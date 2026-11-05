import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { render } from 'ink-testing-library';
import { applyChunk, formatStatus, TuiApp } from '../src/ui/tui.tsx';
import { TuiController } from '../src/ui/tui-controller.ts';
import { ZONE_MARKER } from '../src/zone.ts';
import { mockModel, reasoningTurn, tempDir, textTurn, toolTurn } from './helpers.ts';

// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping ANSI colour codes
const plain = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '');
const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));
async function until(check: () => boolean, ms = 2000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out waiting');
    await tick(10);
  }
}

describe('tui: pure helpers', () => {
  test('a chunk ending in a newline submits; inner newlines become spaces', () => {
    expect(applyChunk('', 'abc')).toEqual({ value: 'abc', submit: false });
    expect(applyChunk('ls ', '-la\r')).toEqual({ value: 'ls -la', submit: true });
    expect(applyChunk('', 'one\ntwo\r\n')).toEqual({ value: 'one two', submit: true });
    expect(applyChunk('', 'one\ntwo')).toEqual({ value: 'one two', submit: false });
  });

  test('status line', () => {
    expect(
      formatStatus({
        model: 'claude/claude-sonnet-5',
        tokensIn: 12345,
        tokensOut: 678,
        cost: 0.0123,
        contextPct: 38,
        mcp: '2/3',
        offline: 'Offline zone /w',
        yolo: false,
      }),
    ).toBe(
      'claude/claude-sonnet-5 · 12,345 in / 678 out · ~$0.0123 · context 38% · mcp 2/3 · offline zone /w',
    );
    expect(formatStatus({ model: 'm', tokensIn: 0, tokensOut: 0, contextPct: 0, yolo: true })).toBe(
      'm · 0 in / 0 out · context 0% · yolo',
    );
  });
});

