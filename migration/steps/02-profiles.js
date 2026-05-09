// Step 02: populate v2 profiles from v1 users + teamUsers.
//
// After step 01, v2 has 47 auth users + 47 auto-seeded profile rows
// (placeholder role/name). This step UPDATES each profile with the
// real fields from v1:
//
//   users doc          ->  profiles
//     role             ->  role
//     displayName      ->  display_name
//     createdBy (uid)  ->  created_by (mapped via fbUidToUuid)
//     canAddAPC etc.   ->  permissions { canAddAPC: ..., canAddBrand: ..., canManageIncentives: ... }
//     leaveQuota       ->  leave_quota (jsonb)
//     resetSchedule    ->  reset_schedule (jsonb)
//     customResponsibilities -> responsibilities (text[])
//
//   teamUsers doc      ->  same profile, additional fields:
//     ownerId (uid)    ->  reports_to (mapped)
//     tasks (array)    ->  responsibilities (overwrite users.customResponsibilities)
//     canManageTasks   ->  permissions.canManageTasks
//     canManageResources -> permissions.canManageResources
//
// reports_to (FK) constraint: profiles row must exist for the target.
// We set reports_to AFTER all profiles are upserted, in a second pass,
// so order of inserts doesn't matter.
//
// v1 read-only. v2 write-only. Idempotent — re-running just rewrites
// the same values.

import { fbDb } from '../lib/firebase.js';
import { sb } from '../lib/supabase.js';
import { fbUidToUuid } from '../lib/uid.js';
import { makeLogger } from '../lib/log.js';

const log = makeLogger('02-profiles');
const APPLY = process.env.MIGRATION_APPLY === '1';

const VALID_ROLES = ['boss','ol','tl','pctl','apc','ipc','developer'];

function buildPermissions(userDoc, teamUserDoc) {
  const out = {};
  // From users doc (TL/PCTL flags)
  if (userDoc?.canAddAPC          === true) out.canAddAPC          = true;
  if (userDoc?.canAddBrand        === true) out.canAddBrand        = true;
  if (userDoc?.canManageIncentives === true) out.canManageIncentives = true;
  if (userDoc?.canAddIPC          === true) out.canAddIPC          = true;
  // From teamUsers doc (APC/IPC flags)
  if (teamUserDoc?.canManageTasks     === true) out.canManageTasks     = true;
  if (teamUserDoc?.canManageResources === true) out.canManageResources = true;
  return out;
}

function buildResponsibilities(userDoc, teamUserDoc) {
  // teamUsers.tasks is the canonical "what this team member is responsible for" list.
  if (Array.isArray(teamUserDoc?.tasks) && teamUserDoc.tasks.length > 0) {
    return teamUserDoc.tasks.filter((t) => typeof t === 'string' && t.trim());
  }
  // Fallback: users.customResponsibilities (single string) split by comma.
  const custom = (userDoc?.customResponsibilities || '').trim();
  if (custom) {
    return custom.split(/\s*,\s*/).filter(Boolean);
  }
  return [];
}

// v2 default — used when v1 quota is missing OR uses v1's old shape
// ({wfh, casual, medical_emergency}). v2's RPCs read {wfh, medical,
// emergency}, so importing the v1 shape verbatim gives wfh:4 and 0
// for both medical & emergency (broken — keys never read).
const V2_LEAVE_DEFAULT = { wfh: 2, medical: 1, emergency: 1 };

function buildLeaveQuota(userDoc, teamUserDoc) {
  // Prefer teamUsers leaveQuota (for APC/IPC), fall back to users leaveQuota.
  const raw = teamUserDoc?.leaveQuota || userDoc?.leaveQuota || null;
  if (!raw || typeof raw !== 'object') return null;

  // Detect v1 shape — has 'casual' and/or 'medical_emergency'.
  const isV1Shape = ('casual' in raw) || ('medical_emergency' in raw);
  if (isV1Shape) {
    // v1's wfh:4 was per-month with monthly reset; v2's default is wfh:2.
    // Fall back to the v2 default rather than copying v1's values across
    // mis-named keys. The Boss can adjust per-user if needed via the v2
    // admin UI; we don't try to interpret medical_emergency as either
    // medical or emergency since v1 used it as a combined bucket.
    return { ...V2_LEAVE_DEFAULT };
  }
  // Already v2 shape (wfh + medical + emergency or a subset) — pass through.
  return raw;
}

function buildResetSchedule(userDoc, teamUserDoc) {
  return teamUserDoc?.resetSchedule || userDoc?.resetSchedule || null;
}

