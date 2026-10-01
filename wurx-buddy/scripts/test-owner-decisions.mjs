// Owner decisions Q1, Q5, Q6 (app-guides/REVIEW.md): RLS proof on dev.
// Every scenario runs in ONE transaction that is always rolled back: set-up as
// postgres, then `set local role authenticated` + request.jwt.claims per actor
// (the same simulation as QA's acl.sql). DEV ONLY; prints roles and counts only.
//   node scripts/test-owner-decisions.mjs
// Q3 and Q4 are UI-only (no policy change); Q3's server side is re-checked below.
import pg from 'pg';
import { devDbUrl, SSL } from './dev-env.mjs';

const db = new pg.Client({ connectionString: devDbUrl(), ssl: SSL });
await db.connect();
const q = async (sql, p) => (await db.query(sql, p)).rows;
const one = async (sql, p) => (await q(sql, p))[0];

let fail = 0, n = 0;
const check = (label, ok, extra = '') => { n++; if (!ok) fail++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra ? `  ${extra}` : ''}`); };
const as = async (uid) => {
  await db.query('reset role');
  await db.query("select set_config('request.jwt.claims', $1, true), set_config('request.jwt.claim.sub', $2, true), set_config('request.jwt.claim.role', 'authenticated', true)",
    [JSON.stringify({ sub: uid, role: 'authenticated' }), uid]);
  await db.query('set local role authenticated');
};
const asPostgres = () => db.query('reset role');
const raises = async (sql, p) => {
  await db.query('savepoint t');
  try { await db.query(sql, p); await db.query('release savepoint t'); return null; } catch (e) { await db.query('rollback to savepoint t'); return e.message; }
};
async function scenario(name, fn) {
  await db.query('begin');
  try { await fn(); } catch (e) { fail++; console.log(`FAIL  ${name}: ${e.message}`); } finally { await db.query('rollback'); }
}

const pick = (role) => one(`select id from profiles where role = $1 and is_active and deleted_at is null order by created_at limit 1`, [role]);
const pickN = (role, k) => q(`select id from profiles where role = $1 and is_active and deleted_at is null order by created_at limit $2`, [role, k]);
const boss = await pick('boss'), ol = await pick('ol'), tl = await pick('tl'), am = await pick('ads_manager'), dev = await pick('developer');
const [apc1, apc2] = await pickN('apc', 2);

// ---------------------------------------------------------------- Q1
await scenario('Q1', async () => {
  // Even with a manager set, an Ads Manager's leave goes to the Boss.
  await db.query('update profiles set reports_to = $1 where id = $2', [tl.id, am.id]);
  await as(am.id);
  const { id } = await one(`insert into leave_requests (requester_id, type, start_date, end_date, reason)
    values ($1, 'wfh', current_date + 30, current_date + 30, 'rls test') returning id`, [am.id]);
  await asPostgres();
  check('Q1 approver of an Ads Manager request = Boss (reports_to set to a TL)', (await one('select leave_current_approver($1) a', [id])).a === boss.id);
  check('Q1 legacy leave_approver = Boss', (await one('select leave_approver($1) a', [am.id])).a === boss.id);
  check('Q1 "New leave request" notification goes to the Boss', (await one(`select count(*)::int c from notifications where entity_id = $1 and recipient_id = $2 and action = 'leave.requested'`, [id, boss.id])).c === 1);
  check('Q1 …and not to the TL', (await one(`select count(*)::int c from notifications where entity_id = $1 and recipient_id = $2`, [id, tl.id])).c === 0);
  await as(tl.id);
  check('Q1 the TL no longer sees the request', (await one('select count(*)::int c from leave_requests where id = $1', [id])).c === 0);
  check('Q1 the TL cannot decide it', /not authorized/.test(await raises(`select leave_decide($1, 'approve', null)`, [id]) || ''));
  await as(boss.id);
  const err = await raises(`select leave_decide($1, 'approve', null)`, [id]);
  check('Q1 the Boss can approve it', err === null, err || '');
  // Unchanged for other roles: an APC's approver is still their TL.
  await asPostgres();
  const apcTl = await one('select reports_to r from profiles where id = $1', [apc1.id]);
  if (apcTl.r) {
    await as(apc1.id);
    const { id: a } = await one(`insert into leave_requests (requester_id, type, start_date, end_date, reason)
      values ($1, 'wfh', current_date + 31, current_date + 31, 'rls test') returning id`, [apc1.id]);
    await asPostgres();
    check('Q1 control: an APC request still goes to their TL', (await one('select leave_current_approver($1) a', [a])).a === apcTl.r);
  }
});

// ---------------------------------------------------------------- Q5
await scenario('Q5', async () => {
  // A TL sends a poll to one APC (target 'users' — what a TL may choose).
  await asPostgres();
  await db.query('update profiles set reports_to = $1 where id = $2', [tl.id, apc1.id]);
  await as(tl.id);
  const b = await one(`insert into broadcasts (author_id, title, body, target, target_user_ids, response_options)
    values ($1, 'RLS test poll', 'x', 'users', array[$2]::uuid[], '[{"id":"a","label":"Acknowledged"}]'::jsonb) returning id`, [tl.id, apc1.id]);
  await asPostgres();
  check('Q5 dispatch still notifies the recipient', (await one(`select count(*)::int c from notifications where entity_id = $1 and recipient_id = $2 and action = 'broadcast'`, [b.id, apc1.id])).c === 1);
  check('Q5 dispatch records exactly the recipient', (await one('select count(*)::int c from broadcast_recipients where broadcast_id = $1', [b.id])).c === 1);
  const sees = async (uid) => { await as(uid); return (await one('select count(*)::int c from broadcasts where id = $1', [b.id])).c === 1; };
  check('Q5 recipient sees it', await sees(apc1.id));
  check('Q5 author sees it', await sees(tl.id));
  check('Q5 Boss sees it', await sees(boss.id));
  check('Q5 another APC does not', !(await sees(apc2.id)));
  check('Q5 an OL who was not sent it does not', !(await sees(ol.id)));
  await as(apc2.id);
  check('Q5 non-recipient cannot answer (RPC)', /only recipients/.test(await raises(`select broadcast_respond($1, 'a', 'Acknowledged')`, [b.id]) || ''));
  check('Q5 non-recipient cannot answer (direct insert)', /row-level security/.test(await raises(`insert into broadcast_responses (broadcast_id, user_id, option_id) values ($1, $2, 'a')`, [b.id, apc2.id]) || ''));
  await as(apc1.id);
  check('Q5 recipient can answer', (await raises(`select broadcast_respond($1, 'a', 'Acknowledged')`, [b.id])) === null);
  await asPostgres();
  check('Q5 response_count trigger still counts', (await one('select response_count c from broadcasts where id = $1', [b.id])).c === 1);
  const results = async (uid) => { await as(uid); return (await one('select count(*)::int c from broadcast_responses where broadcast_id = $1', [b.id])).c; };
  check('Q5 results: author 1, Boss 1, OL 0, recipient own 1',
    (await results(tl.id)) === 1 && (await results(boss.id)) === 1 && (await results(ol.id)) === 0 && (await results(apc1.id)) === 1);
  await as(apc2.id);
  check('Q5 recipient list hidden from non-recipients', (await one('select count(*)::int c from broadcast_recipients where broadcast_id = $1', [b.id])).c === 0);
  await as(tl.id);
  check('Q5 author can re-notify pending (0: everyone answered)', (await one('select broadcast_renotify_pending($1) c', [b.id])).c === 0);
  check('Q5 author cannot ping a non-recipient', /not a recipient/.test(await raises('select broadcast_renotify($1, $2)', [b.id, apc2.id]) || ''));
  // 'all' still reaches everyone active (via the dispatch trigger), Boss included.
  await as(ol.id);
  const all = await one(`insert into broadcasts (author_id, title, target) values ($1, 'RLS test all', 'all') returning id`, [ol.id]);
  await asPostgres();
  const active = (await one(`select count(*)::int c from profiles where is_active and id <> $1`, [ol.id])).c;
  check('Q5 target all: every active user (not the sender) is a recipient', (await one('select count(*)::int c from broadcast_recipients where broadcast_id = $1', [all.id])).c === active);
});

// ---------------------------------------------------------------- Q6
await scenario('Q6', async () => {
  // Dev's copied config row has a generated id; the RPCs address 'default'.
  await db.query(`insert into resource_planner_config (id) values ('default') on conflict (id) do nothing`);
  await as(dev.id);
  check('Q6 developer reads no planner config (table)', (await one('select count(*)::int c from resource_planner_config')).c === 0);
  check('Q6 developer gets nothing from get_planner_config()', (await one('select (get_planner_config()).id id')).id === null);
  check('Q6 developer cannot save', /Only Boss/.test(await raises('select save_planner_config(p_churn_rate => 6)') || ''));
  await as(ol.id);
  check('Q6 OL gets nothing either', (await one('select (get_planner_config()).id id')).id === null);
  await as(boss.id);
  check('Q6 Boss reads the config', (await one('select (get_planner_config()).id id')).id === 'default');
  check('Q6 Boss can save', (await raises('select save_planner_config(p_churn_rate => 6)')) === null);
});

// ---------------------------------------------------------------- Q3 (server side unchanged)
await scenario('Q3', async () => {
  // Dev has no PCTL/IPC-authored report: make a synthetic draft (rolled back).
  const pctl = await pick('pctl');
  const r = await one(`insert into reports (brand_id, author_id, type, status, period_start, period_end, data)
    select id, $1, 'weekly', 'draft', date '2031-01-05', date '2031-01-11', '{}'::jsonb from brands order by brand_name limit 1
    returning id, author_id`, [pctl.id]);
  await as(r.author_id);
  check('Q3 a PCTL/IPC author can save their own draft (reports_update, unchanged)', (await one(`with u as (update reports set updated_at = now() where id = $1 returning 1) select count(*)::int c from u`, [r.id])).c === 1);
});

await db.end();
console.log(`\n${n - fail}/${n} checks pass.`);
process.exit(fail ? 1 : 0);
