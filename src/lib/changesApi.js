import { supabase } from './supabase';

export const SOP_TYPES = [
  { key: 'delivery_roadmap', label: 'Delivery Roadmap', color: '#0ea5e9' },
  { key: 'policies',         label: 'Policies',         color: '#2563eb' },
  { key: 'operational',      label: 'Operational SOPs', color: '#7c3aed' },
  { key: 'training',         label: 'Training SOPs',    color: '#059669' },
];

export const CHANGE_STATUSES = [
  { key: 'pending',     label: 'Pending Review', fg: '#92400e', bg: '#fff3e0' },
  { key: 'approved',    label: 'Approved',       fg: '#166534', bg: '#ecfdf5' },
  { key: 'rejected',    label: 'Rejected',       fg: '#991b1b', bg: '#fef2f2' },
  { key: 'in_progress', label: 'In Progress',    fg: '#1e40af', bg: '#dbeafe' },
  { key: 'paused',      label: 'Paused',         fg: '#92400e', bg: '#fffbeb' },
  { key: 'delayed',     label: 'Delayed',        fg: '#991b1b', bg: '#fee2e2' },
  { key: 'completed',   label: 'Completed',      fg: '#5b21b6', bg: '#f5f3ff' },
  { key: 'implemented', label: 'Implemented',    fg: '#14532d', bg: '#dcfce7' },
];

export const CHANGE_PRIORITIES = [
  { key: 'low',    label: 'Low',    fg: '#4b5563', bg: '#f3f4f6' },
  { key: 'medium', label: 'Medium', fg: '#92400e', bg: '#fff3e0' },
  { key: 'high',   label: 'High',   fg: '#991b1b', bg: '#fee2e2' },
];

export const sopTypeMeta        = (k) => SOP_TYPES.find((x) => x.key === k) || { key: k, label: k, color: '#64748b' };
export const changeStatusMeta   = (k) => CHANGE_STATUSES.find((x) => x.key === k) || CHANGE_STATUSES[0];
export const changePriorityMeta = (k) => CHANGE_PRIORITIES.find((x) => x.key === k) || null;

// Owner-facing legal transitions (while approved). Boss can move to
// anything; the UI gates boss transitions through the ReviewModal.
export const OWNER_TRANSITIONS = {
  approved:    ['in_progress', 'paused', 'delayed'],
  in_progress: ['paused', 'delayed', 'completed'],
  paused:      ['in_progress', 'delayed', 'completed'],
  delayed:     ['in_progress', 'paused', 'completed'],
};

// --------------------------------------------------------------
// Queries
// --------------------------------------------------------------
export async function listChanges({ status, sopType, q, scope = 'all' } = {}) {
  const { data: me } = await supabase.auth.getUser();
  const uid = me?.user?.id;

  let query = supabase.from('changes').select('*');

  if (scope === 'mine' && uid)      query = query.eq('submitted_by', uid);
  if (scope === 'assigned' && uid)  query = query.eq('owner_id', uid);
  if (status && status !== 'all')   query = query.eq('status', status);
  if (sopType && sopType !== 'all') query = query.eq('sop_type', sopType);
  if (q) {
    const qq = q.replace(/%/g, '').trim();
    if (qq) query = query.or(`title.ilike.%${qq}%,change_code.ilike.%${qq}%`);
  }
  query = query.order('created_at', { ascending: false });

  const { data, error } = await query;
  if (error) throw new Error(error.message);
  return data || [];
}

export async function getChange(id) {
  const { data, error } = await supabase.from('changes').select('*').eq('id', id).maybeSingle();
  if (error) throw new Error(error.message);
  return data;
}

// --------------------------------------------------------------
// Owner picker — we list everyone who can legitimately be assigned
// (tl/ol/pctl/apc/ipc + boss). Active only.
// --------------------------------------------------------------
export async function listPotentialOwners() {
  const { data, error } = await supabase
    .from('profiles')
    .select('id, display_name, role, email')
    .eq('is_active', true)
    .in('role', ['tl','ol','pctl','apc','ipc','boss'])
    .order('display_name');
  if (error) throw new Error(error.message);
  return data || [];
}

