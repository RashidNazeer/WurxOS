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
  visibleMessages, canRegenerateMsg, clockSkew, nextAllowedRoles, ALL_ROLES,
  catalogRowUsable, modelBadges, modelOptions, modelLabel, creditsExhausted, lastChecked,
  chainAdd, chainRemove, chainMove, optionKey, parseOptionKey, FALLBACK_MAX,
  slotsOf, slotLabel, allOptions, filterOptions, keySlotRows, KEY_SLOTS,
  TRANSIENT_REASON, chainEntryStatus, vectorsByModel, freeSourcesValue, toggleInList,
  keySlotMeta, canEditSettings,
  normalizeRoleModels, roleModelView, setRoleMain, setRoleBackups, setRoleEconomy, budgetSaverState, modelSourceLabel,
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
  check('roles: fallback fails closed (Boss + developers only)', BUDDY_ROLES.join() === 'boss,developer' && buddyRoles(null).join() === 'boss,developer');
  check('roles: allowed_roles adds to the always-roles', buddyRoles(['Boss', 'apc']).join() === 'boss,developer,apc' && buddyRoles([]).join() === 'boss,developer');
  check('roles: Boss and developers can never be removed', ['boss', 'developer'].every((r) => buddyRoles([]).includes(r) && buddyRoles(['apc']).includes(r)));
  const inAttr = citeHtml('<div><a href="/kb?q=[S2]" class="ai-link">see [S2]</a> and <span title="a>[D1]">x</span> [D1]</div>', sources);
  check('cites: markers inside attributes untouched', inAttr.includes('href="/kb?q=[S2]"') && inAttr.includes('title="a>[D1]"'), inAttr);
  check('cites: text markers still rewritten', (inAttr.match(/class="bd-cite"/g) || []).length === 2, inAttr);
}

