// Datemend UI. Plain DOM, textContent only (file names are untrusted). No network, no storage.
import { analyze, run } from '../pipeline.js';
import { BlobZipOutput, StreamZipOutput } from '../output/zipOutput.js';
import { DirOutput } from '../output/dirOutput.js';
import { browserCompositor, browserCompositorAvailable } from '../compositor.js';
import { rowsToCsv } from '../report.js';
import { PRODUCT_NAME, VERSION } from '../config.js';

const $ = (id) => document.getElementById(id);
const el = (tag, props = {}, ...kids) => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) { if (k === 'class') e.className = v; else e.setAttribute(k, v); }
  for (const k of kids.flat()) e.append(k instanceof Node ? k : document.createTextNode(String(k)));
  return e;
};
const fmtBytes = (n) => (n >= 1073741824 ? (n / 1073741824).toFixed(2) + ' GB' : n >= 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(n / 1024)) + ' KB');

const caps = {
  folderWrite: typeof window.showDirectoryPicker === 'function',
  savePicker: typeof window.showSaveFilePicker === 'function',
  decompress: typeof DecompressionStream !== 'undefined',
  canvas: browserCompositorAvailable(),
};

let picked = []; // [{ name, path, blob }]
let analysis = null;
let abort = null;
let busy = false;

function setPicked(list, replace = false) {
  picked = replace ? list : picked.concat(list);
  const zips = picked.filter((f) => /\.zip$/i.test(f.name)).length;
  $('picked').textContent = picked.length ? `${picked.length} file(s) selected (${zips} zip, ${picked.length - zips} other).` : '';
  runAnalysis();
}

async function runAnalysis() {
  $('step-result').hidden = true;
  if (!picked.length) { analysis = null; $('step-diag').hidden = true; $('step-options').hidden = true; return; }
  $('step-diag').hidden = false;
  $('diag').textContent = 'Reading the export (nothing is uploaded)…';
  try { analysis = await analyze(picked); }
  catch (e) { $('diag').textContent = 'Could not read these files: ' + (e && e.message ? e.message : e); $('step-options').hidden = true; return; }
  renderDiag(analysis);
  $('step-options').hidden = analysis.summary.mediaItems === 0;
}

function renderDiag(a) {
  const s = a.summary; const root = $('diag'); root.textContent = '';
  const rows = [
    ['Zip files read', s.zipsRead],
    ['Photos / videos found', `${s.photos} photos, ${s.videos} videos (${s.overlays} with a caption/sticker overlay)`],
    ['History file', s.manifestSource ? `${s.manifestSource} (${s.manifestFormat}); ${s.entries} entries` : 'none found'],
    ['Entries with coordinates', s.entriesWithCoordinates + (s.entriesLocationTextOnly ? ` (+${s.entriesLocationTextOnly} with a place name only, which cannot be written as GPS)` : '')],
    ['Matched with certainty', s.pairing.exact + s.pairing.window],
    ['Matched but ambiguous (same day as others)', s.pairing.ambiguous + s.pairing['window-ambiguous']],
    ['Files without a history entry', s.pairing.none],
    ['History entries without a file', s.sourceMissing],
    ['Download-link fields', `${s.linksEmpty} empty, ${s.linksNonEmpty} filled (never opened by this tool)`],
    ['Estimated output size', fmtBytes(s.estimatedOutputBytes)],
  ];
  const t = el('table'); for (const [k, v] of rows) t.append(el('tr', {}, el('th', {}, k), el('td', {}, v)));
  root.append(t);
  for (const g of s.parts) if (g.names.length > 1 || g.missing.length) root.append(el('p', {}, `Export "${g.id}": parts found ${g.parts.join(', ')}${g.missing.length ? '; MISSING ' + g.missing.join(', ') : ''}.`));
  if (a.problems.length) root.append(el('ul', { class: 'bad' }, a.problems.map((p) => el('li', {}, p))));
  if (a.warnings.length) root.append(el('ul', { class: 'w' }, a.warnings.map((p) => el('li', {}, p))));
  if (!s.mediaItems) root.append(el('p', { class: 'bad' }, 'No memory photos or videos were found. Select the zip parts that contain the "memories" folder (or the unzipped folder).'));
}

