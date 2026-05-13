// What still points at Samran / Test APC user IDs?
// Counts rows in every table likely to reference a user.

import { sb } from './lib/supabase.js';

const TARGETS = [
  { name: 'Samran',   id: '38c1b000-292b-55a0-b5d0-7ada6a8e6317' },
  { name: 'Test APC', id: '80f41dbf-9478-5036-8976-9ed7b6cbff02' },
];

// table → list of column names to check
const TABLES = {
  attendance:               ['user_id', 'approval_by', 'closed_by_manager_id'],
  attendance_adjustments:   ['user_id', 'created_by', 'updated_by'],
  attendance_edit_requests: ['user_id', 'requested_by', 'decided_by'],
  audit_log:                ['user_id', 'actor_id'],
  app_events:               ['user_id'],
  notifications:            ['user_id', 'actor_id'],
  push_subscriptions:       ['user_id'],
  tasks:                    ['assignee_id', 'created_by'],
  task_comments:            ['author_id', 'user_id'],
  leave_requests:           ['requester_id', 'approved_by', 'rejected_by'],
  performance_ratings:      ['user_id', 'rated_by'],
  performance_flags:        ['user_id', 'created_by'],
  performance_warnings:     ['user_id', 'created_by'],
  incentives:               ['user_id', 'created_by'],
  brand_assignments:        ['user_id'],
  brands:                   ['owner_id', 'created_by'],
  brand_switches:           ['from_user_id', 'to_user_id', 'initiated_by'],
  kb_articles:              ['created_by', 'updated_by'],
  bug_reports:              ['reporter_id', 'assignee_id'],
  suggestions:              ['suggester_id'],
  resources:                ['created_by'],
  reports:                  ['user_id', 'created_by'],
  weekly_reports:           ['user_id', 'created_by'],
  biweekly_reports:         ['user_id', 'created_by'],
  monthly_reports:          ['user_id', 'created_by'],
  reminders:                ['user_id', 'created_by'],
  broadcasts:               ['created_by'],
  broadcast_reads:          ['user_id'],
  changes:                  ['created_by'],
  chat_messages:            ['author_id', 'sender_id'],
  chat_participants:        ['user_id'],
  client_access:            ['user_id', 'created_by'],
  campaigns:                ['created_by'],
  product_campaigns:        ['created_by'],
  paid_collab_videos:       ['created_by'],
  profiles:                 ['reports_to', 'created_by'],
  company_holidays:         ['created_by'],
};

for (const t of TARGETS) {
  console.log(`\n=== ${t.name} (${t.id}) ===`);
  for (const [table, cols] of Object.entries(TABLES)) {
    for (const col of cols) {
      try {
        const { count, error } = await sb
          .from(table)
          .select('*', { count: 'exact', head: true })
          .eq(col, t.id);
        if (error) {
          // Table or column may not exist — skip silently for unknown
          // schemas. Only show real errors.
          if (!/does not exist|relation .* does not exist/i.test(error.message)) {
            console.log(`  ${table}.${col} ERR: ${error.message}`);
          }
          continue;
        }
        if ((count || 0) > 0) {
          console.log(`  ${table}.${col}: ${count}`);
        }
      } catch (e) {
        // ignore
      }
    }
  }
}
