// HTTP transport for a turn, as a Web Response (Deno serves it directly; the
// Node server pipes it). Checks that refuse the request (empty, too long,
// rate limit, not your conversation) come back as JSON with a status code;
// once the turn starts, everything is SSE. `stream:false` gets one JSON reply.
//
// The turn does not depend on the connection (ui-design §6): if the client
// goes away the stream just stops being written, and `done` still settles
// when the reply row is finished. The Deno function hands `done` to
// EdgeRuntime.waitUntil so the worker is not stopped before that.

import { runTurn, type CoreDeps, type TurnRequest } from './core.ts';

export const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-internal-secret',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
export const json = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });

export type TurnHttp = { response: Response; done: Promise<void> };

export async function turnResponse(req: TurnRequest, deps: CoreDeps, stream: boolean): Promise<TurnHttp> {
  if (!stream) {
    const r = await runTurn(req, deps, () => {});
    const response = r.httpStatus ? json({ error: r.error }, r.httpStatus)
      : json({ conversationId: r.conversationId, requestId: r.requestId, messageId: r.messageId, reply: r.answer, sources: r.sources,
          ...(r.error ? { error: r.error } : {}), ...(r.cancelled ? { cancelled: true } : {}) });
    return { response, done: Promise.resolve() };
  }
  const enc = new TextEncoder();
  let ctrl: ReadableStreamDefaultController<Uint8Array> | null = null;
  let closed = false;
  const queue: string[] = [];
  let resolveFirst!: (v: 'event' | 'done') => void;
  const first = new Promise<'event' | 'done'>((ok) => { resolveFirst = ok; });
  const write = (line: string) => {
    if (closed) return;
    if (!ctrl) { queue.push(line); return; }
    try { ctrl.enqueue(enc.encode(line)); } catch { closed = true; }   // client went away: keep working, stop writing
  };
  const emit = (ev: Record<string, unknown>) => { write(`data: ${JSON.stringify(ev)}\n\n`); resolveFirst('event'); };
  const run = runTurn(req, deps, emit).then((r) => { resolveFirst('done'); return r; }, (e) => { resolveFirst('done'); throw e; });
  const done = run.then(() => {}, (e) => { console.error('turn failed', e); });
  if ((await first) === 'done' && !queue.length) {
    const r = await run.catch((e) => ({ error: String(e?.message ?? e), httpStatus: 500 }) as any);
    return { response: json({ error: r.error }, r.httpStatus ?? 500), done };
  }
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      ctrl = c;
      for (const l of queue.splice(0)) c.enqueue(enc.encode(l));
      run.catch((e) => write(`data: ${JSON.stringify({ error: String(e?.message ?? e).slice(0, 300) })}\n\n`))
        .finally(() => { if (!closed) { closed = true; try { c.close(); } catch { /* closed */ } } });
    },
    cancel() { closed = true; },
  });
  return {
    response: new Response(body, { headers: { ...CORS, 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache', Connection: 'keep-alive' } }),
    done,
  };
}
