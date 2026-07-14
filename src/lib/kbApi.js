import { supabase } from './supabase';

// --------------------------------------------------------------
// Constants — v1's 5 fixed tabs. Free-form categories are still
// allowed on the backend but these are the default picker options.
// --------------------------------------------------------------
export const KB_CATEGORIES = [
  { value: 'delivery_roadmap',   label: 'Delivery Roadmap' },
  { value: 'bootcamp',           label: 'BootCamp Curriculum' },
  { value: 'operational_sops',   label: 'Operational SOPs' },
  { value: 'training_sops',      label: 'Training SOPs' },
  { value: 'policies',           label: 'Policies' },
];

export function categoryLabel(value) {
  return KB_CATEGORIES.find((c) => c.value === value)?.label || value || 'General';
}

export const KB_VISIBILITIES = [
  { value: 'private', label: 'Only me' },
  { value: 'users',   label: 'Specific users' },
  { value: 'role',    label: 'Roles' },
  { value: 'office',  label: 'Everyone' },
];

// --------------------------------------------------------------
// Queries
// --------------------------------------------------------------
export async function listArticles({ category = null, onlyLatest = true, status = 'approved' } = {}) {
  let q = supabase
    .from('kb_articles')
    .select('*, created_by_profile:created_by(id, display_name, role, avatar_url), updater:updated_by(id, display_name)')
    .order('updated_at', { ascending: false });
  if (category) q = q.eq('category', category);
  if (status)   q = q.eq('approval_status', status);
  const { data, error } = await q;
  if (error) throw new Error(error.message);
  const rows = data || [];
  if (!onlyLatest) return rows;
  // Keep only the highest-version row per sop_group_id
  const byGroup = new Map();
  for (const r of rows) {
    const k = r.sop_group_id || r.id;
    const cur = byGroup.get(k);
    if (!cur || (r.version || 1) > (cur.version || 1)) byGroup.set(k, r);
  }
  return Array.from(byGroup.values()).sort(
    (a, b) => new Date(b.updated_at) - new Date(a.updated_at),
  );
}

export async function listVersions(sopGroupId) {
  const { data, error } = await supabase
    .from('kb_articles')
    .select('*')
    .eq('sop_group_id', sopGroupId)
    .order('version', { ascending: false });
  if (error) throw new Error(error.message);
  return data || [];
}

export async function listPending() {
  const { data, error } = await supabase
    .from('kb_articles')
    .select('*, submitter:submitted_by(id, display_name, role, avatar_url)')
    .eq('approval_status', 'pending')
    .order('submitted_at', { ascending: false });
  if (error) throw new Error(error.message);
  return data || [];
}

export async function getMyAckMap(userId) {
  // Returns a Set<article_id> that I've acknowledged.
  const { data, error } = await supabase
    .from('kb_acknowledgments')
    .select('article_id')
    .eq('user_id', userId);
  if (error) throw new Error(error.message);
  return new Set((data || []).map((r) => r.article_id));
}

export async function listComments(articleId) {
  const { data, error } = await supabase
    .from('kb_comments')
    .select('*, author:author_id(id, display_name, role, avatar_url)')
    .eq('article_id', articleId)
    .order('created_at', { ascending: true });
  if (error) throw new Error(error.message);
  return data || [];
}

export async function ackDashboard(articleId) {
  const { data, error } = await supabase.rpc('kb_ack_dashboard', { p_id: articleId });
  if (error) throw new Error(error.message);
  return data || [];
}

// --------------------------------------------------------------
// Mutations
// --------------------------------------------------------------
export async function proposeArticle({
  title, body, url, description, category, tags,
  visibility, visibleToRoles, visibleToUsers, requiresAck,
  sopGroupId = null, autoApprove = false, versionLabel = null,
}) {
  const { data, error } = await supabase.rpc('kb_propose', {
    p_title:             title,
    p_body:              body || '',
    p_url:               url || null,
    p_description:       description || '',
    p_category:          category || 'General',
    p_tags:              tags || [],
    p_visibility:        visibility,
    p_visible_to_roles:  visibleToRoles || [],
    p_visible_to_users:  visibleToUsers || [],
    p_requires_ack:      !!requiresAck,
    p_sop_group_id:      sopGroupId,
    p_auto_approve:      !!autoApprove,
    p_version_label:     versionLabel || null,
  });
  if (error) throw new Error(error.message);
  return data;
}

