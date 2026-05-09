// Step 03: brands + brand_assignments.
//
// v1 brand doc                v2 brands row
//   id (random str)           id (uuidv5 from v1 id)
//   brandName                 brand_name
//   clientName                client_name
//   tier (mixed case)         tier (lowercased)
//   status (active/inactive)  status (same)
//   gmv                       gmv
//   paidCollabStatus (label)  paid_collab_status (snake_case)
//   ownerId (fb uid)          owner_id (mapped via fbUidToUuid)
//   createdAt                 created_at
//   updatedAt                 updated_at
//
// v1 assignedUsers[]          v2 brand_assignments rows
//   {id, name}                  brand_id, user_id, assigned_by(=brand owner), assigned_at(=brand createdAt)
//
// Idempotent: brand id is uuidv5 of v1 doc id, so re-running upserts.
// Pre-conditions: step 02 must have populated profiles.

import { fbDb } from '../lib/firebase.js';
import { sb } from '../lib/supabase.js';
import { fbUidToUuid, fbDocIdToUuid } from '../lib/uid.js';
import { makeLogger } from '../lib/log.js';
import { deleteOrphans } from '../lib/sync.js';

const log = makeLogger('03-brands');
const APPLY = process.env.MIGRATION_APPLY === '1';

const PAID_COLLAB_MAP = {
  'Not applicable':     'not_applicable',
  'Managed by brand':   'managed_by_brand',
  'Managed internally': 'managed_internally',
  'Hybrid':             'hybrid',
};

function mapTier(t) {
  if (!t) return null;
  return String(t).toLowerCase();
}
function mapStatus(s) {
  return s === 'inactive' ? 'inactive' : 'active';
}
function mapPaidCollab(s) {
  return PAID_COLLAB_MAP[s] || 'not_applicable';
}
function ts(v) {
  if (!v) return null;
  if (v._seconds) return new Date(v._seconds * 1000).toISOString();
  if (v.toDate) return v.toDate().toISOString();
  return null;
}

