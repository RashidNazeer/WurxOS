// ============================================================
// Edge Function: ai-chat
//
// The WurxOS AI Support Assistant backend. Answers are grounded (RAG) in
// Boss-curated knowledge (ai_assistant_docs — WurxOS how-to guides + the
// company SOP library) plus a Boss-set persona (ai_assistant_config), with
// persistent per-user memory (ai_conversations / ai_messages).
//
// BOSS-ONLY (test phase): the assistant is locked to the Boss while it is
// being validated on a paid model. Access is enforced HERE (hard 403 for any
// non-Boss caller) as well as hidden in the UI — so it can't be reached by
// hitting the function directly. Widen ALLOWED_ROLES to launch to more roles.
//
// Grounding: pure Knowledge Base RAG — on each question we score the docs by
// relevance and inject only the most relevant ones (whole docs; they're small),
// so the model answers from real SOPs and can't be pushed off-topic. (The old
// brand-report "DATA mode" was removed — this is now a pure knowledge/SOP
// assistant.)
//
// The function is the ONLY writer of ai_messages, so assistant replies can't
// be forged by a client.
//
// Request: { conversationId?: string, message: string }
// Response: { conversationId, reply }
//
// Model: OpenAI (api.openai.com), key in OPEN_AI_API_KEY. NOTE the GPT-5.x
// models require `max_completion_tokens` (not `max_tokens`) and reject a
// non-default `temperature` — both handled below. Model id is overridable via
// ai_assistant_config.model (no redeploy needed to switch).
//
// Env (supabase secrets): OPEN_AI_API_KEY, SUPABASE_URL/SERVICE_ROLE_KEY (auto),
//   SUPABASE_ANON_KEY. (GPT_TOKEN kept as a legacy fallback only.)
// Deploy: supabase functions deploy ai-chat
// ============================================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const OPENAI_KEY = Deno.env.get('OPEN_AI_API_KEY') ?? Deno.env.get('OPENAI_API_KEY') ?? '';
const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY') ?? ''; // used to read KB as the caller (RLS applies)
const OPENAI_URL = 'https://api.openai.com/v1/chat/completions';
const DEFAULT_MODEL = 'gpt-5.4-mini'; // near-latest, cheap, strong at reading SOPs. Override in config.

// Boss-only during the test phase. Add roles here to widen access at launch.
const ALLOWED_ROLES = ['boss'];

