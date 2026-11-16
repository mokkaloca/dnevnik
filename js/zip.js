// Простой zip без сжатия (видео и так сжато).
// Файлы не читаются в память целиком: архив собирается из ссылок на них.
// Поддерживает zip64, поэтому архив может быть больше 4 ГБ.

const LIMIT32 = 0xFFFFFFFF;
const enc = new TextEncoder();

let table;
function crcTable() {
  if (!table) {
    table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c >>> 0;
    }
  }
  return table;
}

// Контрольная сумма файла. Читает его кусками по 4 МБ.
export async function crc32OfBlob(blob) {
  const T = crcTable();
  const CHUNK = 4 * 1024 * 1024;
  let c = 0xFFFFFFFF;
  for (let off = 0; off < blob.size; off += CHUNK) {
    const b = new Uint8Array(await blob.slice(off, off + CHUNK).arrayBuffer());
    for (let i = 0; i < b.length; i++) c = T[(c ^ b[i]) & 0xFF] ^ (c >>> 8);
  }
  return (c ^ 0xFFFFFFFF) >>> 0;
}

function w64(view, pos, n) {
  view.setUint32(pos, n % 4294967296, true);
  view.setUint32(pos + 4, Math.floor(n / 4294967296), true);
}

function r64(view, pos) {
  return view.getUint32(pos, true) + view.getUint32(pos + 4, true) * 4294967296;
}

