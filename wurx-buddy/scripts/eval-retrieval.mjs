// ============================================================
// Retrieval eval (phase5-design.md §6.1). DEV only, read-only, no LLM.
//
//   node --experimental-strip-types scripts/eval-retrieval.mjs
//        [--set KEY=VALUE …]      override retrieval config (config.ts keys; JSON values)
//        [--no-filters]           reports index without the emulated brand/period filters
//        [--examples]             also print the five before/after examples
//        [--out <file.json>]      write every row's results
//        [--embed-cache <file>]   reuse query embeddings between runs
//        [--rpc-cache <file>]     reuse identical RPC results between runs (tuning; delete after the store changes)
//        [--search-fn <fn>]       public.ai_search (default) or scratch382.ai_search (bench-search.mjs)
//
// For every questions.jsonl row with expected_sources it runs, as the Boss
// (service role + p_as_user, exactly like the Slack relay):
//   (a) the index the policy expects for each expected source,
//   (b) searchEverything (federated, fixed quotas),
//   (c) the baseline: raw pooled ai_search over every source, top 8.
// and reports recall@8 per index and category, plus the crowd-out rate.
//
// Expected ai_doc ids that were merged into a KB article count as that
// kb_article. Expected sources that are not in the store (e.g. an unapproved
// report) are listed and left out of the denominators.
//
// The agent normally resolves brand and period before calling search_reports.
// Here that step is emulated deterministically: brand names (or initials) found
// in the question / history / Slack context, and period phrases (detectPeriods).
// Cost: one small embedding per distinct query (cents per run at most).
// ============================================================
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import pg from 'pg';
import { ASSISTANT, devDbUrl, readEnv, SSL } from './dev-env.mjs';
import { retrievalConfig } from '../supabase/functions/_shared/ai/retrieval/config.ts';
import { indexForSourceType } from '../supabase/functions/_shared/ai/retrieval/indexes.ts';
import { detectPeriods } from '../supabase/functions/_shared/ai/retrieval/resolve.ts';
import { searchEverything, searchIndex } from '../supabase/functions/_shared/ai/retrieval/search.ts';
import { embedTexts } from '../supabase/functions/_shared/ai/embedder.ts';
import { openAiReranker } from '../supabase/functions/_shared/ai/retrieval/rerank.ts';

const argv = process.argv.slice(2);
const flag = (f) => argv.includes(f);
const opt = (f) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : undefined; };
const sets = {};
argv.forEach((a, i) => {
  if (a !== '--set') return;
  const [k, ...v] = argv[i + 1].split('=');
  const raw = v.join('=');
  try { sets[k] = JSON.parse(raw); } catch { sets[k] = raw; }
});
const { config: cfg, ignored } = retrievalConfig(sets);
if (ignored.length) { console.error(`bad --set keys: ${ignored.join(', ')}`); process.exit(1); }
for (const k of Object.keys(sets)) if (!(k in cfg)) { console.error(`unknown --set key ${k}`); process.exit(1); }

const env = readEnv();
if (!env.OPEN_AI_API_KEY) { console.error('OPEN_AI_API_KEY missing in ../.env.dev'); process.exit(1); }

pg.types.setTypeParser(1082, (v) => v);   // date → 'YYYY-MM-DD', as PostgREST returns it
const pool = new pg.Pool({ connectionString: devDbUrl(), ssl: SSL, max: 4, statement_timeout: 30_000 });
// Session-level (no transaction held open): service role, so p_as_user applies.
pool.on('connect', (c) => c.query(`select set_config('request.jwt.claims', '{"role":"service_role"}', false)`));

