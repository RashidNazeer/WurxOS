// ============================================================
// Assistant v2 ingest runner (Node). DEV ONLY (dev-env.mjs guard).
//
//   node --experimental-strip-types scripts/ingest.mjs [--dry-run] [--source <type>] [--limit <n>] [--tts-jsonl <path>]
//   node --experimental-strip-types scripts/ingest.mjs --backfill [--source <type>] --owner-approved
//   node --experimental-strip-types scripts/ingest.mjs --drain [--limit <n>] --owner-approved
//
// --dry-run (default): read-only transaction, no API call. Runs every source
//   row through the SAME planner the worker uses (ingest/plan.ts) against what
//   the store holds, and prints what a drain would do: documents new / changed
//   / unchanged / to remove, chunks, chunks and tokens to embed, cost. Also
//   checks that SQL and TypeScript agree on which rows are indexable (a
//   disagreement would be re-enqueued every night), and how many rows
//   ai_backfill would enqueue. --tts-jsonl plans the TikTok crawl file as if
//   it were imported (tts_articles is empty until the import).
// --backfill: select ai_backfill(<source>) — enqueues only what differs.
// --drain: runs the worker (real OpenAI embeddings) until the queue is empty.
//
// --backfill and --drain write. They refuse to run without --owner-approved:
// the INGESTION HOLD (TEAM.md rule 8) stands until the Owner approves.
// ============================================================
import fs from 'node:fs';
import pg from 'pg';
import { devDbUrl, readEnv, SSL } from './dev-env.mjs';
import { PIPELINE_VERSION, DEFAULT_CONFIG } from '../supabase/functions/_shared/ai/config.ts';
import { SOURCE_TYPES } from '../supabase/functions/_shared/ai/extractors/index.ts';
import { extractors } from '../supabase/functions/_shared/ai/extractors/index.ts';
import { loaders } from '../supabase/functions/_shared/ai/ingest/loaders.ts';
import { pgRpc } from '../supabase/functions/_shared/ai/ingest/db.ts';
import { planDocument } from '../supabase/functions/_shared/ai/ingest/plan.ts';
import { crawlToRows } from '../supabase/functions/_shared/ai/ingest/ttsImport.ts';
import { nvidiaEmbedder, openAiEmbedder, runWorker } from '../supabase/functions/_shared/ai/ingest/worker.ts';

const PRICE_PER_M = 0.02;   // text-embedding-3-small, USD per 1M tokens (check on the day)
const args = process.argv.slice(2);
const has = (k) => args.includes(k);
const val = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const SOURCE = val('--source', null);
const LIMIT = val('--limit', null) === null ? null : Number(val('--limit'));
const MODE = has('--drain') ? 'drain' : has('--backfill') ? 'backfill' : 'dry-run';

if (SOURCE && !SOURCE_TYPES.includes(SOURCE)) { console.error(`unknown --source ${SOURCE}; one of ${SOURCE_TYPES.join(', ')}`); process.exit(1); }
if (MODE !== 'dry-run' && !has('--owner-approved')) {
  console.error([
    `Refusing to run --${MODE}: it writes to the ingest queue / vector store and ${MODE === 'drain' ? 'calls the OpenAI embeddings API' : 'queues embedding work'}.`,
    'The INGESTION HOLD (Assistant/TEAM.md rule 8, Owner 2026-09-28) is in force.',
    'Re-run with --owner-approved only after the Owner has explicitly approved ingestion.',
    'Without flags this script does a read-only --dry-run.',
  ].join('\n'));
  process.exit(2);
}

const url = devDbUrl();
const newClient = async () => {
  // query_timeout: a socket the pooler dropped mid-query rejects instead of hanging.
  const c = new pg.Client({ connectionString: url, ssl: SSL, connectionTimeoutMillis: 20_000, query_timeout: 300_000, statement_timeout: 290_000 });
  c.on('error', () => {});
  await c.connect();
  return c;
};
async function withRetry(label, fn) {
  for (let attempt = 1; ; attempt++) {
    try { return await fn(); } catch (e) {
      if (attempt >= 4 || !/ETIMEDOUT|ENOTFOUND|ECONNRESET|Connection terminated|timeout/i.test(String(e?.message ?? e) + (e?.code ?? ''))) throw e;
      console.error(`${label}: ${e.code || e.message}; retry ${attempt}…`);
      await new Promise((r) => setTimeout(r, 3000 * attempt));
    }
  }
}

