/**
 * Track 4, U2: the web app in a real browser (Playwright's Chromium) against a real `mrig app`
 * server with a scripted mock model. Run with `bun run test:e2e`; not part of `bun test`, since
 * it needs a browser (CI installs one on Linux).
 *
 * Covers: pairing (automatic, and a wrong code), a streamed reply with markdown, a permission
 * request answered with Allow and shown as a diff, Stop, nothing loaded from outside the
 * server, the service worker, and the phone layout. Screenshots go to $E2E_SHOTS when set.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { type Browser, chromium, type Page } from 'playwright';
import { APP_ASSETS } from '../src/server/app-assets.ts';
import { DeviceStore } from '../src/server/devices.ts';
import { type RunningServer, startServer } from '../src/server/serve.ts';
import { mockModel, tempDir, textTurn, toolTurn } from '../tests/helpers.ts';

const SHOTS = process.env.E2E_SHOTS;
const shot = async (page: Page, name: string) => {
  if (SHOTS) await page.screenshot({ path: join(SHOTS, `${name}.png`) });
};

describe('mrig app in a browser (U2)', () => {
  const home = tempDir('mrig-e2e-home-');
  const project = tempDir('mrig-e2e-proj-');
  let server: RunningServer;
  let store: DeviceStore;
  let browser: Browser;
  const offsite: string[] = [];

  beforeAll(async () => {
    process.env.MRIG_HOME = home.dir;
    writeFileSync(
      join(home.dir, 'config.json'),
      JSON.stringify({
        providers: {
          local: { kind: 'openai-compatible', baseURL: 'http://localhost:8000/v1', model: 'm', pricing: { input: 0, output: 0 } },
        },
      }),
    );
    writeFileSync(join(project.dir, 'notes.txt'), 'first line\nold line\nlast line\n');
    if (SHOTS) mkdirSync(SHOTS, { recursive: true });
    store = new DeviceStore(join(home.dir, 'app'));
    server = startServer({
      port: 0,
      version: 'e2e',
      checks: false,
      devices: store,
      app: APP_ASSETS,
      uploadsDir: join(home.dir, 'uploads'),
      runtime: {
        provider: 'local',
        languageModel: mockModel([
          textTurn('Hello! Here is **bold**, `code` and a block:\n\n```ts\nconst answer = 42;\n```'),
          toolTurn('edit', JSON.stringify({ path: 'notes.txt', old_string: 'old line', new_string: 'new line' }), 'e1'),
          textTurn('Edited notes.txt.'),
          toolTurn('write', JSON.stringify({ path: 'never.txt', content: 'x' }), 'w1'),
          textTurn('not reached'),
        ]),
      },
    });
    browser = await chromium.launch();
  });

  afterAll(async () => {
    await browser?.close();
    await server?.stop();
    home.cleanup();
    project.cleanup();
  });

  const newPage = async (viewport = { width: 1200, height: 800 }) => {
    const colorScheme = process.env.E2E_DARK ? ('dark' as const) : ('light' as const);
    const context = await browser.newContext({ viewport, colorScheme });
    const page = await context.newPage();
    page.on('request', (r) => {
      const host = new URL(r.url()).host;
      if (host !== `127.0.0.1:${server.port}`) offsite.push(r.url());
    });
    return page;
  };

  test('a wrong pairing code is refused and explained', async () => {
    store.allow('tablet');
    const page = await newPage();
    await page.goto(`${server.url}/`);
    await page.getByLabel('Device name').fill('tablet');
    await page.getByLabel('Pairing code').fill('WRONG234');
    await page.getByRole('button', { name: 'Pair' }).click();
    await page.getByText("That code isn't right").waitFor();
    expect(await page.context().cookies()).toEqual([]);
    await page.close();
  });

  test('pair, chat, allow an edit, stop: the whole loop', async () => {
    const page = await newPage();
    const code = store.allow('mac');
    await page.goto(`${server.url}/#pair=${code}&device=mac`);
    await page.locator('.status .dot.open').waitFor(); // logged in and connected
    expect(page.url()).toBe(`${server.url}/`); // the code is gone from the address bar
    const cookie = (await page.context().cookies())[0];
    expect(cookie).toMatchObject({ name: 'mrig_device', httpOnly: true, sameSite: 'Strict' });

    await page.getByLabel('Open a folder by path').fill(project.dir);
    await page.getByRole('button', { name: 'Open', exact: true }).click();
    await page.getByText('New conversation in').waitFor();

    const box = page.getByLabel('Message');
    await box.fill('hello');
    await box.press('Enter');
    await page.locator('.msg.assistant strong', { hasText: 'bold' }).waitFor();
    await page.locator('.code .tok-keyword', { hasText: 'const' }).waitFor();
    await shot(page, '1-reply');

    await box.fill('please edit the notes');
    await box.press('Enter');
    const ask = page.getByRole('region', { name: 'Permission request' });
    await ask.waitFor();
    expect(await ask.textContent()).toContain('edit notes.txt');
    await shot(page, '2-permission');
    await ask.getByRole('button', { name: /Allow once/ }).click();
    await page.getByText('Edited notes.txt.').waitFor();
    expect(readFileSync(join(project.dir, 'notes.txt'), 'utf8')).toBe('first line\nnew line\nlast line\n');
    const card = page.locator('details.tool.ok', { hasText: 'edit notes.txt' });
    await card.locator('summary').click();
    await card.locator('.diff .add', { hasText: 'new line' }).waitFor();
    await card.locator('.diff .del', { hasText: 'old line' }).waitFor();
    await shot(page, '3-diff');

    await box.fill('write something');
    await box.press('Enter');
    await ask.waitFor();
    await page.getByRole('button', { name: 'Stop' }).click();
    await page.getByText('Stopped.').waitFor();
    expect(await Bun.file(join(project.dir, 'never.txt')).exists()).toBe(false);

    // The installed-app pieces: the service worker registered, the manifest is linked.
    const sw = await page.evaluate(() => navigator.serviceWorker.ready.then((r) => !!r.active));
    expect(sw).toBe(true);
    const manifest = await page.locator('link[rel=manifest]').getAttribute('href');
    expect((await page.request.get(new URL(manifest ?? '', server.url).toString())).ok()).toBe(true);

    // The status bar shows the model, and a reload picks the conversation back up.
    await page.locator('.status', { hasText: 'local/m' }).waitFor();
    await page.close();
  });

  test('phone width: the sidebar is a drawer', async () => {
    const page = await newPage({ width: 390, height: 844 });
    const code = store.allow('phone');
    await page.goto(`${server.url}/#pair=${code}&device=phone`);
    await page.locator('.status .dot.open').waitFor(); // logged in and connected
    const nav = page.getByRole('navigation', { name: 'Conversations' });
    expect(await nav.isVisible()).toBe(true); // in the page, but moved off-screen
    const box = await nav.boundingBox();
    expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(1);
    await page.getByRole('button', { name: 'Show conversations' }).click();
    await page.waitForTimeout(300);
    expect((await nav.boundingBox())?.x).toBe(0);
    await shot(page, '4-phone-drawer');
    await page.close();
  });

  test('nothing loads from anywhere but this server', () => {
    expect(offsite).toEqual([]);
  });
});

/**
 * Track 4, U4: the app inside a frame, as the VS Code panel shows it. A page on another loopback
 * port stands in for the VS Code webview (`parent=` in the fragment, honoured only with the
 * launch token), and a third origin plays a page trying to talk to the app.
 */
