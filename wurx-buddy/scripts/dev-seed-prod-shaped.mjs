// DEV ONLY. Loads a production-SHAPED corpus into the dev database so migration 432 and the worker can be
// rehearsed on realistic rows, and puts it in the state production was in before 432:
//   - OpenAI-labelled (text-embedding-3-small) vectors on ~60 % of chunks (random: they are never searched),
//   - real NVIDIA vectors in embedding_alt on ~70 % of the non-incentive chunks (from --vectors),
//   - the rest with no vector at all.
// Plus fake 'report' and 'incentive' documents (invented text, no client data) for the privacy rules.
//
//   node scripts/dev-seed-prod-shaped.mjs --corpus corpus.json --vectors run.nvidia.d.bin [--wipe]
//
// corpus.json: [{id, doc, st, title, section, et, tc}] (chunk text from the public/company document types),
// run.nvidia.d.bin: Float32 1536 × corpus.length, NVIDIA 'passage' vectors in corpus order.
import fs from 'node:fs';
import crypto from 'node:crypto';
import pg from 'pg';
import { devDbUrl, SSL } from './dev-env.mjs';

const arg = (k) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : null; };
const corpus = JSON.parse(fs.readFileSync(arg('corpus'), 'utf8'));
const bin = fs.readFileSync(arg('vectors'));
const vecs = new Float32Array(bin.buffer, bin.byteOffset, corpus.length * 1536);
const lit = (a) => `[${Array.from(a, (x) => Number(x).toFixed(6)).join(',')}]`;
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const rnd = (seed) => { let x = seed >>> 0; return () => ((x = (x * 1664525 + 1013904223) >>> 0) / 2 ** 32); };
const fakeOpenAi = (i) => { const r = rnd(i + 1); return lit(Array.from({ length: 1536 }, () => r() - 0.5)); };
const OLD = 'text-embedding-3-small', NV = 'nvidia:llama-nemotron-embed-vl-1b-v2';

const c = new pg.Client({ connectionString: devDbUrl(), ssl: SSL });
await c.connect();
const [shard, shards] = (arg('shard') ?? '0/1').split('/').map(Number);   // run several in parallel: --shard 0/6 … 5/6
if (process.argv.includes('--wipe') && shard === 0) await c.query('delete from public.ai_documents');

const docs = new Map();
corpus.forEach((x, i) => { if (!docs.has(x.doc)) docs.set(x.doc, { st: x.st, title: x.title, chunks: [] }); docs.get(x.doc).chunks.push({ x, i }); });
// invented documents for the types we must not copy from production
for (let d = 0; d < 40; d++) docs.set(`fake-report-${d}`, { st: 'report', title: `Weekly report — Brand ${d}`, fake: true,
  chunks: Array.from({ length: 4 }, (_, k) => ({ x: { st: 'report', section: 'summary', tc: 60, et: `[Weekly report · Brand ${d} · Week ${k + 1}] GMV was ${1000 + d * 37 + k} USD, videos posted ${5 + k}, top creator handle @creator${d}.` }, i: -1 })) });
for (let d = 0; d < 12; d++) docs.set(`fake-incentive-${d}`, { st: 'incentive', title: `Incentive plan ${d}`, fake: true,
  chunks: Array.from({ length: 2 }, (_, k) => ({ x: { st: 'incentive', section: 'plan', tc: 40, et: `[Incentive plan ${d}] Basic salary PKR ${50000 + d * 1000}, bonus tier ${k + 1}.` }, i: -1 })) });

let n = 0, docN = 0, k = -1;
for (const [key, d] of docs) {
  if (++k % shards !== shard) { n += d.chunks.length; continue; }
  const sourceId = d.fake ? crypto.createHash('md5').update(key).digest('hex').replace(/^(.{8})(.{4})(.{4})(.{4})(.{12}).*$/, '$1-$2-$3-$4-$5') : key;
  const { rows: [doc] } = await c.query(
    `insert into public.ai_documents (source_type, source_id, title, acl_mode, doc_hash, chunk_count, status, pipeline_version, embed_model, indexed_at)
     values ($1, $2, $3, $4, $5, $6, 'active', '2026-09-28.1', $7, now())
     on conflict (source_type, source_id) do update set title = excluded.title, status = 'active', embed_model = excluded.embed_model, chunk_count = excluded.chunk_count
     returning id`, [d.st, sourceId, d.title, d.fake ? 'boss' : 'all', sha(key), d.chunks.length, OLD]);
  docN++;
  for (const [ci, { x, i }] of d.chunks.entries()) {
    n++;
    const hasOld = n % 5 < 3;
    const hasNv = d.st !== 'incentive' && i >= 0 && n % 10 < 7;
    await c.query(
      `insert into public.ai_chunks (document_id, chunk_index, section, content, embed_text, token_count, content_hash, source_type,
                                     embedding, embedding_model, embedding_alt, embed_model_alt)
       values ($1, $2, $3, $4, $4, $5, $6, $7, $8::extensions.vector, $9, $10::extensions.vector, $11)
       on conflict (document_id, chunk_index) do nothing`,
      [doc.id, ci, x.section ?? null, x.et, x.tc ?? 100, sha(`${x.et}|${OLD}`), d.st,
       hasOld ? fakeOpenAi(n) : null, OLD, hasNv ? lit(vecs.subarray(i * 1536, (i + 1) * 1536)) : null, hasNv ? NV : null]);
  }
}
console.log(`seeded ${docN} documents, ${n} chunks`);
await c.end();
