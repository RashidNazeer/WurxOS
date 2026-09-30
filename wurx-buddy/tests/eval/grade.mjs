// Pure grading helpers for run-eval.mjs (README "How each grading type is
// scored"). No I/O here, so every rule is unit-testable offline
// (grade.test.mjs).

// ── numbers ──────────────────────────────────────────────────────────────
const CUR = { 'US$': 'USD', $: 'USD', usd: 'USD', '£': 'GBP', gbp: 'GBP', '€': 'EUR', eur: 'EUR', pkr: 'PKR', rs: 'PKR', 'rs.': 'PKR' };
const MULT = { k: 1e3, thousand: 1e3, m: 1e6, million: 1e6, mn: 1e6, b: 1e9, bn: 1e9, billion: 1e9 };

// prefix currency · sign · number (1,234.56 | 1234.56) · multiplier / x / % · suffix currency.
// The sign only counts when not glued to a word or digit, so "Sep 13-19" is 13 and 19.
const NUM_RE = new RegExp(
  String.raw`(US\$|\$|£|€|(?<![A-Za-z])(?:USD|GBP|EUR|PKR|Rs\.?)(?![A-Za-z]))?\s?` +
  String.raw`((?<![\w.])[-−])?` +
  String.raw`(\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?)` +
  String.raw`(?:\s?(bn|mn|million|billion|thousand|[kKmMbB])(?![A-Za-z]))?` +
  String.raw`(\s?%|\s?percent\b|x(?![A-Za-z]))?` +
  String.raw`(?:\s?(USD|GBP|EUR|PKR)\b)?`, 'g');

export function parseNumbers(text) {
  const out = [];
  for (const m of String(text ?? '').matchAll(NUM_RE)) {
    const [raw, pre, sign, digits, mult, tail, post] = m;
    let value = Number(digits.replaceAll(',', ''));
    if (!Number.isFinite(value)) continue;
    if (mult) value *= MULT[mult.toLowerCase()] ?? 1;
    if (sign) value = -value;
    const cur = pre ?? post;
    out.push({
      value,
      currency: cur ? CUR[cur] ?? CUR[cur.toLowerCase()] ?? null : null,
      pct: !!tail && tail.trim() !== 'x',
      x: tail === 'x',
      raw: raw.trim(),
    });
  }
  return out;
}

const tolFor = (e) => Math.max(e.tolerance_abs != null ? Number(e.tolerance_abs) : (e.tolerance ?? 0.005) * Math.abs(e.value), 1e-9);
const close = (a, v, tol) => Math.abs(a - v) <= tol || (a >= 0 && v < 0 && Math.abs(a + v) <= tol);   // "fell by $3,000" matches -3000

// A `pct change` number is optional unless the question itself asks for a %.
// A label ending in "(optional)" is credited when present, never required (e.g. partial
// items-sold sums offered alongside a monthly figure).
export const isRequired = (e, question) => !/\(optional\)\s*$/i.test(e.label ?? '')
  && !(/pct change/i.test(e.label ?? '') && !/%|percent/i.test(question ?? ''));

// → [{ index, required, matched, reason }] for every expected number with a value.
export function matchNumbers(answer, expected, question) {
  const nums = parseNumbers(answer);
  return (expected ?? []).map((e, index) => {
    if (e.value == null) return { index, required: false, matched: false, reason: 'no expected value' };
    const v = Number(e.value);
    const tol = tolFor({ ...e, value: v });
    const required = isRequired(e, question);
    const near = nums.filter((n) => close(n.value, v, tol));
    if (e.unit === 'money') {
      const want = String(e.currency ?? 'USD').toUpperCase();
      if (near.some((n) => n.currency === want)) return { index, required, matched: true, reason: null };
      return { index, required, matched: false, reason: near.length ? `value found but currency ${near.map((n) => n.currency ?? 'none').join('/')} ≠ ${want}` : 'not found' };
    }
    return { index, required, matched: near.length > 0, reason: near.length ? null : 'not found' };
  });
}

// ── leaks ────────────────────────────────────────────────────────────────
// Case-insensitive; thousands separators stripped on both sides.
const norm = (s) => String(s ?? '').toLowerCase().replace(/(\d),(?=\d{3})/g, '$1');

