// Client for the WurxOS AI Assistant's knowledge, config and history: plain RLS-gated
// table reads/writes. Chat itself goes through the `assistant` function (see buddyApi.js);
// the old `ai-chat` function and its client helpers were removed.
import { supabase } from './supabase';

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

// ── Slack relay (Boss only; RLS enforces it) ──────────────────────
// The relay answers questions asked in Slack and posts them into one internal
// channel. Routing is seeded by migration 357; this is just the on/off switch
// and a read-only view of where things are pointed.
export async function getSlackConfig() {
  const { data, error } = await supabase.from('slack_config').select('*').eq('id', 1).maybeSingle();
  if (error) throw new Error(error.message);
  return data;
}
export async function setSlackEnabled(enabled) {
  const { error } = await supabase.from('slack_config')
    .update({ enabled, updated_at: new Date().toISOString() }).eq('id', 1);
  if (error) throw new Error(error.message);
}
export async function listSlackRelayLog(limit = 20) {
  const { data, error } = await supabase.from('slack_relay_log')
    .select('id, question, answer, posted, error, source_channel, created_at')
    .order('created_at', { ascending: false }).limit(limit);
  if (error) throw new Error(error.message);
  return data || [];
}
