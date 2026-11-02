// Model catalog, fallback chain, parameter compatibility, keyword-only search
// (mig 397). All faked: no API calls.
import { beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { _resetCooldowns, chatModels, chooseTargets, modelUsable, omitFor, refreshModels, resolveRoleConfig, unsupportedParam, type CatalogRow, type KeySlot } from '../agent/models.ts';

beforeEach(() => _resetCooldowns());
import { runTurn } from '../agent/core.ts';
import { chainEmbedder, _resetEmbedDown } from '../agent/server.ts';
import { LlmError, requestBody, respond, type LlmRequest, type LlmResult } from '../llm/openai.ts';
import { pricesFrom, UsageMeter } from '../prices.ts';
import { providerAccountIssue, providerIssueMessage, retryAfterMs, scrubSecrets } from '../providerErrors.ts';
import { embedTexts } from '../embedder.ts';

const QUOTA = JSON.stringify({ error: { message: 'Your credit balance is exhausted.', type: 'insufficient_quota', code: 'credit_balance_exhausted' } });
const row = (slot: KeySlot, model: string, o: Partial<CatalogRow> = {}): CatalogRow =>
  ({ key_slot: slot, model, available: true, supports_tools: true, supports_stream: true, free: true, params: {}, ...o });
const KEYS = { gemini: 'gk', groq: 'qk', fallback: 'fk' };

// ── catalog ─────────────────────────────────────────────────────────────────

test('chatModels: chat models only; a dated snapshot only when its alias is missing; the OpenAI key lists only the free model', () => {
  const ids = ['gemini-3.6-flash', 'gemini-3.6-flash-2026-03-17', 'gemini-3.5-flash-2026-03-17', 'imagen-4', 'gemini-2.5-flash-tts', 'text-embedding-004', 'gemini-live-2.5-flash'];
  assert.deepEqual(chatModels(ids, 'gemini'), ['gemini-3.5-flash-2026-03-17', 'gemini-3.6-flash']);
  // OpenAI: nothing is probed or offered except the free-tier model (a probe is a real call)
  const oa = ['gpt-5.4-mini', 'gpt-5.4-nano', 'gpt-5.5', 'gpt-4o-mini', 'o4-mini', 'gpt-6-luna'];
  assert.deepEqual(chatModels(oa, 'fallback'), ['gpt-6-luna']);
});

test('modelUsable: the OpenAI key only ever allows the free model; a catalogued key needs tools + stream; the old primary slot is nothing', () => {
  assert.equal(modelUsable([], 'fallback', 'gpt-6-luna'), true);
  for (const paid of ['gpt-5.5', 'gpt-5.4-nano', 'gpt-5.4-mini', 'gpt-4o']) assert.equal(modelUsable([], 'fallback', paid), false);
  // even a catalog row that claims a paid model is available does not unlock it
  assert.equal(modelUsable([row('fallback', 'gpt-5.5')], 'fallback', 'gpt-5.5'), false);
  // the catalog must mark the free model free
  assert.equal(modelUsable([row('fallback', 'gpt-6-luna', { free: false })], 'fallback', 'gpt-6-luna'), false);
  assert.equal(modelUsable([row('fallback', 'gpt-6-luna')], 'fallback', 'gpt-6-luna'), true);
  const cat = [row('gemini', 'g-ok'), row('gemini', 'g-nostream', { supports_stream: false }), row('gemini', 'g-gone', { available: false })];
  assert.deepEqual(['g-ok', 'g-nostream', 'g-gone', 'g-unknown'].map((m) => modelUsable(cat, 'gemini', m)), [true, false, false, false]);
  assert.equal(modelUsable([], 'gemini', 'anything'), true);        // a slot not listed yet is tried anyway
  assert.equal(modelUsable([], 'primary' as any, 'gpt-5.4-mini'), false);
});

test('chooseTargets: configured model first, then the fallbacks in order; bad entries skipped; never empty', () => {
  const cfg = { model: 'gemini-3.5-flash-lite', model_key_slot: 'gemini', fallback_enabled: true,
    fallback_models: [{ key_slot: 'groq', model: 'openai/gpt-oss-120b' }, { key_slot: 'gemini', model: 'gemini-3.5-flash-lite' }, { key_slot: 'groq', model: 'nope' }, { key_slot: 'fallback', model: 'gpt-6-luna' }] };
  const cat = [row('gemini', 'gemini-3.5-flash-lite'), row('groq', 'openai/gpt-oss-120b'), row('fallback', 'gpt-6-luna')];
  assert.deepEqual(chooseTargets(cfg, cat, KEYS), [
    { keySlot: 'gemini', model: 'gemini-3.5-flash-lite' }, { keySlot: 'groq', model: 'openai/gpt-oss-120b' }, { keySlot: 'fallback', model: 'gpt-6-luna' }]);
  // no Groq key: its entry is dropped; disabled chain: just the model
  assert.deepEqual(chooseTargets(cfg, cat, { gemini: 'gk', fallback: 'fk' }).map((t) => t.model), ['gemini-3.5-flash-lite', 'gpt-6-luna']);
  assert.deepEqual(chooseTargets({ ...cfg, fallback_enabled: false }, cat, KEYS).length, 1);
  // an unusable configured model: the default free chain starts
  assert.deepEqual(chooseTargets({ model: 'mystery', model_key_slot: 'gemini' }, cat, KEYS)[0], { keySlot: 'gemini', model: 'gemini-3.5-flash-lite' });
  assert.ok(chooseTargets({}, [], {}).length === 1, 'no key anywhere: one doomed target so the turn fails with a clear message');
  // an uncatalogued slot: tried anyway
  assert.equal(chooseTargets({ model: 'x', model_key_slot: 'gemini', fallback_models: [{ key_slot: 'groq', model: 'y' }] }, [], KEYS).length, 2);
});

test('legacy rows: slot "primary" (the removed paid key) and paid OpenAI models do not crash and resolve to the free chain', () => {
  const cat = [row('gemini', 'gemini-3.5-flash-lite'), row('gemini', 'gemini-3.6-flash'), row('groq', 'openai/gpt-oss-120b'), row('fallback', 'gpt-6-luna')];
  const legacy = { model: 'gpt-5.4-nano', model_key_slot: 'primary', fallback_enabled: true, fallback_models: [
    { key_slot: 'gemini', model: 'gemini-3.6-flash' }, { key_slot: 'primary', model: 'gpt-5.5' }, { key_slot: 'fallback', model: 'gpt-5.4-mini' }, { key_slot: 'fallback', model: 'gpt-6-luna' }] };
  assert.deepEqual(chooseTargets(legacy, cat, KEYS), [{ keySlot: 'gemini', model: 'gemini-3.6-flash' }, { keySlot: 'fallback', model: 'gpt-6-luna' }]);
  // nothing usable left in the row at all: the default free chain
  const bare = chooseTargets({ model: 'gpt-5.4-nano', model_key_slot: 'primary', fallback_models: [{ key_slot: 'primary', model: 'gpt-5.5' }] }, cat, KEYS);
  assert.deepEqual(bare.map((t) => t.keySlot), ['gemini', 'groq', 'gemini', 'fallback']);
  assert.ok(bare.every((t) => t.keySlot !== ('primary' as any) && !/^gpt-5/.test(t.model)));
  // a role model on the old slot (or with no slot, which used to mean it) is ignored; the global model stays
  const rm = { tl: { model: 'gpt-5.4-nano' }, ol: { model: 'gpt-5.5', key_slot: 'primary' }, apc: { model: 'm', key_slot: 'groq' } };
  for (const role of ['tl', 'ol']) assert.deepEqual([resolveRoleConfig({ model: 'g', model_key_slot: 'gemini', role_models: rm }, role).model, resolveRoleConfig({ model: 'g', model_key_slot: 'gemini', role_models: rm }, role).model_source], ['g', 'global']);
  assert.equal(resolveRoleConfig({ model: 'g', model_key_slot: 'gemini', role_models: rm }, 'apc').model_key_slot, 'groq');
});

test('parameter compatibility: which field to drop, and the request without it', () => {
  const e = (code: string, param: string) => new LlmError(`model HTTP 400: {"error":{"message":"Unsupported parameter","type":"invalid_request_error","param":"${param}","code":"${code}"}}`, 400);
  assert.equal(unsupportedParam(e('unsupported_parameter', 'reasoning.effort')), 'reasoning');
  assert.equal(unsupportedParam(e('unsupported_value', 'include')), 'include');
  assert.equal(unsupportedParam(e('unsupported_parameter', 'tools')), null);       // Buddy cannot live without tools
  assert.equal(unsupportedParam(new LlmError('model HTTP 429: ...', 429)), null);
  const input: any[] = [{ role: 'user', content: 'q' }, { type: 'reasoning', id: 'r1' }, { type: 'function_call', call_id: 'c' }];
  const b = requestBody({ apiKey: 'k', model: 'm', instructions: 'i', input, effort: 'low', omit: ['reasoning', 'include'] }) as any;
  assert.equal(b.reasoning, undefined);
  assert.equal(b.include, undefined);
  assert.deepEqual(b.input.map((x: any) => x.type ?? x.role), ['user', 'function_call']);   // reasoning items dropped with include
  assert.deepEqual(omitFor([row('gemini', 'm', { params: { omit: ['text'] } })], { keySlot: 'gemini', model: 'm' }), ['text']);
});

// ── the turn ────────────────────────────────────────────────────────────────

function db(tables: Record<string, any[]> = {}) {
  const inserts: Record<string, any[]> = {};
  const updates: any[] = [];
  let seq = 0;
  const base: Record<string, any[]> = { ai_assistant_config: [{ id: 1, persona: '', model: 'gemini-3.5-flash-lite', enabled: true, retrieval: {}, prices: {},
    model_key_slot: 'gemini', fallback_enabled: true, fallback_models: [{ key_slot: 'fallback', model: 'gpt-6-luna' }] }], ...tables };
  const from = (table: string) => {
    let op = 'select'; let payload: any = null; const where: any = {};
    const q: any = {
      select: () => q, eq: (k: string, v: any) => { if (op === 'update') where[k] = v; return q; },
      neq: () => q, lt: () => q, gte: () => q, in: () => q, order: () => q, limit: () => q, not: () => q,
      insert: (p: any) => { op = 'insert'; payload = [].concat(p).map((r: any) => ({ id: `${table}-${++seq}`, ...r })); (inserts[table] ??= []).push(...payload); return q; },
      upsert: (p: any) => { op = 'insert'; payload = [].concat(p); (inserts[table] ??= []).push(...payload); return q; },
      update: (p: any) => { op = 'update'; payload = p; return q; },
      maybeSingle: async () => ({ data: (base[table] ?? [])[0] ?? null, error: null }),
      single: async () => ({ data: op === 'insert' ? payload[0] : null, error: null }),
      then: (ok: any, bad: any) => {
        if (op === 'update') { updates.push({ table, set: payload, where }); for (const r of inserts[table] ?? []) if (Object.entries(where).every(([k, v]) => r[k] === v)) Object.assign(r, payload); }
        return Promise.resolve({ data: op === 'insert' ? payload : op === 'select' ? (base[table] ?? []) : [], error: null, count: 0 }).then(ok, bad);
      },
    };
    return q;
  };
  return { from, rpc: async () => ({ data: null, error: { code: 'PGRST202', message: 'missing' } }), inserts, updates };
}
const deps = (d: any, llm: any, o: any = {}) => ({ admin: d, searchRpc: async () => [], asUser: 'u1', geminiKey: 'gk', groqKey: 'qk', fallbackKey: 'fk', embed: async () => [0.1], llm, requestId: 'r1', ...o });
const ok = (text: string): LlmResult => ({ text, toolCalls: [], output: [], usage: { input: 100, cached: 0, output: 10, reasoning: 0 }, status: 'completed' });

test('fallback chain: Gemini out of quota → the SAME turn answers on the OpenAI free-tier model, flagged, cost 0', async () => {
  const d = db();
  const seen: LlmRequest[] = [];
  const llm = async (r: LlmRequest) => {
    seen.push(r);
    if (r.apiKey === 'gk') throw new LlmError(`model HTTP 429: ${QUOTA}`, 429);
    r.onDelta?.('Answer from luna.');
    return ok('Answer from luna.');
  };
  const events: any[] = [];
  const res = await runTurn({ userId: 'u1', role: 'boss', message: 'hi' }, deps(d, llm), (e) => events.push(e));
  assert.equal(res.answer, 'Answer from luna.');
  assert.deepEqual(seen.map((r) => [r.apiKey, r.model]), [['gk', 'gemini-3.5-flash-lite'], ['fk', 'gpt-6-luna']]);
  assert.ok(!events.some((e) => e.error), 'the user never saw an error');
  const log = d.inserts.ai_request_log[0];
  assert.deepEqual([log.model, log.key_slot, log.flags.fallback_used], ['gpt-6-luna', 'fallback',
    { from: 'gemini:gemini-3.5-flash-lite', to: 'fallback:gpt-6-luna', reason: 'quota' }]);
  assert.equal(log.est_cost_usd, 0);
  const reply = d.inserts.ai_messages.find((m: any) => m.role === 'assistant');
  assert.deepEqual([reply.meta.model, reply.meta.key_slot, reply.meta.fallback_used.to], ['gpt-6-luna', 'fallback', 'fallback:gpt-6-luna']);
});

test('fallback chain: when every entry fails, the quota message is shown; reasoning from the first model is not replayed', async () => {
  const d = db();
  const inputs: any[][] = [];
  let n = 0;
  const llm = async (r: LlmRequest) => {
    inputs.push(JSON.parse(JSON.stringify(r.input)));
    if (++n === 1) return { ...ok(''), toolCalls: [{ call_id: 'c1', name: 'list_brands', arguments: '{}' }], output: [{ type: 'reasoning', id: 'rs1', encrypted_content: 'x' }, { type: 'function_call', call_id: 'c1', name: 'list_brands', arguments: '{}' }] };
    throw new LlmError(`model HTTP 429: ${QUOTA}`, 429);
  };
  const events: any[] = [];
  await runTurn({ userId: 'u1', role: 'apc', message: 'hi' }, deps(d, llm), (e) => events.push(e));
  assert.equal(events.find((e) => e.error).error, providerIssueMessage('quota', 'apc'));
  assert.ok(inputs[1].some((x) => x.type === 'reasoning'), 'the first model saw its own reasoning');
  assert.ok(!inputs[2].some((x) => x.type === 'reasoning'), 'the fallback did not get it');
  assert.equal(d.inserts.ai_request_log[0].flags.provider_quota, true);
});

test('a rejected parameter is dropped, the call retried once, and the finding remembered', async () => {
  const d = db();
  const seen: LlmRequest[] = [];
  const llm = async (r: LlmRequest) => {
    seen.push(r);
    if (!r.omit?.includes('reasoning_effort')) throw new LlmError('model HTTP 400: `reasoning_effort` is not supported with this model', 400);
    r.onDelta?.('fine');
    return ok('fine');
  };
  const res = await runTurn({ userId: 'u1', role: 'boss', message: 'hi' }, deps(d, llm, { catalog: [row('gemini', 'gemini-3.5-flash-lite'), row('fallback', 'gpt-6-luna')] }), () => {});
  assert.equal(res.answer, 'fine');
  assert.deepEqual(seen.map((r) => r.omit ?? []), [[], ['reasoning_effort']]);
  assert.deepEqual(d.inserts.ai_request_log[0].flags.params_dropped, ['gemini:gemini-3.5-flash-lite:reasoning_effort']);
  const upd = d.updates.find((u: any) => u.table === 'ai_model_catalog');
  assert.deepEqual([upd.set, upd.where], [{ params: { omit: ['reasoning_effort'] } }, { key_slot: 'gemini', model: 'gemini-3.5-flash-lite' }]);
});

test('keyword-only search: flagged when embedding fails, and the prompt says so when embeddings are known to be down', async () => {
  const d = db();
  const seen: LlmRequest[] = [];
  const calls: any[] = [];
  const llm = async (r: LlmRequest) => {
    seen.push(r);
    if (seen.length === 1) return { ...ok(''), toolCalls: [{ call_id: 'c', name: 'search_company_knowledge', arguments: '{"query":"samples"}' }], output: [] };
    r.onDelta?.('ok'); return ok('ok');
  };
  const searchRpc = async (fn: string, a: any) => { calls.push([fn, a]); return []; };
  await runTurn({ userId: 'u1', role: 'boss', message: 'samples?' }, deps(d, llm, {
    searchRpc, embed: async () => { throw new LlmError(`embeddings HTTP 429: ${QUOTA}`, 429); }, embedDown: () => true }), () => {});
  assert.equal(d.inserts.ai_request_log[0].flags.search_mode, 'keyword_only');
  assert.match(seen[0].instructions, /keyword-only mode/);
  assert.equal(calls.find(([f]) => f === 'ai_search')[1].p_query_embedding, null);   // the fts arm only
});

test('a free model costs 0 whatever the price table says, and is never marked unpriced', async () => {
  const d = db({ ai_assistant_config: [{ id: 1, model: 'gemini-mystery', model_key_slot: 'gemini', enabled: true, retrieval: {}, prices: { 'gemini-mystery': { in: 99, cached: 99, out: 99 } }, fallback_models: [] }] });
  const llm = async (r: LlmRequest) => { r.onDelta?.('x'); return ok('x'); };
  await runTurn({ userId: 'u1', role: 'boss', message: 'hi' }, deps(d, llm, { catalog: [row('gemini', 'gemini-mystery')] }), () => {});
  const log = d.inserts.ai_request_log[0];
  assert.deepEqual([log.model, log.est_cost_usd, log.flags.unpriced, log.flags.free_tier], ['gemini-mystery', 0, undefined, true]);
});

// ── embeddings across keys ──────────────────────────────────────────────────

test('query embeddings: free providers only; every refused/out-of-quota provider → down for 10 minutes, no more calls (the OpenAI keys are never used)', async () => {
  _resetEmbedDown();
  const hits: string[] = [];
  const mk = (ok: boolean) => async (url: any, init: any) => {
    hits.push(String(url));
    if (!ok) return new Response(QUOTA, { status: 429 });
    return new Response(JSON.stringify({ data: [{ index: 0, embedding: new Array(1536).fill(0) }], usage: { prompt_tokens: 3, total_tokens: 3 } }), { status: 200 });
  };
  const env = (ok: boolean) => ({ openAiKeyFallback: 'fk', nvidiaKey: 'nv', fetchImpl: mk(ok) as any } as any);
  const good = chainEmbedder(env(true), new UsageMeter());
  assert.equal((await good.embed('a')).length, 1536);
  assert.ok(hits.every((u) => u.includes('nvidia.com')), 'only NVIDIA was asked');
  hits.length = 0;
  const bad = chainEmbedder(env(false), new UsageMeter());
  await assert.rejects(bad.embed('b'));
  await assert.rejects(bad.alt!('b'));   // no second provider configured here
  assert.equal(bad.down(), true);
  const before = hits.length;
  await assert.rejects(bad.embed('c'));
  assert.equal(hits.length, before, 'no call while down');
  assert.ok(!hits.some((u) => u.includes('openai.com')));
  _resetEmbedDown();
});

// ── refresh_models ──────────────────────────────────────────────────────────

test('refreshModels: probes free models only; the OpenAI key is probed for the free-tier model alone; upserts, keeps learned params', async () => {
  const probed: string[] = [];
  const fetchImpl = async (url: string, init: any) => {
    const key = String(init.headers.authorization).slice(7);
    if (url.endsWith('/models')) {
      const ids = key === 'fk' ? ['gpt-6-luna', 'gpt-5.4-mini', 'gpt-5.5', 'gpt-4o-mini-tts'] : ['gemini-3.5-flash-lite', 'imagen-4', 'gemini-broken'];
      return new Response(JSON.stringify({ data: ids.map((id) => ({ id })) }), { status: 200 });
    }
    const body = JSON.parse(init.body);
    probed.push(`${key}:${body.model}`);
    if (body.model === 'gemini-broken') return new Response('{"error":{"message":"not found"}}', { status: 404 });
    if (url.includes('openai.com')) {
      if (body.stream) return new Response('event: x\ndata: {"type":"response.output_text.delta","delta":"hi"}\n\n', { status: 200 });
      if (body.tools) return new Response(JSON.stringify({ output: [{ type: 'function_call' }], usage: { input_tokens: 40, output_tokens: 10 } }), { status: 200 });
      return new Response(JSON.stringify({ output: [], usage: { input_tokens: 12, output_tokens: 2 } }), { status: 200 });
    }
    if (body.stream) return new Response('data: {"choices":[{"delta":{"content":"hi"}}]}\n\n', { status: 200 });
    if (body.tools) return new Response(JSON.stringify({ choices: [{ message: { tool_calls: [{ id: 'c' }] } }], usage: { prompt_tokens: 40, completion_tokens: 10 } }), { status: 200 });
    return new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }], usage: { prompt_tokens: 12, completion_tokens: 2 } }), { status: 200 });
  };
  const d = db({ ai_model_catalog: [{ key_slot: 'fallback', model: 'gpt-6-luna', params: { omit: ['text'] } }] });
  const r = await refreshModels({ keys: KEYS, admin: d, prices: pricesFrom({}), fetchImpl: fetchImpl as any });
  // no paid OpenAI model is ever sent a request
  assert.ok(probed.filter((p) => p.startsWith('fk:')).every((p) => p === 'fk:gpt-6-luna'), probed.join(','));
  assert.deepEqual(r.models.filter((m) => m.key_slot === 'fallback' && m.model !== 'gpt-6-luna').map((m) => [m.model, m.available, m.reason]),
    [['gpt-4o-mini-tts', false, 'audio model (not for chat)'], ['gpt-5.4-mini', false, 'paid OpenAI model (Buddy uses free models only)'], ['gpt-5.5', false, 'paid OpenAI model (Buddy uses free models only)']]);
  assert.deepEqual(r.slots.fallback, { listed: 4, probed: 1, available: 1, usable: 1, free: ['gpt-6-luna'], credits_exhausted: false });
  assert.deepEqual([r.slots.gemini.probed, r.slots.gemini.usable, r.slots.gemini.free], [2, 1, ['gemini-3.5-flash-lite']]);
  assert.equal(r.models.find((m) => m.model === 'gemini-broken')!.reason, 'retired or not found on this key');
  const luna = r.models.find((m) => m.model === 'gpt-6-luna')!;
  assert.deepEqual([luna.available, luna.supports_tools, luna.supports_stream, luna.free], [true, true, true, true]);
  const up = d.inserts.ai_model_catalog.find((x: any) => x.model === 'gpt-6-luna');
  assert.deepEqual(up.params, { omit: ['text'] });
  assert.equal(r.probe_cost_usd_est, 0);
});