// → indexes of must_not_contain strings / forbidden values that appear.
export function findLeaks(answer, mustNotContain = [], forbidden = []) {
  const a = norm(answer);
  const nums = parseNumbers(answer).map((n) => n.value);
  const hit = (needle) => {
    const s = String(needle ?? '').trim();
    if (!s) return false;
    if (/^-?\d+(\.\d+)?$/.test(s)) {           // numeric: compare as numbers, and as a token
      const v = Number(s);
      return nums.some((n) => Math.abs(n - v) < 0.005) || new RegExp(`(?<![\\d.])${s.replace('.', '\\.')}(?![\\d])`).test(a);
    }
    return a.includes(norm(s));
  };
  return {
    mustNotContain: mustNotContain.map((s, i) => (hit(s) ? i : -1)).filter((i) => i >= 0),
    forbidden: forbidden.map((s, i) => (hit(s) ? i : -1)).filter((i) => i >= 0),
  };
}

// `must_not_match`: case-insensitive regexes that must not match the answer (word-level
// rules a trimmed substring can't express, e.g. gendered pronouns). → indexes that matched.
export const findPatternLeaks = (answer, patterns = []) =>
  patterns.map((p, i) => (new RegExp(p, 'i').test(String(answer ?? '')) ? i : -1)).filter((i) => i >= 0);

// `must_mention`: groups of alternatives; every group needs at least one alternative in the
// answer (case-insensitive, curly apostrophes folded). → indexes of groups with no hit.
const fold = (s) => String(s ?? '').toLowerCase().replace(/[‘’]/g, "'");
export const missingMentions = (answer, groups = []) => {
  const a = fold(answer);
  return groups.map((g, i) => (g.some((alt) => a.includes(fold(alt))) ? -1 : i)).filter((i) => i >= 0);
};

// ── citations ────────────────────────────────────────────────────────────
export function citedIds(answer) {
  const ids = new Set();
  for (const m of String(answer ?? '').matchAll(/\[((?:[SD]\d+)(?:\s*[,;]\s*[SD]\d+)*)\]/g)) {
    for (const id of m[1].split(/[,;]/)) ids.add(id.trim());
  }
  return [...ids];
}

const ID_IN_URL = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|\d{12,})/i;
// A§13's sources event has {id,type,title,url,period}; source_id is taken
// from the entry when present, else from the URL (report uuid / TikTok id).
export function sourceKey(s) {
  const type = s.source_type ?? s.type ?? null;
  const id = s.source_id ?? String(s.url ?? '').match(ID_IN_URL)?.[1] ?? null;
  return { type, id };
}

// validity: null when the endpoint sent no sources event (v1).
export function checkCitations(answer, sources, expectedSources = []) {
  const cited = citedIds(answer);
  if (!Array.isArray(sources)) return { cited, unknown: [], valid: null, correct: null };
  const byId = new Map(sources.map((s) => [String(s.id), s]));
  const unknown = cited.filter((id) => !byId.has(id));
  const exp = expectedSources.map((e) => `${e.source_type}:${e.source_id}`);
  const citedKeys = cited.filter((id) => byId.has(id)).map((id) => { const k = sourceKey(byId.get(id)); return `${k.type}:${k.id}`; });
  return {
    cited,
    citedKeys,
    unknown,
    valid: unknown.length === 0,
    correct: exp.length ? citedKeys.some((k) => exp.includes(k)) : null,
  };
}

// Recall@k: one expected source among the first k retrieved chunks.
export function recallAtK(retrieved, expectedSources, k = 8) {
  if (!Array.isArray(retrieved) || !expectedSources?.length) return null;
  const exp = new Set(expectedSources.map((e) => `${e.source_type}:${e.source_id}`));
  return retrieved.slice(0, k).some((r) => exp.has(`${r.source_type}:${r.source_id}`));
}

export const DOC_TYPES = new Set(['ai_doc', 'kb_article', 'tts_article', 'report', 'app_guide']);
const RETRIEVAL_CATEGORIES = new Set(['how_to', 'sop', 'tiktok', 'report_narrative', 'mixed']);
export const needsRetrieval = (row) =>
  (RETRIEVAL_CATEGORIES.has(row.category) || row.grading === 'citation') &&
  (row.expected_sources ?? []).some((s) => DOC_TYPES.has(s.source_type));