// Categories that participate in SOP versioning. Bootcamp doesn't
// version (it's curriculum, not policy). Matches v1's SOP_TABS.
export const SOP_CATEGORIES = ['delivery_roadmap', 'operational_sops', 'training_sops', 'policies'];
export function isSopCategory(c) { return SOP_CATEGORIES.includes(c); }

export async function approveArticle(id) {
  const { data, error } = await supabase.rpc('kb_approve', { p_id: id });
  if (error) throw new Error(error.message);
  return data;
}

export async function rejectArticle(id, reason) {
  const { data, error } = await supabase.rpc('kb_reject', { p_id: id, p_reason: reason || null });
  if (error) throw new Error(error.message);
  return data;
}

export async function setAck(articleId, read) {
  const { error } = await supabase.rpc('kb_set_ack', { p_id: articleId, p_read: !!read });
  if (error) throw new Error(error.message);
}

export async function addComment(articleId, body) {
  const { data, error } = await supabase.rpc('kb_comment_add', { p_article: articleId, p_body: body });
  if (error) throw new Error(error.message);
  return data;
}

export async function replyToComment(commentId, body) {
  const { data, error } = await supabase.rpc('kb_comment_reply', { p_comment: commentId, p_body: body });
  if (error) throw new Error(error.message);
  return data;
}

export async function updateArticleFields(id, patch) {
  const { data, error } = await supabase
    .from('kb_articles')
    .update(patch)
    .eq('id', id)
    .select()
    .single();
  if (error) throw new Error(error.message);
  return data;
}

export async function deleteArticle(id) {
  const { error } = await supabase.from('kb_articles').delete().eq('id', id);
  if (error) throw new Error(error.message);
}

// =====================================================================
// v1-compat layer — fields/helpers shaped to match v1's Firestore docs
// so the verbatim-ported v1 components can read/write the v2 backend
// without touching the JSX. Keep additions strictly additive.
// =====================================================================

// v1's tab → v2's category. Values match 1:1; this is just an alias so
// v1 markup using `item.tab` keeps working when read from v2.
export const KB_TABS = KB_CATEGORIES;
export const KB_SOP_TABS = SOP_CATEGORIES;

// v1 stored description and body separately; v2's kb_propose RPC
// concatenates them as "description\n\nbody". Split them back out so
// the v1 page can show item.description verbatim.
function splitDescriptionBody(combined) {
  const s = combined || '';
  const sep = '\n\n';
  const idx = s.indexOf(sep);
  if (idx < 0) return { description: s, body: '' };
  return { description: s.slice(0, idx), body: s.slice(idx + sep.length) };
}

// Firestore Timestamp shim — v1 calls `ts.toDate()` and reads `ts.seconds`
// in lots of places. Wrap an ISO string so both work.
function fsTs(value) {
  if (!value) return null;
  if (typeof value === 'object' && (value.toDate || typeof value.seconds === 'number')) {
    return value;
  }
  const d = new Date(value);
  if (isNaN(d.getTime())) return null;
  const seconds = Math.floor(d.getTime() / 1000);
  return {
    toDate: () => d,
    seconds,
    nanoseconds: 0,
    _date: d,
    valueOf: () => d.getTime(),
  };
}

// ── Visibility: the v1 UI and the DB disagree on TWO of the four names ────
// The UI works in { everyone | roles | users | private }.
// kb_articles.visibility is a CHECK constraint over ('private','office','role',
// 'users') — 'office' not 'everyone', and 'role' SINGULAR not 'roles'.
//
// 'everyone' → 'office' was already translated. **'roles' → 'role' was NOT**, so
// choosing "By Role" in the Boss KB and pressing Save sent visibility='roles',
// the CHECK constraint rejected the write, the error was swallowed, and NOTHING
// HAPPENED — no article, no message. Verified against prod: inserting 'roles' is
// rejected by the constraint; 'role' is accepted. Cruelly, 'users' IS a legal
// value, which is why "By User" worked and only "By Role" was broken.
//
// And on the way back, a stored 'role' was handed to the UI as-is while the UI
// compares against 'roles' — so the 25 role-restricted articles already in prod
// showed no "By Role" badge and didn't preselect their mode when edited.
const VIS_TO_DB = { everyone: 'office', roles: 'role' };
const VIS_TO_UI = { office: 'everyone', role: 'roles' };
const visToDb = (t) => VIS_TO_DB[t] || t || 'office';
const visToUi = (t) => VIS_TO_UI[t] || t || 'everyone';

