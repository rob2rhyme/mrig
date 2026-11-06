/**
 * The bridge between the web app and an app that hosts it in a frame (Track 4, U4): the VS Code
 * extension shows the app in its panel and adds editor features through these messages.
 *
 * The app joins host mode only when the URL fragment says `host=vscode`, which only the
 * extension writes, together with the launch token. It talks only to its parent frame: every
 * message in must come from the parent window and its exact origin, and is checked field by
 * field; every message out is addressed to that origin only. The origin is a VS Code webview
 * (`vscode-webview://…`), or, with a launch token in the fragment, the `parent` given there
 * (the browser tests use that to stand in for VS Code).
 */
import type { ToolDisplay } from '../src/tools/types.ts';

export interface HostInfo {
  kind: 'vscode';
  /** The origin every message must come from and go to. */
  parentOrigin: string;
  /** The project to open: the VS Code workspace folder. */
  cwd?: string;
}

/** What the app tells its host. */
export type ToHost =
  | { type: 'ready' }
  | { type: 'status'; model: string; cost?: number; running: boolean; waiting: number }
  | { type: 'ask'; askId: string; summary: string; display?: ToolDisplay }
  | { type: 'ask.closed'; askId: string }
  | { type: 'open'; path: string; line?: number };

/** What a host may tell the app. */
export type FromHost =
  | { type: 'insert'; text: string }
  | { type: 'answer'; askId: string; answer: 'yes' | 'no' };

export function detectHost(
  hash: string,
  ancestorOrigins: readonly string[] = [],
): HostInfo | undefined {
  const params = new URLSearchParams(hash.replace(/^#/, ''));
  if (params.get('host') !== 'vscode') return undefined;
  const given = params.get('token') ? params.get('parent') : null;
  const parentOrigin =
    given ?? ancestorOrigins.find((o) => /^vscode-webview:\/\/[a-z0-9-]+$/i.test(o));
  if (!parentOrigin) return undefined;
  const cwd = params.get('cwd');
  return { kind: 'vscode', parentOrigin, ...(cwd ? { cwd } : {}) };
}

/** A message from the host, if it is one the app accepts; anything else is dropped. */
export function parseFromHost(data: unknown): FromHost | undefined {
  if (!data || typeof data !== 'object') return undefined;
  const d = data as Record<string, unknown>;
  if (d.type === 'insert' && typeof d.text === 'string' && d.text.length <= 20_000) {
    return { type: 'insert', text: d.text };
  }
  if (
    d.type === 'answer' &&
    typeof d.askId === 'string' &&
    d.askId.length <= 100 &&
    (d.answer === 'yes' || d.answer === 'no')
  ) {
    return { type: 'answer', askId: d.askId, answer: d.answer };
  }
  return undefined;
}

/**
 * A file reference in a reply, like `src/agent.ts`, `src/agent.ts:42` or `web/ui.tsx:10-20`,
 * that the host can open. Not a URL, and it must have a file extension.
 */
export function fileRef(text: string): { path: string; line?: number } | undefined {
  const m = /^(\.{0,2}\/?[\w@.+-]+(?:\/[\w@.+-]+)*\.[A-Za-z0-9]{1,8})(?::(\d+)(?:[-:]\d+)?)?$/.exec(
    text.trim(),
  );
  if (!m?.[1] || text.includes('://')) return undefined;
  const line = m[2] ? Number(m[2]) : undefined;
  return { path: m[1], ...(line ? { line } : {}) };
}