// ── completion pass: regenerate, skew, stop mood, load errors, roles ──
{
  const C3 = '33333333-3333-4333-8333-333333333333';
  const base = run(S0, { type: 'THREAD_LOADED', key: C3, messages: [
    { id: 'u1', role: 'user', content: 'How do I apply for leave?' },
    { id: 'a1', role: 'assistant', content: 'Old answer', status: 'done', sources: [{ id: 'S1' }] },
  ] });

  // Regenerate replaces the answer in place; the question is not repeated.
  let s = run(base, { type: 'REGEN_START', key: C3, messageId: 'a1', text: 'How do I apply for leave?', at: T0 });
  let m = s.threads[C3].messages;
  check('regen: no repeated question', m.length === 2 && m.filter((x) => x.role === 'user').length === 1);
  check('regen: old text kept aside, status "Regenerating…"', m[1].regenerating && m[1].oldContent === 'Old answer' && m[1].content === '' && s.inflight[C3].status === 'Regenerating…');
  check('regen: thinking while it runs', deriveMood(s) === 'thinking');
  s = run(s, { type: 'MSG_ID', key: C3, messageId: 'a2' }, { type: 'DELTA', key: C3, delta: 'New answer' },
    { type: 'DONE', key: C3, messageId: 'a2', status: 'done', viewed: true });
  m = s.threads[C3].messages;
  check('regen: new answer replaces the old, flags cleared', m.length === 2 && m[1].content === 'New answer' && m[1].id === 'a2'
    && !m[1].regenerating && !m[1].oldContent && !m[1].previous, JSON.stringify(m[1]));

  // Failed or stopped after starting: the old row is superseded on the server; keep it for "Show previous".
  const failed = run(base, { type: 'REGEN_START', key: C3, messageId: 'a1', text: 'Q', at: T0 },
    { type: 'DONE', key: C3, messageId: 'a3', status: 'error', error: 'That took too long…', viewed: true });
  check('regen fails: new error stands, previous answer kept aside', failed.threads[C3].messages[1].error === 'That took too long…'
    && failed.threads[C3].messages[1].previous?.content === 'Old answer');
  const stopped = run(base, { type: 'REGEN_START', key: C3, messageId: 'a1', text: 'Q', at: T0 },
    { type: 'MSG_ID', key: C3, messageId: 'a4' }, { type: 'STOPPING', key: C3 },
    { type: 'DONE', key: C3, messageId: 'a4', status: 'error', cancelled: true, viewed: true });
  check('regen stopped: "Stopped" + previous answer', stopped.threads[C3].messages[1].stopped && stopped.threads[C3].messages[1].previous?.content === 'Old answer');

  // Refused before starting (409 etc.): nothing changed, the old answer is back as it was.
  const refused = run(base, { type: 'REGEN_START', key: C3, messageId: 'a1', text: 'Q', at: T0 },
    { type: 'FAILED', key: C3, error: 'Buddy is already working on this.', refused: true });
  const r1 = refused.threads[C3].messages[1];
  check('regen refused: old answer restored with a note', r1.content === 'Old answer' && r1.id === 'a1' && r1.status === 'done'
    && !r1.error && !r1.regenerating && r1.notice === 'Buddy is already working on this.' && !refused.inflight[C3], JSON.stringify(r1));
  const denied = run(base, { type: 'REGEN_START', key: C3, messageId: 'a1', text: 'Q', at: T0 },
    { type: 'FAILED', key: C3, error: 'x', denied: true, refused: true });
  check('regen 403: restores instead of dropping the turn', denied.threads[C3].messages.length === 2 && denied.threads[C3].messages[1].content === 'Old answer');
  check('regen: unknown id is ignored', run(base, { type: 'REGEN_START', key: C3, messageId: 'nope', text: 'Q', at: T0 }) === base);
  check('409 → "already working on this"', friendlyError(409).conflict && /already working/.test(friendlyError(409).text));

  // Rows.
  const sup = rowToMessage({ id: 'o', role: 'assistant', content: 'x', status: 'superseded', meta: { superseded_by: 'n' } });
  const sup2 = rowToMessage({ id: 'o2', role: 'assistant', content: 'x', status: 'done', meta: { superseded_by: 'n' } });
  const nu = rowToMessage({ id: 'n', role: 'assistant', content: 'y', status: 'error', meta: { supersedes: 'o', error: 'boom' } });
  check('rows: superseded hidden (status or meta)', visibleMessages([sup, sup2, nu]).map((x) => x.id).join() === 'n');
  check('rows: supersedes kept for "Show previous"', nu.supersedes === 'o');
  check('canRegenerate: saved last reply, done or error only',
    canRegenerateMsg({ role: 'assistant', id: 'a', status: 'done' }) && canRegenerateMsg({ role: 'assistant', id: 'a', status: 'error' })
    && !canRegenerateMsg({ role: 'assistant', id: 'a', status: 'generating' }) && !canRegenerateMsg({ role: 'assistant', status: 'done' })
    && !canRegenerateMsg({ role: 'assistant', id: 'a', status: 'done', pending: true }));

  // Clock skew: rows' created_at is server time.
  const local = Date.parse('2026-09-30T10:00:00Z');
  check('skew: server 5 min ahead', clockSkew('2026-09-30T10:05:00Z', local) === 300000);
  check('skew: small / missing / absurd → 0', clockSkew('2026-09-30T10:00:01Z', local) === 0 && clockSkew(null, local) === 0 && clockSkew('2020-01-01T00:00:00Z', local) === 0);
  const row = { status: 'generating', created_at: '2026-09-30T10:03:00Z' };
  check('isStuck: judged on the server clock', !isStuck(row, local + 300000) && isStuck(row, local + 300000 + 3 * 60000));

  // Stop → idle at once.
  const stopping = run(S0, { type: 'SEND_START', key: C3, text: 'Q', at: T0 }, { type: 'MSG_ID', key: C3, messageId: 'm' }, { type: 'STOPPING', key: C3 });
  check('mood: idle as soon as Stop is pressed', deriveMood(stopping) === 'idle' && !!stopping.inflight[C3]);

  // Stop before {started} in a new chat: the stopped view moves to the real id.
  const moved = run(S0, { type: 'SEND_START', key: 'tmp:5', text: 'Q', at: T0 }, { type: 'PAGE_KEY', key: 'tmp:5' },
    { type: 'DELTA', key: 'tmp:5', delta: 'Part' }, { type: 'STOPPED', key: 'tmp:5' }, { type: 'CONV_ID', from: 'tmp:5', to: C3 });
  check('stop before started: thread, stopped flag and view move to the real id', moved.threads[C3]?.messages.at(-1).stopped
    && moved.stopped[C3] && !moved.threads['tmp:5'] && moved.pageKey === C3);

  // Load errors.
  let e = run(S0, { type: 'CONVS_ERROR', error: 'net' });
  check('history: error shown before the first load', e.convsError === 'net' && !e.convsLoaded);
  e = run(e, { type: 'CONVS_LOADED', convs: [] });
  check('history: a load clears the error', e.convsLoaded && e.convsError === null);
  check('thread: error when nothing is shown yet', run(S0, { type: 'THREAD_ERROR', key: C3, error: 'x' }).threads[C3].error === 'x');
  check('thread: a failed refetch keeps what is on screen', run(base, { type: 'THREAD_ERROR', key: C3, error: 'x' }) === base);

  // Allowed roles: Boss and developers always in, order stable.
  check('roles: Boss + developers always included', nextAllowedRoles([], 'apc', true).join() === 'boss,apc,developer'
    && nextAllowedRoles(['boss'], 'boss', false).join() === 'boss,developer' && nextAllowedRoles(['boss', 'developer'], 'developer', false).join() === 'boss,developer');
  check('roles: toggle off, stable order', nextAllowedRoles(['developer', 'apc', 'boss', 'tl'], 'apc', false).join() === 'boss,tl,developer');
  check('roles: 8 roles offered', ALL_ROLES.length === 8);
}

