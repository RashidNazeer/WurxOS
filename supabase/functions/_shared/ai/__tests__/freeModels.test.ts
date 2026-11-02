// Free models only (Owner 2026-11-02). Whole turns through the REAL adapters with
// globalThis.fetch replaced by a recorder: what is asked of which provider, in
// which order, and that nothing is ever sent to the paid OpenAI API.
import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { runTurn } from '../agent/core.ts';
import { _resetCooldowns, type CatalogRow } from '../agent/models.ts';

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });
beforeEach(() => _resetCooldowns());

type Seen = { url: string; model: string; auth: string };
const sse = (text: string) => new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: text }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`, { status: 200 });
const luna = (text: string) => new Response(`data: ${JSON.stringify({ type: 'response.output_text.delta', delta: text })}\n\ndata: ${JSON.stringify({ type: 'response.completed', response: { status: 'completed', output: [], usage: { input_tokens: 5, output_tokens: 2 } } })}\n\n`, { status: 200 });
const quota = (url: string) => (url.includes('googleapis')
  ? new Response(JSON.stringify([{ error: { code: 429, message: 'You exceeded your current quota, please check your plan and billing details.', status: 'RESOURCE_EXHAUSTED' } }]), { status: 429 })
  : new Response(JSON.stringify({ error: { message: 'You exceeded your current quota', type: 'insufficient_quota', code: 'insufficient_quota' } }), { status: 429 }));

// answers(url, model) → the Response; every request is recorded.
function spy(answers: (url: string, model: string) => Response) {
  const seen: Seen[] = [];
  globalThis.fetch = (async (url: any, init: any) => {
    const body = JSON.parse(String(init?.body ?? '{}'));
    seen.push({ url: String(url), model: body.model, auth: String(init?.headers?.authorization ?? '') });
    return answers(String(url), body.model);
  }) as any;
  return seen;
}

function db(cfg: Record<string, unknown>) {
  const inserts: Record<string, any[]> = {};
  let seq = 0;
  const base: Record<string, any[]> = { ai_assistant_config: [{ id: 1, persona: '', enabled: true, retrieval: {}, prices: {}, fallback_enabled: true, auto_failover: false, ...cfg }] };
  const from = (table: string) => {
    let op = 'select'; let payload: any = null;
    const q: any = {
      select: () => q, eq: () => q, neq: () => q, lt: () => q, gte: () => q, in: () => q, order: () => q, limit: () => q, not: () => q,
      insert: (p: any) => { op = 'insert'; payload = [].concat(p).map((r: any) => ({ id: `${table}-${++seq}`, ...r })); (inserts[table] ??= []).push(...payload); return q; },
      update: () => { op = 'update'; return q; },
      maybeSingle: async () => ({ data: (base[table] ?? [])[0] ?? null, error: null }),
      single: async () => ({ data: op === 'insert' ? payload[0] : null, error: null }),
      then: (ok: any, bad: any) => Promise.resolve({ data: op === 'insert' ? payload : op === 'select' ? (base[table] ?? []) : [], error: null, count: 0 }).then(ok, bad),
    };
    return q;
  };
  return { from, rpc: async () => ({ data: null, error: { code: 'PGRST202', message: 'missing' } }), inserts };
}
const row = (slot: any, model: string): CatalogRow => ({ key_slot: slot, model, available: true, supports_tools: true, supports_stream: true, free: true, params: {} });
const CAT = () => [row('gemini', 'gemini-3.6-flash'), row('gemini', 'gemini-3.5-flash-lite'), row('groq', 'openai/gpt-oss-120b'), row('fallback', 'gpt-6-luna'),
  row('nvidia', 'poolside/laguna-xs-2.1'), row('fallback', 'gpt-5.5'), row('fallback', 'gpt-5.4-nano')];
const KEYS = { geminiKey: 'gk', groqKey: 'qk', fallbackKey: 'fk', nvidiaKey: 'nk' };
const ask = (d: any, o: Record<string, unknown> = {}) => runTurn({ userId: 'u1', role: 'boss', message: 'hi' },
  { admin: d, searchRpc: async () => [], asUser: 'u1', embed: async () => null, requestId: 'r1', ...KEYS, catalog: CAT(), ...o } as any, () => {});
const openAiCalls = (seen: Seen[]) => seen.filter((s) => s.url.includes('api.openai.com'));

test('the configured order is honoured: each model is tried in the order the Boss set, across providers, until one answers', async () => {
  const seen = spy((url, model) => (model === 'poolside/laguna-xs-2.1' ? sse('from nvidia') : quota(url)));
  const d = db({ model: 'openai/gpt-oss-120b', model_key_slot: 'groq', fallback_models: [
    { key_slot: 'gemini', model: 'gemini-3.6-flash' }, { key_slot: 'fallback', model: 'gpt-6-luna' }, { key_slot: 'gemini', model: 'gemini-3.5-flash-lite' }, { key_slot: 'nvidia', model: 'poolside/laguna-xs-2.1' }] });
  const r = await ask(d);
  assert.equal(r.answer, 'from nvidia');
  assert.deepEqual(seen.map((s) => s.model), ['openai/gpt-oss-120b', 'gemini-3.6-flash', 'gpt-6-luna', 'gemini-3.5-flash-lite', 'poolside/laguna-xs-2.1']);
  assert.deepEqual(seen.map((s) => new URL(s.url).host), ['api.groq.com', 'generativelanguage.googleapis.com', 'api.openai.com', 'generativelanguage.googleapis.com', 'integrate.api.nvidia.com']);
});

test('no request ever goes to api.openai.com for a paid model, whatever the config or the key slots say', async () => {
  const seen = spy((url, model) => (url.includes('api.openai.com') ? luna('from luna') : url.includes('groq') ? quota(url) : sse(`from ${model}`)));
  // a legacy row: the removed paid slot, paid models everywhere, also on the free-tier key
  const legacy = { model: 'gpt-5.4-nano', model_key_slot: 'primary', fallback_models: [
    { key_slot: 'primary', model: 'gpt-5.5' }, { key_slot: 'fallback', model: 'gpt-5.4-mini' }, { key_slot: 'fallback', model: 'gpt-5.5' }, { key_slot: 'fallback', model: 'gpt-5.4-nano' }], role_models: { boss: { model: 'gpt-5.5', key_slot: 'primary' } } };
  const r = await ask(db(legacy), { auto_failover: true });
  assert.ok(!r.error, String(r.error));
  assert.ok(seen.length >= 1);
  assert.deepEqual(openAiCalls(seen), [], 'a legacy config resolves to the free chain, not to OpenAI');
  assert.ok(seen.every((s) => !/^gpt-5/.test(s.model)), seen.map((s) => s.model).join());
  // the safety net (auto_failover on, every free model failing): the OpenAI key is asked for the free model only
  _resetCooldowns();
  const seen2 = spy((url, model) => (url.includes('api.openai.com') ? luna('from luna') : quota(url)));
  const net = db({ model: 'gemini-3.6-flash', model_key_slot: 'gemini', fallback_models: [], auto_failover: true });
  const r2 = await runTurn({ userId: 'u1', role: 'boss', message: 'hi' }, { admin: net, searchRpc: async () => [], asUser: 'u1', embed: async () => null, requestId: 'r2', ...KEYS, catalog: CAT() } as any, () => {});
  assert.equal(r2.answer, 'from luna');
  const oa = openAiCalls(seen2);
  assert.ok(oa.length >= 1 && oa.every((s) => s.model === 'gpt-6-luna' && s.auth === 'Bearer fk'), JSON.stringify(oa));
});

test('a provider that answers quota / 401 / 429 is skipped on the next turn with no new request, until its cooldown ends', async () => {
  const outcome: Record<string, number> = { 'gemini-3.6-flash': 429, 'openai/gpt-oss-120b': 401 };
  const seen = spy((url, model) => {
    const s = outcome[model];
    if (s === 401) return new Response(JSON.stringify({ error: { message: 'Invalid API Key', code: 'invalid_api_key' } }), { status: 401 });
    if (s === 429) return quota(url);
    return sse(`from ${model}`);
  });
  const cfg = { model: 'gemini-3.6-flash', model_key_slot: 'gemini', fallback_models: [{ key_slot: 'groq', model: 'openai/gpt-oss-120b' }, { key_slot: 'gemini', model: 'gemini-3.5-flash-lite' }] };
  const catalog = CAT();
  const r1 = await ask(db(cfg), { catalog });
  assert.equal(r1.answer, 'from gemini-3.5-flash-lite');
  assert.deepEqual(seen.map((s) => s.model), ['gemini-3.6-flash', 'openai/gpt-oss-120b', 'gemini-3.5-flash-lite']);
  // the next turns: the two failed models cost nothing (same worker, then a fresh worker reading the catalog)
  for (const fresh of [false, true]) {
    if (fresh) _resetCooldowns();
    seen.length = 0;
    const r = await ask(db(cfg), { catalog });
    assert.equal(r.answer, 'from gemini-3.5-flash-lite');
    assert.deepEqual(seen.map((s) => s.model), ['gemini-3.5-flash-lite'], fresh ? 'fresh worker' : 'same worker');
  }
  // cooldown over → asked again (and recovers)
  _resetCooldowns();
  for (const c of catalog) if ((c.params as any)?.cooling) (c.params as any).cooling.until = Date.now() - 1;
  outcome['gemini-3.6-flash'] = 200;
  seen.length = 0;
  const r3 = await ask(db(cfg), { catalog });
  assert.equal(r3.answer, 'from gemini-3.6-flash');
  assert.deepEqual(seen.map((s) => s.model), ['gemini-3.6-flash']);
});

test('a legacy row naming the removed "primary" slot, or a paid model on the free-tier key, does not crash and answers from the free chain', async () => {
  const seen = spy((_u, model) => sse(`from ${model}`));
  const r = await ask(db({ model: 'gpt-5.4-nano', model_key_slot: 'primary', fallback_models: [{ key_slot: 'fallback', model: 'gpt-5.5' }] }));
  assert.equal(r.answer, 'from gemini-3.5-flash-lite');
  assert.deepEqual(seen.map((s) => new URL(s.url).host), ['generativelanguage.googleapis.com']);
  // no free key at all: a clear failure, not a crash and not an OpenAI call
  const seen2 = spy(() => sse('x'));
  const r2 = await runTurn({ userId: 'u1', role: 'boss', message: 'hi' }, { admin: db({ model: 'gpt-5.4-nano', model_key_slot: 'primary', fallback_models: [] }), searchRpc: async () => [], asUser: 'u1', embed: async () => null, requestId: 'r3', catalog: CAT() } as any, () => {});
  assert.ok(r2.error || r2.answer);
  assert.deepEqual(openAiCalls(seen2), []);
});

test('the automatic safety net: Gemini by benchmark rank, then Groq, the OpenAI free tier, and NVIDIA last; benchmarked-bad NVIDIA models never; no paid OpenAI model', async () => {
  const { safetyNet } = await import('../agent/models.ts');
  const cat = [row('gemini', 'gemini-3.8-flash'), row('gemini', 'gemini-3-flash-preview'), row('gemini', 'gemini-3.5-flash-lite'), row('gemini', 'gemini-3.6-flash'),
    row('groq', 'openai/gpt-oss-120b'), row('fallback', 'gpt-6-luna'), row('fallback', 'gpt-5.5'),
    row('nvidia', 'poolside/laguna-xs-2.1'), row('nvidia', 'nvidia/nemotron-3-ultra-550b-a55b'), row('nvidia', 'meta/muse-glimmer-30b'),
    row('nvidia', 'google/diffusiongemma-26b-a4b-it'), row('nvidia', 'nvidia/nemotron-3-super-120b-a12b'), row('nvidia', 'openai/gpt-oss-20b')];
  const net = safetyNet(cat, { gemini: 'g', groq: 'q', fallback: 'f', nvidia: 'n' }, []);
  assert.deepEqual(net.map((t) => `${t.keySlot}:${t.model}`), [
    'gemini:gemini-3.5-flash-lite', 'gemini:gemini-3-flash-preview', 'gemini:gemini-3.6-flash', 'gemini:gemini-3.8-flash',
    'groq:openai/gpt-oss-120b', 'fallback:gpt-6-luna', 'nvidia:nvidia/nemotron-3-ultra-550b-a55b', 'nvidia:poolside/laguna-xs-2.1']);   // ultra first: slower (11 s) but it invented nothing in the benchmark; laguna added claims
});