async function main() {
  log.info(`Mode: ${APPLY ? 'APPLY' : 'DRY-RUN'}`);

  // Truth for brand assignments lives in teamUsers/users `assignedBrands[]`
  // (per-user list). The brand doc's `assignedUsers[]` is sometimes stale
  // — when an APC is switched away in v1, the new APC is added to the
  // brand's assignedUsers but the previous one isn't always removed.
  // Read both, prefer the per-user side as the canonical assignment set.
  const [brandsSnap, profsRes, teamSnap, usersSnap] = await Promise.all([
    fbDb.collection('brands').get(),
    sb.from('profiles').select('id'),
    fbDb.collection('teamUsers').get(),
    fbDb.collection('users').get(),
  ]);
  const sbProfileIds = new Set((profsRes.data || []).map((r) => r.id));
  log.info(`v1 brands: ${brandsSnap.size}`);
  log.info(`v2 profiles available: ${sbProfileIds.size}`);

  // Build canonical (brandId → Set<userId>) from per-user lists.
  const v1AssignsByBrand = new Map();
  const addAssign = (brandId, userId) => {
    if (!brandId || !userId) return;
    if (!v1AssignsByBrand.has(brandId)) v1AssignsByBrand.set(brandId, new Set());
    v1AssignsByBrand.get(brandId).add(userId);
  };
  for (const d of teamSnap.docs) {
    for (const b of (d.data().assignedBrands || [])) addAssign(b?.id, d.id);
  }
  for (const d of usersSnap.docs) {
    for (const b of (d.data().assignedBrands || [])) addAssign(b?.id, d.id);
  }

  const brandRows = [];
  const assignmentRows = [];
  const skipped = [];

  for (const d of brandsSnap.docs) {
    const b = d.data();
    const ownerUuid = b.ownerId ? fbUidToUuid(b.ownerId) : null;
    if (!ownerUuid || !sbProfileIds.has(ownerUuid)) {
      skipped.push({ brand: b.brandName, reason: `owner ${b.ownerId} not in v2 profiles` });
      continue;
    }
    const brandId = fbDocIdToUuid(d.id);
    brandRows.push({
      id: brandId,
      legacy_id: d.id,
      brand_name: b.brandName || '(unnamed)',
      client_name: b.clientName || '',
      tier: mapTier(b.tier),
      status: mapStatus(b.status),
      gmv: Number(b.gmv || 0),
      paid_collab_status: mapPaidCollab(b.paidCollabStatus),
      owner_id: ownerUuid,
      created_by: ownerUuid, // best guess: owner created it
      created_at: ts(b.createdAt) || new Date().toISOString(),
      updated_at: ts(b.updatedAt) || ts(b.createdAt) || new Date().toISOString(),
    });
    // Pull assignees from the per-user truth set (NOT brand.assignedUsers).
    const v1Assignees = v1AssignsByBrand.get(d.id) || new Set();
    for (const v1User of v1Assignees) {
      const uid = fbUidToUuid(v1User);
      if (!uid || !sbProfileIds.has(uid)) {
        log.warn(`  brand "${b.brandName}": assignee ${v1User} not in v2 profiles — skipped`);
        continue;
      }
      assignmentRows.push({
        brand_id: brandId,
        user_id: uid,
        assigned_by: ownerUuid,
        assigned_at: ts(b.createdAt) || new Date().toISOString(),
      });
    }
  }

  log.info(`Brand rows to upsert:        ${brandRows.length}`);
  log.info(`Assignment rows to upsert:   ${assignmentRows.length}`);
  if (skipped.length) {
    log.warn(`Skipped ${skipped.length} brands:`);
    skipped.forEach((s) => log.warn(`  ${s.brand}  (${s.reason})`));
  }

  log.info('Sample 3 brand rows:');
  brandRows.slice(0, 3).forEach((b) =>
    log.info(`  ${b.brand_name}  tier=${b.tier}  status=${b.status}  pc=${b.paid_collab_status}  gmv=${b.gmv}`),
  );

  if (!APPLY) {
    log.info('DRY-RUN — no writes. Re-run with --apply to execute.');
    return;
  }

  // Upsert brands first. Use the sync-bypass RPC so the
  // brands_block_owner_change trigger (from migration 025) doesn't
  // reject owner_id changes when re-syncing existing rows.
  log.info('Upserting brands via sync_brands_upsert RPC...');
  const { data: cnt, error: be } = await sb.rpc('sync_brands_upsert', { p_rows: brandRows });
  if (be) {
    log.error(`Brand upsert failed: ${be.message}`);
    process.exit(1);
  }
  log.info(`Upserted ${cnt ?? brandRows.length} brands.`);

  // Upsert assignments.
  log.info('Upserting brand_assignments...');
  // Composite primary key is (brand_id, user_id). Upsert handles duplicates.
  const { error: ae } = await sb
    .from('brand_assignments')
    .upsert(assignmentRows, { onConflict: 'brand_id,user_id' });
  if (ae) {
    log.error(`Assignment upsert failed: ${ae.message}`);
    process.exit(1);
  }
  log.info(`Upserted ${assignmentRows.length} brand_assignments.`);

  // Delete stale brand_assignments — rows in v2 that aren't in the
  // current v1 truth set. (Without this, switching an APC in v1 leaves
  // the previous APC permanently attached to the brand in v2.)
  // brand_assignments has no `legacy_id` column, so we reconcile by
  // (brand_id, user_id) pairs against what we just built.
  const expectedKeys = new Set(assignmentRows.map((r) => `${r.brand_id}|${r.user_id}`));
  // Only consider brands we actually synced in this run — leave v2-only
  // brands (not in v1) alone, just like the brands orphan cleanup.
  const syncedBrandIds = new Set(brandRows.map((r) => r.id));
  const { data: existing } = await sb
    .from('brand_assignments')
    .select('brand_id, user_id')
    .in('brand_id', Array.from(syncedBrandIds));
  const stale = (existing || []).filter((r) => !expectedKeys.has(`${r.brand_id}|${r.user_id}`));
  if (stale.length) {
    log.info(`Deleting ${stale.length} stale brand_assignments (APC switches / removals from v1).`);
    let deleted = 0;
    for (const r of stale) {
      const { error: de } = await sb
        .from('brand_assignments')
        .delete()
        .eq('brand_id', r.brand_id)
        .eq('user_id', r.user_id);
      if (!de) deleted++;
      else log.warn(`  failed: brand=${r.brand_id} user=${r.user_id}: ${de.message}`);
    }
    log.info(`Removed ${deleted}/${stale.length} stale assignments.`);
  } else {
    log.info('No stale brand_assignments to clean up.');
  }

  // Delete orphans — brands that existed in v1 previously but are now gone.
  const currentLegacyIds = brandRows.map((r) => r.legacy_id);
  await deleteOrphans('brands', currentLegacyIds, log);

  log.info('Step 03 complete.');
}

main().catch((e) => {
  log.error(e.stack || e.message);
  process.exit(1);
});
