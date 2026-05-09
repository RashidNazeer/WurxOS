// GMV Max Reporting API.
//
// Per-brand monthly entries stored in `gmv_max_reports`. Each row has:
//   * Monthly Overview metrics (cost, sku_orders, cost_per_order,
//     gross_revenue, roi)
//   * A `campaigns` jsonb array of per-campaign breakdowns, each with
//     metadata (name, ID, target ROI, schedule, budget, status) and
//     the same 5 performance metrics as the overview.
//
// All money values are USD — these reports come from TikTok Ads
// Manager which is USD-denominated for the US shop accounts the team
// manages. (Other parts of WurxOS use PKR; GMV Max is the exception.)

import { supabase } from './supabase';

// ── Helpers ─────────────────────────────────────────────────────────

export function monthKey(year, monthIdx) {
  return `${year}-${String(monthIdx + 1).padStart(2, '0')}`;
}

export function monthRange(year, monthIdx) {
  const start = `${monthKey(year, monthIdx)}-01`;
  const last = new Date(year, monthIdx + 1, 0).getDate();
  const end = `${monthKey(year, monthIdx)}-${String(last).padStart(2, '0')}`;
  return { start, end };
}

export function monthLabel(year, monthIdx) {
  const d = new Date(year, monthIdx, 1);
  return d.toLocaleString('en-US', { month: 'long', year: 'numeric' });
}

export function newCampaignId() {
  return 'cmp_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6);
}

function toNum(v) {
  if (v == null || v === '') return 0;
  const s = String(v).replace(/[$,\s]/g, '');
  const n = parseFloat(s);
  return Number.isNaN(n) ? 0 : n;
}

// ── Field metadata (used by the entry forms) ────────────────────────

export const GMV_MAX_FIELDS = [
  { key: 'cost',          label: 'Cost',           suffix: 'USD',  hint: 'Total ad spend for the period' },
  { key: 'skuOrders',     label: 'SKU Orders',     suffix: '',     hint: 'Number of SKU orders generated' },
  { key: 'costPerOrder',  label: 'Cost per Order', suffix: 'USD',  hint: 'Cost ÷ SKU orders' },
  { key: 'grossRevenue',  label: 'Gross Revenue',  suffix: 'USD',  hint: 'Total revenue attributable to GMV Max' },
  { key: 'roi',           label: 'ROI',            suffix: 'x',    hint: 'Gross revenue ÷ cost' },
];

export const GMV_CAMPAIGN_META_FIELDS = [
  { key: 'campaignName',   label: 'Campaign Name',    type: 'text',           placeholder: 'e.g. GMV Max_NuDerma Clinical_4.25', required: true },
  { key: 'campaignId',     label: 'Campaign ID',      type: 'text',           placeholder: 'e.g. 1828327240366130' },
  { key: 'targetRoi',      label: 'Target ROI',       type: 'number',         suffix: 'x',   placeholder: 'e.g. 2.70' },
  { key: 'scheduleTime',   label: 'Schedule Time',    type: 'datetime-local', placeholder: 'YYYY-MM-DDTHH:MM' },
  { key: 'campaignBudget', label: 'Campaign Budget',  type: 'number',         suffix: 'USD', placeholder: 'e.g. 40000' },
];

export const CAMPAIGN_STATUSES = [
  { key: 'active', label: 'Active', color: '#16a34a', bg: '#dcfce7' },
  { key: 'paused', label: 'Paused', color: '#d97706', bg: '#fef3c7' },
  { key: 'ended',  label: 'Ended',  color: '#64748b', bg: '#f1f5f9' },
  { key: 'draft',  label: 'Draft',  color: '#7c3aed', bg: '#f3e8ff' },
];

export function formatGmvField(key, value) {
  const v = Number(value) || 0;
  switch (key) {
    case 'cost':
    case 'costPerOrder':
    case 'grossRevenue':
      return v.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 });
    case 'skuOrders':
      return v.toLocaleString('en-US');
    case 'roi':
      return v.toFixed(2) + 'x';
    default:
      return v.toLocaleString('en-US');
  }
}

// ── Row ↔ camelCase mapping ────────────────────────────────────────
// DB columns are snake_case; the UI deals in camelCase to match the
// shape v1's components expect. We normalize on every read/write.

function fromRow(r) {
  if (!r) return r;
  return {
    id: r.id,
    brandId: r.brand_id,
    brandName: r.brand_name,
    period: r.period,
    periodStart: r.period_start,
    periodEnd: r.period_end,
    periodLabel: r.period_label,
    cost: Number(r.cost) || 0,
    skuOrders: Number(r.sku_orders) || 0,
    costPerOrder: Number(r.cost_per_order) || 0,
    grossRevenue: Number(r.gross_revenue) || 0,
    roi: Number(r.roi) || 0,
    currency: r.currency || 'USD',
    notes: r.notes || '',
    campaigns: Array.isArray(r.campaigns) ? r.campaigns : [],
    createdAt: r.created_at,
    createdBy: r.created_by,
    createdByName: r.created_by_name,
    updatedAt: r.updated_at,
    updatedBy: r.updated_by,
    updatedByName: r.updated_by_name,
  };
}

