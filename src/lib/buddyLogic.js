// Wurx Buddy: the pure parts (no React, no Supabase, no import.meta), so
// scripts/buddy-tests.mjs can run them under plain Node.
//   • buddyReducer: conversations, threads, in-flight replies, unread, panel
//   • deriveMood: which clip the floating Buddy plays
//   • parseSse / friendlyError: the transport contract
//   • findReply / watchReply: picking up a reply after the stream dropped
//   • history groups, page-aware chips, role starter cards

// Who sees Buddy comes from ai_assistant_config.allowed_roles (the same list
// the assistant function enforces). This is only the fallback when that read
// fails, and it fails closed.
export const BUDDY_ROLES = ['boss'];

export function buddyRoles(allowedRoles) {
  return Array.isArray(allowedRoles) ? allowedRoles.map((r) => String(r).toLowerCase()) : BUDDY_ROLES;
}

export const TMP_PREFIX = 'tmp:';
export const isTmpKey = (k) => typeof k === 'string' && k.startsWith(TMP_PREFIX);

// ── state ──────────────────────────────────────────────────────────
export const initialBuddyState = {
  convs: [],        // ai_conversations rows (own only), newest first
  threads: {},      // key → { messages: [], loaded: bool }
  inflight: {},     // key → { status, startedAt, recovering, text }
  unread: {},       // conversation id → true
  readAt: {},       // conversation id → ms the user last saw it here (beats a stale server read)
  panel: 'closed',  // closed | open | minimised
  quickKey: null,   // the quick panel's conversation
  pageKey: null,    // the /buddy tab's conversation
  bounce: 0,        // bumps once per reply that lands unseen (the FAB bounces on change)
  denied: false,    // the backend refused this role (403)
  stopped: {},      // key → true: the user pressed Stop; its late reply is not "unread"
  convsLoaded: false, // history has loaded at least once (skeleton until then)
  convsError: null,   // the last history read failed (shown with Retry)
};

// Every role that can be offered Buddy (Settings → Allowed roles).
export const ALL_ROLES = [
  ['boss', 'Boss'], ['ol', 'Operation Leads'], ['tl', 'Team Leads'], ['pctl', 'Paid Collab TLs'],
  ['apc', 'APCs'], ['ipc', 'IPCs'], ['ads_manager', 'Ads Managers'], ['developer', 'Developers'],
];

// The Boss is always included: ticking roles can only widen access.
export function nextAllowedRoles(current, role, on) {
  const set = new Set([...(Array.isArray(current) ? current : []), 'boss'].map((r) => String(r).toLowerCase()));
  if (role !== 'boss') { if (on) set.add(role); else set.delete(role); }
  return ALL_ROLES.map(([r]) => r).filter((r) => set.has(r));
}

const ms = (iso) => (iso ? new Date(iso).getTime() || 0 : 0);

// A reply the user has not seen, per the server columns (§6): last_reply_at
// after last_read_at, and after anything this client marked read.
export function serverUnread(conv, readAtMs = 0) {
  const reply = ms(conv?.last_reply_at);
  if (!reply) return false;
  return reply > Math.max(ms(conv.last_read_at), readAtMs || 0);
}

function renameKey(obj, from, to) {
  if (!(from in obj)) return obj;
  const { [from]: v, ...rest } = obj;
  return { ...rest, [to]: v };
}

function patchLastAssistant(thread, fn) {
  const messages = (thread?.messages || []).slice();
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'assistant') { messages[i] = fn(messages[i]); break; }
  }
  return { ...(thread || { loaded: true }), messages };
}

// End of a regenerate (mig 389). Refused before it started (409 etc.): nothing
// changed on the server, so the old answer comes back as it was. Otherwise
// the new reply stands (the old row is superseded); if it failed or was
// stopped, the old text is kept aside for "Show previous answer".
export function settleRegen(m, { restore = false } = {}) {
  if (!m.regenerating) return m;
  const { regenerating: _r, oldContent, oldSources, oldId, oldStatus, ...rest } = m;
  if (restore) {
    return { ...rest, id: oldId ?? rest.id, status: oldStatus ?? 'done', content: oldContent || '', sources: oldSources || [], error: null, stopped: false };
  }
  const keep = (rest.error || rest.stopped) && oldContent;
  return keep ? { ...rest, previous: { content: oldContent, sources: oldSources || [] } } : rest;
}

