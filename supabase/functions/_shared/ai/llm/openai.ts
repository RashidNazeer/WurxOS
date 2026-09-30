// OpenAI Responses API adapter (phase5-design.md §7). Pure TS over fetch:
// runs on Deno and Node. The API key is always passed in.
//
// Stateless (store:false): each call sends the whole input, and the previous
// rounds' output items go back as input, with the reasoning items' encrypted
// content, so the model keeps its chain of thought across tool rounds.

import { providerAccountIssue } from '../providerErrors.ts';

export const ALLOWED_MODELS = ['gpt-5.4-mini', 'gpt-5.5', 'gpt-5.4-nano'] as const;
export const DEFAULT_MODEL = 'gpt-5.4-mini';
export const pickModel = (m: unknown): string => ((ALLOWED_MODELS as readonly string[]).includes(String(m)) ? String(m) : DEFAULT_MODEL);

export type Effort = 'none' | 'minimal' | 'low' | 'medium' | 'high';

// What a model accepts, where it differs (live-checked 2026-09-30): gpt-5.4-nano
// rejects reasoning.effort 'minimal' (400), so an unsupported effort becomes
// 'low' for that model instead of failing the turn. Nano otherwise takes the
// same request: streaming, parallel function tools, encrypted reasoning, cache.
export const MODEL_EFFORTS: Readonly<Record<string, readonly Effort[]>> = Object.freeze({
  'gpt-5.4-nano': ['none', 'low', 'medium', 'high'],
});
export function effortFor(model: string, effort: Effort): Effort {
  const ok = MODEL_EFFORTS[model];
  return !ok || ok.includes(effort) ? effort : 'low';
}

// Provider-neutral function tool (tools/types.ts ToolDef has the same shape).
export type FunctionTool = { name: string; description: string; parameters: Record<string, unknown> };

// Input items: chat messages, plus raw output items of earlier rounds and the
// function_call_output items that answer their calls.
export type InputItem =
  | { role: 'system' | 'developer' | 'user' | 'assistant'; content: string }
  | { type: 'function_call_output'; call_id: string; output: string }
  | Record<string, unknown>;

export type ToolCall = { call_id: string; name: string; arguments: string };

export type Usage = { input: number; cached: number; output: number; reasoning: number };

export type LlmResult = {
  text: string;
  toolCalls: ToolCall[];
  output: Record<string, unknown>[];    // raw output items, to send back next round
  usage: Usage;
  status: string;                        // completed | incomplete | failed
  incompleteReason?: string;             // e.g. max_output_tokens
};

export type LlmRequest = {
  apiKey: string;
  model: string;
  instructions: string;
  input: InputItem[];
  tools?: FunctionTool[];
  effort?: Effort;
  maxOutputTokens?: number;
  onDelta?: (text: string) => void;      // set → streamed
  promptCacheKey?: string;
  timeoutMs?: number;
  deadline?: number;                     // epoch ms: no attempt runs past it, no retry near it
  signal?: AbortSignal;                  // the caller's cancel (Stop)
  omit?: string[];                       // top-level fields this model rejects (agent/models.ts)
  fetchImpl?: typeof fetch;
  endpoint?: string;
};

export class LlmError extends Error {
  status?: number;
  cancelled?: boolean;
  constructor(message: string, status?: number) { super(message); this.name = 'LlmError'; this.status = status; }
}

const ZERO: Usage = { input: 0, cached: 0, output: 0, reasoning: 0 };

export function usageOf(u: any): Usage {
  if (!u) return { ...ZERO };
  return {
    input: u.input_tokens ?? 0,
    cached: u.input_tokens_details?.cached_tokens ?? 0,
    output: u.output_tokens ?? 0,
    reasoning: u.output_tokens_details?.reasoning_tokens ?? 0,
  };
}

// Everything but the text deltas comes from the final response object.
export function resultOf(resp: any, streamedText?: string): LlmResult {
  const output: Record<string, unknown>[] = Array.isArray(resp?.output) ? resp.output : [];
  const toolCalls: ToolCall[] = output.filter((o: any) => o?.type === 'function_call')
    .map((o: any) => ({ call_id: String(o.call_id), name: String(o.name), arguments: String(o.arguments ?? '{}') }));
  const text = streamedText ?? output.filter((o: any) => o?.type === 'message')
    .flatMap((o: any) => o.content ?? []).filter((c: any) => c?.type === 'output_text').map((c: any) => c.text ?? '').join('');
  return {
    text, toolCalls, output, usage: usageOf(resp?.usage), status: String(resp?.status ?? 'completed'),
    ...(resp?.incomplete_details?.reason ? { incompleteReason: String(resp.incomplete_details.reason) } : {}),
  };
}

