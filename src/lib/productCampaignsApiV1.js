// v1-compat layer for the Product Campaigns module.
//
// v1 model (Firestore):
//   /productCampaigns/{productId}                    ← flattened index
//   /brands/{brandId}/products/{productId}           ← source of truth
//
// v2 model (Postgres, mig 067/069/070/077):
//   brand_products(id, brand_id, product_name, product_id, retail_price,
//                  type, skus jsonb, ...)                ← products table
//   product_campaigns(id, product_id, brand_id, promotions jsonb,
//                     sku_overrides jsonb, ...)          ← campaigns
//
// Mapping: v1 keys both docs by the product id. In v2 each row has its
// own UUID; we expose v1's "row id" as the brand_products.id and look
// up the matching product_campaigns row via product_id when needed.
//
// What v1 markup expects:
//   - listProductsForBrand(brandId) → product list with `promotions`
//     and `skus` already merged in (so the modal's product picker can
//     pre-populate).
//   - listAllProductCampaigns({ role, uid, brandIds? }) → flat list
//     for the page grid; each row is shaped like a v1 productCampaigns
//     doc (productName, retailPrice, type, promotions, skus, brandId,
//     brandName, addedBy*, createdAt).
//   - saveProductCampaign({ productId, brandId, brandName, promotions,
//       skus, addedBy, addedByName, addedByRole }) → upsert (creates
//     a product_campaigns row if missing for the product, otherwise
//     updates promotions/sku_overrides; also updates brand_products.skus).
//   - removeProductCampaign(productId) → delete the campaign row +
//     clear brand_products.skus' promo overrides.

import { supabase } from './supabase';

// --- helpers -------------------------------------------------------

function genId(prefix = 'p') {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  return prefix + '_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6);
}

// Promotions are stored in JSONB with SNAKE_CASE dates (start_date / end_date —
// see saveProductCampaign below), but the ported v1 markup reads startDate /
// endDate everywhere: the two <input type="date"> fields, the "· ends <date>"
// line on the card, and the expiry/urgency badge.
//
// This used to only stamp a missing id and pass the row straight through, so
// p.startDate was ALWAYS undefined. Consequences, all silent:
//   * both date pickers opened BLANK even though the DB held the dates,
//   * no "ends" line and no expiry badge ever rendered, so a promo never looked
//     expired,
//   * and worst — the edit modal rebuilds the promo from that blank form state,
//     so pressing Save wrote start_date/end_date back as NULL. Opening a campaign
//     and saving anything DESTROYED its dates.
//
// Map to camelCase for the UI and KEEP the snake_case keys, so the write path
// (which reads `p.startDate || p.start_date`) is correct from either shape.
function ensurePromoIds(promos) {
  return (promos || []).map((p) => {
    const src = p || {};
    return {
      ...src,
      id: src.id || genId('promo'),
      startDate: src.startDate || src.start_date || '',
      endDate: src.endDate || src.end_date || '',
    };
  });
}

// SKUs in v2 brand_products are { id, sku_name, retail_price }.
// v1 markup uses { id, skuName, retailPrice, promoDiscounts }.
// We merge promoDiscounts from product_campaigns.sku_overrides into each SKU.
function mergeSkuOverrides(skus, skuOverrides) {
  const overrides = skuOverrides || {};
  return (skus || []).map(s => ({
    id: s.id,
    skuName: s.sku_name || s.skuName || '',
    retailPrice: Number(s.retail_price ?? s.retailPrice ?? 0),
    promoDiscounts: overrides[s.id] || {},
  }));
}

