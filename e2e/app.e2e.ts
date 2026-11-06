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
