// Step 01b: Incremental Auth user sync — non-destructive.
//
// Unlike step 01 (which wipes everything before importing), this step:
//   - lists v1 Firebase Auth users
//   - finds the ones missing in v2 Supabase Auth (by UID match — UIDs are
//     preserved verbatim because step 01 used `id = firebase_uid`)
//   - creates only the missing ones with email_confirm=true and the
//     same temp password convention
//   - lists v1 users docs and notes any that have no Auth account
//
// It does NOT delete v2 auth users (could be intentional v2 cleanups).
// Pair this with step 02 to refresh roles/display names.

import { fbDb, fbAuth } from '../lib/firebase.js';
import { sb } from '../lib/supabase.js';
import { makeLogger } from '../lib/log.js';
import { fbUidToUuid } from '../lib/uid.js';

const log = makeLogger('01b-auth-users-incremental');
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

  const [authUsers, usersSnap, sbAuth] = await Promise.all([
    listAllFirebaseAuthUsers(),
    fbDb.collection('users').get(),
    listAllSupabaseAuthUsers(),
  ]);

  const v1UsersByUid = new Map();
  usersSnap.docs.forEach((d) => v1UsersByUid.set(d.id, d.data()));

  // v2 auth ids are uuidv5(v1 uid) per step 01.
  const sbAuthByUuid = new Map(sbAuth.map((u) => [u.id, u]));

  const toCreate = authUsers.filter((u) =>
    v1UsersByUid.has(u.uid) && !sbAuthByUuid.has(fbUidToUuid(u.uid)),
  );
  const alreadyPresent = authUsers.filter((u) => sbAuthByUuid.has(fbUidToUuid(u.uid))).length;

  log.info(`v1 Firebase Auth users:    ${authUsers.length}`);
  log.info(`v1 users docs:             ${v1UsersByUid.size}`);
  log.info(`v2 Supabase Auth users:    ${sbAuth.length}`);
  log.info(`Already present in v2:     ${alreadyPresent}`);
  log.info(`New v1 users to create:    ${toCreate.length}`);

  if (toCreate.length) {
    log.info('Will create:');
    toCreate.forEach((u) => {
      const d = v1UsersByUid.get(u.uid);
      log.info(`  fb=${u.uid}  ${u.email}  role=${d?.role || '?'}  name=${d?.displayName || '?'}`);
    });
  }

  if (!APPLY) {
    log.info('DRY-RUN — no writes. Re-run with --apply to execute.');
    return;
  }

  let created = 0;
  let failed = 0;
  for (const u of toCreate) {
    const d = v1UsersByUid.get(u.uid) || {};
    const { error } = await sb.auth.admin.createUser({
      id: fbUidToUuid(u.uid),          // matches step 01 — uuidv5 of Firebase UID
      email: u.email,
      password: TEMP_PASSWORD,
      email_confirm: true,
      user_metadata: {
        display_name: d.displayName || '',
        role: d.role || 'apc',
      },
    });
    if (error) {
      failed++;
      log.error(`  FAIL ${u.email}: ${error.message}`);
    } else {
      created++;
      log.info(`  + ${u.email}`);
    }
  }

  log.info(`Created: ${created}, failed: ${failed}.`);
  log.info('Step 01b complete.');
}

main().catch((e) => {
  log.error(e.stack || e.message);
  process.exit(1);
});
