import { supabase } from './supabase';

// --------------------------------------------------------------
// brand_products CRUD — products live per-brand with optional SKUs.
// Campaigns (product_campaigns) FK into this table.
// --------------------------------------------------------------

export async function listProducts(brandId) {
  if (!brandId) return [];
  const { data, error } = await supabase
    .from('brand_products')
    .select('*, creator:created_by(display_name)')
    .eq('brand_id', brandId)
    .order('created_at', { ascending: false });
  if (error) throw new Error(error.message);
  return data || [];
}

export async function getProduct(id) {
  const { data, error } = await supabase
    .from('brand_products')
    .select('*')
    .eq('id', id)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return data;
}

export async function createProduct({
  brandId, productName, productId, productUrl,
  type = 'focus', retailPrice = 0, skus = [], monthlySampleGoal = null,
}) {
  const { data: me } = await supabase.auth.getUser();
  const payload = {
    brand_id:     brandId,
    product_name: productName.trim(),
    product_id:   productId  || null,
    product_url:  productUrl || null,
    type,
    retail_price: Number(retailPrice || 0),
    monthly_sample_goal: monthlySampleGoal,
    skus:         normalizeSkus(skus),
    created_by:   me?.user?.id,
  };
  const { data, error } = await supabase
    .from('brand_products').insert(payload).select().single();
  if (error) throw new Error(error.message);
  return data;
}

export async function updateProduct(id, patch) {
  const normalized = { ...patch };
  if (patch.skus) normalized.skus = normalizeSkus(patch.skus);
  if (patch.retail_price != null) normalized.retail_price = Number(patch.retail_price);
  const { data, error } = await supabase
    .from('brand_products').update(normalized).eq('id', id).select().single();
  if (error) throw new Error(error.message);
  return data;
}

export async function deleteProduct(id) {
  const { error } = await supabase.from('brand_products').delete().eq('id', id);
  if (error) throw new Error(error.message);
}

// --------------------------------------------------------------
// Brand-level "unlimited sample goal" (migration 348)
// --------------------------------------------------------------
// Some contracts put no cap on free-sample approvals. The flag lives on
// `brands`, but it is WRITTEN through an RPC rather than a table update: the
// people who maintain sample goals are the brand's APC/IPC, and brands_update
// would have had to hand them owner_id, the managed-by-us statuses and every
// other column on the row to get one boolean. The RPC's authority mirrors the
// brand_products policy that already governs sample goals.

export async function getBrandUnlimitedSampleGoal(brandId) {
  if (!brandId) return false;
  const { data, error } = await supabase
    .from('brands')
    .select('unlimited_sample_goal')
    .eq('id', brandId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return data?.unlimited_sample_goal === true;
}

export async function setBrandUnlimitedSampleGoal(brandId, unlimited) {
  const { data, error } = await supabase.rpc('set_brand_unlimited_sample_goal', {
    p_brand_id:  brandId,
    p_unlimited: !!unlimited,
  });
  if (error) throw new Error(error.message);
  return data === true;
}

// The whole sample-goal picture for one brand in a single call: the brand-level
// unlimited flag plus the per-product goals, keyed the way report rows match
// them — by TikTok Shop product ID (primary: report product names come from
// Euka and differ from the catalog's) and by trimmed lowercase name (fallback
// for catalog products entered without an ID).
//
// Callers that get `unlimited: true` should draw no goal progress at all. The
// per-product numbers are still returned, because they are retained rather than
// erased while the flag is on — turning it back off restores them.
export async function getBrandSampleGoals(brandId) {
  if (!brandId) return { unlimited: false, goals: {} };
  const [unlimited, rows] = await Promise.all([
    getBrandUnlimitedSampleGoal(brandId),
    listProducts(brandId),
  ]);
  const goals = {};
  (rows || []).forEach((p) => {
    if (p.monthly_sample_goal == null) return;
    const pid = String(p.product_id || '').trim();
    if (pid) goals[pid] = p.monthly_sample_goal;
    const pname = String(p.product_name || '').trim().toLowerCase();
    if (pname) goals[pname] = p.monthly_sample_goal;
  });
  return { unlimited, goals };
}

export function normalizeSkus(skus) {
  return (skus || []).map((s) => ({
    id:           s.id || cryptoRandomId('sku'),
    sku_name:     String(s.sku_name || '').trim(),
    retail_price: Number(s.retail_price || 0),
  })).filter((s) => s.sku_name);
}

function cryptoRandomId(prefix = 'id') {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  return prefix + '_' + Math.random().toString(36).slice(2, 10);
}
