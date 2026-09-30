// Which model answers, on which OpenAI key, and what to fall back to
// (Owner, 2026-10-01: the Boss can pick ANY model; free models are fallbacks).
//
//   catalog   ai_model_catalog (mig 397): per key slot, what each model can do,
//             filled by refreshModels() (the Boss's {refresh_models} action).
//   targets   the configured model first, then ai_assistant_config.fallback_models
//             in order; the turn moves down the list only on an account error
//             (no credits, key refused), before the user sees anything.
//   params    request fields a model rejected (400 unsupported_parameter /
//             unsupported_value) are dropped for that model and remembered.

import { ALLOWED_MODELS, DEFAULT_MODEL, LlmError } from '../llm/openai.ts';
import { providerAccountIssue } from '../providerErrors.ts';
import type { Prices } from '../prices.ts';

export type KeySlot = 'primary' | 'fallback';
export type Target = { keySlot: KeySlot; model: string };
export type Keys = { primary: string; fallback?: string | null };
export type CatalogRow = {
  key_slot: KeySlot; model: string; available: boolean; supports_tools: boolean; supports_stream: boolean;
  free: boolean; params?: { omit?: string[] } | null; last_error?: string | null; checked_at?: string;
};

// Mirrors public.ai_model_usable (mig 397).
export function modelUsable(catalog: CatalogRow[], slot: KeySlot, model: string): boolean {
  const builtin = slot === 'primary' && (ALLOWED_MODELS as readonly string[]).includes(model);
  const rows = catalog.filter((c) => c.key_slot === slot);
  // A built-in that failed its probe only for lack of credits stays choosable:
  // it works again the moment the account is topped up.
  if (rows.length) return rows.some((c) => c.model === model &&
    ((c.available && c.supports_tools && c.supports_stream) || (builtin && /quota|credit/i.test(c.last_error ?? ''))));
  return builtin;
}

const asSlot = (s: unknown): KeySlot => (s === 'fallback' ? 'fallback' : 'primary');

// The ordered list a turn may use. The first entry is the configured model (or
// the safe default); fallbacks need their key, and a catalogued slot must list
// them as usable. Duplicates are dropped.
export function chooseTargets(cfg: { model?: unknown; model_key_slot?: unknown; fallback_models?: unknown; fallback_enabled?: unknown },
  catalog: CatalogRow[], keys: Keys, override?: string | null): Target[] {
  const has = (slot: KeySlot) => (slot === 'primary' ? !!keys.primary : !!keys.fallback);
  let first: Target = { keySlot: asSlot(cfg.model_key_slot), model: String(cfg.model ?? '') };
  if (override) first = { keySlot: 'primary', model: override };
  if (!has(first.keySlot) || !modelUsable(catalog, first.keySlot, first.model)) first = { keySlot: 'primary', model: DEFAULT_MODEL };
  const out: Target[] = [first];
  if (cfg.fallback_enabled !== false && Array.isArray(cfg.fallback_models)) {
    for (const f of cfg.fallback_models.slice(0, 5)) {
      const t: Target = { keySlot: asSlot(f?.key_slot), model: String(f?.model ?? '') };
      if (!t.model || !has(t.keySlot)) continue;
      const catalogued = catalog.some((c) => c.key_slot === t.keySlot);
      if (catalogued && !modelUsable(catalog, t.keySlot, t.model)) continue;
      if (out.some((o) => o.keySlot === t.keySlot && o.model === t.model)) continue;
      out.push(t);
    }
  }
  return out;
}

export const omitFor = (catalog: CatalogRow[], t: Target): string[] =>
  [...new Set([...(catalog.find((c) => c.key_slot === t.keySlot && c.model === t.model)?.params?.omit ?? []), ...learnedOmit(t)])];

// Request fields a model may reject and Buddy can live without.
export const OMITTABLE = new Set(['reasoning', 'include', 'prompt_cache_key', 'parallel_tool_calls', 'max_output_tokens', 'text', 'temperature', 'store']);

// 400 unsupported_parameter / unsupported_value → the top-level field to drop.
export function unsupportedParam(e: unknown): string | null {
  const status = Number((e as LlmError)?.status);
  const msg = String((e as Error)?.message ?? '');
  if (status !== 400 || !/unsupported_(parameter|value)|not supported/i.test(msg)) return null;
  const p = msg.match(/"param"\s*:\s*"([^"]+)"/)?.[1] ?? msg.match(/'([a-z_.]+)' is not supported/i)?.[1] ?? null;
  const top = p?.split('.')[0] ?? null;
  return top && OMITTABLE.has(top) ? top : null;
}

// ── listing and probing (the Boss's {refresh_models}) ───────────────────────

// Chat models only; a dated snapshot only when its alias is not listed.
const NOT_CHAT = /image|audio|realtime|transcribe|tts|embedding|whisper|search|instruct|dall|moderation|codex|chatgpt|computer|-pro\b|^o\d.*-pro/i;
const DATED = /-(\d{4}-\d{2}-\d{2}|\d{4})$/;
export function chatModels(ids: string[]): string[] {
  const base = ids.filter((id) => /^(gpt|o\d)/i.test(id) && !NOT_CHAT.test(id));
  const set = new Set(base);
  return base.filter((id) => !DATED.test(id) || !set.has(id.replace(DATED, ''))).sort();
}

type Probe = { ok: boolean; status: number; body: string; usage?: { input_tokens?: number; output_tokens?: number } };