function currentTz() {
  const v = $('opt-tz').value;
  if (v === 'utc') return { mode: 'utc' };
  if (v === 'custom') {
    const zone = $('opt-tz-custom').value.trim();
    try { new Intl.DateTimeFormat('en-US', { timeZone: zone }); } catch { throw new Error('Unknown time zone name: ' + zone); }
    return { mode: 'iana', zone };
  }
  return { mode: 'iana', zone: v };
}

async function start() {
  if (busy || !analysis) return;
  let tz; try { tz = currentTz(); } catch (e) { $('status').textContent = e.message; return; }
  const mode = $('opt-output').value;
  let output;
  try {
    if (mode === 'folder') output = new DirOutput(await window.showDirectoryPicker({ mode: 'readwrite' }));
    else if (mode === 'zip-save') {
      const fh = await window.showSaveFilePicker({ suggestedName: 'memories-fixed.zip', types: [{ description: 'Zip file', accept: { 'application/zip': ['.zip'] } }] });
      output = new StreamZipOutput(await fh.createWritable());
    } else output = new BlobZipOutput();
  } catch (e) { $('status').textContent = e && e.name === 'AbortError' ? 'Cancelled.' : 'Could not open the destination: ' + e.message; return; }

  busy = true; abort = new AbortController();
  $('start').disabled = true; $('stop').hidden = false; $('progress').hidden = false; $('progress').value = 0; $('step-result').hidden = true;
  const warnLeave = (e) => { e.preventDefault(); e.returnValue = ''; };
  window.addEventListener('beforeunload', warnLeave);
  try {
    const res = await run({
      analysis, output, signal: abort.signal, compositor: caps.canvas ? browserCompositor : null,
      options: { tz, layout: $('opt-layout').value, overlayMode: $('opt-overlay').value },
      onProgress: ({ done, total }) => { $('progress').value = total ? done / total : 1; $('status').textContent = `Processed ${done} of ${total}…`; },
    });
    showResult(res, mode);
    $('status').textContent = abort.signal.aborted ? 'Stopped. Files processed so far were saved.' : 'Done.';
  } catch (e) { $('status').textContent = 'Stopped by an error: ' + (e && e.message ? e.message : e); }
  finally { window.removeEventListener('beforeunload', warnLeave); busy = false; $('start').disabled = false; $('stop').hidden = true; }
}

function showResult(res, mode) {
  const root = $('result'); root.textContent = '';
  $('step-result').hidden = false;
  const s = res.summary;
  const t = el('table');
  for (const [k, v] of [['Fixed completely', s.ok], ['Fixed with caveats (see report)', s.partial], ['Failed', s.failed], ['Not found in the files you selected', s.sourceMissing + s.entriesWithoutDate], ['Flagged ambiguous', s.ambiguous], ['Not processed (stopped)', s.stopped]]) t.append(el('tr', {}, el('th', {}, k), el('td', {}, v)));
  root.append(t);
  if (mode === 'zip-download') {
    root.append(el('p', {}, 'Download your fixed memories (the zip also contains report.csv and report.html):'));
    for (const part of res.outputs) {
      const url = URL.createObjectURL(part.blob);
      root.append(el('p', {}, el('a', { class: 'btn primary', href: url, download: part.name, 'data-part': part.name }, `Download ${part.name} (${fmtBytes(part.size)})`)));
    }
    if (res.outputs.length > 1) root.append(el('p', { class: 'muted small' }, 'Your library was split into several zip files to keep each download manageable. Extract them all into the same folder.'));
    root.append(el('p', { class: 'muted small' }, 'Extracting the zip restores each file\'s modified time to its capture time. Dates are also stored inside each photo/video.'));
  } else if (mode === 'zip-save') root.append(el('p', {}, 'Saved to the zip file you chose. It contains report.csv and report.html too.'));
  else root.append(el('p', {}, 'Written into the folder you chose, including report.csv and report.html. (Browsers cannot set file modified times when writing folders; the capture date is stored inside each file and in its name.)'));
  const csv = URL.createObjectURL(new Blob([rowsToCsv(res.rows)], { type: 'text/csv' }));
  root.append(el('p', {}, el('a', { href: csv, download: 'report.csv' }, 'Download report.csv')));
  const bad = res.rows.filter((r) => r.status === 'failed' || r.status === 'source_missing').slice(0, 25);
  if (bad.length) {
    root.append(el('h3', {}, 'Items that need attention (first 25; see report.csv for all)'));
    root.append(el('ul', {}, bad.map((r) => el('li', {}, `${r.original_path || r.date_utc}: ${r.notes.join('; ')}`))));
  }
}

