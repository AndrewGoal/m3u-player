/* ==========================================================================
   海纳百川-播放器 · Service Worker
   应用外壳预缓存 + 静态资源 stale-while-revalidate + 导航网络优先。
   只接管本站静态资源，播放列表请求与视频流保持直连，避免播放到过期内容。
   ========================================================================== */

'use strict';

const VERSION = '1.0.0';
const CACHE_NAME = 'hnbc-player-' + VERSION;
const CACHE_PREFIX = 'hnbc-player-';

/* 静态资源：后缀白名单，命中才进入缓存逻辑 */
const ASSET_RE = /\.(?:css|m?js|json|webmanifest|svg|png|jpe?g|webp|avif|gif|ico|woff2?|ttf|otf)$/i;

const PRECACHE = [
  './',
  'index.html',
  'manifest.json',
  'player/style.css',
  'player/sdk.js',
  'player/playlist.js',
  'player/app.js',
  'player/pwa.js',
  'player/poster.svg',
  'player/vendor/hls.light.min.js',
  'icons/icon.svg',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/icon-maskable-192.png',
  'icons/icon-maskable-512.png',
  'icons/apple-touch-icon.png',
  'icons/favicon-32.png',
  'icons/favicon-16.png'
];

const SCOPE_PATH = new URL('./', self.location.href).pathname;

self.addEventListener('install', function (event) {
  event.waitUntil(
    (async function () {
      const cache = await caches.open(CACHE_NAME);
      // 单个文件失败不影响整体安装（例如部署过程中某个图标暂缺）
      await Promise.all(
        PRECACHE.map(function (path) {
          const url = new URL(path, self.registration.scope).href;
          return cache.add(new Request(url, { cache: 'reload' })).catch(function () {});
        })
      );
    })()
  );
});

self.addEventListener('message', function (event) {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

self.addEventListener('activate', function (event) {
  event.waitUntil(
    (async function () {
      const keys = await caches.keys();
      await Promise.all(
        keys.map(function (key) {
          if (key.indexOf(CACHE_PREFIX) === 0 && key !== CACHE_NAME) return caches.delete(key);
          return undefined;
        })
      );
      await self.clients.claim();
    })()
  );
});

self.addEventListener('fetch', function (event) {
  const request = event.request;
  if (request.method !== 'GET') return;
  if (request.headers.has('range')) return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  if (request.mode === 'navigate') {
    event.respondWith(networkFirst(request));
    return;
  }

  if (url.pathname.indexOf(SCOPE_PATH) !== 0) return;
  if (ASSET_RE.test(url.pathname)) {
    event.respondWith(staleWhileRevalidate(event, request));
  }
});

async function networkFirst(request) {
  const cache = await caches.open(CACHE_NAME);
  try {
    const response = await fetch(request);
    if (response && response.ok) {
      // 不论 URL 带什么参数，都复用同一份外壳
      cache.put('index.html', response.clone()).catch(function () {});
    }
    return response;
  } catch (err) {
    const cached = (await cache.match('index.html')) || (await cache.match('./'));
    if (cached) return cached;
    return new Response(
      '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
        '<title>离线</title><body style="margin:0;display:grid;place-items:center;height:100vh;' +
        'background:#070c15;color:#e9f1ff;font-family:system-ui,sans-serif">' +
        '<p>当前处于离线状态，且尚未缓存应用外壳。</p>',
      { status: 503, headers: { 'content-type': 'text/html; charset=utf-8' } }
    );
  }
}

async function staleWhileRevalidate(event, request) {
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(request, { ignoreSearch: true });

  const network = fetch(request)
    .then(function (response) {
      if (response && response.ok && response.type === 'basic') {
        cache.put(request, response.clone()).catch(function () {});
      }
      return response;
    })
    .catch(function () {
      return null;
    });

  if (cached) {
    event.waitUntil(network.then(function () {}));
    return cached;
  }

  const response = await network;
  return response || new Response('', { status: 504, statusText: 'Offline' });
}
