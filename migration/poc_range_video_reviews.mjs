import xlsx from 'xlsx';

// New model: user picks a DATE RANGE. For every creator, we number their
// all-time videos (from the file, single source of truth, raw date, no TZ).
// 1st-review list = creators whose 1st-ever video falls in the range;
// 2nd = whose 2nd-ever video falls in the range; 3rd = likewise. A creator
// can appear on more than one list if two milestones land in the window.
const FILE = 'C:/Users/RA_shid/Downloads/Video reviews test file.xlsx';
const START = '2026-07-13';
const END = '2026-07-19';

const wb = xlsx.readFile(FILE, { cellDates: false });
const ws = wb.Sheets[wb.SheetNames[0]];
const aoa = xlsx.utils.sheet_to_json(ws, { header: 1, defval: '', blankrows: true });
const header = (aoa[2] || []).map((h) => String(h).trim());   // header = 3rd row
const ci_name = header.indexOf('Creator name');
const ci_vid = header.indexOf('Video ID');
const ci_time = header.indexOf('Time');
const toDay = (t) => String(t).trim().split(' ')[0].replace(/\//g, '-');
const inRange = (d) => d >= START && d <= END;

const byCreator = new Map();  // name -> Map(videoId -> day)
for (let i = 3; i < aoa.length; i++) {
  const row = aoa[i];
  const name = String(row[ci_name] || '').trim();
  const vid = String(row[ci_vid] || '').trim();
  const day = toDay(row[ci_time]);
  if (!name || !/^\d{4}-\d{2}-\d{2}$/.test(day)) continue;
  let m = byCreator.get(name);
  if (!m) { m = new Map(); byCreator.set(name, m); }
  if (!m.has(vid)) m.set(vid, day);
}

const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const g1 = [], g2 = [], g3 = [];
const multi = [];
for (const [name, m] of byCreator) {
  const days = [...m.values()].sort(cmp);   // all-time, oldest first
  const hits = [];
  if (days[0] && inRange(days[0])) { g1.push(name); hits.push('1st'); }
  if (days[1] && inRange(days[1])) { g2.push(name); hits.push('2nd'); }
  if (days[2] && inRange(days[2])) { g3.push(name); hits.push('3rd'); }
  if (hits.length > 1) multi.push({ name, hits, d: days.slice(0, 3) });
}
g1.sort(); g2.sort(); g3.sort();

// how many creators posted at all in the range (context)
let postedInRange = 0;
for (const [, m] of byCreator) { if ([...m.values()].some(inRange)) postedInRange++; }

console.log(`Range ${START} .. ${END}`);
console.log('creators who posted in range :', postedInRange);
console.log('1st video review :', g1.length);
console.log('2nd video review :', g2.length);
console.log('3rd video review :', g3.length);
console.log('on >1 list (multi-milestone) :', multi.length);
for (const x of multi.slice(0, 12)) console.log(`   ${x.name}  ${x.hits.join('+')}  first3=${x.d.join(',')}`);
