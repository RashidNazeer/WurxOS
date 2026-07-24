// Safe live test of the weekly-APC-performance rollup (mig 269).
//
// Uses a FAKE future month ('2099-01') + throwaway meetings so nothing touches
// real performance_ratings/salary. Emits ZERO notifications (never calls the
// cron). Restores the global switch to its original value and deletes every
// test row at the end. agenda_meetings has only a touch trigger (no notify).
import { sb } from '../migration/lib/supabase.js';

const FM = '2099-01';
const FM2 = '2099-05';  // manual-protection test
const FM3 = '2099-06';  // orphan-reconcile test
const PRE = '2026-07';  // pre-launch floor test (before weekly_apc_ratings_since = 2026-08-01)
const KEYS = ['dailyTasksQuality', 'reporting', 'overallWorkflow', 'responseTime', 'tasksProcessing'];
const flat = (v) => Object.fromEntries(KEYS.map((k) => [k, v]));

let pass = 0, fail = 0;
const ok = (label, cond, extra = '') => { if (cond) { pass++; console.log(`  ✓ ${label}`); } else { fail++; console.log(`  ✗ ${label} ${extra}`); } };

async function setEnabled(v) {
  const { error } = await sb.from('performance_config').update({ weekly_apc_ratings_enabled: v }).eq('id', 1);
  if (error) throw new Error('setEnabled: ' + error.message);
}
async function recompute(apc) {
  const { error } = await sb.rpc('wpr_recompute_month', { p_apc: apc, p_month: FM });
  if (error) throw new Error('recompute: ' + error.message);
}
async function perfRow(apc) {
  const { data } = await sb.from('performance_ratings').select('metrics, overall_score, source').eq('user_id', apc).eq('month', FM).maybeSingle();
  return data;
}

