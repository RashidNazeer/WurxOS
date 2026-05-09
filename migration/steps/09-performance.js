// Step 09: performance_ratings (9) + performance_flags (2).
//
// v1 performance doc          v2 performance_ratings row
//   userId, month, metrics      user_id, month, metrics
//   evaluatedBy                 evaluated_by
//   overallScore                (NOT WRITTEN — generated column)
//
// v1 performanceFlags doc     v2 performance_flags row
//   userId, type (green/red)    user_id, type
//   weightage                   severity
//   description                 reason
//   addedBy                     created_by

import { fbDb } from '../lib/firebase.js';
import { sb } from '../lib/supabase.js';
import { fbUidToUuid, fbDocIdToUuid } from '../lib/uid.js';
import { makeLogger } from '../lib/log.js';
import { deleteOrphans } from '../lib/sync.js';

const log = makeLogger('09-performance');
const APPLY = process.env.MIGRATION_APPLY === '1';

const VALID_FLAG_TYPE = new Set(['green','red']);
const VALID_SEVERITY = new Set(['low','medium','high','critical']);

function ts(v) {
  if (!v) return null;
  if (v._seconds) return new Date(v._seconds * 1000).toISOString();
  if (v.toDate) return v.toDate().toISOString();
  return null;
}

async function main() {
  log.info(`Mode: ${APPLY ? 'APPLY' : 'DRY-RUN'}`);

  const [perfSnap, flagSnap, profsRes] = await Promise.all([
    fbDb.collection('performance').get(),
    fbDb.collection('performanceFlags').get(),
    sb.from('profiles').select('id'),
  ]);
  const profileIds = new Set((profsRes.data || []).map((r) => r.id));
  log.info(`v1 performance: ${perfSnap.size}, performanceFlags: ${flagSnap.size}`);
  log.info(`v2 profiles: ${profileIds.size}`);

  // Ratings
  const ratings = [];
  const skippedR = [];
  for (const d of perfSnap.docs) {
    const x = d.data();
    const userId = x.userId ? fbUidToUuid(x.userId) : null;
    if (!userId || !profileIds.has(userId)) {
      skippedR.push({ id: d.id, reason: `userId ${x.userId} not in profiles` });
      continue;
    }
    if (!x.month || !/^\d{4}-\d{2}$/.test(x.month)) {
      skippedR.push({ id: d.id, reason: `bad month ${x.month}` });
      continue;
    }
    let evaluatedBy = x.evaluatedBy ? fbUidToUuid(x.evaluatedBy) : null;
    if (evaluatedBy && !profileIds.has(evaluatedBy)) evaluatedBy = null;

    ratings.push({
      id: fbDocIdToUuid(d.id),
      legacy_id: d.id,
      user_id: userId,
      month: x.month,
      metrics: x.metrics || {},
      evaluated_by: evaluatedBy,
      updated_at: ts(x.updatedAt) || ts(x.createdAt) || new Date().toISOString(),
    });
  }

  // Flags
  const flags = [];
  const skippedF = [];
  for (const d of flagSnap.docs) {
    const x = d.data();
    const userId = x.userId ? fbUidToUuid(x.userId) : null;
    if (!userId || !profileIds.has(userId)) {
      skippedF.push({ id: d.id, reason: `userId ${x.userId} not in profiles` });
      continue;
    }
    let createdBy = x.addedBy ? fbUidToUuid(x.addedBy) : null;
    if (createdBy && !profileIds.has(createdBy)) createdBy = null;

    flags.push({
      id: fbDocIdToUuid(d.id),
      legacy_id: d.id,
      user_id: userId,
      type: VALID_FLAG_TYPE.has(x.type) ? x.type : 'green',
      severity: VALID_SEVERITY.has(x.weightage) ? x.weightage : 'low',
      reason: x.description || '(no description)',
      created_by: createdBy,
      created_at: ts(x.createdAt) || new Date().toISOString(),
    });
  }

  log.info(`Ratings ready: ${ratings.length} (skipped ${skippedR.length})`);
  log.info(`Flags ready:   ${flags.length} (skipped ${skippedF.length})`);
  if (skippedR.length) skippedR.forEach((s) => log.warn(`  rating ${s.id}: ${s.reason}`));
  if (skippedF.length) skippedF.forEach((s) => log.warn(`  flag ${s.id}: ${s.reason}`));

  log.info('Sample rating:');
  if (ratings[0]) log.info(`  user=${ratings[0].user_id.slice(0,8)} month=${ratings[0].month} metrics=${JSON.stringify(ratings[0].metrics)}`);
  log.info('Sample flag:');
  if (flags[0]) log.info(`  user=${flags[0].user_id.slice(0,8)} type=${flags[0].type} sev=${flags[0].severity} reason="${flags[0].reason.slice(0,60)}"`);

  if (!APPLY) {
    log.info('DRY-RUN — no writes. Re-run with --apply to execute.');
    return;
  }

  if (ratings.length) {
    const { error } = await sb.from('performance_ratings').upsert(ratings, { onConflict: 'id' });
    if (error) {
      log.error(`Ratings upsert failed: ${error.message}`);
      process.exit(1);
    }
    log.info(`  ratings upserted: ${ratings.length}`);
  }
  if (flags.length) {
    const { error } = await sb.from('performance_flags').upsert(flags, { onConflict: 'id' });
    if (error) {
      log.error(`Flags upsert failed: ${error.message}`);
      process.exit(1);
    }
    log.info(`  flags upserted: ${flags.length}`);
  }

  await deleteOrphans('performance_ratings', ratings.map((r) => r.legacy_id), log);
  await deleteOrphans('performance_flags',   flags.map((r) => r.legacy_id),   log);
  log.info(`Step 09 complete.`);
}

main().catch((e) => {
  log.error(e.stack || e.message);
  process.exit(1);
});
