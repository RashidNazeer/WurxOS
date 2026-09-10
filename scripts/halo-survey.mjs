// READ-ONLY survey of the Amazon Halo tables on prod and dev.
//
// Writes nothing to either database. Its only job is to say what a copy WOULD
// move, so the scope can be agreed before anything is written — the owner asked
// for Halo data only, and "only Halo" is a claim that has to be checked against
// the schema rather than assumed from table names.
//
// Prod is opened read-only and is never written to by this file or by the copy
// script that follows it.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
// pg is not a dependency of this repo, so it is resolved from the sibling
// project rather than installed here — a survey script should not change the
// dependency tree of the app it is surveying.
const { default: pg } = await import(
  new URL('file:///D:/Milestone/WurxOS V2/gmv-intel/node_modules/pg/lib/index.js').href);

// fileURLToPath, not URL.pathname: this path contains a space, and pathname
// leaves it percent-encoded so every fs call silently misses.
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function readEnv(file) {
  const out = {};
  const p = path.join(ROOT, file);
  if (!fs.existsSync(p)) return out;
  for (const line of fs.readFileSync(p, 'utf8').split(/\r?\n/)) {
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && m[2]) out[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
  return out;
}

const prodEnv = readEnv('.env.local');
const devEnv = readEnv('.env.dev.local');

const PROD_REF = (prodEnv.VITE_SUPABASE_URL || '').match(/https:\/\/([a-z0-9]+)\./)?.[1];
const DEV_REF = devEnv.WURXOS_DEV_PROJECT_REF;
const DEV_URL = devEnv.WURXOS_DEV_DB_URL;

if (!PROD_REF || !DEV_REF) {
  console.error('Could not resolve both project refs. prod=%s dev=%s', PROD_REF, DEV_REF);
  process.exit(1);
}

// The prod DB password is not in .env.local (only the service-role key is), so
// prod is reached through PostgREST rather than a direct connection. That is
// also a useful accident: this script CANNOT write to prod even by mistake,
// because it never opens a writable session against it.
const PROD_REST = prodEnv.VITE_SUPABASE_URL;
const PROD_KEY = prodEnv.SERVICE_ROLL_KEY;

async function prodQuery(table, select = '*', limit = 1) {
  const url = `${PROD_REST}/rest/v1/${table}?select=${encodeURIComponent(select)}&limit=${limit}`;
  const res = await fetch(url, {
    headers: {
      apikey: PROD_KEY,
      Authorization: `Bearer ${PROD_KEY}`,
      Prefer: 'count=exact',
    },
  });
  const range = res.headers.get('content-range');
  const total = range ? Number(range.split('/')[1]) : null;
  if (!res.ok) return { ok: false, status: res.status, total: null, rows: [] };
  return { ok: true, status: res.status, total, rows: await res.json() };
}

const dev = new pg.Client({ connectionString: DEV_URL, ssl: { rejectUnauthorized: false } });
await dev.connect();

console.log(`prod ${PROD_REF}  (read-only, via PostgREST)`);
console.log(`dev  ${DEV_REF}\n`);

// Every table whose name suggests Halo, discovered from the DEV schema rather
// than from a hardcoded list — the two schemas should match, and a table
// present on one but not the other is itself worth seeing.
const { rows: tables } = await dev.query(`
  select table_name
    from information_schema.tables
   where table_schema = 'public'
     and table_name ilike '%halo%'
   order by table_name`);

console.log('── Halo tables ─────────────────────────────────────────────');
console.log('table'.padEnd(34), 'prod'.padStart(8), 'dev'.padStart(8));

const summary = [];
for (const t of tables) {
  const name = t.table_name;
  const p = await prodQuery(name, 'count', 1).catch(() => ({ ok: false, total: null }));
  const d = await dev.query(`select count(*)::int n from public.${name}`).catch(() => ({ rows: [{ n: null }] }));
  const devN = d.rows[0].n;
  summary.push({ name, prod: p.total, dev: devN });
  console.log(name.padEnd(34), String(p.total ?? '—').padStart(8), String(devN ?? '—').padStart(8));
}

// Halo enablement may live as a COLUMN on brands rather than in its own table.
// That matters a lot: copying it means UPDATING existing dev rows, not
// inserting, and getting that wrong would overwrite dev's brands.
console.log('\n── Halo-related columns on other tables ────────────────────');
const { rows: cols } = await dev.query(`
  select table_name, column_name, data_type
    from information_schema.columns
   where table_schema = 'public'
     and column_name ilike '%halo%'
     and table_name not ilike '%halo%'
   order by table_name, column_name`);
if (!cols.length) console.log('  (none — Halo state lives entirely in its own tables)');
for (const c of cols) console.log(`  ${c.table_name}.${c.column_name}  ${c.data_type}`);

// Anything that would fire on insert. The owner has been bitten once already by
// a prod-to-dev copy waking real users' devices.
console.log('\n── triggers on those tables (what a copy would fire) ───────');
const names = tables.map((t) => `'${t.table_name}'`).join(',') || `''`;
const { rows: trg } = await dev.query(`
  select c.relname as table_name, t.tgname as trigger_name
    from pg_trigger t
    join pg_class c on c.oid = t.tgrelid
    join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and not t.tgisinternal
     and c.relname in (${names})
   order by 1, 2`);
if (!trg.length) console.log('  (none — nothing fires on insert into these tables)');
for (const t of trg) console.log(`  ${t.table_name} -> ${t.trigger_name}`);

await dev.end();

console.log('\nNothing was written. This is a survey only.');
