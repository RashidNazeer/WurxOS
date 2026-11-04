// The read-only SQL stand-in for supabase-js (_shared/mcp/sqlBuilder.ts): escaping, identifiers, shapes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ident, lit, pgArrayLiteral, pgClient, Query, RPC_ALLOWED, selectList, splitTop } from '../mcp/sqlBuilder.ts';

const qry = (table: string) => new Query(async () => [], table);
const BS = String.fromCharCode(92);

test('ident: lowercase snake_case only; anything else is refused', () => {
  assert.equal(ident('display_name'), '"display_name"');
  for (const bad of ['Name', 'a-b', 'a b', 'a;b', 'a"b', '1a', '', 'a.b', "a'b", 'a(b)', 'x'.repeat(64), null, 5]) assert.throws(() => ident(bad), /bad identifier/, String(bad));
});

test('lit: quotes are doubled, backslash is just a character, NUL and non-finite are refused', () => {
  assert.equal(lit("O'Brien"), "'O''Brien'");
  assert.equal(lit("'; drop table profiles; --"), "'''; drop table profiles; --'");
  assert.equal(lit('a' + BS + 'b'), "'a" + BS + "b'");
  assert.equal(lit(null), 'null');
  assert.equal(lit(true), 'true');
  assert.equal(lit(12.5), '12.5');
  assert.throws(() => lit('a\0b'), /NUL/);
  assert.throws(() => lit(NaN), /non-finite/);
  assert.throws(() => lit(Infinity), /non-finite/);
  assert.throws(() => lit(Symbol('x') as any), /unsupported/);
});

test('arrays become one quoted Postgres array literal', () => {
  assert.equal(pgArrayLiteral(['a', 'b']), `'{"a","b"}'`);
  assert.equal(pgArrayLiteral(['x"y', 'p' + BS + 'q']), `'{"x${BS}"y","p${BS}${BS}q"}'`);
  assert.equal(pgArrayLiteral([]), `'{}'`);
  assert.equal(lit(["a'b"]), `'{"a''b"}'`);
  assert.throws(() => pgArrayLiteral([{} as any]), /unsupported/);
});

test('select list: plain columns and the one embedded many-to-one; nothing else', () => {
  assert.equal(selectList('id, display_name'), 't."id", t."display_name"');
  const e = selectList('id, brand:brand_id(brand_name, currency)');
  assert.match(e, /\(select to_jsonb\(e\) from \(select "brand_name", "currency" from public\."brands" as r where r\.id = t\."brand_id"\) e\) as "brand"/);
  assert.throws(() => selectList('owner:owner_id(display_name)'), /not supported/);
  assert.throws(() => selectList('*'), /bad identifier/);
  assert.throws(() => selectList('id; drop table x'), /bad identifier/);
  assert.deepEqual(splitTop('a, b:c(d, e), f'), ['a', 'b:c(d, e)', 'f']);
});

test('query: filters, order, limit render as one SELECT with a stable order', () => {
  const s = qry('profiles').select('id, role').eq('is_active', true).is('deleted_at', null).in('role', ['apc', 'tl']).ilike('display_name', '%a_%').order('display_name', { ascending: true }).limit(20).sql();
  assert.match(s, /^select coalesce\(jsonb_agg\(\(to_jsonb\(q\) - '__n'\) order by q\.__n\), '\[\]'::jsonb\) as j from \(select t\."id", t\."role", row_number\(\) over \(order by t\."display_name" asc\) as __n from public\."profiles" as t where t\."is_active" = true and t\."deleted_at" is null and t\."role" in \('apc', 'tl'\) and t\."display_name" ilike '%a_%' order by t\."display_name" asc limit 20\) q$/);
  assert.match(qry('x').select('id').in('id', []).sql(), /where false/);
  assert.match(qry('x').select('id').order('due_date', { ascending: true, nullsFirst: false }).sql(), /order by t\."due_date" asc nulls last/);
});

test('query: injection attempts stay inside literals; bad columns, limits and operators throw', () => {
  const evil = "x' or '1'='1";
  const s = qry('profiles').select('id').eq('display_name', evil).sql();
  assert.ok(s.includes("= 'x'' or ''1''=''1'"));
  assert.throws(() => qry('profiles').select('id').eq('a;b', 1), /bad identifier/);
  assert.throws(() => qry('profiles;x'), /bad identifier/);
  assert.throws(() => qry('profiles').select('id').eq('id', null), /\.is/);
  assert.throws(() => qry('profiles').select('id').limit(-1), /bad limit/);
  assert.throws(() => qry('profiles').select('id').limit(1e9), /bad limit/);
  assert.throws(() => qry('profiles').select('id').is('a', 'x' as any), /is needs/);
  assert.throws(() => qry('profiles').select('id', { count: 'exact' }), /not supported/);
  assert.throws(() => qry('profiles').sql(), /select\(\) first/);
});

