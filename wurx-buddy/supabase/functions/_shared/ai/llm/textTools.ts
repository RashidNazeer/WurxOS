// Tool calls written as TEXT instead of native tool_calls (seen live 2026-10-01:
// nvidia/nemotron-3-ultra answered "Top brands by GMV" with raw
// <tool_call><function=rank_brands><parameter=period>…, shown to the user).
// Pure: parse them into real calls for the tools offered, and strip markup.
//
// Formats: Qwen3-coder <tool_call><function=NAME><parameter=K>V</parameter></function></tool_call>
// (also without the wrapper); Hermes <tool_call>{"name", "arguments"}</tool_call>;
// <|tool_call|> / <|python_tag|> + JSON; a bare {"name", "arguments"|"parameters"} (or an
// array of them) as the whole message.

import type { FunctionTool, ToolCall } from './openai.ts';

// Does a message start like tool-call markup? (only the first ~40 characters count)
const START_RE = /^\s*(<tool_call|<function=|<\|tool_call\|>|<\|python_tag\|>|\[?\s*\{\s*"name"\s*:)/;
export const looksLikeToolMarkup = (head: string): boolean => START_RE.test(head.slice(0, 60));

// A schema-typed value from text: numbers, booleans, JSON objects / arrays.
function coerce(v: string, schema: any): unknown {
  const s = v.trim();
  const type = Array.isArray(schema?.type) ? schema.type.find((t: string) => t !== 'null') : schema?.type;
  if (type === 'number' || type === 'integer') { const n = Number(s); return Number.isFinite(n) ? n : s; }
  if (type === 'boolean') return /^true$/i.test(s) ? true : /^false$/i.test(s) ? false : s;
  if (type === 'object' || type === 'array') { try { return JSON.parse(s); } catch { return s; } }
  return s;
}

let seq = 0;
const id = () => `call_txt_${Date.now().toString(36)}${(seq++).toString(36)}`;

function fromJson(raw: unknown, known: Map<string, FunctionTool>): ToolCall[] {
  const list = Array.isArray(raw) ? raw : [raw];
  const out: ToolCall[] = [];
  for (const x of list as any[]) {
    const name = typeof x?.name === 'string' ? x.name : typeof x?.function?.name === 'string' ? x.function.name : null;
    if (!name || !known.has(name)) continue;
    let args = x.arguments ?? x.parameters ?? x.function?.arguments ?? {};
    if (typeof args === 'string') { try { args = JSON.parse(args); } catch { args = {}; } }
    out.push({ call_id: id(), name, arguments: JSON.stringify(args && typeof args === 'object' ? args : {}) });
  }
  return out;
}

const tryJson = (s: string): unknown => { try { return JSON.parse(s); } catch { return undefined; } };

// The calls in `text` for the offered tools; null when there is nothing usable.
export function parseTextToolCalls(text: string, tools: FunctionTool[] | undefined): ToolCall[] | null {
  if (!tools?.length || !text) return null;
  const known = new Map(tools.map((t) => [t.name, t]));
  const calls: ToolCall[] = [];
  // Qwen3-coder: <function=NAME> … <parameter=K>V</parameter> …
  for (const m of text.matchAll(/<function=([\w.\-]+)>([\s\S]*?)(?:<\/function>|(?=<function=)|$)/g)) {
    const tool = known.get(m[1]);
    if (!tool) continue;
    const props = (tool.parameters as any)?.properties ?? {};
    const args: Record<string, unknown> = {};
    for (const p of m[2].matchAll(/<parameter=([\w.\-]+)>([\s\S]*?)(?:<\/parameter>|(?=<parameter=)|(?=<\/function>)|$)/g)) {
      const v = p[2].replace(/<\/?tool_call>/g, '');
      if (v.trim() !== '') args[p[1]] = coerce(v, props[p[1]]);
    }
    calls.push({ call_id: id(), name: m[1], arguments: JSON.stringify(args) });
  }
  if (calls.length) return calls;
  // Hermes: <tool_call>{json}</tool_call>
  for (const m of text.matchAll(/<tool_call>\s*([\s\S]*?)\s*(?:<\/tool_call>|$)/g)) {
    const j = tryJson(m[1]);
    if (j !== undefined) calls.push(...fromJson(j, known));
  }
  if (calls.length) return calls;
  // <|tool_call|> / <|python_tag|> + JSON, or the whole message as JSON
  const body = text.replace(/<\|(tool_call|python_tag)\|>/g, '').replace(/<\|eom_id\|>|<\|eot_id\|>/g, '').trim();
  const j = tryJson(body);
  if (j !== undefined) calls.push(...fromJson(j, known));
  return calls.length ? calls : null;
}

// Last safety net for answer text: no tool-call markup ever reaches the user.
export function stripToolMarkup(text: string): string {
  return text
    .replace(/<tool_call>[\s\S]*?(<\/tool_call>|$)/g, '')
    .replace(/<function=[\w.\-]+>[\s\S]*?(<\/function>|$)/g, '')
    .replace(/<\/?parameter(=[\w.\-]+)?>|<\/?function(=[\w.\-]+)?>|<\/?tool_call>|<\|(tool_call|python_tag|eom_id|eot_id)\|>/g, '')
    .replace(/\n{3,}/g, '\n\n');
}
