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
import { pickModel, respond, type InputItem, type LlmRequest, type LlmResult, type Usage } from '../llm/openai.ts';
import { agentConfig, type AgentConfig } from './config.ts';
import { costUsd, pricesFrom, type Prices, type UsageMeter } from '../prices.ts';
import { CitationStream, citedIds, numbersWithoutData } from './citations.ts';
import { buildInstructions, effectivePersona, isSeriousTopic } from './prompt.ts';
import { ALL_TOOL_DEFS, CiteRegistry, runTool, TOOL_STATUS, type ToolEnv, type ToolLog } from './tools.ts';

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
  apiKey: string;
  embed: (text: string) => Promise<number[] | null>;
  rerank?: Reranker;
  meter?: UsageMeter;                // rerank + query-embedding usage of this question (→ ai_usage_log)
  now?: () => Date;
  llm?: (r: LlmRequest) => Promise<LlmResult>;   // test seam
  requestId?: string;
};

export type TurnResult = { requestId: string; conversationId: string | null; messageId?: string; answer: string; sources: unknown[]; error?: string; httpStatus?: number; cancelled?: boolean };

const ZERO: Usage = { input: 0, cached: 0, output: 0, reasoning: 0 };
const add = (a: Usage, b: Usage): Usage => ({ input: a.input + b.input, cached: a.cached + b.cached, output: a.output + b.output, reasoning: a.reasoning + b.reasoning });

async function loadConfig(admin: any) {
  const { data } = await admin.from('ai_assistant_config').select('persona, model, enabled, retrieval, prices').eq('id', 1).maybeSingle();
  return data ?? {};
}

