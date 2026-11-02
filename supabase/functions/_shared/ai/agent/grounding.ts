// Grounding check on the finished answer (the owner's rule: Buddy must NEVER state false information).
//
// After the model writes its answer, every NAME, NUMBER, PERCENTAGE, MONEY AMOUNT, DATE and every ROLE or
// EMPLOYMENT-STATUS claim in it is checked, mechanically, against what THIS turn's tools returned. This
// catches the failure the prompt cannot: a model that read "Ali Ahmad (APC, former employee)" and still
// wrote "the highest TL is Ali Ahmad".
//
// What counts as support (and nothing else does):
//   * the text of every tool / search result of this turn            (the evidence)
//   * the user's own messages                                         (what they typed is theirs to say)
//   * the NOW line of the prompt                                      (today's date)
//   * for NAMES only: earlier assistant turns of the conversation     (so "why is he low?" can say who "he" is)
// Earlier assistant answers never support a number, a role or a status.
//
// The rules, each documented where it is implemented below:
//   N1 number   money, %, ratios, decimals and integers above 10 must match a number the tools printed,
//               to the precision the answer wrote (211,580.19 -> "$211.6K" ok, "$212K" ok, "$215K" not).
//   N2 derived  a figure is also fine if it is a sum / difference / ratio / % change of two evidence numbers,
//               a sum of grounded figures in the same sentence or the list just above it, or a plain count
//               of the lines in a list the tool returned (e.g. "12 APCs").
//   N3 exempt   years, week numbers, dates, times, list markers, ordinals, citations [D1], URLs and small
//               integers (<= 10, no %, no currency) -- "top 3", "2 steps" are counts the model may derive.
//   P1 name     a person's name (from the profiles dictionary) must appear in the evidence, the user's text,
//               or an earlier assistant turn. An invented colleague is caught here.
//   R1 role     "<name> ... <role>" / "<role> <name>" / "<name> (<role>)" must match the role the tool printed
//               next to that name. A role the tool never printed for that person is also ungrounded.
//   S1 status   a person the tool marked "former employee" must not be presented as current, and a sentence
//               or bullet naming such a person must say they are former/left/no longer active (the incident).
//               Calling a person who the tool shows as active "former" is also caught.
//   A1 absence  "X had no score / no entries" is wrong when a tool result printed a composite score for X.
//   D1 date     a day (Oct 25), a month with year (October 2026, 2026-10) or a bare month name must appear in
//               the evidence, the user's text or NOW.
//
// Known limits (also in the report): free-text claims about WHY something happened, comparisons ("better
// than"), and figures the model computes from many numbers (an average of eight scores) are not verifiable
// mechanically; an unexpected spelling of a name (a nickname, a typo) is not in the dictionary so it is
// not checked; a number that coincides with some other number in the evidence passes. The check is a safety
// net on top of correct tool output, not a replacement for it.

export type ClaimKind = 'number' | 'name' | 'role' | 'status' | 'date' | 'absence';
export type Claim = { kind: ClaimKind; text: string; sentence: string; reason: string; unit: number };
export type Evidence = {
  tools: string[];            // full text of each tool / search result of this turn
  user: string[];             // the user's messages (this turn and earlier)
  now?: string;               // the NOW line of the prompt
  priorAssistant?: string[];  // earlier assistant turns: supports NAMES only
  people?: string[];          // dictionary of every person display_name (profiles), for P1
};
export type Verdict = {
  claims: Claim[];
  checked: { numbers: number; names: number; roles: number; statuses: number; dates: number };
  units: string[][];          // the answer as [line][sentence], for redaction
  seps: string[][];
};

// --------------------------------------------------------------------------- text helpers
const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const MON_RE = '(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)';
const monthNo = (s: string) => { const i = MONTHS.findIndex((m) => m.startsWith(s.toLowerCase().slice(0, 3))); return i < 0 ? 0 : i + 1; };

const CITE = /\[(?:[SDW]\d{1,3})(?:\s*[,;]\s*[SDW]\d{1,3})*\]/g;
const URLS = /https?:\/\/\S+|\]\([^)]*\)|\/[a-z][a-z0-9\-_/]*(?=[\s).,;]|$)/gi;
const LINE_MARK = /^\s*(?:[-*•]|\d{1,2}[.)])\s+/;

const ROLE_WORDS: [RegExp, string][] = [
  [/paid[\s-]collab(?:oration)?\s+team\s+lead(?:er)?s?/i, 'PCTL'],
  [/operations?\s+leads?/i, 'OL'],
  [/team\s+lead(?:er)?s?(?:\s+[—–-]\s+affiliate)?/i, 'TL'],
  [/affiliate\s+program\s+coordinators?/i, 'APC'],
  [/influencer\s+program\s+coordinators?/i, 'IPC'],
  [/ads?\s+managers?/i, 'ADS MANAGER'],
  [/developers?/i, 'DEVELOPER'],
  [/\bPCTLs?\b/, 'PCTL'], [/\bTLs?\b/, 'TL'], [/\bOLs?\b/, 'OL'], [/\bAPCs?\b/, 'APC'], [/\bIPCs?\b/, 'IPC'],
  [/\b(?:the\s+)?boss\b/i, 'BOSS'],
];
const ROLE_ALT = ROLE_WORDS.map(([r]) => r.source).join('|');

