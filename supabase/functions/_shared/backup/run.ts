// The weekly database backup (mig 410), runtime-neutral: the db-backup edge
// function (Deno) and the tests (Node) both call runBackup with their own rpc
// and storage.
//
//   lease the open run → for each table not yet written: page it by primary key
//   (backup_page), buffer NDJSON, gzip and upload at ~4 MB or when the time
//   budget runs out → record progress and return 'partial' (the minute tick
//   calls again) → when every table is written: upload manifest.json, delete
//   day folders past retention, finish 'done'.
//
// A table that needs more than one upload is split into parts:
//   <table>.ndjson.gz, <table>.part01.ndjson.gz, …   (restore concatenates them)
// Nothing here reads the environment; the vector store is not backed up (the
// exclude list lives in backup_config).

export type BackupRpc = (fn: string, args?: Record<string, unknown>) => Promise<any>;

export type BackupStorage = {
  upload(path: string, body: Uint8Array, contentType: string): Promise<void>;
  list(prefix: string): Promise<string[]>;            // names inside the prefix
  remove(paths: string[]): Promise<void>;
};

export type TableInfo = { table_name: string; pk: string[]; est_rows: number };
export type TableDone = { table: string; rows: number; bytes: number; parts: string[] };
export type Cursor = { table?: string; after?: unknown; part?: number; rows?: number; bytes?: number };

export type BackupResult = {
  status: 'idle' | 'partial' | 'done' | 'failed';
  id?: number;
  path?: string;
  tables?: number;
  rows?: number;
  bytes?: number;
  table?: string;            // where it stopped (partial)
  pruned?: string[];
  error?: string;
};

export const FLUSH_BYTES = 4 * 1024 * 1024;   // gzip input per uploaded part
export const PAGE_ROWS = 2000;
export const BUDGET_MS = 100_000;             // the edge wall clock is ~150 s

// One NDJSON line per row, newline-terminated (so parts concatenate cleanly).
export function ndjson(rows: unknown[]): string {
  return rows.length ? rows.map((r) => JSON.stringify(r)).join('\n') + '\n' : '';
}

export async function gzip(text: string): Promise<Uint8Array> {
  const cs = new CompressionStream('gzip');
  const writer = cs.writable.getWriter();
  void writer.write(new TextEncoder().encode(text));
  void writer.close();
  const parts: Uint8Array[] = [];
  const reader = cs.readable.getReader();
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    if (value) parts.push(value);
  }
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}

// part 0 keeps the plain name, so a one-file table reads as <table>.ndjson.gz.
export const partName = (table: string, part: number) =>
  part === 0 ? `${table}.ndjson.gz` : `${table}.part${String(part).padStart(2, '0')}.ndjson.gz`;

// The tables still to write, in backup_tables() order, skipping what is done.
export function remaining(tables: TableInfo[], done: TableDone[]): TableInfo[] {
  const names = new Set(done.map((d) => d.table));
  return tables.filter((t) => !names.has(t.table_name));
}

