// Lossless EXIF writer for JPEG (APP1 rewrite; entropy-coded image data is copied byte-for-byte)
// and PNG (eXIf chunk). Existing tags are preserved (Make, Model, Orientation, ...) except the ones we
// set; MakerNote, Interop, thumbnails (IFD1) and SubIFD pointers are dropped because their internal
// offsets cannot be relocated safely.
import { concat, view, asciiBytes, ascii, crc32 } from '../util/bytes.js';

const TYPE_SIZE = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8, 13: 4 };
const DROP_IFD0 = new Set([0x8769, 0x8825, 0x014a, 0x0201, 0x0202, 0x0111, 0x0117]);
const DROP_EXIF = new Set([0x927c, 0xa005, 0x8769, 0x8825]);
const T = { ASCII: 2, BYTE: 1, SHORT: 3, LONG: 4, RATIONAL: 5 };

// ---------- parse existing ----------
function parseTiff(tiff) {
  if (tiff.length < 8) return null;
  const le = tiff[0] === 0x49 && tiff[1] === 0x49;
  if (!le && !(tiff[0] === 0x4d && tiff[1] === 0x4d)) return null;
  const v = view(tiff);
  const u16 = (o) => v.getUint16(o, le), u32 = (o) => v.getUint32(o, le);
  if (u16(2) !== 42) return null;
  const readIfd = (off) => {
    const m = new Map();
    if (off < 8 || off + 2 > tiff.length) return m;
    const n = u16(off);
    for (let i = 0; i < n; i++) {
      const e = off + 2 + i * 12;
      if (e + 12 > tiff.length) break;
      const tag = u16(e), type = u16(e + 2), count = u32(e + 4);
      const sz = TYPE_SIZE[type];
      if (!sz) continue;
      const len = sz * count;
      let data;
      if (len <= 4) data = tiff.slice(e + 8, e + 8 + len);
      else {
        const vo = u32(e + 8);
        if (vo + len > tiff.length) continue;
        data = tiff.slice(vo, vo + len);
      }
      m.set(tag, { type, count, data });
    }
    return m;
  };
  const ifd0 = readIfd(u32(4));
  const ptr = (m, tag) => { const e = m.get(tag); return e && e.type === T.LONG && e.count === 1 ? view(e.data).getUint32(0, le) : 0; };
  const exif = ptr(ifd0, 0x8769) ? readIfd(ptr(ifd0, 0x8769)) : new Map();
  const gps = ptr(ifd0, 0x8825) ? readIfd(ptr(ifd0, 0x8825)) : new Map();
  return { le, ifd0, exif, gps };
}

// ---------- value builders (byte order aware) ----------
const mk = (le) => ({
  ascii: (s) => ({ type: T.ASCII, count: s.length + 1, data: concat([asciiBytes(s), new Uint8Array([0])]) }),
  short: (n) => { const d = new Uint8Array(2); view(d).setUint16(0, n, le); return { type: T.SHORT, count: 1, data: d }; },
  bytes: (arr) => ({ type: T.BYTE, count: arr.length, data: new Uint8Array(arr) }),
  rationals: (pairs) => {
    const d = new Uint8Array(pairs.length * 8); const dv = view(d);
    pairs.forEach(([n, den], i) => { dv.setUint32(i * 8, n, le); dv.setUint32(i * 8 + 4, den, le); });
    return { type: T.RATIONAL, count: pairs.length, data: d };
  },
});

function dmsRationals(deg) {
  const a = Math.abs(deg);
  let d = Math.floor(a), mi = Math.floor((a - d) * 60);
  let s = Math.round(((a - d) * 60 - mi) * 60 * 10000) / 10000;
  if (s >= 60) { s = 0; mi += 1; }
  if (mi >= 60) { mi = 0; d += 1; }
  return [[d, 1], [mi, 1], [Math.round(s * 10000), 10000]];
}

