// Step 04: attendance — 351 records.
//
// v1 attendance doc            v2 attendance row
//   id (userId_date)            id (uuidv5 of v1 doc id)
//   userId (fb uid)             user_id (mapped)
//   date ('YYYY-MM-DD')         date (date)
//   clockIn (ts)                clock_in (timestamptz)
//   clockOut (ts)               clock_out
//   location                    location (already valid: lakecity/bahria/wfh)
//   status                      status (clocked-in / clocked-out)
//   breaks (array)              breaks (jsonb)
//   totalWorkMs                 total_work_ms
//   totalBreakMs                total_break_ms
//   approvalBy (fb uid)         approval_by (mapped)
//   approvalAt                  approval_at
//   rejectionReason / clockOutNote -> approval_note (best fit)
//
// Skipped: userName / userRole / userEmail / ownerId — derivable from
// profiles. requestedAt / requestTimeMs — not modeled in v2.

import { fbDb } from '../lib/firebase.js';
import { sb } from '../lib/supabase.js';
import { fbUidToUuid, fbDocIdToUuid } from '../lib/uid.js';
import { makeLogger } from '../lib/log.js';
import { deleteOrphans } from '../lib/sync.js';

const log = makeLogger('04-attendance');
const APPLY = process.env.MIGRATION_APPLY === '1';

const VALID_LOCATIONS = new Set(['wfh','bahria','lakecity','office']);

function ts(v) {
  if (!v) return null;
  if (v._seconds) return new Date(v._seconds * 1000).toISOString();
  if (v.toDate) return v.toDate().toISOString();
  return null;
}

function transformBreaks(breaks) {
  if (!Array.isArray(breaks)) return [];
  return breaks.map((b) => {
    const out = {};
    if (b.start) out.start = ts(b.start) || b.start;
    if (b.end)   out.end   = ts(b.end)   || b.end;
    return out;
  });
}

async function main() {
  log.info(`Mode: ${APPLY ? 'APPLY' : 'DRY-RUN'}`);

  const [snap, profsRes] = await Promise.all([
    fbDb.collection('attendance').get(),
    sb.from('profiles').select('id'),
  ]);
  const profileIds = new Set((profsRes.data || []).map((r) => r.id));
  log.info(`v1 attendance: ${snap.size}`);
  log.info(`v2 profiles available: ${profileIds.size}`);

  const rows = [];
  const skipped = [];
  const dedupKey = new Set();

  for (const d of snap.docs) {
    const a = d.data();
    const userUuid = fbUidToUuid(a.userId);
    if (!userUuid || !profileIds.has(userUuid)) {
      skipped.push({ id: d.id, reason: `user ${a.userId} not in v2 profiles` });
      continue;
    }
    if (!a.date || !/^\d{4}-\d{2}-\d{2}$/.test(a.date)) {
      skipped.push({ id: d.id, reason: `bad date ${a.date}` });
      continue;
    }
    const loc = VALID_LOCATIONS.has(a.location) ? a.location : 'wfh';

    // De-dupe (user_id, date) — there's a UNIQUE constraint in v2.
    const k = `${userUuid}|${a.date}`;
    if (dedupKey.has(k)) {
      skipped.push({ id: d.id, reason: `duplicate (user_id, date)` });
      continue;
    }
    dedupKey.add(k);

    // approval_note: prefer rejectionReason for rejected, else clockOutNote
    const approvalNote =
      a.approvalStatus === 'rejected' && a.rejectionReason
        ? a.rejectionReason
        : (a.clockOutNote || null);

    rows.push({
      id: fbDocIdToUuid(d.id),
      legacy_id: d.id,
      user_id: userUuid,
      date: a.date,
      clock_in: ts(a.clockIn) || new Date(`${a.date}T09:00:00Z`).toISOString(),
      clock_out: ts(a.clockOut),
      location: loc,
      status: a.status === 'clocked-out' ? 'clocked-out' : 'clocked-in',
      breaks: transformBreaks(a.breaks),
      approval_by: a.approvalBy ? fbUidToUuid(a.approvalBy) : null,
      approval_at: ts(a.approvalAt),
      approval_note: approvalNote,
      auto_closed: !!(a.clockOutNote && a.clockOutNote.includes('Auto-clocked out')),
      total_work_ms: a.totalWorkMs ? Math.round(a.totalWorkMs) : null,
      total_break_ms: a.totalBreakMs ? Math.round(a.totalBreakMs) : null,
      created_at: ts(a.clockIn) || new Date().toISOString(),
    });
  }

  // Filter out approval_by that doesn't exist in v2 profiles (orphan approver).
  for (const r of rows) {
    if (r.approval_by && !profileIds.has(r.approval_by)) {
      r.approval_by = null;
    }
  }

  log.info(`Rows ready to upsert: ${rows.length}`);
  log.info(`Skipped: ${skipped.length}`);
  if (skipped.length) {
    skipped.slice(0, 10).forEach((s) => log.warn(`  ${s.id}: ${s.reason}`));
    if (skipped.length > 10) log.warn(`  ... and ${skipped.length - 10} more`);
  }

  // Stats
  const statusCount = rows.reduce((m, r) => { m[r.status] = (m[r.status]||0)+1; return m; }, {});
  const locCount = rows.reduce((m, r) => { m[r.location] = (m[r.location]||0)+1; return m; }, {});
  const autoClosed = rows.filter((r) => r.auto_closed).length;
  const withBreaks = rows.filter((r) => Array.isArray(r.breaks) && r.breaks.length > 0).length;
  log.info(`  by status:    ${JSON.stringify(statusCount)}`);
  log.info(`  by location:  ${JSON.stringify(locCount)}`);
  log.info(`  auto_closed:  ${autoClosed}`);
  log.info(`  with breaks:  ${withBreaks}`);

  log.info('Sample 3 rows:');
  rows.slice(0, 3).forEach((r) =>
    log.info(`  ${r.date} user=${r.user_id.slice(0,8)} status=${r.status} loc=${r.location} work_ms=${r.total_work_ms}`),
  );

  if (!APPLY) {
    log.info('DRY-RUN — no writes. Re-run with --apply to execute.');
    return;
  }

  // Insert in batches to avoid request size limits.
  const CHUNK = 100;
  let ok = 0;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK);
    const { error } = await sb.from('attendance').upsert(chunk, { onConflict: 'id' });
    if (error) {
      log.error(`Chunk ${i / CHUNK}: ${error.message}`);
      process.exit(1);
    }
    ok += chunk.length;
    log.info(`  ${ok}/${rows.length}`);
  }
  log.info(`Step 04 upsert complete: ${ok} attendance rows.`);

  await deleteOrphans('attendance', rows.map((r) => r.legacy_id), log);
  log.info('Step 04 complete.');
}

main().catch((e) => {
  log.error(e.stack || e.message);
  process.exit(1);
});
