/**
 * Track 4, U3: other devices through Tailscale Serve. The pure rules (which requests count as
 * the Mac's, which as another device's, which are refused), the Tailscale login pin, reading
 * Tailscale's status, the background service, and a real `mrig app` server driven with the
 * headers Tailscale Serve sends (checked against its source: ipn/ipnlocal/serve.go).
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from '../src/cli/args.ts';
import { loadConfig } from '../src/config.ts';
import { DeviceStore } from '../src/server/devices.ts';
import { MAC_ONLY } from '../src/server/hub.ts';
import { type ServerMessage, SUBPROTOCOL } from '../src/server/protocol.ts';
import { decodeLogin, originAllowed, requestFrom, tailscaleName } from '../src/server/security.ts';
import { type RunningServer, startServer } from '../src/server/serve.ts';
import {
  installService,
  launchAgentPlist,
  plistPath,
  removeService,
  SERVICE_LABEL,
  type ServiceEnv,
  serviceStatus,
  shellQuote,
} from '../src/server/service.ts';
import { detectTailscale, serveStatus } from '../src/server/tailscale.ts';
import { mockModel, tempDir, textTurn, toolTurn } from './helpers.ts';

const TS = 'mac.tail1234.ts.net';
const PORT = 4747;
/** What Tailscale Serve adds to a request from a tailnet device signed in as `login`. */
const serve = (login = 'rt@example.com', extra: Record<string, string> = {}) => ({
  Host: TS,
  'X-Forwarded-Host': TS,
  'X-Forwarded-Proto': 'https',
  'X-Forwarded-For': '100.101.102.103',
  'Tailscale-User-Login': login,
  'Tailscale-User-Name': 'RT',
  'Tailscale-Headers-Info': 'https://tailscale.com/s/serve-headers',
  ...extra,
});
const from = (headers: Record<string, string>, opts = { tailscaleHost: TS, remoteAllowed: true }) =>
  requestFrom(new Headers(headers), PORT, '127.0.0.1', opts);

describe('which requests are the Mac’s, which another device’s (U3)', () => {
  test('the Mac: a loopback Host and no proxy header', () => {
    expect(from({ Host: `127.0.0.1:${PORT}` })).toEqual({ kind: 'local', address: '127.0.0.1' });
    expect(from({ Host: `localhost:${PORT}` }).kind).toBe('local');
    expect(from({ Host: 'evil.example' })).toMatchObject({ kind: 'refused', status: 403 });
  });

  test('another device: through Serve, on the Mac’s Tailscale name, over HTTPS', () => {
    expect(from(serve())).toEqual({
      kind: 'remote',
      address: '100.101.102.103',
      login: 'rt@example.com',
    });
    expect(from({ ...serve(), Host: `${TS}:443` }).kind).toBe('remote');
    // A tagged node gets no identity headers; it is still another device.
    const { 'Tailscale-User-Login': _l, ...tagged } = serve();
    expect(from(tagged)).toEqual({ kind: 'remote', address: '100.101.102.103' });
  });

  test('a device can’t pass as the Mac: any proxy header makes it remote', () => {
    // Serve copies Host from the device, so a device can send the loopback Host itself.
    for (const header of [
      'X-Forwarded-For',
      'X-Forwarded-Host',
      'X-Forwarded-Proto',
      'Forwarded',
    ]) {
      const r = from({ Host: `127.0.0.1:${PORT}`, [header]: 'x' });
      expect(r).toMatchObject({
        kind: 'refused',
        reason: expect.stringContaining('Tailscale name'),
      });
    }
    for (const header of ['Tailscale-User-Login', 'tailscale_user_login', 'TAILSCALE-ANYTHING']) {
      expect(from({ Host: `127.0.0.1:${PORT}`, [header]: 'x' }).kind).toBe('refused');
    }
  });

  test('Funnel is refused, however the header is spelled, and says why', () => {
    for (const name of ['Tailscale-Funnel-Request', 'tailscale_funnel_request']) {
      const { 'Tailscale-User-Login': _l, ...rest } = serve();
      const r = from({ ...rest, [name]: '?1' });
      expect(r).toMatchObject({
        kind: 'refused',
        status: 403,
        reason: expect.stringContaining('Funnel'),
      });
    }
    // Even with the loopback Host, and even in token mode.
    expect(from({ Host: `127.0.0.1:${PORT}`, 'Tailscale-Funnel-Request': '?1' }).kind).toBe(
      'refused',
    );
  });

  test('refused: another Tailscale name, an unknown name, plain HTTP, token mode', () => {
    expect(from({ ...serve(), Host: 'other.tail1234.ts.net' })).toMatchObject({
      kind: 'refused',
      reason: expect.stringContaining("not this Mac's Tailscale name"),
    });
    expect(from(serve(), { tailscaleHost: undefined as never, remoteAllowed: true })).toMatchObject(
      {
        kind: 'refused',
        reason: expect.stringContaining('app.tailscaleHost'),
      },
    );
    expect(from({ ...serve(), 'X-Forwarded-Proto': 'http' })).toMatchObject({
      kind: 'refused',
      reason: expect.stringContaining('HTTPS'),
    });
    expect(from(serve(), { tailscaleHost: TS, remoteAllowed: false })).toMatchObject({
      kind: 'refused',
      reason: expect.stringContaining('mrig app only'),
    });
  });

  test('Origin: the Tailscale address only over HTTPS, only that name', () => {
    expect(originAllowed(`https://${TS}`, PORT, TS)).toBe(true);
    expect(originAllowed(`http://${TS}`, PORT, TS)).toBe(false);
    expect(originAllowed('https://other.tail1234.ts.net', PORT, TS)).toBe(false);
    expect(originAllowed(`https://${TS}`, PORT)).toBe(false);
  });

  test('Tailscale names and logins', () => {
    expect(tailscaleName('Mac.Tail1234.TS.NET.')).toBe(TS);
    for (const bad of [
      'ts.net',
      'tail1234.ts.net',
      'mac.example.com',
      'mac.tail1234.ts.net:443',
      '-a.b.ts.net',
      '',
    ]) {
      expect(tailscaleName(bad)).toBeUndefined();
    }
    expect(decodeLogin('rt@example.com')).toBe('rt@example.com');
    expect(decodeLogin('=?utf-8?q?r=C3=A9mi@example.com?=')).toBe('rémi@example.com');
  });
});

