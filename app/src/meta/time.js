// Time helpers. Snapchat manifest dates are UTC. Output zone is the user's choice:
//   { mode: 'utc' } | { mode: 'fixed', offsetMinutes } | { mode: 'iana', zone: 'America/Phoenix' }
import { pad } from '../util/bytes.js';

export function parseExportDate(raw, minYear = 2010) {
  if (typeof raw !== 'string') return null;
  const m = /^\s*(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:\.\d+)?\s*(UTC|GMT|Z|[+-]\d{2}:?\d{2})?\s*$/i.exec(raw);
  if (!m) return null;
  const [y, mo, d, h, mi, s] = m.slice(1, 7).map(Number);
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59 || s > 60) return null;
  let ms = Date.UTC(y, mo - 1, d, h, mi, s);
  const dt = new Date(ms);
  if (dt.getUTCMonth() !== mo - 1) return null; // e.g. Feb 30
  const z = m[7];
  if (z && /^[+-]/.test(z)) {
    const sign = z[0] === '-' ? -1 : 1; const digits = z.slice(1).replace(':', '');
    ms -= sign * (Number(digits.slice(0, 2)) * 60 + Number(digits.slice(2, 4))) * 60000;
  }
  if (y < minYear) return null;
  return ms;
}

const fmtCache = new Map();
function ianaParts(ms, zone) {
  let f = fmtCache.get(zone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', { timeZone: zone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
    fmtCache.set(zone, f);
  }
  const o = {};
  for (const p of f.formatToParts(new Date(ms))) o[p.type] = p.value;
  const y = Number(o.year), mo = Number(o.month), d = Number(o.day), h = Number(o.hour) % 24, mi = Number(o.minute), s = Number(o.second);
  const asUtc = Date.UTC(y, mo - 1, d, h, mi, s);
  return { y, mo, d, h, mi, s, offsetMinutes: Math.round((asUtc - Math.floor(ms / 1000) * 1000) / 60000) };
}

export function localParts(ms, tz = { mode: 'utc' }) {
  if (tz.mode === 'iana') return ianaParts(ms, tz.zone);
  const off = tz.mode === 'fixed' ? tz.offsetMinutes : 0;
  const d = new Date(ms + off * 60000);
  return { y: d.getUTCFullYear(), mo: d.getUTCMonth() + 1, d: d.getUTCDate(), h: d.getUTCHours(), mi: d.getUTCMinutes(), s: d.getUTCSeconds(), offsetMinutes: off };
}

/** Epoch ms for a wall-clock time in the given zone (used for filename-only fallback dates). */
export function fromLocal(y, mo, d, h, mi, s, tz = { mode: 'utc' }) {
  let guess = Date.UTC(y, mo - 1, d, h, mi, s);
  for (let i = 0; i < 3; i++) {
    const p = localParts(guess, tz);
    guess = Date.UTC(y, mo - 1, d, h, mi, s) - p.offsetMinutes * 60000;
  }
  return guess;
}

export function offsetString(minutes) {
  const sign = minutes < 0 ? '-' : '+'; const a = Math.abs(minutes);
  return `${sign}${pad(Math.floor(a / 60))}:${pad(a % 60)}`;
}

export function describeTz(tz) {
  if (tz.mode === 'iana') return tz.zone;
  if (tz.mode === 'fixed') return 'UTC' + offsetString(tz.offsetMinutes);
  return 'UTC';
}
