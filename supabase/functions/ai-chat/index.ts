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
const EMBED_URL = 'https://api.openai.com/v1/embeddings';
const EMBED_MODEL = 'text-embedding-3-small'; // 1536-dim; matches tts_knowledge.embedding
const DEFAULT_MODEL = 'gpt-5.4-mini'; // default: fast + cheap, strong at reading SOPs.
// The Boss may switch the assistant model in the Train tab, but ONLY to a
// vetted model in this allow-list — so a typo/stale/incompatible model can
// never break the assistant. Both are GPT-5.x (use max_completion_tokens, no
// temperature). Add a new option here to offer it in the Train dropdown.
const ALLOWED_MODELS = ['gpt-5.4-mini', 'gpt-5.5'];

// Embed one query string for TikTok-Academy semantic retrieval. Returns null
// on any failure so retrieval degrades to keyword-only rather than erroring.
async function embedQuery(text: string): Promise<number[] | null> {
  try {
    const res = await fetch(EMBED_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${OPENAI_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: EMBED_MODEL, input: text.slice(0, 8000) }),
    });
    if (!res.ok) return null;
    const j = await res.json();
    return j?.data?.[0]?.embedding ?? null;
  } catch { return null; }
}

// Boss-only during the test phase. Add roles here to widen access at launch.
const ALLOWED_ROLES = ['boss'];

// Paid model (128K context) → comfortable budgets. Still RAG-tight for cost:
// we send only the most relevant docs, not the whole library.
const KNOWLEDGE_BUDGET = 14000; // chars of WurxOS/SOP knowledge injected per call
const TTS_KNOWLEDGE_BUDGET = 9000; // chars of TikTok Shop Academy knowledge (separate budget)
const HISTORY_CHAR_CAP = 4000;  // cap recent-history chars
const HISTORY_TURNS = 12;       // most-recent messages considered for memory
// Output cap. GPT-5.x reasoning models spend this budget on BOTH hidden
// reasoning AND the visible answer, so too small a cap can leave nothing for
// the answer — a heavy ask ("analyze all of a brand's reports + action plan")
// once burned the whole 1000 on reasoning and returned EMPTY content (a blank
// bubble). 2500 is enough for a thorough report analysis + action plan while
// staying cheap on gpt-5.4-mini (output tokens are the pricey part).
const MAX_COMPLETION_TOKENS = 2500;
// Larger cap used ONLY to retry once when the first answer came back empty
// (reasoning ate the budget) — so a heavy turn still produces something
// instead of a blank bubble. Rare, so the extra cost is paid rarely.
const MAX_COMPLETION_TOKENS_RETRY = 6000;
// TOOL rounds don't need a big output budget — the model is only picking a
// query and (usually) emitting a short tool call, not prose. Keeping this
// small stops each of the (up to 4) tool rounds from reserving 2500 tokens of
// pricey output headroom it never uses.
const MAX_TOOL_ROUND_TOKENS = 1200;

// ── Cost controls (see below) ──────────────────────────────────────
// A single question must NEVER run away in cost, no matter how much data or
// history it touches. Three guards work together:
//
//  1) COST_CEILING_TOKENS — a hard per-request backstop. We sum the tokens
//     OpenAI reports across EVERY model call in one question; once we cross
//     this ceiling we stop making further calls (no extra tool round, no big
//     retry) and answer with what we already have. This is what guarantees a
//     heavy/pathological question can't cost dollars. ~60k total tokens is only
//     a few cents on gpt-5.4-mini even in the worst case, yet far above a
//     normal question (a few k), so it only ever trips on a runaway.
//  2) REASONING_EFFORT — gpt-5.x are REASONING models: they spend hidden
//     "thinking" tokens you pay for as output, and an open-ended ask ("analyze
//     all of a brand's reports and say why sales dropped") makes them think a
//     LOT. This assistant rarely needs deep reasoning — tool rounds just pick a
//     query, and answers summarise data the tools already computed. Keeping
//     effort LOW is the single biggest cost lever, and it ALSO reduces the
//     empty-answer retries (less reasoning = less chance reasoning eats the
//     whole token budget and returns a blank). Raise to 'medium' if depth ever
//     suffers.
//  3) TOOL_RESULT_CHAR_CAP — hard bound on how much a single tool result can
//     add to the conversation (which gets re-sent as input on later rounds), so
//     a data-heavy answer can't balloon the prompt as the DB grows.
const COST_CEILING_TOKENS = 60000;
const REASONING_EFFORT = 'low';
const TOOL_RESULT_CHAR_CAP = 6000;

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const admin = createClient(SUPABASE_URL, SERVICE_ROLE, { auth: { persistSession: false, autoRefreshToken: false } });
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...cors, 'Content-Type': 'application/json' } });