describe('the Tailscale login pin (U3)', () => {
  test('a pinned device logs in only through Tailscale, as that login', () => {
    const dir = tempDir('mrig-pin-');
    const store = new DeviceStore(dir.dir);
    const code = store.allow('phone', { login: 'RT@Example.com' });
    expect(store.get('phone')?.login).toBe('rt@example.com');
    const paired = store.pair('phone', code);
    if (!paired.ok) throw new Error('pairing failed');
    const cookie = `phone.${paired.key}`;
    expect(store.verify(cookie, '-', { remote: true, login: 'rt@example.com' })).toBe('phone');
    expect(store.verify(cookie, '-', { remote: true, login: 'RT@EXAMPLE.COM' })).toBe('phone');
    expect(store.verify(cookie, '-', { remote: true, login: 'someone@else.com' })).toBeUndefined();
    expect(store.verify(cookie, '-', { remote: true })).toBeUndefined(); // a tagged node
    expect(store.verify(cookie, '-', { remote: false })).toBeUndefined(); // straight to 127.0.0.1
    expect(store.recent().some((l) => l.includes('login-failed:pin phone'))).toBe(true);
    // A new code keeps the pin; an unpinned device works from anywhere.
    store.allow('phone');
    expect(store.get('phone')?.login).toBe('rt@example.com');
    expect(() => store.allow('ipad', { login: 'not a login' })).toThrow('Tailscale login');
    dir.cleanup();
  });
});

describe('reading Tailscale (U3)', () => {
  const status = JSON.stringify({ Self: { DNSName: `${TS}.` } });
  const serving = JSON.stringify({
    TCP: { '443': { HTTPS: true } },
    Web: { [`${TS}:443`]: { Handlers: { '/': { Proxy: 'http://127.0.0.1:4747' } } } },
  });

  test('the name from `tailscale status`, and whether Serve forwards to the app', () => {
    const calls: string[][] = [];
    const run = (cmd: string[]) => {
      calls.push(cmd);
      if (cmd[0] === 'tailscale') return undefined; // not on PATH: try the Mac app's copy
      return cmd[1] === 'status' ? status : serving;
    };
    expect(detectTailscale(4747, run)).toEqual({ host: TS, serving: true, funnel: false });
    expect(calls[1]?.[0]).toContain('Tailscale.app');
    expect(detectTailscale(4747, () => undefined)).toBeUndefined();
    expect(detectTailscale(4747, () => '{"Self":{"DNSName":"evil.example."}}')).toBeUndefined();
  });

  test('Serve to another port is not serving the app; Funnel is noticed', () => {
    expect(serveStatus(serving, TS, 4748).serving).toBe(false);
    expect(serveStatus(serving.replace('http://127.0.0.1:4747', '4747'), TS, 4747).serving).toBe(
      false,
    );
    const funnel = JSON.stringify({ ...JSON.parse(serving), AllowFunnel: { [`${TS}:443`]: true } });
    expect(serveStatus(funnel, TS, 4747)).toEqual({ serving: true, funnel: true });
    expect(serveStatus('not json', TS, 4747)).toEqual({ serving: false, funnel: false });
  });
});

