// The grounding step inside a real turn (agent/core.ts): the answer is held, checked against this turn's tool
// results, given ONE corrective retry, and whatever is still unsupported is replaced, never shipped.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runTurn, type CoreDeps } from '../agent/core.ts';
import { UNVERIFIED_NOTE } from '../agent/grounding.ts';
import type { LlmRequest, LlmResult } from '../llm/openai.ts';
import { fakeDb } from './fixtures/fakeDb.ts';
import { turnDb } from './fixtures/turnDb.ts';

const NOW = new Date('2026-11-02T18:40:00Z');
const BOSS = 'b0000000-0000-0000-0000-000000000001';
const PEOPLE = [
  { id: 'apc-new', display_name: 'Haseeb', role: 'apc', is_active: true, deleted_at: null },
  { id: 'apc-gone', display_name: 'Ali Ahmad', role: 'apc', is_active: false, deleted_at: '2026-10-12T14:55:22+00:00' },
  { id: 'tl-a', display_name: 'Muhammad Azam', role: 'tl', is_active: true, deleted_at: null },
];
const comp: Record<string, any> = { 'apc-new': { composite_score: 89, level: 'good' }, 'apc-gone': { composite_score: 56, level: 'warning' }, 'tl-a': { composite_score: 78, level: 'good' } };

// ai_* tables go to the turn recorder, everything else to the data fixture.
function combined() {
  const turn = turnDb({
    ai_assistant_config: [{ id: 1, persona: 'You are the WurxOS Assistant, a friendly internal support bot…', model: 'gpt-5.4-mini', enabled: true, retrieval: {} }],
    ai_request_log: [], ai_conversations: [], ai_messages: [],
  });
  const data = fakeDb({
    profiles: PEOPLE, brands: [], performance_flags: [], performance_warnings: [], performance_month_snapshots: [],
    performance_ratings: [{ user_id: 'apc-new', month: '2026-10', metrics: {}, overall_score: 60 }, { user_id: 'apc-gone', month: '2026-10', metrics: {}, overall_score: 12.8 }],
  }, { get_performance_composite: (a: any) => (comp[a.p_user] ? [comp[a.p_user]] : []) });
  const db: any = {
    from: (t: string) => (t.startsWith('ai_') ? turn.from(t) : data.from(t)),
    rpc: (fn: string, a: any) => (fn.startsWith('ai_') ? turn.rpc(fn, a) : data.rpc(fn, a)),
    inserts: turn.inserts, updates: turn.updates,
  };
  return db;
}

function scripted(script: Array<{ stream?: string[]; toolCalls?: any[] }>) {
  const seen: LlmRequest[] = [];
  const llm = async (r: LlmRequest): Promise<LlmResult> => {
    seen.push(JSON.parse(JSON.stringify({ ...r, onDelta: undefined, apiKey: 'x' })));
    const s = script.shift() ?? { stream: ['(no more script)'] };
    for (const d of s.stream ?? []) r.onDelta?.(d);
    return { text: (s.stream ?? []).join(''), toolCalls: s.toolCalls ?? [], output: (s.toolCalls ?? []).map((c: any) => ({ type: 'function_call', ...c })), usage: { input: 1000, cached: 0, output: 100, reasoning: 0 }, status: 'completed' };
  };
  return { llm, seen };
}
const run = async (script: Array<{ stream?: string[]; toolCalls?: any[] }>, extra: Partial<CoreDeps> = {}) => {
  const db = combined();
  const { llm, seen } = scripted(script);
  const events: any[] = [];
  const r = await runTurn({ userId: BOSS, role: 'boss', message: 'who has the highest score among APC and TL in October' },
    { admin: db, searchRpc: async () => [], asUser: BOSS, apiKey: 'k', embed: async () => [0.1], llm, now: () => NOW, requestId: 'req-g', ...extra } as CoreDeps, (e) => events.push(e));
  return { r, seen, events, db };
};
const CALL = { toolCalls: [{ call_id: 'k1', name: 'get_performance', arguments: '{"month":"2026-10"}' }] };
const LIE = 'The highest scoring TL is **Ali Ahmad** (TL) with 56.0 / 100 [D1]. Haseeb (APC) has 89.0 / 100 [D1].';
const TRUE = 'Among current staff, Haseeb (APC) has 89.0 / 100 and Muhammad Azam (TL) has 78.0 / 100 [D1]. Ali Ahmad (APC) scored 56.0 / 100 but is a former employee, so I left him out [D1].';
const deltas = (events: any[]) => events.filter((e) => e.delta !== undefined).map((e) => e.delta).join('');

