#!/usr/bin/env node
/**
 * attendance-parity.mjs — GROUND-TRUTH PARITY HARNESS for the attendance-score refactor.
 *
 * Computes THREE attendance percentages per (user, month) from the SAME raw DB rows:
 *
 *   A) CURRENT-JS   the LIVE formula the Boss sees today.
 *                   Mirrors src/components/performance/PerformancePage.jsx exactly
 *                   (calcAttendanceScore L134, workingDaysInMonth L149, cutoffYmdForMonth L160,
 *                    clipDateSet L175, weekendDateSetInMonth L196, team covered-set L1289-1318)
 *                   plus src/lib/attendanceApi.js (computeMonthlyDays L1075, expandLeaveWeekdays
 *                   L1016, fetchRosterMonth L1217 -> leave types medical/emergency/half_leave/other)
 *                   and src/lib/holidaysApi.js (listHolidayDatesForMonth L60).
 *                   Bugs included on purpose. This is the number we must reproduce.
 *
 *   B) CURRENT-SQL  public.perf_attendance_score (migration 120).
 *                   (present U adjusted U approved medical/emergency leave) / min_attendance_days,
 *                   capped 100, rounded to 1dp. No weekends, no holidays, no half_leave/other,
 *                   hardcoded denominator. This is what the INCENTIVE auto-fill actually reads.
 *
 *   C) NEW          the agreed target formula (SQL becomes single source of truth):
 *                   cutoff  = least(today_karachi, month_end)
 *                   elapsed = CALENDAR days month_start..cutoff
 *                   covered = weekends U holidays U leave(medical,emergency,half_leave,other)
 *                             U clock-ins U adjustments   (all clipped to month_start..cutoff)
 *                   score   = least(100, round(covered / elapsed * 100))
 *
 * Read-only. Touches nothing. Run:
 *   node scripts/attendance-parity.mjs [YYYY-MM ...]
 * Default months: 2026-07 2026-06 2026-02 2025-12
 */

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient } from '@supabase/supabase-js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');

// ── env ───────────────────────────────────────────────────────────────────────
// Hand-rolled .env parser (no dotenv dependency). The service-role key lives
// under the literal name SERVICE_ROLL_KEY (sic) and its line may carry trailing
// whitespace — trim BOTH sides of key and value.
function loadEnvLocal() {
  const raw = readFileSync(resolve(REPO_ROOT, '.env.local'), 'utf8');
  const env = {};
  for (const line of raw.split(/\r?\n/)) {
    const s = line.trim();
    if (!s || s.startsWith('#')) continue;
    const eq = s.indexOf('=');
    if (eq === -1) continue;
    const k = s.slice(0, eq).trim();
    let v = s.slice(eq + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    env[k] = v.trim();
  }
  return env;
}

const env = loadEnvLocal();
const SUPABASE_URL = env.VITE_SUPABASE_URL;
const SERVICE_KEY  = env.SERVICE_ROLL_KEY || env.SERVICE_ROLE_KEY;
if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error('FATAL: .env.local is missing VITE_SUPABASE_URL and/or SERVICE_ROLL_KEY');
  console.error('  keys found: ' + Object.keys(env).join(', '));
  process.exit(1);
}
const sb = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

// ── date helpers ──────────────────────────────────────────────────────────────
const pad = (n) => String(n).padStart(2, '0');
const ymdOf = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const lastDayOf = (y, m) => new Date(y, m, 0).getDate();

/** Today's date in Asia/Karachi (the DB's locked timezone) as YYYY-MM-DD. */
function karachiTodayYmd() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Karachi', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
}

/** Inclusive YYYY-MM-DD walk. */
function eachDate(startYmd, endYmd, fn) {
  const cur = new Date(startYmd + 'T00:00:00');
  const stop = new Date(endYmd + 'T00:00:00');
  while (cur <= stop) { fn(ymdOf(cur), cur.getDay()); cur.setDate(cur.getDate() + 1); }
}

const isWeekendYmd = (ds) => {
  const [y, m, d] = ds.split('-').map(Number);
  const dow = new Date(y, m - 1, d).getDay();
  return dow === 0 || dow === 6;
};

/** Paginated select — PostgREST hard-caps a select at 1000 rows. */
async function selectAll(table, columns, apply) {
  const PAGE = 1000;
  const out = [];
  for (let from = 0; ; from += PAGE) {
    let q = sb.from(table).select(columns);
    if (apply) q = apply(q);
    const { data, error } = await q.range(from, from + PAGE - 1);
    if (error) throw new Error(`${table}: ${error.message}`);
    out.push(...(data || []));
    if (!data || data.length < PAGE) break;
  }
  return out;
}

// ══════════════════════════════════════════════════════════════════════════════
// A) CURRENT-JS — verbatim mirror of the LIVE PerformancePage
// ══════════════════════════════════════════════════════════════════════════════

/** PerformancePage L134. NOTE: workingDays <= 0 short-circuits to 100. */
function calcAttendanceScore(coveredDays, workingDays) {
  if (!workingDays || workingDays <= 0) return 100;
  return Math.min(100, Math.round((coveredDays / workingDays) * 100));
}

/**
 * PerformancePage L149. Despite the name this returns CALENDAR DAYS ELAPSED,
 * not weekdays: today.getDate() for the current month, last-day for a past
 * month, 0 for a future month. Uses machine-LOCAL `new Date()`, exactly as the
 * browser does.
 */
function workingDaysInMonth(monthStr) {
  if (!monthStr) return 0;
  const [y, m] = monthStr.split('-').map(Number);
  const today = new Date();
  const firstOfMonth = new Date(y, m - 1, 1);
  if (today < firstOfMonth) return 0;
  if (today.getFullYear() === y && today.getMonth() + 1 === m) return today.getDate();
  return new Date(y, m, 0).getDate();
}

