/**
 * The VS Code extension's logic with no `vscode` import (Track 4, U4), so `bun test` covers it:
 * reading `mrig serve`'s first line, the panel's HTML, the proposed file for a diff, the text a
 * selection sends, and where to find the `mrig` program.
 */
import { join } from 'node:path';

export interface ServeInfo {
  url: string;
  token: string;
}

/** `mrig serve` prints one JSON line first: `{"protocol":1,"url":…,"ws":…,"token":…}`. */
export function parseServeLine(line: string): ServeInfo | undefined {
  try {
    const v = JSON.parse(line) as { protocol?: unknown; url?: unknown; token?: unknown };
    if (
      v.protocol === 1 &&
      typeof v.url === 'string' &&
      /^http:\/\/127\.0\.0\.1:\d+$/.test(v.url) &&
      typeof v.token === 'string' &&
      /^[0-9a-f]{64}$/.test(v.token)
    ) {
      return { url: v.url, token: v.token };
    }
  } catch {
    // not the line we want
  }
  return undefined;
}

/** The app's address for the panel: host mode, the token and the folder in the fragment. */
export function appSrc(info: ServeInfo, cwd: string): string {
  const params = new URLSearchParams({ host: 'vscode', token: info.token, cwd });
  return `${info.url}/#${params.toString()}`;
}

/**
 * The panel's HTML: one frame showing the app from mrig's own server, and a few lines that pass
 * messages between the frame and the extension, from that frame and origin only.
 */
export function webviewHtml(info: ServeInfo, cwd: string, nonce: string): string {
  const origin = info.url;
  const src = appSrc(info, cwd).replaceAll('&', '&amp;').replaceAll('"', '&quot;');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; frame-src ${origin}; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
<style nonce="${nonce}">html,body,iframe{margin:0;padding:0;border:0;width:100%;height:100%;overflow:hidden;display:block}</style>
</head>
<body>
<iframe id="app" title="mrig" src="${src}" allow="clipboard-read; clipboard-write"></iframe>
<script nonce="${nonce}">
const vscode = acquireVsCodeApi();
const frame = document.getElementById('app');
const origin = ${JSON.stringify(origin)};
window.addEventListener('message', (e) => {
  if (e.source === frame.contentWindow && e.origin === origin) {
    vscode.postMessage(e.data);
  } else if (e.data && e.data.toApp) {
    frame.contentWindow.postMessage(e.data.toApp, origin);
  }
});
</script>
</body>
</html>`;
}

type Display =
  | { kind: 'diff'; path: string; before: string; after: string }
  | { kind: 'file'; path: string; content: string }
  | { kind: string; path?: string };

/** The marker `truncateMiddle` puts in text it cut; a cut snippet can't be found in the file. */
const CUT = /… \[[^\]]* characters truncated\] …/;

/**
 * What the diff editor shows for an edit or a write: the whole file before and after when the
 * edit's text is found exactly once in it, else just the snippet. Undefined for other tools.
 */
export function proposedContent(
  display: Display,
  current: string | undefined,
): { before: string; after: string } | undefined {
  if (display.kind === 'file' && 'content' in display) {
    return { before: current ?? '', after: display.content };
  }
  if (display.kind === 'diff' && 'before' in display) {
    const at = current?.indexOf(display.before) ?? -1;
    const once = current !== undefined && at >= 0 && current.indexOf(display.before, at + 1) < 0;
    if (once && !CUT.test(display.before) && !CUT.test(display.after)) {
      return {
        before: current,
        after: current.slice(0, at) + display.after + current.slice(at + display.before.length),
      };
    }
    return { before: display.before, after: display.after };
  }
  return undefined;
}

/** What "Ask mrig about this" puts in the message box: a reference the app shows as a link. */
export function selectionText(relativePath: string, start: number, end: number): string {
  const lines = start === end ? `${start}` : `${start}-${end}`;
  return `\`${relativePath}:${lines}\` `;
}

/** Where to look for `mrig`: the setting, then PATH, then the usual install folders. */
export function mrigCandidates(setting: string, home: string, platform: string): string[] {
  if (setting.trim()) return [setting.trim()];
  const exe = platform === 'win32' ? 'mrig.exe' : 'mrig';
  return [
    exe,
    join(home, '.local', 'bin', exe),
    ...(platform === 'win32' ? [] : ['/opt/homebrew/bin/mrig', '/usr/local/bin/mrig']),
  ];
}

/** The status bar's text. */
export function statusText(s: { model: string; cost?: number; running: boolean; waiting: number }) {
  if (s.waiting > 0) return `$(bell) mrig: ${s.waiting} waiting`;
  if (s.running) return `$(sync~spin) mrig · ${s.model}`;
  return `$(sparkle) mrig · ${s.model}${s.cost !== undefined ? ` · $${s.cost.toFixed(4)}` : ''}`;
}
