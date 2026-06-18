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
const KNOWLEDGE_BUDGET = 4500;  // chars of knowledge injected per call — kept small so the request
                                // fits even strict models (e.g. GitHub Models gpt-5-mini = 4000 input tokens).
                                // Lowered from 6000 to leave room for the role-grounding block below.
const HISTORY_CHAR_CAP = 2500;  // cap recent-history chars for the same reason
const HISTORY_TURNS = 10;       // most-recent messages considered for memory

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const admin = createClient(SUPABASE_URL, SERVICE_ROLE, { auth: { persistSession: false, autoRefreshToken: false } });
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...cors, 'Content-Type': 'application/json' } });

// ── Role grounding ──────────────────────────────────────────────────
// So the assistant answers from what the user's role can ACTUALLY do (it
// once told the Boss how to "apply for leave" — a flow the Boss doesn't have)
// and can hand back real in-app links. Verified against the app:
//   • LeaveRouter.jsx   — boss = approval queue only; everyone else submits.
//   • AttendancePage.jsx — boss has no personal clock-in (team overview only);
//     apc/ipc clock-outs need manager approval.
//   • *ReportsRouter.jsx — boss/ol/developer review all; tl/pctl/apc/ipc author.
const ROLE_LABEL: Record<string, string> = {
  boss: 'Boss (agency owner)',
  ol: 'Operation Lead (OL)',
  tl: 'Team Lead — Affiliate (TL)',
  pctl: 'Paid Collab Team Lead (PCTL)',
  apc: 'Affiliate Program Coordinator (APC)',
  ipc: 'Influencer Program Coordinator (IPC)',
  developer: 'Developer',
};
const ROLE_CAPS: Record<string, string> = {
  boss: 'You run the agency. You REVIEW and APPROVE — you do NOT submit your own leave, clock your own attendance, or author client reports. You approve leave requests, review every report, and manage staff, brands, salaries, holidays, client access and analytics. There is no "apply for leave", "clock in", or "create a report" action for you.',
  ol: 'You oversee teams and brands. You approve leave for your teams, review all reports, run the agenda meetings, and manage client access and team structure. You also do your own employee actions: you submit your own leave and clock your own attendance.',
  tl: "You lead an affiliate team of APCs. You see your team, verify your APCs' reports before they go up, and attend agenda meetings. You also submit your own leave and clock your own attendance.",
  pctl: 'You manage IPCs and the paid-collaboration brands, creators and videos. You submit your own leave and clock your own attendance.',
  apc: 'You manage assigned client brands and author their weekly / bi-weekly / monthly reports (your Team Lead verifies, then the Operation Lead approves). You submit your own leave and clock your own attendance (your clock-out needs manager approval).',
  ipc: 'You work under a Paid Collab Team Lead on influencer / creator work. You submit your own leave and clock your own attendance (your clock-out needs manager approval).',
  developer: 'You handle technical / ops tasks and bug triage. For HR you are a regular employee: you submit your own leave (the Boss approves) and clock your own attendance.',
};

