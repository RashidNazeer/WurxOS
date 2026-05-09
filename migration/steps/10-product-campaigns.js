// Step 10: productCampaigns — 14 docs.
//
// v1 productCampaigns                     v2 (split into 2 tables)
//   id, brandId, productName, productId,    brand_products: product_name, product_id,
//   retailPrice, type, skus(?)               product_url, type, retail_price, skus
//   promotions[]                              product_campaigns: promotions, sku_overrides
//
// Promotion field renames inside each promotion object:
//   startDate -> start_date
//   endDate   -> end_date
//   (others stay the same: id, type, name, discount, status)
//
// Order:
//   1. Insert brand_products (key: uuidv5 of `bp:{brandId}:{productId or docId}`)
//   2. Insert product_campaigns referencing those products

import { fbDb } from '../lib/firebase.js';
import { sb } from '../lib/supabase.js';
import { fbUidToUuid, fbDocIdToUuid } from '../lib/uid.js';
import { makeLogger } from '../lib/log.js';
import { deleteOrphans } from '../lib/sync.js';

const log = makeLogger('10-product-campaigns');
const APPLY = process.env.MIGRATION_APPLY === '1';

const VALID_TYPE = new Set(['focus','non-focus']);

function ts(v) {
  if (!v) return null;
  if (v._seconds) return new Date(v._seconds * 1000).toISOString();
  if (v.toDate) return v.toDate().toISOString();
  return null;
}

function transformPromotions(arr) {
  if (!Array.isArray(arr)) return [];
  return arr.map((p, idx) => {
    const out = { ...p };
    // Rename camelCase -> snake_case
    if ('startDate' in out) { out.start_date = out.startDate; delete out.startDate; }
    if ('endDate' in out)   { out.end_date   = out.endDate;   delete out.endDate; }
    // Provide a stable id if missing (the trigger doesn't require it but the UI does).
    if (!out.id) out.id = `legacy-${idx}`;
    return out;
  });
}

async function main() {
  log.info(`Mode: ${APPLY ? 'APPLY' : 'DRY-RUN'}`);

  const [snap, profsRes, brandsRes] = await Promise.all([
    fbDb.collection('productCampaigns').get(),
    sb.from('profiles').select('id'),
    sb.from('brands').select('id'),
  ]);
  const profileIds = new Set((profsRes.data || []).map((r) => r.id));
  const brandIds = new Set((brandsRes.data || []).map((r) => r.id));
  log.info(`v1 productCampaigns: ${snap.size}`);

  const products = [];
  const campaigns = [];
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
    const createdBy = x.createdBy ? fbUidToUuid(x.createdBy) : null;
    const cb = createdBy && profileIds.has(createdBy) ? createdBy : null;

    // Product key: uuidv5 of `bp:{brandId}:{productId or docId}`
    const productKey = `bp:${x.brandId}:${x.productId || d.id}`;
    const productUuid = fbDocIdToUuid(productKey);

    products.push({
      id: productUuid,
      legacy_id: productKey,
      brand_id: brandUuid,
      product_name: (x.productName || '(unnamed)').slice(0, 500),
      product_id: x.productId || null,
      product_url: x.productUrl || null,
      type: VALID_TYPE.has(x.type) ? x.type : 'focus',
      retail_price: Number(x.retailPrice || 0),
      skus: Array.isArray(x.skus) ? x.skus : [],
      created_by: cb,
      created_at: ts(x.createdAt) || new Date().toISOString(),
      updated_at: ts(x.updatedAt) || ts(x.createdAt) || new Date().toISOString(),
    });

    // Campaign references the product. brand_id is auto-synced by trigger,
    // but we still set it for the initial insert.
    campaigns.push({
      id: fbDocIdToUuid(d.id),
      legacy_id: d.id,
      product_id: productUuid,
      brand_id: brandUuid,
      raw_paste: x.rawPaste || null,
      promotions: transformPromotions(x.promotions),
      sku_overrides: x.skuOverrides && typeof x.skuOverrides === 'object' ? x.skuOverrides : {},
      created_by: cb,
      created_at: ts(x.createdAt) || new Date().toISOString(),
      updated_at: ts(x.updatedAt) || ts(x.createdAt) || new Date().toISOString(),
    });
  }

  log.info(`Products to insert: ${products.length}`);
  log.info(`Campaigns to insert: ${campaigns.length}`);
  log.info(`Skipped: ${skipped.length}`);
  if (skipped.length) skipped.forEach((s) => log.warn(`  ${s.id}: ${s.reason}`));

  log.info('Sample product:');
  if (products[0]) log.info(`  "${products[0].product_name}" type=${products[0].type} retail=${products[0].retail_price}`);
  log.info('Sample campaign promotions:');
  if (campaigns[0]) log.info(`  ${JSON.stringify(campaigns[0].promotions).slice(0,200)}`);

  if (!APPLY) {
    log.info('DRY-RUN — no writes. Re-run with --apply to execute.');
    return;
  }

  // Insert products first.
  const { error: pe } = await sb.from('brand_products').upsert(products, { onConflict: 'id' });
  if (pe) {
    log.error(`brand_products upsert: ${pe.message}`);
    process.exit(1);
  }
  log.info(`brand_products upserted: ${products.length}`);

  const { error: ce } = await sb.from('product_campaigns').upsert(campaigns, { onConflict: 'id' });
  if (ce) {
    log.error(`product_campaigns upsert: ${ce.message}`);
    process.exit(1);
  }
  log.info(`product_campaigns upserted: ${campaigns.length}`);

  await deleteOrphans('product_campaigns', campaigns.map((r) => r.legacy_id), log);
  await deleteOrphans('brand_products',    products.map((r)  => r.legacy_id), log);
  log.info('Step 10 complete.');
}

main().catch((e) => {
  log.error(e.stack || e.message);
  process.exit(1);
});
