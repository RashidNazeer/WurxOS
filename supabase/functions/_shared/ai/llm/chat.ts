// OpenAI-compatible Chat Completions adapter (Groq, Gemini's OpenAI endpoint;
// Owner 2026-10-01: free keys as models and fallbacks). The same request and
// result shapes as the Responses adapter (openai.ts), so the agent loop and its
// history stay provider-neutral: the loop keeps Responses-style items
// (function_call / function_call_output / message), and this file maps them to
// chat messages on the way out and back on the way in.
//
// No reasoning items or encrypted content here (dropped from the input). The
// instructions are the first `system` message, unchanged, so a provider that
// caches prompt prefixes still sees the same prefix every call.

import { httpError, LlmError, providerError, readSse, withRetries, type Effort, type InputItem, type LlmRequest, type LlmResult, type ToolCall, type Usage } from './openai.ts';

type ChatToolCall = { id: string; type: 'function'; function: { name: string; arguments: string }; extra_content?: unknown };
type ChatMessage =
  | { role: 'system' | 'user'; content: string }
  | { role: 'assistant'; content: string | null; tool_calls?: ChatToolCall[] }
  | { role: 'tool'; tool_call_id: string; content: string };

const outputText = (it: any): string =>
  (Array.isArray(it?.content) ? it.content : []).filter((c: any) => c?.type === 'output_text' || c?.type === 'text').map((c: any) => c.text ?? '').join('');

// Loop history → chat messages. Consecutive tool calls become one assistant
// message; each result a `tool` message after it.
// signedCallsOnly (Gemini 3): a tool call in the current turn must carry the
// model's own thought signature, so calls another model made (a turn that
// failed over, live 2026-10-01: 400 INVALID_ARGUMENT) go in as plain context.
export function toMessages(instructions: string, input: InputItem[], o: { signedCallsOnly?: boolean } = {}): ChatMessage[] {
  const out: ChatMessage[] = [{ role: 'system', content: instructions }];
  let turn: { role: 'assistant'; content: string | null; tool_calls: ChatToolCall[] } | null = null;
  const flush = () => {
    if (!turn) return;
    out.push(turn.tool_calls.length ? turn : { role: 'assistant', content: turn.content ?? '' });
    turn = null;
  };
  const foreign = new Map<string, string>();       // call_id → "name(args)"
  let notes: string[] = [];
  const flushNotes = () => {
    if (!notes.length) return;
    out.push({ role: 'user', content: `[Tool results gathered earlier in this answer, by the tools you have; not from the person]\n${notes.join('\n\n')}` });
    notes = [];
  };
  for (const it of input as any[]) {
    if (it?.type === 'reasoning') continue;
    if (o.signedCallsOnly && it?.type === 'function_call' && !it.extra_content) {
      flush();
      foreign.set(String(it.call_id), `${it.name}(${it.arguments ?? '{}'})`);
      continue;
    }
    if (it?.type === 'function_call_output' && foreign.has(String(it.call_id))) {
      notes.push(`${foreign.get(String(it.call_id))} returned:\n${String(it.output ?? '')}`);
      continue;
    }
    flushNotes();
    if (it?.type === 'function_call') {
      turn ??= { role: 'assistant', content: null, tool_calls: [] };
      turn.tool_calls.push({ id: String(it.call_id), type: 'function', function: { name: String(it.name), arguments: String(it.arguments ?? '{}') },
        ...(it.extra_content ? { extra_content: it.extra_content } : {}) });
      continue;
    }
    if (it?.type === 'message' && it.role === 'assistant') {
      flush();
      turn = { role: 'assistant', content: outputText(it) || null, tool_calls: [] };
      continue;
    }
    flush();
    if (it?.type === 'function_call_output') out.push({ role: 'tool', tool_call_id: String(it.call_id), content: String(it.output ?? '') });
    else if (it?.role) out.push({ role: it.role === 'assistant' ? 'assistant' : it.role === 'user' ? 'user' : 'system', content: String(it.content ?? '') } as ChatMessage);
  }
  flush();
  flushNotes();
  return out;
}
const GEMINI_HOST = 'generativelanguage.googleapis.com';

// Chat providers take low / medium / high.
const chatEffort = (e: Effort): string => (e === 'none' || e === 'minimal' ? 'low' : e);

export function chatBody(r: LlmRequest): Record<string, unknown> {
  const stream = !!r.onDelta;
  const body: Record<string, unknown> = {
    model: r.model,
    messages: toMessages(r.instructions, r.input, { signedCallsOnly: (r.endpoint ?? '').includes(GEMINI_HOST) }),
    ...(r.tools?.length ? {
      tools: r.tools.map((t) => {
        // A function without arguments goes without `parameters`: an empty
        // object schema is refused by some providers.
        const props = (t.parameters as any)?.properties;
        const hasArgs = props && typeof props === 'object' && Object.keys(props).length > 0;
        return { type: 'function', function: { name: t.name, description: t.description, ...(hasArgs ? { parameters: t.parameters } : {}) } };
      }),
    } : {}),
    ...(r.maxOutputTokens ? { max_tokens: r.maxOutputTokens } : {}),
    ...(r.effort ? { reasoning_effort: chatEffort(r.effort) } : {}),
    stream,
    ...(stream ? { stream_options: { include_usage: true } } : {}),
  };
  for (const k of r.omit ?? []) if (!['model', 'messages', 'tools', 'stream'].includes(k)) delete body[k];
  return body;
}

