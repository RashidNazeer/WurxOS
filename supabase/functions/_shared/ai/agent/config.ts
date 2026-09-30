// Agent parameters (phase5-design.md §7). Overridable from
// ai_assistant_config.retrieval (the same jsonb as the retrieval keys; keys
// unknown here are ignored).

export const AGENT_DEFAULTS = Object.freeze({
  MAX_ROUNDS: 3,                    // tool rounds; then one answer call without tools
  MAX_PARALLEL_TOOLS: 4,            // per round; extra calls get a "skipped" result
  COST_CEILING_TOKENS: 60_000,      // input + output across every call of one question
  TOOL_ROUND_MAX_OUTPUT_TOKENS: 2500,
  ANSWER_MAX_OUTPUT_TOKENS: 2500,
  ANSWER_RETRY_MAX_OUTPUT_TOKENS: 6000,
  EFFORT_TOOL_ROUNDS: 'low',
  EFFORT_ANSWER: 'low',
  HISTORY_TURNS: 12,
  HISTORY_CHAR_CAP: 6000,
  MESSAGE_MAX_CHARS: 4000,
  RATE_LIMIT_PER_USER_PER_HOUR: 30,
  RATE_LIMIT_EXEMPT_USERS: [] as string[],   // eval users
  SEARCH_TIMEOUT_MS: 20_000,        // dev vector search is slow cold (WP-A issue 1); prod target is far lower
  DATA_TOOL_TIMEOUT_MS: 25_000,
  MODEL_TIMEOUT_MS: 90_000,         // per model call; every call is also bounded by the turn deadline
  // The whole turn, tools included, well inside the edge wall clock (150 s on
  // the free plan). Past it the partial answer is saved as status 'error'.
  TURN_DEADLINE_MS: 110_000,
  TOOL_ROUND_MIN_LEFT_MS: 35_000,   // less left than this → no more tool rounds, answer now
  ANSWER_RESERVE_MS: 20_000,        // time kept back from the tools for the answer
  CANCEL_POLL_MS: 1500,             // how often a running turn checks for Stop
  TOOL_RESULT_CHAR_CAP: 6000,
  LOG_RESULT_PREVIEW_CHARS: 2000,
  // Prices: ai_assistant_config.prices (mig 387), fallback ../prices.ts.
});

type Widen<T> = T extends number ? number : T extends string ? string : T;
export type AgentConfig = { -readonly [K in keyof typeof AGENT_DEFAULTS]: Widen<(typeof AGENT_DEFAULTS)[K]> };

const EFFORTS = new Set(['none', 'minimal', 'low', 'medium', 'high']);

export function agentConfig(raw?: unknown): AgentConfig {
  const cfg = { ...AGENT_DEFAULTS, RATE_LIMIT_EXEMPT_USERS: [] as string[] } as AgentConfig;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return cfg;
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!(k in AGENT_DEFAULTS)) continue;
    const def = (AGENT_DEFAULTS as Record<string, unknown>)[k];
    if (Array.isArray(def)) { if (Array.isArray(v) && v.every((x) => typeof x === 'string')) (cfg as any)[k] = [...v]; continue; }
    if (typeof def === 'number') { if (typeof v === 'number' && Number.isFinite(v) && v > 0) (cfg as any)[k] = v; continue; }
    if (k.startsWith('EFFORT_')) { if (EFFORTS.has(String(v))) (cfg as any)[k] = v; continue; }
  }
  return cfg;
}
