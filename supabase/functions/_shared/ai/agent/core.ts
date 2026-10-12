// The v2 agent turn (phase5-design.md §7): one question in, an SSE-shaped
// event stream out. Transport-free: the Deno function and the local Node
// server both call runTurn with their own clients and an `emit`.
//
// Events (v1's contract + started/sources/requestId, A§13):
//   {started, conversationId, requestId, messageId}  {status}  {delta}
//   {sources:[{id,source_type,source_id,title,url,period,cited}]}
//   {error} | {cancelled:true}   {done:true, conversationId, requestId, messageId, status, cancelled?}

import type { Rpc } from '../ingest/db.ts';
import { retrievalConfig } from '../retrieval/config.ts';
import type { Reranker } from '../retrieval/search.ts';
import { respond, type InputItem, type LlmRequest, type LlmResult, type Usage } from '../llm/openai.ts';
import { chooseTargets, coolDown, coolingDown, endpointFor, extraFor, isThinking, keyFor, THINKING_MIN_OUTPUT, omitFor, rememberOmit, rememberParams, resolveRoleConfig, safetyNet, SLOTS, unsupportedParam, type CatalogRow, type KeySlot, type Keys, type Target } from './models.ts';
import { chatRespond } from '../llm/chat.ts';
import { stripToolMarkup } from '../llm/textTools.ts';
import { agentConfig, type AgentConfig } from './config.ts';
import { costUsd, pricesFrom, type Prices, type UsageMeter } from '../prices.ts';
import { providerAccountIssue, providerIssueMessage, scrubSecrets, type ChainIssue } from '../providerErrors.ts';
import { CitationStream, citedIds, numbersWithoutData } from './citations.ts';
import { buildInstructions, compactInstructions, effectivePersona, isSeriousTopic } from './prompt.ts';
import { budgetFor, budgetFromError, estimate, fitRequest, learnBudget } from './compact.ts';
import { CiteRegistry, newTurnGuard, runTool, toolDefsFor, TOOL_STATUS, type ToolEnv, type ToolLog } from './tools.ts';
import { usableProviders, webAllowedForRole, webConfig, type WebEnv, type WebKeys, type WebUsage } from '../web/index.ts';

export type Emit = (ev: Record<string, unknown>) => void;

export type TurnRequest = {
  userId: string;
  role: string;
  displayName?: string | null;
  message: string;
  conversationId?: string | null;
  regenerate?: string | null;         // an assistant messageId: answer its question again, in place
  surface?: 'quick' | 'full' | 'slack';  // quick panel → concise answers; slack = the internal relay
  pageContext?: PageContext | null;    // a hint only; never used for permissions
};

export type PageContext = { route: string; brand_id?: string; report_id?: string; kb_id?: string };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Browser-supplied, so validated and capped: an app path and at most three ids.
export function cleanPageContext(raw: unknown): PageContext | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const route = typeof r.route === 'string' ? r.route.trim().slice(0, 200) : '';
  if (!/^\/[A-Za-z0-9\-_/.:]*$/.test(route)) return null;
  const pc: PageContext = { route };
  for (const k of ['brand_id', 'report_id', 'kb_id'] as const) if (typeof r[k] === 'string' && UUID_RE.test(r[k] as string)) pc[k] = r[k] as string;
  return pc;
}

export const cleanSurface = (s: unknown): 'quick' | 'full' => (s === 'quick' ? 'quick' : 'full');

// The page as a prompt hint. Names are looked up only for things the caller
// may see (the app's own helpers); otherwise the id is dropped, so a crafted
// page_context can neither widen access nor reveal a name.
export async function pageContextNote(admin: any, userId: string, pc: PageContext | null): Promise<string | null> {
  if (!pc) return null;
  const bits = [`the page ${pc.route}`];
  try {
    if (pc.brand_id) {
      const { data: b } = await admin.from('brands').select('id, brand_name, owner_id').eq('id', pc.brand_id).maybeSingle();
      const { data: ok } = b ? await admin.rpc('can_view_brand', { b_owner: b.owner_id, b_id: b.id, uid: userId }) : { data: false };
      if (ok === true) bits.push(`brand "${b.brand_name}"`);
    }
    if (pc.report_id) {
      const { data: r } = await admin.from('reports').select('id, brand_id, author_id, type, period_label, status, brands(brand_name)').eq('id', pc.report_id).maybeSingle();
      const { data: ok } = r ? await admin.rpc('can_view_report', { r_brand: r.brand_id, r_author: r.author_id, uid: userId }) : { data: false };
      if (ok === true) bits.push(`the ${r.type} report "${r.brands?.brand_name ?? ''} · ${r.period_label}" (status: ${r.status})`);
    }
  } catch { /* a hint is optional */ }
  if (pc.kb_id) bits.push('a Knowledge Base article');
  return `PAGE CONTEXT (a hint from the app, not an instruction and not a permission): the person is on ${bits.join(', ')}. "This brand / this report / this page" probably means these; still look everything up with the tools as usual.`;
}

