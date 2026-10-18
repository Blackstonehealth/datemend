// Defensive parser for memories_history.json (and a best-effort HTML fallback).
// Every key is optional; we never fabricate values. We read the link fields ONLY to report whether they
// are empty — the tool never requests those URLs.
import { parseExportDate } from '../meta/time.js';
import { DEFAULTS } from '../config.js';

const norm = (k) => String(k).toLowerCase().replace(/[^a-z0-9]/g, '');

function pick(obj, ...names) {
  const want = new Set(names);
  for (const k of Object.keys(obj)) if (want.has(norm(k))) return obj[k];
  return undefined;
}

export function parseLocation(v) {
  if (v == null) return { gps: null, text: null };
  if (typeof v === 'object') {
    const lat = Number(pick(v, 'latitude', 'lat')), lon = Number(pick(v, 'longitude', 'lon', 'lng'));
    return coordResult(lat, lon, null);
  }
  const s = String(v).trim();
  if (!s) return { gps: null, text: null };
  let m = /latitude\s*,\s*longitude\s*:\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)/i.exec(s)
    || /^\s*(-?\d+\.\d+)\s*[, ]\s*(-?\d+\.\d+)\s*$/.exec(s);
  if (m) return coordResult(Number(m[1]), Number(m[2]), null);
  return { gps: null, text: s };
}

function coordResult(lat, lon, text) {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return { gps: null, text };
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return { gps: null, text: text ?? 'out-of-range coordinates ignored' };
  if (lat === 0 && lon === 0) return { gps: null, text: null, zero: true }; // 0,0 means "unknown" in these exports
  return { gps: { lat, lon }, text };
}

function kindOf(v) {
  const s = String(v ?? '').toLowerCase();
  if (/video|movie/.test(s)) return 'video';
  if (/image|photo|picture/.test(s)) return 'image';
  return 'unknown';
}

function entryFrom(obj, index, opts) {
  const dateRaw = pick(obj, 'date', 'capturedate', 'datetime', 'time');
  const ms = parseExportDate(typeof dateRaw === 'string' ? dateRaw : null, opts.minYear);
  const loc = parseLocation(pick(obj, 'location', 'gps'));
  const link = pick(obj, 'downloadlink');
  const dl = pick(obj, 'mediadownloadurl');
  return {
    index, dateRaw: dateRaw ?? null, ms,
    dateIssue: ms == null ? (dateRaw == null || dateRaw === '' ? 'missing' : 'unparseable-or-implausible') : null,
    kind: kindOf(pick(obj, 'mediatype', 'type')),
    gps: loc.gps, locationText: loc.text, locationZero: !!loc.zero,
    hasLink: typeof link === 'string' && link.trim() !== '',
    hasDownloadUrl: typeof dl === 'string' && dl.trim() !== '',
  };
}

export function parseManifestJson(text, { minYear = DEFAULTS.minPlausibleYear } = {}) {
  const warnings = [];
  let data;
  try { data = JSON.parse(text.replace(/^\uFEFF/, '')); }
  catch (e) { throw new Error('memories_history.json is not valid JSON: ' + e.message); }
  let arr = null, key = null;
  if (Array.isArray(data)) arr = data;
  else if (data && typeof data === 'object') {
    key = Object.keys(data).find((k) => norm(k) === 'savedmedia' && Array.isArray(data[k]))
      || Object.keys(data).find((k) => Array.isArray(data[k]) && data[k].some((x) => x && typeof x === 'object' && pick(x, 'date') !== undefined));
    if (key) arr = data[key];
  }
  if (!arr) throw new Error('Could not find a list of memories in memories_history.json (expected a "Saved Media" array).');
  const entries = [];
  arr.forEach((o, i) => { if (o && typeof o === 'object') entries.push(entryFrom(o, i, { minYear })); else warnings.push(`entry ${i} is not an object; skipped`); });
  return { format: 'json', key, entries, warnings };
}

// ---- HTML fallback (best effort; real-world shape unconfirmed) ----
const stripTags = (s) => s.replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, ' ').trim();

export function parseManifestHtml(text, { minYear = DEFAULTS.minPlausibleYear } = {}) {
  const warnings = ['Parsed from HTML (best effort). For the most reliable result, request the export again with "Export JSON Files" ticked.'];
  const entries = [];
  const rows = text.match(/<tr[\s\S]*?<\/tr>/gi) || [];
  for (const r of rows) {
    const cells = (r.match(/<t[dh][\s\S]*?<\/t[dh]>/gi) || []).map(stripTags);
    const dateCell = cells.find((c) => /\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}/.test(c));
    if (!dateCell) continue;
    const dateRaw = /\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:\s*UTC)?/.exec(dateCell)[0];
    const kindCell = cells.find((c) => /^(image|video|photo)$/i.test(c)) || '';
    const locCell = cells.find((c) => /latitude|longitude/i.test(c)) || '';
    const loc = parseLocation(locCell.replace(/^.*?(Latitude)/i, '$1') || null);
    const ms = parseExportDate(dateRaw, minYear);
    entries.push({ index: entries.length, dateRaw, ms, dateIssue: ms == null ? 'unparseable-or-implausible' : null, kind: kindOf(kindCell), gps: loc.gps, locationText: loc.text, locationZero: !!loc.zero, hasLink: /href\s*=\s*["']https?:/i.test(r), hasDownloadUrl: false });
  }
  if (!entries.length) warnings.push('No memory rows found in the HTML file.');
  return { format: 'html', key: null, entries, warnings };
}