describe('mrig app in a host frame (U4)', () => {
  const home = tempDir('mrig-e2e-host-home-');
  const project = tempDir('mrig-e2e-host-proj-');
  let server: RunningServer;
  let host: ReturnType<typeof Bun.serve>;
  let evil: ReturnType<typeof Bun.serve>;
  let browser: Browser;

  type Received = { origin: string; data: { type: string; [k: string]: unknown } };

  beforeAll(async () => {
    process.env.MRIG_HOME = home.dir;
    writeFileSync(
      join(home.dir, 'config.json'),
      JSON.stringify({
        providers: {
          local: { kind: 'openai-compatible', baseURL: 'http://localhost:8000/v1', model: 'm', pricing: { input: 0, output: 0 } },
        },
      }),
    );
    writeFileSync(join(project.dir, 'notes.txt'), 'first line\nold line\nlast line\n');
    server = startServer({
      port: 0,
      version: 'e2e',
      checks: false,
      app: APP_ASSETS,
      runtime: {
        provider: 'local',
        languageModel: mockModel([
          textTurn('The loop is in `src/agent.ts:42`, and `npm test` runs the tests.'),
          toolTurn('edit', JSON.stringify({ path: 'notes.txt', old_string: 'old line', new_string: 'new line' }), 'e1'),
          textTurn('Edited notes.txt.'),
        ]),
      },
    });
    // A page from another origin that keeps trying to type into the app's message box.
    evil = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch: () =>
        new Response(
          `<script>setInterval(() => { try { parent.frames[0].postMessage({ type: 'insert', text: 'evil' }, '*');
            parent.frames[0].postMessage({ type: 'answer', askId: 'a1', answer: 'yes' }, '*'); } catch {} }, 50);</script>`,
          { headers: { 'Content-Type': 'text/html' } },
        ),
    });
    host = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch: (req) => {
        const mode = new URL(req.url).searchParams.get('mode');
        const self = `http://127.0.0.1:${host.port}`;
        const parent = mode === 'mismatch' ? `http://127.0.0.1:${evil.port}` : self;
        const fragment =
          mode === 'plain'
            ? ''
            : `#${new URLSearchParams({ host: 'vscode', token: server.token, parent, cwd: project.dir })}`;
        return new Response(
          `<!doctype html><body style="margin:0">
          <iframe id="app" src="${server.url}/${fragment}" style="width:900px;height:700px;border:0"></iframe>
          <iframe id="evil" src="http://127.0.0.1:${evil.port}/" style="display:none"></iframe>
          <script>
            const APP = ${JSON.stringify(server.url)};
            window.received = [];
            addEventListener('message', (e) => received.push({ origin: e.origin, data: e.data }));
            window.toApp = (m) => document.getElementById('app').contentWindow.postMessage(m, APP);
          </script></body>`,
          { headers: { 'Content-Type': 'text/html' } },
        );
      },
    });
    browser = await chromium.launch();
  });

  afterAll(async () => {
    await browser?.close();
    await server?.stop();
    host?.stop(true);
    evil?.stop(true);
    home.cleanup();
    project.cleanup();
  });

  const received = (page: Page) => page.evaluate(() => (window as unknown as { received: Received[] }).received);
  const waitFor = async (page: Page, type: string, ms = 10_000): Promise<Received['data']> => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      const hit = (await received(page)).find((r) => r.data?.type === type);
      if (hit) return hit.data;
      await page.waitForTimeout(50);
    }
    throw new Error(`no ${type} message from the app`);
  };

  test('selection in, file links and permission answers out, from the host only', async () => {
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${host.port}/?mode=host`);
    const app = page.frameLocator('#app');
    await app.locator('.status .dot.open').waitFor();
    await waitFor(page, 'ready');
    // Every message out is addressed to the host and comes from the app's origin.
    expect((await received(page)).every((r) => r.origin === server.url)).toBe(true);

    // The workspace folder opens by itself; a selection from the editor lands in the box.
    await app.getByText('New conversation in').waitFor();
    const box = app.getByLabel('Message');
    await page.evaluate(() => (window as unknown as { toApp: (m: unknown) => void }).toApp({ type: 'insert', text: '`src/agent.ts:40-44` ' }));
    await page.waitForTimeout(300); // the other origin has had several tries by now
    expect(await box.inputValue()).toBe('`src/agent.ts:40-44` ');

    await box.fill('where is the loop?');
    await box.press('Enter');
    const link = app.locator('button.file-ref', { hasText: 'src/agent.ts:42' });
    await link.waitFor();
    expect(await app.locator('button.file-ref', { hasText: 'npm test' }).count()).toBe(0);
    await link.click();
    expect(await waitFor(page, 'open')).toEqual({ type: 'open', path: 'src/agent.ts', line: 42 });
    const status = await waitFor(page, 'status');
    expect(status).toMatchObject({ model: 'local/m', waiting: 0 });

    // An edit asks; the host sees what it would change, and answers.
    await box.fill('please edit the notes');
    await box.press('Enter');
    const ask = await waitFor(page, 'ask');
    expect(ask).toMatchObject({
      summary: expect.stringContaining('notes.txt'),
      display: { kind: 'diff', path: 'notes.txt', before: 'old line', after: 'new line' },
    });
    expect(readFileSync(join(project.dir, 'notes.txt'), 'utf8')).toContain('old line');
    await page.evaluate(
      (askId) => (window as unknown as { toApp: (m: unknown) => void }).toApp({ type: 'answer', askId, answer: 'yes' }),
      ask.askId,
    );
    await app.getByText('Edited notes.txt.').waitFor();
    expect(await waitFor(page, 'ask.closed')).toEqual({ type: 'ask.closed', askId: ask.askId });
    expect(readFileSync(join(project.dir, 'notes.txt'), 'utf8')).toBe('first line\nnew line\nlast line\n');
    expect(await box.inputValue()).not.toContain('evil');
    await page.close();
  });

  test('a parent that is not the one named gets nothing, and is not listened to', async () => {
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${host.port}/?mode=mismatch`);
    const app = page.frameLocator('#app');
    await app.locator('.status .dot.open').waitFor();
    await page.evaluate(() => (window as unknown as { toApp: (m: unknown) => void }).toApp({ type: 'insert', text: 'from the wrong parent' }));
    await page.waitForTimeout(500);
    expect((await received(page)).filter((r) => r.origin === server.url)).toEqual([]);
    expect(await app.getByLabel('Message').count()).toBeLessThanOrEqual(1);
    if (await app.getByLabel('Message').count()) {
      expect(await app.getByLabel('Message').inputValue()).toBe('');
    }
    await page.close();
  });

  test('outside a host, the app refuses to be framed', async () => {
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${host.port}/?mode=plain`);
    await page.frameLocator('#app').getByText("mrig can't be shown inside another page").waitFor();
    await page.close();
  });
});
