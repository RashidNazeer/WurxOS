// Model catalog, fallback chain, parameter compatibility, keyword-only search
// (mig 397). All faked: no API calls.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chatModels, chooseTargets, modelUsable, omitFor, refreshModels, unsupportedParam, type CatalogRow } from '../agent/models.ts';
import { runTurn } from '../agent/core.ts';
import { chainEmbedder, _resetEmbedDown } from '../agent/server.ts';
import { LlmError, requestBody, type LlmRequest, type LlmResult } from '../llm/openai.ts';
import { pricesFrom, UsageMeter } from '../prices.ts';
import { providerIssueMessage } from '../providerErrors.ts';

const QUOTA = JSON.stringify({ error: { message: 'Your credit balance is exhausted.', type: 'insufficient_quota', code: 'credit_balance_exhausted' } });
const row = (slot: 'primary' | 'fallback', model: string, o: Partial<CatalogRow> = {}): CatalogRow =>
  ({ key_slot: slot, model, available: true, supports_tools: true, supports_stream: true, free: false, params: {}, ...o });
const KEYS = { primary: 'pk', fallback: 'fk' };

// ── catalog ─────────────────────────────────────────────────────────────────

test('chatModels: chat models only; a dated snapshot only when its alias is missing', () => {
  const ids = ['gpt-5.4-mini', 'gpt-5.4-mini-2026-03-17', 'gpt-5.4-nano-2026-03-17', 'gpt-image-1', 'gpt-4o-audio-preview', 'gpt-4o-realtime-preview',
    'gpt-4o-mini-tts', 'gpt-4o-transcribe', 'text-embedding-3-small', 'gpt-4o-search-preview', 'o3-pro', 'gpt-5-codex', 'gpt-3.5-turbo-instruct', 'gpt-6-luna', 'o4-mini', 'dall-e-3', 'chatgpt-4o-latest'];
  assert.deepEqual(chatModels(ids), ['gpt-5.4-mini', 'gpt-5.4-nano-2026-03-17', 'gpt-6-luna', 'o4-mini']);
});

test('modelUsable: an empty catalog allows the three built-ins on primary only; a catalogued key needs tools + stream', () => {
  assert.equal(modelUsable([], 'primary', 'gpt-5.5'), true);
  assert.equal(modelUsable([], 'primary', 'gpt-6-luna'), false);
  assert.equal(modelUsable([], 'fallback', 'gpt-5.4-mini'), false);
  const cat = [row('fallback', 'gpt-6-luna'), row('fallback', 'gpt-x', { supports_stream: false }), row('primary', 'gpt-5.4-mini', { available: false })];
  assert.equal(modelUsable(cat, 'fallback', 'gpt-6-luna'), true);
  assert.equal(modelUsable(cat, 'fallback', 'gpt-x'), false);
  assert.equal(modelUsable(cat, 'primary', 'gpt-5.4-mini'), false);   // the primary key is catalogued now
  // out of credit: a built-in stays choosable (it works after a top-up); other models do not
  const broke = [row('primary', 'gpt-5.4-nano', { available: false, supports_tools: false, supports_stream: false, last_error: 'HTTP 429: insufficient_quota' }),
    row('primary', 'gpt-odd', { available: false, supports_tools: false, supports_stream: false, last_error: 'HTTP 429: insufficient_quota' })];
  assert.equal(modelUsable(broke, 'primary', 'gpt-5.4-nano'), true);
  assert.equal(modelUsable(broke, 'primary', 'gpt-odd'), false);
});

test('chooseTargets: configured model first, then the fallbacks in order; bad entries skipped', () => {
  const cfg = { model: 'gpt-5.5', model_key_slot: 'primary', fallback_enabled: true,
    fallback_models: [{ key_slot: 'fallback', model: 'gpt-6-luna' }, { key_slot: 'primary', model: 'gpt-5.5' }, { key_slot: 'fallback', model: 'nope' }, { key_slot: 'primary', model: 'gpt-5.4-nano' }] };
  const cat = [row('fallback', 'gpt-6-luna')];
  assert.deepEqual(chooseTargets(cfg, cat, KEYS), [
    { keySlot: 'primary', model: 'gpt-5.5' }, { keySlot: 'fallback', model: 'gpt-6-luna' }, { keySlot: 'primary', model: 'gpt-5.4-nano' }]);
  // no fallback key → fallback entries dropped; disabled chain → just the model
  assert.deepEqual(chooseTargets(cfg, cat, { primary: 'pk' }).map((t) => t.model), ['gpt-5.5', 'gpt-5.4-nano']);
  assert.deepEqual(chooseTargets({ ...cfg, fallback_enabled: false }, cat, KEYS).length, 1);
  // an unusable configured model falls back to the default; a fallback-key model can be the main one
  assert.deepEqual(chooseTargets({ model: 'mystery' }, [], KEYS)[0], { keySlot: 'primary', model: 'gpt-5.4-mini' });
  assert.deepEqual(chooseTargets({ model: 'gpt-6-luna', model_key_slot: 'fallback' }, cat, KEYS)[0], { keySlot: 'fallback', model: 'gpt-6-luna' });
  // an uncatalogued fallback key: tried anyway (its catalog is empty)
  assert.equal(chooseTargets({ model: 'gpt-5.4-mini', fallback_models: [{ key_slot: 'fallback', model: 'gpt-6-luna' }] }, [], KEYS).length, 2);
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
  assert.deepEqual(omitFor([row('primary', 'm', { params: { omit: ['text'] } })], { keySlot: 'primary', model: 'm' }), ['text']);
});

