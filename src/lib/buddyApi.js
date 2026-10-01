// Client for Wurx Buddy (Assistant v2). Chat goes to the `assistant` edge
// function over SSE; conversations and messages are plain RLS-gated table
// access (owner-only). Columns added for the Buddy UI (status, pinned,
// last_read_at, …) are optional here: if the backend migration hasn't landed,
// every call falls back to the v1 columns instead of failing.
import { supabase } from './supabase';
import { assertAllowedInDemo } from './demoMode';
import { parseSse, rowToMessage, visibleMessages } from './buddyLogic';

export class BuddyHttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

// VITE_BUDDY_URL points the UI at a local scripts/serve-assistant.mjs
// (e.g. http://127.0.0.1:8787/assistant) before the dev deploy.
function endpoint() {
  const override = import.meta.env.VITE_BUDDY_URL;
  if (override) return override;
  return `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/assistant`;
}

// A stream that goes quiet this long is treated as dropped; the provider then
// picks the reply up from the database. Tool rounds emit a status line, so a
// healthy turn is never silent this long.
const STALL_MS = 90000;

// Resolves { done } once the stream ends. Throws BuddyHttpError for a refusal
// (JSON + status), anything else (network, abort) as-is.
// `regenerate` (the conversation's last reply id, mig 389) asks for a new
// answer in place of that one: no message or conversationId is sent.
export async function streamAssistant({ conversationId, message, regenerate, surface, pageContext, signal, onEvent }) {
  assertAllowedInDemo('assistant');
  const { data: { session } } = await supabase.auth.getSession();
  const token = session?.access_token;
  if (!token) throw new BuddyHttpError(401, 'Not signed in.');

  const ctrl = new AbortController();
  const abort = () => ctrl.abort(signal?.reason);
  if (signal) { if (signal.aborted) abort(); else signal.addEventListener('abort', abort, { once: true }); }
  let stall = setTimeout(() => ctrl.abort('stall'), STALL_MS);
  const alive = () => { clearTimeout(stall); stall = setTimeout(() => ctrl.abort('stall'), STALL_MS); };

  try {
    const res = await fetch(endpoint(), {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        apikey: import.meta.env.VITE_SUPABASE_ANON_KEY,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(regenerate
        ? { regenerate, stream: true, surface, page_context: pageContext }
        : { conversationId: conversationId || undefined, message, stream: true, surface, page_context: pageContext }),
      signal: ctrl.signal,
    });

    if (!res.ok) {
      let detail = '';
      try { const b = await res.json(); detail = b?.error || ''; } catch { /* not JSON */ }
      throw new BuddyHttpError(res.status, detail);
    }

    const ctype = res.headers.get('content-type') || '';
    if (!ctype.includes('text/event-stream') || !res.body) {
      const b = await res.json().catch(() => ({}));
      if (b?.error && !b?.reply) throw new BuddyHttpError(500, b.error);
      if (b?.reply) onEvent({ delta: b.reply });
      if (b?.sources) onEvent({ sources: b.sources });
      onEvent({ done: true, conversationId: b?.conversationId, requestId: b?.requestId });
      return { done: true };
    }

    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    let done = false;
    for (;;) {
      const { value, done: end } = await reader.read();
      if (end) break;
      alive();
      buf += dec.decode(value, { stream: true });
      const [events, rest] = parseSse(buf);
      buf = rest;
      for (const ev of events) {
        if (ev.done) done = true;
        onEvent(ev);
      }
    }
    return { done };
  } catch (e) {
    // A stall is a drop, not the user's Stop: surface it as a network error.
    if (ctrl.signal.reason === 'stall' && !signal?.aborted) throw new TypeError('stream stalled');
    throw e;
  } finally {
    clearTimeout(stall);
    signal?.removeEventListener?.('abort', abort);
  }
}

// ── schema fallback ────────────────────────────────────────────────
const missingColumn = (error) => !!error && (error.code === '42703' || error.code === 'PGRST204' || /column .* does not exist|Could not find the .* column/i.test(error.message || ''));

