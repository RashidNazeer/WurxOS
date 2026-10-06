// Which model answers, on which key, and what to fall back to
// (Owner, 2026-10-01: the Boss can pick ANY model; free models are fallbacks;
// Buddy must never go down).
//
//   slots     primary / fallback = the two OpenAI keys (Responses API);
//             groq / gemini = free keys on OpenAI-compatible Chat Completions.
//   catalog   ai_model_catalog (mig 397, 401): EVERY model each key lists, with
//             what it can do, or why it cannot be used (`reason`); filled by
//             refreshModels() (the {refresh_models} action).
//   targets   the configured model first, then ai_assistant_config.fallback_models
//             in order, then (auto_failover) every other usable catalog model.
//             A failing model hands the SAME turn to the next one, before any
//             text reached the user. A model that just failed for quota / limit /
//             a refused key cools down, so the next turns skip it.
//   params    request fields a model rejected (400 unsupported ...) are dropped
//             for that model and remembered.

import { ALLOWED_MODELS, DEFAULT_MODEL, LlmError } from '../llm/openai.ts';
import { providerAccountIssue, retryAfterMs, type ProviderIssue } from '../providerErrors.ts';
import type { Prices } from '../prices.ts';

export type KeySlot = 'primary' | 'fallback' | 'groq' | 'gemini' | 'nvidia' | 'nvidia2';
export type Api = 'openai-responses' | 'openai-chat';
export const SLOTS: Record<KeySlot, { api: Api; base: string; label: string; free: boolean }> = {
  primary: { api: 'openai-responses', base: 'https://api.openai.com/v1', label: 'OpenAI', free: false },
  fallback: { api: 'openai-responses', base: 'https://api.openai.com/v1', label: 'OpenAI (fallback key)', free: false },
  groq: { api: 'openai-chat', base: 'https://api.groq.com/openai/v1', label: 'Groq (free)', free: true },
  gemini: { api: 'openai-chat', base: 'https://generativelanguage.googleapis.com/v1beta/openai', label: 'Gemini (free)', free: true },
  // NVIDIA API catalog: free keys for prototyping / testing only (NVIDIA's terms).
  nvidia: { api: 'openai-chat', base: 'https://integrate.api.nvidia.com/v1', label: 'NVIDIA (dev/test only)', free: true },
  nvidia2: { api: 'openai-chat', base: 'https://integrate.api.nvidia.com/v1', label: 'NVIDIA (key 2) (dev/test only)', free: true },
};
export const KEY_SLOTS = Object.keys(SLOTS) as KeySlot[];
export const isSlot = (s: unknown): s is KeySlot => typeof s === 'string' && (KEY_SLOTS as string[]).includes(s);
export const endpointFor = (slot: KeySlot) => `${SLOTS[slot].base}${SLOTS[slot].api === 'openai-chat' ? '/chat/completions' : '/responses'}`;

export type Target = { keySlot: KeySlot; model: string };
export type Keys = { primary: string; fallback?: string | null; groq?: string | null; gemini?: string | null; nvidia?: string | null; nvidia2?: string | null };
export type CatalogRow = {
  key_slot: KeySlot; model: string; available: boolean; supports_tools: boolean; supports_stream: boolean;
  free: boolean; params?: { omit?: string[]; token_budget?: number; extra_body?: Record<string, unknown> } | null; last_error?: string | null; reason?: string | null; checked_at?: string;
};
export const keyFor = (keys: Keys, slot: KeySlot): string | null => (slot === 'primary' ? keys.primary : keys[slot] ?? null) || null;

const BUILTINS = ALLOWED_MODELS as readonly string[];
const selectable = (c: CatalogRow) => c.available && c.supports_tools && c.supports_stream;