export function buddyReducer(state, a) {
  switch (a.type) {
    case 'CONVS_LOADED': {
      const unread = { ...state.unread };
      for (const c of a.convs) if (!state.stopped?.[c.id] && serverUnread(c, state.readAt[c.id])) unread[c.id] = true;
      return { ...state, convs: a.convs, unread, convsLoaded: true, convsError: null };
    }
    case 'CONVS_ERROR':
      return { ...state, convsError: a.error || 'error' };
    case 'THREAD_LOADED':
      // Never clobber a thread that is streaming right now.
      if (state.inflight[a.key] && !state.inflight[a.key].recovering) return state;
      return { ...state, threads: { ...state.threads, [a.key]: { messages: a.messages, loaded: true } } };
    case 'THREAD_ERROR':
      // Only when nothing is shown yet: a failed refetch keeps what is on screen.
      if (state.threads[a.key]?.loaded || state.inflight[a.key]) return state;
      return { ...state, threads: { ...state.threads, [a.key]: { messages: [], loaded: false, error: a.error || 'error' } } };
    case 'REGEN_START': {
      // Regenerate replaces the answer in place: the old text stays, faded,
      // until the new one starts arriving (then it is dropped).
      const t = state.threads[a.key];
      if (!t || state.inflight[a.key]) return state;
      const messages = t.messages.slice();
      const i = messages.findIndex((m) => m.role === 'assistant' && m.id === a.messageId);
      if (i < 0) return state;
      const old = messages[i];
      messages[i] = {
        ...old, pending: true, regenerating: true,
        oldContent: old.content, oldSources: old.sources, oldId: old.id, oldStatus: old.status,
        content: '', sources: [], error: null, stopped: false, previous: null, status: 'generating', created_at: a.at,
      };
      const { [a.key]: _s, ...stopped } = state.stopped || {};
      return {
        ...state, stopped,
        threads: { ...state.threads, [a.key]: { ...t, messages } },
        inflight: { ...state.inflight, [a.key]: { status: 'Regenerating…', startedAt: a.at, recovering: false, text: a.text, regenerate: a.messageId } },
      };
    }
    case 'SEND_START': {
      const t = state.threads[a.key] || { messages: [], loaded: true };
      const messages = [
        ...t.messages,
        { role: 'user', content: a.text, created_at: a.at },
        { role: 'assistant', content: '', pending: true, created_at: a.at, sources: [] },
      ];
      const { [a.key]: _s, ...stopped } = state.stopped || {};
      return {
        ...state,
        stopped,
        threads: { ...state.threads, [a.key]: { ...t, messages } },
        inflight: { ...state.inflight, [a.key]: { status: 'On it…', startedAt: a.at, recovering: false, text: a.text } },
      };
    }
    case 'STATUS':
      // While stopping, keep saying so.
      if (!state.inflight[a.key] || state.inflight[a.key].stopping) return state;
      return { ...state, inflight: { ...state.inflight, [a.key]: { ...state.inflight[a.key], status: a.status } } };
    case 'MSG_ID':
      // The reply row's id ({started}, or found by recovery): what Stop cancels.
      if (!state.inflight[a.key] || state.inflight[a.key].messageId === a.messageId) return state;
      return { ...state, inflight: { ...state.inflight, [a.key]: { ...state.inflight[a.key], messageId: a.messageId } } };
    case 'STOPPING': {
      // Cancel sent; the stream (or the watcher) still runs to its done.
      if (!state.inflight[a.key]) return state;
      const { [a.key]: _u, ...unread } = state.unread;
      return {
        ...state, unread, stopped: { ...(state.stopped || {}), [a.key]: true },
        inflight: { ...state.inflight, [a.key]: { ...state.inflight[a.key], stopping: true, status: 'Stopping…' } },
      };
    }
    case 'DELTA':
      if (!state.inflight[a.key]) return state;
      return { ...state, threads: { ...state.threads, [a.key]: patchLastAssistant(state.threads[a.key], (m) => ({ ...m, content: m.content + a.delta })) } };
    case 'SOURCES':
      return { ...state, threads: { ...state.threads, [a.key]: patchLastAssistant(state.threads[a.key], (m) => ({ ...m, sources: a.sources })) } };
    case 'CONV_ID': {
      if (a.from === a.to) return state;
      return {
        ...state,
        threads: renameKey(state.threads, a.from, a.to),
        inflight: renameKey(state.inflight, a.from, a.to),
        stopped: renameKey(state.stopped || {}, a.from, a.to),
        quickKey: state.quickKey === a.from ? a.to : state.quickKey,
        pageKey: state.pageKey === a.from ? a.to : state.pageKey,
      };
    }
    case 'DONE':
    case 'RECOVERED': {
      if (!state.inflight[a.key]) return state;
      const { [a.key]: _gone, ...inflight } = state.inflight;
      const threads = a.type === 'RECOVERED' && a.messages
        ? { ...state.threads, [a.key]: { messages: a.messages, loaded: true } }
        : { ...state.threads, [a.key]: patchLastAssistant(state.threads[a.key], (m) => settleRegen({
            ...m, pending: false, requestId: a.requestId ?? m.requestId, id: a.messageId ?? m.id,
            status: a.status ?? m.status ?? null,
            // A cancelled reply is "Stopped", not an error.
            stopped: !!a.cancelled || !!m.stopped,
            error: a.cancelled ? null : a.error || m.error || (a.status === 'error' ? 'Buddy hit a problem with this answer.' : null),
          })) };
      const unseen = !a.viewed && !isTmpKey(a.key) && !a.cancelled && !state.stopped?.[a.key];
      return {
        ...state, threads, inflight,
        unread: unseen ? { ...state.unread, [a.key]: true } : state.unread,
        bounce: unseen ? state.bounce + 1 : state.bounce,
      };
    }
    case 'RESUME':
      // A reply still generating from before a reload.
      if (state.inflight[a.key]) return state;
      return { ...state, inflight: { ...state.inflight, [a.key]: { status: 'Buddy is still working on this…', startedAt: a.at, recovering: true, text: null, messageId: a.messageId ?? null } } };
    case 'RESET':
      return initialBuddyState;
    case 'RECOVERING':
      if (!state.inflight[a.key]) return state;
      return { ...state, inflight: { ...state.inflight, [a.key]: { ...state.inflight[a.key], recovering: true, status: a.status || state.inflight[a.key].status } } };
    case 'RECOVER_TICK':
      if (!state.inflight[a.key]) return state;
      return { ...state, threads: { ...state.threads, [a.key]: { messages: a.messages, loaded: true } } };
    case 'FAILED': {
      const { [a.key]: _gone, ...inflight } = state.inflight;
      let t = state.threads[a.key] || { messages: [], loaded: true };
      const regen = [...t.messages].reverse().find((m) => m.role === 'assistant')?.regenerating;
      if (regen && (a.refused || a.denied)) {
        // A refused Regenerate changed nothing: put the old answer back, with a note.
        t = patchLastAssistant(t, (m) => ({ ...settleRegen(m, { restore: true }), notice: a.error }));
      } else if (a.denied) {
        // Drop the turn we optimistically added: the backend never took it.
        t = { ...t, messages: t.messages.slice(0, -2) };
      } else {
        t = patchLastAssistant(t, (m) => settleRegen({ ...m, pending: false, error: a.error, content: m.content || '' }));
      }
      return { ...state, inflight, threads: { ...state.threads, [a.key]: t }, denied: state.denied || !!a.denied };
    }
    case 'STOPPED': {
      if (!state.inflight[a.key]) return state;
      const { [a.key]: _gone, ...inflight } = state.inflight;
      const { [a.key]: _u, ...unread } = state.unread;
      return {
        ...state, inflight, unread, stopped: { ...(state.stopped || {}), [a.key]: true },
        threads: { ...state.threads, [a.key]: patchLastAssistant(state.threads[a.key], (m) => settleRegen({ ...m, pending: false, stopped: true })) },
      };
    }
    case 'MARK_READ': {
      if (!state.unread[a.id] && state.readAt[a.id] && a.at <= state.readAt[a.id]) return state;
      const { [a.id]: _gone, ...unread } = state.unread;
      return { ...state, unread, readAt: { ...state.readAt, [a.id]: a.at } };
    }
    case 'PANEL':
      return { ...state, panel: a.panel, quickKey: a.quickKey !== undefined ? a.quickKey : state.quickKey };
    case 'QUICK_KEY':
      return { ...state, quickKey: a.key };
    case 'PAGE_KEY':
      return { ...state, pageKey: a.key };
    case 'MSG_META': {
      // Which model answered (read back from the saved row after {done}).
      const t = state.threads[a.key];
      if (!t || !t.messages.some((m) => m.id === a.id)) return state;
      return { ...state, threads: { ...state.threads, [a.key]: { ...t, messages: t.messages.map((m) => (m.id === a.id ? { ...m, ...a.meta } : m)) } } };
    }
    case 'CONV_PATCH':
      return { ...state, convs: state.convs.map((c) => (c.id === a.id ? { ...c, ...a.patch } : c)) };
    case 'CONV_REMOVE': {
      const { [a.id]: _t, ...threads } = state.threads;
      const { [a.id]: _u, ...unread } = state.unread;
      return {
        ...state, threads, unread,
        convs: state.convs.filter((c) => c.id !== a.id),
        quickKey: state.quickKey === a.id ? null : state.quickKey,
        pageKey: state.pageKey === a.id ? null : state.pageKey,
      };
    }
    default:
      return state;
  }
}

