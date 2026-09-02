// Client for the WurxOS AI Assistant. Chat goes through the `ai-chat` edge
// function (GPT_TOKEN stays server-side). Knowledge/config/history are plain
// RLS-gated table reads/writes.
import { supabase } from './supabase';
import { assertAllowedInDemo } from './demoMode';

// ── Chat ──────────────────────────────────────────────────────────
export async function aiSend({ conversationId, message }) {
  const { data, error } = await supabase.functions.invoke('ai-chat', { body: { conversationId, message } });
  if (error) {
    // supabase-js masks the function's body on non-2xx as a generic message;
    // dig the real reason out of error.context (the raw Response).
    let detail = error.message || 'AI request failed';
    try { const b = await error.context?.json?.(); if (b?.error) detail = b.error; } catch { /* keep generic */ }
    throw new Error(detail);
  }
  if (data?.error) throw new Error(data.error);
  return data; // { conversationId, reply }
}

// Streaming chat. Calls ai-chat with { stream:true } and reads the SSE body,
// invoking onDelta(textChunk) as tokens arrive. Resolves with { conversationId }
// once the stream completes. supabase.functions.invoke can't stream, so we hit
// the function URL directly with the user's access token.
export async function aiSendStream({ conversationId, message, onDelta, onStatus, signal }) {
  // Raw fetch, so the invoke wrapper in supabase.js does not cover this path.
  assertAllowedInDemo('ai-chat');
  const { data: { session } } = await supabase.auth.getSession();
  const token = session?.access_token;
  const anon = import.meta.env.VITE_SUPABASE_ANON_KEY;
  const base = import.meta.env.VITE_SUPABASE_URL;
  if (!token || !base) throw new Error('Not signed in.');

  const res = await fetch(`${base}/functions/v1/ai-chat`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, apikey: anon, 'Content-Type': 'application/json' },
    body: JSON.stringify({ conversationId, message, stream: true }),
    signal,
  });

  // Non-2xx → parse the JSON error the function returned.
  if (!res.ok) {
    let detail = `AI request failed (${res.status})`;
    try { const b = await res.json(); if (b?.error) detail = b.error; } catch { /* keep generic */ }
    throw new Error(detail);
  }

  // If the server didn't stream (older deploy / fallback), treat as JSON.
  const ctype = res.headers.get('content-type') || '';
  if (!ctype.includes('text/event-stream') || !res.body) {
    const b = await res.json().catch(() => ({}));
    if (b?.error) throw new Error(b.error);
    if (b?.reply && onDelta) onDelta(b.reply);
    return { conversationId: b?.conversationId || conversationId };
  }

  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  let newConvId = conversationId;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop() || '';
    for (const line of lines) {
      const s = line.trim();
      if (!s.startsWith('data:')) continue;
      const payload = s.slice(5).trim();
      if (!payload) continue;
      let obj;
      try { obj = JSON.parse(payload); } catch { continue; }
      if (obj.error) throw new Error(obj.error);
      if (obj.status && onStatus) onStatus(obj.status);
      if (obj.delta && onDelta) onDelta(obj.delta);
      if (obj.done) newConvId = obj.conversationId || newConvId;
    }
  }
  return { conversationId: newConvId };
}

export async function listConversations() {
  const { data, error } = await supabase
    .from('ai_conversations').select('id, title, updated_at')
    .order('updated_at', { ascending: false }).limit(60);
  if (error) throw new Error(error.message);
  return data || [];
}

export async function getMessages(conversationId) {
  const { data, error } = await supabase
    .from('ai_messages').select('role, content, created_at')
    .eq('conversation_id', conversationId).order('created_at', { ascending: true });
  if (error) throw new Error(error.message);
  return data || [];
}

export async function deleteConversation(id) {
  const { error } = await supabase.from('ai_conversations').delete().eq('id', id);
  if (error) throw new Error(error.message);
}

// ── Config (Boss persona/greeting/model) ──────────────────────────
export async function getAiConfig() {
  const { data, error } = await supabase.from('ai_assistant_config').select('*').eq('id', 1).maybeSingle();
  if (error) throw new Error(error.message);
  return data;
}
export async function updateAiConfig(patch) {
  const { error } = await supabase.from('ai_assistant_config')
    .update({ ...patch, updated_at: new Date().toISOString() }).eq('id', 1);
  if (error) throw new Error(error.message);
}

// ── Knowledge docs (Boss "training") ──────────────────────────────
export async function listDocs() {
  const { data, error } = await supabase.from('ai_assistant_docs').select('*').order('updated_at', { ascending: false });
  if (error) throw new Error(error.message);
  return data || [];
}
export async function saveDoc(doc) {
  if (doc.id) {
    const { error } = await supabase.from('ai_assistant_docs')
      .update({ title: doc.title, content: doc.content, is_active: doc.is_active, updated_at: new Date().toISOString() })
      .eq('id', doc.id);
    if (error) throw new Error(error.message);
  } else {
    const { data: u } = await supabase.auth.getUser();
    const { error } = await supabase.from('ai_assistant_docs')
      .insert({ title: doc.title, content: doc.content, is_active: doc.is_active ?? true, created_by: u?.user?.id });
    if (error) throw new Error(error.message);
  }
}
export async function deleteDoc(id) {
  const { error } = await supabase.from('ai_assistant_docs').delete().eq('id', id);
  if (error) throw new Error(error.message);
}
