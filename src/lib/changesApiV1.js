// v1-compat layer for the Change Management module.
//
// v1 stored:
//   /changes/{id}                  ← top-level (with subcollection thread)
//   /changes/{id}/thread/{msgId}   ← discussion thread per change
//   /sopVersions/{sopType}         ← SOP version map
//   /knowledgeBase/{id}            ← KB articles (referenced as "affected SOPs")
//
// v2 has:
//   public.changes                  (mig 076)
//   public.change_thread            (mig 076 — flat table, change_id FK)
//   public.kb_articles              (used as "affected KB" picker)
//   No sopVersions table — versions live on kb_articles.version per article;
//   we synthesize a per-sop_type "current version" by latest article in
//   that category.
//
// This shim normalizes v2 rows so the v1 markup keeps working unchanged.

import { supabase } from './supabase';

// --- Firestore Timestamp shim --------------------------------------
// v1 markup reads `ts.toDate()` and `ts.seconds`.
function tsShim(input) {
  if (input == null) return null;
  const d = input instanceof Date ? input : new Date(input);
  if (isNaN(d.getTime())) return null;
  return {
    toDate: () => d,
    seconds: Math.floor(d.getTime() / 1000),
    nanoseconds: 0,
  };
}

// --- Row normalizer ------------------------------------------------
function _normChange(row) {
  if (!row) return row;
  return {
    ...row,
    // v1 ID alias — markup reads `c.changeId` (the human code, not UUID)
    id: row.id,
    changeId: row.change_code || row.id,
    title: row.title || '',
    sopType: row.sop_type || '',
    sopTypeLabel: '',  // populated client-side from SOP_TYPES const
    currentVersion: row.current_version || '',
    currentProcess: row.current_process || '',
    proposedChange: row.proposed_change || '',
    expectedImpact: row.expected_impact || '',
    risks: row.risks || '',
    ownerId: row.owner_id || null,
    ownerName: row.owner_name || '',
    priority: row.priority || null,
    affectedSopIds: row.affected_kb_ids || [],
    affectedSopNames: row.affected_kb_titles || [],
    submittedBy: row.submitted_by || null,
    submittedByName: row.submitted_by_name || '',
    submittedByRole: row.submitted_by_role || '',
    dateSubmitted: tsShim(row.created_at),
    status: row.status || 'pending',
    approvedBy: row.approved_by_name || null,
    approvalDate: tsShim(row.approval_date),
    newVersion: row.new_version || '',
    implementationStart: tsShim(row.implementation_start),
    implementationEnd: tsShim(row.implementation_end),
    bossComment: row.boss_comment || '',
    rejectionReason: row.rejection_reason || '',
    completedAt: tsShim(row.completed_at),
    implementedAt: tsShim(row.implemented_at),
    // logSheetUrl is v1-only — v2 uses a hard-coded LOG_URL constant
    logSheetUrl: '',
  };
}

function _normThreadMsg(row) {
  if (!row) return row;
  return {
    id: row.id,
    userId: row.user_id,
    userName: row.user_name || '',
    userRole: row.user_role || '',
    type: row.type || 'message',
    text: row.text || '',
    createdAt: tsShim(row.created_at),
  };
}

// --- Reads ---------------------------------------------------------

// v1 used onSnapshot. We wrap a Realtime channel.
export function subscribeAllChanges(onRows, onError) {
  let cancelled = false;
  let channel = null;

  const refresh = async () => {
    try {
      const { data, error } = await supabase
        .from('changes')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(500);
      if (error) throw new Error(error.message);
      if (!cancelled) onRows((data || []).map(_normChange));
    } catch (e) {
      if (!cancelled && onError) onError(e);
    }
  };
  refresh();

  channel = supabase
    .channel(`changes-all-${Math.random().toString(36).slice(2, 8)}`)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'changes' }, refresh)
    .subscribe();

  return () => {
    cancelled = true;
    if (channel) supabase.removeChannel(channel);
  };
}

