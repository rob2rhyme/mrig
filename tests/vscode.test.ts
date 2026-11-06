/**
 * Track 4, U4: the VS Code extension's logic without VS Code: reading `mrig serve`'s first line,
 * the panel's HTML and its CSP, the proposed file a diff shows, the selection text, where to
 * look for `mrig`, and the status bar's text.
 */
import { describe, expect, test } from 'bun:test';
import {
  appSrc,
  mrigCandidates,
  parseServeLine,
  proposedContent,
  selectionText,
  statusText,
  webviewHtml,
} from '../vscode/src/logic.ts';

const TOKEN = 'a'.repeat(64);
const INFO = { url: 'http://127.0.0.1:4747', token: TOKEN };

describe('the VS Code extension (U4)', () => {
  test("reads `mrig serve`'s first line, and nothing else", () => {
    const line = JSON.stringify({
      protocol: 1,
      url: INFO.url,
      ws: 'ws://127.0.0.1:4747/ws',
      token: TOKEN,
    });
    expect(parseServeLine(line)).toEqual(INFO);
    expect(parseServeLine('not json')).toBeUndefined();
    expect(
      parseServeLine(JSON.stringify({ protocol: 2, url: INFO.url, token: TOKEN })),
    ).toBeUndefined();
    // Only this machine's loopback address, never another host.
    for (const url of [
      'http://evil.example:4747',
      'https://127.0.0.1:4747',
      'http://127.0.0.1:4747/x',
    ]) {
      expect(parseServeLine(JSON.stringify({ protocol: 1, url, token: TOKEN }))).toBeUndefined();
    }
    for (const token of ['short', 'g'.repeat(64), `${TOKEN}"`]) {
      expect(parseServeLine(JSON.stringify({ protocol: 1, url: INFO.url, token }))).toBeUndefined();
    }
  });

  test('the panel frames the app from that server only, with the token in the fragment', () => {
    const src = appSrc(INFO, '/Users/rt/my project');
    expect(src.startsWith('http://127.0.0.1:4747/#')).toBe(true);
    const params = new URLSearchParams(src.split('#')[1]);
    expect(params.get('host')).toBe('vscode');
    expect(params.get('token')).toBe(TOKEN);
    expect(params.get('cwd')).toBe('/Users/rt/my project');

    const html = webviewHtml(INFO, '/p"><script>alert(1)</script>', 'NONCE');
    expect(html).toContain(
      "default-src 'none'; frame-src http://127.0.0.1:4747; style-src 'nonce-NONCE'; script-src 'nonce-NONCE';",
    );
    // The folder can't break out of the src attribute.
    expect(html).not.toContain('<script>alert');
    expect(html.match(/<script/g)?.length).toBe(1);
    expect(html).toContain('<script nonce="NONCE">');
    // Messages from the frame are passed on only from its own window and origin.
    expect(html).toContain('e.source === frame.contentWindow && e.origin === origin');
    expect(html).toContain('frame.contentWindow.postMessage(e.data.toApp, origin)');
  });

  test('a diff shows the whole file when the edit is found exactly once', () => {
    const file = 'one\ntwo\nthree\n';
    expect(
      proposedContent({ kind: 'diff', path: 'a.ts', before: 'two', after: '2' }, file),
    ).toEqual({
      before: file,
      after: 'one\n2\nthree\n',
    });
    // Twice in the file, or not at all, or a new file: only the snippet.
    for (const current of ['two two', 'none', undefined]) {
      expect(
        proposedContent({ kind: 'diff', path: 'a.ts', before: 'two', after: '2' }, current),
      ).toEqual({
        before: 'two',
        after: '2',
      });
    }
    // A snippet the display cut short can't be matched to the file.
    const cut = 'two\n\n… [120 characters truncated] …\n\nthree';
    expect(
      proposedContent({ kind: 'diff', path: 'a.ts', before: cut, after: 'x' }, `one\n${cut}\n`),
    ).toEqual({
      before: cut,
      after: 'x',
    });
    // A write shows the old file (or nothing) against the new one.
    expect(proposedContent({ kind: 'file', path: 'n.ts', content: 'new' }, undefined)).toEqual({
      before: '',
      after: 'new',
    });
    expect(proposedContent({ kind: 'file', path: 'n.ts', content: 'new' }, 'old')).toEqual({
      before: 'old',
      after: 'new',
    });
    expect(proposedContent({ kind: 'command', path: undefined }, 'x')).toBeUndefined();
  });

  test('the selection becomes a reference the app shows as a link', () => {
    expect(selectionText('src/agent.ts', 42, 42)).toBe('`src/agent.ts:42` ');
    expect(selectionText('src/agent.ts', 10, 20)).toBe('`src/agent.ts:10-20` ');
  });

  test('where to look for mrig', () => {
    expect(mrigCandidates(' /opt/mrig ', '/home/rt', 'darwin')).toEqual(['/opt/mrig']);
    expect(mrigCandidates('', '/Users/rt', 'darwin')).toEqual([
      'mrig',
      '/Users/rt/.local/bin/mrig',
      '/opt/homebrew/bin/mrig',
      '/usr/local/bin/mrig',
    ]);
    const win = mrigCandidates('', 'C:\\Users\\rt', 'win32');
    expect(win[0]).toBe('mrig.exe');
    expect(win).toHaveLength(2);
    expect(win[1]).toBe('C:\\Users\\rt\\.local\\bin\\mrig.exe');
  });

  test('the status bar', () => {
    const base = { model: 'claude-sonnet-5-5', running: false, waiting: 0 };
    expect(statusText(base)).toBe('$(sparkle) mrig · claude-sonnet-5-5');
    expect(statusText({ ...base, cost: 0.0301 })).toBe(
      '$(sparkle) mrig · claude-sonnet-5-5 · $0.0301',
    );
    expect(statusText({ ...base, running: true })).toBe('$(sync~spin) mrig · claude-sonnet-5-5');
    expect(statusText({ ...base, running: true, waiting: 2 })).toBe('$(bell) mrig: 2 waiting');
  });
});