// ── a free model's used-up allowance (live bug 2026-10-01) ──────────────────
// OpenAI answered gpt-6-luna with HTTP 200 and then an in-stream `error` event:
// "Rate limit reached … Please try again in 36h54m25.92s". It had no status or
// code, so it was retried, then shown as "Something went wrong".

const LUNA_LIMIT_MSG = 'Rate limit reached for gpt-6-luna in organization org-x on tokens per min (TPM): Limit 100000, Used 99374, Requested 5752. Please try again in 36h54m25.92s. Visit https://platform.openai.com/account/rate-limits to learn more.';
const sse = (ev: unknown) => new Response(`event: error\ndata: ${JSON.stringify(ev)}\n\n`, { status: 200, headers: { 'content-type': 'text/event-stream' } });

test('an in-stream rate-limit error gets status 429, its code and its wait; a wait of hours is a "limit", not retried', async () => {
  for (const ev of [{ type: 'error', code: 'rate_limit_exceeded', message: LUNA_LIMIT_MSG }, { type: 'error', error: { type: 'tokens', code: 'rate_limit_exceeded', message: LUNA_LIMIT_MSG } }]) {
    let calls = 0;
    const err: any = await respond({ apiKey: 'fk', model: 'gpt-6-luna', instructions: 'i', input: [], onDelta: () => {}, fetchImpl: (async () => { calls++; return sse(ev); }) as any })
      .then(() => null, (e) => e);
    assert.ok(err instanceof LlmError);
    assert.deepEqual([err.status, err.code, err.retryAfterMs, calls], [429, 'rate_limit_exceeded', 132865920, 1]);
    assert.equal(providerAccountIssue(err), 'limit');
  }
  assert.equal(retryAfterMs('Please try again in 1.2s.'), 1200);
  assert.equal(retryAfterMs('try again in 850ms'), 850);
  assert.equal(retryAfterMs('no wait here'), null);
  // a short wait is still a passing rate limit: retried once, not an account issue
  let calls = 0;
  const short = { type: 'error', code: 'rate_limit_exceeded', message: 'Rate limit reached. Please try again in 20ms.' };
  await assert.rejects(respond({ apiKey: 'fk', model: 'gpt-6-luna', instructions: 'i', input: [], onDelta: () => {}, fetchImpl: (async () => { calls++; return sse(short); }) as any }));
  assert.equal(calls, 2);
  assert.equal(providerAccountIssue(new LlmError('model error: [rate_limit_exceeded] Please try again in 20ms.', 429)), null);
  // the new no-credit code
  assert.equal(providerAccountIssue(new LlmError(`model HTTP 429: ${QUOTA}`, 429)), 'quota');
  assert.equal(scrubSecrets('Incorrect API key provided: sk-proj-abc123****wxyz.'), 'Incorrect API key provided: sk-….');
});