export async function runBackup(o: {
  rpc: BackupRpc;
  storage: BackupStorage;
  workerId: string;
  now?: () => number;
  budgetMs?: number;
  flushBytes?: number;
  pageRows?: number;
}): Promise<BackupResult> {
  const now = o.now ?? (() => Date.now());
  const t0 = now();
  const budget = o.budgetMs ?? BUDGET_MS;
  const flushAt = o.flushBytes ?? FLUSH_BYTES;
  const pageRows = o.pageRows ?? PAGE_ROWS;
  const timeLeft = () => budget - (now() - t0);

  const lease = await o.rpc('backup_lease', { p_worker: o.workerId });
  if (!lease) return { status: 'idle' };
  const id: number = Number(lease.id);
  const path: string = String(lease.path);
  const done: TableDone[] = Array.isArray(lease.tables) ? lease.tables : [];
  let cursor: Cursor = (lease.cursor && typeof lease.cursor === 'object') ? lease.cursor : {};
  let rows = Number(lease.rows ?? 0);
  let bytes = Number(lease.bytes ?? 0);

  const save = (partial: boolean) => o.rpc('backup_save', {
    p_id: id, p_worker: o.workerId, p_cursor: cursor, p_tables: done,
    p_rows: rows, p_bytes: bytes, p_partial: partial,
  });

  try {
    const tables: TableInfo[] = (await o.rpc('backup_tables')) ?? [];
    for (const t of remaining(tables, done)) {
      // Resuming inside this table? Otherwise start it from the beginning.
      const resuming = cursor.table === t.table_name;
      let after: unknown = resuming ? cursor.after ?? null : null;
      let part = resuming ? Number(cursor.part ?? 0) : 0;
      let tableRows = resuming ? Number(cursor.rows ?? 0) : 0;
      let tableBytes = resuming ? Number(cursor.bytes ?? 0) : 0;
      const parts: string[] = [];
      for (let p = 0; p < part; p++) parts.push(partName(t.table_name, p));
      let buf = '';

      const flush = async () => {
        if (!buf) return;
        const gz = await gzip(buf);
        const name = partName(t.table_name, part);
        await o.storage.upload(`${path}/${name}`, gz, 'application/gzip');
        parts.push(name);
        tableBytes += gz.length;
        bytes += gz.length;
        buf = '';
        part += 1;
      };

      for (;;) {
        const page = await o.rpc('backup_page', { p_table: t.table_name, p_after: after ?? null, p_limit: pageRows });
        const pageRowsOut: unknown[] = page?.rows ?? [];
        buf += ndjson(pageRowsOut);
        tableRows += pageRowsOut.length;
        rows += pageRowsOut.length;
        after = page?.last ?? after;
        const complete = page?.complete === true || pageRowsOut.length === 0;
        if (complete) { await flush(); break; }
        // Flush a big buffer, and stop cleanly when the budget is nearly spent:
        // the next tick resumes at `after`.
        if (buf.length >= flushAt || timeLeft() < 20_000) {
          await flush();
          if (timeLeft() < 20_000) {
            cursor = { table: t.table_name, after, part, rows: tableRows, bytes: tableBytes };
            await save(true);
            return { status: 'partial', id, path, table: t.table_name, rows, bytes, tables: done.length };
          }
        }
      }

      done.push({ table: t.table_name, rows: tableRows, bytes: tableBytes, parts });
      cursor = {};
      await o.rpc('backup_save', { p_id: id, p_worker: o.workerId, p_cursor: {}, p_tables: done,
        p_rows: rows, p_bytes: bytes, p_partial: false });
      if (timeLeft() < 20_000 && remaining(tables, done).length) {
        await save(true);
        return { status: 'partial', id, path, rows, bytes, tables: done.length };
      }
    }

    // Everything written: the manifest, then retention.
    const meta = (await o.rpc('backup_meta')) ?? {};
    const manifest = {
      path, started_at: lease.started_at ?? null, finished_at: new Date(now()).toISOString(),
      ...meta, tables: done, table_count: done.length, rows, bytes,
      note: 'One gzipped NDJSON file per table (parts concatenate in order). The ingestion / vector store is not backed up: re-ingest to rebuild it.',
    };
    const body = new TextEncoder().encode(JSON.stringify(manifest, null, 1));
    await o.storage.upload(`${path}/manifest.json`, body, 'application/json');
    bytes += body.length;

    const pruned: string[] = [];
    for (const old of ((await o.rpc('backup_old_prefixes')) ?? []) as Array<string | { backup_old_prefixes: string }>) {
      const prefix = typeof old === 'string' ? old : old?.backup_old_prefixes;
      if (!prefix || prefix === path) continue;
      const names = await o.storage.list(prefix);
      if (names.length) await o.storage.remove(names.map((n) => `${prefix}/${n}`));
      pruned.push(prefix);
    }

    await o.rpc('backup_finish', { p_id: id, p_status: 'done', p_tables: done, p_rows: rows, p_bytes: bytes });
    return { status: 'done', id, path, tables: done.length, rows, bytes, pruned };
  } catch (e) {
    const error = String((e as Error)?.message ?? e).slice(0, 1000);
    await o.rpc('backup_finish', { p_id: id, p_status: 'failed', p_tables: done, p_rows: rows, p_bytes: bytes, p_error: error })
      .catch(() => {});
    return { status: 'failed', id, path, error, rows, bytes, tables: done.length };
  }
}
