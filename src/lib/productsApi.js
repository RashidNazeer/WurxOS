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
