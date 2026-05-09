import { supabase } from './supabase';

// --------------------------------------------------------------
// product_campaigns — applies promotions to an existing brand_product.
// --------------------------------------------------------------

export async function listCampaigns({ brandId = null, status = 'all' } = {}) {
  let q = supabase
    .from('product_campaigns')
    .select(`
      *,
      brand:brand_id(id, brand_name, logo_url, owner_id),
      product:product_id(id, product_name, product_id, product_url, type, retail_price, skus)
    `)
    .order('latest_end_date', { ascending: false, nullsFirst: false });
  if (brandId) q = q.eq('brand_id', brandId);
  const { data, error } = await q;
  if (error) throw new Error(error.message);
  const rows = data || [];
  const today = todayStr();
  return rows.map((r) => ({ ...r, _status: deriveStatus(r, today) }))
    .filter((r) => status === 'all' || r._status === status);
}

export async function getCampaign(id) {
  const { data, error } = await supabase
    .from('product_campaigns')
    .select(`
      *,
      brand:brand_id(id, brand_name, logo_url, owner_id),
      product:product_id(id, product_name, product_id, product_url, type, retail_price, skus)
    `)
    .eq('id', id).maybeSingle();
  if (error) throw new Error(error.message);
  return data;
}

export async function createCampaign({ productId, promotions, skuOverrides = {}, rawPaste = null }) {
  const { data: me } = await supabase.auth.getUser();
  // Fetch brand_id from the product (trigger also does this server-side as a safety net).
  const { data: product } = await supabase
    .from('brand_products').select('brand_id').eq('id', productId).maybeSingle();
  if (!product) throw new Error('Product not found.');

  const payload = {
    product_id:    productId,
    brand_id:      product.brand_id,
    raw_paste:     rawPaste,
    promotions:    promotions || [],
    sku_overrides: skuOverrides || {},
    created_by:    me?.user?.id,
  };
  const { data, error } = await supabase
    .from('product_campaigns').insert(payload).select().single();
  if (error) throw new Error(error.message);
  return data;
}

export async function updateCampaign(id, patch) {
  const { data, error } = await supabase
    .from('product_campaigns').update(patch).eq('id', id).select().single();
  if (error) throw new Error(error.message);
  return data;
}

export async function deleteCampaign(id) {
  const { error } = await supabase.from('product_campaigns').delete().eq('id', id);
  if (error) throw new Error(error.message);
}

// --------------------------------------------------------------
// Brand picker — everything RLS lets the caller see
// --------------------------------------------------------------
export async function listMyBrands() {
  const { data, error } = await supabase
    .from('brands')
    .select('id, brand_name, logo_url, owner_id')
    .order('brand_name');
  if (error) throw new Error(error.message);
  return data || [];
}

// --------------------------------------------------------------
// Status helpers
// --------------------------------------------------------------
export function todayStr() { return new Date().toISOString().slice(0, 10); }

export function deriveStatus(row, today = todayStr()) {
  const end = row.latest_end_date;
  if (!end) return 'draft';
  if (end < today) return 'expired';
  const diffDays = Math.round((new Date(end) - new Date(today)) / 86400000);
  if (diffDays <= 2) return 'ending_soon';
  return 'active';
}

export const STATUS_META = {
  draft:       { label: 'Draft',        tone: 'muted'   },
  active:      { label: 'Active',       tone: 'success' },
  ending_soon: { label: 'Ending soon',  tone: 'warning' },
  expired:     { label: 'Expired',      tone: 'danger'  },
};

// --------------------------------------------------------------
// Paste parser — ports v1's TikTok Shop paste. Returns promotions[]
// matching our column shape (`start_date` / `end_date`).
// --------------------------------------------------------------
export function parsePastedPromotion(text) {
  const out = { retailPrice: 0, promotions: [] };
  if (!text) return out;
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);

  const isSectionHeader = (s) =>
    /^(individual product promotion|cart level promotion|coupon|retail price|schedule campaign)/i.test(s);
  const isPureDollar = (s) => /^\$?\s*\d+(\.\d+)?$/.test(s.replace(/,/g, ''));

  let i = 0;
  while (i < lines.length) {
    const lower = lines[i].toLowerCase();
    if (lower.includes('retail price')) {
      i++;
      if (i < lines.length) out.retailPrice = parseDollar(lines[i]);
    } else if (lower.includes('individual product promotion')) {
      const p = readPromotion(lines, ++i, 'individual', isSectionHeader, isPureDollar);
      if (p.promo.discount > 0) out.promotions.push(p.promo);
      i = p.cursor; continue;
    } else if (lower.includes('cart level promotion')) {
      const p = readPromotion(lines, ++i, 'cart', isSectionHeader, isPureDollar);
      if (p.promo.discount > 0) out.promotions.push(p.promo);
      i = p.cursor; continue;
    } else if (lower.includes('coupon')) {
      const p = readPromotion(lines, ++i, 'coupon', isSectionHeader, isPureDollar);
      if (p.promo.discount > 0) out.promotions.push(p.promo);
      i = p.cursor; continue;
    }
    i++;
  }

  const today = todayStr();
  out.promotions = out.promotions.map((p) => ({
    id:         cryptoRandomId('promo'),
    type:       p.type,
    name:       p.name || defaultPromoName(p.type),
    discount:   p.discount,
    start_date: p.start_date || '',
    end_date:   p.end_date   || '',
    status:     (p.end_date && p.end_date < today) ? 'expired' : 'active',
  }));
  return out;
}

function readPromotion(lines, start, type, isSectionHeader, isPureDollar) {
  const promo = { type, name: '', discount: 0, start_date: '', end_date: '' };
  let i = start;
  if (i < lines.length) { promo.discount = parseDollar(lines[i]); i++; }
  if (i < lines.length && !isPureDollar(lines[i]) && !isSectionHeader(lines[i]) && !lines[i].includes(' - ')) {
    promo.name = lines[i].replace(/^Schedule Campaign price\s*\d+\s*/i, '').trim();
    i++;
  }
  if (i < lines.length && isPureDollar(lines[i])) i++;
  if (i < lines.length && lines[i].includes(' - ')) {
    const dates = parseDateRange(lines[i]);
    promo.start_date = dates.start;
    promo.end_date   = dates.end;
    i++;
  }
  return { promo, cursor: i };
}

function defaultPromoName(type) {
  return type === 'individual' ? 'Individual product promotion'
       : type === 'cart'       ? 'Cart-level promotion'
       : 'Coupon';
}

function parseDollar(s) {
  if (!s) return 0;
  const m = String(s).replace(/,/g, '').match(/[0-9]+(?:\.[0-9]+)?/);
  return m ? Number(m[0]) : 0;
}

function parseDateRange(line) {
  const parts = line.split(' - ');
  if (parts.length < 2) return { start: '', end: '' };
  return { start: toIso(parts[0]), end: toIso(parts[1]) };
}

function toIso(raw) {
  if (!raw) return '';
  const cleaned = raw.replace(/\s*GMT[+-]?\d+.*$/i, '').trim();
  const d = new Date(cleaned);
  if (isNaN(d.getTime())) return '';
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function cryptoRandomId(prefix = 'id') {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  return prefix + '_' + Math.random().toString(36).slice(2, 10);
}
