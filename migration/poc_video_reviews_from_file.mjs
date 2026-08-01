import xlsx from 'xlsx';

// READ-ONLY proof-of-concept: reproduce the video-review-targets algorithm
// from the uploaded TikTok "all videos" export instead of Euka, for a target.
const FILE = 'C:/Users/RA_shid/Downloads/Video reviews test file.xlsx';
const TARGET = '2026-07-19';
const MISSED = [];   // none for this run

// ---- load as array-of-arrays; row 0 = banner, row 1 = header, row 2+ = data ----
const wb = xlsx.readFile(FILE, { cellDates: false });
const ws = wb.Sheets[wb.SheetNames[0]];
const aoa = xlsx.utils.sheet_to_json(ws, { header: 1, defval: '', blankrows: true });
// row 0 = date-range banner, row 1 = blank, row 2 = header, row 3+ = data
const HEADER_ROW = 2, DATA_START = 3;
const header = (aoa[HEADER_ROW] || []).map((h) => String(h).trim());
console.log('Detected header:', JSON.stringify(header.slice(0, 6)), '...');
const col = (name) => header.indexOf(name);
const ci_handle = col('Creator name');
const ci_vid = col('Video ID');
const ci_time = col('Time');
console.log('col idx  handle:', ci_handle, ' video:', ci_vid, ' time:', ci_time);

const toDay = (t) => {
  const s = String(t).trim();
  const datePart = s.split(' ')[0];           // "2026/07/31 11:01:05" -> "2026/07/31"
  return datePart.replace(/\//g, '-');        // -> "2026-07-31"
};
const recs = [];
for (let i = DATA_START; i < aoa.length; i++) {
  const row = aoa[i];
  const handle = String(row[ci_handle] || '').trim();
  const vid = String(row[ci_vid] || '').trim();
  const day = toDay(row[ci_time]);
  if (!handle || !/^\d{4}-\d{2}-\d{2}$/.test(day)) continue;
  recs.push({ handle, vid, day });
}

// ---- basic shape ----
const allDays = recs.map((r) => r.day).sort();
const minDay = allDays[0], maxDay = allDays[allDays.length - 1];
const uniqCreators = new Set(recs.map((r) => r.handle));
const uniqVideos = new Set(recs.map((r) => r.vid));
const beyondTarget = recs.filter((r) => r.day > TARGET).length;
console.log('=== FILE SHAPE ===');
console.log('rows kept        :', recs.length);
console.log('unique creators  :', uniqCreators.size);
console.log('unique video ids :', uniqVideos.size);
console.log('post-day range   :', minDay, '->', maxDay);
console.log('rows AFTER target:', beyondTarget, `(post-day > ${TARGET})`);

// videos-per-day around the target
const perDay = {};
for (const r of recs) perDay[r.day] = (perDay[r.day] || 0) + 1;
const around = Object.keys(perDay).filter((d) => d >= '2026-07-14' && d <= '2026-07-22').sort();
console.log('videos/day 07-14..07-22:', around.map((d) => `${d}:${perDay[d]}`).join('  '));

// ---- per-creator video days (dedup by video id), oldest first, <= target ----
const byCreator = new Map();
for (const r of recs) {
  if (r.day > TARGET) continue;               // ignore future-dated rows for grouping
  let m = byCreator.get(r.handle);
  if (!m) { m = new Map(); byCreator.set(r.handle, m); }
  if (!m.has(r.vid)) m.set(r.vid, r.day);
}

// ---- the send-date algorithm (ported from the edge function) ----
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const addDays = (d, n) => { const t = new Date(d + 'T00:00:00Z'); t.setUTCDate(t.getUTCDate() + n); return t.toISOString().slice(0, 10); };
const maxDate = (...ds) => ds.filter(Boolean).sort(cmp).slice(-1)[0];
const isMissed = (d) => MISSED.includes(d);
const firstRunOnOrAfter = (d) => { let x = d; while (isMissed(x)) x = addDays(x, 1); return x; };

const group1 = [], group2 = [], group3 = [];
const boundaryRisk = [];   // earliest-in-file video sits at/near the left edge -> true 1st video may predate the file
const LEFT_EDGE_BUFFER = addDays(minDay, 3);   // within 3 days of the file's start

for (const [handle, m] of byCreator) {
  const days = [...m.values()].sort(cmp);
  const D1 = days[0], D2 = days[1], D3 = days[2];
  const s1 = D1 ? firstRunOnOrAfter(D1) : null;
  const s2 = D2 ? firstRunOnOrAfter(maxDate(D2, addDays(s1, 1))) : null;
  const s3 = D3 ? firstRunOnOrAfter(maxDate(D3, addDays(s2, 1))) : null;
  let grp = 0;
  if (s1 === TARGET) { group1.push(handle); grp = 1; }
  else if (s2 === TARGET) { group2.push(handle); grp = 2; }
  else if (s3 === TARGET) { group3.push(handle); grp = 3; }
  if (grp && D1 <= LEFT_EDGE_BUFFER) boundaryRisk.push({ handle, grp, D1, D2, D3, total: days.length });
}
group1.sort(); group2.sort(); group3.sort();

console.log('\n=== VIDEO-REVIEW GROUPS for', TARGET, '(missed:', JSON.stringify(MISSED) + ') ===');
console.log('1st video review:', group1.length, '->', group1.slice(0, 12).join(', ') + (group1.length > 12 ? ' …' : ''));
console.log('2nd video review:', group2.length, '->', group2.slice(0, 12).join(', ') + (group2.length > 12 ? ' …' : ''));
console.log('3rd video review:', group3.length, '->', group3.slice(0, 12).join(', ') + (group3.length > 12 ? ' …' : ''));

console.log('\n=== HISTORY-DEPTH RISK ===');
console.log('These grouped creators have their EARLIEST in-file video within 3 days of the file start');
console.log(`(${minDay}), so their true first video could predate the export and the group may be wrong:`);
console.log('count:', boundaryRisk.length);
for (const b of boundaryRisk.slice(0, 15)) console.log(`  g${b.grp}  ${b.handle}  D1=${b.D1} total-in-file=${b.total}`);
