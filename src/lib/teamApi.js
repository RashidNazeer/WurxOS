// Team management API — wrappers for the SQL RPCs in migration 114.
//
// All actions are Boss / OL / Developer only (enforced server-side).

import { supabase } from './supabase';

/** Move an APC (or IPC) under a different Team Lead. */
export async function moveApcToTl(apcId, newTlId) {
  const { data, error } = await supabase.rpc('team_move_apc_to_tl', {
    p_apc:    apcId,
    p_new_tl: newTlId,
  });
  if (error) throw new Error(error.message);
  return data;
}

/** Move a brand to a different TL. Pass `apcId = null` to leave it
 *  unassigned; otherwise the APC must report to the new TL. */
export async function moveBrand(brandId, newTlId, apcId = null, note = null) {
  const { data, error } = await supabase.rpc('team_move_brand', {
    p_brand:   brandId,
    p_new_tl:  newTlId,
    p_new_apc: apcId,
    p_note:    note,
  });
  if (error) throw new Error(error.message);
  return data;
}

/** Move an IPC under a different PCTL. */
export async function moveIpcToPctl(ipcId, newPctlId) {
  const { data, error } = await supabase.rpc('team_move_ipc_to_pctl', {
    p_ipc:      ipcId,
    p_new_pctl: newPctlId,
  });
  if (error) throw new Error(error.message);
  return data;
}

/** Mark a brand inactive. Existing data stays; new tasks / campaigns /
 *  reports / products are blocked at the DB level. */
export async function deactivateBrand(brandId) {
  const { data, error } = await supabase.rpc('brand_deactivate', { p_brand: brandId });
  if (error) throw new Error(error.message);
  return data;
}

/** Reactivate a previously-deactivated brand. */
export async function reactivateBrand(brandId) {
  const { data, error } = await supabase.rpc('brand_reactivate', { p_brand: brandId });
  if (error) throw new Error(error.message);
  return data;
}

/** Hierarchy fetch — shape mirrors v1's TeamHierarchyPage data so the
 *  ported components keep working without their own translations.
 *  Returns { boss, ols, users (tl+pctl), teamUsers (apc+ipc as v1 shape),
 *  brands (with assignedUsers + ownerName) }.
 *
 *  v1 keyed each member's brands off teamUsers.assignedBrands; v2 stores
 *  the same relation in brand_assignments(user_id, brand_id). We rebuild
 *  the per-member brand list from that table so the org chart can render
 *  brand chips next to each APC/IPC.
 */
export async function fetchHierarchy() {
  const { data: profiles, error: profErr } = await supabase
    .from('profiles')
    .select('id, display_name, email, role, reports_to, is_active, deleted_at, avatar_url')
    .is('deleted_at', null)
    .eq('is_active', true);
  if (profErr) throw new Error(profErr.message);

  const { data: brands, error: brErr } = await supabase
    .from('brands')
    .select(`
      id, brand_name, status, owner_id,
      assignments:brand_assignments(user_id)
    `);
  if (brErr) throw new Error(brErr.message);

  // Index profiles by id for owner / member lookups.
  const byId = new Map((profiles || []).map((p) => [p.id, p]));

  // Reshape brands to the v1 shape.
  const v1Brands = (brands || []).map((b) => {
    const owner = b.owner_id ? byId.get(b.owner_id) : null;
    const assignedUsers = (b.assignments || [])
      .map((a) => byId.get(a.user_id))
      .filter(Boolean)
      .map((p) => ({ id: p.id, userName: p.display_name, email: p.email, userType: p.role }));
    return {
      id:         b.id,
      brandName:  b.brand_name,
      brandLabel: b.brand_name,
      status:     b.status,
      ownerId:    b.owner_id,
      ownerName:  owner?.display_name || '',
      assignedUsers,
    };
  });

  // teamUsers = APCs + IPCs, with assignedBrands derived from
  // brand_assignments. v1 also kept ownerId here, so include it.
  const teamUsers = (profiles || [])
    .filter((p) => p.role === 'apc' || p.role === 'ipc')
    .map((p) => {
      const assignedBrands = v1Brands
        .filter((b) => b.assignedUsers.some((au) => au.id === p.id))
        .map((b) => ({ id: b.id, brandName: b.brandName }));
      const owner = p.reports_to ? byId.get(p.reports_to) : null;
      return {
        id: p.id,
        userName: p.display_name,
        email: p.email,
        userType: p.role,
        ownerId: p.reports_to,
        ownerName: owner?.display_name || '',
        assignedBrands,
      };
    });

  // users = boss + ol + tl + pctl, mapped to v1's {id, displayName, email, role}.
  const users = (profiles || [])
    .filter((p) => ['boss', 'ol', 'tl', 'pctl'].includes(p.role))
    .map((p) => ({
      id: p.id,
      displayName: p.display_name,
      email: p.email,
      role: p.role,
      avatar_url: p.avatar_url,
    }));

  return { users, teamUsers, brands: v1Brands };
}

/** Roster fetch — every TL/PCTL with their direct reports + brands.
 *  Built from a single big select with joins; the page splits by role. */
export async function fetchTeamRoster() {
  // 1. Pull all active profiles (we'll group client-side by role/reports_to).
  const { data: profiles, error: profErr } = await supabase
    .from('profiles')
    .select('id, display_name, email, role, reports_to, is_active, deleted_at')
    .is('deleted_at', null)
    .eq('is_active', true);
  if (profErr) throw new Error(profErr.message);

  // 2. Pull all brands with owner + assignee references.
  const { data: brands, error: brErr } = await supabase
    .from('brands')
    .select(`
      id, brand_name, status, tier, gmv, owner_id,
      assignments:brand_assignments(user_id)
    `);
  if (brErr) throw new Error(brErr.message);

  return {
    profiles: profiles || [],
    brands: (brands || []).map((b) => ({
      ...b,
      assigneeIds: (b.assignments || []).map((a) => a.user_id),
    })),
  };
}
