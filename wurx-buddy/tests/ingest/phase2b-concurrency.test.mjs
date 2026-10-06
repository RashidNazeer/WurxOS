// ============================================================
// QA Phase 2B T8: concurrent workers (mode C, qa/2026-09-28-phase2b-test-plan.md).
//
//   node --experimental-strip-types tests/ingest/phase2b-concurrency.test.mjs
//
// The ONLY committed writes: 60 ai_ingest_queue rows with source_type
// 'qa_test' (Lead-approved: queue rows that are cleaned up), deleted in
// `finally`. Each worker runs on its own connection inside its own
// transaction that is rolled back, so every ai_documents / ai_chunks write
// disappears. Refuses to start unless the queue is idle and no ai% cron job
// exists (nothing else may claim the rows).
// ============================================================
import crypto from 'node:crypto';
import pg from 'pg';
import { devDbUrl, SSL } from '../../scripts/dev-env.mjs';
import { DEFAULT_CONFIG } from '../../../supabase/functions/_shared/ai/config.ts';
import { pgRpc } from '../../../supabase/functions/_shared/ai/ingest/db.ts';
import { runWorker } from '../../../supabase/functions/_shared/ai/ingest/worker.ts';

const N = 60;
const results = [];
const check = (name, ok, detail = '') => results.push({ ok: !!ok, name, detail: String(detail ?? '').slice(0, 200) });
const J = (x) => JSON.stringify(x);
const url = devDbUrl();
const connect = async () => { const c = new pg.Client({ connectionString: url, ssl: SSL, connectionTimeoutMillis: 20_000, query_timeout: 120_000 }); c.on('error', () => {}); await c.connect(); return c; };
const vec = (t) => { const h = crypto.createHash('sha256').update(t).digest(); return Array.from({ length: DEFAULT_CONFIG.EMBED_DIMS }, (_, i) => ((h[i % 32] + i) % 89) / 89 - 0.5); };
const text = (id) => `QA Zq concurrency item ${id} zqconc.`;
const qaSource = {
  extractor: {
    sourceType: 'qa_test', indexable: () => true,
    toDocument: (row) => ({ title: `QA ${row.id}`, acl: { mode: 'all' }, metadata: {}, header: `[QA Zq ${row.id}]`, sections: [{ key: 'b', title: 'B', kind: 'prose', text: text(row.id) }] }),
  },
  fetch: async (ids) => ids.map((id) => ({ source_id: id, indexable: true, fp: id, payload: { row: { id }, ctx: undefined } })),
};

const admin = await connect();
const one = async (sql, p) => (await admin.query(sql, p)).rows[0];
let inserted = false;
try {
  const pre = await one(`select (select count(*)::int from ai_ingest_queue where status in ('pending','processing')) busy,
      (select count(*)::int from ai_documents) docs, (select count(*)::int from cron.job where jobname ilike 'ai%') cron`);
  if (pre.busy || pre.docs || pre.cron) throw new Error(`refusing: ${J(pre)}`);
  check('pre: queue idle, store empty, no ai% cron job', true, J(pre));

  await admin.query(`insert into ai_ingest_queue (source_type, source_id, op, priority, reason, not_before)
      select 'qa_test', 'qa-conc-' || lpad(g::text, 2, '0'), 'upsert', 5, 'qa-concurrency', now() - interval '1 second' from generate_series(1, $1) g`, [N]);
  inserted = true;

  for (const W of [2, 4]) {
    const conns = [];
    for (let i = 0; i < W; i++) conns.push(await connect());
    const claimed = conns.map(() => []);
    const inputs = conns.map(() => 0);
    const errors = [];
    try {
      await Promise.all(conns.map((c) => c.query(`begin`).then(() => c.query(`set local lock_timeout = '10s'`))));
      const stats = await Promise.all(conns.map(async (c, i) => {
        const base = pgRpc(c, { savepoints: true });
        // Mig 377: qa_test is not in ai_assistant_config.ingest_sources, and the
        // config row cannot be updated in 4 concurrent transactions (row lock).
        // So the worker is told qa_test is enabled, and each write is stored as
        // an enabled type (tts_article, synthetic qa-conc-* ids, rolled back).
        const rpc = async (fn, args) => {
          if (fn === 'ai_ingest_write' && args.p_doc?.source_type === 'qa_test') args = { ...args, p_doc: { ...args.p_doc, source_type: 'tts_article' } };
          const r = await base(fn, args);
          if (fn === 'ai_ingest_claim') claimed[i].push(...r.map((x) => x.source_id));
          if (fn === 'ai_source_types') return [...(r ?? []), 'qa_test'];
          return r;
        };
        const embed = async (t) => { inputs[i] += t.length; return { vectors: t.map(vec), tokens: 1, requests: 1 }; };
        try { return await runWorker({ rpc, embed, workerId: `qa-conc-w${i}`, sources: { qa_test: qaSource }, claimBatch: 20 }); }
        catch (e) { errors.push(e.message); return null; }
      }));
      const ids = claimed.flat();
      const docs = await Promise.all(conns.map(async (c, i) => (await c.query(`select count(*)::int n from ai_documents where source_type = 'tts_article' and source_id = any($1)`, [claimed[i]])).rows[0].n));
      check(`${W} workers: claimed sets are disjoint and cover all ${N}`, ids.length === N && new Set(ids).size === N, `per worker ${J(claimed.map((x) => x.length))}`);
      check(`${W} workers: each embedded only its own items (total inputs = ${N}, once each)`, inputs.reduce((a, b) => a + b, 0) === N && inputs.every((n, i) => n === claimed[i].length), J(inputs));
      check(`${W} workers: each wrote exactly its claimed documents, 0 failed, no deadlock / lock timeout / unique violation`,
        !errors.length && stats.every((s) => s && !s.failed && s.written === s.claimed) && docs.every((n, i) => n === claimed[i].length), J({ errors, docs }));
      check(`${W} workers: more than one worker did work (real contention)`, claimed.filter((x) => x.length).length >= 2, J(claimed.map((x) => x.length)));
    } finally {
      await Promise.all(conns.map((c) => c.query('rollback').catch(() => {}).then(() => c.end().catch(() => {}))));
    }
    const back = await one(`select count(*) filter (where status = 'pending')::int p, count(*)::int n from ai_ingest_queue where source_type = 'qa_test'`);
    check(`${W} workers rolled back: the ${N} queue rows are pending again, 0 documents`, back.p === N && !(await one(`select count(*)::int n from ai_documents`)).n, J(back));
  }
} catch (e) {
  check(`aborted: ${e.message}`, false);
} finally {
  if (inserted) await admin.query(`delete from ai_ingest_queue where source_type = 'qa_test' and reason = 'qa-concurrency'`).catch((e) => check(`cleanup failed: ${e.message}`, false));
  const post = await one(`select (select count(*)::int from ai_ingest_queue) q, (select count(*)::int from ai_ingest_queue where source_type = 'qa_test') qa,
      (select count(*)::int from ai_documents) d, (select count(*)::int from ai_chunks) ch, (select count(*)::int from ai_ingest_runs where stats->>'worker' like 'qa-conc-%') runs`).catch(() => null);
  check('cleanup: 0 qa_test queue rows, 0 documents / chunks, no committed run rows', post && !post.qa && !post.d && !post.ch && !post.runs, J(post));
  await admin.end().catch(() => {});
  for (const r of results) console.log(`${r.ok ? 'ok  ' : 'FAIL'} ${r.name}${r.detail ? `  [${r.detail}]` : ''}`);
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} passed.`);
  process.exitCode = failed ? 1 : 0;
}