export const unreadCount = (state) => Object.keys(state.unread).length;

// idle → thinking (anything generating, panel open or not) → happy (a reply
// landed unseen). Generating wins: the user should see Buddy is still busy.
export function deriveMood(state) {
  // A reply being stopped no longer counts: Buddy goes idle at once.
  if (Object.values(state.inflight).some((f) => !f.stopping)) return 'thinking';
  if (unreadCount(state)) return 'happy';
  return 'idle';
}

export function unreadTitle(n) {
  return n > 0 ? `(${n}) Buddy replied` : null;
}

// ── transport ──────────────────────────────────────────────────────
// Feed raw SSE text; returns [events, rest]. Events are the JSON after `data:`.
export function parseSse(buffer) {
  const lines = buffer.split('\n');
  const rest = lines.pop() ?? '';
  const events = [];
  for (const line of lines) {
    const s = line.trim();
    if (!s.startsWith('data:')) continue;
    const payload = s.slice(5).trim();
    if (!payload) continue;
    try { events.push(JSON.parse(payload)); } catch { /* partial or junk line */ }
  }
  return [events, rest];
}

// A refusal (JSON + status) → what Buddy says, and whether it's the role gate.
export function friendlyError(status, serverMsg = '') {
  const msg = String(serverMsg || '');
  switch (status) {
    case 400:
      if (/too long/i.test(msg)) return { text: "That's a bit long for me. Could you shorten it and ask again?" };
      return { text: "I couldn't read that message. Please try again." };
    case 401:
      return { text: 'Your session has expired. Please sign in again.' };
    case 403:
      return { text: 'Buddy is coming to your role soon.', denied: true };
    case 404:
      return { text: "I couldn't find that conversation. Start a new chat and ask again." };
    case 409:
      // Regenerate refused: not the last reply, something still generating, or a race.
      return { text: 'Buddy is already working on this.', conflict: true };
    case 429:
      return { text: 'Buddy needs a short break, try again in a minute 🐾' };
    case 503:
      return { text: 'Buddy is switched off by an admin right now. Please try again later.' };
    default:
      return { text: 'Something went wrong. Please try again.' };
  }
}

