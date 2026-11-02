// Which model answers, on which key, and what to fall back to.
// Owner, 2026-11-02: Buddy uses FREE models only. There is no paid OpenAI key
// any more (the old 'primary' slot is gone); Buddy must never go down, so the
// chain spans several providers.
//
//   slots     gemini / groq = free keys on OpenAI-compatible Chat Completions;
//             fallback = the OpenAI FREE-TIER key (Responses API), restricted
//             to the models the catalog marks free (llm/openai.ts FREE_OPENAI_MODELS);
//             nvidia / nvidia2 = NVIDIA API-catalog keys, for prototyping /
//             testing only per NVIDIA's terms: LAST-RESORT fallbacks, never the
//             configured model, and never given people / pay data.
//   legacy    a stored config that still names the old 'primary' slot does not
//             crash: that entry is dropped and the turn runs on the free chain.
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

import { FREE_OPENAI_MODELS, LlmError } from '../llm/openai.ts';
import { providerAccountIssue, retryAfterMs, type ProviderIssue } from '../providerErrors.ts';
import type { Prices } from '../prices.ts';

export type KeySlot = 'fallback' | 'groq' | 'gemini' | 'nvidia' | 'nvidia2';
export type Api = 'openai-responses' | 'openai-chat';
// `trial`: terms limit it to prototyping / testing: last resort, no private data.
export const SLOTS: Record<KeySlot, { api: Api; base: string; label: string; free: true; trial?: true }> = {
  fallback: { api: 'openai-responses', base: 'https://api.openai.com/v1', label: 'OpenAI (free tier)', free: true },
  groq: { api: 'openai-chat', base: 'https://api.groq.com/openai/v1', label: 'Groq (free)', free: true },
  gemini: { api: 'openai-chat', base: 'https://generativelanguage.googleapis.com/v1beta/openai', label: 'Gemini (free)', free: true },
  // NVIDIA API catalog: free keys for prototyping / testing only (NVIDIA's terms).
  nvidia: { api: 'openai-chat', base: 'https://integrate.api.nvidia.com/v1', label: 'NVIDIA (dev/test only)', free: true, trial: true },
  nvidia2: { api: 'openai-chat', base: 'https://integrate.api.nvidia.com/v1', label: 'NVIDIA (key 2) (dev/test only)', free: true, trial: true },
};
export const KEY_SLOTS = Object.keys(SLOTS) as KeySlot[];
export const isSlot = (s: unknown): s is KeySlot => typeof s === 'string' && (KEY_SLOTS as string[]).includes(s);
export const endpointFor = (slot: KeySlot) => `${SLOTS[slot].base}${SLOTS[slot].api === 'openai-chat' ? '/chat/completions' : '/responses'}`;

export type Target = { keySlot: KeySlot; model: string };
export type Keys = { fallback?: string | null; groq?: string | null; gemini?: string | null; nvidia?: string | null; nvidia2?: string | null };
export type CatalogRow = {
  key_slot: KeySlot; model: string; available: boolean; supports_tools: boolean; supports_stream: boolean;
  free: boolean; params?: { omit?: string[]; token_budget?: number; extra_body?: Record<string, unknown> } | null; last_error?: string | null; reason?: string | null; checked_at?: string;
};
export const keyFor = (keys: Keys, slot: KeySlot): string | null => keys[slot] || null;

// The model that answers when nothing configured is usable: the first of the
// default free chain (Gemini; see DEFAULT_FREE_CHAIN).
const selectable = (c: CatalogRow) => c.available && c.supports_tools && c.supports_stream;
// The OpenAI key is free-tier only: a model on it must be on the allow-list
// AND marked free in the catalog (an uncatalogued key allows the list alone).
const freeOpenAi = (m: string) => FREE_OPENAI_MODELS.includes(m);

// Mirrors public.ai_model_usable (mig 431).
export function modelUsable(catalog: CatalogRow[], slot: KeySlot, model: string): boolean {
  if (!isSlot(slot)) return false;
  if (slot === 'fallback' && !freeOpenAi(model)) return false;
  const rows = catalog.filter((c) => c.key_slot === slot);
  if (rows.length) return rows.some((c) => c.model === model && selectable(c) && (slot !== 'fallback' || c.free));
  return true;       // a slot the refresh has not listed yet: tried anyway
}

// The default free chain, used when the configured chain yields no model at
// all (a legacy config, an empty one). Order from wurx-buddy/model-benchmark.md.
export const DEFAULT_FREE_CHAIN: Target[] = [
  { keySlot: 'gemini', model: 'gemini-3.5-flash-lite' },
  { keySlot: 'groq', model: 'openai/gpt-oss-120b' },
  { keySlot: 'gemini', model: 'gemini-3.6-flash' },
  { keySlot: 'fallback', model: 'gpt-6-luna' },
];