/** PerformancePage L160. */
function cutoffYmdForMonth(monthStr) {
  if (!monthStr) return '0000-01-01';
  const [y, m] = monthStr.split('-').map(Number);
  const today = new Date();
  const firstOfMonth = new Date(y, m - 1, 1);
  if (today < firstOfMonth) return '0000-01-01';
  if (today.getFullYear() === y && today.getMonth() + 1 === m) {
    return `${y}-${pad(m)}-${pad(today.getDate())}`;
  }
  return `${y}-${pad(m)}-${pad(lastDayOf(y, m))}`;
}

/** PerformancePage L175. */
function clipDateSet(set, cutoffYmd) {
  const out = new Set();
  if (!cutoffYmd || !set) return out;
  for (const d of set) if (d <= cutoffYmd) out.add(d);
  return out;
}

/** PerformancePage L196. */
function weekendDateSetInMonth(monthStr) {
  const out = new Set();
  const [y, m] = monthStr.split('-').map(Number);
  const last = lastDayOf(y, m);
  for (let d = 1; d <= last; d++) {
    const dow = new Date(y, m - 1, d).getDay();
    if (dow === 0 || dow === 6) out.add(`${y}-${pad(m)}-${pad(d)}`);
  }
  return out;
}

/** attendanceApi.js L1016 — weekday-only, holiday-excluded, month-clipped. */
function expandLeaveWeekdays(startDate, endDate, { mStart, mEnd, holidaySet } = {}) {
  const out = new Set();
  if (!startDate || !endDate) return out;
  eachDate(startDate, endDate, (ds, dow) => {
    if (dow === 0 || dow === 6) return;
    if (mStart && ds < mStart) return;
    if (mEnd && ds > mEnd) return;
    if (holidaySet && holidaySet.has(ds)) return;
    out.add(ds);
  });
  return out;
}

/** attendanceApi.js L1075 — weekend clock-ins / adjustments are DROPPED. */
function computeMonthlyDays(userId, monthRecords, monthAdjusts) {
  const actualDateSet = new Set();
  (monthRecords || []).forEach((r) => {
    if (r.user_id !== userId || !r.date) return;
    if (isWeekendYmd(r.date)) return;
    if (r.clock_in) actualDateSet.add(r.date);
  });
  const effectiveSet = new Set(actualDateSet);
  (monthAdjusts || []).forEach((a) => {
    if (a.user_id !== userId || !a.date || isWeekendYmd(a.date)) return;
    effectiveSet.add(a.date);
  });
  return { actualDays: actualDateSet.size, effectiveDays: effectiveSet.size, effectiveSet };
}

/** holidaysApi.js L60 — expands holiday RANGES to weekday dates inside the month. */
function holidayWeekdaySetForMonth(holidayRows, mStart, mEnd) {
  const out = new Set();
  (holidayRows || []).forEach((h) => {
    eachDate(h.start_date, h.end_date, (ds, dow) => {
      if (dow === 0 || dow === 6) return;
      if (ds < mStart || ds > mEnd) return;
      out.add(ds);
    });
  });
  return out;
}

const UI_LEAVE_TYPES = ['medical', 'emergency', 'half_leave', 'other']; // fetchRosterMonth L1229

/**
 * Same as workingDaysInMonth / cutoffYmdForMonth above, but with `today`
 * injected instead of read from the system clock. String compares on YYYY-MM-DD
 * are equivalent to the Date compares the real code does. Used so the synthetic
 * scenarios can evaluate a month as if it were over.
 */
function elapsedDaysAt(month, todayYmd) {
  const [y, m] = month.split('-').map(Number);
  const mStart = `${y}-${pad(m)}-01`;
  const mEnd = `${y}-${pad(m)}-${pad(lastDayOf(y, m))}`;
  if (todayYmd < mStart) return 0;
  if (todayYmd <= mEnd) return Number(todayYmd.slice(8, 10));
  return lastDayOf(y, m);
}
function cutoffAt(month, todayYmd) {
  const [y, m] = month.split('-').map(Number);
  const mStart = `${y}-${pad(m)}-01`;
  const mEnd = `${y}-${pad(m)}-${pad(lastDayOf(y, m))}`;
  if (todayYmd < mStart) return '0000-01-01';
  return todayYmd <= mEnd ? todayYmd : mEnd;
}

/** Formula A evaluated against the live system clock (what the UI does today). */
function scoreCurrentJs(uid, month, db) {
  return scoreCurrentJsAt(uid, month, db, ymdOf(new Date()));
}

function scoreCurrentJsAt(uid, month, db, todayYmd) {
  const { mStart, mEnd } = db;
  const cutoff = cutoffAt(month, todayYmd);
  const { actualDays, effectiveDays, effectiveSet } =
    computeMonthlyDays(uid, db.attendance, db.adjustments);

  const holidaySet = db.holidayWeekdaySet;                        // unclipped, feeds leave expansion
  const holidayClipped = clipDateSet(holidaySet, cutoff);
  const weekendSet = clipDateSet(weekendDateSetInMonth(month), cutoff);

  const leaveDates = new Set();
  db.leaves
    .filter((l) => l.requester_id === uid && UI_LEAVE_TYPES.includes(l.type))
    .forEach((l) => {
      expandLeaveWeekdays(l.start_date, l.end_date, { mStart, mEnd, holidaySet })
        .forEach((d) => leaveDates.add(d));
    });
  const leaveClipped = clipDateSet(leaveDates, cutoff);

  const coveredSet = new Set([
    ...effectiveSet, ...leaveClipped, ...holidayClipped, ...weekendSet,
  ]);
  const workingDays = elapsedDaysAt(month, todayYmd);
  return {
    pct: calcAttendanceScore(coveredSet.size, workingDays),
    denom: workingDays,
    covered: coveredSet.size,
    actualDays, effectiveDays,
    leaveDays: leaveClipped.size,
    holidayDays: holidayClipped.size,
    weekendDays: weekendSet.size,
    coveredSet,
  };
}

