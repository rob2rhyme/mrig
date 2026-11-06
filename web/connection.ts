/**
 * The web app's link to `mrig serve` / `mrig app` (Track 4, U2): one WebSocket, `hello` first,
 * reconnect with back-off, and every open conversation reopened after a reconnect. Login is the
 * device cookie (app mode) or a launch token in the URL fragment (`#token=`, for VS Code).
 */
import type { ClientMessage, ServerMessage } from '../src/server/protocol.ts';
import type { LocalAction } from './model.ts';

export type Dispatch = (m: ServerMessage | LocalAction) => void;

/** What to send again after a reconnect: the sessions that were open, and which was active. */
export interface Reopen {
  sessions: Array<{ cwd: string; sessionId: string }>;
  active?: string;
}

const PROTOCOL = 1;

export class Connection {
  private ws: WebSocket | undefined;
  private attempt = 0;
  private stopped = false;
  private token: string | undefined;
  private connectedOnce = false;

  constructor(
    private readonly dispatch: Dispatch,
    private readonly reopen: () => Reopen,
  ) {}

  /** Check the login, then connect. Shows the pairing screen when this device isn't paired. */
  async start(): Promise<void> {
    const me = await fetch('/api/me', { credentials: 'same-origin' }).catch(() => undefined);
    if (!me) {
      this.dispatch({ type: 'local.connection', connection: 'reconnecting' });
      this.retryLater();
      return;
    }
    if (me.status === 401) {
      this.dispatch({ type: 'local.connection', connection: 'unauthorized' });
      return;
    }
    const info = (await me.json()) as { mode: 'token' | 'device' };
    if (info.mode === 'token') {
      this.token = new URLSearchParams(location.hash.slice(1)).get('token') ?? undefined;
    }
    this.open();
  }

  send(message: ClientMessage): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(message));
  }

  stop(): void {
    this.stopped = true;
    this.ws?.close();
  }

  private open(): void {
    const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
    const protocols = ['mrig.v1', ...(this.token ? [`mrig.token.${this.token}`] : [])];
    const ws = new WebSocket(`${scheme}://${location.host}/ws`, protocols);
    this.ws = ws;
    ws.addEventListener('open', () => {
      this.attempt = 0;
      ws.send(JSON.stringify({ type: 'hello', protocol: PROTOCOL }));
      ws.send(JSON.stringify({ type: 'projects.list' }));
      const again = this.reopen();
      if (this.connectedOnce) {
        this.dispatch({
          type: 'local.reset',
          ...(again.active ? { focusSession: again.active } : {}),
        });
        for (const s of again.sessions) {
          ws.send(JSON.stringify({ type: 'session.open', cwd: s.cwd, resume: s.sessionId }));
        }
      }
      this.connectedOnce = true;
    });
    ws.addEventListener('message', (e) => {
      try {
        this.dispatch(JSON.parse(String(e.data)) as ServerMessage);
      } catch {
        // A message that isn't JSON is a server bug; ignore it rather than break the page.
      }
    });
    ws.addEventListener('close', (e) => {
      if (this.stopped) return;
      if (e.code === 4001) {
        this.dispatch({ type: 'local.connection', connection: 'unauthorized' });
        return;
      }
      this.dispatch({ type: 'local.connection', connection: 'reconnecting' });
      this.retryLater();
    });
  }

  private retryLater(): void {
    const delay = Math.min(10_000, 500 * 2 ** this.attempt++);
    setTimeout(() => {
      if (!this.stopped) void this.start();
    }, delay);
  }
}

/** Pair this browser with a one-time code from `mrig app allow add <name>`. */
export async function pair(
  device: string,
  code: string,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const res = await fetch('/api/pair', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ device, code }),
  }).catch(() => undefined);
  if (!res) return { ok: false, reason: 'offline' };
  if (res.ok) return { ok: true };
  const body = (await res.json().catch(() => ({}))) as { reason?: string };
  return { ok: false, reason: body.reason ?? `http-${res.status}` };
}

/** Upload an image for the next message; returns the path to put in it. */
export async function upload(file: File, token?: string): Promise<string> {
  const res = await fetch('/api/upload', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': file.type, ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: file,
  });
  if (!res.ok) throw new Error((await res.text()).trim() || `Upload failed (${res.status}).`);
  return ((await res.json()) as { path: string }).path;
}