// Inverse — v1 hands us `[{id, skuName, retailPrice, promoDiscounts}]`.
// Split back into:
//   1. brand_products.skus  → [{id, sku_name, retail_price}]
//   2. sku_overrides         → { [skuId]: { [promoId]: discount } }
function splitSkus(skus, validPromoIds) {
  const cleanSkus = [];
  const overrides = {};
  (skus || []).forEach(s => {
    const id = s.id || genId('sku');
    cleanSkus.push({
      id,
      sku_name: (s.skuName || s.sku_name || '').trim(),
      retail_price: Number(s.retailPrice ?? s.retail_price ?? 0),
    });
    const filtered = Object.fromEntries(
      Object.entries(s.promoDiscounts || {})
        .filter(([pid, v]) => validPromoIds.has(pid) && v !== '' && v != null)
        .map(([pid, v]) => [pid, Number(v) || 0]),
    );
    if (Object.keys(filtered).length) overrides[id] = filtered;
  });
  return { cleanSkus, overrides };
}

// Normalize a brand_products row plus its joined campaign so the v1
// markup sees `productName`, `retailPrice`, `promotions`, `skus`.
function _normProduct(prod, campaign = null) {
  if (!prod) return prod;
  const skus = mergeSkuOverrides(prod.skus, campaign?.sku_overrides);
  const promotions = ensurePromoIds(campaign?.promotions || []);
  return {
    id: prod.id,
    productName: prod.product_name || '',
    productId: prod.product_id || '',
    retailPrice: Number(prod.retail_price || 0),
    type: prod.type || 'focus',
    skus,
    promotions,
    brandId: prod.brand_id,
    brandName: prod.brand?.brand_name || '',
    // Pass-through any extras
    _raw: { product: prod, campaign },
  };
}

// Normalize a product_campaigns row joined with the underlying product
// for the page grid (v1 expected `productCampaigns` docs).
function _normCampaignRow(row) {
  if (!row) return row;
  const prod = row.product || {};
  const skus = mergeSkuOverrides(prod.skus, row.sku_overrides);
  return {
    id: prod.id || row.product_id, // v1 keys by product id
    _campaignId: row.id,            // internal: the actual product_campaigns row
    productName: prod.product_name || '',
    productId: prod.product_id || '',
    retailPrice: Number(prod.retail_price || 0),
    type: prod.type || 'focus',
    skus,
    promotions: ensurePromoIds(row.promotions || []),
    brandId: row.brand_id,
    brandName: row.brand?.brand_name || '',
    addedBy: row.created_by || null,
    addedByName: row.creator?.display_name || '',
    addedByRole: row.creator?.role || null,
    createdAt: row.created_at || null,
    updatedAt: row.updated_at || null,
    raw_paste: row.raw_paste || null,
  };
}

// --- products (per brand picker list) ------------------------------

export async function listProductsForBrand(brandId) {
  if (!brandId) return [];
  const { data: products, error } = await supabase
    .from('brand_products')
    .select('*')
    .eq('brand_id', brandId)
    .order('created_at', { ascending: false });
  if (error) throw new Error(error.message);
  if (!products?.length) return [];

  // Hydrate each product with its campaign (if any)
  const ids = products.map(p => p.id);
  const { data: campaigns } = await supabase
    .from('product_campaigns')
    .select('*')
    .in('product_id', ids);
  const byProduct = new Map((campaigns || []).map(c => [c.product_id, c]));

  return products.map(p => _normProduct(p, byProduct.get(p.id) || null));
}

// --- main page list -----------------------------------------------
//
// Matches v1's behavior: read every productCampaigns doc; for non-Boss/OL
// roles, filter by brandId in the caller's allowed brands. Caller passes
// `brandIds` (a Set or array) when the role isn't Boss/OL/dev.
export async function listAllProductCampaigns({ brandIds = null } = {}) {
  let q = supabase
    .from('product_campaigns')
    .select(`
      *,
      brand:brand_id(id, brand_name, logo_url, owner_id),
      product:product_id(id, product_name, product_id, product_url, type, retail_price, skus, brand_id),
      creator:created_by(display_name, role)
    `)
    .order('updated_at', { ascending: false });
  if (brandIds && brandIds.size > 0) {
    q = q.in('brand_id', Array.from(brandIds));
  } else if (brandIds && brandIds.size === 0) {
    return [];
  }
  const { data, error } = await q;
  if (error) throw new Error(error.message);
  return (data || []).map(_normCampaignRow);
}