// ── models (mig 397): usable filter, badges, picker groups, fallback chain ──
{
  const row = (o) => ({ key_slot: 'primary', available: true, supports_tools: true, supports_stream: true, free: false, last_error: null, ...o });
  const cat = [
    row({ model: 'gpt-5.4-mini' }),
    row({ model: 'gpt-5.5', available: false, supports_tools: false, supports_stream: false, last_error: 'HTTP 429: insufficient_quota' }),
    row({ model: 'gpt-4.1-weird', available: false, last_error: 'HTTP 404: model_not_found' }),
    row({ model: 'gpt-x-notools', supports_tools: false }),
    row({ model: 'gpt-x-nostream', supports_stream: false }),
    row({ key_slot: 'fallback', model: 'gpt-6-luna', free: true }),
    row({ key_slot: 'fallback', model: 'gpt-6-quota', available: false, last_error: 'HTTP 429: insufficient_quota' }),
  ];
  const by = (slot, m) => cat.find((r) => r.key_slot === slot && r.model === m);

  // Usable = available with tools and streaming, or a built-in on the main key that failed only for credits.
  check('usable: working model', catalogRowUsable(by('primary', 'gpt-5.4-mini')));
  check('usable: built-in out of credits stays choosable', catalogRowUsable(by('primary', 'gpt-5.5')));
  check('usable: not for other failures / no tools / no stream', !catalogRowUsable(by('primary', 'gpt-4.1-weird'))
    && !catalogRowUsable(by('primary', 'gpt-x-notools')) && !catalogRowUsable(by('primary', 'gpt-x-nostream')));
  check('usable: quota exemption is main-key built-ins only', !catalogRowUsable(by('fallback', 'gpt-6-quota')));

  check('badges: free + tools + streaming', modelBadges(by('fallback', 'gpt-6-luna')).join() === 'Free,Tools ✓,Streaming ✓');
  check('badges: needs credits, still usable', modelBadges(by('primary', 'gpt-5.5')).join() === 'Needs credits');
  check('badges: not usable', modelBadges(by('primary', 'gpt-x-notools')).includes('Not usable'));

  const opts = modelOptions(cat);
  check('picker: grouped by key', opts.primary.length === 5 && opts.fallback.length === 2);
  check('picker: usable first, built-ins first', opts.primary.slice(0, 2).map((o) => o.model).join() === 'gpt-5.4-mini,gpt-5.5' && opts.primary[2].usable === false,
    opts.primary.map((o) => o.model).join());
  const nt = opts.primary.find((o) => o.model === 'gpt-x-notools');
  check('picker: unusable carries a reason', !nt.usable && /tool calling/.test(nt.reason));
  check('picker: unusable reason from last_error', /model_not_found/.test(opts.primary.find((o) => o.model === 'gpt-4.1-weird').reason));
  check('picker: friendly labels for the three built-ins', modelLabel('gpt-5.4-nano') === 'gpt-5.4-nano (cheapest)'
    && modelLabel('gpt-5.4-mini') === 'gpt-5.4-mini (recommended)' && modelLabel('gpt-5.5') === 'gpt-5.5 (strongest)' && modelLabel('gpt-6-luna') === 'gpt-6-luna');
  const empty = modelOptions([]);
  check('picker: empty catalog → the three built-ins on the main key', empty.primary.map((o) => o.model).sort().join() === 'gpt-5.4-mini,gpt-5.4-nano,gpt-5.5'
    && empty.primary.every((o) => o.usable) && empty.fallback.length === 0);
  const k = optionKey('fallback', 'gpt-6-luna');
  check('option keys round-trip (model names may contain dots)', JSON.stringify(parseOptionKey(k)) === '{"key_slot":"fallback","model":"gpt-6-luna"}');

  // Credits banner.
  check('credits: from the refresh result', creditsExhausted(cat, { slots: { primary: { credits_exhausted: true } } }) === true
    && creditsExhausted(cat, { slots: { primary: { credits_exhausted: false } } }) === false);
  const dry = [row({ model: 'gpt-5.4-mini', available: false, last_error: 'HTTP 429: insufficient_quota' }), row({ model: 'gpt-5.5', available: false, last_error: 'credit balance exhausted' })];
  check('credits: from the catalog after a reload', creditsExhausted(dry, null) && !creditsExhausted(cat, null) && !creditsExhausted([], null));
  check('last checked: newest checked_at', lastChecked([{ checked_at: '2026-10-01T10:00:00Z' }, { checked_at: '2026-10-01T11:00:00Z' }]) === '2026-10-01T11:00:00.000Z' && lastChecked([]) === null);

  // Fallback chain.
  const a = { key_slot: 'fallback', model: 'gpt-6-luna' };
  let c = chainAdd([], a);
  check('chain: add', c.length === 1 && c[0].model === 'gpt-6-luna');
  check('chain: no duplicates', chainAdd(c, { ...a }).length === 1 && chainAdd(c, { key_slot: 'primary', model: 'gpt-6-luna' }).length === 2);
  for (let i = 0; i < 20; i++) c = chainAdd(c, { key_slot: 'primary', model: `m${i}` });
  check('chain: capped at 6 (MAX_FALLBACKS / the mig 401 trigger)', c.length === FALLBACK_MAX && FALLBACK_MAX === 6);
  check('chain: a smaller cap from the backend is honoured', chainAdd([a, { key_slot: 'gemini', model: 'g' }], { key_slot: 'groq', model: 'q' }, 2).length === 2);
  check('chain: any key slot is kept as is', chainAdd([], { key_slot: 'gemini', model: 'gemini-3.5-flash' })[0].key_slot === 'gemini'
    && chainAdd([], { model: 'x' }).length === 0);
  const three = [{ key_slot: 'primary', model: 'a' }, { key_slot: 'primary', model: 'b' }, { key_slot: 'primary', model: 'c' }];
  check('chain: move up / down', chainMove(three, 1, -1).map((x) => x.model).join() === 'b,a,c' && chainMove(three, 1, 1).map((x) => x.model).join() === 'a,c,b');
  check('chain: moves past the ends do nothing', chainMove(three, 0, -1) === three && chainMove(three, 2, 1) === three);
  check('chain: remove', chainRemove(three, 1).map((x) => x.model).join() === 'a,c');

  // Which model answered.
  const fb = rowToMessage({ id: 'x', role: 'assistant', content: 'hi', status: 'done', meta: { model: 'gpt-6-luna', key_slot: 'fallback', fallback_used: { from: 'primary:gpt-5.4-mini', to: 'fallback:gpt-6-luna', reason: 'quota' } } });
  check('row: model, key and fallback', fb.model === 'gpt-6-luna' && fb.keySlot === 'fallback' && fb.fallbackUsed.reason === 'quota');
  const s = run(S0, { type: 'THREAD_LOADED', key: C1, messages: [{ id: 'q', role: 'user', content: 'Q' }, { id: 'x', role: 'assistant', content: 'A' }] },
    { type: 'MSG_META', key: C1, id: 'x', meta: { model: 'gpt-5.4-mini', keySlot: 'primary', fallbackUsed: null } });
  check('MSG_META: labels the live reply', s.threads[C1].messages[1].model === 'gpt-5.4-mini');
  check('MSG_META: unknown id ignored', run(s, { type: 'MSG_META', key: C1, id: 'nope', meta: { model: 'z' } }) === s);
}

