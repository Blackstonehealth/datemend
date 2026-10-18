// The whole fix, as a framework-free pipeline: analyze -> plan -> run.
// No DOM, no network. Browser pieces (overlay compositing, output sinks) are injected.
import { collectSources, discover, parseZipParts, sniffFormat } from './export/discover.js';
import { parseManifestJson, parseManifestHtml } from './export/manifest.js';
import { matchMemories } from './export/match.js';
import { localParts, fromLocal, describeTz } from './meta/time.js';
import { writeJpegExif, writePngExif } from './meta/exif.js';
import { patchMp4 } from './meta/mp4.js';
import { rowsToCsv, rowsToHtml } from './report.js';
import { DEFAULTS, PRODUCT_NAME, VERSION } from './config.js';
import { pad, baseName } from './util/bytes.js';

const p2 = pad;

// ---------------------------------------------------------------- analyze
/** input: [{ name, path?, blob }]. Returns an analysis object (no output is written). */
export async function analyze(input, { minYear = DEFAULTS.minPlausibleYear } = {}) {
  const { sources, zips, errors } = await collectSources(input);
  const disc = discover(sources);
  const warnings = []; const problems = [];
  for (const e of errors) problems.push(`Could not read ${e.file}: ${e.error}`);

  // zip parts
  const partInfo = parseZipParts(zips.map((z) => z.name));
  for (const g of partInfo.groups) {
    if (g.missing.length) warnings.push(`Export "${g.id}": part(s) ${g.missing.join(', ')} missing (found ${g.parts.join(', ')}). Memories stored in the missing part(s) cannot be fixed until you add them.`);
    if (!g.hasFirst) warnings.push(`Export "${g.id}": part 1 (the one holding memories_history.json) was not selected.`);
  }

  // manifest: prefer JSON from the lowest-numbered container
  const rank = (m) => {
    const c = m.source.container || '';
    const mm = /-(\d{1,3})\.zip$/i.exec(c);
    return (m.kind === 'json' ? 0 : 1000) + (mm ? Number(mm[1]) : 1);
  };
  const manifests = [...disc.manifests].sort((a, b) => rank(a) - rank(b));
  let manifest = null; let manifestSource = null;
  for (const m of manifests) {
    try {
      const text = await (await m.source.blob()).text();
      manifest = m.kind === 'json' ? parseManifestJson(text, { minYear }) : parseManifestHtml(text, { minYear });
      manifestSource = m.source.path;
      if (manifest.entries.length || m.kind === 'json') break;
    } catch (e) { problems.push(`Could not use ${m.source.path}: ${e.message}`); manifest = null; }
  }
  if (!manifests.length) problems.push('No memories_history file found. When requesting your export, tick "Export JSON Files" so the capture dates and locations are included. Without it, only the date in each file name (no time, no location) can be used.');
  if (manifest) { warnings.push(...manifest.warnings); if (manifest.format === 'html') warnings.push('Using the HTML history: tick "Export JSON Files" in your next request for best results.'); }
  if (manifests.filter((m) => m.kind === 'json').length > 1) warnings.push('More than one memories_history.json was found; used the one in the lowest-numbered part.');

  const entries = manifest ? manifest.entries : [];
  const match = matchMemories(entries, disc.media);

  const count = (f) => entries.filter(f).length;
  const summary = {
    parts: partInfo.groups, zipsRead: zips.length,
    manifestSource, manifestFormat: manifest ? manifest.format : null,
    entries: entries.length, entriesUsable: count((e) => e.ms != null), entriesWithoutDate: count((e) => e.ms == null),
    entriesWithCoordinates: count((e) => e.gps), entriesLocationTextOnly: count((e) => !e.gps && e.locationText), entriesNoLocation: count((e) => !e.gps && !e.locationText),
    linksNonEmpty: count((e) => e.hasLink || e.hasDownloadUrl), linksEmpty: count((e) => !e.hasLink && !e.hasDownloadUrl),
    mediaItems: disc.media.length, photos: disc.media.filter((m) => m.kind === 'image' && m.main).length, videos: disc.media.filter((m) => m.kind === 'video').length,
    overlays: disc.media.filter((m) => m.overlay).length, overlayWithoutMain: disc.media.filter((m) => !m.main).length,
    duplicateFilesIgnored: disc.duplicates.length, otherFilesIgnored: disc.ignored.length,
    pairing: ['exact', 'ambiguous', 'window', 'window-ambiguous', 'none'].reduce((o, k) => ({ ...o, [k]: match.pairs.filter((p) => p.pairing === k).length }), {}),
    sourceMissing: match.sourceMissing.length,
    estimatedOutputBytes: disc.media.reduce((n, m) => n + (m.main ? m.main.size : 0) + (m.overlay ? m.overlay.size : 0), 0),
  };
  if (summary.linksNonEmpty) warnings.push(`${summary.linksNonEmpty} entries contain download links. This tool never opens them (they are Snap's servers; it only works on the files you already downloaded).`);
  if (summary.entries && summary.sourceMissing) warnings.push(`${summary.sourceMissing} memories are listed in the history but their media files were not found in the files you selected.`);
  if (summary.pairing.ambiguous || summary.pairing['window-ambiguous']) warnings.push(`${summary.pairing.ambiguous + summary.pairing['window-ambiguous']} files share a day with other memories, so their exact time was assigned in a fixed order and flagged "ambiguous" in the report. Location is only written for them when it is certain.`);

  return { sources, disc, manifest, entries, match, summary, warnings, problems };
}

