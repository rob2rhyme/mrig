/**
 * The web app's files, built into the binary (Track 4, U2). Bun bundles `web/index.html` and
 * what it imports (React, the views, the stylesheet) when mrig is built; the service worker,
 * manifest and icons are embedded as they are. Imported only by `mrig app` and the tests that
 * need the app, so `mrig serve` and the terminal never load it.
 */

import appleTouchIcon from '../../web/icons/apple-touch-icon.png' with { type: 'file' };
import icon192 from '../../web/icons/icon-192.png' with { type: 'file' };
import icon512 from '../../web/icons/icon-512.png' with { type: 'file' };
import iconMaskable from '../../web/icons/icon-maskable-512.png' with { type: 'file' };
import page from '../../web/index.html';
import manifest from '../../web/manifest.webmanifest' with { type: 'file' };
import sw from '../../web/sw.js' with { type: 'file' };
import type { AppAssets } from './serve.ts';

export const APP_ASSETS: AppAssets = {
  page,
  files: {
    '/sw.js': { path: sw, type: 'text/javascript; charset=utf-8' },
    '/manifest.webmanifest': { path: manifest, type: 'application/manifest+json' },
    '/icons/icon-192.png': { path: icon192, type: 'image/png' },
    '/icons/icon-512.png': { path: icon512, type: 'image/png' },
    '/icons/icon-maskable-512.png': { path: iconMaskable, type: 'image/png' },
    '/icons/apple-touch-icon.png': { path: appleTouchIcon, type: 'image/png' },
  },
};
