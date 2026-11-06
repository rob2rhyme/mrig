/**
 * Track 4, U1: the app server over a real loopback socket, with mock models (no internet).
 * Streaming, permissions, abort, reconnect, two conversations at once, and a refusing test
 * for every security rule that applies to U1.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { connect as tcpConnect } from 'node:net';
import { join } from 'node:path';
import { MockImageModelV4 } from 'ai/test';
import { parseArgs } from '../src/cli/args.ts';
import type { RuntimeDefaults } from '../src/server/hub.ts';
import {
  type ClientMessage,
  PROTOCOL_VERSION,
  type ServerMessage,
  SUBPROTOCOL,
  TOKEN_PROTOCOL_PREFIX,
} from '../src/server/protocol.ts';
import {
  hostAllowed,
  insideMediaFolders,
  MediaSigner,
  originAllowed,
  safeEqual,
  tokenFromProtocols,
} from '../src/server/security.ts';
import { type RunningServer, startServer } from '../src/server/serve.ts';
import { transcriptItems } from '../src/server/transcript.ts';
import { DEFAULT_TOOLS } from '../src/tools/index.ts';
import { mockModel, tempDir, textTurn, toolTurn } from './helpers.ts';

const LOCAL = {
  kind: 'openai-compatible',
  baseURL: 'http://localhost:8000/v1',
  model: 'm',
  pricing: { input: 0, output: 0 },
};

/** A connected test client: every server message lands in `got`; `next` waits for one. */
interface Client {
  ws: WebSocket;
  got: ServerMessage[];
  send(m: ClientMessage | Record<string, unknown>): void;
  next<T extends ServerMessage['type']>(
    type: T,
    where?: (m: Extract<ServerMessage, { type: T }>) => boolean,
  ): Promise<Extract<ServerMessage, { type: T }>>;
  closed: Promise<{ code: number; reason: string }>;
}

function connect(
  server: RunningServer,
  opts: { token?: string; origin?: string; protocols?: string[]; hello?: boolean } = {},
): Promise<Client> {
  const protocols = opts.protocols ?? [
    SUBPROTOCOL,
    `${TOKEN_PROTOCOL_PREFIX}${opts.token ?? server.token}`,
  ];
  const ws = new WebSocket(server.ws, {
    protocols,
    ...(opts.origin ? { headers: { Origin: opts.origin } } : {}),
  });
  const got: ServerMessage[] = [];
  const waiters: Array<() => void> = [];
  ws.addEventListener('message', (e) => {
    got.push(JSON.parse(String(e.data)) as ServerMessage);
    for (const w of waiters.splice(0)) w();
  });
  const closed = new Promise<{ code: number; reason: string }>((resolve) =>
    ws.addEventListener('close', (e) => resolve({ code: e.code, reason: e.reason })),
  );
  const client: Client = {
    ws,
    got,
    closed,
    send: (m) => ws.send(JSON.stringify(m)),
    next(type, where) {
      let seen = 0;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(
          () =>
            reject(
              new Error(`timed out waiting for ${type}; got ${got.map((m) => m.type).join(', ')}`),
            ),
          5000,
        );
        const look = () => {
          for (; seen < got.length; seen++) {
            const m = got[seen] as ServerMessage;
            if (m.type === type && (!where || where(m as never))) {
              got.splice(seen, 1);
              clearTimeout(timer);
              resolve(m as never);
              return;
            }
          }
          waiters.push(look);
        };
        look();
      });
    },
  };
  return new Promise((resolve, reject) => {
    ws.addEventListener('open', () => {
      if (opts.hello !== false) client.send({ type: 'hello', protocol: PROTOCOL_VERSION });
      resolve(client);
    });
    ws.addEventListener('error', () => reject(new Error('connection refused')));
  });
}

