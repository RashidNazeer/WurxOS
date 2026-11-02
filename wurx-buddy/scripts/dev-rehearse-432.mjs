// DEV ONLY. Rehearses migration 432 and the new worker on the production-shaped corpus seeded by
// dev-seed-prod-shaped.mjs, and prints a before/after.
//
//   node --experimental-strip-types scripts/dev-rehearse-432.mjs --queries queries.json --corpus corpus.json [--apply] [--worker]
//
//   (no flags)  BEFORE snapshot + retrieval test against the old state, nothing changed
//   --apply     applies 432 (if not yet recorded), then proves a second run changes no data (rolled back)
//   --worker    runs the real worker (NVIDIA + Gemini free keys from .env.dev) until the backfill is done
// queries.json: [{q, gold_chunk, gold_docs, kind}], corpus.json: the seeded corpus (to map gold chunks by text).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import pg from 'pg';
import { ASSISTANT, devDbUrl, readEnv, SSL, stripBom } from './dev-env.mjs';
import { pgRpc } from '../../supabase/functions/_shared/ai/ingest/db.ts';
import { runWorker } from '../../supabase/functions/_shared/ai/ingest/worker.ts';
import { embedOptions, embedWithKeys, MODEL_LABEL } from '../../supabase/functions/_shared/ai/embedder.ts';

const arg = (k) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : null; };
const has = (k) => process.argv.includes(`--${k}`);
const env = readEnv();
const c = new pg.Client({ connectionString: devDbUrl(), ssl: SSL });
await c.connect();
const q = async (sql, p) => (await c.query(sql, p)).rows;
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const vecLit = (v) => `[${v.join(',')}]`;

async function snapshot(label) {
  const rows = await q(`select source_type, count(*)::int chunks, count(embedding)::int main, count(embedding_alt)::int alt,
      count(*) filter (where embedding is null and embedding_alt is null)::int none,
      string_agg(distinct embedding_model, ',') main_model, string_agg(distinct embed_model_alt, ',') alt_model
    from ai_chunks group by 1 order by 1`);
  console.log(`\n== ${label} ==`);
  console.table(rows);
  const docs = await q(`select embed_model, count(*)::int n from ai_documents group by 1`);
  console.log('documents by embed_model:', JSON.stringify(docs));
  return rows;
}

async function stats() {
  await c.query('begin');
  await c.query(`select set_config('request.jwt.claims', '{"role":"service_role"}', true)`);
  const [{ s }] = await q(`select public.ai_ingest_stats() s`);
  await c.query('rollback');
  return s;
}
const showStats = (s) => console.log(JSON.stringify({ vector_pending: s.vector_pending, vectors: s.vectors }, null, 1));

// Retrieval: the gold chunk's rank for N paraphrased questions, through ai_search as the service role.
async function retrieval(label, useMain, useAlt) {
  const queries = JSON.parse(fs.readFileSync(arg('queries'), 'utf8')).filter((x) => x.gold_chunk).slice(0, 40);
  const corpus = new Map(JSON.parse(fs.readFileSync(arg('corpus'), 'utf8')).map((x) => [x.id, x]));
  const [{ id: boss }] = await q(`select id from profiles where role = 'boss' and is_active limit 1`);
  const keys = [env.NEM_API, env.OPEN_AI_NVA].filter(Boolean);
  const qv = (await embedWithKeys(queries.map((x) => x.q), keys, embedOptions('nvidia', 'query'))).vectors;
  const newSig = (await q(`select count(*)::int n from pg_proc where proname = 'ai_search' and pronargs = 12`))[0].n > 0;
  let hit5 = 0, hit10 = 0, n = 0, mrr = 0;
  for (const [i, x] of queries.entries()) {
    const text = corpus.get(x.gold_chunk)?.et;
    const [gold] = text ? await q(`select id from ai_chunks where content_hash = $1 limit 1`, [sha(`${text}|text-embedding-3-small`)]) : [];
    if (!gold) continue;
    n++;
    await c.query('begin');
    await c.query(`select set_config('request.jwt.claims', '{"role":"service_role"}', true)`);
    const hits = newSig
      ? await q(`select chunk_id from ai_search($1::extensions.vector, $2, null, null, null, null, 10, $3, null, $4::extensions.vector, $5, $6)`,
        [useMain ? vecLit(qv[i]) : null, x.q, boss, useAlt ? vecLit(qv[i]) : null, useMain ? MODEL_LABEL.nvidia : null, useAlt ? MODEL_LABEL.nvidia : null])
      : await q(`select chunk_id from ai_search($1::extensions.vector, $2, null, null, null, null, 10, $3, null, $4::extensions.vector)`,
        [useMain ? vecLit(qv[i]) : null, x.q, boss, useAlt ? vecLit(qv[i]) : null]);
    await c.query('rollback');
    const pos = hits.findIndex((h) => h.chunk_id === gold.id);
    if (pos >= 0 && pos < 5) hit5++;
    if (pos >= 0) { hit10++; mrr += 1 / (pos + 1); }
  }
  console.log(`${label}: ${n} questions, recall@5 ${(hit5 / n).toFixed(3)}, recall@10 ${(hit10 / n).toFixed(3)}, MRR ${(mrr / n).toFixed(3)}`);
}