// Map a v2 kb_articles row (snake_case + joined profile) into the
// v1 doc shape that BossKnowledgeBasePage / KnowledgeBasePage expect.
export function _normRow(row) {
  if (!row) return row;
  const { description, body } = splitDescriptionBody(row.body);
  const visType = row.visibility || 'office';
  return {
    id:                 row.id,
    title:              row.title || '',
    url:                row.url || '',
    description,
    body,
    tab:                row.category || 'General',
    category:           row.category || 'General',
    version:            row.version_label || (row.version ? `v${row.version}` : ''),
    versionInt:         row.version || 1,
    versionLabel:       row.version_label || null,
    sopGroupId:         row.sop_group_id || row.id,
    requiresAck:        !!row.requires_ack,
    approvalStatus:     row.approval_status || 'approved',
    rejectionReason:    row.rejection_reason || '',
    visibility: {
      type:    visToUi(visType),
      roles:   row.visible_to_roles || [],
      userIds: row.visible_to_users || [],
    },
    submittedBy:        row.submitted_by || null,
    submittedByName:    row.submitter?.display_name || row.created_by_profile?.display_name || '',
    submittedByRole:    row.author_role || row.submitter?.role || '',
    createdBy:          row.created_by || null,
    createdByName:      row.created_by_profile?.display_name || row.submitter?.display_name || '',
    approvedBy:         row.approved_by || null,
    approvedByName:     '',
    createdAt:          fsTs(row.created_at || row.submitted_at),
    submittedAt:        fsTs(row.submitted_at),
    approvedAt:         fsTs(row.approved_at),
    updatedAt:          fsTs(row.updated_at),
    // Was `row.updated_by_name` — a column kb_articles never had, so "Updated by
    // X" NEVER rendered on either KB page. mig 248 adds a real updated_by (stamped
    // by trigger from auth.uid(), backfilled to the creator) and we join it.
    updatedByName:      row.updater?.display_name || row.created_by_profile?.display_name || '',
    tags:               row.tags || [],
    _raw:               row,
  };
}

// ---------------------------------------------------------------------
// Bulk loaders for the v1 pages
// ---------------------------------------------------------------------

// Boss view — every article (approved + pending + rejected). RLS already
// gates this to boss/ol/developer & owners, so we just rely on the
// SELECT policy.
export async function listAllArticles() {
  const { data, error } = await supabase
    .from('kb_articles')
    .select('*, created_by_profile:created_by(id, display_name, role, avatar_url), submitter:submitted_by(id, display_name, role, avatar_url), updater:updated_by(id, display_name)')
    .order('created_at', { ascending: false });
  if (error) throw new Error(error.message);
  return (data || []).map(_normRow);
}

// User view — what RLS already filters down for me (approved + own
// pending/rejected). Same shape as listAllArticles, normalized.
export async function listVisibleArticles() {
  return listAllArticles();
}

// All active users (Boss DocModal "Specific Users" picker + ack dashboard).
export async function listAllUsers() {
  const { data, error } = await supabase
    .from('profiles')
    .select('id, display_name, email, role, avatar_url, is_active')
    .eq('is_active', true)
    .order('display_name', { ascending: true });
  if (error) throw new Error(error.message);
  return (data || []).map((p) => ({
    id:          p.id,
    uid:         p.id,
    displayName: p.display_name || '',
    userName:    p.display_name || '',
    email:       p.email || '',
    role:        p.role || '',
    avatarUrl:   p.avatar_url || '',
  }));
}

// Acknowledgments for a specific article (Boss ack-dashboard modal).
// Returns v1-shaped rows: { userId, userName, readAt }.
export async function listAcknowledgments(articleId) {
  const { data, error } = await supabase
    .from('kb_acknowledgments')
    .select('user_id, read_at, user:user_id(id, display_name)')
    .eq('article_id', articleId);
  if (error) throw new Error(error.message);
  return (data || []).map((a) => ({
    id:       a.user_id,
    userId:   a.user_id,
    userName: a.user?.display_name || '',
    readAt:   fsTs(a.read_at),
  }));
}