// Rate limit (QA m2): counted and recorded atomically when the turn STARTS
// (ai_turn_begin, mig 386), so parallel sends can't slip past the cap. Without
// that function (older DB) it falls back to counting finished turns.
async function beginTurn(admin: any, cfg: AgentConfig, userId: string, requestId: string, question: string, model: string, now: Date):
  Promise<{ limited: boolean; logged: boolean }> {
  const exempt = cfg.RATE_LIMIT_EXEMPT_USERS.includes(userId);
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
  if (meter?.rerank.calls) {
    const r = meter.rerank;
    rows.push({ ...who, kind: 'rerank', model: r.model, calls: r.calls, tokens_in: r.input, tokens_cached: r.cached, tokens_out: r.output,
      est_cost_usd: Number(costUsd(prices, r.model, { input: r.input, cached: r.cached, output: r.output }).usd.toFixed(6)) });
  }
  if (meter?.embed.calls) {
    const m = meter.embed;
    rows.push({ ...who, kind: 'embed_query', model: m.model, calls: m.calls, tokens_in: m.input,
      est_cost_usd: Number(costUsd(prices, m.model, { input: m.input }).usd.toFixed(6)) });
  }
  return rows;
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
  const model = pickModel(row.model);
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
  const begun = await beginTurn(admin, agent, req.userId, requestId, message, model, now);
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
  const toolsCalled: string[] = [];
  let serious = isSeriousTopic(message);
  const surface = req.surface === 'slack' ? 'slack' : cleanSurface(req.surface);
  const notes = [
    ...(surface === 'quick' ? ['SURFACE: the quick-chat panel. Keep the answer short: at most ~120 words or 5 bullets, the key facts with their citations, and offer the full version ("Open in Buddy ↗" shows more).'] : []),
    ...[await pageContextNote(admin, req.userId, req.pageContext ?? null)].filter((x): x is string => !!x),
  ];
  const { instructions } = buildInstructions({ persona: persona.text, role: req.role, displayName: req.displayName, now, notes });

  const reg = new CiteRegistry();
  const env: ToolEnv = {
    admin, searchRpc: deps.searchRpc, asUser: deps.asUser, embed: deps.embed, rerank: deps.rerank,
    // userClient: the caller's own JWT client, so people & pay tools read under
    // that user's RLS (Engineer 2, ui-design §8). None on the internal (Boss) path.
    retrieval, agent, ctx: { userId: req.userId, role: req.role, ...(deps.userClient ? { userClient: deps.userClient } : {}) }, now,
  };
  const cstream = new CitationStream(reg.has, () => serious);
  let answer = '';
  let firstTokenMs: number | null = null;
  const onDelta = (d: string) => {
    if (cancelled) return;
    const safe = cstream.push(d);
    if (!safe) return;
    if (firstTokenMs == null) firstTokenMs = Date.now() - t0;
    answer += safe;
    emit({ delta: safe });
  };
  const ask = (o: Partial<LlmRequest>) => llm({
    apiKey: deps.apiKey, model, instructions, input, promptCacheKey: `wurx-buddy-${req.role}`,
    timeoutMs: agent.MODEL_TIMEOUT_MS, deadline, signal: cancelCtrl.signal, onDelta, ...o,
  });

  const toolLogs: ToolLog[] = [];
  const flags: Record<string, unknown> = { persona: persona.source };
  let usage = { ...ZERO };
  let rounds = 0;
  let error: string | null = null;
  const llmMs: number[] = [];         // per model call, for the latency picture
  flags.llm_ms = llmMs;
  const input: InputItem[] = [...history, { role: 'user', content: message }];

  emit({ status: 'On it…' });
  try {
    for (let round = 0; ; round++) {
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
        tools: toolsAllowed ? ALL_TOOL_DEFS : undefined,
        effort: (toolsAllowed ? agent.EFFORT_TOOL_ROUNDS : agent.EFFORT_ANSWER) as any,
        maxOutputTokens: toolsAllowed ? agent.TOOL_ROUND_MAX_OUTPUT_TOKENS : agent.ANSWER_MAX_OUTPUT_TOKENS,
      });
      usage = add(usage, res.usage);
      llmMs.push(Date.now() - tl);
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
    if (!answer.trim() && !cancelled && left() > agent.ANSWER_RESERVE_MS) {
      flags.empty_retry = true;
      emit({ status: 'Composing a detailed answer…' });
      const res = await ask({ effort: agent.EFFORT_ANSWER as any, maxOutputTokens: agent.ANSWER_RETRY_MAX_OUTPUT_TOKENS });
      usage = add(usage, res.usage);
    }
    if (await checkCancel()) throw new Stop();
    const tail = cstream.flush();
    if (tail) { answer += tail; emit({ delta: tail }); }
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
      error = String((e as Error)?.message ?? e).slice(0, 500);
      if (/deadline|timed out/i.test(error)) flags.deadline_hit = true;
      const tail = cstream.flush();
      if (tail) { answer += tail; emit({ delta: tail }); }
      emit({ error: /HTTP 429/.test(error) ? 'The assistant is busy right now (rate limit). Please wait a moment and try again.'
        : flags.deadline_hit ? 'That took too long, so I stopped. Please try again, maybe a narrower question.' : 'Something went wrong while answering. Please try again.' });
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
  const prices = pricesFrom(row.prices);
  const est = costUsd(prices, model, usage).usd;

  // Finish the reply row (the thing the UI trusts), then log. A failure here
  // must not lose the answer already streamed: the row is retried once.
  // A stopped reply is kept (partial) as 'error' + cancelled, and does not
  // move last_reply_at: no unread badge for an answer the user stopped.
  const meta = {
    requestId, model, engine: 'v2', surface, ...(regen ? { supersedes: regen.oldId } : {}),
    sources: sources.filter((s) => s.cited),
    tools: toolLogs.map((t) => ({ name: t.name, args: t.args, ms: t.ms, cites: t.cites })),
    ...(cancelled ? { cancelled: true, error: 'Stopped.' } : error ? { error: flags.deadline_hit ? 'The reply took too long and was stopped.' : 'Something went wrong while answering.' } : {}),
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
    conversation_id: conversationId, surface, rounds, tools: toolLogs, retrieved,
    tokens_in: usage.input, tokens_cached: usage.cached, tokens_out: usage.output, est_cost_usd: Number(est.toFixed(5)),
    latency_ms: Date.now() - t0, first_token_ms: firstTokenMs, error, flags,
  };
  try {
    const { error: e } = begun.logged
      ? await admin.from('ai_request_log').update(logRow).eq('id', requestId)
      : await admin.from('ai_request_log').insert({ id: requestId, user_id: req.userId, engine: 'v2', provider: 'openai', model, question: message, ...logRow });
    if (e) throw e;
  } catch (e) {
    console.error('ai_request_log write failed', (e as Error)?.message ?? e);
  }
  const extra = usageRows(deps.meter, prices, { user_id: req.userId, request_id: requestId });
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