// files: [{ name, blob, crc }] → Blob с архивом.
// limit нужен только для проверок: с маленьким значением включается режим zip64.
export function buildZip(files, { limit = LIMIT32, date = new Date() } = {}) {
  const dosTime = (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1);
  const dosDate = ((Math.max(1980, date.getFullYear()) - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  const parts = [];
  const central = [];
  let offset = 0;

  for (const f of files) {
    const name = enc.encode(f.name);
    const size = f.blob.size;
    const big = size >= limit;
    const offBig = offset >= limit;

    const localExtra = big ? 20 : 0;
    const lh = new DataView(new ArrayBuffer(30 + name.length + localExtra));
    lh.setUint32(0, 0x04034b50, true);
    lh.setUint16(4, big ? 45 : 20, true);
    lh.setUint16(6, 0x0800, true); // имена в UTF-8
    lh.setUint16(8, 0, true); // без сжатия
    lh.setUint16(10, dosTime, true);
    lh.setUint16(12, dosDate, true);
    lh.setUint32(14, f.crc, true);
    lh.setUint32(18, big ? LIMIT32 : size, true);
    lh.setUint32(22, big ? LIMIT32 : size, true);
    lh.setUint16(26, name.length, true);
    lh.setUint16(28, localExtra, true);
    new Uint8Array(lh.buffer).set(name, 30);
    if (big) {
      const p = 30 + name.length;
      lh.setUint16(p, 1, true);
      lh.setUint16(p + 2, 16, true);
      w64(lh, p + 4, size);
      w64(lh, p + 12, size);
    }
    parts.push(lh.buffer, f.blob);

    const extraData = (big ? 16 : 0) + (offBig ? 8 : 0);
    const extraLen = extraData ? extraData + 4 : 0;
    const ch = new DataView(new ArrayBuffer(46 + name.length + extraLen));
    ch.setUint32(0, 0x02014b50, true);
    ch.setUint16(4, 45, true);
    ch.setUint16(6, big || offBig ? 45 : 20, true);
    ch.setUint16(8, 0x0800, true);
    ch.setUint16(10, 0, true);
    ch.setUint16(12, dosTime, true);
    ch.setUint16(14, dosDate, true);
    ch.setUint32(16, f.crc, true);
    ch.setUint32(20, big ? LIMIT32 : size, true);
    ch.setUint32(24, big ? LIMIT32 : size, true);
    ch.setUint16(28, name.length, true);
    ch.setUint16(30, extraLen, true);
    ch.setUint32(42, offBig ? LIMIT32 : offset, true);
    new Uint8Array(ch.buffer).set(name, 46);
    if (extraLen) {
      let p = 46 + name.length;
      ch.setUint16(p, 1, true);
      ch.setUint16(p + 2, extraData, true);
      p += 4;
      if (big) { w64(ch, p, size); w64(ch, p + 8, size); p += 16; }
      if (offBig) w64(ch, p, offset);
    }
    central.push(ch.buffer);
    offset += lh.byteLength + size;
  }

  const cdOffset = offset;
  const cdSize = central.reduce((s, b) => s + b.byteLength, 0);
  parts.push(...central);

  const need64 = files.length >= 0xFFFF || cdOffset >= limit || cdSize >= limit;
  if (need64) {
    const e = new DataView(new ArrayBuffer(56 + 20));
    e.setUint32(0, 0x06064b50, true);
    w64(e, 4, 44);
    e.setUint16(12, 45, true);
    e.setUint16(14, 45, true);
    w64(e, 24, files.length);
    w64(e, 32, files.length);
    w64(e, 40, cdSize);
    w64(e, 48, cdOffset);
    e.setUint32(56, 0x07064b50, true);
    w64(e, 64, cdOffset + cdSize);
    e.setUint32(72, 1, true);
    parts.push(e.buffer);
  }

  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, need64 ? 0xFFFF : files.length, true);
  end.setUint16(10, need64 ? 0xFFFF : files.length, true);
  end.setUint32(12, need64 ? LIMIT32 : cdSize, true);
  end.setUint32(16, need64 ? LIMIT32 : cdOffset, true);
  parts.push(end.buffer);

  return new Blob(parts, { type: 'application/zip' });
}

// Читает оглавление архива. Содержимое файлов достаётся по запросу и тоже не грузится в память.
export async function readZip(file) {
  const size = file.size;
  const tailLen = Math.min(size, 65536 + 22 + 20);
  const tail = new DataView(await file.slice(size - tailLen).arrayBuffer());
  let p = -1;
  for (let i = tail.byteLength - 22; i >= 0; i--) {
    if (tail.getUint32(i, true) === 0x06054b50) { p = i; break; }
  }
  if (p < 0) throw new Error('Это не zip-архив');

  let count = tail.getUint16(p + 10, true);
  let cdSize = tail.getUint32(p + 12, true);
  let cdOffset = tail.getUint32(p + 16, true);
  if (count === 0xFFFF || cdSize === LIMIT32 || cdOffset === LIMIT32) {
    const lp = p - 20;
    if (lp >= 0 && tail.getUint32(lp, true) === 0x07064b50) {
      const at = r64(tail, lp + 8);
      const e = new DataView(await file.slice(at, at + 56).arrayBuffer());
      if (e.byteLength === 56 && e.getUint32(0, true) === 0x06064b50) {
        count = r64(e, 32);
        cdSize = r64(e, 40);
        cdOffset = r64(e, 48);
      }
    }
  }

  const cd = new DataView(await file.slice(cdOffset, cdOffset + cdSize).arrayBuffer());
  const dec = new TextDecoder();
  const entries = new Map();
  let q = 0;
  for (let i = 0; i < count; i++) {
    if (q + 46 > cd.byteLength || cd.getUint32(q, true) !== 0x02014b50) throw new Error('Архив повреждён');
    const method = cd.getUint16(q + 10, true);
    let comp = cd.getUint32(q + 20, true);
    let uncomp = cd.getUint32(q + 24, true);
    const nameLen = cd.getUint16(q + 28, true);
    const extraLen = cd.getUint16(q + 30, true);
    const commentLen = cd.getUint16(q + 32, true);
    let off = cd.getUint32(q + 42, true);
    const name = dec.decode(new Uint8Array(cd.buffer, q + 46, nameLen)).replace(/\\/g, '/');
    let x = q + 46 + nameLen;
    const extraEnd = x + extraLen;
    while (x + 4 <= extraEnd) {
      const id = cd.getUint16(x, true);
      const len = cd.getUint16(x + 2, true);
      if (id === 1) {
        let y = x + 4;
        if (uncomp === LIMIT32) { uncomp = r64(cd, y); y += 8; }
        if (comp === LIMIT32) { comp = r64(cd, y); y += 8; }
        if (off === LIMIT32) off = r64(cd, y);
      }
      x += 4 + len;
    }
    entries.set(name, { method, comp, uncomp, off });
    q = extraEnd + commentLen;
  }

  return {
    names: [...entries.keys()],
    async blob(name, type = '') {
      const e = entries.get(name);
      if (!e) return null;
      const lh = new DataView(await file.slice(e.off, e.off + 30).arrayBuffer());
      if (lh.byteLength < 30 || lh.getUint32(0, true) !== 0x04034b50) throw new Error('Архив повреждён');
      const start = e.off + 30 + lh.getUint16(26, true) + lh.getUint16(28, true);
      const raw = file.slice(start, start + e.comp, type);
      if (e.method === 0) return raw;
      if (e.method === 8 && typeof DecompressionStream !== 'undefined') {
        const out = await new Response(raw.stream().pipeThrough(new DecompressionStream('deflate-raw'))).blob();
        return out.slice(0, out.size, type);
      }
      throw new Error('Архив сжат способом, который приложение не понимает');
    },
  };
}