export function subscribeChangeThread(changeId, onMessages) {
  let cancelled = false;
  let channel = null;

  const refresh = async () => {
    const { data } = await supabase
      .from('change_thread')
      .select('*')
      .eq('change_id', changeId)
      .order('created_at', { ascending: true });
    if (!cancelled) onMessages((data || []).map(_normThreadMsg));
  };
  refresh();

  channel = supabase
    .channel(`change-thread-${changeId}`)
    .on('postgres_changes',
      { event: '*', schema: 'public', table: 'change_thread', filter: `change_id=eq.${changeId}` },
      refresh)
    .subscribe();

  return () => {
    cancelled = true;
    if (channel) supabase.removeChannel(channel);
  };
}

// All active users for owner picker / participant list. v1 markup
// expected: [{ id, name, role }] where role is the human label
// ('Boss', 'Team Lead', 'Op Lead', 'PCTL', 'APC', etc.).
export async function listAllUsersForChanges() {
  const { data, error } = await supabase
    .from('profiles')
    .select('id, display_name, email, role, is_active, deleted_at')
    .eq('is_active', true)
    .is('deleted_at', null)
    .in('role', ['boss', 'tl', 'ol', 'pctl', 'apc', 'ipc'])
    .order('display_name');
  if (error) throw new Error(error.message);
  const ROLE_LABELS = { boss: 'Boss', tl: 'Team Lead', ol: 'Op Lead', pctl: 'PCTL', apc: 'APC', ipc: 'IPC' };
  return (data || []).map((p) => ({
    id: p.id,
    name: p.display_name || p.email?.split('@')[0] || 'User',
    role: ROLE_LABELS[p.role] || p.role,
  }));
}

// SOP versions — v2 doesn't have a dedicated table; synthesize from
// kb_articles by category. Returns { sopType: 'v1.0' | ... }. For now
// we just return 'v1.0' for every type since v1 didn't surface this
// per-doc — it was a single shop-wide version.
export async function listSopVersions() {
  // Fixed map — v2 doesn't model per-SOP-type versions yet; v1 did.
  // This keeps the v1 markup happy ("Current version: v1.0").
  return {
    delivery_roadmap: 'v1.0',
    policies:         'v1.0',
    operational:      'v1.0',
    training:         'v1.0',
  };
}

// SOP docs (KB articles) for the "Affected SOPs" picker.
// v1 expected each doc to have a `tab` field matching the SOP_TAB_MAP
// constant in ChangeManagementPage.js: delivery_roadmap, policies,
// operational_sops, training_sops. v2's kb_articles table has a
// `category` column with same values.
export async function listSopDocs() {
  const { data, error } = await supabase
    .from('kb_articles')
    .select('id, title, category, version')
    .in('category', ['delivery_roadmap', 'operational_sops', 'training_sops', 'policies'])
    .order('title');
  if (error) throw new Error(error.message);
  // Expose v1's `tab` alias so the existing markup works
  return (data || []).map((d) => ({
    id: d.id,
    title: d.title || '(untitled)',
    tab: d.category,
    version: d.version || 'v1.0',
  }));
}

// --- Writes (camelCase v1 payloads) --------------------------------

// Create a new change request. v1 payload keys → v2 columns.
export async function submitChangeV1(payload) {
  const { data: me } = await supabase.auth.getUser();
  const uid = me?.user?.id;
  if (!uid) throw new Error('Not signed in');
  const { data: profile } = await supabase
    .from('profiles').select('display_name, role').eq('id', uid).maybeSingle();

  // v1 wrote a `bossComment` etc. immediately as null — v2 just
  // omits and the column NULLs by default.
  const insertable = {
    title:              (payload.title || '').trim(),
    sop_type:           payload.sopType || null,
    current_version:    payload.currentVersion || null,
    current_process:    (payload.currentProcess || '').trim(),
    proposed_change:    (payload.proposedChange || '').trim(),
    expected_impact:    (payload.expectedImpact || '').trim() || null,
    risks:              (payload.risks || '').trim() || null,
    owner_id:           payload.ownerId,
    owner_name:         payload.ownerName || null,
    priority:           payload.priority || null,
    affected_kb_ids:    payload.affectedSopIds || [],
    affected_kb_titles: payload.affectedSopNames || [],
    submitted_by:       uid,
    submitted_by_name:  profile?.display_name || null,
    submitted_by_role:  profile?.role || null,
  };
  // Boss-submitted requests skip the queue (mig 107)
  if (profile?.role === 'boss') {
    insertable.status = 'approved';
    insertable.approved_by = uid;
    insertable.approved_by_name = profile?.display_name || null;
    insertable.approval_date = new Date().toISOString();
  }
  const { data, error } = await supabase
    .from('changes').insert(insertable).select().single();
  if (error) throw new Error(error.message);
  return _normChange(data);
}

