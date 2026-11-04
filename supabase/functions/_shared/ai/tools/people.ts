// People & pay tools, ported from v1 (app repo supabase/functions/ai-chat/index.ts,
// runTool). Same queries, same text: scripts/test-tools-parity.mjs diffs every
// one of them against v1's own code. Only the return shape is new ({text,
// source}).
//
// Who sees what (role safeguards, ui-design §8): `db` is the service client for
// the Boss and the CALLER'S OWN JWT client for everyone else, so table RLS
// decides exactly as it does in the app. On top of RLS, only where the app is
// stricter than its RLS (salary: others' pay is on the Boss-only page), and a
// polite refusal instead of "no data" when someone asks about a colleague they
// can't see. Rule table: tools/roles.ts.
// deno-lint-ignore-file no-explicit-any

import type { Db, ToolCtx, ToolSource } from './types.ts';
import { hms, karachiMonthNow, money, monthToRange, pktTime, roleLabelOf } from './v1format.ts';
import { isOlViewer, olMay, OL_SEES } from './roles.ts';
import { FORMER_PHRASE, formerMatches, isFormer, leftOn, loadPeople, noActiveMatch, PARTIAL_VIEW, roleCode, sawAll, who } from './who.ts';

export type Out = { text: string; source: ToolSource };
// db: what the caller may read (service for the Boss, their JWT otherwise).
// svc: service client, ONLY for pure computation on rows db already returned
// (commission_line_state, which `authenticated` can't execute; the app does
// the same sum in JS from commission_fx_map).
export type Scope = { db: Db; svc: Db; ctx: ToolCtx; boss: boolean };

// Says nothing about whether the data exists (persona §6.2: no hints).
export const NOT_YOURS = "That's not something I can show you.";

const out = (text: string, source: ToolSource): Out => ({ text, source });
const NO_ONE = '00000000-0000-0000-0000-000000000000';
const aboutSomeoneElse = (s: Scope, ids: string[] | null) => !s.boss && !!ids && ids[0] !== s.ctx.userId;

// Resolve a name → profile rows (active, non-deleted). Returns [] if none.
// ilike treats % and _ as wildcards: a typed name must not be able to match everyone.
export const likeEsc = (t: string) => t.replace(/[\\%_]/g, (c) => '\\' + c);

export async function resolvePeople(db: Db, name: string) {
  const q = String(name || '').trim();
  if (!q) return [];
  const { data } = await db.from('profiles')
    .select('id, display_name, role')
    .ilike('display_name', `%${likeEsc(q)}%`)
    .is('deleted_at', null)
    .limit(8);
  return data || [];
}

const goalLine = (g: any) => {
  const tv = g?.targetValue, av = g?.achievedValue, sfx = g?.suffix || '';
  const prog = (tv != null || av != null) ? ` (${av ?? '?'}${sfx} of ${tv ?? '?'}${sfx}${g?.completed ? ', met' : ', not met'})` : '';
  return `    • ${String(g?.text || 'goal').trim()}${prog} — ${money(g?.amount)}`;
};

// showPay: basic salary appears only on the Boss's view and the caller's own row
// (others' pay is Boss-only in the app's salary pages; ui-design §8).
function fmtIncentiveRow(name: string, row: any, showPay = true, compact = false): string {
  const inc = Array.isArray(row.incentives) ? row.incentives : [];
  const bon = Array.isArray(row.bonuses) ? row.bonuses : [];
  const sum = (arr: any[]) => arr.reduce((s, g) => s + (g?.completed ? Number(g?.amount) || 0 : 0), 0);
  const earned = sum(inc) + sum(bon);
  const potential = [...inc, ...bon].reduce((s, g) => s + (Number(g?.amount) || 0), 0);
  const goals = inc.length + bon.length;
  const met = [...inc, ...bon].filter((g: any) => g?.completed).length;
  // A stored 0 / empty plan is NOT a measured zero: say what is absent.
  const salary = Number(row.basic_salary) > 0 ? `basic salary ${money(row.basic_salary)}` : 'basic salary not recorded in the incentive row';
  const flags = `verified: ${row.verified ? 'yes' : 'no'}, payout cleared: ${row.payout_cleared ? 'yes' : 'no'}`;
  const plan = goals ? `Earned so far (completed goals): ${money(earned)} of ${money(potential)} potential; ${met} of ${goals} goals met.` : 'No incentive or bonus goals are set for this month, so there is nothing earned or potential to report.';
  if (compact) return `- ${name} — ${showPay ? `${salary}; ` : ''}${goals ? `${met} of ${goals} goals met; earned ${money(earned)} of ${money(potential)} potential` : 'no goals set this month'}; ${flags}`;
  const lines = [`${name} — ${row.month} (${showPay ? `${salary}; ` : ''}${flags})`, `  ${plan}`];
  if (inc.length) { lines.push('  Incentives:'); inc.forEach((g: any) => lines.push(goalLine(g))); }
  if (bon.length) { lines.push('  Bonuses:'); bon.forEach((g: any) => lines.push(goalLine(g))); }
  return lines.join('\n');
}

// ── Attendance-linked incentive overlay (cross-owner contract C1+C2) ──
// A { source:'attendance' } item stores achievedValue null/0 and completed=false
// BY DESIGN; its value is derived at read time from the live monthly attendance
// %. Mirror of src/lib/incentivesApi.applyAttendanceAutofill + autoComplete and
// of v1: keep all three in lock-step.
//   • achievedValue = incentive_attendance_pct(month,user); targetValue = 100;
//     fallback to the stored value when the RPC has no row for a user.
//   • completed ONLY when the month is CLOSED (month < Karachi this-month) AND
//     achievedValue/targetValue >= 0.9.
//   • A payout_cleared row is FROZEN: stored values verbatim.
const attAutoComplete = (achieved: number, target: number) => (target > 0 ? (achieved / target) >= 0.9 : false);
const hasAttendanceItem = (row: any) =>
  [...(Array.isArray(row?.incentives) ? row.incentives : []), ...(Array.isArray(row?.bonuses) ? row.bonuses : [])]
    .some((it: any) => it && it.source === 'attendance');

