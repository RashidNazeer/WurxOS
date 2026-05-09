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
// IPC management (PCTL-facing)
// --------------------------------------------------------------
export async function listMyIPCs(pctlId) {
  const { data, error } = await supabase
    .from('profiles')
    .select('id, display_name, email, is_active, leave_quota, created_at')
    .eq('role', 'ipc')
    .eq('reports_to', pctlId)
    .order('created_at', { ascending: false });
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
    .select('brand_id, brand:brand_id(id, brand_name, logo_url, paid_collab_status)')
    .eq('user_id', ipcId);
  if (error) throw new Error(error.message);
  return (data || []).map((r) => r.brand).filter(Boolean);
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
