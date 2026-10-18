// Small byte helpers shared by the zip, EXIF and MP4 code. No DOM / Node specifics.

export const te = new TextEncoder();

export function concat(chunks) {
  let n = 0;
  for (const c of chunks) n += c.length;
  const out = new Uint8Array(n);
  let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.length; }
  return out;
}

export function ascii(u8, start = 0, end = u8.length) {
  let s = '';
  for (let i = start; i < end; i++) s += String.fromCharCode(u8[i]);
  return s;
}

export function asciiBytes(s) {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff;
  return out;
}

export function view(u8) { return new DataView(u8.buffer, u8.byteOffset, u8.byteLength); }

// ---- CRC32 (slicing-by-8) ----
const T = (() => {
  const t = new Uint32Array(256 * 8);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1;
    t[i] = c >>> 0;
  }
  for (let i = 0; i < 256; i++) {
    let c = t[i];
    for (let k = 1; k < 8; k++) { c = t[c & 0xff] ^ (c >>> 8); t[k * 256 + i] = c >>> 0; }
  }
  return t;
})();

/** Incremental CRC32. Start with crc = 0, feed chunks, result is an unsigned 32-bit int. */
export function crc32(chunk, crc = 0) {
  let c = ~crc >>> 0;
  let i = 0;
  const n = chunk.length;
  for (; i + 8 <= n; i += 8) {
    const a = c ^ (chunk[i] | (chunk[i + 1] << 8) | (chunk[i + 2] << 16) | (chunk[i + 3] << 24));
    c = T[1792 + (a & 0xff)] ^ T[1536 + ((a >>> 8) & 0xff)] ^ T[1280 + ((a >>> 16) & 0xff)] ^ T[1024 + (a >>> 24)] ^
        T[768 + chunk[i + 4]] ^ T[512 + chunk[i + 5]] ^ T[256 + chunk[i + 6]] ^ T[chunk[i + 7]];
  }
  for (; i < n; i++) c = T[(c ^ chunk[i]) & 0xff] ^ (c >>> 8);
  return ~c >>> 0;
}

/** Read a whole Blob (or Uint8Array) into a Uint8Array. */
export async function toU8(data) {
  if (data instanceof Uint8Array) return data;
  return new Uint8Array(await data.arrayBuffer());
}

/** Iterate a Blob in chunks without holding it all in memory. */
export async function* blobChunks(blob, chunkSize = 4 * 1024 * 1024) {
  for (let off = 0; off < blob.size; off += chunkSize) {
    yield new Uint8Array(await blob.slice(off, Math.min(blob.size, off + chunkSize)).arrayBuffer());
  }
}

export function baseName(path) { const i = path.lastIndexOf('/'); return i < 0 ? path : path.slice(i + 1); }
export function dirName(path) { const i = path.lastIndexOf('/'); return i < 0 ? '' : path.slice(0, i); }
export function extOf(name) { const i = name.lastIndexOf('.'); return i < 0 ? '' : name.slice(i + 1).toLowerCase(); }

export function pad(n, w = 2) { return String(n).padStart(w, '0'); }
