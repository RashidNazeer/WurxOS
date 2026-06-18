// ============================================================
// Edge Function: ai-chat
//
// The WurxOS AI Support Assistant backend. Any logged-in employee can chat;
// the model is GitHub Models (OpenAI-compatible), called with GPT_TOKEN which
// stays server-side. Answers are grounded (RAG) in Boss-curated knowledge
// (ai_assistant_docs) + a Boss-set persona (ai_assistant_config), with
// persistent per-user memory (ai_conversations / ai_messages).
//
// The function is the ONLY writer of ai_messages, so assistant replies can't
// be forged by a client.
//
// Request: { conversationId?: string, message: string }
// Response: { conversationId, reply }
//
// Env (supabase secrets set): GPT_TOKEN, SUPABASE_URL/SERVICE_ROLE_KEY (auto)
// Deploy: supabase functions deploy ai-chat
// ============================================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const GPT_TOKEN = Deno.env.get('GPT_TOKEN') ?? '';
const MODELS_URL = 'https://models.github.ai/inference/chat/completions';
const KNOWLEDGE_BUDGET = 6000;  // chars of knowledge injected per call — kept small so the request
                                // fits even strict models (e.g. GitHub Models gpt-5-mini = 4000 input tokens)
const HISTORY_CHAR_CAP = 3000;  // cap recent-history chars for the same reason
const HISTORY_TURNS = 10;       // most-recent messages considered for memory

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const admin = createClient(SUPABASE_URL, SERVICE_ROLE, { auth: { persistSession: false, autoRefreshToken: false } });
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...cors, 'Content-Type': 'application/json' } });

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  try {
    if (!GPT_TOKEN) return json({ error: 'GPT_TOKEN not configured' }, 500);

    // ── Auth: any active employee ──────────────────────────────────
    const token = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
    if (!token) return json({ error: 'unauthenticated' }, 401);
    const { data: u } = await admin.auth.getUser(token);
    if (!u?.user) return json({ error: 'unauthenticated' }, 401);
    const { data: profile } = await admin.from('profiles')
      .select('display_name, role, is_active').eq('id', u.user.id).maybeSingle();
    if (!profile || profile.is_active === false) return json({ error: 'forbidden' }, 403);

    const body = await req.json().catch(() => ({}));
    const message = String(body?.message || '').trim();
    let conversationId: string | null = body?.conversationId || null;
    if (!message) return json({ error: 'empty message' }, 400);
    if (message.length > 4000) return json({ error: 'message too long' }, 400);

    // ── Config + guardrail ─────────────────────────────────────────
    const { data: cfg } = await admin.from('ai_assistant_config').select('*').eq('id', 1).maybeSingle();
    if (cfg && cfg.enabled === false) {
      return json({ error: 'The assistant is currently turned off by an admin.' }, 503);
    }
    const persona = cfg?.persona || 'You are the WurxOS assistant. Answer only from the provided knowledge; stay on WurxOS topics.';
    const model = cfg?.model || 'openai/gpt-4o-mini';

    // ── Conversation (own it, or create) ───────────────────────────
    if (conversationId) {
      const { data: conv } = await admin.from('ai_conversations')
        .select('id, user_id').eq('id', conversationId).maybeSingle();
      if (!conv || conv.user_id !== u.user.id) return json({ error: 'conversation not found' }, 404);
    } else {
      const title = message.slice(0, 60);
      const { data: created, error: cErr } = await admin.from('ai_conversations')
        .insert({ user_id: u.user.id, title }).select('id').single();
      if (cErr) return json({ error: cErr.message }, 500);
      conversationId = created.id;
    }

    // ── Knowledge (RAG) — pick the docs most relevant to THIS question
    //    and cap the size, so the request fits the model's input limit
    //    instead of stuffing the whole knowledge base into every call. ──
    const { data: docs } = await admin.from('ai_assistant_docs')
      .select('title, content').eq('is_active', true).order('updated_at', { ascending: false });
    const STOP = new Set(['the','a','an','to','how','do','does','i','what','is','are','my','of','in','on','for','and','me','about','this','that','you','your','with','it','at','be','or','as','will','can','please','need','want','where','when','who','why','from','our','we','us']);
    const terms = (message.toLowerCase().match(/[a-z0-9']+/g) || []).filter((w) => w.length > 2 && !STOP.has(w));
    const scored = (docs || []).map((d) => {
      const hay = `${d.title} ${d.title} ${d.title} ${d.content}`.toLowerCase(); // weight the title
      let score = 0;
      for (const t of terms) { let i = 0; while ((i = hay.indexOf(t, i)) !== -1) { score++; i += t.length; } }
      return { d, score };
    }).sort((a, b) => b.score - a.score);
    let picked = scored.filter((s) => s.score > 0).map((s) => s.d);
    if (picked.length === 0) picked = (docs || []).slice(0, 2); // no keyword hit → a little general context
    let knowledge = '';
    for (const d of picked) {
      const block = `\n\n## ${d.title}\n${d.content}`;
      if (knowledge.length && knowledge.length + block.length > KNOWLEDGE_BUDGET) break; // always include the top match
      knowledge += block;
    }
    const knowledgeBlock = knowledge
      ? `WURXOS KNOWLEDGE (answer only from this):${knowledge}`
      : 'No knowledge has been added yet — if you cannot answer from general WurxOS context, say so and suggest asking the Team Lead or Boss.';

    // ── History (memory) ───────────────────────────────────────────
    const { data: history } = await admin.from('ai_messages')
      .select('role, content').eq('conversation_id', conversationId)
      .order('created_at', { ascending: false }).limit(HISTORY_TURNS);
    // Keep only the most recent turns within a char cap (newest-first, then re-order).
    const trimmed = [];
    let histChars = 0;
    for (const m of history || []) { // already newest-first
      histChars += (m.content || '').length;
      if (histChars > HISTORY_CHAR_CAP) break;
      trimmed.push(m);
    }
    const priorTurns = trimmed.reverse().map((m) => ({ role: m.role, content: m.content }));

    const systemPrompt = `${persona}\n\nThe employee you are helping is ${profile.display_name || 'a team member'} (role: ${profile.role || 'staff'}).\n\n${knowledgeBlock}`;

    // ── Call the model ─────────────────────────────────────────────
    const aiRes = await fetch(MODELS_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${GPT_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        messages: [{ role: 'system', content: systemPrompt }, ...priorTurns, { role: 'user', content: message }],
        max_tokens: 800,
        temperature: 0.3,
      }),
    });
    const aiText = await aiRes.text();
    if (!aiRes.ok) {
      console.error('model error', aiRes.status, aiText.slice(0, 300));
      return json({ error: `AI service error (${aiRes.status}): ${aiText.slice(0, 180)}`, conversationId }, 502);
    }
    let reply = '';
    try { reply = JSON.parse(aiText)?.choices?.[0]?.message?.content || ''; } catch { /* ignore */ }
    if (!reply) reply = 'Sorry, I couldn’t generate a response just now. Please try again.';

    // ── Persist the turn (service role — only writer) ──────────────
    await admin.from('ai_messages').insert([
      { conversation_id: conversationId, role: 'user', content: message },
      { conversation_id: conversationId, role: 'assistant', content: reply },
    ]);
    await admin.from('ai_conversations').update({ updated_at: new Date().toISOString() }).eq('id', conversationId);

    return json({ conversationId, reply });
  } catch (err) {
    console.error('ai-chat failed:', err);
    return json({ error: String(err) }, 500);
  }
});