// The dev instance is small: a cold vector scan takes seconds. Identical RPC
// calls (same function, arguments and embedding) are therefore cached, in
// memory and optionally on disk (--rpc-cache), so a tuning run that changes
// only client-side parameters (boost, diversity, quotas, recency) re-reads no
// database at all. Delete the file after any change to the store.
const IDENT = /^[a-z_][a-z0-9_]*$/;
const rpcCacheFile = opt('--rpc-cache');
const rpcCache = rpcCacheFile && fs.existsSync(rpcCacheFile) ? JSON.parse(fs.readFileSync(rpcCacheFile, 'utf8')) : {};
let dbCalls = 0, dbMs = 0;
// The pooler / DNS is flaky from here: retry transport errors, never SQL errors.
async function query(sql, params) {
  for (let attempt = 1; ; attempt++) {
    try { return await pool.query(sql, params); } catch (e) {
      if (attempt >= 6 || e.severity) throw e;
      await new Promise((r) => setTimeout(r, 5000 * attempt));
    }
  }
}
// --search-fn scratch382.ai_search: run the eval against a candidate ai_search
// (scripts/bench-search.mjs builds it) without applying its migration.
const searchFn = opt('--search-fn') ?? 'public.ai_search';
if (!/^(public|scratch382)\.ai_search$/.test(searchFn)) { console.error('bad --search-fn'); process.exit(1); }
async function rpc(fn, args = {}) {
  if (!IDENT.test(fn)) throw new Error(`bad function ${fn}`);
  const keys = Object.keys(args).filter((k) => args[k] !== undefined).sort();
  for (const k of keys) if (!IDENT.test(k)) throw new Error(`bad arg ${k}`);
  const ck = crypto.createHash('sha1').update(JSON.stringify([fn, keys.map((k) => [k, args[k]])])).digest('hex');
  if (rpcCache[ck]) return structuredClone(rpcCache[ck]);
  const t = Date.now();
  const { rows } = await query(`select * from ${fn === 'ai_search' ? searchFn : `public.${fn}`}(${keys.map((k, i) => `${k} => $${i + 1}`).join(', ')})`, keys.map((k) => args[k]));
  dbCalls++; dbMs += Date.now() - t;
  rpcCache[ck] = rows;
  return structuredClone(rows);
}
const saveRpcCache = () => { if (rpcCacheFile) fs.writeFileSync(rpcCacheFile, JSON.stringify(rpcCache)); };

// ── query embeddings (disk cache optional) ──
const cacheFile = opt('--embed-cache');
const embCache = cacheFile && fs.existsSync(cacheFile) ? JSON.parse(fs.readFileSync(cacheFile, 'utf8')) : {};
let embedTokens = 0, embedCalls = 0;
async function embedAll(texts) {
  const todo = [...new Set(texts.map((t) => t.trim()))].filter((t) => !embCache[t]);
  if (todo.length) {
    const r = await embedTexts(todo, { apiKey: env.OPEN_AI_API_KEY });
    todo.forEach((t, i) => { embCache[t] = r.vectors[i]; });
    embedTokens += r.usage.totalTokens;
    embedCalls += r.requests;
    if (cacheFile) fs.writeFileSync(cacheFile, JSON.stringify(embCache));
  }
}
const embed = async (t) => embCache[t.trim()] ?? (await embedAll([t]), embCache[t.trim()]);

// ── data ──
const questions = fs.readFileSync(path.join(ASSISTANT, 'tests/eval/questions.jsonl'), 'utf8')
  .split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l));
const boss = (await query(`select id from profiles where role = 'boss' and is_active and deleted_at is null order by created_at limit 1`)).rows[0]?.id;
if (!boss) throw new Error('no active boss on dev');
const merged = new Map((await query(`select id::text, kb_article_id::text kb from ai_assistant_docs where kb_article_id is not null`)).rows.map((r) => [r.id, r.kb]));
const active = new Set((await query(`select source_type || ':' || source_id k from ai_documents where status = 'active'`)).rows.map((r) => r.k));
const brands = (await query(`select id::text, brand_name from brands`)).rows;

// The optional rerank (off by default) is an LLM call per index search: its
// token usage is counted and printed with the run.
// Scores are cached with the RPC results, so a rerun costs nothing.
const rerankUsage = { calls: 0, input_tokens: 0, output_tokens: 0 };
const reranker = cfg.RERANK_ENABLED ? openAiReranker({ apiKey: env.OPEN_AI_API_KEY, model: cfg.RERANK_MODEL,
  onUsage: (u) => { rerankUsage.calls++; rerankUsage.input_tokens += u.input_tokens; rerankUsage.output_tokens += u.output_tokens; } }) : null;
const deps = {
  rpc, embed, asUser: boss, config: cfg, now: new Date(),
  rerank: reranker ? async (q, items) => {
    const ck = 'rerank:' + crypto.createHash('sha1').update(JSON.stringify([cfg.RERANK_MODEL, q, items.map((i) => i.id)])).digest('hex');
    if (!rpcCache[ck]) rpcCache[ck] = await reranker(q, items);
    return rpcCache[ck];
  } : undefined,
};