// ── every model, four providers, search, safety net ────────────────
{
  const row = (o) => ({ available: true, supports_tools: true, supports_stream: true, free: false, last_error: null, ...o });
  const cat = [
    row({ key_slot: 'primary', model: 'gpt-5.4-mini' }),
    row({ key_slot: 'gemini', model: 'gemini-3.5-flash', free: true }),
    row({ key_slot: 'gemini', model: 'gemini-embedding-001', supports_tools: false, supports_stream: false }),
    row({ key_slot: 'groq', model: 'llama-4-scout', free: true }),
    row({ key_slot: 'mistral', model: 'mistral-small' }),
  ];
  check('slots: the four known, in order, then extras', slotsOf(cat).join() === 'primary,fallback,gemini,groq,mistral');
  check('slots: built-in labels mirror ai_key_slots', slotLabel('gemini') === 'Gemini (free)' && slotLabel('groq') === 'Groq (free)'
    && slotLabel('primary') === 'OpenAI' && slotLabel('fallback') === 'OpenAI (fallback key)' && slotLabel('mistral') === 'mistral');
  const meta = keySlotMeta([
    { slot: 'groq', label: 'Groq (free)', sort: 4 }, { slot: 'primary', label: 'OpenAI', sort: 1 },
    { slot: 'gemini', label: 'Google Gemini', sort: 3 }, { slot: 'fallback', label: 'OpenAI (fallback key)', sort: 2 },
  ]);
  check('key slots: order and labels come from the table', meta.order.join() === 'primary,fallback,gemini,groq'
    && slotLabel('gemini', meta) === 'Google Gemini' && slotsOf(cat, meta).at(-1) === 'mistral');
  check('key slots: empty / unreadable table → built-in labels', keySlotMeta([]).order.join() === 'primary,fallback,gemini,groq' && keySlotMeta(null).labels.primary === 'OpenAI');
  check('key slots: usage rows follow the table', keySlotRows({}, meta)[2].label === 'Google Gemini');
  check('settings: the Boss and active developers edit; nobody else',
    canEditSettings({ role: 'boss', is_active: true }) && canEditSettings({ role: 'developer', is_active: true })
    && !canEditSettings({ role: 'developer', is_active: false }) && !canEditSettings({ role: 'developer', deleted_at: '2026-01-01' })
    && !canEditSettings({ role: 'ol', is_active: true }) && !canEditSettings(null));
  const opts = modelOptions(cat);
  check('picker: every catalogued model is listed, unusable ones too', allOptions(opts).length === 5
    && opts.gemini.find((o) => o.model === 'gemini-embedding-001')?.usable === false && /tool calling/.test(opts.gemini[1].reason));
  check('picker: groups for all providers', opts.groq.length === 1 && opts.fallback.length === 0 && opts.mistral.length === 1);
  const f = filterOptions(opts, 'GEMINI', { key_slot: 'primary', model: 'gpt-5.4-mini' });
  check('search: case-insensitive, across groups', f.gemini.length === 2 && f.groq.length === 0);
  check('search: the chosen model is always kept', f.primary.length === 1 && f.primary[0].model === 'gpt-5.4-mini');
  check('search: empty query → everything', filterOptions(opts, '  ', null) === opts);

  const rows = keySlotRows({ primary: { questions: 3, fallback_used: 0, est_cost_usd: 0.01 }, gemini: { questions: 2, fallback_used: 2, est_cost_usd: 0 } });
  check('usage by key: the four slots, labelled, zeros when unused', rows.map((r) => r.slot).join() === KEY_SLOTS.join()
    && rows[0].questions === 3 && rows[1].questions === 0 && rows[2].label === 'Gemini (free)' && rows[3].est_cost_usd === 0);
  check('usage by key: extra slots appended', keySlotRows({ mistral: { questions: 1 } }).at(-1).slot === 'mistral');

  const fbRow = rowToMessage({ id: 'g', role: 'assistant', content: 'x', status: 'done', meta: { model: 'gemini-3.5-flash', key_slot: 'gemini', fallback_used: { from: 'primary:gpt-5.4-mini', to: 'gemini:gemini-3.5-flash', reason: 'quota' } } });
  check('answer label: any provider', fbRow.model === 'gemini-3.5-flash' && fbRow.keySlot === 'gemini' && !!fbRow.fallbackUsed);
}

