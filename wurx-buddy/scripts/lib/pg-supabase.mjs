// A supabase-js look-alike over one pg connection, so the data tools can run
// "as a user" on dev with no JWT: the caller wraps each tool call in
// runAs(uid), which opens a transaction, switches to the `authenticated` role
// with request.jwt.claims set (the same simulation as QA's acl.sql), and ALWAYS
// rolls back. Supports exactly the builder calls the tools make; results come
// back as JSON like PostgREST's (dates as strings, numerics as numbers).
// Test-only. DEV ONLY (the caller connects through dev-env.mjs).

const EMBED_TABLE = { brand: 'brands' };
const ident = (s) => {
  if (!/^[a-z_][a-z0-9_]*$/i.test(s)) throw new Error(`unsafe identifier: ${s}`);
  return `"${s}"`;
};

function splitTop(s) {
  const out = []; let depth = 0, cur = '';
  for (const ch of s) {
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (ch === ',' && depth === 0) { out.push(cur.trim()); cur = ''; } else cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

class Query {
  constructor(run, table) { this.run = run; this.table = table; this.cols = '*'; this.where = []; this.params = []; this.orders = []; this.lim = null; this.one = null; }
  p(v) { this.params.push(v); return `$${this.params.length}`; }
  select(cols = '*') { this.cols = cols; return this; }
  eq(c, v) { this.where.push(`t.${ident(c)} = ${this.p(v)}`); return this; }
  neq(c, v) { this.where.push(`t.${ident(c)} <> ${this.p(v)}`); return this; }
  in(c, vs) { this.where.push(`t.${ident(c)} = any(${this.p(vs)})`); return this; }
  is(c, v) { if (v !== null) throw new Error('is() only supports null'); this.where.push(`t.${ident(c)} is null`); return this; }
  ilike(c, v) { this.where.push(`t.${ident(c)}::text ilike ${this.p(v)}`); return this; }
  gte(c, v) { this.where.push(`t.${ident(c)} >= ${this.p(v)}`); return this; }
  lte(c, v) { this.where.push(`t.${ident(c)} <= ${this.p(v)}`); return this; }
  lt(c, v) { this.where.push(`t.${ident(c)} < ${this.p(v)}`); return this; }
  order(c, o = {}) {
    const asc = o.ascending !== false;
    const nulls = o.nullsFirst === undefined ? '' : o.nullsFirst ? ' nulls first' : ' nulls last';
    this.orders.push(`t.${ident(c)} ${asc ? 'asc' : 'desc'}${nulls}`); return this;
  }
  limit(n) { this.lim = Number(n); return this; }
  single() { this.one = 'single'; return this; }
  maybeSingle() { this.one = 'maybe'; return this; }
  sql() {
    const cols = splitTop(this.cols).map((c) => {
      if (c === '*') return 't.*';
      const m = c.match(/^(\w+):(\w+)\(([^)]*)\)$/);
      if (!m) return `t.${ident(c)}`;
      const [, alias, fk, inner] = m;
      const pairs = inner.split(',').map((x) => x.trim()).filter(Boolean).map((x) => `'${x}', e.${ident(x)}`).join(', ');
      // An embedded row the caller can't see comes back null, as in PostgREST.
      return `(select json_build_object(${pairs}) from public.${ident(EMBED_TABLE[alias] ?? alias)} e where e.id = t.${ident(fk)}) as ${ident(alias)}`;
    }).join(', ');
    return `select coalesce(json_agg(x), '[]'::json) as d from (select ${cols} from public.${ident(this.table)} t` +
      (this.where.length ? ` where ${this.where.join(' and ')}` : '') +
      (this.orders.length ? ` order by ${this.orders.join(', ')}` : '') +
      (this.lim != null ? ` limit ${this.lim}` : '') + ') x';
  }
  async exec() {
    const r = await this.run(this.sql(), this.params);
    if (r.error) return r;
    const rows = r.data;
    if (this.one) return rows.length ? { data: rows[0], error: null } : { data: null, error: this.one === 'single' ? { message: 'no rows' } : null };
    return { data: rows, error: null };
  }
  then(res, rej) { return this.exec().then(res, rej); }
}

// Simulation gap: these SECURITY DEFINER functions treat `session_user =
// 'postgres'` as the service role, and this connection IS postgres (SET ROLE
// changes current_user, not session_user), so they would answer for anyone.
// Through the real API session_user is `authenticator` and their own gate
// applies. We reproduce that gate here, copied from the function bodies:
// the caller may see a target when they are the Boss, an active non-deleted
// OL/developer, the target themselves, or the target's reports_to manager.
// scripts/test-tools-roles.mjs asserts the live bodies still contain it.
export const DEFINER_GATES = {
  get_performance_composite: { arg: 'p_user' },
  attendance_month_breakdown_bulk: { rowKey: 'user_id' },
  incentive_attendance_pct: { rowKey: 'user_id' },
};

export function pgSupabase(client, uid = null) {
  let lock = Promise.resolve();
  const fns = new Map();
  // One statement at a time, each in a savepoint, so a failing query (e.g.
  // permission denied) returns { error } and doesn't abort the transaction.
  const run = (sql, params) => {
    const job = lock.then(async () => {
      await client.query('savepoint q');
      try {
        const { rows } = await client.query(sql, params);
        await client.query('release savepoint q');
        return { data: rows[0]?.d ?? null, error: null };
      } catch (e) {
        await client.query('rollback to savepoint q');
        return { data: null, error: { message: e.message, code: e.code } };
      }
    });
    lock = job.catch(() => {});
    return job;
  };
  const fnInfo = async (name) => {
    if (!fns.has(name)) {
      const r = await run(`select coalesce(json_agg(json_build_object('set', p.proretset)), '[]'::json) as d from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = $1`, [name]);
      fns.set(name, r.data?.[0] ?? null);
    }
    return fns.get(name);
  };
  let gate = null;
  const canSee = async (target) => {
    if (!gate) {
      const r = await run(`select coalesce(json_agg(json_build_object('id', id, 'role', role, 'rt', reports_to, 'ok', is_active and deleted_at is null)), '[]'::json) as d from public.profiles`, []);
      const me = (r.data || []).find((p) => p.id === uid);
      const priv = !!me && (me.role === 'boss' || (['ol', 'developer'].includes(me.role) && me.ok));
      const reports = new Set((r.data || []).filter((p) => p.rt === uid).map((p) => p.id));
      gate = (t) => priv || t === uid || reports.has(t);
    }
    return gate(target);
  };
  return {
    from: (table) => new Query(run, table),
    rpc: async (name, args = {}) => {
      const info = await fnInfo(name);
      if (!info) return { data: null, error: { code: '42883', message: `function public.${name} does not exist` } };
      const g = uid ? DEFINER_GATES[name] : null;
      if (g?.arg && !(await canSee(args[g.arg]))) return { data: [], error: null };
      const keys = Object.keys(args);
      const call = `public.${ident(name)}(${keys.map((k, i) => `${ident(k)} => $${i + 1}`).join(', ')})`;
      const sql = info.set ? `select coalesce(json_agg(r), '[]'::json) as d from ${call} r` : `select to_json(${call}) as d`;
      const res = await run(sql, keys.map((k) => args[k]));
      if (g?.rowKey && Array.isArray(res.data)) {
        const keep = [];
        for (const row of res.data) if (await canSee(row[g.rowKey])) keep.push(row);
        res.data = keep;
      }
      return res;
    },
  };
}

// Runs fn(userClient) as `uid` with role `authenticated`; always rolled back.
export async function runAs(client, uid, fn) {
  await client.query('begin');
  try {
    await client.query('set local role authenticated');
    await client.query("select set_config('request.jwt.claims', $1, true), set_config('request.jwt.claim.sub', $2, true), set_config('request.jwt.claim.role', 'authenticated', true)",
      [JSON.stringify({ sub: uid, role: 'authenticated' }), uid]);
    return await fn(pgSupabase(client, uid));
  } finally {
    await client.query('rollback');
  }
}