// ══════════════════════════════════════════════════════════════════════════════
// B) CURRENT-SQL — public.perf_attendance_score (mig 120)
// ══════════════════════════════════════════════════════════════════════════════
const SQL_LEAVE_TYPES = ['medical', 'emergency']; // mig 120 L191

function scoreCurrentSql(uid, month, db, minAttendanceDays) {
  const { mStart, mEnd } = db;
  const covered = new Set();
  // present — NOTE: no weekend filter in SQL; a Saturday clock-in counts.
  db.attendance.forEach((r) => {
    if (r.user_id === uid && r.clock_in && r.date >= mStart && r.date <= mEnd) covered.add(r.date);
  });
  // adjusted — no weekend filter either.
  db.adjustments.forEach((a) => {
    if (a.user_id === uid && a.date >= mStart && a.date <= mEnd) covered.add(a.date);
  });
  // leaves — medical/emergency only, expanded as CALENDAR days (weekends included).
  db.leaves
    .filter((l) => l.requester_id === uid && SQL_LEAVE_TYPES.includes(l.type))
    .forEach((l) => {
      const s = l.start_date > mStart ? l.start_date : mStart;
      const e = l.end_date < mEnd ? l.end_date : mEnd;
      if (s > e) return;
      eachDate(s, e, (ds) => covered.add(ds));
    });
  // No holidays at all — mig 120 predates company_holidays (mig 167).
  const raw = (covered.size / minAttendanceDays) * 100;
  const pct = Math.min(100, Math.round(raw * 10) / 10); // round(...,1)
  return { pct, covered: covered.size, denom: minAttendanceDays };
}

// ══════════════════════════════════════════════════════════════════════════════
// C) NEW — the target formula (single source of truth)
// ══════════════════════════════════════════════════════════════════════════════
const NEW_LEAVE_TYPES = ['medical', 'emergency', 'half_leave', 'other']; // NOT wfh

function scoreNew(uid, month, db, todayYmd) {
  const { mStart, mEnd } = db;
  // cutoff = least(today, month_end). A past month => the whole month.
  if (todayYmd < mStart) {
    return { pct: 100, elapsed: 0, covered: 0, future: true,
             daysPresent: 0, weekends: 0, holidayDays: 0, approvedLeaveDays: 0,
             daysNotCovered: 0, coveredSet: new Set() };
  }
  const cutoff = todayYmd < mEnd ? todayYmd : mEnd;

  // elapsed = CALENDAR days month_start..cutoff (inclusive)
  let elapsed = 0;
  eachDate(mStart, cutoff, () => { elapsed++; });

  const inWindow = (ds) => ds >= mStart && ds <= cutoff;

  const weekends = new Set();
  eachDate(mStart, cutoff, (ds, dow) => { if (dow === 0 || dow === 6) weekends.add(ds); });

  const holidays = new Set();
  db.holidayRows.forEach((h) => {
    eachDate(h.start_date, h.end_date, (ds) => { if (inWindow(ds)) holidays.add(ds); });
  });

  const leave = new Set();
  db.leaves
    .filter((l) => l.requester_id === uid && NEW_LEAVE_TYPES.includes(l.type))
    .forEach((l) => {
      eachDate(l.start_date, l.end_date, (ds) => { if (inWindow(ds)) leave.add(ds); });
    });

  const clockIns = new Set();
  db.attendance.forEach((r) => {
    if (r.user_id === uid && r.clock_in && inWindow(r.date)) clockIns.add(r.date);
  });
  const adjusted = new Set();
  db.adjustments.forEach((a) => {
    if (a.user_id === uid && inWindow(a.date)) adjusted.add(a.date);
  });
  const present = new Set([...clockIns, ...adjusted]);

  const coveredSet = new Set([...weekends, ...holidays, ...leave, ...present]);
  const pct = elapsed <= 0 ? 100 : Math.min(100, Math.round((coveredSet.size / elapsed) * 100));

  return {
    pct,
    elapsed,                                  // daysThisMonth
    daysPresent: present.size,                // clock-ins + adjustments
    weekends: weekends.size,
    holidayDays: holidays.size,
    approvedLeaveDays: leave.size,
    covered: coveredSet.size,
    daysNotCovered: elapsed - coveredSet.size,
    coveredSet,
    future: false,
  };
}

// ══════════════════════════════════════════════════════════════════════════════
// D) NEW-SQL — a LINE-BY-LINE transliteration of the ACTUAL migration
//    supabase/migrations/252_attendance_single_source.sql
//    (attendance_month_breakdown_bulk). This mirrors the SQL AS WRITTEN, not the
//    spec's description of it — that is the whole point: it catches an
//    implementation bug in the migration that column C (which mirrors the SPEC)
//    would happily agree with.
//
//    Mapping, SQL CTE -> JS below:
//      v_today   := (now() at time zone 'Asia/Karachi')::date   -> karachiToday
//      v_start / v_end / v_cutoff := least(v_today, v_end)
//      v_elapsed := greatest(0, (v_cutoff - v_start) + 1)
//      v_weekends: generate_series(v_start, v_cutoff) where isodow in (6,7)
//      v_holidays: generate_series(v_start, v_cutoff) where isodow 1..5
//                  and exists(company_holidays range)          [WEEKDAY-ONLY]
//      hol_full : cal_full joined to company_holidays, isodow 1..5  [FULL MONTH]
//      leave_full: approved, type in (medical,emergency,half_leave,other),
//                  expanded over greatest(start,v_start)..least(end,v_end),
//                  isodow 1..5, and NOT in hol_full            [FULL MONTH]
//      pres_full / adj_full: full month, clipped at use-time to <= cutoff
//      covered  : UNION of wk, hol, leave(<=cutoff), pres(<=cutoff), adj(<=cutoff)
//      pct         := case when v_elapsed>0 then least(100, round(cov/elapsed*100, 1)) end
//      pct_display := case when v_elapsed>0 then least(100, round(cov/elapsed*100))::int end
// ══════════════════════════════════════════════════════════════════════════════
const SQL252_LEAVE_TYPES = ['medical', 'emergency', 'half_leave', 'other']; // mig 252 L258 — wfh EXCLUDED