export async function overlayAttendanceIncentives(db: Db, rows: any[], month: string): Promise<any[]> {
  const list = Array.isArray(rows) ? rows : [];
  const needIds = [...new Set(list.filter((r) => !r?.payout_cleared && hasAttendanceItem(r)).map((r) => r.user_id).filter(Boolean))];
  if (!needIds.length) return list;
  const pctByUser = new Map<string, number>();
  try {
    const { data, error } = await db.rpc('incentive_attendance_pct', { p_month: month, p_user_ids: needIds });
    if (error) throw error;
    (data || []).forEach((r: any) => pctByUser.set(r.user_id, Number(r.pct) || 0));
  } catch (e) {
    // Fail soft: stored values rather than zeroing real numbers.
    console.warn('data-tools attendance overlay skipped:', String((e as Error)?.message || e).slice(0, 150));
    return list;
  }
  const monthClosed = String(month) < karachiMonthNow();
  const patch = (it: any, uid: string) => {
    if (!it || it.source !== 'attendance') return it;
    const val = pctByUser.has(uid) ? (pctByUser.get(uid) as number) : (Number(it.achievedValue) || 0);
    return { ...it, achievedValue: val, targetValue: 100, suffix: it.suffix || '%', completed: monthClosed ? attAutoComplete(val, 100) : false };
  };
  return list.map((r) => {
    if (r?.payout_cleared) return r;
    const uid = r.user_id;
    return {
      ...r,
      incentives: (Array.isArray(r.incentives) ? r.incentives : []).map((it: any) => patch(it, uid)),
      bonuses: (Array.isArray(r.bonuses) ? r.bonuses : []).map((it: any) => patch(it, uid)),
    };
  });
}

// ── GMV Max overlay (mig 317 + 339) ──
// A { source:'gmv_max' } item stores achievedValue null / completed false BY
// DESIGN: the figure lives in brand_monthly_metrics. The 90% threshold and the
// target>0 guard duplicate mig 339: a goal of 0 must never read as met.
const hasGmvMaxItem = (row: any) =>
  [...(Array.isArray(row?.incentives) ? row.incentives : []), ...(Array.isArray(row?.bonuses) ? row.bonuses : [])]
    .some((it: any) => it && it.source === 'gmv_max' && it.brandId);

export async function overlayGmvMaxIncentives(db: Db, rows: any[], month: string): Promise<any[]> {
  const list = Array.isArray(rows) ? rows : [];
  if (!list.some((r) => !r?.payout_cleared && hasGmvMaxItem(r))) return list;

  const { data: mets, error } = await db
    .from('brand_monthly_metrics').select('brand_id, gmv_achieved').eq('month_key', month);
  if (error) return list;   // best effort: stale beats wrong-and-confident
  const byBrand = new Map((mets || []).map((m: any) => [m.brand_id, Number(m.gmv_achieved) || 0]));

  const patch = (it: any) => {
    if (!it || it.source !== 'gmv_max' || !it.brandId) return it;
    const achievedValue = byBrand.has(it.brandId) ? byBrand.get(it.brandId) as number : 0;
    const target = Number(it.targetValue) || 0;
    return { ...it, achievedValue, completed: target > 0 && achievedValue >= target * 0.9 };
  };
  // A PAID row keeps its frozen achievedValue but has no stored `completed`
  // (mig 340): derive the flag from the frozen figure.
  const freezeFlag = (it: any) => {
    if (!it || it.source !== 'gmv_max') return it;
    const target = Number(it.targetValue) || 0;
    const achieved = Number(it.achievedValue) || 0;
    return { ...it, completed: target > 0 && achieved >= target * 0.9 };
  };
  return list.map((r: any) => {
    const fn = r?.payout_cleared ? freezeFlag : patch;
    return { ...r, incentives: (r.incentives || []).map(fn), bonuses: (r.bonuses || []).map(fn) };
  });
}

// ── Commission Based Tier overlay (mig 333) ──
// Deliberately not a copy of the formula: public.commission_line_state owns the
// gate, the clamp and the FX conversion; this calls it once per distinct line.
const hasCommissionItem = (row: any) =>
  [...(Array.isArray(row?.incentives) ? row.incentives : []), ...(Array.isArray(row?.bonuses) ? row.bonuses : [])]
    .some((it: any) => it && it.source === 'commission_tier' && it.brandId);

export async function overlayCommissionIncentives(db: Db, rows: any[], month: string): Promise<any[]> {
  const list = Array.isArray(rows) ? rows : [];
  if (!list.some((r) => !r?.payout_cleared && hasCommissionItem(r))) return list;

  const wanted = new Map<string, { brandId: string; benchmark: number; achieved: number; pct: number }>();
  for (const r of list) {
    if (r?.payout_cleared) continue;
    for (const it of [...(r.incentives || []), ...(r.bonuses || [])]) {
      if (it?.source !== 'commission_tier' || !it.brandId) continue;
      const key = [it.brandId, it.targetValue, it.achievedValue, it.commissionPct].join('|');
      wanted.set(key, { brandId: it.brandId,
        benchmark: Number(it.targetValue) || 0,
        achieved: Number(it.achievedValue) || 0,
        pct: Number(it.commissionPct) || 0 });
    }
  }
  const state = new Map<string, any>();
  try {
    for (const [key, { brandId, benchmark, achieved, pct }] of wanted) {
      const { data, error } = await db.rpc('commission_line_state', {
        p_brand: brandId, p_month: month, p_benchmark: benchmark, p_achieved: achieved, p_pct: pct });
      if (error) throw error;
      if (data) state.set(key, data);
    }
  } catch (e) {
    console.warn('data-tools commission overlay skipped:', String((e as Error)?.message || e).slice(0, 150));
    return list;
  }
  const patch = (it: any) => {
    if (!it || it.source !== 'commission_tier' || !it.brandId) return it;
    const s = state.get([it.brandId, it.targetValue, it.achievedValue, it.commissionPct].join('|'));
    return s ? { ...it, ...s } : it;
  };
  return list.map((r) => {
    if (r?.payout_cleared) return r;
    return {
      ...r,
      incentives: (Array.isArray(r.incentives) ? r.incentives : []).map(patch),
      bonuses: (Array.isArray(r.bonuses) ? r.bonuses : []).map(patch),
    };
  });
}

const multiple = (asked: string, people: any[]) =>
  `Multiple people match "${asked}": ${people.map((p: any) => p.display_name).join(', ')}. Ask which one.`;

