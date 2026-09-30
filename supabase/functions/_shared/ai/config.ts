// Assistant v2 parameters (architecture.md §17). Plain TS: runs under Deno and
// `node --experimental-strip-types`.
//
// Only the values marked ⚙ in §17 may be overridden at runtime from
// ai_assistant_config.retrieval (jsonb). Chunking/embedding parameters are
// deliberately NOT overridable: changing them changes every content_hash, so
// it is a planned re-index, not a config toggle.

export type ChunkParams = { target: number; max: number; overlap: number; min: number };

// Bump whenever an extractor, the chunker, text normalisation or any other
// rule that shapes a document or its chunks changes. It is part of every
// doc_hash, so the next backfill/reconcile reprocesses every document ONCE
// (chunks whose embedded text is unchanged keep their vectors), after which the
// ingester is idempotent again. Must equal public.ai_pipeline_version() in SQL
// (the worker refuses to run otherwise; a unit test checks the migrations).
export const PIPELINE_VERSION = '2026-09-28.1';

// §6.2. ai_doc (imported SOP text) uses the kb_article sizes: same content.
const SMALL: ChunkParams = { target: 450, max: 700, overlap: 50, min: 30 };
export const CHUNK_PARAMS: Readonly<Record<string, ChunkParams>> = Object.freeze({
  report:              { target: 450, max: 700, overlap: 60, min: 40 },
  kb_article:          { target: 550, max: 800, overlap: 80, min: 60 },
  ai_doc:              { target: 550, max: 800, overlap: 80, min: 60 },
  app_guide:           { target: 500, max: 800, overlap: 60, min: 60 },
  tts_article:         { target: 600, max: 750, overlap: 90, min: 60 },
  gmv_max_report:      SMALL,
  agenda_task:         SMALL,
  agenda_presentation: SMALL,
  brand_profile:       SMALL,
  incentive:           SMALL,
});

export function chunkParamsFor(sourceType: string): ChunkParams {
  return CHUNK_PARAMS[sourceType] ?? SMALL;
}

// Everything besides the extractor code that shapes a source type's chunks.
// It goes into doc_hash (QA F2), so changing a chunk size re-chunks that type
// on its next pass even before PIPELINE_VERSION is bumped; a unit test pins
// these values next to the version so the bump (which is what makes
// backfill/reconcile pick the change up) cannot be forgotten.
export function pipelineSalt(sourceType: string, version: string = PIPELINE_VERSION): string {
  const p = chunkParamsFor(sourceType);
  return `${version}|${p.target}/${p.max}/${p.overlap}/${p.min}|${DEFAULT_CONFIG.TABLE_ROWS_PER_CHUNK}/${DEFAULT_CONFIG.MAX_CHUNKS_PER_DOC}/${DEFAULT_CONFIG.EMBED_MAX_TOKENS}`;
}