describe('tui: the controller (no terminal)', () => {
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
          fake: { kind: 'openai-compatible', baseURL: 'http://127.0.0.1:1/v1', model: 'fake' },
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

  const make = (turns: Parameters<typeof mockModel>[0], now?: () => number) =>
    new TuiController({ cwd: project.dir, provider: 'fake', languageModel: mockModel(turns) }, now);

  test('start shows the banner and fills the status line', async () => {
    const c = make([]);
    await c.start();
    const s = c.getSnapshot();
    expect(plain(s.items[0]?.text ?? '')).toMatch(/^mrig v[\d.]+ · fake\/fake$/);
    expect(s.items.every((i) => i.kind === 'banner')).toBe(true);
    expect(s.status.model).toBe('fake/fake');
    expect(s.status.cost).toBe(0);
    await c.close();
  });

  test('a message streams in, then becomes an item with a footer; the status updates', async () => {
    const c = make([textTurn('Hello there.', { input: 120, output: 9 })]);
    await c.start();
    const seen: string[] = [];
    c.subscribe(() => seen.push(c.getSnapshot().live));
    await c.submit('hi');
    const s = c.getSnapshot();
    const kinds = s.items
      .filter((i) => i.kind !== 'banner')
      .map((i) => `${i.kind}:${plain(i.text)}`);
    expect(kinds).toEqual([
      'user:hi',
      'assistant:Hello there.',
      'footer:— 1 step · 120 in / 9 out · ~$0.0000',
    ]);
    expect(seen).toContain('Hello there.'); // it was live before it was an item
    expect(s.live).toBe('');
    expect(s.running).toBe(false);
    expect(s.status.tokensIn).toBe(120);
    await c.close();
  });

  test('a tool call asks; answering shows the answer and the tool line', async () => {
    const c = make([toolTurn('write', '{"path":"out.txt","content":"x"}'), textTurn('Written.')]);
    await c.start();
    const done = c.submit('write it');
    await until(() => c.getSnapshot().ask !== undefined);
    expect(c.getSnapshot().ask?.summary).toMatch(/write out\.txt/);
    expect(c.getSnapshot().running).toBe(true);
    c.answer('yes');
    await done;
    const texts = c.getSnapshot().items.map((i) => plain(i.text));
    expect(texts).toContain('  → yes');
    expect(texts.some((t) => /^⚙ write out\.txt .* ✓ 1 line/.test(t))).toBe(true);
    expect(texts).toContain('Written.');
    expect(c.getSnapshot().ask).toBeUndefined();
    await c.close();
  });

  test('Ctrl+C: denies a pending question, and quits on a second press when idle', async () => {
    let clock = 0;
    const c = make(
      [toolTurn('write', '{"path":"out.txt","content":"x"}'), textTurn('ok')],
      () => clock,
    );
    await c.start();
    const done = c.submit('write it');
    await until(() => c.getSnapshot().ask !== undefined);
    expect(c.interrupt()).toBe('denied');
    await done;
    expect(c.getSnapshot().items.map((i) => plain(i.text))).toContain('⏹ aborted');
    clock = 10_000;
    expect(c.interrupt()).toBe('armed');
    expect(c.getSnapshot().hint).toBe('press Ctrl+C again to exit');
    clock = 10_500;
    expect(c.interrupt()).toBe('exit');
    await c.close();
  });

  test('slash commands use the same code as the REPL; /exit ends the UI', async () => {
    const c = make([]);
    await c.start();
    expect(await c.submit('/context')).toBeUndefined();
    const last = c.getSnapshot().items.at(-1);
    expect(last?.kind).toBe('info');
    expect(plain(last?.text ?? '')).toMatch(/of 32,768 tokens .* compacts at/);
    await c.submit('/nope');
    expect(plain(c.getSnapshot().items.at(-1)?.text ?? '')).toBe(
      'Unknown command /nope. Try /help.',
    );
    expect(await c.submit('/exit')).toBe('exit');
    expect(await c.submit('   ')).toBeUndefined(); // blank lines do nothing
    await c.close();
  });

  test('/verbose shows reasoning as a dim item before the answer; off by default', async () => {
    const c = make([
      reasoningTurn('The user greets me.', 'Hello!'),
      reasoningTurn('Again a greeting.', 'Hi again.'),
    ]);
    await c.start();
    await c.submit('hi');
    const kinds = () =>
      c
        .getSnapshot()
        .items.filter((i) => i.kind === 'reasoning' || i.kind === 'assistant')
        .map((i) => `${i.kind}:${plain(i.text)}`);
    expect(kinds()).toEqual(['assistant:Hello!']); // hidden by default
    await c.submit('/verbose');
    expect(plain(c.getSnapshot().items.at(-1)?.text ?? '')).toMatch(/^verbose on/);
    expect(c.runtime?.verbose).toBe(true);
    const seen: string[] = [];
    c.subscribe(() => seen.push(c.getSnapshot().reasoning));
    await c.submit('hi again');
    expect(seen).toContain('Again a greeting.'); // it streamed live first
    expect(kinds()).toEqual([
      'assistant:Hello!',
      'reasoning:Again a greeting.',
      'assistant:Hi again.',
    ]);
    expect(c.getSnapshot().reasoning).toBe('');
    await c.submit('/verbose off');
    expect(c.runtime?.verbose).toBe(false);
    await c.submit('/verbose loud');
    expect(plain(c.getSnapshot().items.at(-1)?.text ?? '')).toBe('usage: /verbose [on|off]');
    await c.close();
  });

  test('the status line shows offline zones', async () => {
    writeFileSync(join(project.dir, ZONE_MARKER), '');
    const c = make([]);
    await c.start();
    expect(c.getSnapshot().status.offline).toBe(`Offline zone ${project.dir}`);
    await c.close();
  });

  test('model errors become an error item, not a crash', async () => {
    const c = new TuiController({
      cwd: project.dir,
      provider: 'fake',
      languageModel: mockModel([[{ type: 'error', error: new Error('model exploded') }]]),
    });
    await c.start();
    await c.submit('hi');
    const last = c.getSnapshot().items.at(-1);
    expect(last?.kind).toBe('error');
    expect(last?.text).toContain('model exploded');
    await c.close();
  });

  test('the Ink view: transcript, input, permission box and status line', async () => {
    const c = make([toolTurn('write', '{"path":"out.txt","content":"x"}'), textTurn('All done.')]);
    await c.start();
    const app = render(<TuiApp controller={c} />);
    try {
      const screen = () => plain(app.frames.join('\n'));
      expect(screen()).toContain('fake/fake · 0 in / 0 out · ~$0.0000 · context');
      app.stdin.write('write the file');
      await until(() => screen().includes('❯ write the file'));
      app.stdin.write('\r');
      await until(() => screen().includes('Allow? yes / no / always'));
      expect(screen()).toContain('⚠ write out.txt');
      app.stdin.write('y');
      await until(() => screen().includes('All done.') && screen().includes('— 2 steps'));
      expect(screen()).toMatch(/— 2 steps · 20 in \/ 10 out/);
    } finally {
      app.unmount();
      await c.close();
    }
  });
});
