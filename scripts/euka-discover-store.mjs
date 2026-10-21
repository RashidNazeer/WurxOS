// ============================================================
// Discover the store_id + euka_brand_id behind a NEW Euka API key.
//
//   node scripts/euka-discover-store.mjs
//
// Reads every EUKA_API_KEY_<SLUG> line from .env.production (gitignored) and,
// for each, asks Euka who it is:
//   GET /stores  -> store_id          (does NOT carry a brand id)
//   GET /brands  -> euka_brand_id     (mig 315: the only place the pairing lives)
//
// Why both: Euka's /data-export requires brand_id ALONGSIDE store_id, and
// brand_id is what actually scopes the rows. Mig 315 verified that pairing one
// brand's store_id with another's brand_id returns the OTHER brand's data,
// silently and with a 200. So this script refuses to guess: if a key sees more
// than one store or more than one brand, it prints them and pairs nothing.
// A dedicated ('own') key should see exactly one of each.
//
// Talks only to Euka. Touches no database and writes no secret anywhere.
// Result is saved to Downloads\euka-new-stores.json.
// ============================================================
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const ROOT = path.resolve(import.meta.dirname, '..');
const BASE = 'https://api.euka.ai/v0';

const envFile = path.join(ROOT, '.env.production');
if (!fs.existsSync(envFile)) {
  console.error('Missing ' + envFile);
  console.error('Add one line per new key, e.g.  EUKA_API_KEY_HONEYSTICKS=euka_openapi_...');
  process.exit(1);
}

const keys = [];
for (const line of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
  const m = line.match(/^EUKA_API_KEY_([A-Z0-9_]+)\s*=\s*(.+)$/);
  if (m && m[2].trim()) keys.push({ slug: m[1].toLowerCase(), key: m[2].trim() });
}
if (!keys.length) {
  console.error('No EUKA_API_KEY_<SLUG> lines found in .env.production.');
  console.error('Example:  EUKA_API_KEY_HONEYSTICKS=euka_openapi_xxx');
  process.exit(1);
}

async function get(pathname, key) {
  const res = await fetch(BASE + pathname, {
    headers: { Authorization: 'Bearer ' + key, Accept: 'application/json' },
  });
  const text = await res.text();
  if (!res.ok) throw new Error('HTTP ' + res.status + ' on ' + pathname + ' — ' + text.slice(0, 200));
  let j;
  try { j = JSON.parse(text); } catch { throw new Error('Non-JSON from ' + pathname + ': ' + text.slice(0, 160)); }
  const arr = Array.isArray(j) ? j : (j.data ?? j.items ?? j.results ?? j.stores ?? j.brands ?? []);
  return Array.isArray(arr) ? arr : [arr];
}
const pick = (o, names) => { for (const n of names) if (o && o[n] != null) return String(o[n]); return null; };

const out = [];
for (const { slug, key } of keys) {
  const row = { slug, secret_name: 'EUKA_API_KEY_' + slug.toUpperCase(), ok: false };
  try {
    const stores = await get('/stores', key);
    const brands = await get('/brands', key);
    row.store_count = stores.length;
    row.brand_count = brands.length;
    row.stores = stores.map((s) => ({ id: pick(s, ['id', 'store_id', 'storeId']), name: pick(s, ['name', 'label', 'store_name']) }));
    row.brands = brands.map((b) => ({ id: pick(b, ['id', 'brand_id', 'brandId']), name: pick(b, ['name', 'label', 'brand_name']) }));

    if (stores.length === 1 && brands.length === 1) {
      row.store_id = row.stores[0].id;
      row.euka_brand_id = row.brands[0].id;
      row.label = row.stores[0].name || row.brands[0].name || slug;
      row.ok = !!(row.store_id && row.euka_brand_id);
      if (!row.ok) row.note = 'Could not read an id field — see stores/brands below for the real shape.';
    } else {
      row.note = 'REFUSING TO PAIR: expected exactly 1 store and 1 brand, saw '
        + stores.length + ' store(s) and ' + brands.length + ' brand(s). '
        + 'Mig 315: a wrong brand_id silently returns another brand’s data.';
    }
  } catch (e) {
    row.error = String(e.message || e);
  }
  out.push(row);
}

for (const r of out) {
  console.log('\n=== ' + r.slug + '  (' + r.secret_name + ')');
  if (r.error) { console.log('  ERROR: ' + r.error); continue; }
  console.log('  stores: ' + r.store_count + '   brands: ' + r.brand_count);
  if (r.ok) {
    console.log('  label         : ' + r.label);
    console.log('  store_id      : ' + r.store_id);
    console.log('  euka_brand_id : ' + r.euka_brand_id);
  } else {
    console.log('  ' + r.note);
    console.log('  stores: ' + JSON.stringify(r.stores));
    console.log('  brands: ' + JSON.stringify(r.brands));
  }
}

const outFile = path.join(os.homedir(), 'Downloads', 'euka-new-stores.json');
fs.writeFileSync(outFile, JSON.stringify(out, null, 2), 'utf8');
console.log('\nSaved: ' + outFile);