// ── picking up a reply after the stream dropped ────────────────────
// The assistant row that answers `userText`: the first assistant message after
// the LAST user message with that text. Order-based, so client/server clock
// skew doesn't matter.
export function findReply(messages, userText) {
  const want = String(userText || '').trim();
  let u = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'user' && String(messages[i].content || '').trim() === want) { u = i; break; }
  }
  if (u < 0) return null;
  for (let i = u + 1; i < messages.length; i++) if (messages[i].role === 'assistant') return messages[i];
  return null;
}

// No status column (older backend) means the row only exists once finished.
export const isFinal = (m) => !!m && (m.status == null || m.status === 'done' || m.status === 'error');

// An ai_messages row → a thread message. A reply the user stopped is saved as
// status 'error' + meta.cancelled (mig 386): shown as "Stopped", not an error.
// A timed-out or stale row (meta.stale) keeps its error.
export const rowToMessage = (r) => ({
  id: r.id, role: r.role, content: r.content || '', created_at: r.created_at,
  status: r.status ?? null,
  sources: r.meta?.sources || [],
  requestId: r.meta?.requestId || null,
  stopped: r.meta?.cancelled === true,
  // Replaced by a Regenerate: status 'superseded' or meta.superseded_by (both
  // handled until the backend contract is final).
  superseded: r.status === 'superseded' || !!r.meta?.superseded_by,
  supersedes: r.meta?.supersedes || null,   // the answer this one replaced (mig 389)
  ...answeredBy(r.meta),
  error: r.status === 'error' && r.meta?.cancelled !== true ? (r.meta?.error || 'Buddy hit a problem with this answer.') : null,
});

