// A tool's own text, fed back as the "answer", must verify cleanly (catches false positives on real data shapes).
import { loadSnapshot, bossCtx } from './load.mjs';
import { runDataTool } from '../../../supabase/functions/_shared/ai/tools/index.ts';
import { verifyAnswer } from '../../../supabase/functions/_shared/ai/agent/grounding.ts';
const s = loadSnapshot();
const people = s.tables.profiles.map((p) => p.display_name);
const calls = [['get_incentives', { month: '2026-10' }], ['get_salary', {}], ['get_employees', { include_inactive: true }], ['get_employees', {}], ['get_performance', { month: '2026-10' }], ['get_performance', { month: '2026-09' }], ['get_attendance', { month: '2026-10' }], ['get_leave', { month: '2026-10' }], ['list_brands', {}], ['get_brand_assignments', {}], ['rank_brands', { metric: 'gmv', period: 'September' }], ['get_gmv_max', {}], ['get_agenda_tasks', {}], ['get_reports', {}], ['brand_overview', { brand: 'Cutler' }], ['get_top_creators', { brand: 'Cutler', period: 'September' }], ['compare_periods', { brand: 'Cutler', metric: 'gmv', period_a: 'September' }], ['find_person', { name: 'Ali Ahmad' }]];
let bad = 0;
for (const [n, a] of calls) {
  const r = await runDataTool(s.db, bossCtx(), n, a);
  const v = verifyAnswer(r.text, { tools: [r.text], user: [], now: 'NOW: Monday 2026-11-02 23:40 PKT.', people });
  console.log(n, JSON.stringify(a), v.claims.length, JSON.stringify(v.checked));
  v.claims.slice(0, 5).forEach((c) => { bad++; console.log('   ', c.kind, '|', c.text, '|', c.reason, '|', c.sentence.slice(0, 100)); });
}
console.log('claims on verbatim tool text:', bad);