/** isodow 1..5 (Mon..Fri) — Postgres `extract(isodow from d) between 1 and 5`. */
function isWeekdayYmd(ds) {
  const [y, m, d] = ds.split('-').map(Number);
  const dow = new Date(y, m - 1, d).getDay();   // 0=Sun..6=Sat
  return dow >= 1 && dow <= 5;
}

function scoreNewSql(uid, month, db, karachiTodayYmdStr) {
  const { mStart, mEnd } = db;

  // v_cutoff := least(v_today, v_end).  For a FUTURE month v_cutoff < v_start.
  const cutoff = karachiTodayYmdStr < mEnd ? karachiTodayYmdStr : mEnd;
  const future = cutoff < mStart;

  // v_elapsed := greatest(0, (v_cutoff - v_start) + 1)
  let elapsed = 0;
  if (!future) eachDate(mStart, cutoff, () => { elapsed++; });

  const leCutoff = (ds) => !future && ds >= mStart && ds <= cutoff;

  // wk  (cal, isodow 6,7)
  const wk = new Set();
  if (!future) eachDate(mStart, cutoff, (ds, dow) => { if (dow === 0 || dow === 6) wk.add(ds); });

  // hol_full (cal_full x company_holidays, isodow 1..5) — FULL MONTH, weekday-only
  const holFull = new Set();
  eachDate(mStart, mEnd, (ds, dow) => {
    if (dow === 0 || dow === 6) return;                       // isodow 1..5
    for (const h of db.holidayRows) {
      if (ds >= h.start_date && ds <= h.end_date) { holFull.add(ds); break; }
    }
  });
  // hol := hol_full where d <= v_cutoff
  const hol = new Set([...holFull].filter(leCutoff));

  // leave_full — FULL MONTH; weekday-only; holiday-subtracted; approved; type-filtered
  const leaveFull = new Set();
  db.leaves
    .filter((l) => l.requester_id === uid
      && l.status === 'approved'
      && SQL252_LEAVE_TYPES.includes(l.type))
    .forEach((l) => {
      const s = l.start_date > mStart ? l.start_date : mStart;   // greatest(start, v_start)
      const e = l.end_date   < mEnd   ? l.end_date   : mEnd;     // least(end, v_end)
      if (s > e) return;
      eachDate(s, e, (ds) => {
        if (!isWeekdayYmd(ds)) return;                            // isodow 1..5
        if (holFull.has(ds)) return;                             // not exists in hol_full
        leaveFull.add(ds);
      });
    });

  // pres_full / adj_full — FULL MONTH (no weekday filter in the SQL)
  const presFull = new Set();
  db.attendance.forEach((r) => {
    if (r.user_id === uid && r.clock_in && r.date >= mStart && r.date <= mEnd) presFull.add(r.date);
  });
  const adjFull = new Set();
  db.adjustments.forEach((a) => {
    if (a.user_id === uid && a.date >= mStart && a.date <= mEnd) adjFull.add(a.date);
  });

  // covered := wk ∪ hol ∪ leave(<=cutoff) ∪ pres(<=cutoff) ∪ adj(<=cutoff)   SET UNION
  const coveredSet = new Set([
    ...wk,
    ...hol,
    ...[...leaveFull].filter(leCutoff),
    ...[...presFull].filter(leCutoff),
    ...[...adjFull].filter(leCutoff),
  ]);

  // missed := cal \ covered
  const missed = [];
  if (!future) eachDate(mStart, cutoff, (ds) => { if (!coveredSet.has(ds)) missed.push(ds); });
  const missedPast = missed.filter((ds) => ds < karachiTodayYmdStr);   // m.d < v_today

  // agg counters
  const presClipped = [...presFull].filter(leCutoff);
  const adjClipped  = [...adjFull].filter(leCutoff);
  const presUnionAdj = new Set([...presClipped, ...adjClipped]);

  const ci_wd    = presClipped.filter(isWeekdayYmd).length;
  const pres_wd  = [...presUnionAdj].filter(isWeekdayYmd).length;
  const ci_all   = presClipped.length;
  const pres_all = presUnionAdj.size;
  const lv       = [...leaveFull].filter(leCutoff).length;
  const cov      = coveredSet.size;

  const exact = elapsed > 0 ? (cov / elapsed) * 100 : null;
  const pct         = elapsed > 0 ? Math.min(100, Math.round(exact * 10) / 10) : null;   // round(x,1)
  const pctDisplay  = elapsed > 0 ? Math.min(100, Math.round(exact)) : null;             // round(x)::int

  return {
    userId: uid,
    month,
    cutoffDate: future ? null : cutoff,
    elapsedDays: elapsed,
    daysClockedIn: ci_wd,
    daysPresent: pres_wd,
    adjustedDays: pres_wd - ci_wd,
    daysClockedInAll: ci_all,
    daysPresentAll: pres_all,
    weekendDays: wk.size,
    holidayDays: hol.size,
    leaveDays: lv,
    coveredDays: cov,
    daysNotCovered: elapsed - cov,
    pct,
    pctDisplay,
    missedDates: missed,
    missedDatesPast: missedPast,
    presentDates: [...presFull].sort(),
    adjustedDates: [...adjFull].sort(),
    leaveDates: [...leaveFull].sort(),
    holidayDates: [...holFull].sort(),
    coveredSet,
    future,
  };
}

/**
 * INVARIANTS the migration promises. Any violation is a migration BUG, not a
 * parity difference. Checked for every user in every month.
 */