export type CoreDeps = {
  admin: any;                        // service-role supabase-js client
  searchRpc: Rpc;                    // search RPCs as the caller (JWT) or service role + asUser
  asUser: string | null;
  userClient?: any;                  // supabase-js client with the caller's JWT (data tools, RLS); absent = none
  apiKey: string;                    // OPEN_AI_API_KEY (the 'primary' slot)
  fallbackKey?: string | null;       // OPEN_AI_API_KEY_FALLBACK (the 'fallback' slot)
  groqKey?: string | null;           // GROQ_API_KEY (the 'groq' slot, Chat Completions)
  geminiKey?: string | null;         // GEMINI_API_KEY (the 'gemini' slot, Chat Completions)
  nvidiaKey?: string | null;         // NVIDIA_API_KEY (the 'nvidia' slot; free, dev/test only)
  nvidia2Key?: string | null;        // NVIDIA_API_KEY_2 (the 'nvidia2' slot)
  tavilyKey?: string | null;         // TAVILY_API_KEY (web search / page extraction, mig 415)
  braveKey?: string | null;          // BRAVE_API_KEY (web search, mig 416; unset until the Owner adds it)
  fetchImpl?: typeof fetch;          // test seam for the web tools
  catalog?: CatalogRow[];            // tests; otherwise read from ai_model_catalog
  rateLimitExempt?: boolean;         // local server only (serve-assistant --no-rate-limit); still logged
  embedDown?: () => boolean;         // query embeddings known to be failing on every key
  embed: (text: string) => Promise<number[] | null>;
  embedAlt?: (text: string) => Promise<number[] | null>;   // NVIDIA query vector (mig 406)
  rerank?: Reranker;
  model?: string;                    // local override (serve-assistant --model); still allow-listed
  modelKeySlot?: KeySlot;            // with `model`: that key, taken as given (serve-assistant --key-slot)
  meter?: UsageMeter;                // rerank + query-embedding usage of this question (→ ai_usage_log)
  now?: () => Date;
  llm?: (r: LlmRequest) => Promise<LlmResult>;   // test seam (also used for chat slots unless chatLlm is set)
  chatLlm?: (r: LlmRequest) => Promise<LlmResult>;
  requestId?: string;
};

export type TurnResult = { requestId: string; conversationId: string | null; messageId?: string; answer: string; sources: unknown[]; error?: string; httpStatus?: number; cancelled?: boolean };

const ZERO: Usage = { input: 0, cached: 0, output: 0, reasoning: 0 };
// Failover bounds: at most this many model calls in a turn, and no
// switch when less time than this is left (the answer needs room too).
export const MAX_MODEL_ATTEMPTS = 8;
export const SWITCH_MIN_LEFT_MS = 15_000;
const add = (a: Usage, b: Usage): Usage => ({ input: a.input + b.input, cached: a.cached + b.cached, output: a.output + b.output, reasoning: a.reasoning + b.reasoning });

async function loadConfig(admin: any) {
  const cols = 'persona, model, enabled, retrieval, prices, model_key_slot, fallback_models, fallback_enabled';
  const { data, error } = await admin.from('ai_assistant_config')
    .select(`${cols}, auto_failover, role_models, web_search_enabled, web_providers, searxng_url, web_max_results, web_allowed_roles`)
    .eq('id', 1).maybeSingle();
  // Before mig 401 / 404 / 415 there are no auto_failover / role_models / web_* columns: read the rest.
  if (error) return (await admin.from('ai_assistant_config').select(cols).eq('id', 1).maybeSingle()).data ?? {};
  return data ?? {};
}

// Rate limit (QA m2): counted and recorded atomically when the turn STARTS
// (ai_turn_begin, mig 386), so parallel sends can't slip past the cap. Without
// that function (older DB) it falls back to counting finished turns.
async function beginTurn(admin: any, cfg: AgentConfig, userId: string, requestId: string, question: string, model: string, now: Date, forceExempt = false):
  Promise<{ limited: boolean; logged: boolean }> {
  const exempt = forceExempt || cfg.RATE_LIMIT_EXEMPT_USERS.includes(userId);
  const { data, error } = await admin.rpc('ai_turn_begin', {
    p_request_id: requestId, p_user_id: userId, p_question: question, p_model: model, p_limit: exempt ? null : cfg.RATE_LIMIT_PER_USER_PER_HOUR,
  });
  if (!error) return { limited: data === 'rate_limited', logged: data === 'ok' };
  if (exempt) return { limited: false, logged: false };
  const since = new Date(now.getTime() - 3600_000).toISOString();
  const { count, error: e2 } = await admin.from('ai_request_log').select('id', { count: 'exact', head: true })
    .eq('user_id', userId).gte('created_at', since);
  return { limited: !e2 && (count ?? 0) >= cfg.RATE_LIMIT_PER_USER_PER_HOUR, logged: false };
}

// Last turns within the char cap, oldest first. Tool results are never stored, so never replayed.
export function trimHistory(rowsNewestFirst: { role: string; content: string }[], turns: number, cap: number): InputItem[] {
  const out: { role: 'user' | 'assistant'; content: string }[] = [];
  let chars = 0;
  for (const m of rowsNewestFirst.slice(0, turns)) {
    chars += (m.content ?? '').length;
    if (chars > cap) break;
    if (m.role === 'user' || m.role === 'assistant') out.push({ role: m.role, content: m.content });
  }
  return out.reverse();
}

class Stop extends Error {}

// The spend of a question outside the chat model, as ai_usage_log rows.
export function usageRows(meter: UsageMeter | undefined, prices: Prices, who: { user_id: string; request_id: string }) {
  const rows: Record<string, unknown>[] = [];
  // Every column, in every row: a bulk insert sends null for a key some rows
  // lack, which a column default does not catch (QA 2026-10-01 F2).
  if (meter?.rerank.calls) {
    const r = meter.rerank;
    const c = costUsd(prices, r.model, { input: r.input, cached: r.cached, output: r.output });
    rows.push({ ...who, kind: 'rerank', model: r.model, key_slot: 'primary', calls: r.calls, tokens_in: r.input, tokens_cached: r.cached, tokens_out: r.output,
      est_cost_usd: Number(c.usd.toFixed(6)), unpriced: !c.priced });
  }
  if (meter?.embed.calls) {
    const m = meter.embed;
    const c = costUsd(prices, m.model, { input: m.input });
    rows.push({ ...who, kind: 'embed_query', model: m.model, key_slot: m.keySlot ?? 'primary', calls: m.calls, tokens_in: m.input, tokens_cached: 0, tokens_out: 0,
      est_cost_usd: Number(c.usd.toFixed(6)), unpriced: !c.priced });
  }
  return rows;
}