// ── SSE streaming helpers ──────────────────────────────────────────
// Wire format (one JSON object per `data:` line):
//   {"status":"..."}                      — live "what I'm doing now" label
//   {"delta":"..."}                       — a chunk of answer text
//   {"done":true,"conversationId":"..."}  — end of stream
//   {"error":"..."}                       — failure (client shows it)
const sseHeaders = { ...cors, 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache', Connection: 'keep-alive' };
const sseLine = (obj: unknown) => `data: ${JSON.stringify(obj)}\n\n`;

// Run the WHOLE conversation inside one SSE stream: emit live {status} events
// while tool rounds run ("Checking incentives…"), then stream the answer as
// {delta} events, persist, and finish with {done}. This is what lets the user
// see what the assistant is doing instead of a generic "Thinking…".
function streamConversation(opts: {
  convo: any[]; model: string; isBoss: boolean; cid: string;
  admin: any; persist: (reply: string) => Promise<void>; kbStatus: string;
}): Response {
  const { convo, model, isBoss, cid, admin, persist, kbStatus } = opts;
  const enc = new TextEncoder();
  const dec = new TextDecoder();
  // 2 rounds covers the real need: round 1 picks tools (e.g. find brand +
  // get_reports, which can run together), round 2 lets the model add ONE more
  // lookup if needed — then it answers. Rounds 3–4 almost never added a new
  // tool call; they just re-sent the whole (now-large) conversation to the
  // model again, re-billing every tool payload as input. That re-billing was
  // the bulk of the per-question cost. Lowering to 2 is the biggest input cut.
  const MAX_TOOL_ROUNDS = 2;

  const out = new ReadableStream({
    async start(controller) {
      const emit = (obj: unknown) => controller.enqueue(enc.encode(sseLine(obj)));
      const callOpenAI = (body: unknown) => fetch(OPENAI_URL, {
        method: 'POST',
        headers: { Authorization: `Bearer ${OPENAI_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      let full = '';
      let answered = false;
      let tokensUsed = 0; // running total across every model call this request (cost backstop)

      try {
        // Initial status while we figure out what to do.
        emit({ status: isBoss ? 'Thinking…' : kbStatus });

        // ── Tool-calling rounds (Boss only), emitting a status per tool ──
        for (let round = 0; round < (isBoss ? MAX_TOOL_ROUNDS : 0); round++) {
          // Cost backstop: if earlier rounds already spent the ceiling, stop
          // fetching more data and go straight to writing the answer.
          if (tokensUsed >= COST_CEILING_TOKENS) break;
          const r = await callOpenAI({ model, messages: convo, max_completion_tokens: MAX_TOOL_ROUND_TOKENS, reasoning_effort: REASONING_EFFORT, tools: TOOLS, tool_choice: 'auto' });
          if (!r.ok) {
            const t = await r.text().catch(() => '');
            console.error('model error (stream tool round)', r.status, t.slice(0, 200));
            emit({ error: r.status === 429 ? 'The assistant is busy right now (rate limit). Please wait a moment and try again.' : `AI service error (${r.status}).` });
            controller.close(); return;
          }
          let parsed: any = null;
          try { parsed = JSON.parse(await r.text()); } catch { /* ignore */ }
          tokensUsed += Number(parsed?.usage?.total_tokens) || 0;
          const m = parsed?.choices?.[0]?.message;
          const toolCalls = m?.tool_calls;
          if (toolCalls && toolCalls.length) {
            // Show the user what we're fetching (first tool's label is enough).
            emit({ status: TOOL_STATUS[toolCalls[0]?.function?.name] || 'Looking that up…' });
            convo.push({ role: 'assistant', content: m.content ?? null, tool_calls: toolCalls });
            for (const tc of toolCalls) {
              let a: any = {};
              try { a = JSON.parse(tc.function?.arguments || '{}'); } catch { /* ignore */ }
              const result = await runTool(admin, tc.function?.name, a);
              convo.push({ role: 'tool', tool_call_id: tc.id, content: result.slice(0, TOOL_RESULT_CHAR_CAP) });
            }
            continue;
          }
          // Model produced the answer directly during a tool round → stream it out.
          const direct = m?.content || '';
          if (direct) {
            emit({ status: 'Writing the answer…' });
            for (let i = 0; i < direct.length; i += 24) emit({ delta: direct.slice(i, i + 24) });
            full = direct; answered = true;
          }
          break;
        }

        // ── Final streamed answer (if not already produced) ──
        if (!answered) {
          emit({ status: 'Writing the answer…' });
          const r = await callOpenAI({ model, messages: convo, max_completion_tokens: MAX_COMPLETION_TOKENS, reasoning_effort: REASONING_EFFORT, stream: true, stream_options: { include_usage: true } });
          if (!r.ok || !r.body) {
            const t = await r.text().catch(() => '');
            console.error('model error (stream final)', r.status, t.slice(0, 200));
            emit({ error: r.status === 429 ? 'The assistant is busy right now (rate limit). Please wait a moment and try again.' : `AI service error (${r.status}).` });
            controller.close(); return;
          }
          const reader = r.body.getReader();
          let buf = '';
          while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            buf += dec.decode(value, { stream: true });
            const lines = buf.split('\n');
            buf = lines.pop() || '';
            for (const line of lines) {
              const s = line.trim();
              if (!s.startsWith('data:')) continue;
              const payload = s.slice(5).trim();
              if (payload === '[DONE]') continue;
              try {
                const j = JSON.parse(payload);
                const delta = j?.choices?.[0]?.delta?.content;
                if (delta) { full += delta; emit({ delta }); }
                // Final usage chunk (include_usage) has empty choices — capture it.
                if (j?.usage) tokensUsed += Number(j.usage.total_tokens) || 0;
              } catch { /* ignore keep-alive / partial */ }
            }
          }
        }

        // Empty answer? On a reasoning model this means reasoning consumed the
        // whole token budget with nothing left to write (a heavy analytical ask
        // — "analyze all of a brand's reports + action plan" — does this). Retry
        // ONCE, non-streamed, with a much larger cap so the user gets a real
        // answer instead of a blank bubble.
        // Only pay for the larger retry if we're still under the cost ceiling.
        if (!full && tokensUsed < COST_CEILING_TOKENS) {
          emit({ status: 'Composing a detailed answer…' });
          const r2 = await callOpenAI({ model, messages: convo, max_completion_tokens: MAX_COMPLETION_TOKENS_RETRY, reasoning_effort: REASONING_EFFORT });
          if (r2.ok) {
            let text = '';
            try {
              const j2 = JSON.parse(await r2.text());
              tokensUsed += Number(j2?.usage?.total_tokens) || 0;
              text = j2?.choices?.[0]?.message?.content || '';
            } catch { /* ignore */ }
            if (text) { for (let i = 0; i < text.length; i += 24) emit({ delta: text.slice(i, i + 24) }); full = text; }
          }
        }
      } catch (e) {
        console.error('streamConversation error', e);
        emit({ error: 'Something went wrong generating the answer. Please try again.' });
        controller.close(); return;
      }

      console.log('ai-chat tokens (stream)', tokensUsed);
      if (!full) full = 'Sorry, I couldn’t generate a response just now. Please try again.';
      try { await persist(full); } catch (e) { console.error('persist after stream failed', e); }
      emit({ done: true, conversationId: cid });
      controller.close();
    },
  });
  return new Response(out, { headers: sseHeaders });
}

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
  { path: '/halo', label: 'Amazon Halo Effect', purpose: 'correlate TikTok vs Amazon daily metrics (halo lag, heatmap, overlay)', roles: ['boss', 'ol'] },
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

// ════════════════════════════════════════════════════════════════════
// BOSS DATA TOOLS (tool-calling)
// The Boss can ask about live OS data (reports, brands, incentives/bonuses,
// salaries). Instead of stuffing tables into the prompt, the model CHOOSES a
// tool; we run a FIXED, parameterized query (never model-authored SQL) and feed
// back only those rows — so token use stays tiny and the model can't be tricked
// into reading anything outside these queries. Gated to Boss callers only.
//
// Queries use the service-role `admin` client (RLS bypass) — safe because the
// caller is already verified Boss, who can see all of this in the app anyway.
// ════════════════════════════════════════════════════════════════════

const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'find_person',
      description: "Look up one employee's profile by (partial) name — full name, role, manager, employment type, start date, responsibilities, email, active status. Use for 'who is X / tell me about X', and before other tools when the user names a person. For salary/incentives/performance/attendance/leave, also call the matching tool.",
      parameters: {
        type: 'object',
        properties: { name: { type: 'string', description: 'Full or partial employee name, e.g. "Ali" or "Abdul Subhan".' } },
        required: ['name'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_employees',
      description: "List employees — the whole team, or filtered by role and/or a name search. Returns name, role, manager, employment type, and start date. Use for 'list all employees', 'who are the APCs', 'show the team', 'how many TLs do we have'. For one person's full detail use find_person.",
      parameters: {
        type: 'object',
        properties: {
          role: { type: 'string', enum: ['boss', 'ol', 'tl', 'pctl', 'apc', 'ipc', 'developer'], description: 'Filter to a single role; omit for everyone.' },
          search: { type: 'string', description: 'Optional name substring to filter by.' },
          include_inactive: { type: 'boolean', description: 'Include deactivated/ex employees; default false (active only).' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_incentives',
      description: "Get monthly incentive & bonus goals (target vs achieved, PKR amount, completed/verified/paid) for one employee, or for ALL employees when no name is given. Month format YYYY-MM; omit for the latest month with data.",
      parameters: {
        type: 'object',
        properties: {
          person_name: { type: 'string', description: 'Employee name; omit to get everyone (e.g. for ranking/totals).' },
          month: { type: 'string', description: 'YYYY-MM, e.g. "2026-06". Omit for the latest month that has data.' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_salary',
      description: 'Get current basic salary (PKR) and recent change history for one employee, or for ALL employees when no name is given. The Boss has no salary and is excluded.',
      parameters: {
        type: 'object',
        properties: { person_name: { type: 'string', description: 'Employee name; omit to list everyone.' } },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_reports',
      description: "Get client report data (weekly, biweekly, or monthly). IMPORTANT for cost: request ONLY the sections the question needs via `sections`. If the user asks just for GMV or a metric, use ['metrics'] — do NOT pull insights/tables. Use ['all'] only when they want the whole/full report for a specific brand+period. Period is a substring match on the report label (e.g. \"June\", \"Week 13\", \"2026-06\").",
      parameters: {
        type: 'object',
        properties: {
          brand_name: { type: 'string', description: 'Brand name (partial ok); omit for all brands.' },
          period: { type: 'string', description: 'Period label substring, e.g. "June" or "Week 13". Omit for most recent.' },
          type: { type: 'string', enum: ['weekly', 'biweekly', 'monthly'], description: 'Report type; omit for any.' },
          sections: {
            type: 'array',
            description: "Which parts to return. Pick the MINIMUM needed. Options: 'metrics' (GMV, orders, samples, videos, ROI, shop score, offsite), 'insights' (written analysis per area), 'creators' (top creators), 'videos' (top videos), 'gmvmax' (GMV Max ad campaigns), 'products' (product highlights/analytics), 'written' (recommendations, action items, upcoming campaigns, operational updates), or 'all' for the complete report. Default is ['metrics'].",
            items: { type: 'string', enum: ['metrics', 'insights', 'creators', 'videos', 'gmvmax', 'products', 'written', 'all'] },
          },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_performance',
      description: "Get monthly performance for one employee, or for ALL employees ranked when no name is given. The HEADLINE is the composite score + level (the same number the Performance page shows — a weighted blend of the manager-metrics pillar, incentives, attendance and flags). Also returns the 5 manager metrics (reporting, response time, daily-task quality, task processing, overall workflow) as supporting detail, plus that person's performance flags (green = positive note, red = concern) and any warnings. Month format YYYY-MM; omit for the latest month with data.",
      parameters: {
        type: 'object',
        properties: {
          person_name: { type: 'string', description: 'Employee name; omit to get everyone (e.g. for ranking).' },
          month: { type: 'string', description: 'YYYY-MM, e.g. "2026-06". Omit for the latest month that has ratings.' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_attendance',
      description: "Get attendance for one employee, or a team summary when no name is given. Returns a SUMMARY by default: the canonical attendance % (the same figure the Roster/Performance pages show — it folds in approved leave, holidays and manager adjustments, so it is NOT a raw clock-in count), days present, coverage, and hours worked. Set detail=true ONLY when the user wants the individual day-by-day log. For the current month the % is coverage so far. Month format YYYY-MM; omit for the current/most-recent month with data.",
      parameters: {
        type: 'object',
        properties: {
          person_name: { type: 'string', description: 'Employee name; omit for a team-wide summary.' },
          month: { type: 'string', description: 'YYYY-MM, e.g. "2026-06". Omit for the latest month with attendance.' },
          detail: { type: 'boolean', description: 'true = list individual days (capped); false/omit = just the summary. Keep false unless day-level detail is asked for.' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_leave',
      description: "Get leave requests for one employee, or across everyone. Filter by status (approved/pending/rejected/cancelled) and/or type (wfh, emergency, medical, half_leave). Month filters by the leave's start date (YYYY-MM). Compact one line per request.",
      parameters: {
        type: 'object',
        properties: {
          person_name: { type: 'string', description: 'Employee name; omit for everyone.' },
          status: { type: 'string', enum: ['approved', 'pending', 'rejected', 'cancelled'], description: 'Filter by decision status.' },
          type: { type: 'string', enum: ['wfh', 'emergency', 'medical', 'half_leave'], description: 'Filter by leave type.' },
          month: { type: 'string', description: 'YYYY-MM on the start date; omit for all/recent.' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_brands',
      description: 'List client brands with their status and owner. Use for "which brands do we have / who owns X".',
      parameters: { type: 'object', properties: {} },
    },
  },
];

const money = (n: unknown) => {
  const v = Number(n);
  return Number.isFinite(v) ? `PKR ${v.toLocaleString('en-US')}` : String(n ?? '');
};

// Human "what am I doing right now" label per tool — shown live to the user
// while that tool runs (replaces a generic "Thinking…").
const TOOL_STATUS: Record<string, string> = {
  find_person: 'Looking up employee info…',
  get_employees: 'Looking up the team directory…',
  get_incentives: 'Checking incentives & bonuses…',
  get_salary: 'Checking salaries…',
  get_performance: 'Reviewing performance data…',
  get_reports: 'Pulling report data…',
  get_attendance: 'Checking attendance…',
  get_leave: 'Checking leave requests…',
  list_brands: 'Looking up brands…',
};

// Rich-text (HTML) insight → clean plain text for the model.
const htmlToText = (s: unknown) => String(s || '')
  .replace(/<\s*(br|\/p|\/li|\/h[1-6]|\/div)\s*>/gi, '\n')
  .replace(/<li[^>]*>/gi, '• ')
  .replace(/<[^>]+>/g, '')
  .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#39;|&rsquo;|&lsquo;/g, "'").replace(/&quot;|&ldquo;|&rdquo;/g, '"')
  .replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();

// Cap any single free-text field so one long report note / insight can't bloat
// the tool payload (which is re-sent as input on later rounds). Summaries, not
// raw blobs — keeps token use flat no matter how much an APC typed in.
const clip = (s: string, n = 500) => (s.length > n ? s.slice(0, n).trimEnd() + '…' : s);

const has = (v: unknown) => v != null && v !== '' && v !== 'N/A';

// Friendly role label (reuses the ROLE_LABEL map defined above; falls back to raw).
const roleLabelOf = (role: unknown) => ROLE_LABEL[String(role || '').toLowerCase()] || String(role || 'unknown');

// milliseconds → "7h 20m"
const hms = (ms: unknown) => {
  const n = Number(ms);
  if (!Number.isFinite(n) || n <= 0) return '0h';
  const h = Math.floor(n / 3_600_000);
  const m = Math.round((n % 3_600_000) / 60_000);
  return `${h}h${m ? ` ${m}m` : ''}`;
};

// The business "this month" in Asia/Karachi — the SINGLE source for the money
// gate "is this month CLOSED" (mirror of src/lib/serverTime.karachiMonth). The
// cluster runs UTC, so a raw new Date() month drifts for the first ~5h of every
// UTC day and at every month boundary; convert through Karachi explicitly.
const karachiMonthNow = (): string => {
  const p = new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Karachi', year: 'numeric', month: '2-digit' }).formatToParts(new Date());
  const y = p.find((x) => x.type === 'year')?.value ?? '';
  const m = p.find((x) => x.type === 'month')?.value ?? '';
  return `${y}-${m}`;
};

// Clock timestamps are stored UTC; the office runs on Pakistan time. Format
// clock-in/out in Asia/Karachi so the assistant states real local times.
const pktTimeFmt = new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Karachi', hour: '2-digit', minute: '2-digit', hour12: false });
const pktTime = (ts: unknown) => (ts ? pktTimeFmt.format(new Date(ts as string)) : '—');

// YYYY-MM → {gte, lt} date-range strings for created_at/date filtering.
const monthToRange = (month: string) => {
  if (!/^\d{4}-\d{2}$/.test(month)) return null;
  const [y, mm] = month.split('-').map(Number);
  const next = mm === 12 ? `${y + 1}-01` : `${y}-${String(mm + 1).padStart(2, '0')}`;
  return { gte: `${month}-01`, lt: `${next}-01` };
};

// Resolve a name → profile rows (active, non-deleted). Returns [] if none.
async function resolvePeople(admin: any, name: string) {
  const q = String(name || '').trim();
  if (!q) return [];
  const { data } = await admin.from('profiles')
    .select('id, display_name, role')
    .ilike('display_name', `%${q}%`)
    .is('deleted_at', null)
    .limit(8);
  return data || [];
}

const goalLine = (g: any) => {
  const tv = g?.targetValue, av = g?.achievedValue, sfx = g?.suffix || '';
  const prog = (tv != null || av != null) ? ` (${av ?? '?'}${sfx} of ${tv ?? '?'}${sfx}${g?.completed ? ', met' : ', not met'})` : '';
  return `    • ${String(g?.text || 'goal').trim()}${prog} — ${money(g?.amount)}`;
};

function fmtIncentiveRow(name: string, row: any): string {
  const inc = Array.isArray(row.incentives) ? row.incentives : [];
  const bon = Array.isArray(row.bonuses) ? row.bonuses : [];
  const sum = (arr: any[]) => arr.reduce((s, g) => s + (g?.completed ? Number(g?.amount) || 0 : 0), 0);
  const earned = sum(inc) + sum(bon);
  const potential = [...inc, ...bon].reduce((s, g) => s + (Number(g?.amount) || 0), 0);
  const lines = [
    `${name} — ${row.month} (basic salary ${money(row.basic_salary)}; verified: ${row.verified ? 'yes' : 'no'}, payout cleared: ${row.payout_cleared ? 'yes' : 'no'})`,
    `  Earned so far (completed goals): ${money(earned)} of ${money(potential)} potential.`,
  ];
  if (inc.length) { lines.push('  Incentives:'); inc.forEach((g) => lines.push(goalLine(g))); }
  if (bon.length) { lines.push('  Bonuses:'); bon.forEach((g) => lines.push(goalLine(g))); }
  return lines.join('\n');
}

// ── Attendance-linked incentive overlay (cross-owner contract C1+C2) ──
// An item flagged { source:'attendance' } stores achievedValue null/0 and
// completed=false BY DESIGN; its real value is derived at READ time from the
// live monthly attendance %. This is the EXACT Deno mirror of
// src/lib/incentivesApi.applyAttendanceAutofill + autoComplete — two
// hand-maintained copies of the same rule; keep them in lock-step or the Boss
// assistant and the Incentives page diverge. Rules:
//   • achievedValue = incentive_attendance_pct(month,user); targetValue = 100;
//     suffix = it.suffix||'%'. Fallback to the stored value when the RPC has no
//     row for a user (missing/pre-migration pct must not zero a real number).
//   • completed ONLY when the month is CLOSED (month < Karachi this-month — the
//     money gate) AND raw ratio achievedValue/targetValue >= 0.9 (C2). Mid-month
//     the running % still SHOWS, but completed stays false.
//   • A payout_cleared row is FROZEN: its paid % was snapshotted server-side at
//     clear time — never re-overlay it; use the stored values verbatim.
const attAutoComplete = (achieved: number, target: number) => (target > 0 ? (achieved / target) >= 0.9 : false);
const hasAttendanceItem = (row: any) =>
  [...(Array.isArray(row?.incentives) ? row.incentives : []), ...(Array.isArray(row?.bonuses) ? row.bonuses : [])]
    .some((it: any) => it && it.source === 'attendance');

async function overlayAttendanceIncentives(admin: any, rows: any[], month: string): Promise<any[]> {
  const list = Array.isArray(rows) ? rows : [];
  // Only non-paid rows with an attendance item need the live pct (paid = frozen).
  const needIds = [...new Set(list.filter((r) => !r?.payout_cleared && hasAttendanceItem(r)).map((r) => r.user_id).filter(Boolean))];
  if (!needIds.length) return list;
  const pctByUser = new Map<string, number>();
  try {
    const { data, error } = await admin.rpc('incentive_attendance_pct', { p_month: month, p_user_ids: needIds });
    if (error) throw error;
    (data || []).forEach((r: any) => pctByUser.set(r.user_id, Number(r.pct) || 0));
  } catch (e) {
    // Fail soft — leave items untouched (stored values) rather than zeroing real
    // numbers, exactly like applyAttendanceAutofill's catch.
    console.warn('ai-chat attendance overlay skipped:', String((e as Error)?.message || e).slice(0, 150));
    return list;
  }
  const monthClosed = String(month) < karachiMonthNow();
  const patch = (it: any, uid: string) => {
    if (!it || it.source !== 'attendance') return it;
    const val = pctByUser.has(uid) ? (pctByUser.get(uid) as number) : (Number(it.achievedValue) || 0);
    return { ...it, achievedValue: val, targetValue: 100, suffix: it.suffix || '%', completed: monthClosed ? attAutoComplete(val, 100) : false };
  };
  return list.map((r) => {
    if (r?.payout_cleared) return r; // frozen — stored values verbatim
    const uid = r.user_id;
    return {
      ...r,
      incentives: (Array.isArray(r.incentives) ? r.incentives : []).map((it: any) => patch(it, uid)),
      bonuses: (Array.isArray(r.bonuses) ? r.bonuses : []).map((it: any) => patch(it, uid)),
    };
  });
}

// ── Commission Based Tier overlay (mig 333) ──────────────────────────
// Same contract as the attendance overlay above: a { source:'commission_tier' }
// item stores amount 0 / completed false BY DESIGN and derives everything at
// read time. Without this the assistant would tell the Boss that an earned
// commission is worth nothing — the single most expensive thing it could get
// wrong about someone's pay.
//
// DELIBERATELY NOT a fourth hand-written copy of the formula. The gate, the
// clamp and the FX conversion live once, in public._commission_state, and this
// calls it — one lookup per distinct (brand, percentage) pair. The attendance
// overlay above is a hand-maintained mirror and has already drifted from its
// JS twin; this one cannot drift because there is nothing here to drift.
const hasCommissionItem = (row: any) =>
  [...(Array.isArray(row?.incentives) ? row.incentives : []), ...(Array.isArray(row?.bonuses) ? row.bonuses : [])]
    .some((it: any) => it && it.source === 'commission_tier' && it.brandId);

async function overlayCommissionIncentives(admin: any, rows: any[], month: string): Promise<any[]> {
  const list = Array.isArray(rows) ? rows : [];
  if (!list.some((r) => !r?.payout_cleared && hasCommissionItem(r))) return list;

  const wanted = new Map<string, { brandId: string; pct: number }>();
  for (const r of list) {
    if (r?.payout_cleared) continue;
    for (const it of [...(r.incentives || []), ...(r.bonuses || [])]) {
      if (it?.source !== 'commission_tier' || !it.brandId) continue;
      const pct = Number(it.commissionPct) || 0;
      wanted.set(`${it.brandId}|${pct}`, { brandId: it.brandId, pct });
    }
  }
  const state = new Map<string, any>();
  try {
    for (const [key, { brandId, pct }] of wanted) {
      const { data, error } = await admin.rpc('_commission_state', { p_brand: brandId, p_month: month, p_pct: pct });
      if (error) throw error;
      if (data) state.set(key, data);
    }
  } catch (e) {
    // Fail soft, like the attendance overlay: stored values rather than a guess.
    console.warn('ai-chat commission overlay skipped:', String((e as Error)?.message || e).slice(0, 150));
    return list;
  }
  const patch = (it: any) => {
    if (!it || it.source !== 'commission_tier' || !it.brandId) return it;
    const s = state.get(`${it.brandId}|${Number(it.commissionPct) || 0}`);
    return s ? { ...it, ...s } : it;
  };
  return list.map((r) => {
    if (r?.payout_cleared) return r; // frozen — stored values verbatim
    return {
      ...r,
      incentives: (Array.isArray(r.incentives) ? r.incentives : []).map(patch),
      bonuses: (Array.isArray(r.bonuses) ? r.bonuses : []).map(patch),
    };
  });
}

// Run a tool. Returns a compact text block for the model. Boss-only (checked by caller).
async function runTool(admin: any, name: string, args: any): Promise<string> {
  try {
    if (name === 'find_person') {
      const q = String(args?.name || '').trim();
      if (!q) return 'Provide a name to look up.';
      const { data: people } = await admin.from('profiles')
        .select('id, display_name, role, email, reports_to, employment_type, start_date, responsibilities, is_active, deleted_at')
        .ilike('display_name', `%${q}%`).is('deleted_at', null).limit(8);
      if (!people || !people.length) return `No active employee matches "${q}".`;
      if (people.length > 1) return `Multiple people match "${q}":\n` + people.map((p: any) => `- ${p.display_name} (${roleLabelOf(p.role)})`).join('\n') + '\nAsk which one.';
      const p = people[0];
      // resolve manager name
      let mgr = '';
      if (p.reports_to) {
        const { data: m } = await admin.from('profiles').select('display_name, role').eq('id', p.reports_to).maybeSingle();
        if (m) mgr = `${m.display_name} (${roleLabelOf(m.role)})`;
      }
      const resp = Array.isArray(p.responsibilities) && p.responsibilities.length ? p.responsibilities.join(', ') : '';
      const lines = [
        `${p.display_name}`,
        `- Role: ${roleLabelOf(p.role)}`,
        p.email ? `- Email: ${p.email}` : null,
        mgr ? `- Reports to: ${mgr}` : (p.role === 'boss' ? null : '- Reports to: (not set)'),
        p.employment_type ? `- Employment: ${p.employment_type}` : null,
        p.start_date ? `- Start date: ${p.start_date}` : null,
        resp ? `- Responsibilities: ${resp}` : null,
        p.is_active === false ? '- Status: INACTIVE' : null,
        '(For this person\'s salary, incentives, performance, attendance or leave, call the matching tool.)',
      ].filter(Boolean);
      return lines.join('\n');
    }

    if (name === 'get_employees') {
      let q = admin.from('profiles')
        .select('display_name, role, reports_to, employment_type, start_date, is_active')
        .order('role', { ascending: true }).order('display_name', { ascending: true }).limit(300);
      if (!args?.include_inactive) q = q.is('deleted_at', null).eq('is_active', true);
      if (args?.role) q = q.eq('role', String(args.role));
      if (args?.search) q = q.ilike('display_name', `%${String(args.search).trim()}%`);
      const { data: emps } = await q;
      if (!emps || !emps.length) return 'No employees match that filter.';
      // manager names
      const mgrIds = [...new Set(emps.map((e: any) => e.reports_to).filter(Boolean))];
      const { data: mgrs } = mgrIds.length
        ? await admin.from('profiles').select('id, display_name').in('id', mgrIds)
        : { data: [] };
      const mgrOf = new Map((mgrs || []).map((m: any) => [m.id, m.display_name]));
      // group by role for a tidy, compact listing
      const byRole = new Map<string, string[]>();
      for (const e of emps) {
        const line = `  - ${e.display_name}${e.employment_type ? ` · ${e.employment_type}` : ''}${e.reports_to && mgrOf.get(e.reports_to) ? ` · reports to ${mgrOf.get(e.reports_to)}` : ''}${e.start_date ? ` · since ${e.start_date}` : ''}${e.is_active === false ? ' · INACTIVE' : ''}`;
        const k = roleLabelOf(e.role);
        (byRole.get(k) || byRole.set(k, []).get(k)!).push(line);
      }
      const out = [...byRole.entries()].map(([role, lines]) => `${role} (${lines.length}):\n${lines.join('\n')}`);
      return `Employees (${emps.length}):\n\n` + out.join('\n\n');
    }

    if (name === 'get_incentives') {
      let userIds: string[] | null = null;
      let label = 'all employees';
      if (args?.person_name) {
        const people = await resolvePeople(admin, args.person_name);
        if (!people.length) return `No active employee matches "${args.person_name}".`;
        if (people.length > 1) return `Multiple people match "${args.person_name}": ${people.map((p: any) => p.display_name).join(', ')}. Ask which one.`;
        userIds = [people[0].id]; label = people[0].display_name;
      }
      // Resolve month: given, else latest month present in the table.
      let month = String(args?.month || '').trim();
      if (!month) {
        const { data: mx } = await admin.from('incentives').select('month').order('month', { ascending: false }).limit(1);
        month = mx?.[0]?.month || '';
      }
      let query = admin.from('incentives')
        .select('user_id, month, basic_salary, incentives, bonuses, verified, payout_cleared')
        .eq('month', month);
      if (userIds) query = query.in('user_id', userIds);
      const { data: rows } = await query;
      if (!rows || !rows.length) return `No incentive records for ${label} in ${month || '(no data)'}.`;
      // Overlay attendance-linked items with the live % + money gate so the AI
      // agrees with the Incentives page (contract C1+C2). fmtIncentiveRow then
      // recomputes "Earned" from the OVERLAID completed flags, not the stale
      // stored ones.
      const orows = await overlayCommissionIncentives(admin, await overlayAttendanceIncentives(admin, rows, month), month);
      // attach names
      const ids = [...new Set(orows.map((r: any) => r.user_id))];
      const { data: profs } = await admin.from('profiles').select('id, display_name').in('id', ids);
      const nameOf = new Map((profs || []).map((p: any) => [p.id, p.display_name]));
      const blocks = orows
        .sort((a: any, b: any) => String(nameOf.get(a.user_id)).localeCompare(String(nameOf.get(b.user_id))))
        .map((r: any) => fmtIncentiveRow(nameOf.get(r.user_id) || 'Unknown', r));
      return `Incentives for ${month} (${orows.length} record(s)):\n\n` + blocks.join('\n\n');
    }

    if (name === 'get_salary') {
      let userIds: string[] | null = null;
      if (args?.person_name) {
        const people = await resolvePeople(admin, args.person_name);
        if (!people.length) return `No active employee matches "${args.person_name}".`;
        if (people.length > 1) return `Multiple people match "${args.person_name}": ${people.map((p: any) => p.display_name).join(', ')}. Ask which one.`;
        userIds = [people[0].id];
      }
      let compQ = admin.from('employee_compensation').select('user_id, basic_salary, effective_from, last_change_reason');
      if (userIds) compQ = compQ.in('user_id', userIds);
      const { data: comp } = await compQ;
      if (!comp || !comp.length) return userIds ? 'No salary on record for that person (the Boss has no salary).' : 'No salary records found.';
      const ids = comp.map((c: any) => c.user_id);
      const { data: profs } = await admin.from('profiles').select('id, display_name, role').in('id', ids);
      const p = new Map((profs || []).map((x: any) => [x.id, x]));
      // recent history for the (single) person, if asked
      let histNote = '';
      if (userIds) {
        const { data: hist } = await admin.from('salary_history')
          .select('effective_from, previous_amount, new_amount, increment_pct, change_reason')
          .eq('user_id', userIds[0]).order('effective_from', { ascending: false }).limit(5);
        if (hist && hist.length) {
          histNote = '\nRecent changes:\n' + hist.map((h: any) =>
            `  - ${h.effective_from}: ${money(h.previous_amount)} → ${money(h.new_amount)}${h.increment_pct != null ? ` (${h.increment_pct}%)` : ''}${h.change_reason ? ` — ${h.change_reason}` : ''}`).join('\n');
        }
      }
      const lines = comp
        .map((c: any) => ({ c, prof: p.get(c.user_id) }))
        .filter((x: any) => x.prof && x.prof.role !== 'boss')
        .sort((a: any, b: any) => (Number(b.c.basic_salary) || 0) - (Number(a.c.basic_salary) || 0))
        .map((x: any) => `- ${x.prof.display_name} (${x.prof.role}): ${money(x.c.basic_salary)} (since ${x.c.effective_from || 'n/a'})`);
      return `Salaries (${lines.length}):\n` + lines.join('\n') + histNote;
    }

    if (name === 'get_reports') {
      // Which sections to include — default to metrics only (cheap).
      let sections: string[] = Array.isArray(args?.sections) && args.sections.length ? args.sections : ['metrics'];
      const wantAll = sections.includes('all');
      const want = (s: string) => wantAll || sections.includes(s);

      // Resolve brand name → ids IN THE DB first, then filter reports by
      // brand_id. (Filtering by name in JS after a small LIMIT could drop the
      // wanted brand if it fell outside the fetched window — real bug hit in
      // testing: "Bentgo Week 12" returned nothing because 18 Week-12 reports
      // existed and Bentgo wasn't in the first few fetched.)
      let brandIds: string[] | null = null;
      if (args?.brand_name) {
        const { data: bmatch } = await admin.from('brands')
          .select('id, brand_name').ilike('brand_name', `%${String(args.brand_name).trim()}%`).limit(20);
        if (!bmatch || !bmatch.length) return `No brand matches "${args.brand_name}".`;
        brandIds = bmatch.map((b: any) => b.id);
      }

      let query = admin.from('reports')
        .select('type, period_label, period_start, status, data, brand:brand_id(brand_name)')
        .order('period_start', { ascending: false });
      if (brandIds) query = query.in('brand_id', brandIds);
      if (args?.type) query = query.eq('type', String(args.type));
      if (args?.period) query = query.ilike('period_label', `%${String(args.period).trim()}%`);
      // Narrow (brand+period) ask may want the full report → few rows; broad
      // scan → more rows but we only print headline lines.
      query = query.limit(args?.brand_name && args?.period ? 8 : (args?.brand_name || args?.period ? 40 : 15));
      const { data: reps } = await query;
      const rows = reps || [];
      if (!rows.length) return 'No matching reports found for that brand/period.';

      // Detail sections cost tokens; only expand detail for a bounded number of
      // reports. If the ask is broad and detail was requested, cap and note it.
      const detailWanted = want('insights') || want('creators') || want('videos') || want('gmvmax') || want('products') || want('written');
      const detailCap = detailWanted ? 3 : 20;

      const metricsLine = (d: any) => {
        const o = d?.overallPerformance || d?.keyMetrics || {};
        const off = d?.offsitePerformance || {};
        const parts = [
          has(o.gmv) ? `GMV ${o.gmv}` : null,
          has(o.affiliateGmv) ? `affiliate GMV ${o.affiliateGmv}` : null,
          has(o.orders) ? `orders ${o.orders}` : null,
          has(o.samplesApproved) ? `samples ${o.samplesApproved}` : null,
          has(o.videosPosted) ? `videos ${o.videosPosted}` : null,
          has(o.roi) ? `ROI ${o.roi}` : null,
          has(o.shopPerformanceScore) ? `shop score ${o.shopPerformanceScore}` : null,
          has(off.offsiteGmv) ? `offsite GMV ${off.offsiteGmv}` : null,
        ].filter(Boolean).join(', ');
        return parts || 'no headline metrics filled';
      };

      const tableBlock = (title: string, arr: any[], cols: [string, string][]) => {
        if (!Array.isArray(arr) || !arr.length) return '';
        const lines = arr.slice(0, 8).map((it: any) => '  - ' + cols.map(([k, lbl]) => has(it[k]) ? `${lbl}: ${it[k]}` : null).filter(Boolean).join(', '));
        return `\n  ${title}:\n${lines.join('\n')}`;
      };

      const insightBlock = (d: any) => {
        const keys: [string, string][] = [
          ['overallInsights', 'Overall'], ['gmvMaxInsights', 'GMV Max'], ['topCreatorsInsights', 'Top creators'],
          ['topVideosInsights', 'Top videos'], ['productHighlightsInsights', 'Products'], ['offsiteInsights', 'Offsite'],
          ['keyWinsInsights', 'Key wins'],
        ];
        const out = keys.map(([k, lbl]) => { const t = clip(htmlToText(d[k])); return t && t.length > 3 ? `  ${lbl}: ${t}` : null; }).filter(Boolean);
        return out.length ? '\n  Insights:\n' + out.join('\n') : '';
      };

      const writtenBlock = (d: any) => {
        const keys: [string, string][] = [
          ['recommendations', 'Recommendations'], ['actionItems', 'Action items'],
          ['upcomingCampaigns', 'Upcoming campaigns'], ['operationalUpdates', 'Operational updates'], ['campaignsText', 'Campaigns'],
        ];
        const out = keys.map(([k, lbl]) => { const t = clip(htmlToText(d[k])); return t && t.length > 3 ? `  ${lbl}: ${t}` : null; }).filter(Boolean);
        return out.length ? '\n  Written sections:\n' + out.join('\n') : '';
      };

      let detailShown = 0;
      const blocks = rows.map((r: any) => {
        const d = r.data || {};
        let block = `- ${r.brand?.brand_name || 'Unknown brand'} · ${r.period_label || r.period_start} (${r.type}, ${r.status})`;
        if (want('metrics') || (!detailWanted)) block += `: ${metricsLine(d)}`;
        if (detailWanted && detailShown < detailCap) {
          if (want('creators')) block += tableBlock('Top creators', d.topCreators, [['name', 'name'], ['gmv', 'GMV'], ['videosPosted', 'videos'], ['itemsSold', 'sold'], ['notes', 'notes']]);
          if (want('videos')) block += tableBlock('Top videos', d.topVideos, [['creatorName', 'creator'], ['gmv', 'GMV'], ['views', 'views'], ['productClicks', 'clicks'], ['videoLink', 'link']]);
          if (want('gmvmax')) block += tableBlock('GMV Max campaigns', d.gmvMax, [['campaign', 'campaign'], ['spend', 'spend'], ['gmv', 'GMV'], ['roi', 'ROI'], ['orders', 'orders'], ['cpo', 'CPO']]);
          if (want('products')) block += tableBlock('Product highlights', d.productHighlights || d.productAnalytics, [['productName', 'product'], ['gmv', 'GMV'], ['unitsSold', 'units'], ['newVideos', 'new videos']]);
          if (want('insights')) block += insightBlock(d);
          if (want('written')) block += writtenBlock(d);
          detailShown++;
        }
        return block;
      });
      let footer = '';
      if (detailWanted && rows.length > detailCap) footer = `\n\n(Showing full detail for the first ${detailCap} of ${rows.length} reports. Ask about a specific brand + period for the rest.)`;
      return `Reports (${rows.length} matched):\n` + blocks.join('\n') + footer;
    }

    if (name === 'get_performance') {
      let userIds: string[] | null = null;
      let single: any = null;
      if (args?.person_name) {
        const people = await resolvePeople(admin, args.person_name);
        if (!people.length) return `No active employee matches "${args.person_name}".`;
        if (people.length > 1) return `Multiple people match "${args.person_name}": ${people.map((p: any) => p.display_name).join(', ')}. Ask which one.`;
        userIds = [people[0].id]; single = people[0];
      }
      // Resolve month: given, else latest month present in ratings.
      let month = String(args?.month || '').trim();
      if (!month) {
        const { data: mx } = await admin.from('performance_ratings').select('month').order('month', { ascending: false }).limit(1);
        month = mx?.[0]?.month || '';
      }
      let rq = admin.from('performance_ratings')
        .select('user_id, month, metrics, overall_score')
        .eq('month', month);
      if (userIds) rq = rq.in('user_id', userIds);
      const { data: ratings } = await rq;

      const ids = [...new Set([...(ratings || []).map((r: any) => r.user_id), ...(userIds || [])])];
      const { data: profs } = ids.length
        ? await admin.from('profiles').select('id, display_name, role').in('id', ids)
        : { data: [] };
      const nameOf = new Map((profs || []).map((p: any) => [p.id, p.display_name]));
      const roleOf = new Map((profs || []).map((p: any) => [p.id, p.role]));

      // Composite headline (contract C3): report the SAME number + level the
      // Performance page shows (calcComposite), via the now-corrected RPC — NOT
      // performance_ratings.overall_score, which is only the manager-metrics
      // pillar and crosses the Good/Warning boundary against the composite.
      // get_performance_composite is SECURITY DEFINER + service-callable, so the
      // admin client can read it. Fetch per resolved user (single → one call;
      // everyone → one per rated user, bounded by staff count).
      const compUserIds = userIds || [...new Set((ratings || []).map((r: any) => r.user_id))].filter(Boolean);
      const compMap = new Map<string, any>();
      await Promise.all(compUserIds.map(async (uid: string) => {
        try {
          const { data: c } = await admin.rpc('get_performance_composite', { p_user: uid, p_month: month });
          if (Array.isArray(c) && c.length) compMap.set(uid, c[0]);
        } catch { /* fall back to metrics avg headline */ }
      }));
      const LEVEL_LABEL: Record<string, string> = { promotion: 'Promotion', good: 'Good', warning: 'Warning', termination: 'Termination' };
      const headlineOf = (uid: string): string | null => {
        const c = compMap.get(uid);
        if (!c) return null;
        // The composite is withheld until the OL verifies the incentive plan
        // (mig 257) — report that, NOT the raw metrics average, or the assistant
        // would silently disagree with the Performance page (which shows a badge).
        if (c.level === 'pending_verification') {
          return 'composite withheld — incentive plan not yet verified by the OL';
        }
        if (c.composite_score == null) return null;   // not rated yet
        const lvl = c.level ? (LEVEL_LABEL[String(c.level)] || String(c.level)) : '';
        return `composite ${Number(c.composite_score).toFixed(1)}/100${lvl ? ` — ${lvl}` : ''}`;
      };
      const compScoreOf = (r: any) => {
        const c = compMap.get(r.user_id);
        if (c && c.level === 'pending_verification') return -1;   // unverified → rank last
        return c && c.composite_score != null ? Number(c.composite_score) : (Number(r.overall_score) || 0);
      };

      // 5 metrics — punctuality was dropped (mig 243). Old rows still carry a
      // punctuality value in metrics jsonb; it no longer counts toward
      // overall_score, so don't report it either.
      const metricLabel: Record<string, string> = {
        reporting: 'Reporting', responseTime: 'Response time',
        dailyTasksQuality: 'Daily-task quality', tasksProcessing: 'Task processing', overallWorkflow: 'Overall workflow',
      };
      const fmtRating = (r: any) => {
        const m = r.metrics || {};
        const parts = Object.keys(metricLabel).filter((k) => m[k] != null).map((k) => `${metricLabel[k]} ${m[k]}`);
        const ov = r.overall_score != null ? Number(r.overall_score).toFixed(1) : '?';
        const nm = nameOf.get(r.user_id) || 'Unknown';
        const head = headlineOf(r.user_id);
        const detail = `manager-metrics avg ${ov}/100${parts.length ? `; ${parts.join(', ')}` : ''}`;
        return head ? `${nm} — ${head} (${detail})` : `${nm} — ${detail}`;
      };

      // Flags + warnings. Scoped to the person if named. When a month is in
      // play, filter by created_at within that month (these tables have no
      // month column, only a timestamp).
      let monthRange: { gte: string; lt: string } | null = null;
      if (month && /^\d{4}-\d{2}$/.test(month)) {
        const [y, mm] = month.split('-').map(Number);
        const next = mm === 12 ? `${y + 1}-01` : `${y}-${String(mm + 1).padStart(2, '0')}`;
        monthRange = { gte: `${month}-01`, lt: `${next}-01` };
      }
      let fq = admin.from('performance_flags').select('user_id, type, severity, reason, created_at').order('created_at', { ascending: false }).limit(userIds ? 30 : 50);
      if (userIds) fq = fq.in('user_id', userIds);
      if (monthRange) fq = fq.gte('created_at', monthRange.gte).lt('created_at', monthRange.lt);
      const { data: flags } = await fq;
      let wq = admin.from('performance_warnings').select('user_id, reason, severity, created_at').order('created_at', { ascending: false }).limit(userIds ? 30 : 50);
      if (userIds) wq = wq.in('user_id', userIds);
      if (monthRange) wq = wq.gte('created_at', monthRange.gte).lt('created_at', monthRange.lt);
      const { data: warns } = await wq;

      // Backfill names for flag/warning owners who had no rating this month
      // (that's why they were showing as "Unknown").
      const extraIds = [...new Set([
        ...(flags || []).map((f: any) => f.user_id),
        ...(warns || []).map((w: any) => w.user_id),
      ])].filter((id) => id && !nameOf.has(id));
      if (extraIds.length) {
        const { data: more } = await admin.from('profiles').select('id, display_name, role').in('id', extraIds);
        (more || []).forEach((p: any) => { nameOf.set(p.id, p.display_name); roleOf.set(p.id, p.role); });
      }

      const whoLabel = month ? ` in ${month}` : '';
      let out = '';
      if (ratings && ratings.length) {
        // Rank by the composite (the page's headline), not the metrics-avg pillar.
        const sorted = ratings.slice().sort((a: any, b: any) => compScoreOf(b) - compScoreOf(a));
        out += `Performance for ${month} (${ratings.length}; headline = composite score / level, same as the Performance page):\n` + sorted.map((r: any) => `- ${fmtRating(r)}`).join('\n');
      } else {
        const head = single && userIds ? headlineOf(userIds[0]) : null;
        out += head
          ? `${single.display_name} — ${head}${whoLabel} (no manager-metric ratings recorded, so the metrics pillar is not rated yet).`
          : `No performance ratings for ${single ? single.display_name : 'anyone'}${whoLabel || ' (no data)'}.`;
      }

      if (flags && flags.length) {
        out += `\n\nFlags${whoLabel} (${flags.length}; green = positive, red = concern):\n` + flags.map((f: any) =>
          `- ${nameOf.get(f.user_id) || 'Unknown'} · ${f.type || '?'}${f.severity ? `/${f.severity}` : ''} (${String(f.created_at).slice(0,10)}): ${String(f.reason || '').slice(0, 300)}`).join('\n');
      } else if (single) {
        out += `\n\nNo performance flags for ${single.display_name}${whoLabel}.`;
      }
      if (warns && warns.length) {
        out += `\n\nWarnings${whoLabel} (${warns.length}):\n` + warns.map((w: any) =>
          `- ${nameOf.get(w.user_id) || 'Unknown'}${w.severity ? ` (${w.severity})` : ''} (${String(w.created_at).slice(0,10)}): ${String(w.reason || '').slice(0, 300)}`).join('\n');
      }
      return out;
    }

    if (name === 'get_attendance') {
      let userIds: string[] | null = null;
      let single: any = null;
      if (args?.person_name) {
        const people = await resolvePeople(admin, args.person_name);
        if (!people.length) return `No active employee matches "${args.person_name}".`;
        if (people.length > 1) return `Multiple people match "${args.person_name}": ${people.map((p: any) => p.display_name).join(', ')}. Ask which one.`;
        userIds = [people[0].id]; single = people[0];
      }
      // Month: given, else the latest month that has attendance.
      let month = String(args?.month || '').trim();
      if (!month) {
        const { data: mx } = await admin.from('attendance').select('date').order('date', { ascending: false }).limit(1);
        month = mx?.[0]?.date ? String(mx[0].date).slice(0, 7) : '';
      }

      // The attendance % is the ONE canonical number every UI surface shows —
      // sourced from attendance_month_breakdown_bulk (mig 252), NOT a raw
      // row-count. That engine folds in approved leave, company holidays and
      // manager adjustments and returns pct = covered/elapsed, so a raw count of
      // `attendance` rows (which ignores all three) is a different, wrong number.
      // The RPC needs an EXPLICIT id array — it can't do "everyone" implicitly —
      // so for the team case we enumerate the active clock-role staff (everyone
      // but the Boss, who has no personal attendance).
      let rpcIds: string[] = userIds || [];
      if (!userIds) {
        const { data: team } = await admin.from('profiles')
          .select('id').is('deleted_at', null).eq('is_active', true).neq('role', 'boss').limit(300);
        rpcIds = (team || []).map((p: any) => p.id);
      }
      let breakdown: any[] = [];
      try {
        const { data: bd, error } = await admin.rpc('attendance_month_breakdown_bulk', { p_month: month, p_user_ids: rpcIds });
        if (error) throw error;
        breakdown = bd || [];
      } catch (e) {
        console.warn('ai-chat attendance breakdown failed:', String((e as Error)?.message || e).slice(0, 150));
      }
      const bdOf = new Map(breakdown.map((b: any) => [b.user_id, b]));

      // Raw `attendance` rows are still needed — but ONLY for hours worked / break
      // time / the day-by-day log. The RPC returns coverage %, not hours.
      const range = monthToRange(month);
      let q = admin.from('attendance').select('user_id, date, clock_in, clock_out, total_work_ms, total_break_ms, status').order('date', { ascending: false });
      if (userIds) q = q.in('user_id', userIds);
      if (range) q = q.gte('date', range.gte).lt('date', range.lt);
      const RAW_CAP = userIds ? 60 : 1500; // one person's month, or team month
      q = q.limit(RAW_CAP);
      const { data: att } = await q;
      const rows = att || [];
      const hoursTruncated = !userIds && rows.length >= RAW_CAP; // team hours may be partial

      // names — everyone in the roster we might print, plus any raw-row owners
      const ids = [...new Set([...rpcIds, ...rows.map((a: any) => a.user_id)])].filter(Boolean);
      const { data: profs } = ids.length ? await admin.from('profiles').select('id, display_name').in('id', ids) : { data: [] };
      const nameOf = new Map((profs || []).map((p: any) => [p.id, p.display_name]));

      // hours aggregate (from raw rows)
      const agg = new Map<string, { days: number; work: number; brk: number }>();
      for (const a of rows) {
        const cur = agg.get(a.user_id) || { days: 0, work: 0, brk: 0 };
        cur.days += 1; cur.work += Number(a.total_work_ms) || 0; cur.brk += Number(a.total_break_ms) || 0;
        agg.set(a.user_id, cur);
      }

      const open = String(month) >= karachiMonthNow(); // current/future month → pct is "so far"
      const soFar = open ? ' (so far this month)' : '';
      const pctPhrase = (uid: string): string | null => {
        const b = bdOf.get(uid);
        if (!b) return null;
        return `${b.pct_display}% attendance (${b.days_present} present of ${b.covered_days} covered, ${b.elapsed_days} elapsed days)`;
      };

      if (userIds && args?.detail) {
        // day-by-day for the single person (capped). Clock times are Pakistan time.
        const lines = rows.slice(0, 40).map((a: any) =>
          `  - ${a.date}: ${hms(a.total_work_ms)} worked (in ${pktTime(a.clock_in)}, out ${pktTime(a.clock_out)}${Number(a.total_break_ms) > 0 ? `, break ${hms(a.total_break_ms)}` : ''})`);
        const s = agg.get(userIds[0]) || { days: 0, work: 0, brk: 0 };
        const pl = pctPhrase(userIds[0]);
        return `Attendance for ${single.display_name} — ${month}${soFar}${pl ? ` — ${pl}` : ''} (hours: ${hms(s.work)} total, avg ${hms(Math.round(s.work / Math.max(1, s.days)))}/day). Clock times below are Pakistan time (PKT).\n${lines.join('\n')}` + (rows.length > 40 ? `\n  …and ${rows.length - 40} more days.` : '');
      }

      if (userIds) {
        const s = agg.get(userIds[0]) || { days: 0, work: 0, brk: 0 };
        const pl = pctPhrase(userIds[0]);
        if (!pl && !rows.length) return `No attendance data for ${single.display_name} in ${month || '(no data)'}.`;
        return `Attendance for ${single.display_name} — ${month}${soFar}: ${pl || 'no coverage data'}. Hours: ${hms(s.work)} total worked (avg ${hms(Math.round(s.work / Math.max(1, s.days)))}/day), ${hms(s.brk)} on breaks.`;
      }

      // team summary — ranked by attendance % (the canonical number)
      const teamRows = rpcIds
        .map((uid) => {
          const b = bdOf.get(uid);
          const s = agg.get(uid) || { days: 0, work: 0, brk: 0 };
          return { name: nameOf.get(uid) || 'Unknown', pct: b ? Number(b.pct) : null, pctDisp: b ? b.pct_display : null, present: b ? b.days_present : s.days, work: s.work };
        })
        .filter((r) => r.pct != null || r.work > 0)
        .sort((a, b) => (b.pct ?? -1) - (a.pct ?? -1));
      if (!teamRows.length) return `No attendance data for ${month || '(no data)'}.`;
      return `Team attendance summary — ${month}${soFar} (${teamRows.length} employees, ranked by attendance %):\n` +
        teamRows.map((r) => `- ${r.name}: ${r.pctDisp != null ? `${r.pctDisp}%` : 'n/a'} (${r.present} present), ${hms(r.work)} worked`).join('\n') +
        (hoursTruncated ? '\n\n(Results may be truncated: the hours query hit its 1500-row limit for this month, so some employees\' hours could be understated. The attendance % is from the canonical engine and is complete.)' : '');
    }

    if (name === 'get_leave') {
      let userIds: string[] | null = null;
      let single: any = null;
      if (args?.person_name) {
        const people = await resolvePeople(admin, args.person_name);
        if (!people.length) return `No active employee matches "${args.person_name}".`;
        if (people.length > 1) return `Multiple people match "${args.person_name}": ${people.map((p: any) => p.display_name).join(', ')}. Ask which one.`;
        userIds = [people[0].id]; single = people[0];
      }
      let q = admin.from('leave_requests')
        .select('requester_id, type, other_title, start_date, end_date, status, reason, paid_days, unpaid_days')
        .order('start_date', { ascending: false });
      if (userIds) q = q.in('requester_id', userIds);
      if (args?.status) q = q.eq('status', String(args.status));
      if (args?.type) q = q.eq('type', String(args.type));
      const range = args?.month ? monthToRange(String(args.month)) : null;
      if (range) q = q.gte('start_date', range.gte).lt('start_date', range.lt);
      const LEAVE_CAP = 60;
      q = q.limit(LEAVE_CAP);
      const { data: lv } = await q;
      if (!lv || !lv.length) return `No leave requests found${single ? ` for ${single.display_name}` : ''}${args?.status ? ` (${args.status})` : ''}${args?.type ? ` of type ${args.type}` : ''}${args?.month ? ` in ${args.month}` : ''}.`;
      const leaveTruncated = lv.length >= LEAVE_CAP;
      const ids = [...new Set(lv.map((l: any) => l.requester_id))];
      const { data: profs } = await admin.from('profiles').select('id, display_name').in('id', ids);
      const nameOf = new Map((profs || []).map((p: any) => [p.id, p.display_name]));
      const span = (l: any) => l.start_date === l.end_date ? l.start_date : `${l.start_date}→${l.end_date}`;
      const paid = (l: any) => {
        const p = Number(l.paid_days) || 0, u = Number(l.unpaid_days) || 0;
        return p || u ? ` [${p ? `${p} paid` : ''}${p && u ? ', ' : ''}${u ? `${u} unpaid` : ''}]` : '';
      };
      const lines = lv.map((l: any) =>
        `- ${nameOf.get(l.requester_id) || 'Unknown'} · ${l.type === 'half_leave' ? 'half leave' : l.type}${l.other_title ? ` (${l.other_title})` : ''} · ${span(l)} · ${l.status}${paid(l)}${l.reason ? ` — ${String(l.reason).slice(0, 120)}` : ''}`);
      return `Leave requests (${lv.length}):\n` + lines.join('\n') +
        (leaveTruncated ? `\n\n(Results may be truncated at ${LEAVE_CAP} requests — narrow by person, status, type or month for a complete list; do not treat this as the full total.)` : '');
    }

    if (name === 'list_brands') {
      const { data: brands } = await admin.from('brands').select('brand_name, status, owner_id').order('brand_name').limit(200);
      if (!brands || !brands.length) return 'No brands found.';
      const ids = brands.map((b: any) => b.owner_id).filter(Boolean);
      const { data: profs } = await admin.from('profiles').select('id, display_name').in('id', ids.length ? ids : ['00000000-0000-0000-0000-000000000000']);
      const nameOf = new Map((profs || []).map((p: any) => [p.id, p.display_name]));
      return `Brands (${brands.length}):\n` + brands.map((b: any) =>
        `- ${b.brand_name} (${b.status || 'n/a'})${b.owner_id ? ` — owner: ${nameOf.get(b.owner_id) || 'unknown'}` : ''}`).join('\n');
    }

    return `Unknown tool: ${name}`;
  } catch (e) {
    return `Tool ${name} failed: ${String((e as Error)?.message || e).slice(0, 150)}`;
  }
}

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
    const wantStream = body?.stream === true; // client opts into SSE token streaming
    if (!message) return json({ error: 'empty message' }, 400);
    if (message.length > 4000) return json({ error: 'message too long' }, 400);

    // ── Config + guardrail ─────────────────────────────────────────
    const { data: cfg } = await admin.from('ai_assistant_config').select('*').eq('id', 1).maybeSingle();
    if (cfg && cfg.enabled === false) {
      return json({ error: 'The assistant is currently turned off by an admin.' }, 503);
    }
    const persona = cfg?.persona || 'You are the WurxOS assistant. Answer only from the provided knowledge; stay on WurxOS topics.';
    // Model comes from config but is GUARDED by an allow-list: the Boss can
    // pick from the vetted options in the Train tab, and anything else (typo,
    // stale value, incompatible model) falls back to the safe default. This
    // keeps Boss choice without letting a bad value break the assistant.
    const model = ALLOWED_MODELS.includes(cfg?.model) ? cfg.model : DEFAULT_MODEL;

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

    // ── Cost guard: skip heavy knowledge retrieval for pure DATA questions ──
    // The SOP/KB + TikTok-Academy retrieval (an embedding API call, a vector
    // query, and up to ~23k chars of knowledge text) is pure waste when the
    // Boss is asking about live OS DATA ("analyze brand X's reports", "who
    // sold most", "Ali's salary") — those are answered by the tools, not the
    // knowledge base, and that big block was being RE-SENT as input on every
    // tool round. Detect a data-style ask and skip the whole block for it.
    // Conservative: only skips when it clearly looks like data AND clearly does
    // NOT look like a how-to / TikTok-Shop question (those still need the KB).
    const callerIsBoss = String(profile.role || '').toLowerCase() === 'boss';
    const qlc = message.toLowerCase();
    const looksHowTo = /\b(how (do|to|can)|where (do|is|can)|what page|which page|steps?|guide|policy|sop|set up|setup|configure|enable|submit|apply for|clock|leave request|tiktok|gmv max|affiliate program|creator|violation|listing|promotion|academy|shop health|sps|ahr)\b/.test(qlc);
    const looksData = callerIsBoss && /\b(report|reports|gmv|orders|sales|revenue|salary|salaries|incentive|bonus|performance|rating|attendance|hours|leave balance|brand|brands|creator[s]? sold|units? sold|action plan|analy[sz]e|analysis|month(ly)?|week(ly)?|june|july|august|q[1-4]|top (creator|product|video)|compare|trend)\b/.test(qlc);
    const skipKnowledge = looksData && !looksHowTo;

    let knowledgeBlock: string;
    if (skipKnowledge) {
      knowledgeBlock = 'No knowledge-base lookup was run for this question (it is a live-data / reporting question — use the data tools).';
    } else {
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

      // ── TikTok Shop Academy knowledge (hybrid semantic + keyword) ──
      // A second retrieval source: official TikTok Shop Academy content
      // ingested into tts_knowledge. Embed the question, run the Boss-gated
      // hybrid RPC (through the caller's client so RLS/is_boss applies), and
      // append the top chunks WITH their source URLs so the model can cite.
      // Degrades silently to nothing if embedding/RPC fails — never blocks.
      if (userClient) {
        const qEmbed = await embedQuery(message);
        if (qEmbed) {
          const { data: tts } = await userClient.rpc('tts_knowledge_search', {
            p_query_embedding: qEmbed,
            p_query_text: message,
            p_match_count: 6,
          });
          if (Array.isArray(tts) && tts.length) {
            let ttsBlock = '';
            let ttsUsed = 0;
            for (const c of tts) {
              const head = [c.breadcrumb, c.title].filter(Boolean).join(' > ');
              const block = `\n\n### ${head}\n${strip(c.chunk_text)}\nSource: ${c.source_url}`;
              if (ttsBlock.length && ttsBlock.length + block.length > TTS_KNOWLEDGE_BUDGET) break;
              ttsBlock += block;
              if (++ttsUsed >= 6) break;
            }
            if (ttsBlock) {
              knowledgeBlock += `\n\nTIKTOK SHOP KNOWLEDGE (official TikTok Shop Academy — use for TikTok Shop questions about ads/GMV Max, affiliate/creators, policy, listings, promotions, etc. Cite the Source link when you use one):${ttsBlock}`;
            }
          }
        }
      }
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
      '- The KNOWLEDGE comes in TWO kinds and you must NOT confuse or mislabel them: (1) the WurxOS how-to guides + company SOP library (about OUR app and internal process), and (2) the TIKTOK SHOP KNOWLEDGE block (official TikTok Shop Academy — about TikTok Shop itself). NEVER call TikTok Shop Academy content "the SOP" / "our knowledge"; NEVER call a WurxOS SOP "TikTok". Attribute each fact to its real source.',
      '- USE BOTH SOURCES TOGETHER. If a question has relevant material in BOTH the WurxOS/SOP knowledge AND the TikTok Shop Academy block, answer from BOTH — do not stop at the first source. Present each side clearly labelled (e.g. a "Per the TikTok Shop Academy" part and a "In WurxOS / our process" part), and then add a short SUMMARY paragraph that ties them together so the user gets one clear takeaway. Only use a single source when the other genuinely has nothing relevant.',
      '- IF THE TWO SOURCES DISAGREE (e.g. the TikTok Shop Academy says one thing and our WurxOS SOP says another, or one says yes and the other no), do NOT silently pick one or average them. State plainly what each source says, flag that they differ, and in the summary advise the user to CONFIRM WITH THEIR TEAM LEAD OR THE BOSS before acting. Never hide a conflict.',
      '- If they ask how to do something their role cannot do (e.g. a Boss asking how to apply for leave), do NOT invent steps. Briefly say it is not part of their role and point them to what they CAN do instead.',
      '- Never invent pages, buttons, tools, or steps that are not in the knowledge or the page list. If the knowledge does not cover it, say you are not certain and suggest asking their Team Lead, Operation Lead, or the Boss — do NOT guess.',
      '- MATCH BY MEANING, not exact words. If the user phrases something differently from the SOP (e.g. "time off" vs "leave", "budget" vs "target ROI"), still find and use the relevant SOP; never say you have nothing just because the wording differs.',
      '- If a question is relevant but unclear or could mean several things, ask ONE short clarifying question instead of guessing or refusing.',
      '- When you mention an in-app page, link it INLINE using markdown to its exact path, e.g. [Leave](/leave). Only link to paths in the list above; never invent a path.',
      '- Some knowledge entries are only a title + a link to a full guide. For those, point the user to the guide with a markdown link; recite detailed steps only when the knowledge actually contains them.',
      '- For TikTok Shop topics (GMV Max / ads, affiliate & creators, product policy, SPS / AHR / violations / shop health, listings, promotions, LIVE, seller setup), the TIKTOK SHOP KNOWLEDGE section is the authoritative source — ALWAYS check it and use it when it has anything relevant, even if the WurxOS SOP already gives a partial answer. ALWAYS end an answer that used it with a markdown link to the article via its Source URL, e.g. [TikTok Shop Academy](<source url>). This citation is REQUIRED whenever you used any TikTok fact.',
      '- Give the concrete guidance the TikTok knowledge contains rather than over-hedging. If the Academy states a specific number, rule, or recommendation, state it plainly as TikTok\'s guidance. Only say "not specified" when the knowledge genuinely lacks it.',
      '- When BRAND LIVE DATA is also relevant (the Boss tools), fold it in too: the TikTok best practice + our WurxOS process/SOP + what the brand\'s actual numbers show, and point to the right WurxOS page for the live view.',
      '- Read short follow-up questions in the context of the conversation so far — they usually continue the previous topic.',
      '- NEVER invent the name of a person, brand, or assignment. If asked who handles something and you were not given that fact, say you do not have it.',
      '- Be concise, warm, and practical; use short numbered steps when describing a flow.',
    ].join('\n');

    // Boss gets live-data tools; other roles never do (defense in depth — they
    // also can't reach this function at all).
    const isBoss = roleKey === 'boss';
    const dataToolRules = isBoss ? [
      '',
      'LIVE DATA (Boss only): You also have TOOLS to look up real WurxOS data — the employee directory (roles, manager, employment type, start date, responsibilities), incentives & bonuses, salaries, performance ratings/flags/warnings, attendance, leave requests, client reports (weekly/biweekly/monthly), and brands. For "who is X / tell me about X" use find_person; for lists like "all employees" or "who are the APCs" use get_employees. For a rich "tell me everything about X", combine find_person with their salary/incentives/performance tools. When the question is about actual data (e.g. "what were Ali\'s incentives in June?", "who earned the most bonus?", "how is Ali performing?", "how many hours did Ali work in June?", "who is on leave / show pending leave requests", "GMV for Solid Gold last week?", "give me the full report for X", "what is Y\'s salary?"), CALL THE RELEVANT TOOL and answer from what it returns — do NOT guess numbers or names. Resolve people by name with the tools. Money is PKR; ratings are out of 100.',
      'ATTENDANCE: get_attendance returns a SUMMARY by default — the canonical attendance % (the same figure the Roster and Performance pages show), days present, coverage, and hours worked — only pass detail=true if the user wants the day-by-day log. The headline is the % (it already accounts for approved leave, holidays and manager adjustments); report it, not a raw day count. Any clock times from the tool are ALREADY in Pakistan time (PKT) — state them as-is, do NOT add hours. For the current month the % is "so far this month" (coverage to date), which is expected.',
      'REPORTS — be token-smart: get_reports takes a `sections` list. Request ONLY what the question needs: just a metric ("GMV for X") → sections=["metrics"]; the written analysis → ["insights"]; top creators/videos/campaigns/products → the matching section; the whole/full report for a specific brand+period → ["all"]. Do not pull insights or tables when only a number was asked. When they want a full report, name the brand AND period so it returns that one report completely.',
      'If a tool says a person is ambiguous or not found, ask the user to clarify. If the data genuinely isn\'t returned, say so plainly. For pure how-to/SOP questions, do NOT call tools — answer from the KNOWLEDGE above.',
    ].join('\n') : '';

    // ── System prompt, ORDERED FOR PROMPT-CACHING ──────────────────
    // OpenAI automatically caches the longest STABLE PREFIX of a request
    // (system message + tool definitions) and bills those cached tokens at a
    // large discount on every subsequent call. So everything IDENTICAL across
    // calls for this role goes FIRST as one stable block — persona, role
    // capabilities, the page list, and all answer/tool RULES — and the things
    // that CHANGE go LAST: the per-user name and the per-question retrieved
    // KNOWLEDGE. Previously the knowledge sat in the MIDDLE, which cut the
    // prefix short and forced the big rules block (plus the tool definitions,
    // re-sent on every one of the up-to-2 tool rounds) to be re-billed at full
    // price every turn. With this order a Boss DATA question — where the name
    // is constant and the knowledge block is a fixed "skipped" string — has a
    // byte-identical static half that is fully cached. DO NOT move the dynamic
    // knowledge/name back above the rules or the cache benefit is lost.
    const systemPrompt = [
      // —— stable prefix (cached across calls for this role) ——
      persona,
      `WHAT THEY CAN DO: ${roleCap}`,
      `PAGES THEY CAN OPEN (use these exact paths for links; never invent one):\n${pageList}`,
      groundingRules + dataToolRules,
      // —— dynamic tail (changes per user / per question; never cached) ——
      `WHO YOU ARE HELPING: ${profile.display_name || 'a team member'} — role: ${roleLabel}.`,
      knowledgeBlock,
    ].join('\n\n');

    // ── Call the model (OpenAI), with a tool-calling loop for the Boss ──
    // GPT-5.x require `max_completion_tokens` (not `max_tokens`) and reject a
    // non-default `temperature` — so we omit temperature and use the new field.
    // Tool rounds run NON-streamed (the model just decides which query to run,
    // no user-visible text). The FINAL answer is streamed to the client when
    // requested. Loop is bounded so a misbehaving model can't spin forever.
    const convo: any[] = [{ role: 'system', content: systemPrompt }, ...priorTurns, { role: 'user', content: message }];
    const MAX_TOOL_ROUNDS = 2; // see streamConversation — 2 covers real need; higher just re-bills tool payloads
    const cid = conversationId;
    // Initial status for a non-tool answer (KB/how-to). Reflects whether the
    // knowledge retrieval actually matched something.
    const kbStatus = knowledgeBlock.startsWith('KNOWLEDGE') ? 'Searching the knowledge base…' : 'Thinking…';

    // Persist helper — writes the user turn + assistant reply once we have it.
    const persist = async (reply: string) => {
      await admin.from('ai_messages').insert([
        { conversation_id: cid, role: 'user', content: message },
        { conversation_id: cid, role: 'assistant', content: reply },
      ]);
      await admin.from('ai_conversations').update({ updated_at: new Date().toISOString() }).eq('id', cid);
    };

    // Streaming path: run the whole thing inside one SSE stream so the client
    // sees live {status} events ("Checking incentives…") then the answer.
    if (wantStream) {
      return streamConversation({ convo, model, isBoss, cid: cid!, admin, persist, kbStatus });
    }

    // ── Non-streaming path (fallback / older clients) ──────────────
    let toolError: Response | null = null;
    let tokensUsed = 0; // running total across every model call this request (cost backstop)
    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      if (!isBoss) break; // only the Boss has tools; go straight to the answer
      if (tokensUsed >= COST_CEILING_TOKENS) break; // cost backstop: stop fetching, go answer
      const aiRes = await fetch(OPENAI_URL, {
        method: 'POST',
        headers: { Authorization: `Bearer ${OPENAI_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, messages: convo, max_completion_tokens: MAX_TOOL_ROUND_TOKENS, reasoning_effort: REASONING_EFFORT, tools: TOOLS, tool_choice: 'auto' }),
      });
      const aiText = await aiRes.text();
      if (!aiRes.ok) {
        console.error('model error (tool round)', aiRes.status, aiText.slice(0, 300));
        toolError = aiRes.status === 429
          ? json({ error: `The assistant is busy right now (rate limit). Please wait a moment and try again.`, conversationId }, 429)
          : json({ error: `AI service error (${aiRes.status}): ${aiText.slice(0, 180)}`, conversationId }, 502);
        break;
      }
      let parsed: any = null;
      try { parsed = JSON.parse(aiText); } catch { /* ignore */ }
      tokensUsed += Number(parsed?.usage?.total_tokens) || 0;
      const m = parsed?.choices?.[0]?.message;
      const toolCalls = m?.tool_calls;
      if (toolCalls && toolCalls.length) {
        convo.push({ role: 'assistant', content: m.content ?? null, tool_calls: toolCalls });
        for (const tc of toolCalls) {
          let a: any = {};
          try { a = JSON.parse(tc.function?.arguments || '{}'); } catch { /* ignore */ }
          const result = await runTool(admin, tc.function?.name, a);
          convo.push({ role: 'tool', tool_call_id: tc.id, content: result.slice(0, TOOL_RESULT_CHAR_CAP) });
        }
        continue;
      }
      const direct = m?.content || '';
      if (direct) { console.log('ai-chat tokens', tokensUsed); await persist(direct); return json({ conversationId, reply: direct }); }
      break;
    }
    if (toolError) return toolError;

    const aiRes = await fetch(OPENAI_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${OPENAI_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, messages: convo, max_completion_tokens: MAX_COMPLETION_TOKENS, reasoning_effort: REASONING_EFFORT }),
    });
    const aiText = await aiRes.text();
    if (!aiRes.ok) {
      console.error('model error', aiRes.status, aiText.slice(0, 300));
      if (aiRes.status === 429) return json({ error: `The assistant is busy right now (rate limit). Please wait a moment and try again.`, conversationId }, 429);
      return json({ error: `AI service error (${aiRes.status}): ${aiText.slice(0, 180)}`, conversationId }, 502);
    }
    let reply = '';
    try {
      const jf = JSON.parse(aiText);
      tokensUsed += Number(jf?.usage?.total_tokens) || 0;
      reply = jf?.choices?.[0]?.message?.content || '';
    } catch { /* ignore */ }
    // Empty answer → reasoning ate the whole budget. Retry once with a larger
    // cap before giving up, so heavy analytical asks still return something —
    // but only while we're still under the per-request cost ceiling.
    if (!reply && tokensUsed < COST_CEILING_TOKENS) {
      const retryRes = await fetch(OPENAI_URL, {
        method: 'POST',
        headers: { Authorization: `Bearer ${OPENAI_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, messages: convo, max_completion_tokens: MAX_COMPLETION_TOKENS_RETRY, reasoning_effort: REASONING_EFFORT }),
      });
      if (retryRes.ok) {
        try {
          const jr = JSON.parse(await retryRes.text());
          tokensUsed += Number(jr?.usage?.total_tokens) || 0;
          reply = jr?.choices?.[0]?.message?.content || '';
        } catch { /* ignore */ }
      }
    }
    if (!reply) reply = 'Sorry, I couldn’t generate a response just now. Please try again.';
    console.log('ai-chat tokens', tokensUsed);
    await persist(reply);
    return json({ conversationId, reply });
  } catch (err) {
    console.error('ai-chat failed:', err);
    return json({ error: String(err) }, 500);
  }
});
