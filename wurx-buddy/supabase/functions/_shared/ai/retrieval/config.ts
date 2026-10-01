// Retrieval parameters (phase5-design.md §2.3, §6.1). Every value can be
// overridden from ai_assistant_config.retrieval (jsonb, admin-edited). That
// jsonb also holds agent keys (A§17), so keys unknown here are ignored, not
// errors; a known key with the wrong type is skipped and reported.

export const RETRIEVAL_DEFAULTS = Object.freeze({
  RETRIEVAL_POOL: 40,                 // ai_search candidates per index
  TOP_K: 8,                           // results per index tool
  MAX_CHUNKS_PER_DOC_IN_RESULTS: 2,   // diversity
  REPORTS_CROSS_BRAND_MAX_PER_DOC: 1, // reports without a brand filter: one chunk per report…
  REPORTS_CROSS_BRAND_POOL: 100,      // …from a wider pool (a monthly report has ~8 narrative chunks)
  NEIGHBOUR_TOP: 3,                   // neighbour expansion for the top N
  RECENCY_HALF_LIFE_DAYS: 120,        // reports, when no period is given
  TITLE_BOOST: 0.5,                   // score × (1 + boost × share of query terms in the title); not reports
  SYNONYMS: true,                     // expand the keyword arm (never the embedding)
  PERIOD_RELAX: true,                 // reports: nothing in the period → search all periods, and say so
  RECENT_PASS_DAYS: 21,               // reports for one brand, no period: also search its last 3 weeks…
  RECENT_PASS_TOP: 2,                 // …and put its best 2 reports first
  // Token budgets per index tool (§2.3.6). TikTok chunks average ~460 tokens:
  // at the design's 2,000 only 4 of the top 8 fit (eval: overlap recall 0.69 → 0.92 at 3,500).
  // Reports: GMV Max tables and cross-brand lists were cut at 2,500.
  BUDGET_COMPANY: 2500,
  BUDGET_REPORTS: 3500,
  BUDGET_TIKTOK: 3500,
  BUDGET_INCENTIVES: 1200,
  // Federated search: fixed quotas per index, then a per-group budget.
  QUOTA_COMPANY: 4,
  QUOTA_REPORTS: 3,
  QUOTA_TIKTOK: 3,
  QUOTA_INCENTIVES: 1,
  FEDERATED_MAX_PER_DOC: 1,
  FEDERATED_NEIGHBOUR_TOP: 0,
  FEDERATED_BUDGET_COMPANY: 1800,
  FEDERATED_BUDGET_REPORTS: 1000,
  FEDERATED_BUDGET_TIKTOK: 1200,
  FEDERATED_BUDGET_INCENTIVES: 400,
  // Report sections searched when the caller names none (§2.3.5). An entry
  // matches a section exactly or by the prefix before ':'.
  REPORT_NARRATIVE_SECTIONS: ['summary', 'insights', 'written', 'offsite'] as string[],
  // LLM rerank (§2.5). On (Lead decision after the WP-A eval: reports
  // narrative 0.847 → 0.902), but only for search_reports without a brand
  // filter; searchIndex needs a `rerank` dep for it to run at all.
  RERANK_ENABLED: true,
  RERANK_INDEXES: ['reports'] as string[],   // where it runs when enabled (§2.5: per index)
  RERANK_CANDIDATES: 20,
  FEDERATED_RERANK: false,            // federated search stays one fast round
  RERANK_REPORTS_CROSS_BRAND_ONLY: true, // a brand's own reports are few and ranked well already
  RERANK_MODEL: 'gpt-5.4-mini',
});

export type RetrievalConfig = { -readonly [K in keyof typeof RETRIEVAL_DEFAULTS]: (typeof RETRIEVAL_DEFAULTS)[K] };

// Values that may legitimately be 0 (a boost or a neighbour count switched off).
const ZERO_OK = new Set(['TITLE_BOOST', 'NEIGHBOUR_TOP', 'RECENT_PASS_DAYS', 'RECENT_PASS_TOP', 'FEDERATED_NEIGHBOUR_TOP', 'QUOTA_INCENTIVES',
  'QUOTA_COMPANY', 'QUOTA_REPORTS', 'QUOTA_TIKTOK']);

export function retrievalConfig(raw?: unknown): { config: RetrievalConfig; ignored: string[] } {
  const config = { ...RETRIEVAL_DEFAULTS, REPORT_NARRATIVE_SECTIONS: [...RETRIEVAL_DEFAULTS.REPORT_NARRATIVE_SECTIONS] } as RetrievalConfig;
  const ignored: string[] = [];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { config, ignored };
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!(key in RETRIEVAL_DEFAULTS)) continue;
    const def = (RETRIEVAL_DEFAULTS as Record<string, unknown>)[key];
    let ok: boolean;
    if (Array.isArray(def)) ok = Array.isArray(value) && value.length > 0 && value.every((x) => typeof x === 'string' && x);
    else if (typeof def === 'number') ok = typeof value === 'number' && Number.isFinite(value) && (value > 0 || (value === 0 && ZERO_OK.has(key)));
    else ok = typeof value === typeof def;
    if (!ok) { ignored.push(key); continue; }
    (config as Record<string, unknown>)[key] = Array.isArray(value) ? [...value] : value;
  }
  return { config, ignored };
}
