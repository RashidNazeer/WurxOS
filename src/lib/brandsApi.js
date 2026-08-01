import { supabase } from './supabase';

// --------------------------------------------------------------
// Reads
// --------------------------------------------------------------
// Returns brands visible to the current user (filtered by RLS) with
// the owner profile and the list of assigned APCs.
export async function listBrands({ status } = {}) {
  let q = supabase
    .from('brands')
    .select(`
      *,
      owner:owner_id(id, display_name, email, role, avatar_url, deleted_at),
      assignments:brand_assignments(user_id, assigned_at, expires_at, profile:user_id(id, display_name, email, role, avatar_url, deleted_at))
    `)
    .order('created_at', { ascending: false });
  if (status) q = q.eq('status', status);
  const { data, error } = await q;
  if (error) throw new Error(error.message);
  return (data || []).map(normalizeBrand);
}

export async function getBrand(id) {
  const { data, error } = await supabase
    .from('brands')
    .select(`
      *,
      owner:owner_id(id, display_name, email, role, avatar_url, deleted_at),
      assignments:brand_assignments(user_id, assigned_at, expires_at, profile:user_id(id, display_name, email, role, avatar_url, deleted_at))
    `)
    .eq('id', id)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return data ? normalizeBrand(data) : null;
}

// Record (or clear, pass null) the last date a sale was generated for a brand.
// Goes through the RPC so an assigned APC/IPC can set it even though they can't
// edit the brand form (Boss/OL/owner only). Server re-checks the caller's scope.
export async function setBrandLastSaleDate(brandId, date) {
  const { error } = await supabase.rpc('brand_set_last_sale_date', {
    p_brand: brandId, p_date: date || null,
  });
  if (error) throw new Error(error.message);
}

function normalizeBrand(row) {
  // Strip soft-deleted users from the assignment list and the owner.
  // Profile rows have deleted_at set by the delete-user Edge Function;
  // we don't want them showing up as brand members.
  const assignedUsers = (row.assignments || [])
    .filter((a) => a.profile && !a.profile.deleted_at)
    .map((a) => ({ ...a.profile, assignedAt: a.assigned_at, expiresAt: a.expires_at }));
  const owner = row.owner && !row.owner.deleted_at ? row.owner : null;
  return { ...row, assignedUsers, owner };
}

// --------------------------------------------------------------
// Writes (brands)
// --------------------------------------------------------------
// The Euka stores available to link a brand to (slug + store_id + label).
// Read from the euka_stores reference table (mig 229) — non-secret, so any
// authenticated user (Boss/OL/TL creating a brand) can load it for the picker.
export async function listEukaStores() {
  const { data, error } = await supabase
    .from('euka_stores')
    .select('store_id, slug, label')
    .eq('is_active', true)
    .order('label');
  if (error) throw new Error(error.message);
  return data || [];
}

export async function createBrand({ brandName, clientName, tier, gmv, ownerId, logoUrl, status = 'active', paidCollabStatus = 'not_applicable', gmvMaxStatus = 'not_applicable', currency = 'USD', eukaStoreId = null, eukaSlug = null }) {
  const { data: me } = await supabase.auth.getUser();
  const { data, error } = await supabase
    .from('brands')
    .insert({
      brand_name: brandName.trim(),
      client_name: (clientName || '').trim(),
      tier: tier?.trim() || null,
      gmv: toNumberOrNull(gmv),
      owner_id: ownerId,
      logo_url: logoUrl || null,
      status,
      paid_collab_status: paidCollabStatus,
      gmv_max_status: gmvMaxStatus,
      currency: currency || 'USD',
      euka_store_id: eukaStoreId || null,
      euka_slug: eukaSlug || null,
      created_by: me?.user?.id ?? null,
    })
    .select()
    .single();
  if (error) throw new Error(error.message);
  return data;
}