export function requestBody(r: LlmRequest): Record<string, unknown> {
  const omit = new Set(r.omit ?? []);
  // Without `include`, reasoning items come back without their encrypted
  // content, and sending them back would be refused: drop them from the input.
  const input = omit.has('include') ? r.input.filter((i: any) => i?.type !== 'reasoning') : r.input;
  const body: Record<string, unknown> = {
    model: r.model,
    instructions: r.instructions,
    input,
    ...(r.tools?.length ? { tools: r.tools.map((t) => ({ type: 'function', name: t.name, description: t.description, parameters: t.parameters, strict: false })), parallel_tool_calls: true } : {}),
    ...(r.effort ? { reasoning: { effort: effortFor(r.model, r.effort) } } : {}),
    ...(r.maxOutputTokens ? { max_output_tokens: r.maxOutputTokens } : {}),
    ...(r.promptCacheKey ? { prompt_cache_key: r.promptCacheKey } : {}),
    store: false,
    include: ['reasoning.encrypted_content'],
    stream: !!r.onDelta,
  };
  for (const k of omit) if (!['model', 'instructions', 'input', 'tools', 'stream'].includes(k)) delete body[k];
  return body;
}

// One Responses call. Retries once on 429/5xx/network before any text was streamed.
export async function respond(r: LlmRequest): Promise<LlmResult> {
  const doFetch = r.fetchImpl ?? fetch;
  const endpoint = r.endpoint ?? 'https://api.openai.com/v1/responses';
  for (let attempt = 0; ; attempt++) {
    const cancelledErr = () => Object.assign(new LlmError('cancelled'), { cancelled: true });
    if (r.signal?.aborted) throw cancelledErr();
    const timeoutMs = Math.min(r.timeoutMs ?? 90_000, r.deadline ? r.deadline - Date.now() : Infinity);
    if (timeoutMs <= 0) throw new LlmError('turn deadline reached');
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    const onCancel = () => ctrl.abort();
    r.signal?.addEventListener('abort', onCancel);
    let streamed = false;
    try {
      let res: Response;
      try {
        res = await doFetch(endpoint, {
          method: 'POST',
          signal: ctrl.signal,
          headers: { 'content-type': 'application/json', authorization: `Bearer ${r.apiKey}`, ...(r.onDelta ? { accept: 'text/event-stream' } : {}) },
          body: JSON.stringify(requestBody(r)),
        });
      } catch (e) {
        if (r.signal?.aborted) throw cancelledErr();
        throw new LlmError(ctrl.signal.aborted ? `model call timed out after ${timeoutMs} ms` : `model network error: ${(e as Error)?.message ?? e}`);
      }
      if (!res.ok) {
        const body = (await res.text().catch(() => '')).slice(0, 400);
        throw new LlmError(`model HTTP ${res.status}: ${body}`, res.status);
      }
      if (!r.onDelta) return resultOf(await res.json());
      let text = '';
      let final: any = null;
      await readSse(res, (ev) => {
        if (ev.type === 'response.output_text.delta' && typeof ev.delta === 'string') {
          streamed = true;
          text += ev.delta;
          r.onDelta!(ev.delta);
        } else if (ev.type === 'response.completed' || ev.type === 'response.incomplete') {
          final = ev.response;
        } else if (ev.type === 'response.failed') {
          throw new LlmError(`model failed: ${ev.response?.error?.message ?? 'unknown error'}`);
        } else if (ev.type === 'error') {
          throw new LlmError(`model error: ${ev.message ?? ev.error?.message ?? 'unknown'}`);
        }
      });
      if (!final) throw new LlmError('model stream ended without a response');
      return resultOf(final, text);
    } catch (e) {
      if (r.signal?.aborted) throw cancelledErr();     // a stream read aborted by Stop
      const err = e instanceof LlmError ? e : new LlmError(String((e as Error)?.message ?? e));
      const nearDeadline = r.deadline != null && r.deadline - Date.now() < 10_000;
      // No credits / a refused key: another attempt cannot succeed.
      const retryable = !streamed && !nearDeadline && !providerAccountIssue(err) && (err.status === undefined || err.status === 429 || err.status >= 500);
      if (!retryable || attempt >= 1) throw err;
      await new Promise((ok) => setTimeout(ok, 1500));
    } finally {
      clearTimeout(timer);
      r.signal?.removeEventListener('abort', onCancel);
    }
  }
}

// Server-sent events: "data: {json}" blocks separated by a blank line.
export async function readSse(res: Response, on: (ev: any) => void): Promise<void> {
  if (!res.body) throw new LlmError('model stream has no body');
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  const handle = (block: string) => {
    const data = block.split(/\r?\n/).filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trimStart()).join('\n');
    if (!data || data === '[DONE]') return;
    let ev: any;
    try { ev = JSON.parse(data); } catch { return; }
    on(ev);
  };
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const parts = buf.split(/\r?\n\r?\n/);
    buf = parts.pop() ?? '';
    for (const p of parts) handle(p);
  }
  if (buf.trim()) handle(buf);
}