// Mirrors public.ai_model_usable (mig 397).
export function modelUsable(catalog: CatalogRow[], slot: KeySlot, model: string): boolean {
  const builtin = slot === 'primary' && BUILTINS.includes(model);
  const rows = catalog.filter((c) => c.key_slot === slot);
  // A built-in that failed its probe only for lack of credits stays choosable:
  // it works again the moment the account is topped up.
  if (rows.length) return rows.some((c) => c.model === model && (selectable(c) || (builtin && /quota|credit/i.test(c.last_error ?? ''))));
  return builtin;
}

// The Boss's list: the configured model (or the safe default), then the
// fallbacks. Fallbacks need their key; a catalogued slot must list them as
// usable (an uncatalogued one is tried anyway). Duplicates are dropped.
export function chooseTargets(cfg: { model?: unknown; model_key_slot?: unknown; fallback_models?: unknown; fallback_enabled?: unknown },
  catalog: CatalogRow[], keys: Keys, override?: string | Target | null): Target[] {
  const has = (slot: KeySlot) => !!keyFor(keys, slot);
  let first: Target = { keySlot: isSlot(cfg.model_key_slot) ? cfg.model_key_slot : 'primary', model: String(cfg.model ?? '') };
  if (override) first = typeof override === 'string' ? { keySlot: 'primary', model: override } : override;
  // A local override (serve-assistant --model/--key-slot) is taken as given.
  const trusted = !!override && typeof override !== 'string';
  if (!has(first.keySlot) || (!trusted && !modelUsable(catalog, first.keySlot, first.model))) first = { keySlot: 'primary', model: DEFAULT_MODEL };
  const out: Target[] = [first];
  if (cfg.fallback_enabled !== false && Array.isArray(cfg.fallback_models)) {
    for (const f of cfg.fallback_models.slice(0, MAX_FALLBACKS)) {
      if (!isSlot(f?.key_slot)) continue;
      const t: Target = { keySlot: f.key_slot, model: String(f?.model ?? '') };
      if (!t.model || !has(t.keySlot)) continue;
      const catalogued = catalog.some((c) => c.key_slot === t.keySlot);
      // A model that only failed the check for a passing provider error (503,
      // timeout) stays in the Boss's chain: seen live 2026-10-01 on gemini-3.5-flash.
      const flaky = catalog.some((c) => c.key_slot === t.keySlot && c.model === t.model && c.reason === TRANSIENT_REASON);
      if (catalogued && !flaky && !modelUsable(catalog, t.keySlot, t.model)) continue;
      if (out.some((o) => o.keySlot === t.keySlot && o.model === t.model)) continue;
      out.push(t);
    }
  }
  return out;
}
export const MAX_FALLBACKS = 6;

// Per-role models (mig 404): the caller's role entry over the globals; a
// missing role or field inherits. The result feeds chooseTargets.
//
// There is deliberately no budget/economy downgrade here. The Owner removed it
// on 2026-10-02: "we have budget or no budget the boss or developers can
// choose the models role wise". Role models are the only override.
export type ModelSource = 'global' | `role:${string}`;
export function resolveRoleConfig<T extends Record<string, unknown>>(cfg: T, role: string):
  T & { model_source: ModelSource } {
  const r = String(role || '').toLowerCase();
  const rm = (cfg.role_models && typeof cfg.role_models === 'object' ? (cfg.role_models as Record<string, any>)[r] : null) ?? null;
  const out: any = { ...cfg, model_source: 'global' };
  if (!rm || typeof rm !== 'object') return out;
  if (rm.model) { out.model = rm.model; out.model_key_slot = rm.key_slot ?? 'primary'; out.model_source = `role:${r}`; }
  if (Array.isArray(rm.fallback_models)) { out.fallback_models = rm.fallback_models; out.model_source = `role:${r}`; }
  return out;
}