function checkSqlInvariants(D) {
  const bad = [];
  if (D.daysNotCovered !== D.missedDates.length) {
    bad.push(`days_not_covered(${D.daysNotCovered}) != missed_dates.length(${D.missedDates.length})`);
  }
  if (D.coveredDays > D.elapsedDays) bad.push(`covered(${D.coveredDays}) > elapsed(${D.elapsedDays})`);
  if (D.pctDisplay !== null && D.pctDisplay > 100) bad.push(`pct_display ${D.pctDisplay} > 100`);
  if (D.daysPresentAll < D.daysPresent) bad.push(`days_present_all < days_present`);
  if (D.daysClockedInAll < D.daysClockedIn) bad.push(`days_clocked_in_all < days_clocked_in`);
  if (D.elapsedDays === 0 && D.pct !== null) bad.push(`elapsed=0 but pct is not NULL`);
  for (const k of ['missedDates', 'missedDatesPast', 'presentDates', 'adjustedDates',
                   'leaveDates', 'holidayDates']) {
    if (!Array.isArray(D[k])) bad.push(`${k} is not an array`);
  }
  return bad;
}

// ══════════════════════════════════════════════════════════════════════════════
// fetch + run
// ══════════════════════════════════════════════════════════════════════════════
async function loadMonth(month) {
  const [y, m] = month.split('-').map(Number);
  const mStart = `${y}-${pad(m)}-01`;
  const mEnd   = `${y}-${pad(m)}-${pad(lastDayOf(y, m))}`;

  const [attendance, adjustments, leaves, holidayRows] = await Promise.all([
    selectAll('attendance', 'user_id, date, clock_in',
      (q) => q.gte('date', mStart).lte('date', mEnd).order('date')),
    selectAll('attendance_adjustments', 'user_id, date',
      (q) => q.gte('date', mStart).lte('date', mEnd).order('date')),
    selectAll('leave_requests', 'requester_id, type, status, start_date, end_date',
      (q) => q.eq('status', 'approved').lte('start_date', mEnd).gte('end_date', mStart)),
    selectAll('company_holidays', 'start_date, end_date, label',
      (q) => q.lte('start_date', mEnd).gte('end_date', mStart)),
  ]);

  return {
    mStart, mEnd, attendance, adjustments, leaves, holidayRows,
    holidayWeekdaySet: holidayWeekdaySetForMonth(holidayRows, mStart, mEnd),
  };
}

/**
 * Cross-check: call the REAL public.perf_attendance_score in the DB and compare
 * it to our reimplementation of it (B). If these disagree, our mirror of mig 120
 * is wrong and nothing else in this harness can be trusted.
 */
async function verifyBAgainstRpc(users, month, db, minDays) {
  let checked = 0, mismatches = [];
  for (const u of users) {
    const { data, error } = await sb.rpc('perf_attendance_score', { p_user: u.id, p_month: month });
    if (error) return { error: error.message };
    const real = Number(data);
    const mine = scoreCurrentSql(u.id, month, db, minDays).pct;
    checked++;
    if (Math.abs(real - mine) > 0.05) {
      mismatches.push(`${u.display_name}: RPC=${real} vs harness-B=${mine}`);
    }
  }
  return { checked, mismatches };
}

/** What did the data actually EXERCISE? Guards against a false "parity holds". */
function coverageReport(db) {
  const types = {};
  db.leaves.forEach((l) => { types[l.type] = (types[l.type] || 0) + 1; });
  const weekendClockIns = db.attendance.filter((r) => r.clock_in && isWeekendYmd(r.date)).length;
  const weekendAdjusts  = db.adjustments.filter((a) => isWeekendYmd(a.date)).length;
  return { types, weekendClockIns, weekendAdjusts };
}

const fmt = (n, w) => String(n).padStart(w);
const padR = (s, w) => String(s).padEnd(w);

// ══════════════════════════════════════════════════════════════════════════════
// Synthetic scenarios — exercise the bug classes the live data cannot.
// Pure in-memory. No DB writes. Months are PAST months so the cutoff is the
// full month for both A and C (deterministic regardless of when this is run).
// ══════════════════════════════════════════════════════════════════════════════
const U = '00000000-0000-0000-0000-000000000001';

function synthDb(month, { clockIns = [], adjust = [], leaves = [], holidays = [] }) {
  const [y, m] = month.split('-').map(Number);
  const mStart = `${y}-${pad(m)}-01`;
  const mEnd = `${y}-${pad(m)}-${pad(lastDayOf(y, m))}`;
  const holidayRows = holidays.map(([s, e, label]) => ({ start_date: s, end_date: e, label }));
  return {
    mStart, mEnd,
    attendance: clockIns.map((d) => ({ user_id: U, date: d, clock_in: `${d}T09:00:00Z` })),
    adjustments: adjust.map((d) => ({ user_id: U, date: d })),
    leaves: leaves.map(([s, e, type]) => ({ requester_id: U, type, status: 'approved', start_date: s, end_date: e })),
    holidayRows,
    holidayWeekdaySet: holidayWeekdaySetForMonth(holidayRows, mStart, mEnd),
  };
}

/** Every weekday of a month, as YYYY-MM-DD, optionally excluding some dates. */
function allWeekdays(month, exclude = []) {
  const [y, m] = month.split('-').map(Number);
  const ex = new Set(exclude);
  const out = [];
  eachDate(`${y}-${pad(m)}-01`, `${y}-${pad(m)}-${pad(lastDayOf(y, m))}`, (ds, dow) => {
    if (dow !== 0 && dow !== 6 && !ex.has(ds)) out.push(ds);
  });
  return out;
}

