// A short cache for query embeddings (A§10.1 step 3). The OpenAI query embedder and LLM reranker that
// lived here are gone: free providers only (see agent/server.ts for the query embedders).


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