// The Boss's list: the configured model, then the fallbacks. An entry needs
// its key and must be usable (a catalogued slot must list it; an uncatalogued
// slot is tried anyway). Duplicates are dropped. An entry that names a slot
// that no longer exists (the old paid 'primary') or a paid OpenAI model is
// skipped, never fatal; if nothing is left, the default free chain runs. The
// result is never empty.
export function chooseTargets(cfg: { model?: unknown; model_key_slot?: unknown; fallback_models?: unknown; fallback_enabled?: unknown },
  catalog: CatalogRow[], keys: Keys, override?: string | Target | null): Target[] {
  const has = (slot: KeySlot) => !!keyFor(keys, slot);
  hydrateCooldowns(catalog);
  const out: Target[] = [];
  // A local override (serve-assistant --model/--key-slot) is taken as given,
  // except that the free-only rule for the OpenAI key still holds.
  const fromOverride = override && typeof override !== 'string' ? override : null;
  const cand: Target | null = fromOverride ?? (override ? null : isSlot(cfg.model_key_slot) ? { keySlot: cfg.model_key_slot, model: String(cfg.model ?? '') } : null);
  if (cand && cand.model && has(cand.keySlot) && (modelUsable(catalog, cand.keySlot, cand.model) || (fromOverride && !(cand.keySlot === 'fallback' && !freeOpenAi(cand.model))))) out.push(cand);
  if (cfg.fallback_enabled !== false && Array.isArray(cfg.fallback_models)) {
    for (const f of cfg.fallback_models.slice(0, MAX_FALLBACKS)) {
      if (!isSlot(f?.key_slot)) continue;
      const t: Target = { keySlot: f.key_slot, model: String(f?.model ?? '') };
      if (!t.model || !has(t.keySlot) || (t.keySlot === 'fallback' && !freeOpenAi(t.model))) continue;
      const catalogued = catalog.some((c) => c.key_slot === t.keySlot);
      // A model that only failed the check for a passing provider error (503,
      // timeout) stays in the Boss's chain: seen live 2026-10-01 on gemini-3.5-flash.
      const flaky = catalog.some((c) => c.key_slot === t.keySlot && c.model === t.model && c.reason === TRANSIENT_REASON);
      if (catalogued && !flaky && !modelUsable(catalog, t.keySlot, t.model)) continue;
      if (out.some((o) => o.keySlot === t.keySlot && o.model === t.model)) continue;
      out.push(t);
    }
  }
  if (!out.length) for (const t of DEFAULT_FREE_CHAIN) if (has(t.keySlot)) out.push(t);
  // Still nothing (no key at all): one doomed Gemini target, so the turn fails
  // with a clear "key refused / missing" message instead of crashing.
  if (!out.length) out.push(DEFAULT_FREE_CHAIN[0]);
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
  // A role model on a slot that no longer exists (or none: it used to mean the
  // paid key) is ignored; the role's own fallbacks and the global chain remain.
  if (rm.model && isSlot(rm.key_slot)) { out.model = rm.model; out.model_key_slot = rm.key_slot; out.model_source = `role:${r}`; }
  if (Array.isArray(rm.fallback_models)) { out.fallback_models = rm.fallback_models; out.model_source = `role:${r}`; }
  return out;
}

