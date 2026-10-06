// mig 410: the backup writer and its resume logic. Fake rpc + storage only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gunzipSync } from 'node:zlib';
import { gzip, ndjson, partName, remaining, runBackup } from '../../backup/run.ts';

const text = (gz: Uint8Array) => gunzipSync(Buffer.from(gz)).toString('utf8');

// A fake database: two tables, paged by `id`, plus the run's state.
function fake(o: { rowsPerTable?: number; pageRows?: number } = {}) {
  const n = o.rowsPerTable ?? 5;
  const data: Record<string, Array<{ id: number; v: string }>> = {
    attendance: Array.from({ length: n }, (_, i) => ({ id: i + 1, v: `a${i}` })),
    brands: Array.from({ length: n }, (_, i) => ({ id: i + 1, v: `b${i}` })),
  };
  const run = { id: 7, path: '2026-10-04', cursor: {} as any, tables: [] as any[], rows: 0, bytes: 0,
    status: 'running', started_at: '2026-10-04T02:00:00Z', lease: null as string | null };
  const up: Array<{ path: string; body: Uint8Array; type: string }> = [];
  const removed: string[][] = [];
  const calls: string[] = [];
  const rpc = async (fn: string, args: any = {}) => {
    calls.push(fn);
    if (fn === 'backup_lease') {
      if (!['running', 'partial'].includes(run.status)) return null;
      run.lease = args.p_worker;
      return { id: run.id, path: run.path, cursor: run.cursor, tables: run.tables, rows: run.rows, bytes: run.bytes, started_at: run.started_at };
    }
    if (fn === 'backup_tables') return Object.keys(data).sort().map((t) => ({ table_name: t, pk: ['id'], est_rows: data[t].length }));
    if (fn === 'backup_page') {
      const limit = args.p_limit as number;
      const after = args.p_after?.id ?? 0;
      const rows = data[args.p_table].filter((r) => r.id > after).slice(0, limit);
      return { rows, pk: ['id'], last: rows.length ? { id: rows[rows.length - 1].id } : null, complete: rows.length < limit };
    }
    if (fn === 'backup_save') {
      assert.equal(args.p_worker, run.lease, 'only the lease holder saves');
      // As mig 410: handing the run back releases the lease; a progress save keeps it.
      Object.assign(run, { cursor: args.p_cursor, tables: args.p_tables, rows: args.p_rows, bytes: args.p_bytes,
        status: args.p_partial ? 'partial' : run.status, lease: args.p_partial ? null : run.lease });
      return true;
    }
    if (fn === 'backup_meta') return { database: 'postgres', schema_version: '410', excluded: ['ai_chunks'], keep_weeks: 8 };
    if (fn === 'backup_old_prefixes') return ['2026-07-01'];
    if (fn === 'backup_finish') { Object.assign(run, { status: args.p_status, tables: args.p_tables, rows: args.p_rows, bytes: args.p_bytes }); return true; }
    return null;
  };
  const storage = {
    upload: async (path: string, body: Uint8Array, type: string) => { up.push({ path, body, type }); },
    list: async (prefix: string) => (prefix === '2026-07-01' ? ['brands.ndjson.gz', 'manifest.json'] : []),
    remove: async (paths: string[]) => { removed.push(paths); },
  };
  return { data, run, up, removed, calls, rpc, storage };
}

test('ndjson / gzip / part names', async () => {
  assert.equal(ndjson([{ a: 1 }, { a: 2 }]), '{"a":1}\n{"a":2}\n');
  assert.equal(ndjson([]), '');
  assert.equal(text(await gzip('{"a":1}\n')), '{"a":1}\n');
  assert.deepEqual([partName('brands', 0), partName('brands', 1), partName('brands', 12)],
    ['brands.ndjson.gz', 'brands.part01.ndjson.gz', 'brands.part12.ndjson.gz']);
  assert.deepEqual(remaining([{ table_name: 'a', pk: [], est_rows: 0 }, { table_name: 'b', pk: [], est_rows: 0 }],
    [{ table: 'a', rows: 1, bytes: 1, parts: [] }]).map((t) => t.table_name), ['b']);
});

