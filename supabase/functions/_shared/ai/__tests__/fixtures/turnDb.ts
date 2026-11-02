// The in-memory client the agent tests use for the ai_* tables (insert/update tracking). Copied from agent.test.ts so other
// tests can drive runTurn without importing a file that runs its own tests.
// deno-lint-ignore-file no-explicit-any
export function turnDb(tables: Record<string, any[]> = {}, opts: { rpc?: (fn: string, args: any) => any; updateDelayMs?: number } = {}) {
  const inserts: Record<string, any[]> = {};
  const updates: Array<{ table: string; set: any; where: Record<string, unknown> }> = [];
  let seq = 0;
  const from = (table: string) => {
    let rows = [...(tables[table] ?? []), ...(inserts[table] ?? [])];
    let op: 'select' | 'insert' | 'update' = 'select';
    let payload: any = null;
    let head = false;
    const where: Record<string, unknown> = {};
    const whereIn: Record<string, unknown[]> = {};
    let returning = false;
    // select filters: a row without the key passes (fixtures are sparse)
    const keep = (f: (r: any) => boolean) => { if (op === 'select') rows = rows.filter(f); return q; };
    const q: any = {
      select: (_c?: string, o?: any) => { if (o?.head) head = true; if (op === 'update') returning = true; return q; },
      eq: (k: string, v: unknown) => {
        if (op === 'update') where[k] = v;
        else if (op === 'select' && ['id', 'user_id', 'conversation_id', 'status'].includes(k)) rows = rows.filter((r) => r[k] === undefined || r[k] === v);
        return q;
      },
      neq: (k: string, v: unknown) => keep((r) => r[k] === undefined || r[k] !== v),
      lt: (k: string, v: any) => keep((r) => r[k] === undefined || r[k] < v),
      in: (k: string, vs: unknown[]) => { if (op === 'update') { whereIn[k] = vs; return q; } return keep((r) => r[k] === undefined || vs.includes(r[k])); },
      order: (k: string, o?: { ascending?: boolean }) => {
        if (op === 'select') rows = [...rows].sort((a, b) => (String(a[k] ?? '') < String(b[k] ?? '') ? -1 : 1) * (o?.ascending === false ? -1 : 1));
        return q;
      },
      gte: () => q, lte: () => q, ilike: () => q, limit: () => q,
      insert: (p: any) => {
        op = 'insert';
        payload = [].concat(p).map((r: any) => ({ id: `${table}-${++seq}`, ...r }));
        (inserts[table] ??= []).push(...payload);
        return q;
      },
      update: (p: any) => { op = 'update'; payload = p; return q; },
      maybeSingle: async () => ({ data: rows[0] ?? null, error: null }),
      single: async () => ({ data: op === 'insert' ? payload[0] : rows[0], error: null }),
      then: (ok: any, bad: any) => {
        if (op === 'update') {
          return new Promise((r) => setTimeout(r, opts.updateDelayMs ?? 0)).then(() => {
            updates.push({ table, set: payload, where, ...(Object.keys(whereIn).length ? { whereIn } : {}) });
            const hit = [...(tables[table] ?? []), ...(inserts[table] ?? [])].filter((row) =>
              Object.entries(where).every(([k, v]) => row[k] === v) && Object.entries(whereIn).every(([k, vs]) => vs.includes(row[k])));
            for (const row of hit) Object.assign(row, payload);
            return { data: returning ? hit.map((r) => ({ id: r.id })) : null, error: null };
          }).then(ok, bad);
        }
        return Promise.resolve(op === 'insert' ? { data: payload, error: null } : head ? { count: rows.length, error: null } : { data: rows, error: null }).then(ok, bad);
      },
    };
    return q;
  };
  const missing = { data: null, error: { code: 'PGRST202', message: 'Could not find the function' } };
  const rpc = async (fn: string, args: any) => {
    const v = opts.rpc?.(fn, args);
    return v === undefined ? missing : { data: v, error: null };
  };
  return { from, rpc, inserts, updates };
}
