import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig, resolveApiKey, resolveProfile } from '../src/config.ts';
import {
  addUsage,
  cacheMinPrefix,
  cacheProviderOptions,
  emptyUsage,
  estimateCost,
  explainCacheMiss,
  pricingFor,
} from '../src/providers.ts';
import { tempDir } from './helpers.ts';

describe('config', () => {
  let home: ReturnType<typeof tempDir>;
  let project: ReturnType<typeof tempDir>;
  const prevHome = process.env.MRIG_HOME;
  beforeEach(() => {
    home = tempDir('mrig-home-');
    project = tempDir('mrig-proj-');
    process.env.MRIG_HOME = home.dir;
  });
  afterEach(() => {
    home.cleanup();
    project.cleanup();
    if (prevHome === undefined) delete process.env.MRIG_HOME;
    else process.env.MRIG_HOME = prevHome;
  });

  test('defaults load without any files', () => {
    const cfg = loadConfig({ cwd: project.dir, env: {} });
    expect(cfg.defaultProvider).toBe('claude');
    expect(cfg.providers.ollama?.baseURL).toBe('http://localhost:11434/v1');
    expect(cfg.maxSteps).toBe(40);
    expect(cfg.cacheTtl).toBe('5m');
  });

  test('cacheTtl loads from config and rejects anything but 5m/1h', async () => {
    await Bun.write(join(home.dir, 'config.json'), JSON.stringify({ cacheTtl: '1h' }));
    expect(loadConfig({ cwd: project.dir, env: {} }).cacheTtl).toBe('1h');
    await Bun.write(join(home.dir, 'config.json'), JSON.stringify({ cacheTtl: '2h' }));
    expect(() => loadConfig({ cwd: project.dir, env: {} })).toThrow(/Invalid "cacheTtl"/);
  });

  test('global then project config layer on top, env last', async () => {
    await Bun.write(
      join(home.dir, 'config.json'),
      JSON.stringify({
        defaultProvider: 'ollama',
        providers: {
          ollama: {
            kind: 'openai-compatible',
            baseURL: 'http://gpu:11434/v1',
            model: 'qwen3.8:27b',
          },
        },
        permissions: { allow: ['bash:git status'] },
      }),
    );
    mkdirSync(join(project.dir, '.mrig'));
    await Bun.write(
      join(project.dir, '.mrig', 'config.json'),
      JSON.stringify({ maxSteps: 5, permissions: { allow: ['edit:src/**'] } }),
    );
    const cfg = loadConfig({ cwd: project.dir, env: {} });
    expect(cfg.defaultProvider).toBe('ollama');
    expect(cfg.providers.ollama?.model).toBe('qwen3.8:27b');
    expect(cfg.providers.claude?.model).toBe('claude-sonnet-5'); // untouched default
    expect(cfg.maxSteps).toBe(5);
    expect(cfg.permissions.allow).toEqual(['bash:git status', 'edit:src/**']);
    const withEnv = loadConfig({
      cwd: project.dir,
      env: { MRIG_PROVIDER: 'claude', MRIG_YOLO: '1' },
    });
    expect(withEnv.defaultProvider).toBe('claude');
    expect(withEnv.permissions.yolo).toBe(true);
  });

  test('invalid JSON is a readable error', async () => {
    await Bun.write(join(home.dir, 'config.json'), '{ nope');
    expect(() => loadConfig({ cwd: project.dir, env: {} })).toThrow(/Invalid JSON/);
  });

  test('resolveProfile applies overrides and rejects unknown names', () => {
    const cfg = loadConfig({ cwd: project.dir, env: {} });
    const r = resolveProfile(cfg, 'opus', 'claude-opus-5-20990101');
    expect(r.name).toBe('opus');
    expect(r.profile.model).toBe('claude-opus-5-20990101');
    expect(() => resolveProfile(cfg, 'nope')).toThrow(/Unknown provider "nope"/);
  });

  test('api keys resolve from literal, named env, or well-known env', () => {
    expect(resolveApiKey({ kind: 'anthropic', model: 'm', apiKey: 'lit' }, {})).toBe('lit');
    expect(
      resolveApiKey({ kind: 'anthropic', model: 'm', apiKeyEnv: 'MY_KEY' }, { MY_KEY: 'k1' }),
    ).toBe('k1');
    expect(resolveApiKey({ kind: 'anthropic', model: 'm' }, { ANTHROPIC_API_KEY: 'k2' })).toBe(
      'k2',
    );
    expect(resolveApiKey({ kind: 'openai-compatible', model: 'm' }, {})).toBeUndefined();
  });

  test('pricing: known Claude models priced, local free, unknown undefined', () => {
    const usage = {
      inputTokens: 1_000_000,
      outputTokens: 100_000,
      cacheReadTokens: 500_000,
      cacheWriteTokens: 0,
      requests: 3,
    };
    const sonnet = pricingFor({ kind: 'anthropic', model: 'claude-sonnet-5' });
    // 500k uncached × $2 + 500k cached × $0.2 + 100k out × $10 = 1 + 0.1 + 1 = $2.10
    expect(estimateCost(usage, sonnet)).toBeCloseTo(2.1, 6);
    expect(
      estimateCost(usage, pricingFor({ kind: 'openai-compatible', model: 'x', baseURL: 'u' })),
    ).toBe(0);
    expect(
      estimateCost(usage, pricingFor({ kind: 'openai', model: 'gpt-unknown' })),
    ).toBeUndefined();
  });

  test('cache writes: 1.25× input at 5m, 2× at 1h, explicit cacheWrite/cacheRead win', () => {
    const usage = {
      inputTokens: 1_000_000,
      outputTokens: 0,
      cacheReadTokens: 300_000,
      cacheWriteTokens: 200_000,
      requests: 2,
    };
    const sonnet = pricingFor({ kind: 'anthropic', model: 'claude-sonnet-5' });
    // 500k uncached × $2 + 300k read × $0.2 + 200k write × $2.5 = 1 + 0.06 + 0.5
    expect(estimateCost(usage, sonnet)).toBeCloseTo(1.56, 6);
    expect(estimateCost(usage, sonnet, '5m')).toBeCloseTo(1.56, 6);
    // 1h: 200k write × $4 = 0.8
    expect(estimateCost(usage, sonnet, '1h')).toBeCloseTo(1.86, 6);
    // Explicit prices override both multipliers.
    expect(
      estimateCost(usage, { input: 2, output: 10, cacheRead: 1, cacheWrite: 1 }, '1h'),
    ).toBeCloseTo(1 + 0.3 + 0.2, 6);
    // Fable 5.1 reads at $0.25/M, not 10% of input.
    const fable = pricingFor({ kind: 'anthropic', model: 'claude-fable-5-1' });
    expect(
      estimateCost(
        {
          inputTokens: 1_000_000,
          outputTokens: 0,
          cacheReadTokens: 1_000_000,
          cacheWriteTokens: 0,
          requests: 1,
        },
        fable,
      ),
    ).toBeCloseTo(0.25, 6);
  });

  test('addUsage accumulates cache reads and writes from the SDK usage shape', () => {
    const totals = addUsage(emptyUsage(), {
      inputTokens: 1000,
      inputTokenDetails: { noCacheTokens: 100, cacheReadTokens: 600, cacheWriteTokens: 300 },
      outputTokens: 50,
      outputTokenDetails: { textTokens: 50, reasoningTokens: 0 },
      totalTokens: 1050,
    });
    expect(totals).toEqual({
      inputTokens: 1000,
      outputTokens: 50,
      cacheReadTokens: 600,
      cacheWriteTokens: 300,
      requests: 1,
    });
  });

  test('cache minimum-prefix table knows the per-model floors', () => {
    expect(cacheMinPrefix('claude-sonnet-5')).toBe(1024);
    expect(cacheMinPrefix('claude-sonnet-5-5')).toBe(512);
    expect(cacheMinPrefix('claude-opus-5')).toBe(512);
    expect(cacheMinPrefix('claude-fable-5-1')).toBe(512);
    expect(cacheMinPrefix('claude-haiku-4-5-20251001')).toBe(4096);
    expect(cacheMinPrefix('claude-opus-4-7')).toBe(2048);
    expect(cacheMinPrefix('claude-opus-4-6')).toBe(4096);
    expect(cacheMinPrefix('claude-sonnet-4-5')).toBe(1024);
    expect(cacheMinPrefix('gpt-5')).toBeUndefined();
  });

  test('cacheProviderOptions is Anthropic-only; explainCacheMiss names the floor', () => {
    const claude = { kind: 'anthropic', model: 'claude-haiku-4-5-20251001' } as const;
    expect(cacheProviderOptions(claude, '1h')).toEqual({
      anthropic: { cacheControl: { type: 'ephemeral', ttl: '1h' } },
    });
    expect(
      cacheProviderOptions({ kind: 'openai-compatible', model: 'x', baseURL: 'u' }, '5m'),
    ).toBeUndefined();
    expect(cacheProviderOptions({ kind: 'openai', model: 'gpt-5' }, '5m')).toBeUndefined();

    const none = { ...emptyUsage(), requests: 2, inputTokens: 900 };
    expect(explainCacheMiss(none, claude)).toMatch(/4,096 tokens/);
    expect(explainCacheMiss(none, { kind: 'openai', model: 'gpt-5' })).toBeUndefined();
    expect(explainCacheMiss(emptyUsage(), claude)).toBeUndefined(); // nothing sent yet
    const writtenNeverRead = { ...none, cacheWriteTokens: 800 };
    expect(explainCacheMiss(writtenNeverRead, claude)).toMatch(/never read/);
    const healthy = { ...none, cacheWriteTokens: 800, cacheReadTokens: 800 };
    expect(explainCacheMiss(healthy, claude)).toBeUndefined();
  });
});