async function main() {
  const { data: apcs, error: ae } = await sb.from('profiles')
    .select('id, display_name, reports_to').eq('role', 'apc').not('reports_to', 'is', null).limit(1);
  if (ae) throw ae;
  if (!apcs.length) throw new Error('no APC with a reports_to to test against');
  const apc = apcs[0].id;
  const tlId = apcs[0].reports_to;
  console.log(`Testing against APC: ${apcs[0].display_name}`);

  const { data: cfg0 } = await sb.from('performance_config').select('weekly_apc_ratings_enabled').eq('id', 1).single();
  const origEnabled = cfg0.weekly_apc_ratings_enabled;

  let meetingIds = [];
  try {
    // 3 throwaway meetings in the fake month
    const rows = [
      { tl_id: tlId, week_start: '2099-01-05', meeting_date: '2099-01-06', meeting_time: '10:00', status: 'completed' },
      { tl_id: tlId, week_start: '2099-01-12', meeting_date: '2099-01-13', meeting_time: '10:00', status: 'completed' },
      { tl_id: tlId, week_start: '2099-01-19', meeting_date: '2099-01-20', meeting_time: '10:00', status: 'completed' },
    ];
    const { data: mtgs, error: me } = await sb.from('agenda_meetings').insert(rows).select('id, meeting_date').order('meeting_date');
    if (me) throw new Error('insert meetings: ' + me.message);
    meetingIds = mtgs.map((m) => m.id);

    // ── Trial (OFF): weekly ratings collected but NO official rollup ──
    await setEnabled(false);
    // scores: m1=80, m2=60, m3=90
    const scoreByMeeting = [80, 60, 90];
    for (let i = 0; i < 3; i++) {
      const { error } = await sb.from('weekly_performance_ratings')
        .insert({ apc_id: apc, meeting_id: meetingIds[i], metrics: flat(scoreByMeeting[i]), rated_by: null });
      if (error) throw new Error('insert wpr: ' + error.message);
    }
    // fill trigger set month + week_start
    const { data: wrows } = await sb.from('weekly_performance_ratings')
      .select('meeting_id, month, week_start, overall_score').eq('apc_id', apc).eq('month', FM).order('week_start');
    ok('fill trigger set month=2099-01 on all 3 rows', wrows.length === 3 && wrows.every((r) => r.month === FM), JSON.stringify(wrows.map((r) => r.month)));
    ok('fill trigger set week_start from the meeting', wrows.every((r) => r.week_start && r.week_start.startsWith('2099-01')), JSON.stringify(wrows.map((r) => r.week_start)));
    ok('generated overall_score per week = the flat value', wrows.map((r) => Number(r.overall_score)).sort((a, b) => a - b).join(',') === '60,80,90', JSON.stringify(wrows.map((r) => r.overall_score)));

    ok('TRIAL: no official monthly row was created', (await perfRow(apc)) == null);

    // ── Go LIVE: rollup writes the monthly average ──
    await setEnabled(true);
    await recompute(apc);
    const live = await perfRow(apc);
    // avg of 80,60,90 = 76.667 → per-metric stored 76.67; overall_score = 76.67; composite would round → 77
    ok('LIVE: monthly row created with source=weekly', live && live.source === 'weekly', JSON.stringify(live));
    ok('LIVE: each metric = average of the 3 weeks (76.67)', live && KEYS.every((k) => Math.abs(Number(live.metrics[k]) - 76.67) < 0.01), JSON.stringify(live?.metrics));
    ok('LIVE: overall_score = mean of weekly overalls (~76.67)', live && Math.abs(Number(live.overall_score) - 76.67) < 0.02, String(live?.overall_score));
    ok('LIVE: round(overall) = 77 (what the composite pillar uses)', live && Math.round(Number(live.overall_score)) === 77, String(live?.overall_score));

    // ── Edit a week while live → monthly recomputes automatically (trigger) ──
    await sb.from('weekly_performance_ratings').update({ metrics: flat(30) }).eq('apc_id', apc).eq('meeting_id', meetingIds[1]);
    const edited = await perfRow(apc);
    // now 80,30,90 → avg 66.667
    ok('LIVE: editing a week auto-recomputes the monthly average (66.67)', edited && Math.abs(Number(edited.overall_score) - 66.67) < 0.02, String(edited?.overall_score));

    // ── OFF-freeze: turning OFF must NOT delete/recompute the derived row ──
    await setEnabled(false);
    await sb.from('weekly_performance_ratings').delete().eq('apc_id', apc).eq('meeting_id', meetingIds[2]); // remove the 90
    const frozen = await perfRow(apc);
    ok('OFF: deleting a week does NOT change the frozen official row', frozen && Math.abs(Number(frozen.overall_score) - 66.67) < 0.02, String(frozen?.overall_score));

    // ── Re-enable + recompute → reflects only remaining weeks (80,30 → 55) ──
    await setEnabled(true);
    await recompute(apc);
    const relive2 = await perfRow(apc);
    ok('LIVE again: recompute reflects remaining weeks (55)', relive2 && Math.abs(Number(relive2.overall_score) - 55) < 0.02, String(relive2?.overall_score));

    // ── Delete all weekly rows while live → derived monthly row is removed ──
    await sb.from('weekly_performance_ratings').delete().eq('apc_id', apc).eq('month', FM);
    ok('LIVE: removing all weeks deletes the derived monthly row', (await perfRow(apc)) == null);

    // ── F2: pre-launch month (< since) never rolls up / can't touch a closed month ──
    await setEnabled(true);
    const before07 = await sb.from('performance_ratings').select('metrics, overall_score, source').eq('user_id', apc).eq('month', PRE).maybeSingle();
    // Non-Monday week_start so it can't collide with a real (Monday-keyed) July meeting.
    const { data: julyMtg } = await sb.from('agenda_meetings')
      .insert({ tl_id: tlId, week_start: '2026-07-15', meeting_date: '2026-07-15', meeting_time: '10:00', status: 'completed' })
      .select('id').single();
    meetingIds.push(julyMtg.id);
    await sb.from('weekly_performance_ratings').insert({ apc_id: apc, meeting_id: julyMtg.id, metrics: flat(99), rated_by: null });
    await sb.rpc('wpr_recompute_month', { p_apc: apc, p_month: PRE });
    const after07 = await sb.from('performance_ratings').select('metrics, overall_score, source').eq('user_id', apc).eq('month', PRE).maybeSingle();
    ok('F2: pre-launch month is floored — existing July row unchanged (no fabricate/overwrite)',
      JSON.stringify(before07.data) === JSON.stringify(after07.data), `before=${JSON.stringify(before07.data)} after=${JSON.stringify(after07.data)}`);

    // ── F4: a source='manual' monthly row is never overwritten/converted ──
    await sb.from('performance_ratings').insert({ user_id: apc, month: FM2, metrics: flat(50), source: 'manual', evaluated_by: null });
    const { data: m2mtg } = await sb.from('agenda_meetings')
      .insert({ tl_id: tlId, week_start: '2099-05-04', meeting_date: '2099-05-05', meeting_time: '10:00', status: 'completed' })
      .select('id').single();
    meetingIds.push(m2mtg.id);
    await sb.from('weekly_performance_ratings').insert({ apc_id: apc, meeting_id: m2mtg.id, metrics: flat(80), rated_by: null });
    await sb.rpc('wpr_recompute_month', { p_apc: apc, p_month: FM2 });
    const m2 = await sb.from('performance_ratings').select('metrics, source').eq('user_id', apc).eq('month', FM2).maybeSingle();
    ok('F4: manual row preserved (still source=manual, metrics=50, not converted to weekly)',
      m2.data && m2.data.source === 'manual' && Number(m2.data.metrics.reporting) === 50, JSON.stringify(m2.data));

    // ── F1/F5: an orphan derived row (source=weekly, 0 weekly rows) is reconciled away ──
    await sb.from('performance_ratings').insert({ user_id: apc, month: FM3, metrics: flat(40), source: 'weekly', evaluated_by: null });
    await sb.rpc('wpr_recompute_month', { p_apc: apc, p_month: FM3 }); // enabled + 0 weekly rows → delete
    const m3 = await sb.from('performance_ratings').select('user_id').eq('user_id', apc).eq('month', FM3).maybeSingle();
    ok('F1/F5: orphan weekly-derived row (no backing weeks) is deleted on recompute', m3.data == null, JSON.stringify(m3.data));

    // ── F8: rounding parity at the .5 boundary (weeks 55 + 90 → 72.5 → 73) ──
    const { data: pMtg } = await sb.from('agenda_meetings')
      .insert([
        { tl_id: tlId, week_start: '2099-01-26', meeting_date: '2099-01-27', meeting_time: '10:00', status: 'completed' },
      ]).select('id').single();
    meetingIds.push(pMtg.id);
    await sb.from('weekly_performance_ratings').insert([
      { apc_id: apc, meeting_id: meetingIds[0], metrics: flat(55), rated_by: null },
      { apc_id: apc, meeting_id: pMtg.id, metrics: flat(90), rated_by: null },
    ]);
    await sb.rpc('wpr_recompute_month', { p_apc: apc, p_month: FM });
    const par = await perfRow(apc);
    // JS integer-hundredths mirror of the composite pillar
    const jsAvg = Math.round(KEYS.reduce((a, k) => a + Math.round((Number(par.metrics[k]) || 0) * 100), 0) / (KEYS.length * 100));
    ok('F8: SQL round(overall)=73 at the .5 boundary (72.5)', Math.round(Number(par.overall_score)) === 73, String(par.overall_score));
    ok('F8: JS integer-hundredths avg == SQL round (both 73, no FP drift)', jsAvg === Math.round(Number(par.overall_score)), `js=${jsAvg} sql=${Math.round(Number(par.overall_score))}`);
    await sb.from('weekly_performance_ratings').delete().eq('apc_id', apc).eq('month', FM);
  } finally {
    // ── cleanup: restore switch, wipe every test row (NEVER the real July data) ──
    await sb.from('weekly_performance_ratings').delete().eq('apc_id', apc).in('month', [FM, FM2, FM3, PRE]);
    await sb.from('performance_ratings').delete().eq('user_id', apc).in('month', [FM, FM2, FM3]); // NOT PRE — that's real
    if (meetingIds.length) await sb.from('agenda_meetings').delete().in('id', meetingIds);
    await setEnabled(origEnabled);
    const { data: chk } = await sb.from('performance_config').select('weekly_apc_ratings_enabled').eq('id', 1).single();
    ok('cleanup: switch restored to original', chk.weekly_apc_ratings_enabled === origEnabled, `(now ${chk.weekly_apc_ratings_enabled})`);
    const { data: leftWpr } = await sb.from('weekly_performance_ratings').select('id').in('month', [FM, FM2, FM3, PRE]);
    ok('cleanup: no test weekly rows left', (leftWpr || []).length === 0);
    const { data: leftPr } = await sb.from('performance_ratings').select('user_id').eq('user_id', apc).in('month', [FM, FM2, FM3]);
    ok('cleanup: no test monthly rows left', (leftPr || []).length === 0);
  }

  console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAIL'} — ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}
main().catch((e) => { console.error('ERROR:', e.message || e); process.exit(1); });