const FORMER_RE = /\b(?:former|ex-employee|left (?:the|our|wurx|company)|has left|have left|no longer (?:works?|working|with|employed|active|part|here)|deactivated|departed|resigned|laid off|leaver|not (?:a )?current)/i;
const CURRENT_RE = /\b(?:current(?:ly)? (?:employees?|staff|members?|employed|works?|working)|active (?:employees?|staff|members?)|still (?:works?|working|with us|employed|here)|works? (?:here|for us))\b/i;

const ABSENT_RE = /\b(?:no|did not have|didn't have|does not have|doesn't have|has no|have no|without|missing|not recorded|not rated|not available|unavailable)\b[^.\n]{0,60}\b(?:composite|scores?|entries|entry)\b|\b(?:composite|scores?)\b[^.\n]{0,40}\b(?:not recorded|missing|not available|unavailable|not rated)\b/i;
const SCORE_LINE = /composite \d|\d\/100/i;
const PERIOD_ABSENCE_RE = /\b(?:aren't|are not|isn't|is not|hasn't|haven't|has not|have not|not) (?:in|available|submitted|recorded|rated|published)(?: yet)?\b|\bnot yet (?:in|available|rated|recorded|submitted|published)\b|\b(?:yet to|still to) (?:be )?(?:come|submitted|rated|recorded)\b/i;
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// --------------------------------------------------------------------------- numbers
type Num = { raw: string; value: number; dec: number; scale: number; money: boolean; pct: boolean; start: number; end: number };

const NUM_RE = /(?<![\w.,]|[A-Za-z]-)([$£€₨]\s?)?(-?\d[\d,]*(?:\.\d+)?)(?:(\s?[kKmM])(?![a-zA-Z]))?(\s?%)?(?:\s?(PKR|USD|GBP|EUR)\b)?(?!-[A-Za-z])/g;
const CUR_BEFORE = /(?:PKR|USD|GBP|EUR|Rs\.?)\s?$/;

