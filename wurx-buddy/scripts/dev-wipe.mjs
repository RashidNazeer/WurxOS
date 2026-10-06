// DEV ONLY. Clears operational data, keeping people, brands, assignments and configuration.
// Owner, 2026-10-02: "delete all reports and all data ingestion, keep the users, their logins
// and their roles; keep the brands but delete all data except that" + delete knowledge content.
//   node scripts/dev-wipe.mjs            dry run: what would go, what stays
//   node scripts/dev-wipe.mjs --confirm  do it
import pg from 'pg';
import { devDbUrl, SSL } from './dev-env.mjs';

// Kept: identity, brands and their assignments/integrations, and configuration.
const KEEP = new Set([
  'profiles', 'push_subscriptions',
  'brands', 'brand_assignments', 'ads_manager_brands', 'pctl_brand_selections',
  'paid_collab_brands', 'halo_brands', 'euka_stores', 'tiktok_connections', 'tiktok_ad_accounts',
  'app_config', 'ai_assistant_config', 'ai_model_catalog', 'ai_key_slots',
  'agenda_settings', 'agenda_team_schedules', 'video_review_settings', 'creator_library_config',
  'slack_config', 'achievement_types', 'payout_fx_rates', 'bi_weekly_anchors',
  'resource_planner_config', 'performance_config', 'performance_weight_history',
  'company_holidays', 'report_section_presets', 'user_report_custom_fields',
]);

const db = new pg.Client({ connectionString: devDbUrl(), ssl: SSL });   // refuses anything but dev
await db.connect();
const { rows: all } = await db.query(
  `select c.relname as t from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relkind = 'r' order by 1`);
const tables = all.map((r) => r.t);
const drop = tables.filter((t) => !KEEP.has(t));
const keep = tables.filter((t) => KEEP.has(t));

// TRUNCATE CASCADE also empties anything referencing a dropped table. Abort if that
// would reach a table we promised to keep.
const { rows: risk } = await db.query(
  `select distinct src.relname as keeps, tgt.relname as because_of
   from pg_constraint k
   join pg_class src on src.oid = k.conrelid
   join pg_class tgt on tgt.oid = k.confrelid
   where k.contype = 'f' and src.relname = any($1) and tgt.relname = any($2)`, [keep, drop]);
if (risk.length) {
  console.log('ABORT: these kept tables point at tables being cleared, so CASCADE would empty them too:');
  for (const r of risk) console.log(`  ${r.keeps}  ->  ${r.because_of}`);
  await db.end();
  process.exit(1);
}

const counts = async (list) => {
  const out = {};
  for (const t of list) out[t] = Number((await db.query(`select count(*)::int n from public."${t}"`)).rows[0].n);
  return out;
};
const before = await counts(drop);
const keptBefore = await counts(keep);
const total = Object.values(before).reduce((a, b) => a + b, 0);
console.log(`clearing ${drop.length} tables (${total.toLocaleString()} rows), keeping ${keep.length}`);
console.log('biggest:', Object.entries(before).filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1]).slice(0, 12)
  .map(([t, n]) => `${t} ${n}`).join(', '));

if (!process.argv.includes('--confirm')) {
  console.log('\nDRY RUN. Re-run with --confirm to clear them.');
  console.log('keeping (rows):', Object.entries(keptBefore).filter(([, n]) => n > 0).map(([t, n]) => `${t} ${n}`).join(', '));
  await db.end();
  process.exit(0);
}

await db.query(`truncate table ${drop.map((t) => `public."${t}"`).join(', ')} restart identity cascade`);
const after = await counts(drop);
const keptAfter = await counts(keep);
const left = Object.entries(after).filter(([, n]) => n > 0);
console.log(`\ncleared. rows left in cleared tables: ${left.length ? JSON.stringify(Object.fromEntries(left)) : '0'}`);
const changed = keep.filter((t) => keptBefore[t] !== keptAfter[t]);
console.log('kept tables changed (must be none):', changed.length ? changed.join(', ') : 'none');
console.log('kept now:', Object.entries(keptAfter).filter(([, n]) => n > 0).map(([t, n]) => `${t} ${n}`).join(', '));
await db.end();