// Which model and key wrote a reply (mig 397: meta.model, key_slot, fallback_used).
export function answeredBy(meta) {
  return {
    model: meta?.model || null,
    keySlot: meta?.key_slot || null,
    fallbackUsed: meta?.fallback_used || null,
  };
}

// The server regenerates only a saved last reply that is done or error (mig 389).
export const canRegenerateMsg = (m) => !!m && m.role === 'assistant' && !!m.id && !m.pending
  && (m.status == null || m.status === 'done' || m.status === 'error');

// What the chat shows: superseded answers are hidden.
export const visibleMessages = (messages) => messages.filter((m) => !m.superseded);

// A reply row still `generating` after this long is lost (Lead, 2026-09-30):
// the UI offers Retry instead of waiting on it. `now` should be the server's
// clock (serverNow): created_at is server time.
export const STUCK_MS = 3 * 60000;
export const isStuck = (m, now = Date.now()) =>
  !!m && m.status === 'generating' && now - ms(m.created_at) > STUCK_MS;

// Server clock minus ours, from {started}.server_now. 0 (trust our clock)
// when it's missing or absurd; a round trip's worth is noise, so ignore < 2 s.
export function clockSkew(serverNowIso, receivedAtMs = Date.now()) {
  const s = ms(serverNowIso);
  if (!s) return 0;
  const d = s - receivedAtMs;
  return Math.abs(d) < 2000 || Math.abs(d) > 7 * 86400000 ? 0 : d;
}

// The question an assistant message answered: the nearest user turn before it.
export function questionBefore(messages, idx) {
  for (let i = idx - 1; i >= 0; i--) if (messages[i].role === 'user') return messages[i].content;
  return null;
}

// Poll + Realtime until pick(messages) is final. Resolves { messages, reply };
// rejects on timeout or cancel. Deps are injected so tests can fake them.
export function watchReply({ fetchMessages, subscribe, pick, onTick, pollMs = 4000, timeoutMs = 240000, addOnline }) {
  let stopped = false;
  let timer = null;
  let unsub = () => {};
  let offOnline = () => {};
  let busy = false;
  let again = false;
  const cleanup = () => {
    stopped = true;
    clearInterval(timer);
    clearTimeout(deadline);
    try { unsub(); } catch { /* ignore */ }
    try { offOnline(); } catch { /* ignore */ }
  };
  let deadline;
  let rejectFn = () => {};
  const promise = new Promise((resolve, reject) => {
    rejectFn = reject;
    const check = async () => {
      if (stopped) return;
      if (busy) { again = true; return; }
      busy = true;
      try {
        const messages = await fetchMessages();
        if (stopped) return;
        const reply = pick(messages);
        onTick?.(messages, reply);
        if (reply && isFinal(reply)) { cleanup(); resolve({ messages, reply }); }
      } catch { /* flaky network: the next tick retries */ }
      finally {
        busy = false;
        if (again && !stopped) { again = false; check(); }
      }
    };
    deadline = setTimeout(() => { cleanup(); reject(new Error('timeout')); }, timeoutMs);
    timer = setInterval(check, pollMs);
    try { unsub = subscribe?.(check) || (() => {}); } catch { /* Realtime unavailable: polling covers it */ }
    offOnline = addOnline?.(check) || (() => {});
    check();
  });
  promise.cancel = () => { if (!stopped) { cleanup(); rejectFn(new Error('cancelled')); } };
  return promise;
}

// ── history ────────────────────────────────────────────────────────
export function groupConversations(convs, now = new Date()) {
  const start = new Date(now); start.setHours(0, 0, 0, 0);
  const today = start.getTime();
  const yesterday = today - 86400000;
  const week = today - 6 * 86400000;
  const groups = { Pinned: [], Today: [], Yesterday: [], 'Last 7 days': [], Older: [] };
  for (const c of convs) {
    const t = ms(c.last_reply_at) || ms(c.updated_at) || ms(c.created_at);
    if (c.pinned) groups.Pinned.push(c);
    else if (t >= today) groups.Today.push(c);
    else if (t >= yesterday) groups.Yesterday.push(c);
    else if (t >= week) groups['Last 7 days'].push(c);
    else groups.Older.push(c);
  }
  return Object.entries(groups).filter(([, list]) => list.length).map(([label, items]) => ({ label, items }));
}

export function autoTitle(text) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  return t.length > 60 ? t.slice(0, 57) + '…' : t || 'New chat';
}