// ── agent emulation: brand + period + report type from the text ──
const norm = (s) => ` ${String(s).toLowerCase().replace(/[‘’]/g, "'").replace(/'s\b/g, '').replace(/[^a-z0-9]+/g, ' ').trim()} `;
// A brand is named by its full name, its name without a plural s, its
// initials ("PDC"), or a first word no other brand shares ("Obagi").
const firstWords = new Map();
for (const b of brands) { const w = norm(b.brand_name).trim().split(' ')[0]; firstWords.set(w, (firstWords.get(w) ?? 0) + 1); }
function brandsIn(text) {
  const t = norm(text);
  return brands.filter((b) => {
    const n = norm(b.brand_name).trim();
    const words = n.split(' ');
    const initials = words.length >= 2 ? words.map((w) => w[0]).join('') : null;
    return t.includes(` ${n} `) || t.includes(` ${n.replace(/s$/, '')} `) || (initials && initials.length >= 3 && t.includes(` ${initials} `))
      || (words.length >= 2 && words[0].length >= 4 && firstWords.get(words[0]) === 1 && t.includes(` ${words[0]} `));
  }).map((b) => b.id);
}
function reportFilters(row) {
  const ctx = row.question.match(/^\[Context:[^\]]*\]/)?.[0] ?? '';
  const body = row.question.slice(ctx.length);
  const hist = (row.history ?? []).filter((h) => h.role === 'user').map((h) => h.content).join(' \n ');
  let brandIds = brandsIn(body);
  if (!brandIds.length) brandIds = brandsIn(hist);
  if (!brandIds.length) brandIds = brandsIn(ctx);
  const periods = detectPeriods(`${body}`, deps.now);
  const found = periods.length ? periods : detectPeriods(hist, deps.now);
  const f = {};
  if (brandIds.length) f.brandIds = brandIds;
  const ranges = [];
  const weeks = [];
  for (const p of found) {
    const r = p.resolution.kind === 'ambiguous' ? p.resolution.options[0] : p.resolution;
    if (r.kind === 'range') ranges.push(r.range);
    if (r.kind === 'week_number') weeks.push(r.week);
  }
  if (weeks.length) f.weekNumber = weeks;
  if (ranges.length) {
    f.periodFrom = ranges.map((r) => r.from).sort()[0];
    f.periodTo = ranges.map((r) => r.to).sort().at(-1);
  }
  // Only an explicit report type; "August" alone may be answered by weeklies too.
  const all = `${body} ${hist}`.toLowerCase();
  if (/\bmonthly\b/.test(all)) f.reportType = 'monthly';
  else if (/\bweekly\b/.test(all)) f.reportType = 'weekly';
  return f;
}
// The agent writes a standalone, corpus-specific query (§2.4). Emulated: the
// previous user turn is prepended for follow-ups, and a trailing format
// instruction after the question ("Give me our SOP and what TikTok's rules
// say.", "Send me the link.") is dropped.
const META = /^(?:give|send|show|tell|walk|i want)\b[^.?!]*[.?!]?$/i;
const standalone = (row) => {
  const body = row.question.replace(/^\[Context:[^\]]*\]\s*/, '');
  const sentences = body.match(/[^.?!]+[.?!]*/g)?.map((s) => s.trim()).filter(Boolean) ?? [body];
  const kept = sentences.filter((s, i) => i === 0 || !META.test(s)).join(' ');
  const prev = (row.history ?? []).filter((h) => h.role === 'user').at(-1)?.content;
  return prev ? `${prev} ${kept}` : kept;
};

// ── run ──
// Row fields (tests/eval/README.md): expected_index picks the index tool
// ('mixed' → one per expected source's corpus); retrieval_match 'any' | 'all'
// scores the row 1/0 on any / every expected source (default: the share
// found); optional_sources never count. rep-009's source is a gmv_max_reports
// id, which is not in the store.
const SKIP = new Set(['rep-009']);
const JUNK = new Set(['kb_article:833b9bda']);   // "testing doc": prefix match, reported if it ever surfaces
const isJunk = (k) => [...JUNK].some((j) => k.startsWith(j));
const rows = questions.filter((r) => r.expected_sources?.length && !SKIP.has(r.id));
const unreachable = [];
const results = [];
await embedAll(rows.map(standalone));

