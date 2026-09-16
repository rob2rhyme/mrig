import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig, resolveApiKey, resolveProfile } from '../src/config.ts';
import { estimateCost, pricingFor } from '../src/providers.ts';
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
});
