// Step 00: Audit — counts every relevant Firestore collection AND
// the existing v2 Supabase tables. Read-only on both sides. No writes.
//
// Goal: give us a clear picture of what we're migrating before we
// write a single transform.

import { fbDb, fbAuth, fbProjectId } from '../lib/firebase.js';
import { sb } from '../lib/supabase.js';
import { makeLogger } from '../lib/log.js';

const log = makeLogger('00-audit');

const TOP_LEVEL_COLLECTIONS = [
  'users',
  'teamUsers',
  'brands',
  'campaigns',
  'productCampaigns',
  'incentives',
  'changes',
  'sopVersions',
  'knowledgeBase',
  'attendance',
  'leaveRequests',
  'generalTasks',
  'requests',
  'suggestions',
  'meetings',
  'reminders',
  'performance',
  'bugs',
  'reports',
  'broadcasts',  // skipped per user request, but counted for completeness
  'chats',
  'notifications',
];

async function countFb(name) {
  try {
    const snap = await fbDb.collection(name).count().get();
    return snap.data().count;
  } catch (e) {
    return `ERR: ${e.message}`;
  }
}

async function countAuthUsers() {
  let total = 0;
  let nextPageToken;
  do {
    const page = await fbAuth.listUsers(1000, nextPageToken);
    total += page.users.length;
    nextPageToken = page.pageToken;
  } while (nextPageToken);
  return total;
}

async function countSb(table) {
  const { count, error } = await sb
    .from(table)
    .select('*', { count: 'exact', head: true });
  if (error) return `ERR: ${error.message}`;
  return count;
}

const SB_TABLES = [
  'profiles',
  'brands',
  'tasks',
  'task_comments',
  'kb_articles',
  'incentives',
  'attendance',
  'attendance_entries',
  'leave_requests',
  'performance',
  'product_campaigns',
  'reminders',
  'changes',
  'bugs',
  'reports',
  'notifications',
];

async function main() {
  log.info(`Firebase project: ${fbProjectId}`);
  log.info('--- Firebase Auth ---');
  const authCount = await countAuthUsers();
  log.info(`auth.users: ${authCount}`);

  log.info('--- Firestore collections (v1) ---');
  for (const c of TOP_LEVEL_COLLECTIONS) {
    const n = await countFb(c);
    log.info(`  ${c.padEnd(20)} ${n}`);
  }

  log.info('--- Supabase tables (v2 current state) ---');
  for (const t of SB_TABLES) {
    const n = await countSb(t);
    log.info(`  ${t.padEnd(22)} ${n}`);
  }

  log.info('Audit complete.');
}

main().catch((e) => {
  log.error(e.stack || e.message);
  process.exit(1);
});
