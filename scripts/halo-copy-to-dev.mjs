// Copy Amazon Halo configuration and data from PROD to DEV. Halo only.
//
//   node scripts/halo-copy-to-dev.mjs            dry run — shows what would move
//   node scripts/halo-copy-to-dev.mjs --apply    writes to DEV
//
// ── THE SAFETY THAT MATTERS MOST ───────────────────────────────────────────
// PROD IS NEVER WRITTEN TO. It is reached through PostgREST with GET requests
// only, and this file contains no prod write path of any kind. The dev database
// is the only writable connection that is opened.
//
// ── WHY THIS IS HALO-ONLY, AND HOW THAT IS ENFORCED ────────────────────────
// TABLES below is an explicit allow-list, not a pattern match. A survey found
// no halo_* column on brands or profiles, so enabling Halo on dev means
// INSERTING rows into halo tables — it never updates a brand or a user, and
// nothing here can touch a table outside the list.
//
// halo_shares and halo_v2_shares are deliberately EXCLUDED. They are public
// share links belonging to prod, not settings; copying them would mint dev URLs
// that look like real shared reports. Pass --with-shares if they are wanted.
//
// ── FOREIGN KEYS ARE CHECKED BEFORE ANYTHING IS WRITTEN ────────────────────
// Every halo row points at a brand and a profile. Dev's brands and users were
// copied separately, so a prod row can reference something dev does not have.
// Those rows are reported and SKIPPED rather than failing the run half-way
// through — a partial copy that stopped at row 300 is worse than one that
// completed and said what it left behind.
//
// Re-runnable: every write is an upsert on the primary key, so running twice
// changes nothing the second time.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const { default: pg } = await import(
  new URL('file:///D:/Milestone/WurxOS V2/gmv-intel/node_modules/pg/lib/index.js').href);

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const APPLY = process.argv.includes('--apply');
const WITH_SHARES = process.argv.includes('--with-shares');

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
const PROD_REST = prodEnv.VITE_SUPABASE_URL;
const PROD_KEY = prodEnv.SERVICE_ROLL_KEY;
const DEV_URL = devEnv.WURXOS_DEV_DB_URL;

if (!PROD_REST || !PROD_KEY || !DEV_URL) {
  console.error('Missing credentials. Need VITE_SUPABASE_URL + SERVICE_ROLL_KEY in .env.local and WURXOS_DEV_DB_URL in .env.dev.local.');
  process.exit(1);
}
// A dev URL that is not the dev project would make this a prod-to-prod copy.
if (!/vyvkwbvreeycmmnikqbz/.test(DEV_URL)) {
  console.error('Refusing to run: the dev connection string is not the dev project.');
  process.exit(1);
}

/** GET only. There is no POST/PATCH/DELETE path to prod anywhere in this file. */
async function prodRows(table) {
  const out = [];
  const page = 1000;
  for (let from = 0; ; from += page) {
    const res = await fetch(`${PROD_REST}/rest/v1/${table}?select=*`, {
      headers: {
        apikey: PROD_KEY,
        Authorization: `Bearer ${PROD_KEY}`,
        Range: `${from}-${from + page - 1}`,
      },
    });
    if (!res.ok) throw new Error(`prod ${table}: HTTP ${res.status}`);
    const rows = await res.json();
    out.push(...rows);
    if (rows.length < page) break;
  }
  return out;
}

// Order matters: a dataset must exist before its rows can reference it.
const TABLES = [
  { name: 'halo_brands', pk: ['brand_id'], fks: [['brand_id', 'brands'], ['enabled_by', 'profiles']] },
  { name: 'halo_datasets', pk: ['id'], fks: [['brand_id', 'brands'], ['created_by', 'profiles']] },
  { name: 'halo_rows', pk: ['id'], fks: [['dataset_id', 'halo_datasets']] },
];
if (WITH_SHARES) {
  TABLES.push({ name: 'halo_shares', pk: ['id'], fks: [['created_by', 'profiles']] });
  TABLES.push({ name: 'halo_v2_shares', pk: ['id'], fks: [['created_by', 'profiles']] });
}

const dev = new pg.Client({ connectionString: DEV_URL, ssl: { rejectUnauthorized: false } });
await dev.connect();

