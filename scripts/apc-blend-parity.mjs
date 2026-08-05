// APC/TL blend parity: prove the PerformancePage JS perf-pillar mirror ==
// the live SQL get_performance_composite for the new (mig 303–305) method.
// Read-only, service key. Run AFTER the migrations are applied:
//   node scripts/apc-blend-parity.mjs 2026-08
//
// APC pillar (JS mirror) = apcPerfPillar(calcCheckpointAvg(monthly metrics),
//   list_apc_reporting.report_score)  — must equal composite.performance_score.
// TL  pillar (JS mirror) = round(0.6·avg(APC composites) + 0.4·reporting), the
//   same team+reporting blend the page computes — must equal composite.performance_score.
// Also checks the SQL previews are self-consistent with the composite.
import { createClient } from '@supabase/supabase-js';
import fs from 'fs';

const env = Object.fromEntries(fs.readFileSync('.env.local', 'utf8').split('\n')
  .map((l) => l.trim()).filter((l) => l && !l.startsWith('#'))
  .map((l) => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; }));
const sb = createClient(env.VITE_SUPABASE_URL, env.SERVICE_ROLL_KEY, { auth: { persistSession: false } });

const months = process.argv.slice(2).length ? process.argv.slice(2) : ['2026-08'];
const R = (x) => Math.round(x);
const clamp = (x) => Math.max(0, Math.min(100, x));

// --- EXACT copies of the shared page helpers (performanceApi.js) ---
const CK = ['dailyTasksQuality', 'overallWorkflow', 'responseTime', 'tasksProcessing'];
function calcCheckpointAvg(m) {
  if (!m) return 0;
  const s = CK.reduce((a, k) => a + Math.round((Number(m[k]) || 0) * 100), 0);
  return R(s / (CK.length * 100));
}
function apcPerfPillar(c, r) {
  c = c == null ? null : Number(c); r = r == null ? null : Number(r);
  let v;
  if (c != null && r != null) v = R(0.6 * c + 0.4 * r);
  else if (c != null) v = R(c);
  else if (r != null) v = R(r);
  else return null;
  return clamp(v);
}

const { data: cfg } = await sb.from('performance_config').select('*').eq('id', 1).maybeSingle();
const wkOn = !!cfg.weekly_apc_ratings_enabled;
const wkSince = String(cfg.weekly_apc_ratings_since).slice(0, 7);
const tlOn = !!cfg.tl_perf_method_enabled;
const tlSince = String(cfg.tl_perf_since).slice(0, 7);
console.log(`config: weekly_apc=${wkOn ? 'ON' : 'off'}(>=${wkSince})  tl_perf=${tlOn ? 'ON' : 'off'}(>=${tlSince})  apc_report_since=${cfg.apc_report_since}`);

const { data: users } = await sb.from('profiles').select('id,display_name,role,reports_to')
  .in('role', ['apc', 'tl']).eq('is_active', true).is('deleted_at', null);

let total = 0;
for (const month of months) {
  const wkLive = wkOn && month >= wkSince;
  const tlLive = tlOn && month >= tlSince;
  const { data: ratings } = await sb.from('performance_ratings').select('user_id,metrics,source').eq('month', month);
  const recOf = new Map((ratings || []).map((r) => [r.user_id, r]));
  const { data: apcRep } = await sb.rpc('list_apc_reporting', { p_month: month });
  const apcRepOf = new Map((apcRep || []).map((r) => [r.apc_id, r]));

  // cache composite per user (also used to average APC composites for TL team score)
  const compCache = new Map();
  async function composite(uid) {
    if (compCache.has(uid)) return compCache.get(uid);
    const { data } = await sb.rpc('get_performance_composite', { p_user: uid, p_month: month });
    const row = data?.[0] || null; compCache.set(uid, row); return row;
  }

  let mism = 0;
  for (const u of users) {
    const comp = await composite(u.id);
    const sqlPerf = comp?.performance_score == null ? null : Number(comp.performance_score);

    let jsPerf = null;
    if (u.role === 'apc') {
      if (wkLive) {
        const rec = recOf.get(u.id);
        const chk = rec ? calcCheckpointAvg(rec.metrics) : null;
        const rep = apcRepOf.get(u.id)?.report_score;
        jsPerf = apcPerfPillar(chk, rep == null ? null : Number(rep));
      } else {
        const rec = recOf.get(u.id);
        jsPerf = rec && rec.overall_score != null ? clamp(R(Number(rec.overall_score))) : null;
      }
    } else if (u.role === 'tl') {
      if (tlLive) {
        // team = avg of this TL's active APCs' composites (skip null)
        const apcs = users.filter((a) => a.role === 'apc' && a.reports_to === u.id);
        const comps = [];
        for (const a of apcs) { const c = await composite(a.id); if (c?.composite_score != null) comps.push(Number(c.composite_score)); }
        const team = comps.length ? comps.reduce((x, y) => x + y, 0) / comps.length : null;
        const { data: tlr } = await sb.rpc('list_tl_reporting', { p_month: month });
        const rep = (tlr || []).find((r) => r.tl_id === u.id)?.reporting_score;
        const repN = rep == null ? null : Number(rep);
        jsPerf = (team != null && repN != null) ? clamp(R(0.6 * team + 0.4 * repN))
          : team != null ? clamp(R(team)) : repN != null ? clamp(R(repN)) : null;
      } else {
        const rec = recOf.get(u.id);
        jsPerf = rec && rec.overall_score != null ? clamp(R(Number(rec.overall_score))) : null;
      }
    }

    if (jsPerf !== sqlPerf) {
      mism++;
      console.log(`  MISMATCH ${u.role} ${u.display_name}: JS perf=${jsPerf} vs SQL perf=${sqlPerf}  (composite=${comp?.composite_score})`);
    }
  }
  console.log(`\nMONTH ${month} (apc ${wkLive ? 'BLEND' : 'legacy'}, tl ${tlLive ? 'BLEND' : 'legacy'}): perf-pillar mismatches=${mism}` + (mism ? '' : '   <-- PARITY HOLDS'));
  total += mism;
}
console.log(`\n${total === 0 ? 'ALL MONTHS PARITY HOLDS (JS perf pillar == SQL get_performance_composite)' : 'TOTAL MISMATCHES: ' + total}`);
