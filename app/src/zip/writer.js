// Streaming ZIP writer. Entries are STORED (no recompression: photos/videos are already compressed).
// Handles ZIP64 (entries/sizes/offsets beyond 4 GB / 65535 entries), UTF-8 names, and writes both
// the DOS time (capture time in the chosen zone) and the Info-ZIP extended timestamp (UTC) so that
// extractors restore file modified times to the capture time.
import { crc32, te, view, toU8 } from '../util/bytes.js';

const U32 = 0xffffffff;

function dosParts(p) {
  let y = p.y;
  let clamp = false;
  if (y < 1980) { y = 1980; clamp = true; }
  if (y > 2107) { y = 2107; clamp = true; }
  const date = ((y - 1980) << 9) | (p.mo << 5) | p.d;
  const time = (p.h << 11) | (p.mi << 5) | (p.s >> 1);
  return { date: clamp ? ((y - 1980) << 9) | (1 << 5) | 1 : date, time: clamp ? 0 : time };
}

export class ZipWriter {
  /** sink: { write(Uint8Array|Blob), close() }. A sink may take Blobs directly (no read-through). */
  constructor(sink, { forceZip64 = false } = {}) {
    this.sink = sink;
    this.forceZip64 = forceZip64;
    this.offset = 0;
    this.central = [];
    this.names = new Set();
    this.closed = false;
  }

  async _w(chunk) {
    await this.sink.write(chunk);
    this.offset += chunk.length ?? chunk.size;
  }

  async _crc(data) {
    if (data instanceof Uint8Array) return crc32(data);
    let c = 0;
    const r = data.stream().getReader();
    for (;;) { const { done, value } = await r.read(); if (done) break; c = crc32(value, c); }
    return c;
  }

