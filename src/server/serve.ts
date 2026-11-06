/**
 * The app server behind `mrig serve` (Track 4, U1) and `mrig app` (U2).
 *
 * It listens on 127.0.0.1 only, never on another interface, and refuses any request whose
 * `Host` is not that address (DNS rebinding). Clients authenticate one of two ways:
 *
 * - **Launch token** (`mrig serve`, for the VS Code extension): offered as the WebSocket
 *   subprotocol `mrig.token.<hex>`, or `Authorization: Bearer <hex>` on an upload.
 * - **Device login** (`mrig app`): only devices on the allowlist (`devices.ts`), each paired once
 *   with a code; the device key travels in an HttpOnly, SameSite=Strict cookie.
 *
 * A browser's `Origin` must be the server's own (or a VS Code webview). The first WebSocket
 * message must be `hello`. Media files come only from `/media/<conversation>` links the hub
 * signed, for files in that conversation's media folders. The app's own files (HTML, scripts,
 * styles, icons) hold no secrets and load without a login. Everything else is 404.
 * See §3 and §4 of docs/decisions/2026-11-06-app-front-ends.md.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { extname, join } from 'node:path';
import type { ServerWebSocket } from 'bun';
import { IMAGE_TYPES, MAX_IMAGE_BYTES } from '../vision.ts';
import { appDir, COOKIE_NAME, type DeviceStore, KEY_IDLE_DAYS } from './devices.ts';
import { Hub, type HubClient, type HubOptions } from './hub.ts';
import { ClientMessage, type ServerMessage, SUBPROTOCOL } from './protocol.ts';
import {
  cookieValue,
  deviceCookie,
  hostAllowed,
  MEDIA_TYPES,
  MediaSigner,
  newSecret,
  originAllowed,
  RateLimiter,
  safeEqual,
  tokenFromProtocols,
} from './security.ts';

export const LISTEN_HOST = '127.0.0.1';
/** Largest WebSocket message accepted from a client. */
const MAX_MESSAGE_BYTES = 1024 * 1024;
/** How often a device-mode server checks the allowlist for revocations. */
const REVOKE_CHECK_MS = 2000;

/** The web app's files (U2): the HTML entry Bun bundles, and plain files by URL path. */
export interface AppAssets {
  page: Bun.HTMLBundle;
  files: Record<string, { path: string; type: string }>;
}

export interface ServeOptions extends Omit<HubOptions, 'signer'> {
  /** 0 picks a free port (the default for `mrig serve`). */
  port?: number;
  /** The launch token; a new random one when absent. Ignored in device mode. */
  token?: string;
  /** Device mode (`mrig app`): log in with an allowlisted device instead of a launch token. */
  devices?: DeviceStore;
  /** Serve the web app at `/`. */
  app?: AppAssets;
  /** Where uploaded images go (default ~/.mrig/app/uploads). */
  uploadsDir?: string;
}

export interface RunningServer {
  port: number;
  url: string;
  ws: string;
  /** The launch token (token mode only). */
  token: string;
  hub: Hub;
  stop(): Promise<void>;
}

interface Client extends HubClient {
  greeted: boolean;
  /** The device it logged in as (device mode), and that device's key hash at the time. */
  device?: string;
  keyHash?: string;
}

interface WsData {
  client: Client;
}

const BASE_HEADERS: Record<string, string> = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Cache-Control': 'no-store',
};

function reply(status: number, text: string): Response {
  return new Response(`${text}\n`, {
    status,
    headers: { ...BASE_HEADERS, 'Content-Type': 'text/plain; charset=utf-8' },
  });
}

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...BASE_HEADERS, 'Content-Type': 'application/json', ...headers },
  });
}