// Comments for a specific article in v1 shape.
export async function listCommentsV1(articleId) {
  const rows = await listComments(articleId);
  return rows.map((c) => ({
    id:          c.id,
    userId:      c.author_id,
    userName:    c.author?.display_name || '',
    userRole:    c.author?.role || '',
    text:        c.body || '',
    bossReply:   c.boss_reply || null,
    bossReplyBy: c.boss_reply_by || null,
    bossReplyAt: fsTs(c.boss_reply_at),
    createdAt:   fsTs(c.created_at),
  }));
}

// ---------------------------------------------------------------------
// Realtime subscription helpers — v1 uses onSnapshot loops; map them
// to Supabase Realtime channels with the same { items, comments } shape.
// ---------------------------------------------------------------------
export function subscribeArticles(onChange, onError) {
  // initial load + channel. If the initial fetch throws (RLS edge case,
  // network glitch), call `onError` so the caller can flip loading off
  // — silent catches were the cause of the "infinite spinner" symptom
  // some APC users saw.
  let stopped = false;
  (async () => {
    try { const rows = await listAllArticles(); if (!stopped) onChange(rows); }
    catch (e) {
      if (!stopped) {
        console.warn('[subscribeArticles] initial load failed:', e?.message);
        onError?.(e);
      }
    }
  })();
  const ch = supabase
    .channel('kb-articles')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'kb_articles' },
      async () => {
        try { const rows = await listAllArticles(); if (!stopped) onChange(rows); }
        catch (e) {
          console.warn('[subscribeArticles] refetch failed:', e?.message);
          if (!stopped) onError?.(e);
        }
      })
    .subscribe();
  return () => { stopped = true; supabase.removeChannel(ch); };
}

export function subscribeComments(articleId, onChange) {
  let stopped = false;
  (async () => {
    try { const rows = await listCommentsV1(articleId); if (!stopped) onChange(rows); }
    catch { /* ignore initial */ }
  })();
  const ch = supabase
    .channel(`kb-comments-${articleId}`)
    .on('postgres_changes',
      { event: '*', schema: 'public', table: 'kb_comments', filter: `article_id=eq.${articleId}` },
      async () => { try { const rows = await listCommentsV1(articleId); if (!stopped) onChange(rows); } catch { /* ignore */ } })
    .subscribe();
  return () => { stopped = true; supabase.removeChannel(ch); };
}

// ---------------------------------------------------------------------
// v1-shaped writes — wrap RPCs so callers can pass v1 payloads
// ---------------------------------------------------------------------

// v1 Boss "Add" / "Edit" / "New Version" payload:
//   { title, url, description, tab, version, visibility:{type,roles,userIds}, sopGroupId? }
// Boss is admin → auto_approve = true. Returns the normalized row.
export async function bossSaveArticle(payload) {
  const visType = visToDb(payload.visibility?.type);
  const data = await proposeArticle({
    title:           payload.title,
    body:            '',
    url:             payload.url,
    description:     payload.description,
    category:        payload.tab,
    tags:            payload.tags || [],
    visibility:      visType,
    visibleToRoles:  payload.visibility?.roles || [],
    visibleToUsers:  payload.visibility?.userIds || [],
    requiresAck:     !!payload.requiresAck,
    sopGroupId:      payload.sopGroupId || null,
    autoApprove:     true,
    versionLabel:    payload.version || null,
  });
  return _normRow(data);
}

// v1 TL/OL "Propose" — title/url/description/tab/version, no visibility
// (boss sets it on approve). Goes into pending queue.
export async function userProposeArticle(payload) {
  const data = await proposeArticle({
    title:        payload.title,
    body:         '',
    url:          payload.url,
    description:  payload.description,
    category:     payload.tab,
    tags:         [],
    visibility:   'private',          // RPC requires a value; boss flips it on approve
    visibleToRoles: [],
    visibleToUsers: [],
    requiresAck:  false,
    sopGroupId:   null,
    autoApprove:  false,
    versionLabel: payload.version || null,
  });
  return _normRow(data);
}

