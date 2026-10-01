// ============================================================
// Points the dev cron jobs at the deployed functions (step (e) of
// scripts/deploy-dev.ps1). DEV ONLY.
//
//   node scripts/deploy-dev-config.mjs           set app_config ai_ingest_url, ai_crawl_url, ai_ingest_secret
//   node scripts/deploy-dev-config.mjs --check   read-only: which of the three are set
//
// The secret is read from ../.env.dev (AI_INGEST_SECRET) and never printed.
// Refuses unless WURXOS_DEV_PROJECT_REF is the dev project below and the
// database URL connects to it (dev-env.mjs).
// ============================================================
import pg from 'pg';
import { devDbUrl, readEnv, SSL } from './dev-env.mjs';

const DEV_REF = 'vyvkwbvreeycmmnikqbz';
const env = readEnv();
if (env.WURXOS_DEV_PROJECT_REF !== DEV_REF) {
  console.error(`Refusing: WURXOS_DEV_PROJECT_REF is not the dev project (${DEV_REF}).`);
  process.exit(1);
}
const url = devDbUrl();
const CHECK = process.argv.includes('--check');
const secret = env.AI_INGEST_SECRET ?? '';
if (!CHECK && secret.length < 32) {
  console.error('Refusing: AI_INGEST_SECRET is missing or shorter than 32 characters in ../.env.dev.');
  process.exit(1);
}
const base = `https://${DEV_REF}.supabase.co/functions/v1`;
const want = { ai_ingest_url: `${base}/ai-ingest`, ai_crawl_url: `${base}/tts-crawl`, ai_ingest_secret: secret };

const c = new pg.Client({ connectionString: url, ssl: SSL, connectionTimeoutMillis: 20_000 });
await c.connect();
try {
  if (!CHECK) {
    await c.query('begin');
    for (const [key, value] of Object.entries(want)) {
      await c.query('insert into public.app_config (key, value) values ($1, $2) on conflict (key) do update set value = excluded.value', [key, value]);
    }
    await c.query('commit');
  }
  const { rows } = await c.query(`select key, value from public.app_config where key = any($1) order by key`, [Object.keys(want)]);
  const got = Object.fromEntries(rows.map((r) => [r.key, r.value ?? '']));
  for (const k of Object.keys(want)) {
    const v = got[k];
    const shown = v === undefined ? 'MISSING (apply 375 / 381)' : !v ? 'empty' : k === 'ai_ingest_secret'
      ? `set (${v.length} chars${secret && v === secret ? ', matches ../.env.dev' : secret ? ', DIFFERS from ../.env.dev' : ''})` : v;
    console.log(`${k.padEnd(17)} ${shown}`);
  }
} finally {
  await c.end();
}
