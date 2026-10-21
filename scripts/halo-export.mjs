// ============================================================
// Amazon Halo — export every sheet for one brand to CSV.
//
//   node scripts/halo-export.mjs                  auto-picks the brand with the most sheets
//   node scripts/halo-export.mjs "Apothecary"     or name one (quote it)
//   node scripts/halo-export.mjs --list           just show what exists, write nothing
//   node scripts/halo-export.mjs --dataset <uuid> export one dataset by id
//
// Reads SUPABASE_ACCESS_TOKEN from .env.production (gitignored) and calls the
// Supabase Management API query endpoint — the same path the dashboard SQL
// Editor uses, so no database password is needed.
//
// Writes into %USERPROFILE%\Downloads\wurxos-halo-<brand>-<date>\:
//   manifest.csv           the datasets behind everything below
//   1-metrics.csv          one row per date per granularity, metrics jsonb expanded
//   2-product-revenue.csv  halo_rows.product_revenue expanded (mig 261)
//   3-weekly-keywords.csv  halo_datasets.weekly_keywords expanded (mig 261)
//
// Brands are matched on brand_id, never on a name string — the restructure
// taught us what name matching costs. A pre-mig-267 dataset with a NULL
// brand_id has no brand to match, so reach it with --dataset <uuid>.
// ============================================================
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const ROOT = path.resolve(import.meta.dirname, '..');
const REF = 'xoaaidgvblondjpvxjqp';

const envFile = path.join(ROOT, '.env.production');
if (!fs.existsSync(envFile)) {
  console.error('Missing ' + envFile + ' containing SUPABASE_ACCESS_TOKEN=sbp_...');
  process.exit(1);
}
const TOKEN = (fs.readFileSync(envFile, 'utf8').match(/SUPABASE_ACCESS_TOKEN=(.+)/) || [])[1];
if (!TOKEN) { console.error('No SUPABASE_ACCESS_TOKEN found in .env.production'); process.exit(1); }

async function q(sql) {
  const res = await fetch('https://api.supabase.com/v1/projects/' + REF + '/database/query', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + TOKEN.trim(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: sql }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error('HTTP ' + res.status + ' — ' + text.slice(0, 400));
  let j;
  try { j = JSON.parse(text); } catch { throw new Error('Non-JSON reply: ' + text.slice(0, 200)); }
  return Array.isArray(j) ? j : (j.result ?? j.rows ?? j.data ?? []);
}

// RFC-4180: quote every cell and double any internal quote. Applied to all
// cells rather than the risky-looking ones, because a brand name with a comma
// is exactly the case that gets missed.
function cell(v) {
  if (v === null || v === undefined) return '';
  const s = typeof v === 'object' ? JSON.stringify(v) : String(v);
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}
function writeCsv(file, rows) {
  if (!rows.length) { fs.writeFileSync(file, '', 'utf8'); return 0; }
  const cols = [...new Set(rows.flatMap((r) => Object.keys(r)))];
  const lines = [cols.map(cell).join(',')];
  for (const r of rows) lines.push(cols.map((c) => cell(r[c])).join(','));
  fs.writeFileSync(file, lines.join('\r\n') + '\r\n', 'utf8');
  return rows.length;
}

const METRIC_KEYS = ['gmv', 'orders', 'items_sold', 'aov', 'live_gmv', 'video_per_day',
  'product_impressions', 'unique_impressions', 'product_clicks', 'unique_clicks',
  'revenue_per_day', 'ntb', 'keyword_search_volume', 'keyword_search_rank', 'cost',
  'gmvmax_orders', 'cpo', 'gross_revenue', 'roi'];
const metricCols = METRIC_KEYS
  .map((k) => "(r.metrics->>'" + k + "')::numeric as " + (k === 'revenue_per_day' ? 'amazon_revenue' : k))
  .join(', ');

const args = process.argv.slice(2);
const listOnly = args.includes('--list');
const dsIdx = args.indexOf('--dataset');
const datasetId = dsIdx >= 0 ? args[dsIdx + 1] : null;
const wantBrand = args.find((a) => !a.startsWith('--') && a !== datasetId) || null;

const summary = await q(
  "select coalesce(b.brand_name,'(no brand linked)') as brand, d.brand_id::text as brand_id," +
  " count(*)::int as sheets," +
  " string_agg(coalesce(d.granularity,'legacy'), ', ' order by d.granularity) as granularities," +
  " sum(d.row_count)::int as total_rows" +
  " from public.halo_datasets d left join public.brands b on b.id = d.brand_id" +
  " group by 1,2 order by sheets desc, total_rows desc");
console.table(summary);
if (listOnly) process.exit(0);

let scope;
let label;
if (datasetId) {
  scope = "d.id = '" + datasetId + "'";
  label = 'dataset-' + datasetId.slice(0, 8);
} else {
  const pick = wantBrand
    ? summary.find((s) => String(s.brand).toLowerCase() === wantBrand.toLowerCase())
    : summary.find((s) => s.brand_id);
  if (!pick) { console.error('No brand matched "' + wantBrand + '". Pick one of the brand values above.'); process.exit(1); }
  if (!pick.brand_id) { console.error('"' + pick.brand + '" has no brand_id — export it with --dataset <uuid>.'); process.exit(1); }
  scope = "d.brand_id = '" + pick.brand_id + "'";
  label = String(pick.brand).replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '');
  console.log('\nExporting ' + pick.brand + ' — ' + pick.sheets + ' sheet(s) [' + pick.granularities + '], ' + pick.total_rows + ' rows');
}