// The automatic safety net (auto_failover): every other usable catalog model
// with a key, in this order: Gemini flash family, Groq, the OpenAI fallback
// key, anything else.
// Probe-passing models first (Lead 2026-10-01: 3.5-flash gave 503 on larger requests).
const GEMINI_ORDER = ['gemini-3.6-flash', 'gemini-3-flash-preview', 'gemini-3.5-flash', 'gemini-3.7-flash'];
const GROQ_ORDER = ['openai/gpt-oss-120b', 'qwen/qwen3.8-27b', 'openai/gpt-oss-20b'];
export function netRank(t: Target): number {
  if (t.keySlot === 'gemini') {
    const i = GEMINI_ORDER.indexOf(t.model);
    if (i >= 0) return i;
    if (/flash-lite/.test(t.model)) return 10;
    if (/^gemma/.test(t.model)) return 20;
    if (/flash/.test(t.model)) return 5;
    return 30;
  }
  if (t.keySlot === 'nvidia' || t.keySlot === 'nvidia2') return (t.keySlot === 'nvidia' ? 50 : 60) + (/nemotron/.test(t.model) ? 0 : /gpt-oss/.test(t.model) ? 1 : 5);
  if (t.keySlot === 'groq') { const i = GROQ_ORDER.indexOf(t.model); return 100 + (i >= 0 ? i : 10); }
  if (t.keySlot === 'fallback') return 200;
  return 300;
}
export function safetyNet(catalog: CatalogRow[], keys: Keys, taken: Target[]): Target[] {
  return catalog
    .filter((c) => selectable(c) && !!keyFor(keys, c.key_slot) && !taken.some((t) => t.keySlot === c.key_slot && t.model === c.model))
    .map((c) => ({ keySlot: c.key_slot, model: c.model }))
    .sort((a, b) => netRank(a) - netRank(b) || a.model.localeCompare(b.model));
}

// ── cooldown: models that just failed, skipped by the next turns ────────────
// In memory (per worker / process): a lost cooldown only costs one quick failure.
export type Cooling = { until: number; issue: ProviderIssue | 'busy'; waitMs: number | null };
const cooling = new Map<string, Cooling>();
const ck = (t: Target) => `${t.keySlot}|${t.model}`;
export const _resetCooldowns = () => cooling.clear();      // tests
export function coolingDown(t: Target, now = Date.now()): Cooling | null {
  const c = cooling.get(ck(t));
  return c && c.until > now ? c : null;
}
// How long a failure keeps a model out. A request that was too large says
// nothing about the next (smaller) question, so it does not cool down.
export function coolDown(t: Target, e: unknown, now = Date.now()): void {
  const issue = providerAccountIssue(e);
  const status = Number((e as LlmError)?.status);
  const wait = (e as LlmError)?.retryAfterMs ?? retryAfterMs(String((e as Error)?.message ?? ''));
  let ms: number;
  if (issue === 'too_large') return;
  if (issue === 'quota') ms = 10 * 60_000;
  else if (issue === 'auth') ms = 30 * 60_000;
  else if (issue === 'limit') ms = Math.min(wait ?? 60 * 60_000, 60 * 60_000);
  else if (status === 429) ms = Math.min(Math.max(wait ?? 30_000, 5_000), 5 * 60_000);
  else ms = 60_000;                        // 5xx, a silent model, a timeout
  cooling.set(ck(t), { until: now + ms, issue: issue ?? 'busy', waitMs: wait ?? null });
}

// Extra request fields per model (Chat Completions only): catalog params.extra_body
// wins; NVIDIA Nemotron gets its thinking switch by default (NVIDIA's example).
const NEMOTRON_EXTRA = { chat_template_kwargs: { enable_thinking: true }, temperature: 1, top_p: 0.95 };
export function extraFor(catalog: CatalogRow[], t: Target): Record<string, unknown> | null {
  const own = catalog.find((c) => c.key_slot === t.keySlot && c.model === t.model)?.params?.extra_body;
  if (own && typeof own === 'object') return own;
  return (t.keySlot === 'nvidia' || t.keySlot === 'nvidia2') && /^nvidia\/nemotron/i.test(t.model) ? NEMOTRON_EXTRA : null;
}
// A thinking model spends output tokens on reasoning first: it gets room for both.
export const THINKING_MIN_OUTPUT = 8000;
export const isThinking = (extra: Record<string, unknown> | null) => !!(extra?.chat_template_kwargs as any)?.enable_thinking;

