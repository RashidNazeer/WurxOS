// Minimal in-memory stand-in for the supabase-js query builder: just the calls
// the data tools make (select with `alias:fk(cols)` embeds, eq/neq/in/is/ilike/
// gte/lte/lt, order, limit, single/maybeSingle, rpc). Test-only.
// deno-lint-ignore-file no-explicit-any

type Row = Record<string, any>;
type Tables = Record<string, Row[]>;
type Rpc = Record<string, (args: any) => any>;

const EMBED = /(\w+):(\w+)\(([^)]*)\)/g;
const EMBED_TABLE: Record<string, string> = { brand: 'brands' };

function likeToRe(p: string): RegExp {
  let re = '';
  for (let i = 0; i < p.length; i++) {
    const c = p[i];
    if (c === '\\' && i + 1 < p.length) { re += p[++i].replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); continue; }
    re += c === '%' ? '.*' : c === '_' ? '.' : c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`, 'is');
}

class Q {
  private filters: ((r: Row) => boolean)[] = [];
  private orders: { col: string; asc: boolean; nullsFirst?: boolean }[] = [];
  private lim = Infinity;
  private cols = '*';
  private one: 'single' | 'maybe' | null = null;
  private db: Tables;
  private table: string;
  constructor(db: Tables, table: string) { this.db = db; this.table = table; }
  select(cols = '*') { this.cols = cols; return this; }
  eq(c: string, v: any) { this.filters.push((r) => r[c] === v); return this; }
  neq(c: string, v: any) { this.filters.push((r) => r[c] !== v); return this; }
  in(c: string, vs: any[]) { this.filters.push((r) => vs.includes(r[c])); return this; }
  is(c: string, v: any) { this.filters.push((r) => (r[c] ?? null) === v); return this; }
  ilike(c: string, p: string) { const re = likeToRe(p); this.filters.push((r) => re.test(String(r[c] ?? ''))); return this; }
  gte(c: string, v: any) { this.filters.push((r) => r[c] != null && r[c] >= v); return this; }
  lte(c: string, v: any) { this.filters.push((r) => r[c] != null && r[c] <= v); return this; }
  lt(c: string, v: any) { this.filters.push((r) => r[c] != null && r[c] < v); return this; }
  order(col: string, o: { ascending?: boolean; nullsFirst?: boolean } = {}) { this.orders.push({ col, asc: o.ascending !== false, nullsFirst: o.nullsFirst }); return this; }
  limit(n: number) { this.lim = n; return this; }
  single() { this.one = 'single'; return this; }
  maybeSingle() { this.one = 'maybe'; return this; }
  private run() {
    let rows = (this.db[this.table] || []).filter((r) => this.filters.every((f) => f(r)));
    rows = [...rows].sort((a, b) => {
      for (const o of this.orders) {
        const x = a[o.col], y = b[o.col];
        if (x === y) continue;
        if (x == null || y == null) return (x == null ? -1 : 1) * (o.nullsFirst ?? !o.asc ? 1 : -1);
        return (x < y ? -1 : 1) * (o.asc ? 1 : -1);
      }
      return 0;
    }).slice(0, this.lim);
    const embeds = [...this.cols.matchAll(EMBED)];
    const out = rows.map((r) => {
      const o: Row = { ...r };
      for (const [, alias, fk, cols] of embeds) {
        const t = this.db[EMBED_TABLE[alias] ?? alias] || [];
        const hit = t.find((x) => x.id === r[fk]);
        o[alias] = hit ? Object.fromEntries(cols.split(',').map((c) => c.trim()).map((c) => [c, hit[c] ?? null])) : null;
      }
      return o;
    });
    if (this.one) return { data: out[0] ?? null, error: this.one === 'single' && !out.length ? { message: 'no rows' } : null };
    return { data: out, error: null };
  }
  then(res: (v: any) => any, rej?: (e: any) => any) { try { return Promise.resolve(this.run()).then(res, rej); } catch (e) { return Promise.reject(e).then(res, rej); } }
}

export function fakeDb(tables: Tables, rpc: Rpc = {}) {
  return {
    from: (t: string) => new Q(tables, t),
    // A handler may return a value, a promise, or throw → { error } like supabase-js.
    rpc: async (name: string, args: any) => {
      if (!rpc[name]) return { data: null, error: { code: 'PGRST202', message: `Could not find the function public.${name} in the schema cache` } };
      try { return { data: await rpc[name](args), error: null }; } catch (e) { return { data: null, error: { message: String((e as Error).message) } }; }
    },
  };
}