console.log(`prod  ${PROD_REST.replace(/https:\/\/([a-z0-9]+).*/, '$1')}  (read-only)`);
console.log(`dev   vyvkwbvreeycmmnikqbz`);
console.log(APPLY ? '\nAPPLYING to dev.\n' : '\nDRY RUN — nothing will be written. Re-run with --apply.\n');

const report = [];
// Ids this run will have inserted by the time a later table references them.
const willExist = new Map();

for (const t of TABLES) {
  const rows = await prodRows(t.name);

  // Which referenced ids actually exist on dev.
  //
  // `willExist` matters for the dry run. halo_rows point at halo_datasets, and
  // in an --apply run those datasets are inserted moments earlier in this same
  // loop. Checking only dev's CURRENT state reported all 628 rows as
  // uncopyable, which is not what applying would do — and a dry run that
  // disagrees with the real run is worse than no dry run at all.
  const missing = new Map();
  for (const [col, refTable] of t.fks) {
    const ids = [...new Set(rows.map((r) => r[col]).filter(Boolean))];
    if (!ids.length) continue;
    const { rows: present } = await dev.query(
      `select id from public.${refTable} where id = any($1::uuid[])`, [ids],
    );
    const have = new Set(present.map((p) => p.id));
    for (const id of willExist.get(refTable) || []) have.add(id);
    const gone = ids.filter((i) => !have.has(i));
    if (gone.length) missing.set(col, { refTable, gone: new Set(gone) });
  }

  // A row is only copyable when every REQUIRED reference resolves. A nullable
  // reference that is missing is nulled rather than dropping the whole row —
  // losing a dataset because the person who created it is not on dev would be
  // the wrong trade.
  const usable = [];
  const skipped = [];
  for (const r of rows) {
    let drop = null;
    const copy = { ...r };
    for (const [col, refTable] of t.fks) {
      const m = missing.get(col);
      if (!m || !r[col] || !m.gone.has(r[col])) continue;
      const required = col === 'brand_id' || col === 'dataset_id';
      if (required) { drop = `${col} -> ${refTable} ${r[col]} is not on dev`; break; }
      copy[col] = null;
    }
    if (drop) skipped.push({ row: r, why: drop }); else usable.push(copy);
  }

  console.log(`${t.name.padEnd(16)} prod ${String(rows.length).padStart(5)}  copyable ${String(usable.length).padStart(5)}  skipped ${skipped.length}`);
  for (const s of skipped.slice(0, 5)) console.log(`    skip: ${s.why}`);
  if (skipped.length > 5) console.log(`    …and ${skipped.length - 5} more`);

  report.push({ table: t.name, prod: rows.length, usable: usable.length, skipped: skipped.length });

  // Record what this table contributes, so the next table can see it.
  if (t.pk.length === 1) {
    willExist.set(t.name, new Set(usable.map((r) => r[t.pk[0]]).filter(Boolean)));
  }

  if (!APPLY || !usable.length) continue;

  const cols = Object.keys(usable[0]);
  const conflict = t.pk.join(', ');
  const updates = cols.filter((c) => !t.pk.includes(c))
    .map((c) => `"${c}" = excluded."${c}"`).join(', ');

  let written = 0;
  for (const r of usable) {
    const values = cols.map((c) => r[c]);
    const params = cols.map((_, i) => `$${i + 1}`).join(', ');
    await dev.query(
      `insert into public.${t.name} (${cols.map((c) => `"${c}"`).join(', ')})
       values (${params})
       on conflict (${conflict}) do update set ${updates || `"${cols[0]}" = excluded."${cols[0]}"`}`,
      values,
    );
    written += 1;
  }
  console.log(`    wrote ${written}`);
}

console.log('\n── dev after ───────────────────────────────────────────────');
for (const t of TABLES) {
  const { rows } = await dev.query(`select count(*)::int n from public.${t.name}`);
  console.log(`  ${t.name.padEnd(16)} ${rows[0].n}`);
}

await dev.end();

if (!APPLY) console.log('\nNothing was written. Re-run with --apply to copy.');
console.log('\nProd was never written to: every prod call in this script is a GET.');
