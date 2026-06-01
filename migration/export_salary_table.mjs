// Export the current Salary Management state as a CSV + console table.
// Excludes Boss role per memory/salary-management.md.

import { sb } from './lib/supabase.js';
import { writeFileSync } from 'node:fs';

const PAYROLL = ['ol', 'tl', 'pctl', 'apc', 'ipc', 'developer'];

function yearsCompleted(hire) {
  if (!hire) return null;
  const now = new Date();
  const h = new Date(hire + 'T00:00:00');
  if (isNaN(h)) return null;
  let y = now.getFullYear() - h.getFullYear();
  const passed = now.getMonth() > h.getMonth() ||
    (now.getMonth() === h.getMonth() && now.getDate() >= h.getDate());
  if (!passed) y -= 1;
  return Math.max(0, y);
}
function fmtPKR(n) {
  if (n == null) return '';
  return Number(n).toLocaleString('en-PK', { maximumFractionDigits: 0 });
}

const { data: profiles } = await sb
  .from('profiles')
  .select('id, display_name, email, role, start_date')
  .is('deleted_at', null).eq('is_active', true).in('role', PAYROLL)
  .order('role').order('display_name');
const { data: comps } = await sb
  .from('employee_compensation')
  .select('user_id, basic_salary, effective_from, last_change_reason');
const compByUid = new Map((comps || []).map(c => [c.user_id, c]));

const rows = profiles.map(p => {
  const c = compByUid.get(p.id);
  return {
    name:        p.display_name || p.email || '—',
    role:        (p.role || '').toUpperCase(),
    hireDate:    p.start_date || '',
    yearsDone:   yearsCompleted(p.start_date),
    salaryPKR:   c?.basic_salary ?? null,
    effective:   c?.effective_from || '',
    lastReason:  c?.last_change_reason || '',
  };
});

// ── Console table ────────────────────────────────────────────
console.log('Name'.padEnd(28) + 'Role'.padEnd(6) + 'Hire date'.padEnd(13) + 'Years'.padEnd(7) + 'Salary (PKR)'.padEnd(15) + 'Effective'.padEnd(13) + 'Last reason');
console.log('-'.repeat(95));
for (const r of rows) {
  console.log(
    String(r.name).padEnd(28) +
    String(r.role).padEnd(6) +
    String(r.hireDate || '—').padEnd(13) +
    String(r.yearsDone == null ? '—' : r.yearsDone).padEnd(7) +
    String(r.salaryPKR == null ? '—' : fmtPKR(r.salaryPKR)).padEnd(15) +
    String(r.effective || '—').padEnd(13) +
    String(r.lastReason || '—')
  );
}
console.log('-'.repeat(95));
console.log(`Total: ${rows.length}  ·  with salary: ${rows.filter(r => r.salaryPKR != null).length}  ·  with hire date: ${rows.filter(r => r.hireDate).length}`);

// ── CSV ──────────────────────────────────────────────────────
function csvEscape(v) {
  const s = v == null ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
const header = ['Employee Name', 'Role', 'Hire Date', 'Years Completed', 'Current Salary (PKR)', 'Effective From', 'Last Change Reason'];
const lines = [header.join(',')];
for (const r of rows) {
  lines.push([
    r.name, r.role, r.hireDate, r.yearsDone, r.salaryPKR, r.effective, r.lastReason,
  ].map(csvEscape).join(','));
}
const csv = lines.join('\n') + '\n';
const out = 'migration/_salary_export_2026-06-01.csv';
writeFileSync(out, csv);
console.log(`\nCSV written to: ${out}`);