export async function findPerson(s: Scope, args: any): Promise<Out> {
  const db = s.db;
  const src: ToolSource = { table: 'profiles' };
  const q = String(args?.name || '').trim();
  if (!q) return out('Provide a name to look up.', src);
  const { data: found } = await db.from('profiles')
    .select('id, display_name, role, email, reports_to, employment_type, start_date, responsibilities, is_active, deleted_at')
    .ilike('display_name', `%${likeEsc(q)}%`).limit(20);
  const people = (found || []).filter((p: any) => !isFormer(p)).slice(0, 8);
  const former = (found || []).filter((p: any) => isFormer(p));
  const formerNote = former.length ? `\nAlso matching, but ${FORMER_PHRASE}s (no longer work here): ${former.slice(0, 5).map((p: any) => who(p)).join('; ')}.` : '';
  if (!people.length && former.length === 1) {
    const f = former[0];
    return out([who(f), `- Role: ${roleLabelOf(f.role)}`, '- Status: FORMER EMPLOYEE, no longer works here' + (leftOn(f) ? `; left ${leftOn(f)}` : ''),
      f.start_date && (s.boss || !isOlViewer(s.ctx.role)) ? `- Start date: ${f.start_date}` : null, '(A former employee has no current salary, incentives, performance, attendance or leave.)'].filter(Boolean).join('\n'), { ...src, ids: [f.id] });
  }
  if (!people.length) return out(former.length ? await noActiveMatch(db, q) : `No active employee matches "${q}".`, src);
  if (people.length > 1) return out(`Multiple people match "${q}":\n` + people.map((p: any) => `- ${who(p)} — ${roleLabelOf(p.role)}`).join('\n') + formerNote + '\nAsk which one.', { ...src, ids: people.map((p: any) => p.id) });
  const p = people[0];
  let mgr = '';
  if (p.reports_to) {
    const { data: m } = await db.from('profiles').select('display_name, role').eq('id', p.reports_to).maybeSingle();
    if (m) mgr = `${m.display_name} (${roleLabelOf(m.role)})`;
  }
  // Lead decision: email and responsibilities for the Boss and OLs only, although
  // profiles RLS lets every employee read them (conservative; Owner may widen).
  // An OL sees email and responsibilities only for the roles the app's directory lists, and neither
  // employment type nor start date of anyone else (no OL page shows them).
  const ol = !s.boss && isOlViewer(s.ctx.role);
  const self = p.id === s.ctx.userId;
  const full = s.boss || (ol && olMay('directory', p.role));
  const resp = full && Array.isArray(p.responsibilities) && p.responsibilities.length ? p.responsibilities.join(', ') : '';
  const lines = [
    `${who(p)}`,
    `- Role: ${roleLabelOf(p.role)}`,
    full && p.email ? `- Email: ${p.email}` : null,
    mgr ? `- Reports to: ${mgr}` : (p.role === 'boss' ? null : '- Reports to: (not set)'),
    (s.boss || (ol && self)) && p.employment_type ? `- Employment: ${p.employment_type}` : null,
    p.start_date && (!ol || self) ? `- Start date: ${p.start_date}` : null,
    resp ? `- Responsibilities: ${resp}` : null,
    '- Status: active (currently employed)',
    '(For this person\'s salary, incentives, performance, attendance or leave, call the matching tool.)',
  ].filter(Boolean);
  return out(lines.join('\n') + formerNote, { ...src, ids: [p.id] });
}

export async function getEmployees(s: Scope, args: any): Promise<Out> {
  const db = s.db;
  const src: ToolSource = { table: 'profiles' };
  let q = db.from('profiles')
    .select('id, display_name, role, reports_to, employment_type, start_date, is_active, deleted_at')
    .order('role', { ascending: true }).order('display_name', { ascending: true }).limit(300);
  if (!args?.include_inactive) q = q.is('deleted_at', null).eq('is_active', true);
  if (args?.role) q = q.eq('role', String(args.role));
  if (args?.search) q = q.ilike('display_name', `%${likeEsc(String(args.search).trim())}%`);
  const { data: raw } = await q;
  // An OL's directory lists current tl/pctl/ol/apc/ipc only: no Boss, developers, ads managers or former staff.
  const emps = !s.boss && isOlViewer(s.ctx.role) ? (raw || []).filter((e: any) => !isFormer(e) && olMay('directory', e.role)) : raw;
  if (!emps || !emps.length) return out('No employees match that filter.', src);
  const mgrIds = [...new Set(emps.map((e: any) => e.reports_to).filter(Boolean))];
  const { data: mgrs } = mgrIds.length
    ? await db.from('profiles').select('id, display_name').in('id', mgrIds)
    : { data: [] };
  const mgrOf = new Map((mgrs || []).map((m: any) => [m.id, m.display_name]));
  const ol = !s.boss && isOlViewer(s.ctx.role);   // see findPerson: an OL gets neither employment type nor start dates of others
  const byRole = new Map<string, string[]>();
  for (const e of emps) {
    const line = `  - ${e.display_name}${s.boss && e.employment_type ? ` · ${e.employment_type}` : ''}${e.reports_to && mgrOf.get(e.reports_to) ? ` · reports to ${mgrOf.get(e.reports_to)}` : ''}${e.start_date && (!ol || e.id === s.ctx.userId) ? ` · since ${e.start_date}` : ''}${isFormer(e) ? ` · FORMER EMPLOYEE (${leftOn(e) ? `left ${leftOn(e)}` : 'deactivated'})` : ''}`;
    const k = roleLabelOf(e.role);
    (byRole.get(k) || byRole.set(k, []).get(k)!).push(line);
  }
  const blocks = [...byRole.entries()].map(([role, lines]) => `${role} (${lines.length}):\n${lines.join('\n')}`);
  const nFormer = emps.filter((e: any) => isFormer(e)).length;
  const head = args?.include_inactive ? `Employees (${emps.length}: ${emps.length - nFormer} current, ${nFormer} former)` : `Current employees (${emps.length}; former employees are not included)`;
  return out(`${head}:\n\n` + blocks.join('\n\n'), { ...src, extra: { count: emps.length } });
}

