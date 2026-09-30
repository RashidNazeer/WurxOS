// ============================================================
// Dev-database helper for the Assistant project. DEV ONLY.
//
//   node scripts/db-dev.mjs apply 367 368 …   apply migrations (in order)
//   node scripts/db-dev.mjs status             which 36x/37x migrations dev has
//   node scripts/db-dev.mjs sql <file.sql>     run a SQL file inside a transaction
//                                              that is ALWAYS rolled back (tests)
//
// Guard rails:
//   • Reads ../.env.dev. Parses WURXOS_DEV_DB_URL and refuses unless its host
//     (or pooler user) is WURXOS_DEV_PROJECT_REF; refuses the production ref.
//   • `sql` refuses files with transaction-control statements, and verifies
//     afterwards that it is still inside its own transaction before claiming
//     "rolled back".
//   • Each migration runs in its own transaction and is recorded in
//     supabase_migrations.schema_migrations, so a later `supabase db push`
//     against dev will not re-run it. Already-recorded versions are skipped.
//   • Never uses `supabase db push` — dev's history may lack other branches'
//     migrations, and push would apply those too.
// ============================================================
import fs from 'node:fs';
import path from 'node:path';
import pg from 'pg';
import { ASSISTANT, devDbUrl, findTxControl, SSL, stripBom } from './dev-env.mjs';

const url = devDbUrl();
const [cmd, ...rest] = process.argv.slice(2);

if (cmd === 'sql') {
  const bad = findTxControl(fs.readFileSync(path.resolve(rest[0]), 'utf8'));
  if (bad.length) {
    console.error(`Refusing: ${rest[0]} contains transaction control (${bad.slice(0, 3).join('; ')}); the runner owns the transaction.`);
    process.exit(1);
  }
}

const client = new pg.Client({ connectionString: url, ssl: SSL });
await client.connect();
client.on('notice', (n) => console.log(`  notice: ${n.message}`));

const migDir = path.join(ASSISTANT, 'supabase', 'migrations');
const fileFor = (v) => {
  const f = fs.readdirSync(migDir).find((n) => n.startsWith(`${v}_`) && n.endsWith('.sql'));
  if (!f) throw new Error(`no migration file for ${v}`);
  return f;
};

try {
  if (cmd === 'apply') {
    for (const v of rest) {
      const file = fileFor(v);
      const name = file.replace(/^\d+_/, '').replace(/\.sql$/, '');
      const { rows } = await client.query('select 1 from supabase_migrations.schema_migrations where version = $1', [String(v)]);
      if (rows.length) { console.log(`= ${file} already applied, skipping`); continue; }
      const sql = stripBom(fs.readFileSync(path.join(migDir, file), 'utf8'));
      await client.query('begin');
      try {
        await client.query(sql);
        await client.query('insert into supabase_migrations.schema_migrations (version, name, statements) values ($1, $2, $3)', [String(v), name, [sql]]);
        await client.query('commit');
        console.log(`✓ ${file}`);
      } catch (e) {
        await client.query('rollback');
        console.error(`✗ ${file}: ${e.message}${e.position ? ` (at char ${e.position})` : ''}`);
        process.exitCode = 1;
        break;
      }
    }
  } else if (cmd === 'status') {
    const { rows } = await client.query(`select version, name from supabase_migrations.schema_migrations where version::int >= 360 order by version::int`);
    console.table(rows);
  } else if (cmd === 'sql') {
    const sql = stripBom(fs.readFileSync(path.resolve(rest[0]), 'utf8'));
    await client.query('begin');
    // Our transaction id: a file cannot forge it (QA L8). If it differs
    // afterwards, something committed and a new transaction began.
    const xid = (await client.query('select pg_current_xact_id()::text as x')).rows[0].x;
    let intact = false;
    try {
      const res = await client.query(sql);
      for (const r of [].concat(res)) if (r.rows?.length) console.table(r.rows);
    } finally {
      try {
        const { rows } = await client.query('select pg_current_xact_id()::text as x');
        intact = rows[0].x === xid;
      } catch { intact = true; }   // aborted transaction: still ours, the rollback below ends it
      await client.query('rollback');
      if (intact) console.log('(rolled back)');
      else { console.error('!!! The runner\'s transaction ended early: some statements may have been COMMITTED on dev.'); process.exitCode = 1; }
    }
  } else {
    console.log('usage: db-dev.mjs apply <versions…> | status | sql <file>');
  }
} finally {
  await client.end();
}
