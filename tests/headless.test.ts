import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { type HeadlessJson, type OutputMode, runHeadless } from '../src/headless.ts';
import { mockModel, tempDir, textTurn, toolTurn } from './helpers.ts';

// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping ANSI colour codes
const plain = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '');

describe('headless output modes (L7)', () => {
  let home: ReturnType<typeof tempDir>;
  let project: ReturnType<typeof tempDir>;
  const prevHome = process.env.MRIG_HOME;
  beforeEach(() => {
    home = tempDir('mrig-home-');
    project = tempDir('mrig-proj-');
    mkdirSync(join(project.dir, '.git'));
    writeFileSync(join(project.dir, 'notes.txt'), 'hello\n');
    process.env.MRIG_HOME = home.dir;
    writeFileSync(
      join(home.dir, 'config.json'),
      JSON.stringify({
        providers: {
          fake: { kind: 'openai-compatible', baseURL: 'http://127.0.0.1:1/v1', model: 'fake-1' },
        },
      }),
    );
  });
  afterEach(() => {
    home.cleanup();
    project.cleanup();
    if (prevHome === undefined) delete process.env.MRIG_HOME;
    else process.env.MRIG_HOME = prevHome;
  });

  // Two steps: some text and a read call, then the final answer.
  const turns = () => [
    [
      ...textTurn('Let me look.', { input: 100, output: 4 }).slice(0, 5),
      ...toolTurn('read', '{"path":"notes.txt"}', 'c1', { input: 100, output: 4 }).slice(2),
    ],
    textTurn('The file says hello.', { input: 150, output: 6 }),
  ];

  async function run(output: OutputMode | undefined, model = mockModel(turns())) {
    let stdout = '';
    let stderr = '';
    const code = await runHeadless(
      {
        cwd: project.dir,
        provider: 'fake',
        languageModel: model,
        prompt: 'what is in notes?',
        output,
      },
      {
        stdout: (t) => {
          stdout += t;
        },
        stderr: (t) => {
          stderr += t;
        },
        ask: async () => 'no',
      },
    );
    return { code, stdout, stderr: plain(stderr) };
  }

  test('stream (default): every text delta on stdout, tool lines and summary on stderr', async () => {
    const r = await run(undefined);
    expect(r.code).toBe(0);
    expect(r.stdout).toBe('Let me look.The file says hello.\n');
    expect(r.stderr).toContain('⚙ read notes.txt');
    expect(r.stderr).toMatch(/— 2 steps · 250 in \/ 10 out · ~\$0\.0000 · session \S+/);
  });

  test('--output-last: only the final answer on stdout', async () => {
    const r = await run('last');
    expect(r.code).toBe(0);
    expect(r.stdout).toBe('The file says hello.\n');
    expect(r.stderr).toContain('⚙ read notes.txt'); // progress still visible
  });

  test('--json: one object with the final text, usage, cost and session id', async () => {
    const r = await run('json');
    expect(r.code).toBe(0);
    expect(r.stdout.trim().split('\n')).toHaveLength(1);
    const out = JSON.parse(r.stdout) as HeadlessJson;
    expect(out).toMatchObject({
      text: 'The file says hello.',
      stop: 'done',
      steps: 2,
      provider: 'fake',
      model: 'fake-1',
      usage: { inputTokens: 250, outputTokens: 10, requests: 2 },
      cost: 0, // local profiles are free
    });
    expect(out.sessionId).toMatch(/\S+/);
    expect(out.error).toBeUndefined();
    expect(r.stderr).not.toContain('— 2 steps'); // the summary is in the JSON instead
  });

  test('--json reports a model error as JSON, exit 1', async () => {
    const r = await run(
      'json',
      mockModel([[{ type: 'error', error: new Error('model exploded') }]]),
    );
    expect(r.code).toBe(1);
    const out = JSON.parse(r.stdout) as HeadlessJson;
    expect(out.stop).toBe('error');
    expect(out.error).toContain('model exploded');
    expect(out.sessionId).toMatch(/\S+/);
  });

  test('--json reports a bad config as JSON too', async () => {
    let stdout = '';
    const code = await runHeadless(
      { cwd: project.dir, provider: 'nope', prompt: 'hi', output: 'json' },
      { stdout: (t) => (stdout += t), stderr: () => {}, ask: async () => 'no' },
    );
    expect(code).toBe(1);
    const out = JSON.parse(stdout) as HeadlessJson;
    expect(out).toMatchObject({ stop: 'error', steps: 0, cost: null });
    expect(out.error).toMatch(/Unknown provider "nope"/);
  });

  test('hitting max steps exits 2 and says so in the JSON', async () => {
    const model = mockModel([
      toolTurn('read', '{"path":"notes.txt"}', 'c1'),
      toolTurn('read', '{"path":"notes.txt"}', 'c2'),
    ]);
    let stdout = '';
    const code = await runHeadless(
      {
        cwd: project.dir,
        provider: 'fake',
        languageModel: model,
        maxSteps: 1,
        prompt: 'loop',
        output: 'json',
      },
      { stdout: (t) => (stdout += t), stderr: () => {}, ask: async () => 'no' },
    );
    expect(code).toBe(2);
    expect((JSON.parse(stdout) as HeadlessJson).stop).toBe('max-steps');
  });
});