// Boss approve: sets visibility + flips status. Uses kb_approve, then
// patches visibility (not auth-gated by the RPC; UPDATE policy allows boss).
export async function bossApprove(articleId, visibility) {
  const visType = visToDb(visibility?.type);
  // Approve first
  await approveArticle(articleId);
  // Then patch visibility (kb_approve doesn't take it)
  const patch = {
    visibility:        visType,
    visible_to_roles:  visibility?.roles || [],
    visible_to_users:  visibility?.userIds || [],
  };
  const data = await updateArticleFields(articleId, patch);
  return _normRow(data);
}

export async function bossReject(articleId, reason) {
  const data = await rejectArticle(articleId, reason);
  return _normRow(data);
}

// Boss inline-edit existing article (after it's already approved). v1
// just updateDoc()s any subset of fields. Map to v2 column names.
export async function bossUpdateArticle(articleId, payload) {
  // undefined when the caller isn't patching visibility — don't default it here,
  // or a partial update would silently reset the article to "everyone".
  const visType = payload.visibility?.type ? visToDb(payload.visibility.type) : undefined;
  const patch = {};
  if (payload.title       !== undefined) patch.title        = payload.title;
  if (payload.url         !== undefined) patch.url          = payload.url;
  if (payload.description !== undefined) patch.body         = payload.description;
  if (payload.tab         !== undefined) patch.category     = payload.tab;
  if (payload.version     !== undefined) patch.version_label = payload.version || null;
  if (payload.visibility  !== undefined) {
    patch.visibility       = visType;
    patch.visible_to_roles = payload.visibility?.roles || [];
    patch.visible_to_users = payload.visibility?.userIds || [];
  }
  patch.updated_at = new Date().toISOString();
  const data = await updateArticleFields(articleId, patch);
  return _normRow(data);
}

export async function bossDeleteArticle(articleId) { return deleteArticle(articleId); }

// Comment helpers in v1 shape
export async function userAddComment(articleId, text) {
  const c = await addComment(articleId, text);
  return c;
}
export async function bossReplyComment(commentId, text) {
  const c = await replyToComment(commentId, text);
  return c;
}
export async function bossDeleteComment(commentId) {
  const { error } = await supabase.from('kb_comments').delete().eq('id', commentId);
  if (error) throw new Error(error.message);
}

// Ack helpers
export async function ackArticle(articleId) { return setAck(articleId, true); }
export async function unackArticle(articleId) { return setAck(articleId, false); }

// Linked changes (Delivery Roadmap section in user KB page).
// Returns rows in v1 shape: { id, title, status, sopType, ownerName, affectedSopIds }.
export async function listLinkedChanges() {
  const { data, error } = await supabase
    .from('changes')
    .select('id, title, status, sop_type, owner_name, affected_kb_ids')
    .neq('status', 'rejected')
    .order('created_at', { ascending: false });
  if (error) throw new Error(error.message);
  return (data || []).map((c) => ({
    id:              c.id,
    title:           c.title || '',
    status:          c.status || '',
    sopType:         c.sop_type || '',
    ownerName:       c.owner_name || '',
    affectedSopIds:  c.affected_kb_ids || [],
  }));
}

export function subscribeLinkedChanges(onChange) {
  let stopped = false;
  (async () => {
    try { const rows = await listLinkedChanges(); if (!stopped) onChange(rows); }
    catch (e) {
      // Non-fatal — APCs may not have read access to `changes` rows under
      // RLS. Default to empty list so the UI keeps working.
      console.warn('[subscribeLinkedChanges] initial load failed:', e?.message);
      if (!stopped) onChange([]);
    }
  })();
  const ch = supabase
    .channel('kb-linked-changes')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'changes' },
      async () => {
        try { const rows = await listLinkedChanges(); if (!stopped) onChange(rows); }
        catch (e) { console.warn('[subscribeLinkedChanges] refetch failed:', e?.message); }
      })
    .subscribe();
  return () => { stopped = true; supabase.removeChannel(ch); };
}

