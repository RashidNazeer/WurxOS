// Step 12: campaigns (paid-collab brand-wide promotions) — 171 docs.
//
// v1 campaigns doc           v2 campaigns row
//   id, brandId, brandName     id, brand_id (mapped)
//   promotionName              promotion_name
//   status (4 values)          status (only Ongoing/Deactivated; others -> Ongoing)
//   startTime, endTime         start_time, end_time
//   type, notes                type, notes
//   reminders (object)         reminders (jsonb)
//   ownerId, addedBy, addedByRole -> owner_id, added_by, added_by_role
//
// Status mapping: v2 only stores Ongoing / Deactivated; Upcoming/Ended
// are derived at render time from start_time/end_time. So v1 statuses
// Upcoming/Ended/Ongoing all map to Ongoing in v2.

import { fbDb } from '../lib/firebase.js';
import { sb } from '../lib/supabase.js';
import { fbUidToUuid, fbDocIdToUuid } from '../lib/uid.js';
import { makeLogger } from '../lib/log.js';
import { deleteOrphans } from '../lib/sync.js';

const log = makeLogger('12-campaigns');
const APPLY = process.env.MIGRATION_APPLY === '1';

function ts(v) {
  if (!v) return null;
  if (v._seconds) return new Date(v._seconds * 1000).toISOString();
  if (v.toDate) return v.toDate().toISOString();
  return null;
}

function mapStatus(s) {
  return s === 'Deactivated' ? 'Deactivated' : 'Ongoing';
}

async function main() {
  log.info(`Mode: ${APPLY ? 'APPLY' : 'DRY-RUN'}`);

  const [snap, profsRes, brandsRes] = await Promise.all([
    fbDb.collection('campaigns').get(),
    sb.from('profiles').select('id'),
    sb.from('brands').select('id'),
  ]);
  const profileIds = new Set((profsRes.data || []).map((r) => r.id));
  const brandIds = new Set((brandsRes.data || []).map((r) => r.id));
  log.info(`v1 campaigns: ${snap.size}`);

  const rows = [];
  const skipped = [];
  for (const d of snap.docs) {
    const x = d.data();
    if (!x.brandId) {
      skipped.push({ id: d.id, reason: 'no brandId' });
      continue;
    }
    const brandUuid = fbDocIdToUuid(x.brandId);
    if (!brandIds.has(brandUuid)) {
      skipped.push({ id: d.id, reason: `brand ${x.brandId} not migrated` });
      continue;
    }
    let ownerId = x.ownerId ? fbUidToUuid(x.ownerId) : null;
    if (ownerId && !profileIds.has(ownerId)) ownerId = null;
    let addedBy = x.addedBy ? fbUidToUuid(x.addedBy) : null;
    if (addedBy && !profileIds.has(addedBy)) addedBy = null;

    rows.push({
      id: fbDocIdToUuid(d.id),
      legacy_id: d.id,
      brand_id: brandUuid,
      promotion_name: (x.promotionName || '(unnamed)').slice(0, 500),
      status: mapStatus(x.status),
      start_time: ts(x.startTime),
      end_time: ts(x.endTime),
      type: x.type || null,
      notes: x.notes || null,
      reminders: x.reminders && typeof x.reminders === 'object' ? x.reminders : {},
      owner_id: ownerId,
      added_by: addedBy,
      added_by_role: x.addedByRole || null,
      created_at: ts(x.createdAt) || new Date().toISOString(),
      updated_at: ts(x.updatedAt) || ts(x.createdAt) || new Date().toISOString(),
    });
  }

  log.info(`Rows ready: ${rows.length}`);
  log.info(`Skipped: ${skipped.length}`);
  if (skipped.length) skipped.slice(0, 10).forEach((s) => log.warn(`  ${s.id}: ${s.reason}`));
  const byStatus = rows.reduce((m, r) => { m[r.status] = (m[r.status]||0)+1; return m; }, {});
  log.info(`By status: ${JSON.stringify(byStatus)}`);

  if (!APPLY) {
    log.info('DRY-RUN — no writes. Re-run with --apply to execute.');
    return;
  }

  const CHUNK = 100;
  let ok = 0;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK);
    const { error } = await sb.from('campaigns').upsert(chunk, { onConflict: 'id' });
    if (error) {
      log.error(`Chunk ${i / CHUNK}: ${error.message}`);
      process.exit(1);
    }
    ok += chunk.length;
    log.info(`  ${ok}/${rows.length}`);
  }
  log.info(`Step 12 upsert complete: ${ok} campaigns.`);

  await deleteOrphans('campaigns', rows.map((r) => r.legacy_id), log);
  log.info('Step 12 complete.');
}

main().catch((e) => {
  log.error(e.stack || e.message);
  process.exit(1);
});
