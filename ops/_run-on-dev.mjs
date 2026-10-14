// Applies a .sql file to the DEV database over a direct Postgres connection.
// Used because the Supabase CLI needs the management API, and this machine's
// CLI account cannot see the WurxOS projects (see HANDOVER.md 3.2).
//
//   node ops/_run-on-dev.mjs ops/apply-420-ipc-visibility.sql
import fs from 'node:fs';
import pg from 'pg';

const file = process.argv[2];
if (!file) throw new Error('usage: node ops/_run-on-dev.mjs <file.sql>');

const env = Object.fromEntries(
  fs.readFileSync('.env.dev', 'utf8').split(/\r?\n/)
    .map((l) => l.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*)$/))
    .filter(Boolean).map((m) => [m[1], m[2].trim()]),
);

const url = env.WURXOS_DEV_DB_URL;
if (!url) throw new Error('WURXOS_DEV_DB_URL missing from .env.dev');
// Refuse to touch anything but dev, whatever the file says.
if (!url.includes('vyvkwbvreeycmmnikqbz')) throw new Error('not the dev project - aborting');
if (url.includes('xoaaidgvblondjpvxjqp')) throw new Error('PRODUCTION ref - aborting');

const sql = fs.readFileSync(file, 'utf8');
const client = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
await client.connect();
try {
  const res = await client.query(sql);
  const sets = Array.isArray(res) ? res : [res];
  for (const r of sets) {
    if (r?.rows?.length) {
      console.log(`\n--- ${r.rows.length} row(s) ---`);
      console.table(r.rows);
    }
  }
  console.log('\nDone.');
} finally {
  await client.end();
}