const p2 = (n) => String(n).padStart(2, '0');
const exifDate = (p) => `${String(p.y).padStart(4, '0')}:${p2(p.mo)}:${p2(p.d)} ${p2(p.h)}:${p2(p.mi)}:${p2(p.s)}`;
function offStr(min) { const a = Math.abs(min); return `${min < 0 ? '-' : '+'}${p2(Math.floor(a / 60))}:${p2(a % 60)}`; }

// ---------- serialize ----------
function serializeTiff(le, ifd0, exif, gps) {
  const v16 = (n) => { const b = new Uint8Array(2); view(b).setUint16(0, n, le); return b; };
  const v32 = (n) => { const b = new Uint8Array(4); view(b).setUint32(0, n, le); return b; };
  const ifds = [];
  const hasExif = exif.size > 0, hasGps = gps.size > 0;
  ifds.push({ name: 'ifd0', map: new Map(ifd0) });
  if (hasExif) ifds.push({ name: 'exif', map: new Map(exif) });
  if (hasGps) ifds.push({ name: 'gps', map: new Map(gps) });
  // placeholders for pointers (fixed size, so layout is computable before offsets are known)
  const ptrEntry = () => ({ type: T.LONG, count: 1, data: v32(0) });
  if (hasExif) ifds[0].map.set(0x8769, ptrEntry());
  if (hasGps) ifds[0].map.set(0x8825, ptrEntry());
  let off = 8;
  for (const f of ifds) { f.offset = off; f.entries = [...f.map.entries()].sort((a, b) => a[0] - b[0]); off += 2 + f.entries.length * 12 + 4; }
  const ptrs = {}; for (const f of ifds) ptrs[f.name] = f.offset;
  if (hasExif) ifds[0].map.set(0x8769, { type: T.LONG, count: 1, data: v32(ptrs.exif) });
  if (hasGps) ifds[0].map.set(0x8825, { type: T.LONG, count: 1, data: v32(ptrs.gps) });
  for (const f of ifds) f.entries = [...f.map.entries()].sort((a, b) => a[0] - b[0]);
  const dataChunks = []; let dataOff = off;
  const out = [new Uint8Array([le ? 0x49 : 0x4d, le ? 0x49 : 0x4d]), v16(42), v32(8)];
  for (const f of ifds) {
    out.push(v16(f.entries.length));
    for (const [tag, e] of f.entries) {
      const ent = new Uint8Array(12); const ev = view(ent);
      ev.setUint16(0, tag, le); ev.setUint16(2, e.type, le); ev.setUint32(4, e.count, le);
      if (e.data.length <= 4) ent.set(e.data, 8);
      else {
        ev.setUint32(8, dataOff, le);
        const padded = e.data.length % 2 ? concat([e.data, new Uint8Array(1)]) : e.data;
        dataChunks.push(padded); dataOff += padded.length;
      }
      out.push(ent);
    }
    out.push(v32(0));
  }
  return concat([...out, ...dataChunks]);
}

/**
 * Build the TIFF payload.
 * info: { local: {y,mo,d,h,mi,s,offsetMinutes}, utc: {y,mo,d,h,mi,s}, gps: {lat,lon}|null, resetOrientation?: bool }
 * existingTiff: Uint8Array|null (TIFF bytes of an existing Exif APP1, after the "Exif\0\0" prefix)
 * Returns { tiff, warnings }
 */
