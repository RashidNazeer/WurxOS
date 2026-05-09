/**
 * Resource visibility helpers — v1 verbatim port.
 *
 * Brand resources live with brand_id != NULL — visible to the brand's
 * owner (TL), assigned APCs/IPCs, Boss, and OL (RLS handles this).
 *
 * General resources live with brand_id = NULL and a `visibility` field:
 *
 *   visibility: 'private'        → only the creator
 *              | 'office'         → everyone in the company
 *              | 'group'          → creator + users with roles in `visibleToRoles`
 *              | 'user'           → creator + a specific user (`visibleToUid`)
 *
 * Additional rules:
 *  - Boss and OL can see ALL non-private general resources.
 *  - The creator always sees their own resources regardless of visibility.
 */

export const VISIBILITY_OPTIONS = {
  private: { label: 'Private (only me)',              icon: 'bi-person-fill-lock', color: '#6c757d' },
  user:    { label: 'Specific person',                icon: 'bi-person-fill',       color: '#0d6efd' },
  group:   { label: 'Group (select roles)',           icon: 'bi-people-fill',       color: '#6610f2' },
  office:  { label: 'Whole office (everyone)',        icon: 'bi-building',          color: '#198754' },
};

export const VISIBILITY_GROUP_ROLE_OPTIONS = {
  tl:   { label: 'Team Leads',        color: '#0d6efd' },
  ol:   { label: 'Operation Leads',   color: '#8b5cf6' },
  pctl: { label: 'Paid Collab TLs',   color: '#2563eb' },
  apc:  { label: 'APCs',              color: '#10b981' },
  ipc:  { label: 'IPCs',              color: '#06b6d4' },
  boss: { label: 'Boss',              color: '#f59e0b' },
};

/**
 * Check whether a given user can see a general resource. v2 enforces
 * this server-side via RLS, but the v1 markup also runs this client-
 * side as a defense-in-depth guard.
 */
export function canUserSeeGeneralResource(resource, { uid, role }) {
  if (!resource) return false;
  if (resource.createdBy === uid) return true;

  const v = resource.visibility;

  // Private means private — even Boss/OL cannot see it
  if (v === 'private') return false;

  // Boss and OL can see any non-private general resource
  if (role === 'boss' || role === 'ol') return true;

  if (v === 'office') return true;
  if (v === 'user') return resource.visibleToUid === uid;
  if (v === 'group') return Array.isArray(resource.visibleToRoles) && resource.visibleToRoles.includes(role);
  return false;
}

/**
 * Visibility options the user is allowed to pick when creating a
 * general resource.
 */
export function allowedVisibilitiesForRole(role) {
  if (role === 'boss' || role === 'ol' || role === 'developer') return ['private', 'user', 'group', 'office'];
  if (role === 'tl' || role === 'pctl') return ['private', 'user', 'group'];
  if (role === 'apc' || role === 'ipc') return ['private'];
  return ['private'];
}

/**
 * Role groups a given creator can target for 'group' visibility.
 */
export function allowedGroupTargetsForRole(role) {
  if (role === 'boss' || role === 'ol' || role === 'developer') {
    return ['tl', 'ol', 'pctl', 'apc', 'ipc'];
  }
  if (role === 'tl' || role === 'pctl') {
    return ['tl', 'ol', 'pctl', 'apc', 'ipc', 'boss'];
  }
  return [];
}