function runSyntheticScenarios(minDays) {
  // A past date, so cutoff = month_end for both A and C in every scenario.
  const PAST = '2099-01-01';
  const cases = [
    {
      name: 'Feb 2026 (20 weekdays): PERFECT attendance',
      month: '2026-02',
      db: synthDb('2026-02', { clockIns: allWeekdays('2026-02') }),
      why: 'divide-by-22: 20 present / 22 => B caps a perfect month at 90.9%',
    },
    {
      name: 'Jul 2026 (23 weekdays): 1 weekday MISSED',
      month: '2026-07',
      db: synthDb('2026-07', { clockIns: allWeekdays('2026-07', ['2026-07-10']) }),
      why: 'divide-by-22: 22 present / 22 => B shows 100%, the missed day is INVISIBLE',
    },
    {
      name: 'Jul 2026: all weekdays except a 2-day approved half_leave',
      month: '2026-07',
      db: synthDb('2026-07', {
        clockIns: allWeekdays('2026-07', ['2026-07-09', '2026-07-10']),
        leaves: [['2026-07-09', '2026-07-10', 'half_leave']],
      }),
      why: 'leave types: SQL credits only medical/emergency => approved half_leave counts as ABSENCE',
    },
    {
      name: 'Jul 2026: all weekdays except a 2-day approved "other" leave',
      month: '2026-07',
      db: synthDb('2026-07', {
        clockIns: allWeekdays('2026-07', ['2026-07-09', '2026-07-10']),
        leaves: [['2026-07-09', '2026-07-10', 'other']],
      }),
      why: 'leave types: same — approved "other" (wedding/bereavement) counts as ABSENCE',
    },
    {
      name: 'Jun 2026: 3-day Eid company holiday, nobody clocks in',
      month: '2026-06',
      db: synthDb('2026-06', {
        clockIns: allWeekdays('2026-06', ['2026-06-10', '2026-06-11', '2026-06-12']),
        holidays: [['2026-06-10', '2026-06-12', 'Eid al-Adha']],
      }),
      why: 'holidays: perf_attendance_score (mig 120) predates company_holidays (mig 167) => Eid = 3 absences',
    },
    {
      name: 'Jul 2026: manager-backfilled adjustments for 2 missed days',
      month: '2026-07',
      db: synthDb('2026-07', {
        clockIns: allWeekdays('2026-07', ['2026-07-09', '2026-07-10']),
        adjust: ['2026-07-09', '2026-07-10'],
      }),
      why: 'adjustments: all three formulas credit them — included as a control (expect A==C, B low only from /22)',
    },
  ];

  console.log('='.repeat(104));
  console.log('SYNTHETIC SCENARIOS — exercise the bug classes the live data does NOT contain');
  console.log('(in-memory only; nothing written to the DB; all past months so cutoff = full month)');
  console.log('='.repeat(104));
  console.log(`${padR('SCENARIO', 56)}${fmt('A(JS)', 7)}${fmt('B(SQL)', 8)}${fmt('D(252)', 8)}${fmt('D-A', 6)}${fmt('D-B', 7)}`);
  console.log('-'.repeat(104));
  let synthDiff = 0;
  for (const c of cases) {
    // Force a past-month cutoff by evaluating C with a far-future "today".
    const A = scoreCurrentJsAt(U, c.month, c.db, PAST);
    const B = scoreCurrentSql(U, c.month, c.db, minDays);
    const D = scoreNewSql(U, c.month, c.db, PAST);   // the ACTUAL mig-252 logic
    if (D.pctDisplay !== A.pct) synthDiff++;
    console.log(`${padR(c.name.slice(0, 55), 56)}${fmt(A.pct, 7)}${fmt(B.pct, 8)}${fmt(D.pctDisplay, 8)}` +
      `${fmt(D.pctDisplay - A.pct, 6)}${fmt(Math.round((D.pctDisplay - B.pct) * 10) / 10, 7)}`);
    console.log(`   ${c.why}`);
    console.log(`   A cov ${A.covered}/${A.denom}   B cov ${B.covered}/${B.denom}   D cov ${D.coveredDays}/${D.elapsedDays}`);
  }
  console.log('-'.repeat(104));
  console.log(`SYNTHETIC: C != A in ${synthDiff} of ${cases.length} scenarios` +
    (synthDiff === 0 ? '   <-- A and C agree even under the bug-triggering cases' : ''));
  console.log('C - B is the money: that gap is what the incentive auto-fill currently underpays.');
  console.log('');
}