export async function getIncentives(s: Scope, args: any): Promise<Out> {
  const db = s.db;
  let userIds: string[] | null = null;
  let label = 'all employees';
  if (args?.person_name) {
    const people = await resolvePeople(db, args.person_name);
    if (!people.length) return out(await noActiveMatch(db, args.person_name), { table: 'incentives' });
    if (people.length > 1) return out(multiple(args.person_name, people), { table: 'incentives' });
    userIds = [people[0].id]; label = people[0].display_name;
  }
  let month = String(args?.month || '').trim();
  if (!month) {
    const { data: mx } = await db.from('incentives').select('month').order('month', { ascending: false }).limit(1);
    month = mx?.[0]?.month || '';
  }
  const src: ToolSource = { table: 'incentives', period: month || null };
  let query = db.from('incentives')
    .select('user_id, month, basic_salary, incentives, bonuses, verified, payout_cleared')
    .eq('month', month);
  if (userIds) query = query.in('user_id', userIds);
  const { data: rows } = await query;
  if (!rows || !rows.length) return out(aboutSomeoneElse(s, userIds) ? NOT_YOURS : `No incentive records for ${label} in ${month || '(no data)'}.`, src);
  // Overlays so the numbers agree with the Incentives page; "Earned" is then
  // recomputed from the OVERLAID completed flags. Attendance and GMV Max read
  // as the caller (as the page does); commission is pure arithmetic on these
  // already-visible rows (see Scope.svc).
  const orows = await overlayCommissionIncentives(s.svc,
    await overlayGmvMaxIncentives(db,
      await overlayAttendanceIncentives(db, rows, month), month), month);
  const ids = [...new Set(orows.map((r: any) => r.user_id))];
  const people = await loadPeople(db, ids as string[]);
  const nameOf = (id: string) => people.get(id)?.display_name || 'Unknown';
  // An OL's Incentives page lists only ACTIVE apc / ipc / tl / ol / ads_manager (OLIncentivesPage.jsx):
  // no PCTLs, no former employees. Their own row is always theirs.
  const olView = !s.boss && isOlViewer(s.ctx.role);
  const listed = olView
    ? orows.filter((r: any) => r.user_id === s.ctx.userId || (people.has(r.user_id) && !isFormer(people.get(r.user_id)) && olMay('incentives', people.get(r.user_id).role)))
    : orows;
  if (!listed.length) return out(aboutSomeoneElse(s, userIds) ? NOT_YOURS : `No incentive records for ${label} in ${month || '(no data)'}.`, src);
  const sorted = listed.slice().sort((a: any, b: any) => String(nameOf(a.user_id)).localeCompare(String(nameOf(b.user_id))));
  const show = (r: any) => (s.boss || r.user_id === s.ctx.userId);
  // One person: the goal-by-goal detail. Everyone: one compact line each (the full detail of 13+
  // people overran the tool's size cap and silently cut people off the end).
  const render = (r: any) => fmtIncentiveRow(people.has(r.user_id) ? who(people.get(r.user_id)) : 'Unknown person', r, show(r), !userIds);
  const current = sorted.filter((r: any) => !isFormer(people.get(r.user_id)));
  const former = sorted.filter((r: any) => isFormer(people.get(r.user_id)));
  const sep = userIds ? '\n\n' : '\n';
  let text = `Incentives for ${month} (${listed.length} record(s)${former.length ? `: ${current.length} current employees, ${former.length} ${FORMER_PHRASE}s listed after them` : ''}):\n\n` + current.map(render).join(sep);
  if (former.length) text += `\n\nFormer employees (NOT current staff; leave out of current rankings and totals):\n` + former.map(render).join(sep);
  if (!userIds) text += '\n\n(Compact view. Name one person to see their goal-by-goal detail.)';
  if (!userIds && !sawAll(s.boss, s.ctx.role)) text += `\n(${PARTIAL_VIEW})`;
  return out(text, { ...src, ids: listed.map((r: any) => r.user_id) as string[], currency: 'PKR' });
}

export async function getSalary(s: Scope, args: any): Promise<Out> {
  const db = s.db;
  const src: ToolSource = { table: 'employee_compensation', currency: 'PKR' };
  let userIds: string[] | null = null;
  if (args?.person_name) {
    const people = await resolvePeople(db, args.person_name);
    if (!people.length) return out(await noActiveMatch(db, args.person_name), src);
    if (people.length > 1) return out(multiple(args.person_name, people), src);
    userIds = [people[0].id];
  }
  // Stricter than ec_select (which also lets an active OL read): the app shows
  // others' pay only on the Boss-only Salaries page; everyone else has "My
  // Compensation". So a non-Boss only ever gets their own.
  if (!s.boss) {
    if (aboutSomeoneElse(s, userIds)) return out(NOT_YOURS, src);
    userIds = [s.ctx.userId];
  }
  let compQ = db.from('employee_compensation').select('user_id, basic_salary, effective_from, last_change_reason');
  if (userIds) compQ = compQ.in('user_id', userIds);
  const { data: comp } = await compQ;
  if (!comp || !comp.length) {
    if (!s.boss) return out(s.ctx.role === 'boss' ? 'The Boss has no salary.' : 'No salary on record for you (My Compensation shows the same).', src);
    return out(userIds ? 'No salary on record for that person (the Boss has no salary).' : 'No salary records found.', src);
  }
  const p = await loadPeople(db, comp.map((c: any) => c.user_id));
  let histNote = '';
  if (userIds) {
    const { data: hist } = await db.from('salary_history')
      .select('effective_from, previous_amount, new_amount, increment_pct, change_reason')
      .eq('user_id', userIds[0]).order('effective_from', { ascending: false }).limit(5);
    if (hist && hist.length) {
      histNote = '\nRecent changes:\n' + hist.map((h: any) =>
        `  - ${h.effective_from}: ${money(h.previous_amount)} → ${money(h.new_amount)}${h.increment_pct != null ? ` (${h.increment_pct}%)` : ''}${h.change_reason ? ` — ${h.change_reason}` : ''}`).join('\n');
    }
  }
  // The Boss has no salary: excluded here even if a stray row exists.
  const shown = comp
    .map((c: any) => ({ c, prof: p.get(c.user_id) as any }))
    .filter((x: any) => x.prof && x.prof.role !== 'boss')
    .sort((a: any, b: any) => (Number(b.c.basic_salary) || 0) - (Number(a.c.basic_salary) || 0));
  const lineOf = (x: any) => `- ${who(x.prof)}: ${money(x.c.basic_salary)} (since ${x.c.effective_from || 'n/a'})`;
  const cur = shown.filter((x: any) => !isFormer(x.prof));
  const gone = shown.filter((x: any) => isFormer(x.prof));
  if (userIds) return out(`Salaries (${shown.length}):\n` + shown.map(lineOf).join('\n') + histNote, { ...src, ids: shown.map((x: any) => x.c.user_id), extra: { history: 'salary_history' } });
  // Everyone (Boss only): current staff first with their total, then the people who left, kept apart so
  // a payroll sum never includes them; and current staff who have NO salary row are named, not skipped.
  const total = cur.reduce((t: number, x: any) => t + (Number(x.c.basic_salary) || 0), 0);
  const { data: act } = await db.from('profiles').select('id, display_name, role, is_active, deleted_at')
    .is('deleted_at', null).eq('is_active', true).neq('role', 'boss').limit(500);
  const have = new Set(comp.map((c: any) => c.user_id));
  const none = (act || []).filter((x: any) => !have.has(x.id)).sort((a: any, b: any) => String(a.display_name).localeCompare(String(b.display_name)));
  let text = `Current employees' salaries (${cur.length}; total ${money(total)} per month):\n` + cur.map(lineOf).join('\n');
  if (none.length) text += `\n\nCurrent employees with NO salary record on file (not zero, just not recorded): ${none.map((x: any) => who(x)).join('; ')}.`;
  if (gone.length) text += `\n\nFormer employees (NOT current staff; excluded from the total above):\n` + gone.map(lineOf).join('\n');
  return out(text, { ...src, ids: shown.map((x: any) => x.c.user_id) });
}

// The roles the Performance page rates (src/lib/performanceApi.js listEvaluableUsers).
const RATED_ROLES = ['ol', 'pctl', 'tl', 'apc', 'ipc'];
export const COMPOSITE_CONCURRENCY = 4;
export const COMPOSITE_FAILED = 'composite could not be loaded (lookup failed), so this is NOT the Performance page figure';