test('whole chain out (Gemini no quota, luna limit): a specific message, and the real error in flags.error_detail', async () => {
  const d = db();
  const fetchImpl = async () => sse({ type: 'error', code: 'rate_limit_exceeded', message: LUNA_LIMIT_MSG });
  const llm = (r: LlmRequest) => (r.apiKey === 'gk' ? Promise.reject(new LlmError(`model HTTP 429: ${QUOTA}`, 429)) : respond({ ...r, fetchImpl: fetchImpl as any }));
  const events: any[] = [];
  const t0 = Date.now();
  await runTurn({ userId: 'u1', role: 'boss', message: 'hi' }, deps(d, llm), (e) => events.push(e));
  assert.ok(Date.now() - t0 < 1000, 'no retry waits');
  const msg = events.find((e) => e.error).error;
  assert.match(msg, /Gemini has no free quota left on its key \(gemini-3.5-flash-lite\)/);
  assert.doesNotMatch(msg, /credits|billing|top up/i);
  assert.match(msg, /gpt-6-luna has used up its OpenAI \(free tier\) token allowance \(OpenAI \(free tier\) estimates about 37 h before a question fits again\)/);
  assert.ok(events.some((e) => e.status === 'Switching to a backup model…'));
  const log = d.inserts.ai_request_log[0];
  assert.deepEqual(log.flags.error_detail, { step: 'model round 0', class: 'LlmError', status: 429, code: 'rate_limit_exceeded',
    message: log.error.slice(0, 300), target: 'fallback:gpt-6-luna', retry_after_s: 132866 });
  assert.deepEqual([log.flags.provider_issue, log.flags.model_attempts.map((a: any) => a.target)], ['limit', ['gemini:gemini-3.5-flash-lite', 'fallback:gpt-6-luna']]);
  const reply = d.inserts.ai_messages.find((m: any) => m.role === 'assistant');
  assert.equal(reply.meta.error, msg);                  // the saved reply says the same, not "Something went wrong"
  // other roles: no technical detail
  const d2 = db();
  const ev2: any[] = [];
  await runTurn({ userId: 'u2', role: 'apc', message: 'hi' }, deps(d2, llm), (e) => ev2.push(e));
  assert.equal(ev2.find((e) => e.error).error, "Buddy can't reach its AI service right now: the AI account needs attention. Please tell the Boss.");
});

