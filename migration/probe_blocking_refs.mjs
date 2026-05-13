// Targeted probe: tables with ON DELETE RESTRICT (or known-non-cascade)
// referencing profiles. These are the actual blockers when deleting
// an auth user.

import { sb } from './lib/supabase.js';

const TARGETS = [
  { name: 'Samran',   id: '38c1b000-292b-55a0-b5d0-7ada6a8e6317' },
  { name: 'Test APC', id: '80f41dbf-9478-5036-8976-9ed7b6cbff02' },
];

const TABLES = {
  reports: ['author_id', 'submitted_by', 'verified_by', 'approved_by', 'rejected_by', 'reopened_by'],
  brand_switch_requests: ['from_owner_id', 'to_owner_id', 'requested_by', 'decided_by'],
  task_attachments: ['uploader_id'],
  task_comments: ['author_id'],
  audit_log: ['actor_id'],
  brands: ['owner_id'],
};

for (const t of TARGETS) {
  console.log(`\n=== ${t.name} (${t.id}) ===`);
  for (const [table, cols] of Object.entries(TABLES)) {
    for (const col of cols) {
      const { count, error } = await sb
        .from(table).select('*', { count: 'exact', head: true }).eq(col, t.id);
      if (error) {
        if (error.message && !/does not exist/i.test(error.message)) {
          console.log(`  ${table}.${col} ERR: ${error.message}`);
        }
        continue;
      }
      if ((count || 0) > 0) console.log(`  ${table}.${col}: ${count}`);
    }
  }
}