async function main() {
  log.info(`Mode: ${APPLY ? 'APPLY' : 'DRY-RUN'}`);

  // Load all v1 user data.
  const [usersSnap, teamUsersSnap, sbProfsRes] = await Promise.all([
    fbDb.collection('users').get(),
    fbDb.collection('teamUsers').get(),
    sb.from('profiles').select('id'),
  ]);

  const usersByUid = new Map();
  usersSnap.docs.forEach((d) => usersByUid.set(d.id, d.data()));
  const teamUsersByUid = new Map();
  teamUsersSnap.docs.forEach((d) => teamUsersByUid.set(d.id, d.data()));

  const sbProfileIds = new Set((sbProfsRes.data || []).map((r) => r.id));

  log.info(`v1 users docs:        ${usersByUid.size}`);
  log.info(`v1 teamUsers docs:    ${teamUsersByUid.size}`);
  log.info(`v2 profile rows:      ${sbProfileIds.size}`);

  // Build the patch list.
  const patches = [];
  const skipped = [];
  for (const [fbUid, u] of usersByUid) {
    const sbId = fbUidToUuid(fbUid);
    if (!sbProfileIds.has(sbId)) {
      skipped.push({ fbUid, email: u.email, reason: 'no v2 profile (orphan?)' });
      continue;
    }
    const tu = teamUsersByUid.get(fbUid) || null;

    // v1 used "dev" — v2's CHECK constraint expects "developer".
    let role = u.role === 'dev' ? 'developer' : u.role;
    if (!VALID_ROLES.includes(role)) {
      log.warn(`Unknown role "${role}" for ${u.email}; defaulting to apc`);
      role = 'apc';
    }

    const lq = buildLeaveQuota(u, tu);
    const rs = buildResetSchedule(u, tu);
    const patch = {
      role,
      display_name: u.displayName || tu?.userName || u.email.split('@')[0],
      created_by:   u.createdBy ? fbUidToUuid(u.createdBy) : null,
      permissions:  buildPermissions(u, tu),
      responsibilities: buildResponsibilities(u, tu),
    };
    // Only override defaults if v1 actually had values. Otherwise the
    // auto-trigger's defaults stand (NOT NULL constraint forbids us
    // sending null explicitly).
    if (lq) patch.leave_quota = lq;
    if (rs) patch.reset_schedule = rs;

    patches.push({
      sbId,
      fbUid,
      email: u.email,
      patch,
      reportsTo: tu?.ownerId ? fbUidToUuid(tu.ownerId) : null,
    });
  }

  // Distribution preview.
  const dist = patches.reduce((m, p) => { m[p.patch.role] = (m[p.patch.role]||0)+1; return m; }, {});
  log.info(`Will update ${patches.length} profiles. Role distribution:`);
  for (const [r, n] of Object.entries(dist)) log.info(`  ${r.padEnd(10)} ${n}`);
  if (skipped.length) {
    log.warn(`Skipped ${skipped.length} v1 users with no v2 profile:`);
    skipped.forEach((s) => log.warn(`  fb=${s.fbUid}  ${s.email}  (${s.reason})`));
  }

  // Sample
  log.info('Sample 3 patches:');
  patches.slice(0, 3).forEach((p) => {
    log.info(`  ${p.email} (role=${p.patch.role})`);
    log.info(`    perms: ${JSON.stringify(p.patch.permissions)}`);
    log.info(`    resp:  ${JSON.stringify(p.patch.responsibilities)}`);
    log.info(`    leave: ${JSON.stringify(p.patch.leave_quota)}`);
    log.info(`    reports_to (fb=${p.reportsTo ? p.reportsTo.slice(0,8)+'...' : 'null'})`);
  });

  // Pre-flight: verify every reports_to target exists.
  const orphanReports = patches.filter(
    (p) => p.reportsTo && !sbProfileIds.has(p.reportsTo) && !patches.some((x) => x.sbId === p.reportsTo),
  );
  if (orphanReports.length) {
    log.warn(`${orphanReports.length} profiles have a reports_to that points at a non-existent profile. They will be set to NULL.`);
    orphanReports.forEach((p) => log.warn(`  ${p.email}  reports_to=${p.reportsTo}`));
  }

  if (!APPLY) {
    log.info('DRY-RUN — no writes. Re-run with --apply to execute.');
    return;
  }

  // ============================================================
  // APPLY
  // ============================================================

  // Pass 1: update everything except reports_to (avoids FK ordering issues).
  log.info('Pass 1: updating profile fields...');
  let ok = 0, fail = 0;
  for (const p of patches) {
    const { error } = await sb.from('profiles').update(p.patch).eq('id', p.sbId);
    if (error) {
      fail++;
      log.error(`  FAIL ${p.email}: ${error.message}`);
    } else {
      ok++;
      if (ok % 10 === 0) log.info(`  ${ok}/${patches.length}`);
    }
  }
  log.info(`Pass 1 done. ok=${ok} fail=${fail}`);
  if (fail) {
    log.error('Pass 1 had failures — fix and re-run before continuing.');
    process.exit(1);
  }

  // Pass 2: set reports_to. Only set if the target profile exists.
  log.info('Pass 2: setting reports_to...');
  const allIds = new Set(patches.map((p) => p.sbId));
  let setCount = 0, nulled = 0;
  for (const p of patches) {
    if (!p.reportsTo) continue;
    const target = allIds.has(p.reportsTo) ? p.reportsTo : null;
    if (!target) { nulled++; continue; }
    const { error } = await sb.from('profiles').update({ reports_to: target }).eq('id', p.sbId);
    if (error) log.error(`  FAIL reports_to ${p.email}: ${error.message}`);
    else setCount++;
  }
  log.info(`Pass 2 done. set=${setCount} nulled=${nulled}`);

  log.info('Step 02 complete. Verify in v2 admin UI before running step 03.');
}

main().catch((e) => {
  log.error(e.stack || e.message);
  process.exit(1);
});
