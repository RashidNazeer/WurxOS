// ============================================================
// ai_search latency bench (mig 382). DEV ONLY. Read-only against the real
// tables; `setup` builds a SCRATCH copy (schema scratch382: a copy of
// ai_chunks with source_type, the per-corpus indexes, and 382's ai_search
// pointed at it), so 382 can be measured before it is applied. `teardown`
// drops the schema.
//
//   node --experimental-strip-types scripts/bench-search.mjs setup [--full]
//   node --experimental-strip-types scripts/bench-search.mjs bench --fn public.ai_search --embed-cache <file> [--n 20]
//   node --experimental-strip-types scripts/bench-search.mjs explain --fn scratch382.ai_search --embed-cache <file>
//   node --experimental-strip-types scripts/bench-search.mjs teardown
//
// Queries: the first --n texts of an eval-retrieval embedding cache (no API
// calls). Each corpus (company, reports, tiktok, incentives, all) is run as the
// Boss, match count 30 as the index tools use: pass 1 is the first touch after
// the other corpora ran ("cold" as far as a shared instance allows), pass 2
// repeats the same queries at once ("warm").
// ============================================================
import fs from 'node:fs';
import path from 'node:path';
import pg from 'pg';
import { ASSISTANT, devDbUrl, SSL, stripBom } from './dev-env.mjs';

const [cmd, ...argv] = process.argv.slice(2);
const opt = (f, d) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : d; };
const flag = (f) => argv.includes(f);
const CORPORA = {
  company: ['kb_article', 'ai_doc', 'app_guide'],
  reports: ['report'],
  tiktok: ['tts_article'],
  incentives: ['incentive'],
  all: null,
};

// The pooler's DNS is flaky from here: retry the connect only.
let c;
for (let attempt = 1; ; attempt++) {
  c = new pg.Client({ connectionString: devDbUrl(), ssl: SSL, connectionTimeoutMillis: 30_000, statement_timeout: 600_000 });
  c.on('error', () => {});
  try { await c.connect(); break; } catch (e) { if (attempt >= 5) throw e; await new Promise((r) => setTimeout(r, 3000 * attempt)); }
}
const q = async (sql, params) => (await c.query(sql, params)).rows;
const one = async (sql, params) => (await q(sql, params))[0];

// 382 as written (halfvec indexes), or with --full: the same design on full
// vectors, for the comparison.
function migration382({ full }) {
  const sql = stripBom(fs.readFileSync(path.join(ASSISTANT, 'supabase/migrations/382_ai_corpus_indexes.sql'), 'utf8'));
  let idx = [...sql.matchAll(/create index if not exists (\w+) on public\.ai_chunks([\s\S]*?);/g)]
    .map(([, name, body]) => `create index ${name} on scratch382.ai_chunks${body};`);
  let fn = sql.slice(sql.indexOf('create or replace function public.ai_search('));
  fn = fn.replaceAll('public.ai_chunks', 'scratch382.ai_chunks').replaceAll('public.ai_search(', 'scratch382.ai_search(');
  if (full) {
    fn = fn.replaceAll('(c.embedding::extensions.halfvec(1536)) <=> v_qh', 'c.embedding <=> p_query_embedding');
    idx = idx.map((s) => s.replace('((embedding::extensions.halfvec(1536)) extensions.halfvec_cosine_ops)', '(embedding extensions.vector_cosine_ops)'));
  }
  return { idx, fn };
}

const boss = (await one(`select id from profiles where role = 'boss' and is_active and deleted_at is null limit 1`)).id;
const pct = (xs, p) => { const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]; };