// Remembered per session so we don't hit the error on every call.
export const schema = { convExtras: true, msgStatus: true };

const CONV_BASE = 'id, title, created_at, updated_at';
const CONV_FULL = `${CONV_BASE}, pinned, last_read_at, last_reply_at, title_edited`;

export async function listConversations(userId) {
  const run = (cols) => supabase.from('ai_conversations').select(cols)
    .eq('user_id', userId).order('updated_at', { ascending: false }).limit(150);
  if (schema.convExtras) {
    const { data, error } = await run(CONV_FULL);
    if (!error) return data || [];
    if (!missingColumn(error)) throw new Error(error.message);
    schema.convExtras = false;
  }
  const { data, error } = await run(CONV_BASE);
  if (error) throw new Error(error.message);
  return data || [];
}

// Conversations whose messages mention q (title matches are filtered client-side).
export async function searchConversationIds(convIds, q) {
  const term = String(q || '').replace(/[%_\\]/g, ' ').trim();
  if (!term || !convIds.length) return [];
  const { data, error } = await supabase.from('ai_messages').select('conversation_id')
    .in('conversation_id', convIds.slice(0, 150)).ilike('content', `%${term}%`).limit(200);
  if (error) return [];
  return [...new Set((data || []).map((r) => r.conversation_id))];
}

const toMessage = rowToMessage;

// The answer a Regenerate replaced (for "Show previous answer"). Own rows only (RLS).
export async function getMessageById(id) {
  const { data, error } = await supabase.from('ai_messages').select('id, role, content, created_at, meta, status').eq('id', id).maybeSingle();
  if (error) throw new Error(error.message);
  return data ? toMessage(data) : null;
}

// ── models (Boss, mig 397) ─────────────────────────────────────────
export async function listModelCatalog() {
  const { data, error } = await supabase.from('ai_model_catalog').select('*');
  if (error) throw new Error(error.message);
  return data || [];
}

// The model keys, with their labels and order (mig 401). [] if it can't be
// read: the UI then uses its built-in labels.
export async function listKeySlots() {
  const { data, error } = await supabase.from('ai_key_slots').select('*').order('sort');
  return error ? [] : data || [];
}

