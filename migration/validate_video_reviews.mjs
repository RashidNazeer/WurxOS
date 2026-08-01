import xlsx from 'xlsx';

// Sweep target dates; compare file-derived groups to the KNOWN Euka output
// (Cutler CSVs generated 2026-07-14) to see if the file reproduces Euka.
const FILE = 'C:/Users/RA_shid/Downloads/Video reviews test file.xlsx';

const KNOWN = {
  g1: ['_thepotential_', 'caidennnrecs', 'harlowhousebeauty', 'healthsearcher', 'lifecoachingwithm3', 'sammyyc1', 'victoriaheavenbby'],
  g2: ['alineokayshop', 'dayana_martinez91', 'morsekyle', 'randomelisethough', 'rubyrubes38', 'samswellnessjourney'],
  g3: ['jess_2639', 'luckyfindscrew', 'thirties_withjess'],
};

const wb = xlsx.readFile(FILE, { cellDates: false });
const ws = wb.Sheets[wb.SheetNames[0]];
const aoa = xlsx.utils.sheet_to_json(ws, { header: 1, defval: '', blankrows: true });
const header = (aoa[2] || []).map((h) => String(h).trim());
const ci_handle = header.indexOf('Creator name');
const ci_vid = header.indexOf('Video ID');
const ci_time = header.indexOf('Time');
const toDay = (t) => String(t).trim().split(' ')[0].replace(/\//g, '-');
const norm = (h) => String(h).trim().toLowerCase();

const recs = [];
for (let i = 3; i < aoa.length; i++) {
  const row = aoa[i];
  const handle = norm(row[ci_handle]);
  const vid = String(row[ci_vid] || '').trim();
  const day = toDay(row[ci_time]);
  if (!handle || !/^\d{4}-\d{2}-\d{2}$/.test(day)) continue;
  recs.push({ handle, vid, day });
}

const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const addDays = (d, n) => { const t = new Date(d + 'T00:00:00Z'); t.setUTCDate(t.getUTCDate() + n); return t.toISOString().slice(0, 10); };
const maxDate = (...ds) => ds.filter(Boolean).sort(cmp).slice(-1)[0];

function groupsFor(target) {
  const byCreator = new Map();
  for (const r of recs) {
    if (r.day > target) continue;
    let m = byCreator.get(r.handle);
    if (!m) { m = new Map(); byCreator.set(r.handle, m); }
    if (!m.has(r.vid)) m.set(r.vid, r.day);
  }
  const g1 = [], g2 = [], g3 = [];
  for (const [handle, m] of byCreator) {
    const days = [...m.values()].sort(cmp);
    const D1 = days[0], D2 = days[1], D3 = days[2];
    const s1 = D1 || null;
    const s2 = D2 ? maxDate(D2, addDays(s1, 1)) : null;
    const s3 = D3 ? maxDate(D3, addDays(s2, 1)) : null;
    if (s1 === target) g1.push(handle);
    else if (s2 === target) g2.push(handle);
    else if (s3 === target) g3.push(handle);
  }
  return { g1: g1.sort(), g2: g2.sort(), g3: g3.sort() };
}

const setEq = (a, b) => { const B = new Set(b); return a.length === b.length && a.every((x) => B.has(x)); };
const overlap = (a, b) => { const B = new Set(b); return a.filter((x) => B.has(x)).length; };

console.log('target      g1(match/known/got)   g2                 g3                 exact?');
for (let d = 8; d <= 16; d++) {
  const target = `2026-07-${String(d).padStart(2, '0')}`;
  const g = groupsFor(target);
  const o1 = overlap(g.g1, KNOWN.g1), o2 = overlap(g.g2, KNOWN.g2), o3 = overlap(g.g3, KNOWN.g3);
  const exact = setEq(g.g1, KNOWN.g1) && setEq(g.g2, KNOWN.g2) && setEq(g.g3, KNOWN.g3);
  console.log(
    `${target}   g1 ${o1}/${KNOWN.g1.length}/${g.g1.length}      g2 ${o2}/${KNOWN.g2.length}/${g.g2.length}      g3 ${o3}/${KNOWN.g3.length}/${g.g3.length}     ${exact ? 'YES ***' : ''}`,
  );
}

// Detail for the best-matching date
const T = '2026-07-10';
const g = groupsFor(T);
console.log(`\n=== detail for ${T} ===`);
for (const k of ['g1', 'g2', 'g3']) {
  const got = new Set(g[k]); const known = new Set(KNOWN[k]);
  const missing = KNOWN[k].filter((x) => !got.has(x));
  const extra = g[k].filter((x) => !known.has(x));
  console.log(`${k}: got ${g[k].length}, known ${KNOWN[k].length}, missing=[${missing.join(', ')}] extra=[${extra.join(', ')}]`);
}