export const omitFor = (catalog: CatalogRow[], t: Target): string[] =>
  [...new Set([...(catalog.find((c) => c.key_slot === t.keySlot && c.model === t.model)?.params?.omit ?? []), ...learnedOmit(t)])];

// Request fields a model may reject and Buddy can live without (both APIs).
export const OMITTABLE = new Set(['reasoning', 'include', 'prompt_cache_key', 'parallel_tool_calls', 'max_output_tokens', 'text', 'temperature', 'store',
  'reasoning_effort', 'max_tokens', 'stream_options', 'tool_choice']);

// A 400 about one request field → the top-level field to drop. OpenAI names it
// in "param"; Groq / Gemini put it in the message ("`reasoning_effort` is not
// supported", 'Unknown name "stream_options"').
export function unsupportedParam(e: unknown): string | null {
  const status = Number((e as LlmError)?.status);
  const msg = String((e as Error)?.message ?? '');
  if (status !== 400 || !/unsupported|not supported|unknown name|must be one of|not allowed|unrecognized|invalid value/i.test(msg)) return null;
  const named = msg.match(/"param"\s*:\s*"([^"]+)"/)?.[1] ?? null;
  const cands = [named, ...[...msg.matchAll(/[`'"\\]+([a-z_]+(?:\.[a-z_]+)*)[`'"\\]+/gi)].map((m) => m[1])].filter(Boolean) as string[];
  for (const p of cands) {
    const top = p.split('.')[0];
    if (OMITTABLE.has(top)) return top;
  }
  return null;
}

// ── listing and probing ({refresh_models}) ──────────────────────────────────

// Why a listed model is not probed at all (no call spent); null = probe it.
const REASONS: [RegExp, string][] = [
  [/embed|retriever|rerank/i, 'embedding / rerank model (not for chat)'],
  [/parse|ocr|deplot/i, 'document parser (not for chat)'],
  [/asr|parakeet|canary|riva/i, 'speech-to-text model (not for chat)'],
  [/translat/i, 'translation model (not for chat)'],
  [/cosmos/i, 'world model (not for chat)'],
  [/clip|vision|-vl\b|vila|neva|kosmos|fuyu|paligemma/i, 'vision model (not for chat)'],
  [/whisper|transcribe/i, 'speech-to-text model (not for chat)'],
  [/tts|orpheus|playai|lyria/i, 'audio model (not for chat)'],
  [/guard|safeguard|safety|moderation/i, 'safety classifier (not for chat)'],
  [/imagen|dall-e|image|nano-banana/i, 'image model (not for chat)'],
  [/veo|sora|video/i, 'video model (not for chat)'],
  [/realtime|native-audio|\blive\b|-live|audio/i, 'live / audio model (not for chat)'],
  [/antigravity/i, 'Interactions API only'],
  [/deep-research/i, 'research agent (not for chat)'],
  [/omni/i, 'not a chat model (omni)'],
  [/allam|compound|distil|aqa|learnlm|robotics|computer-use|gemma-3n/i, 'not a general chat model'],
];
const DATED = /-(\d{4}-\d{2}-\d{2}|\d{4})$/;
export function skipReason(slot: KeySlot, id: string, all: Set<string>): string | null {
  for (const [re, why] of REASONS) if (re.test(id)) return why;
  if (SLOTS[slot].api === 'openai-responses') {
    if (!/^(gpt|o\d)/i.test(id) || /chatgpt|dall|codex|search|instruct|computer/i.test(id)) return 'not a chat model';
    if (/-pro\b|^o\d.*-pro/i.test(id)) return 'pro model (not for Buddy)';
  }
  if (DATED.test(id) && all.has(id.replace(DATED, ''))) return 'dated snapshot (its alias is listed)';
  return null;
}
// Kept for the OpenAI-only callers and tests: the chat models of a key.
export function chatModels(ids: string[]): string[] {
  const all = new Set(ids);
  return ids.filter((id) => !skipReason('primary', id, all)).sort();
}

// A failed probe → the reason the settings screen shows.
export const TRANSIENT_REASON = 'did not answer the check (provider error or timeout)';
function probeReason(status: number, body: string): string {
  if (status === 404 || /not found|retired|deprecated|is not supported for generateContent/i.test(body)) return 'retired or not found on this key';
  if (/Interactions API/i.test(body)) return 'Interactions API only';
  if (providerAccountIssue({ status, message: body }) === 'quota' || /free_tier.*limit: 0|limit: 0/i.test(body)) return 'no quota on this key';
  if (status === 401 || status === 403) return 'this key may not use it';
  if (status === 429) return 'rate limited during the check (try the refresh later)';
  if (status >= 500 || status === 0) return TRANSIENT_REASON;
  return `refused the check (HTTP ${status})`;
}

type Probe = { ok: boolean; status: number; body: string; usage?: { input_tokens?: number; output_tokens?: number } };

export type RefreshResult = {
  refreshed_at: string;
  slots: Record<string, { listed: number; probed: number; available: number; usable: number; free: string[]; credits_exhausted: boolean; error?: string }>;
  models: CatalogRow[];
  probe_tokens: { input: number; output: number };
  probe_cost_usd_est: number;
};

export async function refreshModels(o: { keys: Keys; admin: any; prices: Prices; fetchImpl?: typeof fetch; concurrency?: number; limitPerSlot?: number; slots?: KeySlot[]; retryPauseMs?: number }): Promise<RefreshResult> {
  const doFetch = o.fetchImpl ?? fetch;
  const H = (k: string) => ({ authorization: `Bearer ${k}`, 'content-type': 'application/json' });
  const tokens = { input: 0, output: 0 };
  let cost = 0;
  const result: RefreshResult = { refreshed_at: new Date().toISOString(), slots: {}, models: [], probe_tokens: tokens, probe_cost_usd_est: 0 };

  // One slot: list, classify, probe the chat-looking models (a tiny call; tools
  // and streaming only for the ones that answered).
  const one = async (slot: KeySlot) => {
    const key = keyFor(o.keys, slot);
    if (!key) return;
    const chat = SLOTS[slot].api === 'openai-chat';
    // A provider hiccup (5xx, timeout) gets one more try before it counts.
    const call = async (body: Record<string, unknown>): Promise<Probe> => {
      const p = await call1(body);
      if (p.ok || (p.status !== 0 && p.status < 500)) return p;
      await new Promise((ok) => setTimeout(ok, o.retryPauseMs ?? 2000));
      return call1(body);
    };
    const call1 = async (body: Record<string, unknown>): Promise<Probe> => {
      try {
        const r = await doFetch(endpointFor(slot), { method: 'POST', headers: H(key), body: JSON.stringify(chat ? body : { store: false, ...body }), signal: AbortSignal.timeout(30_000) });
        const text = await r.text();
        let usage;
        try {
          const u = body.stream ? undefined : JSON.parse(text)?.usage;
          usage = u && chat ? { input_tokens: u.prompt_tokens, output_tokens: u.completion_tokens } : u;
        } catch { /* stream or not json */ }
        return { ok: r.ok, status: r.status, body: text, usage };
      } catch (e) { return { ok: false, status: 0, body: String((e as Error)?.message ?? e) }; }
    };
    const count = (model: string, p: Probe) => {
      const i = p.usage?.input_tokens ?? 0, out = p.usage?.output_tokens ?? 0;
      tokens.input += i; tokens.output += out;
      const pr = o.prices[model];
      if (pr && !SLOTS[slot].free) cost += (i * pr.in + out * pr.out) / 1e6;
    };
    const tiny = (model: string) => call(chat ? { model, messages: [{ role: 'user', content: 'Reply with the word ok.' }], max_tokens: 16 } : { model, input: 'Reply with the word ok.', max_output_tokens: 16 });
    const toolProbe = (model: string) => chat
      ? call({ model, messages: [{ role: 'user', content: 'What time is it in Lahore? Use the tool.' }], max_tokens: 300,
        tools: [{ type: 'function', function: { name: 'get_time', description: 'Get the local time in a city.', parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] } } }] })
      : call({ model, input: 'What time is it in Lahore? Use the tool.', max_output_tokens: 200,
        tools: [{ type: 'function', name: 'get_time', description: 'Get the local time in a city.', parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] } }] });
    const streamProbe = (model: string) => call(chat ? { model, messages: [{ role: 'user', content: 'Say hi.' }], stream: true, max_tokens: 16 } : { model, input: 'Say hi.', stream: true, max_output_tokens: 16 });
    const calledTool = (p: Probe) => {
      try {
        const j = JSON.parse(p.body);
        return chat ? (j?.choices?.[0]?.message?.tool_calls ?? []).length > 0 : (j?.output ?? []).some((x: { type?: string }) => x.type === 'function_call');
      } catch { return false; }
    };
    const streamed = (p: Probe) => p.ok && (chat ? /data:\s*\{/.test(p.body) : /response\.(output_text\.delta|completed)/.test(p.body));

    let ids: string[] = [];
    try {
      const r = await doFetch(`${SLOTS[slot].base}/models`, { headers: H(key), signal: AbortSignal.timeout(20_000) });
      if (!r.ok) throw new Error(`models HTTP ${r.status}`);
      ids = [...new Set<string>(((await r.json())?.data ?? []).map((m: { id: string }) => String(m.id).replace(/^models\//, '')))].sort();
    } catch (e) {
      result.slots[slot] = { listed: 0, probed: 0, available: 0, usable: 0, free: [], credits_exhausted: false, error: String((e as Error)?.message ?? e).slice(0, 200) };
      return;
    }
    const all = new Set(ids);
    const rows: CatalogRow[] = [];
    const toProbe: string[] = [];
    for (const id of ids) {
      const why = skipReason(slot, id, all);
      if (why) rows.push({ key_slot: slot, model: id, available: false, supports_tools: false, supports_stream: false, free: SLOTS[slot].free, params: {}, last_error: null, reason: why });
      else toProbe.push(id);
    }
    const probeList = o.limitPerSlot ? toProbe.slice(0, o.limitPerSlot) : toProbe;
    let exhausted = false;
    let next = 0;
    const worker = async () => {
      while (next < probeList.length) {
        const model = probeList[next++];
        const t = await tiny(model);
        count(model, t);
        const row: CatalogRow = { key_slot: slot, model, available: t.ok, supports_tools: false, supports_stream: false, free: SLOTS[slot].free, params: {}, last_error: null, reason: null };
        if (!t.ok) {
          if (!chat && (providerAccountIssue({ status: t.status, message: t.body }) === 'quota' || /credit_balance_exhausted/i.test(t.body))) exhausted = true;
          row.last_error = `HTTP ${t.status}: ${(t.body.match(/"(?:code|type|status)"\s*:\s*"([^"]+)"/)?.[1] ?? t.body).slice(0, 160)}`;
          row.reason = probeReason(t.status, t.body);
        } else {
          const tp = await toolProbe(model);
          count(model, tp);
          row.supports_tools = tp.ok && calledTool(tp);
          const sp = await streamProbe(model);
          row.supports_stream = streamed(sp);
          const hiccup = (p: Probe) => !p.ok && (p.status === 0 || p.status >= 500);
          if (!row.supports_tools) {
            row.last_error = tp.ok ? 'no tool call in the tools check' : `tools probe HTTP ${tp.status}`;
            row.reason = hiccup(tp) ? TRANSIENT_REASON : 'no tool calling (Buddy needs tools)';
          } else if (!row.supports_stream) {
            row.last_error = `stream probe HTTP ${sp.status}`;
            row.reason = hiccup(sp) ? TRANSIENT_REASON : 'no streaming';
          }
        }
        rows.push(row);
      }
    };
    await Promise.all(Array.from({ length: Math.min(o.concurrency ?? 4, probeList.length) }, worker));
    // OpenAI: free = answered while this key had no credits, or a known price of 0.
    if (!chat) for (const r of rows) { const p = o.prices[r.model]; r.free = r.available && (exhausted || (!!p && p.in === 0 && p.out === 0)); }
    rows.sort((a, b) => a.model.localeCompare(b.model));
    result.slots[slot] = {
      listed: ids.length, probed: probeList.length, available: rows.filter((r) => r.available).length,
      usable: rows.filter(selectable).length,
      free: rows.filter((r) => r.free && selectable(r)).map((r) => r.model), credits_exhausted: exhausted,
    };
    result.models.push(...rows);
  };
  // The keys are independent: probed side by side.
  await Promise.all((o.slots ?? KEY_SLOTS).map(one));
  result.models.sort((a, b) => a.key_slot.localeCompare(b.key_slot) || a.model.localeCompare(b.model));

  // Upsert what was listed; a model no longer listed on a key becomes unavailable.
  // Learned params are kept (the probe does not relearn them).
  const now = new Date().toISOString();
  if (result.models.length) {
    const { data: old } = await o.admin.from('ai_model_catalog').select('key_slot, model, params');
    const keep = new Map<string, unknown>((old ?? []).map((r: CatalogRow) => [`${r.key_slot}|${r.model}`, r.params ?? {}]));
    const up = result.models.map((r) => ({ ...r, params: keep.get(`${r.key_slot}|${r.model}`) ?? {}, checked_at: now }));
    const { error } = await o.admin.from('ai_model_catalog').upsert(up, { onConflict: 'key_slot,model' });
    if (error) throw new Error(`catalog write failed: ${error.message}`);
    for (const slot of Object.keys(result.slots)) {
      const listed = result.models.filter((r) => r.key_slot === slot).map((r) => r.model);
      if (!listed.length || o.limitPerSlot) continue;
      await o.admin.from('ai_model_catalog').update({ available: false, last_error: null, reason: 'no longer listed for this key', checked_at: now })
        .eq('key_slot', slot).not('model', 'in', `(${listed.map((m) => `"${m}"`).join(',')})`);
    }
  }
  result.probe_cost_usd_est = Number(cost.toFixed(6));
  return result;
}

// Remember that a model rejects a field: in this process, and on its catalog
// row if it has one. Never inserts a row: a lone row would make its key look
// catalogued and hide every other model (modelUsable).
const learned = new Map<string, string[]>();
export const learnedOmit = (t: Target): string[] => learned.get(`${t.keySlot}|${t.model}`) ?? [];
export async function rememberOmit(admin: any, t: Target, omit: string[], catalog: CatalogRow[] = []): Promise<void> {
  learned.set(`${t.keySlot}|${t.model}`, omit);
  await rememberParams(admin, t, { omit }, catalog);
}
// Merge into the row's params (omit, token_budget, ...): one learning never erases another.
export async function rememberParams(admin: any, t: Target, patch: Record<string, unknown>, catalog: CatalogRow[] = []): Promise<void> {
  const row = catalog.find((c) => c.key_slot === t.keySlot && c.model === t.model);
  const params = { ...(row?.params ?? {}), ...patch };
  if (row) row.params = params as CatalogRow['params'];
  try {
    await admin.from('ai_model_catalog').update({ params }).eq('key_slot', t.keySlot).eq('model', t.model);
  } catch { /* not worth failing a turn over */ }
}
