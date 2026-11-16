// Хранилище на устройстве (IndexedDB).
// entries — записи (текст, дата, список видео без самих файлов).
// videos  — сами видеофайлы (Blob). Лента их не трогает, поэтому большие файлы не попадают в память.
// meta    — служебные мелочи.

const DB_NAME = 'dnevnik';
const DB_VERSION = 1;
let dbPromise;

function openDb() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('entries')) db.createObjectStore('entries', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('videos')) db.createObjectStore('videos', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta');
      };
      req.onsuccess = () => {
        const db = req.result;
        db.onversionchange = () => db.close();
        resolve(db);
      };
      req.onerror = () => reject(req.error);
    });
    dbPromise.catch(() => { dbPromise = undefined; });
  }
  return dbPromise;
}

// Выполняет работу в одной транзакции. Обещание выполняется, только когда данные точно записаны.
async function run(stores, mode, work) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    let result;
    let t;
    try {
      t = db.transaction(stores, mode);
    } catch (e) {
      reject(e);
      return;
    }
    let failure = null;
    t.oncomplete = () => resolve(result);
    t.onerror = (ev) => { failure = failure || (ev.target && ev.target.error); };
    t.onabort = () => reject(t.error || failure || new DOMException('Запись прервана', 'AbortError'));
    try {
      work(t, (value) => { result = value; });
    } catch (e) {
      failure = e;
      try { t.abort(); } catch { reject(e); }
    }
  });
}

export function isQuotaError(e) {
  if (!e) return false;
  return e.name === 'QuotaExceededError' || e.code === 22 || /quota|disk|space/i.test(String(e.message || ''));
}

export function getAllEntries() {
  return run('entries', 'readonly', (t, set) => {
    const r = t.objectStore('entries').getAll();
    r.onsuccess = () => set(r.result);
  });
}

export function putEntry(entry) {
  return run('entries', 'readwrite', (t) => { t.objectStore('entries').put(entry); });
}

export function deleteEntry(id, videoIds = []) {
  return run(['entries', 'videos', 'meta'], 'readwrite', (t) => {
    t.objectStore('entries').delete(id);
    for (const v of videoIds) {
      t.objectStore('videos').delete(v);
      t.objectStore('meta').delete('crc:' + v);
      t.objectStore('meta').delete('thumb:' + v);
    }
  });
}

export function getVideoBlob(id) {
  return run('videos', 'readonly', (t, set) => {
    const r = t.objectStore('videos').get(id);
    r.onsuccess = () => set(r.result ? r.result.blob : null);
  });
}

// Сохраняет видео и сразу проверяет, что оно действительно лежит в хранилище целиком.
export async function putVideo(id, blob) {
  await run('videos', 'readwrite', (t) => { t.objectStore('videos').put({ id, blob }); });
  const saved = await getVideoBlob(id);
  if (!saved || saved.size !== blob.size) {
    try { await deleteVideos([id]); } catch { /* уберётся при следующем запуске */ }
    throw new DOMException('Видео записалось не полностью', 'QuotaExceededError');
  }
}

export function deleteVideos(ids) {
  if (!ids.length) return Promise.resolve();
  return run(['videos', 'meta'], 'readwrite', (t) => {
    for (const id of ids) {
      t.objectStore('videos').delete(id);
      t.objectStore('meta').delete('crc:' + id);
      t.objectStore('meta').delete('thumb:' + id);
    }
  });
}

export function getAllVideoKeys() {
  return run('videos', 'readonly', (t, set) => {
    const r = t.objectStore('videos').getAllKeys();
    r.onsuccess = () => set(r.result);
  });
}

export function metaGet(key) {
  return run('meta', 'readonly', (t, set) => {
    const r = t.objectStore('meta').get(key);
    r.onsuccess = () => set(r.result);
  });
}

export function metaSet(key, value) {
  return run('meta', 'readwrite', (t) => { t.objectStore('meta').put(value, key); });
}
