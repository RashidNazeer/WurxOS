// Safe live test of the TL performance method (migs 271+272).
//
// Reads real composites (service_role bypasses the visibility gate) for a real
// TL + a past month (2026-07) where APC data exists. Writes only a transient
// deduction (removed) and briefly toggles the config switch/floor to verify
// gating (restored). No real score is persisted; the switch is left as found.
import { sb } from '../migration/lib/supabase.js';

const M = '2026-07';
let pass = 0, fail = 0;
const ok = (l, c, e = '') => { if (c) { pass++; console.log(`  ✓ ${l}`); } else { fail++; console.log(`  ✗ ${l} ${e}`); } };
const near = (a, b, t = 0.01) => a != null && b != null && Math.abs(Number(a) - Number(b)) < t;

async function comp(uid, month) { const { data, error } = await sb.rpc('get_performance_composite', { p_user: uid, p_month: month }); if (error) throw new Error(error.message); return data?.[0] || null; }
async function preview(tl, month) { const { data, error } = await sb.rpc('tl_perf_preview', { p_tl: tl, p_month: month }); if (error) throw new Error(error.message); return data?.[0] || null; }
async function repScore(tl, month) { const { data, error } = await sb.rpc('tl_reporting_score', { p_tl: tl, p_month: month }); if (error) throw new Error(error.message); return data; }
async function setCfg(patch) { const { error } = await sb.from('performance_config').update(patch).eq('id', 1); if (error) throw new Error(error.message); }

