// Index search and federated search (phase5-design.md §2.2, §2.3).
//
//   searchIndex(index, query, filters, deps)
//     embed → ai_search (pool of RETRIEVAL_POOL, as the caller) → title boost
//     and report recency → ≤ N chunks per document → optional rerank → top K →
//     neighbours (±1) for the top few → pack to the index's token budget.
//   searchEverything(query, deps)
//     the four indexes in parallel with fixed quotas, grouped and labelled, so a
//     large corpus (TikTok: 27× our SOPs) can never crowd a small one out.
//
// Pure TS (Deno + Node). The database is reached only through `rpc`
// (ai_search, ai_get_chunks), which applies the caller's ACL.

import type { Rpc } from '../ingest/db.ts';
import { estimateTokens } from '../text.ts';
import { retrievalConfig, type RetrievalConfig } from './config.ts';
import { budgetFor, INDEX_ORDER, INDEXES, quotaFor, type IndexName } from './indexes.ts';
import { expandSynonyms, pktToday, toIsoDate } from './resolve.ts';

export type SearchFilters = {
  brandIds?: string[];
  periodFrom?: string;          // YYYY-MM-DD (PKT)
  periodTo?: string;
  weekNumber?: number | number[];   // brand-relative "Week 12": matched on the report's period label
  reportType?: 'weekly' | 'biweekly' | 'monthly';
  sections?: string[] | 'all';  // reports: default narrative (config), 'all' = no filter
};

export type Reranker = (query: string, items: Array<{ id: string; title: string; text: string }>) => Promise<number[]>;

export type SearchDeps = {
  rpc: Rpc;
  embed: (text: string) => Promise<number[] | null>;
  asUser?: string | null;       // service role only (Slack relay, eval); else the JWT decides
  config?: RetrievalConfig;
  now?: Date;
  rerank?: Reranker;
};

export type Candidate = {
  chunk_id: string;
  document_id: string;
  chunk_index: number;
  source_type: string;
  source_id: string;
  title: string;
  url: string | null;
  section: string | null;
  content: string;
  brand_id: string | null;
  period_start: string | null;
  period_end: string | null;
  metadata: Record<string, any>;
  score: number;                // RRF from ai_search
  adj: number;                  // after title boost / recency / rerank
};

export type Neighbour = { chunk_index: number; section: string | null; content: string };

export type Packed = {
  cite: string;                 // S1, S2, …
  chunk_id: string;             // the matched chunk (neighbours are in chunk_indexes)
  index: IndexName;
  source_type: string;
  source_id: string;
  document_id: string;
  title: string;
  url: string | null;
  section: string | null;
  brand_id: string | null;
  brand: string | null;
  period: { start: string | null; end: string | null; label: string | null } | null;
  report_type: string | null;
  status: string | null;        // reports: always 'approved' (only approved are indexed)
  currency: string | null;
  score: number;
  chunk_indexes: number[];
  text: string;
  tokens: number;
};

export type IndexResult = {
  index: IndexName;
  label: string;
  authority: string;
  query: string;
  filters: SearchFilters;
  sections: string[] | null;
  results: Packed[];
  ranked: Array<{ source_type: string; source_id: string; chunk_id: string }>;   // the top K before packing (logs, eval)
  candidates: number;
  tokens: number;
  notes: string[];              // e.g. "no report in that period: searched all periods"
};

type RunOpts = { topK?: number; maxPerDoc?: number; budget?: number; neighbourTop?: number; citeStart?: number; rerank?: boolean };

// ── pure stages (exported for tests) ────────────────────────────────────────

export function diversify<T extends { document_id: string }>(items: T[], maxPerDoc: number): T[] {
  const n = new Map<string, number>();
  return items.filter((c) => {
    const k = (n.get(c.document_id) ?? 0) + 1;
    n.set(c.document_id, k);
    return k <= maxPerDoc;
  });
}

// 0.5 ^ (age / half-life); a period in the future or today counts as age 0.
export function recencyFactor(periodEnd: string | null, now: Date, halfLifeDays: number): number {
  if (!periodEnd || !(halfLifeDays > 0)) return 1;
  const age = (now.getTime() - Date.parse(`${periodEnd}T00:00:00Z`)) / 86_400_000;
  return Number.isFinite(age) ? Math.pow(0.5, Math.max(0, age) / halfLifeDays) : 1;
}

const STOP = new Set(('a an and are as at be by can do does did for from has have how i if in is it its me my of on or our ' +
  'should so that the their them there these they this to was we were what when where which who why will with you your ' +
  'tell show give about say says said').split(' '));

