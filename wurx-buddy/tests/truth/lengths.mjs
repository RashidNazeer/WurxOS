import { loadSnapshot, bossCtx } from './load.mjs';
import { runDataTool } from '../../../supabase/functions/_shared/ai/tools/index.ts';
const s = loadSnapshot();
const calls = [['get_incentives', { month: '2026-10' }], ['get_salary', {}], ['get_employees', { include_inactive: true }], ['get_employees', {}], ['get_performance', { month: '2026-10' }], ['get_performance', { month: '2026-09' }], ['get_attendance', { month: '2026-10' }], ['get_leave', {}], ['list_brands', {}], ['get_brand_assignments', {}], ['rank_brands', { metric: 'gmv', period: 'September' }], ['get_gmv_max', {}], ['get_agenda_tasks', {}], ['get_reports', {}]];
for (const [n, a] of calls) { const r = await runDataTool(s.db, bossCtx(), n, a); console.log(n, JSON.stringify(a), r.text.length, r.truncated ? 'TRUNCATED' : ''); }
