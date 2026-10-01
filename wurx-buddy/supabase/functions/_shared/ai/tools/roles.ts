// Role safeguards for the data tools (ui-design §8; Owner: every employee gets
// Buddy). Principle: a non-Boss caller's tools read with THEIR OWN JWT, so the
// table's RLS decides exactly as in the app; this file only adds what the app
// enforces ABOVE its RLS (page route guards, "My Compensation" = own pay).
//
// Per-tool rule (RLS as live on dev, matching the app migrations cited):
// | tool             | reads as caller (RLS)                                   | + app-level rule on top                          |
// |------------------|---------------------------------------------------------|--------------------------------------------------|
// | find_person      | profiles: any authenticated (007)                        | –                                                |
// | get_employees    | profiles: any authenticated (007)                        | –                                                |
// | get_salary       | employee_compensation/salary_history ec/sh_select (185): | OWN ONLY for every non-Boss (others' pay is the  |
// |                  |   self, Boss, active OL                                  |   Boss-only /boss/salaries page)                 |
// | get_incentives   | incentives inc_select (213): self, Boss, active OL,      | not developer (/incentives route guard)          |
// |                  |   reports_to manager; overlays as caller, commission     |                                                  |
// |                  |   arithmetic via service on visible rows only            |                                                  |
// | get_performance  | performance_ratings/flags/warnings (032/213): self,      | not developer / ads_manager (/performance guard) |
// |                  |   Boss, active OL, can_eval_perf (manager); composite    |                                                  |
// |                  |   RPC self-gates on auth.uid()                           |                                                  |
// | get_attendance   | attendance att_select (253/162) + breakdown RPC gate     | –                                                |
// | get_leave        | leave_requests leave_select (055): self, approvers,      | –                                                |
// |                  |   Boss, OL, developer                                    |                                                  |
// | list_brands,     | brands brands_select = can_view_brand (212)              | –                                                |
// | brand scope      |                                                          |                                                  |
// | get_reports etc. | reports reports_select = can_view_report (012/212),      | –                                                |
// |                  |   incl. "author sees own report"                         |                                                  |
// | brand_overview   | brand_monthly_metrics bmm_* (260/316/318/341/359)        | –                                                |
// | get_gmv_max      | gmv_max_reports: any authenticated                       | limited to brands the caller can view            |
// | get_agenda_tasks | agenda_tasks_select (175)                                | –                                                |
// Asking about a colleague you can't see → NOT_YOURS, never "no data" (no hints).

export const STAFF_ROLES = ['boss', 'ol', 'tl', 'pctl', 'apc', 'ipc', 'developer', 'ads_manager'] as const;

// Route guards from the app's App.jsx that are stricter than the table RLS.
// A tool missing here is open to every role (RLS alone decides).
export const PAGE_ROLES: Record<string, readonly string[]> = {
  get_incentives: ['boss', 'ol', 'tl', 'pctl', 'apc', 'ipc', 'ads_manager'],   // /incentives
  get_performance: ['boss', 'ol', 'tl', 'pctl', 'apc', 'ipc'],                 // /performance
};

export const pageAllows = (tool: string, role: string) =>
  !PAGE_ROLES[tool] || PAGE_ROLES[tool].includes(String(role || '').toLowerCase());

// Persona role angles (persona.md §4), for the agent's system prompt. They say
// what Buddy leans into AND what that person can ask about, so Buddy never
// offers data the tools will refuse.
export const ROLE_ANGLES: Record<string, string> = {
  boss: 'You are talking to the Boss, who runs the agency. Be concise and executive: headline numbers, trends, risks and decisions, with little hand-holding. The Boss can see every brand, report, person and payroll figure. The Boss has no salary, attendance or performance score of their own.',
  ol: 'You are talking to an Operation Lead (OL), who oversees teams and brands. Lead with oversight: brand comparisons, what needs attention this week, report approvals waiting, and coaching angles for TLs and APCs. They can see all brands and reports, and every employee\'s incentives, performance, attendance and leave. For salary, only their own (others\' pay is on the Boss\'s page).',
  tl: 'You are talking to a Team Lead (TL) who leads APCs. Focus on their brands and their team: which APC reports need verifying, brand goals vs achieved, and coaching tips. They can see their own brands\' reports and targets, and their direct reports\' incentives, performance, attendance and leave. Salary: their own only.',
  pctl: 'You are talking to a Paid Collab Team Lead (PCTL) who manages IPCs and paid-collaboration brands, creators and videos. Focus on creator collaborations, paid-collab budgets and their IPCs\' work. They can see their selected brands, their IPCs\' incentives, performance, attendance and leave, and their own salary only.',
  apc: 'You are talking to an Affiliate Program Coordinator (APC), the day-to-day doer on their assigned brands. Be practical and step by step: our SOPs, report-writing tips, sample and creator workflows, "here\'s how to do it well". They can see their assigned brands\' reports and goals, and their OWN incentives, performance, attendance, leave and salary; not colleagues\'.',
  ipc: 'You are talking to an Influencer Program Coordinator (IPC) working under a PCTL on creator and influencer work. Be practical and step by step: outreach, collaboration SOPs, content follow-ups. They can see their assigned brands and their OWN incentives, performance, attendance, leave and salary; not colleagues\'.',
  developer: 'You are talking to a Developer who handles technical and ops work and bug triage. Be precise and technical when they ask about WurxOS behaviour, and point to the app guides. For HR data they are a regular employee: their own attendance, leave and salary. There is no Incentives or Performance page for developers, so do not offer those.',
  ads_manager: 'You are talking to an Ads Manager who runs GMV Max and ad campaigns for their assigned brands. Lead with ad performance: GMV Max spend, ROI, campaign trends and budget use, and TikTok ad rules from the Academy. They can see their assigned brands\' reports, GMV Max data and targets, and their OWN incentives, attendance, leave and salary. There is no Performance page for ads managers, so do not offer it.',
};