function toNumberOrNull(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

export async function updateBrand(id, patch) {
  const payload = {};
  if ('brandName'  in patch) payload.brand_name  = patch.brandName.trim();
  if ('clientName' in patch) payload.client_name = (patch.clientName || '').trim();
  if ('tier'       in patch) payload.tier        = patch.tier?.trim() || null;
  if ('gmv'        in patch) payload.gmv         = toNumberOrNull(patch.gmv);
  if ('ownerId'    in patch) payload.owner_id    = patch.ownerId;
  if ('logoUrl'    in patch) payload.logo_url    = patch.logoUrl || null;
  if ('status'     in patch) payload.status      = patch.status;
  if ('paidCollabStatus' in patch) payload.paid_collab_status = patch.paidCollabStatus;
  if ('gmvMaxStatus'     in patch) payload.gmv_max_status     = patch.gmvMaxStatus;
  if ('currency'         in patch) payload.currency           = patch.currency || 'USD';
  // Euka link — set both together (store scopes queries, slug picks the key).
  // Passing null for both un-links the brand from Euka.
  if ('eukaStoreId' in patch) payload.euka_store_id = patch.eukaStoreId || null;
  if ('eukaSlug'    in patch) payload.euka_slug     = patch.eukaSlug || null;

  const { data, error } = await supabase
    .from('brands')
    .update(payload)
    .eq('id', id)
    .select()
    .single();
  if (error) throw new Error(error.message);
  return data;
}

// --------------------------------------------------------------
// Brand custom fields
// --------------------------------------------------------------
export async function listBrandCustomFields(brandId) {
  const { data, error } = await supabase
    .from('brand_custom_fields')
    .select('*')
    .eq('brand_id', brandId)
    .order('created_at', { ascending: true });
  if (error) throw new Error(error.message);
  return data || [];
}

export async function addBrandCustomField(brandId, fieldName, fieldValue = '') {
  const { data, error } = await supabase
    .from('brand_custom_fields')
    .insert({ brand_id: brandId, field_name: fieldName.trim(), field_value: fieldValue })
    .select()
    .single();
  if (error) throw new Error(error.message);
  return data;
}

export async function updateBrandCustomField(id, patch) {
  const payload = {};
  if ('fieldName'  in patch) payload.field_name  = patch.fieldName.trim();
  if ('fieldValue' in patch) payload.field_value = patch.fieldValue;
  const { data, error } = await supabase
    .from('brand_custom_fields')
    .update(payload)
    .eq('id', id)
    .select()
    .single();
  if (error) throw new Error(error.message);
  return data;
}

export async function deleteBrandCustomField(id) {
  const { error } = await supabase.from('brand_custom_fields').delete().eq('id', id);
  if (error) throw new Error(error.message);
}

export async function archiveBrand(id) {
  return updateBrand(id, { status: 'inactive' });
}

export async function reactivateBrand(id) {
  return updateBrand(id, { status: 'active' });
}

// --------------------------------------------------------------
// Brand ↔ APC assignments
// --------------------------------------------------------------
// Replace the full assignment set for a brand: diff + add/remove.
export async function setBrandAssignments(brandId, userIds) {
  const { data: current, error: curErr } = await supabase
    .from('brand_assignments')
    .select('user_id')
    .eq('brand_id', brandId);
  if (curErr) throw new Error(curErr.message);

  const currentIds = new Set((current || []).map((r) => r.user_id));
  const nextIds    = new Set(userIds);

  const toAdd    = [...nextIds].filter((id) => !currentIds.has(id));
  const toRemove = [...currentIds].filter((id) => !nextIds.has(id));

  if (toAdd.length) {
    const { data: me } = await supabase.auth.getUser();
    const rows = toAdd.map((user_id) => ({ brand_id: brandId, user_id, assigned_by: me?.user?.id ?? null }));
    const { error } = await supabase.from('brand_assignments').insert(rows);
    if (error) throw new Error(error.message);
  }

  if (toRemove.length) {
    const { error } = await supabase
      .from('brand_assignments')
      .delete()
      .eq('brand_id', brandId)
      .in('user_id', toRemove);
    if (error) throw new Error(error.message);
  }

  return { added: toAdd.length, removed: toRemove.length };
}

// --------------------------------------------------------------
// Assign a brand to an APC/IPC ALONGSIDE any existing assignees, optionally
// for a limited time. Used by the brand's owning TL (and OL/Boss) to cover a
// brand when its usual APC is unavailable. expiresAt = ISO string for a
// temporary assignment (auto-removed by the expire-brand-assignments cron),
// or null for permanent. RLS already gates this to can_edit_brand.
// --------------------------------------------------------------
export async function assignBrandUser(brandId, userId, expiresAt = null) {
  const { data: me } = await supabase.auth.getUser();
  const { error } = await supabase
    .from('brand_assignments')
    .upsert(
      { brand_id: brandId, user_id: userId, assigned_by: me?.user?.id ?? null, expires_at: expiresAt },
      { onConflict: 'brand_id,user_id' },
    );
  if (error) throw new Error(error.message);
}

export async function unassignBrandUser(brandId, userId) {
  const { error } = await supabase
    .from('brand_assignments')
    .delete()
    .eq('brand_id', brandId)
    .eq('user_id', userId);
  if (error) throw new Error(error.message);
}

// --------------------------------------------------------------
// Switch a brand's APC (Boss / OL only)
//
// Replaces the brand's APC assignment with `newApcId`, retargets
// the brand's TL to the new APC's manager, and reassigns any open
// tasks on the brand from the old APC(s) to the new one.
// --------------------------------------------------------------
// `notify` defaults to false — notifications are opt-in. The RPC
// only dispatches the brand.switched notification to the new APC and
// their Team Lead when the caller explicitly ticks the UI checkbox.
export async function switchBrandApc(brandId, newApcId, note = null, notify = false) {
  const { error } = await supabase.rpc('brand_switch_apc', {
    p_brand: brandId, p_new_apc: newApcId, p_note: note, p_notify: notify,
  });
  if (error) throw new Error(error.message);
}

// Returns the current brand list for each of the two users — used
// by the Switch APC preview so the caller can see exactly which
// brands will move in each direction of the swap.
export async function listBrandsForUsers(userIds) {
  const ids = (userIds || []).filter(Boolean);
  if (ids.length === 0) return {};
  const { data, error } = await supabase
    .from('brand_assignments')
    .select('user_id, brand:brand_id(id, brand_name, logo_url)')
    .in('user_id', ids);
  if (error) throw new Error(error.message);
  const byUser = {};
  for (const row of data || []) {
    if (!row.brand) continue;
    (byUser[row.user_id] ||= []).push(row.brand);
  }
  return byUser;
}

// List APCs / IPCs that can receive a brand (any active APC/IPC with
// a Team Lead so ownership can resolve cleanly).
export async function listAssignableApcs() {
  const { data, error } = await supabase
    .from('profiles')
    .select('id, display_name, email, role, avatar_url, reports_to, manager:reports_to(id, display_name, role)')
    .in('role', ['apc', 'ipc'])
    .eq('is_active', true)
    .not('reports_to', 'is', null)
    .order('display_name');
  if (error) throw new Error(error.message);
  return data || [];
}

// --------------------------------------------------------------
// Logo upload
// --------------------------------------------------------------
// Uploads to `brand-logos` bucket and returns a public URL.
export async function uploadBrandLogo(file) {
  if (!file) return null;
  const ext = (file.name.split('.').pop() || 'png').toLowerCase();
  const filename = `${crypto.randomUUID()}.${ext}`;
  const path = `logos/${filename}`;

  const { error: upErr } = await supabase.storage
    .from('brand-logos')
    .upload(path, file, { contentType: file.type, upsert: false });
  if (upErr) throw new Error(upErr.message);

  const { data } = supabase.storage.from('brand-logos').getPublicUrl(path);
  return data.publicUrl;
}

// Remove a logo file from storage. Safe to call with a falsy value.
export async function removeBrandLogo(publicUrl) {
  if (!publicUrl) return;
  // Extract the object path after '/brand-logos/'
  const marker = '/brand-logos/';
  const idx = publicUrl.indexOf(marker);
  if (idx < 0) return;
  const path = publicUrl.substring(idx + marker.length);
  await supabase.storage.from('brand-logos').remove([path]);
}

// --------------------------------------------------------------
// Lookups for pickers
// --------------------------------------------------------------
export async function listActiveTLs() {
  const { data, error } = await supabase
    .from('profiles')
    .select('id, display_name, email')
    .eq('role', 'tl')
    .eq('is_active', true)
    .order('display_name', { ascending: true });
  if (error) throw new Error(error.message);
  return data || [];
}

// APCs that report to a given TL — used when picking assigned APCs
// for a brand owned by that TL.
export async function listAPCsUnderTL(tlId) {
  if (!tlId) return [];
  const { data, error } = await supabase
    .from('profiles')
    .select('id, display_name, email')
    .eq('role', 'apc')
    .eq('is_active', true)
    .eq('reports_to', tlId)
    .order('display_name', { ascending: true });
  if (error) throw new Error(error.message);
  return data || [];
}

// Same as listAPCsUnderTL but augmented with each APC's current brand
// workload so the caller can split them into "already managing" vs
// "available" groups. Returns each row with `brand_count`.
export async function listAPCsUnderTLWithLoad(tlId) {
  if (!tlId) return [];
  const apcs = await listAPCsUnderTL(tlId);
  if (apcs.length === 0) return [];

  const ids = apcs.map((a) => a.id);
  const { data: rows, error } = await supabase
    .from('brand_assignments')
    .select('user_id')
    .in('user_id', ids);
  if (error) throw new Error(error.message);

  const byUser = new Map();
  for (const r of rows || []) {
    byUser.set(r.user_id, (byUser.get(r.user_id) || 0) + 1);
  }
  return apcs.map((a) => ({ ...a, brand_count: byUser.get(a.id) || 0 }));
}
