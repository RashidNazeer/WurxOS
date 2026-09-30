// OpenAI prices, USD per 1M tokens. The source of truth is
// ai_assistant_config.prices (mig 387, Boss-editable); these are only the
// fallback when that row can't be read, and must match the migration's default.
// ASSUMED values: verify against OpenAI's price list.

export type Price = { in: number; cached: number; out: number };
export type Prices = Record<string, Price>;

export const DEFAULT_PRICES: Readonly<Prices> = Object.freeze({
  'gpt-5.4-mini': { in: 0.75, cached: 0.075, out: 4.5 },
  'gpt-5.5': { in: 5, cached: 0.5, out: 30 },
  // ASSUMED, not a verified list price (2026-09-30): check OpenAI's price page.
  'gpt-5.4-nano': { in: 0.2, cached: 0.02, out: 1.25 },
  // Answers free on the fallback key (Lead's probe, 2026-10-01).
  'gpt-6-luna': { in: 0, cached: 0, out: 0 },
  'text-embedding-3-small': { in: 0.02, cached: 0.02, out: 0 },
});

// The stored table over the defaults; a malformed entry is ignored.
export function pricesFrom(raw: unknown): Prices {
  const out: Prices = { ...DEFAULT_PRICES };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const [model, p] of Object.entries(raw as Record<string, any>)) {
    const v = { in: Number(p?.in), cached: Number(p?.cached ?? p?.in), out: Number(p?.out ?? 0) };
    if ([v.in, v.cached, v.out].every((x) => Number.isFinite(x) && x >= 0)) out[model] = v;
  }
  return out;
}

export type TokenUsage = { input: number; cached?: number; output?: number };

// Cached input tokens are part of `input` (as OpenAI reports them) and are
// billed at the cached rate. An unknown model costs 0 and says so.
export function costUsd(prices: Prices, model: string, u: TokenUsage): { usd: number; priced: boolean } {
  const p = prices[model];
  if (!p) return { usd: 0, priced: false };
  const cached = Math.min(Math.max(u.cached ?? 0, 0), Math.max(u.input, 0));
  const usd = ((Math.max(u.input, 0) - cached) * p.in + cached * p.cached + Math.max(u.output ?? 0, 0) * p.out) / 1e6;
  return { usd, priced: true };
}

// Per-question spend outside the chat model: reranks and query embeddings.
export class UsageMeter {
  rerank = { calls: 0, input: 0, cached: 0, output: 0, model: '' };
  embed = { calls: 0, input: 0, model: '', keySlot: 'primary' as 'primary' | 'fallback' };
  onRerank = (model: string) => (u: { input_tokens: number; output_tokens: number; cached_tokens?: number }) => {
    this.rerank.calls++;
    this.rerank.input += u.input_tokens ?? 0;
    this.rerank.cached += u.cached_tokens ?? 0;
    this.rerank.output += u.output_tokens ?? 0;
    this.rerank.model = model;
  };
  onEmbed = (model: string, keySlot: 'primary' | 'fallback' = 'primary') => (tokens: number) => {
    this.embed.calls++;
    this.embed.input += tokens ?? 0;
    this.embed.model = model;
    this.embed.keySlot = keySlot;
  };
}
