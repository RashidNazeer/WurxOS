import xlsx from 'xlsx';
import { buildDueLists, markSentUpdates, preDoneCount, totalMilestones }
  from '../src/lib/videoReviewQueue.js';

// Simulate daily runs of the file-based video-review queue against the real
// export and assert the invariants: one message per creator per day, strict
// 1->2->3 order, and everyone eventually gets exactly (total - pre-baseline).
const FILE = 'C:/Users/RA_shid/Downloads/Video reviews test file.xlsx';
const START = '2026-07-13';            // the baseline "line"
const RUN_FROM = '2026-07-13';
const RUN_TO = '2026-08-05';           // a bit past the last video so bursts finish

const wb = xlsx.readFile(FILE, { cellDates: false });
const ws = wb.Sheets[wb.SheetNames[0]];
const aoa = xlsx.utils.sheet_to_json(ws, { header: 1, defval: '', blankrows: true });
const header = (aoa[2] || []).map((h) => String(h).trim());
const ci_name = header.indexOf('Creator name');
const ci_vid = header.indexOf('Video ID');
const ci_time = header.indexOf('Time');
const toDay = (t) => String(t).trim().split(' ')[0].replace(/\//g, '-');
const keyOf = (c) => String(c.creator).trim().toLowerCase();

// creator -> Map(videoId -> day)  (dedup by video id, keep per-video dates)
const byCreator = new Map();
for (let i = 3; i < aoa.length; i++) {
  const row = aoa[i];
  const name = String(row[ci_name] || '').trim();
  const vid = String(row[ci_vid] || '').trim();
  const day = toDay(row[ci_time]);
  if (!name || !vid || !/^\d{4}-\d{2}-\d{2}$/.test(day)) continue;
  let m = byCreator.get(name);
  if (!m) { m = new Map(); byCreator.set(name, m); }
  if (!m.has(vid)) m.set(vid, day);
}

const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const addDays = (d, n) => { const t = new Date(d + 'T00:00:00Z'); t.setUTCDate(t.getUTCDate() + n); return t.toISOString().slice(0, 10); };

// Per-creator all-time per-video days (sorted). Full list; we clip to <= runDate each day.
const allTime = new Map(); // name -> string[]
for (const [name, m] of byCreator) allTime.set(name, [...m.values()].sort(cmp));

// Persistent tracker across days: key -> { sentCount, lastSentDate }
const tracker = new Map();
const sentLog = new Map();   // key -> [ '1st@date', '2nd@date', ... ] to check order
let doubleSendViolations = 0;

console.log(`baseline ${START} · runs ${RUN_FROM}..${RUN_TO}\n`);
console.log('date        g1   g2   g3');
for (let T = RUN_FROM; cmp(T, RUN_TO) <= 0; T = addDays(T, 1)) {
  // Build creators visible as of T (videos with day <= T).
  const creators = [];
  for (const [name, days] of allTime) {
    const clipped = days.filter((d) => cmp(d, T) <= 0);
    if (clipped.length) creators.push({ creator: name, days: clipped });
  }
  const { group1, group2, group3 } = buildDueLists({ creators, startDate: START, runDate: T, tracker, keyOf });

  // A creator must never be in two groups on the same day.
  const seen = new Set();
  for (const g of [group1, group2, group3]) for (const n of g) {
    const k = keyOf({ creator: n });
    if (seen.has(k)) doubleSendViolations++;
    seen.add(k);
  }

  // Simulate the user sending all three lists today, then advancing the tracker.
  for (const [gi, g] of [group1, group2, group3].entries()) {
    const ups = markSentUpdates({ creators, group: g, runDate: T, startDate: START, tracker, keyOf });
    for (const u of ups) {
      tracker.set(u.key, { sentCount: u.sentCount, lastSentDate: u.lastSentDate });
      const arr = sentLog.get(u.key) || []; arr.push(`${gi + 1}@${T}`); sentLog.set(u.key, arr);
    }
  }
  if (group1.length || group2.length || group3.length) {
    console.log(`${T}  ${String(group1.length).padStart(3)}  ${String(group2.length).padStart(3)}  ${String(group3.length).padStart(3)}`);
  }
}

// ---- Invariant checks ----
let orderViolations = 0, countMismatch = 0, totalMsgs = 0;
for (const [name, days] of allTime) {
  const k = name.toLowerCase();
  const total = totalMilestones(days);           // min(videoCount, 3)
  const pre = preDoneCount(days, START);          // seeded as already-sent
  const expectSystemMsgs = Math.max(0, total - pre);
  const log = sentLog.get(k) || [];
  totalMsgs += log.length;
  // sent messages must be exactly expectSystemMsgs (given runs went past all milestones)
  if (log.length !== expectSystemMsgs) { countMismatch++; if (countMismatch <= 8) console.log(`  COUNT ${name}: got ${log.length}, expected ${expectSystemMsgs} (total ${total}, preDone ${pre})`); }
  // order must be 1,2,3... and one per distinct date
  const nums = log.map((s) => Number(s.split('@')[0]));
  const dates = log.map((s) => s.split('@')[1]);
  for (let i = 0; i < nums.length; i++) if (nums[i] !== pre + i + 1) { orderViolations++; break; }
  if (new Set(dates).size !== dates.length) { orderViolations++; }
}

console.log('\n=== INVARIANTS ===');
console.log('double-send (same creator, two groups, one day):', doubleSendViolations, doubleSendViolations === 0 ? 'OK' : 'FAIL');
console.log('order/one-per-day violations                   :', orderViolations, orderViolations === 0 ? 'OK' : 'FAIL');
console.log('count mismatches (sent != owed since baseline) :', countMismatch, countMismatch === 0 ? 'OK' : 'FAIL');
console.log('total messages sent across all creators        :', totalMsgs);

// A concrete burst example
for (const name of ['thebidness9', '_twinaesthetics', 'huntingwithhailey']) {
  const k = name.toLowerCase();
  console.log(`  ${name}: videos=${(allTime.get(name) || []).length} preDone=${preDoneCount(allTime.get(name) || [], START)} schedule=[${(sentLog.get(k) || []).join(', ')}]`);
}
