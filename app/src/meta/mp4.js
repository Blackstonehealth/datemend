// MP4/MOV metadata patcher (no re-encode). Sets creation/modification times in mvhd/tkhd/mdhd and, when a
// location is known, adds the QuickTime location atom (keys/ilst "com.apple.quicktime.location.ISO6709",
// which Apple Photos reads) plus the udta ©xyz atom (read by Google Photos/Android tools).
// Only the `moov` box is rewritten; the (possibly multi-GB) media data is referenced by Blob slices, never read.
// If `moov` sits before `mdat`, all chunk offsets (stco/co64) are shifted by the size change.
import { view, concat, ascii, asciiBytes, te } from '../util/bytes.js';

const EPOCH_1904 = 2082844800; // seconds between 1904-01-01 and 1970-01-01
const CONTAINERS = new Set(['moov', 'trak', 'mdia', 'minf', 'stbl', 'udta', 'meta']);

function u32(b, o) { return view(b).getUint32(o); }
function box(type, ...payload) {
  const body = concat(payload);
  const out = new Uint8Array(8 + body.length);
  view(out).setUint32(0, out.length); out.set(asciiBytes(type), 4); out.set(body, 8);
  return out;
}
const be32 = (n) => { const b = new Uint8Array(4); view(b).setUint32(0, n); return b; };

// ---- tiny box tree over a Uint8Array ----
function parseBoxes(buf, start, end) {
  const list = [];
  let p = start;
  while (p + 8 <= end) {
    let size = u32(buf, p); const type = ascii(buf, p + 4, p + 8); let hdr = 8;
    if (size === 1) { size = Number(view(buf).getBigUint64(p + 8)); hdr = 16; }
    else if (size === 0) size = end - p;
    if (size < hdr || p + size > end) break;
    const b = { type, raw: buf.subarray(p, p + size), hdr, children: null, dirty: false };
    list.push(b);
    p += size;
  }
  return list;
}
function expand(b) {
  if (b.children || !CONTAINERS.has(b.type)) return b;
  const prefix = b.type === 'meta' ? 4 : 0;
  b.prefix = b.raw.subarray(b.hdr, b.hdr + prefix);
  b.children = parseBoxes(b.raw, b.hdr + prefix, b.raw.length);
  return b;
}
function expandAll(b) { expand(b); if (b.children) b.children.forEach(expandAll); return b; }
function markDirty(path) { path.forEach((b) => { b.dirty = true; }); }
function find(b, type) { return (b.children || []).find((c) => c.type === type); }
function walk(b, fn, path = []) { fn(b, path); (b.children || []).forEach((c) => walk(c, fn, [...path, b])); }

function setTimes(b, secs) {
  // mvhd / tkhd / mdhd: version(1) flags(3) creation modification ...
  const raw = new Uint8Array(b.raw); const v = view(raw);
  const o = b.hdr; const ver = raw[o];
  if (ver === 1) { v.setBigUint64(o + 4, BigInt(secs)); v.setBigUint64(o + 12, BigInt(secs)); }
  else { const s32 = Math.min(secs, 0xffffffff); v.setUint32(o + 4, s32); v.setUint32(o + 8, s32); }
  b.raw = raw;
}

function shiftOffsets(b, from, delta) {
  const raw = new Uint8Array(b.raw); const v = view(raw);
  const o = b.hdr; const n = v.getUint32(o + 4);
  if (b.type === 'stco') {
    for (let i = 0; i < n; i++) { const p = o + 8 + i * 4; const x = v.getUint32(p); if (x >= from) { const y = x + delta; if (y > 0xffffffff || y < 0) throw new Error('chunk offset overflow (stco)'); v.setUint32(p, y); } }
  } else {
    for (let i = 0; i < n; i++) { const p = o + 8 + i * 8; const x = Number(v.getBigUint64(p)); if (x >= from) v.setBigUint64(p, BigInt(x + delta)); }
  }
  b.raw = raw;
}

export function iso6709(lat, lon) {
  const f = (v, intDigits) => (v < 0 ? '-' : '+') + Math.abs(v).toFixed(4).padStart(intDigits + 5, '0');
  return `${f(lat, 2)}${f(lon, 3)}/`;
}