type Page = { path: string; label: string; purpose: string; roles: string[] | 'all' };
const ALL_STAFF = ['boss', 'ol', 'tl', 'pctl', 'apc', 'ipc', 'developer'];
const PAGES: Page[] = [
  { path: '/dashboard', label: 'Dashboard', purpose: 'your home overview', roles: 'all' },
  { path: '/attendance', label: 'Attendance', purpose: 'clock in/out, breaks, your hours (Boss: team overview only)', roles: 'all' },
  { path: '/leave', label: 'Leave', purpose: 'request leave & view your requests (Boss/Dev approver: approval queue)', roles: 'all' },
  { path: '/tasks', label: 'Tasks', purpose: 'your to-dos and assigned work', roles: 'all' },
  { path: '/performance', label: 'Performance', purpose: 'performance metrics', roles: 'all' },
  { path: '/incentives', label: 'Incentives', purpose: 'incentive plans & payouts', roles: 'all' },
  { path: '/me/compensation', label: 'My Compensation', purpose: 'your salary & pay', roles: ['ol', 'tl', 'pctl', 'apc', 'ipc', 'developer'] },
  { path: '/kb', label: 'Knowledge Base', purpose: 'shop / company guidelines', roles: 'all' },
  { path: '/chat', label: 'Team Chat', purpose: 'message teammates', roles: 'all' },
  { path: '/notifications', label: 'Notifications', purpose: 'your alerts', roles: 'all' },
  { path: '/settings', label: 'Settings', purpose: 'your profile & preferences', roles: 'all' },
  { path: '/resources', label: 'Resources', purpose: 'shared files & links', roles: 'all' },
  { path: '/reminders', label: 'Reminders', purpose: 'personal reminders', roles: 'all' },
  { path: '/broadcasts', label: 'Broadcasts', purpose: 'company announcements', roles: 'all' },
  { path: '/suggestions', label: 'Suggestions', purpose: 'submit ideas', roles: 'all' },
  { path: '/bugs', label: 'Bug Reports', purpose: 'report a bug', roles: 'all' },
  { path: '/changes', label: 'Changes', purpose: 'change requests (Boss reviews)', roles: 'all' },
  { path: '/product-campaigns', label: 'Product Campaigns', purpose: 'product campaign tracker', roles: 'all' },
  { path: '/campaigns', label: 'Campaign Tracker', purpose: 'campaign tracking', roles: 'all' },
  { path: '/weekly-reports', label: 'Weekly Reports', purpose: 'weekly client reports', roles: ALL_STAFF },
  { path: '/biweekly-reports', label: 'Bi-Weekly Reports', purpose: 'bi-weekly client reports', roles: ALL_STAFF },
  { path: '/monthly-reports', label: 'Monthly Reports', purpose: 'monthly client reports', roles: ALL_STAFF },
  { path: '/gmv-max', label: 'GMV Max Reporting', purpose: 'GMV Max ad reports', roles: ALL_STAFF },
  { path: '/brands', label: 'Brands', purpose: 'client brands you manage', roles: ['boss', 'ol', 'tl', 'apc', 'ipc', 'developer'] },
  { path: '/agenda/upcoming', label: 'Upcoming Meetings', purpose: 'scheduled agenda meetings', roles: ['boss', 'ol', 'tl', 'apc'] },
  { path: '/agenda/ongoing', label: 'Live Meeting', purpose: 'the agenda meeting in progress', roles: ['boss', 'ol', 'tl', 'apc'] },
  { path: '/agenda/prior', label: 'Past Meetings', purpose: 'previous agenda meetings', roles: ['boss', 'ol', 'tl', 'apc'] },
  { path: '/agenda/tasks', label: 'Agenda Tasks', purpose: 'action items from meetings', roles: ['boss', 'ol', 'tl', 'apc'] },
  { path: '/agenda/resources', label: 'Agenda Resources', purpose: 'meeting resources', roles: ['boss', 'ol', 'tl', 'apc'] },
  { path: '/agenda/settings', label: 'Agenda Settings', purpose: 'configure agenda meetings', roles: ['boss', 'ol', 'developer'] },
  { path: '/paid-collab/dashboard', label: 'Paid Collab Dashboard', purpose: 'paid-collaboration overview', roles: ['pctl'] },
  { path: '/paid-collab/brands', label: 'Paid Collab Brands', purpose: 'paid-collab brands', roles: ['boss', 'ol', 'pctl', 'developer'] },
  { path: '/paid-collab/creators', label: 'Paid Collab Creators', purpose: 'paid-collab creators', roles: ['boss', 'ol', 'pctl', 'developer'] },
  { path: '/paid-collab/videos', label: 'Paid Collab Videos', purpose: 'paid-collab videos', roles: ['boss', 'ol', 'pctl', 'developer'] },
  { path: '/pctl/ipcs', label: 'My IPCs', purpose: 'IPCs you manage', roles: ['pctl'] },
  { path: '/tl/team', label: 'My Team', purpose: 'your team members', roles: ['tl'] },
  { path: '/euka', label: 'Euka Analytics', purpose: 'TikTok Shop analytics', roles: ['boss'] },
  { path: '/client-access', label: 'Client Access', purpose: 'client portal access', roles: ['boss', 'ol', 'developer'] },
  { path: '/team-management', label: 'Team Management', purpose: 'team switching & APC leads', roles: ['boss', 'ol', 'developer'] },
  { path: '/team-hierarchy', label: 'Team Hierarchy', purpose: 'org chart', roles: ['boss', 'ol', 'developer'] },
  { path: '/holidays', label: 'Holidays', purpose: 'company holidays', roles: ['boss'] },
  { path: '/analytics/brands', label: 'Brand Analytics', purpose: 'brand analytics', roles: ['boss', 'ol', 'developer'] },
  { path: '/audit', label: 'Audit Log', purpose: 'system audit log', roles: ['boss', 'ol', 'developer'] },
  { path: '/brand-switcher', label: 'Brand Switcher', purpose: 'reassign brands between APCs', roles: ['boss', 'ol', 'developer'] },
  { path: '/boss/manage/tls', label: 'Manage Affiliate TLs', purpose: 'manage team leads', roles: ['boss'] },
  { path: '/boss/manage/pctls', label: 'Manage Paid Collab TLs', purpose: 'manage paid-collab TLs', roles: ['boss'] },
  { path: '/boss/manage/ols', label: 'Manage Operation Leads', purpose: 'manage OLs', roles: ['boss'] },
  { path: '/boss/manage/apcs', label: 'Manage APCs', purpose: 'manage APCs', roles: ['boss'] },
  { path: '/boss/manage/ipcs', label: 'Manage IPCs', purpose: 'manage IPCs', roles: ['boss'] },
  { path: '/boss/manage/developers', label: 'Manage Developers', purpose: 'manage developers', roles: ['boss'] },
  { path: '/boss/resource-planner', label: 'Resource Planner', purpose: 'plan resourcing', roles: ['boss', 'developer'] },
  { path: '/boss/salaries', label: 'Salary Management', purpose: 'set salaries & payroll', roles: ['boss'] },
];
const pagesForRole = (role: string) =>
  PAGES.filter((p) => p.roles === 'all' || (p.roles as string[]).includes(role));

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

    // ── Role grounding (correctness + real navigation links) ───────
    const roleKey = String(profile.role || '').toLowerCase();
    const roleLabel = ROLE_LABEL[roleKey] || (profile.role || 'team member');
    const roleCap = ROLE_CAPS[roleKey] || 'You are a WurxOS user.';
    const pageList = pagesForRole(roleKey)
      .map((p) => `- ${p.label} (${p.path}): ${p.purpose}`).join('\n');

    const groundingRules = [
      'HOW TO ANSWER:',
      `- The person you are helping is a ${roleLabel}. Only explain actions THIS role can actually do, based on "WHAT THEY CAN DO" and the page list above.`,
      '- If they ask how to do something their role cannot do (e.g. a Boss asking how to apply for leave), do NOT invent steps. Briefly say it is not part of their role and point them to what they CAN do instead.',
      '- Never invent pages, buttons, or steps that are not supported by the knowledge or the page list. If you do not know, say so and suggest asking their Team Lead, Operation Lead, or the Boss.',
      '- When you mention a page, link it INLINE using markdown to its exact path, e.g. [Leave](/leave). Only link to paths in the list above; never show a bare URL or invent a path.',
      '- Be concise and friendly; use short numbered steps when describing a flow.',
    ].join('\n');

    const systemPrompt = [
      persona,
      `WHO YOU ARE HELPING: ${profile.display_name || 'a team member'} — role: ${roleLabel}.`,
      `WHAT THEY CAN DO: ${roleCap}`,
      `PAGES THEY CAN OPEN (use these exact paths for links; never invent one):\n${pageList}`,
      knowledgeBlock,
      groundingRules,
    ].join('\n\n');

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