test('a false first answer is never shown: one corrective retry with the offending claims, then the corrected answer is sent', async () => {
  const { r, seen, events, db } = await run([CALL, { stream: [LIE] }, { stream: [TRUE] }]);
  assert.equal(r.answer, TRUE);
  assert.equal(deltas(events), TRUE, 'the user only ever sees the verified answer');
  assert.ok(!deltas(events).includes('highest scoring TL'));
  // the retry was told what was wrong, with no tools offered
  const retry = seen[2];
  assert.ok(!retry.tools || retry.tools.length === 0);
  const last = (retry.input as any[]).at(-1);
  assert.equal(last.role, 'user');
  assert.ok(last.content.includes('Ali Ahmad is TL') && last.content.includes('FORMER'));
  assert.ok((retry.input as any[]).some((i) => i.role === 'assistant' && i.content === LIE), 'the model sees its own draft');
  assert.ok(events.some((e) => e.status === 'Double-checking the figures…'));
  const flags = db.inserts.ai_request_log[0].flags;
  assert.equal(flags.grounding.retried, true);
  assert.equal(flags.grounding.replaced, false);
  assert.ok(flags.grounding.ungrounded === 0);
  // the saved reply is the corrected one
  assert.equal(db.inserts.ai_messages[1].content, TRUE);
});

test('still wrong after the retry: the offending sentences are replaced by a plain "could not verify" note, and it is logged', async () => {
  const { r, events, db } = await run([CALL, { stream: [LIE] }, { stream: [LIE] }]);
  assert.ok(!r.answer.includes('highest scoring TL'));
  assert.ok(r.answer.includes(UNVERIFIED_NOTE));
  assert.equal(deltas(events), r.answer);
  const g = db.inserts.ai_request_log[0].flags.grounding;
  assert.equal(g.retried, true);
  assert.equal(g.replaced, true);
  assert.ok(g.ungrounded > 0 && g.claims.length > 0);
});

test('a grounded answer is sent once, with no retry and a clean log', async () => {
  const { r, seen, events, db } = await run([CALL, { stream: [TRUE] }]);
  assert.equal(r.answer, TRUE);
  assert.equal(seen.length, 2);
  assert.equal(deltas(events), TRUE);
  const g = db.inserts.ai_request_log[0].flags.grounding;
  assert.deepEqual([g.retried, g.replaced, g.ungrounded], [false, false, 0]);
  assert.ok(g.checked.numbers > 0 && g.checked.roles >= 1);
});

test('the text is held: nothing is streamed before the check finishes', async () => {
  const order: string[] = [];
  const db = combined();
  const { llm } = scripted([CALL, { stream: ['Haseeb (APC) has ', '89.0 / 100 [D1].'] }]);
  await runTurn({ userId: BOSS, role: 'boss', message: 'highest APC?' },
    { admin: db, searchRpc: async () => [], asUser: BOSS, apiKey: 'k', embed: async () => [0.1], llm, now: () => NOW, requestId: 'req-h' } as CoreDeps,
    (e) => { if (e.delta !== undefined) order.push('delta'); if (e.done) order.push('done'); });
  assert.deepEqual(order, ['delta', 'done'], 'the answer arrives in one piece, right before done');
});

test('grounding:false keeps live streaming (used by tests of other behaviour)', async () => {
  const order: string[] = [];
  const db = combined();
  const { llm } = scripted([CALL, { stream: ['Haseeb (APC) has ', '89.0 / 100 [D1].'] }]);
  await runTurn({ userId: BOSS, role: 'boss', message: 'highest APC?' },
    { admin: db, searchRpc: async () => [], asUser: BOSS, apiKey: 'k', embed: async () => [0.1], llm, now: () => NOW, requestId: 'req-i', grounding: false } as CoreDeps,
    (e) => { if (e.delta !== undefined) order.push('delta'); if (e.done) order.push('done'); });
  assert.deepEqual(order, ['delta', 'delta', 'done']);
});

test('a how-to answer without tools or figures is untouched', async () => {
  const { r, seen } = await run([{ stream: ['Open [Leave](/leave), pick your dates and submit. Your Team Lead approves it.'] }]);
  assert.equal(r.answer, 'Open [Leave](/leave), pick your dates and submit. Your Team Lead approves it.');
  assert.equal(seen.length, 1);
});

test('a how-to answer that invents a figure or a person without any tool is caught too', async () => {
  const { r } = await run([{ stream: ['Haseeb (APC) scored 89.0 / 100 last month.'] }, { stream: ['I do not have that data right now.'] }]);
  assert.equal(r.answer, 'I do not have that data right now.');
});

test('no text after the tool calls: a plain "could not answer" message, never an invented one', async () => {
  const { r } = await run([CALL, { stream: [] }, { stream: [] }]);
  assert.match(r.answer, /^Sorry, I couldn't put an answer together/);
});