function locationMetaBox(str) {
  const hdlr = box('hdlr', new Uint8Array(4), new Uint8Array(4), asciiBytes('mdta'), new Uint8Array(12), new Uint8Array(1));
  const keyName = asciiBytes('com.apple.quicktime.location.ISO6709');
  const keys = box('keys', new Uint8Array(4), be32(1), be32(8 + keyName.length), asciiBytes('mdta'), keyName);
  const data = box('data', be32(1), be32(0), te.encode(str));
  const item = new Uint8Array(8 + data.length); view(item).setUint32(0, item.length); view(item).setUint32(4, 1); item.set(data, 8);
  const ilst = box('ilst', item);
  return box('meta', new Uint8Array(4), hdlr, keys, ilst);
}

function xyzBox(str) {
  const s = te.encode(str);
  const body = new Uint8Array(4 + s.length); const v = view(body);
  v.setUint16(0, s.length); v.setUint16(2, 0x15c7); body.set(s, 4); // language 'und'
  return box('\u00a9xyz', body);
}

async function topLevel(blob) {
  const boxes = [];
  let p = 0;
  while (p + 8 <= blob.size) {
    const h = new Uint8Array(await blob.slice(p, Math.min(blob.size, p + 16)).arrayBuffer());
    let size = u32(h, 0); const type = ascii(h, 4, 8);
    if (size === 1) { if (h.length < 16) break; size = Number(view(h).getBigUint64(8)); }
    else if (size === 0) size = blob.size - p;
    if (size < 8 || p + size > blob.size) break;
    boxes.push({ type, start: p, size });
    p += size;
  }
  return boxes;
}

/**
 * patchMp4(blob, { creationMs, location: {lat, lon}|null })
 * -> { blob, notes: string[], changed: boolean, hevc: boolean }
 */