try {
  if (cmd === 'setup') {
    const full = flag('--full');
    const t0 = Date.now();
    await q(`drop schema if exists scratch382 cascade`);
    await q(`create schema scratch382`);
    // 128 MB with a parallel build failed on dev ("could not resize shared memory segment").
    await q(`set maintenance_work_mem = '64MB'`);
    await q(`set max_parallel_maintenance_workers = 0`);
    await q(`create table scratch382.ai_chunks as
      select c.id, c.document_id, c.chunk_index, c.section, c.content, c.embed_text, c.token_count, c.content_hash,
             c.embedding, c.embedding_model, c.fts, c.created_at, c.updated_at, d.source_type
        from public.ai_chunks c join public.ai_documents d on d.id = c.document_id`);
    await q(`alter table scratch382.ai_chunks add primary key (id)`);
    await q(`create index on scratch382.ai_chunks (document_id)`);
    await q(`create index on scratch382.ai_chunks using gin (fts)`);
    console.log(`copy: ${((Date.now() - t0) / 1000).toFixed(1)} s`);
    const { idx, fn } = migration382({ full });
    for (const s of idx) {
      const t = Date.now();
      await q(s);
      console.log(`${s.match(/index (\w+)/)[1]}: ${((Date.now() - t) / 1000).toFixed(1)} s`);
    }
    await q(fn);
    await q(`analyze scratch382.ai_chunks`);
    console.table(await q(`select c.relname, pg_size_pretty(pg_relation_size(c.oid)) size from pg_class c
        join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'scratch382' order by pg_relation_size(c.oid) desc`));
    console.log(`scratch382 ready (${full ? 'full vector' : 'halfvec'} indexes), ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  } else if (cmd === 'setup-fn') {
    // After an edit of 382's ai_search: redefine only the scratch function.
    let { fn } = migration382({ full: flag('--full') });
    if (opt('--ef')) fn = fn.replace(`'hnsw.ef_search', '100'`, `'hnsw.ef_search', '${Number(opt('--ef'))}'`);
    await q(fn);
    console.log(`scratch382.ai_search redefined (${flag('--full') ? 'full vector' : 'halfvec'})`);
  } else if (cmd === 'teardown') {
    await q(`drop schema if exists scratch382 cascade`);
    console.log('scratch382 dropped');
  } else if (cmd === 'bench' || cmd === 'explain') {
    const fnName = opt('--fn', 'public.ai_search');
    if (!fnName.split(',').every((f) => /^(public|scratch382)\.ai_search$/.test(f))) throw new Error('bad --fn');
    const cache = JSON.parse(fs.readFileSync(opt('--embed-cache'), 'utf8'));
    const texts = Object.keys(cache).slice(0, Number(opt('--n', 20)));
    await q(`select set_config('request.jwt.claims', '{"role":"service_role"}', false)`);
    const call = `select count(*)::int n from ${fnName}($1::extensions.vector, $2, $3::text[], null, null, null, 30, $4)`;
    if (cmd === 'explain') {
      for (const [name, types] of Object.entries(CORPORA)) {
        const t = texts[0];
        const plan = (await q(`explain (analyze, buffers, format json) ${call}`, [`[${cache[t].join(',')}]`, t, types, boss]))[0]['QUERY PLAN'][0];
        const p = plan.Plan;
        console.log(`${name.padEnd(10)} ${plan['Execution Time'].toFixed(0).padStart(6)} ms  shared hit ${p['Shared Hit Blocks']}  read ${p['Shared Read Blocks']}`);
      }
    } else {
      // Server-side time (EXPLAIN ANALYZE of the call: only the top node is
      // instrumented, so the overhead is small); the round trip from here to
      // the dev region (~200 ms) is left out, as the edge function sits next to it.
      const fns = fnName.split(',');
      const out = {};
      for (const [name, types] of Object.entries(CORPORA)) {
        for (const pass of [1, 2]) {
          for (const fn of fns) {
            for (const t of texts) {
              const plan = (await q(`explain (analyze, buffers, format json) ${call.replace(fnName, fn)}`, [`[${cache[t].join(',')}]`, t, types, boss]))[0]['QUERY PLAN'][0];
              const o = ((out[fn] ??= {})[name] ??= { 1: [], 2: [], reads: 0 });
              o[pass].push(plan['Execution Time']);
              o.reads += plan.Plan['Shared Read Blocks'];
            }
          }
        }
      }
      for (const fn of fns) {
        const rows = Object.fromEntries(Object.entries(out[fn]).map(([k, v]) => [k, {
          'cold p50': Math.round(pct(v[1], 50)), 'cold p95': Math.round(pct(v[1], 95)), 'cold max': Math.round(Math.max(...v[1])),
          'warm p50': Math.round(pct(v[2], 50)), 'warm p95': Math.round(pct(v[2], 95)), 'blocks read': v.reads,
        }]));
        console.log(`${fn}: ${texts.length} queries per corpus, server ms`);
        console.table(rows);
      }
      if (opt('--out')) fs.writeFileSync(opt('--out'), JSON.stringify({ fns, raw: out }, null, 1));
    }
  } else {
    console.log('usage: bench-search.mjs setup [--full] | bench --fn <fn> --embed-cache <file> [--n 20] [--out f] | explain --fn <fn> --embed-cache <file> | teardown');
  }
} finally {
  await c.end();
}