// ── mig 401 alignment, mig 402 ingestion helpers ───────────────────
{
  const row = (o) => ({ available: true, supports_tools: true, supports_stream: true, free: true, last_error: null, reason: null, ...o });
  const cat = [
    row({ key_slot: 'gemini', model: 'gemini-3.5-flash', available: false, supports_tools: false, supports_stream: false, reason: TRANSIENT_REASON }),
    row({ key_slot: 'gemini', model: 'text-embedding-004', available: false, supports_tools: false, supports_stream: false, reason: 'embedding model (not for chat)', last_error: 'x' }),
    row({ key_slot: 'groq', model: 'openai/gpt-oss-120b' }),
  ];
  const o = modelOptions(cat);
  check('reason: the backend reason wins over last_error', o.gemini.find((x) => x.model === 'text-embedding-004').reason === 'embedding model (not for chat)');
  check('transient: marked, not usable', o.gemini.find((x) => x.model === 'gemini-3.5-flash').transient === true && !o.gemini.find((x) => x.model === 'gemini-3.5-flash').usable);
  check('chain status: ok / flaky / skipped / uncatalogued', chainEntryStatus({ key_slot: 'groq', model: 'openai/gpt-oss-120b' }, cat) === 'ok'
    && chainEntryStatus({ key_slot: 'gemini', model: 'gemini-3.5-flash' }, cat) === 'flaky'
    && chainEntryStatus({ key_slot: 'gemini', model: 'text-embedding-004' }, cat) === 'skipped'
    && chainEntryStatus({ key_slot: 'gemini', model: 'not-listed' }, cat) === 'skipped'
    && chainEntryStatus({ key_slot: 'fallback', model: 'gpt-6-luna' }, cat) === 'ok');

  check('vectors: object form', JSON.stringify(vectorsByModel({ vectors_by_model: { 'text-embedding-3-small': 11556, 'gemini-embedding-001': 200 } }))
    === '[{"model":"text-embedding-3-small","count":11556},{"model":"gemini-embedding-001","count":200}]');
  check('vectors: array form, any count field', vectorsByModel({ vectors_by_model: [{ model: 'a', n: 2 }, { embed_model: 'b', chunks: 5 }] }).map((x) => `${x.model}:${x.count}`).join() === 'b:5,a:2');
  check('vectors: missing → nothing', vectorsByModel({}).length === 0 && vectorsByModel(null).length === 0);

  const types = ['kb_article', 'ai_doc', 'app_guide', 'tts_article', 'report', 'incentive'];
  check('free sources: default leaves incentive plans out', freeSourcesValue(null, types).join() === 'kb_article,ai_doc,app_guide,tts_article,report');
  check('free sources: the saved list, in type order', freeSourcesValue(['report', 'kb_article', 'bogus'], types).join() === 'kb_article,report');
  check('toggle: add / remove keeps the order', toggleInList(['report'], 'kb_article', true, types).join() === 'kb_article,report'
    && toggleInList(['kb_article', 'report'], 'report', false, types).join() === 'kb_article');
}

