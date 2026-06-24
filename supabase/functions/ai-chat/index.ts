// ============================================================
// Edge Function: ai-chat
//
// The WurxOS AI Support Assistant backend. Any logged-in employee can chat;
// the model is GitHub Models (OpenAI-compatible), called with GPT_TOKEN which
// stays server-side. Answers are grounded (RAG) in Boss-curated knowledge
// (ai_assistant_docs) + a Boss-set persona (ai_assistant_config), with
// persistent per-user memory (ai_conversations / ai_messages).
//
// Two grounding modes, picked per question:
//   • HELP mode  — "how do I use X?" → Knowledge Base RAG (default).
//   • DATA mode  — "which week had the highest GMV?" → the user's OWN brand
//     reports, read with their JWT so RLS (reports_select) scopes the rows to
//     brands they may view. The model only ever sees already-authorized data,
//     so it cannot be prompted into another user's/brand's figures. The KB is
//     skipped in this mode to stay well inside the free-tier token budget.
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
const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY') ?? ''; // used to read KB as the caller (RLS applies)
const MODELS_URL = 'https://models.github.ai/inference/chat/completions';
const KNOWLEDGE_BUDGET = 4500;  // chars of knowledge injected per call — kept small so the request
                                // fits even strict models (e.g. GitHub Models gpt-5-mini = 4000 input tokens).
                                // Lowered from 6000 to leave room for the role-grounding block below.
const HISTORY_CHAR_CAP = 2500;  // cap recent-history chars for the same reason
const HISTORY_TURNS = 10;       // most-recent messages considered for memory
const DATA_BUDGET = 8000;       // chars of brand-report data injected in DATA mode (KB + page list
                                // are skipped in this mode, so there's room for the full breakdowns)
const REPORTS_FETCH_LIMIT = 120; // rows pulled (RLS-scoped) before compacting

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

// ── Data mode (brand-report analytics) ──────────────────────────────
// Lets a user ask about THEIR OWN brands' report metrics ("which week had
// the highest GMV?"). Security is enforced by RLS, NOT by the model: reports
// are fetched with the caller's JWT, so the DB only ever returns brands they
// may view. The model just reasons over the rows it's handed — it can't be
// prompted into fetching anyone else's data, because that data is never read.

