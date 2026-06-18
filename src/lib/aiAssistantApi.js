// Client for the WurxOS AI Assistant. Chat goes through the `ai-chat` edge
// function (GPT_TOKEN stays server-side). Knowledge/config/history are plain
// RLS-gated table reads/writes.
import { supabase } from './supabase';

// ── Chat ──────────────────────────────────────────────────────────
export async function aiSend({ conversationId, message }) {
  const { data, error } = await supabase.functions.invoke('ai-chat', { body: { conversationId, message } });
  if (error) throw new Error(error.message || 'AI request failed');
  if (data?.error) throw new Error(data.error);
  return data; // { conversationId, reply }
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
