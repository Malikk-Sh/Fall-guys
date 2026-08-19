'use strict';

const CACHE_NAME = 'wobble-pwa-v1';
const APP_SHELL = [
  '/',
  '/index.html',
  '/offline.html',
  '/styles.css',
  '/pwa.css',
  '/menu-ux.css',
  '/main.js',
  '/pwa-entry.js',
  '/game/FeedbackController.js',
  '/ui/MenuPolish.js',
  '/ui/MenuStageExperience.js',
  '/ui/ScreenTransitions.js',
  '/core/pwa.js',
  '/manifest.webmanifest',
  '/icons/apple-touch-icon-180.png',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/icon-maskable-512.png'
];
const NETWORK_ONLY_PREFIXES = ['/api/', '/account', '/health', '/metrics', '/ws'];
const CACHEABLE_DESTINATIONS = new Set(['script', 'style', 'image', 'font', 'manifest', 'worker']);

self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE_NAME).then(cache => cache.addAll(APP_SHELL)));
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches
      .keys()
      .then(keys =>
        Promise.all(
          keys
            .filter(key => key !== CACHE_NAME && key.startsWith('wobble-pwa-'))
            .map(key => caches.delete(key))
        )
      )
      .then(() => self.clients.claim())
  );
});

self.addEventListener('message', event => {
  if (event.data?.type === 'SKIP_WAITING') self.skipWaiting();
});

function networkOnly(url, request) {
  if (NETWORK_ONLY_PREFIXES.some(prefix => url.pathname === prefix || url.pathname.startsWith(prefix)))
    return true;
  return request.destination === '' && request.mode !== 'navigate';
}

async function networkFirst(request, fallback = null) {
  const cache = await caches.open(CACHE_NAME);
  try {
    const response = await fetch(request);
    if (response.ok && request.mode !== 'navigate') await cache.put(request, response.clone());
    return response;
  } catch (error) {
    if (fallback) {
      const offline = await cache.match(fallback);
      if (offline) return offline;
    }
    const cached = await cache.match(request);
    if (cached) return cached;
    throw error;
  }
}

self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin || networkOnly(url, request)) return;
  if (request.mode === 'navigate') {
    event.respondWith(networkFirst(request, '/offline.html'));
    return;
  }
  if (!CACHEABLE_DESTINATIONS.has(request.destination)) return;
  event.respondWith(networkFirst(request));
});