export function startServer(opts: ServeOptions): RunningServer {
  const token = opts.devices ? '' : (opts.token ?? newSecret());
  const hub = new Hub({ ...opts, signer: new MediaSigner() });
  const devices = opts.devices;
  const pairLimit = new RateLimiter(10, 60_000);
  const sockets = new Set<ServerWebSocket<WsData>>();
  let nextClient = 1;

  /** The device a request logs in as, in device mode. */
  const deviceOf = (req: Request, address: string) =>
    devices?.verify(cookieValue(req.headers.get('cookie'), COOKIE_NAME), address);
  /** True when the request carries the launch token as a bearer header (uploads). */
  const bearerOk = (req: Request) => {
    const h = req.headers.get('authorization') ?? '';
    return !devices && h.startsWith('Bearer ') && safeEqual(h.slice(7), token);
  };

  const staticRoutes: Record<string, (req: Request, srv: Bun.Server<WsData>) => Response> = {};
  for (const [path, file] of Object.entries(opts.app?.files ?? {})) {
    staticRoutes[path] = (req, srv) => {
      if (!hostAllowed(req.headers.get('host'), srv.port ?? 0))
        return reply(403, 'Forbidden host.');
      return new Response(Bun.file(file.path), {
        headers: {
          'X-Content-Type-Options': 'nosniff',
          'Content-Type': file.type,
          'Cache-Control': path === '/sw.js' ? 'no-cache' : 'public, max-age=3600',
        },
      });
    };
  }

  const server = Bun.serve({
    hostname: LISTEN_HOST,
    port: opts.port ?? 0,
    development: false,
    ...(opts.app ? { routes: { '/': opts.app.page, ...staticRoutes } } : {}),
    async fetch(req, srv) {
      const port = srv.port ?? 0;
      if (!hostAllowed(req.headers.get('host'), port)) return reply(403, 'Forbidden host.');
      const url = new URL(req.url);
      const address = srv.requestIP(req)?.address ?? '-';
      const origin = req.headers.get('origin');

      if (url.pathname === '/ws') {
        if (!originAllowed(origin, port)) return reply(403, 'Forbidden origin.');
        const header = req.headers.get('sec-websocket-protocol');
        const protocols = (header ?? '').split(',').map((p) => p.trim());
        const client: Client = { id: `w${nextClient++}`, greeted: false, send: () => {} };
        if (devices) {
          const device = deviceOf(req, address);
          if (!device) return reply(401, 'This device is not logged in.');
          client.device = device;
          client.keyHash = devices.get(device)?.keyHash;
        } else {
          const offered = tokenFromProtocols(header);
          if (!offered || !safeEqual(offered, token)) return reply(401, 'Missing or wrong token.');
        }
        if (!protocols.includes(SUBPROTOCOL)) return reply(400, `Use subprotocol ${SUBPROTOCOL}.`);
        const upgraded = srv.upgrade(req, {
          headers: { 'Sec-WebSocket-Protocol': SUBPROTOCOL },
          data: { client },
        });
        return upgraded ? undefined : reply(400, 'Expected a WebSocket upgrade.');
      }

      if (url.pathname === '/api/me' && req.method === 'GET') {
        if (!devices) return json(200, { mode: 'token' });
        const device = deviceOf(req, address);
        return device ? json(200, { mode: 'device', device }) : json(401, { mode: 'device' });
      }

      if (url.pathname === '/api/pair' && req.method === 'POST') {
        if (!devices) return reply(404, 'Not found.');
        // A pairing request must come from the app's own page.
        if (origin === null || !originAllowed(origin, port)) return reply(403, 'Forbidden origin.');
        if (!pairLimit.hit(address)) return json(429, { reason: 'slow-down' });
        const body = (await req.json().catch(() => null)) as { device?: unknown; code?: unknown };
        if (typeof body?.device !== 'string' || typeof body.code !== 'string') {
          return json(400, { reason: 'bad-request' });
        }
        const result = devices.pair(body.device, body.code.slice(0, 32), address);
        if (!result.ok) return json(401, { reason: result.reason });
        const secure = url.protocol === 'https:';
        return json(
          200,
          { device: body.device },
          {
            'Set-Cookie': deviceCookie(
              COOKIE_NAME,
              `${body.device}.${result.key}`,
              KEY_IDLE_DAYS * 86_400,
              secure,
            ),
          },
        );
      }

      if (url.pathname === '/api/upload' && req.method === 'POST') {
        if (origin !== null && !originAllowed(origin, port)) return reply(403, 'Forbidden origin.');
        if (!(devices ? deviceOf(req, address) : bearerOk(req))) return reply(401, 'Log in first.');
        const type = (req.headers.get('content-type') ?? '').split(';')[0]?.trim() ?? '';
        const ext = Object.entries(IMAGE_TYPES).find(([, t]) => t === type)?.[0];
        if (!ext) return reply(415, 'Only PNG, JPEG, WebP or GIF images.');
        if (Number(req.headers.get('content-length') ?? 0) > MAX_IMAGE_BYTES) {
          return reply(413, 'Images can be at most 5 MB.');
        }
        const bytes = new Uint8Array(await req.arrayBuffer());
        if (bytes.byteLength === 0) return reply(400, 'Empty upload.');
        if (bytes.byteLength > MAX_IMAGE_BYTES) return reply(413, 'Images can be at most 5 MB.');
        const dir = join(
          opts.uploadsDir ?? join(appDir(), 'uploads'),
          new Date().toISOString().slice(0, 10),
        );
        mkdirSync(dir, { recursive: true, mode: 0o700 });
        const path = join(dir, `${newSecret().slice(0, 16)}${ext}`);
        writeFileSync(path, bytes, { mode: 0o600 });
        return json(200, { path });
      }

      const media = /^\/media\/([^/]+)$/.exec(url.pathname);
      if (media && req.method === 'GET') {
        const conversation = decodeURIComponent(media[1] ?? '');
        const path = hub.signer.verify(conversation, url.searchParams);
        if (!path || !hub.mediaAllowed(conversation, path)) return reply(403, 'Forbidden.');
        const file = Bun.file(path);
        if (!(await file.exists())) return reply(404, 'Not found.');
        return new Response(file, {
          headers: {
            ...BASE_HEADERS,
            'Content-Type': MEDIA_TYPES[extname(path).toLowerCase()] ?? 'application/octet-stream',
            'Content-Security-Policy': "default-src 'none'; sandbox",
          },
        });
      }
      return reply(404, 'Not found.');
    },
    websocket: {
      data: {} as WsData,
      maxPayloadLength: MAX_MESSAGE_BYTES,
      open(ws) {
        sockets.add(ws);
        ws.data.client.send = (m: ServerMessage) => {
          ws.send(JSON.stringify(m));
        };
      },
      message(ws, raw) {
        const { client } = ws.data;
        let parsed: ReturnType<typeof ClientMessage.safeParse> | undefined;
        if (typeof raw === 'string') {
          try {
            parsed = ClientMessage.safeParse(JSON.parse(raw));
          } catch {
            parsed = undefined;
          }
        }
        if (!parsed?.success) {
          client.send({ type: 'error', message: 'Not a valid protocol message.' });
          if (!client.greeted) ws.close(1008, 'hello first');
          return;
        }
        if (!client.greeted) {
          if (parsed.data.type !== 'hello') {
            ws.close(1008, 'hello first');
            return;
          }
          client.greeted = true;
        }
        void hub.handle(client, parsed.data);
      },
      close(ws) {
        sockets.delete(ws);
        hub.detach(ws.data.client);
      },
    },
  });

  // Device mode: a revoked or re-paired device loses its open connections within seconds.
  let lastMtime = devices?.mtime() ?? 0;
  const watcher = devices
    ? setInterval(() => {
        const mtime = devices.mtime();
        if (mtime === lastMtime) return;
        lastMtime = mtime;
        for (const ws of sockets) {
          const { device, keyHash } = ws.data.client;
          if (device && devices.get(device)?.keyHash !== keyHash) ws.close(4001, 'revoked');
        }
      }, REVOKE_CHECK_MS)
    : undefined;

  const port = server.port ?? 0;
  return {
    port,
    url: `http://${LISTEN_HOST}:${port}`,
    ws: `ws://${LISTEN_HOST}:${port}/ws`,
    token,
    hub,
    async stop() {
      if (watcher) clearInterval(watcher);
      await hub.close();
      await server.stop(true);
    },
  };
}
