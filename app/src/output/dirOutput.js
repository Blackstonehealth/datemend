// Writes files into a directory via the File System Access API (Chromium desktop: showDirectoryPicker;
// also works with an OPFS directory handle, which the automated browser test uses).
// Limitation: this API cannot set a file's modified time. The date is embedded in EXIF / MP4 metadata and
// the file name; use the zip output if you want modified times restored on extraction.
export class DirOutput {
  constructor(rootHandle) { this.root = rootHandle; this.cache = new Map(); this.files = 0; }
  async _dir(parts) {
    let h = this.root, key = '';
    for (const p of parts) {
      key += '/' + p;
      let next = this.cache.get(key);
      if (!next) { next = await h.getDirectoryHandle(p, { create: true }); this.cache.set(key, next); }
      h = next;
    }
    return h;
  }
  async addFile(path, data) {
    const parts = path.split('/').filter(Boolean);
    const name = parts.pop();
    const dir = await this._dir(parts);
    const fh = await dir.getFileHandle(name, { create: true });
    const w = await fh.createWritable();
    try {
      if (data instanceof Uint8Array) { await w.write(data); await w.close(); }
      else { await data.stream().pipeTo(w); }
    } catch (e) { try { await w.abort(); } catch {} throw e; }
    this.files++;
  }
  async close() { return [{ name: '(folder)', size: null }]; }
}
