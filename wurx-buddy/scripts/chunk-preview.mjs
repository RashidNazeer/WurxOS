// ============================================================
// Chunk preview + corpus estimate for the Assistant ingester. DEV ONLY,
// READ-ONLY, NO embedding calls.
//
//   node --experimental-strip-types Assistant/scripts/chunk-preview.mjs [--jsonl <path>] [--quiet]
//
// 1. Loads a few real rows from the dev DB (2 reports of different layouts,
//    2 KB articles with merged SOP text) plus 2 TikTok Academy records from
//    the crawl jsonl, runs them through extractor + chunker, and prints chunk
//    counts, token sizes and the start of every chunk.
// 2. Runs the WHOLE indexable corpus (reports, active ai docs, KB, the jsonl)
//    through the same code and prints chunk / token totals, the embedding
//    cost at $0.02 per 1M tokens, and why rows were skipped.
//
// Guard rails as db-dev.mjs (scripts/dev-env.mjs).
// ============================================================
import fs from 'node:fs';
import pg from 'pg';
import { devDbUrl, SSL } from './dev-env.mjs';
import { chunkDocument } from '../supabase/functions/_shared/ai/chunker.ts';
import { chunkParamsFor } from '../supabase/functions/_shared/ai/config.ts';
import { extractors } from '../supabase/functions/_shared/ai/extractors/index.ts';
import { detectLayout } from '../supabase/functions/_shared/ai/extractors/report.ts';

const PRICE_PER_M = 0.02;
const args = process.argv.slice(2);
const argVal = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const JSONL = argVal('--jsonl', 'C:/Users/Umar Ilyas/WurxOS/Assistant/data/tts-academy/articles.jsonl');
const QUIET = args.includes('--quiet');

const url = devDbUrl();

// The dev pooler drops connections now and then; the load is read-only, so
// retry all of it.
async function load() {
  // query_timeout: a socket the pooler dropped mid-query rejects (and retries)
  // instead of hanging forever (QA N3).
  const c = new pg.Client({ connectionString: url, ssl: SSL, connectionTimeoutMillis: 20_000, query_timeout: 120_000, statement_timeout: 110_000 });
  c.on('error', () => {});   // a dropped socket rejects the pending query instead of crashing
  try {
    await c.connect();
    await c.query('begin read only');
    const { rows: reports } = await c.query(`
      select r.id, r.type, r.brand_id, r.author_id, r.status, r.period_label,
             r.period_start::text, r.period_end::text, r.data, r.sections_enabled,
             r.updated_at, r.legacy_id, b.brand_name, b.client_name, b.currency
        from public.reports r left join public.brands b on b.id = r.brand_id
       where r.status in ('submitted','verified','approved')
       order by r.period_start desc nulls last, r.id`);
    const { rows: docs } = await c.query(`
      select id, title, content, is_active, kind, slug, meta, kb_article_id, created_by, updated_at
        from public.ai_assistant_docs where is_active order by id`);
    const { rows: kbRows } = await c.query(`
      select id, title, body, url, category, tags, visibility, visible_to_roles, visible_to_users,
             created_by, submitted_by, approval_status, sop_group_id, version, version_label, requires_ack, updated_at
        from public.kb_articles order by coalesce(sop_group_id, id), version desc nulls last, id`);
    await c.query('rollback');
    return { reports, docs, kbRows };
  } finally {
    await c.end().catch(() => {});
  }
}

let loaded;
for (let attempt = 1; !loaded; attempt++) {
  try { loaded = await load(); } catch (e) {
    if (attempt >= 5) throw e;
    console.error(`load failed (${e.code || e.message}), retry ${attempt}...`);
    await new Promise((r) => setTimeout(r, 3000 * attempt));
  }
}
const { reports, docs, kbRows } = loaded;

const tts = fs.existsSync(JSONL)
  ? fs.readFileSync(JSONL, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).map((r) => ({
      knowledge_id: r.id, kind: r.kind, url: r.url, title: r.title, breadcrumb: r.breadcrumb, course: r.course ?? null,
      keywords: r.keywords ?? [], applies_to: r.applies_to, source: r.source, ai_summary: r.ai_summary, toc: r.toc ?? [],
      body: r.text, views: r.views, source_modified_at: r.modified_at, is_active: true,
    }))
  : [];

// ---------------------------------------------------------------- contexts
// Latest APPROVED version per SOP group (QA L10), as the ingester's loader.
const latestKb = new Set();
{ const seen = new Set(); for (const k of kbRows) { if (k.approval_status !== 'approved') continue; const g = k.sop_group_id || k.id; if (!seen.has(g)) { seen.add(g); latestKb.add(k.id); } } }
const docsByKb = new Map();
for (const d of docs) if (d.kb_article_id) (docsByKb.get(d.kb_article_id) ?? docsByKb.set(d.kb_article_id, []).get(d.kb_article_id)).push(d);
const reportCtx = (r) => ({ brand: { brand_name: r.brand_name, client_name: r.client_name, currency: r.currency } });
const kbCtx = (k) => ({ isLatestVersion: latestKb.has(k.id), linkedDocs: docsByKb.get(k.id) ?? [] });
const docSource = (d) => (d.kind === 'app_guide' ? 'app_guide' : 'ai_doc');