// KB articles affected by a change (filtered by sop_type → kb category).
// The mapping is convention-based; we don't have a structured sop_type
// column on kb_articles in v2, so we pass sopType through as a category
// hint and the UI can browse/pick freely.
export async function listKbForPicker() {
  const { data, error } = await supabase
    .from('kb_articles')
    .select('id, title, category')
    .order('title');
  if (error) throw new Error(error.message);
  return data || [];
}

// --------------------------------------------------------------
// Mutations
// --------------------------------------------------------------
export async function submitChange(input) {
  const { data: me } = await supabase.auth.getUser();
  const uid = me?.user?.id;
  if (!uid) throw new Error('Not signed in');
  const { data: profile } = await supabase
    .from('profiles').select('display_name, role').eq('id', uid).maybeSingle();

  const {
    title, sopType, currentVersion, currentProcess, proposedChange,
    expectedImpact, risks, ownerId, ownerName, priority,
    affectedKbIds = [], affectedKbTitles = [],
  } = input;

  // Boss-submitted change requests skip the approval queue and land
  // already approved — the Boss is the approver. Everyone else enters
  // as 'pending' and goes through the standard review flow.
  const isBoss = profile?.role === 'boss';
  const insertPayload = {
    title:              title.trim(),
    sop_type:           sopType || null,
    current_version:    currentVersion || null,
    current_process:    currentProcess.trim(),
    proposed_change:    proposedChange.trim(),
    expected_impact:    (expectedImpact || '').trim() || null,
    risks:              (risks || '').trim() || null,
    owner_id:           ownerId,
    owner_name:         ownerName || null,
    priority:           priority || null,
    affected_kb_ids:    affectedKbIds,
    affected_kb_titles: affectedKbTitles,
    submitted_by:       uid,
    submitted_by_name:  profile?.display_name || null,
    submitted_by_role:  profile?.role || null,
  };
  if (isBoss) {
    insertPayload.status            = 'approved';
    insertPayload.approved_by       = uid;
    insertPayload.approved_by_name  = profile?.display_name || null;
    insertPayload.approval_date     = new Date().toISOString();
  }

  const { data, error } = await supabase
    .from('changes')
    .insert(insertPayload)
    .select().single();
  if (error) throw new Error(error.message);
  return data;
}

export async function updateChange(id, patch) {
  // patch shape follows the DB's snake_case for simplicity — caller
  // builds it. status transitions that go through this call will
  // emit a notification + thread entry via the DB trigger.
  const { data, error } = await supabase
    .from('changes').update(patch).eq('id', id).select().single();
  if (error) throw new Error(error.message);
  return data;
}

export async function deleteChange(id) {
  const { error } = await supabase.from('changes').delete().eq('id', id);
  if (error) throw new Error(error.message);
}

// --------------------------------------------------------------
// Thread
// --------------------------------------------------------------
export async function listChangeThread(changeId) {
  const { data, error } = await supabase
    .from('change_thread')
    .select('*')
    .eq('change_id', changeId)
    .order('created_at', { ascending: true });
  if (error) throw new Error(error.message);
  return data || [];
}

export async function postChangeMessage(changeId, text) {
  const { data: me } = await supabase.auth.getUser();
  const uid = me?.user?.id;
  if (!uid) throw new Error('Not signed in');
  const { data: profile } = await supabase
    .from('profiles').select('display_name, role').eq('id', uid).maybeSingle();

  const { data, error } = await supabase
    .from('change_thread')
    .insert({
      change_id: changeId,
      user_id:   uid,
      user_name: profile?.display_name || null,
      user_role: profile?.role || null,
      type:      'message',
      text:      text.trim(),
    })
    .select().single();
  if (error) throw new Error(error.message);
  return data;
}
