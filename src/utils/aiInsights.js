/**
 * v1 AI insights helpers — stubbed in v2.
 *
 * v1 used Firebase's Gemini integration (`geminiModel.generateContent`)
 * to auto-generate per-section narrative for weekly/biweekly/monthly
 * reports. v2 is on Supabase (no Firebase Gemini). Wiring up an LLM
 * call requires:
 *   1. An API key stored in Supabase secrets (NOT in client bundles)
 *   2. An Edge Function that proxies the call (so the key stays server-side)
 *   3. A v2 client wrapper that calls the Edge Function
 *
 * That's a substantial standalone task; until it's done, every "Generate
 * with AI" button surfaces this error. The v1 forms already wrap these
 * calls in try/catch so the UI degrades to a clear toast — users can
 * still write narrative manually as they always could.
 *
 * To enable AI later: replace these implementations with a fetch() to
 * a Supabase Edge Function. Signatures stay identical so v1 markup
 * doesn't need to change.
 */

const NOT_AVAILABLE_MSG =
  'AI insights are not yet available in v2. Please write this section manually for now.';

function _stub() {
  return Promise.reject(new Error(NOT_AVAILABLE_MSG));
}

export const generateOverallInsight         = _stub;
export const generateCreatorsInsight        = _stub;
export const generateVideosInsight          = _stub;
export const generateGmvMaxInsight          = _stub;
export const generateProductsInsight        = _stub;
export const generateOffsiteInsight         = _stub;
export const generateAllInsights            = _stub;
export const generateMonthlyKeyWinsInsight  = _stub;
