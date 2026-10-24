// Service worker: makes the site installable and lets it open offline.
// Pages, CSS and JS are network-first, so a deploy shows up on the next load with no
// version bumping; the cache is only the offline fallback. Fonts and icons rarely change,
// so they're cache-first. Bump VERSION only when the precache list below changes.
const VERSION = 'hb-v2';
const PRECACHE = [
  '/', '/how-to', '/faq', '/privacy',
  '/css/gear.css', '/js/app.js', '/js/harmonica.js', '/js/pitch.js', '/js/look.js', '/js/gear.js', '/js/consent.js', '/js/pwa.js',
  '/js/vendor/gsap.min.js', '/js/vendor/CustomEase.min.js', '/js/vendor/ScrollTrigger.min.js',
  '/fonts/barlow-400-latin.woff2', '/fonts/barlow-500-latin.woff2', '/fonts/barlow-600-latin.woff2',
  '/fonts/barlow-condensed-600-latin.woff2', '/fonts/barlow-condensed-700-latin.woff2', '/fonts/hanken-grotesk-latin.woff2',
  '/favicon.svg', '/manifest.webmanifest', '/icons/icon-192.png', '/icons/icon-512.png',
];

self.addEventListener('install', (event) => {
  // Add one at a time so a single missing URL (e.g. clean URLs on a local dev server) can't fail the install.
  event.waitUntil(caches.open(VERSION).then((cache) => Promise.all(PRECACHE.map((url) => cache.add(url).catch(() => {})))));
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

// Links use faq.html etc., which the host serves at /faq. Try both spellings when offline.
function cacheKeys(url) {
  const u = new URL(url);
  const keys = [u.origin + u.pathname];
  if (u.pathname.endsWith('/index.html')) keys.push(u.origin + u.pathname.slice(0, -'index.html'.length));
  else if (u.pathname.endsWith('.html')) keys.push(u.origin + u.pathname.slice(0, -5));
  return keys;
}
async function fromCache(request) {
  for (const key of cacheKeys(request.url)) {
    const hit = await caches.match(key);
    if (hit) return hit;
  }
  return null;
}

async function networkFirst(request) {
  try {
    const res = await fetch(request);
    // Don't store redirects: a cached redirected response can't be replayed for a navigation.
    if (res.ok && res.type === 'basic' && !res.redirected) {
      const copy = res.clone();
      caches.open(VERSION).then((c) => c.put(new URL(request.url).origin + new URL(request.url).pathname, copy));
    }
    return res;
  } catch (err) {
    const hit = await fromCache(request);
    if (hit) return hit;
    if (request.mode === 'navigate') return (await caches.match('/')) || Response.error();
    throw err;
  }
}

async function cacheFirst(request) {
  const hit = await caches.match(request);
  if (hit) return hit;
  const res = await fetch(request);
  if (res.ok) { const copy = res.clone(); caches.open(VERSION).then((c) => c.put(request, copy)); }
  return res;
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);
  // Only handle our own GET requests; analytics and other sites go straight to the network.
  if (request.method !== 'GET' || url.origin !== self.location.origin) return;
  if (/\.(woff2|png|svg|ico)$/.test(url.pathname)) event.respondWith(cacheFirst(request));
  else event.respondWith(networkFirst(request));
});
