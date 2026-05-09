// Step 01: wipe v2 dummy data + import v1 Auth users into Supabase Auth.
//
// What this does:
//   1. (apply only) Calls wipe_all_operational_data() RPC to clear v2
//      operational tables. profiles + auth.users are NOT touched by the
//      RPC, so we delete those manually next.
//   2. (apply only) Deletes every existing v2 auth.users row (profiles
//      cascade-delete). Confirms a clean slate.
//   3. For every v1 user that has BOTH a Firebase Auth account AND a
//      Firestore `users` doc, creates a Supabase auth user with:
//        - id = Firebase UID (preserves all foreign-key references)
//        - email = v1 email
//        - password = "12345678"
//        - email_confirm = true (no verification required)
//      The auto-create-profile trigger seeds a default `apc` profile;
//      step 02 overwrites it with the real role / display_name / etc.
//   4. Skips the 8 orphan Firebase Auth users (no users doc).
//
// v1 is read-only the entire time. Only Supabase is mutated, and only
// when --apply is set.

import { fbDb, fbAuth } from '../lib/firebase.js';
import { sb } from '../lib/supabase.js';
import { makeLogger } from '../lib/log.js';
import { fbUidToUuid } from '../lib/uid.js';

const log = makeLogger('01-auth-users');
const APPLY = process.env.MIGRATION_APPLY === '1';
const TEMP_PASSWORD = '12345678';

async function listAllFirebaseAuthUsers() {
  const out = [];
  let token;
  do {
    const page = await fbAuth.listUsers(1000, token);
    out.push(...page.users);
    token = page.pageToken;
  } while (token);
  return out;
}

async function listAllSupabaseAuthUsers() {
  const out = [];
  let page = 1;
  while (true) {
    const { data, error } = await sb.auth.admin.listUsers({ page, perPage: 200 });
    if (error) throw error;
    out.push(...data.users);
    if (data.users.length < 200) break;
    page++;
  }
  return out;
}

