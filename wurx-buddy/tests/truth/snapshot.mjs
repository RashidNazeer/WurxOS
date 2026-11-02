// Takes a READ-ONLY snapshot of the production tables the Buddy data tools read, plus the RPC answers
// they depend on, into wurx-buddy/tests/truth/.snapshot/ (gitignored: real people, pay and client data).
// Usage: node wurx-buddy/tests/truth/snapshot.mjs [--months 2026-08,2026-09,2026-10]
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { q } from './prodq.mjs';

const dir = resolve(dirname(fileURLToPath(import.meta.url)), '.snapshot');
mkdirSync(dir, { recursive: true });
const arg = process.argv.indexOf('--months');
const months = arg > 0 ? process.argv[arg + 1].split(',') : null;

const TABLES = ['profiles', 'performance_ratings', 'performance_flags', 'performance_warnings', 'performance_month_snapshots', 'incentives',
  'employee_compensation', 'salary_history', 'attendance_adjustments', 'leave_requests', 'brands', 'brand_assignments',
  'brand_monthly_metrics', 'gmv_max_reports', 'agenda_tasks', 'company_holidays'];
const tables = {};
for (const t of TABLES) { tables[t] = await q(`select * from public.${t} t`); console.log(t, tables[t].length); }
tables.attendance = [];
for (let off = 0; ; off += 1000) {
  const r = await q(`select * from public.attendance order by id limit 1000 offset ${off}`);
  tables.attendance.push(...r); if (r.length < 1000) break;
}
console.log('attendance', tables.attendance.length);
tables.reports = [];
for (let off = 0; ; off += 100) {
  const r = await q(`select * from public.reports order by id limit 100 offset ${off}`);
  tables.reports.push(...r); if (r.length < 100) break;
}
console.log('reports', tables.reports.length);

const ms = months ?? [...new Set([...tables.performance_ratings.map((r) => r.month), ...tables.performance_month_snapshots.map((r) => r.month), ...tables.incentives.map((r) => r.month)])]
  .filter((m) => m >= '2026-06').sort();
const rpc = { composite: {}, breakdown: {}, months: ms };
for (const m of ms) {
  const c = await q(`select p.id uid, c.* from public.profiles p cross join lateral public.get_performance_composite(p.id, '${m}') c`);
  c.forEach((r) => { rpc.composite[`${r.uid}|${m}`] = r; });
  rpc.breakdown[m] = await q(`select * from public.attendance_month_breakdown_bulk('${m}', null)`);
  console.log('rpc', m, c.length, rpc.breakdown[m].length);
}
const [{ now }] = await q(`select now() as now`);
writeFileSync(resolve(dir, 'tables.json'), JSON.stringify(tables));
writeFileSync(resolve(dir, 'rpc.json'), JSON.stringify({ ...rpc, takenAt: now }));
console.log('snapshot written', dir, now);