export const DEFAULT_CONFIG = Object.freeze({
  // Chunking
  TABLE_ROWS_PER_CHUNK: 12,
  MAX_CHUNKS_PER_DOC: 40,
  // Embedding
  EMBED_MODEL: 'text-embedding-3-small',
  EMBED_DIMS: 1536,
  EMBED_BATCH_INPUTS: 96,
  EMBED_BATCH_TOKENS: 250_000,
  EMBED_MAX_TOKENS: 7500,
  EMBED_CONCURRENCY: 2,
  EMBED_MAX_RETRIES: 4,
  EMBED_TIMEOUT_MS: 30_000,
  QUERY_EMBED_CACHE_TTL_MS: 600_000,
  // Index / retrieval
  HNSW_M: 16,
  HNSW_EF_CONSTRUCTION: 64,
  EF_SEARCH: 100,
  SEMANTIC_CANDIDATES: 60,
  KEYWORD_CANDIDATES: 60,
  RRF_K: 60,
  RRF_WEIGHT_SEMANTIC: 1.0,
  RRF_WEIGHT_KEYWORD: 1.0,
  TOP_K: 8,
  MAX_CHUNKS_PER_DOC_IN_RESULTS: 3,
  RECENCY_HALF_LIFE_DAYS: 120,
  RERANK_ENABLED: false,
  RERANK_CANDIDATES: 30,
  RETRIEVAL_TOKEN_BUDGET: 3500,
  // Agent
  MAX_ROUNDS: 3,
  MAX_PARALLEL_TOOLS: 4,
  TOOL_ROUND_MAX_OUTPUT_TOKENS: 1200,
  ANSWER_MAX_OUTPUT_TOKENS: 2500,
  ANSWER_RETRY_MAX_OUTPUT_TOKENS: 6000,
  EFFORT_TOOL_ROUNDS: 'none',
  EFFORT_ANSWER: 'low',
  COST_CEILING_TOKENS: 60_000,
  TOOL_RESULT_CHAR_CAP: 6000,
  HISTORY_TURNS: 12,
  HISTORY_CHAR_CAP: 6000,
  // Limits
  MESSAGE_MAX_CHARS: 4000,
  RATE_LIMIT_PER_USER_PER_HOUR: 30,
  // Ingest
  WORKER_TIME_BUDGET_MS: 100_000,
  CLAIM_BATCH: 20,
  LOCK_TIMEOUT_MS: 600_000,
  MAX_ATTEMPTS: 5,
  // Crawl
  CRAWL_BATCH: 20,
  CRAWL_GAP_MS: 2500,
  CRAWL_JITTER_MS: 1000,
  CRAWL_MAX_ATTEMPTS: 6,
  CRAWL_STALE_AFTER_MISSES: 3,
  // Brand profiles
  BRAND_PROFILE_MAX_PER_NIGHT: 60,
  BRAND_PROFILE_WORDS: 400,
});

export type Config = { -readonly [K in keyof typeof DEFAULT_CONFIG]: (typeof DEFAULT_CONFIG)[K] };

// The ⚙ column of §17.
export const OVERRIDABLE: ReadonlySet<keyof Config> = new Set<keyof Config>([
  'EF_SEARCH', 'SEMANTIC_CANDIDATES', 'KEYWORD_CANDIDATES', 'RRF_K', 'RRF_WEIGHT_SEMANTIC',
  'RRF_WEIGHT_KEYWORD', 'TOP_K', 'MAX_CHUNKS_PER_DOC_IN_RESULTS', 'RECENCY_HALF_LIFE_DAYS',
  'RERANK_ENABLED', 'RERANK_CANDIDATES', 'RETRIEVAL_TOKEN_BUDGET', 'MAX_ROUNDS',
  'ANSWER_MAX_OUTPUT_TOKENS', 'ANSWER_RETRY_MAX_OUTPUT_TOKENS', 'EFFORT_TOOL_ROUNDS',
  'EFFORT_ANSWER', 'COST_CEILING_TOKENS', 'RATE_LIMIT_PER_USER_PER_HOUR',
]);

// Merge ai_assistant_config.retrieval into the defaults. The jsonb is
// admin-edited, so every value is validated: unknown keys, non-⚙ keys, wrong
// types and non-positive numbers are skipped and reported in `ignored`.
export function withOverrides(raw: unknown): { config: Config; ignored: string[] } {
  const config = { ...DEFAULT_CONFIG } as Config;
  const ignored: string[] = [];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { config, ignored };
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!OVERRIDABLE.has(key as keyof Config)) { ignored.push(key); continue; }
    const def = (DEFAULT_CONFIG as Record<string, unknown>)[key];
    const ok = typeof value === typeof def &&
      (typeof value !== 'number' || (Number.isFinite(value) && value > 0));
    if (!ok) { ignored.push(key); continue; }
    (config as Record<string, unknown>)[key] = value;
  }
  return { config, ignored };
}
