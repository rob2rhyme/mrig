import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DEFAULT_CONFIG, loadConfig } from '../src/config.ts';
import { initConfig, initReport, pickDefaultProvider } from '../src/init.ts';
import { tempDir } from './helpers.ts';

describe('mrig init (L7)', () => {
  let home: ReturnType<typeof tempDir>;
  let project: ReturnType<typeof tempDir>;
  const prevHome = process.env.MRIG_HOME;
  beforeEach(() => {
    home = tempDir('mrig-home-');
    project = tempDir('mrig-proj-');
    // A folder that does not exist yet: init creates it.
    process.env.MRIG_HOME = join(home.dir, '.mrig');
  });
  afterEach(() => {
    home.cleanup();
    project.cleanup();
    if (prevHome === undefined) delete process.env.MRIG_HOME;
    else process.env.MRIG_HOME = prevHome;
  });

  test('the default profile follows the keys you have', () => {
    expect(pickDefaultProvider({ ANTHROPIC_API_KEY: 'k', OPENAI_API_KEY: 'k' })).toBe('claude');
    expect(pickDefaultProvider({ OPENAI_API_KEY: 'k' })).toBe('openai');
    expect(pickDefaultProvider({})).toBe('ollama');
  });

  test('writes a starter config that loads cleanly and holds no key', () => {
    const r = initConfig({ ANTHROPIC_API_KEY: 'sk-ant-secret' });
    expect(r).toEqual({
      path: join(home.dir, '.mrig', 'config.json'),
      created: true,
      defaultProvider: 'claude',
    });
    const text = readFileSync(r.path, 'utf8');
    expect(text).not.toContain('sk-ant-secret');
    const cfg = loadConfig({ cwd: project.dir, env: {} });
    expect(cfg.defaultProvider).toBe('claude');
    expect(cfg.providers).toEqual(DEFAULT_CONFIG.providers);
    expect(cfg.permissions).toEqual({
      yolo: false,
      allow: ['bash:git status', 'bash:git diff', 'bash:git log'],
    });
    expect(cfg.compaction).toEqual(DEFAULT_CONFIG.compaction);
    expect(cfg.mcpServers).toEqual({});
    expect(cfg.trustedProjects).toEqual([]);
    if (process.platform !== 'win32') expect(statSync(r.path).mode & 0o777).toBe(0o600);
    expect(initReport(r)[0]).toBe(`Wrote ${r.path} (default profile: claude).`);
  });

  test('never overwrites an existing config', () => {
    const first = initConfig({});
    writeFileSync(first.path, '{"defaultProvider":"mine"}');
    const again = initConfig({ ANTHROPIC_API_KEY: 'k' });
    expect(again).toEqual({ path: first.path, created: false });
    expect(readFileSync(first.path, 'utf8')).toBe('{"defaultProvider":"mine"}');
    expect(initReport(again)).toEqual([`${first.path} already exists; it was not changed.`]);
  });

  test('without keys it picks Ollama and says what to pull', () => {
    const r = initConfig({});
    expect(existsSync(r.path)).toBe(true);
    expect(initReport(r).join('\n')).toContain('ollama pull qwen3-coder');
  });
});
