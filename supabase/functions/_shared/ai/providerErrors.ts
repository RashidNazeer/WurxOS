// OpenAI account problems (QA 2026-10-01 F3): no credits left, or a key the
// API refuses. Retrying them only burns time, and they need a person (the
// Boss) rather than another attempt. Works on LlmError and EmbedError, which
// both carry the HTTP status and the start of the response body.

export type ProviderIssue = 'quota' | 'auth';

const QUOTA_RE = /insufficient_quota|no credits remaining|exceeded your current quota|billing_hard_limit/i;
const AUTH_RE = /invalid_api_key|incorrect api key|invalid authentication/i;

export function providerAccountIssue(e: unknown): ProviderIssue | null {
  const status = Number((e as { status?: number })?.status);
  const text = String((e as Error)?.message ?? e ?? '');
  if (QUOTA_RE.test(text)) return 'quota';
  if (status === 401 || AUTH_RE.test(text)) return 'auth';
  return null;
}

// What people are told. The user gets no technical detail; the Boss gets what to do.
export function providerIssueMessage(issue: ProviderIssue, role: string): string {
  if (String(role).toLowerCase() !== 'boss') {
    return "Buddy can't reach its AI service right now: the AI account needs attention. Please tell the Boss.";
  }
  return issue === 'quota'
    ? 'OpenAI credits are used up: top up the OpenAI account (platform.openai.com → Billing).'
    : 'OpenAI refused the API key: check the OPEN_AI_API_KEY secret of the assistant function (platform.openai.com → API keys).';
}