// Metric stored as a string like "$12,345.67" / "1,200" / "3.5x" → number|null.
function parseNum(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const s = String(v).replace(/[^0-9.\-]/g, '');
  if (s === '' || s === '-' || s === '.' || s === '-.') return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

// Heuristic: does the question want report DATA/metrics rather than how-to help?
// Misrouting is harmless to security (RLS still scopes everything); worst case
// a how-to gets answered from data context. An explicit "how do I…" phrasing
// stays in HELP mode even if it mentions a metric word ("how do I post videos").
function looksLikeDataQuestion(msg: string): boolean {
  const m = msg.toLowerCase();
  const analytic = /\b(highest|lowest|best|worst|top|most|least|maximum|minimum|max|min|compare|comparison|versus|vs|trend|growth|grew|increase[d]?|decrease[d]?|drop(ped)?|decline[d]?|average|avg|total|sum|how much|how many|which (week|month|period|brand)|over time|so far|this (week|month)|last (week|month)|year to date|ytd)\b/;
  const metric = /\b(gmv|sales|revenue|orders?|roi|spend|cpo|views?|clicks?|samples?|shop\s*(performance|score)|affiliate|offsite|conversion|creators?|campaigns?|products?|videos?|metrics?|numbers?|figures?|stats?|statistics|performance|insights?)\b/;
  const howto = /^\s*(how\s+(do|can|to|would|should)|where\s+(do|is|can|are)|what('?s| is| are) the (process|step|way)|guide me|walk me|teach me|explain how)/;
  if (analytic.test(m)) return true;     // explicit analytics intent → data
  if (howto.test(m)) return false;       // explicit how-to → help (KB), even with a metric word
  return metric.test(m);                 // otherwise a metric/section noun → data
}

// Headline numeric metrics — the compact per-period time-series backbone.
const METRIC_COLS: { label: string; path: (d: Record<string, any>) => unknown }[] = [
  { label: 'GMV',                    path: (d) => d?.overallPerformance?.gmv },
  { label: 'Affiliate GMV',          path: (d) => d?.overallPerformance?.affiliateGmv },
  { label: 'Orders',                 path: (d) => d?.overallPerformance?.orders },
  { label: 'ROI',                    path: (d) => d?.overallPerformance?.roi },
  { label: 'Videos Posted',          path: (d) => d?.overallPerformance?.videosPosted },
  { label: 'Samples Approved',       path: (d) => d?.overallPerformance?.samplesApproved },
  { label: 'Shop Performance Score', path: (d) => d?.overallPerformance?.shopPerformanceScore },
  { label: 'Offsite GMV',            path: (d) => d?.offsitePerformance?.offsiteGmv },
  { label: 'TikTok Shop GMV',        path: (d) => d?.offsitePerformance?.tiktokShopGmv },
  { label: 'Offsite Effect',         path: (d) => d?.offsitePerformance?.offsiteEffect },
];

// ── Detail serialization helpers ────────────────────────────────────
const num = (v: unknown): string => { const n = parseNum(v); return n === null ? '' : String(n); };
function clip(v: unknown, n: number): string {
  // Insight/notes fields are stored as rich-text HTML — strip tags & decode
  // the common entities so the model sees clean prose, not "<p>…</p>".
  const t = String(v ?? '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>').replace(/&quot;/gi, '"').replace(/&#3?9;/gi, "'")
    .replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}
// Compact pipe sub-table from an array of row objects; drops blank rows.
function miniTable(arr: any[], cols: { label: string; get: (x: any) => string }[], maxRows: number): string {
  const rows = (arr || []).filter((x) => x && cols.some((c) => c.get(x) !== '')).slice(0, maxRows);
  if (!rows.length) return '';
  let t = cols.map((c) => c.label).join(' | ');
  for (const x of rows) t += `\n${cols.map((c) => c.get(x)).join(' | ')}`;
  const more = (arr?.length || 0) - rows.length;
  if (more > 0) t += `\n…(+${more} more)`;
  return t;
}

// Full, compact serialization of ONE report's detail sections — every part of
// the report (creators, videos, GMV Max, products, offsite, insights, notes,
// operational sections, custom fields), each capped so a single period stays
// token-bounded.
function reportDetail(r: any): string {
  const d = r?.data || {};
  const parts: string[] = [];
  const text = (label: string, v: unknown, n = 320) => { const s = clip(v, n); if (s) parts.push(`${label}: ${s}`); };

  text('Overall insights', d.overallInsights);
  text('Samples note', d.overallNotes?.samplesApproved, 160);
  text('Videos note', d.overallNotes?.videosPosted, 160);

  const creators = miniTable(d.topCreators, [
    { label: 'Creator', get: (x) => clip(x.name, 40) },
    { label: 'Videos', get: (x) => num(x.videosPosted) },
    { label: 'Items', get: (x) => num(x.itemsSold) },
    { label: 'GMV', get: (x) => num(x.gmv) },
    { label: 'Notes', get: (x) => clip(x.notes, 60) },
  ], 8);
  if (creators) parts.push(`Top creators:\n${creators}`);
  text('Creators insight', d.topCreatorsInsights);

  const videos = miniTable(d.topVideos, [
    { label: 'Creator', get: (x) => clip(x.creatorName, 30) },
    { label: 'Items', get: (x) => num(x.itemsSold) },
    { label: 'GMV', get: (x) => num(x.gmv) },
    { label: 'Views', get: (x) => num(x.views) },
    { label: 'Clicks', get: (x) => num(x.productClicks) },
    { label: 'Notes', get: (x) => clip(x.notes, 50) },
  ], 8);
  if (videos) parts.push(`Top videos:\n${videos}`);
  text('Videos insight', d.topVideosInsights);

  const gmvmax = miniTable(d.gmvMax, [
    { label: 'Campaign', get: (x) => clip(x.campaign, 40) },
    { label: 'Spend', get: (x) => num(x.spend) },
    { label: 'GMV', get: (x) => num(x.gmv) },
    { label: 'ROI', get: (x) => num(x.roi) },
    { label: 'Orders', get: (x) => num(x.orders) },
    { label: 'CPO', get: (x) => num(x.cpo) },
    { label: 'Notes', get: (x) => clip(x.notes, 50) },
  ], 8);
  if (gmvmax) parts.push(`GMV Max campaigns:\n${gmvmax}`);
  text('GMV Max insight', d.gmvMaxInsights);

  const products = miniTable(d.productHighlights, [
    { label: 'Product', get: (x) => clip(x.productName, 40) },
    { label: 'Units', get: (x) => num(x.unitsSold) },
    { label: 'GMV', get: (x) => num(x.gmv) },
    { label: 'New Videos', get: (x) => num(x.newVideos) },
    { label: 'Notes', get: (x) => clip(x.notes, 50) },
  ], 8);
  if (products) parts.push(`Product highlights:\n${products}`);
  text('Products insight', d.productHighlightsInsights);

  // Offsite headline numbers are already in the per-period table; include the
  // narrative + the three figures together here for context.
  const off = d.offsitePerformance || {};
  if (num(off.offsiteGmv) || num(off.tiktokShopGmv) || num(off.offsiteEffect)) {
    parts.push(`Offsite: GMV=${num(off.offsiteGmv) || '—'}, TikTok Shop GMV=${num(off.tiktokShopGmv) || '—'}, Offsite effect=${num(off.offsiteEffect) || '—'}`);
  }
  text('Offsite insight', d.offsiteInsights);

  text('Current & upcoming campaigns', d.upcomingCampaigns);
  text('Operational updates', d.operationalUpdates);
  text('Recommendations', d.recommendations);
  text('Action items', d.actionItems);

  if (d.customFields && typeof d.customFields === 'object') {
    const cf = Object.values(d.customFields as Record<string, any>)
      .filter((f) => f && (f.name || f.value))
      .map((f) => `${clip(f.name, 40)}=${clip(f.value, 80)}`).slice(0, 10);
    if (cf.length) parts.push(`Custom fields: ${cf.join('; ')}`);
  }
  return parts.join('\n');
}

// Does the message reference this report's period (e.g. "week 11", "June")?
function periodMentioned(label: string, ml: string): boolean {
  const lab = (label || '').toLowerCase();
  const wk = lab.match(/week\s*(\d+)/);
  if (wk && new RegExp(`\\bweek\\s*${wk[1]}\\b`).test(ml)) return true;
  const months = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
  return months.some((m) => lab.includes(m) && ml.includes(m));
}

// Build the (token-bounded) DATA block: a headline time-series per brand, then
// full detailed breakdowns for the most relevant periods (named first, else
// most recent), filling the remaining budget.
function buildDataBlock(reps: any[], message: string): string {
  const intro = 'BRAND REPORT DATA (these are the ONLY brands/reports you can access — they all belong to this user. Never reference, invent, or imply data for any brand or person not listed here):';
  if (!reps.length) return `${intro}\n\n(No reports are visible to you yet, so there is no performance data to analyze.)`;

  // Group by brand (newest-first order preserved from the query).
  const byBrand = new Map<string, { name: string; currency: string; rows: any[] }>();
  for (const r of reps) {
    const name = r.brand?.brand_name || `Brand ${String(r.brand_id).slice(0, 8)}`;
    if (!byBrand.has(r.brand_id)) byBrand.set(r.brand_id, { name, currency: String(r.data?.currency || 'USD'), rows: [] });
    byBrand.get(r.brand_id)!.rows.push(r);
  }
  // If the user named one of THEIR brands, narrow to it (still within the
  // authorized set — naming a brand they don't have simply matches nothing).
  const ml = message.toLowerCase();
  const named = [...byBrand.values()].filter((b) => b.name.length > 1 && ml.includes(b.name.toLowerCase()));
  const brands = named.length ? named : [...byBrand.values()];
  const list = brands.slice(0, named.length ? named.length : 5);
  const headlineRows = (list.length <= 1 || named.length) ? 26 : 12;

  let out = '';
  let truncated = false;

  // Pass 1 — headline time-series for every (capped) brand. Cheap, so these
  // generally all fit and cover any "which week/month was X highest" question.
  for (const b of list) {
    const cols = METRIC_COLS.filter((c) => b.rows.some((r) => parseNum(c.path(r.data)) !== null));
    if (!cols.length) continue;
    let tbl = `\n\n### ${b.name} (currency: ${b.currency}) — headline metrics by period\n${['Type', 'Period', 'Status', ...cols.map((c) => c.label)].join(' | ')}`;
    const hrows = b.rows.slice(0, headlineRows);
    for (const r of hrows) tbl += `\n${r.type} | ${r.period_label || r.period_start} | ${r.status} | ${cols.map((c) => num(c.path(r.data))).join(' | ')}`;
    if (b.rows.length > headlineRows) tbl += `\n…(${b.rows.length - headlineRows} older periods not shown in this table)`;
    if (out.length && out.length + tbl.length > DATA_BUDGET) { truncated = true; break; }
    out += tbl;
  }

  // Pass 2 — full detailed breakdowns, prioritized: periods the user named,
  // then named brand, then most recent. Fills whatever budget remains.
  const candidates: { b: any; r: any; idx: number; brandNamed: boolean; periodNamed: boolean }[] = [];
  list.forEach((b) => {
    const brandNamed = named.includes(b);
    b.rows.forEach((r: any, idx: number) => candidates.push({ b, r, idx, brandNamed, periodNamed: periodMentioned(r.period_label, ml) }));
  });
  candidates.sort((a, z) =>
    (Number(z.periodNamed) - Number(a.periodNamed)) ||
    (Number(z.brandNamed) - Number(a.brandNamed)) ||
    (a.idx - z.idx));

  let detailHeader = false;
  let emitted = 0;
  for (const c of candidates) {
    if (emitted >= 12) break;
    const detail = reportDetail(c.r);
    if (!detail) continue;
    const head = detailHeader ? '' : '\n\n## DETAILED BREAKDOWNS (top creators, top videos, GMV Max campaigns, product highlights, offsite, insights & notes — shown for the most relevant periods):';
    const block = `${head}\n\n— ${c.b.name} · ${c.r.period_label || c.r.period_start} (${c.r.type}, ${c.r.status}) —\n${detail}`;
    if (out.length + block.length > DATA_BUDGET) { truncated = true; break; }
    out += block;
    detailHeader = true;
    emitted++;
  }

  if (truncated) out += '\n\n(Some detail was omitted to stay within size limits. For older periods, other brands, or a specific section, ask about that brand and week/month by name.)';
  return `${intro}${out || '\n\n(No metrics have been filled into your reports yet.)'}`;
}

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

    // ── Caller-scoped client (RLS applies) ─────────────────────────
    // Used to read the Knowledge Base AND brand reports AS THE USER, so the
    // database itself guarantees they only ever see what they're allowed to.
    const userClient = ANON_KEY
      ? createClient(SUPABASE_URL, ANON_KEY, {
          global: { headers: { Authorization: `Bearer ${token}` } },
          auth: { persistSession: false, autoRefreshToken: false },
        })
      : null;

    // Route the question: a metrics/analytics ask → DATA mode (read the user's
    // own brand reports, and SKIP the KB to keep us well under the token cap).
    // Anything else → help mode (Knowledge Base RAG, unchanged).
    const dataMode = !!userClient && looksLikeDataQuestion(message);

    let knowledgeBlock: string;
    if (dataMode) {
      // RLS-scoped read: `reports_select` (mig 012 → can_view_report →
      // can_view_brand) means this returns ONLY reports for brands the caller
      // may view — owned (TL), assigned (APC/IPC, incl. temporary), or authored;
      // OL/Boss/Dev see all. The model never picks the filter, so it can't be
      // prompted into another user's or brand's data: that data is never read.
      const { data: reps } = await userClient!
        .from('reports')
        .select('brand_id, type, period_start, period_label, status, data, brand:brand_id(brand_name)')
        .order('period_start', { ascending: false })
        .limit(REPORTS_FETCH_LIMIT);
      knowledgeBlock = buildDataBlock(reps || [], message);
    } else {
      // ── Knowledge (RAG) — pick the docs most relevant to THIS question
      //    and cap the size, so the request fits the model's input limit
      //    instead of stuffing the whole knowledge base into every call. ──
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

      // Unified relevance pool — curated WurxOS guides ranked slightly above KB
      // so "how do I use the app" questions prefer the how-to guides.
      const pool = [
        ...(docs || []).map((d) => ({ title: d.title, content: d.content, boost: 1.2 })),
        ...kbDocs.map((d) => ({ title: d.title, content: d.content, boost: 1.0 })),
      ];
      const STOP = new Set(['the','a','an','to','how','do','does','i','what','is','are','my','of','in','on','for','and','me','about','this','that','you','your','with','it','at','be','or','as','will','can','please','need','want','where','when','who','why','from','our','we','us']);
      const terms = (message.toLowerCase().match(/[a-z0-9']+/g) || []).filter((w) => w.length > 2 && !STOP.has(w));
      const scored = pool.map((d) => {
        const hay = `${d.title} ${d.title} ${d.title} ${d.content}`.toLowerCase(); // weight the title
        let score = 0;
        for (const t of terms) { let i = 0; while ((i = hay.indexOf(t, i)) !== -1) { score++; i += t.length; } }
        return { d, score: score * d.boost };
      }).sort((a, b) => b.score - a.score);
      let picked = scored.filter((s) => s.score > 0).map((s) => s.d);
      if (picked.length === 0) picked = pool.filter((d) => d.boost > 1).slice(0, 2); // no hit → a little general WurxOS context
      let knowledge = '';
      for (const d of picked) {
        const block = `\n\n## ${d.title}\n${d.content}`;
        if (knowledge.length && knowledge.length + block.length > KNOWLEDGE_BUDGET) break; // always include the top match
        knowledge += block;
      }
      knowledgeBlock = knowledge
        ? `KNOWLEDGE (answer using this — WurxOS app help and company Knowledge Base articles):${knowledge}`
        : 'No specific knowledge matched this question. Answer from general WurxOS context if you can; otherwise say you are not sure and suggest asking the Team Lead or Boss.';
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

    let systemPrompt: string;
    if (dataMode) {
      // Lean prompt: persona + who + the (RLS-scoped) data + analysis rules.
      // No page list / KB here — keeps the request small and the answer focused.
      const dataRules = [
        'HOW TO ANSWER (DATA MODE):',
        '- Answer ONLY from the BRAND REPORT DATA above. It has a per-brand headline metrics table (every period) AND DETAILED BREAKDOWNS — top creators, top videos, GMV Max campaigns, product highlights, offsite performance, plus written insights and notes — for the most relevant periods.',
        '- MATCH FIELDS BY MEANING, not by exact wording. Users name metrics loosely — map their phrasing to the closest column/field and never say a metric is missing just because the words differ from the header. Guide: "samples" / "samples approved" / "approved samples" = Samples Approved; "orders" / "orders shipped" / "orders placed" = Orders; "sales" / "revenue" / "total sales" = GMV; "creator/affiliate sales" = Affiliate GMV; "videos" / "content posted" = Videos Posted; "shop score" / "store score" / "performance score" = Shop Performance Score; "ad return" / "return on investment" = ROI; "offsite" / "off-platform" = Offsite GMV / TikTok Shop GMV / Offsite Effect; "creators", "videos list", "campaigns/ads", "products" live in the detailed breakdowns. If a term is genuinely ambiguous between two fields, ask which one they mean.',
        '- Do the math yourself (max, min, totals, averages, growth, comparisons, rankings) and state the exact period and the number.',
        '- For max/min/average, use ONLY the periods where that metric actually has a value (ignore blanks). If even ONE period shows the metric, you CAN compute its lowest/highest — NEVER claim it was "not reported for any week" when values are present in the table.',
        '- READ FOLLOW-UPS IN CONTEXT. A short follow-up continues the previous topic: after you gave the highest of a metric, "also the minimum one" / "and the lowest?" / "what about videos?" means the SAME kind of question on the same data — answer it from the table; do NOT say you lack the information.',
        '- The detailed breakdowns are shown only for the most relevant or recent periods. If asked for detail (e.g. a creator or video list) about a period that is NOT shown, ask the user to name that specific week/month so it can be pulled in.',
        "- Show money using the brand's stated currency. A blank metric means \"not reported\" for that period — do not treat it as zero.",
        "- This data is the user's OWN brand(s). You have NO access to any other employee's or brand's figures. If they ask about a brand or person not listed above, tell them you can only see their own brand data and do not guess or fabricate.",
        '- If a question is relevant but unclear or could mean several things (which metric? which brand? which report type?), ask ONE short clarifying question instead of refusing. "I don\'t have that information" is correct ONLY when the data genuinely does not contain it — never as a response to ambiguity.',
        '- If the data spans more than one brand and the user did not name one, either answer per brand or ask which brand they mean.',
        '- Only when the data truly lacks the requested metric, say so briefly and point them to [Weekly Reports](/weekly-reports), [Bi-Weekly Reports](/biweekly-reports) or [Monthly Reports](/monthly-reports).',
        '- Be concise and well-structured: a direct answer first, then a small list or table when it helps (e.g. comparing periods or ranking creators).',
      ].join('\n');
      systemPrompt = [
        persona,
        `WHO YOU ARE HELPING: ${profile.display_name || 'a team member'} — role: ${roleLabel}.`,
        knowledgeBlock,
        dataRules,
      ].join('\n\n');
    } else {
      const roleCap = ROLE_CAPS[roleKey] || 'You are a WurxOS user.';
      const pageList = pagesForRole(roleKey)
        .map((p) => `- ${p.label} (${p.path}): ${p.purpose}`).join('\n');

      const groundingRules = [
        'HOW TO ANSWER:',
        `- The person you are helping is a ${roleLabel}. Only explain actions THIS role can actually do, based on "WHAT THEY CAN DO" and the page list above.`,
        '- If they ask how to do something their role cannot do (e.g. a Boss asking how to apply for leave), do NOT invent steps. Briefly say it is not part of their role and point them to what they CAN do instead.',
        '- Never invent pages, buttons, or steps that are not supported by the knowledge or the page list. If you do not know, say so and suggest asking their Team Lead, Operation Lead, or the Boss.',
        '- When you mention a page, link it INLINE using markdown to its exact path, e.g. [Leave](/leave). Only link to paths in the list above; never show a bare URL or invent a path.',
        '- Some knowledge entries have no written steps — only a title and a link to a full guide (e.g. a Google Doc). For those, do NOT say you have no information and do NOT invent steps: point the user to the guide with a markdown link, e.g. [open the guide](https://…). Recite detailed steps only when the knowledge actually contains them.',
        '- If the user is clearly asking about their brand\'s performance/metrics (GMV, orders, etc.), tell them you can answer that — ask them to mention the metric and brand — rather than guessing numbers.',
        '- Read short follow-up questions in the context of the conversation so far — they usually continue the previous topic. If a question is relevant but unclear, ask ONE short clarifying question instead of replying that you do not know.',
        '- Be concise and friendly; use short numbered steps when describing a flow.',
      ].join('\n');

      systemPrompt = [
        persona,
        `WHO YOU ARE HELPING: ${profile.display_name || 'a team member'} — role: ${roleLabel}.`,
        `WHAT THEY CAN DO: ${roleCap}`,
        `PAGES THEY CAN OPEN (use these exact paths for links; never invent one):\n${pageList}`,
        knowledgeBlock,
        groundingRules,
      ].join('\n\n');
    }

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
      if (aiRes.status === 429) {
        // GitHub Models free tier caps requests per-minute and per-day. Don't
        // dump GitHub's raw ToS blurb at the user — give a clean, calm message.
        const retry = aiRes.headers.get('retry-after');
        const wait = retry && Number(retry) > 0
          ? `about ${Math.ceil(Number(retry) / 60) || 1} minute(s)`
          : 'a minute';
        return json({ error: `The assistant is getting a lot of requests right now and the AI provider's free rate limit was hit. Please wait ${wait} and try again.`, conversationId }, 429);
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