export function buildExifTiff(info, existingTiff = null) {
  const warnings = [];
  let parsed = existingTiff ? parseTiff(existingTiff) : null;
  if (existingTiff && !parsed) warnings.push('existing EXIF block unreadable; replaced');
  const le = parsed ? parsed.le : true;
  const b = mk(le);
  const ifd0 = new Map(), exif = new Map(), gps = new Map();
  if (parsed) {
    for (const [t, e] of parsed.ifd0) if (!DROP_IFD0.has(t)) ifd0.set(t, e);
    for (const [t, e] of parsed.exif) if (!DROP_EXIF.has(t)) exif.set(t, e);
    if (!info.gps) for (const [t, e] of parsed.gps) gps.set(t, e);
  }
  const dt = exifDate(info.local), off = offStr(info.local.offsetMinutes);
  ifd0.set(0x0132, b.ascii(dt));
  exif.set(0x9003, b.ascii(dt)); exif.set(0x9004, b.ascii(dt));
  exif.set(0x9010, b.ascii(off)); exif.set(0x9011, b.ascii(off)); exif.set(0x9012, b.ascii(off));
  if (!exif.has(0xa000)) exif.set(0xa000, { type: 7, count: 4, data: asciiBytes('0231') }); // ExifVersion
  if (info.resetOrientation && ifd0.has(0x0112)) ifd0.set(0x0112, b.short(1));
  if (info.gps) {
    const { lat, lon } = info.gps;
    gps.set(0x0000, b.bytes([2, 3, 0, 0]));
    gps.set(0x0001, b.ascii(lat < 0 ? 'S' : 'N')); gps.set(0x0002, b.rationals(dmsRationals(lat)));
    gps.set(0x0003, b.ascii(lon < 0 ? 'W' : 'E')); gps.set(0x0004, b.rationals(dmsRationals(lon)));
    const u = info.utc;
    gps.set(0x0007, b.rationals([[u.h, 1], [u.mi, 1], [u.s, 1]]));
    gps.set(0x001d, b.ascii(`${String(u.y).padStart(4, '0')}:${p2(u.mo)}:${p2(u.d)}`));
  }
  let tiff = serializeTiff(le, ifd0, exif, gps);
  if (tiff.length > 65000) {
    // Too big for one APP1: keep only essentials.
    warnings.push('large pre-existing EXIF dropped (kept Make/Model/Orientation only)');
    for (const m of [ifd0, exif]) for (const [t, e] of [...m]) if (e.data.length > 64 && ![0x0132, 0x9003, 0x9004].includes(t)) m.delete(t);
    tiff = serializeTiff(le, ifd0, exif, gps);
  }
  return { tiff, warnings };
}

// ---------- JPEG ----------
export function isJpeg(u8) { return u8.length > 3 && u8[0] === 0xff && u8[1] === 0xd8 && u8[2] === 0xff; }

/** Split a JPEG into header segments (before SOS) and the untouched remainder. */
function splitJpeg(u8) {
  const segs = [];
  let p = 2;
  while (p + 4 <= u8.length) {
    if (u8[p] !== 0xff) throw new Error('Corrupt JPEG (bad marker)');
    let m = u8[p + 1];
    if (m === 0xff) { p++; continue; }
    if (m === 0xda || m === 0xd9) return { segs, rest: p };
    if (m >= 0xd0 && m <= 0xd7 || m === 0x01) { p += 2; continue; }
    const len = (u8[p + 2] << 8) | u8[p + 3];
    if (len < 2 || p + 2 + len > u8.length) throw new Error('Corrupt JPEG (bad segment length)');
    segs.push({ marker: m, start: p, end: p + 2 + len });
    p += 2 + len;
  }
  throw new Error('Corrupt JPEG (no image data found)');
}

/** Returns { bytes: Uint8Array parts[], warnings } — the JPEG with EXIF set, pixel data untouched. */
export function writeJpegExif(u8, info) {
  if (!isJpeg(u8)) throw new Error('Not a JPEG');
  const { segs, rest } = splitJpeg(u8);
  let existing = null;
  for (const s of segs) {
    if (s.marker === 0xe1 && ascii(u8, s.start + 4, s.start + 10) === 'Exif\0\0') { existing = u8.subarray(s.start + 10, s.end); break; }
  }
  const { tiff, warnings } = buildExifTiff(info, existing);
  const app1 = new Uint8Array(10 + tiff.length);
  app1[0] = 0xff; app1[1] = 0xe1;
  const len = 2 + 6 + tiff.length;
  app1[2] = len >> 8; app1[3] = len & 0xff;
  app1.set(asciiBytes('Exif'), 4); app1.set(tiff, 10);
  const isExifSeg = (s) => s.marker === 0xe1 && ascii(u8, s.start + 4, s.start + 10) === 'Exif\0\0';
  const kept = segs.filter((s) => !isExifSeg(s));
  const at = kept.length && kept[0].marker === 0xe0 ? 1 : 0; // keep JFIF APP0 first, then Exif
  const out = [u8.subarray(0, 2)];
  kept.forEach((s, i) => { if (i === at) out.push(app1); out.push(u8.subarray(s.start, s.end)); });
  if (at >= kept.length) out.push(app1);
  out.push(u8.subarray(rest));
  return { parts: out, warnings };
}