const manifest = await q(
  "select d.id::text as dataset_id, coalesce(b.brand_name,'(no brand linked)') as brand, d.granularity," +
  " d.row_count, d.period_start, d.period_end, d.currency, d.name, d.source_filename, d.created_at" +
  " from public.halo_datasets d left join public.brands b on b.id = d.brand_id" +
  " where " + scope + " order by d.granularity");

const metrics = await q(
  "select coalesce(d.granularity,'legacy') as granularity, r.date, " + metricCols +
  " from public.halo_rows r join public.halo_datasets d on d.id = r.dataset_id" +
  " where " + scope + " order by 1, r.date");

const products = await q(
  "select coalesce(d.granularity,'legacy') as granularity, r.date, pr.key as product, pr.value::numeric as revenue" +
  " from public.halo_rows r join public.halo_datasets d on d.id = r.dataset_id" +
  " cross join lateral jsonb_each_text(coalesce(r.product_revenue,'{}'::jsonb)) pr" +
  " where " + scope + " order by 1, r.date, pr.key");

const keywords = await q(
  "select wk->>'week_ending' as week_ending, kv.key as keyword, kv.value::numeric as search_volume" +
  " from public.halo_datasets d" +
  " cross join lateral jsonb_array_elements(coalesce(d.weekly_keywords,'[]'::jsonb)) wk" +
  " cross join lateral jsonb_each_text(wk->'keywords') kv" +
  " where " + scope + " order by 1, 2");

// Nothing should be dropped silently: name any metric key the fixed column list misses.
const extra = await q(
  "select distinct k from public.halo_rows r" +
  " join public.halo_datasets d on d.id = r.dataset_id" +
  " cross join lateral jsonb_object_keys(r.metrics) k" +
  " where " + scope + " and k not in (" + METRIC_KEYS.map((k) => "'" + k + "'").join(',') + ")");

const outDir = path.join(os.homedir(), 'Downloads',
  'wurxos-halo-' + label + '-' + new Date().toISOString().slice(0, 10));
fs.mkdirSync(outDir, { recursive: true });

const wrote = [
  ['manifest.csv', writeCsv(path.join(outDir, 'manifest.csv'), manifest)],
  ['1-metrics.csv', writeCsv(path.join(outDir, '1-metrics.csv'), metrics)],
  ['2-product-revenue.csv', writeCsv(path.join(outDir, '2-product-revenue.csv'), products)],
  ['3-weekly-keywords.csv', writeCsv(path.join(outDir, '3-weekly-keywords.csv'), keywords)],
];

console.log('\nWrote to ' + outDir);
for (const [f, n] of wrote) console.log('  ' + String(n).padStart(6) + ' rows  ' + f);
if (extra.length) {
  console.log('\n!! metric keys present but NOT exported — add to METRIC_KEYS: ' + extra.map((e) => e.k).join(', '));
}
