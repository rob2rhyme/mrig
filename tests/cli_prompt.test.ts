import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync } from 'node:fs';
import { join, sep } from 'node:path';
import { parseArgs } from '../src/cli/args.ts';
import { buildSystemPrompt, findMemoryFiles } from '../src/prompt.ts';
import { Runtime } from '../src/runtime.ts';
import { firstLines, humanBytes, truncateMiddle } from '../src/util/text.ts';
import { tempDir } from './helpers.ts';

describe('parseArgs', () => {
  test('parses flags, values, and positional prompt', () => {
    const a = parseArgs([
      '-P',
      'ollama',
      '-m',
      'qwen3',
      '--yolo',
      '-c',
      '--max-steps',
      '7',
      'fix',
      'the',
      'bug',
    ]);
    expect(a.provider).toBe('ollama');
    expect(a.model).toBe('qwen3');
    expect(a.yolo).toBe(true);
    expect(a.continue).toBe(true);
    expect(a.maxSteps).toBe(7);
    expect(a.prompt).toBe('fix the bug');
    expect(parseArgs(['-p', 'hello']).print).toBe('hello');
  });

  test('L7 flags: --json and --output-last need -p; init alone is the subcommand', () => {
    expect(parseArgs(['-p', 'hi', '--json']).json).toBe(true);
    expect(parseArgs(['--output-last', '-p', 'hi']).outputLast).toBe(true);
    expect(() => parseArgs(['--json'])).toThrow('--json works with -p "prompt"');
    expect(() => parseArgs(['--output-last', 'fix it'])).toThrow(/--output-last works with -p/);
    expect(() => parseArgs(['-p', 'hi', '--json', '--output-last'])).toThrow(/not both/);
    expect(parseArgs(['init']).init).toBe(true);
    expect(parseArgs(['--init']).init).toBe(true);
    const prompt = parseArgs(['init', 'a', 'git', 'repo', 'here']);
    expect(prompt.init).toBe(false);
    expect(prompt.prompt).toBe('init a git repo here');
    expect(parseArgs(['-p', 'init']).init).toBe(false);
  });

  test('doctor as a subcommand or flag; not when it is just the first prompt word', () => {
    expect(parseArgs(['doctor']).doctor).toBe(true);
    expect(parseArgs(['doctor', '-P', 'ollama']).doctor).toBe(true);
    expect(parseArgs(['--doctor']).doctor).toBe(true);
    expect(parseArgs(['doctor']).prompt).toBeUndefined();
    const p = parseArgs(['-p', 'doctor please']);
    expect(p.doctor).toBe(false);
    expect(p.print).toBe('doctor please');
    expect(parseArgs(['call', 'the', 'doctor']).prompt).toBe('call the doctor');
  });

  test('rejects bad input', () => {
    expect(() => parseArgs(['--max-steps', 'x'])).toThrow(/positive integer/);
    expect(() => parseArgs(['--provider'])).toThrow(/Missing value/);
    expect(() => parseArgs(['--wat'])).toThrow(/Unknown option/);
  });
});

describe('system prompt and memory', () => {
  let t: ReturnType<typeof tempDir>;
  let home: ReturnType<typeof tempDir>;
  const prevHome = process.env.MRIG_HOME;
  beforeEach(() => {
    t = tempDir();
    home = tempDir('mrig-home-');
    process.env.MRIG_HOME = home.dir;
  });
  afterEach(() => {
    t.cleanup();
    home.cleanup();
    if (prevHome === undefined) delete process.env.MRIG_HOME;
    else process.env.MRIG_HOME = prevHome;
  });

  test('finds AGENTS.md up to the git root, nearest last, plus global', async () => {
    mkdirSync(join(t.dir, '.git'));
    mkdirSync(join(t.dir, 'pkg', 'app'), { recursive: true });
    await Bun.write(join(t.dir, 'AGENTS.md'), 'ROOT RULES');
    await Bun.write(join(t.dir, 'pkg', 'app', 'AGENTS.md'), 'APP RULES');
    await Bun.write(join(home.dir, 'AGENTS.md'), 'GLOBAL RULES');
    const files = findMemoryFiles(join(t.dir, 'pkg', 'app'));
    expect(files.map((f) => f.replace(t.dir, '').split(sep).join('/'))).toEqual([
      '/AGENTS.md',
      '/pkg/app/AGENTS.md',
    ]);
    const prompt = buildSystemPrompt({ cwd: join(t.dir, 'pkg', 'app'), modelLabel: 'x/y' });
    expect(prompt.indexOf('GLOBAL RULES')).toBeLessThan(prompt.indexOf('ROOT RULES'));
    expect(prompt.indexOf('ROOT RULES')).toBeLessThan(prompt.indexOf('APP RULES'));
    expect(prompt).toContain('Working directory:');
    expect(prompt).toContain('model: x/y');
  });

  test('prompt without memory stays short', () => {
    const prompt = buildSystemPrompt({ cwd: t.dir, modelLabel: 'x/y' });
    expect(prompt).not.toContain('Project memory');
    expect(prompt.length).toBeLessThan(4000); // ≈ under 1k tokens
  });

  test('minimal tool mode swaps the file-tool guidance for a bash-only workflow', () => {
    const full = buildSystemPrompt({ cwd: t.dir, modelLabel: 'x/y' });
    const minimal = buildSystemPrompt({ cwd: t.dir, modelLabel: 'x/y', toolMode: 'minimal' });
    expect(full).toContain('use glob and grep');
    expect(full).not.toContain('Only the bash tool');
    expect(minimal).toContain('Only the bash tool is available');
    expect(minimal).not.toContain('Prefer edit');
    expect(minimal.length).toBeLessThan(4000);
  });

  test('Runtime picks the tool set and prompt from the profile toolMode, also on switch', async () => {
    await Bun.write(
      join(home.dir, 'config.json'),
      JSON.stringify({
        providers: {
          mini: {
            kind: 'openai-compatible',
            baseURL: 'http://127.0.0.1:1/v1',
            model: 'tiny',
            toolMode: 'minimal',
          },
          big: { kind: 'openai-compatible', baseURL: 'http://127.0.0.1:1/v1', model: 'large' },
        },
      }),
    );
    const rt = new Runtime({
      cwd: t.dir,
      provider: 'mini',
      ask: async () => 'no',
      events: { onText: () => {} },
    });
    expect(rt.agent.opts.tools.map((x) => x.name)).toEqual(['bash']);
    expect(rt.agent.opts.systemPrompt).toContain('Only the bash tool');
    rt.switchModel('big');
    expect(rt.agent.opts.tools.length).toBe(7); // read, edit, write, bash, glob, grep, fetch
    expect(rt.agent.opts.systemPrompt).not.toContain('Only the bash tool');
    rt.switchModel('mini');
    expect(rt.agent.opts.tools.map((x) => x.name)).toEqual(['bash']);
  });
});

describe('text utils', () => {
  test('truncateMiddle keeps head and tail', () => {
    const s = `${'a'.repeat(5000)}${'b'.repeat(5000)}`;
    const out = truncateMiddle(s, 1000);
    expect(out.startsWith('aaaa')).toBe(true);
    expect(out.endsWith('bbbb')).toBe(true);
    expect(out).toContain('characters truncated');
    expect(truncateMiddle('short', 1000)).toBe('short');
  });
  test('firstLines and humanBytes', () => {
    expect(firstLines('1\n2\n3\n4', 2)).toBe('1\n2\n… (2 more lines)');
    expect(humanBytes(2048)).toBe('2.0 KB');
  });
});
