// ============================================================
// QA runner: a SQL test file with not-yet-applied migrations executed first,
// all inside ONE transaction that is ALWAYS rolled back. DEV ONLY.
//
//   node tests/run-with-migrations.mjs --mig 379,380,374,375,381 tests/sql/grants.sql [more.sql …]
//   node tests/run-with-migrations.mjs tests/sql/store_health.sql      (no migrations)
//
// Like `scripts/db-dev.mjs sql`, plus: migrations already recorded on dev are
// skipped (the post-deploy state runs the same command), several files share
// the transaction in order, and the transaction id is checked before rollback.
// Short locks: lock_timeout 10 s; the server ends the session if this process
// dies mid-run (idle_in_transaction_session_timeout 60 s).
// ============================================================
import fs from 'node:fs';
import path from 'node:path';
import pg from 'pg';
import { ASSISTANT, devDbUrl, findTxControl, SSL, stripBom } from '../scripts/dev-env.mjs';

const args = process.argv.slice(2);
const mi = args.indexOf('--mig');
const migs = mi >= 0 ? args[mi + 1].split(',').map((s) => s.trim()).filter(Boolean) : [];
const files = args.filter((_, i) => mi < 0 || (i !== mi && i !== mi + 1));
if (!files.length) { console.error('usage: run-with-migrations.mjs [--mig 379,380,…] <file.sql> [...]'); process.exit(2); }
for (const f of files) {
  const bad = findTxControl(fs.readFileSync(path.resolve(f), 'utf8'));
  if (bad.length) { console.error(`Refusing: ${f} contains transaction control (${bad.slice(0, 3).join('; ')}).`); process.exit(1); }
}
const migDir = path.join(ASSISTANT, 'supabase', 'migrations');
const migFile = (v) => {
  const f = fs.readdirSync(migDir).find((n) => n.startsWith(`${v}_`) && n.endsWith('.sql'));
  if (!f) throw new Error(`no migration file for ${v}`);
  return path.join(migDir, f);
};

const c = new pg.Client({ connectionString: devDbUrl(), ssl: SSL, connectionTimeoutMillis: 20_000, query_timeout: 300_000 });
c.on('notice', (n) => { if (n.severity !== 'NOTICE' || !/does not exist, skipping/.test(n.message)) console.log(`  ${n.severity?.toLowerCase() ?? 'notice'}: ${n.message}`); });
c.on('error', () => {});
await c.connect();
let xid = null;
let failed = false;
try {
  await c.query(`set idle_in_transaction_session_timeout = '60s'`);
  await c.query('begin');
  xid = (await c.query('select pg_current_xact_id()::text x')).rows[0].x;
  await c.query(`set local lock_timeout = '10s'`);
  const applied = new Set((await c.query(`select version from supabase_migrations.schema_migrations`)).rows.map((r) => r.version));
  for (const v of migs) {
    if (applied.has(v)) { console.log(`= ${v} already applied on dev, not re-run`); continue; }
    await c.query(stripBom(fs.readFileSync(migFile(v), 'utf8')));
    console.log(`+ ${v} executed inside the transaction`);
  }
  for (const f of files) {
    console.log(`\n### ${f}`);
    const res = await c.query(stripBom(fs.readFileSync(path.resolve(f), 'utf8')));
    for (const r of [].concat(res)) {
      if (!r.rows?.length) continue;
      // result tables (n, result, test, detail) one line each; anything else as a table
      if ('result' in r.rows[0] && 'test' in r.rows[0]) {
        for (const x of r.rows) console.log(`${String(x.result).padEnd(4)} ${x.test}${x.detail != null ? `  [${String(x.detail).slice(0, 300)}]` : ''}`);
      } else console.table(r.rows);
    }
  }
} catch (e) {
  failed = true;
  console.error(`ERROR: ${e.message}${e.position ? ` (at char ${e.position})` : ''}`);
} finally {
  let intact = false;
  try { intact = (await c.query('select pg_current_xact_id()::text x')).rows[0].x === xid; } catch { intact = true; }
  await c.query('rollback').catch(() => {});
  await c.end().catch(() => {});
  if (intact) console.log('(rolled back)');
  else { console.error('!!! the transaction id changed: something may have been COMMITTED on dev'); failed = true; }
  process.exitCode = failed ? 1 : 0;
}
