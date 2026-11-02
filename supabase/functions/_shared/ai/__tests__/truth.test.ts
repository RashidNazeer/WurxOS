// Data-correctness regressions from the 2026-11 truth audit: every case is a SYNTHETIC fixture shaped like
// production (no real people or pay). Each one pins a way the tools used to let the model say something
// false: a former employee shown as current, a blank shown as zero, a population silently dropped, a role
// the model had to guess, a total that mixed in people who left.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runDataTool } from '../tools/index.ts';
import { who } from '../tools/who.ts';
import { fakeDb } from './fixtures/fakeDb.ts';

const BOSS = { userId: 'boss-1', role: 'boss' };
const NL = String.fromCharCode(10);
const lines = (t: string) => t.split(NL);

const P = [
  { id: 'boss-1', display_name: 'The Boss', role: 'boss', is_active: true, deleted_at: null },
  { id: 'ol', display_name: 'Olive Lead', role: 'ol', is_active: true, deleted_at: null },
  { id: 'tl', display_name: 'Tina Lead', role: 'tl', is_active: true, deleted_at: null },
  { id: 'apc', display_name: 'Ann Coord', role: 'apc', is_active: true, deleted_at: null, reports_to: 'tl' },
  { id: 'apc2', display_name: 'Bea Coord', role: 'apc', is_active: true, deleted_at: null, reports_to: 'tl' },
  { id: 'ads', display_name: 'Adam Ads', role: 'ads_manager', is_active: true, deleted_at: null },
  { id: 'gone', display_name: 'Gus Gone', role: 'apc', is_active: false, deleted_at: '2026-10-12T14:55:22+00:00', reports_to: 'tl' },
  { id: 'gone2', display_name: 'Gail Gone', role: 'ol', is_active: false, deleted_at: '2026-09-30T20:00:00+00:00' },
];

test('who(): role code on everyone, "former employee – left <PKT date>" on people who left', () => {
  assert.equal(who(P[3]), 'Ann Coord (APC)');
  assert.equal(who(P[5]), 'Adam Ads (ADS MANAGER)');
  assert.equal(who(P[6]), 'Gus Gone (APC, former employee – left 2026-10-12)');
  // 20:00 UTC on 30 Sep is already 1 Oct in Pakistan
  assert.equal(who(P[7]), 'Gail Gone (OL, former employee – left 2026-10-01)');
  assert.equal(who({ display_name: 'No Date', role: 'tl', is_active: false }), 'No Date (TL, former employee – deactivated)');
});