// Web calls as ai_usage_log rows (mig 415). Tavily bills in credits, not
// tokens, so the credit count goes in tokens_in (the only integer column the
// usage view sums) and est_cost_usd stays 0 with unpriced=true: the Boss sees
// HOW MUCH was used without Buddy inventing a dollar rate for a plan it cannot
// see. SearXNG is the company's own instance, so it is free by definition.
export function webUsageRows(entries: { kind: 'web_search' | 'web_extract'; usage: WebUsage[] }[],
  who: { user_id: string; request_id: string }) {
  const byKey = new Map<string, { kind: string; provider: string; calls: number; credits: number }>();
  for (const e of entries) {
    for (const u of e.usage) {
      const k = `${e.kind}|${u.provider}`;
      const prev = byKey.get(k) ?? { kind: e.kind, provider: u.provider, calls: 0, credits: 0 };
      prev.calls += u.calls;
      prev.credits += u.credits;
      byKey.set(k, prev);
    }
  }
  return [...byKey.values()].map((v) => ({
    ...who, kind: v.kind, model: v.provider, key_slot: 'web', calls: v.calls,
    tokens_in: Math.round(v.credits), tokens_cached: 0, tokens_out: 0,
    est_cost_usd: 0, unpriced: v.credits > 0,
  }));
}

