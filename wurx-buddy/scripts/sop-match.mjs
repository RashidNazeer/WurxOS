// Matches imported SOP docs (ai_assistant_docs with the import sentinel) to
// the KB article they were imported from. Pure; used by link-sops.mjs.
//
// What the dev data shows (2026-09-28): the importer kept the KB title, and
// split long SOPs into "<KB title> (part N)" or "<KB title> — <section>".
// Only 1 of 133 docs carries a link (a Loom URL). So:
//   high    exact normalised title, a "(part N)" / " — section" split of an
//           exact KB title, or a Google/Loom id shared with the KB url, and
//           exactly one KB article (or one SOP group) fits
//   medium  best fuzzy title match (token Dice ≥ 0.6, clear of the runner-up),
//           or an exact match that fits several unrelated KB articles
//   none    everything else
// Only 'high' is ever written.

export const SOP_SENTINEL = '<!--wurx-sop-import-->';

export const normTitle = (s) => String(s ?? '').normalize('NFKC').toLowerCase()
  .replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').trim()
  .replace(/^sop /, '');

const PART_RE = /\s*\(part\s*\d+\)\s*$/i;
const SECTION_RE = /\s+[—–]\s+/;   // the importer's separator; a plain " - " is part of real titles

// Base titles a doc may have been cut from, strongest first.
function baseTitles(title) {
  const t = String(title ?? '').trim();
  const out = [{ title: t, method: 'title_exact' }];
  if (PART_RE.test(t)) out.push({ title: t.replace(PART_RE, ''), method: 'title_part' });
  if (SECTION_RE.test(t)) out.push({ title: t.split(SECTION_RE)[0], method: 'title_section' });
  return out;
}

// Google Docs/Drive/Sheets file ids and Loom share ids.
export function linkIds(s) {
  const ids = new Set();
  for (const m of String(s ?? '').matchAll(/(?:docs|drive)\.google\.com\/(?:[a-z]+\/)*(?:d|file\/d)\/([A-Za-z0-9_-]{20,})/g)) ids.add(`g:${m[1]}`);
  for (const m of String(s ?? '').matchAll(/[?&]id=([A-Za-z0-9_-]{20,})/g)) ids.add(`g:${m[1]}`);
  for (const m of String(s ?? '').matchAll(/loom\.com\/(?:share|embed)\/([a-f0-9]{32})/g)) ids.add(`l:${m[1]}`);
  return [...ids];
}

const tokens = (s) => new Set(normTitle(s).split(' ').filter((w) => w.length > 1));
function dice(a, b) {
  const A = tokens(a), B = tokens(b);
  if (!A.size || !B.size) return 0;
  let n = 0;
  for (const w of A) if (B.has(w)) n++;
  return (2 * n) / (A.size + B.size);
}

// Several KB rows for one title are fine when they are versions of one SOP:
// link the latest APPROVED version of that group (QA L10: the one the KB page
// shows and the ingester indexes), else the latest one.
function pickOne(kbs) {
  const groups = new Set(kbs.map((k) => k.sop_group_id || k.id));
  if (groups.size !== 1) return null;
  const order = (a, b) => (b.version ?? -1) - (a.version ?? -1) || String(a.id).localeCompare(String(b.id));
  return [...kbs].filter((k) => k.approval_status === 'approved').sort(order)[0] ?? [...kbs].sort(order)[0];
}

export function matchSop(doc, kbRows, { byTitle, byLink } = indexKb(kbRows)) {
  for (const id of linkIds(doc.content)) {
    const hits = byLink.get(id);
    if (hits?.length) {
      const one = pickOne(hits);
      return one ? { kb: one, method: 'url_id', confidence: 'high', score: 1 }
                 : { kb: hits[0], method: 'url_id_ambiguous', confidence: 'medium', score: 1, candidates: hits.length };
    }
  }
  for (const b of baseTitles(doc.title)) {
    const hits = byTitle.get(normTitle(b.title));
    if (hits?.length) {
      const one = pickOne(hits);
      return one ? { kb: one, method: b.method, confidence: 'high', score: 1 }
                 : { kb: hits[0], method: `${b.method}_ambiguous`, confidence: 'medium', score: 1, candidates: hits.length };
    }
  }
  const base = baseTitles(doc.title).at(-1).title;
  const ranked = kbRows.map((k) => ({ k, s: Math.max(dice(doc.title, k.title), dice(base, k.title)) }))
    .sort((a, b) => b.s - a.s);
  const [best, next] = ranked;
  if (best && best.s >= 0.6 && best.s - (next?.s ?? 0) >= 0.1) {
    return { kb: best.k, method: 'title_fuzzy', confidence: 'medium', score: +best.s.toFixed(3) };
  }
  return { kb: best?.k ?? null, method: 'none', confidence: 'none', score: +(best?.s ?? 0).toFixed(3) };
}

export function indexKb(kbRows) {
  const byTitle = new Map();
  const byLink = new Map();
  const push = (m, k, v) => (m.get(k) ?? m.set(k, []).get(k)).push(v);
  for (const k of kbRows) {
    push(byTitle, normTitle(k.title), k);
    for (const id of linkIds(k.url)) push(byLink, id, k);
  }
  return { byTitle, byLink };
}

export function matchSops(docs, kbRows) {
  const idx = indexKb(kbRows);
  return docs.filter((d) => String(d.content ?? '').includes(SOP_SENTINEL))
    .map((d) => ({ doc: d, ...matchSop(d, kbRows, idx) }));
}
