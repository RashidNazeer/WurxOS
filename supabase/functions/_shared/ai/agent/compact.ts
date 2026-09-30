// Compact mode (Lead, 2026-10-01): a model with a small token budget (Groq's
// free tier: 8,000 tokens a minute, counting the input AND max_tokens) gets a
// trimmed request instead of a 413. Seen live: Buddy's round 2 (prompt, tools,
// search results) is ~9-10k. Pure: the loop's shared history is never changed;
// only the request sent to this model is.
//
// Steps, in order, until the estimate fits (with a 15 % margin: our estimate is
// chars/4, a provider's tokenizer may count more):
//   output_1500       cap the reply budget
//   prompt_compact    drop the optional prompt parts (role angle, page context,
//                     page list, surface / search notes); the core rules stay
//   tool_results_N    cut each tool result to N chars from the end: results are
//                     ranked best first, so the lower-ranked sources go first
//   no_more_tools     once results are in, answer with them (no further tool round)

import type { FunctionTool, InputItem } from '../llm/openai.ts';
import type { CatalogRow, KeySlot, Target } from './models.ts';

// Known budgets per key (tokens per request, input + max output).
export const SLOT_BUDGETS: Partial<Record<KeySlot, number>> = { groq: 8000 };
const learned = new Map<string, number>();
export const _resetBudgets = () => learned.clear();     // tests
export const learnBudget = (t: Target, n: number) => learned.set(`${t.keySlot}|${t.model}`, n);

export function budgetFor(catalog: CatalogRow[], t: Target): number | null {
  const fromCatalog = Number((catalog.find((c) => c.key_slot === t.keySlot && c.model === t.model)?.params as any)?.token_budget);
  return learned.get(`${t.keySlot}|${t.model}`) ?? (fromCatalog > 0 ? fromCatalog : null) ?? SLOT_BUDGETS[t.keySlot] ?? null;
}

// "… (TPM): Limit 8000, Requested 9120 …" → { limit: 8000, requested: 9120 }
export const budgetFromError = (msg: string): { limit: number; requested: number | null } | null => {
  const m = /Limit[:\s]+(\d{3,7})/i.exec(msg);
  if (!m) return null;
  const r = /Requested[:\s]+(\d{3,7})/i.exec(msg);
  return { limit: Number(m[1]), requested: r ? Number(r[1]) : null };
};

export type Req = { instructions: string; compactInstructions: string; input: InputItem[]; tools?: FunctionTool[]; maxOutputTokens?: number };
export type Fitted = { instructions: string; input: InputItem[]; tools?: FunctionTool[]; maxOutputTokens?: number; steps: string[]; estimate: number };

export const estimate = (instructions: string, input: InputItem[], tools: FunctionTool[] | undefined, maxOut: number | undefined) =>
  Math.ceil((instructions.length + JSON.stringify(input).length + JSON.stringify(tools ?? []).length) / 4) + (maxOut ?? 0);

const cut = (input: InputItem[], cap: number): InputItem[] => input.map((it: any) => {
  if (it?.type !== 'function_call_output') return it;
  const s = String(it.output ?? '');
  return s.length <= cap ? it : { ...it, output: `${s.slice(0, cap)}\n[… cut to fit this model; lower-ranked results left out]` };
});

export function fitRequest(r: Req, budget: number): Fitted {
  const goal = Math.floor(budget * 0.85);
  let f: Fitted = { instructions: r.instructions, input: r.input, tools: r.tools, maxOutputTokens: r.maxOutputTokens, steps: [], estimate: 0 };
  const est = () => (f.estimate = estimate(f.instructions, f.input, f.tools, f.maxOutputTokens));
  const hasResults = r.input.some((i: any) => i?.type === 'function_call_output');
  const steps: [string, () => void][] = [
    ['output_1500', () => { f.maxOutputTokens = Math.min(f.maxOutputTokens ?? 1500, 1500); }],
    ['prompt_compact', () => { f.instructions = r.compactInstructions; }],
    ['tool_results_3000', () => { f.input = cut(f.input, 3000); }],
    ['tool_results_1500', () => { f.input = cut(f.input, 1500); }],
    ...(hasResults && r.tools?.length ? [['no_more_tools', () => { f.tools = undefined; }] as [string, () => void]] : []),
    ['tool_results_700', () => { f.input = cut(f.input, 700); }],
  ];
  for (const [name, apply] of steps) {
    if (est() <= goal) break;
    apply();
    f.steps.push(name);
  }
  est();
  return f;
}