async function main() {
  const { data: cfg0 } = await sb.from('performance_config').select('tl_perf_method_enabled, tl_perf_since').eq('id', 1).single();
  const orig = { tl_perf_method_enabled: cfg0.tl_perf_method_enabled, tl_perf_since: cfg0.tl_perf_since };

  // pick a TL that has active APCs
  const { data: tls } = await sb.from('profiles').select('id, display_name').eq('role', 'tl').eq('is_active', true);
  let tl = null, apcs = [];
  for (const t of tls) {
    const { data: a } = await sb.from('profiles').select('id, display_name').eq('reports_to', t.id).eq('role', 'apc').eq('is_active', true).is('deleted_at', null);
    if (a && a.length) { tl = t; apcs = a; break; }
  }
  if (!tl) throw new Error('no TL with active APCs to test against');
  console.log(`Testing TL: ${tl.display_name} (${apcs.length} APCs), month ${M}`);

  let dedId = null;
  let smId = null;
  try {
    // ── TEAM SCORE = avg of the TL's APCs' composites (skip null) ──
    const apcComps = [];
    for (const a of apcs) { const c = await comp(a.id, M); if (c && c.composite_score != null) apcComps.push(Number(c.composite_score)); }
    const expTeam = apcComps.length ? apcComps.reduce((x, y) => x + y, 0) / apcComps.length : null;
    const pv = await preview(tl.id, M);
    ok('team score = average of APC composites', (expTeam == null && pv.team_score == null) || near(pv.team_score, expTeam), `sql=${pv.team_score} js=${expTeam}`);

    // ── REPORTING formula: (N - D) / N * 100 (D=0 → 100), N from the SQL ──
    const N = pv.reports_n;
    console.log(`  (N = ${N} verified reports for the TL's brands in ${M}, D = ${pv.deductions})`);
    if (Number(pv.deductions) === 0) {
      ok('reporting = 100 when N>0 and no deductions (or null when N=0)',
        (N === 0 && pv.reporting_score == null) || (N > 0 && near(pv.reporting_score, 100)), `N=${N} rep=${pv.reporting_score}`);
    }

    if (N > 0) {
      // D now joins deductions→reports→brands on the report's verified_at window,
      // so the deduction must reference a real report the TL owns, verified this
      // (Karachi) month. Karachi window in UTC: [M-01 00:00+05:00, next-01 00:00+05:00).
      const [yy, mm] = M.split('-').map(Number);
      const start = new Date(`${M}-01T00:00:00+05:00`).toISOString();
      const endM = new Date(Date.UTC(yy, mm, 1));
      const end = new Date(`${endM.getUTCFullYear()}-${String(endM.getUTCMonth() + 1).padStart(2, '0')}-01T00:00:00+05:00`).toISOString();
      const { data: brs } = await sb.from('brands').select('id').eq('owner_id', tl.id);
      const brIds = (brs || []).map((b) => b.id);
      const { data: rr } = await sb.from('reports').select('id').in('brand_id', brIds).gte('verified_at', start).lt('verified_at', end).limit(1);
      const repId = rr?.[0]?.id;
      ok('found a verified report owned by the TL to attach a test deduction', !!repId);
      if (repId) {
        const { data: ins } = await sb.from('tl_reporting_deductions').insert({ tl_id: tl.id, report_id: repId, month: M, amount: 2, decided_by: null, note: 'TEST' }).select('id').single();
        dedId = ins.id;
        const rep2 = await repScore(tl.id, M);
        ok('reporting drops by a deduction: (N-2)/N*100 (D joins on the report)', near(rep2, ((N - 2) / N) * 100), `got ${rep2}, want ${((N - 2) / N) * 100}`);
        await sb.from('tl_reporting_deductions').delete().eq('id', dedId); dedId = null;
        const rep3 = await repScore(tl.id, M);
        ok('reporting restored after removing the deduction', near(rep3, 100), String(rep3));
      }
    }

    // ── BLEND = round(0.6*team + 0.4*reporting), fallbacks when one is null ──
    const team = pv.team_score == null ? null : Number(pv.team_score);
    const rep = pv.reporting_score == null ? null : Number(pv.reporting_score);
    const expBlend = (team != null && rep != null) ? Math.round(0.6 * team + 0.4 * rep)
      : team != null ? Math.round(team) : rep != null ? Math.round(rep) : null;
    ok('blended pillar = round(0.6*team + 0.4*reporting)', (expBlend == null && pv.blended == null) || Number(pv.blended) === expBlend, `sql=${pv.blended} js=${expBlend}`);

    // ── GATING: OFF → old method; ON → blend; floor → old even when ON ──
    await setCfg({ tl_perf_method_enabled: false });
    const cOff = await comp(tl.id, M);
    const { data: pr } = await sb.from('performance_ratings').select('overall_score').eq('user_id', tl.id).eq('month', M).maybeSingle();
    const oldPerf = pr && pr.overall_score != null ? Math.round(Number(pr.overall_score)) : null;
    ok('SWITCH OFF: TL perf pillar = old OL rating (overall_score), not the blend',
      (oldPerf == null && cOff.performance_score == null) || Number(cOff.performance_score) === oldPerf, `off=${cOff.performance_score} old=${oldPerf}`);

    await setCfg({ tl_perf_method_enabled: true, tl_perf_since: '2026-01-01' }); // floor below M so the blend applies
    const cOn = await comp(tl.id, M);
    ok('SWITCH ON (month ≥ floor): TL perf pillar = the blend', Number(cOn.performance_score) === expBlend, `on=${cOn.performance_score} blend=${expBlend}`);
    ok('PARITY: SQL blend == JS blend (round(0.6*team+0.4*rep))', Number(cOn.performance_score) === expBlend);

    // ── FULL COMPOSITE parity for the TL (page-style composition vs SQL, live) ──
    // Reproduce PerformancePage calcComposite over the SQL-returned pillars (drop
    // null incentives, weighted mean, Math.round) and compare to the SQL composite.
    if (cOn.composite_score != null) {
      const { data: cfg } = await sb.from('performance_config').select('weight_performance, weight_incentives, weight_attendance, weight_flags').eq('id', 1).single();
      const pillars = [
        [Number(cOn.performance_score), Number(cfg.weight_performance)],
        cOn.incentives_score == null ? null : [Number(cOn.incentives_score), Number(cfg.weight_incentives)],
        [Number(cOn.attendance_score), Number(cfg.weight_attendance)],
        [Number(cOn.flags_score), Number(cfg.weight_flags)],
      ].filter(Boolean);
      const numr = pillars.reduce((a, [s, w]) => a + s * w, 0);
      const denr = pillars.reduce((a, [, w]) => a + w, 0);
      const jsComposite = denr > 0 ? Math.round(numr / denr) : 0;
      ok('FULL COMPOSITE PARITY: JS-page composition == SQL composite (TL, live)', Number(cOn.composite_score) === jsComposite, `js=${jsComposite} sql=${cOn.composite_score}`);
    } else {
      ok('FULL COMPOSITE PARITY: skipped — TL composite null (not rated / pending verify)', true);
    }

    await setCfg({ tl_perf_since: '2099-01-01' }); // floor ABOVE M → M is pre-launch
    const cFloor = await comp(tl.id, M);
    ok('FLOOR: month before tl_perf_since uses the OLD method even when ON',
      (oldPerf == null && cFloor.performance_score == null) || Number(cFloor.performance_score) === oldPerf, `floored=${cFloor.performance_score} old=${oldPerf}`);

    // ── OL star rating blends into reporting: 0.6×stars + 0.4×accountability ──
    // Throwaway July meeting (non-Monday week_start avoids colliding with a real one).
    const { data: sm } = await sb.from('agenda_meetings')
      .insert({ tl_id: tl.id, week_start: '2026-07-15', meeting_date: '2026-07-15', meeting_time: '10:00', status: 'completed', tl_reporting_stars: 4 })
      .select('id').single();
    smId = sm.id;
    const pvS = await preview(tl.id, M);   // raw RPC row = snake_case columns
    ok('star score = avg stars × 20 (4★ → 80)', near(pvS.star_score, 80) && near(pvS.star_avg, 4), `starScore=${pvS.star_score} avg=${pvS.star_avg}`);
    const expRep = 0.6 * 80 + 0.4 * Number(pvS.accountability);
    ok('reporting blends 0.6×stars + 0.4×accountability', near(pvS.reporting_score, expRep), `rep=${pvS.reporting_score} exp=${expRep} (acct=${pvS.accountability})`);
  } finally {
    if (smId) await sb.from('agenda_meetings').delete().eq('id', smId);
    if (dedId) await sb.from('tl_reporting_deductions').delete().eq('id', dedId);
    await sb.from('tl_reporting_deductions').delete().eq('note', 'TEST');
    await setCfg(orig);
    const { data: chk } = await sb.from('performance_config').select('tl_perf_method_enabled, tl_perf_since').eq('id', 1).single();
    ok('cleanup: switch + floor restored', chk.tl_perf_method_enabled === orig.tl_perf_method_enabled && String(chk.tl_perf_since) === String(orig.tl_perf_since), JSON.stringify(chk));
    const { data: leftD } = await sb.from('tl_reporting_deductions').select('id').eq('note', 'TEST');
    ok('cleanup: no test deductions left', (leftD || []).length === 0);
  }

  console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAIL'} — ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}
main().catch((e) => { console.error('ERROR:', e.message || e); process.exit(1); });