// The model-label guard: a vector labelled with ANOTHER model is ignored by ai_search, never compared.
async function guard() {
  const [{ id: boss }] = await q(`select id from profiles where role = 'boss' and is_active limit 1`);
  const v = (await embedWithKeys(['how do I apply for leave'], [env.NEM_API ?? env.OPEN_AI_NVA], embedOptions('nvidia', 'query'))).vectors[0];
  const run = async (label) => {
    await c.query('begin');
    await c.query(`select set_config('request.jwt.claims', '{"role":"service_role"}', true)`);
    // text NULL → no keyword arm: only the vector can produce rows
    const rows = await q(`select count(*)::int n from ai_search($1::extensions.vector, null, null, null, null, null, 10, $2, null, null, $3, null)`, [vecLit(v), boss, label]);
    await c.query('rollback');
    return rows[0].n;
  };
  const right = await run(MODEL_LABEL.nvidia), wrong = await run('gemini:gemini-embedding-001'), legacy = await run(null);
  console.log(`label guard: matching label → ${right} rows; another model's label → ${wrong} rows (ignored); no label → ${legacy} rows`);
}

await snapshot('BEFORE (production-shaped)');
if (!has('apply') && !has('worker')) {
  await retrieval('before: question vector against the second space only (the only working one)', false, true);
}

if (has('apply')) {
  const file = fs.readdirSync(path.join(ASSISTANT, '..', 'supabase', 'migrations')).find((n) => n.startsWith('432_'));
  const sql = stripBom(fs.readFileSync(path.join(ASSISTANT, '..', 'supabase', 'migrations', file), 'utf8'));
  const done = await q(`select 1 from supabase_migrations.schema_migrations where version = '432'`);
  if (!done.length) {
    const t0 = Date.now();
    await c.query('begin');
    await c.query(sql);
    await c.query(`insert into supabase_migrations.schema_migrations (version, name, statements) values ('432', 'buddy_free_embeddings', $1)`, [[sql]]);
    await c.query('commit');
    console.log(`\napplied ${file} in ${Date.now() - t0} ms`);
  } else console.log('\n432 already applied');
  await snapshot('AFTER 432 (before any embedding)');
  showStats(await stats());
  // idempotency: a second run in a rolled-back transaction must change no data
  const sig = async () => (await q(`select md5(string_agg(id::text || coalesce(embedding_model,'') || (embedding is not null)::text || (embedding_alt is not null)::text || coalesce(embed_model_alt,''), ',' order by id)) h from ai_chunks`))[0].h;
  const before = await sig();
  await c.query('begin'); await c.query(sql); const after = await sig(); await c.query('rollback');
  console.log(`idempotent: second run leaves the data ${before === after ? 'IDENTICAL' : 'CHANGED (BUG)'}`);
  await guard();
}

if (has('worker')) {
  const keys = { nvidia: env.OPEN_AI_NVA, nvidia2: env.NEM_API, gemini: env.Gemini_Fallback };
  const rpc = pgRpc(c);
  const t0 = Date.now();
  for (let run = 1; run <= 20; run++) {
    const s = await runWorker({ rpc, keys, recordRun: false, checkPipeline: true, timeBudgetMs: 100_000, log: (m) => console.log('  ' + m) });
    console.log(`run ${run}: main +${s.backfilled_primary}, second +${s.backfilled_alt}, skipped ${s.skipped_rows}, down ${JSON.stringify(s.spaces_down)}, errors ${JSON.stringify(s.errors.map((e) => e.slice(0, 140)))}`);
    if (!s.backfilled_primary && !s.backfilled_alt) break;
  }
  console.log(`worker finished in ${Math.round((Date.now() - t0) / 1000)} s`);
  await snapshot('AFTER worker');
  showStats(await stats());
  await retrieval('after: NVIDIA question vector against the MAIN space (complete)', true, false);
  await guard();
}
await c.end();