const keyOf = (s) => {
  const k = `${s.source_type}:${s.source_id}`;
  return s.source_type === 'ai_doc' && merged.has(s.source_id) ? `kb_article:${merged.get(s.source_id)}` : k;
};
let done = 0;
for (const row of rows) {
  const q = standalone(row);
  const exp = new Map();
  for (const s of row.expected_sources) {
    const key = keyOf(s);
    if (!active.has(key)) { unreachable.push(`${row.id} ${key}`); continue; }
    exp.set(key, indexForSourceType(key.split(':')[0]));
  }
  if (!exp.size) continue;
  const rf = flag('--no-filters') ? {} : reportFilters(row);
  const indexes = new Set(exp.values());
  if (['company', 'reports', 'tiktok'].includes(row.expected_index)) indexes.add(row.expected_index);
  const byIndex = {};
  for (const idx of indexes) {
    const r = await searchIndex(idx, q, idx === 'reports' ? rf : {}, deps);
    byIndex[idx] = {
      keys: r.results.map((x) => `${x.source_type}:${x.source_id}`),
      ranked: r.ranked.map((x) => `${x.source_type}:${x.source_id}`),
      candidates: r.candidates,
      notes: r.notes,
    };
  }
  const fed = await searchEverything(q, deps, rf);
  const fedKeys = fed.groups.flatMap((g) => g.results.map((x) => `${x.source_type}:${x.source_id}`));
  const vec = `[${(await embed(q)).join(',')}]`;
  const raw = await rpc('ai_search', { p_query_embedding: vec, p_query_text: q, p_match_count: 8, p_as_user: boss });
  const rawKeys = raw.map((x) => `${x.source_type}:${x.source_id}`);
  // Counterfactual for crowd-out: the same pooled search without TikTok.
  const rawNoTt = await rpc('ai_search', { p_query_embedding: vec, p_query_text: q, p_match_count: 8, p_as_user: boss,
    p_source_types: ['kb_article', 'ai_doc', 'app_guide', 'report', 'incentive'] });
  const rawNoTtKeys = rawNoTt.map((x) => `${x.source_type}:${x.source_id}`);
  results.push({
    id: row.id, category: row.category, overlap: row.subset === 'phase5-overlap', match: row.retrieval_match ?? 'share',
    expectedIndex: row.expected_index ?? null, q, filters: rf, expected: Object.fromEntries(exp),
    optional: (row.optional_sources ?? []).map(keyOf), byIndex, fedKeys, rawKeys, rawNoTtKeys,
  });
  if (++done % 20 === 0) { console.error(`… ${done}/${rows.length} rows (${dbCalls} db calls, ${(dbMs / 1000).toFixed(0)} s in db)`); saveRpcCache(); }
}
saveRpcCache();

// ── metrics ──
function score(expKeys, got, match) {
  if (!expKeys.length) return null;
  const found = expKeys.filter((k) => got.includes(k)).length;
  if (match === 'any') return found > 0 ? 1 : 0;
  if (match === 'all') return found === expKeys.length ? 1 : 0;
  return found / expKeys.length;
}
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
const cell = new Map();   // "index|category" → scores
const add = (k, v) => { if (v == null) return; if (!cell.has(k)) cell.set(k, []); cell.get(k).push(v); };
// Two crowd-out measures over rows that require one of our own (company or
// report) sources:
//   causal: an own source missing from the list that the SAME search without
//     TikTok returns. Federated: its company/report groups have fixed quotas
//     and never see TikTok candidates, so dropping the TikTok group changes
//     nothing; measured anyway by re-scoring the list minus that group.
//   strict: an own source missing while any TikTok item is in the list,
//     whatever the cause (for federated this includes quota-limited misses).
const cnt = { n: 0, fedCausal: 0, rawCausal: 0, fedStrict: 0, rawStrict: 0, ovlN: 0, ovlFedCausal: 0, ovlRawCausal: 0, ovlFedStrict: 0, ovlRawStrict: 0 };
const misses = [];
const junkSeen = [];
for (const r of results) {
  const keys = Object.keys(r.expected);
  const cats = [r.category, 'ALL', ...(r.overlap ? ['OVERLAP'] : [])];
  for (const [idx, got] of Object.entries(r.byIndex)) {
    const mine = keys.filter((k) => r.expected[k] === idx);
    const v = score(mine, got.keys, r.match);
    for (const c of cats) { add(`${idx}|${c}`, v); add(`${idx}@ranked|${c}`, score(mine, got.ranked, r.match)); }
    if (v != null && v < 1) misses.push(`${r.id} [${idx}] missing ${mine.filter((k) => !got.keys.includes(k)).join(', ')}${mine.some((k) => !got.keys.includes(k) && got.ranked.includes(k)) ? '  (ranked in top K, cut by the token budget)' : ''}${got.notes.length ? `  (${got.notes.join('; ')})` : ''}`);
    if (!mine.length) misses.push(`${r.id} [${idx}] expected_index has no expected source in this corpus (label?)`);
    if (got.keys.some(isJunk)) junkSeen.push(`${r.id} [${idx}]`);
  }
  for (const c of cats) {
    add(`federated|${c}`, score(keys, r.fedKeys, r.match));
    add(`baseline|${c}`, score(keys, r.rawKeys, r.match));
  }
  if (r.fedKeys.some(isJunk)) junkSeen.push(`${r.id} [federated]`);
  if (r.rawKeys.some(isJunk)) junkSeen.push(`${r.id} [baseline]`);
  const ours = keys.filter((k) => ['company', 'reports'].includes(r.expected[k]));
  if (!ours.length) continue;
  const rule = r.match === 'any' ? 'any' : 'all';
  const ok = (list) => score(ours, list, rule) === 1;
  const tt = (list) => list.some((k) => k.startsWith('tts_article:'));
  const fedNoTt = r.fedKeys.filter((k) => !k.startsWith('tts_article:'));
  const fc = !ok(r.fedKeys) && ok(fedNoTt), rc = !ok(r.rawKeys) && ok(r.rawNoTtKeys);
  const fs_ = !ok(r.fedKeys) && tt(r.fedKeys), rs = !ok(r.rawKeys) && tt(r.rawKeys);
  cnt.n++; cnt.fedCausal += fc; cnt.rawCausal += rc; cnt.fedStrict += fs_; cnt.rawStrict += rs;
  if (r.overlap) { cnt.ovlN++; cnt.ovlFedCausal += fc; cnt.ovlRawCausal += rc; cnt.ovlFedStrict += fs_; cnt.ovlRawStrict += rs; }
}