const skips = {};
async function run(sourceType, row, ctx) {
  const ex = extractors[sourceType];
  if (!ex.indexable(row, ctx)) {
    const why = (ex.skipReason?.(row, ctx) ?? 'not indexable').replace(/ [0-9a-f-]{36}$/, ' …');
    skips[`${sourceType}: ${why}`] = (skips[`${sourceType}: ${why}`] ?? 0) + 1;
    return null;
  }
  const doc = ex.toDocument(row, ctx);
  const res = await chunkDocument(doc, chunkParamsFor(sourceType));
  return { doc, ...res };
}

function show(label, r) {
  if (!r) { console.log(`\n### ${label}: not indexable`); return; }
  const toks = r.chunks.map((c) => c.token_count);
  console.log(`\n### ${label}`);
  console.log(`header: ${r.doc.header}`);
  console.log(`acl: ${JSON.stringify(r.doc.acl)}  sections: ${r.doc.sections.length}  chunks: ${r.chunks.length}${r.capped ? ` (CAPPED from ${r.totalBeforeCap})` : ''}  tokens: [${toks.join(', ')}]`);
  for (const c of r.chunks) {
    const [, sec, ...body] = c.content.split('\n');
    console.log(`  #${c.chunk_index} ${c.section} (${c.token_count} tok) ${sec}\n     ${JSON.stringify(body.join('\n').slice(0, 200))}`);
  }
}

// ---------------------------------------------------------------- 1. samples
if (!QUIET) {
  console.log('=============== SAMPLES ===============');
  const byLayout = (l) => reports.find((r) => detectLayout(r) === l);
  for (const l of ['single', 'monthly']) {
    const r = byLayout(l);
    if (r) show(`report (${l}) ${r.type} ${r.period_label}`, await run('report', r, reportCtx(r)));
  }
  const merged = kbRows.filter((k) => docsByKb.has(k.id)).sort((a, b) => docsByKb.get(b.id).length - docsByKb.get(a.id).length);
  const restricted = merged.find((k) => k.visibility !== 'office');
  for (const k of [merged[0], restricted].filter(Boolean)) {
    show(`kb_article "${k.title}" + ${docsByKb.get(k.id).length} SOP doc(s), visibility ${k.visibility}`, await run('kb_article', k, kbCtx(k)));
  }
  const ttsPick = [tts.find((t) => t.kind === 'essay' && t.ai_summary), tts.find((t) => t.kind === 'course_lesson')].filter(Boolean);
  for (const t of ttsPick) show(`tts ${t.kind} "${t.title}" (${t.body.length} chars)`, await run('tts_article', t, undefined));
}

// ---------------------------------------------------------------- 2. corpus
const stats = {};
const layouts = {};
const add = (src, r) => {
  const s = (stats[src] ??= { rows: 0, indexed: 0, chunks: 0, tokens: 0, capped: 0, maxChunks: 0, maxTok: 0, errors: 0 });
  s.rows++;
  if (!r) return;
  if (r.error) { s.errors++; return; }
  s.indexed++;
  s.chunks += r.chunks.length;
  s.tokens += r.chunks.reduce((a, c) => a + c.token_count, 0);
  s.capped += r.capped ? 1 : 0;
  s.maxChunks = Math.max(s.maxChunks, r.chunks.length);
  s.maxTok = Math.max(s.maxTok, ...r.chunks.map((c) => c.token_count), 0);
};
const safe = async (...a) => { try { return await run(...a); } catch (e) { return { error: e.message }; } };

for (const k of Object.keys(skips)) delete skips[k];   // the samples above ran through run() too
for (const r of reports) {
  const l = detectLayout(r);
  layouts[`${r.type}/${l}`] = (layouts[`${r.type}/${l}`] ?? 0) + 1;
  add('report', await safe('report', r, reportCtx(r)));
}
for (const d of docs) add(docSource(d), await safe(docSource(d), d, undefined));
for (const k of kbRows) add('kb_article', await safe('kb_article', k, kbCtx(k)));
for (const t of tts) add('tts_article', await safe('tts_article', t, undefined));

console.log('\n=============== CORPUS ESTIMATE (no embeddings) ===============');
console.log('report layouts (indexable):', layouts);
console.table(Object.fromEntries(Object.entries(stats).map(([k, s]) => [k, {
  ...s, avgTok: s.chunks ? Math.round(s.tokens / s.chunks) : 0, costUSD: +(s.tokens / 1e6 * PRICE_PER_M).toFixed(4),
}])));
const tot = Object.values(stats).reduce((a, s) => ({ chunks: a.chunks + s.chunks, tokens: a.tokens + s.tokens }), { chunks: 0, tokens: 0 });
console.log(`TOTAL: ${tot.chunks} chunks, ${tot.tokens.toLocaleString('en-US')} tokens → $${(tot.tokens / 1e6 * PRICE_PER_M).toFixed(4)} at $${PRICE_PER_M}/1M`);
console.log(`TikTok jsonl: ${tts.length} records from ${JSONL}${tts.length ? '' : ' (not found)'}`);
const linked = docs.filter((d) => d.kb_article_id).length;
console.log(`ai docs linked to a KB article: ${linked} of ${docs.length}; KB articles carrying SOP text: ${docsByKb.size}`);
console.log('skipped (not indexable):', skips);