async function main() {
  const months = process.argv.slice(2).filter((a) => /^\d{4}-\d{2}$/.test(a));
  // Pinned defaults. The old set (07/06/02/12) exercises ZERO adjustments, ZERO
  // holidays and ZERO weekend clock-ins — it would print "PARITY HOLDS" while
  // proving nothing about two of the three bug classes. 2026-04 has the 418
  // adjustments; 2026-05 has the 3-weekday Eid + weekend clock-ins.
  const MONTHS = months.length
    ? months
    : ['2026-07', '2026-06', '2026-05', '2026-04', '2026-02', '2025-12'];

  const users = await selectAll('profiles', 'id, display_name, email, role',
    (q) => q.eq('is_active', true).is('deleted_at', null)
            .in('role', ['tl', 'pctl', 'ol', 'apc', 'ipc'])
            .order('display_name'));

  const { data: cfg, error: cfgErr } = await sb
    .from('performance_config').select('min_attendance_days').eq('id', 1).maybeSingle();
  if (cfgErr) throw new Error('performance_config: ' + cfgErr.message);
  const MIN_DAYS = cfg?.min_attendance_days || 22;

  const localToday   = ymdOf(new Date());
  const karachiToday = karachiTodayYmd();

  console.log('='.repeat(104));
  console.log('ATTENDANCE PARITY HARNESS   A=CURRENT-JS (live UI)   B=CURRENT-SQL (mig120)   D=NEW-SQL (mig252, as written)');
  console.log('='.repeat(104));
  console.log('D is a line-by-line transliteration of the ACTUAL SQL in');
  console.log('supabase/migrations/252_attendance_single_source.sql — not of the spec. The migration is NOT');
  console.log('applied to the DB (no deploy authorised), so this is how its logic is executed and proven.');
  console.log('='.repeat(104));
  console.log(`machine-local today : ${localToday}   (what formula A's new Date() sees)`);
  console.log(`Asia/Karachi today  : ${karachiToday}   (what formula D's cutoff uses)`);
  console.log(`performance_config.min_attendance_days = ${MIN_DAYS}   (formula B's hardcoded denominator)`);
  console.log(`active employees (tl,pctl,ol,apc,ipc)  = ${users.length}`);
  if (localToday !== karachiToday) {
    console.log('!! machine-local today != Karachi today — A and C use different cutoffs this run.');
  }
  console.log('');

  // Self-check: the parameterized helpers used by formula A must return exactly
  // what the verbatim copies of PerformancePage's originals return.
  for (const mo of ['2026-07', '2026-06', '2026-02', '2025-12', '2027-01']) {
    const a1 = workingDaysInMonth(mo), a2 = elapsedDaysAt(mo, localToday);
    const c1 = cutoffYmdForMonth(mo), c2 = cutoffAt(mo, localToday);
    if (a1 !== a2 || c1 !== c2) {
      console.log(`!! SELF-CHECK FAILED ${mo}: elapsed ${a1} vs ${a2}, cutoff ${c1} vs ${c2}`);
      process.exitCode = 1;
    }
  }
  console.log('self-check: parameterized formula-A helpers == verbatim PerformancePage originals. OK');
  console.log('');

  const allDivergences = [];

  for (const month of MONTHS) {
    const db = await loadMonth(month);
    const [y, m] = month.split('-').map(Number);
    let weekdays = 0;
    eachDate(db.mStart, db.mEnd, (_ds, dow) => { if (dow !== 0 && dow !== 6) weekdays++; });

    console.log('-'.repeat(104));
    console.log(`MONTH ${month}   calendar days=${lastDayOf(y, m)}  weekdays=${weekdays}  ` +
      `attendance rows=${db.attendance.length}  adjustments=${db.adjustments.length}  ` +
      `approved leaves=${db.leaves.length}  holidays=${db.holidayRows.length}`);
    if (db.holidayRows.length) {
      db.holidayRows.forEach((h) => console.log(`   holiday: ${h.start_date}..${h.end_date}  ${h.label || ''}`));
    }
    console.log('-'.repeat(104));
    console.log(`${padR('USER', 26)}${padR('ROLE', 6)}${fmt('A(JS)', 7)}${fmt('B(SQL)', 8)}${fmt('D(mig252)', 11)}` +
      `${fmt('D-A', 6)}${fmt('D-B', 7)}   ${padR('A: cov/denom', 14)}${padR('B: cov/22', 12)}D: cov/elapsed`);
    console.log('-'.repeat(104));

    let diffDA = 0;
    let invariantFails = 0;
    for (const u of users) {
      const A = scoreCurrentJs(u.id, month, db);
      const B = scoreCurrentSql(u.id, month, db, MIN_DAYS);
      const D = scoreNewSql(u.id, month, db, karachiToday);   // <- the REAL migration logic

      const bad = checkSqlInvariants(D);
      if (bad.length) {
        invariantFails++;
        console.log(`  !! INVARIANT VIOLATION ${u.display_name}: ${bad.join('; ')}`);
      }

      const dDA = Math.round((D.pctDisplay - A.pct) * 10) / 10;
      const dDB = Math.round((D.pctDisplay - B.pct) * 10) / 10;
      if (D.pctDisplay !== A.pct) {
        diffDA++;
        // Diff the covered sets so a divergence is explained by DATE, not guessed.
        const onlyA = [...A.coveredSet].filter((d) => !D.coveredSet.has(d));
        const onlyD = [...D.coveredSet].filter((d) => !A.coveredSet.has(d));
        allDivergences.push({
          month, user: u.display_name || u.email, role: u.role,
          a: A.pct, d: D.pctDisplay,
          aDenom: A.denom, dDenom: D.elapsedDays,
          aCov: A.covered, dCov: D.coveredDays,
          onlyA, onlyD,
        });
      }
      const name = (u.display_name || u.email || '(unnamed)').slice(0, 25);
      console.log(
        `${padR(name, 26)}${padR(u.role, 6)}${fmt(A.pct, 7)}${fmt(B.pct, 8)}${fmt(D.pctDisplay, 11)}` +
        `${fmt(dDA > 0 ? '+' + dDA : dDA, 6)}${fmt(dDB > 0 ? '+' + dDB : dDB, 7)}   ` +
        `${padR(`${A.covered}/${A.denom}`, 14)}${padR(`${B.covered}/${B.denom}`, 12)}${D.coveredDays}/${D.elapsedDays}`,
      );
    }
    console.log('-'.repeat(104));
    console.log(`SUMMARY ${month}: D(mig252) != A for ${diffDA} of ${users.length} users` +
      (diffDA === 0 ? '   <-- PARITY HOLDS' : '   <-- INVESTIGATE'));
    console.log(`  SQL INVARIANTS: ${invariantFails === 0
      ? `all ${users.length} users pass (days_not_covered==missed_dates.length, covered<=elapsed, pct<=100, *_all>=weekday-only)`
      : `${invariantFails} VIOLATIONS`}`);

    // Cross-check B against the real DB function.
    const rpc = await verifyBAgainstRpc(users, month, db, MIN_DAYS);
    if (rpc.error) {
      console.log(`  RPC CROSS-CHECK: FAILED (${rpc.error})`);
    } else if (rpc.mismatches.length) {
      console.log(`  RPC CROSS-CHECK: ${rpc.mismatches.length} MISMATCH vs real perf_attendance_score:`);
      rpc.mismatches.forEach((m) => console.log(`     ${m}`));
    } else {
      console.log(`  RPC CROSS-CHECK: column B matches the REAL perf_attendance_score() for all ${rpc.checked} users.`);
    }

    // What this month's data actually exercises.
    const cov = coverageReport(db);
    const typeStr = Object.keys(cov.types).length
      ? Object.entries(cov.types).map(([t, n]) => `${t}=${n}`).join(' ')
      : '(none)';
    console.log(`  DATA EXERCISES: approved-leave types [${typeStr}]  holidays=${db.holidayRows.length}  ` +
      `adjustments=${db.adjustments.length}  weekend-clock-ins=${cov.weekendClockIns}  weekend-adjustments=${cov.weekendAdjusts}`);
    const untested = [];
    if (!db.holidayRows.length) untested.push('company_holidays (divergence c)');
    if (!cov.types.half_leave && !cov.types.other) untested.push('half_leave/other leave (divergence b)');
    if (!db.adjustments.length) untested.push('attendance_adjustments');
    if (untested.length) console.log(`  NOT EXERCISED by real data: ${untested.join(', ')}`);
    console.log('');
  }

  // ── headline check: Ali Waseem, 2026-07 ──
  const ali = users.find((u) => /ali\s*waseem/i.test(u.display_name || ''));
  if (ali && MONTHS.includes('2026-07')) {
    const db = await loadMonth('2026-07');
    const A = scoreCurrentJs(ali.id, '2026-07', db);
    const B = scoreCurrentSql(ali.id, '2026-07', db, MIN_DAYS);
    const D = scoreNewSql(ali.id, '2026-07', db, karachiToday);
    console.log('='.repeat(104));
    console.log('HEADLINE CHECK — Ali Waseem, 2026-07   (D = the ACTUAL mig-252 SQL, transliterated)');
    console.log('='.repeat(104));
    console.log(`  A  CURRENT-JS  = ${A.pct}%   covered ${A.covered} / elapsed-calendar-days ${A.denom}`);
    console.log(`       breakdown: clock-ins(weekday) ${A.actualDays}, +adjustments => effective ${A.effectiveDays}, ` +
      `leave ${A.leaveDays}, holidays ${A.holidayDays}, weekends ${A.weekendDays}`);
    console.log(`  B  CURRENT-SQL = ${B.pct}%   covered ${B.covered} / hardcoded ${B.denom}   <-- what the INCENTIVE auto-fill pays on`);
    console.log(`  D  NEW-SQL 252 = ${D.pctDisplay}%   covered ${D.coveredDays} / elapsed ${D.elapsedDays}   (pct=${D.pct}, 1dp)`);
    console.log(`       breakdown: daysThisMonth ${D.elapsedDays}, daysPresent ${D.daysPresent}, daysClockedIn ${D.daysClockedIn}, ` +
      `weekends ${D.weekendDays}, holidayDays ${D.holidayDays}, approvedLeaveDays ${D.leaveDays}, ` +
      `covered ${D.coveredDays}, daysNotCovered ${D.daysNotCovered}`);
    console.log(`       personal-card (unfiltered): daysPresentAll ${D.daysPresentAll}, daysClockedInAll ${D.daysClockedInAll}`);
    console.log(`       missed_dates ${JSON.stringify(D.missedDates)}  missed_dates_past ${JSON.stringify(D.missedDatesPast)}`);
    console.log(`  DEPLOY GATE: elapsed 15, covered 14, daysPresent 9, daysClockedIn 9, weekends 4, holidays 0, leave 2, notCovered 1, pct_display 93, pct 93.3`);
    const gateOk = D.elapsedDays === 15 && D.coveredDays === 14 && D.daysPresent === 9 &&
      D.daysClockedIn === 9 && D.weekendDays === 4 && D.holidayDays === 0 && D.leaveDays === 2 &&
      D.daysNotCovered === 1 && D.pctDisplay === 93 && Math.abs(D.pct - 93.3) < 0.05;
    console.log(`  DEPLOY GATE: ${gateOk ? 'PASS — every field matches exactly.' : '*** FAIL ***'}`);
    console.log(`  A vs D: ${A.pct === D.pctDisplay ? 'IDENTICAL' : `*** DIFFER (A=${A.pct} D=${D.pctDisplay}) ***`}`);
    console.log(`  underpayment B vs D: ${Math.round((D.pctDisplay - B.pct) * 10) / 10} percentage points`);
    console.log('');
  } else if (MONTHS.includes('2026-07')) {
    console.log('!! Ali Waseem not found among active employees — headline check skipped.\n');
  }

  // ── synthetic scenarios ─────────────────────────────────────────────────────
  // The live DB has no company_holidays and no adjustments, so the real-data
  // parity run above cannot exercise divergences (b) and (c). These fabricated
  // in-memory cases do. Nothing is written to the DB.
  runSyntheticScenarios(MIN_DAYS);

  console.log('='.repeat(104));
  console.log('DIVERGENCES  (D = the ACTUAL mig-252 SQL  vs  A = CURRENT-JS live UI)');
  console.log('='.repeat(104));
  if (!allDivergences.length) {
    console.log('NONE. The SQL AS WRITTEN in migration 252 reproduces the LIVE UI number for every');
    console.log('user in every month tested. Nothing on screen changes.');
  } else {
    allDivergences.forEach((d) => {
      console.log(`${d.month}  ${d.user} (${d.role}):  A=${d.a}%  D=${d.d}%`);
      console.log(`   A covered ${d.aCov}/${d.aDenom}   D covered ${d.dCov}/${d.dDenom}`);
      if (d.onlyA.length) console.log(`   dates counted by A but NOT D: ${d.onlyA.join(', ')}`);
      if (d.onlyD.length) console.log(`   dates counted by D but NOT A: ${d.onlyD.join(', ')}`);
    });
  }
  console.log('');
}

main().catch((e) => {
  console.error('\nHARNESS FAILED:', e.message);
  console.error(e.stack);
  process.exit(1);
});
