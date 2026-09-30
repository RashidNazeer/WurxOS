// OpenAI account problems (QA 2026-10-01 F3): no credits left, or a key the
// API refuses. Retrying them only burns time, and they need a person (the
// Boss) rather than another attempt. Works on LlmError and EmbedError, which
// both carry the HTTP status and the start of the response body.
//
// 'limit': a rate limit whose wait is long (a free model's token allowance is
// used up: "try again in 36h54m…", seen live 2026-10-01). Like no credits, a
// retry within the turn cannot help, so the chain moves on.

export type ProviderIssue = 'quota' | 'auth' | 'limit';

const QUOTA_RE = /insufficient_quota|credit_balance_exhausted|no credits remaining|credit balance is exhausted|exceeded your current quota|billing_hard_limit/i;
const AUTH_RE = /invalid_api_key|incorrect api key|invalid authentication/i;
const RATE_RE = /rate_limit_exceeded|rate limit reached|rate limit/i;
export const LONG_LIMIT_MS = 60_000;

// "Please try again in 36h54m25.92s" / "in 1.2s" / "in 850ms" → ms (null if absent).
export function retryAfterMs(text: string): number | null {
  const m = /try again in ((?:\d+(?:\.\d+)?(?:h|ms|m|s))+)/i.exec(text);
  if (!m) return null;
  let ms = 0;
  for (const [, n, u] of m[1].matchAll(/(\d+(?:\.\d+)?)(h|ms|m|s)/g)) ms += Number(n) * ({ h: 3_600_000, m: 60_000, s: 1000, ms: 1 } as Record<string, number>)[u];
  return Math.round(ms);
}

export function providerAccountIssue(e: unknown): ProviderIssue | null {
  const status = Number((e as { status?: number })?.status);
  const text = `${(e as { code?: string })?.code ?? ''} ${String((e as Error)?.message ?? e ?? '')}`;
  if (QUOTA_RE.test(text)) return 'quota';
  if (status === 401 || AUTH_RE.test(text)) return 'auth';
  if (status === 429 || RATE_RE.test(text)) {
    const wait = (e as { retryAfterMs?: number })?.retryAfterMs ?? retryAfterMs(text);
    if (wait != null && wait > LONG_LIMIT_MS) return 'limit';
  }
  return null;
}

// Provider text can quote a (masked) key: never store or print it.
export const scrubSecrets = (s: string) => s.replace(/\b(sk|rk)-[A-Za-z0-9_\-*]{4,}/g, '$1-…');

const aboutHours = (ms: number) => (ms >= 5_400_000 ? `about ${Math.round(ms / 3_600_000)} h` : `about ${Math.max(1, Math.round(ms / 60_000))} min`);

// What people are told. The user gets no technical detail; the Boss gets what to do.
// `chain`: every account problem met this turn, in order (the main model, then fallbacks).
export function providerIssueMessage(issue: ProviderIssue, role: string, chain: { issue: ProviderIssue; model?: string; waitMs?: number | null }[] = []): string {
  const all = chain.length ? chain : [{ issue }];
  const boss = String(role).toLowerCase() === 'boss';
  if (!boss) {
    return all.every((c) => c.issue === 'limit')
      ? 'Buddy has reached its AI usage limit for now. Please try again later, or tell the Boss.'
      : "Buddy can't reach its AI service right now: the AI account needs attention. Please tell the Boss.";
  }
  const parts: string[] = [];
  if (all.some((c) => c.issue === 'quota')) parts.push('OpenAI credits are used up: top up the OpenAI account (platform.openai.com → Billing).');
  if (all.some((c) => c.issue === 'auth')) parts.push('OpenAI refused an API key: check the OPEN_AI_API_KEY / OPEN_AI_API_KEY_FALLBACK secrets of the assistant function (platform.openai.com → API keys).');
  for (const c of all.filter((x) => x.issue === 'limit')) {
    // OpenAI's wait is for a request of THIS size to fit (it did not count down
    // between calls, live 2026-10-01), so it is an estimate, not a reset time.
    parts.push(`${c.model ?? 'The model'} has used up its OpenAI token allowance${c.waitMs ? ` (OpenAI estimates ${aboutHours(c.waitMs)} before a question fits again)` : ''}.`);
  }
  return parts.join(' ');
}
