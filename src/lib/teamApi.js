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

/** Add a Team Lead to an APC/IPC without moving them off their current ones.
 *  Boss/OL only. The primary stays profiles.reports_to; this adds a second team. */
export async function addApcTl(apcId, tlId) {
  const { error } = await supabase.rpc('add_apc_tl', { p_apc: apcId, p_tl: tlId });
  if (error) throw new Error(error.message);
}

/** Take an APC off one of their additional Team Leads. The server refuses the
 *  primary TL, and any TL whose live brand the APC still holds. */
export async function removeApcTl(apcId, tlId) {
  const { error } = await supabase.rpc('remove_apc_tl', { p_apc: apcId, p_tl: tlId });
  if (error) throw new Error(error.message);
}

/** apc_id -> [tl_id] for every team an APC/IPC works under (primary included). */
async function fetchTeamLeadLinks() {
  const { data, error } = await supabase.from('apc_team_leads').select('apc_id, tl_id');
  if (error) throw new Error(error.message);
  const byApc = new Map();
  for (const l of data || []) {
    if (!byApc.has(l.apc_id)) byApc.set(l.apc_id, []);
    byApc.get(l.apc_id).push(l.tl_id);
  }
  return byApc;
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
 *  Returns { boss, ols, users (tl+pctl+developer leads), teamUsers
 *  (apc+ipc+junior developers as v1 shape), brands (with assignedUsers +
 *  ownerName) }.
 *
 *  v1 keyed each member's brands off teamUsers.assignedBrands; v2 stores
 *  the same relation in brand_assignments(user_id, brand_id). We rebuild
 *  the per-member brand list from that table so the org chart can render
 *  brand chips next to each APC/IPC.
 *
 *  Developers have no separate "lead" role (unlike tl/pctl vs apc/ipc) —
 *  everyone is role='developer', distinguished only by who reports_to
 *  whom (mig 398). So "lead" here is STRUCTURAL, not role-based: a
 *  developer counts as a lead the moment another developer reports to
 *  them, exactly mirroring how a TL card exists whether or not it has
 *  APCs yet. A developer with neither a manager nor a report (a lone
 *  developer, pre-team) simply doesn't appear on this chart — same as
 *  how the chart has never had anything to show for a role with zero
 *  members on either side.
 */
export async function fetchHierarchy() {
  const { data: profiles, error: profErr } = await supabase
    .from('profiles')
    .select('id, display_name, email, role, reports_to, is_active, deleted_at, avatar_url, responsibilities')
    .is('deleted_at', null)
    .eq('is_active', true);
  if (profErr) throw new Error(profErr.message);

  const devLeadIds = new Set(
    (profiles || [])
      .filter((p) => p.role === 'developer' && p.reports_to)
      .map((p) => p.reports_to),
  );

  const { data: brands, error: brErr } = await supabase
    .from('brands')
    .select(`
      id, brand_name, status, owner_id,
      assignments:brand_assignments(user_id)
    `);
  if (brErr) throw new Error(brErr.message);
  const linksByApc = await fetchTeamLeadLinks();

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

  // teamUsers = APCs + IPCs + junior developers (reports_to another
  // developer), with assignedBrands derived from brand_assignments — always
  // empty for developers, who have none. v1 also kept ownerId here, so
  // include it.
  const teamUsers = (profiles || [])
    .filter((p) => p.role === 'apc' || p.role === 'ipc'
      || (p.role === 'developer' && p.reports_to && devLeadIds.has(p.reports_to)))
    .map((p) => {
      // Active brands only. An inactive brand is a client we no longer work
      // for, so listing it under a person overstates their book and makes the
      // org chart look busier than the team really is (Owner, 2026-10-12).
      // The full list is still returned below for the totals.
      const assignedBrands = v1Brands
        .filter((b) => b.status !== 'inactive' && b.assignedUsers.some((au) => au.id === p.id))
        .map((b) => ({ id: b.id, brandName: b.brandName }));
      const owner = p.reports_to ? byId.get(p.reports_to) : null;
      return {
        id: p.id,
        userName: p.display_name,
        email: p.email,
        userType: p.role,
        avatar_url: p.avatar_url,
        ownerId: p.reports_to,
        ownerName: owner?.display_name || '',
        // Every team this person works under, primary included. ownerId stays
        // the primary: org-chart grouping uses teamLeadIds, everything that
        // asks "who is their manager" keeps using ownerId.
        teamLeadIds: linksByApc.get(p.id) || (p.reports_to ? [p.reports_to] : []),
        responsibilities: p.responsibilities || [],
        assignedBrands,
      };
    });

  // users = boss + ol + tl + pctl + developer LEADS (structural — see the
  // fetchHierarchy doc comment), mapped to v1's {id, displayName, email, role}.
  const users = (profiles || [])
    .filter((p) => ['boss', 'ol', 'tl', 'pctl'].includes(p.role) || devLeadIds.has(p.id))
    .map((p) => ({
      id: p.id,
      displayName: p.display_name,
      email: p.email,
      role: p.role,
      avatar_url: p.avatar_url,
      responsibilities: p.responsibilities || [],
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
  const linksByApc = await fetchTeamLeadLinks();

  return {
    profiles: (profiles || []).map((p) => ({ ...p, team_lead_ids: linksByApc.get(p.id) || [] })),
    brands: (brands || []).map((b) => ({
      ...b,
      assigneeIds: (b.assignments || []).map((a) => a.user_id),
    })),
  };
}