// ---------- PNG ----------
export function isPng(u8) { return u8.length > 8 && u8[0] === 0x89 && u8[1] === 0x50 && u8[2] === 0x4e && u8[3] === 0x47; }

export function writePngExif(u8, info) {
  if (!isPng(u8)) throw new Error('Not a PNG');
  const dv = view(u8);
  const chunks = [];
  let p = 8; let existing = null;
  while (p + 12 <= u8.length) {
    const len = dv.getUint32(p), type = ascii(u8, p + 4, p + 8);
    if (p + 12 + len > u8.length) throw new Error('Corrupt PNG');
    chunks.push({ type, start: p, end: p + 12 + len });
    if (type === 'eXIf') existing = u8.subarray(p + 8, p + 8 + len);
    p += 12 + len;
    if (type === 'IEND') break;
  }
  const { tiff, warnings } = buildExifTiff(info, existing);
  const chunk = new Uint8Array(12 + tiff.length); const cv = view(chunk);
  cv.setUint32(0, tiff.length); chunk.set(asciiBytes('eXIf'), 4); chunk.set(tiff, 8);
  cv.setUint32(8 + tiff.length, crc32(chunk.subarray(4, 8 + tiff.length)));
  const out = [u8.subarray(0, 8)];
  let done = false;
  for (const c of chunks) {
    if (c.type === 'eXIf') continue;
    out.push(u8.subarray(c.start, c.end));
    if (c.type === 'IHDR' && !done) { out.push(chunk); done = true; }
  }
  return { parts: out, warnings };
}

/** Minimal reader for tests / diagnostics: returns decoded key tags from a JPEG or raw TIFF. */
export function readExifSummary(tiff) {
  const p = parseTiff(tiff);
  if (!p) return null;
  const le = p.le;
  const str = (e) => e && ascii(e.data, 0, e.data.length).replace(/\0+$/, '');
  const rat = (e) => { if (!e) return null; const v = view(e.data); const r = []; for (let i = 0; i < e.count; i++) r.push(v.getUint32(i * 8, le) / v.getUint32(i * 8 + 4, le)); return r; };
  const dms = (a) => a && a[0] + a[1] / 60 + a[2] / 3600;
  const lat = dms(rat(p.gps.get(2))), lon = dms(rat(p.gps.get(4)));
  return {
    tagsIfd0: [...p.ifd0.keys()], tagsExif: [...p.exif.keys()], tagsGps: [...p.gps.keys()],
    make: str(p.ifd0.get(0x010f)), dateTime: str(p.ifd0.get(0x0132)),
    orientation: p.ifd0.get(0x0112) ? view(p.ifd0.get(0x0112).data).getUint16(0, le) : null,
    dateTimeOriginal: str(p.exif.get(0x9003)), offsetTimeOriginal: str(p.exif.get(0x9011)),
    gpsLat: lat == null ? null : (str(p.gps.get(1)) === 'S' ? -lat : lat),
    gpsLon: lon == null ? null : (str(p.gps.get(3)) === 'W' ? -lon : lon),
    gpsDate: str(p.gps.get(0x1d)),
  };
}

export function extractJpegTiff(u8) {
  const { segs } = splitJpeg(u8);
  for (const s of segs) if (s.marker === 0xe1 && ascii(u8, s.start + 4, s.start + 10) === 'Exif\0\0') return u8.subarray(s.start + 10, s.end);
  return null;
}
