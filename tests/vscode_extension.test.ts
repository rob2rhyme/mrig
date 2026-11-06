/**
 * Track 4, U4: the extension itself, run against a stand-in for the `vscode` module, with a real
 * `mrig serve --with-app` as its child. Covers starting the server, the panel's frame, a
 * selection reaching the app, an edit opening the diff editor with Allow in it, a file link
 * opening the file, the status bar, and deactivating (closing the window) stopping the server.
 *
 * Not on Windows: `mrig.path` points at a small POSIX launcher for `bun src/index.ts`, since
 * the extension starts mrig directly, without a shell. The logic tests run everywhere.
 */
import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test';
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tempDir } from './helpers.ts';

type Listener = (m: unknown) => unknown;

const home = tempDir('mrig-vscode-home-');
const project = tempDir('mrig-vscode-proj-');
const bin = tempDir('mrig-vscode-bin-');
const launcher = join(bin.dir, 'mrig');
let mrigPath = launcher;

const calls: Array<[string, ...unknown[]]> = [];
const commands = new Map<string, (...a: unknown[]) => unknown>();
const posted: unknown[] = [];
const statusItem = { text: '', tooltip: '', name: '', command: '', show() {}, dispose() {} };
let activeTextEditor: unknown;
const tabs: Array<{ input: unknown }> = [];

class EventEmitter {
  event = () => ({ dispose() {} });
  fire() {}
  dispose() {}
}
class TabInputTextDiff {
  constructor(
    readonly original: { scheme: string; query: string },
    readonly modified: { scheme: string; query: string },
  ) {}
}
class Range {
  constructor(
    readonly startLine: number,
    readonly startCharacter: number,
    readonly endLine: number,
    readonly endCharacter: number,
  ) {}
}
const Uri = {
  file: (p: string) => ({ scheme: 'file', fsPath: p, path: p, query: '' }),
  from: (u: { scheme: string; path: string; query: string }) => ({ ...u }),
};

const vscodeStub = {
  EventEmitter,
  TabInputTextDiff,
  Range,
  Uri,
  StatusBarAlignment: { Left: 1, Right: 2 },
  window: {
    createStatusBarItem: () => statusItem,
    registerWebviewViewProvider: (id: string, provider: unknown) => {
      calls.push(['registerWebviewViewProvider', id, provider]);
      return { dispose() {} };
    },
    showErrorMessage: async (...a: unknown[]) => {
      calls.push(['showErrorMessage', ...a]);
    },
    showInformationMessage: async (...a: unknown[]) => {
      calls.push(['showInformationMessage', ...a]);
    },
    showWarningMessage: async (...a: unknown[]) => {
      calls.push(['showWarningMessage', ...a]);
    },
    showTextDocument: async (...a: unknown[]) => {
      calls.push(['showTextDocument', ...a]);
    },
    get activeTextEditor() {
      return activeTextEditor;
    },
    tabGroups: {
      get all() {
        return [{ tabs }];
      },
      close: async (t: unknown) => {
        calls.push(['closeTabs', t]);
        return true;
      },
    },
  },
  workspace: {
    get workspaceFolders() {
      return [{ uri: { fsPath: project.dir } }];
    },
    getConfiguration: () => ({ get: (key: string) => (key === 'path' ? mrigPath : undefined) }),
    registerTextDocumentContentProvider: (scheme: string, provider: unknown) => {
      calls.push(['registerTextDocumentContentProvider', scheme, provider]);
      return { dispose() {} };
    },
    fs: {
      readFile: async (u: { fsPath: string }) =>
        new Uint8Array(await Bun.file(u.fsPath).arrayBuffer()),
    },
    asRelativePath: (u: { fsPath: string }) => u.fsPath.slice(project.dir.length + 1),
    openTextDocument: async (u: { fsPath: string }) => {
      calls.push(['openTextDocument', u.fsPath]);
      return { lineCount: 100 };
    },
  },
  commands: {
    registerCommand: (id: string, fn: (...a: unknown[]) => unknown) => {
      commands.set(id, fn);
      return { dispose() {} };
    },
    executeCommand: async (...a: unknown[]) => {
      calls.push(['executeCommand', ...a]);
    },
  },
};

function fakeView() {
  let onMessage: Listener | undefined;
  const view = {
    visible: true,
    webview: {
      options: {},
      html: '',
      onDidReceiveMessage: (fn: Listener) => {
        onMessage = fn;
        return { dispose() {} };
      },
      postMessage: async (m: unknown) => {
        posted.push(m);
        return true;
      },
    },
    onDidDispose: () => ({ dispose() {} }),
    onDidChangeVisibility: () => ({ dispose() {} }),
  };
  return { view, send: (m: unknown) => onMessage?.(m) };
}

