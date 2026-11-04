// Runs the SQL stand-in's statements as the signed-in person: one short transaction per statement with
// role `authenticated`, their id in the JWT claims (the same two things PostgREST sets), READ ONLY and a short
// statement timeout, so row-level security decides what comes back and nothing can be written.
// deno-lint-ignore-file no-explicit-any

import postgres from 'npm:postgres@3.4.4';
import { hasStatementBreak, pgClient, type PgClient, type RunSql } from '../_shared/mcp/sqlBuilder.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function userPgClient(dbUrl: string, userId: string): { client: PgClient; close: () => Promise<void> } {
  if (!UUID.test(userId)) throw new Error('bad user id');
  const sql = postgres(dbUrl, { max: 1, idle_timeout: 5, connect_timeout: 8, prepare: false, onnotice: () => {} });
  const claims = JSON.stringify({ sub: userId, role: 'authenticated' });

  const run: RunSql = async (text) => {
    if (hasStatementBreak(text)) throw new Error('refused: more than one statement');
    return await sql.begin('read only', async (tx: any) => {
      // The escaping in sqlBuilder.ts relies on standard_conforming_strings (the Postgres default): check it.
      const [{ s }] = await tx`select current_setting('standard_conforming_strings') as s`;
      if (s !== 'on') throw new Error('refused: unexpected server setting');
      await tx`select set_config('request.jwt.claims', ${claims}, true)`;
      await tx.unsafe(`set local role authenticated`);
      await tx.unsafe(`set local statement_timeout = '8s'`);
      // Extended protocol (simple: false): the server itself rejects a second statement in the text.
      const rows = await tx.unsafe(text, [], { simple: false });
      const j = rows?.[0]?.j ?? null;
      return typeof j === 'string' ? JSON.parse(j) : j;
    });
  };

  const setCache = new Map<string, boolean>();
  const isSet = async (fn: string): Promise<boolean> => {
    if (!setCache.has(fn)) {
      const r = await sql`select proretset from pg_proc where proname = ${fn} and pronamespace = 'public'::regnamespace`;
      if (r.length !== 1) throw new Error(`function ${fn} is missing or overloaded`);
      setCache.set(fn, r[0].proretset === true);
    }
    return setCache.get(fn)!;
  };
  return { client: pgClient(run, isSet), close: async () => { try { await sql.end({ timeout: 2 }); } catch { /* already closed */ } } };
}
