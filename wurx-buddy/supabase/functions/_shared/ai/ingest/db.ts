// The worker's only view of the database: named SQL functions (mig 373).
// Deno wraps supabase-js `rpc`, Node wraps a pg client (pgRpc below), tests
// wrap a pg client inside a transaction they roll back.

export type Rpc = (fn: string, args?: Record<string, unknown>) => Promise<any>;

export type QueueItem = {
  id: number | string;
  source_type: string;
  source_id: string;
  op: 'upsert' | 'delete' | 'acl';
  attempts: number;
};

// One source row as ai_ingest_source() returns it. fp is the SQL-side source
// fingerprint that backfill/reconcile compare against ai_documents.source_fp.
// excluded: on the Boss's exclusion list (mig 380), never indexed.
export type SourceRecord = { source_id: string; indexable: boolean; fp: string; payload?: any; excluded?: boolean };

// One stored document as ai_ingest_existing() returns it.
export type ExistingDoc = {
  source_id: string;
  doc_hash: string;
  source_fp: string | null;
  pipeline_version: string | null;
  embed_model: string | null;
  status: string;
  chunk_hashes: string[];        // by chunk_index
};

export type Queryable = { query(text: string, params?: unknown[]): Promise<{ rows: any[] }> };

// Functions that return rows rather than one value.
const SET_RETURNING = new Set(['ai_ingest_claim']);

// A non-empty array of strings is a text[] argument; any other object or array
// is jsonb (pg would otherwise send a JS array of objects as a Postgres array).
function encode(v: unknown): unknown {
  if (v === undefined) return null;
  if (Array.isArray(v) && v.length && v.every((x) => typeof x === 'string')) return v;
  if (v !== null && typeof v === 'object') return JSON.stringify(v);
  return v;
}

// savepoints: the caller holds ONE transaction open (tests, which roll it
// back). Each call then gets its own savepoint, so a failing RPC is undone on
// its own, as it would be over PostgREST, instead of aborting the transaction.
export function pgRpc(client: Queryable, opts: { savepoints?: boolean } = {}): Rpc {
  return async (fn, args = {}) => {
    if (!/^[a-z_][a-z0-9_]*$/.test(fn)) throw new Error(`bad function name ${fn}`);
    const keys = Object.keys(args).filter((k) => args[k] !== undefined);
    for (const k of keys) if (!/^[a-z_][a-z0-9_]*$/.test(k)) throw new Error(`bad argument name ${k}`);
    const call = `public.${fn}(${keys.map((k, i) => `${k} => $${i + 1}`).join(', ')})`;
    const params = keys.map((k) => encode(args[k]));
    const run = async () => (SET_RETURNING.has(fn)
      ? (await client.query(`select * from ${call}`, params)).rows
      : (await client.query(`select ${call} as v`, params)).rows[0]?.v ?? null);
    if (!opts.savepoints) return run();
    await client.query('savepoint ai_rpc');
    try {
      const out = await run();
      await client.query('release savepoint ai_rpc');
      return out;
    } catch (e) {
      await client.query('rollback to savepoint ai_rpc');
      throw e;
    }
  };
}

// supabase-js client → Rpc (the edge function). Typed loosely so this file
// needs no supabase import.
export function supabaseRpc(admin: { rpc(fn: string, args?: Record<string, unknown>): PromiseLike<{ data: any; error: any }> }): Rpc {
  return async (fn, args = {}) => {
    const { data, error } = await admin.rpc(fn, args);
    if (error) throw new Error(`${fn}: ${error.message ?? JSON.stringify(error)}`);
    return data;
  };
}
