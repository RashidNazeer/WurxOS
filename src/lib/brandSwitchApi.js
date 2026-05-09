import { supabase } from './supabase';

// Legacy TL-ownership switch request (pre-045). Kept so any in-flight
// rows still have a create-path; new UIs should call
// `submitApcSwitchRequest` instead.
export async function submitBrandSwitch({ brandId, fromOwnerId, toOwnerId, reason = '' }) {
  const { data: me } = await supabase.auth.getUser();
  const { data, error } = await supabase
    .from('brand_switch_requests')
    .insert({
      brand_id: brandId,
      from_owner_id: fromOwnerId || null,
      to_owner_id: toOwnerId,
      requested_by: me?.user?.id,
      reason,
    })
    .select()
    .single();
  if (error) throw new Error(error.message);
  return data;
}

// New canonical shape: an OL proposes moving a brand's APC to
// `toApcId`. On Boss approval, the DB trigger calls
// `brand_switch_apc` which retargets the TL, tasks, and notifications.
export async function submitApcSwitchRequest({ brandId, toApcId, reason = '', notify = false }) {
  const { data: me } = await supabase.auth.getUser();
  const { data, error } = await supabase
    .from('brand_switch_requests')
    .insert({
      brand_id: brandId,
      to_apc_id: toApcId,
      requested_by: me?.user?.id,
      reason,
      notify_on_approve: notify,
    })
    .select()
    .single();
  if (error) throw new Error(error.message);
  return data;
}

export async function listBrandSwitchRequests() {
  const { data, error } = await supabase
    .from('brand_switch_requests')
    .select(`
      *,
      brand:brand_id(id, brand_name, logo_url),
      from_owner:from_owner_id(id, display_name, role, avatar_url),
      to_owner:to_owner_id(id, display_name, role, avatar_url),
      to_apc:to_apc_id(id, display_name, role, avatar_url, email, reports_to, manager:reports_to(id, display_name, role)),
      requester:requested_by(id, display_name, role, avatar_url),
      decider:decided_by(id, display_name)
    `)
    .order('created_at', { ascending: false });
  if (error) throw new Error(error.message);
  return data || [];
}

export async function decideBrandSwitch(id, { approve, note = '' }) {
  const { data: me } = await supabase.auth.getUser();
  const { error } = await supabase
    .from('brand_switch_requests')
    .update({
      status:        approve ? 'approved' : 'rejected',
      decision_note: note || null,
      decided_by:    me?.user?.id,
      decided_at:    new Date().toISOString(),
    })
    .eq('id', id);
  if (error) throw new Error(error.message);
}

export async function cancelBrandSwitch(id) {
  const { error } = await supabase
    .from('brand_switch_requests')
    .update({ status: 'cancelled' })
    .eq('id', id);
  if (error) throw new Error(error.message);
}