// Things that look like numbers but are not figures (N3).
function maskNonFigures(text: string): string {
  const blank = (m: string) => ' '.repeat(m.length);
  return text
    .replace(CITE, blank).replace(URLS, blank)
    .replace(/\b\d{4}-\d{2}(?:-\d{2})?\b/g, blank)                                             // ISO dates / months
    .replace(new RegExp(`\\b\\d{1,2}(?:st|nd|rd|th)?\\s+${MON_RE}\\b(?:\\s+\\d{4})?`, 'gi'), blank)  // 12 October 2026
    .replace(new RegExp(`\\b${MON_RE}\\.?\\s+\\d{1,2}(?:\\s*[-–—]\\s*\\d{1,2})?(?:,?\\s+\\d{4})?\\b`, 'gi'), blank)  // Oct 25 - 31, 2026
    .replace(new RegExp(`\\b${MON_RE}\\.?\\s+\\d{4}\\b`, 'gi'), blank)                           // October 2026
    .replace(/\b\d{1,2}[––-]\d{1,2}\s+(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*/gi, blank)
    .replace(/\b(?:weeks?|wk)\s*#?\d+(?:\s*[-–—]\s*\d+)?/gi, blank)                              // Week 23, Weeks 10-12
    .replace(/\b\d{1,2}:\d{2}(?::\d{2})?\s?(?:am|pm)?\b/gi, blank)                              // times
    .replace(/\b\d+(?:st|nd|rd|th)\b/gi, blank)                                                  // ordinals
    .replace(/(?<![$£€\d,.])\b(?:19|20)\d{2}\b(?![\d,.]*\s?%)/g, blank);                         // bare years
}

function numbersIn(text: string): Num[] {
  const out: Num[] = [];
  const t = text;
  for (const m of t.matchAll(NUM_RE)) {
    const digits = m[2];
    const dec = digits.includes('.') ? digits.split('.')[1].length : 0;
    const base = Number(digits.replace(/,/g, ''));
    if (!Number.isFinite(base)) continue;
    const scale = m[3] ? (/m/i.test(m[3]) ? 1e6 : 1e3) : 1;
    const before = t.slice(Math.max(0, m.index! - 5), m.index!);
    out.push({ raw: m[0].trim(), value: base * scale, dec, scale, money: !!m[1] || !!m[5] || CUR_BEFORE.test(before), pct: !!m[4], start: m.index!, end: m.index! + m[0].length });
  }
  return out;
}

const approx = (a: number, b: number, tol: number) => Math.abs(a - b) <= tol + 1e-9 * Math.max(1, Math.abs(b));
const tolOf = (n: Num) => 0.5 * 10 ** -n.dec * n.scale;

// Every number the evidence prints, K/M-expanded forms included, plus the line counts of its lists (N2).
function evidenceNumbers(texts: string[]): { vals: number[]; counts: Set<number> } {
  const set = new Set<number>();
  const counts = new Set<number>();
  for (const raw of texts) {
    for (const n of numbersIn(raw)) set.add(n.value);
    let run = 0, total = 0;
    for (const line of raw.split('\n')) {
      if (/^\s*(?:[-•*]|\d+[.)])\s+/.test(line)) { run++; total++; } else { if (run > 1) counts.add(run); run = 0; }
      const items = line.split(',').length;
      if (items > 2 && line.includes(':')) counts.add(items);
    }
    if (run > 1) counts.add(run);
    if (total > 1) counts.add(total);
  }
  return { vals: [...set], counts };
}

function supportedNumber(n: Num, ev: { vals: number[]; counts: Set<number> }, sameUnit: number[], listSums: number[]): boolean {
  const tol = tolOf(n);
  const v = n.value;
  if (ev.vals.some((e) => approx(e, v, tol) || approx(Math.round(e * 10 ** n.dec) / 10 ** n.dec * n.scale / n.scale, v, tol))) return true;
  // a percentage may be printed as a ratio and the reverse ("0.903" vs "90.3%")
  if (n.pct && ev.vals.some((e) => approx(e * 100, v, tol))) return true;
  if (!n.money && !n.pct && Number.isInteger(v) && ev.counts.has(v)) return true;      // N2: a count of listed items
  // N2: derived from two evidence numbers
  if (Math.abs(v) >= 1000 || (n.pct && n.dec > 0)) {
    const pool = ev.vals.filter((e) => Math.abs(e) >= 100).slice(0, 500);
    const t2 = tol * 3;
    for (let i = 0; i < pool.length; i++) {
      const a = pool[i];
      for (let j = 0; j < pool.length; j++) {
        const b = pool[j];
        if (Math.abs(v) >= 1000 && i < j && (approx(a + b, v, t2) || approx(a - b, v, t2) || approx(b - a, v, t2))) return true;
        if (n.pct && b !== 0 && (approx((a / b) * 100, v, t2) || approx(((a - b) / Math.abs(b)) * 100, v, t2))) return true;
      }
    }
  }
  // N2: sums of grounded figures in the same sentence, or of the list right above it
  const near = sameUnit.filter((x) => x !== v);
  for (let mask = 3; mask < (1 << Math.min(near.length, 8)); mask++) {
    if ((mask & (mask - 1)) === 0) continue;
    let s = 0;
    for (let k = 0; k < Math.min(near.length, 8); k++) if (mask & (1 << k)) s += near[k];
    if (approx(s, v, tol * 3)) return true;
  }
  return listSums.some((s) => approx(s, v, tol * 3));
}

// --------------------------------------------------------------------------- dates
function dateKeys(text: string): Set<string> {
  const keys = new Set<string>();
  const add = (y: number | null, m: number, d: number | null) => {
    keys.add(`M${m}`);
    if (y) keys.add(`YM${y}-${m}`);
    if (d) { keys.add(`MD${m}-${d}`); if (y) keys.add(`YMD${y}-${m}-${d}`); }
  };
  for (const m of text.matchAll(/\b((?:19|20)\d{2})-(\d{2})(?:-(\d{2}))?\b/g)) add(+m[1], +m[2], m[3] ? +m[3] : null);
  for (const m of text.matchAll(new RegExp(`\\b(${MON_RE})\\.?\\s+(\\d{1,2})(?:\\s*[-–—]\\s*(?:(${MON_RE})\\.?\\s+)?(\\d{1,2}))?(?:,?\\s+((?:19|20)\\d{2}))?`, 'gi'))) {
    const y = m[5] ? +m[5] : null, mo = monthNo(m[1]);
    add(y, mo, +m[2]);
    if (m[4]) { const mo2 = m[3] ? monthNo(m[3]) : mo; for (let d = +m[2]; d <= +m[4] && d - +m[2] < 40; d++) add(y, mo2, d); add(y, mo2, +m[4]); }
  }
  for (const m of text.matchAll(new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?(?:\\s*[-–—]\\s*(\\d{1,2})(?:st|nd|rd|th)?)?\\s+(${MON_RE})\\b(?:,?\\s+((?:19|20)\\d{2}))?`, 'gi'))) {
    const y = m[4] ? +m[4] : null, mo = monthNo(m[3]);
    add(y, mo, +m[1]);
    if (m[2]) for (let d = +m[1]; d <= +m[2] && d - +m[1] < 40; d++) add(y, mo, d);
  }
  for (const m of text.matchAll(new RegExp(`\\b(${MON_RE})\\.?,?\\s+((?:19|20)\\d{2})\\b`, 'gi'))) add(+m[2], monthNo(m[1]), null);
  for (const m of text.matchAll(new RegExp(`\\b(${MON_RE.replace('may|', '').replace('mar(?:ch)?|', '')})[a-z]*\\b`, 'gi'))) keys.add(`M${monthNo(m[1])}`);
  for (const m of text.matchAll(/\b(May|March)\b/g)) keys.add(`M${monthNo(m[1])}`);
  return keys;
}

type DateMention = { text: string; key: string; strict: boolean };
function dateMentions(text: string): DateMention[] {
  const t = text.replace(CITE, ' ').replace(URLS, ' ');
  const out: DateMention[] = [];
  for (const m of t.matchAll(/\b((?:19|20)\d{2})-(\d{2})(?:-(\d{2}))?\b/g)) {
    const mo = +m[2]; if (mo < 1 || mo > 12) continue;
    out.push({ text: m[0], key: m[3] ? `YMD${+m[1]}-${mo}-${+m[3]}` : `YM${+m[1]}-${mo}`, strict: true });
  }
  for (const m of t.matchAll(new RegExp(`\\b(${MON_RE})\\.?\\s+(\\d{1,2})(?:\\s*[-–—]\\s*(?:(${MON_RE})\\.?\\s+)?(\\d{1,2}))?(?:,?\\s+((?:19|20)\\d{2}))?\\b`, 'gi'))) {
    const mo = monthNo(m[1]); const y = m[5] ? +m[5] : null;
    out.push({ text: m[0], key: y ? `YMD${y}-${mo}-${+m[2]}` : `MD${mo}-${+m[2]}`, strict: true });
    if (m[4]) { const mo2 = m[3] ? monthNo(m[3]) : mo; out.push({ text: m[0], key: y ? `YMD${y}-${mo2}-${+m[4]}` : `MD${mo2}-${+m[4]}`, strict: true }); }
  }
  for (const m of t.matchAll(new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?(?:\\s*[-–—]\\s*(\\d{1,2})(?:st|nd|rd|th)?)?\\s+(${MON_RE})\\b(?:,?\\s+((?:19|20)\\d{2}))?`, 'gi'))) {
    const mo = monthNo(m[3]); const y = m[4] ? +m[4] : null;
    out.push({ text: m[0], key: y ? `YMD${y}-${mo}-${+m[1]}` : `MD${mo}-${+m[1]}`, strict: true });
    if (m[2]) out.push({ text: m[0], key: y ? `YMD${y}-${mo}-${+m[2]}` : `MD${mo}-${+m[2]}`, strict: true });
  }
  for (const m of t.matchAll(new RegExp(`\\b(${MON_RE})\\.?,?\\s+((?:19|20)\\d{2})\\b`, 'gi'))) out.push({ text: m[0], key: `YM${+m[2]}-${monthNo(m[1])}`, strict: true });
  // a bare full month name ("in October"); "may"/"march" are ordinary words and are not checked
  const stripped = t.replace(new RegExp(`\\b${MON_RE}\\.?,?\\s+(?:\\d{1,2}|(?:19|20)\\d{2})\\b`, 'gi'), ' ');
  for (const m of stripped.matchAll(/\b(January|February|April|June|July|August|September|October|November|December)\b/g)) out.push({ text: m[0], key: `M${monthNo(m[1])}`, strict: false });
  return out;
}