export function queryTerms(q: string): string[] {
  return [...new Set(String(q).toLowerCase().match(/[a-z0-9]+/g) ?? [])].filter((w) => w.length >= 3 && !STOP.has(w));
}

// Share of the query's content terms that appear in the title (prefix match,
// so "approving" meets "approve").
export function titleOverlap(terms: string[], title: string): number {
  if (!terms.length) return 0;
  const words = String(title).toLowerCase().match(/[a-z0-9]+/g) ?? [];
  const stem = (w: string) => w.slice(0, Math.max(4, Math.min(w.length, 6)));
  const hit = terms.filter((t) => words.some((w) => stem(w) === stem(t)));
  return hit.length / terms.length;
}

// Report sections searched for a query when the caller names none: the
// narrative, plus a number table the question plainly asks about.
export function defaultReportSections(query: string, narrative: string[]): string[] {
  const q = query.toLowerCase();
  const s = [...narrative];
  if (/\b(creators?|affiliates?|influencers?)\b/.test(q) && /\b(top|best|which|who|ranking|list)\b/.test(q)) s.push('table:creators');
  if (/\bproducts?\b|\bskus?\b/.test(q) && /\b(top|best|which|ranking|list)\b/.test(q)) s.push('table:products');
  if (/\bvideos?\b/.test(q) && /\b(top|best|which|ranking|list)\b/.test(q)) s.push('table:videos');
  if (/\bgmv ?max\b|\broas\b|\bad spend\b/.test(q)) s.push('table:gmvmax', 'table:gmvmax_mtd');
  return s;
}

const HEADER_RE = /^\[[^\n]*\]\n/;

// The main chunk plus the neighbours that fit, in document order; repeated
// context headers are dropped from the neighbours.
export function joinWithNeighbours(main: { chunk_index: number; content: string }, neighbours: Neighbour[]): { text: string; indexes: number[] } {
  const all = [{ chunk_index: main.chunk_index, content: main.content }, ...neighbours].sort((a, b) => a.chunk_index - b.chunk_index);
  const header = main.content.match(HEADER_RE)?.[0] ?? '';
  return { text: header + all.map((c) => c.content.replace(HEADER_RE, '')).join('\n…\n'), indexes: all.map((c) => c.chunk_index) };
}

// Base results first (recall), then neighbours of the top `neighbourTop` from
// what is left of the budget. The first result is always kept (cut to fit).
export function pack(index: IndexName, top: Candidate[], neighbours: Map<string, Neighbour[]>, budget: number,
  neighbourTop: number, citeStart = 1): Packed[] {
  const chosen: Array<{ c: Candidate; nb: Neighbour[]; tokens: number }> = [];
  let used = 0;
  for (const c of top) {
    const t = estimateTokens(c.content);
    if (chosen.length && used + t > budget) continue;
    chosen.push({ c, nb: [], tokens: t });
    used += t;
  }
  const inResults = new Set(chosen.map((x) => `${x.c.document_id}:${x.c.chunk_index}`));
  for (const x of chosen.slice(0, neighbourTop)) {
    for (const n of neighbours.get(x.c.chunk_id) ?? []) {
      const key = `${x.c.document_id}:${n.chunk_index}`;
      if (inResults.has(key)) continue;
      const t = estimateTokens(n.content.replace(HEADER_RE, ''));
      if (used + t > budget) continue;
      x.nb.push(n);
      x.tokens += t;
      used += t;
      inResults.add(key);
    }
  }
  return chosen.map((x, i) => {
    const { text: joined, indexes } = joinWithNeighbours(x.c, x.nb);
    const text = x.tokens > budget ? joined.slice(0, budget * 4) : joined;
    const m = x.c.metadata ?? {};
    const isReport = x.c.source_type === 'report';
    return {
      cite: `S${citeStart + i}`,
      index,
      source_type: x.c.source_type,
      source_id: x.c.source_id,
      document_id: x.c.document_id,
      chunk_id: x.c.chunk_id,
      title: x.c.title,
      url: x.c.url ?? m.url ?? null,
      section: x.c.section,
      brand_id: x.c.brand_id,
      brand: m.brand_name ?? null,
      period: x.c.period_start || m.month ? { start: x.c.period_start, end: x.c.period_end, label: m.period_label ?? m.month ?? null } : null,
      report_type: m.report_type ?? null,
      status: isReport ? (m.status ?? 'approved') : null,
      currency: m.currency ?? null,
      score: Number(x.c.adj.toFixed(6)),
      chunk_indexes: indexes,
      text,
      tokens: estimateTokens(text),
    };
  });
}

// ── the index tool ──────────────────────────────────────────────────────────

const vecLiteral = (v: number[]) => `[${v.join(',')}]`;