const fmt = (x) => (Number.isFinite(x) ? x.toFixed(3) : '  -  ');
const cats = [...new Set(results.map((r) => r.category))];
const table = {};
for (const idx of ['company', 'reports', 'tiktok', 'company@ranked', 'reports@ranked', 'tiktok@ranked', 'federated', 'baseline']) {
  const line = {};
  for (const c of [...cats, 'OVERLAP', 'ALL']) { const xs = cell.get(`${idx}|${c}`) ?? []; line[c] = xs.length ? `${fmt(mean(xs))} (${xs.length})` : ''; }
  table[idx] = line;
}
console.log(`\nrecall (n) per index × category — ${results.length} rows, as the Boss${flag('--no-filters') ? ', NO report filters' : ''}`);
console.log(`  <index>: what the tool returns (top ${cfg.TOP_K}, packed to its token budget) · <index>@ranked: top ${cfg.TOP_K} before packing`);
console.log(`  federated: all groups (quotas ${cfg.QUOTA_COMPANY}/${cfg.QUOTA_REPORTS}/${cfg.QUOTA_TIKTOK}/${cfg.QUOTA_INCENTIVES}) · baseline: raw pooled ai_search, top 8`);
console.table(table);
const tgt = (idx, cs) => mean(cs.flatMap((c) => cell.get(`${idx}|${c}`) ?? []));
const summary = {
  company_sop_howto: tgt('company', ['sop', 'how_to']),
  reports_narrative: tgt('reports', ['report_narrative']),
  tiktok: tgt('tiktok', ['tiktok']),
  ranked_company_sop_howto: tgt('company@ranked', ['sop', 'how_to']),
  ranked_reports_narrative: tgt('reports@ranked', ['report_narrative']),
  ranked_tiktok: tgt('tiktok@ranked', ['tiktok']),
  crowd_out_federated_causal: cnt.fedCausal / cnt.n,
  crowd_out_federated_strict: cnt.fedStrict / cnt.n,
  overlap_index_tools: mean(['company', 'reports', 'tiktok'].flatMap((i) => cell.get(`${i}|OVERLAP`) ?? [])),
  overlap_federated: tgt('federated', ['OVERLAP']),
  overlap_crowd_out_federated_strict: cnt.ovlFedStrict / cnt.ovlN,
  baseline_company_sop_howto: tgt('baseline', ['sop', 'how_to']),
  baseline_reports_narrative: tgt('baseline', ['report_narrative']),
  baseline_tiktok: tgt('baseline', ['tiktok']),
  baseline_overlap: tgt('baseline', ['OVERLAP']),
  crowd_out_baseline_causal: cnt.rawCausal / cnt.n,
  crowd_out_baseline_strict: cnt.rawStrict / cnt.n,
  overlap_crowd_out_baseline_causal: cnt.ovlRawCausal / cnt.ovlN,
};
console.log('\nTargets: company ≥ 0.90 · reports narrative ≥ 0.85 · tiktok ≥ 0.90 · federated crowd-out ≤ 0.05');
console.table(Object.fromEntries(Object.entries(summary).map(([k, v]) => [k, fmt(v)])));
console.log(`crowd-out over ${cnt.n} rows needing an own source (overlap: ${cnt.ovlN}): causal ${cnt.fedCausal} federated / ${cnt.rawCausal} baseline;`
  + ` strict ${cnt.fedStrict} federated / ${cnt.rawStrict} baseline; overlap causal ${cnt.ovlFedCausal} / ${cnt.ovlRawCausal}, strict ${cnt.ovlFedStrict} / ${cnt.ovlRawStrict}`);
