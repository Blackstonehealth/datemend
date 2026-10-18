// Output sinks. All outputs implement: addFile(path, data, meta), close() -> result.
import { ZipWriter } from '../zip/writer.js';
import { DEFAULTS } from '../config.js';

/** Collects zip bytes as Blob pieces (browser: Blobs spill to disk; stored files are NOT copied). */
class BlobSink {
  constructor() { this.parts = []; this.size = 0; }
  async write(chunk) { this.parts.push(chunk); this.size += chunk.length ?? chunk.size; }
  async close() {}
  toBlob() { return new Blob(this.parts, { type: 'application/zip' }); }
}

/**
 * In-memory/Blob zip output with automatic splitting into parts (download-fallback path).
 * close() -> [{ name, blob, size }]
 */
export class BlobZipOutput {
  constructor({ baseName = 'memories-fixed', maxPartBytes = DEFAULTS.maxZipPartBytes, forceZip64 = false } = {}) {
    this.baseName = baseName; this.maxPartBytes = maxPartBytes; this.forceZip64 = forceZip64;
    this.sinks = []; this.cur = null; this.files = 0;
  }
  _open() {
    const sink = new BlobSink();
    this.sinks.push(sink);
    this.cur = { sink, zip: new ZipWriter(sink, { forceZip64: this.forceZip64 }), bytes: 0, count: 0 };
  }
  async addFile(path, data, meta) {
    const size = data.length ?? data.size;
    if (this.cur && this.cur.count > 0 && this.cur.bytes + size > this.maxPartBytes) {
      await this.cur.zip.finish(); this.cur = null;
    }
    if (!this.cur) this._open();
    await this.cur.zip.addFile(path, data, meta);
    this.cur.bytes += size; this.cur.count++; this.files++;
  }
  async close() {
    if (!this.cur) this._open();
    if (this.cur) await this.cur.zip.finish();
    this.cur = null;
    const n = this.sinks.length;
    return this.sinks.map((s, i) => {
      const blob = s.toBlob();
      return { name: n === 1 ? `${this.baseName}.zip` : `${this.baseName}-part${i + 1}-of-${n}.zip`, blob, size: blob.size };
    });
  }
}

/** Streams one zip to a WritableStream-like (File System Access save picker, or a Node file stream wrapper). */
export class StreamZipOutput {
  constructor(writable, { forceZip64 = false } = {}) {
    this.files = 0;
    const sink = {
      write: (c) => writable.write(c),
      close: () => writable.close(),
    };
    this.zip = new ZipWriter(sink, { forceZip64 });
  }
  async addFile(path, data, meta) { await this.zip.addFile(path, data, meta); this.files++; }
  async close() { await this.zip.finish(); return [{ name: '(streamed to chosen file)', size: null }]; }
}
