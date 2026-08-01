// ============================================================
// Creator Library — data access.
//
// Creator DATA comes from ONE shared published Google Sheet (columns: Tiktok
// Handle, Name, Brand, Status, Paypal details, Discord), read server-side by the
// `creator-sheet` edge function. The OS OWNS the approval STATUS: a creator per
// (brand, handle) is pending → TL-approved → OL-approved (stored in
// creator_approvals, mig 282). Brand scoping reuses the reporting brand list
// (OL/PCTL/Boss = all, owner TL = own, assigned IPC = assigned).
// ============================================================
import { supabase } from './supabase';
import { listBrandsForReporting } from './reportsApi';

// Normalise a TikTok handle for matching sheet rows ↔ approval rows: lower-case,
// trim, drop a leading '@'. Must mirror creator_set_approval's normalisation.
export function normHandle(h) {
  return String(h ?? '').trim().replace(/^@+/, '').toLowerCase();
}

// The derived status of a merged creator row. OL is the top level, so its
// decision wins over the TL's.
export function creatorStatus(appr) {
  if (appr?.ol_approved_by) return 'ol';
  if (appr?.ol_rejected_by) return 'rejected';
  if (appr?.tl_approved_by) return 'tl';
  if (appr?.tl_rejected_by) return 'rejected';
  return 'pending';
}
export const STATUS_LABEL = {
  pending: 'Pending',
  tl: 'Approved by Team Lead',
  ol: 'Approved by Operation Lead',
  rejected: 'Rejected',
};

// The plain-text status written back to the sheet's "Status" column (when a
// write-back webhook is configured). Mirrors the derived status above.
export function sheetStatusText(appr) {
  const s = creatorStatus(appr);
  if (s === 'ol') return 'Approved by Operation Lead';
  if (s === 'tl') return 'Approved by Team Lead';
  if (s === 'rejected') {
    return appr?.ol_rejected_by ? 'Rejected by Operation Lead' : 'Rejected by Team Lead';
  }
  return 'Pending';
}

// ── the published sheet ──────────────────────────────────────────────────────
export async function fetchCreatorSheet() {
  const { data, error } = await supabase.functions.invoke('creator-sheet', { body: {} });
  if (error) throw new Error(error.message || 'Failed to load the creator sheet.');
  if (data?.error) throw new Error(data.error);
  return data; // { headers, rows, fetchedAt }
}

// ── sheet config (Boss/OL): published CSV url + live Apps Script webhook ──────
export async function getSheetConfig() {
  const { data, error } = await supabase
    .from('creator_library_config')
    .select('sheet_url, sheet_webhook_url, sheet_webhook_secret, updated_at')
    .eq('id', 1).maybeSingle();
  if (error) throw new Error(error.message);
  return data || { sheet_url: '', sheet_webhook_url: '', sheet_webhook_secret: '' };
}
export async function saveSheetConfig({ sheetUrl, webhookUrl, webhookSecret }) {
  const { data: me } = await supabase.auth.getUser();
  const patch = { updated_by: me?.user?.id ?? null, updated_at: new Date().toISOString() };
  if (sheetUrl !== undefined)      patch.sheet_url = (sheetUrl || '').trim() || null;
  if (webhookUrl !== undefined)    patch.sheet_webhook_url = (webhookUrl || '').trim() || null;
  if (webhookSecret !== undefined) patch.sheet_webhook_secret = (webhookSecret || '').trim() || null;
  const { error } = await supabase.from('creator_library_config').update(patch).eq('id', 1);
  if (error) throw new Error(error.message);
}

// Mirror the OS approval state into the sheet's Status/Notes columns (best-effort;
// the OS remains authoritative). No-op server-side if no webhook is configured.
export async function writeSheetStatus({ brandId, handle, note }) {
  const { data, error } = await supabase.functions.invoke('creator-sheet', {
    body: { action: 'write', brandId, handle, note: (note || '').trim() || null },
  });
  if (error) throw new Error(error.message || 'Sheet write failed.');
  if (data?.error) throw new Error(data.error);
  return data; // { ok, status, skipped? }
}

// ── accessible brands (same scoping as reporting) ────────────────────────────
export async function listCreatorBrands({ role, uid, permissions } = {}) {
  const rows = await listBrandsForReporting({ role, uid, permissions });
  // Normalise to { id, name, ownerId } and a lower-cased name for sheet matching.
  return (rows || []).map((b) => ({
    id: b.id,
    name: b.brand_name || b.name || '',
    ownerId: b.owner_id || b.ownerId || null,
    matchKey: String(b.brand_name || b.name || '').trim().toLowerCase(),
  }));
}

// ── approvals ────────────────────────────────────────────────────────────────
// { `${brandId}|${normHandle}` : approvalRow } for the given brand ids.
export async function listApprovals(brandIds) {
  if (!brandIds?.length) return {};
  const { data, error } = await supabase
    .from('creator_approvals')
    .select('brand_id, tiktok_handle, tl_approved_by, tl_approved_at, tl_rejected_by, tl_rejected_at, tl_note, ol_approved_by, ol_approved_at, ol_rejected_by, ol_rejected_at, ol_note, updated_at, tl:tl_approved_by(display_name), ol:ol_approved_by(display_name), tlr:tl_rejected_by(display_name), olr:ol_rejected_by(display_name)')
    .in('brand_id', brandIds);
  if (error) throw new Error(error.message);
  const m = {};
  for (const r of data || []) m[`${r.brand_id}|${normHandle(r.tiktok_handle)}`] = r;
  return m;
}

// decision ∈ 'approve' | 'reject' | 'clear'; note is optional free text.
export async function setApproval({ brandId, handle, level, decision, note }) {
  const { data, error } = await supabase.rpc('creator_set_approval', {
    p_brand: brandId, p_handle: handle, p_level: level,
    p_decision: decision, p_note: (note || '').trim() || null,
  });
  if (error) throw new Error(error.message);
  return data;
}

export async function notifyPending({ brandId, message }) {
  const { data, error } = await supabase.rpc('creator_notify_pending', {
    p_brand: brandId, p_message: (message || '').trim() || null,
  });
  if (error) throw new Error(error.message);
  return data; // number of people notified
}
