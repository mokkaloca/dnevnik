// Мелкие общие функции: идентификаторы, даты, размеры, проверка видео.

export function uid() {
  if (crypto.randomUUID) return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
}

const pad = (n) => String(n).padStart(2, '0');

// Дата хранится как местное время в виде «2026-11-16T14:05».
export function nowLocal(d = new Date()) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export const DATE_RE = /^\d{4}-\d\d-\d\dT\d\d:\d\d$/;

export function parseLocal(s) {
  const m = /^(\d{4})-(\d\d)-(\d\d)T(\d\d):(\d\d)/.exec(s || '');
  return m ? new Date(+m[1], m[2] - 1, +m[3], +m[4], +m[5]) : new Date(NaN);
}

const dayFmt = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'long', year: 'numeric', weekday: 'long' });
const dateFmt = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' });

export function fmtDay(s) {
  const d = parseLocal(s);
  if (isNaN(d)) return 'Без даты';
  const text = dayFmt.format(d);
  return text.charAt(0).toUpperCase() + text.slice(1);
}

export function fmtDate(s) {
  const d = typeof s === 'number' ? new Date(s) : parseLocal(s);
  return isNaN(d) ? 'без даты' : dateFmt.format(d);
}

export function fmtTime(s) {
  return (s || '').slice(11, 16);
}

export function fmtSize(bytes) {
  if (!(bytes >= 0)) return '—';
  const units = ['Б', 'КБ', 'МБ', 'ГБ', 'ТБ'];
  let i = 0;
  let n = bytes;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  const text = n >= 100 || i === 0 ? String(Math.round(n)) : n.toFixed(1).replace('.', ',').replace(',0', '');
  return `${text} ${units[i]}`;
}

// plural(3, 'запись', 'записи', 'записей') → «3 записи»
export function plural(n, one, few, many) {
  const a = Math.abs(n) % 100;
  const b = a % 10;
  const word = a > 10 && a < 20 ? many : b === 1 ? one : b >= 2 && b <= 4 ? few : many;
  return `${n} ${word}`;
}

const VIDEO_EXT = ['mov', 'mp4', 'm4v', 'webm', 'mkv', 'avi', '3gp', 'mpg', 'mpeg', 'wmv', 'ogv'];

const AUDIO_EXT = ['m4a', 'mp3', 'wav', 'ogg', 'oga', 'aac', 'caf', 'weba', 'flac'];

export const MONTHS = ['Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь', 'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь'];
export const WEEKDAYS = ['вс', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб'];

export function extOf(v) {
  const m = /\.([A-Za-z0-9]{1,5})$/.exec(v.name || '');
  if (m) return m[1].toLowerCase();
  const t = v.type || '';
  if (t.startsWith('audio/')) return t.includes('webm') ? 'webm' : t.includes('ogg') ? 'ogg' : t.includes('mpeg') ? 'mp3' : 'm4a';
  if (t.includes('quicktime')) return 'mov';
  if (t.includes('webm')) return 'webm';
  return 'mp4';
}

// 'video', 'audio' или null, если файл не подходит.
export function mediaKind(file) {
  const type = file.type || '';
  if (type.startsWith('video/')) return 'video';
  if (type.startsWith('audio/')) return 'audio';
  if (!/\.[A-Za-z0-9]+$/.test(file.name || '')) return null;
  const ext = extOf(file);
  if (VIDEO_EXT.includes(ext)) return 'video';
  if (AUDIO_EXT.includes(ext)) return 'audio';
  return null;
}

// Первая строка записи — заголовок, остальное — текст.
export function splitText(text) {
  const s = (text || '').trim();
  const i = s.indexOf('\n');
  return i < 0 ? [s, ''] : [s.slice(0, i).trim(), s.slice(i + 1).trim()];
}

function frameToBlob(video) {
  const w = video.videoWidth;
  const hgt = video.videoHeight;
  if (!w || !hgt) return Promise.resolve(null);
  const k = Math.min(1, 400 / Math.max(w, hgt));
  const c = document.createElement('canvas');
  c.width = Math.round(w * k);
  c.height = Math.round(hgt * k);
  try {
    c.getContext('2d').drawImage(video, 0, 0, c.width, c.height);
    return new Promise((resolve) => c.toBlob(resolve, 'image/jpeg', 0.72));
  } catch {
    return Promise.resolve(null);
  }
}

// Маленький кадр из уже открытого плеера.
export function thumbFromPlayer(video) {
  return frameToBlob(video);
}

// Маленький кадр из видеофайла для ленты. Если не получилось — null, это не ошибка.
export async function thumbFromFile(file, type) {
  const url = URL.createObjectURL(file.slice(0, file.size, type));
  const v = document.createElement('video');
  v.muted = true;
  v.playsInline = true;
  v.preload = 'auto';
  try {
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('timeout')), 5000);
      v.onloadeddata = () => { clearTimeout(t); resolve(); };
      v.onerror = () => { clearTimeout(t); reject(new Error('error')); };
      v.src = url;
      const p = v.play();
      if (p && p.then) p.then(() => v.pause()).catch(() => {});
    });
    if (v.duration > 1) {
      await new Promise((resolve) => {
        const t = setTimeout(resolve, 1500);
        v.onseeked = () => { clearTimeout(t); resolve(); };
        v.currentTime = Math.min(1, v.duration / 4);
      });
    }
    return await frameToBlob(v);
  } catch {
    return null;
  } finally {
    v.pause();
    v.removeAttribute('src');
    v.load();
    URL.revokeObjectURL(url);
  }
}

