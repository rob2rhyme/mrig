/**
 * mrig for VS Code (Track 4, U4). A panel showing mrig's own web app, and the editor features
 * a panel can't do alone. See §7 of docs/decisions/2026-11-06-app-front-ends.md.
 *
 * - The extension starts its own `mrig serve --with-app` (one per window, 127.0.0.1 only, a new
 *   launch token each time) and shows the app from it in a webview. Closing the window stops it.
 * - "Ask mrig about this" sends the selection's path and lines to the message box.
 * - An edit or write that asks permission opens in VS Code's diff editor, with Allow and Deny
 *   in its title bar (the panel's buttons work too).
 * - File references in replies open in the editor; a status bar item shows the model, the cost,
 *   and when mrig is working or waiting; a notification appears when it waits and the panel is
 *   hidden.
 */
import { type ChildProcess, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import { basename, isAbsolute, resolve } from 'node:path';
import * as vscode from 'vscode';
import {
  mrigCandidates,
  parseServeLine,
  proposedContent,
  type ServeInfo,
  selectionText,
  statusText,
  webviewHtml,
} from './logic.ts';

const SCHEME = 'mrig-proposed';
const START_TIMEOUT_MS = 20_000;

type FromApp =
  | { type: 'ready' }
  | { type: 'status'; model: string; cost?: number; running: boolean; waiting: number }
  | { type: 'ask'; askId: string; summary: string; display?: { kind: string; path?: string } }
  | { type: 'ask.closed'; askId: string }
  | { type: 'open'; path: string; line?: number };

class Mrig implements vscode.WebviewViewProvider, vscode.TextDocumentContentProvider {
  private view: vscode.WebviewView | undefined;
  private child: ChildProcess | undefined;
  private info: ServeInfo | undefined;
  private ready = false;
  private queue: unknown[] = [];
  private pendingAsk: string | undefined;
  private readonly proposals = new Map<string, { before: string; after: string }>();
  private readonly status: vscode.StatusBarItem;
  private readonly changed = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this.changed.event;

  constructor(private readonly context: vscode.ExtensionContext) {
    this.status = vscode.window.createStatusBarItem(
      'mrig.status',
      vscode.StatusBarAlignment.Right,
      100,
    );
    this.status.name = 'mrig';
    this.status.text = '$(sparkle) mrig';
    this.status.command = 'mrig.show';
    this.status.show();
    context.subscriptions.push(this.status, this.changed);
  }

  get cwd(): string {
    return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? homedir();
  }

  // ---- the panel ----

  async resolveWebviewView(view: vscode.WebviewView): Promise<void> {
    this.view = view;
    this.ready = false;
    view.webview.options = { enableScripts: true, localResourceRoots: [] };
    view.webview.html = this.message('Starting mrig…');
    view.webview.onDidReceiveMessage(
      (m: FromApp) => this.fromApp(m),
      undefined,
      this.context.subscriptions,
    );
    view.onDidDispose(() => {
      this.view = undefined;
      this.ready = false;
    });
    try {
      const info = await this.start();
      const nonce = randomBytes(16).toString('base64');
      view.webview.html = webviewHtml(info, this.cwd, nonce);
    } catch (err) {
      view.webview.html = this.message((err as Error).message);
    }
  }

  private message(text: string): string {
    const safe = text.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
    return `<!doctype html><meta http-equiv="Content-Security-Policy" content="default-src 'none'"><body style="font-family:var(--vscode-font-family);color:var(--vscode-foreground);padding:12px">${safe}</body>`;
  }

  /** Start `mrig serve --with-app`, once per window, and read its address and token. */
  private start(): Promise<ServeInfo> {
    if (this.info && this.child && this.child.exitCode === null) return Promise.resolve(this.info);
    const setting = vscode.workspace.getConfiguration('mrig').get<string>('path', '');
    const candidates = mrigCandidates(setting, homedir(), process.platform);
    return this.trySpawn(candidates);
  }

  private trySpawn(candidates: string[]): Promise<ServeInfo> {
    const [cmd, ...rest] = candidates;
    if (!cmd) {
      return Promise.reject(
        new Error(
          "Can't find the mrig program. Install mrig (see its README), or set mrig.path in Settings to where it is.",
        ),
      );
    }
    return new Promise<ServeInfo>((done, fail) => {
      const child = spawn(cmd, ['serve', '--with-app'], {
        cwd: this.cwd,
        env: process.env,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      let out = '';
      let err = '';
      const timer = setTimeout(() => {
        child.kill();
        fail(new Error(`mrig did not start within ${START_TIMEOUT_MS / 1000} s. ${err.trim()}`));
      }, START_TIMEOUT_MS);
      child.on('error', (e: NodeJS.ErrnoException) => {
        clearTimeout(timer);
        if (e.code === 'ENOENT') this.trySpawn(rest).then(done, fail);
        else fail(e);
      });
      child.stderr?.on('data', (d: Buffer) => {
        err += d.toString();
      });
      child.stdout?.on('data', (d: Buffer) => {
        if (this.info && this.child === child) return;
        out += d.toString();
        const line = out.split('\n')[0] ?? '';
        if (!out.includes('\n')) return;
        clearTimeout(timer);
        const info = parseServeLine(line);
        if (!info) {
          child.kill();
          fail(new Error(`mrig printed something unexpected: ${line.slice(0, 200)}`));
          return;
        }
        this.child = child;
        this.info = info;
        done(info);
      });
      child.on('exit', (code) => {
        clearTimeout(timer);
        if (this.child !== child) return;
        this.child = undefined;
        this.info = undefined;
        if (code !== 0 && code !== null) {
          void vscode.window
            .showErrorMessage(
              `mrig stopped (exit code ${code}). ${err.trim().slice(-300)}`,
              'Restart',
            )
            .then((pick) => {
              if (pick === 'Restart') void this.restart();
            });
        }
      });
    });
  }

  async restart(): Promise<void> {
    this.stop();
    if (this.view) await this.resolveWebviewView(this.view);
  }

  /** Stop the server: closing stdin is enough (mrig serve exits), and kill as a backstop. */
  stop(): void {
    const child = this.child;
    this.child = undefined;
    this.info = undefined;
    if (!child) return;
    child.stdin?.end();
    setTimeout(() => {
      if (child.exitCode === null) child.kill();
    }, 2000);
  }

  // ---- messages ----

  private toApp(message: unknown): void {
    if (!this.view || !this.ready) {
      this.queue.push(message);
      return;
    }
    void this.view.webview.postMessage({ toApp: message });
  }

  private async fromApp(m: FromApp): Promise<void> {
    if (!m || typeof m !== 'object') return;
    switch (m.type) {
      case 'ready':
        this.ready = true;
        for (const queued of this.queue.splice(0)) this.toApp(queued);
        return;
      case 'status':
        this.status.text = statusText(m);
        this.status.tooltip = `mrig: ${m.model}`;
        return;
      case 'ask':
        await this.showAsk(m);
        return;
      case 'ask.closed':
        await this.closeAsk(m.askId);
        return;
      case 'open':
        await this.openFile(m.path, m.line);
        return;
    }
  }

  // ---- permission requests in the diff editor ----

  private async showAsk(ask: Extract<FromApp, { type: 'ask' }>): Promise<void> {
    const display = ask.display;
    if (display && (display.kind === 'diff' || display.kind === 'file') && display.path) {
      const file = isAbsolute(display.path) ? display.path : resolve(this.cwd, display.path);
      let current: string | undefined;
      try {
        current = new TextDecoder().decode(
          await vscode.workspace.fs.readFile(vscode.Uri.file(file)),
        );
      } catch {
        current = undefined; // a new file
      }
      const proposal = proposedContent(display as Parameters<typeof proposedContent>[0], current);
      if (proposal) {
        this.proposals.set(ask.askId, proposal);
        this.pendingAsk = ask.askId;
        await vscode.commands.executeCommand('setContext', 'mrig.askOpen', true);
        const uri = (side: string) =>
          vscode.Uri.from({
            scheme: SCHEME,
            path: `/${basename(file)}`,
            query: `ask=${ask.askId}&side=${side}`,
          });
        await vscode.commands.executeCommand(
          'vscode.diff',
          uri('before'),
          uri('after'),
          `mrig wants to change ${display.path} (Allow or Deny in the title bar)`,
          { preview: true },
        );
        return;
      }
    }
    this.pendingAsk = ask.askId;
    await vscode.commands.executeCommand('setContext', 'mrig.askOpen', true);
    if (!this.view?.visible) {
      const pick = await vscode.window.showInformationMessage(
        `mrig wants to: ${ask.summary}`,
        'Show',
      );
      if (pick === 'Show') await this.show();
    }
  }

  private async closeAsk(askId: string): Promise<void> {
    this.proposals.delete(askId);
    if (this.pendingAsk === askId) {
      this.pendingAsk = undefined;
      await vscode.commands.executeCommand('setContext', 'mrig.askOpen', false);
    }
    const tabs = vscode.window.tabGroups.all
      .flatMap((g) => g.tabs)
      .filter(
        (t) =>
          t.input instanceof vscode.TabInputTextDiff &&
          t.input.modified.scheme === SCHEME &&
          t.input.modified.query.includes(`ask=${askId}&`),
      );
    if (tabs.length) await vscode.window.tabGroups.close(tabs, true);
  }

  answer(answer: 'yes' | 'no'): void {
    if (!this.pendingAsk) {
      void vscode.window.showInformationMessage('mrig is not waiting for an answer.');
      return;
    }
    this.toApp({ type: 'answer', askId: this.pendingAsk, answer });
  }

  /** The two sides of a proposed change, for the diff editor. */
  provideTextDocumentContent(uri: vscode.Uri): string {
    const params = new URLSearchParams(uri.query);
    const proposal = this.proposals.get(params.get('ask') ?? '');
    if (!proposal) return '';
    return params.get('side') === 'after' ? proposal.after : proposal.before;
  }

  // ---- editor features ----

  private async openFile(path: string, line?: number): Promise<void> {
    if (typeof path !== 'string' || !path) return;
    const file = isAbsolute(path) ? path : resolve(this.cwd, path);
    try {
      const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
      const at = Math.max(0, Math.min((line ?? 1) - 1, doc.lineCount - 1));
      const range = new vscode.Range(at, 0, at, 0);
      await vscode.window.showTextDocument(doc, { selection: range, preview: true });
    } catch {
      void vscode.window.showWarningMessage(`mrig: can't open ${path}`);
    }
  }

  async show(): Promise<void> {
    await vscode.commands.executeCommand('mrig.panel.focus');
  }

  async askAboutSelection(): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor) return;
    const sel = editor.selection;
    const rel = vscode.workspace.asRelativePath(editor.document.uri, false);
    const end =
      sel.end.character === 0 && sel.end.line > sel.start.line ? sel.end.line : sel.end.line + 1;
    await this.show();
    this.toApp({ type: 'insert', text: selectionText(rel, sel.start.line + 1, end) });
  }

  async addActiveFile(): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor) return;
    await this.show();
    this.toApp({
      type: 'insert',
      text: `\`${vscode.workspace.asRelativePath(editor.document.uri, false)}\` `,
    });
  }
}

let mrig: Mrig | undefined;

export function activate(context: vscode.ExtensionContext): void {
  mrig = new Mrig(context);
  const m = mrig;
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('mrig.panel', m, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.workspace.registerTextDocumentContentProvider(SCHEME, m),
    vscode.commands.registerCommand('mrig.show', () => m.show()),
    vscode.commands.registerCommand('mrig.askAboutSelection', () => m.askAboutSelection()),
    vscode.commands.registerCommand('mrig.addActiveFile', () => m.addActiveFile()),
    vscode.commands.registerCommand('mrig.allow', () => m.answer('yes')),
    vscode.commands.registerCommand('mrig.deny', () => m.answer('no')),
    vscode.commands.registerCommand('mrig.restart', () => m.restart()),
    { dispose: () => m.stop() },
  );
}

export function deactivate(): void {
  mrig?.stop();
}
