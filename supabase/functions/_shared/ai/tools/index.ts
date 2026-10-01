// Data tools for Assistant v2 (A§11, phase5-design §8): definitions for the LLM
// and one dispatcher. Read-only, parameterised, role-checked, bounded.
// deno-lint-ignore-file no-explicit-any

import type { Db, ToolCtx, ToolDef, ToolResult, ToolSource } from './types.ts';
import { isBoss } from './acl.ts';
import * as P from './people.ts';
import { NOT_YOURS } from './people.ts';
import { pageAllows } from './roles.ts';
import * as R from './reports.ts';

export type { ToolCtx, ToolDef, ToolResult, ToolSource } from './types.ts';
export { parseMetric, normTier, reportCurrency, fmtMoney } from './metrics.ts';
export { resolvePeriod, resolveBrands } from './period.ts';
export { NOT_YOURS } from './people.ts';
export { PAGE_ROLES, ROLE_ANGLES, STAFF_ROLES } from './roles.ts';

export const TOOL_RESULT_CHAR_CAP = 6000;
const SOURCE_ID_CAP = 50;

const PERIOD_HINT = 'A month ("August", "2026-08", "last month"), a week ("last week", "this week", "Week 24"), a quarter ("Q3"), a date ("2026-09-14") or a range ("2026-09-01..2026-09-30"). Dates are Pakistan time; weeks run Sunday to Saturday.';