/** A raw HTTP request, for headers a fetch or WebSocket client won't let us forge (Host). */
function rawStatus(port: number, lines: string[]): Promise<number> {
  return new Promise((resolve, reject) => {
    const sock = tcpConnect(port, '127.0.0.1', () => {
      sock.write(`${lines.join('\r\n')}\r\nConnection: close\r\n\r\n`);
    });
    let buf = '';
    sock.on('data', (d) => {
      buf += d.toString();
      const m = /^HTTP\/1\.1 (\d{3})/.exec(buf);
      if (m) {
        resolve(Number(m[1]));
        sock.destroy();
      }
    });
    sock.on('error', reject);
  });
}

describe('app server (U1)', () => {
  let home: ReturnType<typeof tempDir>;
  let project: ReturnType<typeof tempDir>;
  let server: RunningServer | undefined;
  const clients: Client[] = [];
  const prevHome = process.env.MRIG_HOME;

  beforeEach(() => {
    home = tempDir('mrig-home-');
    project = tempDir('mrig-proj-');
    process.env.MRIG_HOME = home.dir;
    writeFileSync(
      join(home.dir, 'config.json'),
      JSON.stringify({
        providers: { local: LOCAL },
        image: { profile: 'local', model: 'mock-image', pricePerImage: 0.04 },
      }),
    );
  });
  afterEach(async () => {
    for (const c of clients.splice(0)) c.ws.close();
    await server?.stop();
    server = undefined;
    home.cleanup();
    project.cleanup();
    if (prevHome === undefined) delete process.env.MRIG_HOME;
    else process.env.MRIG_HOME = prevHome;
  });

  const start = (
    runtime: RuntimeDefaults | ((cwd: string) => RuntimeDefaults),
    extra: { askTimeoutMs?: number } = {},
  ) => {
    server = startServer({ version: 'test', checks: false, runtime, ...extra });
    return server;
  };
  const local = (turns: Parameters<typeof mockModel>[0], extra: Partial<RuntimeDefaults> = {}) =>
    ({ provider: 'local', languageModel: mockModel(turns), ...extra }) as RuntimeDefaults;
  const join_ = async (s: RunningServer, opts?: Parameters<typeof connect>[1]) => {
    const c = await connect(s, opts);
    clients.push(c);
    await c.next('hello.ok');
    return c;
  };
  const open = async (c: Client, cwd = project.dir, resume?: string) => {
    c.send({ type: 'session.open', cwd, ...(resume ? { resume } : {}) });
    return c.next('snapshot');
  };

  test('listens on 127.0.0.1 only and prints where', () => {
    const s = start(local([]));
    expect(s.url).toBe(`http://127.0.0.1:${s.port}`);
    expect(s.ws).toBe(`ws://127.0.0.1:${s.port}/ws`);
    expect(s.token).toMatch(/^[0-9a-f]{64}$/);
  });

  test('a turn streams text, then ends with the status', async () => {
    const s = start(local([textTurn('Hello from mrig.')]));
    const c = await join_(s);
    const snap = await open(c);
    expect(snap.items).toEqual([]);
    expect(snap.running).toBe(false);
    const conversation = snap.info.conversation;
    c.send({ type: 'turn.send', conversation, text: 'hi' });
    expect((await c.next('turn.start')).text).toBe('hi');
    expect((await c.next('turn.end')).result).toBe('ok');
    const streamed = c.got
      .filter((m): m is Extract<ServerMessage, { type: 'text.delta' }> => m.type === 'text.delta')
      .map((m) => m.delta)
      .join('');
    expect(streamed).toBe('Hello from mrig.');
    expect((await c.next('status')).status.model).toContain('local');
  });

  test('permission round trip: the ask, the answer, and the tool card with its display', async () => {
    const s = start(
      local([toolTurn('write', '{"path":"a.txt","content":"one\\ntwo"}', 'w1'), textTurn('done')]),
    );
    const c = await join_(s);
    const { info } = await open(c);
    c.send({ type: 'turn.send', conversation: info.conversation, text: 'make a file' });
    const start_ = await c.next('tool.start');
    expect(start_).toMatchObject({
      name: 'write',
      summary: 'write a.txt (2 lines)',
      display: { kind: 'file', path: 'a.txt', content: 'one\ntwo' },
    });
    const ask = await c.next('ask');
    expect(ask.summary).toBe('write a.txt (2 lines)');
    expect(ask.alwaysRule).toContain('write');
    c.send({ type: 'ask.answer', askId: ask.askId, answer: 'yes' });
    expect((await c.next('ask.closed')).answer).toBe('yes');
    expect((await c.next('tool.end')).status).toBe('ok');
    expect((await c.next('turn.end')).result).toBe('ok');
    expect(await Bun.file(join(project.dir, 'a.txt')).text()).toBe('one\ntwo');
  });

  test('a denied call reports denied and changes nothing', async () => {
    const s = start(local([toolTurn('write', '{"path":"no.txt","content":"x"}'), textTurn('ok')]));
    const c = await join_(s);
    const { info } = await open(c);
    c.send({ type: 'turn.send', conversation: info.conversation, text: 'try' });
    const ask = await c.next('ask');
    c.send({ type: 'ask.answer', askId: ask.askId, answer: 'no' });
    expect((await c.next('tool.end')).status).toBe('denied');
    await c.next('turn.end');
    expect(await Bun.file(join(project.dir, 'no.txt')).exists()).toBe(false);
  });

  test('an unanswered question times out as deny', async () => {
    const s = start(local([toolTurn('write', '{"path":"t.txt","content":"x"}'), textTurn('ok')]), {
      askTimeoutMs: 50,
    });
    const c = await join_(s);
    const { info } = await open(c);
    c.send({ type: 'turn.send', conversation: info.conversation, text: 'try' });
    await c.next('ask');
    expect((await c.next('ask.closed')).answer).toBe('no');
    expect((await c.next('tool.end')).status).toBe('denied');
  });

  test('Stop denies the open question and ends the turn as aborted', async () => {
    const s = start(
      local([toolTurn('write', '{"path":"s.txt","content":"x"}'), textTurn('never')]),
    );
    const c = await join_(s);
    const { info } = await open(c);
    c.send({ type: 'turn.send', conversation: info.conversation, text: 'go' });
    await c.next('ask');
    c.send({ type: 'turn.abort', conversation: info.conversation });
    expect((await c.next('ask.closed')).answer).toBe('no');
    expect((await c.next('turn.end')).result).toBe('aborted');
    expect(await Bun.file(join(project.dir, 's.txt')).exists()).toBe(false);
  });

  test('one turn at a time per conversation', async () => {
    const s = start(local([toolTurn('write', '{"path":"b.txt","content":"x"}'), textTurn('ok')]));
    const c = await join_(s);
    const { info } = await open(c);
    c.send({ type: 'turn.send', conversation: info.conversation, text: 'first' });
    await c.next('ask');
    c.send({ type: 'turn.send', conversation: info.conversation, text: 'second' });
    expect((await c.next('error')).message).toContain('A turn is running');
  });

  test('reconnect: a second client resumes the same conversation and gets the full snapshot', async () => {
    const s = start(
      local([toolTurn('write', '{"path":"r.txt","content":"x"}', 'w9'), textTurn('All done.')]),
    );
    const a = await join_(s);
    const { info } = await open(a);
    a.send({ type: 'turn.send', conversation: info.conversation, text: 'please write' });
    const ask = await a.next('ask');
    a.send({ type: 'ask.answer', askId: ask.askId, answer: 'yes' });
    await a.next('turn.end');

    const b = await join_(s);
    const snap = await open(b, project.dir, info.sessionId);
    expect(snap.info.conversation).toBe(info.conversation); // the same runtime, not a copy
    expect(snap.items).toEqual([
      { kind: 'user', text: 'please write' },
      {
        kind: 'tool',
        id: 'w9',
        name: 'write',
        summary: 'write r.txt (1 line)',
        display: { kind: 'file', path: 'r.txt', content: 'x' },
        status: 'ok',
        output: expect.stringContaining('r.txt'),
      },
      { kind: 'assistant', text: 'All done.' },
    ]);
  });

  test('two clients on one conversation both see a question; the first answer wins', async () => {
    const s = start(local([toolTurn('write', '{"path":"d.txt","content":"x"}'), textTurn('ok')]));
    const a = await join_(s);
    const { info } = await open(a);
    const b = await join_(s);
    await open(b, project.dir, info.sessionId);
    a.send({ type: 'turn.send', conversation: info.conversation, text: 'go' });
    const askA = await a.next('ask');
    const askB = await b.next('ask');
    expect(askB.askId).toBe(askA.askId);
    b.send({ type: 'ask.answer', askId: askB.askId, answer: 'yes' });
    await a.next('ask.closed');
    a.send({ type: 'ask.answer', askId: askA.askId, answer: 'no' });
    expect((await a.next('error')).message).toContain('is not open');
    expect((await a.next('tool.end')).status).toBe('ok');
  });

  test('two conversations run at once, each with its own stream', async () => {
    const other = tempDir('mrig-proj2-');
    try {
      const s = start((cwd) =>
        local([textTurn(cwd === other.dir ? 'second project' : 'first project')]),
      );
      const c = await join_(s);
      const one = (await open(c)).info.conversation;
      const two = (await open(c, other.dir)).info.conversation;
      expect(one).not.toBe(two);
      c.send({ type: 'turn.send', conversation: one, text: 'a' });
      c.send({ type: 'turn.send', conversation: two, text: 'b' });
      await c.next('turn.end', (m) => m.conversation === one);
      await c.next('turn.end', (m) => m.conversation === two);
      const text = (conv: string) =>
        c.got
          .filter(
            (m): m is Extract<ServerMessage, { type: 'text.delta' }> => m.type === 'text.delta',
          )
          .filter((m) => m.conversation === conv)
          .map((m) => m.delta)
          .join('');
      expect(text(one)).toBe('first project');
      expect(text(two)).toBe('second project');
    } finally {
      other.cleanup();
    }
  });

  test('slash commands run and their output comes back without colour codes', async () => {
    const s = start(local([]));
    const c = await join_(s);
    const { info } = await open(c);
    c.send({ type: 'command.run', conversation: info.conversation, text: '/cost' });
    const out = await c.next('command.output');
    expect(out.text).toContain('requests');
    expect(out.text).not.toContain('\x1b[');
    await c.next('snapshot');
  });

  test('model and mode pickers use the same code paths as /model and /mode', async () => {
    const s = start(local([]));
    const c = await join_(s);
    const { info } = await open(c);
    c.send({ type: 'mode.set', conversation: info.conversation, mode: 'learn' });
    expect((await c.next('snapshot')).status.mode).toContain('learn');
    c.send({ type: 'mode.set', conversation: info.conversation, mode: 'nonsense' });
    expect((await c.next('error')).message).toContain('Unknown mode');
  });

  test('sessions and projects are listed for the sidebar', async () => {
    const s = start(local([textTurn('saved')]));
    const c = await join_(s);
    const { info } = await open(c);
    c.send({ type: 'turn.send', conversation: info.conversation, text: 'remember me' });
    await c.next('turn.end');
    c.send({ type: 'sessions.list', cwd: project.dir });
    const list = await c.next('sessions');
    expect(list.sessions.map((x) => x.id)).toContain(info.sessionId);
    c.send({ type: 'projects.list' });
    expect((await c.next('projects')).projects.map((p) => p.cwd)).toContain(project.dir);
    c.send({ type: 'sessions.list', cwd: 'relative/path' });
    expect((await c.next('error')).message).toContain('absolute path');
  });

  test('a generated image comes back as a signed media link that the server serves', async () => {
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
      'base64',
    );
    const imageModel = new MockImageModelV4({
      modelId: 'mock-image',
      doGenerate: async (o) => ({
        images: Array.from({ length: o.n }, () => png.toString('base64')),
        warnings: [],
        response: { timestamp: new Date(0), modelId: 'mock-image', headers: undefined },
      }),
    });
    const s = start(
      local([toolTurn('image', '{"prompt":"a red fox"}'), textTurn('here')], { imageModel }),
    );
    const c = await join_(s);
    const { info } = await open(c);
    c.send({ type: 'turn.send', conversation: info.conversation, text: 'draw' });
    const ask = await c.next('ask');
    c.send({ type: 'ask.answer', askId: ask.askId, answer: 'yes' });
    const end = await c.next('tool.end');
    expect(end.status).toBe('ok');
    const media = end.media?.[0];
    expect(media?.kind).toBe('image');
    const res = await fetch(`${s.url}${media?.url}`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/png');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(Buffer.from(await res.arrayBuffer())).toEqual(png);
  });

  describe('security: each rule refuses', () => {
    test('a wrong Host is refused (DNS rebinding)', async () => {
      const s = start(local([]));
      expect(await rawStatus(s.port, ['GET /ws HTTP/1.1', 'Host: evil.example'])).toBe(403);
      expect(await rawStatus(s.port, ['GET /ws HTTP/1.1', `Host: evil.example:${s.port}`])).toBe(
        403,
      );
      expect(await rawStatus(s.port, ['GET /nope HTTP/1.1', `Host: 127.0.0.1:${s.port}`])).toBe(
        404,
      );
    });

    test('no token, a wrong token, or no mrig.v1 subprotocol is refused', async () => {
      const s = start(local([]));
      const status = (protocol?: string) =>
        fetch(
          `${s.url}/ws`,
          protocol ? { headers: { 'Sec-WebSocket-Protocol': protocol } } : {},
        ).then((r) => r.status);
      expect(await status()).toBe(401);
      expect(await status(`${SUBPROTOCOL}, ${TOKEN_PROTOCOL_PREFIX}${'0'.repeat(64)}`)).toBe(401);
      expect(await status(`${TOKEN_PROTOCOL_PREFIX}${s.token}`)).toBe(400);
      // The right token and subprotocol pass every check; only the upgrade itself is missing.
      expect(await status(`${SUBPROTOCOL}, ${TOKEN_PROTOCOL_PREFIX}${s.token}`)).toBe(400);
      await expect(connect(s, { token: 'f'.repeat(64) })).rejects.toThrow('connection refused');
    });

    test("another website's Origin is refused; the server's own and VS Code's are not", async () => {
      const s = start(local([]));
      await expect(connect(s, { origin: 'https://evil.example' })).rejects.toThrow(
        'connection refused',
      );
      await expect(connect(s, { origin: `http://localhost:${s.port + 1}` })).rejects.toThrow(
        'connection refused',
      );
      const own = await join_(s, { origin: `http://127.0.0.1:${s.port}` });
      expect(own.ws.protocol).toBe(SUBPROTOCOL); // the token is never echoed back
      await join_(s, { origin: 'vscode-webview://1a2b3c' });
    });

    test('the first message must be hello; a malformed one later is refused but harmless', async () => {
      const s = start(local([]));
      const early = await connect(s, { hello: false });
      clients.push(early);
      early.send({ type: 'projects.list' });
      expect((await early.closed).code).toBe(1008);

      const late = await join_(s);
      late.ws.send('not json');
      expect((await late.next('error')).message).toBe('Not a valid protocol message.');
      late.send({ type: 'turn.send', conversation: 'c1', text: '' });
      await late.next('error');
      late.send({ type: 'projects.list' });
      await late.next('projects'); // still connected
    });

    test('a client cannot act on a conversation it did not open', async () => {
      const s = start(local([textTurn('x')]));
      const owner = await join_(s);
      const { info } = await open(owner);
      const stranger = await join_(s);
      stranger.send({ type: 'turn.send', conversation: info.conversation, text: 'hi' });
      expect((await stranger.next('error')).message).toContain('No open conversation');
    });

    test('media: only signed links, only inside the media folders, no symlink escape', async () => {
      const s = start(local([]));
      const c = await join_(s);
      const { info } = await open(c);
      const conv = info.conversation;
      mkdirSync(join(project.dir, 'images'));
      const inside = join(project.dir, 'images', 'ok.png');
      writeFileSync(inside, 'png');
      const outside = join(project.dir, 'secret.png');
      writeFileSync(outside, 'secret');
      // Windows needs Developer Mode or admin rights for a symlink; skip only that check there.
      let linked = true;
      try {
        symlinkSync(outside, join(project.dir, 'images', 'link.png'));
      } catch {
        linked = false;
      }
      writeFileSync(join(project.dir, 'images', 'notes.txt'), 'text');
      const get = (path: string) => fetch(`${s.url}${path}`).then((r) => r.status);

      expect(await get(s.hub.signer.url(conv, inside))).toBe(200);
      const good = s.hub.signer.url(conv, inside);
      expect(await get(good.replace(/s=[^&]+$/, 's=AAAA'))).toBe(403); // tampered signature
      expect(await get(good.replace(`/media/${conv}`, '/media/c999'))).toBe(403); // other conversation
      expect(await get(s.hub.signer.url(conv, outside))).toBe(403); // signed, but not a media folder
      if (linked) {
        expect(await get(s.hub.signer.url(conv, join(project.dir, 'images', 'link.png')))).toBe(
          403,
        );
      }
      expect(await get(s.hub.signer.url(conv, join(project.dir, 'images', 'notes.txt')))).toBe(403);
      expect(await get(`/media/${conv}`)).toBe(403); // no link at all
    });
  });

  test('`mrig serve` prints its address and token, and exits when its parent closes stdin', async () => {
    const proc = Bun.spawn(['bun', join(import.meta.dir, '..', 'src', 'index.ts'), 'serve'], {
      env: { ...process.env, MRIG_HOME: home.dir },
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const reader = proc.stdout.getReader();
    let line = '';
    while (!line.includes('\n')) {
      const { value, done } = await reader.read();
      if (done) break;
      line += new TextDecoder().decode(value);
    }
    const info = JSON.parse(line) as { protocol: number; url: string; ws: string; token: string };
    expect(info.protocol).toBe(1);
    expect(info.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    const port = Number(info.url.split(':')[2]);
    const c = await connect(
      { port, url: info.url, ws: info.ws, token: info.token } as RunningServer,
      {},
    );
    await c.next('hello.ok');
    c.ws.close();
    proc.stdin.end();
    expect(await proc.exited).toBe(0);
  });
});

describe('app server security rules, one by one', () => {
  test('Host must name this server', () => {
    expect(hostAllowed('127.0.0.1:4747', 4747)).toBe(true);
    expect(hostAllowed('LOCALHOST:4747', 4747)).toBe(true);
    expect(hostAllowed('127.0.0.1:4748', 4747)).toBe(false);
    expect(hostAllowed('evil.example:4747', 4747)).toBe(false);
    expect(hostAllowed(null, 4747)).toBe(false);
  });

  test("Origin: none (not a browser), the server's own, or a VS Code webview", () => {
    expect(originAllowed(null, 4747)).toBe(true);
    expect(originAllowed('http://127.0.0.1:4747', 4747)).toBe(true);
    expect(originAllowed('http://localhost:4747', 4747)).toBe(true);
    expect(originAllowed('vscode-webview://0abc-12', 4747)).toBe(true);
    expect(originAllowed('https://127.0.0.1:4747', 4747)).toBe(false);
    expect(originAllowed('http://127.0.0.1:4747.evil.example', 4747)).toBe(false);
    expect(originAllowed('vscode-webview://x.evil.example/', 4747)).toBe(false);
    expect(originAllowed('null', 4747)).toBe(false);
  });

  test('the token is read from the subprotocols and compared in full', () => {
    expect(tokenFromProtocols(`mrig.v1, ${TOKEN_PROTOCOL_PREFIX}abc`)).toBe('abc');
    expect(tokenFromProtocols('mrig.v1')).toBeUndefined();
    expect(tokenFromProtocols(null)).toBeUndefined();
    expect(safeEqual('abc', 'abc')).toBe(true);
    expect(safeEqual('abc', 'abd')).toBe(false);
    expect(safeEqual('abc', 'abcd')).toBe(false);
  });

  test('media links expire and cannot be moved to another file', () => {
    let now = 1_000;
    const signer = new MediaSigner('k', () => now, 100);
    const url = new URL(`http://x${signer.url('c1', '/p/images/a.png')}`);
    expect(signer.verify('c1', url.searchParams)).toBe('/p/images/a.png');
    expect(signer.verify('c2', url.searchParams)).toBeUndefined();
    const moved = new URLSearchParams(url.searchParams);
    moved.set('p', Buffer.from('/p/images/b.png').toString('base64url'));
    expect(signer.verify('c1', moved)).toBeUndefined();
    now = 2_000;
    expect(signer.verify('c1', url.searchParams)).toBeUndefined();
  });

  test('media folders: relative paths, other types and ".." are refused', () => {
    const t = tempDir();
    try {
      mkdirSync(join(t.dir, 'images'));
      writeFileSync(join(t.dir, 'images', 'a.png'), 'x');
      writeFileSync(join(t.dir, 'b.png'), 'x');
      const folders = [join(t.dir, 'images')];
      expect(insideMediaFolders(join(t.dir, 'images', 'a.png'), folders)).toBe(true);
      expect(insideMediaFolders(join(t.dir, 'images', '..', 'b.png'), folders)).toBe(false);
      expect(insideMediaFolders('images/a.png', folders)).toBe(false);
      expect(insideMediaFolders(join(t.dir, 'images'), folders)).toBe(false);
      expect(insideMediaFolders(join(t.dir, 'images', 'missing.png'), folders)).toBe(false);
    } finally {
      t.cleanup();
    }
  });

  test('a saved transcript becomes items, with denied calls marked', () => {
    const items = transcriptItems(
      [
        { role: 'user', content: 'fix it' },
        {
          role: 'assistant',
          content: [
            { type: 'text', text: 'Looking.' },
            {
              type: 'tool-call',
              toolCallId: 't1',
              toolName: 'bash',
              input: { command: 'rm -rf build' },
            },
          ],
        },
        {
          role: 'tool',
          content: [
            {
              type: 'tool-result',
              toolCallId: 't1',
              toolName: 'bash',
              output: {
                type: 'error-text',
                value:
                  'The user denied this tool call. Do not retry the same call; explain what you wanted to do and ask how to proceed, or take a different approach.',
              },
            },
          ],
        },
      ],
      DEFAULT_TOOLS,
    );
    expect(items).toEqual([
      { kind: 'user', text: 'fix it' },
      { kind: 'assistant', text: 'Looking.' },
      {
        kind: 'tool',
        id: 't1',
        name: 'bash',
        summary: '$ rm -rf build',
        display: { kind: 'command', command: 'rm -rf build' },
        status: 'denied',
        output: expect.stringContaining('denied'),
      },
    ]);
  });

  test('`mrig serve` arguments', () => {
    expect(parseArgs(['serve'])).toMatchObject({ serve: true });
    expect(parseArgs(['serve', '--port', '4747'])).toMatchObject({ serve: true, port: 4747 });
    expect(() => parseArgs(['--port', '4747'])).toThrow('--port works with mrig serve');
    expect(() => parseArgs(['serve', '--port', '70000'])).toThrow('0 to 65535');
    expect(() => parseArgs(['serve', 'hello'])).toThrow('takes no prompt');
    expect(parseArgs(['serve', '--with-app'])).toMatchObject({ serve: true, withApp: true });
    expect(parseArgs(['serve']).withApp).toBeFalsy();
    expect(() => parseArgs(['--with-app'])).toThrow('--with-app works with mrig serve');
    expect(parseArgs(['serve the soup'])).toMatchObject({ serve: false, prompt: 'serve the soup' });
  });
});
