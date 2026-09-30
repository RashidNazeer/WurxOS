// Model-provider account problems (QA 2026-10-01 F3): no credits / quota left,
// or a key the API refuses. Retrying them only burns time, and they need a
// person (the Boss) rather than another attempt. Works on LlmError and
// EmbedError, which both carry the HTTP status and the start of the body.
//
// 'limit':     a rate limit whose wait is long (a free model's token allowance
//              is used up: "try again in 36h54m…", seen live 2026-10-01).
// 'too_large': the request is bigger than the model's free per-minute budget
//              (Groq 413 "Request too large … TPM: Limit 8000"): no wait helps.
// Either way the turn moves on to the next model.

export type ProviderIssue = 'quota' | 'auth' | 'limit' | 'too_large';

const QUOTA_RE = /insufficient_quota|credit_balance_exhausted|no credits remaining|credit balance is exhausted|exceeded your current quota|billing_hard_limit|RESOURCE_EXHAUSTED/i;
const AUTH_RE = /invalid_api_key|incorrect api key|invalid authentication|API key not valid|API_KEY_INVALID/i;
const RATE_RE = /rate_limit_exceeded|rate limit reached|rate limit/i;
const TOO_LARGE_RE = /request too large|reduce your message size|context_length_exceeded|maximum context length/i;
export const LONG_LIMIT_MS = 60_000;

// "try again in 36h54m25.92s" / "in 1.2s" / "in 850ms" (OpenAI, Groq), "Please retry in 37.5s"
// or "retryDelay": "37s" (Gemini) → ms; null when absent.
export function retryAfterMs(text: string): number | null {
  const m = /(?:try again|retry) in ((?:\d+(?:\.\d+)?(?:h|ms|m|s))+)/i.exec(text) ?? /retryDelay"?\s*:\s*"((?:\d+(?:\.\d+)?s))"/i.exec(text);
  if (!m) return null;
  let ms = 0;
  for (const [, n, u] of m[1].matchAll(/(\d+(?:\.\d+)?)(h|ms|m|s)/g)) ms += Number(n) * ({ h: 3_600_000, m: 60_000, s: 1000, ms: 1 } as Record<string, number>)[u];
  return Math.round(ms);
}

export function providerAccountIssue(e: unknown): ProviderIssue | null {
  const status = Number((e as { status?: number })?.status);
  const text = `${(e as { code?: string })?.code ?? ''} ${String((e as Error)?.message ?? e ?? '')}`;
  const wait = (e as { retryAfterMs?: number })?.retryAfterMs ?? retryAfterMs(text);
  if (status === 401 || AUTH_RE.test(text)) return 'auth';
  if (status === 413 || TOO_LARGE_RE.test(text)) return 'too_large';
  // Gemini's free per-minute quota also says "exceeded your current quota", but
  // with a wait: that one is a passing rate limit, not an empty account.
  if (QUOTA_RE.test(text) && wait == null) return 'quota';
  if (status === 429 || RATE_RE.test(text) || QUOTA_RE.test(text)) {
    if (wait != null && wait > LONG_LIMIT_MS) return 'limit';
  }
  return null;
}

// Provider text can quote a (masked) key: never store or print it.
export const scrubSecrets = (s: string) => s.replace(/\b(sk|rk|gsk)[-_][A-Za-z0-9_\-*]{4,}/g, '$1-…').replace(/\bAIza[A-Za-z0-9_\-*]{8,}/g, 'AIza…');

const aboutHours = (ms: number) => (ms >= 5_400_000 ? `about ${Math.round(ms / 3_600_000)} h` : `about ${Math.max(1, Math.round(ms / 60_000))} min`);

// Per key slot: who to blame, and which function secret holds the key.
const SLOT_INFO: Record<string, { provider: string; secret: string; openai: boolean }> = {
  primary: { provider: 'OpenAI', secret: 'OPEN_AI_API_KEY', openai: true },
  fallback: { provider: 'OpenAI', secret: 'OPEN_AI_API_KEY_FALLBACK', openai: true },
  groq: { provider: 'Groq', secret: 'GROQ_API_KEY', openai: false },
  gemini: { provider: 'Gemini', secret: 'GEMINI_API_KEY', openai: false },
};

export type ChainIssue = { issue: ProviderIssue; model?: string; slot?: string; waitMs?: number | null };

// What people are told. The user gets no technical detail; the Boss gets what to do.
// `chain`: every account problem met this turn, in order (the main model, then fallbacks).
export function providerIssueMessage(issue: ProviderIssue, role: string, chain: ChainIssue[] = []): string {
  const all = chain.length ? chain : [{ issue }];
  const boss = String(role).toLowerCase() === 'boss';
  if (!boss) {
    return all.every((c) => c.issue === 'limit' || c.issue === 'too_large')
      ? 'Buddy has reached its AI usage limit for now. Please try again later, or tell the Boss.'
      : "Buddy can't reach its AI service right now: the AI account needs attention. Please tell the Boss.";
  }
  const parts = new Set<string>();
  for (const c of all) {
    const s = SLOT_INFO[c.slot ?? 'primary'] ?? SLOT_INFO.primary;
    if (c.issue === 'quota') {
      parts.add(s.openai ? 'OpenAI credits are used up: top up the OpenAI account (platform.openai.com → Billing).'
        : `${s.provider} has no free quota left on its key${c.model ? ` (${c.model})` : ''}.`);
    } else if (c.issue === 'auth') {
      parts.add(`${s.provider} refused an API key: check the ${s.secret} secret of the assistant function.`);
    } else if (c.issue === 'limit') {
      // OpenAI's wait is for a request of THIS size to fit (it did not count down
      // between calls, live 2026-10-01), so it is an estimate, not a reset time.
      parts.add(`${c.model ?? 'The model'} has used up its ${s.provider} token allowance${c.waitMs ? ` (${s.provider} estimates ${aboutHours(c.waitMs)} before a question fits again)` : ''}.`);
    } else {
      parts.add(`${c.model ?? 'The model'} cannot take a question this size on its free ${s.provider} tier.`);
    }
  }
  return [...parts].join(' ');
}
