/**
 * `mrig serve` (Track 4, U1): the hub behind a local HTTP + WebSocket server.
 *
 * It listens on 127.0.0.1 only, never on another interface, and refuses any request whose
 * `Host` is not that address (DNS rebinding). The WebSocket at `/ws` also needs an allowed
 * `Origin` (or none, for a program that is not a browser) and the launch token, offered as the
 * subprotocol `mrig.token.<hex>`. The first message must be `hello`. Media files come only
 * from `/media/<conversation>` links the hub signed, for files in that conversation's media
 * folders. Everything else is 404. See §3 of docs/decisions/2026-11-06-app-front-ends.md.
 */
import { extname } from 'node:path';
import { Hub, type HubClient, type HubOptions } from './hub.ts';
import { ClientMessage, type ServerMessage, SUBPROTOCOL } from './protocol.ts';
import {
  hostAllowed,
  MEDIA_TYPES,
  MediaSigner,
  newSecret,
  originAllowed,
  safeEqual,
  tokenFromProtocols,
} from './security.ts';

export const LISTEN_HOST = '127.0.0.1';
/** Largest WebSocket message accepted from a client. */
const MAX_MESSAGE_BYTES = 1024 * 1024;

export interface ServeOptions extends Omit<HubOptions, 'signer'> {
  /** 0 picks a free port (the default for `mrig serve`). */
  port?: number;
  /** The launch token; a new random one when absent. */
  token?: string;
}

export interface RunningServer {
  port: number;
  url: string;
  ws: string;
  token: string;
  hub: Hub;
  stop(): Promise<void>;
}

interface WsData {
  client: HubClient & { greeted: boolean };
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

export function startServer(opts: ServeOptions): RunningServer {
  const token = opts.token ?? newSecret();
  const hub = new Hub({ ...opts, signer: new MediaSigner() });
  let nextClient = 1;

  const server = Bun.serve({
    hostname: LISTEN_HOST,
    port: opts.port ?? 0,
    fetch(req, srv) {
      const port = srv.port ?? 0;
      if (!hostAllowed(req.headers.get('host'), port)) return reply(403, 'Forbidden host.');
      const url = new URL(req.url);

      if (url.pathname === '/ws') {
        if (!originAllowed(req.headers.get('origin'), port)) {
          return reply(403, 'Forbidden origin.');
        }
        const header = req.headers.get('sec-websocket-protocol');
        const offered = tokenFromProtocols(header);
        if (!offered || !safeEqual(offered, token)) return reply(401, 'Missing or wrong token.');
        const protocols = (header ?? '').split(',').map((p) => p.trim());
        if (!protocols.includes(SUBPROTOCOL)) return reply(400, `Use subprotocol ${SUBPROTOCOL}.`);
        const client = {
          id: `w${nextClient++}`,
          greeted: false,
          send: (_m: ServerMessage) => {},
        };
        const upgraded = srv.upgrade(req, {
          headers: { 'Sec-WebSocket-Protocol': SUBPROTOCOL },
          data: { client },
        });
        return upgraded ? undefined : reply(400, 'Expected a WebSocket upgrade.');
      }

      const media = /^\/media\/([^/]+)$/.exec(url.pathname);
      if (media && req.method === 'GET') {
        const conversation = decodeURIComponent(media[1] ?? '');
        const path = hub.signer.verify(conversation, url.searchParams);
        if (!path || !hub.mediaAllowed(conversation, path)) return reply(403, 'Forbidden.');
        const file = Bun.file(path);
        return file.exists().then((exists) =>
          exists
            ? new Response(file, {
                headers: {
                  ...BASE_HEADERS,
                  'Content-Type':
                    MEDIA_TYPES[extname(path).toLowerCase()] ?? 'application/octet-stream',
                  'Content-Security-Policy': "default-src 'none'; sandbox",
                },
              })
            : reply(404, 'Not found.'),
        );
      }
      return reply(404, 'Not found.');
    },
    websocket: {
      data: {} as WsData,
      maxPayloadLength: MAX_MESSAGE_BYTES,
      open(ws) {
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
        hub.detach(ws.data.client);
      },
    },
  });

  const port = server.port ?? 0;
  return {
    port,
    url: `http://${LISTEN_HOST}:${port}`,
    ws: `ws://${LISTEN_HOST}:${port}/ws`,
    token,
    hub,
    async stop() {
      await hub.close();
      await server.stop(true);
    },
  };
}
