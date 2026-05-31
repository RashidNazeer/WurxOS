// One-time backfill: seed public.employee_compensation from each user's
// most recent non-zero incentives.basic_salary.
//
// Run AFTER migration 185_salary_management.sql has been applied.
// Re-runnable: skips users who already have an employee_compensation row.
//
// Usage:
//   node migration/seed_salary_from_incentives.mjs --dry-run
//   node migration/seed_salary_from_incentives.mjs --commit
//
// Calls the SECURITY DEFINER RPC set_user_salary() via service-role
// auth so the Boss-only guard is bypassed for this one-time seed. Uses
// change_reason = 'initial_seed' so no employee notification fires.

import { sb } from './lib/supabase.js';

const COMMIT = process.argv.includes('--commit');
const VERBOSE = process.argv.includes('-v') || process.argv.includes('--verbose');

if (!COMMIT && !process.argv.includes('--dry-run')) {
  console.log('Pass --dry-run to preview or --commit to apply changes.');
  process.exit(1);
}

console.log(`Mode: ${COMMIT ? 'COMMIT' : 'DRY-RUN'}\n`);

// 1) Load active employees with their latest non-zero basic_salary.
const { data: profiles, error: pErr } = await sb
  .from('profiles')
  .select('id, display_name, email, role, is_active, deleted_at')
  .is('deleted_at', null)
  .eq('is_active', true);
if (pErr) { console.error('profile load failed:', pErr); process.exit(1); }

// 2) Already-seeded set.
const { data: already } = await sb
  .from('employee_compensation')
  .select('user_id');
const seeded = new Set((already || []).map(r => r.user_id));

let seededCount = 0, skippedHas = 0, skippedNoSalary = 0, errors = 0;
const noSalary = [];

for (const p of profiles) {
  if (seeded.has(p.id)) { skippedHas++; continue; }

  // Find the most recent non-zero basic_salary across all incentives months.
  const { data: incRows, error: iErr } = await sb
    .from('incentives')
    .select('basic_salary, month')
    .eq('user_id', p.id)
    .gt('basic_salary', 0)
    .order('month', { ascending: false })
    .limit(1);
  if (iErr) { console.warn(`  ${p.display_name}: incentives query failed:`, iErr.message); errors++; continue; }

  const latest = incRows?.[0];
  if (!latest) {
    skippedNoSalary++;
    noSalary.push(`${p.display_name} (${p.role})`);
    continue;
  }

  if (VERBOSE || !COMMIT) {
    console.log(`  ${p.display_name.padEnd(28)} ${p.role.padEnd(5)}  PKR ${Number(latest.basic_salary).toLocaleString()}  (from ${latest.month})`);
  }

  if (COMMIT) {
    const { error: rErr } = await sb.rpc('set_user_salary', {
      p_uid:            p.id,
      p_new_amount:     latest.basic_salary,
      p_change_reason:  'initial_seed',
      p_increment_pct:  null,
      p_boss_notes:     `Seeded from incentives.basic_salary (month ${latest.month})`,
      p_effective_from: null,
    });
    if (rErr) {
      console.error(`  ✗ ${p.display_name}: RPC failed:`, rErr.message);
      errors++;
      continue;
    }
  }
  seededCount++;
}

console.log('');
console.log(`Seeded:              ${seededCount}`);
console.log(`Already had a row:   ${skippedHas}`);
console.log(`No salary anywhere:  ${skippedNoSalary}`);
console.log(`Errors:              ${errors}`);

if (noSalary.length) {
  console.log('\nUsers with no salary data — Boss must enter manually:');
  for (const n of noSalary) console.log(`  • ${n}`);
}

if (!COMMIT) console.log('\n(dry-run — re-run with --commit to apply)');
