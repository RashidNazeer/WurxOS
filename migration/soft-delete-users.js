// One-shot: soft-delete the 5 named users.
//   * profiles.is_active = false
//   * profiles.deleted_at = now()
//   * remove their rows from membership tables (mirrors mig 113):
//     - brand_assignments
//     - pctl_brand_selections
//     - chat_members
//     - kb_acknowledgments
//     - suggestion_upvotes
// Historical FKs (attendance, tasks, reports, campaigns, incentives,
// notifications) keep pointing at the profile row — preserved on purpose.
//
// Idempotent: re-running has no extra effect.

import { sb } from './lib/supabase.js';

const APPLY = process.argv.includes('--apply');

const TARGET_NAMES = ['Raees Ali Azeem', 'Abdul Rafay', 'Raja Jihad', 'Mohib', 'Nadeem Hassan'];

async function main() {
  // 1. Resolve targets
  const { data: profiles, error } = await sb.from('profiles')
    .select('id, display_name, email, role, is_active, deleted_at')
    .in('display_name', TARGET_NAMES);
  if (error) { console.error(error); process.exit(1); }

  if (!profiles || profiles.length === 0) {
    console.error('No matching profiles found.');
    process.exit(1);
  }

  console.log(`Found ${profiles.length} matching profiles:`);
  for (const p of profiles) {
    console.log(`  ${p.display_name.padEnd(22)} role=${p.role.padEnd(4)} active=${p.is_active}  deleted_at=${p.deleted_at || 'null'}`);
  }
  if (profiles.length !== TARGET_NAMES.length) {
    console.warn(`\n⚠ Expected ${TARGET_NAMES.length} matches, got ${profiles.length}.`);
    const found = new Set(profiles.map(p => p.display_name));
    const missing = TARGET_NAMES.filter(n => !found.has(n));
    if (missing.length) console.warn('Missing:', missing.join(', '));
  }

  if (!APPLY) {
    console.log('\nDRY-RUN — re-run with --apply to soft-delete + clean memberships.');
    process.exit(0);
  }

  const ids = profiles.map(p => p.id);
  const now = new Date().toISOString();

  // 2. Soft-delete the profile (mark inactive + stamp deleted_at)
  const { error: pe } = await sb.from('profiles')
    .update({ is_active: false, deleted_at: now })
    .in('id', ids);
  if (pe) { console.error('profiles update failed:', pe.message); process.exit(1); }
  console.log(`\n✓ Soft-deleted ${ids.length} profiles (is_active=false, deleted_at=now()).`);

  // 3. Clean membership tables (mirrors mig 113 for these users)
  const tables = [
    ['brand_assignments',     'user_id'],
    ['pctl_brand_selections', 'pctl_id'],
    ['chat_members',          'user_id'],
    ['kb_acknowledgments',    'user_id'],
    ['suggestion_upvotes',    'user_id'],
  ];
  for (const [tbl, col] of tables) {
    const { count, error: de } = await sb.from(tbl).delete({ count: 'exact' }).in(col, ids);
    if (de) { console.warn(`  ${tbl}: ${de.message}`); continue; }
    console.log(`  ${tbl}: removed ${count ?? 0}`);
  }

  console.log('\nDone. These users are now hidden from every picker that filters on is_active or deleted_at.');
  console.log('Their attendance, tasks, reports, campaigns, incentives, and notifications are preserved.');
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