  /** meta: { mtimeMs (UTC epoch ms), dos: {y,mo,d,h,mi,s} local capture time } */
  async addFile(name, data, meta = {}) {
    if (this.closed) throw new Error('zip already finished');
    if (this.names.has(name)) throw new Error('duplicate zip entry name: ' + name);
    this.names.add(name);
    const nameBytes = te.encode(name);
    const size = data instanceof Uint8Array ? data.length : data.size;
    const crc = await this._crc(data);
    const mtimeMs = meta.mtimeMs ?? Date.now();
    const d = new Date(mtimeMs);
    const dp = dosParts(meta.dos ?? { y: d.getUTCFullYear(), mo: d.getUTCMonth() + 1, d: d.getUTCDate(), h: d.getUTCHours(), mi: d.getUTCMinutes(), s: d.getUTCSeconds() });
    const unix = Math.max(0, Math.min(U32, Math.floor(mtimeMs / 1000)));
    const big = this.forceZip64 || size >= U32;
    const bigOff = this.forceZip64 || this.offset >= U32;
    const ext55 = new Uint8Array(9); const ev = view(ext55);
    ev.setUint16(0, 0x5455, true); ev.setUint16(2, 5, true); ext55[4] = 1; ev.setUint32(5, unix, true);

    let localExtra = ext55;
    if (big) {
      const z = new Uint8Array(20); const zv = view(z);
      zv.setUint16(0, 0x0001, true); zv.setUint16(2, 16, true);
      zv.setBigUint64(4, BigInt(size), true); zv.setBigUint64(12, BigInt(size), true);
      localExtra = concat2(z, ext55);
    }
    const lh = new Uint8Array(30 + nameBytes.length + localExtra.length); const lv = view(lh);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, big ? 45 : 20, true);
    lv.setUint16(6, 0x0800, true);
    lv.setUint16(8, 0, true);
    lv.setUint16(10, dp.time, true); lv.setUint16(12, dp.date, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, big ? U32 : size, true); lv.setUint32(22, big ? U32 : size, true);
    lv.setUint16(26, nameBytes.length, true); lv.setUint16(28, localExtra.length, true);
    lh.set(nameBytes, 30); lh.set(localExtra, 30 + nameBytes.length);
    const headerOffset = this.offset;
    await this._w(lh);
    await this._w(data);
    this.central.push({ nameBytes, crc, size, big, bigOff, headerOffset, dp, unix });
  }

  async finish() {
    if (this.closed) return;
    this.closed = true;
    const cdStart = this.offset;
    const parts = [];
    for (const e of this.central) {
      const zf = [];
      if (e.big) { const b = new Uint8Array(8); view(b).setBigUint64(0, BigInt(e.size), true); zf.push(b, b); }
      if (e.bigOff) { const b = new Uint8Array(8); view(b).setBigUint64(0, BigInt(e.headerOffset), true); zf.push(b); }
      let zextra = new Uint8Array(0);
      if (zf.length) {
        zextra = new Uint8Array(4 + zf.length * 8); const zv = view(zextra);
        zv.setUint16(0, 1, true); zv.setUint16(2, zf.length * 8, true);
        zf.forEach((b, i) => zextra.set(b, 4 + i * 8));
      }
      const ext55 = new Uint8Array(9); const ev = view(ext55);
      ev.setUint16(0, 0x5455, true); ev.setUint16(2, 5, true); ext55[4] = 1; ev.setUint32(5, e.unix, true);
      const extra = concat2(zextra, ext55);
      const h = new Uint8Array(46 + e.nameBytes.length + extra.length); const hv = view(h);
      hv.setUint32(0, 0x02014b50, true);
      hv.setUint16(4, 45, true); hv.setUint16(6, (e.big || e.bigOff) ? 45 : 20, true);
      hv.setUint16(8, 0x0800, true); hv.setUint16(10, 0, true);
      hv.setUint16(12, e.dp.time, true); hv.setUint16(14, e.dp.date, true);
      hv.setUint32(16, e.crc, true);
      hv.setUint32(20, e.big ? U32 : e.size, true); hv.setUint32(24, e.big ? U32 : e.size, true);
      hv.setUint16(28, e.nameBytes.length, true); hv.setUint16(30, extra.length, true);
      hv.setUint32(42, e.bigOff ? U32 : e.headerOffset, true);
      h.set(e.nameBytes, 46); h.set(extra, 46 + e.nameBytes.length);
      parts.push(h);
    }
    let cdLen = 0; for (const p of parts) cdLen += p.length;
    const n = this.central.length;
    const need64 = this.forceZip64 || n >= 0xffff || cdStart >= U32 || cdLen >= U32;
    let tailBytes = [];
    if (need64) {
      const r = new Uint8Array(56 + 20); const rv = view(r);
      rv.setUint32(0, 0x06064b50, true); rv.setBigUint64(4, 44n, true);
      rv.setUint16(12, 45, true); rv.setUint16(14, 45, true);
      rv.setBigUint64(24, BigInt(n), true); rv.setBigUint64(32, BigInt(n), true);
      rv.setBigUint64(40, BigInt(cdLen), true); rv.setBigUint64(48, BigInt(cdStart), true);
      rv.setUint32(56, 0x07064b50, true); rv.setBigUint64(64, BigInt(cdStart + cdLen), true); rv.setUint32(72, 1, true);
      tailBytes.push(r);
    }
    const eo = new Uint8Array(22); const ov = view(eo);
    ov.setUint32(0, 0x06054b50, true);
    ov.setUint16(8, need64 ? 0xffff : n, true); ov.setUint16(10, need64 ? 0xffff : n, true);
    ov.setUint32(12, need64 ? U32 : cdLen, true); ov.setUint32(16, need64 ? U32 : cdStart, true);
    tailBytes.push(eo);
    for (const p of parts) await this._w(p);
    for (const t of tailBytes) await this._w(t);
    await this.sink.close();
  }
}

function concat2(a, b) { const o = new Uint8Array(a.length + b.length); o.set(a, 0); o.set(b, a.length); return o; }

export { toU8 };
