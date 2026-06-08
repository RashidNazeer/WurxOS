// Delete the duplicate Rashid Nazeer (apc) profile and the now-defunct
// Smackin brand, plus their last clinging references (one stale task,
// one approved leave request). Per chat instruction 2026-05-31.
//
// Strategy: snapshot every row to a backup JSON file BEFORE deleting,
// so the whole operation is reversible by re-inserting from that file
// if anything was wrong.
//
// Pass --dry-run to preview, --commit to execute.

import { sb } from './lib/supabase.js';
import { writeFileSync } from 'node:fs';

const COMMIT = process.argv.includes('--commit');
if (!COMMIT && !process.argv.includes('--dry-run')) {
  console.log('Pass --dry-run to preview or --commit to execute.');
  process.exit(1);
}

const APC_UID  = '3582f4f1-e018-507d-af98-8ae206320c5e';   // Rashid Nazeer (apc)
const BRAND_ID = '96ddfecb-a4d6-5651-98fb-7c22f74e5011';   // Smackin
const TASK_ID  = 'bbb91c0c-d694-5bc1-bc57-237a0b67d305';   // Chat Sort
const LEAVE_ID = '7bc9e6d0-656f-4bd5-88ef-a01a50ebf170';   // apc Rashid's other leave

// ── Snapshot ─────────────────────────────────────────────────
const [
  { data: profile },
  { data: brand },
  { data: task },
  { data: leave },
] = await Promise.all([
  sb.from('profiles').select('*').eq('id', APC_UID).maybeSingle(),
  sb.from('brands').select('*').eq('id', BRAND_ID).maybeSingle(),
  sb.from('tasks').select('*').eq('id', TASK_ID).maybeSingle(),
  sb.from('leave_requests').select('*').eq('id', LEAVE_ID).maybeSingle(),
]);

const backup = { snapshotAt: new Date().toISOString(), profile, brand, task, leave };
const path = 'migration/_deleted_rashid_smackin_backup.json';
writeFileSync(path, JSON.stringify(backup, null, 2));
console.log(`Snapshot saved to ${path}`);
console.log(`  profile: ${profile ? `${profile.display_name} (${profile.role})` : '(missing)'}`);
console.log(`  brand:   ${brand ? `"${brand.brand_name}" status=${brand.status}` : '(missing)'}`);
console.log(`  task:    ${task ? `"${task.title}" status=${task.status}` : '(missing)'}`);
console.log(`  leave:   ${leave ? `${leave.type} ${leave.status} ${leave.start_date}→${leave.end_date}` : '(missing)'}`);

if (!COMMIT) {
  console.log('\n(dry-run — nothing deleted; re-run with --commit)');
  process.exit(0);
}

// ── Execute ──────────────────────────────────────────────────
console.log('\nDeleting…');

const r1 = await sb.from('tasks').delete().eq('id', TASK_ID);
console.log(`  tasks.delete:           ${r1.error ? '✗ ' + r1.error.message : '✓'}`);

const r2 = await sb.from('leave_requests').delete().eq('id', LEAVE_ID);
console.log(`  leave_requests.delete:  ${r2.error ? '✗ ' + r2.error.message : '✓'}`);

const r3 = await sb.from('brands').delete().eq('id', BRAND_ID);
console.log(`  brands.delete:          ${r3.error ? '✗ ' + r3.error.message : '✓'}`);

// Soft-delete profile (same shape as the delete-user Edge Function).
const r4 = await sb
  .from('profiles')
  .update({ is_active: false, deleted_at: new Date().toISOString(), updated_at: new Date().toISOString() })
  .eq('id', APC_UID);
console.log(`  profiles.soft-delete:   ${r4.error ? '✗ ' + r4.error.message : '✓'}`);

console.log('\nDone. Snapshot saved at ' + path + ' — re-insert if you need to undo.');