test('query results: rows, maybeSingle (0, 1, many) and driver errors become { data, error }', async () => {
  const rows = (r: unknown) => new Query(async () => r, 'profiles').select('id');
  assert.deepEqual(await rows([{ id: 1 }, { id: 2 }]), { data: [{ id: 1 }, { id: 2 }], error: null });
  assert.deepEqual(await rows([]).maybeSingle(), { data: null, error: null });
  assert.deepEqual(await rows([{ id: 1 }]).maybeSingle(), { data: { id: 1 }, error: null });
  assert.equal((await rows([{ id: 1 }, { id: 2 }]).maybeSingle()).error?.code, 'PGRST116');
  const bad = await new Query(async () => { throw Object.assign(new Error('invalid input syntax for type uuid'), { code: '22P02' }); }, 'profiles').select('id');
  assert.equal(bad.data, null);
  assert.equal(bad.error?.code, '22P02');
  assert.equal((await rows('nope')).error?.message, 'unexpected result');
});

test('rpc: only the six allow-listed functions, named arguments, set vs scalar shapes', async () => {
  assert.deepEqual([...RPC_ALLOWED].sort(), ['attendance_month_breakdown_bulk', 'can_view_brand', 'commission_line_state', 'get_performance_composite', 'incentive_attendance_pct']);
  const seen: string[] = [];
  const c = pgClient(async (t) => { seen.push(t); return [1]; }, async (fn) => fn !== 'can_view_brand');
  await c.rpc('attendance_month_breakdown_bulk', { p_month: '2026-10', p_user_ids: ['u1', 'u2'] });
  assert.equal(seen[0], `select coalesce(jsonb_agg(to_jsonb(r)), '[]'::jsonb) as j from public."attendance_month_breakdown_bulk"("p_month" => '2026-10', "p_user_ids" => '{"u1","u2"}') as r`);
  await c.rpc('can_view_brand', { b_id: 'x' });
  assert.equal(seen[1], `select to_jsonb(public."can_view_brand"("b_id" => 'x')) as j`);
  const denied = await c.rpc('delete_user', {});
  assert.match(denied.error!.message, /rpc not allowed/);
  assert.equal(seen.length, 2);
  assert.match((await c.rpc('can_view_brand', { 'a;b': 1 })).error!.message, /bad identifier/);
});

// Every data tool, as an OL, through the SQL stand-in: none may hit an unsupported builder call.
test('all data tools run on the SQL stand-in without an unsupported call (OL path)', async () => {
  const { runDataTool, TOOL_DEFS } = await import('../ai/tools/index.ts');
  const sqls: string[] = [];
  const client = pgClient(async (t) => { sqls.push(t); return t.includes('as j from public."') && t.includes('"(') ? [] : []; }, async () => true);
  const ol = { userId: '11111111-1111-1111-1111-111111111111', role: 'ol', userClient: client };
  const svc = pgClient(async () => [], async () => true);
  const argSets: Record<string, any[]> = {
    find_person: [{ name: 'Ali' }], get_employees: [{}, { role: 'tl', search: 'a', include_inactive: true }],
    get_incentives: [{}, { person_name: 'Ali', month: '2026-10' }], get_salary: [{}, { person_name: 'Ali' }],
    get_reports: [{}, { brand_name: 'Cutler', period: 'October', type: 'monthly', sections: ['all'] }],
    get_performance: [{}, { person_name: 'Ali', month: '2026-10' }, { role: 'tl' }],
    get_attendance: [{}, { person_name: 'Ali', month: '2026-10', detail: true }], get_leave: [{}, { person_name: 'Ali', status: 'approved', month: '2026-10' }],
    list_brands: [{}], get_brand_assignments: [{}, { brand: 'x', person: 'y', role: 'apc' }],
    get_top_creators: [{ brand: 'x', period: 'October' }], compare_periods: [{ brand: 'x', metric: 'gmv', period_a: 'October' }],
    rank_brands: [{ metric: 'gmv', period: 'October' }], brand_overview: [{ brand: 'x' }], get_gmv_max: [{}, { brand: 'x', period: 'October' }],
    get_agenda_tasks: [{}, { brand: 'x', person: 'y', status: 'todo', limit: 10 }],
  };
  const bad = /bad identifier|not supported|rpc not allowed|needs a value|select\(\) first|bad limit|unsupported/;
  for (const def of TOOL_DEFS) {
    for (const args of argSets[def.name] ?? [{}]) {
      const r = await runDataTool(svc as any, ol as any, def.name, args);
      assert.ok(!bad.test(r.text), `${def.name} ${JSON.stringify(args)} -> ${r.text.slice(0, 200)}`);
    }
  }
  assert.ok(sqls.length > 20);
  for (const s of sqls) assert.ok(/^select /.test(s) && !/;/.test(s.replace(/'(?:[^']|'')*'/g, '')), s.slice(0, 120));   // one SELECT each, no stray statements outside literals
});