export async function runTurn(req: TurnRequest, deps: CoreDeps, emit: Emit): Promise<TurnResult> {
  const t0 = Date.now();
  const now = deps.now?.() ?? new Date();
  const requestId = deps.requestId ?? crypto.randomUUID();
  const llm = deps.llm ?? respond;
  const admin = deps.admin;
  const regenerate = req.regenerate ?? null;
  let message = String(req.message ?? '').trim();

  const [row] = await Promise.all([
    loadConfig(admin),
    // QA M1: rows a killed turn left 'generating' are finished here too, not only by cron.
    Promise.resolve(admin.rpc('ai_finish_stale_replies', { p_minutes: 10 })).catch(() => null),
  ]);
  const agent = agentConfig(row.retrieval);
  const retrieval = retrievalConfig(row.retrieval).config;
  // The model chain (mig 397): the configured model on its key, then the
  // fallbacks. `target` moves down it on an account error (no credits, key refused).
  let catalog: CatalogRow[] = deps.catalog ?? [];
  if (!deps.catalog) { try { catalog = (await admin.from('ai_model_catalog').select('*')).data ?? []; } catch { catalog = []; } }
  const keys: Keys = { primary: deps.apiKey, fallback: deps.fallbackKey ?? null, groq: deps.groqKey ?? null, gemini: deps.geminiKey ?? null,
    nvidia: deps.nvidiaKey ?? null, nvidia2: deps.nvidia2Key ?? null };
  const override: string | Target | null = deps.model ? (deps.modelKeySlot ? { keySlot: deps.modelKeySlot, model: deps.model } : deps.model) : null;
  // Per-role models (mig 404): the Boss / a developer picks the model per role.
  const resolved = resolveRoleConfig(row, req.role);
  const chain = chooseTargets(resolved, catalog, keys, override);
  // Buddy must never go down (Owner 2026-10-01): after the Boss's chain, every
  // other usable model in the catalog, unless auto_failover is switched off.
  const targets = row.auto_failover === false ? chain : [...chain, ...safetyNet(catalog, keys, chain)];
  let ti = 0;
  let target = targets[0];
  let model = target.model;
  const prices = pricesFrom(row.prices);
  const fail = (error: string, httpStatus: number): TurnResult => ({ requestId, conversationId: req.conversationId ?? null, answer: '', sources: [], error, httpStatus });
  if (row.enabled === false) return fail('The assistant is currently turned off by an admin.', 503);

  // Regenerate: the same question again, answered in place of the last reply.
  let conversationId = req.conversationId ?? null;
  let regen: { oldId: string; questionAt: string; oldStatus: string; oldMeta: Record<string, unknown> } | null = null;
  if (regenerate) {
    const r = await regenerateTarget(admin, req.userId, regenerate);
    if ('error' in r) return fail(r.error, r.status);
    ({ conversationId } = r);
    message = r.question;
    regen = { oldId: regenerate, questionAt: r.questionAt, oldStatus: r.oldStatus, oldMeta: r.oldMeta };
  }

  if (!message) return fail('empty message', 400);
  if (message.length > agent.MESSAGE_MAX_CHARS) return fail('message too long', 400);

  // Own the conversation before anything is recorded.
  if (conversationId && !regen) {
    const { data: conv } = await admin.from('ai_conversations').select('id, user_id').eq('id', conversationId).maybeSingle();
    if (!conv || conv.user_id !== req.userId) return fail('conversation not found', 404);
  }
  const begun = await beginTurn(admin, agent, req.userId, requestId, message, model, now, deps.rateLimitExempt === true);
  if (begun.limited) return fail(`You've reached ${agent.RATE_LIMIT_PER_USER_PER_HOUR} questions this hour. Please try again a little later.`, 429);
  if (!conversationId) {
    const { data: created, error } = await admin.from('ai_conversations').insert({ user_id: req.userId, title: message.slice(0, 60) }).select('id').single();
    if (error) return fail(error.message, 500);
    conversationId = created.id;
  }

  // The question and a 'generating' reply row go in before any work: the
  // reply is finished and saved even if the browser disconnects (ui-design §6).
  // A regenerate reuses its question row, and supersedes the old reply only
  // if nobody else did first (two clicks, two tabs).
  let messageId: string;
  if (regen) {
    const { data: sup, error: sErr } = await admin.from('ai_messages').update({ status: 'superseded' })
      .eq('id', regen.oldId).in('status', ['done', 'error']).select('id');
    if (sErr) return fail(sErr.message, 500);
    if (!sup?.length) return fail('that reply was already regenerated or is still being written', 409);
    const { data: made, error: mErr } = await admin.from('ai_messages').insert(
      { conversation_id: conversationId, role: 'assistant', content: '', status: 'generating', meta: { requestId, supersedes: regen.oldId }, created_at: new Date(t0).toISOString() },
    ).select('id').single();
    if (mErr) {
      await admin.from('ai_messages').update({ status: regen.oldStatus }).eq('id', regen.oldId);
      return fail(mErr.message, 500);
    }
    messageId = made.id;
    await admin.from('ai_messages').update({ meta: { ...regen.oldMeta, superseded_by: messageId } }).eq('id', regen.oldId);
  } else {
    const { data: made, error: mErr } = await admin.from('ai_messages').insert([
      { conversation_id: conversationId, role: 'user', content: message, status: 'done', meta: { requestId }, created_at: new Date(t0).toISOString() },
      { conversation_id: conversationId, role: 'assistant', content: '', status: 'generating', meta: { requestId }, created_at: new Date(t0 + 1).toISOString() },
    ]).select('id, role');
    if (mErr) return fail(mErr.message, 500);
    messageId = (made ?? []).find((m: any) => m.role === 'assistant')?.id;
  }
  // First event, before any model or retrieval work, so the UI can always Stop.
  emit({ started: true, conversationId, requestId, messageId, server_now: new Date().toISOString(), ...(regen ? { regenerated: regen.oldId } : {}) });

  // Context: finished turns only (superseded, error and generating rows never
  // reach the model), and for a regenerate only what came before its question.
  let hq = admin.from('ai_messages').select('role, content').eq('conversation_id', conversationId).eq('status', 'done');
  hq = regen ? hq.lt('created_at', regen.questionAt) : hq.lt('created_at', new Date(t0).toISOString());
  const { data: hist } = await hq.order('created_at', { ascending: false }).limit(agent.HISTORY_TURNS);
  const history = trimHistory(hist ?? [], agent.HISTORY_TURNS, agent.HISTORY_CHAR_CAP);

  // Stop (QA M2): the owner's POST {cancel} sets cancel_requested_at; polled here.
  const cancelCtrl = new AbortController();
  let cancelled = false;
  const checkCancel = async () => {
    if (cancelled) return true;
    try {
      const { data } = await admin.from('ai_messages').select('cancel_requested_at').eq('id', messageId).maybeSingle();
      if (data?.cancel_requested_at) { cancelled = true; cancelCtrl.abort(); }
    } catch { /* a failed poll is not a cancel */ }
    return cancelled;
  };
  const poller = setInterval(() => { void checkCancel(); }, agent.CANCEL_POLL_MS);

  // QA M1: one deadline for the whole turn, well inside the edge wall clock.
  const deadline = t0 + agent.TURN_DEADLINE_MS;
  const left = () => deadline - Date.now();

  const persona = effectivePersona(row.persona);
  // The open internet (mig 415): off unless switched on AND this role is
  // allowed AND a provider is actually usable. All three have to hold, or the
  // tools are not offered and the prompt never mentions the web.
  const webCfg = webConfig(row);
  const webKeys: WebKeys = { tavily: deps.tavilyKey ?? null, brave: deps.braveKey ?? null };
  const webEnv: WebEnv | null = (() => {
    if (!webAllowedForRole(webCfg, req.role)) return null;
    const env: WebEnv = { config: webCfg, keys: webKeys, ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}) };
    return usableProviders(env).length ? env : null;
  })();
  const webUsage: { kind: 'web_search' | 'web_extract'; usage: WebUsage[] }[] = [];
  const turnGuard = newTurnGuard(message);
  const toolsCalled: string[] = [];
  let serious = isSeriousTopic(message);
  const surface = req.surface === 'slack' ? 'slack' : cleanSurface(req.surface);
  const notes = [
    ...(surface === 'quick' ? ['SURFACE: the quick-chat panel. Keep the answer short: at most ~120 words or 5 bullets, the key facts with their citations, and offer the full version ("Open in Buddy ↗" shows more).'] : []),
    ...[await pageContextNote(admin, req.userId, req.pageContext ?? null)].filter((x): x is string => !!x),
    ...(deps.embedDown?.() ? ['SEARCH is in keyword-only mode right now (no semantic search): search with the exact words a document would use, and if you cannot find something, say so plainly.'] : []),
  ];
  const { instructions } = buildInstructions({ persona: persona.text, role: req.role, displayName: req.displayName, now, notes, web: !!webEnv });
  const compactBase = compactInstructions({ persona: persona.text, role: req.role, displayName: req.displayName, now, web: !!webEnv });
  const compactTried = new Set<string>();

  // Search without embeddings (no credits on any key): the keyword arm only.
  let embedFailed = false;
  const embedWatched = async (text: string) => {
    try { const v = await deps.embed(text); if (!v) embedFailed = true; return v; } catch (e) { embedFailed = true; throw e; }
  };
  const reg = new CiteRegistry();
  const env: ToolEnv = {
    admin, searchRpc: deps.searchRpc, asUser: deps.asUser, embed: embedWatched, embedAlt: deps.embedAlt, rerank: deps.rerank,
    // The per-turn guard, seeded with any link the person put in their own
    // message (those they may always open). It is created whether or not the
    // web is on, because it also latches "private data has been read", which
    // gates free-tier model failover.
    turn: turnGuard,
    ...(webEnv ? { web: webEnv, onWebUsage: (kind, usage) => { webUsage.push({ kind, usage }); } } : {}),
    // userClient: the caller's own JWT client, so people & pay tools read under
    // that user's RLS (Engineer 2, ui-design §8). None on the internal (Boss) path.
    retrieval, agent, ctx: { userId: req.userId, role: req.role, ...(deps.userClient ? { userClient: deps.userClient } : {}) }, now,
  };
  const cstream = new CitationStream(reg.has, () => serious);
  let answer = '';
  let firstTokenMs: number | null = null;
  const onDelta = (d: string) => {
    if (cancelled) return;
    // Some models cite with fullwidth brackets (gpt-oss on NVIDIA, live 2026-10-01: 【S1】).
    const safe = cstream.push(d.replace(/【/g, '[').replace(/】/g, ']'));
    if (!safe) return;
    if (firstTokenMs == null) firstTokenMs = Date.now() - t0;
    answer += safe;
    emit({ delta: safe });
  };
  let costSum = 0;
  let unpriced = false;
  // Every account problem met on the way down the chain, for the final message.
  const chainIssues: ChainIssue[] = [];
  // Each model call (success or not), for diagnosing a failed turn.
  const attempts: { target: string; ms: number; error?: string }[] = [];
  const chatLlm = deps.chatLlm ?? deps.llm ?? chatRespond;
  const tag = (t: Target) => `${t.keySlot}:${t.model}`;
  // The SAME turn moves to the next model. Encrypted reasoning belongs to the
  // model (and key) that made it, so it is dropped.
  let switchedNotice = false;
  const moveOn = (reason: string) => {
    target = targets[++ti];
    model = target.model;
    flags.fallback_used = { from: tag(targets[0]), to: tag(target), reason };
    for (let i = input.length - 1; i >= 0; i--) if ((input[i] as any)?.type === 'reasoning') input.splice(i, 1);
    if (!switchedNotice) { switchedNotice = true; emit({ status: 'Switching to a backup model…' }); }
  };
  // One model call on the current target. A field the model rejects is dropped
  // and remembered. Any other failure before text reached the user hands the
  // turn to the next model, within MAX_MODEL_ATTEMPTS and the deadline.
  const ask = async (o: Partial<LlmRequest>): Promise<LlmResult> => {
    for (let paramTries = 0; ;) {
      // A model that just failed for quota / limit / a refused key is skipped
      // (the last one left is always tried).
      // Pay data must not fail over onto a free tier. Once a people/pay tool
      // has returned, its output is in `input`, and every later model call
      // carries it — so a quota error on the paid key would have handed
      // salaries to Gemini/Groq/NVIDIA free endpoints, whose terms are not
      // what we would choose for payroll (QA F8). Free slots are skipped from
      // that moment; if only free ones remain the turn fails, which is the
      // right way round.
      if (turnGuard?.sensitiveUsed) {
        for (let guard = 0; SLOTS[target.keySlot].free && ti + 1 < targets.length && guard < targets.length; guard++) {
          ((flags.skipped_free_tier ??= []) as string[]).push(tag(target));
          moveOn('private data in this turn: free tiers skipped');
        }
        if (SLOTS[target.keySlot].free) throw new Error('No non-free model is available, and this turn has read private data.');
      }
      for (let c = coolingDown(target); c && ti + 1 < targets.length; c = coolingDown(target)) {
        ((flags.skipped_cooling ??= []) as string[]).push(tag(target));
        if (c.issue !== 'busy') chainIssues.push({ issue: c.issue, model: target.model, slot: target.keySlot, waitMs: c.waitMs });
        moveOn(`cooling down (${c.issue})`);
      }
      const omit = omitFor(catalog, target);
      const chat = SLOTS[target.keySlot].api === 'openai-chat';
      // Compact mode: a model with a small token budget gets a trimmed request
      // (agent/compact.ts); the shared history is left as it is.
      let call: Partial<LlmRequest> = { instructions, input, ...o };
      // Model extras (NVIDIA Nemotron's thinking switch); a thinking model gets
      // output room for its reasoning and the answer.
      const extra = chat ? extraFor(catalog, target) : null;
      if (extra) call = { ...call, extra, ...(isThinking(extra) ? { maxOutputTokens: Math.max(call.maxOutputTokens ?? 0, THINKING_MIN_OUTPUT) } : {}) };
      const budget = budgetFor(catalog, target);
      if (budget) {
        const reqI = call.instructions ?? instructions;
        const extra = reqI.startsWith(instructions) ? reqI.slice(instructions.length) : '';   // e.g. the SERIOUS note
        const f = fitRequest({ instructions: reqI, compactInstructions: compactBase + extra, input, tools: call.tools, maxOutputTokens: call.maxOutputTokens }, budget);
        if (f.steps.length) {
          ((flags.compact ??= []) as unknown[]).push({ target: tag(target), budget, steps: f.steps, estimate: f.estimate });
          call = { ...call, instructions: f.instructions, input: f.input, tools: f.tools, maxOutputTokens: f.maxOutputTokens };
        }
      }
      const ta = Date.now();
      try {
        const res = await (chat ? chatLlm : llm)({
          apiKey: keyFor(keys, target.keySlot)!, model: target.model, instructions, input,
            // The web rules are part of the stable prefix, so they are part of
          // the cache key: otherwise two different prefixes share one cache.
          promptCacheKey: `wurx-buddy-${req.role}${webEnv ? '-web' : ''}`, timeoutMs: agent.MODEL_TIMEOUT_MS, deadline, signal: cancelCtrl.signal, onDelta,
          ...(chat ? { endpoint: endpointFor(target.keySlot) } : {}),
          ...(omit.length ? { omit } : {}), ...call,
        });
        attempts.push({ target: tag(target), ms: Date.now() - ta });
        // Free tiers (Groq, Gemini) cost nothing, whatever the model's name.
        const c = SLOTS[target.keySlot].free ? { usd: 0, priced: true } : costUsd(prices, target.model, res.usage);
        if (SLOTS[target.keySlot].free) flags.free_tier = true;
        costSum += c.usd;
        if (!c.priced) unpriced = true;
        return res;
      } catch (e) {
        attempts.push({ target: tag(target), ms: Date.now() - ta, error: String((e as any)?.code ?? (e as any)?.status ?? (e as Error)?.name ?? 'error') });
        if (cancelCtrl.signal.aborted || (e as any)?.cancelled) throw e;
        const p = unsupportedParam(e);
        if (p && !omit.includes(p) && paramTries < 3) {
          paramTries++;
          ((flags.params_dropped ??= []) as string[]).push(`${tag(target)}:${p}`);
          await rememberOmit(admin, target, [...omit, p], catalog);
          continue;
        }
        const issue = providerAccountIssue(e);
        // Too large for this model: learn its budget and try it once more, compacted.
        if (issue === 'too_large' && !compactTried.has(tag(target)) && left() > SWITCH_MIN_LEFT_MS) {
          compactTried.add(tag(target));
          // In our estimate's units: the provider's limit scaled by how it counted this request.
          const sent = estimate(call.instructions ?? instructions, call.input ?? input, call.tools, call.maxOutputTokens);
          const got = budgetFromError(String((e as Error)?.message ?? ''));
          const b = got?.requested ? Math.floor(got.limit * sent / got.requested) : got ? got.limit : Math.floor(sent * 0.7);
          learnBudget(target, b);
          await rememberParams(admin, target, { token_budget: b }, catalog);
          continue;
        }
        if (issue) chainIssues.push({ issue, model: target.model, slot: target.keySlot, waitMs: (e as any)?.retryAfterMs ?? null });
        if (!(e as any)?.streamed) coolDown(target, e);
        const status = Number((e as any)?.status);
        const why = issue ?? ((e as any)?.code === 'bad_tool_format' ? 'bad_tool_format'
          : status === 429 ? 'rate_limit' : (e as any)?.code === 'first_byte_timeout' ? 'no_response' : status >= 500 ? 'server_error' : 'error');
        // Text already shown cannot be taken back: only a clean failure moves on.
        if (!(e as any)?.streamed && ti + 1 < targets.length && attempts.length < MAX_MODEL_ATTEMPTS && left() > SWITCH_MIN_LEFT_MS) {
          moveOn(why);
          continue;
        }
        throw e;
      }
    }
  };

  const toolLogs: ToolLog[] = [];
  const flags: Record<string, unknown> = { persona: persona.source };
  let usage = { ...ZERO };
  let rounds = 0;
  let error: string | null = null;
  let userError = '';
  const llmMs: number[] = [];         // per model call, for the latency picture
  flags.llm_ms = llmMs;
  flags.model_attempts = attempts;
  flags.model_source = override ? 'override' : resolved.model_source;
  if (webEnv) flags.web = { providers: usableProviders(webEnv), merge: webCfg.merge };
  const input: InputItem[] = [...history, { role: 'user', content: message }];
  let step = 'start';

  emit({ status: 'On it…' });
  try {
    for (let round = 0; ; round++) {
      step = `model round ${round}`;
      if (await checkCancel()) throw new Stop();
      const spent = usage.input + usage.output;
      // A tool round needs room for the tools and an answer after them.
      const toolsAllowed = round < agent.MAX_ROUNDS && spent < agent.COST_CEILING_TOKENS && left() > agent.TOOL_ROUND_MIN_LEFT_MS;
      if (!toolsAllowed && spent >= agent.COST_CEILING_TOKENS) flags.ceiling_hit = true;
      if (!toolsAllowed && round < agent.MAX_ROUNDS && left() <= agent.TOOL_ROUND_MIN_LEFT_MS) flags.deadline_short = true;
      if (!toolsAllowed && round > 0) emit({ status: 'Writing the answer…' });
      const tl = Date.now();
      const res = await ask({
        instructions: serious ? `${instructions}\nThis is a SERIOUS topic: no emoji, no jokes.` : instructions,
        tools: toolsAllowed ? toolDefsFor(!!webEnv) : undefined,
        effort: (toolsAllowed ? agent.EFFORT_TOOL_ROUNDS : agent.EFFORT_ANSWER) as any,
        maxOutputTokens: toolsAllowed ? agent.TOOL_ROUND_MAX_OUTPUT_TOKENS : agent.ANSWER_MAX_OUTPUT_TOKENS,
      });
      usage = add(usage, res.usage);
      llmMs.push(Date.now() - tl);
      // Tool calls written as text, not as tool_calls: remembered for this model.
      if (res.textToolCalls) {
        flags.text_tool_calls = true;
        if (!(catalog.find((c) => c.key_slot === target.keySlot && c.model === target.model)?.params as any)?.text_tool_calls) {
          await rememberParams(admin, target, { text_tool_calls: true }, catalog);
        }
      }
      if (!res.toolCalls.length) break;
      rounds++;
      input.push(...res.output);
      const calls = res.toolCalls.slice(0, agent.MAX_PARALLEL_TOOLS);
      const skipped = res.toolCalls.slice(agent.MAX_PARALLEL_TOOLS);
      if (skipped.length) flags.skipped_calls = ((flags.skipped_calls as number) ?? 0) + skipped.length;
      toolsCalled.push(...calls.map((c) => c.name));
      serious = serious || isSeriousTopic('', toolsCalled);
      emit({ status: TOOL_STATUS[calls[0].name] ?? 'Looking that up…' });
      // Tools may use what is left, minus room for the answer.
      step = `tools round ${round}`;
      const toolBudget = Math.max(3000, left() - agent.ANSWER_RESERVE_MS);
      env.agent = { ...agent, SEARCH_TIMEOUT_MS: Math.min(agent.SEARCH_TIMEOUT_MS, toolBudget), DATA_TOOL_TIMEOUT_MS: Math.min(agent.DATA_TOOL_TIMEOUT_MS, toolBudget) };
      const outs = await Promise.all(calls.map((c) => runTool(env, reg, c.name, c.arguments)));
      outs.forEach((o, i) => { toolLogs.push(o.log); input.push({ type: 'function_call_output', call_id: calls[i].call_id, output: o.output }); });
      for (const c of skipped) {
        input.push({ type: 'function_call_output', call_id: c.call_id, output: `Skipped: at most ${agent.MAX_PARALLEL_TOOLS} tool calls per round. Call it again next round if you still need it.` });
      }
    }
    const held = cstream.flush();
    if (held && !cancelled) { answer += held; emit({ delta: held }); }
    // Reasoning can eat the whole output budget: retry once, bigger, without tools.
    step = 'answer';
    if (!answer.trim() && !cancelled && left() > agent.ANSWER_RESERVE_MS) {
      step = 'empty-answer retry';
      flags.empty_retry = true;
      emit({ status: 'Composing a detailed answer…' });
      const res = await ask({ effort: agent.EFFORT_ANSWER as any, maxOutputTokens: agent.ANSWER_RETRY_MAX_OUTPUT_TOKENS });
      usage = add(usage, res.usage);
    }
    if (await checkCancel()) throw new Stop();
    const tail = cstream.flush();
    if (tail) { answer += tail; emit({ delta: tail }); }
    // Last safety net: tool-call markup is never part of an answer.
    if (/<tool_call|<function=|<\/parameter>|<\|tool_call\|>/.test(answer)) {
      flags.stripped_tool_markup = true;
      answer = stripToolMarkup(answer).trim();
    }
    if (!answer.trim()) {
      const sorry = "Sorry, I couldn't put an answer together this time. Could you try asking again, maybe a little more specifically?";
      answer = sorry;
      emit({ delta: sorry });
    }
  } catch (e) {
    if (e instanceof Stop || (e as any)?.cancelled || cancelled) {
      cancelled = true;
      emit({ cancelled: true });
    } else {
      error = scrubSecrets(String((e as Error)?.message ?? e)).slice(0, 500);
      const status = Number((e as any)?.status) || null;
      // No credits / a refused key / a used-up allowance: say who can fix it (QA 2026-10-01 F3).
      const account = providerAccountIssue(e);
      if (account || chainIssues.length) { flags.provider_quota = true; flags.provider_issue = account ?? chainIssues[chainIssues.length - 1].issue; }
      if (!account && /deadline|timed out/i.test(error)) flags.deadline_hit = true;
      // The real exception, for whoever reads the log: never the key, never the prompt.
      flags.error_detail = {
        step, class: (e as Error)?.name ?? typeof e, status, code: (e as any)?.code ?? null, message: error.slice(0, 300),
        target: `${target.keySlot}:${target.model}`, retry_after_s: (e as any)?.retryAfterMs != null ? Math.round((e as any).retryAfterMs / 1000) : null,
      };
      console.error(`assistant turn ${requestId} failed at ${step}:`, JSON.stringify(flags.error_detail));
      const tail = cstream.flush();
      if (tail) { answer += tail; emit({ delta: tail }); }
      // Nothing worked. Account problems met anywhere in the chain are named;
      // models that were only busy or silent get one line after them.
      const busy = !account && !flags.deadline_hit && (status === 429 || (status ?? 0) >= 500 || (e as any)?.code === 'first_byte_timeout');
      userError = account ? providerIssueMessage(account, req.role, chainIssues)
        : chainIssues.length && busy ? `${providerIssueMessage(chainIssues[chainIssues.length - 1].issue, req.role, chainIssues)} The other models were busy or did not answer: please try again in a minute.`
        : busy ? 'The assistant is busy right now (rate limit). Please wait a moment and try again.'
        : flags.deadline_hit ? 'That took too long, so I stopped. Please try again, maybe a narrower question.' : 'Something went wrong while answering. Please try again.';
      if (!account && !busy && !flags.deadline_hit) flags.error_unclassified = true;
      emit({ error: userError });
    }
  } finally {
    clearInterval(poller);
  }

  const cited = new Set(citedIds(answer));
  const sources = [...reg.entries.values()].map((s) => ({
    id: s.id, source_type: s.source_type, source_id: s.source_id, title: s.title, url: s.url, period: s.period,
    ...(s.ids && s.ids.length > 1 ? { ids: s.ids } : {}), cited: cited.has(s.id),
  }));
  emit({ sources });

  const noData = numbersWithoutData(answer);
  if (noData.length) flags.numbers_without_data = noData;
  if (cstream.stripped.length) flags.stripped_citations = [...new Set(cstream.stripped)];
  if (serious) flags.serious = true;
  if (cancelled) flags.cancelled = true;
  const retrieved = reg.retrieved.map((r) => ({ ...r, cited: cited.has(r.cite) }));
  const est = costSum;
  if (unpriced) flags.unpriced = true;
  if (embedFailed || deps.embedDown?.()) flags.search_mode = 'keyword_only';

  // Finish the reply row (the thing the UI trusts), then log. A failure here
  // must not lose the answer already streamed: the row is retried once.
  // A stopped reply is kept (partial) as 'error' + cancelled, and does not
  // move last_reply_at: no unread badge for an answer the user stopped.
  const meta = {
    requestId, model, key_slot: target.keySlot, model_source: flags.model_source, ...(flags.fallback_used ? { fallback_used: flags.fallback_used } : {}), engine: 'v2', surface, ...(regen ? { supersedes: regen.oldId } : {}),
    sources: sources.filter((s) => s.cited),
    tools: toolLogs.map((t) => ({ name: t.name, args: t.args, ms: t.ms, cites: t.cites })),
    ...(cancelled ? { cancelled: true, error: 'Stopped.' } : error ? { error: flags.deadline_hit ? 'The reply took too long and was stopped.' : flags.error_unclassified ? 'Something went wrong while answering.' : userError } : {}),
  };
  const status = cancelled || error ? 'error' : 'done';     // a partial answer is kept, marked error
  const finishedAt = new Date().toISOString();
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const { error: e } = await admin.from('ai_messages').update({ content: answer, status, meta }).eq('id', messageId);
      if (e) throw e;
      await admin.from('ai_conversations').update(cancelled ? { updated_at: finishedAt } : { updated_at: finishedAt, last_reply_at: finishedAt }).eq('id', conversationId);
      delete flags.persist_error;
      break;
    } catch (e) {
      flags.persist_error = String((e as Error)?.message ?? e).slice(0, 200);
    }
  }
  const logRow = {
    model, key_slot: target.keySlot,
    conversation_id: conversationId, surface, rounds, tools: toolLogs, retrieved,
    tokens_in: usage.input, tokens_cached: usage.cached, tokens_out: usage.output, est_cost_usd: Number(est.toFixed(5)),
    latency_ms: Date.now() - t0, first_token_ms: firstTokenMs, error, flags,
  };
  try {
    const { error: e } = begun.logged
      ? await admin.from('ai_request_log').update(logRow).eq('id', requestId)
      : await admin.from('ai_request_log').insert({ id: requestId, user_id: req.userId, engine: 'v2', provider: 'openai', question: message, ...logRow });
    if (e) throw e;
  } catch (e) {
    console.error('ai_request_log write failed', (e as Error)?.message ?? e);
  }
  const extra = [
    ...usageRows(deps.meter, prices, { user_id: req.userId, request_id: requestId }),
    ...webUsageRows(webUsage, { user_id: req.userId, request_id: requestId }),
  ];
  if (extra.length) {
    try {
      const { error: e } = await admin.from('ai_usage_log').insert(extra);
      if (e) throw e;
    } catch (e) {
      console.error('ai_usage_log write failed', (e as Error)?.message ?? e);
    }
  }

  emit({ done: true, conversationId, requestId, messageId, status, ...(cancelled ? { cancelled: true } : {}) });
  return { requestId, conversationId, messageId, answer, sources, ...(error ? { error } : {}), ...(cancelled ? { cancelled: true } : {}) };
}

