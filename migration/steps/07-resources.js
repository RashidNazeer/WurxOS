// Step 07: resources — pulls from BOTH:
//   * /resources                       (v1's "general" top-level collection)
//   * /brands/{brandId}/resources      (v1's "brand-scoped" sub-collection)
//
// v2 has a single unified `resources` table where brand_id IS NULL
// means a general resource. RLS enforces visibility.
//
// v1 resources doc            v2 resources row
//   id                          id (uuidv5 of legacy_id)
//   type (link/image/video)     type
//   name                        name
//   url                         url
//   description                 description
//   visibility (private/...)    visibility (general only — brand-scoped
//                                           always uses 'office')
//   visibleToUid (fb uid)       visible_to_uid (mapped)
//   visibleToRoles []           visible_to_roles
//   brandId (if brand-scoped)   brand_id
//   createdBy / addedBy.uid     created_by (mapped)
//   createdAt                   created_at
//
// Brand-scoped resources from v1 have createdBy on the doc OR
// addedBy.uid (older docs). Falls back to brand owner if neither.

import { fbDb } from '../lib/firebase.js';
import { sb } from '../lib/supabase.js';
import { fbUidToUuid, fbDocIdToUuid } from '../lib/uid.js';
import { makeLogger } from '../lib/log.js';
import { deleteOrphans } from '../lib/sync.js';

const log = makeLogger('07-resources');
const APPLY = process.env.MIGRATION_APPLY === '1';

const VALID_TYPE = new Set(['link','image','video','file']);
const VALID_VIS = new Set(['private','office','user','group']);

function ts(v) {
  if (!v) return null;
  if (v._seconds) return new Date(v._seconds * 1000).toISOString();
  if (v.toDate) return v.toDate().toISOString();
  return null;
}

async function main() {
  log.info(`Mode: ${APPLY ? 'APPLY' : 'DRY-RUN'}`);

  const [generalSnap, profsRes, v1BrandsSnap, v2BrandsRes] = await Promise.all([
    fbDb.collection('resources').get(),
    sb.from('profiles').select('id'),
    fbDb.collection('brands').get(),
    sb.from('brands').select('id, owner_id, legacy_id'),
  ]);
  const profileIds = new Set((profsRes.data || []).map((r) => r.id));
  const v2BrandsByLegacy = new Map((v2BrandsRes.data || []).filter(b => b.legacy_id).map(b => [b.legacy_id, b]));
  const v2BrandIds = new Set((v2BrandsRes.data || []).map((r) => r.id));

  // Pull all brand-scoped resources in parallel
  const brandResourceArrays = await Promise.all(
    v1BrandsSnap.docs.map(async (b) => {
      const sub = await fbDb.collection('brands').doc(b.id).collection('resources').get();
      return sub.docs.map(d => ({ doc: d, v1BrandId: b.id, v1BrandData: b.data() }));
    }),
  );
  const brandFlat = brandResourceArrays.flat();

  log.info(`v1 general resources: ${generalSnap.size}`);
  log.info(`v1 brand resources:   ${brandFlat.length} (across ${v1BrandsSnap.size} brands)`);
  log.info(`v2 profiles: ${profileIds.size}, brands: ${v2BrandIds.size}`);

  const rows = [];
  const skipped = [];

  // ---- General resources ------------------------------------------
  for (const d of generalSnap.docs) {
    const r = d.data();
    const createdBy = r.createdBy ? fbUidToUuid(r.createdBy) : null;
    if (!createdBy || !profileIds.has(createdBy)) {
      skipped.push({ id: d.id, src: 'general', name: r.name, reason: `createdBy ${r.createdBy} not in profiles` });
      continue;
    }
    let brandId = r.brandId ? fbDocIdToUuid(r.brandId) : null;
    if (brandId && !v2BrandIds.has(brandId)) brandId = null;

    let visibleToUid = r.visibleToUid ? fbUidToUuid(r.visibleToUid) : null;
    if (visibleToUid && !profileIds.has(visibleToUid)) visibleToUid = null;

    rows.push({
      id: fbDocIdToUuid('general:' + d.id),
      legacy_id: 'general:' + d.id,
      brand_id: brandId,
      type: VALID_TYPE.has(r.type) ? r.type : 'link',
      name: (r.name || '(untitled)').slice(0, 500),
      url: r.url || '',
      description: r.description || '',
      visibility: VALID_VIS.has(r.visibility) ? r.visibility : 'private',
      visible_to_uid: visibleToUid,
      visible_to_roles: Array.isArray(r.visibleToRoles) ? r.visibleToRoles : [],
      created_by: createdBy,
      created_at: ts(r.createdAt) || new Date().toISOString(),
    });
  }

  // ---- Brand-scoped resources ------------------------------------
  for (const { doc: d, v1BrandId, v1BrandData } of brandFlat) {
    const r = d.data();
    // Resolve created_by: prefer createdBy, fall back to addedBy.uid,
    // last resort the brand's owner (can't leave NULL — column is NOT NULL).
    const rawCreator = r.createdBy || r.addedBy?.uid || v1BrandData.ownerId;
    const createdBy = rawCreator ? fbUidToUuid(rawCreator) : null;
    if (!createdBy || !profileIds.has(createdBy)) {
      skipped.push({
        id: d.id, src: 'brand', name: r.name,
        reason: `creator ${rawCreator} not in profiles (brand ${v1BrandData.brandName})`,
      });
      continue;
    }
    const v2Brand = v2BrandsByLegacy.get(v1BrandId);
    if (!v2Brand) {
      skipped.push({ id: d.id, src: 'brand', name: r.name, reason: `brand ${v1BrandId} not in v2` });
      continue;
    }

    rows.push({
      // Use composite legacy_id so brand-scoped IDs never collide with
      // a general resource that happens to share a Firestore doc id.
      id: fbDocIdToUuid('brand:' + v1BrandId + ':' + d.id),
      legacy_id: 'brand:' + v1BrandId + ':' + d.id,
      brand_id: v2Brand.id,
      type: VALID_TYPE.has(r.type) ? r.type : 'link',
      name: (r.name || '(untitled)').slice(0, 500),
      url: r.url || '',
      description: r.description || '',
      // v1 brand-scoped resources have no visibility field — they're
      // always visible to brand viewers. v2 column requires a value;
      // 'office' is the closest analog (anyone with brand access).
      visibility: VALID_VIS.has(r.visibility) ? r.visibility : 'office',
      visible_to_uid: null,
      visible_to_roles: [],
      created_by: createdBy,
      created_at: ts(r.createdAt) || new Date().toISOString(),
    });
  }

  log.info(`Rows ready: ${rows.length}`);
  log.info(`Skipped: ${skipped.length}`);
  if (skipped.length) skipped.forEach((s) => log.warn(`  ${s.id} (${s.name}): ${s.reason}`));

  log.info('Sample 3:');
  rows.slice(0, 3).forEach((r) =>
    log.info(`  "${r.name}" type=${r.type} vis=${r.visibility} brand=${r.brand_id ? 'y' : 'n'}`),
  );

  if (!APPLY) {
    log.info('DRY-RUN — no writes. Re-run with --apply to execute.');
    return;
  }

  const { error } = await sb.from('resources').upsert(rows, { onConflict: 'id' });
  if (error) {
    log.error(`Upsert failed: ${error.message}`);
    process.exit(1);
  }
  log.info(`Step 07 upsert complete: ${rows.length} resources.`);

  await deleteOrphans('resources', rows.map((r) => r.legacy_id), log);
  log.info('Step 07 complete.');
}

main().catch((e) => {
  log.error(e.stack || e.message);
  process.exit(1);
});
