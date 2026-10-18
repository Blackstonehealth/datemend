// Pairs manifest entries with media files. The export gives no id, so the join is by (UTC day, kind)
// with a +-1 day window for the UTC-vs-local-day mismatch. Ambiguity is tracked, never hidden:
//   exact              1 entry, 1 media in the bucket
//   ambiguous          several in the bucket; assigned in a deterministic order (GPS withheld unless all candidates agree)
//   window             matched only through the +-1 day window, unambiguous
//   window-ambiguous   matched through the window with competing candidates
//   none               media without any usable manifest entry
const DAY_MS = 86400000;
const dayNum = (s) => Math.floor(Date.UTC(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10)) / DAY_MS);
const utcDay = (ms) => Math.floor(ms / DAY_MS);
const kindOk = (ek, mk) => ek === 'unknown' || mk === 'unknown' || ek === mk;

export function sameGps(a, b) { return !!a && !!b && Math.abs(a.lat - b.lat) < 1e-5 && Math.abs(a.lon - b.lon) < 1e-5; }
const allAgree = (list) => list.every((e) => (e.gps == null && list[0].gps == null) || sameGps(e.gps, list[0].gps));

export function matchMemories(entries, mediaIn) {
  // Sort media so the result never depends on the order files were selected or listed.
  const media = [...mediaIn].sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : a.uuid < b.uuid ? -1 : a.uuid > b.uuid ? 1 : 0));
  const usable = entries.filter((e) => e.ms != null);
  const unusableEntries = entries.filter((e) => e.ms == null);
  const bucketKey = (day, kind) => `${day}|${kind}`;
  const eBuckets = new Map(), mBuckets = new Map();
  const sortedEntries = [...usable].sort((a, b) => a.ms - b.ms || a.index - b.index);
  for (const e of sortedEntries) {
    const k = bucketKey(utcDay(e.ms), e.kind === 'unknown' ? 'image' : e.kind);
    (eBuckets.get(k) || eBuckets.set(k, []).get(k)).push(e);
  }
  for (const m of media) {
    const k = bucketKey(dayNum(m.day), m.kind === 'unknown' ? 'image' : m.kind);
    (mBuckets.get(k) || mBuckets.set(k, []).get(k)).push(m);
  }
  const pairs = new Map(); // media.key -> pair
  const usedEntries = new Set();

  // pass 1: exact day
  for (const [k, ms] of [...mBuckets].sort()) {
    const es = eBuckets.get(k) || [];
    if (!es.length) continue;
    const exact = es.length === 1 && ms.length === 1;
    const n = Math.min(es.length, ms.length);
    for (let i = 0; i < n; i++) {
      // GPS is only trusted when the pairing is certain, or every candidate agrees and no media is left over.
      const gpsTrusted = exact || (allAgree(es) && es.length >= ms.length);
      pairs.set(ms[i].key, { media: ms[i], entry: es[i], pairing: exact ? 'exact' : 'ambiguous', candidates: es.slice(), gpsTrusted });
      usedEntries.add(es[i]);
    }
  }

  // pass 2: +-1 day window for leftovers
  const leftoverMedia = media.filter((m) => !pairs.has(m.key));
  const leftoverEntries = () => sortedEntries.filter((e) => !usedEntries.has(e));
  for (const m of leftoverMedia) {
    const md = dayNum(m.day);
    const cands = leftoverEntries().filter((e) => kindOk(e.kind, m.kind) && Math.abs(utcDay(e.ms) - md) === 1);
    if (!cands.length) continue;
    const e = cands[0];
    const competingMedia = leftoverMedia.filter((x) => !pairs.has(x.key) && x !== m && kindOk(e.kind, x.kind) && Math.abs(dayNum(x.day) - utcDay(e.ms)) <= 1);
    const clean = cands.length === 1 && competingMedia.length === 0;
    pairs.set(m.key, { media: m, entry: e, pairing: clean ? 'window' : 'window-ambiguous', candidates: cands.slice(), gpsTrusted: clean || (allAgree(cands) && competingMedia.length === 0) });
    usedEntries.add(e);
  }

  const out = media.map((m) => pairs.get(m.key) || { media: m, entry: null, pairing: 'none', candidates: [], gpsTrusted: false });
  const sourceMissing = sortedEntries.filter((e) => !usedEntries.has(e));
  return { pairs: out, sourceMissing, unusableEntries };
}