// ── page awareness ─────────────────────────────────────────────────
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Sent with each question as a hint for the prompt. Never trusted for access.
export function pageContextFor(pathname, search = '') {
  const ctx = { route: String(pathname).slice(0, 200) };
  const brand = pathname.match(/^\/brands\/([^/]+)/);
  if (brand && UUID.test(brand[1])) ctx.brand_id = brand[1];
  const q = new URLSearchParams(search);
  for (const [k, out] of [['report', 'report_id'], ['reportId', 'report_id'], ['kb', 'kb_id'], ['article', 'kb_id']]) {
    const v = q.get(k);
    if (v && UUID.test(v)) ctx[out] = v;
  }
  return ctx;
}

const PAGE_CHIPS = [
  [/^\/leave/, ['How do I apply for leave?', 'How many leave days do I have left?']],
  [/^\/attendance/, ['How does attendance work?', 'What happens if I clock in late?']],
  [/^\/(weekly|biweekly|monthly)-reports/, ['How do I submit my weekly report?', 'What makes a great report?']],
  [/^\/gmv-max/, ['How does GMV Max reporting work?']],
  [/^\/incentives/, ['How are incentives calculated?', "What's my incentive this month?"]],
  [/^\/performance/, ['How is my performance score calculated?']],
  [/^\/me\/compensation/, ['How is my salary paid?']],
  [/^\/kb/, ['Find the SOP for sample requests']],
  [/^\/tasks/, ['How do I assign a task?']],
  [/^\/agenda/, ['How do the weekly agenda meetings work?']],
  [/^\/analytics\/brands/, ['Top brands by GMV this month']],
  [/^\/brands\/?$/, ['Which brands need attention this week?']],
  [/^\/creator-library/, ['How do I add a creator to the library?']],
  [/^\/video-reviews/, ['How do video reviews work?']],
];

export function pageChips(pathname, brandName) {
  if (/^\/brands\/[^/]+/.test(pathname)) {
    const name = brandName || 'this brand';
    return ["Summarise this brand's latest report", `How is ${name} doing this month?`];
  }
  for (const [re, chips] of PAGE_CHIPS) if (re.test(pathname)) return [...chips, 'How do I use this page?'];
  return ['How do I use this page?', 'What can you help me with?'];
}

const STARTERS = {
  boss: ['Top brands by GMV this month', 'Which reports are still awaiting approval?', 'Summarise last week across all brands', 'Which brands dropped vs last month?'],
  ol: ['Which brands need attention this week?', "Which of my team's reports are pending?", 'Compare my brands month over month', 'How do I approve a report?'],
  tl: ["Which of my team's reports are pending?", "How is my team's GMV this month?", 'How do I review an APC report?', 'Coaching tips for a low-GMV week'],
  pctl: ['How do paid collabs work end to end?', 'How do I manage my IPCs?', 'Which campaigns are running now?', 'How do I apply for leave?'],
  apc: ['How do I submit my weekly report?', 'How do I approve sample requests?', "How are my brands doing this month?", 'How is my incentive calculated?'],
  ipc: ['How do I add a creator to the library?', 'How do I track my campaigns?', 'How is my incentive calculated?', 'How do I apply for leave?'],
  ads_manager: ['How does GMV Max reporting work?', 'How are my brands doing this month?', 'Tips to improve ROAS on TikTok Shop', 'How do I apply for leave?'],
  developer: ['How does the ingestion pipeline work?', 'How do I triage a bug report?', 'How do I apply for leave?', 'What can you help me with?'],
};
export const starterCards = (role) => STARTERS[role] || STARTERS.apc;

// Buddy's own greeting, used when the Boss hasn't written one (or it is still
// the v1 default, which calls itself the "WurxOS assistant").
export const BUDDY_GREETING = "Hi {name}! I'm Wurx Buddy: here to help, explore and grow.";

export const greetingIsDefault = (t) => !String(t || '').trim() || /wurxos assistant/i.test(String(t));

export function greetingText(template, name) {
  const use = greetingIsDefault(template) ? BUDDY_GREETING : String(template).trim();
  // With no name, "Hi {name}!" → "Hi!".
  return use.replace(/\{name\}/g, name || '').replace(/\s+([!,.?])/g, '$1').replace(/ {2,}/g, ' ').trim();
}

export function firstName(profile) {
  const n = String(profile?.display_name || profile?.full_name || '').trim();
  return n ? n.split(/\s+/)[0] : '';
}