test('get_salary (all): current staff total excludes people who left; missing records are named, not skipped', async () => {
  const comp = [
    { user_id: 'ol', basic_salary: 200000, effective_from: '2026-06-01' },
    { user_id: 'tl', basic_salary: 120000, effective_from: '2026-06-01' },
    { user_id: 'apc', basic_salary: 60000, effective_from: '2026-05-31' },
    { user_id: 'gone', basic_salary: 50000, effective_from: '2026-05-31' },
    { user_id: 'gone2', basic_salary: 170000, effective_from: '2026-06-01' },
  ];
  const r = await runDataTool(fakeDb({ profiles: P, employee_compensation: comp, salary_history: [] }), BOSS, 'get_salary', {});
  assert.match(r.text, /^Current employees' salaries [(]3; total PKR 380,000 per month[)]:/);
  const [current, rest] = r.text.split('Former employees');
  assert.ok(!current.includes('Gus Gone') && !current.includes('Gail Gone'), 'nobody who left in the current block');
  assert.ok(rest.includes('Gus Gone (APC, former employee – left 2026-10-12): PKR 50,000'));
  assert.ok(current.includes('NO salary record on file (not zero, just not recorded): Bea Coord (APC); Adam Ads (ADS MANAGER)'.replace('Bea Coord (APC); Adam Ads (ADS MANAGER)', 'Bea Coord (APC)')) || current.includes('Adam Ads (ADS MANAGER)'));
  assert.ok(current.includes('Bea Coord (APC)') && current.includes('Adam Ads (ADS MANAGER)'));
  assert.ok(!current.includes('The Boss'), 'the Boss has no salary and is not listed as missing one');
});

test('get_incentives (all): compact lines, blanks are not zeros, people who left are apart', async () => {
  const inc = [
    { user_id: 'apc', month: '2026-10', basic_salary: 60000, verified: true, payout_cleared: false, bonuses: [],
      incentives: [{ text: 'A', amount: 5000, completed: true }, { text: 'B', amount: 5000, completed: false }] },
    { user_id: 'apc2', month: '2026-10', basic_salary: 0, verified: false, payout_cleared: false, incentives: [], bonuses: [] },
    { user_id: 'gone', month: '2026-10', basic_salary: 50000, verified: true, payout_cleared: false, bonuses: [],
      incentives: [{ text: 'A', amount: 9000, completed: true }] },
  ];
  const r = await runDataTool(fakeDb({ profiles: P, incentives: inc }), BOSS, 'get_incentives', { month: '2026-10' });
  assert.match(r.text, /3 record[(]s[)]: 2 current employees, 1 former employee/);
  assert.ok(r.text.includes('- Ann Coord (APC) — basic salary PKR 60,000; 1 of 2 goals met; earned PKR 5,000 of PKR 10,000 potential'));
  // a stored 0 / empty plan is "not recorded" / "no goals", never "PKR 0 of PKR 0"
  assert.ok(r.text.includes('- Bea Coord (APC) — basic salary not recorded in the incentive row; no goals set this month'));
  assert.ok(!/PKR 0 of PKR 0/.test(r.text));
  const [current, former] = r.text.split('Former employees (NOT current staff');
  assert.ok(!current.includes('Gus Gone') && former.includes('Gus Gone (APC, former employee – left 2026-10-12)'));
  // one person: the goal-by-goal detail is back
  const one = await runDataTool(fakeDb({ profiles: P, incentives: inc }), BOSS, 'get_incentives', { month: '2026-10', person_name: 'Ann' });
  assert.ok(one.text.includes('Incentives:') && one.text.includes('1 of 2 goals met'));
});

test('get_incentives for 40 people stays under the size cap (the detail view silently cut people off the end)', async () => {
  const people = Array.from({ length: 40 }, (_, i) => ({ id: `u${i}`, display_name: `Person Number${i}`, role: 'apc', is_active: true, deleted_at: null }));
  const inc = people.map((p) => ({ user_id: p.id, month: '2026-10', basic_salary: 50000, verified: true, payout_cleared: false, bonuses: [],
    incentives: Array.from({ length: 8 }, (_, k) => ({ text: `Goal ${k} with a long description of what to do`, amount: 1000, completed: k % 2 === 0, targetValue: 100, achievedValue: 50, suffix: '%' })) }));
  const r = await runDataTool(fakeDb({ profiles: people, incentives: inc }), BOSS, 'get_incentives', { month: '2026-10' });
  assert.equal(r.truncated, false);
  assert.ok(r.text.includes('Person Number39 (APC)'), 'the last person is present');
});

test('get_employees: head-count says current vs former; the left date is shown', async () => {
  const r = await runDataTool(fakeDb({ profiles: P }), BOSS, 'get_employees', { include_inactive: true });
  assert.match(r.text, /^Employees [(]8: 6 current, 2 former[)]/);
  assert.ok(r.text.includes('Gus Gone · reports to Tina Lead · FORMER EMPLOYEE (left 2026-10-12)'));
  const cur = await runDataTool(fakeDb({ profiles: P }), BOSS, 'get_employees', {});
  assert.match(cur.text, /^Current employees [(]6; former employees are not included[)]/);
  assert.ok(!cur.text.includes('Gus Gone'));
});

test('find_person: a former employee is found AND said to be former (never "no such person")', async () => {
  const one = await runDataTool(fakeDb({ profiles: P }), BOSS, 'find_person', { name: 'Gus Gone' });
  assert.ok(one.text.includes('Gus Gone (APC, former employee – left 2026-10-12)'));
  assert.ok(one.text.includes('Status: FORMER EMPLOYEE'));
  assert.ok(!one.text.includes('Status: active'));
  const act = await runDataTool(fakeDb({ profiles: P }), BOSS, 'find_person', { name: 'Ann' });
  assert.ok(act.text.includes('- Status: active (currently employed)'));
  // a tool that needs a current employee says the match is a former one
  const inc = await runDataTool(fakeDb({ profiles: P, incentives: [] }), BOSS, 'get_incentives', { person_name: 'Gus', month: '2026-10' });
  assert.ok(inc.text.includes('No active employee matches "Gus"') && inc.text.includes('Gus Gone (APC, former employee – left 2026-10-12)'));
  // a partial name that matches a current and a former person lists both, labelled
  const both = await runDataTool(fakeDb({ profiles: [...P, { id: 'g2', display_name: 'Gus Current', role: 'tl', is_active: true, deleted_at: null }] }), BOSS, 'find_person', { name: 'Gus' });
  assert.ok(both.text.includes('Gus Current (TL)') && both.text.includes('Also matching, but former employees'));
});

test('get_performance: Ads Manager is not ranked; a closed month lists leavers WITH their score, apart; gaps are not given a reason', async () => {
  const comp: Record<string, any> = {
    ol: { composite_score: null, level: null }, tl: { composite_score: 80, level: 'good' }, apc: { composite_score: 70, level: 'good' }, ads: { composite_score: 99, level: 'promotion' },
    gone: { composite_score: 95, level: 'promotion' },
  };
  const tables = { profiles: P, performance_ratings: [{ user_id: 'apc', month: '2026-09', metrics: {}, overall_score: 60 }],
    performance_month_snapshots: [{ user_id: 'gone', month: '2026-09' }, { user_id: 'apc', month: '2026-09' }],
    performance_flags: [], performance_warnings: [] };
  const r = await runDataTool(fakeDb(tables, { get_performance_composite: (a: any) => (comp[a.p_user] ? [comp[a.p_user]] : []) }), BOSS, 'get_performance', { month: '2026-09' });
  const [ranked, former] = r.text.split('FORMER employees (NOT current staff');
  assert.ok(!ranked.includes('Adam Ads'), 'the Performance page does not rate the Ads Manager');
  assert.ok(ranked.includes('Tina Lead (TL) — composite 80.0/100') && ranked.includes('Ann Coord (APC) — composite 70.0/100'));
  assert.ok(!ranked.includes('Gus Gone'), 'a leaver with the top score is never ranked');
  assert.ok(former.includes('Gus Gone (APC, former employee – left 2026-10-12) — composite 95.0/100 — Promotion'));
  // OL / Bea have no composite: the tool says so without inventing why
  assert.ok(ranked.includes('No composite score returned for this month (the tool does not say why; do not guess a reason)'));
  assert.ok(!/not rated yet|no entries/i.test(r.text));
});

test('get_performance as a non-Boss/OL: the partial view says so, so nobody is called the overall highest', async () => {
  const me = { userId: 'apc', role: 'apc', userClient: fakeDb({ profiles: P, performance_ratings: [], performance_flags: [], performance_warnings: [], performance_month_snapshots: [] },
    { get_performance_composite: (a: any) => (a.p_user === 'apc' ? [{ composite_score: 70, level: 'good' }] : []) }) };
  const r = await runDataTool(fakeDb({}), me, 'get_performance', { month: '2026-10' });
  assert.ok(r.text.includes('Ann Coord (APC) — composite 70.0/100'));
  assert.ok(r.text.includes('NOT the whole company'));
});

test('get_attendance (team): roles on every name; people who left mid-month are listed apart, not dropped, not ranked', async () => {
  const bd = [
    { user_id: 'tl', pct: 100, pct_display: 100, days_present: 20, covered_days: 31, elapsed_days: 31 },
    { user_id: 'apc', pct: 90, pct_display: 90, days_present: 18, covered_days: 31, elapsed_days: 31 },
    { user_id: 'gone', pct: 52, pct_display: 52, days_present: 7, covered_days: 31, elapsed_days: 31 },
  ];
  const att = [
    { user_id: 'tl', date: '2026-10-05', clock_in: '2026-10-05T04:00:00Z', clock_out: '2026-10-05T12:00:00Z', total_work_ms: 28800000, total_break_ms: 0 },
    { user_id: 'gone', date: '2026-10-05', clock_in: '2026-10-05T04:00:00Z', clock_out: '2026-10-05T12:00:00Z', total_work_ms: 28800000, total_break_ms: 0 },
  ];
  const db = fakeDb({ profiles: P, attendance: att }, { attendance_month_breakdown_bulk: (a: any) => bd.filter((b) => a.p_user_ids.includes(b.user_id)) });
  const r = await runDataTool(db, BOSS, 'get_attendance', { month: '2026-10' });
  const [cur, former] = r.text.split('FORMER employees (NOT current staff');
  assert.ok(cur.includes('- Tina Lead (TL): 100%') && cur.includes('- Ann Coord (APC): 90%'));
  assert.ok(!cur.includes('Gus Gone'));
  assert.ok(former.includes('Gus Gone (APC, former employee – left 2026-10-12): 52% (7 present)'));
});

test('get_leave: a request spanning two months belongs to both; a rejected/cancelled one took no leave; leavers are labelled', async () => {
  const lv = [
    { requester_id: 'apc', type: 'emergency', start_date: '2026-09-28', end_date: '2026-10-03', status: 'approved', reason: 'family', paid_days: 4, unpaid_days: 0 },
    { requester_id: 'apc2', type: 'wfh', start_date: '2026-10-07', end_date: '2026-10-07', status: 'rejected', reason: 'x', paid_days: 1, unpaid_days: 0 },
    { requester_id: 'gone', type: 'medical', start_date: '2026-10-08', end_date: '2026-10-08', status: 'approved', reason: 'fever', paid_days: 1, unpaid_days: 0 },
    { requester_id: 'tl', type: 'wfh', start_date: '2026-11-02', end_date: '2026-11-02', status: 'approved', reason: 'later', paid_days: 1, unpaid_days: 0 },
  ];
  const r = await runDataTool(fakeDb({ profiles: P, leave_requests: lv }), BOSS, 'get_leave', { month: '2026-10' });
  assert.match(r.text, /^Leave requests that overlap 2026-10 [(]3;/);
  assert.ok(r.text.includes('Ann Coord (APC) · emergency · 2026-09-28→2026-10-03 · approved [4 paid]'));
  assert.ok(lines(r.text).some((l) => l.startsWith('- Bea Coord (APC) · wfh · 2026-10-07 · rejected') && !l.includes('[')));
  assert.ok(r.text.includes('Gus Gone (APC, former employee – left 2026-10-12)'));
  assert.ok(!r.text.includes('later'));
});

const B = [
  { id: 'b1', brand_name: 'Alpha', status: 'active', currency: 'USD', owner_id: 'ol' },
  { id: 'b2', brand_name: 'Beta', status: 'active', currency: 'USD', owner_id: 'tl' },
  { id: 'b3', brand_name: 'Gamma', status: 'active', currency: 'USD', owner_id: 'tl' },
  { id: 'b4', brand_name: 'Old', status: 'inactive', currency: 'USD', owner_id: 'tl' },
];
const rep = (brand: string, status: string, gmv: string) => ({ id: `r-${brand}`, brand_id: brand, type: 'monthly', status, period_label: 'August 2026', period_start: '2026-08-01', period_end: '2026-08-31',
  period_year: 2026, period_month: 7, data: { keyMetrics: { gmv } }, sections_enabled: null });

test('rank_brands: inactive brand tagged, total says it is only the listed brands, brands with no report at all are named', async () => {
  const db = fakeDb({ brands: B, reports: [rep('b1', 'approved', '1000'), rep('b4', 'approved', '500')] });
  const r = await runDataTool(db, BOSS, 'rank_brands', { metric: 'gmv', period: 'August 2026' });
  assert.ok(r.text.includes('2. Old (inactive brand) — $500.00'));
  assert.match(r.text, /Total of ONLY the brands with a readable figure here [(]not the whole portfolio; includes inactive brands[)]: \$1,500\.00 across 2 reports/);
  assert.ok(r.text.includes('Active brands with NO monthly report at all for this period: Beta, Gamma.'));
});

test('brand tools show the owner\'s REAL role (an OL or the Boss can own a brand), and the active/inactive split', async () => {
  const db = fakeDb({ brands: B, profiles: P, brand_assignments: [], brand_monthly_metrics: [{ brand_id: 'b1', month_key: '2026-08', gmv_target: 1000, gmv_achieved: 900 }], reports: [] });
  const lb = await runDataTool(db, BOSS, 'list_brands', {});
  assert.match(lb.text, /^Brands [(]4: 3 active, 1 inactive[)]:/m);
  assert.ok(lb.text.includes('- Alpha (active) — owner: Olive Lead (OL)') && lb.text.includes('- Beta (active) — owner: Tina Lead (TL)'));
  const ov = await runDataTool(db, BOSS, 'brand_overview', { brand: 'Alpha' });
  assert.ok(ov.text.includes('- Owner: Olive Lead (OL)') && !ov.text.includes('Owner (Team Lead)'));
  assert.ok(ov.text.includes('GMV (goal tracking) $900.00 of $1,000.00 target'));
  const as = await runDataTool(db, BOSS, 'get_brand_assignments', { role: 'tl' });
  assert.ok(as.text.includes('Alpha (active) — owner: Olive Lead (OL)'));
});

test('get_agenda_tasks: an assignee who left is marked', async () => {
  const tasks = [{ id: 't1', brand_id: 'b1', assignee_id: 'gone', created_by: 'ol', title: 'Fix sheet', details: '', status: 'todo', due_date: '2026-10-20', link: null, updated_at: '2026-10-01', brand: null }];
  const r = await runDataTool(fakeDb({ agenda_tasks: tasks, profiles: P, brands: B }), BOSS, 'get_agenda_tasks', {});
  assert.ok(r.text.includes('Gus Gone (APC, former employee – left 2026-10-12)'));
});

test('get_reports: "Week 2" means Week 2, not Weeks 20-29', async () => {
  const w = (n: number) => ({ id: `w${n}`, brand_id: 'b1', type: 'weekly', status: 'approved', period_label: `Week ${n} (Jan 1 - 7)`, period_start: `2026-01-${String(n).padStart(2, '0')}`, period_end: '2026-01-31', data: { overallPerformance: { gmv: String(n * 100) } } });
  const db = fakeDb({ brands: [{ id: 'b1', brand_name: 'Alpha', status: 'active', currency: 'USD' }], reports: [w(2), w(22), w(25)] });
  const r = await runDataTool(db, BOSS, 'get_reports', { brand_name: 'Alpha', period: 'Week 2' });
  assert.ok(r.text.includes('Week 2 (') && !r.text.includes('Week 22') && !r.text.includes('Week 25'));
});

test('the prompt carries the TRUTH RULES in both the full and the compact form', async () => {
  const { buildInstructions, compactInstructions, BUDDY_PERSONA, TRUTH_RULES } = await import('../agent/prompt.ts');
  assert.ok(buildInstructions({ persona: BUDDY_PERSONA, role: 'apc' }).prefix.includes(TRUTH_RULES));
  assert.ok(compactInstructions({ persona: BUDDY_PERSONA, role: 'apc' }).includes('exactly as the tools write them'));
});
