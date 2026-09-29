// ============================================================
// Wurx Buddy — the provider's pure logic (src/lib/buddyLogic.js):
// the store reducer, mood, unread, SSE parsing, refusal messages, and
// picking a reply up from the database after the stream dropped.
//
//   node scripts/buddy-tests.mjs
// ============================================================

import {
  buddyReducer as R, initialBuddyState as S0, deriveMood, unreadCount, unreadTitle, serverUnread,
  parseSse, friendlyError, findReply, isFinal, isStuck, STUCK_MS, watchReply, questionBefore,
  groupConversations, pageContextFor, pageChips, citeHtml, orderSources, sourceLink, BUDDY_ROLES, greetingText,
  buddyRoles, rowToMessage, fmtUsd, fmtCount, fmtMs, fmtPct, pktDate, usageRange,
} from '../src/lib/buddyLogic.js';

let passed = 0, failed = 0;
const results = [];
function check(name, cond, detail) {
  if (cond) { passed++; results.push(`  PASS  ${name}`); }
  else { failed++; results.push(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
}
const run = (state, ...actions) => actions.reduce(R, state);
const T0 = '2026-09-30T10:00:00.000Z';
const C1 = '11111111-1111-4111-8111-111111111111';

// ── usage formatting (Boss usage panel) ─────────────────────────
{
  check('usd: 2 decimals from $1', fmtUsd(1234.5) === '$1,234.50' && fmtUsd(1) === '$1.00' && fmtUsd('859.95') === '$859.95', fmtUsd(1234.5));
  check('usd: 4 decimals under $1', fmtUsd(0.01234) === '$0.0123' && fmtUsd(0.5) === '$0.5000', fmtUsd(0.01234));
  check('usd: zero and missing', fmtUsd(0) === '$0.00' && fmtUsd(null) === '—' && fmtUsd('x') === '—');
  check('count: thousands separators', fmtCount(1234567) === '1,234,567' && fmtCount(0) === '0' && fmtCount(undefined) === '—');
  check('ms / pct', fmtMs(850) === '850 ms' && fmtMs(4321) === '4.3 s' && fmtPct(12.6) === '13%' && fmtPct(null) === '—');
  // 2026-09-30 21:00 UTC is already Oct 1 in Pakistan (UTC+5).
  const late = new Date('2026-09-30T21:00:00Z');
  check('pktDate: Pakistan calendar day', pktDate(late) === '2026-10-01', pktDate(late));
  const now = new Date('2026-03-05T06:00:00Z');
  check('range: 7 days inclusive', JSON.stringify(usageRange('7d', now)) === '{"from":"2026-02-27","to":"2026-03-05"}', JSON.stringify(usageRange('7d', now)));
  check('range: 30 days default', usageRange('30d', now).from === '2026-02-04' && usageRange('whatever', now).from === '2026-02-04');
  check('range: this month', JSON.stringify(usageRange('month', late)) === '{"from":"2026-10-01","to":"2026-10-01"}');
}

// ── server-side Stop (mig 386) ──────────────────────────────────
{
  const C2 = '22222222-2222-4222-8222-222222222222';
  let s = run(S0,
    { type: 'SEND_START', key: 'tmp:9', text: 'Long question', at: '2026-09-30T10:00:00.000Z' },
    { type: 'CONV_ID', from: 'tmp:9', to: C2 },
    { type: 'MSG_ID', key: C2, messageId: 'm9' },
    { type: 'DELTA', key: C2, delta: 'Partial ' });
  check('cancel: MSG_ID recorded on the in-flight reply', s.inflight[C2].messageId === 'm9');
  s = run(s, { type: 'STOPPING', key: C2 });
  check('cancel: STOPPING keeps the stream alive', !!s.inflight[C2] && s.inflight[C2].stopping && s.inflight[C2].status === 'Stopping…');
  s = run(s, { type: 'STATUS', key: C2, status: 'Checking reports…' }, { type: 'DELTA', key: C2, delta: 'text' });
  check('cancel: status stays "Stopping…", deltas still append',
    s.inflight[C2].status === 'Stopping…' && s.threads[C2].messages.at(-1).content === 'Partial text');
  s = run(s, { type: 'DONE', key: C2, messageId: 'm9', status: 'error', cancelled: true, viewed: false });
  const m = s.threads[C2].messages.at(-1);
  check('cancel: done{cancelled} → "Stopped", partial kept, no error', m.stopped && !m.error && m.content === 'Partial text' && !m.pending, JSON.stringify(m));
  check('cancel: no unread, no bounce, idle Buddy', !s.unread[C2] && s.bounce === 0 && deriveMood(s) === 'idle');

  // A reply cut by the turn deadline is an error, and unread-worthy.
  let t = run(S0, { type: 'SEND_START', key: C2, text: 'Q', at: T0 },
    { type: 'DONE', key: C2, status: 'error', error: 'That took too long…', viewed: false });
  check('deadline: error shown and unread', t.threads[C2].messages.at(-1).error === 'That took too long…' && t.unread[C2] === true);

  // Saved rows.
  const stopped = rowToMessage({ id: 'a', role: 'assistant', content: 'Part', status: 'error', meta: { cancelled: true, error: 'Stopped.' } });
  check('row: cancelled → stopped, no error', stopped.stopped && stopped.error === null && stopped.content === 'Part');
  const stale = rowToMessage({ id: 'b', role: 'assistant', content: '', status: 'error', meta: { stale: true, error: 'Buddy lost this reply.' } });
  check('row: stale → error kept', !stale.stopped && stale.error === 'Buddy lost this reply.');
  check('row: done → plain', !rowToMessage({ role: 'assistant', status: 'done', meta: {} }).error);
  // RECOVERED with a cancelled row (Stop while recovering) is not unread either.
  const r = run(S0, { type: 'RESUME', key: C2, at: T0, messageId: 'b1' }, { type: 'STOPPING', key: C2 },
    { type: 'RECOVERED', key: C2, messages: [stopped], viewed: false });
  check('cancel while recovering: RESUME carries the id; no unread after', !r.inflight[C2] && !r.unread[C2]);
  check('RESUME: messageId kept', run(S0, { type: 'RESUME', key: C2, at: T0, messageId: 'x' }).inflight[C2].messageId === 'x');
}

// ── 1. mood state machine ───────────────────────────────────────
{
  let s = S0;
  check('mood: idle at rest', deriveMood(s) === 'idle');
  s = run(s, { type: 'SEND_START', key: 'tmp:1', text: 'Hi', at: T0 });
  check('mood: thinking while a reply generates', deriveMood(s) === 'thinking');
  s = run(s, { type: 'PANEL', panel: 'minimised' });
  check('mood: still thinking when the panel is minimised', deriveMood(s) === 'thinking');
  s = run(s, { type: 'CONV_ID', from: 'tmp:1', to: C1 });
  s = run(s, { type: 'DELTA', key: C1, delta: 'Hello ' }, { type: 'DELTA', key: C1, delta: 'there' });
  s = run(s, { type: 'DONE', key: C1, requestId: 'r1', messageId: 'm1', status: 'done', viewed: false });
  check('mood: happy once a reply lands unseen', deriveMood(s) === 'happy');
  check('unread: counted', unreadCount(s) === 1);
  check('bounce: bumped once', s.bounce === 1);
  check('title: "(1) Buddy replied"', unreadTitle(unreadCount(s)) === '(1) Buddy replied');
  const msg = s.threads[C1].messages.at(-1);
  check('done: text assembled from deltas', msg.content === 'Hello there' && !msg.pending, JSON.stringify(msg));
  check('done: ids kept for feedback/recovery', msg.requestId === 'r1' && msg.id === 'm1');
  s = run(s, { type: 'MARK_READ', id: C1, at: Date.now() });
  check('mood: back to idle after reading', deriveMood(s) === 'idle' && unreadCount(s) === 0);
  check('title: cleared at 0', unreadTitle(0) === null);
}

// ── 2. seen replies are not unread ──────────────────────────────
{
  const s = run(S0,
    { type: 'SEND_START', key: C1, text: 'Q', at: T0 },
    { type: 'DONE', key: C1, requestId: 'r', viewed: true });
  check('viewed reply: no unread, no bounce', unreadCount(s) === 0 && s.bounce === 0 && deriveMood(s) === 'idle');
}

// ── 3. the temp key follows the server id everywhere ────────────
{
  const s = run(S0,
    { type: 'SEND_START', key: 'tmp:7', text: 'Q', at: T0 },
    { type: 'QUICK_KEY', key: 'tmp:7' }, { type: 'PAGE_KEY', key: 'tmp:7' },
    { type: 'CONV_ID', from: 'tmp:7', to: C1 });
  check('CONV_ID: thread moved', !!s.threads[C1] && !s.threads['tmp:7']);
  check('CONV_ID: in-flight moved', !!s.inflight[C1] && !s.inflight['tmp:7']);
  check('CONV_ID: panel and tab follow', s.quickKey === C1 && s.pageKey === C1);
}

// ── 4. minimise / close never cancel; only Stop does ────────────
{
  let s = run(S0, { type: 'PANEL', panel: 'open' }, { type: 'SEND_START', key: C1, text: 'Q', at: T0 });
  s = run(s, { type: 'PANEL', panel: 'closed', quickKey: null });
  check('close: reply still in flight', !!s.inflight[C1]);
  s = run(s, { type: 'STOPPED', key: C1 });
  check('stop: in-flight cleared, message marked stopped', !s.inflight[C1] && s.threads[C1].messages.at(-1).stopped);
  // The server finishes the stopped reply anyway: no badge, no happy Buddy.
  s = run(s, { type: 'CONVS_LOADED', convs: [{ id: C1, last_reply_at: new Date(Date.now() + 5000).toISOString(), last_read_at: null }] });
  check('stop: late reply is not unread', !s.unread[C1] && deriveMood(s) === 'idle');
  s = run(s, { type: 'SEND_START', key: C1, text: 'again', at: T0 }, { type: 'DONE', key: C1, viewed: false });
  check('stop: the next question counts as unread again', s.unread[C1] === true && !s.stopped[C1]);
  // State from before `stopped` existed (a hot reload) must not crash.
  const { stopped: _x, ...old } = S0;
  check('reducer: tolerates state without `stopped`', run(old, { type: 'CONVS_LOADED', convs: [] }).convs.length === 0
    && !!run(old, { type: 'SEND_START', key: C1, text: 'Q', at: T0 }).inflight[C1]);
}

// ── 5. server unread vs local reads ─────────────────────────────
{
  const conv = { id: C1, last_reply_at: '2026-09-30T10:05:00Z', last_read_at: '2026-09-30T10:00:00Z' };
  check('serverUnread: reply after read', serverUnread(conv));
  check('serverUnread: nothing replied', !serverUnread({ id: C1 }));
  check('serverUnread: read after reply', !serverUnread({ ...conv, last_read_at: '2026-09-30T10:06:00Z' }));
  let s = run(S0, { type: 'CONVS_LOADED', convs: [conv] });
  check('CONVS_LOADED: marks server-unread', s.unread[C1] === true);
  s = run(s, { type: 'MARK_READ', id: C1, at: new Date('2026-09-30T10:05:01Z').getTime() });
  s = run(s, { type: 'CONVS_LOADED', convs: [conv] }); // stale server row (read not saved yet)
  check('local read beats a stale server row', !s.unread[C1]);
}

// ── 6. refusals ─────────────────────────────────────────────────
{
  const s = run(S0,
    { type: 'SEND_START', key: 'tmp:1', text: 'Q', at: T0 },
    { type: 'FAILED', key: 'tmp:1', error: 'x', denied: true });
  check('403: turn dropped, denied set', s.denied && s.threads['tmp:1'].messages.length === 0 && !s.inflight['tmp:1']);
  const s2 = run(S0,
    { type: 'SEND_START', key: C1, text: 'Q', at: T0 },
    { type: 'FAILED', key: C1, error: 'Buddy needs a short break' });
  check('429: error shown on the reply', s2.threads[C1].messages.at(-1).error === 'Buddy needs a short break');
  check('friendlyError 403 → coming soon', friendlyError(403).denied && /coming to your role/.test(friendlyError(403).text));
  check('friendlyError 429 → short break', /short break/.test(friendlyError(429).text));
  check('friendlyError 503 → switched off', /switched off/.test(friendlyError(503).text));
  check('friendlyError 400 too long', /shorten/.test(friendlyError(400, 'message too long').text));
  check('friendlyError 404', /couldn't find/i.test(friendlyError(404).text));
  const s3 = run(S0, { type: 'SEND_START', key: C1, text: 'Q', at: T0 }, { type: 'DONE', key: C1, status: 'error', viewed: true });
  check('done status=error → error on the message', !!s3.threads[C1].messages.at(-1).error);
}

// ── 7. SSE parsing across chunk boundaries ──────────────────────
{
  let buf = 'data: {"started":true,"conversationId":"c","messageId":"m"}\n\ndata: {"del';
  let [ev, rest] = parseSse(buf);
  check('parseSse: complete events only', ev.length === 1 && ev[0].started && rest === 'data: {"del');
  [ev, rest] = parseSse(rest + 'ta":"Hi"}\n\ndata: not-json\n\n: comment\ndata: {"done":true,"status":"done"}\n');
  check('parseSse: joins a split event, skips junk', ev.length === 2 && ev[0].delta === 'Hi' && ev[1].done, JSON.stringify(ev));
}

// ── 8. finding the reply after a drop ───────────────────────────
{
  const msgs = [
    { role: 'user', content: 'How do I apply?' }, { role: 'assistant', content: 'Old', status: 'done' },
    { role: 'user', content: 'How do I apply?' }, { role: 'assistant', content: '', status: 'generating', id: 'x' },
  ];
  check('findReply: answers the LAST identical question', findReply(msgs, 'How do I apply? ')?.id === 'x');
  check('findReply: none yet', findReply(msgs.slice(0, 3), 'How do I apply?') === null);
  check('isFinal: generating is not', !isFinal(msgs[3]) && isFinal({ status: 'done' }) && isFinal({ status: 'error' }) && isFinal({ status: null }));
  const old = { status: 'generating', created_at: new Date(Date.now() - STUCK_MS - 1000).toISOString() };
  check('isStuck: generating > 3 min', isStuck(old) && !isStuck({ ...old, created_at: new Date().toISOString() }) && !isStuck({ ...old, status: 'done' }));
  check('questionBefore: nearest user turn', questionBefore(msgs, 3) === 'How do I apply?' && questionBefore(msgs, 0) === null);
}

// ── 9. watchReply: Realtime + polling until done ────────────────
async function watchTests() {
  {
    let calls = 0;
    let notify = null;
    const rows = () => [{ role: 'user', content: 'Q' }, { role: 'assistant', id: 'm', content: calls >= 3 ? 'A' : '', status: calls >= 3 ? 'done' : 'generating' }];
    const ticks = [];
    const w = watchReply({
      fetchMessages: async () => { calls++; return rows(); },
      subscribe: (cb) => { notify = cb; return () => { notify = null; }; },
      pick: (m) => m.find((x) => x.id === 'm'),
      onTick: (_m, r) => ticks.push(r?.status),
      pollMs: 10000, timeoutMs: 2000,
    });
    await new Promise((r) => setTimeout(r, 10));
    notify?.(); await new Promise((r) => setTimeout(r, 10));
    notify?.();
    const res = await w;
    check('watchReply: resolves on the Realtime nudge that sees done', res.reply.status === 'done' && calls === 3, `calls=${calls}`);
    check('watchReply: ticks show progress', ticks.join(',') === 'generating,generating,done', ticks.join(','));
    check('watchReply: unsubscribes when done', notify === null);
  }
  {
    let calls = 0;
    const w = watchReply({
      fetchMessages: async () => { calls++; if (calls === 1) throw new Error('offline'); return [{ role: 'assistant', id: 'm', status: calls > 2 ? 'error' : 'generating' }]; },
      pick: (m) => m[0], pollMs: 5, timeoutMs: 2000,
    });
    const res = await w;
    check('watchReply: polling survives a failed fetch and ends on error status', res.reply.status === 'error');
  }
  {
    const w = watchReply({ fetchMessages: async () => [], pick: () => null, pollMs: 5, timeoutMs: 40 });
    const e = await w.then(() => null, (x) => x);
    check('watchReply: times out (→ "Buddy lost this reply")', e?.message === 'timeout');
  }
  {
    const w = watchReply({ fetchMessages: async () => [], pick: () => null, pollMs: 5, timeoutMs: 5000 });
    setTimeout(() => w.cancel(), 20);
    const e = await w.then(() => null, (x) => x);
    check('watchReply: cancel (Stop) rejects as cancelled', e?.message === 'cancelled');
  }
  {
    let hits = 0;
    let online = null;
    const w = watchReply({
      fetchMessages: async () => { hits++; return [{ role: 'assistant', id: 'm', status: hits > 1 ? 'done' : 'generating' }]; },
      pick: (m) => m[0], pollMs: 100000, timeoutMs: 2000,
      addOnline: (cb) => { online = cb; return () => {}; },
    });
    setTimeout(() => online(), 15);
    const res = await w;
    check('watchReply: coming back online re-checks at once', res.reply.status === 'done' && hits === 2);
  }
}

// ── 10. history, page awareness, citations ──────────────────────
{
  const now = new Date('2026-09-30T15:00:00');
  const g = groupConversations([
    { id: 'p', pinned: true, updated_at: '2026-01-01T00:00:00' },
    { id: 't', updated_at: '2026-09-30T09:00:00' },
    { id: 'y', updated_at: '2026-09-29T09:00:00' },
    { id: 'w', updated_at: '2026-09-26T09:00:00' },
    { id: 'o', updated_at: '2026-08-01T09:00:00' },
  ], now);
  check('groups: Pinned/Today/Yesterday/Last 7 days/Older', g.map((x) => `${x.label}:${x.items[0].id}`).join('|') === 'Pinned:p|Today:t|Yesterday:y|Last 7 days:w|Older:o', JSON.stringify(g.map((x) => x.label)));

  const ctx = pageContextFor(`/brands/${C1}`, `?report=${C1}&x=1`);
  check('page_context: brand + report ids', ctx.route === `/brands/${C1}` && ctx.brand_id === C1 && ctx.report_id === C1);
  check('page_context: non-uuid ids dropped', !pageContextFor('/brands/new').brand_id);
  check('chips: brand page', pageChips(`/brands/${C1}`, 'PDC')[1] === 'How is PDC doing this month?');
  check('chips: leave page', pageChips('/leave')[0] === 'How do I apply for leave?');
  check('chips: fallback', pageChips('/somewhere').includes('How do I use this page?'));

  const sources = [{ id: 'S2', cited: true, title: 'b' }, { id: 'D1', cited: true, title: 'a' }, { id: 'S9', cited: false }];
  const html = citeHtml('<div>GMV $1 [D1] and steps [S2, D1] <b>[X1]</b></div>', sources);
  check('cites: numbered by source order', html.includes('data-cite="D1" aria-label="Source 2">2<') && html.includes('data-cite="S2" aria-label="Source 1">1<'), html);
  check('cites: non-citations untouched', html.includes('[X1]'));
  check('sources: cited first, numbered', orderSources(sources).map((s) => `${s.id}${s.n}`).join(',') === 'S21,D12,S93');
  check('sourceLink: app / external / none', sourceLink({ url: '/kb' }).kind === 'app' && sourceLink({ url: 'https://x' }).kind === 'ext'
    && sourceLink({ url: '//evil' }) === null && sourceLink({ url: 'javascript:alert(1)' }) === null);
  check('greeting: empty → Buddy text with name', greetingText('', 'Umar') === "Hi Umar! I'm Wurx Buddy: here to help, explore and grow.");
  check('greeting: v1 default → Buddy text', greetingText("Hi! I'm your WurxOS assistant. Ask me anything.", 'Umar').startsWith("Hi Umar! I'm Wurx Buddy"));
  check('greeting: Boss text with {name}', greetingText('Salaam {name}, what are we fixing today?', 'Ali') === 'Salaam Ali, what are we fixing today?');
  check('greeting: no name → "Hi!"', greetingText('', '').startsWith("Hi! I'm Wurx Buddy"), greetingText('', ''));
  check('roles: fallback fails closed (boss only)', BUDDY_ROLES.join() === 'boss' && buddyRoles(null).join() === 'boss');
  check('roles: allowed_roles is used when read', buddyRoles(['Boss', 'apc']).join() === 'boss,apc' && buddyRoles([]).length === 0);
  const inAttr = citeHtml('<div><a href="/kb?q=[S2]" class="ai-link">see [S2]</a> and <span title="a>[D1]">x</span> [D1]</div>', sources);
  check('cites: markers inside attributes untouched', inAttr.includes('href="/kb?q=[S2]"') && inAttr.includes('title="a>[D1]"'), inAttr);
  check('cites: text markers still rewritten', (inAttr.match(/class="bd-cite"/g) || []).length === 2, inAttr);
}

await watchTests();
console.log(results.join('\n'));
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