export async function getPerformance(s: Scope, args: any): Promise<Out> {
  const db = s.db;
  const olView = !s.boss && isOlViewer(s.ctx.role);
  const rated = olView ? RATED_ROLES.filter((r) => olMay('performance', r)) : RATED_ROLES;
  let userIds: string[] | null = null;
  let single: any = null;
  if (args?.person_name) {
    const people = await resolvePeople(db, args.person_name);
    if (!people.length) return out(await noActiveMatch(db, args.person_name), { table: 'performance_ratings' });
    if (people.length > 1) return out(multiple(args.person_name, people), { table: 'performance_ratings' });
    userIds = [people[0].id]; single = people[0];
    // An OL's Performance page rates TLs, PCTLs, APCs and IPCs; no page rates other OLs, developers or ads managers.
    if (olView && people[0].id !== s.ctx.userId && !olMay('performance', people[0].role)) return out(NOT_YOURS, { table: 'performance_ratings' });
  }
  let month = String(args?.month || '').trim();
  if (!month) {
    const { data: mx } = await db.from('performance_ratings').select('month').order('month', { ascending: false }).limit(1);
    month = mx?.[0]?.month || '';
  }

  // RANKING (no name): the people come from PROFILES, not from performance_ratings.
  // That table only holds a row for someone who was rated, so ranking from it had two
  // faults. A Team Lead's performance is computed (reports + team), so in a current
  // month they have no row and silently vanished from "who is highest". And a rating
  // row outlives the employee, so people who had LEFT were ranked beside current staff,
  // with nothing in the text to say so or to say what their role was. Only active,
  // non-deleted staff are ranked here; the Boss carries no score. `role` narrows it.
  const roleArg = String(args?.role || '').trim().toLowerCase();
  if (olView && !args?.person_name && roleArg && !rated.includes(roleArg)) return out(NOT_YOURS, { table: 'performance_ratings' });
  let roster: any[] | null = null;
  if (!userIds) {
    // The roles the Performance page rates (listEvaluableUsers): not the Boss, developers or the Ads Manager.
    let pq = db.from('profiles').select('id, display_name, role, is_active, deleted_at')
      .is('deleted_at', null).eq('is_active', true).in('role', roleArg ? [roleArg] : rated).limit(500);
    const { data: ppl } = await pq;
    roster = ppl || [];
  }
  const rosterIds = roster ? roster.map((p: any) => p.id) : null;

  let rq = db.from('performance_ratings')
    .select('user_id, month, metrics, overall_score')
    .eq('month', month);
  if (userIds) rq = rq.in('user_id', userIds);
  else if (rosterIds && rosterIds.length) rq = rq.in('user_id', rosterIds);
  const { data: ratings } = rosterIds && !rosterIds.length ? { data: [] } : await rq;

  // People who were scored for this month but have since left. A finalised month keeps its snapshot
  // rows, and the Performance page lists them there as "departed"; they are never current staff.
  let goneIds: string[] = [];
  if (roster) {
    const [{ data: allRated }, { data: snaps }] = await Promise.all([
      db.from('performance_ratings').select('user_id').eq('month', month),
      db.from('performance_month_snapshots').select('user_id').eq('month', month),
    ]);
    const inRoster = new Set(rosterIds);
    goneIds = [...new Set([...(allRated || []), ...(snaps || [])].map((x: any) => x.user_id))].filter((id: any) => id && !inRoster.has(id)) as string[];
  }
  const ids = [...new Set([...(ratings || []).map((r: any) => r.user_id), ...(userIds || []), ...(rosterIds || []), ...goneIds])];
  const pmap = await loadPeople(db, ids);
  if (roster) goneIds = goneIds.filter((id) => { const g = pmap.get(id); return !!g && isFormer(g) && (roleArg ? g.role === roleArg : rated.includes(String(g.role))); });
  const nameOf = new Map([...pmap].map(([id, p]) => [id, p.display_name]));
  const whoOf = (id: string) => (pmap.has(id) ? who(pmap.get(id)) : 'Unknown person');

  // Composite headline (contract C3): the SAME number + level the Performance
  // page shows, via get_performance_composite, not overall_score (which is only
  // the manager-metrics pillar).
  const compUserIds: string[] = userIds || [...new Set([...(rosterIds || []), ...(ratings || []).map((r: any) => r.user_id), ...goneIds])].filter(Boolean) as string[];
  // v1 fired every call at once and silently fell back when one failed, so the
  // same question gave different headlines (WP-B, Lead decision 5). Here: at
  // most 4 at a time, one retry, and a failure is said, never hidden.
  const compMap = new Map<string, any>();
  const compFailed = new Set<string>();
  const loadComp = async (uid: string) => {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const { data: c, error } = await db.rpc('get_performance_composite', { p_user: uid, p_month: month });
        if (error) throw error;
        if (Array.isArray(c) && c.length) compMap.set(uid, c[0]);
        return;
      } catch { /* retry once, then report */ }
    }
    compFailed.add(uid);
  };
  for (let i = 0; i < compUserIds.length; i += COMPOSITE_CONCURRENCY) {
    await Promise.all(compUserIds.slice(i, i + COMPOSITE_CONCURRENCY).map(loadComp));
  }
  // get_performance_composite answers only callers allowed to see that person
  // (self, Boss, OL/developer, their manager), with a row even before any
  // rating: no rating AND no composite row means "not yours".
  if (aboutSomeoneElse(s, userIds) && !(ratings || []).length && !compMap.has(userIds![0]) && !compFailed.has(userIds![0])) {
    return out(NOT_YOURS, { table: 'performance_ratings' });
  }
  const LEVEL_LABEL: Record<string, string> = { promotion: 'Promotion', good: 'Good', warning: 'Warning', termination: 'Termination' };
  const headlineOf = (uid: string): string | null => {
    if (compFailed.has(uid)) return COMPOSITE_FAILED;
    const c = compMap.get(uid);
    if (!c) return null;
    // Withheld until the OL verifies the incentive plan (mig 257).
    if (c.level === 'pending_verification') {
      return 'composite withheld — incentive plan not yet verified by the OL';
    }
    if (c.composite_score == null) return null;
    const lvl = c.level ? (LEVEL_LABEL[String(c.level)] || String(c.level)) : '';
    return `composite ${Number(c.composite_score).toFixed(1)}/100${lvl ? ` — ${lvl}` : ''}`;
  };
  const compScoreOf = (r: any) => {
    const c = compMap.get(r.user_id);
    if (c && c.level === 'pending_verification') return -1;
    return c && c.composite_score != null ? Number(c.composite_score) : (Number(r.overall_score) || 0);
  };

  // 5 metrics: punctuality was dropped (mig 243) and is not reported.
  const metricLabel: Record<string, string> = {
    reporting: 'Reporting', responseTime: 'Response time',
    dailyTasksQuality: 'Daily-task quality', tasksProcessing: 'Task processing', overallWorkflow: 'Overall workflow',
  };
  const fmtRating = (r: any) => {
    const m = r.metrics || {};
    const parts = Object.keys(metricLabel).filter((k) => m[k] != null).map((k) => `${metricLabel[k]} ${m[k]}`);
    const ov = r.overall_score != null ? Number(r.overall_score).toFixed(1) : '?';
    const nm = whoOf(r.user_id);
    const head = headlineOf(r.user_id);
    const detail = `manager-metrics avg ${ov}/100${parts.length ? `; ${parts.join(', ')}` : ''}`;
    return head ? `${nm} — ${head} (${detail})` : `${nm} — ${detail}`;
  };

  let monthRange: { gte: string; lt: string } | null = null;
  if (month && /^\d{4}-\d{2}$/.test(month)) {
    const [y, mm] = month.split('-').map(Number);
    const next = mm === 12 ? `${y + 1}-01` : `${y}-${String(mm + 1).padStart(2, '0')}`;
    monthRange = { gte: `${month}-01`, lt: `${next}-01` };
  }
  let fq = db.from('performance_flags').select('user_id, type, severity, reason, created_at').order('created_at', { ascending: false }).limit(userIds ? 30 : 50);
  if (userIds) fq = fq.in('user_id', userIds);
  else if (rosterIds) fq = fq.in('user_id', rosterIds.length ? rosterIds : [NO_ONE]);   // an empty roster must not mean everyone
  if (monthRange) fq = fq.gte('created_at', monthRange.gte).lt('created_at', monthRange.lt);
  const { data: flags } = await fq;
  let wq = db.from('performance_warnings').select('user_id, reason, severity, created_at').order('created_at', { ascending: false }).limit(userIds ? 30 : 50);
  if (userIds) wq = wq.in('user_id', userIds);
  else if (rosterIds) wq = wq.in('user_id', rosterIds.length ? rosterIds : [NO_ONE]);
  if (monthRange) wq = wq.gte('created_at', monthRange.gte).lt('created_at', monthRange.lt);
  const { data: warns } = await wq;

  const extraIds = [...new Set([
    ...(flags || []).map((f: any) => f.user_id),
    ...(warns || []).map((w: any) => w.user_id),
  ])].filter((id) => id && !pmap.has(id));
  if (extraIds.length) (await loadPeople(db, extraIds as string[])).forEach((p, id) => pmap.set(id, p));

  const whoLabel = month ? ` in ${month}` : '';
  let text = '';
  if (roster) {
    const ratingOf = new Map((ratings || []).map((r: any) => [r.user_id, r]));
    // Keep someone only when the caller can see something about them: a rating row or a
    // composite answer (RLS and get_performance_composite withhold what is not theirs).
    const people = roster.filter((p: any) => ratingOf.has(p.id) || compMap.has(p.id) || compFailed.has(p.id));
    // One scale only: the composite. Failed and withheld lookups and people with no
    // composite sort after everyone who has one, never mixed in by a different number.
    const rank = (p: any) => {
      if (compFailed.has(p.id)) return -2;
      const c = compMap.get(p.id);
      if (c && c.level === 'pending_verification') return -1;
      return c && c.composite_score != null ? Number(c.composite_score) : -3;
    };
    const code = (role: unknown) => String(role || '?').toUpperCase().replace(/_/g, ' ');
    const lineOf = (p: any) => {
      const r = ratingOf.get(p.id);
      const head = headlineOf(p.id) || 'no composite score returned for this month';
      const detail = r
        ? `manager-metrics avg ${r.overall_score != null ? Number(r.overall_score).toFixed(1) : '?'}/100`
        : 'no manager-metric ratings stored for this month';
      return `- ${p.display_name} (${code(p.role)}) — ${head} (${detail})`;
    };
    // People with no score (not rated yet, or withheld) share ONE line per group
    // instead of one each, so the ranked names stay easy to read.
    const hasScore = (p: any) => rank(p) >= 0;
    const withheldOf = (p: any) => !compFailed.has(p.id) && compMap.get(p.id)?.level === 'pending_verification';
    const ROLE_ORDER = ['ol', 'pctl', 'tl', 'apc', 'ipc', 'ads_manager', 'developer'];
    const roles = [...new Set(people.map((p: any) => p.role))]
      .sort((a: any, b: any) => (ROLE_ORDER.indexOf(a) < 0 ? 99 : ROLE_ORDER.indexOf(a)) - (ROLE_ORDER.indexOf(b) < 0 ? 99 : ROLE_ORDER.indexOf(b)));
    if (!people.length) {
      text += `No performance data for ${roleArg ? roleLabelOf(roleArg) : 'active staff'}${whoLabel || ' (no data)'}.`;
    } else {
      text += `Performance for ${month} — ${people.length} active ${roleArg ? roleLabelOf(roleArg) : 'staff'}, ranked by composite score within each role `
        + '(the same figure the Performance page shows). Each name carries its role; former employees are listed separately at the end.'
        + (sawAll(s.boss, s.ctx.role) ? '' : ` ${PARTIAL_VIEW}`);
      for (const role of roles) {
        const grp = people.filter((p: any) => p.role === role).sort((a: any, b: any) => rank(b) - rank(a));
        const scored = grp.filter(hasScore);
        const failed = grp.filter((p: any) => compFailed.has(p.id));
        const withheld = grp.filter(withheldOf);
        const none = grp.filter((p: any) => !hasScore(p) && !compFailed.has(p.id) && !withheldOf(p));
        text += `\n\n${roleLabelOf(role)} (${grp.length}):`;
        if (scored.length) text += `\n${scored.map(lineOf).join('\n')}`;
        if (failed.length) text += `\n${failed.map(lineOf).join('\n')}`;
        if (withheld.length) text += `\n- Composite withheld (incentive plan not yet verified by the OL): ${withheld.map((p: any) => p.display_name).join(', ')}`;
        if (none.length) text += `\n- No composite score returned for this month (the tool does not say why; do not guess a reason): ${none.map((p: any) => p.display_name).join(', ')}`;
      }
      if (compFailed.size) text += `\n\n(The composite could not be loaded for ${compFailed.size} of ${compUserIds.length}; they are listed last and are not ranked by composite. Ask again to retry.)`;
    }
    // Former employees scored for that month: shown with their score (the Performance page lists them as
    // departed on a closed month) but kept out of the ranking above and out of "current staff".
    if (goneIds.length) {
      const ordered = goneIds.slice().sort((x, y) => (Number(compMap.get(y)?.composite_score) || -1) - (Number(compMap.get(x)?.composite_score) || -1));
      text += `\n\nFORMER employees (NOT current staff; not part of the ranking above) who were scored for ${month}:\n`
        + ordered.map((id) => `- ${whoOf(id)} — ${headlineOf(id) || 'no composite score returned'}`).join('\n');
    }
  } else if (ratings && ratings.length) {
    // A failed composite ranks last: its metrics average is a different number.
    const score = (r: any) => (compFailed.has(r.user_id) ? -2 : compScoreOf(r));
    const sorted = ratings.slice().sort((a: any, b: any) => score(b) - score(a));
    text += `Performance for ${month} (${ratings.length}; headline = composite score / level, same as the Performance page):\n` + sorted.map((r: any) => `- ${fmtRating(r)}`).join('\n');
    if (compFailed.size) text += `\n(The composite could not be loaded for ${compFailed.size} of ${compUserIds.length}; they are listed last and are not ranked by composite. Ask again to retry.)`;
  } else {
    const head = single && userIds ? headlineOf(userIds[0]) : null;
    text += head
      ? `${whoOf(single.id)} — ${head}${whoLabel} (no manager-metric ratings recorded, so the metrics pillar is not rated yet).`
      : `No performance ratings for ${single ? single.display_name : 'anyone'}${whoLabel || ' (no data)'}.`;
  }

  if (flags && flags.length) {
    text += `\n\nFlags${whoLabel} (${flags.length}; green = positive, red = concern):\n` + flags.map((f: any) =>
      `- ${whoOf(f.user_id)} · ${f.type || '?'}${f.severity ? `/${f.severity}` : ''} (${String(f.created_at).slice(0, 10)}): ${String(f.reason || '').slice(0, 300)}`).join('\n');
  } else if (single) {
    text += `\n\nNo performance flags for ${single.display_name}${whoLabel}.`;
  }
  if (warns && warns.length) {
    text += `\n\nWarnings${whoLabel} (${warns.length}):\n` + warns.map((w: any) =>
      `- ${whoOf(w.user_id)}${w.severity ? ` (${w.severity})` : ''} (${String(w.created_at).slice(0, 10)}): ${String(w.reason || '').slice(0, 300)}`).join('\n');
  }
  return out(text, { table: 'performance_ratings', period: month || null, ids, extra: { composite: 'get_performance_composite' } });
}

