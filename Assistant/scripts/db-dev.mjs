// ============================================================
// Dev-database helper for the Assistant project. DEV ONLY.
//
//   node Assistant/scripts/db-dev.mjs apply 367 368 …   apply migrations (in order)
//   node Assistant/scripts/db-dev.mjs status             which 36x/37x migrations dev has
//   node Assistant/scripts/db-dev.mjs sql <file.sql>     run a SQL file inside a transaction
//                                                       that is ALWAYS rolled back (tests)
//
// Guard rails:
//   • Reads .env.dev. Refuses to run unless the connection string contains
//     WURXOS_DEV_PROJECT_REF, and refuses the production ref outright.
//   • Each migration runs in its own transaction and is recorded in
//     supabase_migrations.schema_migrations, so a later `supabase db push`
//     against dev will not re-run it. Already-recorded versions are skipped.
//   • Never uses `supabase db push` — dev's history may lack other branches'
//     migrations, and push would apply those too.
// ============================================================
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const PROD_REF = 'xoaaidgvblondjpvxjqp';
const env = Object.fromEntries(fs.readFileSync(path.join(ROOT, '.env.dev'), 'utf8').split(/\r?\n/)
  .filter((l) => l.includes('=') && !l.trim().startsWith('#'))
  .map((l) => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, '')]; }));

const url = env.WURXOS_DEV_DB_URL || '';
const devRef = env.WURXOS_DEV_PROJECT_REF || '';
if (!devRef || !url.includes(devRef)) { console.error('Refusing: WURXOS_DEV_DB_URL does not point at WURXOS_DEV_PROJECT_REF.'); process.exit(1); }
if (url.includes(PROD_REF) || devRef === PROD_REF) { console.error('Refusing: that is the PRODUCTION project.'); process.exit(1); }

const [cmd, ...rest] = process.argv.slice(2);
const client = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
await client.connect();
client.on('notice', (n) => console.log(`  notice: ${n.message}`));

const migDir = path.join(ROOT, 'supabase', 'migrations');
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
      const sql = fs.readFileSync(path.join(migDir, file), 'utf8');
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
    const sql = fs.readFileSync(path.resolve(rest[0]), 'utf8');
    await client.query('begin');
    try {
      const res = await client.query(sql);
      for (const r of [].concat(res)) if (r.rows?.length) console.table(r.rows);
    } finally { await client.query('rollback'); console.log('(rolled back)'); }
  } else {
    console.log('usage: db-dev.mjs apply <versions…> | status | sql <file>');
  }
} finally {
  await client.end();
}