// Умеет ли это устройство показывать HEVC (формат видео айфона).
// Браузер отвечает на этот вопрос не всегда точно, поэтому ответ — только повод для подсказки.
export function canPlayHevc() {
  const type = 'video/mp4; codecs="hvc1.1.6.L93.B0"';
  try {
    if (document.createElement('video').canPlayType(type) !== '') return true;
    return typeof MediaSource !== 'undefined' && MediaSource.isTypeSupported(type);
  } catch {
    return false;
  }
}

// Под каким типом отдавать видео плееру. Вне Apple .mov лучше играется как mp4.
export function playableType(v) {
  let type = (v.type || '').split(';')[0];
  if (!type) {
    const ext = extOf(v);
    if (v.kind === 'audio') type = ext === 'webm' ? 'audio/webm' : ext === 'mp3' ? 'audio/mpeg' : ext === 'ogg' ? 'audio/ogg' : 'audio/mp4';
    else type = ext === 'mov' ? 'video/quicktime' : ext === 'webm' ? 'video/webm' : 'video/mp4';
  }
  if (type === 'video/quicktime' && document.createElement('video').canPlayType('video/quicktime') === '') {
    type = 'video/mp4';
  }
  return type;
}

// Проверяет, записано ли видео в HEVC: ищет метку кодека в начале и в конце файла.
// Читает не больше 4 МБ, сам файл в память не грузится.
export async function sniffHevc(blob) {
  const CHUNK = 2 * 1024 * 1024;
  const parts = [blob.slice(0, CHUNK)];
  if (blob.size > CHUNK) parts.push(blob.slice(Math.max(CHUNK, blob.size - CHUNK)));
  try {
    for (const part of parts) {
      const b = new Uint8Array(await part.arrayBuffer());
      for (let i = 0; i + 3 < b.length; i++) {
        // «hvc1» или «hev1»
        if (b[i] === 0x68 && ((b[i + 1] === 0x76 && b[i + 2] === 0x63) || (b[i + 1] === 0x65 && b[i + 2] === 0x76)) && b[i + 3] === 0x31) {
          return true;
        }
      }
    }
  } catch {
    return false;
  }
  return false;
}

export async function freeSpace() {
  try {
    const { quota, usage } = await navigator.storage.estimate();
    if (typeof quota !== 'number' || typeof usage !== 'number') return null;
    return Math.max(0, quota - usage);
  } catch {
    return null;
  }
}