export async function getAttendance(s: Scope, args: any): Promise<Out> {
  const db = s.db;
  let userIds: string[] | null = null;
  let single: any = null;
  if (args?.person_name) {
    const people = await resolvePeople(db, args.person_name);
    if (!people.length) return out(await noActiveMatch(db, args.person_name), { table: 'attendance' });
    if (people.length > 1) return out(multiple(args.person_name, people), { table: 'attendance' });
    userIds = [people[0].id]; single = people[0];
    if (!s.boss && isOlViewer(s.ctx.role) && people[0].id !== s.ctx.userId && !olMay('attendance', people[0].role)) return out(NOT_YOURS, { table: 'attendance' });
  }
  const other = aboutSomeoneElse(s, userIds);
  let month = String(args?.month || '').trim();
  if (!month) {
    const { data: mx } = await db.from('attendance').select('date').order('date', { ascending: false }).limit(1);
    month = mx?.[0]?.date ? String(mx[0].date).slice(0, 7) : '';
  }
  const src: ToolSource = { table: 'attendance', period: month || null, extra: { pct: 'attendance_month_breakdown_bulk' } };

  // The % is the ONE canonical number every UI surface shows
  // (attendance_month_breakdown_bulk, mig 252), not a raw row count. The RPC
  // needs explicit ids; the team case enumerates active non-Boss staff.
  let rpcIds: string[] = userIds || [];
  if (!userIds) {
    let tq = db.from('profiles').select('id').is('deleted_at', null).eq('is_active', true).neq('role', 'boss').limit(300);
    if (!s.boss && isOlViewer(s.ctx.role)) tq = tq.in('role', [...OL_SEES.attendance]);
    const { data: team } = await tq;
    rpcIds = (team || []).map((p: any) => p.id);
  }
  let breakdown: any[] = [];
  try {
    const { data: bd, error } = await db.rpc('attendance_month_breakdown_bulk', { p_month: month, p_user_ids: rpcIds });
    if (error) throw error;
    breakdown = bd || [];
  } catch (e) {
    console.warn('data-tools attendance breakdown failed:', String((e as Error)?.message || e).slice(0, 150));
  }
  const bdOf = new Map(breakdown.map((b: any) => [b.user_id, b]));

  // Raw rows only for hours / breaks / the day-by-day log.
  const range = monthToRange(month);
  let q = db.from('attendance').select('user_id, date, clock_in, clock_out, total_work_ms, total_break_ms, status').order('date', { ascending: false });
  if (userIds) q = q.in('user_id', userIds);
  if (range) q = q.gte('date', range.gte).lt('date', range.lt);
  const RAW_CAP = userIds ? 60 : 1000;   // PostgREST returns at most 1000 rows whatever .limit() says
  q = q.limit(RAW_CAP);
  const { data: att } = await q;
  const rows = att || [];
  const hoursTruncated = !userIds && rows.length >= RAW_CAP;

  const ids = [...new Set([...rpcIds, ...rows.map((a: any) => a.user_id)])].filter(Boolean);
  const pmap = await loadPeople(db, ids as string[]);
  const nameOf = new Map([...pmap].map(([id, p]) => [id, p.display_name]));

  const agg = new Map<string, { days: number; work: number; brk: number }>();
  for (const a of rows) {
    const cur = agg.get(a.user_id) || { days: 0, work: 0, brk: 0 };
    cur.days += 1; cur.work += Number(a.total_work_ms) || 0; cur.brk += Number(a.total_break_ms) || 0;
    agg.set(a.user_id, cur);
  }

  const open = String(month) >= karachiMonthNow();
  const soFar = open ? ' (so far this month)' : '';
  const pctPhrase = (uid: string): string | null => {
    const b = bdOf.get(uid);
    if (!b) return null;
    return `${b.pct_display}% attendance (${b.days_present} present of ${b.covered_days} covered, ${b.elapsed_days} elapsed days)`;
  };

  if (userIds && args?.detail) {
    if (other && !rows.length && !bdOf.has(userIds[0])) return out(NOT_YOURS, src);
    const lines = rows.slice(0, 40).map((a: any) =>
      `  - ${a.date}: ${hms(a.total_work_ms)} worked (in ${pktTime(a.clock_in)}, out ${pktTime(a.clock_out)}${Number(a.total_break_ms) > 0 ? `, break ${hms(a.total_break_ms)}` : ''})`);
    const s = agg.get(userIds[0]) || { days: 0, work: 0, brk: 0 };
    const pl = pctPhrase(userIds[0]);
    return out(`Attendance for ${who(single)} — ${month}${soFar}${pl ? ` — ${pl}` : ''} (hours: ${hms(s.work)} total, avg ${hms(Math.round(s.work / Math.max(1, s.days)))}/day). Clock times below are Pakistan time (PKT).\n${lines.join('\n')}` + (rows.length > 40 ? `\n  …and ${rows.length - 40} more days.` : ''), { ...src, ids: userIds });
  }

  if (userIds) {
    const s = agg.get(userIds[0]) || { days: 0, work: 0, brk: 0 };
    const pl = pctPhrase(userIds[0]);
    if (!pl && !rows.length) return out(other ? NOT_YOURS : `No attendance data for ${who(single)} in ${month || '(no data)'}.`, other ? src : { ...src, ids: userIds });
    return out(`Attendance for ${who(single)} — ${month}${soFar}: ${pl || 'no coverage data'}. Hours: ${hms(s.work)} total worked (avg ${hms(Math.round(s.work / Math.max(1, s.days)))}/day), ${hms(s.brk)} on breaks.`, { ...src, ids: userIds });
  }

  const teamRows = rpcIds
    .map((uid) => {
      const b = bdOf.get(uid);
      const s = agg.get(uid) || { days: 0, work: 0, brk: 0 };
      return { name: pmap.has(uid) ? who(pmap.get(uid)) : 'Unknown person', pct: b ? Number(b.pct) : null, pctDisp: b ? b.pct_display : null, present: b ? b.days_present : s.days, work: s.work };
    })
    .filter((r) => r.pct != null || r.work > 0)
    .sort((a, b) => (b.pct ?? -1) - (a.pct ?? -1));
  if (!teamRows.length) return out(`No attendance data for ${month || '(no data)'}.`, src);
  // People who clocked in during the month and have since left: their own block, never ranked with current staff.
  const fmtRow = (r: any) => `- ${r.name}: ${r.pctDisp != null ? `${r.pctDisp}%` : 'n/a'} (${r.present} present), ${hms(r.work)} worked`;
  const formerIds = [...new Set(rows.map((a: any) => a.user_id))].filter((id: any) => !rpcIds.includes(id) && isFormer(pmap.get(id))) as string[];
  let formerBlock = '';
  if (formerIds.length) {
    let fbd: any[] = [];
    try { const { data: f } = await db.rpc('attendance_month_breakdown_bulk', { p_month: month, p_user_ids: formerIds }); fbd = f || []; } catch { /* the hours still show */ }
    const fOf = new Map(fbd.map((b: any) => [b.user_id, b]));
    formerBlock = `\n\nFORMER employees (NOT current staff; not ranked above) who clocked in during ${month}:\n` + formerIds.map((uid) => {
      const b = fOf.get(uid) as any, a = agg.get(uid) || { days: 0, work: 0, brk: 0 };
      return fmtRow({ name: who(pmap.get(uid)), pctDisp: b ? b.pct_display : null, present: b ? b.days_present : a.days, work: a.work });
    }).join('\n');
  }
  return out(`Team attendance summary — ${month}${soFar} (${teamRows.length} current employees, ranked by attendance %; every name carries its role):\n` +
    teamRows.map(fmtRow).join('\n') + formerBlock +
    (hoursTruncated ? '\n\n(Results may be truncated: the hours query hit its 1000-row limit for this month, so some employees\' hours could be understated. The attendance % is from the canonical engine and is complete.)' : ''), src);
}

