'use strict';

/* Increment the release whenever any precached app-shell file changes.
 * Only static application code is cached. Credentials, API responses and
 * authenticated board data belong to the application outbox, never this cache.
 */
const RELEASE = 'woodline-v2-c56a5301f53f7fb6';
const SCOPE = new URL(self.registration.scope);
const CACHE_PREFIX = 'woodline-shell:' + encodeURIComponent(SCOPE.pathname) + ':';
const CACHE_NAME = CACHE_PREFIX + RELEASE;
const FILES = [
  'index.html',
  'dashboard.css',
  'app-config.js',
  'plan-data.js',
  'board-model.js',
  'cloud-sync.js',
  'app.js'
];
const URLS = FILES.map(file => new URL(file, SCOPE).href);
const SHELL_URLS = new Set(URLS);
const INDEX_URL = new URL('index.html', SCOPE).href;

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    try {
      // addAll commits its puts as one batch: a missing file cannot activate a
      // partial release. Reload bypasses the browser's regular HTTP cache.
      await cache.addAll(URLS.map(url => new Request(url, {
        cache: 'reload',
        credentials: 'same-origin'
      })));
    } catch (error) {
      await caches.delete(CACHE_NAME);
      throw error;
    }
    // An existing application keeps its previous bundle until the user accepts
    // an update. Do not call skipWaiting automatically.
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names.filter(name =>
      name.startsWith(CACHE_PREFIX) && name !== CACHE_NAME
    ).map(name => caches.delete(name)));
    await self.clients.claim();
  })());
});

self.addEventListener('message', event => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    event.waitUntil(self.skipWaiting());
  }
});

let repairing = null;
async function repairShellIfNeeded(cache) {
  const present = await Promise.all(URLS.map(url => cache.match(url)));
  if (present.every(Boolean)) return;
  if (!repairing) {
    // Recover eviction as a complete bundle, never one freshly fetched script
    // mixed with older cached scripts. addAll applies its puts atomically.
    repairing = cache.addAll(URLS.map(url => new Request(url, {
      cache: 'reload', credentials: 'same-origin'
    }))).finally(() => { repairing = null; });
  }
  await repairing;
}

self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== SCOPE.origin) return;

  // Query parameters may carry auth callback codes. Use only the previously
  // cached shell and never write a navigation/auth callback request to cache.
  const canonical = new URL(url.pathname, url.origin).href;
  const rootNavigation = request.mode === 'navigate' && (
    url.pathname === SCOPE.pathname || canonical === INDEX_URL
  );
  if (!rootNavigation && !SHELL_URLS.has(canonical)) return;

  event.respondWith((async () => {
    const cache = await caches.open(CACHE_NAME);
    if (rootNavigation) {
      try { await repairShellIfNeeded(cache); } catch (_) { /* Offline: use only a complete cached bundle. */ }
      const complete = await Promise.all(URLS.map(url => cache.match(url)));
      if (!complete.every(Boolean)) return unavailable(true);
    } else if (repairing) {
      try { await repairing; } catch (_) { /* Report an unavailable asset below. */ }
    }
    const response = await cache.match(rootNavigation ? INDEX_URL : canonical);
    if (response) return response;
    return unavailable(rootNavigation);
  })());
});

function unavailable(rootNavigation) {
    return new Response(
      rootNavigation
        ? '<!doctype html><html lang="ru"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Woodline — нужна сеть</title><body style="font:16px/1.6 system-ui;padding:32px;color:#20332a;background:#f4f5ef"><h1>Нужна сеть для загрузки доски</h1><p>Браузер удалил часть файлов приложения. Подключитесь к интернету и откройте доску снова. Данные аккаунта не удалялись этим обновлением.</p></body></html>'
        : 'Woodline application shell is incomplete. Reconnect to load the app.',
      {
        status: 503,
        statusText: 'App shell unavailable',
        headers: {
          'Content-Type': rootNavigation ? 'text/html; charset=utf-8' : 'text/plain; charset=utf-8',
          'Cache-Control': 'no-store'
        }
      }
    );
}
