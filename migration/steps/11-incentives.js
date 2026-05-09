// Step 11: incentives — 25 docs.
//
// v1 incentives doc           v2 incentives row
//   id                          id (uuidv5)
//   userId (fb uid)             user_id (mapped)
//   month ("YYYY-MM")           month
//   basicSalary                 basic_salary
//   incentives []               incentives (jsonb)
//   bonuses []                  bonuses (jsonb)
//   verified / payoutCleared    verified / payout_cleared (preserved if present)
//
// Each line item shape is identical between v1 and v2:
//   { id, text, amount, targetValue, achievedValue, completed, suffix }

import { fbDb } from '../lib/firebase.js';
import { sb } from '../lib/supabase.js';
import { fbUidToUuid, fbDocIdToUuid } from '../lib/uid.js';
import { makeLogger } from '../lib/log.js';
import { deleteOrphans } from '../lib/sync.js';

const log = makeLogger('11-incentives');
const APPLY = process.env.MIGRATION_APPLY === '1';

function ts(v) {
  if (!v) return null;
  if (v._seconds) return new Date(v._seconds * 1000).toISOString();
  if (v.toDate) return v.toDate().toISOString();
  return null;
}

async function main() {
  log.info(`Mode: ${APPLY ? 'APPLY' : 'DRY-RUN'}`);

  const [snap, profsRes] = await Promise.all([
    fbDb.collection('incentives').get(),
    sb.from('profiles').select('id'),
  ]);
  const profileIds = new Set((profsRes.data || []).map((r) => r.id));
  log.info(`v1 incentives: ${snap.size}`);

  const rows = [];
  const skipped = [];
  const dedup = new Set();

  for (const d of snap.docs) {
    const x = d.data();
    const userId = x.userId ? fbUidToUuid(x.userId) : null;
    if (!userId || !profileIds.has(userId)) {
      skipped.push({ id: d.id, reason: `user ${x.userId} not in profiles` });
      continue;
    }
    if (!x.month || !/^\d{4}-\d{2}$/.test(x.month)) {
      skipped.push({ id: d.id, reason: `bad month ${x.month}` });
      continue;
    }
    const k = `${userId}|${x.month}`;
    if (dedup.has(k)) {
      skipped.push({ id: d.id, reason: `duplicate (user, month)` });
      continue;
    }
    dedup.add(k);

    let lastUpdatedBy = x.lastUpdatedBy ? fbUidToUuid(x.lastUpdatedBy) : null;
    if (lastUpdatedBy && !profileIds.has(lastUpdatedBy)) lastUpdatedBy = null;

    rows.push({
      id: fbDocIdToUuid(d.id),
      legacy_id: d.id,
      user_id: userId,
      month: x.month,
      basic_salary: Number(x.basicSalary || 0),
      incentives: Array.isArray(x.incentives) ? x.incentives : [],
      bonuses: Array.isArray(x.bonuses) ? x.bonuses : [],
      verified: !!x.verified,
      payout_cleared: !!(x.payoutCleared || x.payout_cleared),
      last_updated_by: lastUpdatedBy,
      created_at: ts(x.createdAt) || new Date().toISOString(),
      updated_at: ts(x.updatedAt) || ts(x.createdAt) || new Date().toISOString(),
    });
  }

  log.info(`Rows ready: ${rows.length}`);
  log.info(`Skipped: ${skipped.length}`);
  if (skipped.length) skipped.forEach((s) => log.warn(`  ${s.id}: ${s.reason}`));

  log.info('Sample 3:');
  rows.slice(0, 3).forEach((r) =>
    log.info(`  user=${r.user_id.slice(0,8)} month=${r.month} basic=${r.basic_salary} inc=${r.incentives.length} bon=${r.bonuses.length}`),
  );

  if (!APPLY) {
    log.info('DRY-RUN — no writes. Re-run with --apply to execute.');
    return;
  }

  const { error } = await sb.from('incentives').upsert(rows, { onConflict: 'id' });
  if (error) {
    log.error(`Upsert failed: ${error.message}`);
    process.exit(1);
  }
  log.info(`Step 11 upsert complete: ${rows.length} incentives.`);

  await deleteOrphans('incentives', rows.map((r) => r.legacy_id), log);
  log.info('Step 11 complete.');
}

main().catch((e) => {
  log.error(e.stack || e.message);
  process.exit(1);
});
