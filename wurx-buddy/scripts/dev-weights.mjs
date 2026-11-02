// DEV ONLY. Fuses the real ai_search dense arm and keyword arm client-side at several RRF weights and prints recall@5/10 and MRR
// (benchmark of 2026-11-03: dense alone 0.908, 3:1 0.700, 20:1 0.900). Needs the seeded + embedded dev corpus. node --experimental-strip-types scripts/dev-weights.mjs <bench dir>
import fs from 'node:fs';
import crypto from 'node:crypto';
import pg from 'pg';
import { devDbUrl, readEnv, SSL } from './dev-env.mjs';
import { embedOptions, embedWithKeys, MODEL_LABEL } from '../../supabase/functions/_shared/ai/embedder.ts';
const B = process.argv[2];
const env = readEnv();
const c = new pg.Client({ connectionString: devDbUrl(), ssl: SSL }); await c.connect();
const q = async (s, p) => (await c.query(s, p)).rows;
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const queries = JSON.parse(fs.readFileSync(`${B}/queries.json`)).filter((x) => x.gold_chunk);
const corpus = new Map(JSON.parse(fs.readFileSync(`${B}/corpus.json`)).map((x) => [x.id, x]));
const [{ id: boss }] = await q(`select id from profiles where role='boss' and is_active limit 1`);
const qv = (await embedWithKeys(queries.map((x) => x.q), [env.NEM_API, env.OPEN_AI_NVA].filter(Boolean), embedOptions('nvidia', 'query'))).vectors;
const lit = (v) => `[${v.join(',')}]`;
const lists = [];
for (const [i, x] of queries.entries()) {
  const [gold] = await q(`select id from ai_chunks where content_hash = $1 limit 1`, [sha(`${corpus.get(x.gold_chunk).et}|text-embedding-3-small`)]);
  if (!gold) continue;
  const run = async (vec, text) => {
    await c.query('begin'); await c.query(`select set_config('request.jwt.claims','{"role":"service_role"}',true)`);
    const r = await q(`select chunk_id from ai_search($1::extensions.vector,$2,null,null,null,null,60,$3,null,null,$4,null)`, [vec, text, boss, vec ? MODEL_LABEL.nvidia : null]);
    await c.query('rollback'); return r.map((h) => h.chunk_id);
  };
  lists.push({ gold: gold.id, dense: await run(lit(qv[i]), null), kw: await run(null, x.q) });
}
const rrf = (L, wd, wk) => { const m = new Map(); L.dense.forEach((id, r) => m.set(id, (m.get(id) || 0) + wd / (60 + r + 1))); L.kw.forEach((id, r) => m.set(id, (m.get(id) || 0) + wk / (60 + r + 1))); return [...m.entries()].sort((a, b) => b[1] - a[1]).map((x) => x[0]); };
for (const [wd, wk] of [[1, 0], [0, 1], [1, 1], [3, 1], [5, 1], [10, 1], [20, 1]]) {
  let r5 = 0, r10 = 0, mrr = 0;
  for (const L of lists) { const pos = rrf(L, wd, wk).indexOf(L.gold); if (pos >= 0 && pos < 5) r5++; if (pos >= 0 && pos < 10) r10++; if (pos >= 0) mrr += 1 / (pos + 1); }
  console.log(`dense:kw ${wd}:${wk}  n=${lists.length}  recall@5 ${(r5 / lists.length).toFixed(3)}  @10 ${(r10 / lists.length).toFixed(3)}  MRR ${(mrr / lists.length).toFixed(3)}`);
}
await c.end();
