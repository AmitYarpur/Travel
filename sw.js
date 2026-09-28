// Caches the app's own static shell (HTML/CSS/JS/icons) for fast repeat
// loads and basic resilience to a flaky connection. Deliberately does NOT
// touch Firebase SDK requests, Firestore traffic, map tiles, or geocoding
// requests - every screen still needs a live connection for those; this
// only makes the UI shell itself load fast and stay viewable if the
// network briefly drops.

const CACHE_NAME = 'travel-static-v3';

const PRECACHE_URLS = [
  './',
  'index.html',
  'styles.css',
  'db.js',
  'app.js',
  'manifest.json',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/apple-touch-icon.png',
  'icons/favicon.png',
  // Vendored locally (not loaded from a CDN) specifically so these load
  // instantly and work offline instead of depending on a third-party host's
  // speed/uptime - see index.html.
  'vendor/leaflet/leaflet.js',
  'vendor/leaflet/leaflet.css',
  'vendor/xlsx.full.min.js',
  'vendor/jszip.min.js'
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(PRECACHE_URLS))
      .catch(() => {}) // don't fail install over one missing/renamed file
  );
  self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(key => key !== CACHE_NAME).map(key => caches.delete(key)))
    )
  );
  self.clients.claim();
});

// A hung fetch (e.g. a socket iOS silently killed while the PWA was
// suspended in the background) never rejects on its own - plain fetch()
// would then just hang forever instead of falling back to the cache.
// This races it against a timeout so a stuck request fails fast.
const FETCH_TIMEOUT_MS = 6000;

function fetchWithTimeout(request) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('sw fetch timeout')), FETCH_TIMEOUT_MS);
    fetch(request, { cache: 'no-store' }).then(
      response => { clearTimeout(timer); resolve(response); },
      err => { clearTimeout(timer); reject(err); }
    );
  });
}

// Network-first for our own static files only: always fetch the latest
// version when online (so a deploy shows up the very next load), falling
// back to the cache if the network request fails or hangs.
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== self.location.origin) {
    return;
  }

  event.respondWith(
    fetchWithTimeout(event.request)
      .then(response => {
        if (response && response.ok) {
          const copy = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(event.request, copy));
        }
        return response;
      })
      .catch(() => caches.match(event.request))
  );
});