export async function patchMp4(blob, { creationMs, location = null } = {}) {
  const notes = [];
  const boxes = await topLevel(blob);
  if (!boxes.some((b) => b.type === 'ftyp')) throw new Error('Not an MP4/MOV file (no ftyp)');
  const moovB = boxes.find((b) => b.type === 'moov');
  if (!moovB) throw new Error('No moov box (not a playable MP4)');
  if (boxes.some((b) => b.type === 'moof' || b.type === 'mfra')) {
    return { blob, notes: ['fragmented MP4: metadata not patched'], changed: false, hevc: false };
  }
  if (moovB.size > 256 * 1024 * 1024) throw new Error('moov box implausibly large');
  const moovBuf = new Uint8Array(await blob.slice(moovB.start, moovB.start + moovB.size).arrayBuffer());
  const moov = expandAll(parseBoxes(moovBuf, 0, moovBuf.length)[0]);
  if (find(moov, 'mvex')) {
    return { blob, notes: ['fragmented MP4 (mvex): metadata not patched'], changed: false, hevc: false };
  }
  const hevc = /hvc1|hev1/.test(ascii(moovBuf, 0, moovBuf.length));
  const oldSize = moovB.size;

  // 1) times
  if (creationMs != null) {
    const secs = Math.max(0, Math.floor(creationMs / 1000) + EPOCH_1904);
    walk(moov, (b, path) => {
      if (b.type === 'mvhd' && path.length === 1) { setTimes(b, secs); markDirty(path); }
      else if (b.type === 'tkhd' && path.length === 2 && path[1].type === 'trak') { setTimes(b, secs); markDirty(path); }
      else if (b.type === 'mdhd' && path.length === 3 && path[2].type === 'mdia') { setTimes(b, secs); markDirty(path); }
    });
  }

  // 2) location
  let locationWritten = false;
  if (location) {
    const str = iso6709(location.lat, location.lon);
    const isMdta = (mb) => { const h = find(mb, 'hdlr'); return !!h && ascii(h.raw, h.hdr + 8, h.hdr + 12) === 'mdta' && !!find(mb, 'keys') && !!find(mb, 'ilst'); };
    let meta = moov.children.find((c) => c.type === 'meta');
    let ok = true;
    if (!meta) {
      // Some muxers (ffmpeg +use_metadata_tags) put an mdta meta inside udta. Players disagree about reading
      // two meta boxes, so move it to the standard moov level and merge the location into it.
      const u = moov.children.find((c) => c.type === 'udta');
      const um = u && (u.children || []).find((c) => c.type === 'meta' && isMdta(c));
      if (um) { u.children = u.children.filter((c) => c !== um); markDirty([moov, u]); moov.children.push(um); meta = um; notes.push('moved existing mdta metadata from udta to moov level'); }
    }
    if (!meta) {
      const mb = locationMetaBox(str);
      moov.children.push(expandAll(parseBoxes(mb, 0, mb.length)[0]));
      markDirty([moov]);
    } else {
      const hdlr = find(meta, 'hdlr');
      const handler = hdlr ? ascii(hdlr.raw, hdlr.hdr + 8, hdlr.hdr + 12) : '';
      const keys = find(meta, 'keys'), ilst = find(meta, 'ilst');
      if (handler === 'mdta' && keys && ilst) {
        const kraw = keys.raw; const kv = view(kraw); const cnt = kv.getUint32(keys.hdr + 4);
        const name = asciiBytes('com.apple.quicktime.location.ISO6709');
        let exists = false; let p = keys.hdr + 8;
        for (let i = 0; i < cnt && p + 8 <= kraw.length; i++) { const sz = kv.getUint32(p); if (ascii(kraw, p + 8, p + sz) === ascii(name)) exists = true; p += sz; }
        if (exists) { notes.push('video already has a location atom; left as is'); ok = false; }
        else {
          const entry = concat([be32(8 + name.length), asciiBytes('mdta'), name]);
          keys.raw = box('keys', kraw.subarray(keys.hdr, keys.hdr + 4), be32(cnt + 1), kraw.subarray(keys.hdr + 8), entry);
          const data = box('data', be32(1), be32(0), te.encode(str));
          const item = new Uint8Array(8 + data.length); view(item).setUint32(0, item.length); view(item).setUint32(4, cnt + 1); item.set(data, 8);
          ilst.raw = box('ilst', ilst.raw.subarray(ilst.hdr), item);
          meta.dirty = true; markDirty([moov, meta]);
        }
      } else { notes.push('video has a different top-level metadata box; location atom not added'); ok = false; }
    }
    if (ok) {
      const xyz = xyzBox(str);
      let udta = moov.children.find((c) => c.type === 'udta');
      if (!udta) { udta = expandAll(parseBoxes(box('udta'), 0, 8)[0]); udta.children = []; udta.prefix = new Uint8Array(0); moov.children.push(udta); }
      if (!udta.children.some((c) => c.type === '\u00a9xyz')) {
        udta.children.push({ type: '\u00a9xyz', raw: xyz, hdr: 8, children: null, dirty: false });
        markDirty([moov, udta]);
      }
      locationWritten = true;
    }
  }

  const newMoov = rebuild(moov);
  const delta = newMoov.length - oldSize;
  const moovEnd = moovB.start + oldSize;

  // 3) chunk offsets shift if media data lives after moov
  if (delta !== 0 && boxes.some((b) => b.type === 'mdat' && b.start >= moovEnd)) {
    walk(moov, (b) => { if (b.type === 'stco' || b.type === 'co64') shiftOffsets(b, moovEnd, delta); });
    // offset edits do not change sizes, so rebuild again with the shifted values
    return finish(blob, boxes, moovB, rebuild(moov), notes, hevc, locationWritten);
  }
  return finish(blob, boxes, moovB, newMoov, notes, hevc, locationWritten);
}

function rebuild(b) {
  // force a full rebuild from children so shifted stco bytes are included
  if (!b.children) return b.raw;
  const inner = concat([b.prefix, ...b.children.map(rebuild)]);
  return box(b.type, inner);
}

function finish(blob, boxes, moovB, newMoov, notes, hevc, locationWritten) {
  const out = new Blob([blob.slice(0, moovB.start), newMoov, blob.slice(moovB.start + moovB.size)], { type: 'video/mp4' });
  if (hevc) notes.push('HEVC video kept as-is (some Windows/older players need a codec to play it)');
  return { blob: out, notes, changed: true, hevc, locationWritten };
}
