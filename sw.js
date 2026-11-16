// Работа без интернета: файлы приложения один раз кладутся в память устройства
// и дальше берутся оттуда. В сеть приложение во время работы не ходит.
//
// При любом изменении файлов приложения увеличьте номер версии ниже —
// тогда устройства скачают новую версию при следующем открытии.
const VERSION = 'dnevnik-v3';

const FILES = [
  './',
  'index.html',
  'styles.css',
  'manifest.webmanifest',
  'js/app.js',
  'js/db.js',
  'js/zip.js',
  'js/backup.js',
  'js/util.js',
  'icons/icon-180.png',
  'icons/icon-192.png',
  'icons/icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(VERSION);
    await cache.addAll(FILES.map((url) => new Request(url, { cache: 'reload' })));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names.filter((n) => n !== VERSION).map((n) => caches.delete(n)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== self.location.origin) return;
  if (url.pathname.includes('/__video/')) {
    event.respondWith(serveVideo(req, url));
    return;
  }
  event.respondWith((async () => {
    const cache = await caches.open(VERSION);
    const hit = await cache.match(req, { ignoreSearch: true });
    if (hit) return hit;
    if (req.mode === 'navigate') {
      const page = await cache.match('./');
      if (page) return page;
    }
    return fetch(req);
  })());
});

// ---------- Видео ----------
// Плеер айфона плохо играет видео прямо из хранилища. Поэтому видео отдаётся ему
// по обычному адресу и по частям — так, как это делал бы сайт. Файл целиком в память не читается.

// Номер версии и названия хранилищ должны совпадать с js/db.js.
function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('dnevnik', 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('entries')) db.createObjectStore('entries', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('videos')) db.createObjectStore('videos', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function serveVideo(req, url) {
  try {
    const id = decodeURIComponent(url.pathname.split('/').pop());
    const type = url.searchParams.get('type') || 'video/mp4';
    const db = await openDb();
    const blob = await new Promise((resolve, reject) => {
      const r = db.transaction('videos').objectStore('videos').get(id);
      r.onsuccess = () => resolve(r.result ? r.result.blob : null);
      r.onerror = () => reject(r.error);
    });
    db.close();
    if (!blob) return new Response('', { status: 404 });

    const size = blob.size;
    const base = { 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store' };
    const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.get('range') || '');
    if (!m || (m[1] === '' && m[2] === '')) {
      return new Response(blob, { status: 200, headers: { ...base, 'Content-Length': String(size) } });
    }
    let start;
    let end;
    if (m[1] === '') {
      start = Math.max(0, size - Number(m[2]));
      end = size - 1;
    } else {
      start = Number(m[1]);
      end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1);
    }
    if (start >= size || start > end) {
      return new Response('', { status: 416, headers: { 'Content-Range': `bytes */${size}` } });
    }
    return new Response(blob.slice(start, end + 1, type), {
      status: 206,
      headers: { ...base, 'Content-Range': `bytes ${start}-${end}/${size}`, 'Content-Length': String(end - start + 1) },
    });
  } catch {
    return new Response('', { status: 500 });
  }
}
