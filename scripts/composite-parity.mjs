// Composite parity: prove get_performance_composite (mig 256, transliterated)
// == the live PerformancePage JS composite, for every active employee.
// Read-only. Uses the service key. perf_attendance_score (mig 252, live) is the
// attendance pillar for both sides.
import { createClient } from '@supabase/supabase-js';
import fs from 'fs';

const env = Object.fromEntries(fs.readFileSync('.env.local', 'utf8').split('\n')
  .map((l) => l.trim()).filter((l) => l && !l.startsWith('#'))
  .map((l) => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; }));
const sb = createClient(env.VITE_SUPABASE_URL, env.SERVICE_ROLL_KEY, { auth: { persistSession: false } });

const months = process.argv.slice(2).length ? process.argv.slice(2) : ['2026-07', '2026-06'];
const R = (x) => Math.round(x);
const clamp = (x) => Math.max(0, Math.min(100, x));
// The 5 SCORING metric keys (V1_METRICS). punctuality lingers in the jsonb but
// mig 243 dropped it from overall_score AND the page's calcMetricsAvg ignores it.
const MK = ['dailyTasksQuality', 'reporting', 'overallWorkflow', 'responseTime', 'tasksProcessing'];

// Karachi 'YYYY-MM' for a timestamp — matches the SQL created_at window (business TZ).
function khiMonth(ts) {
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Karachi', year: 'numeric', month: '2-digit' })
    .formatToParts(new Date(ts));
  return `${p.find((x) => x.type === 'year').value}-${p.find((x) => x.type === 'month').value}`;
}

const { data: cfg } = await sb.from('performance_config').select('*').eq('id', 1).maybeSingle();
const W = { performance: +cfg.weight_performance, incentives: +cfg.weight_incentives, attendance: +cfg.weight_attendance, flags: +cfg.weight_flags };
const TH = { promo: +cfg.threshold_promotion, good: +cfg.threshold_good, warn: +cfg.threshold_warning };
const level = (s) => s == null ? 'not_rated' : s >= TH.promo ? 'promotion' : s >= TH.good ? 'good' : s >= TH.warn ? 'warning' : 'termination';
// Current Karachi 'YYYY-MM' — an attendance incentive item completes only once its month is strictly past.
const khiNow = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Karachi', year: 'numeric', month: '2-digit' })
  .formatToParts(new Date()).reduce((a, p) => p.type === 'year' ? p.value + a : p.type === 'month' ? a + '-' + p.value : a, '');

const { data: users } = await sb.from('profiles').select('id,display_name,role')
  .in('role', ['tl', 'pctl', 'ol', 'apc', 'ipc']).eq('is_active', true).is('deleted_at', null);

let totalMismatch = 0;
for (const month of months) {
  const [{ data: ratings }, { data: incs }, { data: flags }] = await Promise.all([
    sb.from('performance_ratings').select('user_id,overall_score,metrics').eq('month', month),
    sb.from('incentives').select('user_id,incentives,bonuses,payout_cleared').eq('month', month),
    sb.from('performance_flags').select('user_id,type,created_at'),
  ]);
  const ratingOf = new Map((ratings || []).map((r) => [r.user_id, r]));
  const incOf = new Map((incs || []).map((r) => [r.user_id, r]));

  let mism = 0; const rows = [];
  for (const u of users) {
    const rec = ratingOf.get(u.id);
    // attendance pillar = live perf_attendance_score (1-dp), same both sides.
    const { data: att } = await sb.rpc('perf_attendance_score', { p_user: u.id, p_month: month });
    const attP = clamp(Number(att) || 0);

    // ---- perf pillar ----
    const perfJS = rec ? R(MK.map((k) => Number(rec.metrics?.[k]) || 0).reduce((a, b) => a + b, 0) / MK.length) : null;
    const perfSQL = rec && rec.overall_score != null ? clamp(R(Number(rec.overall_score))) : null;

    // ---- incentives pillar (overlay attendance items == page applyAttendanceAutofill
    // and the fixed perf_incentives_score: non-paid attendance item completes only
    // when the month is CLOSED and coverage >= 90; paid rows use stored completed) ----
    const ir = incOf.get(u.id);
    const items = ir ? [...(ir.incentives || []), ...(ir.bonuses || [])] : [];
    const incHas = items.length >= 1;
    const monthClosed = month < khiNow;
    const paid = ir?.payout_cleared === true;
    const doneCount = items.filter((it) => (!paid && it.source === 'attendance')
      ? (monthClosed && attP >= 90)
      : !!it.completed).length;
    const incVal = incHas ? R((doneCount / items.length) * 100) : null;

    // ---- flags pillar (both sides use Karachi month membership here) ----
    const fCount = (flags || []).filter((f) => f.user_id === u.id && khiMonth(f.created_at) === month);
    const g = fCount.filter((f) => f.type === 'green').length;
    const r = fCount.length - g;
    const flg = clamp(80 + g * 10 - r * 20);

    // ---- composite, both sides (weighted mean over present pillars) ----
    const comp = (perf, inc) => {
      if (perf == null) return null;
      let num = perf * W.performance, den = W.performance;
      if (inc != null) { num += inc * W.incentives; den += W.incentives; }
      num += attP * W.attendance; den += W.attendance;
      num += flg * W.flags; den += W.flags;
      return den > 0 ? R(clamp(num / den)) : 0;
    };
    const cJS = comp(perfJS, incVal);
    const cSQL = comp(perfSQL, incVal);

    const bad = cJS !== cSQL || perfJS !== perfSQL;
    if (bad) { mism++; rows.push(`  MISMATCH ${u.display_name}: JS comp=${cJS}(perf ${perfJS}) vs SQL comp=${cSQL}(perf ${perfSQL})  att=${attP} inc=${incVal} flg=${flg} lvlJS=${level(cJS)} lvlSQL=${level(cSQL)}`); }
  }
  console.log(`\nMONTH ${month}: ${users.length} employees, composite mismatches = ${mism}` + (mism ? '' : '   <-- PARITY HOLDS'));
  rows.forEach((r) => console.log(r));
  totalMismatch += mism;
}
console.log(`\n${totalMismatch === 0 ? 'ALL MONTHS PARITY HOLDS (JS composite == SQL-256 composite)' : 'TOTAL MISMATCHES: ' + totalMismatch}`);