// --------------------------------------------------------------------------- people
export type Label = { roles: Set<string>; former: boolean; seen: boolean; anyActive: boolean };

const CODE_ALT = 'PCTL|TL|OL|APC|IPC|ADS MANAGER|DEVELOPER|BOSS';
// "Name (APC)" / "Name (APC, former employee – left 2026-10-12)", the one format tools/who.ts prints.
const LABEL_RE = new RegExp(`([A-Z][\\p{L}'’.\\-]*(?: [A-Z][\\p{L}'’.\\-]*){0,4}) \\((${CODE_ALT})(, former employee[^)]*)?\\)`, 'gu');

export function parseLabels(texts: string[], people: string[] = []): Map<string, Label> {
  const map = new Map<string, Label>();
  const get = (name: string) => { const k = name.toLowerCase(); let l = map.get(k); if (!l) { l = { roles: new Set(), former: false, seen: true, anyActive: false }; map.set(k, l); } return l; };
  const dict = [...people].sort((a, b) => b.length - a.length);
  const GROUP_CODE: Record<string, string> = { apcs: 'APC', ipcs: 'IPC', tls: 'TL', pctls: 'PCTL', ols: 'OL', 'ads managers': 'ADS MANAGER', developers: 'DEVELOPER' };
  // the names a line is ABOUT: the one that starts it, or the ones listed after its last colon
  const subjects = (line: string): string[] => {
    const t = line.trim().replace(/^(?:[-•*]|\d+[.)])\s*/, '').replace(/\*\*/g, '');
    const out: string[] = [];
    for (const p of dict) if (t.startsWith(p) && !/^[\p{L}\p{N}]/u.test(t.slice(p.length, p.length + 1))) { out.push(p); break; }
    const ci = t.lastIndexOf(': ');
    if (ci > 0) for (const part of t.slice(ci + 2).split(/[,;]\s*/)) { const nm = part.replace(/\s*\(.*$/, '').trim(); const hit = dict.find((p) => p === nm); if (hit) out.push(hit); }
    return out;
  };
  for (const raw of texts) {
    for (const m of raw.matchAll(LABEL_RE)) {
      const name = m[1].replace(/^(?:[-•*]|\d+[.)])\s*/, '');
      // the capture can start inside a longer phrase; prefer the dictionary name that ends it
      const hit = dict.find((p) => name.toLowerCase().endsWith(p.toLowerCase()));
      const l = get(hit ?? name);
      l.roles.add(m[2]); if (m[3]) l.former = true; else l.anyActive = true;
    }
    // "APCs: A, B (temporary cover ...); IPCs: C" -- the group word is the role
    for (const g of raw.matchAll(/\b(APCs|IPCs|TLs|PCTLs|OLs|Ads Managers|Developers): ([^;\n]+)/g)) {
      for (const part of g[2].split(/,\s*/)) { const nm = part.replace(/\s*\(.*$/, '').trim(); const hit = dict.find((p) => p === nm); if (hit) get(hit).roles.add(GROUP_CODE[g[1].toLowerCase()]); }
    }
    // "Operation Lead (OL) (2):" headings give a role to the bare names listed under them
    let heading: string | null = null;
    for (const line of raw.split('\n')) {
      if (!line.trim()) { heading = null; continue; }
      const h = /^(?:.*?)\((PCTL|TL|OL|APC|IPC)\) \(\d+\):$/.exec(line.trim()) ?? /^.*\((ADS MANAGER|DEVELOPER|BOSS)\)\s*\(\d+\):$/.exec(line.trim());
      if (h) { heading = h[1]; continue; }
      if (/^(?:FORMER|Former)/.test(line.trim())) heading = null;
      const subs = subjects(line);
      if (heading) for (const nm of subs) get(nm).roles.add(heading);
      // "- Name · reports to X · ... · FORMER EMPLOYEE (left ...)": the person at the START of the line
      if (subs.length && /^\s*(?:[-•*])/.test(line)) { if (/FORMER EMPLOYEE|former employee/.test(line)) get(subs[0]).former = true; else get(subs[0]).anyActive = true; }
    }
    // find_person: "Name (APC)" then "- Status: FORMER EMPLOYEE" a few lines below
    const fp = /^(.+?) \([A-Z ]+, former employee[^)]*\)/m.exec(raw);
    if (fp) { const hit = dict.find((p) => fp[1].endsWith(p)); if (hit) get(hit).former = true; }
  }
  return map;
}