// ---------------------------------------------------------------- plan
export function buildPlan(analysis, options = {}) {
  const o = { layout: DEFAULTS.layout, overlayMode: DEFAULTS.overlayMode, tz: { mode: 'utc' }, writeFilenameDates: true, ...options };
  const items = analysis.match.pairs.map((pair) => {
    const flags = [];
    let ms, dateFromFilename = false;
    if (pair.entry) ms = pair.entry.ms;
    else { dateFromFilename = true; const [y, m, d] = pair.media.day.split('-').map(Number); ms = fromLocal(y, m, d, 12, 0, 0, o.tz); flags.push('no-manifest-entry', 'date-from-filename'); }
    if (pair.pairing === 'ambiguous' || pair.pairing === 'window-ambiguous') flags.push('ambiguous');
    if (pair.pairing === 'window' || pair.pairing === 'window-ambiguous') flags.push('matched-via-day-window');
    let gps = null;
    if (pair.entry) {
      if (pair.entry.gps && pair.gpsTrusted) gps = pair.entry.gps;
      else if (pair.entry.gps) flags.push('gps-withheld-ambiguous');
      else if (pair.entry.locationText) flags.push('location-text-only');
      else flags.push('no-location');
    }
    const lp = localParts(ms, o.tz);
    return { pair, ms, gps, flags, dateFromFilename, lp, uuid: pair.media.uuid };
  });
  items.sort((a, b) => a.ms - b.ms || (a.uuid < b.uuid ? -1 : a.uuid > b.uuid ? 1 : 0));
  const used = new Map();
  for (const it of items) {
    const base = `${it.lp.y}${p2(it.lp.mo)}${p2(it.lp.d)}_${p2(it.lp.h)}${p2(it.lp.mi)}${p2(it.lp.s)}`;
    const n = (used.get(base) || 0) + 1; used.set(base, n);
    it.base = n === 1 ? base : `${base}_${n}`;
    it.dir = o.layout === 'flat' ? '' : o.layout === 'year' ? `${it.lp.y}` : `${it.lp.y}/${p2(it.lp.mo)}`;
  }
  return { items, options: o };
}

const joinPath = (...p) => p.filter(Boolean).join('/');
const isoZ = (ms) => new Date(ms).toISOString().replace('.000Z', 'Z');
const localIso = (lp) => `${lp.y}-${p2(lp.mo)}-${p2(lp.d)} ${p2(lp.h)}:${p2(lp.mi)}:${p2(lp.s)}`;

// ---------------------------------------------------------------- run
/**
 * run({ analysis, options, output, compositor, onProgress, signal })
 * output: { addFile(path, data, meta), close() }.  Returns { rows, summary, outputs }.
 */
