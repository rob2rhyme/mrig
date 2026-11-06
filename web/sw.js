// mrig's service worker (Track 4, U2). It keeps only the app's own files so the installed app
// opens fast, and shows a plain page when mrig isn't running. It never stores conversations,
// media, uploads or anything from /api, /ws or /media.
const CACHE = 'mrig-shell-v1';
// The app's bundled files: scripts, styles, icons and the manifest. Bundled names carry a hash
// of their content, so a cached copy is never stale; never the service worker itself.
const SHELL = /^\/(icons\/)?(?!sw\.js$)[\w.-]+\.(js|css|png|webmanifest)$/;

const OFFLINE = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>mrig</title><body style="font:16px -apple-system,system-ui,sans-serif;max-width:32rem;margin:15vh auto;padding:1rem;color:#646b76">
<h1 style="color:inherit">mrig isn't running</h1><p>Start it on your Mac with <code>mrig app</code>, then reload.</p></body>`;

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== self.location.origin) return;

  // The page: always the network, so a running mrig serves the current app; a copy if not.
  if (req.mode === 'navigate' && url.pathname === '/') {
    event.respondWith(
      fetch(req)
        .then((res) => {
          if (res.ok) {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put('/', copy));
          }
          return res;
        })
        .catch(() =>
          caches
            .match('/')
            .then(
              (hit) => hit ?? new Response(OFFLINE, { headers: { 'Content-Type': 'text/html' } }),
            ),
        ),
    );
    return;
  }

  // Bundled scripts and styles (their names change with their content) and icons: cache first.
  if (SHELL.test(url.pathname)) {
    event.respondWith(
      caches.match(req).then(
        (hit) =>
          hit ??
          fetch(req).then((res) => {
            if (res.ok) {
              const copy = res.clone();
              caches.open(CACHE).then((c) => c.put(req, copy));
            }
            return res;
          }),
      ),
    );
  }
  // Everything else (/api, /ws, /media) goes straight to the network.
});
