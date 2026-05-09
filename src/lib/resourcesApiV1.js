// v1-compat layer for the Resources module.
//
// v1 stored two collections:
//   /brands/{brandId}/resources/{id}     ← brand-scoped
//   /resources/{id}                       ← general (with visibility)
//
// v2 has a single `resources` table where brand_id IS NULL means a
// general resource. This shim normalizes v2 rows so the v1 markup
// (which expects camelCase + Firestore Timestamp shape) keeps working.
//
// Server-side `resources_notify` trigger handles fan-out: insert/update
// with `notify=true` notifies brand viewers (brand-scope), the target
// user (general user), or the role group members (general group).

import { supabase } from './supabase';
import {
  detectSource, detectType, thumbnailFor, getYouTubeThumbnail,
} from './resourcesApi';

// Re-export so v1-port files can import from one place
export { detectSource, detectType, thumbnailFor, getYouTubeThumbnail };

// --- Firestore Timestamp shim --------------------------------------
// v1 markup reads `r.createdAt.seconds` directly. Wrap the v2 timestamp
// so those reads keep working.
function tsShim(input) {
  if (input == null) return null;
  const d = input instanceof Date ? input : new Date(input);
  if (isNaN(d.getTime())) return null;
  const ms = d.getTime();
  return {
    toDate: () => d,
    seconds: Math.floor(ms / 1000),
    nanoseconds: 0,
  };
}

// --- Row normalizer ------------------------------------------------
function _normResource(row, brandsById = null) {
  if (!row) return row;
  const isGeneral = !row.brand_id;
  // brand info — prefer joined `brand` (when listResources joins it),
  // fall back to brandsById map (when caller passes a brand cache).
  const brand = row.brand || (row.brand_id && brandsById ? brandsById.get(row.brand_id) : null);
  const brandName = isGeneral ? 'General' : (brand?.brand_name || brand?.brandName || '');
  const creator = row.creator || null;
  return {
    id: row.id,
    type: row.type,
    name: row.name || '',
    url: row.url || '',
    description: row.description || '',
    visibility: row.visibility || (isGeneral ? 'private' : null),
    visibleToUid: row.visible_to_uid || null,
    visibleToRoles: Array.isArray(row.visible_to_roles) ? row.visible_to_roles : [],
    brandId: row.brand_id || null,
    brandName,
    _scope: isGeneral ? 'general' : 'brand',
    // Authorship
    createdBy: row.created_by || null,
    createdByName: creator?.display_name || row.created_by_name || '',
    createdByRole: creator?.role || null,
    addedBy: { uid: row.created_by || null, name: creator?.display_name || row.created_by_name || '' },
    // Timestamp shim
    createdAt: tsShim(row.created_at),
    updatedAt: tsShim(row.updated_at),
  };
}

// --- Reads ---------------------------------------------------------
const SELECT_COLS = `
  *,
  brand:brand_id(id, brand_name, logo_url, owner_id),
  creator:created_by(id, display_name, role)
`;

/**
 * Returns all resources visible to the caller — brand-scoped + general
 * combined, normalized to v1 shape. RLS on the `resources` table does
 * the actual visibility filter; this just shapes the rows.
 */
export async function listAllResourcesV1() {
  const { data, error } = await supabase
    .from('resources')
    .select(SELECT_COLS)
    .order('created_at', { ascending: false });
  if (error) throw new Error(error.message);
  return (data || []).map((r) => _normResource(r));
}

/**
 * v1 had a separate "all users" pull for the share-with-user picker.
 * RLS limits this to active profiles; v1's modal expected
 *   [{ id, name, role }, ...].
 */
export async function listAllUsersV1() {
  const { data, error } = await supabase
    .from('profiles')
    .select('id, display_name, email, role, is_active, deleted_at')
    .eq('is_active', true)
    .is('deleted_at', null)
    .order('display_name');
  if (error) throw new Error(error.message);
  return (data || []).map((p) => ({
    id: p.id,
    name: p.display_name || p.email?.split('@')[0] || 'User',
    role: p.role || 'apc',
  }));
}

// --- Writes (camelCase v1 payloads) --------------------------------

export async function addResourceV1(payload) {
  const me = (await supabase.auth.getUser()).data?.user;
  const detected = detectSource(payload.url || '');
  const row = {
    brand_id:         payload.brandId || null,
    type:             payload.type || detected.type,
    name:             (payload.name || '').trim(),
    url:              (payload.url || '').trim(),
    description:      (payload.description || '').trim(),
    visibility:       payload.visibility || (payload.brandId ? 'office' : 'private'),
    visible_to_uid:   payload.visibility === 'user'  ? (payload.visibleToUid || null) : null,
    visible_to_roles: payload.visibility === 'group' ? (payload.visibleToRoles || []) : [],
    created_by:       me?.id,
    notify:           !!payload.notifyInApp,
  };
  const { data, error } = await supabase
    .from('resources').insert(row).select(SELECT_COLS).single();
  if (error) throw new Error(error.message);
  return _normResource(data);
}

export async function updateResourceV1(id, payload) {
  const detected = payload.url ? detectSource(payload.url) : null;
  const row = { notify: !!payload.notifyInApp };
  if ('name' in payload)        row.name        = (payload.name || '').trim();
  if ('url' in payload)         row.url         = (payload.url || '').trim();
  if ('description' in payload) row.description = (payload.description || '').trim();
  if ('type' in payload)        row.type        = payload.type;
  else if (detected)            row.type        = detected.type;
  if ('brandId' in payload)     row.brand_id    = payload.brandId || null;
  if ('visibility' in payload) {
    row.visibility       = payload.visibility;
    row.visible_to_uid   = payload.visibility === 'user'  ? (payload.visibleToUid || null) : null;
    row.visible_to_roles = payload.visibility === 'group' ? (payload.visibleToRoles || []) : [];
  }
  const { data, error } = await supabase
    .from('resources').update(row).eq('id', id).select(SELECT_COLS).single();
  if (error) throw new Error(error.message);
  return _normResource(data);
}

export async function deleteResourceV1(id) {
  const { error } = await supabase.from('resources').delete().eq('id', id);
  if (error) throw new Error(error.message);
}