// ---------------------------------------------------------------- dry run
async function dryRun() {
  const types = SOURCE ? [SOURCE] : SOURCE_TYPES;
  const jsonl = val('--tts-jsonl', null);
  const totals = {};
  const mismatches = {};
  let sqlPipeline = null;
  const backfill = {};
  const disabled = [];

  await withRetry('dry run', async () => {
    const c = await newClient();
    try {
      await c.query('begin read only');
      const rpc = pgRpc(c);
      sqlPipeline = await rpc('ai_pipeline_version');
      const enabled = (await rpc('ai_source_types')) ?? [];
      for (const type of types) {
        if (!enabled.includes(type)) { disabled.push(type); continue; }
        const t = (totals[type] = { rows: 0, indexable: 0, new: 0, changed: 0, unchanged: 0, touch: 0, softDelete: 0, hardDelete: 0,
          noop: 0, chunks: 0, embedChunks: 0, embedTokens: 0, reused: 0, capped: 0, errors: 0 });
        let sources = (await rpc('ai_ingest_source', { p_type: type, p_ids: null, p_payload: true })) ?? [];
        if (type === 'tts_article' && jsonl && !sources.length) {
          const lines = fs.readFileSync(jsonl, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
          const plan = await crawlToRows(lines);
          sources = plan.rows.map((row) => ({ source_id: row.knowledge_id, indexable: true, fp: '', payload: { row: { ...row, is_active: true } } }));
          t.fromJsonl = `${plan.records} records → ${plan.rows.length} articles (${plan.duplicateIds} repeated ids merged, ${plan.skippedEmpty.length} without text skipped)`;
        }
        if (LIMIT) sources = sources.slice(0, LIMIT);
        const existing = new Map(((await rpc('ai_ingest_existing', { p_type: type, p_ids: null })) ?? []).map((d) => [d.source_id, d]));
        const seen = new Set();
        let mism = 0;
        for (const src of sources) {
          seen.add(src.source_id);
          t.rows++;
          try {
            const { row, ctx } = loaders[type](src.payload);
            const tsIx = extractors[type].indexable(row, ctx) && !src.excluded;   // the exclusion list is SQL-only
            if (tsIx !== src.indexable) mism++;
            if (tsIx) t.indexable++;
            const p = await planDocument(type, src, existing.get(src.source_id) ?? null, { pipelineVersion: PIPELINE_VERSION, model: DEFAULT_CONFIG.EMBED_MODEL });
            if (p.action === 'write') {
              t[p.isNew ? 'new' : 'changed']++;
              t.chunks += p.stats.chunks;
              t.embedChunks += p.toEmbed.length;
              t.embedTokens += p.toEmbed.reduce((a, ch) => a + ch.token_count, 0);
              t.reused += p.stats.reusedMoved + p.stats.reusedSameIndex;
              if (p.stats.capped) t.capped++;
            } else if (p.action === 'skip') t.unchanged++;
            else if (p.action === 'touch') t.touch++;
            else if (p.action === 'delete') t[p.soft ? 'softDelete' : 'hardDelete']++;
            else t.noop++;
          } catch (e) {
            t.errors++;
            if (t.errors <= 3) console.error(`  ${type}/${src.source_id}: ${e.message}`);
          }
        }
        if (!LIMIT) for (const id of existing.keys()) if (!seen.has(id)) t.hardDelete++;
        mismatches[type] = mism;
        if (!(type === 'tts_article' && jsonl)) {
          const { rows } = await c.query('select op, why, count(*)::int n from public.ai_backfill_candidates($1) group by 1, 2 order by 1, 2', [type]);
          backfill[type] = Object.fromEntries(rows.map((r) => [`${r.op}:${r.why}`, r.n]));
        }
      }
      await c.query('rollback');
    } finally {
      await c.end().catch(() => {});
    }
  });

  console.log(`\nDRY RUN (read-only, no API calls) · code pipeline ${PIPELINE_VERSION}, database ai_pipeline_version() ${sqlPipeline}${sqlPipeline === PIPELINE_VERSION ? '' : '  ← MISMATCH: the worker would refuse to run'}`);
  if (disabled.length) console.log(`Switched off in ai_assistant_config.ingest_sources (not planned): ${disabled.join(', ')}`);
  if (LIMIT) console.log(`(--limit ${LIMIT}: first ${LIMIT} rows per source only; orphan detection skipped)`);
  console.table(Object.fromEntries(Object.entries(totals).map(([k, t]) => [k, {
    rows: t.rows, indexable: t.indexable, new: t.new, changed: t.changed, unchanged: t.unchanged, touch: t.touch,
    'soft del': t.softDelete, 'hard del': t.hardDelete, chunks: t.chunks, 'to embed': t.embedChunks, reused: t.reused,
    tokens: t.embedTokens, 'cost $': +(t.embedTokens / 1e6 * PRICE_PER_M).toFixed(4), errors: t.errors,
  }])));
  for (const [k, t] of Object.entries(totals)) if (t.fromJsonl) console.log(`${k}: planned from ${val('--tts-jsonl')}: ${t.fromJsonl}`);
  const sum = Object.values(totals).reduce((a, t) => ({ docs: a.docs + t.new + t.changed, chunks: a.chunks + t.embedChunks, tokens: a.tokens + t.embedTokens }), { docs: 0, chunks: 0, tokens: 0 });
  console.log(`TOTAL a drain would write ${sum.docs} documents and embed ${sum.chunks} chunks, ${sum.tokens.toLocaleString('en-US')} tokens ≈ $${(sum.tokens / 1e6 * PRICE_PER_M).toFixed(4)} at $${PRICE_PER_M}/1M.`);
  console.log('SQL vs TypeScript indexable() disagreements (must be 0):', mismatches);
  console.log('ai_backfill would enqueue (op:why → rows):', backfill);
  const bad = Object.values(mismatches).some((n) => n) || Object.values(totals).some((t) => t.errors);
  if (bad) process.exitCode = 1;
}

// ---------------------------------------------------------------- writes (owner-approved only)
async function backfillRun() {
  const c = await newClient();
  try {
    const out = await pgRpc(c)('ai_backfill', { p_source_type: SOURCE });
    console.log('ai_backfill enqueued (type → why → rows):', JSON.stringify(out, null, 1));
  } finally { await c.end(); }
}

async function drain() {
  const env = readEnv();
  const key = env.OPEN_AI_API_KEY;
  if (!key) { console.error('OPEN_AI_API_KEY missing in ../.env.dev'); process.exit(1); }
  // mig 406: the fallback OpenAI key, and NVIDIA (.env.dev OPEN_AI_NVA / NEM_API) for embedding_alt.
  const nvidia = [env.OPEN_AI_NVA, env.NEM_API].filter(Boolean);
  const c = await newClient();
  try {
    const rpc = pgRpc(c);
    let total = 0;
    for (;;) {
      const s = await runWorker({ rpc, embed: openAiEmbedder([key, env.OPEN_AI_API_KEY_FALLBACK]),
        ...(nvidia.length ? { embedAlt: nvidiaEmbedder(nvidia) } : {}),
        maxItems: LIMIT === null ? undefined : LIMIT - total, log: (m) => console.log(m) });
      total += s.claimed;
      console.log(JSON.stringify({ claimed: s.claimed, succeeded: s.succeeded, failed: s.failed, skipped: s.skipped_unchanged,
        written: s.written, embedded: s.embedded_chunks, tokens: s.embed_tokens, requests: s.embed_requests,
        vector_pending: s.vector_pending, alt_embedded: s.alt_embedded, backfilled_primary: s.backfilled_primary,
        backfilled_alt: s.backfilled_alt, errors: s.errors }));
      if (!s.claimed || (LIMIT !== null && total >= LIMIT)) break;
    }
  } finally { await c.end(); }
}

if (MODE === 'dry-run') await dryRun();
else if (MODE === 'backfill') await backfillRun();
else await drain();