export async function run({ analysis, options = {}, output, compositor = null, onProgress = () => {}, signal = null }) {
  const plan = buildPlan(analysis, options);
  const o = plan.options;
  const rows = []; const counts = { ok: 0, partial: 0, failed: 0, stopped: 0 };
  const tzName = describeTz(o.tz);
  let done = 0; const total = plan.items.length;
  let stopped = false;

  for (const it of plan.items) {
    if (signal && signal.aborted) { stopped = true; }
    const m = it.pair.media; const e = it.pair.entry;
    const row = {
      status: 'ok', flags: [...it.flags], kind: m.kind, output_path: '', original_path: m.main ? m.main.path : '', overlay_original_path: m.overlay ? m.overlay.path : '',
      date_utc: isoZ(it.ms), date_local: localIso(it.lp), time_zone: tzName, gps_lat: it.gps ? it.gps.lat : '', gps_lon: it.gps ? it.gps.lon : '',
      location_text: e && e.locationText ? e.locationText : '', pairing: it.pair.pairing, notes: [],
    };
    if (stopped) { row.status = 'stopped'; row.notes.push('not processed (stopped by user)'); counts.stopped++; rows.push(row); continue; }
    try {
      await processItem(it, row, { o, output, compositor });
    } catch (err) {
      row.status = 'failed'; row.notes.push(String(err && err.message ? err.message : err));
    }
    if (row.status === 'ok' && row.flags.some((f) => /^(overlay-not-merged|overlay-merge-failed|metadata-)/.test(f))) row.status = 'partial';
    counts[row.status] = (counts[row.status] || 0) + 1;
    rows.push(row);
    done++;
    onProgress({ done, total, path: row.original_path, status: row.status });
  }

  for (const e of analysis.match.sourceMissing) rows.push({ status: 'source_missing', flags: ['source-missing'], kind: e.kind, output_path: '', original_path: '', overlay_original_path: '', date_utc: isoZ(e.ms), date_local: localIso(localParts(e.ms, o.tz)), time_zone: tzName, gps_lat: e.gps ? e.gps.lat : '', gps_lon: e.gps ? e.gps.lon : '', location_text: e.locationText || '', pairing: '', notes: ['listed in the history, media file not found in the selected files (missing zip part? item not exported?)'] });
  for (const e of analysis.match.unusableEntries) rows.push({ status: 'source_missing', flags: ['entry-without-usable-date'], kind: e.kind, output_path: '', original_path: '', overlay_original_path: '', date_utc: '', date_local: '', time_zone: tzName, gps_lat: '', gps_lon: '', location_text: e.locationText || '', pairing: '', notes: [`history entry has ${e.dateIssue} date (${JSON.stringify(e.dateRaw)}); could not be matched`] });

  const summary = {
    product: PRODUCT_NAME, version: VERSION, timeZone: tzName, layout: o.layout, overlayMode: o.overlayMode,
    processed: done, total, ok: counts.ok, partial: counts.partial, failed: counts.failed, stopped: counts.stopped,
    sourceMissing: analysis.match.sourceMissing.length, entriesWithoutDate: analysis.match.unusableEntries.length,
    ambiguous: rows.filter((r) => r.flags.includes && r.flags.includes('ambiguous')).length,
    noManifestEntry: rows.filter((r) => r.flags.includes && r.flags.includes('no-manifest-entry')).length,
  };
  const enc = new TextEncoder();
  await output.addFile('report.csv', enc.encode(rowsToCsv(rows)), {});
  await output.addFile('report.html', enc.encode(rowsToHtml(rows, summary, { productName: PRODUCT_NAME, version: VERSION })), {});
  const outputs = await output.close();
  return { rows, summary, outputs, plan };
}

