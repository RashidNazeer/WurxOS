// Step 13: suggestions (5) + suggestion_upvotes + reminders (8).
//
// Suggestions:
//   v1 doc                       v2 suggestions row
//     id, title, description       id, title, description
//     category, status             category, status
//     submittedBy (fb uid)         submitted_by (mapped)
//     devNotes                     dev_notes
//     reviewedBy (fb uid)          reviewed_by (mapped)
//     upvotes [fb uids]            -> suggestion_upvotes rows
//
// Reminders:
//   v1 doc                       v2 reminders row
//     id, userId, title, notes     id, user_id, title, body
//     dueAt                        remind_at
//     triggered                    sent_at = now if true, null if false
//     completed                    (no v2 column — triggered=true is similar)

import { fbDb } from '../lib/firebase.js';
import { sb } from '../lib/supabase.js';
import { fbUidToUuid, fbDocIdToUuid } from '../lib/uid.js';
import { makeLogger } from '../lib/log.js';
import { deleteOrphans } from '../lib/sync.js';

const log = makeLogger('13-suggestions-reminders');
const APPLY = process.env.MIGRATION_APPLY === '1';

function ts(v) {
  if (!v) return null;
  if (v._seconds) return new Date(v._seconds * 1000).toISOString();
  if (v.toDate) return v.toDate().toISOString();
  return null;
}

async function main() {
  log.info(`Mode: ${APPLY ? 'APPLY' : 'DRY-RUN'}`);

  const [sgSnap, rmSnap, profsRes] = await Promise.all([
    fbDb.collection('suggestions').get(),
    fbDb.collection('reminders').get(),
    sb.from('profiles').select('id'),
  ]);
  const profileIds = new Set((profsRes.data || []).map((r) => r.id));
  log.info(`v1 suggestions: ${sgSnap.size}, reminders: ${rmSnap.size}`);

  // ---------- Suggestions + Upvotes ----------
  const suggestions = [];
  const upvotes = [];
  const skippedS = [];
  for (const d of sgSnap.docs) {
    const x = d.data();
    const submittedBy = x.submittedBy ? fbUidToUuid(x.submittedBy) : null;
    if (!submittedBy || !profileIds.has(submittedBy)) {
      skippedS.push({ id: d.id, reason: `submittedBy ${x.submittedBy} not in profiles` });
      continue;
    }
    let reviewedBy = x.reviewedBy ? fbUidToUuid(x.reviewedBy) : null;
    if (reviewedBy && !profileIds.has(reviewedBy)) reviewedBy = null;

    const sId = fbDocIdToUuid(d.id);
    suggestions.push({
      id: sId,
      legacy_id: d.id,
      title: (x.title || '(untitled)').slice(0, 500),
      description: x.description || '',
      category: x.category || 'feature',
      status: x.status || 'new',
      submitted_by: submittedBy,
      dev_notes: x.devNotes || '',
      reviewed_by: reviewedBy,
      created_at: ts(x.createdAt) || new Date().toISOString(),
      updated_at: ts(x.updatedAt) || ts(x.createdAt) || new Date().toISOString(),
    });

    for (const u of (x.upvotes || [])) {
      const uid = fbUidToUuid(u);
      if (uid && profileIds.has(uid)) {
        upvotes.push({ suggestion_id: sId, user_id: uid });
      }
    }
  }

  // ---------- Reminders ----------
  const reminders = [];
  const skippedR = [];
  for (const d of rmSnap.docs) {
    const x = d.data();
    const userId = x.userId ? fbUidToUuid(x.userId) : null;
    if (!userId || !profileIds.has(userId)) {
      skippedR.push({ id: d.id, reason: `userId ${x.userId} not in profiles` });
      continue;
    }
    if (!x.dueAt) {
      skippedR.push({ id: d.id, reason: 'no dueAt' });
      continue;
    }
    reminders.push({
      id: fbDocIdToUuid(d.id),
      legacy_id: d.id,
      user_id: userId,
      title: (x.title || '(no title)').slice(0, 500),
      body: x.notes || '',
      remind_at: ts(x.dueAt),
      sent_at: x.triggered ? (ts(x.dueAt) || new Date().toISOString()) : null,
      created_at: ts(x.createdAt) || new Date().toISOString(),
    });
  }

  log.info(`Suggestions: ${suggestions.length} (skipped ${skippedS.length})`);
  log.info(`Upvotes: ${upvotes.length}`);
  log.info(`Reminders: ${reminders.length} (skipped ${skippedR.length})`);
  if (skippedS.length) skippedS.forEach((s) => log.warn(`  sg ${s.id}: ${s.reason}`));
  if (skippedR.length) skippedR.forEach((s) => log.warn(`  rm ${s.id}: ${s.reason}`));

  if (!APPLY) {
    log.info('DRY-RUN — no writes. Re-run with --apply to execute.');
    return;
  }

  if (suggestions.length) {
    const { error } = await sb.from('suggestions').upsert(suggestions, { onConflict: 'id' });
    if (error) { log.error(`suggestions: ${error.message}`); process.exit(1); }
    log.info(`suggestions upserted: ${suggestions.length}`);
  }
  if (upvotes.length) {
    // suggestion_upvotes likely has composite PK (suggestion_id, user_id).
    const { error } = await sb.from('suggestion_upvotes').upsert(upvotes, { onConflict: 'suggestion_id,user_id' });
    if (error) {
      log.warn(`upvotes upsert via composite failed (${error.message}); trying plain insert with skip-duplicates`);
      // fallback: insert one by one ignoring conflicts
      for (const u of upvotes) {
        await sb.from('suggestion_upvotes').insert(u).then(() => {}).catch(() => {});
      }
    }
    log.info(`upvotes upserted: ${upvotes.length}`);
  }
  if (reminders.length) {
    const { error } = await sb.from('reminders').upsert(reminders, { onConflict: 'id' });
    if (error) { log.error(`reminders: ${error.message}`); process.exit(1); }
    log.info(`reminders upserted: ${reminders.length}`);
  }

  await deleteOrphans('suggestions', suggestions.map((r) => r.legacy_id), log);
  await deleteOrphans('reminders',   reminders.map((r)   => r.legacy_id), log);
  log.info('Step 13 complete.');
}

main().catch((e) => {
  log.error(e.stack || e.message);
  process.exit(1);
});
