// Turns user-selected files (zips and/or an unzipped folder) into a flat list of "sources", finds the
// manifest and the media files, and works out which `mydata~<id>[-n].zip` parts are present/missing.
import { openZip, entryBlob } from '../zip/reader.js';
import { baseName, extOf } from '../util/bytes.js';

const IMAGE_EXT = new Set(['jpg', 'jpeg', 'png', 'webp', 'heic', 'heif', 'gif']);
const VIDEO_EXT = new Set(['mp4', 'mov', 'm4v']);
const MEDIA_RE = /^(\d{4}-\d{2}-\d{2})_([A-Za-z0-9][A-Za-z0-9-]*?)(?:-(main|overlay))?\.([A-Za-z0-9]+)$/;

export const kindFromExt = (ext) => (VIDEO_EXT.has(ext) ? 'video' : IMAGE_EXT.has(ext) ? 'image' : 'unknown');

/** Sniff the real format from magic bytes (extensions lie: 9 of 162 ".png" overlays were WebP in one export). */
export function sniffFormat(u8) {
  if (u8.length >= 3 && u8[0] === 0xff && u8[1] === 0xd8 && u8[2] === 0xff) return 'jpg';
  if (u8.length >= 8 && u8[0] === 0x89 && u8[1] === 0x50 && u8[2] === 0x4e && u8[3] === 0x47) return 'png';
  if (u8.length >= 12 && u8[0] === 0x52 && u8[1] === 0x49 && u8[2] === 0x46 && u8[3] === 0x46 && u8[8] === 0x57 && u8[9] === 0x45 && u8[10] === 0x42 && u8[11] === 0x50) return 'webp';
  if (u8.length >= 12 && String.fromCharCode(u8[4], u8[5], u8[6], u8[7]) === 'ftyp') {
    const brand = String.fromCharCode(u8[8], u8[9], u8[10], u8[11]);
    if (/^(heic|heix|hevc|hevx|mif1|msf1)/.test(brand)) return 'heic';
    if (brand === 'qt  ') return 'mov';
    return 'mp4';
  }
  if (u8.length >= 6 && String.fromCharCode(...u8.subarray(0, 4)) === 'GIF8') return 'gif';
  return null;
}

/** Group zip names like mydata~ID.zip, mydata~ID-2.zip ... into {id, part}. */
export function parseZipParts(names) {
  const stems = names.map((n) => ({ name: n, stem: baseName(n).replace(/\.zip$/i, '') }));
  const looksLikeExport = (s) => /^mydata[~_ -]/i.test(s);
  const groups = new Map();
  // Parts are "<id>.zip" (part 1) and "<id>-<n>.zip". A trailing "-<1..3 digits>" is read as a part number.
  for (const s of stems.filter((x) => looksLikeExport(x.stem))) {
    const m = /^(.*?)-(\d{1,3})$/.exec(s.stem);
    const id = m ? m[1] : s.stem; const part = m ? Number(m[2]) : 1;
    if (!groups.has(id)) groups.set(id, []);
    groups.get(id).push({ ...s, part });
  }
  const result = [];
  for (const [id, parts] of groups) {
    const nums = parts.map((p) => p.part).sort((a, b) => a - b);
    const max = nums[nums.length - 1];
    const missing = []; for (let i = 1; i <= max; i++) if (!nums.includes(i)) missing.push(i);
    result.push({ id, parts: nums, names: parts.map((p) => p.name), missing, hasFirst: nums.includes(1) });
  }
  const other = stems.filter((s) => !looksLikeExport(s.stem)).map((s) => s.name);
  return { groups: result, other };
}

/**
 * input: array of { name, path?, blob, mtime? } where blob is a File/Blob. `path` is the relative path for
 * files picked from an unzipped folder.
 * Returns { sources, zips, errors }
 */
export async function collectSources(input) {
  const sources = []; const zips = []; const errors = [];
  for (const f of input) {
    const rel = (f.path || f.name || '').replace(/\\/g, '/');
    const isZip = extOf(rel) === 'zip';
    if (isZip) {
      try {
        const zip = await openZip(f.blob);
        zips.push({ name: baseName(rel), entries: zip.entries.filter((e) => !e.isDir).length });
        for (const e of zip.entries) {
          if (e.isDir) continue;
          sources.push({
            path: `${baseName(rel)}!/${e.name}`, innerPath: e.name, name: baseName(e.name), size: e.usize,
            mtime: e.mtime, container: baseName(rel), blob: () => entryBlob(zip, e),
          });
        }
      } catch (err) { errors.push({ file: rel, error: String(err.message || err) }); }
    } else {
      sources.push({ path: rel, innerPath: rel, name: baseName(rel), size: f.blob.size, mtime: f.mtime ?? f.blob.lastModified ?? null, container: null, blob: async () => f.blob });
    }
  }
  return { sources, zips, errors };
}

const isMemoriesDir = (seg) => /^memories( \(\d+\))?$/i.test(seg);

/** Classify sources into manifest candidates and media groups. */
export function discover(sources) {
  const manifests = []; const groups = new Map(); const ignored = []; const duplicates = [];
  for (const s of sources) {
    const lower = s.innerPath.toLowerCase();
    const segs = s.innerPath.split('/');
    if (/(^|\/)chat_media\//i.test(lower)) { ignored.push({ path: s.path, reason: 'chat media (out of scope)' }); continue; }
    if (s.name.toLowerCase() === 'memories_history.json') { manifests.push({ kind: 'json', source: s }); continue; }
    if (s.name.toLowerCase() === 'memories_history.html') { manifests.push({ kind: 'html', source: s }); continue; }
    const m = MEDIA_RE.exec(s.name);
    if (m && (segs.slice(0, -1).some(isMemoriesDir) || segs.length === 1)) {
      const [, day, uuid, roleRaw, ext] = m;
      const role = roleRaw || 'main';
      const kindExt = kindFromExt(ext.toLowerCase());
      if (kindExt === 'unknown') { ignored.push({ path: s.path, reason: 'unrecognised file type' }); continue; }
      const key = `${day}_${uuid}`;
      let g = groups.get(key);
      if (!g) { g = { key, day, uuid, kind: null, main: null, overlay: null }; groups.set(key, g); }
      if (g[role]) { duplicates.push({ path: s.path, keptPath: g[role].path, sameSize: g[role].size === s.size }); continue; }
      g[role] = s;
      if (role === 'main') g.kind = kindExt;
      continue;
    }
    ignored.push({ path: s.path, reason: 'not a memory file' });
  }
  const media = [...groups.values()];
  for (const g of media) {
    if (!g.kind) g.kind = g.overlay ? 'image' : 'unknown'; // overlay without a main file
  }
  media.sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : a.uuid < b.uuid ? -1 : a.uuid > b.uuid ? 1 : 0));
  return { manifests, media, ignored, duplicates };
}
