/*
 * Service worker.
 *
 * Two different caching problems here, handled differently:
 *
 *   - Sprites, colour tables and the script bundle never change for a given
 *     build and are small (~1.5 MB together), so they are precached on install
 *     and served cache-first. That is what makes the game start offline.
 *   - Scenes are 570 files and 6.4 MB. Precaching all of them would be a rude
 *     first-run download for maps you may never open, so they are cached as you
 *     play them.
 *
 * The build's own assets are hashed, so their names are not knowable to a
 * static worker; they are cached on first use instead.
 */
/*
 * The cache name carries a build id, substituted by the pwaAssets plugin from
 * a hash of the bundle and of data/.
 *
 * Data files live at stable URLs and are served cache-first, so nothing else
 * would ever dislodge them: an installed app would keep serving the scripts
 * and scenes it first downloaded, however many times the site is redeployed.
 * Tying the cache name to the build means a deploy that changes them produces
 * a different worker, which reinstalls and refetches; a deploy that does not
 * leaves the id alone and costs returning players nothing.
 */
const VERSION = 'iron-accord-__BUILD_ID__';
const SHELL = `${VERSION}-shell`;
const DATA = `${VERSION}-data`;

/** Everything is relative to the worker's own scope, so subpath hosting works. */
const scoped = (relativePath) => new URL(relativePath, self.registration.scope).toString();

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(SHELL);
    await cache.addAll([
      scoped('.'),
      scoped('manifest.webmanifest'),
      scoped('icons/icon-192.png'),
      scoped('icons/icon-512.png'),
    ].map(url => new Request(url, { cache: 'reload' })));

    // The asset lists are data, so the worker does not need regenerating when
    // the sprite set changes.
    const data = await caches.open(DATA);
    const precache = [scoped('scripts.json'), scoped('scenes/index.json'), scoped('sprites/index.json')];
    await data.addAll(precache);

    for (const [indexPath, prefix] of [['sprites/index.json', 'sprites/'], ['colortables/index.json', 'colortables/']]) {
      try {
        const response = await fetch(scoped(indexPath));
        if (!response.ok) continue;
        const listing = await response.json();
        const names = Array.isArray(listing) ? listing : Object.keys(listing);
        const urls = names.map(name => scoped(`${prefix}${encodeName(name)}.png`));
        // Chunked: addAll rejects the whole batch if any single request fails.
        for (let i = 0; i < urls.length; i += 50) {
          await data.addAll(urls.slice(i, i + 50)).catch(() => {});
        }
      } catch { /* offline install: runtime caching will fill in */ }
    }
    await self.skipWaiting();
  })());
});

/** Mirrors assetFileName in src/cw/assetname.ts. */
function encodeName(id) {
  return id.replace(/[^A-Za-z0-9._-]/g, c => `~${c.charCodeAt(0).toString(16).padStart(2, '0')}`);
}

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const keep = new Set([SHELL, DATA]);
    for (const key of await caches.keys()) {
      if (!keep.has(key)) await caches.delete(key);
    }
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // Navigations: network first so a new build is picked up, cache as fallback.
  if (request.mode === 'navigate') {
    event.respondWith((async () => {
      try {
        const response = await fetch(request);
        // Only a real page is worth keeping: caching a 404 or a redirect here
        // makes every later offline launch serve that error instead.
        if (response.ok && response.type === 'basic') {
          (await caches.open(SHELL)).put(scoped('.'), response.clone());
        }
        return response;
      } catch {
        return (await caches.match(scoped('.'))) ?? Response.error();
      }
    })());
    return;
  }

  // Everything else: cache first, filling the cache on a miss.
  event.respondWith((async () => {
    const cached = await caches.match(request);
    if (cached) return cached;
    try {
      const response = await fetch(request);
      if (response.ok) {
        const bucket = /\/(sprites|colortables|scenes)\//.test(url.pathname) || url.pathname.endsWith('scripts.json')
          ? DATA : SHELL;
        (await caches.open(bucket)).put(request, response.clone());
      }
      return response;
    } catch {
      return Response.error();
    }
  })());
});