// Stop (QA M2): the owner asks the running turn to stop. Owner-checked here,
// with the service role; clients have no write access to ai_messages.
export async function requestCancel(admin: any, userId: string, messageId: string): Promise<{ status: number; body: Record<string, unknown> }> {
  if (!UUID_RE.test(String(messageId ?? ''))) return { status: 400, body: { error: 'cancel must be a message id' } };
  const { data: m } = await admin.from('ai_messages').select('id, role, status, conversation_id, ai_conversations(user_id)').eq('id', messageId).maybeSingle();
  if (!m || m.role !== 'assistant' || m.ai_conversations?.user_id !== userId) return { status: 404, body: { error: 'message not found' } };
  if (m.status !== 'generating') return { status: 200, body: { cancelled: false, messageId, status: m.status } };
  const { error } = await admin.from('ai_messages').update({ cancel_requested_at: new Date().toISOString() }).eq('id', messageId).eq('status', 'generating');
  if (error) return { status: 500, body: { error: 'could not cancel' } };
  return { status: 202, body: { cancelled: true, messageId, status: 'generating' } };
}

// Regenerate: only the owner's LAST reply of a conversation, only when nothing
// in it is still generating, and only a finished (done / error) one. Returns
// the question it answered (the user row just before it).
export async function regenerateTarget(admin: any, userId: string, messageId: string):
  Promise<{ conversationId: string; question: string; questionAt: string; oldStatus: string; oldMeta: Record<string, unknown> } | { error: string; status: number }> {
  if (!UUID_RE.test(String(messageId ?? ''))) return { error: 'regenerate must be a message id', status: 400 };
  const { data: m } = await admin.from('ai_messages').select('id, role, status, created_at, meta, conversation_id, ai_conversations(user_id)')
    .eq('id', messageId).maybeSingle();
  if (!m || m.role !== 'assistant' || m.ai_conversations?.user_id !== userId) return { error: 'message not found', status: 404 };
  if (!['done', 'error'].includes(m.status)) return { error: `that reply cannot be regenerated (status ${m.status})`, status: 409 };
  const { data: rows } = await admin.from('ai_messages').select('id, role, status, content, created_at')
    .eq('conversation_id', m.conversation_id).neq('status', 'superseded').order('created_at', { ascending: false }).limit(50);
  const live = (rows ?? []) as Array<{ id: string; role: string; status: string; content: string; created_at: string }>;
  if (live.some((r) => r.status === 'generating')) return { error: 'a reply is still being written in this conversation', status: 409 };
  const lastReply = live.find((r) => r.role === 'assistant');
  if (lastReply?.id !== m.id) return { error: 'only the last reply of a conversation can be regenerated', status: 409 };
  const question = live.find((r) => r.role === 'user' && r.created_at < m.created_at);
  if (!question) return { error: 'the question for that reply was not found', status: 409 };
  return { conversationId: m.conversation_id, question: question.content, questionAt: question.created_at, oldStatus: m.status, oldMeta: m.meta ?? {} };
}