function normalizeCampaign(c) {
  return {
    id: c.id || newCampaignId(),
    campaignName: c.campaignName || '',
    campaignId: c.campaignId || '',
    targetRoi: toNum(c.targetRoi),
    scheduleTime: c.scheduleTime || '',
    campaignBudget: toNum(c.campaignBudget),
    status: c.status || 'active',
    cost: toNum(c.cost),
    skuOrders: toNum(c.skuOrders),
    costPerOrder: toNum(c.costPerOrder),
    grossRevenue: toNum(c.grossRevenue),
    roi: toNum(c.roi),
    notes: c.notes || '',
  };
}

// ── Reads ───────────────────────────────────────────────────────────

export async function getGmvMaxReportsForBrand(brandId, period = null) {
  let q = supabase.from('gmv_max_reports')
    .select('*')
    .eq('brand_id', brandId)
    .order('period_start', { ascending: false })
    .limit(120);
  if (period) q = q.eq('period', period);
  const { data, error } = await q;
  if (error) throw new Error(error.message);
  return (data || []).map(fromRow);
}

export async function getGmvMaxReport({ brandId, period, periodStart }) {
  const { data, error } = await supabase.from('gmv_max_reports')
    .select('*')
    .eq('brand_id', brandId)
    .eq('period', period)
    .eq('period_start', periodStart)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return data ? fromRow(data) : null;
}

export async function getGmvMaxReportsForBrands(brandIds) {
  if (!brandIds || brandIds.length === 0) return [];
  const { data, error } = await supabase.from('gmv_max_reports')
    .select('*')
    .in('brand_id', brandIds)
    .order('period_start', { ascending: false })
    .limit(500);
  if (error) throw new Error(error.message);
  return (data || []).map(fromRow);
}

// ── Writes ──────────────────────────────────────────────────────────

/** Create or update a monthly GMV Max overview. Campaigns are
 *  preserved if the row already exists and `campaigns` is omitted. */
export async function saveGmvMaxReport({
  brandId, brandName, period, periodStart, periodEnd, periodLabel,
  cost, skuOrders, costPerOrder, grossRevenue, roi,
  notes = '', campaigns = null,
}) {
  const { data: me } = await supabase.auth.getUser();
  const { data: prof } = await supabase.from('profiles')
    .select('display_name').eq('id', me?.user?.id).maybeSingle();
  const userName = prof?.display_name || me?.user?.email || '';

  const payload = {
    brand_id: brandId,
    brand_name: brandName,
    period,
    period_start: periodStart,
    period_end: periodEnd,
    period_label: periodLabel,
    cost: toNum(cost),
    sku_orders: Math.round(toNum(skuOrders)),
    cost_per_order: toNum(costPerOrder),
    gross_revenue: toNum(grossRevenue),
    roi: toNum(roi),
    notes,
    updated_by: me?.user?.id,
    updated_by_name: userName,
  };
  if (campaigns) {
    payload.campaigns = campaigns.map(normalizeCampaign);
  }

  // Look up existing row to preserve created_by + campaigns when omitted.
  const { data: existing } = await supabase.from('gmv_max_reports')
    .select('id, campaigns, created_by, created_by_name')
    .eq('brand_id', brandId).eq('period', period).eq('period_start', periodStart)
    .maybeSingle();

  if (existing) {
    if (!campaigns) payload.campaigns = existing.campaigns; // preserve
    const { data, error } = await supabase.from('gmv_max_reports')
      .update(payload).eq('id', existing.id).select().single();
    if (error) throw new Error(error.message);
    return fromRow(data);
  }
  payload.created_by = me?.user?.id;
  payload.created_by_name = userName;
  if (!campaigns) payload.campaigns = [];
  const { data, error } = await supabase.from('gmv_max_reports')
    .insert(payload).select().single();
  if (error) throw new Error(error.message);
  return fromRow(data);
}

/** Replace the campaigns array on a monthly entry. Creates the row
 *  with empty overview metrics if it doesn't yet exist. */
export async function setGmvMaxCampaigns({
  brandId, brandName, periodStart, periodEnd, periodLabel, campaigns,
}) {
  const { data: me } = await supabase.auth.getUser();
  const { data: prof } = await supabase.from('profiles')
    .select('display_name').eq('id', me?.user?.id).maybeSingle();
  const userName = prof?.display_name || me?.user?.email || '';

  const normalized = (campaigns || []).map(normalizeCampaign);

  const { data: existing } = await supabase.from('gmv_max_reports')
    .select('id')
    .eq('brand_id', brandId).eq('period', 'monthly').eq('period_start', periodStart)
    .maybeSingle();

  if (existing) {
    const { data, error } = await supabase.from('gmv_max_reports')
      .update({
        campaigns: normalized,
        updated_by: me?.user?.id, updated_by_name: userName,
      })
      .eq('id', existing.id).select().single();
    if (error) throw new Error(error.message);
    return fromRow(data);
  }
  const { data, error } = await supabase.from('gmv_max_reports')
    .insert({
      brand_id: brandId, brand_name: brandName,
      period: 'monthly',
      period_start: periodStart, period_end: periodEnd, period_label: periodLabel,
      campaigns: normalized,
      created_by: me?.user?.id, created_by_name: userName,
      updated_by: me?.user?.id, updated_by_name: userName,
    })
    .select().single();
  if (error) throw new Error(error.message);
  return fromRow(data);
}

export async function deleteGmvMaxReport(id) {
  const { error } = await supabase.from('gmv_max_reports').delete().eq('id', id);
  if (error) throw new Error(error.message);
}