function roleOfPhrase(s: string): string | null {
  for (const [re, code] of ROLE_WORDS) if (new RegExp(`^(?:${re.source})$`, re.flags.includes('i') ? 'i' : '').test(s.trim())) return code;
  return null;
}

type NameHit = { name: string; start: number; end: number };
function findNames(text: string, names: string[]): NameHit[] {
  const hits: NameHit[] = [];
  const taken: [number, number][] = [];
  for (const name of [...new Set(names)].filter((n) => n.length >= 4).sort((a, b) => b.length - a.length)) {
    const re = new RegExp(`(?<![\\p{L}\\p{N}])${esc(name)}(?![\\p{L}\\p{N}])`, name.includes(' ') ? 'giu' : 'gu');
    for (const m of text.matchAll(re)) {
      const s = m.index!, e = s + m[0].length;
      if (taken.some(([a, b]) => s < b && e > a)) continue;
      taken.push([s, e]); hits.push({ name, start: s, end: e });
    }
  }
  return hits.sort((a, b) => a.start - b.start);
}

// --------------------------------------------------------------------------- segmentation
function segment(answer: string): { units: string[][]; seps: string[][]; lineOf: number[]; flat: { text: string; line: number; idx: number }[] } {
  const lines = answer.split('\n');
  const units: string[][] = [], seps: string[][] = [];
  const flat: { text: string; line: number; idx: number }[] = [];
  lines.forEach((line, li) => {
    const parts = line.split(/(?<=[.!?])(\s+)(?=[A-Z*"(])/);
    const u: string[] = [], s: string[] = [];
    parts.forEach((p, i) => { if (i % 2 === 0) { u.push(p); flat.push({ text: p, line: li, idx: u.length - 1 }); } else s.push(p); });
    units.push(u); seps.push(s);
  });
  return { units, seps, lineOf: [], flat };
}

// --------------------------------------------------------------------------- the check
export function verifyAnswer(answer: string, ev: Evidence): Verdict {
  const text = String(answer ?? '');
  const seg = segment(text);
  const claims: Claim[] = [];
  const checked = { numbers: 0, names: 0, roles: 0, statuses: 0, dates: 0 };
  const evTexts = ev.tools.map((t) => t);
  const userTexts = ev.user;
  const support = [...evTexts, ...userTexts, ...(ev.now ? [ev.now] : [])];
  const evNums = evidenceNumbers(support);
  const evDates = dateKeys(support.join('\n'));
  const nameDict = [...new Set(ev.people ?? [])];
  const labels = parseLabels(evTexts, nameDict);
  const labelNames = [...labels.keys()];
  const supportLower = support.join('\n').toLowerCase();
  const priorLower = (ev.priorAssistant ?? []).join('\n').toLowerCase();
  const allNames = [...new Set([...nameDict, ...labelNames.map((k) => k)])];
  const flagged = new Set<string>();

  const flag = (kind: ClaimKind, textC: string, unit: number, sentence: string, reason: string) => {
    const key = `${kind}|${textC}|${unit}`;
    if (flagged.has(key)) return; flagged.add(key);
    claims.push({ kind, text: textC, sentence: sentence.trim().slice(0, 240), reason, unit });
  };

  // numbers in a list block, for "total" lines (sum of the first figure of each bullet above)
  const lineFirst = (li: number) => { const m = numbersIn(maskNonFigures(seg.units[li].join(' '))).filter((n) => n.value > 10 || n.money || n.pct); return m.length ? m[0] : null; };

  seg.flat.forEach((u, unitNo) => {
    const sentence = u.text;
    if (!sentence.trim()) return;
    const masked = maskNonFigures(sentence);

    // ---- N1/N2/N3 numbers
    const nums = numbersIn(masked);
    const groundedHere: number[] = [];
    const todo: Num[] = [];
    for (const n of nums) {
      const big = Math.abs(n.value) > 10 || n.dec > 0 || n.money || n.pct || n.scale > 1;
      if (!big) continue;
      if (/^\s*(?:[-*•]|\d{1,2}[.)])\s+$/.test(masked.slice(0, n.start + 1)) && n.value <= 99 && Number.isInteger(n.value) && !n.money && !n.pct) continue;
      checked.numbers++;
      if (supportedNumber(n, evNums, [], [])) groundedHere.push(n.value); else todo.push(n);
    }
    for (const n of todo) {
      let listSums: number[] = [];
      if (u.idx === 0) {   // sum of the first figure of each contiguous bullet line above
        let s = 0, k = u.line - 1, c = 0;
        while (k >= 0 && LINE_MARK.test(seg.units[k][0] ?? '')) { const f = lineFirst(k); if (f) { s += f.value; c++; } k--; }
        if (c > 1) listSums = [Math.round(s * 100) / 100];
      }
      if (!supportedNumber(n, evNums, groundedHere, listSums)) {
        flag('number', n.raw, unitNo, sentence, 'this figure is not in any tool result of this turn');
      }
    }

    // ---- D1 dates
    for (const d of dateMentions(sentence)) {
      checked.dates++;
      if (evDates.has(d.key)) continue;
      // a day mentioned with the right month but no year, or a month the user/NOW/tools named
      if (!d.strict && evDates.has(d.key)) continue;
      flag('date', d.text, unitNo, sentence, 'this date / month does not appear in the tool results, your question or today\'s date');
    }
  });

  // Rules D2/E1 (added after the free-model benchmark): months and periods come from the tools or the user, NOT
  // from the calendar, so "November ratings aren't in yet" after a tool returned October is caught; and a role
  // code is never expanded into words the tools did not print ("APC" -> "Associate Program Coordinator").
  const monthEv = dateKeys([...evTexts, ...userTexts].join('\n'));
  const supportLow = support.join('\n').toLowerCase();
  const CANON = ['affiliate program coordinator', 'influencer program coordinator', 'team lead', 'paid collab team lead', 'operation lead', 'ads manager', 'developer'];
  seg.flat.forEach((u, unitNo) => {
    const sentence = u.text;
    for (const d of dateMentions(sentence)) {
      if (d.strict || evDates.has(d.key) === false) continue;
      if (d.key.startsWith('M') && !monthEv.has(d.key) && !d.strict) flag('date', d.text, unitNo, sentence, 'this month is not in any tool result or in your question (do not say anything about periods the tools did not return)');
    }
    if (PERIOD_ABSENCE_RE.test(sentence) && (new RegExp('\\b(?:' + MON_RE + ')\\b', 'i').test(sentence) || /\b(?:this|next|current|last) (?:month|week|quarter)\b/i.test(sentence))) {
      const phrase = (PERIOD_ABSENCE_RE.exec(sentence)?.[0] ?? '').toLowerCase();
      if (!supportLow.includes(phrase)) flag('date', phrase, unitNo, sentence, 'a claim that a period is not in yet, which no tool result says');
    }
    for (const m of sentence.matchAll(/((?:[A-Z][a-z]+ ){1,5})\((APC|IPC|PCTL|TL|OL)\)/g)) {
      const words = m[1].trim();
      const wl = words.toLowerCase();
      if (CANON.some((c) => wl.endsWith(c)) && supportLow.includes(wl)) continue;
      if (supportLow.includes((words + ' (' + m[2] + ')').toLowerCase())) continue;
      if (nameDict.some((n) => words.endsWith(n))) continue;
      if (labels.has(wl)) continue;
      const parts = words.split(' ');
      if (parts.some((_, i) => labels.has(parts.slice(i).join(' ').toLowerCase()))) continue;
      flag('role', words + ' (' + m[2] + ')', unitNo, sentence, 'role codes are written exactly as the tools write them; this expansion is not in any tool result');
    }
  });

  // ---- P1/R1/S1 people (per sentence, with the bullet's heading as context for S1)
  const hasFormerMarker = (unitNo: number): boolean => {
    const u = seg.flat[unitNo];
    if (FORMER_RE.test(u.text)) return true;
    // the whole bullet line, then the heading line above its list
    if (FORMER_RE.test(seg.units[u.line].join(' '))) return true;
    if (LINE_MARK.test(seg.units[u.line][0] ?? '')) {
      for (let k = u.line - 1; k >= 0; k--) {
        const first = seg.units[k][0] ?? '';
        if (!first.trim()) continue;
        if (!LINE_MARK.test(first)) return FORMER_RE.test(seg.units[k].join(' '));
      }
    }
    return false;
  };

  seg.flat.forEach((u, unitNo) => {
    const sentence = u.text;
    const hits = findNames(sentence, allNames);
    if (!hits.length) return;
    // names are replaced by a token so "Tina Lead" is never read as the role "Team Lead"
    let masked = '';
    let last = 0;
    const tokens: string[] = [];
    hits.forEach((h, i) => { masked += sentence.slice(last, h.start) + `\u0001${i}\u0001`; last = h.end; tokens.push(h.name); });
    masked += sentence.slice(last);
    masked = masked.split('**').join('').split('__').join('');

    // P1: the name has to be somewhere the model was allowed to read it
    for (const h of hits) {
      checked.names++;
      const l = h.name.toLowerCase();
      if (supportLower.includes(l) || priorLower.includes(l) || labels.has(l)) continue;
      flag('name', h.name, unitNo, sentence, 'this person does not appear in any tool result of this turn');
    }

    // groups: names joined only by commas / "and" / "&" share whatever role word is next to the group
    const groups: number[][] = [];
    for (let i = 0; i < hits.length; i++) {
      const prev = groups[groups.length - 1];
      if (prev && /^\s*(?:,|and|&|,\s*and)\s*$/i.test(sentence.slice(hits[prev[prev.length - 1]].end, hits[i].start))) prev.push(i); else groups.push([i]);
    }
    const tokenRe = '\\u0001\\d+\\u0001';
    const roleSrc = `(?:${ROLE_ALT})`;
    for (const g of groups) {
      const first = g[0], lastI = g[g.length - 1];
      const firstTok = `\u0001${first}\u0001`, lastTok = `\u0001${lastI}\u0001`;
      const afterIdx = masked.indexOf(lastTok) + lastTok.length;
      const beforeIdx = masked.indexOf(firstTok);
      const after = masked.slice(afterIdx);
      const before = masked.slice(0, beforeIdx);
      const claimedRoles = new Set<string>();
      // R1a: "Name (APC)" or "Name is the highest TL" / "Name - TL" / "| Name | TL |"
      const am = new RegExp(`^\\s*(?:\\(\\s*|,\\s*|\\s+(?:is|was|are|were|as|becomes|remains|being)\\s+|\\s*[—–|:-]\\s*)(?:(?:a|an|the|our|their|its|his|her)\\s+)?(?:(?:highest|lowest|top|best|worst|current|former|senior|new|only|first|second|third|rated|scoring|performing|ranked)[-\\s]+){0,3}(${roleSrc})`, 'i').exec(after);
      if (am) { const r = roleCodeOf(am[1]); if (r) claimedRoles.add(r); }
      // R1b: "TL Haider Ali" / "the Team Lead, Haider Ali" / "highest TL is Ali Ahmad" / "Among the TLs, Ali"
      const bm = new RegExp(`(${roleSrc})\\s*(?:named|called|is|was|are|:|,|[—–-]|being)?\\s*$`, 'i').exec(before);
      if (bm && !new RegExp(tokenRe).test(before.slice(bm.index + bm[0].length))) { const r = roleCodeOf(bm[1]); if (r) claimedRoles.add(r); }
      for (const r of claimedRoles) {
        for (const i of g) {
          checked.roles++;
          const lab = labels.get(hits[i].name.toLowerCase());
          if (!lab || !lab.roles.size) {
            flag('role', `${hits[i].name} is ${r}`, unitNo, sentence, 'no tool result states this person\'s role');
          } else if (!lab.roles.has(r) && !(r === 'TL' && lab.roles.has('PCTL') && false)) {
            flag('role', `${hits[i].name} is ${r}`, unitNo, sentence, `the tool says ${hits[i].name} is ${[...lab.roles].join('/')}${lab.former ? ' and a FORMER employee' : ''}, not ${r}`);
          }
        }
      }
    }

    // A1: "no score" about someone the tool scored
    if (ABSENT_RE.test(sentence)) {
      for (const h of hits) {
        const l = h.name.toLowerCase();
        const scored = evTexts.some((t) => t.split('\n').some((line) => line.toLowerCase().includes(l) && SCORE_LINE.test(line)));
        if (scored) flag('absence', `${h.name} has no score`, unitNo, sentence, `a tool result printed a composite score for ${h.name}`);
      }
    }

    // S1: status
    for (const h of hits) {
      const lab = labels.get(h.name.toLowerCase());
      if (!lab) continue;
      checked.statuses++;
      const near = sentence.slice(Math.max(0, h.start - 80), Math.min(sentence.length, h.end + 120));
      if (lab.former && !lab.anyActive) {
        if (CURRENT_RE.test(near) && !FORMER_RE.test(near)) {
          flag('status', `${h.name} is a current employee`, unitNo, sentence, `the tool says ${h.name} is a FORMER employee`);
        } else if (!hasFormerMarker(unitNo) && !new RegExp('(?:reports to|managed by|under|manager)[:\\s]+' + esc(h.name), 'i').test(sentence)) {
          flag('status', `${h.name} (former employee) presented without saying so`, unitNo, sentence, `the tool says ${h.name} is a FORMER employee: say so, or leave them out`);
        }
      } else if (lab.seen && !lab.former && new RegExp(`${esc(h.name)}(?:\\s*\\([^)]*\\))?\\s+(?:(?:has|have|had|is|was|already|now|also) )*(?:left\\b|a former\\b|an ex-|no longer\\b|deactivated\\b|resigned\\b|former\\b)`, 'i').test(sentence)) {
        flag('status', `${h.name} is former`, unitNo, sentence, `the tool shows ${h.name} as an ACTIVE employee`);
      }
    }
  });

  return { claims, checked, units: seg.units, seps: seg.seps };
}

function roleCodeOf(phrase: string): string | null {
  const p = phrase.trim();
  for (const [re, code] of ROLE_WORDS) if (new RegExp(`^(?:${re.source})$`, re.flags.includes('i') ? 'i' : '').test(p)) return code;
  return null;
}

// --------------------------------------------------------------------------- the retry and the fallback
export function correctionMessage(claims: Claim[], max = 8): string {
  const lines = claims.slice(0, max).map((c, i) => `${i + 1}. "${c.text}" in: "${c.sentence}" -- ${c.reason}.`);
  return [
    'CHECK FAILED. Your draft contains statements the tool results of this turn do not support:',
    ...lines,
    'Rewrite the WHOLE answer now. Use only facts printed in the tool results above, with the role and the former/current status exactly as the tools print them. Remove or correct each statement above. If a fact is not in the results, say "the tool did not return it" instead of guessing. Keep the citations. Do not mention this check.',
  ].join('\n');
}

export const UNVERIFIED_NOTE = "_I couldn't verify this part against our data, so I've left it out._";

// Replaces each sentence that carries an unsupported claim; the rest of the answer is untouched.
export function redactClaims(answer: string, claims: Claim[]): string {
  if (!claims.length) return answer;
  const seg = segment(String(answer ?? ''));
  const bad = new Set(claims.map((c) => c.unit));
  let unitNo = 0;
  const lines = seg.units.map((u, li) => {
    let out = '';
    u.forEach((s, i) => {
      const hit = bad.has(unitNo++);
      const bullet = i === 0 ? (LINE_MARK.exec(s)?.[0] ?? '') : '';
      out += (i > 0 ? seg.seps[li][i - 1] : '') + (hit ? `${bullet}${UNVERIFIED_NOTE}` : s);
    });
    return out;
  });
  // two notes in a row read as one
  return lines.join('\n').replace(new RegExp(`(?:${esc(UNVERIFIED_NOTE)}\\s*){2,}`, 'g'), `${UNVERIFIED_NOTE} `).replace(/ +\n/g, '\n');
}

export function summarize(v: Verdict, extra: { retried?: boolean; replaced?: boolean } = {}) {
  return {
    checked: v.checked, ungrounded: v.claims.length, retried: !!extra.retried, replaced: !!extra.replaced,
    claims: v.claims.slice(0, 6).map((c) => ({ kind: c.kind, text: c.text.slice(0, 80), reason: c.reason.slice(0, 120) })),
  };
}

// Every person's display name (current and former), for P1 and for finding names in the answer. Cached per
// client for ten minutes; a failed read just means no dictionary (the labels in the tool results still work).
const nameCache = new WeakMap<object, { at: number; names: string[] }>();
// deno-lint-ignore no-explicit-any
export async function personNames(admin: any, nowMs = Date.now()): Promise<string[]> {
  if (!admin || typeof admin !== 'object') return [];
  const hit = nameCache.get(admin);
  if (hit && nowMs - hit.at < 600_000) return hit.names;
  try {
    const { data } = await admin.from('profiles').select('display_name').limit(1000);
    // deno-lint-ignore no-explicit-any
    const names = [...new Set((data || []).map((p: any) => String(p?.display_name || '').trim()).filter((n: string) => n.length >= 4))] as string[];
    nameCache.set(admin, { at: nowMs, names });
    return names;
  } catch { return []; }
}
