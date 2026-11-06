/**
 * Track 4, U2: the app server in device mode (`mrig app`) over a real loopback socket. Pairing,
 * the cookie login, uploads, revocation closing an open window, and the app's own files.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { connect as tcpConnect } from 'node:net';
import { join } from 'node:path';
import { APP_ASSETS } from '../src/server/app-assets.ts';
import { DeviceStore } from '../src/server/devices.ts';
import { SUBPROTOCOL, TOKEN_PROTOCOL_PREFIX } from '../src/server/protocol.ts';
import { cookieValue, deviceCookie, RateLimiter } from '../src/server/security.ts';
import { type RunningServer, startServer } from '../src/server/serve.ts';
import { mockModel, tempDir } from './helpers.ts';

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);

function rawStatus(port: number, lines: string[]): Promise<number> {
  return new Promise((resolve, reject) => {
    const sock = tcpConnect(port, '127.0.0.1', () => {
      sock.write(`${lines.join('\r\n')}\r\nConnection: close\r\n\r\n`);
    });
    sock.on('data', (d) => {
      const m = /^HTTP\/1\.1 (\d{3})/.exec(d.toString());
      if (m) {
        resolve(Number(m[1]));
        sock.destroy();
      }
    });
    sock.on('error', reject);
  });
}

describe('app server, device mode (U2)', () => {
  let home: ReturnType<typeof tempDir>;
  let server: RunningServer;
  let store: DeviceStore;
  let origin: string;
  const prevHome = process.env.MRIG_HOME;

  beforeEach(() => {
    home = tempDir('mrig-app-');
    process.env.MRIG_HOME = home.dir;
    writeFileSync(
      join(home.dir, 'config.json'),
      JSON.stringify({
        providers: {
          local: { kind: 'openai-compatible', baseURL: 'http://localhost:8000/v1', model: 'm' },
        },
      }),
    );
    store = new DeviceStore(join(home.dir, 'app'));
    server = startServer({
      version: 'test',
      checks: false,
      devices: store,
      app: APP_ASSETS,
      uploadsDir: join(home.dir, 'uploads'),
      runtime: { provider: 'local', languageModel: mockModel([]) },
    });
    origin = server.url;
  });
  afterEach(async () => {
    await server.stop();
    home.cleanup();
    if (prevHome === undefined) delete process.env.MRIG_HOME;
    else process.env.MRIG_HOME = prevHome;
  });

  const pair = (
    device: string,
    code: string,
    headers: Record<string, string> = { Origin: origin },
  ) =>
    fetch(`${server.url}/api/pair`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify({ device, code }),
    });
  const login = async (device = 'mac') => {
    const res = await pair(device, store.allow(device));
    expect(res.status).toBe(200);
    const cookie = (res.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
    return cookie;
  };
  const wsStatus = (headers: Record<string, string>) =>
    fetch(`${server.url}/ws`, {
      headers: { 'Sec-WebSocket-Protocol': SUBPROTOCOL, ...headers },
    }).then((r) => r.status);

  test('pairing sets an HttpOnly, SameSite=Strict cookie, and /api/me knows the device', async () => {
    expect((await fetch(`${server.url}/api/me`)).status).toBe(401);
    const res = await pair('mac', store.allow('mac'));
    expect(res.status).toBe(200);
    const setCookie = res.headers.get('set-cookie') ?? '';
    expect(setCookie).toMatch(
      /^mrig_device=mac\.[0-9a-f]{64}; Path=\/; HttpOnly; SameSite=Strict; Max-Age=7776000$/,
    );
    const cookie = setCookie.split(';')[0] ?? '';
    const me = await fetch(`${server.url}/api/me`, { headers: { Cookie: cookie } });
    expect(await me.json()).toEqual({ mode: 'device', device: 'mac' });
  });

  test('pairing refuses: no Origin, a foreign Origin, a wrong code, too many tries', async () => {
    const code = store.allow('phone');
    expect((await pair('phone', code, {})).status).toBe(403);
    expect((await pair('phone', code, { Origin: 'https://evil.example' })).status).toBe(403);
    const wrong = await pair('phone', 'WRONG234');
    expect(wrong.status).toBe(401);
    expect(await wrong.json()).toEqual({ reason: 'wrong' });
    expect(wrong.headers.get('set-cookie')).toBeNull();
    let last = 0;
    for (let i = 0; i < 12; i++) last = (await pair('phone', 'WRONG234')).status;
    expect(last).toBe(429);
  });

  test('the WebSocket needs the device cookie; a launch token does not work in device mode', async () => {
    expect(await wsStatus({})).toBe(401);
    expect(await wsStatus({ Cookie: `mrig_device=mac.${'0'.repeat(64)}` })).toBe(401);
    expect(
      await wsStatus({
        'Sec-WebSocket-Protocol': `${SUBPROTOCOL}, ${TOKEN_PROTOCOL_PREFIX}${'a'.repeat(64)}`,
      }),
    ).toBe(401);
    const cookie = await login();
    expect(await wsStatus({ Cookie: cookie })).toBe(400); // every check passed; only the upgrade is missing
    expect(await wsStatus({ Cookie: cookie, Origin: 'https://evil.example' })).toBe(403);
  });

  test('revoking a device closes its open window within seconds', async () => {
    const cookie = await login('phone');
    const ws = new WebSocket(server.ws, { protocols: [SUBPROTOCOL], headers: { Cookie: cookie } });
    await new Promise((ok, fail) => {
      ws.addEventListener('open', ok);
      ws.addEventListener('error', () => fail(new Error('refused')));
    });
    const closed = new Promise<number>((ok) => ws.addEventListener('close', (e) => ok(e.code)));
    new DeviceStore(join(home.dir, 'app')).revoke('phone'); // what `mrig app revoke phone` does
    expect(await closed).toBe(4001);
    expect(await wsStatus({ Cookie: cookie })).toBe(401);
  }, 10_000);

  test('uploads: logged in, images only, at most 5 MB, private files', async () => {
    const send = (
      body: Uint8Array | string,
      type: string,
      cookie?: string,
      extra: Record<string, string> = {},
    ) =>
      fetch(`${server.url}/api/upload`, {
        method: 'POST',
        headers: {
          'Content-Type': type,
          Origin: origin,
          ...(cookie ? { Cookie: cookie } : {}),
          ...extra,
        },
        body,
      });
    expect((await send(PNG, 'image/png')).status).toBe(401);
    const cookie = await login();
    expect((await send('hello', 'text/plain', cookie)).status).toBe(415);
    expect((await send(new Uint8Array(5 * 1024 * 1024 + 1), 'image/png', cookie)).status).toBe(413);
    expect((await send(PNG, 'image/png', cookie, { Origin: 'https://evil.example' })).status).toBe(
      403,
    );
    const ok = await send(PNG, 'image/png', cookie);
    expect(ok.status).toBe(200);
    const { path } = (await ok.json()) as { path: string };
    expect(path.startsWith(join(home.dir, 'uploads'))).toBe(true);
    expect(path.endsWith('.png')).toBe(true);
    expect(Buffer.from(await Bun.file(path).arrayBuffer())).toEqual(PNG);
    if (process.platform !== 'win32') expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  test("the app's own files load without a login; the page carries a strict CSP", async () => {
    const page = await fetch(`${server.url}/`);
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain('Content-Security-Policy');
    expect(html).toContain("default-src 'self'");
    expect(html).toContain("script-src 'self'");
    expect(html).not.toMatch(/<script>[^<]/); // nothing inline
    expect(html).not.toMatch(/https?:\/\/(?!127\.0\.0\.1)/); // nothing remote
    const sw = await fetch(`${server.url}/sw.js`);
    expect(sw.headers.get('content-type')).toContain('javascript');
    expect(sw.headers.get('cache-control')).toBe('no-cache');
    const manifest = (await (await fetch(`${server.url}/manifest.webmanifest`)).json()) as {
      display: string;
      icons: Array<{ sizes: string; purpose: string }>;
    };
    expect(manifest.display).toBe('standalone');
    expect(manifest.icons.map((i) => `${i.sizes}/${i.purpose}`)).toEqual([
      '192x192/any',
      '512x512/any',
      '512x512/maskable',
    ]);
    expect((await fetch(`${server.url}/icons/icon-512.png`)).headers.get('content-type')).toBe(
      'image/png',
    );
    expect(await rawStatus(server.port, ['GET /sw.js HTTP/1.1', 'Host: evil.example'])).toBe(403);
  });

  test('the uploads folder is created only when something is uploaded', () => {
    expect(existsSync(join(home.dir, 'uploads'))).toBe(false);
    expect(readdirSync(home.dir)).not.toContain('uploads');
  });
});

describe('token mode keeps working alongside (U1 clients, VS Code)', () => {
  test('/api/me says token mode, pairing is not offered, uploads take the bearer token', async () => {
    const home = tempDir('mrig-tok-');
    const prev = process.env.MRIG_HOME;
    process.env.MRIG_HOME = home.dir;
    const server = startServer({
      version: 'test',
      checks: false,
      uploadsDir: join(home.dir, 'uploads'),
      runtime: { languageModel: mockModel([]) },
    });
    try {
      expect(await (await fetch(`${server.url}/api/me`)).json()).toEqual({ mode: 'token' });
      expect((await fetch(`${server.url}/api/pair`, { method: 'POST' })).status).toBe(404);
      const up = (auth?: string) =>
        fetch(`${server.url}/api/upload`, {
          method: 'POST',
          headers: { 'Content-Type': 'image/png', ...(auth ? { Authorization: auth } : {}) },
          body: PNG,
        }).then((r) => r.status);
      expect(await up()).toBe(401);
      expect(await up(`Bearer ${'0'.repeat(64)}`)).toBe(401);
      expect(await up(`Bearer ${server.token}`)).toBe(200);
      expect((await fetch(`${server.url}/`)).status).toBe(404); // no app in token mode unless asked
    } finally {
      await server.stop();
      home.cleanup();
      if (prev === undefined) delete process.env.MRIG_HOME;
      else process.env.MRIG_HOME = prev;
    }
  });
});

describe('cookie and rate-limit helpers', () => {
  test('cookies are read by exact name, written with every flag', () => {
    expect(cookieValue('a=1; mrig_device=mac.abc; b=2', 'mrig_device')).toBe('mac.abc');
    expect(cookieValue('xmrig_device=evil', 'mrig_device')).toBeUndefined();
    expect(cookieValue(null, 'mrig_device')).toBeUndefined();
    expect(deviceCookie('n', 'v', 10, true)).toBe(
      'n=v; Path=/; HttpOnly; SameSite=Strict; Max-Age=10; Secure',
    );
  });

  test('the rate limiter allows a burst, then refuses until the window passes', () => {
    let now = 0;
    const limit = new RateLimiter(3, 1000, () => now);
    expect([1, 2, 3, 4].map(() => limit.hit('a'))).toEqual([true, true, true, false]);
    expect(limit.hit('b')).toBe(true);
    now = 1001;
    expect(limit.hit('a')).toBe(true);
  });
});
