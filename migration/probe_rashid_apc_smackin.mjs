// One-off correction: rewrite Rashid Nazeer (developer)'s salary
// history to reflect reality. Per chat 2026-05-31.
//
// Goal final state:
//   comp.basic_salary       = 100,000
//   comp.effective_from     = 2026-04-01
//   comp.last_change_reason = 'promotion'
//   salary_history          = 2 rows:
//     1) initial_seed 50K eff 2025-02-10
//     2) promotion 50K → 100K eff 2026-04-01
//
// Existing 2 history rows (typos from earlier testing) are deleted.
// audit_log captures the override fact.
//
// Bypasses the sh_insert_block and sh_delete_block RLS via the
// service-role connection.

import { sb } from './lib/supabase.js';

const RASHID_DEV = '87f3419d-5c90-537e-b41e-e4097330d670';

// 1. Snapshot current state (in case we need to undo).
const { data: histBefore } = await sb.from('salary_history').select('*').eq('user_id', RASHID_DEV);
const { data: compBefore } = await sb.from('employee_compensation').select('*').eq('user_id', RASHID_DEV).single();
console.log(`Before:  comp=${compBefore?.basic_salary}  history rows=${histBefore?.length}`);

// 2. Delete the existing (typo) history rows.
const del = await sb.from('salary_history').delete().eq('user_id', RASHID_DEV);
if (del.error) { console.error('history delete failed:', del.error); process.exit(1); }
console.log('  ✓ deleted typo history rows');

// 3. Update the comp row to the correct current state.
const compUpdate = await sb.from('employee_compensation').update({
  basic_salary:       100000,
  effective_from:     '2026-04-01',
  last_change_reason: 'promotion',
  last_changed_by:    null,
  updated_at:         new Date().toISOString(),
}).eq('user_id', RASHID_DEV);
if (compUpdate.error) { console.error('comp update failed:', compUpdate.error); process.exit(1); }
console.log('  ✓ updated employee_compensation');

// 4. Insert the real history.
const ins = await sb.from('salary_history').insert([
  {
    user_id:         RASHID_DEV,
    effective_from:  '2025-02-10',
    previous_amount: null,
    new_amount:      50000,
    increment_pct:   null,
    change_reason:   'initial_seed',
    boss_notes:      'Starting salary at hire.',
    changed_by:      null,
  },
  {
    user_id:         RASHID_DEV,
    effective_from:  '2026-04-01',
    previous_amount: 50000,
    new_amount:      100000,
    increment_pct:   100,
    change_reason:   'promotion',
    boss_notes:      'Promotion effective April; first payout on May 1.',
    changed_by:      null,
  },
]);
if (ins.error) { console.error('history insert failed:', ins.error); process.exit(1); }
console.log('  ✓ inserted real history (2 rows)');

// 5. Record the override fact in audit_log.
const audit = await sb.from('audit_log').insert({
  actor_id:    null,
  action:      'salary.history_rewritten',
  entity_type: 'employee_compensation',
  entity_id:   RASHID_DEV,
  before:      { history: histBefore, comp: compBefore },
  after:       {
    history: [
      { effective_from: '2025-02-10', reason: 'initial_seed', new: 50000 },
      { effective_from: '2026-04-01', reason: 'promotion',    prev: 50000, new: 100000 },
    ],
    comp: { basic_salary: 100000, effective_from: '2026-04-01', reason: 'promotion' },
  },
});
if (audit.error) { console.warn('audit insert failed (non-fatal):', audit.error.message); }
else console.log('  ✓ audit_log entry recorded');

// 6. Verify
const { data: comp2 } = await sb.from('employee_compensation').select('basic_salary, effective_from, last_change_reason').eq('user_id', RASHID_DEV).single();
const { data: hist2 } = await sb.from('salary_history').select('*').eq('user_id', RASHID_DEV).order('effective_from');
console.log(`\nAfter:  comp.basic_salary=${comp2.basic_salary}  effective_from=${comp2.effective_from}  reason=${comp2.last_change_reason}`);
console.log('History:');
for (const h of hist2 || []) {
  console.log(`  ${h.effective_from}  ${h.change_reason.padEnd(18)} ${h.previous_amount ?? '—'} → ${h.new_amount}${h.increment_pct != null ? ` (${h.increment_pct}%)` : ''}`);
}