function initOptions() {
  const tz = $('opt-tz'); const local = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  tz.append(el('option', { value: local }, `This computer's time zone (${local})`), el('option', { value: 'utc' }, 'UTC (as Snapchat stores it)'), el('option', { value: 'custom' }, 'Other…'));
  tz.addEventListener('change', () => { $('tz-custom-wrap').hidden = tz.value !== 'custom'; });
  const out = $('opt-output');
  if (caps.savePicker) out.append(el('option', { value: 'zip-save' }, 'One zip file (streams to disk, best for big libraries)'));
  if (caps.folderWrite) out.append(el('option', { value: 'folder' }, 'A folder on this computer'));
  out.append(el('option', { value: 'zip-download' }, 'Zip download (may be split into parts)'));
  const c = $('caps'); const yes = (b) => (b ? 'yes' : 'no');
  c.textContent = `${PRODUCT_NAME} ${VERSION}. Browser support: zip reading ${yes(caps.decompress)}, caption merging ${yes(caps.canvas)}, save to folder ${yes(caps.folderWrite)} (Chrome/Edge/Opera on desktop), streaming zip save ${yes(caps.savePicker)}.` + (caps.decompress ? '' : ' Compressed zips need a newer browser.');
}

async function readDropped(dt) {
  const out = [];
  const entries = [...dt.items].map((i) => (i.webkitGetAsEntry ? i.webkitGetAsEntry() : null)).filter(Boolean);
  const file = (en) => new Promise((res, rej) => en.file(res, rej));
  const walk = async (en) => {
    if (en.isFile) { const f = await file(en); out.push({ name: f.name, path: en.fullPath.replace(/^\//, ''), blob: f }); }
    else if (en.isDirectory) {
      const r = en.createReader();
      for (;;) { const batch = await new Promise((res, rej) => r.readEntries(res, rej)); if (!batch.length) break; for (const c of batch) await walk(c); }
    }
  };
  for (const en of entries) await walk(en);
  if (!entries.length) for (const f of dt.files) out.push({ name: f.name, path: f.name, blob: f });
  return out;
}

function wire() {
  initOptions();
  $('zip-input').addEventListener('change', (e) => { setPicked([...e.target.files].map((f) => ({ name: f.name, path: f.name, blob: f }))); e.target.value = ''; });
  $('folder-input').addEventListener('change', (e) => { setPicked([...e.target.files].map((f) => ({ name: f.name, path: f.webkitRelativePath || f.name, blob: f }))); e.target.value = ''; });
  $('clear').addEventListener('click', () => { if (!busy) { setPicked([], true); $('status').textContent = ''; } });
  const drop = $('drop');
  for (const ev of ['dragenter', 'dragover']) drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('over'); });
  for (const ev of ['dragleave', 'drop']) drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove('over'); });
  drop.addEventListener('drop', async (e) => { setPicked(await readDropped(e.dataTransfer)); });
  document.addEventListener('dragover', (e) => e.preventDefault()); document.addEventListener('drop', (e) => e.preventDefault());
  $('start').addEventListener('click', start);
  $('stop').addEventListener('click', () => { if (abort) abort.abort(); $('status').textContent = 'Stopping after the current file…'; });
}
wire();