// Ported tool definitions keep v1's wording (the model was tuned on it); only
// get_reports gains the approved-only rule.
export const TOOL_DEFS: ToolDef[] = [
  {
    name: 'find_person',
    description: "Look up one employee's profile by (partial) name — full name, role, manager, employment type, start date, responsibilities, email, active status. Use for 'who is X / tell me about X', and before other tools when the user names a person. For salary/incentives/performance/attendance/leave, also call the matching tool.",
    parameters: { type: 'object', properties: { name: { type: 'string', description: 'Full or partial employee name, e.g. "Ali" or "Abdul Subhan".' } }, required: ['name'] },
  },
  {
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
  {
    name: 'get_incentives',
    description: 'Get monthly incentive & bonus goals (target vs achieved, PKR amount, completed/verified/paid) for one employee, or for ALL employees when no name is given. Month format YYYY-MM; omit for the latest month with data.',
    parameters: {
      type: 'object',
      properties: {
        person_name: { type: 'string', description: 'Employee name; omit to get everyone (e.g. for ranking/totals).' },
        month: { type: 'string', description: 'YYYY-MM, e.g. "2026-06". Omit for the latest month that has data.' },
      },
    },
  },
  {
    name: 'get_salary',
    description: 'Get current basic salary (PKR) and recent change history for one employee, or for ALL employees when no name is given. The Boss has no salary and is excluded.',
    parameters: { type: 'object', properties: { person_name: { type: 'string', description: 'Employee name; omit to list everyone.' } } },
  },
  {
    name: 'get_reports',
    description: "Get client report data (weekly, biweekly, or monthly) from APPROVED reports only; a newer report that is not approved yet is named with its status, never its figures. IMPORTANT for cost: request ONLY the sections the question needs via `sections`. If the user asks just for GMV or a metric, use ['metrics'] — do NOT pull insights/tables. Use ['all'] only when they want the whole/full report for a specific brand+period. Period is a substring match on the report label (e.g. \"June\", \"Week 13\", \"2026-06\"); when no label matches, dates are used (\"last week\", \"August\").",
    parameters: {
      type: 'object',
      properties: {
        brand_name: { type: 'string', description: 'Brand name (partial ok); omit for all brands.' },
        period: { type: 'string', description: 'Period label substring, e.g. "June" or "Week 13", or a date phrase like "last week". Omit for most recent.' },
        type: { type: 'string', enum: ['weekly', 'biweekly', 'monthly'], description: 'Report type; omit for any.' },
        sections: {
          type: 'array',
          description: "Which parts to return. Pick the MINIMUM needed. Options: 'metrics' (GMV, orders, samples, videos, ROI, shop score, offsite), 'insights' (written analysis per area), 'creators' (top creators), 'videos' (top videos), 'gmvmax' (GMV Max ad campaigns), 'products' (product highlights/analytics), 'written' (recommendations, action items, upcoming campaigns, operational updates), or 'all' for the complete report. Default is ['metrics']. For 'who was the top creator', prefer get_top_creators.",
          items: { type: 'string', enum: ['metrics', 'insights', 'creators', 'videos', 'gmvmax', 'products', 'written', 'all'] },
        },
      },
    },
  },
  {
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
  {
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
  {
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
  {
    name: 'list_brands',
    description: 'List client brands with their status, owner (the Team Lead) and the APCs/IPCs assigned to each. Use for "which brands do we have / who owns X".',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'get_brand_assignments',
    description: "Who handles which brand: per brand the owner (Team Lead) and the assigned APCs/IPCs (temporary cover marked). Use for 'which APC is responsible for / assigned to / handles brand X' and 'which brands does person Y handle'. Never infer APCs from reports or owners; use this.",
    parameters: {
      type: 'object',
      properties: {
        brand: { type: 'string', description: 'Brand name (partial ok); omit for all brands.' },
        person: { type: 'string', description: 'Employee name: the brands they own or are assigned to.' },
        role: { type: 'string', enum: ['apc', 'ipc', 'tl'], description: 'Only this role (tl = the owner).' },
        include_inactive: { type: 'boolean', description: 'Include inactive brands (default: active only, unless a brand is named).' },
      },
    },
  },
  {
    name: 'get_top_creators',
    description: "Top creators of ONE brand for a period, from approved reports, ranked by GMV (or items sold), with items sold and each creator's row in the report. Use for 'who was the top creator / how many items did they sell'. For a MONTH: the approved monthly report gives the ranking by GMV; items sold (which monthly reports do not record) are derived from the approved weekly reports fully inside the month; with no approved monthly, everything is derived from those weeklies. The result says which weeks were used and excluded; when you answer, say the figure is derived from those weeks and partial per creator. For a week: that week's report, or the latest approved one before it (said so).",
    parameters: {
      type: 'object',
      properties: {
        brand: { type: 'string', description: 'Brand name (partial ok).' },
        period: { type: 'string', description: `${PERIOD_HINT} Omit for the latest approved report.` },
        type: { type: 'string', enum: ['weekly', 'biweekly', 'monthly'], description: 'Report type; defaults from the period (a month → monthly, a week → weekly).' },
        metric: { type: 'string', enum: ['gmv', 'items_sold', 'videos'], description: 'Ranking metric; default gmv.' },
        top_n: { type: 'integer', minimum: 1, maximum: 20, description: 'How many creators; default 5.' },
      },
      required: ['brand'],
    },
  },
  {
    name: 'compare_periods',
    description: 'Compare one metric for one brand between two periods, from approved reports picked by PERIOD (not creation date). Returns both values, the change and the % change; refuses to subtract across currencies. Omit period_b to compare with the previous approved report of the same type.',
    parameters: {
      type: 'object',
      properties: {
        brand: { type: 'string', description: 'Brand name (partial ok).' },
        metric: { type: 'string', enum: R.METRIC_NAMES, description: 'gmv, affiliate_gmv, orders, roi, samples, videos, shop_score, gmv_max_gmv, gmv_max_spend, gmv_max_roi.' },
        period_a: { type: 'string', description: `The period of interest. ${PERIOD_HINT}` },
        period_b: { type: 'string', description: 'The baseline period; omit (or "previous") for the previous approved report.' },
        type: { type: 'string', enum: ['weekly', 'biweekly', 'monthly'], description: 'Report type; defaults from period_a.' },
      },
      required: ['brand', 'metric', 'period_a'],
    },
  },
  {
    name: 'rank_brands',
    description: "Rank brands on one metric for a period, from each brand's approved report (the latest of that type inside the period). States coverage (\"12 of 20 active brands have an approved report\"), lists brands awaiting approval, and never mixes currencies. GMV Max metrics come from each report's GMV Max table (Overall row if present, else campaign rows summed; ROI = GMV / spend).",
    parameters: {
      type: 'object',
      properties: {
        metric: { type: 'string', enum: R.METRIC_NAMES, description: 'What to rank by.' },
        period: { type: 'string', description: PERIOD_HINT },
        type: { type: 'string', enum: ['weekly', 'biweekly', 'monthly'], description: 'Report type; defaults from the period (a month → monthly).' },
        top_n: { type: 'integer', minimum: 1, maximum: 50, description: 'Default 10.' },
        order: { type: 'string', enum: ['desc', 'asc'], description: 'desc = best first (default).' },
      },
      required: ['metric', 'period'],
    },
  },
  {
    name: 'brand_overview',
    description: "One brand at a glance: owner, status, tier, currency, the last 3 months' targets vs achieved (GMV, samples, ROI, GMV Max and paid-collab budgets), and the latest approved report's headline metrics.",
    parameters: { type: 'object', properties: { brand: { type: 'string', description: 'Brand name (partial ok).' } }, required: ['brand'] },
  },
  {
    name: 'get_gmv_max',
    description: 'GMV Max ad reports (spend, gross revenue, ROI, SKU orders, cost per order) with their campaigns, from the GMV Max reports module.',
    parameters: {
      type: 'object',
      properties: {
        brand: { type: 'string', description: 'Brand name (partial ok); omit for all brands.' },
        period: { type: 'string', description: `${PERIOD_HINT} Omit for the latest.` },
      },
    },
  },
  {
    name: 'get_agenda_tasks',
    description: 'Agenda tasks from the weekly agenda meetings: title, brand, assignee, status, due date.',
    parameters: {
      type: 'object',
      properties: {
        brand: { type: 'string', description: 'Brand name (partial ok).' },
        person: { type: 'string', description: 'Assignee name (partial ok).' },
        status: { type: 'string', description: 'e.g. "todo".' },
        limit: { type: 'integer', minimum: 1, maximum: 100, description: 'Default 30.' },
      },
    },
  },
];

// People & pay tools only ever run on the caller's own JWT client for a
// non-Boss (fail closed without one); see tools/roles.ts for the rule table.
const PEOPLE = new Set(['find_person', 'get_employees', 'get_incentives', 'get_salary', 'get_performance', 'get_attendance', 'get_leave']);

// db = what the caller may read; svc = service client (Boss path, and pure
// arithmetic on already-visible rows).
type Impl = (db: Db, ctx: ToolCtx, args: any, svc: Db) => Promise<{ text: string; source: ToolSource; data?: unknown }>;
const scope = (db: Db, ctx: ToolCtx, svc: Db): P.Scope => ({ db, svc, ctx, boss: isBoss(ctx) });
const IMPL: Record<string, Impl> = {
  find_person: (d, c, x, s) => P.findPerson(scope(d, c, s), x),
  get_employees: (d, c, x, s) => P.getEmployees(scope(d, c, s), x),
  get_incentives: (d, c, x, s) => P.getIncentives(scope(d, c, s), x),
  get_salary: (d, c, x, s) => P.getSalary(scope(d, c, s), x),
  get_performance: (d, c, x, s) => P.getPerformance(scope(d, c, s), x),
  get_attendance: (d, c, x, s) => P.getAttendance(scope(d, c, s), x),
  get_leave: (d, c, x, s) => P.getLeave(scope(d, c, s), x),
  list_brands: (d, c) => R.listBrands(d, c),
  get_reports: R.getReports,
  get_top_creators: R.getTopCreators,
  compare_periods: R.comparePeriods,
  rank_brands: R.rankBrands,
  brand_overview: R.brandOverview,
  get_gmv_max: R.getGmvMax,
  get_agenda_tasks: R.getAgendaTasks,
  get_brand_assignments: R.getBrandAssignments,
};
export const TOOL_NAMES = Object.keys(IMPL);

// Cuts at a line boundary and says so; the model is told to narrow the ask.
export function bound(text: string, cap = TOOL_RESULT_CHAR_CAP): { text: string; truncated: boolean } {
  if (text.length <= cap) return { text, truncated: false };
  const note = (shown: number) => `\n\n(Truncated: showing ${shown} of ${text.length} characters. Narrow the request, e.g. by brand, person or period, for the rest.)`;
  const room = cap - note(text.length).length;
  const cut = text.lastIndexOf('\n', room);
  const body = text.slice(0, cut > room / 2 ? cut : room);
  return { text: body + note(body.length), truncated: true };
}

export async function runDataTool(admin: Db, ctx: ToolCtx, name: string, args: any): Promise<ToolResult> {
  const impl = IMPL[name];
  if (!impl) return { name, text: `Unknown tool: ${name}`, source: { table: 'none' }, truncated: false };
  if (!ctx?.userId || !ctx?.role) return { name, text: 'No caller identity; refusing.', source: { table: 'none' }, truncated: false };
  const boss = isBoss(ctx);
  const refuse = (): ToolResult => ({ name, text: NOT_YOURS, source: { table: 'none' }, truncated: false });
  // The app's page guards that are stricter than RLS (e.g. no Performance page
  // for developers).
  if (!boss && !pageAllows(name, ctx.role)) return refuse();
  // Non-Boss: the caller's JWT client, so RLS decides. Without one, people &
  // pay fail closed; brand/report tools fall back to the service client with
  // the can_view_brand checks in acl.ts (e.g. a future as-user relay).
  const db = boss ? admin : ctx.userClient ?? (PEOPLE.has(name) ? null : admin);
  if (!db) return refuse();
  try {
    const r = await impl(db, ctx, args ?? {}, admin);
    const b = bound(r.text);
    const source = { ...r.source, ...(r.source.ids ? { ids: r.source.ids.slice(0, SOURCE_ID_CAP) } : {}) };
    return { name, text: b.text, source, truncated: b.truncated, ...(r.data !== undefined ? { data: r.data } : {}) };
  } catch (e) {
    const err = e as { message?: string; details?: string };
    return { name, text: `Tool ${name} failed: ${String(err?.message || e).slice(0, 150)}${err?.details ? ` (${String(err.details).slice(0, 150)})` : ''}`, source: { table: 'none' }, truncated: false };
  }
}