export type RefreshResult = {
  refreshed_at: string;
  slots: Record<string, { listed: number; probed: number; available: number; usable: number; free: string[]; credits_exhausted: boolean; error?: string }>;
  models: CatalogRow[];
  probe_tokens: { input: number; output: number };
  probe_cost_usd_est: number;
};

export async function refreshModels(o: { keys: Keys; admin: any; prices: Prices; fetchImpl?: typeof fetch; concurrency?: number; limitPerSlot?: number }): Promise<RefreshResult> {
  const doFetch = o.fetchImpl ?? fetch;
  const H = (k: string) => ({ authorization: `Bearer ${k}`, 'content-type': 'application/json' });
  const call = async (key: string, body: Record<string, unknown>): Promise<Probe> => {
    try {
      const r = await doFetch('https://api.openai.com/v1/responses', { method: 'POST', headers: H(key), body: JSON.stringify({ store: false, ...body }), signal: AbortSignal.timeout(30_000) });
      const text = await r.text();
      let usage;
      try { usage = body.stream ? undefined : JSON.parse(text)?.usage; } catch { /* stream or not json */ }
      return { ok: r.ok, status: r.status, body: text, usage };
    } catch (e) { return { ok: false, status: 0, body: String((e as Error)?.message ?? e) }; }
  };
  const tool = [{ type: 'function', name: 'get_time', description: 'Get the local time in a city.', parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] } }];
  const tokens = { input: 0, output: 0 };
  let cost = 0;
  const count = (model: string, p: Probe) => {
    const i = p.usage?.input_tokens ?? 0, out = p.usage?.output_tokens ?? 0;
    tokens.input += i; tokens.output += out;
    const pr = o.prices[model];
    if (pr) cost += (i * pr.in + out * pr.out) / 1e6;
  };
  const result: RefreshResult = { refreshed_at: new Date().toISOString(), slots: {}, models: [], probe_tokens: tokens, probe_cost_usd_est: 0 };

  for (const slot of ['primary', 'fallback'] as KeySlot[]) {
    const key = slot === 'primary' ? o.keys.primary : o.keys.fallback;
    if (!key) continue;
    let ids: string[] = [];
    try {
      const r = await doFetch('https://api.openai.com/v1/models', { headers: H(key), signal: AbortSignal.timeout(20_000) });
      if (!r.ok) throw new Error(`models HTTP ${r.status}`);
      ids = chatModels(((await r.json())?.data ?? []).map((m: { id: string }) => m.id));
    } catch (e) {
      result.slots[slot] = { listed: 0, probed: 0, available: 0, usable: 0, free: [], credits_exhausted: false, error: String((e as Error)?.message ?? e).slice(0, 200) };
      continue;
    }
    if (o.limitPerSlot) ids = ids.slice(0, o.limitPerSlot);
    const rows: CatalogRow[] = [];
    let exhausted = false;
    let next = 0;
    const worker = async () => {
      while (next < ids.length) {
        const model = ids[next++];
        const tiny = await call(key, { model, input: 'Reply with the word ok.', max_output_tokens: 16 });
        count(model, tiny);
        const row: CatalogRow = { key_slot: slot, model, available: tiny.ok, supports_tools: false, supports_stream: false, free: false, params: {}, last_error: null };
        if (!tiny.ok) {
          if (providerAccountIssue({ status: tiny.status, message: tiny.body }) === 'quota' || /credit_balance_exhausted/i.test(tiny.body)) exhausted = true;
          row.last_error = `HTTP ${tiny.status}: ${(tiny.body.match(/"(?:code|type)"\s*:\s*"([^"]+)"/)?.[1] ?? tiny.body).slice(0, 160)}`;
        } else {
          const t = await call(key, { model, input: 'What time is it in Lahore? Use the tool.', tools: tool, max_output_tokens: 200 });
          count(model, t);
          try { row.supports_tools = t.ok && (JSON.parse(t.body)?.output ?? []).some((x: { type?: string }) => x.type === 'function_call'); } catch { row.supports_tools = false; }
          const s = await call(key, { model, input: 'Say hi.', stream: true, max_output_tokens: 16 });
          row.supports_stream = s.ok && /response\.(output_text\.delta|completed)/.test(s.body);
          if (!t.ok) row.last_error = `tools probe HTTP ${t.status}`;
        }
        rows.push(row);
      }
    };
    await Promise.all(Array.from({ length: Math.min(o.concurrency ?? 4, ids.length) }, worker));
    // Free: answered while this key had no credits, or a known price of 0.
    for (const r of rows) {
      const p = o.prices[r.model];
      r.free = r.available && (exhausted || (!!p && p.in === 0 && p.out === 0));
    }
    rows.sort((a, b) => a.model.localeCompare(b.model));
    result.slots[slot] = {
      listed: ids.length, probed: rows.length, available: rows.filter((r) => r.available).length,
      usable: rows.filter((r) => r.available && r.supports_tools && r.supports_stream).length,
      free: rows.filter((r) => r.free).map((r) => r.model), credits_exhausted: exhausted,
    };
    result.models.push(...rows);
  }

  // Upsert what was probed; a model no longer listed on a key becomes unavailable.
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
      await o.admin.from('ai_model_catalog').update({ available: false, last_error: 'no longer listed for this key', checked_at: now })
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
export async function rememberOmit(admin: any, t: Target, omit: string[]): Promise<void> {
  learned.set(`${t.keySlot}|${t.model}`, omit);
  try {
    await admin.from('ai_model_catalog').update({ params: { omit } }).eq('key_slot', t.keySlot).eq('model', t.model);
  } catch { /* not worth failing a turn over */ }
}
