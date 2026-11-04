// A tiny read-only stand-in for the supabase-js query builder, producing ONE SQL statement per query that
// runs as the signed-in person (role `authenticated` + their JWT claims in the transaction), exactly the way
// PostgREST would run it, so row-level security decides what comes back.
//
// Why it exists: connector tokens are our own opaque tokens, not Supabase JWTs, so the data tools cannot use
// a supabase-js client built from the caller's JWT. This covers precisely the calls the data tools make
// (eq, neq, in, is, ilike, gt/gte/lt/lte, order, limit, select with one embedded many-to-one, maybeSingle,
// and six allow-listed RPCs) and refuses everything else. It can only SELECT.
//
// Safety: identifiers are checked against a strict pattern and never come from a value; every value is
// rendered as an escaped literal (quotes doubled; NUL bytes and non-finite numbers are rejected). The server
// runs the text under standard_conforming_strings = on (Postgres default), so a backslash is not an escape.

export type Json = unknown;
export type RunSql = (text: string) => Promise<Json>;            // returns the single JSON value the statement selects
export type Result = { data: any; error: null | { message: string; code?: string } };

export const DEFAULT_LIMIT = 1000;

// True when the statement text contains a ';' outside string literals and quoted identifiers, i.e. a second
// statement. The executor refuses such text outright (belt and braces on top of escaping and the extended protocol).
export function hasStatementBreak(sql: string): boolean {
  return sql.replace(/'(?:[^']|'')*'/g, "''").replace(/"(?:[^"]|"")*"/g, '""').includes(';');
}

const IDENT = /^[a-z_][a-z0-9_]{0,62}$/;
export function ident(s: unknown): string {
  if (typeof s !== 'string' || !IDENT.test(s)) throw new Error(`bad identifier: ${String(s).slice(0, 40)}`);
  return `"${s}"`;
}

// One value as an SQL literal. Strings stay "unknown-typed" so the server coerces them to the column's type.
export function lit(v: unknown): string {
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) throw new Error('non-finite number');
    return String(v);
  }
  if (typeof v === 'string') {
    if (v.includes('\0')) throw new Error('NUL byte in value');
    return `'${v.replace(/'/g, "''")}'`;
  }
  if (Array.isArray(v)) return pgArrayLiteral(v);
  if (typeof v === 'object') return lit(JSON.stringify(v));        // jsonb argument
  throw new Error('unsupported value type');
}