// Update a change. v1 payload uses camelCase keys; map known ones.
export async function updateChangeV1(id, payload) {
  const row = {};
  if ('status'              in payload) row.status              = payload.status;
  if ('newVersion'          in payload) row.new_version         = payload.newVersion;
  if ('approvedBy'          in payload) row.approved_by_name    = payload.approvedBy;
  if ('approvalDate'        in payload) row.approval_date       = payload.approvalDate ?? null;
  if ('implementationStart' in payload) row.implementation_start = payload.implementationStart ?? null;
  if ('implementationEnd'   in payload) row.implementation_end  = payload.implementationEnd ?? null;
  if ('bossComment'         in payload) row.boss_comment        = payload.bossComment ?? null;
  if ('rejectionReason'     in payload) row.rejection_reason    = payload.rejectionReason ?? null;
  if ('completedAt'         in payload) row.completed_at        = payload.completedAt ?? null;
  if ('implementedAt'       in payload) row.implemented_at      = payload.implementedAt ?? null;
  // catch-all for snake_case keys passed directly
  for (const [k, v] of Object.entries(payload)) {
    if (k.includes('_') && !(k in row)) row[k] = v;
  }
  const { data, error } = await supabase
    .from('changes').update(row).eq('id', id).select().single();
  if (error) throw new Error(error.message);
  return _normChange(data);
}

// Boss action: approve/reject/implement via direct status update +
// optional metadata. v1 had separate handlers; we reuse updateChangeV1.
export async function postChangeMessageV1(changeDocId, text, opts = {}) {
  const { data: me } = await supabase.auth.getUser();
  const uid = me?.user?.id;
  if (!uid) throw new Error('Not signed in');
  const { data: profile } = await supabase
    .from('profiles').select('display_name, role').eq('id', uid).maybeSingle();

  const insertable = {
    change_id: changeDocId,
    user_id:   uid,
    user_name: profile?.display_name || null,
    user_role: opts.userRole || profile?.role || null,
    type:      opts.type || 'message',
    text:      (text || '').trim(),
  };
  const { data, error } = await supabase
    .from('change_thread').insert(insertable).select().single();
  if (error) throw new Error(error.message);
  return _normThreadMsg(data);
}

// Boss-only — fetch all participants for thread (submitter + owner +
// boss). v1 derived this client-side; we mirror that.
export async function listChangeParticipants(change) {
  const ids = new Set();
  if (change.submittedBy || change.submitted_by) ids.add(change.submittedBy || change.submitted_by);
  if (change.ownerId || change.owner_id)        ids.add(change.ownerId || change.owner_id);
  // Pull all bosses
  const { data: bosses } = await supabase
    .from('profiles')
    .select('id, display_name, role')
    .eq('is_active', true)
    .eq('role', 'boss');
  (bosses || []).forEach((b) => ids.add(b.id));

  if (ids.size === 0) return [];
  const { data, error } = await supabase
    .from('profiles')
    .select('id, display_name, role')
    .in('id', Array.from(ids));
  if (error) throw new Error(error.message);
  return (data || []).map((p) => ({
    id: p.id,
    name: p.display_name || '?',
    role: p.role,
    roleLabel: p.role === 'boss' ? 'Boss'
      : (p.id === (change.ownerId || change.owner_id)) ? 'Owner'
      : 'Requester',
  }));
}