// The automatic safety net (auto_failover): every other usable catalog model
// with a key. Providers alternate so one outage or rate limit never empties it:
// Gemini, then Groq, then the OpenAI free tier, and NVIDIA (trial terms) last.
// Order from the 2026-11-02 benchmark (wurx-buddy/model-benchmark.md): fastest and
// steadiest first; gemini-3.8-flash answered 503 / hung for 60 s, so it goes last.
const GEMINI_ORDER = ['gemini-3.5-flash-lite', 'gemini-3.6-flash', 'gemini-3-flash-preview', 'gemini-flash-lite-latest'];
const GROQ_ORDER = ['openai/gpt-oss-120b', 'qwen/qwen3.8-27b', 'openai/gpt-oss-20b'];
export function netRank(t: Target): number {
  if (t.keySlot === 'gemini') {
    const i = GEMINI_ORDER.indexOf(t.model);
    if (i >= 0) return i;
    if (/flash-lite/.test(t.model)) return 10;
    if (/3\.8-flash/.test(t.model)) return 25;
    if (/^gemma/.test(t.model)) return 20;
    if (/flash/.test(t.model)) return 15;
    return 30;
  }
  if (t.keySlot === 'groq') { const i = GROQ_ORDER.indexOf(t.model); return 100 + (i >= 0 ? i : 10); }
  if (t.keySlot === 'fallback') return 200;
  if (t.keySlot === 'nvidia' || t.keySlot === 'nvidia2') return (t.keySlot === 'nvidia' ? 300 : 320) + (/nemotron/.test(t.model) ? 0 : /laguna/.test(t.model) ? 1 : /gpt-oss/.test(t.model) ? 2 : 5);
  return 400;
}
// NVIDIA models that failed the 2026-11-02 benchmark (hang past the 20 s first-byte
// limit, 404, or a minute per answer): not worth a wait as an automatic fallback.
// The Boss can still choose one by hand.
const NET_DENY = /^(meta\/muse-glimmer|google\/diffusiongemma|nvidia\/nemotron-3-super|openai\/gpt-oss-20b)/;
export function safetyNet(catalog: CatalogRow[], keys: Keys, taken: Target[]): Target[] {
  return catalog
    .filter((c) => isSlot(c.key_slot) && selectable(c) && !!keyFor(keys, c.key_slot) && (c.key_slot !== 'fallback' || (c.free && freeOpenAi(c.model)))
      && !((c.key_slot === 'nvidia' || c.key_slot === 'nvidia2') && NET_DENY.test(c.model))
      && !taken.some((t) => t.keySlot === c.key_slot && t.model === c.model))
    .map((c) => ({ keySlot: c.key_slot, model: c.model }))
    .sort((a, b) => netRank(a) - netRank(b) || a.model.localeCompare(b.model));
}

// ── cooldown: models that just failed, skipped by the next turns ────────────
// In memory (per worker / process): a lost cooldown only costs one quick failure.
// Edge workers are short-lived and many, so a cooldown is also written on the
// model's catalog row (params.cooling) and read back from the catalog at the
// start of every turn (chooseTargets → hydrateCooldowns): the next question,
// on whichever worker, skips a provider that just said quota / auth / 429
// without spending a request on it. A refused key (auth) cools the whole slot.
export type Cooling = { until: number; issue: ProviderIssue | 'busy'; waitMs: number | null };
const cooling = new Map<string, Cooling>();
const ck = (t: Target) => `${t.keySlot}|${t.model}`;
const slotKey = (slot: string) => `${slot}|*`;
export const _resetCooldowns = () => cooling.clear();      // tests
export function coolingDown(t: Target, now = Date.now()): Cooling | null {
  for (const k of [ck(t), slotKey(t.keySlot)]) {
    const c = cooling.get(k);
    if (c && c.until > now) return c;
  }
  return null;
}
// Pull cooldowns other workers recorded into this worker's memory.
export function hydrateCooldowns(catalog: CatalogRow[], now = Date.now()): void {
  for (const c of catalog) {
    const k = (c.params as any)?.cooling;
    if (!k || !(Number(k.until) > now) || !isSlot(c.key_slot)) continue;
    const key = k.slot_wide ? slotKey(c.key_slot) : `${c.key_slot}|${c.model}`;
    const have = cooling.get(key);
    if (!have || have.until < k.until) cooling.set(key, { until: Number(k.until), issue: k.issue ?? 'busy', waitMs: k.waitMs ?? null });
  }
}
// Record the cooldown just set for `t` on its catalog row (best effort).
export async function persistCooldown(admin: any, t: Target, catalog: CatalogRow[] = []): Promise<void> {
  const c = cooling.get(ck(t)) ?? cooling.get(slotKey(t.keySlot));
  if (!c) return;
  await rememberParams(admin, t, { cooling: { until: c.until, issue: c.issue, waitMs: c.waitMs, slot_wide: cooling.has(slotKey(t.keySlot)) } }, catalog);
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
  else if (issue === 'auth') { cooling.set(slotKey(t.keySlot), { until: now + 30 * 60_000, issue: 'auth', waitMs: wait ?? null }); return; }
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
  // The OpenAI key is free-tier only: nothing but the listed free models is
  // ever probed (a probe is a real call), so a refresh cannot bill the account.
  if (SLOTS[slot].api === 'openai-responses' && !FREE_OPENAI_MODELS.includes(id)) return 'paid OpenAI model (Buddy uses free models only)';
  if (DATED.test(id) && all.has(id.replace(DATED, ''))) return 'dated snapshot (its alias is listed)';
  return null;
}
// The chat models of a key.
export function chatModels(ids: string[], slot: KeySlot = 'gemini'): string[] {
  const all = new Set(ids);
  return ids.filter((id) => !skipReason(slot, id, all)).sort();
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
    // OpenAI: only the allow-listed free-tier models are probed; they are free by definition.
    if (!chat) for (const r of rows) r.free = r.available && FREE_OPENAI_MODELS.includes(r.model);
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