// '{"a","b"}' : a Postgres array literal the server coerces to uuid[] / text[] / ... from context.
export function pgArrayLiteral(a: unknown[]): string {
  const el = (x: unknown) => {
    if (x === null || x === undefined) return 'NULL';
    if (typeof x === 'number' || typeof x === 'boolean') return String(x);
    if (typeof x !== 'string') throw new Error('unsupported array element');
    if (x.includes('\0')) throw new Error('NUL byte in value');
    return `"${x.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  };
  return lit(`{${a.map(el).join(',')}}`);
}

// ---- select list: "a, b, brand:brand_id(brand_name, currency)" -------------------------------
// The ONE embedded relation the tools use is many-to-one through a foreign key column; the table is fixed here.
const EMBED_TABLE: Record<string, string> = { brand_id: 'brands' };

export function splitTop(s: string): string[] {
  const out: string[] = []; let depth = 0, cur = '';
  for (const ch of s) {
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (ch === ',' && depth === 0) { out.push(cur.trim()); cur = ''; continue; }
    cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

export function selectList(cols: string): string {
  const items = splitTop(cols);
  if (!items.length) throw new Error('empty select');
  return items.map((it) => {
    const m = it.match(/^([a-z_][a-z0-9_]*):([a-z_][a-z0-9_]*)\(([^()]*)\)$/);
    if (m) {
      const [, alias, fk, sub] = m;
      const table = EMBED_TABLE[fk];
      if (!table) throw new Error(`embedded relation not supported: ${fk}`);
      const subCols = splitTop(sub).map(ident).join(', ');
      return `(select to_jsonb(e) from (select ${subCols} from public.${ident(table)} as r where r.id = t.${ident(fk)}) e) as ${ident(alias)}`;
    }
    return `t.${ident(it)}`;
  }).join(', ');
}

// ---- the query --------------------------------------------------------------------------------
type Cond = string;
const OPS: Record<string, string> = { eq: '=', neq: '<>', gt: '>', gte: '>=', lt: '<', lte: '<=' };

export class Query implements PromiseLike<Result> {
  private cols = '';
  private conds: Cond[] = [];
  private orders: string[] = [];
  private lim: number | null = null;
  private single = false;
  private run: RunSql;
  private table: string;
  constructor(run: RunSql, table: string) { ident(table); this.run = run; this.table = table; }

  select(cols: string, opts?: unknown) {
    if (opts && typeof opts === 'object' && Object.keys(opts as object).length) throw new Error('select options not supported');
    this.cols = cols; return this;
  }
  private op(kind: keyof typeof OPS, col: string, val: unknown) {
    if (val === null || val === undefined) throw new Error(`${kind} needs a value (use .is for null)`);
    this.conds.push(`t.${ident(col)} ${OPS[kind]} ${lit(val)}`); return this;
  }
  eq(c: string, v: unknown) { return this.op('eq', c, v); }
  neq(c: string, v: unknown) { return this.op('neq', c, v); }
  gt(c: string, v: unknown) { return this.op('gt', c, v); }
  gte(c: string, v: unknown) { return this.op('gte', c, v); }
  lt(c: string, v: unknown) { return this.op('lt', c, v); }
  lte(c: string, v: unknown) { return this.op('lte', c, v); }
  ilike(c: string, pattern: string) {
    if (typeof pattern !== 'string') throw new Error('ilike needs a string');
    this.conds.push(`t.${ident(c)} ilike ${lit(pattern)}`); return this;
  }
  is(c: string, v: null | boolean) {
    if (v !== null && typeof v !== 'boolean') throw new Error('is needs null or a boolean');
    this.conds.push(`t.${ident(c)} is ${v === null ? 'null' : v ? 'true' : 'false'}`); return this;
  }
  in(c: string, vals: unknown[]) {
    if (!Array.isArray(vals)) throw new Error('in needs an array');
    this.conds.push(vals.length ? `t.${ident(c)} in (${vals.map(lit).join(', ')})` : 'false'); return this;
  }
  order(c: string, o?: { ascending?: boolean; nullsFirst?: boolean }) {
    const asc = o?.ascending !== false;
    const nulls = o?.nullsFirst === undefined ? '' : o.nullsFirst ? ' nulls first' : ' nulls last';
    this.orders.push(`t.${ident(c)} ${asc ? 'asc' : 'desc'}${nulls}`); return this;
  }
  limit(n: number) {
    if (!Number.isInteger(n) || n < 0 || n > 10_000) throw new Error('bad limit');
    this.lim = n; return this;
  }
  maybeSingle() { this.single = true; return this; }

  sql(): string {
    if (!this.cols) throw new Error('select() first');
    const where = this.conds.length ? ` where ${this.conds.join(' and ')}` : '';
    const order = this.orders.length ? ` order by ${this.orders.join(', ')}` : '';
    const limit = ` limit ${this.lim ?? DEFAULT_LIMIT}`;                   // PostgREST caps unbounded reads too
    const inner = `select ${selectList(this.cols)}, row_number() over (${order ? order.trim() : ''}) as __n from public.${ident(this.table)} as t${where}${order}${limit}`;
    return `select coalesce(jsonb_agg((to_jsonb(q) - '__n') order by q.__n), '[]'::jsonb) as j from (${inner}) q`;
  }

  async exec(): Promise<Result> {
    try {
      const rows = (await this.run(this.sql())) as any[];
      if (!Array.isArray(rows)) return { data: null, error: { message: 'unexpected result' } };
      if (this.single) {
        if (rows.length > 1) return { data: null, error: { message: 'JSON object requested, multiple (or no) rows returned', code: 'PGRST116' } };
        return { data: rows[0] ?? null, error: null };
      }
      return { data: rows, error: null };
    } catch (e) {
      return { data: null, error: { message: String((e as Error)?.message ?? e).slice(0, 300), code: (e as { code?: string })?.code } };
    }
  }
  then<A = Result, B = never>(ok?: ((v: Result) => A | PromiseLike<A>) | null, no?: ((r: unknown) => B | PromiseLike<B>) | null) {
    return this.exec().then(ok, no);
  }
}

// The only functions the data tools call.
// (ai_viewable_brand_ids is service-only and is never needed: an OL's brand list comes from `brands` under RLS.)
export const RPC_ALLOWED = new Set([
  'can_view_brand', 'incentive_attendance_pct',
  'commission_line_state', 'get_performance_composite', 'attendance_month_breakdown_bulk',
]);

export type PgClient = { from: (t: string) => Query; rpc: (fn: string, args?: Record<string, unknown>) => Promise<Result> };

// `isSet(fn)` says whether the function returns a set (array) or one value, as PostgREST does.
export function pgClient(run: RunSql, isSet: (fn: string) => Promise<boolean>): PgClient {
  return {
    from: (t) => new Query(run, t),
    rpc: async (fn, args = {}) => {
      try {
        if (!RPC_ALLOWED.has(fn)) throw new Error(`rpc not allowed: ${fn}`);
        const named = Object.entries(args).map(([k, v]) => `${ident(k)} => ${lit(v)}`).join(', ');
        const call = `public.${ident(fn)}(${named})`;
        const set = await isSet(fn);
        const text = set
          ? `select coalesce(jsonb_agg(to_jsonb(r)), '[]'::jsonb) as j from ${call} as r`
          : `select to_jsonb(${call}) as j`;
        return { data: await run(text), error: null };
      } catch (e) {
        return { data: null, error: { message: String((e as Error)?.message ?? e).slice(0, 300), code: (e as { code?: string })?.code } };
      }
    },
  };
}
