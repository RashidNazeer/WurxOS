import { supabase } from './supabase';

// --------------------------------------------------------------
// Effective status — only 'Deactivated' is user-set; all other
// states (Upcoming/Ongoing/Ended) are derived from start_time
// and end_time. Matches v1's effectiveStatus logic.
// --------------------------------------------------------------
export function effectiveStatus(row) {
  if (!row) return 'Ongoing';
  if (row.status === 'Deactivated') return 'Deactivated';
  const now = Date.now();
  const start = row.start_time ? new Date(row.start_time).getTime() : null;
  const end   = row.end_time   ? new Date(row.end_time).getTime()   : null;
  if (start && now < start) return 'Upcoming';
  if (end   && now > end)   return 'Ended';
  if (start || end)         return 'Ongoing';
  return row.status || 'Ongoing';
}

export const STATUS_META = {
  Ongoing:     { tone: 'success', label: 'Ongoing' },
  Upcoming:    { tone: 'info',    label: 'Upcoming' },
  Ended:       { tone: 'muted',   label: 'Ended' },
  Deactivated: { tone: 'danger',  label: 'Deactivated' },
};

// --------------------------------------------------------------
// Queries
// --------------------------------------------------------------
export async function listCampaigns() {
  const { data, error } = await supabase
    .from('campaigns')
    .select(`
      *,
      brand:brand_id(id, brand_name, logo_url, owner_id),
      added_by_profile:added_by(display_name, role)
    `)
    .order('end_time', { ascending: true, nullsFirst: false })
    .order('created_at', { ascending: false });
  if (error) throw new Error(error.message);
  return (data || []).map((r) => ({ ...r, _status: effectiveStatus(r) }));
}

export async function listBrandsForPicker() {
  // Inactive brands are read-only; never show them in a creation picker.
  const { data, error } = await supabase
    .from('brands')
    .select('id, brand_name, logo_url, owner_id')
    .eq('status', 'active')
    .order('brand_name');
  if (error) throw new Error(error.message);
  return data || [];
}

// --------------------------------------------------------------
// Mutations
// --------------------------------------------------------------
export async function createCampaign(payload) {
  const { data: me } = await supabase.auth.getUser();
  const { data: brand } = payload.brandId
    ? await supabase.from('brands').select('owner_id').eq('id', payload.brandId).maybeSingle()
    : { data: null };

  const { data: profile } = me?.user?.id
    ? await supabase.from('profiles').select('role').eq('id', me.user.id).maybeSingle()
    : { data: null };

  const insertable = {
    brand_id:       payload.brandId,
    promotion_name: payload.promotionName.trim(),
    status:         payload.status || 'Ongoing',
    start_time:     payload.startTime || null,
    end_time:       payload.endTime   || null,
    type:           (payload.type  || '').trim() || null,
    notes:          (payload.notes || '').trim() || null,
    owner_id:       brand?.owner_id || me?.user?.id,
    added_by:       me?.user?.id,
    added_by_role:  profile?.role || null,
  };
  const { data, error } = await supabase
    .from('campaigns').insert(insertable).select().single();
  if (error) throw new Error(error.message);
  return data;
}

// Bulk create — used by the paste-import flow.
export async function createCampaignsBulk(rows) {
  const { data: me } = await supabase.auth.getUser();
  const { data: profile } = me?.user?.id
    ? await supabase.from('profiles').select('role').eq('id', me.user.id).maybeSingle()
    : { data: null };

  // Fetch owner_id for every involved brand once.
  const brandIds = Array.from(new Set(rows.map((r) => r.brandId).filter(Boolean)));
  const { data: brands } = brandIds.length
    ? await supabase.from('brands').select('id, owner_id').in('id', brandIds)
    : { data: [] };
  const ownerByBrand = new Map((brands || []).map((b) => [b.id, b.owner_id]));

  const insertables = rows.map((r) => ({
    brand_id:       r.brandId,
    promotion_name: r.promotionName.trim(),
    status:         r.status || 'Ongoing',
    start_time:     r.startTime || null,
    end_time:       r.endTime   || null,
    type:           (r.type  || '').trim() || null,
    notes:          (r.notes || '').trim() || null,
    owner_id:       ownerByBrand.get(r.brandId) || me?.user?.id,
    added_by:       me?.user?.id,
    added_by_role:  profile?.role || null,
  }));
  const { data, error } = await supabase.from('campaigns').insert(insertables).select();
  if (error) throw new Error(error.message);
  return data || [];
}