if (Object.keys(sets).length) console.log('overrides:', JSON.stringify(sets));
console.log(`\nmisses (index tools):\n  ${misses.join('\n  ') || 'none'}`);
console.log(`\n"testing doc" (kb_article 833b9bda…) surfaced in: ${junkSeen.join(', ') || 'no result list'}`);
if (unreachable.length) console.log(`\nnot in the store (left out): ${unreachable.join(', ')}`);
console.log(`db: ${dbCalls} uncached RPC calls, ${(dbMs / 1000).toFixed(1)} s`);

// ── the five before/after examples ──
if (flag('--examples')) {
  const EX = [
    { q: 'What does our SOP say about approving sample requests?', runs: [['company', {}]] },
    { q: 'How should we appeal a violation?', runs: [['company', {}], ['tiktok', {}]] },
    { q: 'Which brands had strong GMV Max results in August?', runs: [['reports', 'period:August']] },
    { q: 'What did we recommend about creator outreach this month?', runs: [['reports', 'period:this month|sections:written:recommendations']] },
    { q: "What is TikTok's late dispatch rate requirement?", runs: [['tiktok', {}]] },
  ];
  const { resolvePeriod } = await import('../supabase/functions/_shared/ai/retrieval/resolve.ts');
  await embedAll(EX.map((e) => e.q));
  for (const e of EX) {
    console.log(`\n=== ${e.q}`);
    const raw = await rpc('ai_search', { p_query_embedding: `[${(await embed(e.q)).join(',')}]`, p_query_text: e.q, p_match_count: 8, p_as_user: boss });
    console.log('  BEFORE (raw pooled ai_search, top 8):');
    raw.forEach((x, i) => console.log(`    ${i + 1}. [${x.source_type}] ${x.title.slice(0, 80)} · ${x.section}`));
    for (const [idx, spec] of e.runs) {
      const f = {};
      if (typeof spec === 'string') {
        for (const part of spec.split('|')) {
          const [k, v] = [part.slice(0, part.indexOf(':')), part.slice(part.indexOf(':') + 1)];
          if (k === 'period') { const r = resolvePeriod(v, deps.now); if (r.kind === 'range') { f.periodFrom = r.range.from; f.periodTo = r.range.to; } }
          if (k === 'sections') f.sections = v.split(',');
        }
      }
      const r = await searchIndex(idx, e.q, f, deps);
      console.log(`  AFTER search ${idx}${Object.keys(f).length ? ' ' + JSON.stringify(f) : ''} → sections ${JSON.stringify(r.sections)}; ${r.results.length} results, ${r.tokens} tokens${r.notes.length ? '; ' + r.notes.join('; ') : ''}`);
      r.results.forEach((x) => console.log(`    ${x.cite}. [${x.source_type}] ${x.title.slice(0, 80)} · ${x.section}${x.chunk_indexes.length > 1 ? ` · chunks ${x.chunk_indexes.join(',')}` : ''}`));
    }
  }
}

const outFile = opt('--out');
if (outFile) fs.writeFileSync(outFile, JSON.stringify({ config: cfg, overrides: sets, summary, results, unreachable }, null, 1));
saveRpcCache();
if (cfg.RERANK_ENABLED) console.log(`rerank (${cfg.RERANK_MODEL} on ${cfg.RERANK_INDEXES.join(', ')}): ${rerankUsage.calls} calls, ${rerankUsage.input_tokens} input + ${rerankUsage.output_tokens} output tokens`);
console.log(`\nembedding spend this run: ${embedTokens} tokens in ${embedCalls} request(s) ≈ $${(embedTokens * 0.02 / 1e6).toFixed(5)} (text-embedding-3-small)`);
await pool.end();