// ── usage (Boss) ───────────────────────────────────────────────────
// USD: 2 decimals, 4 under $1 so a few cents of tokens still read.
export function fmtUsd(n) {
  if (n == null || !Number.isFinite(Number(n))) return '—';
  const v = Number(n);
  const d = v !== 0 && Math.abs(v) < 1 ? 4 : 2;
  return `${v < 0 ? '-' : ''}$${Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d })}`;
}

export const fmtCount = (n) => (n == null || !Number.isFinite(Number(n)) ? '—' : Math.round(Number(n)).toLocaleString('en-US'));

export function fmtMs(n) {
  if (n == null || !Number.isFinite(Number(n))) return '—';
  return n >= 1000 ? `${(n / 1000).toFixed(1)} s` : `${Math.round(n)} ms`;
}

export const fmtPct = (n) => (n == null || !Number.isFinite(Number(n)) ? '—' : `${Math.round(Number(n))}%`);

// Today in Pakistan time (the app's timezone), as YYYY-MM-DD.
export const pktDate = (now = new Date()) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Karachi', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);

const addDays = (ymd, n) => {
  const d = new Date(`${ymd}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

// Range presets → { from, to } (inclusive PKT dates) for ai_usage_summary.
export function usageRange(preset, now = new Date()) {
  const to = pktDate(now);
  if (preset === '7d') return { from: addDays(to, -6), to };
  if (preset === 'month') return { from: `${to.slice(0, 8)}01`, to };
  return { from: addDays(to, -29), to };
}

export const USAGE_KIND_LABEL = {
  chat: 'Chat (answers)',
  rerank: 'Search rerank',
  embeddings_query: 'Query embeddings',
  embeddings_ingest: 'Ingestion embeddings',
};

// ── models (Boss, mig 397) ─────────────────────────────────────────
export const KEY_SLOT_LABEL = { primary: 'Main key (paid)', fallback: 'Fallback key (free)' };
export const KEY_SLOT_SHORT = { primary: 'main key', fallback: 'backup' };

// The three built-ins keep their friendly labels, and are what the picker
// offers when the catalog is empty (the database accepts only these then).
export const BUILTIN_MODELS = [
  ['gpt-5.4-nano', 'cheapest'],
  ['gpt-5.4-mini', 'recommended'],
  ['gpt-5.5', 'strongest'],
];
const BUILTIN = new Map(BUILTIN_MODELS);
export const modelLabel = (model) => (BUILTIN.has(model) ? `${model} (${BUILTIN.get(model)})` : model);

export const isQuotaError = (e) => /quota|credit/i.test(String(e || ''));

// Mirrors public.ai_model_usable for one catalog row: works with tools and
// streaming, or a built-in on the main key that failed only for lack of credits
// (it works again the moment the account is topped up).
export const catalogRowUsable = (r) => !!r && (
  (r.available && r.supports_tools && r.supports_stream)
  || (r.key_slot === 'primary' && BUILTIN.has(r.model) && isQuotaError(r.last_error)));

function unusableReason(r) {
  if (!r.available) return r.last_error || 'not available on this key';
  if (!r.supports_tools) return 'no tool calling (Buddy needs it to look things up)';
  if (!r.supports_stream) return 'no streaming';
  return '';
}

export function modelBadges(r) {
  const b = [];
  if (r.free) b.push('Free');
  if (r.supports_tools) b.push('Tools ✓');
  if (r.supports_stream) b.push('Streaming ✓');
  if (r.key_slot === 'primary' && isQuotaError(r.last_error)) b.push('Needs credits');
  if (!catalogRowUsable(r)) b.push('Not usable');
  return b;
}

// Picker options per key: { primary: [...], fallback: [...] }, each
// { key_slot, model, label, usable, reason, badges }. Usable first, then the
// built-ins, then A–Z. A key with no catalog rows offers nothing, except the
// main key, which falls back to the three built-ins.
export function modelOptions(catalog) {
  const rows = Array.isArray(catalog) ? catalog : [];
  const out = { primary: [], fallback: [] };
  for (const slot of ['primary', 'fallback']) {
    const mine = rows.filter((r) => r.key_slot === slot);
    const list = mine.length || slot !== 'primary'
      ? mine
      : BUILTIN_MODELS.map(([model]) => ({ key_slot: 'primary', model, available: true, supports_tools: true, supports_stream: true, free: false, builtinOnly: true }));
    out[slot] = list.map((r) => {
      const usable = r.builtinOnly || catalogRowUsable(r);
      return {
        key_slot: slot, model: r.model, label: modelLabel(r.model), usable,
        reason: usable ? '' : unusableReason(r),
        badges: r.builtinOnly ? [] : modelBadges(r),
      };
    }).sort((a, b) => (b.usable - a.usable) || (BUILTIN.has(b.model) - BUILTIN.has(a.model)) || a.model.localeCompare(b.model));
  }
  return out;
}

export const optionKey = (slot, model) => `${slot}|${model}`;
export const parseOptionKey = (k) => {
  const i = String(k).indexOf('|');
  return i < 0 ? null : { key_slot: String(k).slice(0, i), model: String(k).slice(i + 1) };
};

// The main key is out of credits: from the last refresh, or (after a reload)
// from the catalog: main-key rows exist, none answer, and some failed on quota.
export function creditsExhausted(catalog, refresh) {
  const flag = refresh?.slots?.primary?.credits_exhausted;
  if (typeof flag === 'boolean') return flag;
  const rows = (catalog || []).filter((r) => r.key_slot === 'primary');
  return rows.length > 0 && !rows.some((r) => r.available) && rows.some((r) => isQuotaError(r.last_error));
}

export function lastChecked(catalog) {
  let best = 0;
  for (const r of catalog || []) best = Math.max(best, ms(r.checked_at));
  return best ? new Date(best).toISOString() : null;
}

// Fallback chain edits: ordered, no duplicates, at most 5.
export const FALLBACK_MAX = 5;
const sameTarget = (a, b) => a.key_slot === b.key_slot && a.model === b.model;
export function chainAdd(chain, item) {
  const c = Array.isArray(chain) ? chain : [];
  if (!item?.model || c.length >= FALLBACK_MAX || c.some((x) => sameTarget(x, item))) return c;
  return [...c, { key_slot: item.key_slot === 'primary' ? 'primary' : 'fallback', model: item.model }];
}
export const chainRemove = (chain, i) => chain.filter((_, j) => j !== i);
export function chainMove(chain, i, dir) {
  const j = i + dir;
  if (i < 0 || i >= chain.length || j < 0 || j >= chain.length) return chain;
  const c = chain.slice();
  [c[i], c[j]] = [c[j], c[i]];
  return c;
}

// ── sources ────────────────────────────────────────────────────────
const SOURCE_LABEL = {
  kb_article: 'SOP', ai_doc: 'Guide', app_guide: 'App guide', tts_article: 'TikTok Academy',
  report: 'Report', incentive: 'Incentive',
};
export const sourceLabel = (t) => SOURCE_LABEL[t] || 'Data';

// In-app ('/…') → router; http(s) → new tab; anything else → not a link.
export function sourceLink(s) {
  const u = String(s?.url || '');
  if (u.startsWith('/') && !u.startsWith('//')) return { kind: 'app', to: u };
  if (/^https?:\/\//i.test(u)) return { kind: 'ext', href: u };
  return null;
}

// Cited first, then the rest, each keeping the server's order. Numbered 1..n.
export function orderSources(sources) {
  const list = Array.isArray(sources) ? sources : [];
  return [...list.filter((s) => s.cited !== false), ...list.filter((s) => s.cited === false)]
    .map((s, i) => ({ ...s, n: i + 1 }));
}

const CITE_RE = /\[((?:[SD]\d{1,3})(?:\s*[,;]\s*[SD]\d{1,3})*)\]/g;
// A tag, with quoted attribute values allowed to contain '>'.
const TAG_RE = /<(?:[^>"']|"[^"]*"|'[^']*')*>/g;

// Replace [S1] / [D1, S2] markers in ALREADY-SANITISED html with numbered
// buttons, in text only: a marker inside an attribute (a link URL) is left
// alone. Only the ids the regex matched are emitted, so nothing unsafe gets in.
export function citeHtml(html, sources) {
  const num = new Map(orderSources(sources).map((s) => [s.id, s.n]));
  const cite = (text) => text.replace(CITE_RE, (_m, group) => group.split(/[,;]/).map((raw) => {
    const id = raw.trim();
    const n = num.get(id);
    return `<button type="button" class="bd-cite" data-cite="${id}" aria-label="Source ${n ?? id}">${n ?? id}</button>`;
  }).join(''));
  const s = String(html);
  let out = '';
  let last = 0;
  for (const m of s.matchAll(TAG_RE)) {
    out += cite(s.slice(last, m.index)) + m[0];
    last = m.index + m[0].length;
  }
  return out + cite(s.slice(last));
}