export async function getLeave(s: Scope, args: any): Promise<Out> {
  const db = s.db;
  let userIds: string[] | null = null;
  let single: any = null;
  if (args?.person_name) {
    const people = await resolvePeople(db, args.person_name);
    if (!people.length) return out(await noActiveMatch(db, args.person_name), { table: 'leave_requests' });
    if (people.length > 1) return out(multiple(args.person_name, people), { table: 'leave_requests' });
    userIds = [people[0].id]; single = people[0];
  }
  let q = db.from('leave_requests')
    .select('requester_id, type, other_title, start_date, end_date, status, reason, paid_days, unpaid_days')
    .order('start_date', { ascending: false });
  if (userIds) q = q.in('requester_id', userIds);
  if (args?.status) q = q.eq('status', String(args.status));
  if (args?.type) q = q.eq('type', String(args.type));
  const range = args?.month ? monthToRange(String(args.month)) : null;
  // Overlap, not start date: a leave running 28 Sep to 3 Oct also belongs to October.
  if (range) q = q.lt('start_date', range.lt).gte('end_date', range.gte);
  const LEAVE_CAP = 60;
  q = q.limit(LEAVE_CAP);
  const { data: lv } = await q;
  const src: ToolSource = { table: 'leave_requests', period: args?.month ? String(args.month) : null, status: args?.status ? String(args.status) : null };
  if (!lv || !lv.length) return out(aboutSomeoneElse(s, userIds) ? NOT_YOURS : `No leave requests found${single ? ` for ${who(single)}` : ''}${args?.status ? ` (${args.status})` : ''}${args?.type ? ` of type ${args.type}` : ''}${args?.month ? ` in ${args.month}` : ''}.`, src);
  const leaveTruncated = lv.length >= LEAVE_CAP;
  const ids = [...new Set(lv.map((l: any) => l.requester_id))];
  const people = await loadPeople(db, ids as string[]);
  const span = (l: any) => l.start_date === l.end_date ? l.start_date : `${l.start_date}→${l.end_date}`;
  const paid = (l: any) => {
    const p = Number(l.paid_days) || 0, u = Number(l.unpaid_days) || 0;
    if (l.status === 'rejected' || l.status === 'cancelled') return '';   // nothing was taken
    return p || u ? ` [${p ? `${p} paid` : ''}${p && u ? ', ' : ''}${u ? `${u} unpaid` : ''}]` : '';
  };
  const lines = lv.map((l: any) =>
    `- ${people.has(l.requester_id) ? who(people.get(l.requester_id)) : 'Unknown person'} · ${l.type === 'half_leave' ? 'half leave' : l.type}${l.other_title ? ` (${l.other_title})` : ''} · ${span(l)} · ${l.status}${paid(l)}${l.reason ? ` — ${String(l.reason).replace(/\s+/g, ' ').slice(0, ids.length > 1 ? 70 : 120)}` : ''}`);
  return out(`Leave requests${args?.month ? ` that overlap ${args.month}` : ''} (${lv.length}; rejected and cancelled ones took no leave):\n` + lines.join('\n') +
    (leaveTruncated ? `\n\n(Results may be truncated at ${LEAVE_CAP} requests — narrow by person, status, type or month for a complete list; do not treat this as the full total.)` : ''),
  { ...src, ids: ids as string[] });
}
