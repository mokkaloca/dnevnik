// Резервная копия: один zip-файл с diary.json и папкой videos.

import * as db from './db.js';
import { buildZip, readZip, crc32OfBlob } from './zip.js';
import { DATE_RE, extOf, fmtSize, freeSpace, nowLocal, sniffHevc } from './util.js';

const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

// Ошибка с текстом, который можно показать человеку как есть.
export class BackupError extends Error {}

export async function exportBackup(entries, onProgress) {
  const live = entries.filter((e) => !e.deletedAt);
  const total = live.reduce((s, e) => s + e.videos.length, 0);
  const files = [];
  const out = [];
  let n = 0;
  let missing = 0;

  for (const e of live) {
    const vids = [];
    for (const v of e.videos) {
      n++;
      if (onProgress) onProgress(n, total);
      const blob = await db.getVideoBlob(v.id);
      if (!blob) { missing++; continue; }
      let crc = await db.metaGet('crc:' + v.id);
      if (typeof crc !== 'number') {
        crc = await crc32OfBlob(blob);
        try { await db.metaSet('crc:' + v.id, crc); } catch { /* посчитаем в следующий раз */ }
      }
      const file = `videos/${v.id}.${extOf(v)}`;
      files.push({ name: file, blob, crc });
      const item = { id: v.id, kind: v.kind || 'video', name: v.name, type: v.type, size: v.size, hevc: !!v.hevc, file };
      const thumb = await db.metaGet('thumb:' + v.id);
      if (thumb instanceof Blob) {
        item.thumb = `thumbs/${v.id}.jpg`;
        files.push({ name: item.thumb, blob: thumb, crc: await crc32OfBlob(thumb) });
      }
      vids.push(item);
    }
    out.push({
      id: e.id, date: e.date, text: e.text, tags: e.tags || [], starred: !!e.starred,
      createdAt: e.createdAt, updatedAt: e.updatedAt, videos: vids,
    });
  }

  const json = new Blob(
    [JSON.stringify({ app: 'dnevnik', format: 1, exportedAt: new Date().toISOString(), entries: out }, null, 1)],
    { type: 'application/json' },
  );
  files.unshift({ name: 'diary.json', blob: json, crc: await crc32OfBlob(json) });

  const zip = buildZip(files);
  const name = `dnevnik-${nowLocal().slice(0, 10)}.zip`;
  const media = out.reduce((sum, e) => sum + e.videos.length, 0);
  return { file: new File([zip], name, { type: 'application/zip' }), entries: out.length, videos: media, missing };
}

function cleanEntry(raw) {
  if (!raw || typeof raw !== 'object' || !ID_RE.test(String(raw.id || ''))) return null;
  const date = String(raw.date || '').slice(0, 16);
  if (!DATE_RE.test(date)) return null;
  const videos = [];
  for (const v of Array.isArray(raw.videos) ? raw.videos : []) {
    if (!v || !ID_RE.test(String(v.id || ''))) continue;
    videos.push({
      id: String(v.id),
      kind: v.kind === 'audio' ? 'audio' : 'video',
      thumb: typeof v.thumb === 'string' ? v.thumb : null,
      name: String(v.name || 'video').slice(0, 200),
      type: String(v.type || '').slice(0, 100),
      size: Number(v.size) || 0,
      hevc: typeof v.hevc === 'boolean' ? v.hevc : null,
      file: typeof v.file === 'string' ? v.file : null,
    });
  }
  const now = Date.now();
  return {
    id: String(raw.id),
    date,
    text: typeof raw.text === 'string' ? raw.text : '',
    tags: (Array.isArray(raw.tags) ? raw.tags : []).filter((t) => typeof t === 'string' && t.trim()).map((t) => t.trim().slice(0, 40)).slice(0, 30),
    starred: raw.starred === true,
    createdAt: Number(raw.createdAt) || now,
    updatedAt: Number(raw.updatedAt) || now,
    videos,
  };
}

// Добавляет записи из копии к тем, что уже есть. Ничего не стирает:
// если запись есть и там и тут, остаётся та, что изменена позже.
export async function importBackup(file, entries, onProgress) {
  let zip;
  let data;
  try {
    zip = await readZip(file);
    const jb = await zip.blob('diary.json');
    data = jb ? JSON.parse(await jb.text()) : null;
  } catch {
    data = null;
  }
  if (!data || data.app !== 'dnevnik' || !Array.isArray(data.entries)) {
    throw new BackupError('Это не файл резервной копии «Дневника». Ничего не изменено.');
  }

  const byId = new Map(entries.map((e) => [e.id, e]));
  const have = new Set(await db.getAllVideoKeys());
  const todo = [];
  let need = 0;
  for (const raw of data.entries) {
    const e = cleanEntry(raw);
    if (!e) continue;
    const local = byId.get(e.id);
    if (local && local.updatedAt >= e.updatedAt) continue;
    todo.push(e);
    for (const v of e.videos) if (!have.has(v.id)) need += v.size;
  }

  const free = await freeSpace();
  if (free !== null && need > free) {
    throw new BackupError(`Не хватает места: нужно ${fmtSize(need)}, свободно примерно ${fmtSize(free)}. Ничего не изменено.`);
  }

  const res = { added: 0, updated: 0, videos: 0, same: data.entries.length - todo.length, missingVideos: 0, hevc: false, noSpace: false };
  let done = 0;
  for (const e of todo) {
    if (onProgress) onProgress(++done, todo.length);
    try {
      const vids = [];
      for (const v of e.videos) {
        if (!have.has(v.id)) {
          const blob = v.file ? await zip.blob(v.file, v.type) : null;
          if (!blob) { res.missingVideos++; continue; }
          await db.putVideo(v.id, blob);
          have.add(v.id);
          res.videos++;
          if (v.hevc === null) v.hevc = v.kind === 'video' ? await sniffHevc(blob) : false;
          if (v.hevc) res.hevc = true;
          if (v.thumb) {
            try {
              const thumb = await zip.blob(v.thumb, 'image/jpeg');
              if (thumb) await db.metaSet('thumb:' + v.id, thumb);
            } catch { /* без картинки в ленте можно обойтись */ }
          }
        }
        vids.push({ id: v.id, kind: v.kind, name: v.name, type: v.type, size: v.size, hevc: !!v.hevc });
      }
      await db.putEntry({ ...e, videos: vids });
      const local = byId.get(e.id);
      if (local) {
        res.updated++;
        const keep = new Set(vids.map((v) => v.id));
        const gone = local.videos.filter((v) => !keep.has(v.id)).map((v) => v.id);
        try { await db.deleteVideos(gone); } catch { /* уберётся при следующем запуске */ }
      } else {
        res.added++;
      }
    } catch (err) {
      if (db.isQuotaError(err)) { res.noSpace = true; break; }
      throw err;
    }
  }
  return res;
}