function usageOfChat(u: any): Usage {
  if (!u) return { input: 0, cached: 0, output: 0, reasoning: 0 };
  return {
    input: u.prompt_tokens ?? 0,
    cached: u.prompt_tokens_details?.cached_tokens ?? 0,
    output: u.completion_tokens ?? 0,
    reasoning: u.completion_tokens_details?.reasoning_tokens ?? 0,
  };
}

// The result in the loop's (Responses) shape: output items to send back next round.
function result(text: string, calls: ChatToolCall[], usage: Usage, finish: string | null): LlmResult {
  const toolCalls: ToolCall[] = calls.map((c) => ({ call_id: c.id, name: c.function.name, arguments: c.function.arguments || '{}' }));
  const output: Record<string, unknown>[] = [
    ...(text ? [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] }] : []),
    ...calls.map((c) => ({ type: 'function_call', call_id: c.id, name: c.function.name, arguments: c.function.arguments || '{}', ...(c.extra_content ? { extra_content: c.extra_content } : {}) })),
  ];
  return {
    text, toolCalls, output, usage,
    status: finish === 'length' ? 'incomplete' : 'completed',
    ...(finish === 'length' ? { incompleteReason: 'max_output_tokens' } : {}),
  };
}

let seq = 0;
const newId = () => `call_${Date.now().toString(36)}${(seq++).toString(36)}`;

// One Chat Completions call. `r.endpoint` is the provider's .../chat/completions.
export function chatRespond(r: LlmRequest): Promise<LlmResult> {
  const doFetch = r.fetchImpl ?? fetch;
  if (!r.endpoint) throw new LlmError('chatRespond needs the provider endpoint');
  return withRetries(r, async (io) => {
    let res: Response;
    try {
      res = await doFetch(r.endpoint!, {
        method: 'POST',
        signal: io.signal,
        headers: { 'content-type': 'application/json', authorization: `Bearer ${r.apiKey}`, ...(r.onDelta ? { accept: 'text/event-stream' } : {}) },
        body: JSON.stringify(chatBody(r)),
      });
    } catch (e) {
      throw new LlmError(`model network error: ${(e as Error)?.message ?? e}`);
    }
    io.headers();
    if (!res.ok) throw await httpError('model', res);
    if (!r.onDelta) {
      const j = await res.json();
      const m = j?.choices?.[0]?.message ?? {};
      const calls: ChatToolCall[] = (m.tool_calls ?? []).map((c: any) => ({ id: c.id || newId(), type: 'function', function: { name: c.function?.name ?? '', arguments: c.function?.arguments ?? '{}' }, ...(c.extra_content ? { extra_content: c.extra_content } : {}) }));
      return result(typeof m.content === 'string' ? m.content : '', calls, usageOfChat(j?.usage ?? j?.x_groq?.usage), j?.choices?.[0]?.finish_reason ?? null);
    }
    let text = '';
    let usage: Usage = usageOfChat(null);
    let finish: string | null = null;
    const calls: ChatToolCall[] = [];
    await readSse(res, (ev) => {
      if (ev?.error) throw providerError('model error', undefined, ev.error, 'unknown');
      const u = ev?.usage ?? ev?.x_groq?.usage;
      if (u) usage = usageOfChat(u);
      const ch = ev?.choices?.[0];
      if (!ch) return;
      if (ch.finish_reason) finish = ch.finish_reason;
      const d = ch.delta ?? {};
      if (typeof d.content === 'string' && d.content) {
        io.streamed();
        text += d.content;
        r.onDelta!(d.content);
      }
      // Tool calls arrive in pieces, keyed by index (the id and name first, then
      // argument fragments). A provider without indexes sends each call whole.
      for (const tc of Array.isArray(d.tool_calls) ? d.tool_calls : []) {
        const known = tc.id ? calls.findIndex((c) => c?.id === tc.id) : -1;
        const i = typeof tc.index === 'number' ? tc.index : known >= 0 ? known : calls.length;
        calls[i] ??= { id: '', type: 'function', function: { name: '', arguments: '' } };
        const c = calls[i];
        if (tc.id) c.id = tc.id;
        if (tc.function?.name && !c.function.name) c.function.name = tc.function.name;
        if (typeof tc.function?.arguments === 'string') c.function.arguments += tc.function.arguments;
        if (tc.extra_content) c.extra_content = tc.extra_content;
      }
    });
    const done = calls.filter(Boolean).map((c) => ({ ...c, id: c.id || newId() }));
    if (!text && !done.length && !finish) throw new LlmError('model stream ended without a response');
    return result(text, done, usage, finish);
  });
}
