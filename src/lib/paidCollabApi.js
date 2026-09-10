import { supabase } from './supabase';

// --------------------------------------------------------------
// PCTL brand selections (which brands a PCTL manages)
// --------------------------------------------------------------
export async function listMySelectedBrands(pctlId) {
  const { data, error } = await supabase
    .from('pctl_brand_selections')
    .select('brand_id, created_at, brand:brand_id(id, brand_name, logo_url, paid_collab_status, status)')
    .eq('pctl_id', pctlId)
    .order('created_at', { ascending: false });
  if (error) throw new Error(error.message);
  return (data || []).map((r) => ({ ...r.brand, selectedAt: r.created_at }));
}

// Brands PCTL is eligible to pick: anything with paid_collab_status != 'not_applicable'
export async function listPaidCollabEligibleBrands() {
  const { data, error } = await supabase
    .from('brands')
    .select('id, brand_name, logo_url, paid_collab_status, status, owner_id, owner:owner_id(id, display_name)')
    .neq('paid_collab_status', 'not_applicable')
    .eq('status', 'active')
    .order('brand_name', { ascending: true });
  if (error) throw new Error(error.message);
  return data || [];
}

export async function selectBrand(pctlId, brandId) {
  const { error } = await supabase
    .from('pctl_brand_selections')
    .insert({ pctl_id: pctlId, brand_id: brandId });
  if (error) throw new Error(error.message);
}

export async function unselectBrand(pctlId, brandId) {
  const { error } = await supabase
    .from('pctl_brand_selections')
    .delete()
    .eq('pctl_id', pctlId)
    .eq('brand_id', brandId);
  if (error) throw new Error(error.message);
}

// --------------------------------------------------------------
// IPC management (PCTL & OL-facing)
// --------------------------------------------------------------
export async function listMyIPCs(pctlId) {
  const { data, error } = await supabase
    .from('profiles')
    .select('id, display_name, email, is_active, leave_quota, created_at, reports_to, manager:reports_to(id, display_name, role)')
    .eq('role', 'ipc')
    .eq('reports_to', pctlId)
    .order('created_at', { ascending: false });
  if (error) throw new Error(error.message);
  return data || [];
}

export async function listAllIPCs() {
  const { data, error } = await supabase
    .from('profiles')
    .select('id, display_name, email, is_active, leave_quota, created_at, reports_to, manager:reports_to(id, display_name, role)')
    .eq('role', 'ipc')
    .order('display_name', { ascending: true });
  if (error) throw new Error(error.message);
  return data || [];
}

export async function listAssignableBrandsForIPC() {
  const { data, error } = await supabase
    .from('brands')
    .select('id, brand_name, logo_url, paid_collab_status, status, owner:owner_id(id, display_name)')
    .eq('status', 'active')
    .order('brand_name', { ascending: true });
  if (error) throw new Error(error.message);
  return data || [];
}

export async function updateIPCProfile(ipcId, patch) {
  const { data, error } = await supabase
    .from('profiles')
    .update(patch)
    .eq('id', ipcId)
    .select()
    .single();
  if (error) throw new Error(error.message);
  return data;
}

export async function listIPCAssignedBrands(ipcId) {
  const { data, error } = await supabase
    .from('brand_assignments')
    .select('brand_id, brand:brand_id(id, brand_name, logo_url, paid_collab_status, status)')
    .eq('user_id', ipcId);
  if (error) throw new Error(error.message);
  return (data || []).map((r) => r.brand).filter(Boolean);
}

/**
 * Set an IPC's brand allocation. Server-side, or not at all.
 *
 * ── WHY THERE IS NO FALLBACK HERE ──────────────────────────────────────────
 * The first draft, on ANY rpc error, silently retried the same writes directly
 * against brand_assignments — with a comment saying "fallback if RPC is not
 * deployed yet". Two things were wrong with that.
 *
 * A "not authorised" error is an rpc error. So the fallback fired precisely
 * when the permission check had just refused, and attempted the write again by
 * another route. The RPC's guard was therefore not the boundary at all; the
 * table's RLS policy was, and any gap between the two was reachable.
 *
 * It also broke atomicity. The RPC diffs inside one transaction; the fallback
 * did a separate insert and a separate delete, so a failure between them left
 * the allocation half-applied with no error the operator could act on.
 *
 * If the function is missing the correct outcome is a visible failure, not a
 * quieter path around the check.
 */
export async function setIPCBrandAssignments(ipcId, brandIds) {
  const { data, error } = await supabase.rpc('ipc_set_brand_assignments', {
    p_ipc_id: ipcId,
    p_brand_ids: brandIds || [],
  });
  if (error) throw new Error(error.message);
  // The function returns what actually changed, so the caller can say
  // "2 added, 1 removed" rather than assuming the save did what was asked.
  const row = Array.isArray(data) ? data[0] : data;
  return {
    added: Number(row?.added) || 0,
    removed: Number(row?.removed) || 0,
    unchanged: Number(row?.unchanged) || 0,
  };
}

export async function assignIPCToBrand(ipcId, brandId) {
  const { data: me } = await supabase.auth.getUser();
  const { error } = await supabase
    .from('brand_assignments')
    .insert({ brand_id: brandId, user_id: ipcId, assigned_by: me?.user?.id ?? null });
  if (error) throw new Error(error.message);
}

export async function unassignIPCFromBrand(ipcId, brandId) {
  const { error } = await supabase
    .from('brand_assignments')
    .delete()
    .eq('brand_id', brandId)
    .eq('user_id', ipcId);
  if (error) throw new Error(error.message);
}

// --------------------------------------------------------------
// Leave quota defaults (app_config; Boss-editable, everyone reads
// the column via their own profiles row).
// --------------------------------------------------------------
export async function getLeaveQuotaDefault() {
  const { data, error } = await supabase
    .from('app_config')
    .select('value')
    .eq('key', 'leave_quota_default')
    .maybeSingle();
  if (error) throw new Error(error.message);
  try {
    return data?.value ? JSON.parse(data.value) : { wfh: 2, medical: 1, emergency: 1 };
  } catch {
    return { wfh: 2, medical: 1, emergency: 1 };
  }
}

export async function setLeaveQuotaDefault(quota) {
  const payload = JSON.stringify({
    wfh:       Number(quota.wfh       ?? 0),
    medical:   Number(quota.medical   ?? 0),
    emergency: Number(quota.emergency ?? 0),
  });
  const { error } = await supabase
    .from('app_config')
    .update({ value: payload })
    .eq('key', 'leave_quota_default');
  if (error) throw new Error(error.message);
}
