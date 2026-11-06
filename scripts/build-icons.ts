/**
 * Render the web app's PNG icons from web/icons/icon.svg (Track 4, U2). Run it after changing
 * the SVG: `bun scripts/build-icons.ts`. Uses Playwright's Chromium; the PNGs are committed, so
 * building mrig never needs a browser.
 *
 * - icon-192, icon-512: the rounded icon, for browsers and the Dock.
 * - icon-maskable-512, apple-touch-icon: square and full-bleed, the mark inside the safe zone,
 *   because Android and iOS cut their own shape.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright';

const dir = join(import.meta.dir, '..', 'web', 'icons');
const svg = readFileSync(join(dir, 'icon.svg'), 'utf8');
const square = svg.replace('rx="112"', 'rx="0"');
const page = (body: string, size: number, inset: number) =>
  `<html><body style="margin:0;background:#1f2a44"><div style="width:${size}px;height:${size}px;display:flex;align-items:center;justify-content:center">${body.replace('<svg ', `<svg width="${size - inset * 2}" height="${size - inset * 2}" `)}</div></body></html>`;

const jobs: Array<[string, number, string, number, boolean]> = [
  ['icon-192.png', 192, svg, 0, true],
  ['icon-512.png', 512, svg, 0, true],
  ['icon-maskable-512.png', 512, square, 64, false],
  ['apple-touch-icon.png', 180, square, 16, false],
];

const browser = await chromium.launch();
for (const [name, size, body, inset, transparent] of jobs) {
  const p = await browser.newPage({ viewport: { width: size, height: size } });
  let html = page(body, size, inset);
  if (transparent) html = html.replace('background:#1f2a44', 'background:transparent');
  await p.setContent(html);
  await p.screenshot({ path: join(dir, name), omitBackground: transparent });
  await p.close();
  console.log(`wrote web/icons/${name}`);
}
await browser.close();