export async function updateCampaign(id, patch) {
  const normalized = { ...patch };
  if (patch.promotionName != null) { normalized.promotion_name = patch.promotionName.trim(); delete normalized.promotionName; }
  if (patch.startTime != null)     { normalized.start_time = patch.startTime || null; delete normalized.startTime; }
  if (patch.endTime != null)       { normalized.end_time   = patch.endTime   || null; delete normalized.endTime; }
  if (patch.type != null)          { normalized.type  = (patch.type  || '').trim() || null; }
  if (patch.notes != null)         { normalized.notes = (patch.notes || '').trim() || null; }
  const { data, error } = await supabase
    .from('campaigns').update(normalized).eq('id', id).select().single();
  if (error) throw new Error(error.message);
  return data;
}

export async function deleteCampaign(id) {
  const { error } = await supabase.from('campaigns').delete().eq('id', id);
  if (error) throw new Error(error.message);
}

// --------------------------------------------------------------
// Bulk paste parser — tab or spaced rows copied from TikTok Seller
// Center's promotions list. Returns an array of parsed rows
// { promotionName, status, startTime (ISO), endTime (ISO|null), type }.
// Unknown brand stays null — caller prompts for brand selection.
// --------------------------------------------------------------
const STATUS_TOKENS = /^(Ongoing|Upcoming|Ended|Deactivated)$/i;
const SKIP_HEADERS = /^(promotion name|status|start time|end time|type|gmv|units sold|orders?|revenue|views?)\b/i;

export function parseBulkPaste(text) {
  if (!text) return [];
  // Split into logical rows: try tab-delimited first; if no tabs,
  // fall back to 2+ spaces or line-level grouping.
  const rows = text.split('\n').map((l) => l.replace(/\r$/, '').trim()).filter(Boolean);

  const out = [];
  let cur = [];
  const flush = () => {
    if (cur.length) { out.push(cur); cur = []; }
  };

  for (const line of rows) {
    if (SKIP_HEADERS.test(line)) continue;
    const cells = line.includes('\t')
      ? line.split('\t').map((c) => c.trim()).filter(Boolean)
      : [line];

    if (cells.length >= 3) {
      // Looks like a full tab-delimited row — emit directly
      out.push(cells);
    } else {
      // Collect lines until we see a known status token → that closes a row
      cur.push(cells[0]);
      if (STATUS_TOKENS.test(cells[0])) flush();
    }
  }
  flush();

  return out.map(rowToCampaign).filter((r) => r && r.promotionName);
}

function rowToCampaign(cells) {
  // Heuristics: find the status token, pull the promotion name as the
  // line before it, pull dates as any tokens that look like dates,
  // pull type as a leftover token. If no status token is present,
  // treat the first cell as promotionName.
  if (!cells || cells.length === 0) return null;
  const lower = cells.map((c) => c.toLowerCase());
  let statusIdx = cells.findIndex((c) => STATUS_TOKENS.test(c));
  let promotionName, status = 'Ongoing';
  if (statusIdx > 0) {
    promotionName = cells[statusIdx - 1];
    status = titleCase(cells[statusIdx]);
  } else {
    promotionName = cells[0];
  }
  if (!promotionName) return null;

  const dates = [];
  for (const c of cells) {
    const iso = parseFlexibleDate(c);
    if (iso) dates.push(iso);
  }
  const [startTime = null, endTime = null] = dates;

  // First "other" cell after status that isn't a date and isn't the name → type
  let type = '';
  for (let i = statusIdx + 1; i < cells.length; i++) {
    const c = cells[i];
    if (parseFlexibleDate(c)) continue;
    if (/^indefinite$/i.test(c)) continue;
    if (c === promotionName) continue;
    type = c;
    break;
  }

  return {
    promotionName,
    status: ['Ongoing','Upcoming','Ended','Deactivated'].includes(status) ? (status === 'Deactivated' ? 'Deactivated' : 'Ongoing') : 'Ongoing',
    startTime, endTime, type,
  };
}

function titleCase(s) { return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase(); }

export function parseFlexibleDate(s) {
  if (!s) return null;
  if (/^indefinite$/i.test(String(s).trim())) return null;
  // Strip parenthetical timezone like "(PDT)" / "GMT-7" / "PST"
  const cleaned = String(s).replace(/\s*\((?:[A-Z]{2,5})\)\s*$/, '').replace(/\s*GMT[+-]?\d+.*$/i, '').trim();
  const d = new Date(cleaned);
  if (isNaN(d.getTime())) return null;
  return d.toISOString();
}