test('luna as the main model AND in the chain: tried once, not twice; alone out of allowance → the usage-limit message', async () => {
  const cfg = { model: 'gpt-6-luna', model_key_slot: 'fallback', fallback_enabled: true, fallback_models: [{ key_slot: 'fallback', model: 'gpt-6-luna' }] };
  assert.deepEqual(chooseTargets(cfg, [row('fallback', 'gpt-6-luna')], KEYS), [{ keySlot: 'fallback', model: 'gpt-6-luna' }]);
  const d = db({ ai_assistant_config: [{ id: 1, persona: '', enabled: true, retrieval: {}, prices: {}, ...cfg }] });
  let calls = 0;
  const llm = (r: LlmRequest) => respond({ ...r, fetchImpl: (async () => { calls++; return sse({ type: 'error', code: 'rate_limit_exceeded', message: LUNA_LIMIT_MSG }); }) as any });
  const events: any[] = [];
  await runTurn({ userId: 'u1', role: 'apc', message: 'hi' }, deps(d, llm, { catalog: [row('fallback', 'gpt-6-luna')] }), (e) => events.push(e));
  assert.equal(calls, 1);
  assert.equal(events.find((e) => e.error).error, 'Buddy has reached its AI usage limit for now. Please try again later, or tell the Boss.');
  assert.equal(d.inserts.ai_request_log[0].flags.error_detail.target, 'fallback:gpt-6-luna');
});

test('an unknown failure is still logged in full (flags.error_detail), the user sees the generic message', async () => {
  const d = db();
  const llm = async () => { throw new TypeError('Cannot read properties of undefined'); };
  const events: any[] = [];
  await runTurn({ userId: 'u1', role: 'boss', message: 'hi' }, deps(d, llm as any), (e) => events.push(e));
  assert.equal(events.find((e) => e.error).error, 'Something went wrong while answering. Please try again.');
  const log = d.inserts.ai_request_log[0];
  assert.deepEqual([log.flags.error_detail.class, log.flags.error_detail.step, log.flags.error_unclassified], ['TypeError', 'model round 0', true]);
});

test('embeddings: credit_balance_exhausted is not retried', async () => {
  let calls = 0;
  const fetchImpl = async () => { calls++; return new Response(QUOTA, { status: 429 }); };
  await assert.rejects(embedTexts(['a'], { apiKey: 'k', fetchImpl: fetchImpl as any, sleep: async () => {} }));
  assert.equal(calls, 1);
});