describe('the background service (U3)', () => {
  const env = (home: string, platform = 'darwin') => {
    const calls: string[][] = [];
    const e: ServiceEnv = {
      platform,
      home,
      uid: 501,
      shell: '/bin/zsh',
      command: ["/Users/rt/it's here/mrig"],
      run: (cmd) => {
        calls.push(cmd);
        return { ok: true, output: 'state = running' };
      },
    };
    return { e, calls };
  };

  test('the plist runs mrig app through the login shell, with no key in it', () => {
    const plist = launchAgentPlist(env('/Users/rt').e, '/Users/rt/.mrig/app/service.log');
    expect(plist).toContain(`<string>${SERVICE_LABEL}</string>`);
    expect(plist).toContain('<string>/bin/zsh</string>');
    expect(plist).toContain('<string>-lic</string>');
    expect(plist).toContain(
      `<string>exec '/Users/rt/it'\\''s here/mrig' 'app' '--no-open'</string>`,
    );
    expect(plist).toContain('<key>KeepAlive</key>\n  <true/>');
    expect(plist).not.toMatch(/API_KEY|EnvironmentVariables/);
    expect(shellQuote("a'b")).toBe(`'a'\\''b'`);
  });

  test('install, status and remove call launchctl; other systems are told it is macOS only', () => {
    const home = tempDir('mrig-svc-');
    const prev = process.env.MRIG_HOME;
    process.env.MRIG_HOME = join(home.dir, '.mrig');
    const { e, calls } = env(home.dir);
    installService(e);
    expect(existsSync(plistPath(home.dir))).toBe(true);
    expect(calls).toEqual([
      ['launchctl', 'bootout', `gui/501/${SERVICE_LABEL}`],
      ['launchctl', 'bootstrap', 'gui/501', plistPath(home.dir)],
    ]);
    expect(serviceStatus(e)[0]).toContain('running');
    expect(removeService(e)[0]).toContain('no longer runs');
    expect(existsSync(plistPath(home.dir))).toBe(false);
    expect(serviceStatus(e)[0]).toContain('Not installed');
    expect(() => installService(env(home.dir, 'linux').e)).toThrow('macOS only');
    const failing = { ...e, run: () => ({ ok: false, output: 'Bootstrap failed: 5' }) };
    expect(() => installService(failing)).toThrow('Bootstrap failed');
    process.env.MRIG_HOME = prev;
    home.cleanup();
  });
});

describe('config and arguments (U3)', () => {
  test('app.tailscaleHost must be a Tailscale name', () => {
    const home = tempDir('mrig-cfg-');
    const prev = process.env.MRIG_HOME;
    process.env.MRIG_HOME = home.dir;
    writeFileSync(
      join(home.dir, 'config.json'),
      JSON.stringify({ app: { tailscaleHost: 'MAC.tail1234.ts.net' } }),
    );
    expect(loadConfig({ cwd: home.dir }).app).toEqual({ port: 4747, tailscaleHost: TS });
    writeFileSync(
      join(home.dir, 'config.json'),
      JSON.stringify({ app: { tailscaleHost: 'evil.example' } }),
    );
    expect(() => loadConfig({ cwd: home.dir })).toThrow('Tailscale name');
    process.env.MRIG_HOME = prev;
    home.cleanup();
  });

  test('`--login` and `mrig app service`', () => {
    expect(parseArgs(['app', 'allow', 'add', 'phone', '--login', 'rt@github']).app).toEqual({
      action: 'allow',
      name: 'phone',
      login: 'rt@github',
    });
    expect(parseArgs(['app', 'allow', 'add', 'phone']).app).toEqual({
      action: 'allow',
      name: 'phone',
    });
    expect(() => parseArgs(['app', '--login', 'x@y'])).toThrow('--login works with');
    expect(() => parseArgs(['app', 'allow', 'add', 'phone', '--login'])).toThrow(
      'needs a Tailscale login',
    );
    for (const what of ['install', 'remove', 'status'] as const) {
      expect(parseArgs(['app', 'service', what]).app).toEqual({ action: 'service', what });
    }
    expect(parseArgs(['app', 'service', 'restart']).app).toBeUndefined();
  });
});