function toCandidate(r: any): Candidate {
  return {
    ...r,
    period_start: toIsoDate(r.period_start),
    period_end: toIsoDate(r.period_end),
    metadata: r.metadata ?? {},
    score: Number(r.score),
    adj: Number(r.score),
  };
}

export async function searchIndex(index: IndexName, query: string, filters: SearchFilters, deps: SearchDeps, opts: RunOpts = {}): Promise<IndexResult> {
  const cfg = deps.config ?? retrievalConfig().config;
  const def = INDEXES[index];
  const now = deps.now ?? new Date();
  const notes: string[] = [];
  const q = String(query ?? '').trim();
  const topK = opts.topK ?? cfg.TOP_K;
  const out = (results: Packed[], ranked: Candidate[], candidates: number, sections: string[] | null): IndexResult => ({
    index, label: def.label, authority: def.authority, query: q, filters, sections, results,
    ranked: ranked.map((c) => ({ source_type: c.source_type, source_id: c.source_id, chunk_id: c.chunk_id })), candidates,
    tokens: results.reduce((a, r) => a + r.tokens, 0), notes,
  });
  if (!q || topK <= 0) return out([], [], 0, null);

  const isReports = index === 'reports';
  const sections = isReports && filters.sections !== 'all'
    ? (Array.isArray(filters.sections) && filters.sections.length ? filters.sections : defaultReportSections(q, cfg.REPORT_NARRATIVE_SECTIONS))
    : null;
  const extra = cfg.SYNONYMS ? expandSynonyms(q) : [];
  const weeks = isReports ? [filters.weekNumber ?? []].flat().filter((w) => Number.isInteger(w) && w > 0) : [];
  const keywordText = [q, ...extra, ...weeks.map((w) => `week ${w}`)].join(' ');

  let embedding: number[] | null = null;
  try { embedding = await deps.embed(q); } catch { embedding = null; }
  if (!embedding) notes.push('embedding unavailable: keyword search only');

  const hasPeriod = !!(filters.periodFrom || filters.periodTo);
  const crossBrand = isReports && !filters.brandIds?.length;
  const call = (withPeriod: boolean, from?: string) => deps.rpc('ai_search', {
    p_query_embedding: embedding ? vecLiteral(embedding) : null,
    p_query_text: keywordText,
    p_source_types: def.sourceTypes,
    p_brand_ids: filters.brandIds?.length ? filters.brandIds : undefined,
    p_period_from: from ?? (withPeriod ? filters.periodFrom : undefined),
    p_period_to: withPeriod ? filters.periodTo : undefined,
    p_match_count: from ? 10 : crossBrand ? cfg.REPORTS_CROSS_BRAND_POOL : cfg.RETRIEVAL_POOL,
    p_as_user: deps.asUser ?? undefined,
    p_sections: sections ?? undefined,
  });
  // "How is Obagi doing?" is about the latest reports, which a generic query
  // may not rank into the pool at all: for a brand without a period, the best
  // chunks of its last few weeks are searched separately and put first.
  const recentPass = isReports && !crossBrand && !hasPeriod && !weeks.length && cfg.RECENT_PASS_DAYS > 0 && cfg.RECENT_PASS_TOP > 0;
  const [main, recent] = await Promise.all([
    call(true),
    recentPass ? call(false, new Date(pktToday(now).getTime() - cfg.RECENT_PASS_DAYS * 86_400_000).toISOString().slice(0, 10)) : null,
  ]);
  let rows: Candidate[] = (main ?? []).map(toCandidate);
  const pinned: Candidate[] = diversify<Candidate>((recent ?? []).map(toCandidate), 1).slice(0, recentPass ? cfg.RECENT_PASS_TOP : 0);
  let periodApplied = hasPeriod;
  if (isReports && hasPeriod && !rows.length && cfg.PERIOD_RELAX) {
    rows = ((await call(false)) ?? []).map(toCandidate);
    periodApplied = false;
    notes.push(`no approved report text in ${filters.periodFrom ?? '…'} → ${filters.periodTo ?? '…'}: showing other periods (newest first)`);
  }
  if (weeks.length) {
    const re = new RegExp(`^\\s*week\\s*(?:${weeks.join('|')})\\b`, 'i');
    const kept = rows.filter((r) => re.test(String(r.metadata.period_label ?? '')));
    if (kept.length) rows = kept; else notes.push(`no approved report labelled Week ${weeks.join(' / ')}: showing other weeks`);
  }
  if (isReports && filters.reportType) {
    const kept = rows.filter((r) => r.metadata.report_type === filters.reportType);
    if (kept.length) rows = kept; else notes.push(`no approved ${filters.reportType} report matched: showing other report types`);
  }
  const candidates = rows.length;

  const terms = queryTerms(q);
  for (const r of rows) {
    // Report titles are generated ("Weekly report · Brand · Week 24"): no signal there.
    if (cfg.TITLE_BOOST > 0 && !isReports) r.adj *= 1 + cfg.TITLE_BOOST * titleOverlap(terms, r.title);
    if (isReports && !periodApplied) r.adj *= recencyFactor(r.period_end ?? r.period_start, now, cfg.RECENCY_HALF_LIFE_DAYS);
  }
  rows.sort((a, b) => b.adj - a.adj);
  if (pinned.length) {
    const ids = new Set(pinned.map((p) => p.chunk_id));
    rows = [...pinned, ...rows.filter((r) => !ids.has(r.chunk_id))];
  }
  // A cross-brand report question wants many brands, not two chunks of each.
  const perDoc = opts.maxPerDoc ?? (crossBrand ? cfg.REPORTS_CROSS_BRAND_MAX_PER_DOC : cfg.MAX_CHUNKS_PER_DOC_IN_RESULTS);
  let ranked = diversify(rows, perDoc);

  if (cfg.RERANK_ENABLED && opts.rerank !== false && cfg.RERANK_INDEXES.includes(index) && deps.rerank && ranked.length > 1
      && !(isReports && cfg.RERANK_REPORTS_CROSS_BRAND_ONLY && !crossBrand)) {
    // The pinned latest reports stay first: relevance is not what put them there.
    const pinnedIds = new Set(pinned.map((p) => p.chunk_id));
    const lead = ranked.filter((c) => pinnedIds.has(c.chunk_id));
    const rest = ranked.filter((c) => !pinnedIds.has(c.chunk_id));
    const head = rest.slice(0, cfg.RERANK_CANDIDATES);
    try {
      const scores = await deps.rerank(q, head.map((c) => ({ id: c.chunk_id, title: c.title, text: c.content })));
      if (scores.length === head.length) {
        // Rerank orders; the fused score only breaks ties.
        head.forEach((c, i) => { c.adj = (Number(scores[i]) || 0) + c.adj / 1000; });
        head.sort((a, b) => b.adj - a.adj);
        ranked = [...lead, ...head, ...rest.slice(head.length)];
      }
    } catch { notes.push('rerank failed: fused order kept'); }
  }
  const top = ranked.slice(0, topK);

  const neighbourTop = Math.min(opts.neighbourTop ?? cfg.NEIGHBOUR_TOP, top.length);
  const neighbours = new Map<string, Neighbour[]>();
  await Promise.all(top.slice(0, neighbourTop).map(async (c) => {
    try {
      const got = (await deps.rpc('ai_get_chunks', {
        p_document_id: c.document_id, p_from: c.chunk_index - 1, p_to: c.chunk_index + 1, p_as_user: deps.asUser ?? undefined,
      })) ?? [];
      neighbours.set(c.chunk_id, got.filter((n: any) => n.chunk_index !== c.chunk_index)
        .map((n: any) => ({ chunk_index: n.chunk_index, section: n.section, content: n.content })));
    } catch { /* a neighbour is a nicety: the result stands without it */ }
  }));

  const budget = opts.budget ?? budgetFor(index, cfg);
  return out(pack(index, top, neighbours, budget, neighbourTop, opts.citeStart ?? 1), top, candidates, sections);
}

