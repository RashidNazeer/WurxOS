// Investigate the unpaid leave summary issues:
//   1. Rashid (Boss-overridden to paid) still appearing in summary
//   2. Farakh's request shows "Unpaid" but no days + missing from summary

import { sb } from './lib/supabase.js';

console.log('=== Leave requests this month (May 2026) ===');
const now = new Date();
const monthStart = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`;
const monthEnd = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate()}`;
console.log(`Month range: ${monthStart} → ${monthEnd}`);

const { data: leaves } = await sb
  .from('leave_requests')
  .select('id, type, status, current_level, start_date, end_date, paid_days, unpaid_days, paid_override, requester:requester_id(display_name, email, role)')
  .order('start_date', { ascending: false })
  .limit(100);

console.log(`\nAll recent requests (most recent ${leaves?.length}):`);
for (const r of leaves || []) {
  const note = [];
  if (r.paid_override) note.push('OVERRIDE→PAID');
  if (r.unpaid_days > 0) note.push(`unpaid=${r.unpaid_days}`);
  if (r.paid_days > 0)   note.push(`paid=${r.paid_days}`);
  console.log(`  ${r.start_date}→${r.end_date} | ${r.type} | ${r.status} | ${r.requester?.display_name} (${r.requester?.role}) | ${note.join(' ')}`);
}

console.log('\n=== Farakh-specific lookup ===');
const { data: farakhRows } = await sb
  .from('profiles').select('id, display_name, email, role').ilike('display_name', '%farakh%');
for (const f of farakhRows || []) {
  console.log(`  ${f.display_name} | ${f.email} | role=${f.role} | id=${f.id}`);
  const { data: fLeaves } = await sb
    .from('leave_requests')
    .select('id, type, status, current_level, start_date, end_date, paid_days, unpaid_days, paid_override, reason')
    .eq('requester_id', f.id)
    .order('start_date', { ascending: false });
  console.log(`    Leaves: ${fLeaves?.length || 0}`);
  for (const l of fLeaves || []) {
    console.log(`      ${l.start_date}→${l.end_date} | ${l.type} | ${l.status} | paid=${l.paid_days} unpaid=${l.unpaid_days} override=${l.paid_override}`);
  }
}

console.log('\n=== Rashid (APC) leave lookup ===');
const APC_RASHID = '3582f4f1-e018-507d-af98-8ae206320c5e';
const { data: rLeaves } = await sb
  .from('leave_requests')
  .select('id, type, status, current_level, start_date, end_date, paid_days, unpaid_days, paid_override, reason')
  .eq('requester_id', APC_RASHID)
  .order('start_date', { ascending: false });
for (const l of rLeaves || []) {
  console.log(`  ${l.start_date}→${l.end_date} | ${l.type} | ${l.status} | paid=${l.paid_days} unpaid=${l.unpaid_days} override=${l.paid_override}`);
}