describe('a real mrig app, reached through Tailscale Serve (U3)', () => {
  let home: ReturnType<typeof tempDir>;
  let project: ReturnType<typeof tempDir>;
  let server: RunningServer;
  let store: DeviceStore;
  const prevHome = process.env.MRIG_HOME;

  beforeEach(() => {
    home = tempDir('mrig-remote-');
    project = tempDir('mrig-remote-proj-');
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
      tailscaleHost: TS,
      runtime: {
        provider: 'local',
        languageModel: mockModel([
          toolTurn('write', JSON.stringify({ path: 'a.txt', content: 'hi' }), 'w1'),
          textTurn('Wrote a.txt.'),
        ]),
      },
    });
  });
  afterEach(async () => {
    await server.stop();
    home.cleanup();
    project.cleanup();
    if (prevHome === undefined) delete process.env.MRIG_HOME;
    else process.env.MRIG_HOME = prevHome;
  });

  /** Pair a device the way a phone does: through Serve, from the app's HTTPS page. */
  const pairRemote = async (name: string, login = 'rt@example.com', pin?: string) => {
    const code = store.allow(name, pin ? { login: pin } : {});
    return fetch(`${server.url}/api/pair`, {
      method: 'POST',
      headers: { ...serve(login), Origin: `https://${TS}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ device: name, code }),
    });
  };
  const cookieOf = (res: Response) => (res.headers.get('set-cookie') ?? '').split(';')[0] ?? '';

  /** A WebSocket client through Serve, with the messages it received. */
  const connect = async (cookie: string, headers: Record<string, string> = serve()) => {
    const got: ServerMessage[] = [];
    const ws = new WebSocket(server.ws, {
      protocols: [SUBPROTOCOL],
      headers: { ...headers, Origin: `https://${TS}`, Cookie: cookie },
    } as never);
    ws.addEventListener('message', (e) => got.push(JSON.parse(String(e.data)) as ServerMessage));
    await new Promise((ok, fail) => {
      ws.addEventListener('open', ok);
      ws.addEventListener('error', () => fail(new Error('refused')));
    });
    const next = async <T extends ServerMessage['type']>(type: T, after = 0) => {
      for (let i = 0; i < 200; i++) {
        const m = got.slice(after).find((x) => x.type === type);
        if (m) return m as Extract<ServerMessage, { type: T }>;
        await Bun.sleep(10);
      }
      throw new Error(`no ${type}; got ${got.map((m) => m.type).join(', ')}`);
    };
    const send = (m: unknown) => ws.send(JSON.stringify(m));
    return { ws, got, next, send };
  };

  test('a phone pairs through Serve and gets a Secure cookie; /api/me says remote', async () => {
    const res = await pairRemote('phone');
    expect(res.status).toBe(200);
    expect(res.headers.get('set-cookie')).toContain('; Secure');
    const me = await fetch(`${server.url}/api/me`, {
      headers: { ...serve(), Cookie: cookieOf(res) },
    });
    expect(await me.json()).toEqual({ mode: 'device', device: 'phone', remote: true });
    expect(store.recent().some((l) => l.includes('pair phone 100.101.102.103'))).toBe(true);
  });

  test('from another device: Allow once and Deny only, and no /yolo', async () => {
    const cookie = cookieOf(await pairRemote('phone'));
    const c = await connect(cookie);
    c.send({ type: 'hello', protocol: 1 });
    expect(await c.next('hello.ok')).toMatchObject({ remote: true });
    c.send({ type: 'session.open', cwd: project.dir });
    const snap = await c.next('snapshot');
    const conversation = snap.info.conversation;

    c.send({ type: 'command.run', conversation, text: '/yolo' });
    expect((await c.next('error')).message).toBe(MAC_ONLY.yolo);
    c.send({ type: 'command.run', conversation, text: '  /YOLO on' });
    await Bun.sleep(50);
    expect(c.got.filter((m) => m.type === 'error')).toHaveLength(2);

    c.send({ type: 'turn.send', conversation, text: 'write a.txt' });
    const ask = await c.next('ask');
    const before = c.got.length;
    c.send({ type: 'ask.answer', askId: ask.askId, answer: 'always' });
    expect((await c.next('error', before)).message).toBe(MAC_ONLY.always);
    expect(c.got.some((m) => m.type === 'ask.closed')).toBe(false); // still waiting
    c.send({ type: 'ask.answer', askId: ask.askId, answer: 'yes' });
    expect(await c.next('ask.closed')).toMatchObject({ answer: 'yes' });
    await c.next('turn.end');
    expect(readFileSync(join(project.dir, 'a.txt'), 'utf8')).toBe('hi');
    c.ws.close();
  });

  test('on the Mac itself, Always and /yolo still work', async () => {
    const code = store.allow('mac');
    const res = await fetch(`${server.url}/api/pair`, {
      method: 'POST',
      headers: { Origin: server.url, 'Content-Type': 'application/json' },
      body: JSON.stringify({ device: 'mac', code }),
    });
    expect(res.headers.get('set-cookie')).not.toContain('Secure');
    const c = await connect(cookieOf(res), {});
    c.send({ type: 'hello', protocol: 1 });
    expect((await c.next('hello.ok')).remote).toBeUndefined();
    c.send({ type: 'session.open', cwd: project.dir });
    const conversation = (await c.next('snapshot')).info.conversation;
    c.send({ type: 'turn.send', conversation, text: 'write a.txt' });
    const ask = await c.next('ask');
    c.send({ type: 'ask.answer', askId: ask.askId, answer: 'always' });
    expect(await c.next('ask.closed')).toMatchObject({ answer: 'always' });
    await c.next('turn.end');
    const before = c.got.length;
    c.send({ type: 'command.run', conversation, text: '/yolo' });
    expect((await c.next('command.output', before)).text).toContain('yolo');
    c.ws.close();
  });

  test('Funnel is refused: the login check (with the reason), pairing and the socket', async () => {
    const { 'Tailscale-User-Login': _l, ...rest } = serve();
    const funnel = { ...rest, 'Tailscale-Funnel-Request': '?1' };
    const me = await fetch(`${server.url}/api/me`, { headers: funnel });
    expect(me.status).toBe(403);
    expect(((await me.json()) as { reason: string }).reason).toContain('Funnel');
    expect(
      (await fetch(`${server.url}/api/pair`, { method: 'POST', headers: funnel })).status,
    ).toBe(403);
    const cookie = cookieOf(await pairRemote('phone'));
    await expect(connect(cookie, funnel)).rejects.toThrow('refused');
  });

  test('a pinned device works only as its Tailscale login', async () => {
    expect((await pairRemote('phone', 'someone@else.com', 'rt@example.com')).status).toBe(403);
    const ok = await pairRemote('phone', 'rt@example.com', 'rt@example.com');
    expect(ok.status).toBe(200);
    const cookie = cookieOf(ok);
    const me = (headers: Record<string, string>) =>
      fetch(`${server.url}/api/me`, { headers: { ...headers, Cookie: cookie } }).then(
        (r) => r.status,
      );
    expect(await me(serve('rt@example.com'))).toBe(200);
    expect(await me(serve('someone@else.com'))).toBe(401);
    expect(await me({})).toBe(401); // the same cookie, straight to 127.0.0.1
    await expect(connect(cookie, serve('someone@else.com'))).rejects.toThrow('refused');
  });

  test('revoking a phone closes its open window', async () => {
    const c = await connect(cookieOf(await pairRemote('phone')));
    const closed = new Promise<number>((ok) => c.ws.addEventListener('close', (e) => ok(e.code)));
    store.revoke('phone');
    expect(await closed).toBe(4001);
  }, 10_000);

  test('a token-mode server (mrig serve) refuses other devices', async () => {
    const tokenServer = startServer({
      version: 'test',
      checks: false,
      tailscaleHost: TS,
      runtime: { provider: 'local', languageModel: mockModel([]) },
    });
    const res = await fetch(`${tokenServer.url}/api/me`, { headers: serve() });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { reason: string }).reason).toContain('mrig app only');
    await tokenServer.stop();
  });
});
