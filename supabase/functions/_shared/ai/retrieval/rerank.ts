// Query embedding with a short cache (A§10.1 step 3), and the optional LLM
// rerank (phase5-design.md §2.5; off unless RERANK_ENABLED). The API key is
// always passed in; nothing here reads the environment.

import { embedTexts } from '../embedder.ts';
import type { Reranker } from './search.ts';

export function cachedEmbedder(embed: (text: string) => Promise<number[]>, ttlMs: number, max = 500,
  clock: () => number = Date.now): (text: string) => Promise<number[]> {
  const cache = new Map<string, { at: number; v: Promise<number[]> }>();
  return (text: string) => {
    const key = text.trim();
    const hit = cache.get(key);
    if (hit && clock() - hit.at < ttlMs) return hit.v;
    const v = embed(key);
    v.catch(() => cache.delete(key));
    cache.set(key, { at: clock(), v });
    if (cache.size > max) cache.delete(cache.keys().next().value!);
    return v;
  };
}

export function openAiQueryEmbedder(apiKey: string, fetchImpl?: typeof fetch): (text: string) => Promise<number[]> {
  return async (text) => (await embedTexts([text], { apiKey, fetchImpl, maxRetries: 1, timeoutMs: 10_000 })).vectors[0];
}

// One call scores every candidate 0–10 for "answers the question". Output is
// forced to JSON; a malformed reply throws and searchIndex keeps its order.
export function openAiReranker(opts: {
  apiKey: string; model: string; fetchImpl?: typeof fetch; timeoutMs?: number;
  onUsage?: (u: { input_tokens: number; output_tokens: number }) => void;
}): Reranker {
  const doFetch = opts.fetchImpl ?? fetch;
  return async (query, items) => {
    const list = items.map((it, i) => `[${i}] ${it.title}\n${it.text.slice(0, 1200)}`).join('\n\n');
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 15_000);
    try {
      const res = await doFetch('https://api.openai.com/v1/responses', {
        method: 'POST',
        signal: ctrl.signal,
        headers: { 'content-type': 'application/json', authorization: `Bearer ${opts.apiKey}` },
        body: JSON.stringify({
          model: opts.model,
          reasoning: { effort: 'low' },
          input: [
            { role: 'system', content: 'Score how well each passage helps answer the question, 0 (useless) to 10 (answers it). Reply with JSON only: {"scores":[n,…]} in passage order.' },
            { role: 'user', content: `Question: ${query}\n\nPassages:\n${list}` },
          ],
          text: { format: { type: 'json_object' } },
        }),
      });
      if (!res.ok) throw new Error(`rerank HTTP ${res.status}`);
      const json = await res.json();
      if (json.usage) opts.onUsage?.({ input_tokens: json.usage.input_tokens ?? 0, output_tokens: json.usage.output_tokens ?? 0 });
      const text = json.output_text ?? json.output?.flatMap((o: any) => o.content ?? []).find((c: any) => c.type === 'output_text')?.text;
      const scores = JSON.parse(String(text)).scores;
      if (!Array.isArray(scores) || scores.length !== items.length) throw new Error('rerank: bad scores');
      return scores.map(Number);
    } finally {
      clearTimeout(timer);
    }
  };
}
