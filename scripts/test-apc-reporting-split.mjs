// Safe live test of the APC reporting split (mig 274): chunk math + the
// server-side fold. Uses a fake future meeting (2099-06) and deductions with
// explicit created_at inside/outside the reviewed-week window, then cleans up.
import { sb } from '../migration/lib/supabase.js';

const MD = '2099-06-15';          // meeting date
const KEYS = ['dailyTasksQuality', 'reporting', 'overallWorkflow', 'responseTime', 'tasksProcessing'];
let pass = 0, fail = 0;
const ok = (l, c, e = '') => { if (c) { pass++; console.log(`  ✓ ${l}`); } else { fail++; console.log(`  ✗ ${l} ${e}`); } };

async function chunks(apc, meeting) {
  const { data, error } = await sb.rpc('apc_return_chunks', { p_apc: apc, p_meeting: meeting });
  if (error) throw new Error(error.message);
  return data?.[0];
}

async function main() {
  const { data: apcs } = await sb.from('profiles').select('id, display_name, reports_to').eq('role', 'apc').not('reports_to', 'is', null).limit(1);
  if (!apcs?.length) throw new Error('no APC with a reports_to');
  const apc = apcs[0].id, tlId = apcs[0].reports_to;
  console.log(`Testing APC: ${apcs[0].display_name}`);

  let meetingId = null;
  try {
    const { data: m, error: me } = await sb.from('agenda_meetings')
      .insert({ tl_id: tlId, week_start: MD, meeting_date: MD, meeting_time: '10:00', status: 'completed' })
      .select('id').single();
    if (me) throw new Error('insert meeting: ' + me.message);
    meetingId = m.id;

    // ── no deductions → full 5 / 5 ──
    let c = await chunks(apc, meetingId);
    ok('no deductions → report 5/5, checkpoint 5/5', Number(c.report_score) === 5 && Number(c.checkpoint_score) === 5, JSON.stringify(c));

    // ── report dock of 2, in the reviewed week → report chunk = 3 ──
    await sb.from('apc_reporting_deductions').insert({ apc_id: apc, kind: 'report', amount: 2, decided_by: null, created_at: '2099-06-12T10:00:00+05:00' });
    c = await chunks(apc, meetingId);
    ok('in-window report dock of 2 → report chunk = 3', Number(c.report_score) === 3 && Number(c.report_deducted) === 2, JSON.stringify(c));

    // ── an out-of-window dock does NOT count ──
    await sb.from('apc_reporting_deductions').insert({ apc_id: apc, kind: 'report', amount: 3, decided_by: null, created_at: '2099-05-01T10:00:00+05:00' });
    c = await chunks(apc, meetingId);
    ok('out-of-window dock is ignored → report chunk still 3', Number(c.report_score) === 3, JSON.stringify(c));

    // ── checkpoint dock of 5 → checkpoint chunk = 0 (floored) ──
    await sb.from('apc_reporting_deductions').insert({ apc_id: apc, kind: 'checkpoint', amount: 5, decided_by: null, created_at: '2099-06-13T10:00:00+05:00' });
    c = await chunks(apc, meetingId);
    ok('checkpoint dock of 5 → checkpoint chunk = 0 (floored)', Number(c.checkpoint_score) === 0 && Number(c.checkpoint_deducted) === 5, JSON.stringify(c));

    // ── the fold: a rating with reportingOl=80 → stored reporting = 80 + 3 + 0 = 83 ──
    const olMetrics = { dailyTasksQuality: 70, reporting: 80, overallWorkflow: 70, responseTime: 70, tasksProcessing: 70, reportingOl: 80 };
    await sb.from('weekly_performance_ratings').insert({ apc_id: apc, meeting_id: meetingId, metrics: olMetrics, rated_by: null });
    const { data: row } = await sb.from('weekly_performance_ratings').select('metrics, overall_score').eq('apc_id', apc).eq('meeting_id', meetingId).single();
    ok('trigger folds reporting = reportingOl(80) + report(3) + checkpoint(0) = 83', Number(row.metrics.reporting) === 83, JSON.stringify(row.metrics));
    ok('reportingOl preserved (80) for reload', Number(row.metrics.reportingOl) === 80, JSON.stringify(row.metrics));
    // overall_score = (70+83+70+70+70)/5 = 72.6
    ok('overall_score uses the folded reporting (72.6)', Math.abs(Number(row.overall_score) - 72.6) < 0.01, String(row.overall_score));

    // ── re-fold on update: remove the checkpoint dock, touch the rating → reporting = 80+3+5 = 88 ──
    await sb.from('apc_reporting_deductions').delete().eq('apc_id', apc).eq('kind', 'checkpoint');
    await sb.from('weekly_performance_ratings').update({ metrics: olMetrics }).eq('apc_id', apc).eq('meeting_id', meetingId);
    const { data: row2 } = await sb.from('weekly_performance_ratings').select('metrics').eq('apc_id', apc).eq('meeting_id', meetingId).single();
    ok('re-save re-folds with current chunks → reporting = 88', Number(row2.metrics.reporting) === 88, JSON.stringify(row2.metrics));

    // ── a rating WITHOUT reportingOl is left untouched (backward compat) ──
    const { data: m2 } = await sb.from('agenda_meetings').insert({ tl_id: tlId, week_start: '2099-06-22', meeting_date: '2099-06-22', meeting_time: '10:00', status: 'completed' }).select('id').single();
    await sb.from('weekly_performance_ratings').insert({ apc_id: apc, meeting_id: m2.id, metrics: { dailyTasksQuality: 50, reporting: 95, overallWorkflow: 50, responseTime: 50, tasksProcessing: 50 }, rated_by: null });
    const { data: row3 } = await sb.from('weekly_performance_ratings').select('metrics').eq('apc_id', apc).eq('meeting_id', m2.id).single();
    ok('no reportingOl → reporting left as sent (95, backward compatible)', Number(row3.metrics.reporting) === 95, JSON.stringify(row3.metrics));
    await sb.from('weekly_performance_ratings').delete().eq('meeting_id', m2.id);
    await sb.from('agenda_meetings').delete().eq('id', m2.id);
  } finally {
    await sb.from('weekly_performance_ratings').delete().eq('apc_id', apc).eq('month', '2099-06');
    await sb.from('performance_ratings').delete().eq('user_id', apc).eq('month', '2099-06');
    await sb.from('apc_reporting_deductions').delete().eq('apc_id', apc).gte('created_at', '2099-01-01');
    if (meetingId) await sb.from('agenda_meetings').delete().eq('id', meetingId);
    const { data: leftD } = await sb.from('apc_reporting_deductions').select('id').eq('apc_id', apc).gte('created_at', '2099-01-01');
    ok('cleanup: no test deductions left', (leftD || []).length === 0);
  }

  console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAIL'} — ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}
main().catch((e) => { console.error('ERROR:', e.message || e); process.exit(1); });