describe.skipIf(process.platform === 'win32')('the VS Code extension, run (U4)', () => {
  let ext: typeof import('../vscode/src/extension.ts');
  const context = { subscriptions: [] as Array<{ dispose(): void }> };

  beforeAll(async () => {
    process.env.MRIG_HOME = home.dir;
    writeFileSync(
      launcher,
      `#!/bin/sh\nexec "${process.execPath}" "${join(import.meta.dir, '..', 'src', 'index.ts')}" "$@"\n`,
    );
    chmodSync(launcher, 0o755);
    mkdirSync(join(project.dir, 'src'));
    writeFileSync(join(project.dir, 'src', 'notes.txt'), 'first line\nold line\nlast line\n');
    mock.module('vscode', () => vscodeStub);
    ext = await import('../vscode/src/extension.ts');
    ext.activate(context as never);
  });

  afterAll(() => {
    ext?.deactivate();
    home.cleanup();
    project.cleanup();
    bin.cleanup();
  });

  test('starts mrig, frames its app, and passes the editor features through', async () => {
    const provider = calls.find((c) => c[0] === 'registerWebviewViewProvider')?.[2] as {
      resolveWebviewView(v: unknown): Promise<void>;
    };
    const docs = calls.find((c) => c[0] === 'registerTextDocumentContentProvider')?.[2] as {
      provideTextDocumentContent(u: unknown): string;
    };
    const { view, send } = fakeView();
    await provider.resolveWebviewView(view);
    const url = /src="(http:\/\/127\.0\.0\.1:\d+)\/#/.exec(view.webview.html)?.[1];
    expect(url).toBeDefined();
    expect(view.webview.html).toContain('host=vscode&amp;token=');
    // `--with-app`: the server it started serves the web app.
    const page = await fetch(`${url}/`);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('<div id="root"');

    // Messages for the app wait until it says it's ready.
    activeTextEditor = {
      document: { uri: Uri.file(join(project.dir, 'src', 'agent.ts')) },
      selection: { start: { line: 9, character: 0 }, end: { line: 11, character: 4 } },
    };
    await commands.get('mrig.askAboutSelection')?.();
    expect(posted).toEqual([]);
    await send({ type: 'ready' });
    expect(posted).toEqual([{ toApp: { type: 'insert', text: '`src/agent.ts:10-12` ' } }]);

    // An edit asking permission opens the diff editor on the whole file.
    await send({
      type: 'ask',
      askId: 'a1',
      summary: 'edit src/notes.txt',
      display: { kind: 'diff', path: 'src/notes.txt', before: 'old line', after: 'new line' },
    });
    expect(calls).toContainEqual(['executeCommand', 'setContext', 'mrig.askOpen', true]);
    const diff = calls.find((c) => c[0] === 'executeCommand' && c[1] === 'vscode.diff');
    expect(diff).toBeDefined();
    const [, , left, right, title] = diff as [
      string,
      string,
      { query: string },
      { query: string },
      string,
    ];
    expect(title).toContain('src/notes.txt');
    expect(docs.provideTextDocumentContent(left)).toBe('first line\nold line\nlast line\n');
    expect(docs.provideTextDocumentContent(right)).toBe('first line\nnew line\nlast line\n');

    // Allow in the diff editor's title bar answers the app.
    await commands.get('mrig.allow')?.();
    expect(posted.at(-1)).toEqual({ toApp: { type: 'answer', askId: 'a1', answer: 'yes' } });
    tabs.push({ input: new TabInputTextDiff(left as never, right as never) });
    tabs.push({ input: { modified: { scheme: 'file', query: '' } } });
    const other = { scheme: 'mrig-proposed', query: 'ask=a12&side=after' }; // another ask's diff
    tabs.push({ input: new TabInputTextDiff(other, other) });
    await send({ type: 'ask.closed', askId: 'a1' });
    expect(calls.find((c) => c[0] === 'closeTabs')?.[1]).toEqual([tabs[0]]);
    expect(calls).toContainEqual(['executeCommand', 'setContext', 'mrig.askOpen', false]);
    expect(docs.provideTextDocumentContent(right)).toBe('');

    // A file link in a reply opens the file at its line; the status bar follows the app.
    await send({ type: 'open', path: 'src/agent.ts', line: 42 });
    expect(calls).toContainEqual(['openTextDocument', join(project.dir, 'src', 'agent.ts')]);
    const shown = calls.find((c) => c[0] === 'showTextDocument')?.[2] as { selection: Range };
    expect(shown.selection.startLine).toBe(41);
    await send({ type: 'status', model: 'local/m', running: true, waiting: 0 });
    expect(statusItem.text).toBe('$(sync~spin) mrig · local/m');

    // Closing the window stops the server.
    ext.deactivate();
    const end = Date.now() + 10_000;
    let stopped = false;
    while (!stopped && Date.now() < end) {
      stopped = await fetch(`${url}/`).then(
        () => false,
        () => true,
      );
      if (!stopped) await Bun.sleep(50);
    }
    expect(stopped).toBe(true);
  }, 30_000);

  test("says where to point it when it can't find mrig", async () => {
    mrigPath = join(bin.dir, 'not-here');
    ext.activate(context as never);
    const provider = calls.filter((c) => c[0] === 'registerWebviewViewProvider').at(-1)?.[2] as {
      resolveWebviewView(v: unknown): Promise<void>;
    };
    const { view } = fakeView();
    await provider.resolveWebviewView(view);
    expect(view.webview.html).toContain("Can't find the mrig program");
    expect(view.webview.html).toContain('mrig.path');
  });
});
