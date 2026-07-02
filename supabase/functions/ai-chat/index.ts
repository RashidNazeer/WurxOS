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
      description: 'Resolve an employee by (partial) name to their id, full name and role. Use before other tools when the user names a person.',
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
      description: 'Get client report headline metrics (GMV, orders, samples approved, videos posted, ROI, shop score) for a brand, or across brands. Period is a substring match on the report period label (e.g. "June", "Week 13", "2026-06"); omit for the most recent reports.',
      parameters: {
        type: 'object',
        properties: {
          brand_name: { type: 'string', description: 'Brand name (partial ok); omit for all brands.' },
          period: { type: 'string', description: 'Period label substring, e.g. "June" or "Week 13". Omit for most recent.' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_performance',
      description: "Get monthly performance ratings (0-100 per area: punctuality, reporting, response time, daily-task quality, task processing, overall workflow, plus overall score) for one employee, or for ALL employees ranked by overall score when no name is given. Also returns that person's performance flags (green = positive note, red = concern) and any warnings. Month format YYYY-MM; omit for the latest month with data.",
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

// Run a tool. Returns a compact text block for the model. Boss-only (checked by caller).
async function runTool(admin: any, name: string, args: any): Promise<string> {
  try {
    if (name === 'find_person') {
      const people = await resolvePeople(admin, args?.name);
      if (!people.length) return `No active employee matches "${args?.name}".`;
      return 'Matches:\n' + people.map((p: any) => `- ${p.display_name} (${p.role})`).join('\n');
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
      // attach names
      const ids = [...new Set(rows.map((r: any) => r.user_id))];
      const { data: profs } = await admin.from('profiles').select('id, display_name').in('id', ids);
      const nameOf = new Map((profs || []).map((p: any) => [p.id, p.display_name]));
      const blocks = rows
        .sort((a: any, b: any) => String(nameOf.get(a.user_id)).localeCompare(String(nameOf.get(b.user_id))))
        .map((r: any) => fmtIncentiveRow(nameOf.get(r.user_id) || 'Unknown', r));
      return `Incentives for ${month} (${rows.length} record(s)):\n\n` + blocks.join('\n\n');
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
      let query = admin.from('reports')
        .select('type, period_label, period_start, status, data, brand:brand_id(brand_name)')
        .order('period_start', { ascending: false })
        .limit(args?.brand_name || args?.period ? 40 : 12);
      if (args?.period) query = query.ilike('period_label', `%${String(args.period).trim()}%`);
      const { data: reps } = await query;
      let rows = reps || [];
      if (args?.brand_name) {
        const bn = String(args.brand_name).toLowerCase();
        rows = rows.filter((r: any) => String(r.brand?.brand_name || '').toLowerCase().includes(bn));
      }
      if (!rows.length) return 'No matching reports found.';
      const pick = (o: any) => o?.overallPerformance || {};
      const blocks = rows.slice(0, 20).map((r: any) => {
        const o = pick(r.data);
        const parts = [
          o.gmv != null && o.gmv !== '' ? `GMV ${o.gmv}` : null,
          o.orders != null && o.orders !== '' ? `orders ${o.orders}` : null,
          o.samplesApproved != null && o.samplesApproved !== '' ? `samples ${o.samplesApproved}` : null,
          o.videosPosted != null && o.videosPosted !== '' ? `videos ${o.videosPosted}` : null,
          o.roi != null && o.roi !== '' ? `ROI ${o.roi}` : null,
          o.shopPerformanceScore != null && o.shopPerformanceScore !== '' ? `shop score ${o.shopPerformanceScore}` : null,
        ].filter(Boolean).join(', ');
        return `- ${r.brand?.brand_name || 'Unknown brand'} · ${r.period_label || r.period_start} (${r.type}, ${r.status}): ${parts || 'no headline metrics filled'}`;
      });
      return `Reports (${rows.length} matched, showing ${blocks.length}):\n` + blocks.join('\n');
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

      const metricLabel: Record<string, string> = {
        punctuality: 'Punctuality', reporting: 'Reporting', responseTime: 'Response time',
        dailyTasksQuality: 'Daily-task quality', tasksProcessing: 'Task processing', overallWorkflow: 'Overall workflow',
      };
      const fmtRating = (r: any) => {
        const m = r.metrics || {};
        const parts = Object.keys(metricLabel).filter((k) => m[k] != null).map((k) => `${metricLabel[k]} ${m[k]}`);
        const ov = r.overall_score != null ? Number(r.overall_score).toFixed(1) : '?';
        return `${nameOf.get(r.user_id) || 'Unknown'} — overall ${ov}/100${parts.length ? ` (${parts.join(', ')})` : ''}`;
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
        const sorted = ratings.slice().sort((a: any, b: any) => (Number(b.overall_score) || 0) - (Number(a.overall_score) || 0));
        out += `Performance ratings for ${month} (${ratings.length}):\n` + sorted.map((r: any) => `- ${fmtRating(r)}`).join('\n');
      } else {
        out += `No performance ratings for ${single ? single.display_name : 'anyone'}${whoLabel || ' (no data)'}.`;
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
    if (!message) return json({ error: 'empty message' }, 400);
    if (message.length > 4000) return json({ error: 'message too long' }, 400);

    // ── Config + guardrail ─────────────────────────────────────────
    const { data: cfg } = await admin.from('ai_assistant_config').select('*').eq('id', 1).maybeSingle();
    if (cfg && cfg.enabled === false) {
      return json({ error: 'The assistant is currently turned off by an admin.' }, 503);
    }
    const persona = cfg?.persona || 'You are the WurxOS assistant. Answer only from the provided knowledge; stay on WurxOS topics.';
    // Model is LOCKED in code (not read from config) so a stale or wrong
    // ai_assistant_config.model value can never change or break it. To switch
    // models, edit DEFAULT_MODEL and redeploy — deliberately a dev action.
    const model = DEFAULT_MODEL;

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

    // Boss gets live-data tools; other roles never do (defense in depth — they
    // also can't reach this function at all).
    const isBoss = roleKey === 'boss';
    const dataToolRules = isBoss ? [
      '',
      'LIVE DATA (Boss only): You also have TOOLS to look up real WurxOS data — employee incentives & bonuses, salaries, performance ratings/flags/warnings, client report metrics, and brands. When the question is about actual data (e.g. "what were Ali\'s incentives in June?", "who earned the most bonus?", "how is Ali performing / his ratings?", "who has the best performance score?", "GMV for Solid Gold last month?", "what is X\'s salary?"), CALL THE RELEVANT TOOL and answer from what it returns — do NOT guess numbers or names. Resolve people by name with the tools. Money is PKR; ratings are out of 100. If a tool says a person is ambiguous or not found, ask the user to clarify. If the data genuinely isn\'t returned, say so plainly. For pure how-to/SOP questions, do NOT call tools — answer from the KNOWLEDGE above.',
    ].join('\n') : '';

    const systemPrompt = [
      persona,
      `WHO YOU ARE HELPING: ${profile.display_name || 'a team member'} — role: ${roleLabel}.`,
      `WHAT THEY CAN DO: ${roleCap}`,
      `PAGES THEY CAN OPEN (use these exact paths for links; never invent one):\n${pageList}`,
      knowledgeBlock,
      groundingRules + dataToolRules,
    ].join('\n\n');

    // ── Call the model (OpenAI), with a tool-calling loop for the Boss ──
    // GPT-5.x require `max_completion_tokens` (not `max_tokens`) and reject a
    // non-default `temperature` — so we omit temperature and use the new field.
    // For the Boss we expose data TOOLS: the model may ask us to run a query,
    // we return only those rows, and it answers from them. Loop is bounded so a
    // misbehaving model can't spin forever (and to cap cost).
    const convo: any[] = [{ role: 'system', content: systemPrompt }, ...priorTurns, { role: 'user', content: message }];
    let reply = '';
    const MAX_TOOL_ROUNDS = 4;

    for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
      const payload: any = { model, messages: convo, max_completion_tokens: MAX_COMPLETION_TOKENS };
      // Offer tools only to the Boss, and only while we still allow more rounds.
      if (isBoss && round < MAX_TOOL_ROUNDS) { payload.tools = TOOLS; payload.tool_choice = 'auto'; }

      const aiRes = await fetch(OPENAI_URL, {
        method: 'POST',
        headers: { Authorization: `Bearer ${OPENAI_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const aiText = await aiRes.text();
      if (!aiRes.ok) {
        console.error('model error', aiRes.status, aiText.slice(0, 300));
        if (aiRes.status === 429) {
          return json({ error: `The assistant is busy right now (rate limit). Please wait a moment and try again.`, conversationId }, 429);
        }
        return json({ error: `AI service error (${aiRes.status}): ${aiText.slice(0, 180)}`, conversationId }, 502);
      }

      let choice: any = null;
      try { choice = JSON.parse(aiText)?.choices?.[0]; } catch { /* ignore */ }
      const msg = choice?.message;
      const toolCalls = msg?.tool_calls;

      if (toolCalls && toolCalls.length && isBoss) {
        // Run each requested tool and feed results back for the next round.
        convo.push({ role: 'assistant', content: msg.content ?? null, tool_calls: toolCalls });
        for (const tc of toolCalls) {
          let a: any = {};
          try { a = JSON.parse(tc.function?.arguments || '{}'); } catch { /* ignore */ }
          const result = await runTool(admin, tc.function?.name, a);
          convo.push({ role: 'tool', tool_call_id: tc.id, content: result.slice(0, 8000) });
        }
        continue; // ask the model again now that it has the data
      }

      reply = msg?.content || '';
      break;
    }
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
