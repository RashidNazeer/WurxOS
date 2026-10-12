// Role safeguards: every data tool × every staff role, run AS a real dev user
// through their own RLS (no JWT: `set local role authenticated` +
// request.jwt.claims inside a transaction that is always rolled back, as QA's
// acl.sql does). DEV ONLY, read-only.
//   node --experimental-strip-types scripts/test-tools-roles.mjs
//
// For each role it checks, against an oracle computed under the SAME simulated
// identity with plain SQL:
//   • no leak: every person a people/pay tool names is one that user's RLS
//     returns for that table (and for salary: only themselves);
//   • completeness: record counts equal what RLS allows;
//   • colleagues they can't see → the polite refusal, not "no data";
//   • page guards the app adds on top of RLS (developer / ads_manager).
// Never prints names or pay: roles, counts and PASS/FAIL only.
import path from 'node:path';
import pg from 'pg';
import { createRequire } from 'node:module';
import { ASSISTANT, devDbUrl, readEnv, SSL } from './dev-env.mjs';
import { runAs } from './lib/pg-supabase.mjs';

const require = createRequire(path.join(ASSISTANT, 'package.json'));
const { createClient } = require('@supabase/supabase-js');
const env = readEnv();
{
  const ref = env.WURXOS_DEV_PROJECT_REF || '';
  let host = '';
  try { host = new URL(env.VITE_SUPABASE_URL).hostname.toLowerCase(); } catch { /* checked below */ }
  if (!/^[a-z0-9]{20}$/.test(ref) || ref === 'xoaaidgvblondjpvxjqp' || host !== `${ref}.supabase.co`) {
    console.error('Refusing: VITE_SUPABASE_URL is not the dev project (WURXOS_DEV_PROJECT_REF).');
    process.exit(1);
  }
}
const svc = createClient(env.VITE_SUPABASE_URL, env.WURXOS_DEV_SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
const T = await import('../../supabase/functions/_shared/ai/tools/index.ts');
const db = new pg.Client({ connectionString: devDbUrl(), ssl: SSL });
await db.connect();
const q = async (sql, params) => (await db.query(sql, params)).rows;

// ---- fixtures picked from dev at run time (read as the postgres role)
const everyone = await q(`select id, display_name, role, reports_to, is_active, deleted_at from profiles order by role, display_name`);
const staff = everyone.filter((p) => p.is_active && !p.deleted_at);
// Every profile, active or not: incentives and leave rows of former staff are named too.
const idsByName = new Map();
for (const p of everyone) idsByName.set(p.display_name, [...(idsByName.get(p.display_name) || []), p.id]);
const month = (await q(`select max(month) m from incentives`))[0].m;
const attMonth = (await q(`select to_char(max(date), 'YYYY-MM') m from attendance`))[0].m;
const perfMonth = (await q(`select max(month) m from performance_ratings`))[0].m;
// Per role: the user with the most going on (reports, compensation, incentives).
const scoreSql = `select p.id, p.display_name, p.role,
    (select count(*) from profiles r where r.reports_to = p.id and r.deleted_at is null) reports,
    (select count(*) from employee_compensation c where c.user_id = p.id) comp,
    (select count(*) from incentives i where i.user_id = p.id) inc
  from profiles p where p.deleted_at is null and p.is_active and p.role = $1
  order by 4 desc, 5 desc, 6 desc, p.display_name limit 1`;
const ROLES = T.STAFF_ROLES.filter((r) => r !== 'boss');
const users = {};
for (const r of ROLES) users[r] = (await q(scoreSql, [r]))[0];
// A colleague for "someone else" questions: an APC who is not the user and not their report.
const otherFor = (u) => staff.find((p) => p.role === 'apc' && p.id !== u.id && p.reports_to !== u.id && (idsByName.get(p.display_name) || []).length === 1);

// ---- parsing the subjects (people) a tool names
const SUBJECTS = {
  get_incentives: [/^(.+?) — \d{4}-\d{2} \((?:basic salary|verified)/gm],
  get_salary: [/^- (.+?) \([a-z_]+\): PKR/gm],
  get_performance: [
    /^- ([^·(\n]+?) — (?:composite|manager-metrics)/gm,        // rating lines
    /^(?!- )([^\n]+?) — composite/gm,                          // one person, no ratings
    /^- ([^·(\n]+?) · /gm,                                     // flag lines
    /^- ([^·(\n]+?)(?: \([a-z]+\))? \(\d{4}-\d{2}-\d{2}\):/gm, // warning lines
  ],
  get_attendance: [/^- (.+?): (?:\d+%|n\/a) \(/gm, /^Attendance for (.+?) — /gm],
  get_leave: [/^- (.+?) · /gm],
};
const subjects = (tool, text) => [...new Set((SUBJECTS[tool] || []).flatMap((re) => [...text.matchAll(re)].map((m) => m[1])))];
const count = (re, text) => Number(text.match(re)?.[1] ?? 0);

let fail = 0, checks = 0, leaks = 0;
const check = (label, ok, extra = '') => { checks++; if (!ok) fail++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra ? `  ${extra}` : ''}`); };

// The definer functions' own gate (who may see whom), as SQL for the oracle.
// $2 = the caller. It must match the live function bodies, checked here once.
const GATE_SQL = `select p.id from profiles p, profiles me where me.id = $2 and (me.role = 'boss'
  or (me.role in ('ol', 'developer') and me.is_active and me.deleted_at is null) or p.id = me.id or p.reports_to = me.id)`;
for (const fn of ['get_performance_composite', 'attendance_month_breakdown_bulk']) {
  const body = (await q(`select pg_get_functiondef(p.oid) d from pg_proc p where p.proname = $1 and p.pronamespace = 'public'::regnamespace`, [fn]))[0].d.replace(/\s+/g, ' ');
  check(`${fn}: live gate = the simulated gate`, /is_boss\(v_uid\)/.test(body) && /role in \('ol', ?'developer'\)/.test(body) && /reports_to = v_uid/.test(body) && /session_user in \('postgres', ?'supabase_admin'\)/.test(body));
}
const leakCheck = (label, tool, text, allowed) => {
  const names = subjects(tool, text);
  const bad = names.filter((n) => !(idsByName.get(n) || []).some((id) => allowed.has(id)));
  leaks += bad.length;
  check(`${label}: 0 leaks`, bad.length === 0, `${names.length} people named, ${bad.length} outside RLS`);
};

for (const role of ROLES) {
  const u = users[role];
  if (!u) { console.log(`SKIP  ${role}: no active user on dev`); continue; }
  const other = otherFor(u);
  const tag = `${role}`;
  // One transaction per tool call (short; always rolled back).
  const as = (fn) => runAs(db, u.id, async (client) => fn(client, { userId: u.id, role: u.role, userClient: client }));
  const tool = (name, args) => as((_, ctx) => T.runDataTool(svc, ctx, name, args));
  const oracle = (sql, params = []) => runAs(db, u.id, async () => (await db.query(sql, params)).rows);

  // salary: own only (app rule), whatever RLS allows
  {
    const r = await tool('get_salary', {});
    const names = subjects('get_salary', r.text);
    const hasOwn = (await q('select 1 from employee_compensation where user_id = $1', [u.id])).length > 0;
    check(`${tag} get_salary {}: own only`, hasOwn ? names.length === 1 && idsByName.get(names[0])?.includes(u.id) : /No salary on record for you/.test(r.text), `${names.length} line(s)`);
    if (other) check(`${tag} get_salary {colleague}: refused`, (await tool('get_salary', { person_name: other.display_name })).text === T.NOT_YOURS);
    const rlsAll = (await oracle('select count(*)::int n from employee_compensation'))[0].n;
    if (rlsAll > 1) console.log(`      note: ${role} RLS alone would expose ${rlsAll} salaries; the tool shows ${names.length}`);
  }
  // incentives
  {
    const allowedRows = await oracle('select user_id from incentives where month = $1', [month]);
    const allowed = new Set(allowedRows.map((r) => r.user_id));
    const r = await tool('get_incentives', { month });
    if (!T.PAGE_ROLES.get_incentives.includes(role)) check(`${tag} get_incentives: no Incentives page → refused`, r.text === T.NOT_YOURS);
    else {
      leakCheck(`${tag} get_incentives {}`, 'get_incentives', r.text, allowed);
      check(`${tag} get_incentives {}: count = RLS`, allowed.size === 0 ? /^No incentive records/.test(r.text) : count(/\((\d+) record\(s\)\)/, r.text) === allowedRows.length, `${allowedRows.length} allowed`);
      if (other) {
        const o = await tool('get_incentives', { month, person_name: other.display_name });
        check(`${tag} get_incentives {colleague}: ${allowed.has(other.id) ? 'shown (RLS allows)' : 'refused'}`, allowed.has(other.id) ? /record\(s\)/.test(o.text) : o.text === T.NOT_YOURS);
      }
      if (role === 'tl') {
        const reps = staff.filter((p) => p.reports_to === u.id).map((p) => p.id);
        const repRows = allowedRows.filter((x) => reps.includes(x.user_id)).length;
        check(`tl sees their APCs' incentives (inc_select: reports_to)`, repRows > 0 ? subjects('get_incentives', r.text).some((n) => (idsByName.get(n) || []).some((id) => reps.includes(id))) : true, `${repRows} report rows`);
      }
    }
  }
  // performance
  {
    const r = await tool('get_performance', { month: perfMonth });
    if (!T.PAGE_ROLES.get_performance.includes(role)) check(`${tag} get_performance: no Performance page → refused`, r.text === T.NOT_YOURS);
    else {
      const rows = await oracle(`select user_id from performance_ratings where month = $1
        union select user_id from performance_flags union select user_id from performance_warnings`, [perfMonth]);
      const ratings = (await oracle('select count(*)::int n from performance_ratings where month = $1', [perfMonth]))[0].n;
      leakCheck(`${tag} get_performance {}`, 'get_performance', r.text, new Set(rows.map((x) => x.user_id)));
      check(`${tag} get_performance {}: count = RLS`, ratings ? count(/^Performance for \S+ \((\d+);/m, r.text) === ratings : /^No performance ratings/.test(r.text), `${ratings} allowed`);
      if (other && role !== 'ol') check(`${tag} get_performance {colleague}: refused`, (await tool('get_performance', { month: perfMonth, person_name: other.display_name })).text === T.NOT_YOURS);
    }
  }
  // attendance
  {
    const r = await tool('get_attendance', { month: attMonth });
    // Raw rows by att_select, plus the breakdown RPC's own gate (see GATE_SQL).
    const rows = await oracle(`select user_id from attendance where date >= ($1 || '-01')::date and date < (($1 || '-01')::date + interval '1 month')
      union ${GATE_SQL}`, [attMonth, u.id]);
    leakCheck(`${tag} get_attendance {}`, 'get_attendance', r.text, new Set(rows.map((x) => x.user_id)));
    if (other && !rows.some((x) => x.user_id === other.id)) check(`${tag} get_attendance {colleague}: refused`, (await tool('get_attendance', { month: attMonth, person_name: other.display_name })).text === T.NOT_YOURS);
  }
  // leave
  {
    const r = await tool('get_leave', {});
    const rows = await oracle('select requester_id from leave_requests');
    leakCheck(`${tag} get_leave {}`, 'get_leave', r.text, new Set(rows.map((x) => x.requester_id)));
    if (role === 'apc') {
      // Control: the detector must catch a leak. The service-role (Boss) answer,
      // judged against this APC's RLS, has to show people outside it.
      const boss = (await q(`select id from profiles where role = 'boss' and is_active limit 1`))[0].id;
      const full = await T.runDataTool(svc, { userId: boss, role: 'boss' }, 'get_leave', {});
      const outside = subjects('get_leave', full.text).filter((n) => !(idsByName.get(n) || []).some((id) => rows.some((x) => x.requester_id === id)));
      check('control: the leak detector flags service-role output for an APC', outside.length > 0, `${outside.length} people outside the APC's RLS`);
    }
    check(`${tag} get_leave {}: count = RLS`, rows.length ? count(/^Leave requests \((\d+)\)/, r.text) === Math.min(60, rows.length) : /^No leave requests/.test(r.text), `${rows.length} allowed`);
    if (other && !rows.some((x) => x.requester_id === other.id)) check(`${tag} get_leave {colleague}: refused`, (await tool('get_leave', { person_name: other.display_name })).text === T.NOT_YOURS);
  }
  // brands & reports
  {
    const brands = await oracle('select id, brand_name from brands');
    const lb = await tool('list_brands', {});
    check(`${tag} list_brands = brands RLS`, brands.length ? count(/^Brands you can see \((\d+)\)/, lb.text) === Math.min(200, brands.length) : lb.text === 'No brands found.', `${brands.length} visible`);
    const approved = (await oracle(`select count(*)::int n from reports where status = 'approved'`))[0].n;
    const gr = await tool('get_reports', {});
    check(`${tag} get_reports {} = can_view_report`, approved ? count(/^Reports \((\d+) matched\)/m, gr.text) === Math.min(15, approved) : /No matching reports/.test(gr.text), `${approved} approved visible`);
    const ownOnly = (await oracle(`select count(*)::int n from reports r where r.author_id = $1 and not exists (select 1 from brands b where b.id = r.brand_id)`, [u.id]))[0].n;
    if (ownOnly) {
      // can_view_report shows the author's own report; its brand row is hidden by
      // brands RLS, so the tool resolves the NAME via the service client.
      const [rep] = await oracle(`select r.brand_id, r.period_label from reports r where r.author_id = $1 and r.status = 'approved'
        and not exists (select 1 from brands b where b.id = r.brand_id) order by r.period_start desc limit 1`, [u.id]);
      if (rep) {
        const name = (await q('select brand_name from brands where id = $1', [rep.brand_id]))[0].brand_name;
        const t = (await tool('get_reports', { period: rep.period_label })).text;
        check(`${tag} own report on a brand they can't view: named, not "Unknown brand"`, t.includes(`- ${name} · ${rep.period_label}`) && !t.includes('Unknown brand'), `${ownOnly} such report(s)`);
      }
    }
    const hidden = (await q('select brand_name from brands order by brand_name')).map((b) => b.brand_name).find((n) => !brands.some((b) => b.brand_name === n));
    if (hidden) check(`${tag} brand_overview {brand they can't view}: not found`, /^No brand matches/.test((await tool('brand_overview', { brand: hidden })).text));
    if (brands.length) {
      const b = brands[0];
      const bmm = (await oracle('select count(*)::int n from brand_monthly_metrics where brand_id = $1', [b.id]))[0].n;
      const ov = await tool('brand_overview', { brand: b.brand_name });
      const shown = count(/Monthly targets vs achieved \(latest (\d+)\)/, ov.text);
      check(`${tag} brand_overview: targets = bmm RLS`, bmm ? shown === Math.min(3, bmm) : /none I can show you/.test(ov.text), `${bmm} rows allowed`);
    }
    const rk = await tool('rank_brands', { metric: 'gmv', period: 'August 2026' });
    const active = brands.length ? (await oracle(`select count(*)::int n from brands where lower(status) = 'active'`))[0].n : 0;
    check(`${tag} rank_brands coverage over visible active brands`, rk.data ? rk.data.active === active : /No brands visible/.test(rk.text), `${active} active visible`);
    const ag = await tool('get_agenda_tasks', { limit: 100 });
    const tasks = (await oracle('select count(*)::int n from agenda_tasks'))[0].n;
    check(`${tag} get_agenda_tasks = RLS`, tasks ? count(/^Agenda tasks \((\d+)\)/, ag.text) === Math.min(100, tasks) : /^No agenda tasks/.test(ag.text), `${tasks} visible`);
  }
  // directory: profiles are readable by every authenticated user (RLS); email,
  // responsibilities and employment type are shown to Boss/OL only (Lead decision).
  check(`${tag} get_employees runs`, /^Employees \(\d+\)/.test((await tool('get_employees', {})).text));
  {
    const target = staff.find((p) => p.id !== u.id && (idsByName.get(p.display_name) || []).length === 1 && p.role !== 'boss');
    const t = (await tool('find_person', { name: target.display_name })).text;
    const [row] = await q('select email, responsibilities, employment_type from profiles where id = $1', [target.id]);
    const extras = /- (Email|Responsibilities|Employment):/.test(t);
    if (role === 'ol') check(`ol find_person: full card`, extras || (!row.email && !(row.responsibilities || []).length && !row.employment_type));
    else check(`${tag} find_person: no email / responsibilities / employment`, !extras && /- Role: /.test(t));
  }
}

await db.end();
console.log(`\n${checks - fail}/${checks} checks pass; leaks: ${leaks}.`);
process.exit(fail ? 1 : 0);