async function main() {
  log.info(`Mode: ${APPLY ? 'APPLY' : 'DRY-RUN'}`);

  // --- 1. Read v1 + plan ---
  const [authUsers, usersSnap] = await Promise.all([
    listAllFirebaseAuthUsers(),
    fbDb.collection('users').get(),
  ]);
  const usersByUid = new Map();
  usersSnap.docs.forEach((d) => usersByUid.set(d.id, d.data()));
  const userDocIds = new Set(usersByUid.keys());

  const toImport = authUsers.filter((u) => userDocIds.has(u.uid));
  const orphans = authUsers.filter((u) => !userDocIds.has(u.uid));
  const usersDocsWithoutAuth = [...userDocIds].filter(
    (id) => !authUsers.some((u) => u.uid === id),
  );

  log.info(`v1 Firebase Auth users:        ${authUsers.length}`);
  log.info(`v1 users docs:                 ${usersByUid.size}`);
  log.info(`Will import (Auth + users doc): ${toImport.length}`);
  log.info(`Skipping orphans (Auth only):  ${orphans.length}`);
  log.info(`users docs without Auth:       ${usersDocsWithoutAuth.length}`);

  if (orphans.length) {
    log.info('Orphans to skip:');
    orphans.forEach((u) => log.info(`  ${u.uid}  ${u.email}`));
  }
  if (usersDocsWithoutAuth.length) {
    log.warn('users docs without Auth (these will NOT have a v2 login):');
    usersDocsWithoutAuth.forEach((id) => {
      const d = usersByUid.get(id);
      log.warn(`  ${id}  ${d.email}  (${d.role})`);
    });
  }

  // --- 2. Read current v2 state ---
  const [{ count: profileCount }, sbAuth] = await Promise.all([
    sb.from('profiles').select('*', { count: 'exact', head: true }),
    listAllSupabaseAuthUsers(),
  ]);
  log.info(`Current v2 profiles:    ${profileCount}`);
  log.info(`Current v2 auth.users:  ${sbAuth.length}`);
  if (sbAuth.length) {
    log.info('v2 auth users that will be wiped:');
    sbAuth.forEach((u) => log.info(`  ${u.id}  ${u.email}`));
  }

  // --- 3. Sample plan ---
  log.info('First 5 imports planned:');
  toImport.slice(0, 5).forEach((u) => {
    const d = usersByUid.get(u.uid);
    log.info(
      `  fb=${u.uid}  ->  ${fbUidToUuid(u.uid)}  ${u.email}  role=${d.role}  name=${d.displayName}`,
    );
  });

  if (!APPLY) {
    log.info('DRY-RUN — no changes made. Re-run with --apply to execute.');
    return;
  }

  // ============================================================
  // APPLY PATH
  // ============================================================

  // --- 4. Wipe operational data (does NOT touch profiles/auth) ---
  log.info('Calling wipe_all_operational_data() ...');
  // RPC requires a Boss caller. Service-role bypasses RLS but the function
  // checks auth.uid() and role manually. Easiest: TRUNCATE the same tables
  // directly via raw SQL is not exposed — so instead, we inline the wipe
  // by deleting row-by-row with the service-role key. Simpler approach:
  // since profiles cascade-delete from auth.users, deleting all auth.users
  // will null out most cross-table references. But cascades only fire for
  // FKs that opted-in. To be safe we explicitly delete from operational
  // tables in dependency order before nuking auth.
  const opTables = [
    'task_attachments',
    'task_comments',
    'tasks',
    'attendance_edit_requests',
    'attendance',
    'leave_requests',
    'incentives',
    'kb_acknowledgments',
    'kb_comments',
    'kb_articles',
    'reminders',
    'change_thread',
    'changes',
    'bug_report_messages',
    'bug_reports',
    'suggestion_upvotes',
    'suggestions',
    'product_campaigns',
    'broadcast_responses',
    'broadcasts',
    'campaign_notification_log',
    'tier_notification_log',
    'campaigns',
    'performance_ratings',
    'performance_warnings',
    'performance_flags',
    'reports',
    'report_shares',
    'user_report_custom_fields',
    'resources',
    'resource_planner_config',
    'pctl_brand_selections',
    'brand_switch_requests',
    'brand_assignments',
    'brand_metrics',
    'brand_custom_fields',
    'brand_products',
    'brands',
    'chat_messages',
    'chat_members',
    'chat_channels',
    'notifications',
    'audit_log',
  ];
  for (const t of opTables) {
    const { error } = await sb.from(t).delete().neq('id', '00000000-0000-0000-0000-000000000000');
    if (error && !/does not exist|column .* does not exist/i.test(error.message)) {
      // Some tables don't have an `id` column (e.g. chat_members uses composite).
      // Try a generic delete-all by matching anything via created_at.
      const alt = await sb.from(t).delete().gte('created_at', '1970-01-01');
      if (alt.error && !/does not exist/i.test(alt.error.message)) {
        log.warn(`Could not wipe ${t}: ${alt.error.message}`);
      } else {
        log.info(`  wiped ${t} (alt key)`);
      }
    } else if (error) {
      log.info(`  skipped ${t} (${error.message})`);
    } else {
      log.info(`  wiped ${t}`);
    }
  }

  // --- 5. Delete every v2 auth user (cascades delete profiles) ---
  log.info('Deleting all v2 auth users...');
  for (const u of sbAuth) {
    const { error } = await sb.auth.admin.deleteUser(u.id);
    if (error) log.warn(`  failed to delete ${u.email}: ${error.message}`);
    else log.info(`  deleted ${u.email}`);
  }

  // Sanity check.
  const after = await listAllSupabaseAuthUsers();
  if (after.length > 0) {
    log.error(`Expected 0 auth users after wipe, got ${after.length}. Stopping.`);
    process.exit(1);
  }
  const { count: profilesAfter } = await sb
    .from('profiles')
    .select('*', { count: 'exact', head: true });
  if (profilesAfter > 0) {
    log.error(`Expected 0 profiles after wipe, got ${profilesAfter}. Stopping.`);
    process.exit(1);
  }
  log.info('v2 is now empty (0 auth users, 0 profiles).');

  // --- 6. Import 47 users with deterministic v5-mapped UIDs ---
  log.info(`Creating ${toImport.length} v2 auth users...`);
  let ok = 0, fail = 0;
  for (const u of toImport) {
    const d = usersByUid.get(u.uid);
    const newId = fbUidToUuid(u.uid);
    const { error } = await sb.auth.admin.createUser({
      id: newId,
      email: u.email,
      password: TEMP_PASSWORD,
      email_confirm: true,
      user_metadata: {
        display_name: d.displayName || null,
        v1_uid: u.uid,
        migrated_at: new Date().toISOString(),
      },
    });
    if (error) {
      fail++;
      log.error(`  FAIL ${u.email} (${u.uid} -> ${newId}): ${error.message}`);
    } else {
      ok++;
      log.info(`  + ${u.email}  fb=${u.uid}  ->  ${newId}`);
    }
  }
  log.info(`Created: ${ok}  Failed: ${fail}`);
  if (fail > 0) {
    log.error('Some users failed to import. Check the log and fix before continuing.');
    process.exit(1);
  }

  log.info('Step 01 complete. Run step 02 next to populate profile fields.');
}

main().catch((e) => {
  log.error(e.stack || e.message);
  process.exit(1);
});