// Probes every model on every key (~60 s). The Boss or a developer (403 otherwise).
export async function refreshModelList() {
  const { data: { session } } = await supabase.auth.getSession();
  const token = session?.access_token;
  if (!token) throw new BuddyHttpError(401, 'Not signed in.');
  const res = await fetch(endpoint(), {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, apikey: import.meta.env.VITE_SUPABASE_ANON_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ refresh_models: true }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new BuddyHttpError(res.status, body?.error || '');
  return body;
}

// auto_failover (the "automatic safety net") is newer than the other model
// columns: until its migration lands, read and save without it.
const MODEL_COLS = 'model, model_key_slot, fallback_models, fallback_enabled';
export async function getModelConfig() {
  if (schema.autoFailover !== false) {
    const { data, error } = await supabase.from('ai_assistant_config')
      .select(`${MODEL_COLS}, auto_failover`).eq('id', 1).maybeSingle();
    if (!error) { schema.autoFailover = true; return data || {}; }
    if (!missingColumn(error)) throw new Error(error.message);
    schema.autoFailover = false;
  }
  const { data, error } = await supabase.from('ai_assistant_config').select(MODEL_COLS).eq('id', 1).maybeSingle();
  if (error) throw new Error(error.message);
  return data || {};
}

// A bad choice is refused by a trigger (mig 397) with a readable message: pass it on.
export async function saveModelConfig(patch) {
  const { auto_failover, ...rest } = patch;
  const row = schema.autoFailover && auto_failover !== undefined ? { ...rest, auto_failover } : rest;
  const { error } = await supabase.from('ai_assistant_config')
    .update({ ...row, updated_at: new Date().toISOString() }).eq('id', 1);
  if (error) throw new Error(error.message);
}

// Server-side Stop (mig 386): { cancelled:true } (202) or { cancelled:false,
// status } (200, already finished). Throws BuddyHttpError otherwise.
export async function cancelReply(messageId) {
  const { data: { session } } = await supabase.auth.getSession();
  const token = session?.access_token;
  if (!token) throw new BuddyHttpError(401, 'Not signed in.');
  const res = await fetch(endpoint(), {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, apikey: import.meta.env.VITE_SUPABASE_ANON_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ cancel: messageId }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new BuddyHttpError(res.status, body?.error || '');
  return body;
}

export async function getMessages(conversationId) {
  const run = (cols) => supabase.from('ai_messages').select(cols)
    .eq('conversation_id', conversationId).order('created_at', { ascending: true });
  if (schema.msgStatus) {
    // Superseded answers (replaced by Regenerate) stay in the table but not in the chat.
    const { data, error } = await run('id, role, content, created_at, meta, status').neq('status', 'superseded');
    if (!error) return visibleMessages((data || []).map(toMessage));
    if (!missingColumn(error)) throw new Error(error.message);
    schema.msgStatus = false;
  }
  const { data, error } = await run('id, role, content, created_at, meta');
  if (error) throw new Error(error.message);
  return visibleMessages((data || []).map(toMessage));
}

// Assistant rows still generating (a reload mid-reply). [] on an older backend.
export async function findGenerating(convIds) {
  if (!schema.msgStatus || !convIds.length) return [];
  const { data, error } = await supabase.from('ai_messages').select('id, conversation_id, created_at, status')
    .in('conversation_id', convIds.slice(0, 40)).eq('role', 'assistant').eq('status', 'generating');
  if (error) { if (missingColumn(error)) schema.msgStatus = false; return []; }
  return data || [];
}

// With the reply row's id, only its UPDATEs; otherwise any change in the
// conversation (the row doesn't exist yet). RLS is the boundary either way.
export function subscribeMessages({ conversationId, messageId }, onChange) {
  const filter = messageId
    ? { event: 'UPDATE', filter: `id=eq.${messageId}` }
    : { event: '*', filter: `conversation_id=eq.${conversationId}` };
  const ch = supabase
    .channel(`buddy-msg-${messageId || conversationId}-${Math.random().toString(36).slice(2, 8)}`)
    .on('postgres_changes', { schema: 'public', table: 'ai_messages', ...filter }, () => onChange())
    .subscribe();
  return () => { try { supabase.removeChannel(ch); } catch { /* already gone */ } };
}

// The client may UPDATE only title / pinned / last_read_at (column grants);
// title_edited is the server's business.
async function updateConv(id, patch) {
  const { error } = await supabase.from('ai_conversations').update(patch).eq('id', id);
  if (!error) return true;
  if (missingColumn(error)) { schema.convExtras = false; return false; }
  throw new Error(error.message);
}

export async function renameConversation(id, title) {
  await updateConv(id, { title });
}

export async function pinConversation(id, pinned) {
  const ok = await updateConv(id, { pinned });
  if (!ok) throw new Error('Pinning needs the latest Buddy backend update.');
}

// `at` is never earlier than the reply it acknowledges, so a client clock that
// runs behind the server can't leave a read conversation looking unread.
export async function markConversationRead(id, at) {
  if (!schema.convExtras) return;
  await updateConv(id, { last_read_at: at || new Date().toISOString() }).catch(() => {});
}

export function subscribeConversations(userId, onChange) {
  const ch = supabase
    .channel(`buddy-conv-${userId}-${Math.random().toString(36).slice(2, 8)}`)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'ai_conversations', filter: `user_id=eq.${userId}` }, () => onChange())
    .subscribe();
  return () => { try { supabase.removeChannel(ch); } catch { /* already gone */ } };
}

export async function deleteConversation(id) {
  const { error } = await supabase.from('ai_conversations').delete().eq('id', id);
  if (error) throw new Error(error.message);
}

export async function sendFeedback(requestId, rating, note) {
  const { error } = await supabase.rpc('ai_feedback', { p_request_id: requestId, p_rating: rating, p_note: note || null });
  if (error) throw new Error(error.message);
}