// ── federated ──────────────────────────────────────────────────────────────

export type FederatedResult = { query: string; groups: IndexResult[]; tokens: number };

// Report filters (brand, period, type) apply to the reports group only.
export async function searchEverything(query: string, deps: SearchDeps, reportFilters: SearchFilters = {}): Promise<FederatedResult> {
  const cfg = deps.config ?? retrievalConfig().config;
  const runs = INDEX_ORDER.filter((n) => quotaFor(n, cfg) > 0);
  const groups = await Promise.all(runs.map((n) => searchIndex(n, query, n === 'reports' ? reportFilters : {}, deps, {
    topK: quotaFor(n, cfg),
    maxPerDoc: cfg.FEDERATED_MAX_PER_DOC,
    budget: budgetFor(n, cfg, true),
    neighbourTop: cfg.FEDERATED_NEIGHBOUR_TOP,
    rerank: cfg.FEDERATED_RERANK,
  })));
  // Citation ids run on across groups, in the fixed group order.
  let next = 1;
  const kept = groups.filter((g) => g.results.length).map((g) => ({
    ...g, results: g.results.map((r) => ({ ...r, cite: `S${next++}` })),
  }));
  return { query, groups: kept, tokens: kept.reduce((a, g) => a + g.tokens, 0) };
}