// ── the turn ────────────────────────────────────────────────────────────────

function db(tables: Record<string, any[]> = {}) {
  const inserts: Record<string, any[]> = {};
  const updates: any[] = [];
  let seq = 0;
  const base: Record<string, any[]> = { ai_assistant_config: [{ id: 1, persona: '', model: 'gpt-5.4-mini', enabled: true, retrieval: {}, prices: {},
    model_key_slot: 'primary', fallback_enabled: true, fallback_models: [{ key_slot: 'fallback', model: 'gpt-6-luna' }] }], ...tables };
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
const deps = (d: any, llm: any, o: any = {}) => ({ admin: d, searchRpc: async () => [], asUser: 'u1', apiKey: 'pk', fallbackKey: 'fk', embed: async () => [0.1], llm, requestId: 'r1', ...o });
const ok = (text: string): LlmResult => ({ text, toolCalls: [], output: [], usage: { input: 100, cached: 0, output: 10, reasoning: 0 }, status: 'completed' });

test('fallback chain: no credits on the primary → the SAME turn answers on gpt-6-luna with the fallback key, flagged', async () => {
  const d = db();
  const seen: LlmRequest[] = [];
  const llm = async (r: LlmRequest) => {
    seen.push(r);
    if (r.apiKey === 'pk') throw new LlmError(`model HTTP 429: ${QUOTA}`, 429);
    r.onDelta?.('Answer from luna.');
    return ok('Answer from luna.');
  };
  const events: any[] = [];
  const res = await runTurn({ userId: 'u1', role: 'boss', message: 'hi' }, deps(d, llm), (e) => events.push(e));
  assert.equal(res.answer, 'Answer from luna.');
  assert.deepEqual(seen.map((r) => [r.apiKey, r.model]), [['pk', 'gpt-5.4-mini'], ['fk', 'gpt-6-luna']]);
  assert.ok(!events.some((e) => e.error), 'the user never saw an error');
  const log = d.inserts.ai_request_log[0];
  assert.deepEqual([log.model, log.key_slot, log.flags.fallback_used], ['gpt-6-luna', 'fallback',
    { from: 'primary:gpt-5.4-mini', to: 'fallback:gpt-6-luna', reason: 'quota' }]);
  assert.equal(log.est_cost_usd, 0);                  // luna is free
  assert.ok(!log.flags.unpriced);
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
  assert.ok(inputs[1].some((x) => x.type === 'reasoning'), 'the primary saw its own reasoning');
  assert.ok(!inputs[2].some((x) => x.type === 'reasoning'), 'the fallback did not get it');
  assert.equal(d.inserts.ai_request_log[0].flags.provider_quota, true);
});

test('a rejected parameter is dropped, the call retried once, and the finding remembered', async () => {
  const d = db();
  const seen: LlmRequest[] = [];
  const llm = async (r: LlmRequest) => {
    seen.push(r);
    if (!r.omit?.includes('reasoning')) throw new LlmError('model HTTP 400: {"error":{"param":"reasoning.effort","code":"unsupported_parameter"}}', 400);
    r.onDelta?.('fine');
    return ok('fine');
  };
  const res = await runTurn({ userId: 'u1', role: 'boss', message: 'hi' }, deps(d, llm, { catalog: [row('primary', 'gpt-5.4-mini'), row('fallback', 'gpt-6-luna')] }), () => {});
  assert.equal(res.answer, 'fine');
  assert.deepEqual(seen.map((r) => r.omit ?? []), [[], ['reasoning']]);
  assert.deepEqual(d.inserts.ai_request_log[0].flags.params_dropped, ['primary:gpt-5.4-mini:reasoning']);
  const upd = d.updates.find((u: any) => u.table === 'ai_model_catalog');
  assert.deepEqual([upd.set, upd.where], [{ params: { omit: ['reasoning'] } }, { key_slot: 'primary', model: 'gpt-5.4-mini' }]);
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

test('an unpriced model costs 0 and is marked unpriced', async () => {
  const d = db({ ai_assistant_config: [{ id: 1, model: 'gpt-mystery', model_key_slot: 'primary', enabled: true, retrieval: {}, prices: {}, fallback_models: [] }] });
  const llm = async (r: LlmRequest) => { r.onDelta?.('x'); return ok('x'); };
  await runTurn({ userId: 'u1', role: 'boss', message: 'hi' }, deps(d, llm, { catalog: [row('primary', 'gpt-mystery')] }), () => {});
  const log = d.inserts.ai_request_log[0];
  assert.deepEqual([log.model, log.est_cost_usd, log.flags.unpriced], ['gpt-mystery', 0, true]);
});

// ── embeddings across keys ──────────────────────────────────────────────────

test('query embeddings: primary, then the fallback key; both out of credit → down for 10 minutes, no more calls', async () => {
  _resetEmbedDown();
  const hits: string[] = [];
  const mk = (fallbackOk: boolean) => async (_u: any, init: any) => {
    const key = String(init.headers.authorization).slice(7);
    hits.push(key);
    if (key === 'pk' || !fallbackOk) return new Response(QUOTA, { status: 429 });
    return new Response(JSON.stringify({ data: [{ index: 0, embedding: new Array(1536).fill(0) }], usage: { prompt_tokens: 3, total_tokens: 3 } }), { status: 200 });
  };
  const meter = new UsageMeter();
  const good = chainEmbedder({ openAiKey: 'pk', openAiKeyFallback: 'fk', fetchImpl: mk(true) as any } as any, meter);
  assert.equal((await good.embed('a')).length, 1536);
  assert.deepEqual(hits, ['pk', 'fk']);
  assert.equal(meter.embed.keySlot, 'fallback');
  hits.length = 0;
  const bad = chainEmbedder({ openAiKey: 'pk', openAiKeyFallback: 'fk', fetchImpl: mk(false) as any } as any, new UsageMeter());
  await assert.rejects(bad.embed('b'));
  assert.equal(bad.down(), true);
  const before = hits.length;
  await assert.rejects(bad.embed('c'));
  assert.equal(hits.length, before, 'no call while down');
  _resetEmbedDown();
});

// ── refresh_models ──────────────────────────────────────────────────────────

test('refreshModels: lists, probes, marks free while credits are exhausted, upserts, keeps learned params', async () => {
  const fetchImpl = async (url: string, init: any) => {
    const key = String(init.headers.authorization).slice(7);
    if (url.endsWith('/v1/models')) {
      const ids = key === 'pk' ? ['gpt-5.4-mini', 'gpt-image-1'] : ['gpt-6-luna', 'gpt-5.4-mini', 'gpt-4o-mini-tts'];
      return new Response(JSON.stringify({ data: ids.map((id) => ({ id })) }), { status: 200 });
    }
    const body = JSON.parse(init.body);
    if (body.model !== 'gpt-6-luna') return new Response(QUOTA, { status: 429 });
    if (body.stream) return new Response('event: x\ndata: {"type":"response.output_text.delta","delta":"hi"}\n\n', { status: 200 });
    if (body.tools) return new Response(JSON.stringify({ output: [{ type: 'function_call' }], usage: { input_tokens: 40, output_tokens: 10 } }), { status: 200 });
    return new Response(JSON.stringify({ output: [], usage: { input_tokens: 12, output_tokens: 2 } }), { status: 200 });
  };
  const d = db({ ai_model_catalog: [{ key_slot: 'fallback', model: 'gpt-6-luna', params: { omit: ['text'] } }] });
  const r = await refreshModels({ keys: KEYS, admin: d, prices: pricesFrom({}), fetchImpl: fetchImpl as any });
  assert.deepEqual(r.slots.primary, { listed: 1, probed: 1, available: 0, usable: 0, free: [], credits_exhausted: true });
  assert.deepEqual(r.slots.fallback, { listed: 2, probed: 2, available: 1, usable: 1, free: ['gpt-6-luna'], credits_exhausted: true });
  const luna = r.models.find((m) => m.model === 'gpt-6-luna')!;
  assert.deepEqual([luna.available, luna.supports_tools, luna.supports_stream, luna.free], [true, true, true, true]);
  assert.match(r.models.find((m) => m.key_slot === 'primary')!.last_error!, /429/);
  const up = d.inserts.ai_model_catalog.find((x: any) => x.model === 'gpt-6-luna');
  assert.deepEqual(up.params, { omit: ['text'] });
  assert.equal(r.probe_cost_usd_est, 0);
  assert.equal(r.probe_tokens.input, 52);
});