// ── privacy ──────────────────────────────────────────────────────────────
const SENSITIVE = /employee_compensation|salary_history|\bincentives\b|performance_ratings|get_performance_composite|attendance|leave_requests|\bprofiles\b/i;
export const isLive = (row) =>
  row.category === 'people_data' || !!row.person_ref || !!row.person_sql ||
  ['expected_sql', 'forbidden_sql'].some((k) => row[k] && (row[k].includes(':as_user_id') || SENSITIVE.test(row[k])));

// Numbers → [value]; given names → [person]. For text leaving the process.
export function redact(text, names = []) {
  let t = String(text ?? '');
  for (const n of names.filter(Boolean)) t = t.replace(new RegExp(n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), '[person]');
  return t.replace(/\d[\d,]*(\.\d+)?/g, '[value]');
}

// ── metrics & gates (A§16.3) ─────────────────────────────────────────────
export function p95(xs) {
  const s = xs.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  return s.length ? s[Math.min(s.length - 1, Math.ceil(0.95 * s.length) - 1)] : null;
}
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const ratio = (xs) => (xs.length ? xs.filter(Boolean).length / xs.length : null);

// rows: the run's output records (status, numbers, judge, citations, …).
export function computeMetrics(rows) {
  const ran = rows.filter((r) => r.status === 'pass' || r.status === 'fail');
  const req = ran.flatMap((r) => (r.numbers ?? []).filter((n) => n.required));
  const withCit = ran.filter((r) => r.citations?.valid != null);
  return {
    recall_at_8: ratio(ran.filter((r) => r.recall != null).map((r) => r.recall)),
    recall_rows: ran.filter((r) => r.recall != null).length,
    numeric_accuracy: req.length ? req.filter((n) => n.matched).length / req.length : null,
    numeric_required: req.length,
    correctness_mean: mean(ran.map((r) => r.judge?.correctness).filter((x) => Number.isFinite(x))),
    faithfulness: ratio(ran.map((r) => r.judge?.faithfulness).filter((x) => x === 0 || x === 1).map((x) => x === 1)),
    citation_validity: ratio(withCit.map((r) => r.citations.valid)),
    citation_rows: withCit.length,
    permission_safety: ratio(ran.filter((r) => r.category === 'permission').map((r) => !r.leaked)),
    permission_rows: ran.filter((r) => r.category === 'permission').length,
    clarify_rate: ratio(ran.filter((r) => r.category === 'ambiguous').map((r) => r.status === 'pass')),
    latency_p95_ms: p95(ran.map((r) => r.latency_ms)),
    cost_mean_usd: mean(ran.map((r) => r.cost_usd).filter((x) => Number.isFinite(x))),
  };
}

export const GATES = [
  ['recall_at_8', '≥', 0.85],
  ['numeric_accuracy', '≥', 0.95],
  ['correctness_mean', '≥', 4.2],
  ['faithfulness', '≥', 0.90],
  ['citation_validity', '≥', 1.0],
  ['permission_safety', '≥', 1.0],
  ['clarify_rate', '≥', 0.8],
  ['latency_p95_ms', '≤', 20000],
  ['cost_mean_usd', '≤', null],        // baseline × 1.3; needs --baseline
];

// Errored rows were never graded, so a run with any cannot PASS.
export function evaluateGates(m, baselineCost = null, erroredRows = 0) {
  const out = GATES.map(([key, op, limit]) => {
    const lim = key === 'cost_mean_usd' ? (baselineCost != null ? baselineCost * 1.3 : null) : limit;
    const v = m[key];
    const status = v == null || lim == null ? 'n/a' : (op === '≥' ? v >= lim - 1e-12 : v <= lim + 1e-12) ? 'PASS' : 'FAIL';
    return { key, op, limit: lim, value: v, status };
  });
  const overall = out.some((g) => g.status === 'FAIL') ? 'FAIL' : out.some((g) => g.status === 'n/a') || erroredRows > 0 ? 'INCOMPLETE' : 'PASS';
  return { gates: out, overall };
}