// ── models by role: helpers only (the card ships once role_models exists) ──
{
  const global = { model: 'gpt-5.4-mini', model_key_slot: 'primary', fallback_models: [{ key_slot: 'gemini', model: 'gemini-3.5-flash' }] };
  let rm = normalizeRoleModels({ apc: { model: 'x', key_slot: 'groq', junk: 1, economy: { model: 'g', key_slot: 'gemini' } }, ol: { junk: true } });
  check('role models: only the known shape survives', JSON.stringify(rm) === '{"apc":{"model":"x","key_slot":"groq","economy":{"key_slot":"gemini","model":"g"}}}', JSON.stringify(rm));
  const tl = roleModelView(rm, 'tl', global);
  check('role models: inherit shows the global model and chain', tl.main.inherit && tl.main.model === 'gpt-5.4-mini' && tl.backups.inherit && tl.backups.chain.length === 1 && tl.economy === null);
  const apc = roleModelView(rm, 'apc', global);
  check('role models: override + economy', !apc.main.inherit && apc.main.model === 'x' && apc.economy.model === 'g' && apc.backups.inherit);
  rm = setRoleBackups(rm, 'apc', [{ key_slot: 'groq', model: 'a' }]);
  check('role models: custom backups', !roleModelView(rm, 'apc', global).backups.inherit);
  rm = setRoleMain(setRoleEconomy(setRoleBackups(rm, 'apc', null), 'apc', null), 'apc', null);
  check('role models: clearing every override removes the role', !('apc' in rm));
  const s = budgetSaverState(80, { budget_usd: 50, budget_used_pct: 85 });
  check('budget saver: active at/over the threshold', s.hasBudget && s.active && s.usedPct === 85);
  check('budget saver: no budget → never active', !budgetSaverState(80, { budget_usd: null, budget_used_pct: null }).hasBudget && !budgetSaverState(80, {}).active);
  check('model source labels', modelSourceLabel('economy') === 'budget saver (economy)' && modelSourceLabel(null) === null);
}

await watchTests();
console.log(results.join('\n'));
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