// ---------------------------------------------------------------------
// Date formatters used by v1 markup
// ---------------------------------------------------------------------
export function formatKbDate(ts) {
  if (!ts) return '';
  const d = ts && ts.toDate ? ts.toDate() : new Date(ts);
  if (isNaN(d.getTime())) return '';
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}
export function formatKbTime(ts) {
  if (!ts) return '';
  const d = ts && ts.toDate ? ts.toDate() : new Date(ts);
  if (isNaN(d.getTime())) return '';
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
       + ' ' + d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
}

// ---------------------------------------------------------------------
// Duplicate detection (mirrors v1's utils/kbDuplicates.js exactly)
// ---------------------------------------------------------------------
export function normalizeUrl(input) {
  if (!input) return '';
  let s = String(input).trim();
  if (!s) return '';
  try {
    const hasProtocol = /^https?:\/\//i.test(s);
    const u = new URL(hasProtocol ? s : `https://${s}`);
    let host = u.hostname.toLowerCase().replace(/^www\./, '');
    let path = u.pathname.replace(/\/+$/, '');
    const drop = new Set(['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'fbclid', 'gclid']);
    const params = [...u.searchParams.entries()].filter(([k]) => !drop.has(k.toLowerCase()));
    params.sort(([a], [b]) => a.localeCompare(b));
    const search = params.length ? ('?' + params.map(([k, v]) => `${k}=${v}`).join('&')) : '';
    return `${host}${path}${search}`.toLowerCase();
  } catch {
    return s.toLowerCase().replace(/\/+$/, '');
  }
}
export function normalizeKbTitle(input) {
  return (input || '').toString().trim().toLowerCase().replace(/\s+/g, ' ');
}
export function findDuplicateByUrl(url, items, { excludeId } = {}) {
  const key = normalizeUrl(url);
  if (!key) return null;
  for (const it of items) {
    if (excludeId && it.id === excludeId) continue;
    if (normalizeUrl(it.url) === key) return it;
  }
  return null;
}
export function findDuplicateByTitle(title, items, { excludeId } = {}) {
  const key = normalizeKbTitle(title);
  if (!key) return null;
  for (const it of items) {
    if (excludeId && it.id === excludeId) continue;
    if (normalizeKbTitle(it.title) === key) return it;
  }
  return null;
}
export function groupDuplicates(items) {
  const byUrl = new Map();
  const byTitle = new Map();
  items.forEach((it) => {
    const u = normalizeUrl(it.url);
    if (u) {
      if (!byUrl.has(u)) byUrl.set(u, []);
      byUrl.get(u).push(it);
    }
    const t = normalizeKbTitle(it.title);
    if (t) {
      if (!byTitle.has(t)) byTitle.set(t, []);
      byTitle.get(t).push(it);
    }
  });
  const urlGroups = [...byUrl.entries()].filter(([, list]) => list.length > 1).map(([key, list]) => ({ key, list }));
  const titleGroups = [...byTitle.entries()].filter(([, list]) => list.length > 1).map(([key, list]) => ({ key, list }));
  return { urlGroups, titleGroups };
}

// --------------------------------------------------------------
// Video-embed detection — YouTube / Loom / Vimeo / Drive / direct
// --------------------------------------------------------------
export function detectVideo(url) {
  if (!url || typeof url !== 'string') return null;
  const u = url.trim();
  // YouTube
  let m = u.match(/(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/)([\w-]{6,})/i);
  if (m) return { kind: 'youtube', embed: `https://www.youtube.com/embed/${m[1]}` };
  // Loom
  m = u.match(/loom\.com\/(?:share|embed)\/([\w-]{8,})/i);
  if (m) return { kind: 'loom', embed: `https://www.loom.com/embed/${m[1]}` };
  // Vimeo
  m = u.match(/vimeo\.com\/(?:video\/)?(\d+)/i);
  if (m) return { kind: 'vimeo', embed: `https://player.vimeo.com/video/${m[1]}` };
  // Google Drive (file preview)
  m = u.match(/drive\.google\.com\/file\/d\/([\w-]+)/i);
  if (m) return { kind: 'drive', embed: `https://drive.google.com/file/d/${m[1]}/preview` };
  // Direct video
  if (/\.(mp4|webm|ogg)(\?|$)/i.test(u)) return { kind: 'direct', embed: u };
  return null;
}
