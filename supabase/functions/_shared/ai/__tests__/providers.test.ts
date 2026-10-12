// Groq / Gemini (Chat Completions) keys, the automatic safety net, cooldowns,
// and the always-allowed roles (mig 401). All faked: no API calls.
import { beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { chatBody, chatRespond, toMessages } from '../llm/chat.ts';
import { looksLikeToolMarkup, parseTextToolCalls, stripToolMarkup } from '../llm/textTools.ts';
import { LlmError, type LlmRequest, type LlmResult } from '../llm/openai.ts';
import { _resetCooldowns, chooseTargets, coolDown, coolingDown, netRank, refreshModels, extraFor, KEY_SLOTS, resolveRoleConfig, safetyNet, skipReason, SLOTS, unsupportedParam, type CatalogRow } from '../agent/models.ts';
import { runTurn } from '../agent/core.ts';
import { _resetBudgets, budgetFor, budgetFromError, estimate, fitRequest } from '../agent/compact.ts';
import { compactInstructions } from '../agent/prompt.ts';
import { checkProfile } from '../agent/server.ts';
import { providerAccountIssue, providerIssueMessage } from '../providerErrors.ts';

beforeEach(() => { _resetCooldowns(); _resetBudgets(); });

const row = (slot: any, model: string, o: Partial<CatalogRow> = {}): CatalogRow =>
  ({ key_slot: slot, model, available: true, supports_tools: true, supports_stream: true, free: slot === 'groq' || slot === 'gemini', params: {}, ...o });
const KEYS = { primary: 'pk', fallback: 'fk', groq: 'qk', gemini: 'gk' };
const CHAIN = [{ key_slot: 'gemini', model: 'gemini-3.5-flash' }, { key_slot: 'groq', model: 'openai/gpt-oss-120b' }, { key_slot: 'groq', model: 'qwen/qwen3.8-27b' }, { key_slot: 'fallback', model: 'gpt-6-luna' }];
const sseOf = (chunks: unknown[]) => new Response(chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join('') + 'data: [DONE]\n\n', { status: 200, headers: { 'content-type': 'text/event-stream' } });

// ── the adapter ─────────────────────────────────────────────────────────────

test('toMessages: system first, reasoning dropped, a round of tool calls → one assistant message, results → tool messages', () => {
  const m = toMessages('INSTR', [
    { role: 'user', content: 'q1' },
    { role: 'assistant', content: 'a1' },
    { role: 'user', content: 'q2' },
    { type: 'reasoning', id: 'r', encrypted_content: 'x' },
    { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'let me look' }] },
    { type: 'function_call', call_id: 'c1', name: 'search_company_knowledge', arguments: '{"query":"a"}', extra_content: { google: { thought_signature: 'sig' } } },
    { type: 'function_call', call_id: 'c2', name: 'list_brands', arguments: '{}' },
    { type: 'function_call_output', call_id: 'c1', output: 'R1' },
    { type: 'function_call_output', call_id: 'c2', output: 'R2' },
  ] as any);
  assert.deepEqual(m, [
    { role: 'system', content: 'INSTR' },
    { role: 'user', content: 'q1' }, { role: 'assistant', content: 'a1' }, { role: 'user', content: 'q2' },
    { role: 'assistant', content: 'let me look', tool_calls: [
      { id: 'c1', type: 'function', function: { name: 'search_company_knowledge', arguments: '{"query":"a"}' }, extra_content: { google: { thought_signature: 'sig' } } },
      { id: 'c2', type: 'function', function: { name: 'list_brands', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'c1', content: 'R1' }, { role: 'tool', tool_call_id: 'c2', content: 'R2' },
  ]);
});

test('chatBody: tools in chat shape (no empty schemas), max_tokens, reasoning_effort, usage in the stream; omitted fields dropped', () => {
  const r: LlmRequest = { apiKey: 'k', model: 'm', instructions: 'I', input: [{ role: 'user', content: 'q' }], effort: 'minimal', maxOutputTokens: 900, onDelta: () => {},
    tools: [{ name: 'a', description: 'A', parameters: { type: 'object', properties: { x: { type: 'string' } } } }, { name: 'b', description: 'B', parameters: { type: 'object', properties: {} } }] };
  const b = chatBody(r) as any;
  assert.deepEqual(b.tools, [{ type: 'function', function: { name: 'a', description: 'A', parameters: { type: 'object', properties: { x: { type: 'string' } } } } },
    { type: 'function', function: { name: 'b', description: 'B' } }]);
  assert.deepEqual([b.max_tokens, b.reasoning_effort, b.stream, b.stream_options, b.messages[0]], [900, 'low', true, { include_usage: true }, { role: 'system', content: 'I' }]);
  assert.equal(b.prompt_cache_key, undefined);
  const o = chatBody({ ...r, omit: ['reasoning_effort', 'stream_options', 'model'] }) as any;
  assert.deepEqual([o.reasoning_effort, o.stream_options, o.model], [undefined, undefined, 'm']);
});

test('chatRespond: streamed text + two parallel tool calls in pieces + usage → the loop\'s Responses-style result', async () => {
  const deltas: string[] = [];
  let sent: any = null;
  const fetchImpl = async (url: string, init: any) => {
    sent = { url, auth: init.headers.authorization, body: JSON.parse(init.body) };
    return sseOf([
      { choices: [{ index: 0, delta: { role: 'assistant', content: 'Hel' } }] },
      { choices: [{ index: 0, delta: { content: 'lo' } }] },
      { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_a', type: 'function', function: { name: 'search_company_knowledge', arguments: '{"que' } }] } }] },
      { choices: [{ index: 0, delta: { tool_calls: [{ index: 1, id: 'call_b', type: 'function', function: { name: 'list_brands', arguments: '' } }] } }] },
      { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: 'ry":"x"}' } }, { index: 1, function: { arguments: '{}' } }] } }] },
      { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
      { choices: [], usage: { prompt_tokens: 1200, completion_tokens: 40, prompt_tokens_details: { cached_tokens: 1000 }, completion_tokens_details: { reasoning_tokens: 12 } } },
    ]);
  };
  const res = await chatRespond({ apiKey: 'gk', model: 'gemini-3.5-flash', instructions: 'I', input: [{ role: 'user', content: 'q' }], onDelta: (d) => deltas.push(d),
    endpoint: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions', fetchImpl: fetchImpl as any });
  assert.equal(sent.url, 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions');
  assert.equal(sent.auth, 'Bearer gk');
  assert.deepEqual(deltas, ['Hel', 'lo']);
  assert.equal(res.text, 'Hello');
  assert.deepEqual(res.toolCalls, [{ call_id: 'call_a', name: 'search_company_knowledge', arguments: '{"query":"x"}' }, { call_id: 'call_b', name: 'list_brands', arguments: '{}' }]);
  assert.deepEqual(res.usage, { input: 1200, cached: 1000, output: 40, reasoning: 12 });
  assert.deepEqual(res.output.map((o: any) => o.type), ['message', 'function_call', 'function_call']);
});

test('chatRespond: a whole tool call without an index (Gemini style) keeps its thought signature; Groq usage in x_groq', async () => {
  const fetchImpl = async () => sseOf([
    { choices: [{ delta: { tool_calls: [{ id: 'g1', type: 'function', function: { name: 'list_brands', arguments: '{}' }, extra_content: { google: { thought_signature: 'S' } } }] }, finish_reason: 'tool_calls' }] },
    { choices: [], x_groq: { usage: { prompt_tokens: 7, completion_tokens: 2 } } },
  ]);
  const res = await chatRespond({ apiKey: 'k', model: 'm', instructions: 'I', input: [], onDelta: () => {}, endpoint: 'https://x/chat/completions', fetchImpl: fetchImpl as any });
  assert.deepEqual(res.output, [{ type: 'function_call', call_id: 'g1', name: 'list_brands', arguments: '{}', extra_content: { google: { thought_signature: 'S' } } }]);
  assert.equal(res.usage.input, 7);
});

test('error classes: Gemini array errors, Groq 413 / short 429 / long 429, a key refused', async () => {
  const call = (res: () => Response) => chatRespond({ apiKey: 'k', model: 'm', instructions: 'I', input: [], onDelta: () => {}, endpoint: 'https://x/chat/completions',
    fetchImpl: (async () => res()) as any }).then(() => null, (e) => e);
  const gem = (code: number, status: string, message: string) => new Response(JSON.stringify([{ error: { code, message, status } }]), { status: code });
  // Gemini free per-minute quota: "exceeded your current quota" but with a wait → a passing rate limit (not retried: 37 s > 20 s)
  let e: any = await call(() => gem(429, 'RESOURCE_EXHAUSTED', 'You exceeded your current quota. Please retry in 37.2s.'));
  assert.deepEqual([e.status, e.code, e.retryAfterMs, providerAccountIssue(e)], [429, 'RESOURCE_EXHAUSTED', 37200, null]);
  // no quota at all on this key (no wait) → quota
  e = await call(() => gem(429, 'RESOURCE_EXHAUSTED', 'You exceeded your current quota, please check your plan and billing details.'));
  assert.equal(providerAccountIssue(e), 'quota');
  e = await call(() => gem(400, 'INVALID_ARGUMENT', 'API key not valid. Please pass a valid API key.'));
  assert.equal(providerAccountIssue(e), 'auth');
  // Groq: a request bigger than the free per-minute budget
  e = await call(() => new Response(JSON.stringify({ error: { message: 'Request too large for model `openai/gpt-oss-120b` in organization `org_x` on tokens per minute (TPM): Limit 8000, Requested 9120, please reduce your message size and try again.', type: 'tokens', code: 'rate_limit_exceeded' } }), { status: 413 }));
  assert.equal(providerAccountIssue(e), 'too_large');
  // Groq: a short TPM wait → waited out and retried once
  let n = 0;
  e = await call(() => (++n === 1 ? new Response(JSON.stringify({ error: { message: 'Rate limit reached … Please try again in 20ms.', code: 'rate_limit_exceeded' } }), { status: 429, headers: { 'retry-after-ms': '20' } }) : sseOf([{ choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] }])));
  assert.equal(e, null);
  assert.equal(n, 2);
  // a long wait → limit (the turn moves on)
  e = await call(() => new Response(JSON.stringify({ error: { message: 'Rate limit reached. Please try again in 2h3m.', code: 'rate_limit_exceeded' } }), { status: 429 }));
  assert.equal(providerAccountIssue(e), 'limit');
  // a request field a chat model refuses → learned and dropped
  assert.equal(unsupportedParam(new LlmError('model HTTP 400: {"error":{"message":"`reasoning_effort` is not supported with this model","type":"invalid_request_error"}}', 400)), 'reasoning_effort');
  assert.equal(unsupportedParam(new LlmError('model HTTP 400: [{"error":{"code":400,"message":"Invalid JSON payload received. Unknown name \\"stream_options\\": Cannot find field.","status":"INVALID_ARGUMENT"}}]', 400)), 'stream_options');
  // messages name the provider and its secret
  assert.match(providerIssueMessage('auth', 'boss', [{ issue: 'auth', slot: 'gemini' }]), /Gemini refused an API key: check the GEMINI_API_KEY secret/);
  assert.match(providerIssueMessage('too_large', 'boss', [{ issue: 'too_large', slot: 'groq', model: 'openai/gpt-oss-120b' }]), /openai\/gpt-oss-120b cannot take a question this size on its free Groq tier/);
});

// ── choosing models ─────────────────────────────────────────────────────────

test('the chain across providers, then the safety net in its order; keys missing → skipped; auto_failover decides the net', () => {
  const cat = [row('gemini', 'gemini-3.5-flash'), row('gemini', 'gemini-3.7-flash'), row('gemini', 'gemini-3.1-flash-lite'), row('gemini', 'gemma-4-26b-a4b-it'),
    row('gemini', 'gemini-3-flash-preview'), row('gemini', 'gemini-3.8-flash', { supports_stream: false }), row('groq', 'openai/gpt-oss-120b'), row('groq', 'openai/gpt-oss-20b'),
    row('groq', 'qwen/qwen3.8-27b'), row('fallback', 'gpt-6-luna'), row('groq', 'moonshotai/kimi-k2')];
  const cfg = { model: 'gpt-6-luna', model_key_slot: 'fallback', fallback_enabled: true, fallback_models: CHAIN };
  const chain = chooseTargets(cfg, cat, KEYS);
  assert.deepEqual(chain.map((t) => `${t.keySlot}:${t.model}`), ['fallback:gpt-6-luna', 'gemini:gemini-3.5-flash', 'groq:openai/gpt-oss-120b', 'groq:qwen/qwen3.8-27b']);
  assert.deepEqual(safetyNet(cat, KEYS, chain).map((t) => `${t.keySlot}:${t.model}`),
    ['gemini:gemini-3-flash-preview', 'gemini:gemini-3.7-flash', 'gemini:gemini-3.1-flash-lite', 'gemini:gemma-4-26b-a4b-it', 'groq:openai/gpt-oss-20b', 'groq:moonshotai/kimi-k2']);
  assert.ok(netRank({ keySlot: 'gemini', model: 'gemini-3.5-flash' }) < netRank({ keySlot: 'groq', model: 'openai/gpt-oss-120b' }));
  // no Groq key: its entries leave the chain and the net
  const noGroq = { primary: 'pk', fallback: 'fk', gemini: 'gk' };
  assert.ok(!chooseTargets(cfg, cat, noGroq).some((t) => t.keySlot === 'groq'));
  assert.ok(!safetyNet(cat, noGroq, []).some((t) => t.keySlot === 'groq'));
  // a local override on a free key is taken as given
  assert.deepEqual(chooseTargets(cfg, cat, KEYS, { keySlot: 'groq', model: 'openai/gpt-oss-120b' })[0], { keySlot: 'groq', model: 'openai/gpt-oss-120b' });
  // skip reasons: no call spent on these
  const all = new Set(['gemini-embedding-001', 'whisper-large-v3', 'gemini-2.5-flash-preview-tts', 'antigravity-1', 'gemini-deep-research', 'veo-3', 'openai/gpt-oss-safeguard-20b', 'gemini-3.5-flash']);
  assert.deepEqual([...all].map((id) => skipReason(id.startsWith('whisper') || id.includes('/') ? 'groq' : 'gemini', id, all)), [
    'embedding / rerank model (not for chat)', 'speech-to-text model (not for chat)', 'audio model (not for chat)', 'Interactions API only',
    'research agent (not for chat)', 'video model (not for chat)', 'safety classifier (not for chat)', null]);
});

test('cooldown: quota / limit / refused keys keep a model out for a while; a too-large request does not', () => {
  const t = { keySlot: 'groq' as const, model: 'openai/gpt-oss-120b' };
  coolDown(t, new LlmError('model HTTP 413: Request too large … please reduce your message size', 413), 0);
  assert.equal(coolingDown(t, 1), null);
  coolDown(t, Object.assign(new LlmError('model HTTP 429: rate limit', 429), { retryAfterMs: 45_000 }), 0);
  assert.deepEqual([coolingDown(t, 44_000)?.issue, coolingDown(t, 46_000)], ['busy', null]);
  const p = { keySlot: 'primary' as const, model: 'gpt-5.4-mini' };
  coolDown(p, new LlmError('model HTTP 429: {"error":{"code":"insufficient_quota"}}', 429), 0);
  assert.deepEqual([coolingDown(p, 9 * 60_000)?.issue, coolingDown(p, 11 * 60_000)], ['quota', null]);
});

// ── a whole turn ────────────────────────────────────────────────────────────

function db(cfg: Record<string, unknown> = {}) {
  const inserts: Record<string, any[]> = {};
  let seq = 0;
  const base: Record<string, any[]> = { ai_assistant_config: [{ id: 1, persona: '', model: 'gpt-5.4-mini', model_key_slot: 'primary', enabled: true, retrieval: {}, prices: {},
    fallback_enabled: true, fallback_models: CHAIN, auto_failover: true, ...cfg }] };
  const from = (table: string) => {
    let op = 'select'; let payload: any = null; const where: any = {};
    const q: any = {
      select: () => q, eq: (k: string, v: any) => { if (op === 'update') where[k] = v; return q; },
      neq: () => q, lt: () => q, gte: () => q, in: () => q, order: () => q, limit: () => q, not: () => q,
      insert: (p: any) => { op = 'insert'; payload = [].concat(p).map((r: any) => ({ id: `${table}-${++seq}`, ...r })); (inserts[table] ??= []).push(...payload); return q; },
      update: (p: any) => { op = 'update'; payload = p; return q; },
      maybeSingle: async () => ({ data: (base[table] ?? [])[0] ?? null, error: null }),
      single: async () => ({ data: op === 'insert' ? payload[0] : null, error: null }),
      then: (ok: any, bad: any) => {
        if (op === 'update') for (const r of inserts[table] ?? []) if (Object.entries(where).every(([k, v]) => r[k] === v)) Object.assign(r, payload);
        return Promise.resolve({ data: op === 'insert' ? payload : op === 'select' ? (base[table] ?? []) : [], error: null, count: 0 }).then(ok, bad);
      },
    };
    return q;
  };
  return { from, rpc: async () => ({ data: null, error: { code: 'PGRST202', message: 'missing' } }), inserts };
}
const CAT = [row('gemini', 'gemini-3.5-flash'), row('gemini', 'gemini-3.7-flash'), row('groq', 'openai/gpt-oss-120b'), row('groq', 'qwen/qwen3.8-27b'), row('fallback', 'gpt-6-luna')];
const deps = (d: any, fetchImpl: any, o: any = {}) => ({ admin: d, searchRpc: async () => [], asUser: 'u1', apiKey: 'pk', fallbackKey: 'fk', groqKey: 'qk', geminiKey: 'gk',
  embed: async () => [0.1], catalog: CAT, requestId: 'r1', ...o,
  llm: (r: LlmRequest) => (o.responses ?? (async () => { throw new LlmError('model HTTP 429: {"error":{"code":"insufficient_quota","message":"You exceeded your current quota"}}', 429); }))(r),
  chatLlm: (r: LlmRequest) => chatRespond({ ...r, fetchImpl }) });

test('a full turn on Gemini: tool call, the tool result goes back as a tool message with the thought signature, the answer streams; free', async () => {
  const d = db({ model: 'gemini-3.5-flash', model_key_slot: 'gemini' });
  const bodies: any[] = [];
  const fetchImpl = async (url: string, init: any) => {
    bodies.push({ url, auth: init.headers.authorization, body: JSON.parse(init.body) });
    if (bodies.length === 1) return sseOf([{ choices: [{ delta: { tool_calls: [{ id: 't1', type: 'function', function: { name: 'search_company_knowledge', arguments: '{"query":"samples"}' }, extra_content: { google: { thought_signature: 'SIG' } } }] }, finish_reason: 'tool_calls' }] },
      { choices: [], usage: { prompt_tokens: 6000, completion_tokens: 30 } }]);
    return sseOf([{ choices: [{ delta: { content: 'Samples need approval.' }, finish_reason: 'stop' }] }, { choices: [], usage: { prompt_tokens: 6500, completion_tokens: 20 } }]);
  };
  const events: any[] = [];
  const res = await runTurn({ userId: 'u1', role: 'boss', message: 'samples?' }, deps(d, fetchImpl), (e) => events.push(e));
  assert.equal(res.answer, 'Samples need approval.');
  assert.deepEqual(bodies.map((b) => [b.url, b.auth]), [['https://generativelanguage.googleapis.com/v1beta/openai/chat/completions', 'Bearer gk'], ['https://generativelanguage.googleapis.com/v1beta/openai/chat/completions', 'Bearer gk']]);
  const second = bodies[1].body.messages;
  const asst = second.find((m: any) => m.tool_calls);
  assert.deepEqual(asst.tool_calls[0], { id: 't1', type: 'function', function: { name: 'search_company_knowledge', arguments: '{"query":"samples"}' }, extra_content: { google: { thought_signature: 'SIG' } } });
  assert.equal(second[second.indexOf(asst) + 1].role, 'tool');
  assert.equal(second[second.indexOf(asst) + 1].tool_call_id, 't1');
  const log = d.inserts.ai_request_log[0];
  assert.deepEqual([log.model, log.key_slot, log.est_cost_usd, log.tokens_in, log.flags.free_tier, log.flags.fallback_used], ['gemini-3.5-flash', 'gemini', 0, 12500, true, undefined]);
  const reply = d.inserts.ai_messages.find((m: any) => m.role === 'assistant');
  assert.deepEqual([reply.meta.model, reply.meta.key_slot], ['gemini-3.5-flash', 'gemini']);
});

test('primary out of credit → the chain lands on Gemini in the same turn; a busy Gemini hands over to Groq; the next turn skips what is cooling', async () => {
  let geminiBusy = false;
  const seen: string[] = [];
  const fetchImpl = async (url: string, init: any) => {
    const b = JSON.parse(init.body);
    seen.push(`${init.headers.authorization.slice(7)}:${b.model}`);
    if (url.includes('googleapis') && geminiBusy) return new Response(JSON.stringify([{ error: { code: 503, message: 'The model is overloaded.', status: 'UNAVAILABLE' } }]), { status: 503 });
    return sseOf([{ choices: [{ delta: { content: `answer from ${b.model}` }, finish_reason: 'stop' }] }]);
  };
  const d = db();
  const ev: any[] = [];
  const r1 = await runTurn({ userId: 'u1', role: 'boss', message: 'hi' }, deps(d, fetchImpl), (e) => ev.push(e));
  assert.equal(r1.answer, 'answer from gemini-3.5-flash');
  assert.deepEqual(ev.filter((e) => e.status && !e.done).map((e) => e.status), ['On it…', 'Switching to a backup model…']);
  const log1 = d.inserts.ai_request_log[0];
  assert.deepEqual([log1.key_slot, log1.flags.fallback_used, log1.flags.model_attempts.map((a: any) => a.target)],
    ['gemini', { from: 'primary:gpt-5.4-mini', to: 'gemini:gemini-3.5-flash', reason: 'quota' }, ['primary:gpt-5.4-mini', 'gemini:gemini-3.5-flash']]);
  // turn 2: the primary is cooling (not called); Gemini 503 → one retry → Groq answers
  geminiBusy = true;
  seen.length = 0;
  const d2 = db();
  const r2 = await runTurn({ userId: 'u1', role: 'boss', message: 'hi' }, deps(d2, fetchImpl), () => {});
  assert.equal(r2.answer, 'answer from openai/gpt-oss-120b');
  assert.deepEqual(seen, ['gk:gemini-3.5-flash', 'gk:gemini-3.5-flash', 'qk:openai/gpt-oss-120b']);
  const log2 = d2.inserts.ai_request_log[0];
  assert.deepEqual([log2.flags.skipped_cooling, log2.flags.fallback_used.to, log2.flags.fallback_used.reason], [['primary:gpt-5.4-mini'], 'groq:openai/gpt-oss-120b', 'server_error']);
});

test('nothing works: at most MAX_MODEL_ATTEMPTS calls, then one specific message; auto_failover off → the chain only', async () => {
  const cat = [...CAT, ...['a', 'b', 'c', 'd', 'e', 'f'].map((x) => row('gemini', `gemini-3.9-flash-${x}`))];
  let calls = 0;
  const fetchImpl = async () => { calls++; return new Response(JSON.stringify([{ error: { code: 429, message: 'You exceeded your current quota, please check your plan and billing details.', status: 'RESOURCE_EXHAUSTED' } }]), { status: 429 }); };
  const ev: any[] = [];
  const d = db();
  await runTurn({ userId: 'u1', role: 'boss', message: 'hi' }, deps(d, fetchImpl, { catalog: cat }), (e) => ev.push(e));
  const log = d.inserts.ai_request_log[0];
  assert.equal(log.flags.model_attempts.length, 8);          // 2 OpenAI (primary, luna) + 6 free
  assert.equal(calls, 6);
  const msg = ev.find((e) => e.error).error;
  assert.match(msg, /OpenAI credits are used up/);
  assert.match(msg, /Gemini has no free quota left on its key/);
  assert.match(msg, /Groq has no free quota left on its key/);
  _resetCooldowns();
  calls = 0;
  const d2 = db({ auto_failover: false, fallback_models: [{ key_slot: 'gemini', model: 'gemini-3.5-flash' }] });
  await runTurn({ userId: 'u1', role: 'boss', message: 'hi' }, deps(d2, fetchImpl, { catalog: cat }), () => {});
  assert.equal(d2.inserts.ai_request_log[0].flags.model_attempts.length, 2);
});

test('text already streamed is never handed to another model', async () => {
  const fetchImpl = async () => new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: 'Half an ans' } }] })}\n\ndata: ${JSON.stringify({ error: { message: 'boom', code: 'server_error' } })}\n\n`, { status: 200 });
  const d = db({ model: 'gemini-3.5-flash', model_key_slot: 'gemini' });
  const res = await runTurn({ userId: 'u1', role: 'boss', message: 'hi' }, deps(d, fetchImpl), () => {});
  assert.equal(d.inserts.ai_request_log[0].flags.model_attempts.length, 1);
  assert.match(res.answer, /^Half an ans/);
});

// ── who may use Buddy ───────────────────────────────────────────────────────

test('Boss and active developers always get through; other roles only when allowed_roles lists them', async () => {
  const admin = (role: string, allowed: string[]) => ({
    from: (t: string) => {
      const q: any = { select: () => q, eq: () => q,
        maybeSingle: async () => ({ data: t === 'profiles' ? { display_name: 'X', role, is_active: true, deleted_at: null } : { allowed_roles: allowed }, error: null }) };
      return q;
    },
  });
  const ok = async (role: string, allowed: string[]) => !((await checkProfile(admin(role, allowed), 'u', 't', false)) instanceof Response);
  assert.equal(await ok('developer', ['boss']), true);
  assert.equal(await ok('boss', []), true);
  assert.equal(await ok('apc', ['boss']), false);
  assert.equal(await ok('apc', ['boss', 'developer', 'apc']), true);
  // the Slack relay stays Boss-only
  assert.ok((await checkProfile(admin('developer', ['boss', 'developer']), 'u', null, true)) instanceof Response);
});

test('a model that only hit a provider hiccup during the check stays in the Boss chain (not in the safety net); probes retry a 503 once', async () => {
  const cat = [row('gemini', 'gemini-3.5-flash', { available: false, supports_tools: false, supports_stream: false, reason: 'did not answer the check (provider error or timeout)' }),
    row('gemini', 'gemini-3.6-flash'), row('gemini', 'gemini-2.5-flash', { available: false, reason: 'retired or not found on this key' })];
  const cfg = { model: 'gemini-3.6-flash', model_key_slot: 'gemini', fallback_models: [{ key_slot: 'gemini', model: 'gemini-3.5-flash' }, { key_slot: 'gemini', model: 'gemini-2.5-flash' }] };
  assert.deepEqual(chooseTargets(cfg, cat, KEYS).map((t) => t.model), ['gemini-3.6-flash', 'gemini-3.5-flash']);
  assert.deepEqual(safetyNet(cat, KEYS, []).map((t) => t.model), ['gemini-3.6-flash']);
  let n = 0;
  const fetchImpl = async (url: string, init: any) => {
    if (url.endsWith('/models')) return new Response(JSON.stringify({ data: [{ id: 'models/gemini-3.5-flash' }] }), { status: 200 });
    const b = JSON.parse(init.body);
    if (++n === 1) return new Response('[{"error":{"code":503,"status":"UNAVAILABLE"}}]', { status: 503 });
    if (b.stream) return new Response('data: {"choices":[{"delta":{"content":"hi"}}]}\n\n', { status: 200 });
    if (b.tools) return new Response(JSON.stringify({ choices: [{ message: { tool_calls: [{ id: 'x', function: { name: 'get_time', arguments: '{}' } }] } }] }), { status: 200 });
    return new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }], usage: { prompt_tokens: 5, completion_tokens: 1 } }), { status: 200 });
  };
  const upserts: any[] = [];
  const admin = { from: () => { const q: any = { select: async () => ({ data: [] }), upsert: async (r: any) => { upserts.push(...r); return { error: null }; }, update: () => q, eq: () => q, not: async () => ({}) }; return q; } };
  const r = await refreshModels({ keys: { primary: '', gemini: 'gk' }, admin, prices: {}, fetchImpl: fetchImpl as any, slots: ['gemini'], retryPauseMs: 1 });
  assert.deepEqual(r.models.map((m) => [m.model, m.available, m.supports_tools, m.supports_stream, m.free]), [['gemini-3.5-flash', true, true, true, true]]);
});
test('handing a turn to Gemini: tool calls another model made go in as plain context (Gemini 3 wants its own signatures); its own stay tool calls', () => {
  const input: any[] = [
    { role: 'user', content: 'samples?' },
    { type: 'function_call', call_id: 'q1', name: 'search_company_knowledge', arguments: '{"query":"samples"}' },            // Groq's
    { type: 'function_call_output', call_id: 'q1', output: '[S1] Approve samples by GMV.' },
    { type: 'function_call', call_id: 'g1', name: 'list_brands', arguments: '{}', extra_content: { google: { thought_signature: 'S' } } },
    { type: 'function_call_output', call_id: 'g1', output: 'Brands: A' },
  ];
  const gem = chatBody({ apiKey: 'k', model: 'gemini-3.5-flash', instructions: 'I', input, endpoint: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions' }) as any;
  assert.deepEqual(gem.messages.map((m: any) => m.role), ['system', 'user', 'user', 'assistant', 'tool']);
  assert.match(gem.messages[2].content, /search_company_knowledge\(\{"query":"samples"\}\) returned:\n\[S1\] Approve samples by GMV\./);
  assert.equal(gem.messages[3].tool_calls[0].id, 'g1');
  // Groq takes any tool call as it is
  const groq = chatBody({ apiKey: 'k', model: 'm', instructions: 'I', input, endpoint: 'https://api.groq.com/openai/v1/chat/completions' }) as any;
  assert.deepEqual(groq.messages.map((m: any) => m.role), ['system', 'user', 'assistant', 'tool', 'assistant', 'tool']);
});
// ── compact mode (small token budgets) ──────────────────────────────────────

const bigResult = (n: number) => Array.from({ length: n }, (_, i) => `[S${i + 1}] Source ${i + 1}: ${'detail '.repeat(120)}`).join('\n\n');
const TOOLS = [{ name: 'search_company_knowledge', description: 'd'.repeat(2000), parameters: { type: 'object', properties: { query: { type: 'string' } } } }];

test('fitRequest: under budget → untouched; over → output cap, compact prompt, tool results cut from the end, then no more tools', () => {
  const input: any[] = [{ role: 'user', content: 'q' }, { type: 'function_call', call_id: 'c', name: 'search_company_knowledge', arguments: '{}' },
    { type: 'function_call_output', call_id: 'c', output: bigResult(40) }];
  const r = { instructions: 'FULL '.repeat(3000), compactInstructions: 'CORE '.repeat(800), input, tools: TOOLS, maxOutputTokens: 2500 };
  const small = fitRequest({ ...r, input: [{ role: 'user', content: 'q' }], instructions: 'x', compactInstructions: 'x' }, 8000);
  assert.deepEqual(small.steps, []);
  const f = fitRequest(r, 8000);
  assert.ok(f.estimate <= 8000 * 0.85, `estimate ${f.estimate}`);
  assert.deepEqual(f.steps.slice(0, 3), ['output_1500', 'prompt_compact', 'tool_results_3000']);
  const out = (f.input[2] as any).output as string;
  assert.ok(out.startsWith('[S1] Source 1'), 'the best-ranked result is kept');
  assert.match(out, /cut to fit this model/);
  assert.equal((r.input[2] as any).output.length > out.length, true);   // the original history is untouched
  assert.equal(estimate('abcd', [], undefined, 10), 2 + 10);   // (4 + 2 + 2 chars) / 4 + max output
});

test('budgets: Groq 8k by default, the catalog wins over the slot, a 413 is parsed', () => {
  assert.equal(budgetFor([], { keySlot: 'groq', model: 'openai/gpt-oss-120b' }), 8000);
  assert.equal(budgetFor([], { keySlot: 'gemini', model: 'gemini-3.6-flash' }), null);
  assert.equal(budgetFor([row('gemini', 'gemma-4-26b-a4b-it', { params: { token_budget: 15000 } })], { keySlot: 'gemini', model: 'gemma-4-26b-a4b-it' }), 15000);
  assert.deepEqual(budgetFromError('Request too large for model `x` on tokens per minute (TPM): Limit 8000, Requested 9120, please reduce'), { limit: 8000, requested: 9120 });
  const ci = compactInstructions({ persona: 'P', role: 'apc', displayName: 'Ali', now: new Date('2026-10-01T10:00:00Z'), notes: ['PAGE CONTEXT: x'] });
  assert.ok(!/ROLE ANGLE|PAGE CONTEXT|PAGES THEY CAN OPEN/.test(ci) && /WHO YOU ARE HELPING: Ali/.test(ci));
});

test('a Groq turn: round 2 is compacted to fit 8k instead of a 413; a 413 anyway teaches the budget and retries compacted once', async () => {
  const sent: any[] = [];
  let reject = 0;
  const fetchImpl = async (_u: string, init: any) => {
    const b = JSON.parse(init.body);
    sent.push(b);
    if (sent.length === 1) return sseOf([{ choices: [{ delta: { tool_calls: [{ index: 0, id: 't1', type: 'function', function: { name: 'search_company_knowledge', arguments: '{"query":"samples"}' } }] }, finish_reason: 'tool_calls' }] }]);
    if (reject-- > 0) return new Response(JSON.stringify({ error: { message: 'Request too large for model `openai/gpt-oss-120b` on tokens per minute (TPM): Limit 8000, Requested 9500, please reduce your message size', code: 'rate_limit_exceeded' } }), { status: 413 });
    return sseOf([{ choices: [{ delta: { content: 'Answer [S1].' }, finish_reason: 'stop' }] }]);
  };
  const searchRpc = async () => Array.from({ length: 30 }, (_, i) => ({ chunk_id: `c${i}`, document_id: `d${i}`, chunk_index: 0, source_type: 'kb_article', source_id: `k${i}`,
    title: `SOP ${i}`, url: null, section: null, content: 'detail '.repeat(400), brand_id: null, period_start: null, period_end: null, metadata: {}, score: 1 - i / 100 }));
  for (const r of [0, 1]) {
    _resetCooldowns(); _resetBudgets(); sent.length = 0; reject = r;
    const d = db({ model: 'openai/gpt-oss-120b', model_key_slot: 'groq' });
    const res = await runTurn({ userId: 'u1', role: 'boss', message: 'samples?' }, deps(d, fetchImpl, { searchRpc, catalog: [...CAT] }), () => {});
    const log = d.inserts.ai_request_log[0];
    assert.equal(res.answer, 'Answer [S1].', `reject=${r}`);
    assert.equal(log.key_slot, 'groq');
    const last = sent[sent.length - 1];
    assert.ok(estimate(last.messages[0].content, last.messages.slice(1), last.tools, last.max_tokens) <= 8000, `round 2 fits (reject=${r})`);
    assert.ok(log.flags.compact.some((c: any) => c.steps.includes('prompt_compact')));
    if (r) assert.equal(sent.length, 3);                                  // round 1, the 413, the compacted retry
  }
});
// ── per-role models and the budget saver (mig 404) ──────────────────────────

const ROLE_CFG = { model: 'gpt-6-luna', model_key_slot: 'fallback', fallback_models: CHAIN,
  role_models: { boss: { model: 'gemini-3.6-flash', key_slot: 'gemini' },
    apc: { fallback_models: [{ key_slot: 'groq', model: 'openai/gpt-oss-120b' }], economy: { model: 'gemini-3.1-flash-lite', key_slot: 'gemini' } } } };

test('role models: a role overrides only what it sets; others inherit; a stale economy entry is ignored (no budget downgrade)', () => {
  const b = resolveRoleConfig(ROLE_CFG, 'Boss');
  assert.deepEqual([b.model, b.model_key_slot, b.fallback_models, b.model_source], ['gemini-3.6-flash', 'gemini', CHAIN, 'role:boss']);
  const a = resolveRoleConfig(ROLE_CFG, 'apc');
  assert.deepEqual([a.model, a.model_key_slot, a.fallback_models, a.model_source], ['gpt-6-luna', 'fallback', [{ key_slot: 'groq', model: 'openai/gpt-oss-120b' }], 'role:apc']);
  const t = resolveRoleConfig(ROLE_CFG, 'tl');
  assert.deepEqual([t.model, t.fallback_models, t.model_source], ['gpt-6-luna', CHAIN, 'global']);
  assert.equal(resolveRoleConfig({ model: 'm' }, 'apc').model_source, 'global');   // no role_models at all
});

test('a turn: the APC keeps its role model whatever the spend; the budget saver is gone; logged in flags and the reply meta', async () => {
  const seen: string[] = [];
  const fetchImpl = async (_u: string, init: any) => { const b = JSON.parse(init.body); seen.push(b.model); return sseOf([{ choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] }]); };
  const cat = [...CAT, row('gemini', 'gemini-3.1-flash-lite'), row('gemini', 'gemini-3.6-flash')];
  for (const [want, source] of [['openai/gpt-oss-120b', 'role:apc']] as const) {
    _resetCooldowns(); seen.length = 0;
    const d = db({ ...ROLE_CFG, budget_saver_pct: 80, monthly_budget_usd: 10 });   // legacy saver keys, even over threshold, must do nothing
    // the APC's main model is the global luna (Responses fake: no credits)→ its own chain → Groq
    await runTurn({ userId: 'u1', role: 'apc', message: 'hi' }, deps(d, fetchImpl, { catalog: cat }), () => {});
    const log = d.inserts.ai_request_log[0];
    assert.equal(seen[0], want);
    assert.equal(log.flags.model_source, source);
    assert.equal(d.inserts.ai_messages.find((m: any) => m.role === 'assistant').meta.model_source, source);
  }
});
// ── NVIDIA (mig 405) ────────────────────────────────────────────────────────

test('NVIDIA: two chat slots (dev/test only), non-chat models skipped without a call, -instruct chat models kept', () => {
  assert.deepEqual(KEY_SLOTS.filter((s) => s.startsWith('nvidia')), ['nvidia', 'nvidia2']);
  assert.deepEqual([SLOTS.nvidia.api, SLOTS.nvidia.base, SLOTS.nvidia2.label], ['openai-chat', 'https://integrate.api.nvidia.com/v1', 'NVIDIA (key 2) (dev/test only)']);
  const ids = ['nvidia/nemotron-3-ultra-550b-a55b', 'openai/gpt-oss-20b', 'meta/llama-3.3-70b-instruct', 'nvidia/nv-embedqa-e5-v5', 'nvidia/llama-3.2-nv-rerankqa-1b-v2',
    'nvidia/nemoretriever-parse', 'nvidia/llama-3.1-nemoguard-8b-content-safety', 'nvidia/parakeet-ctc-1.1b-asr', 'nvidia/riva-translate-4b-instruct', 'nvidia/cosmos-reason1-7b',
    'nvidia/nemoretriever-ocr-v1', 'nvidia/nvclip', 'meta/llama-3.2-11b-vision-instruct'];
  const all = new Set(ids);
  assert.deepEqual(ids.filter((id) => !skipReason('nvidia', id, all)), ['nvidia/nemotron-3-ultra-550b-a55b', 'openai/gpt-oss-20b', 'meta/llama-3.3-70b-instruct']);
});

test('NVIDIA extras: Nemotron gets its thinking switch (catalog params win); reasoning_content never becomes answer text', async () => {
  const nemo = { keySlot: 'nvidia' as const, model: 'nvidia/nemotron-3-ultra-550b-a55b' };
  assert.deepEqual(extraFor([], nemo), { chat_template_kwargs: { enable_thinking: true }, temperature: 1, top_p: 0.95 });
  assert.equal(extraFor([], { keySlot: 'nvidia', model: 'openai/gpt-oss-20b' }), null);
  assert.deepEqual(extraFor([row('nvidia', nemo.model, { params: { extra_body: { chat_template_kwargs: { enable_thinking: false } } } })], nemo), { chat_template_kwargs: { enable_thinking: false } });
  const b = chatBody({ apiKey: 'k', model: nemo.model, instructions: 'I', input: [], extra: { chat_template_kwargs: { enable_thinking: true }, top_p: 0.95, model: 'x' } }) as any;
  assert.deepEqual([b.chat_template_kwargs, b.top_p, b.model], [{ enable_thinking: true }, 0.95, nemo.model]);   // a core field is never overridden
  const deltas: string[] = [];
  const res = await chatRespond({ apiKey: 'k', model: nemo.model, instructions: 'I', input: [], onDelta: (d) => deltas.push(d), endpoint: 'https://integrate.api.nvidia.com/v1/chat/completions',
    fetchImpl: (async () => sseOf([{ choices: [{ delta: { reasoning_content: 'let me think…' } }] }, { choices: [{ delta: { content: 'Answer.' }, finish_reason: 'stop' }] },
      { choices: [], usage: { prompt_tokens: 10, completion_tokens: 30, completion_tokens_details: { reasoning_tokens: 25 } } }])) as any });
  assert.deepEqual([res.text, deltas, res.usage.reasoning], ['Answer.', ['Answer.'], 25]);
});

test('a turn on Nemotron: the NVIDIA key and endpoint, the thinking switch, and room for reasoning (max_tokens ≥ 8000)', async () => {
  const sent: any[] = [];
  const fetchImpl = async (url: string, init: any) => { sent.push({ url, auth: init.headers.authorization, body: JSON.parse(init.body) }); return sseOf([{ choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] }]); };
  const d = db({ model: 'nvidia/nemotron-3-ultra-550b-a55b', model_key_slot: 'nvidia' });
  await runTurn({ userId: 'u1', role: 'boss', message: 'hi' }, deps(d, fetchImpl, { nvidiaKey: 'nk', catalog: [...CAT, row('nvidia', 'nvidia/nemotron-3-ultra-550b-a55b')] }), () => {});
  assert.deepEqual([sent[0].url, sent[0].auth, sent[0].body.chat_template_kwargs, sent[0].body.max_tokens >= 8000],
    ['https://integrate.api.nvidia.com/v1/chat/completions', 'Bearer nk', { enable_thinking: true }, true]);
  assert.deepEqual([d.inserts.ai_request_log[0].key_slot, d.inserts.ai_request_log[0].est_cost_usd], ['nvidia', 0]);
});
test('fullwidth citation brackets (【S1】) are read as [S1]; an in-stream "service_unavailable" counts as a 503', async () => {
  let n = 0;
  const fetchImpl = async () => (++n === 1
    ? sseOf([{ choices: [{ delta: { tool_calls: [{ index: 0, id: 't1', type: 'function', function: { name: 'search_company_knowledge', arguments: '{"query":"samples"}' } }] }, finish_reason: 'tool_calls' }] }])
    : sseOf([{ choices: [{ delta: { content: 'Shortlist first 【S' } }] }, { choices: [{ delta: { content: '1】.' }, finish_reason: 'stop' }] }]));
  const searchRpc = async () => [{ chunk_id: 'c1', document_id: 'd1', chunk_index: 0, source_type: 'kb_article', source_id: 'k1', title: 'Sample SOP', url: null, section: null,
    content: 'Shortlist creators first.', brand_id: null, period_start: null, period_end: null, metadata: {}, score: 1 }];
  const d = db({ model: 'openai/gpt-oss-20b', model_key_slot: 'nvidia' });
  const res = await runTurn({ userId: 'u1', role: 'boss', message: 'samples?' }, deps(d, fetchImpl, { nvidiaKey: 'nk', searchRpc, catalog: [...CAT, row('nvidia', 'openai/gpt-oss-20b')] }), () => {});
  assert.equal(res.answer, 'Shortlist first [S1].');
  assert.ok((res.sources as any[]).some((s) => s.cited));
  const e: any = await chatRespond({ apiKey: 'k', model: 'm', instructions: 'I', input: [], onDelta: () => {}, endpoint: 'https://x/chat/completions',
    fetchImpl: (async () => sseOf([{ error: { message: 'busy', code: 'service_unavailable' } }])) as any }).then(() => null, (x) => x);
  assert.equal(e.status, 503);
});
// ── tool calls written as TEXT (live bug 2026-10-01: nemotron showed raw markup) ──

const RANK = { name: 'rank_brands', description: 'Rank brands', parameters: { type: 'object',
  properties: { period: { type: 'string' }, type: { type: 'string' }, order: { type: 'string' }, metric: { type: 'string' }, top_n: { type: 'integer' }, all: { type: 'boolean' }, ids: { type: 'array' } }, required: ['metric'] } };
const QWEN_RAW = '<tool_call>\n<function=rank_brands>\n<parameter=period>\nAugust 2026\n</parameter>\n<parameter=type>\nmonthly\n</parameter>\n<parameter=order>\ndesc\n</parameter>\n<parameter=metric>\ngmv\n</parameter>\n<parameter=top_n>\n5\n</parameter>\n<parameter=all>\nfalse\n</parameter>\n<parameter=ids>\n["a","b"]\n</parameter>\n</function>\n</tool_call>';

test('textTools: every format parses, values are typed, unknown names are refused, markup is stripped', () => {
  const one = (text: string) => parseTextToolCalls(text, [RANK]);
  // Qwen3-coder, the exact live text: values across lines, trimmed and coerced
  const q = one(QWEN_RAW)!;
  assert.equal(q.length, 1);
  assert.deepEqual([q[0].name, JSON.parse(q[0].arguments)],
    ['rank_brands', { period: 'August 2026', type: 'monthly', order: 'desc', metric: 'gmv', top_n: 5, all: false, ids: ['a', 'b'] }]);
  assert.ok(one(QWEN_RAW.replace(/<\/?tool_call>/g, '')), 'also without the wrapper');
  // Hermes, <|tool_call|>, a bare object, an array of objects, "parameters" instead of "arguments"
  assert.deepEqual(JSON.parse(one('<tool_call>{"name":"rank_brands","arguments":{"metric":"gmv"}}</tool_call>')![0].arguments), { metric: 'gmv' });
  const pipe = one('<|tool_call|>{"name":"rank_brands","arguments":"{\\"metric\\":\\"gmv\\"}"}')!;   // arguments as a JSON string
  assert.deepEqual([pipe[0].name, JSON.parse(pipe[0].arguments)], ['rank_brands', { metric: 'gmv' }]);
  assert.equal(one('  {"name":"rank_brands","parameters":{"metric":"gmv"}}')!.length, 1);
  assert.equal(one('[{"name":"rank_brands","arguments":{}},{"name":"rank_brands","arguments":{}}]')!.length, 2);
  // refused: a name the tool list does not have, no tools offered, ordinary prose
  assert.equal(one('<tool_call><function=drop_table><parameter=x>1</parameter></function></tool_call>'), null);
  assert.equal(parseTextToolCalls(QWEN_RAW, []), null);
  assert.equal(one('Our SOP says to shortlist creators.'), null);
  assert.equal(looksLikeToolMarkup('Our SOP says…'), false);
  assert.equal(looksLikeToolMarkup('\n<tool_call>'), true);
  // the strip net
  assert.equal(stripToolMarkup(`Top brands:${QWEN_RAW}`).trim(), 'Top brands:');
  assert.equal(stripToolMarkup('A <tool_call>{"name":"x"}</tool_call> B').replace(/\s+/g, ' ').trim(), 'A B');
});

test('a Nemotron-style turn: the markup never reaches the user, the call runs, and the answer streams', async () => {
  const deltas: string[] = [];
  let n = 0;
  const fetchImpl = async () => (++n === 1
    ? sseOf([...QWEN_RAW.match(/[\s\S]{1,30}/g)!.map((c) => ({ choices: [{ delta: { content: c } }] })), { choices: [{ delta: {}, finish_reason: 'stop' }] }])
    : sseOf([{ choices: [{ delta: { content: 'Obagi leads on GMV.' }, finish_reason: 'stop' }] }]));
  const d = db({ model: 'nvidia/nemotron-3-ultra-550b-a55b', model_key_slot: 'nvidia' });
  const calls: string[] = [];
  const searchRpc = async (fn: string) => { calls.push(fn); return []; };
  const res = await runTurn({ userId: 'u1', role: 'boss', message: 'Top brands by GMV this month' },
    deps(d, fetchImpl, { nvidiaKey: 'nk', searchRpc, catalog: [row('nvidia', 'nvidia/nemotron-3-ultra-550b-a55b')] }), (e) => { if (e.delta) deltas.push(e.delta); });
  assert.equal(res.answer, 'Obagi leads on GMV.');
  assert.ok(!deltas.join('').includes('<tool_call'), 'no markup was streamed');
  assert.ok(!deltas.join('').includes('<function='));
  const log = d.inserts.ai_request_log[0];
  assert.deepEqual([log.flags.text_tool_calls, log.rounds, log.tools[0]?.name], [true, 1, 'rank_brands']);
  assert.ok(calls.length >= 0);
});

test('markup that cannot be read is a model failure: the turn moves on, nothing raw is shown', async () => {
  const deltas: string[] = [];
  const fetchImpl = async (url: string) => (url.includes('nvidia')
    ? sseOf([{ choices: [{ delta: { content: '<tool_call>\n<function=not_a_tool>\n<parameter=x>1</parameter>' } }, ] }, { choices: [{ delta: {}, finish_reason: 'stop' }] }])
    : sseOf([{ choices: [{ delta: { content: 'Here are the top brands.' }, finish_reason: 'stop' }] }]));
  const d = db({ model: 'nvidia/nemotron-3-ultra-550b-a55b', model_key_slot: 'nvidia',
    fallback_models: [{ key_slot: 'gemini', model: 'gemini-3.6-flash' }] });
  const res = await runTurn({ userId: 'u1', role: 'boss', message: 'top brands?' },
    deps(d, fetchImpl, { nvidiaKey: 'nk', catalog: [row('nvidia', 'nvidia/nemotron-3-ultra-550b-a55b'), row('gemini', 'gemini-3.6-flash')] }), (e) => { if (e.delta) deltas.push(e.delta); });
  assert.equal(res.answer, 'Here are the top brands.');
  assert.ok(!deltas.join('').includes('<tool_call'));
  assert.deepEqual(d.inserts.ai_request_log[0].flags.fallback_used, { from: 'nvidia:nvidia/nemotron-3-ultra-550b-a55b', to: 'gemini:gemini-3.6-flash', reason: 'bad_tool_format' });
});