// Realtime subscription on product_campaigns for the All-page.
export function subscribeProductCampaigns(onRows, onError, opts = {}) {
  let cancelled = false;
  let channel = null;
  const refresh = async () => {
    try {
      const rows = await listAllProductCampaigns(opts);
      if (!cancelled) onRows(rows);
    } catch (e) { if (!cancelled && onError) onError(e); }
  };
  refresh();
  channel = supabase
    .channel(`product-campaigns-${Math.random().toString(36).slice(2, 8)}`)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'product_campaigns' }, refresh)
    .subscribe();
  const unsubscribe = () => {
    cancelled = true;
    if (channel) supabase.removeChannel(channel);
  };
  unsubscribe.refetch = refresh;
  return unsubscribe;
}

// --- save (upsert) -------------------------------------------------

export async function saveProductCampaign({
  productId, brandId, /* brandName unused — name comes from join */
  promotions, skus,
  isEdit = false,
}) {
  if (!productId) throw new Error('productId required');
  if (!brandId)   throw new Error('brandId required');

  // Sanitize promotions
  const promoData = (promotions || []).map(p => ({
    id: p.id || genId('promo'),
    type: p.type,
    name: (p.name || '').trim(),
    discount: parseFloat(p.discount) || 0,
    start_date: p.startDate || p.start_date || null,
    end_date: p.endDate || p.end_date || null,
    status: p.status || 'active',
  }));
  const validPromoIds = new Set(promoData.map(p => p.id));

  // Split SKUs into base (brand_products.skus) and overrides (product_campaigns.sku_overrides)
  const { cleanSkus, overrides } = splitSkus(skus, validPromoIds);

  // 1. Update brand_products.skus (the base SKU list lives there).
  if (cleanSkus.length > 0) {
    await supabase
      .from('brand_products')
      .update({ skus: cleanSkus })
      .eq('id', productId);
  }

  // 2. Upsert product_campaigns row keyed on (product_id).
  const { data: me } = await supabase.auth.getUser();
  const { data: existing } = await supabase
    .from('product_campaigns')
    .select('id, created_by')
    .eq('product_id', productId)
    .maybeSingle();

  let saved;
  if (existing) {
    const { data, error } = await supabase
      .from('product_campaigns')
      .update({ promotions: promoData, sku_overrides: overrides })
      .eq('id', existing.id)
      .select('*, brand:brand_id(*), product:product_id(*), creator:created_by(display_name, role)')
      .single();
    if (error) throw new Error(error.message);
    saved = data;
  } else {
    const insertable = {
      product_id: productId,
      brand_id: brandId,
      promotions: promoData,
      sku_overrides: overrides,
      created_by: me?.user?.id,
    };
    const { data, error } = await supabase
      .from('product_campaigns')
      .insert(insertable)
      .select('*, brand:brand_id(*), product:product_id(*), creator:created_by(display_name, role)')
      .single();
    if (error) throw new Error(error.message);
    saved = data;
  }

  return _normCampaignRow(saved);
}

// Update only the promotions array (used by auto-expire pass).
export async function updatePromotionStatuses(productId, promotions) {
  const { data: existing } = await supabase
    .from('product_campaigns')
    .select('id')
    .eq('product_id', productId)
    .maybeSingle();
  if (!existing) return;
  await supabase
    .from('product_campaigns')
    .update({ promotions })
    .eq('id', existing.id);
}

// v1 deleted the productCampaigns doc and cleared promotions on the
// product doc. v2: delete the product_campaigns row (brand_products is
// untouched so the product itself remains).
export async function removeProductCampaign(productId) {
  const { error } = await supabase
    .from('product_campaigns')
    .delete()
    .eq('product_id', productId);
  if (error) throw new Error(error.message);
}
