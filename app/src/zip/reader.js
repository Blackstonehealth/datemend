// Minimal streaming-friendly ZIP reader (stored + deflate, ZIP64, UTF-8 names).
// Reads only the central directory up front; entry bytes are read lazily via Blob.slice,
// so multi-GB archives are never loaded whole. No network. No dependencies.
import { crc32, view } from '../util/bytes.js';

const SIG_EOCD = 0x06054b50, SIG_EOCD64 = 0x06064b50, SIG_LOC64 = 0x07064b50;
const SIG_CEN = 0x02014b50, SIG_LOC = 0x04034b50;

function decodeName(bytes, utf8Flag) {
  if (utf8Flag) return new TextDecoder('utf-8').decode(bytes);
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { return new TextDecoder('latin1').decode(bytes); } // close enough to CP437 for names we care about
}

function dosToMs(date, time) {
  const y = 1980 + (date >> 9), mo = ((date >> 5) & 15) || 1, d = (date & 31) || 1;
  const h = time >> 11, mi = (time >> 5) & 63, s = (time & 31) * 2;
  // DOS times carry no zone; treat as UTC. Only used as a weak hint, never as truth.
  return Date.UTC(y, mo - 1, d, h, mi, s);
}

/** Open a zip from a Blob/File. Returns { entries, blob }. */
export async function openZip(blob) {
  const size = blob.size;
  if (size < 22) throw new Error('Not a zip file (too small)');
  const tailLen = Math.min(size, 65535 + 22 + 20);
  const tailStart = size - tailLen;
  const tail = new Uint8Array(await blob.slice(tailStart, size).arrayBuffer());
  const tv = view(tail);
  let eocd = -1;
  for (let i = tail.length - 22; i >= 0; i--) {
    if (tv.getUint32(i, true) === SIG_EOCD && i + 22 + tv.getUint16(i + 20, true) === tail.length) { eocd = i; break; }
  }
  if (eocd < 0) {
    for (let i = tail.length - 22; i >= 0; i--) if (tv.getUint32(i, true) === SIG_EOCD) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('Not a zip file (end-of-central-directory not found)');
  let total = tv.getUint16(eocd + 10, true);
  let cdSize = tv.getUint32(eocd + 12, true);
  let cdOffset = tv.getUint32(eocd + 16, true);
  if (total === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
    const loc = eocd - 20;
    if (loc >= 0 && tv.getUint32(loc, true) === SIG_LOC64) {
      const off64 = Number(tv.getBigUint64(loc + 8, true));
      const rec = new Uint8Array(await blob.slice(off64, off64 + 56).arrayBuffer());
      const rv = view(rec);
      if (rv.getUint32(0, true) !== SIG_EOCD64) throw new Error('Corrupt ZIP64 end record');
      total = Number(rv.getBigUint64(32, true));
      cdSize = Number(rv.getBigUint64(40, true));
      cdOffset = Number(rv.getBigUint64(48, true));
    } else throw new Error('ZIP64 locator missing');
  }
  const cd = new Uint8Array(await blob.slice(cdOffset, cdOffset + cdSize).arrayBuffer());
  const cv = view(cd);
  const entries = [];
  let p = 0;
  for (let n = 0; n < total && p + 46 <= cd.length; n++) {
    if (cv.getUint32(p, true) !== SIG_CEN) throw new Error('Corrupt central directory');
    const flags = cv.getUint16(p + 8, true), method = cv.getUint16(p + 10, true);
    const time = cv.getUint16(p + 12, true), date = cv.getUint16(p + 14, true);
    const crc = cv.getUint32(p + 16, true);
    let csize = cv.getUint32(p + 20, true), usize = cv.getUint32(p + 24, true);
    const nlen = cv.getUint16(p + 28, true), elen = cv.getUint16(p + 30, true), clen = cv.getUint16(p + 32, true);
    let lho = cv.getUint32(p + 42, true);
    const name = decodeName(cd.subarray(p + 46, p + 46 + nlen), !!(flags & 0x0800));
    let mtime = dosToMs(date, time);
    let q = p + 46 + nlen; const qEnd = q + elen;
    while (q + 4 <= qEnd) {
      const id = cv.getUint16(q, true), len = cv.getUint16(q + 2, true), b = q + 4;
      if (id === 0x0001) {
        let o = b;
        if (usize === 0xffffffff) { usize = Number(cv.getBigUint64(o, true)); o += 8; }
        if (csize === 0xffffffff) { csize = Number(cv.getBigUint64(o, true)); o += 8; }
        if (lho === 0xffffffff) { lho = Number(cv.getBigUint64(o, true)); o += 8; }
      } else if (id === 0x5455 && len >= 5 && (cd[b] & 1)) {
        mtime = cv.getUint32(b + 1, true) * 1000;
      }
      q += 4 + len;
    }
    entries.push({ name, isDir: name.endsWith('/'), method, flags, crc, csize, usize, lho, mtime });
    p += 46 + nlen + elen + clen;
  }
  return { blob, entries };
}

async function dataStart(zip, e) {
  const h = new Uint8Array(await zip.blob.slice(e.lho, e.lho + 30).arrayBuffer());
  const hv = view(h);
  if (hv.getUint32(0, true) !== SIG_LOC) throw new Error('Corrupt local header for ' + e.name);
  return e.lho + 30 + hv.getUint16(26, true) + hv.getUint16(28, true);
}

/** Return the entry's (decompressed) bytes as a Blob. Stored entries stay lazy (no copy). */
export async function entryBlob(zip, e, { verify = false } = {}) {
  if (e.flags & 1) throw new Error('Encrypted zip entries are not supported: ' + e.name);
  const start = await dataStart(zip, e);
  const raw = zip.blob.slice(start, start + e.csize);
  if (e.method === 0) {
    if (e.csize !== e.usize) throw new Error('Size mismatch in stored entry ' + e.name);
    if (verify) await checkCrc(raw, e);
    return raw;
  }
  if (e.method === 8) {
    if (typeof DecompressionStream === 'undefined') throw new Error('This browser lacks DecompressionStream (needed for compressed zips). Use a current Chrome, Edge, Firefox or Safari.');
    const out = await new Response(raw.stream().pipeThrough(new DecompressionStream('deflate-raw'))).blob();
    if (out.size !== e.usize) throw new Error('Decompressed size mismatch in ' + e.name);
    await checkCrc(out, e);
    return out;
  }
  throw new Error(`Unsupported zip compression method ${e.method} in ${e.name}`);
}

async function checkCrc(blob, e) {
  let c = 0;
  const r = blob.stream().getReader();
  for (;;) { const { done, value } = await r.read(); if (done) break; c = crc32(value, c); }
  if (c !== e.crc) throw new Error('CRC mismatch (corrupt data) in ' + e.name);
}