test('a whole backup: one gzipped NDJSON per table, a manifest, retention, then done', async () => {
  const f = fake({ rowsPerTable: 5 });
  const r = await runBackup({ rpc: f.rpc, storage: f.storage, workerId: 'w1', pageRows: 2 });
  assert.deepEqual([r.status, r.tables, r.rows], ['done', 2, 10], r.error ?? '');
  assert.deepEqual(f.up.map((u) => u.path), ['2026-10-04/attendance.ndjson.gz', '2026-10-04/brands.ndjson.gz', '2026-10-04/manifest.json']);
  // every row of a table in one file, newline-terminated, in key order
  const lines = text(f.up[0].body).trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(lines.map((l) => l.id), [1, 2, 3, 4, 5]);
  assert.equal(f.up[0].type, 'application/gzip');
  const manifest = JSON.parse(new TextDecoder().decode(f.up[2].body));
  assert.deepEqual([manifest.path, manifest.schema_version, manifest.table_count, manifest.rows], ['2026-10-04', '410', 2, 10]);
  assert.deepEqual(manifest.tables.map((t: any) => [t.table, t.rows, t.parts]),
    [['attendance', 5, ['attendance.ndjson.gz']], ['brands', 5, ['brands.ndjson.gz']]]);
  assert.deepEqual(manifest.excluded, ['ai_chunks'], 'the manifest says what was NOT backed up');
  assert.deepEqual(f.removed, [['2026-07-01/brands.ndjson.gz', '2026-07-01/manifest.json']], 'old folder pruned');
  assert.equal(f.run.status, 'done');
  assert.equal((await runBackup({ rpc: f.rpc, storage: f.storage, workerId: 'w2' })).status, 'idle', 'nothing open');
});

test('out of time mid-table: a part is uploaded, the run is partial, the next call resumes and finishes', async () => {
  const f = fake({ rowsPerTable: 6 });
  let t = 0;
  const now = () => (t += 30_000);        // every check advances 30 s
  const first = await runBackup({ rpc: f.rpc, storage: f.storage, workerId: 'w1', pageRows: 2, now, budgetMs: 100_000 });
  assert.equal(first.status, 'partial');
  assert.equal(f.run.status, 'partial');
  assert.equal(f.run.lease, null, 'the lease is released so the next tick can take it');
  assert.ok(f.run.cursor.table && f.run.cursor.after, 'the cursor says where to resume');
  const partsSoFar = f.up.map((u) => u.path);
  assert.ok(partsSoFar.length >= 1 && partsSoFar.every((p) => p.endsWith('.ndjson.gz')), partsSoFar.join(','));
  // resume with a full budget: it finishes, and no row is lost or repeated
  const second = await runBackup({ rpc: f.rpc, storage: f.storage, workerId: 'w2', pageRows: 2 });
  assert.equal(second.status, 'done');
  assert.equal(f.run.rows, 12, 'every row of both tables, exactly once');
  const perTable = new Map<string, number[]>();
  for (const u of f.up.filter((x) => x.path.endsWith('.gz'))) {
    const table = u.path.split('/')[1].split('.')[0];
    const ids = text(u.body).trim().split('\n').filter(Boolean).map((l) => JSON.parse(l).id);
    perTable.set(table, [...(perTable.get(table) ?? []), ...ids]);
  }
  assert.deepEqual(perTable.get('attendance'), [1, 2, 3, 4, 5, 6]);
  assert.deepEqual(perTable.get('brands'), [1, 2, 3, 4, 5, 6]);
});

test('a failure marks the run failed and keeps the error', async () => {
  const f = fake();
  const storage = { ...f.storage, upload: async () => { throw new Error('bucket missing'); } };
  const r = await runBackup({ rpc: f.rpc, storage, workerId: 'w1' });
  assert.equal(r.status, 'failed');
  assert.match(r.error!, /bucket missing/);
  assert.equal(f.run.status, 'failed');
});