// The Boss-edited greeting + who may use Buddy (mig 385). allowedRoles is null when the read
// fails, so the caller falls back to BUDDY_ROLES (the Boss and developers only).
export async function getBuddyConfig() {
  try {
    const { data, error } = await supabase.from('ai_assistant_config').select('greeting, allowed_roles').eq('id', 1).maybeSingle();
    if (error) return { greeting: '', allowedRoles: null };
    return { greeting: data?.greeting || '', allowedRoles: Array.isArray(data?.allowed_roles) ? data.allowed_roles : null };
  } catch {
    return { greeting: '', allowedRoles: null };
  }
}

// ── settings ───────────────────────────────────────────────────────
// `force` runs during quiet hours. Older backends have no p_force argument, so
// a "no such function" answer retries without it.
export async function runIngestion(force = false) {
  const call = (args) => supabase.rpc('ai_run_ingestion', args);
  let { data, error } = force ? await call({ p_force: true }) : await call();
  if (error && force && (error.code === 'PGRST202' || /function .*ai_run_ingestion.* does not exist|without parameters/i.test(error.message || ''))) {
    ({ data, error } = await call());
  }
  if (error) throw new Error(/not allowed/i.test(error.message) ? 'not allowed' : error.message);
  return data;
}

export async function ingestStats() {
  const { data, error } = await supabase.rpc('ai_ingest_stats');
  if (error) throw new Error(/not allowed/i.test(error.message) ? 'not allowed' : error.message);
  return data;
}

// Boss-only usage and cost estimate, PKT dates (YYYY-MM-DD, inclusive).
export async function usageSummary(from, to) {
  const { data, error } = await supabase.rpc('ai_usage_summary', { p_from: from, p_to: to });
  if (error) throw new Error(/not allowed|boss/i.test(error.message) ? 'not allowed' : error.message);
  return data;
}

// Who may use Buddy (the assistant function and the UI gate both read it).
export async function setAllowedRoles(roles) {
  const { error } = await supabase.from('ai_assistant_config')
    .update({ allowed_roles: roles, updated_at: new Date().toISOString() }).eq('id', 1);
  if (error) throw new Error(error.message);
}

// Report-only: Buddy is never blocked by it. null clears it.
export async function setMonthlyBudget(usd) {
  const { error } = await supabase.from('ai_assistant_config')
    .update({ monthly_budget_usd: usd, updated_at: new Date().toISOString() }).eq('id', 1);
  if (error) throw new Error(error.message);
}

export const INGEST_SOURCES = [
  ['kb_article', 'Knowledge Base SOPs'],
  ['ai_doc', 'Curated knowledge docs'],
  ['app_guide', 'WurxOS app guides'],
  ['tts_article', 'TikTok Shop Academy'],
  ['report', 'Approved report narratives'],
  ['incentive', 'Incentive plans'],
];

export async function getIngestSources() {
  const { data, error } = await supabase.from('ai_assistant_config').select('ingest_sources').eq('id', 1).maybeSingle();
  if (error) throw new Error(error.message);
  return data?.ingest_sources || [];
}

export async function setIngestSources(list) {
  const { error } = await supabase.from('ai_assistant_config')
    .update({ ingest_sources: list, updated_at: new Date().toISOString() }).eq('id', 1);
  if (error) throw new Error(error.message);
}

export async function listExcluded() {
  const { data, error } = await supabase.from('ai_excluded_documents')
    .select('source_type, source_id, reason, excluded_at').order('excluded_at', { ascending: false });
  if (error) throw new Error(error.message);
  return data || [];
}

export async function addExcluded(sourceType, sourceId, reason) {
  const { error } = await supabase.from('ai_excluded_documents')
    .insert({ source_type: sourceType, source_id: sourceId.trim(), reason: reason?.trim() || '' });
  if (error) throw new Error(error.message);
}

export async function removeExcluded(sourceType, sourceId) {
  const { error } = await supabase.from('ai_excluded_documents').delete()
    .eq('source_type', sourceType).eq('source_id', sourceId);
  if (error) throw new Error(error.message);
}