// Paid model (128K context) → comfortable budgets. Still RAG-tight for cost:
// we send only the most relevant docs, not the whole library.
const KNOWLEDGE_BUDGET = 14000; // chars of knowledge injected per call
const HISTORY_CHAR_CAP = 4000;  // cap recent-history chars
const HISTORY_TURNS = 12;       // most-recent messages considered for memory
const MAX_COMPLETION_TOKENS = 1000; // output cap (cheap; keeps answers complete)

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
    if (!OPENAI_KEY) return json({ error: 'OPEN_AI_API_KEY not configured' }, 500);

    // ── Auth: active employee, AND role must be allowed ────────────
    const token = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
    if (!token) return json({ error: 'unauthenticated' }, 401);
    const { data: u } = await admin.auth.getUser(token);
    if (!u?.user) return json({ error: 'unauthenticated' }, 401);
    const { data: profile } = await admin.from('profiles')
      .select('display_name, role, is_active').eq('id', u.user.id).maybeSingle();
    if (!profile || profile.is_active === false) return json({ error: 'forbidden' }, 403);
    // Boss-only during the test phase — enforced server-side so it can't be
    // reached by calling the function directly, not just hidden in the UI.
    if (!ALLOWED_ROLES.includes(String(profile.role || '').toLowerCase())) {
      return json({ error: 'The assistant is currently in limited testing and not available for your role yet.' }, 403);
    }

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
    // Config may still hold an old GitHub-Models id like "openai/gpt-4.1".
    // Strip any "openai/" prefix (OpenAI's own API wants the bare id) and fall
    // back to our default if it looks like a non-OpenAI/GitHub-only model.
    const rawModel = String(cfg?.model || '').trim();
    const model = rawModel && !rawModel.includes('/') ? rawModel
      : rawModel.startsWith('openai/') ? rawModel.slice('openai/'.length)
      : DEFAULT_MODEL;

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

    // ── Caller-scoped client (RLS applies) ─────────────────────────
    // Used to read the company Knowledge Base AS THE USER, so the database
    // itself guarantees they only ever see articles they're allowed to.
    const userClient = ANON_KEY
      ? createClient(SUPABASE_URL, ANON_KEY, {
          global: { headers: { Authorization: `Bearer ${token}` } },
          auth: { persistSession: false, autoRefreshToken: false },
        })
      : null;

    let knowledgeBlock: string;
    {
      // ── Knowledge (RAG) — pick the docs most relevant to THIS question
      //    and cap the size, so the request stays focused and cheap instead
      //    of stuffing the whole knowledge base into every call. ──
      const { data: docs } = await admin.from('ai_assistant_docs')
        .select('title, content').eq('is_active', true).order('updated_at', { ascending: false });

      // Company Knowledge Base — queried through the CALLER's own token so
      // Supabase RLS (mig 134) returns only the articles they may see
      // (office/role/users + approved). A role-restricted or private SOP is
      // therefore never surfaced to a user who can't normally see it.
      const useKb = cfg ? cfg.use_kb !== false : true;
      const kbDocs: { title: string; content: string }[] = [];
      if (useKb && userClient) {
        const { data: kb } = await userClient.from('kb_articles')
          .select('id, title, body, url, category, sop_group_id, version')
          .eq('approval_status', 'approved')
          .order('version', { ascending: false });
        const seenGroup = new Set<string>();
        for (const a of kb || []) {          // version desc → first seen per SOP group is the latest
          const key = a.sop_group_id || a.id;
          if (seenGroup.has(key)) continue;
          seenGroup.add(key);
          const body = String(a.body || '').trim();
          const url = String(a.url || '').trim();
          // Most KB articles in this org carry no body text — the real content
          // is an external guide (e.g. a Google Doc) in `url`. Keep those so the
          // assistant can still ROUTE the user to the right document by its link.
          let content = body;
          if (url) content = (body ? `${body}\n\n` : '') + `Full guide (open this link for the steps): ${url}`;
          if (!content) continue;
          kbDocs.push({ title: `[KB · ${a.category || 'General'}] ${a.title}`, content });
        }
      }

      // Unified relevance pool — curated WurxOS how-to guides ranked slightly
      // above the SOP library / KB so "how do I use the app" prefers the guides.
      // Strip the internal import sentinel so it never reaches the model.
      const strip = (s: string) => String(s || '').replace(/\s*<!--wurx-sop-import-->\s*/g, '').trim();
      const pool = [
        ...(docs || []).map((d) => ({ title: d.title, content: strip(d.content), boost: 1.15 })),
        ...kbDocs.map((d) => ({ title: d.title, content: strip(d.content), boost: 1.0 })),
      ];

      // ── Retrieval scoring (keyword, synonym- and stem-aware) ──
      // Free-text keyword match, hardened so wording differences don't miss:
      //  • stem long words (prefix) so submit/submitting/submission all match;
      //  • expand a few high-value domain synonyms onto the query;
      //  • weight title hits heavily; normalise by doc length so a long doc
      //    can't win on sheer size (reward density, not verbosity).
      const STOP = new Set(['the','a','an','to','how','do','does','did','i','what','is','are','was','were','my','of','in','on','for','and','me','about','this','that','you','your','with','it','at','be','or','as','will','can','could','should','would','please','need','want','where','when','who','why','from','our','we','us','have','has','get','got','if','so','any','all','not','no']);
      const stem = (w: string) => (w.length > 6 ? w.slice(0, Math.ceil(w.length * 0.75)) : w);
      // query synonym expansion (mirrors the ingest keyword seeds)
      const SYN: [RegExp, string][] = [
        [/\b(vacation|holiday|time off|pto|day off)\b/i, 'leave'],
        [/\b(clock|check in|check out|punch)\b/i, 'attendance'],
        [/\b(budget|spend|roi|target)\b/i, 'gmv max campaign'],
        [/\b(ad|ads|advert)\b/i, 'campaign'],
        [/\b(influencer|creator|affiliate)\b/i, 'creator outreach'],
        [/\b(banned|prohibited|flagged|restricted|compliance)\b/i, 'violation'],
        [/\b(brief|hook|cta|talking points)\b/i, 'content brief'],
        [/\b(competitor|research|kalodata)\b/i, 'competitor research'],
        [/\b(onboard|new brand|kickoff)\b/i, 'onboarding brand'],
      ];
      let qraw = message.toLowerCase();
      for (const [re, extra] of SYN) if (re.test(qraw)) qraw += ' ' + extra;
      const terms = [...new Set((qraw.match(/[a-z0-9']+/g) || [])
        .filter((w) => w.length > 2 && !STOP.has(w)).map(stem))];

      const scored = pool.map((d) => {
        const title = d.title.toLowerCase();
        const hay = `${title} ${d.content.toLowerCase()}`;
        let hits = 0, titleHits = 0, distinct = 0;
        for (const t of terms) {
          let i = 0, c = 0;
          while ((i = hay.indexOf(t, i)) !== -1) { c++; i += t.length; }
          if (c > 0) { hits += c; distinct++; }
          if (title.includes(t)) titleHits++;
        }
        // length normalisation: divide by sqrt(chars) so long docs don't dominate
        const norm = hits / Math.sqrt(Math.max(300, d.content.length));
        // distinct-term coverage matters more than raw repetition
        const score = (norm + distinct * 0.6 + titleHits * 2.5) * d.boost;
        return { d, score, distinct };
      }).sort((a, b) => b.score - a.score);

      // keep docs that matched at least one query term; else a little general context
      let picked = scored.filter((s) => s.distinct > 0).map((s) => s.d);
      if (picked.length === 0) picked = pool.filter((d) => d.boost > 1).slice(0, 3);

      let knowledge = '';
      let used = 0;
      for (const d of picked) {
        const block = `\n\n## ${d.title}\n${d.content}`;
        if (knowledge.length && knowledge.length + block.length > KNOWLEDGE_BUDGET) break; // always include the top match
        knowledge += block;
        if (++used >= 6) break; // at most 6 docs — keeps the prompt focused & cheap
      }
      knowledgeBlock = knowledge
        ? `KNOWLEDGE (answer using ONLY this — WurxOS app help and the company SOP library):${knowledge}`
        : 'No specific knowledge matched this question. If you can answer from general WurxOS context do so; otherwise say you are not sure and suggest asking the Team Lead or Boss.';
    }

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
      `- The person you are helping is a ${roleLabel}. Explain actions in a way that fits this role, using "WHAT THEY CAN DO" and the page list above.`,
      '- Ground every answer in the KNOWLEDGE above (WurxOS how-to guides and the company SOP library). Prefer quoting the actual steps from the matched SOP.',
      '- If they ask how to do something their role cannot do (e.g. a Boss asking how to apply for leave), do NOT invent steps. Briefly say it is not part of their role and point them to what they CAN do instead.',
      '- Never invent pages, buttons, tools, or steps that are not in the knowledge or the page list. If the knowledge does not cover it, say you are not certain and suggest asking their Team Lead, Operation Lead, or the Boss — do NOT guess.',
      '- MATCH BY MEANING, not exact words. If the user phrases something differently from the SOP (e.g. "time off" vs "leave", "budget" vs "target ROI"), still find and use the relevant SOP; never say you have nothing just because the wording differs.',
      '- If a question is relevant but unclear or could mean several things, ask ONE short clarifying question instead of guessing or refusing.',
      '- When you mention an in-app page, link it INLINE using markdown to its exact path, e.g. [Leave](/leave). Only link to paths in the list above; never invent a path.',
      '- Some knowledge entries are only a title + a link to a full guide. For those, point the user to the guide with a markdown link; recite detailed steps only when the knowledge actually contains them.',
      '- Read short follow-up questions in the context of the conversation so far — they usually continue the previous topic.',
      '- NEVER invent the name of a person, brand, or assignment. If asked who handles something and you were not given that fact, say you do not have it.',
      '- Be concise, warm, and practical; use short numbered steps when describing a flow.',
    ].join('\n');

    const systemPrompt = [
      persona,
      `WHO YOU ARE HELPING: ${profile.display_name || 'a team member'} — role: ${roleLabel}.`,
      `WHAT THEY CAN DO: ${roleCap}`,
      `PAGES THEY CAN OPEN (use these exact paths for links; never invent one):\n${pageList}`,
      knowledgeBlock,
      groundingRules,
    ].join('\n\n');

    // ── Call the model (OpenAI) ────────────────────────────────────
    // GPT-5.x require `max_completion_tokens` (not `max_tokens`) and reject a
    // non-default `temperature` — so we omit temperature and use the new field.
    const aiRes = await fetch(OPENAI_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${OPENAI_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        messages: [{ role: 'system', content: systemPrompt }, ...priorTurns, { role: 'user', content: message }],
        max_completion_tokens: MAX_COMPLETION_TOKENS,
      }),
    });
    const aiText = await aiRes.text();
    if (!aiRes.ok) {
      console.error('model error', aiRes.status, aiText.slice(0, 300));
      if (aiRes.status === 429) {
        return json({ error: `The assistant is busy right now (rate limit). Please wait a moment and try again.`, conversationId }, 429);
      }
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