async function processItem(it, row, { o, output, compositor }) {
  const m = it.pair.media;
  const zipMeta = { mtimeMs: it.ms, dos: it.lp };
  const info = { local: it.lp, utc: localParts(it.ms, { mode: 'utc' }), gps: it.gps, resetOrientation: false };
  const stamp = !it.dateFromFilename || o.writeFilenameDates;
  if (!m.main) {
    // overlay without a main file: nothing to fix, keep it
    const blob = await m.overlay.blob();
    const head = new Uint8Array(await blob.slice(0, 16).arrayBuffer());
    const fmt = sniffFormat(head) || 'png';
    const path = joinPath(it.dir, `${it.base}_overlay.${fmt}`);
    await output.addFile(path, blob, zipMeta);
    row.output_path = path; row.flags.push('overlay-without-main'); row.status = 'partial';
    return;
  }
  let mainBlob;
  try { mainBlob = await m.main.blob(); }
  catch (err) { throw new Error('could not read this file from the export (corrupt or truncated?): ' + (err.message || err)); }
  if (mainBlob.size === 0) throw new Error('file is empty (0 bytes) in the export');
  const head = new Uint8Array(await mainBlob.slice(0, 16).arrayBuffer());
  const fmt = sniffFormat(head);
  const extOrig = (/\.([A-Za-z0-9]+)$/.exec(m.main.name) || [])[1] || 'bin';

  if (!fmt) {
    const path = joinPath('_needs_attention', baseName(m.main.innerPath));
    await output.addFile(path, mainBlob, zipMeta);
    row.output_path = path; row.flags.push('unrecognised-format'); row.status = 'partial'; row.notes.push('file is not a recognisable photo/video; copied unchanged');
    return;
  }

  // ---- video ----
  if (fmt === 'mp4' || fmt === 'mov') {
    const path = joinPath(it.dir, `${it.base}.${fmt}`);
    let out = mainBlob;
    try {
      const r = await patchMp4(mainBlob, { creationMs: stamp ? it.ms : null, location: it.gps });
      out = r.blob; row.notes.push(...r.notes);
      if (r.hevc) row.flags.push('hevc');
      if (!r.changed) row.flags.push('metadata-not-patched');
      if (it.gps && !r.locationWritten) row.flags.push('metadata-location-not-written');
    } catch (err) { row.flags.push('metadata-patch-failed'); row.notes.push('video metadata not written: ' + err.message); }
    await output.addFile(path, out, zipMeta);
    row.output_path = path;
    if (m.overlay) await writeOverlaySidecar(it, row, m, output, zipMeta, 'video overlay kept as a separate file (burn-in not in v1)');
    return;
  }

  // ---- photo ----
  let bytesBlob = mainBlob; let outFmt = fmt; let merged = false;
  const wantMerge = m.overlay && o.overlayMode !== 'sidecar';
  if (wantMerge) {
    if (!compositor) { row.flags.push('overlay-not-merged'); row.notes.push('overlay merging needs a browser canvas; overlay kept as a separate file'); }
    else {
      try {
        const ob = await m.overlay.blob();
        if (ob.size === 0) throw new Error('overlay file is empty');
        bytesBlob = await compositor.composite(mainBlob, ob, { quality: o.jpegQuality ?? DEFAULTS.jpegQuality });
        outFmt = 'jpg'; merged = true; info.resetOrientation = true; row.flags.push('overlay-merged');
      } catch (err) { row.flags.push('overlay-merge-failed'); row.notes.push('overlay not merged: ' + err.message); }
    }
  }
  let finalBlob = bytesBlob;
  if (stamp && (outFmt === 'jpg' || outFmt === 'png')) {
    try {
      const u8 = new Uint8Array(await bytesBlob.arrayBuffer());
      const r = outFmt === 'jpg' ? writeJpegExif(u8, info) : writePngExif(u8, info);
      finalBlob = new Blob(r.parts, { type: outFmt === 'jpg' ? 'image/jpeg' : 'image/png' });
      row.notes.push(...r.warnings);
    } catch (err) { row.flags.push('metadata-write-failed'); row.notes.push('EXIF not written: ' + err.message); finalBlob = bytesBlob; }
  } else if (stamp) { row.flags.push(`metadata-unsupported-${outFmt}`); row.notes.push(`${outFmt.toUpperCase()} files cannot carry EXIF in v1; date kept in file name/folder`); }
  const path = joinPath(it.dir, `${it.base}.${outFmt === 'jpg' ? 'jpg' : outFmt}`);
  await output.addFile(path, finalBlob, zipMeta);
  row.output_path = path;
  if (m.overlay && (!merged || o.overlayMode === 'both')) await writeOverlaySidecar(it, row, m, output, zipMeta, null);
}

async function writeOverlaySidecar(it, row, m, output, zipMeta, note) {
  const ob = await m.overlay.blob();
  const head = new Uint8Array(await ob.slice(0, 16).arrayBuffer());
  const fmt = sniffFormat(head) || 'png'; // name by real content, not by extension
  const path = joinPath(it.dir, `${it.base}_overlay.${fmt}`);
  await output.addFile(path, ob, zipMeta);
  row.flags.push('overlay-sidecar');
  if (note) row.notes.push(note);
  row.notes.push('overlay file: ' + path);
}
