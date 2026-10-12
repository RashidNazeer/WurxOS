// ============================================================
// QA: how long does the reports rerank take, and how often would a given
// timeout cut it off? (QA m5, 2026-10-01). DEV ONLY, read-only; costs one
// rerank call per question (~6k input tokens each on gpt-5.4-mini).
//
//   node --experimental-strip-types tests/eval/rerank-timing.mjs [--n 30] [--embed-cache <file>]
//
// For the eval's report questions, as the Boss (service role + p_as_user), it
// runs the real reports search with a wrapped reranker that has NO practical
// timeout (120 s), and records each call's duration and outcome. Then it prints
// how many calls each candidate timeout (10/15/20/25/30 s) would have killed.
// ============================================================
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { ASSISTANT, readEnv } from '../../scripts/dev-env.mjs';
import { supabaseRpc } from '../../../supabase/functions/_shared/ai/ingest/db.ts';
import { retrievalConfig } from '../../../supabase/functions/_shared/ai/retrieval/config.ts';
import { searchIndex } from '../../../supabase/functions/_shared/ai/retrieval/search.ts';
import { openAiQueryEmbedder, openAiReranker } from '../../../supabase/functions/_shared/ai/retrieval/rerank.ts';

const argv = process.argv.slice(2);
const opt = (f, d) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : d; };
const N = Number(opt('--n', '30'));
const env = readEnv();
if (env.WURXOS_DEV_PROJECT_REF !== 'vyvkwbvreeycmmnikqbz') throw new Error('not dev');
const { createClient } = createRequire(path.join(ASSISTANT, 'package.json'))('@supabase/supabase-js');
const admin = createClient(env.VITE_SUPABASE_URL, env.WURXOS_DEV_SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const boss = (await admin.from('profiles').select('id').eq('role', 'boss').eq('is_active', true).limit(1).single()).data.id;
const { data: cfgRow } = await admin.from('ai_assistant_config').select('retrieval').eq('id', 1).maybeSingle();
const cfg = retrievalConfig(cfgRow?.retrieval).config;

const rows = fs.readFileSync(path.join(ASSISTANT, 'tests/eval/questions.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
  .filter((r) => r.expected_index === 'reports' || ['report_narrative', 'aggregation', 'comparison'].includes(r.category)).slice(0, N);

const base = openAiReranker({ apiKey: env.OPEN_AI_API_KEY, model: cfg.RERANK_MODEL ?? 'gpt-5.4-mini', timeoutMs: 120_000 });
const calls = [];
const rerank = async (q, items) => {
  const t = Date.now();
  try { const s = await base(q, items); calls.push({ ms: Date.now() - t, ok: true, n: items.length, chars: items.reduce((a, i) => a + i.text.length, 0) }); return s; }
  catch (e) { calls.push({ ms: Date.now() - t, ok: false, n: items.length, err: String(e?.message ?? e).slice(0, 80) }); throw e; }
};
const embed = openAiQueryEmbedder(env.OPEN_AI_API_KEY);
const deps = { rpc: supabaseRpc(admin), embed, asUser: boss, config: cfg, now: new Date(), rerank };
for (const r of rows) {
  try { await searchIndex('reports', r.question, {}, deps); } catch (e) { console.log(`search error ${r.id}: ${String(e.message).slice(0, 80)}`); }
}
const ms = calls.filter((c) => c.ok).map((c) => c.ms).sort((a, b) => a - b);
const pct = (p) => ms.length ? ms[Math.min(ms.length - 1, Math.floor(p * ms.length))] : null;
console.log(`rerank calls: ${calls.length} (${calls.filter((c) => !c.ok).length} failed outright: ${[...new Set(calls.filter((c) => !c.ok).map((c) => c.err))].join(' | ')})`);
console.log(`duration ms: p50 ${pct(0.5)} · p90 ${pct(0.9)} · p95 ${pct(0.95)} · max ${ms[ms.length - 1]} · candidates/call ${calls[0]?.n} · text chars/call p50 ${calls.map((c) => c.chars || 0).sort((a, b) => a - b)[Math.floor(calls.length / 2)]}`);
for (const t of [10_000, 15_000, 20_000, 25_000, 30_000]) console.log(`timeout ${t / 1000} s would cut off ${calls.filter((c) => c.ms > t).length} of ${calls.length}`);
