import { createContext, useCallback, useContext, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { useAuth } from './AuthContext';
import {
  buddyRoles, TMP_PREFIX, isTmpKey, buddyReducer, initialBuddyState, deriveMood, unreadCount,
  unreadTitle, friendlyError, findReply, watchReply, isStuck, STUCK_MS, greetingText, firstName, serverUnread,
  clockSkew, questionBefore, canRegenerateMsg,
} from '../lib/buddyLogic';
import {
  BuddyHttpError, streamAssistant, listConversations, getMessages, getMessageById, findGenerating, subscribeMessages,
  subscribeConversations, markConversationRead, renameConversation, pinConversation, deleteConversation,
  sendFeedback, getBuddyConfig, cancelReply,
} from '../lib/buddyApi';

// Wurx Buddy's one store (ui-design.md §6). The floating panel and the /buddy
// tab are only views of it, so minimising, closing or navigating never cancels
// a reply. A dropped stream is picked up from the database (Realtime, with
// polling underneath) — most users are on flaky ISPs.

const BuddyCtx = createContext(null);
export const useBuddy = () => useContext(BuddyCtx);

const ms = (iso) => (iso ? new Date(iso).getTime() || 0 : 0);

export function BuddyProvider({ children }) {
  const { user, profile } = useAuth();
  const uid = user?.id || null;
  const role = profile?.role || null;
  // { greeting, allowedRoles } from ai_assistant_config; undefined while loading.
  const [cfg, setCfg] = useState(undefined);
  useEffect(() => {
    if (!uid) { setCfg(undefined); return undefined; }
    let cancelled = false;
    getBuddyConfig().then((c) => { if (!cancelled) setCfg(c); });
    return () => { cancelled = true; };
  }, [uid]);
  const gateReady = !!uid && cfg !== undefined;
  // The UI gate mirrors the function's allowed_roles; BUDDY_ROLES (boss) if the read failed.
  const allowed = gateReady && buddyRoles(cfg.allowedRoles).includes(role);

  const [state, dispatch] = useReducer(buddyReducer, initialBuddyState);
  const stateRef = useRef(state);
  stateRef.current = state;
  const [pageActive, setPageActive] = useState(false);
  const greetingTpl = cfg?.greeting || '';
  const pageActiveRef = useRef(false);
  pageActiveRef.current = pageActive;

  const gen = useRef(0);        // bumps when the provider resets; ends pending loops
  const ctrls = useRef({});     // key → AbortController of the live stream
  const watchers = useRef({});  // key → watchReply promise (has .cancel)
  const tmpSeq = useRef(0);
  // Server clock minus ours ({started}.server_now): rows' created_at is server
  // time, so "stuck" is judged on the server's clock. 0 until we hear otherwise.
  const skew = useRef(0);
  const serverNow = useCallback(() => Date.now() + skew.current, []);

  // Seen = on screen in a visible browser tab, in the panel or the Buddy tab.
  const isViewed = useCallback((key) => {
    if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return false;
    const s = stateRef.current;
    return (s.panel === 'open' && s.quickKey === key) || (pageActiveRef.current && s.pageKey === key);
  }, []);

  const markRead = useCallback((id) => {
    const conv = stateRef.current.convs.find((c) => c.id === id);
    const at = Math.max(Date.now(), ms(conv?.last_reply_at) + 1);
    dispatch({ type: 'MARK_READ', id, at });
    markConversationRead(id, new Date(at).toISOString());
  }, []);

  const refreshConvs = useCallback(async () => {
    if (!allowed) return [];
    try {
      const convs = await listConversations(uid);
      dispatch({ type: 'CONVS_LOADED', convs });
      // A stopped reply that landed anyway: settle it as read (no badge, here or on other devices).
      const s = stateRef.current;
      for (const c of convs) {
        if (s.stopped?.[c.id] && serverUnread(c, s.readAt[c.id])) markRead(c.id);
      }
      return convs;
    } catch (e) {
      dispatch({ type: 'CONVS_ERROR', error: e?.message });
      return stateRef.current.convs;
    }
  }, [allowed, uid, markRead]);

  const resumeRef = useRef(null);  // resumeRow, defined below
  const loadThread = useCallback(async (key, force = false) => {
    if (!key || isTmpKey(key)) return;
    const t = stateRef.current.threads[key];
    if (t?.loaded && !force) return;
    try {
      const messages = await getMessages(key);
      dispatch({ type: 'THREAD_LOADED', key, messages });
      const row = [...messages].reverse().find((m) => m.role === 'assistant');
      if (row?.status === 'generating') resumeRef.current?.(key, row);
    } catch (e) {
      // Shown with Retry when nothing is on screen yet.
      dispatch({ type: 'THREAD_ERROR', key, error: e?.message });
    }
  }, []);

  // Follow a reply in the database until it is done or error. `messageId`
  // narrows Realtime to that row; `timeoutMs` ends it as lost (STUCK_MS).
  const startWatch = useCallback((key, pick, { messageId, timeoutMs = STUCK_MS + 15000 } = {}) => {
    watchers.current[key]?.cancel?.();
    const w = watchReply({
      fetchMessages: () => getMessages(key),
      subscribe: (cb) => subscribeMessages({ conversationId: key, messageId }, cb),
      pick,
      timeoutMs,
      onTick: (messages, reply) => {
        if (!reply) return;
        dispatch({ type: 'RECOVER_TICK', key, messages });
        if (reply.id) dispatch({ type: 'MSG_ID', key, messageId: reply.id });
      },
      addOnline: (cb) => {
        const f = () => { if (document.visibilityState === 'visible') cb(); };
        window.addEventListener('online', f);
        document.addEventListener('visibilitychange', f);
        return () => { window.removeEventListener('online', f); document.removeEventListener('visibilitychange', f); };
      },
    });
    watchers.current[key] = w;
    w.then(({ messages }) => {
      const viewed = isViewed(key);
      dispatch({ type: 'RECOVERED', key, messages, viewed });
      if (viewed) markRead(key);
      refreshConvs();
    }).catch((e) => {
      if (e?.message === 'cancelled') return;
      dispatch({ type: 'FAILED', key, error: 'Buddy lost this reply.' });
    }).finally(() => { if (watchers.current[key] === w) delete watchers.current[key]; });
  }, [isViewed, markRead, refreshConvs]);

  // The server created the conversation but the stream died before telling
  // us its id: it is the newest one titled with this question.
  // Ends early (null) once the provider resets: `gen` moves on unmount / sign-out.
  const findNewConversation = useCallback(async (text, startedAt) => {
    const title = text.slice(0, 60);
    const since = ms(startedAt) - 5 * 60000;
    const mine = gen.current;
    for (let i = 0; i < 6; i++) {
      if (gen.current !== mine) return null;
      const convs = await refreshConvs();
      if (gen.current !== mine) return null;
      const hit = convs.filter((c) => c.title === title && ms(c.created_at) >= since)
        .sort((a, b) => ms(b.created_at) - ms(a.created_at))[0];
      if (hit) return hit.id;
      await new Promise((r) => setTimeout(r, 5000));
    }
    return null;
  }, [refreshConvs]);

  const recover = useCallback(async (key, text, startedAt, messageId) => {
    dispatch({ type: 'RECOVERING', key, status: 'Connection dropped. Buddy is still working on it…' });
    if (messageId && !isTmpKey(key)) {
      startWatch(key, (msgs) => msgs.find((m) => m.id === messageId) || null, { messageId });
      return;
    }
    let k = key;
    if (isTmpKey(k)) {
      const id = await findNewConversation(text, startedAt);
      if (!stateRef.current.inflight[k]) return;          // stopped meanwhile
      if (!id) {
        dispatch({ type: 'FAILED', key: k, error: 'The connection dropped before Buddy could start. Please try again.' });
        return;
      }
      dispatch({ type: 'CONV_ID', from: k, to: id });
      k = id;
    }
    startWatch(k, (msgs) => findReply(msgs, text));
  }, [findNewConversation, startWatch]);

  // `regenerate` (a reply's messageId, existing conversation only) replaces
  // that answer in place instead of adding the question again.
  const send = useCallback(async ({ key, text, surface = 'quick', pageContext, regenerate }) => {
    const msg = String(text || '').trim();
    if (!msg || !allowed) return null;
    let k = key || `${TMP_PREFIX}${++tmpSeq.current}`;
    if (stateRef.current.inflight[k]) return k;
    const startedAt = new Date().toISOString();
    const regen = regenerate && !isTmpKey(k)
      && stateRef.current.threads[k]?.messages.some((m) => m.role === 'assistant' && m.id === regenerate) ? regenerate : null;
    dispatch(regen
      ? { type: 'REGEN_START', key: k, messageId: regen, text: msg, at: startedAt }
      : { type: 'SEND_START', key: k, text: msg, at: startedAt });
    if (surface === 'quick') dispatch({ type: 'QUICK_KEY', key: k });
    else dispatch({ type: 'PAGE_KEY', key: k });

    const ctrl = new AbortController();
    ctrls.current[k] = ctrl;
    let requestId = null;
    let messageId = null;
    let doneStatus = null;
    let cancelled = false;
    let streamErr = null;
    let settled = false;
    const adopt = (id) => {
      if (!id || id === k || !isTmpKey(k)) return;
      dispatch({ type: 'CONV_ID', from: k, to: id });
      ctrls.current[id] = ctrl;
      delete ctrls.current[k];
      k = id;
    };
    try {
      const r = await streamAssistant({
        conversationId: isTmpKey(k) ? null : k, message: msg, regenerate: regen, surface, pageContext, signal: ctrl.signal,
        onEvent: (ev) => {
          // {started} carries the ids (and the server clock) first; {done} repeats them.
          if (ev.started && ev.server_now) skew.current = clockSkew(ev.server_now);
          if (ev.conversationId) adopt(ev.conversationId);
          if (ev.requestId) requestId = ev.requestId;
          if (ev.messageId && ev.messageId !== messageId) {
            messageId = ev.messageId;
            dispatch({ type: 'MSG_ID', key: k, messageId });
          }
          if (ev.done && ev.status) doneStatus = ev.status;
          if (ev.cancelled) cancelled = true;
          if (ev.status && !ev.done) dispatch({ type: 'STATUS', key: k, status: ev.status });
          if (typeof ev.delta === 'string') dispatch({ type: 'DELTA', key: k, delta: ev.delta });
          if (Array.isArray(ev.sources)) dispatch({ type: 'SOURCES', key: k, sources: ev.sources });
          if (ev.error) streamErr = ev.error;
        },
      });
      if (r.done) {
        const viewed = isViewed(k);
        dispatch({ type: 'DONE', key: k, requestId, messageId, status: doneStatus, error: streamErr, cancelled, viewed });
        if (viewed && !isTmpKey(k)) markRead(k);
        settled = true;
        // {done} doesn't say which model answered; the saved row does (mig 397).
        if (messageId) {
          const doneKey = k;
          getMessageById(messageId)
            .then((row) => {
              if (row) dispatch({ type: 'MSG_META', key: doneKey, id: messageId, meta: { model: row.model, keySlot: row.keySlot, fallbackUsed: row.fallbackUsed } });
            })
            .catch(() => { /* only a label */ });
        }
      }
    } catch (e) {
      // 'stop' = the user's Stop; 'reset' = signed out / provider unmounted.
      if (ctrl.signal.aborted && (ctrl.signal.reason === 'stop' || ctrl.signal.reason === 'reset')) return k;
      else if (e instanceof BuddyHttpError) {
        const f = friendlyError(e.status, e.message);
        // Every refusal comes before the turn starts: a refused Regenerate changed nothing.
        dispatch({ type: 'FAILED', key: k, error: f.text, denied: f.denied, refused: !!regen });
        settled = true;
        // 409: the chat moved on (another tab, a reply still generating): show what's there now.
        if (f.conflict) setTimeout(() => loadThread(k, true), 0);
      }
      // anything else is a dropped connection → recover below
    } finally {
      delete ctrls.current[k];
    }
    if (!settled) recover(k, msg, startedAt, messageId);
    else refreshConvs();
    return k;
  }, [allowed, isViewed, markRead, recover, refreshConvs, loadThread]);

  // A reply row still generating that nobody here is streaming (a reload,
  // another tab): follow it to the end, or show it as lost once stuck.
  const resumeRow = useCallback((key, row) => {
    if (stateRef.current.inflight[key] || row.status !== 'generating' || isStuck(row, serverNow())) return;
    dispatch({ type: 'RESUME', key, at: new Date().toISOString(), messageId: row.id });
    const age = serverNow() - ms(row.created_at);
    startWatch(key, (msgs) => msgs.find((m) => m.id === row.id) || null,
      { messageId: row.id, timeoutMs: Math.max(15000, STUCK_MS - age + 15000) });
  }, [startWatch, serverNow]);
  resumeRef.current = resumeRow;

  // Retry a lost / failed reply: ask its question again.
  const retry = useCallback((key, text, surface) => {
    if (text) send({ key, text, surface });
  }, [send]);

  // Stop pressed before {started}: the fetch is gone, but the server may have
  // created the reply row. Find it (as recovery does) and cancel it.
  const cancelWhenFound = useCallback(async (key, text, startedAt) => {
    if (!text) return;
    const mine = gen.current;
    const convId = isTmpKey(key) ? await findNewConversation(text, startedAt) : key;
    if (convId && convId !== key && gen.current === mine && stateRef.current.threads[key]) {
      // The stopped chat now has a real id: move it there so history opens
      // the same view (and the chat stays read).
      dispatch({ type: 'CONV_ID', from: key, to: convId });
      markRead(convId);
    }
    for (let i = 0; i < 8 && convId && gen.current === mine; i++) {
      try {
        const reply = findReply(await getMessages(convId), text);
        if (reply) {
          if (reply.status === 'generating') await cancelReply(reply.id).catch(() => {});
          return;
        }
      } catch { /* flaky network: try again */ }
      await new Promise((r) => setTimeout(r, 2500));
    }
  }, [findNewConversation, markRead]);

  // Server-side Stop (mig 386). With the reply row's id: send the cancel and
  // keep reading the stream (or the watcher) to its done, which arrives as
  // {done, status:'error', cancelled:true} with the partial text. Before
  // {started}: abort the fetch and cancel the row once found. Either way the
  // conversation is read: a stopped reply gives no badge and no happy Buddy.
  const stop = useCallback((key) => {
    const inf = stateRef.current.inflight[key];
    if (!inf) return;
    if (!isTmpKey(key)) markRead(key);
    const hardStop = () => {
      ctrls.current[key]?.abort('stop');
      watchers.current[key]?.cancel?.();
      dispatch({ type: 'STOPPED', key });
    };
    if (inf.messageId) {
      if (inf.stopping) return;
      dispatch({ type: 'STOPPING', key });
      // Unreachable server: at least stop showing it.
      cancelReply(inf.messageId).catch(hardStop);
      return;
    }
    hardStop();
    cancelWhenFound(key, inf.text, inf.startedAt);
  }, [markRead, cancelWhenFound]);

  // Regenerate the last answer in place (server `regenerate`). Without the
  // answer's row id (not saved yet), fall back to asking the question again.
  const regenerate = useCallback((key, surface) => {
    const msgs = stateRef.current.threads[key]?.messages || [];
    const idx = msgs.map((m) => m.role).lastIndexOf('assistant');
    const question = idx >= 0 ? questionBefore(msgs, idx) : [...msgs].reverse().find((m) => m.role === 'user')?.content;
    if (!question) return;
    send({ key, text: question, surface, regenerate: idx >= 0 && canRegenerateMsg(msgs[idx]) ? msgs[idx].id : null });
  }, [send]);

  // ── lifecycle ────────────────────────────────────────────────────
  useEffect(() => {
    if (!allowed) return undefined;
    let cancelled = false;
    (async () => {
      const convs = await refreshConvs();
      if (cancelled) return;
      // Replies still generating from before a reload: watch them to the end.
      const generating = await findGenerating(convs.slice(0, 40).map((c) => c.id));
      for (const g of generating) {
        if (cancelled) return;
        resumeRow(g.conversation_id, g);
      }
    })();
    let t = null;
    const off = subscribeConversations(uid, () => { clearTimeout(t); t = setTimeout(refreshConvs, 800); });
    return () => {
      cancelled = true;
      gen.current++;
      clearTimeout(t);
      off();
      for (const c of Object.values(ctrls.current)) c.abort('reset');
      for (const w of Object.values(watchers.current)) w.cancel?.();
      ctrls.current = {};
      watchers.current = {};
      dispatch({ type: 'RESET' });
    };
  }, [allowed, uid, refreshConvs, resumeRow]);

  // Whatever is on screen is read.
  useEffect(() => {
    const check = () => {
      if (document.visibilityState !== 'visible') return;
      const s = stateRef.current;
      for (const key of [s.panel === 'open' && s.quickKey, pageActiveRef.current && s.pageKey]) {
        if (key && !isTmpKey(key) && s.unread[key]) markRead(key);
      }
    };
    check();
    document.addEventListener('visibilitychange', check);
    return () => document.removeEventListener('visibilitychange', check);
  }, [state.panel, state.quickKey, state.pageKey, state.unread, pageActive, markRead]);

  // "(n) Buddy replied" in the browser tab while replies wait unseen.
  const nUnread = unreadCount(state);
  const baseTitle = useRef(null);
  useEffect(() => {
    const t = unreadTitle(nUnread);
    if (t) {
      if (baseTitle.current == null) baseTitle.current = document.title;
      document.title = t;
    } else if (baseTitle.current != null) {
      document.title = baseTitle.current;
      baseTitle.current = null;
    }
  }, [nUnread]);

  // ── panel ────────────────────────────────────────────────────────
  const openPanel = useCallback((key) => {
    const s = stateRef.current;
    let k = key !== undefined ? key : s.quickKey;
    // Nothing open yet but a reply is waiting: show that one.
    if (k == null) k = Object.keys(s.unread)[0] ?? null;
    dispatch({ type: 'PANEL', panel: 'open', quickKey: k });
    // An unread reply may have landed from another tab: refetch that thread.
    if (k) loadThread(k, !!s.unread[k]);
  }, [loadThread]);
  const minimise = useCallback(() => dispatch({ type: 'PANEL', panel: 'minimised' }), []);
  // Close forgets the panel's chat (the next open starts fresh); a reply
  // still generating carries on and shows up as unread.
  const closePanel = useCallback(() => dispatch({ type: 'PANEL', panel: 'closed', quickKey: null }), []);
  const togglePanel = useCallback(() => {
    if (stateRef.current.panel === 'open') minimise(); else openPanel();
  }, [minimise, openPanel]);
  const newQuickChat = useCallback(() => dispatch({ type: 'QUICK_KEY', key: null }), []);
  const selectPage = useCallback((key) => {
    dispatch({ type: 'PAGE_KEY', key });
    if (key) loadThread(key, !!stateRef.current.unread[key]);
  }, [loadThread]);

  // ── conversations ────────────────────────────────────────────────
  const rename = useCallback(async (id, title) => {
    const t = title.trim();
    if (!t) return;
    dispatch({ type: 'CONV_PATCH', id, patch: { title: t } });
    try { await renameConversation(id, t); } catch (e) { refreshConvs(); throw e; }
  }, [refreshConvs]);
  const pin = useCallback(async (id, pinned) => {
    dispatch({ type: 'CONV_PATCH', id, patch: { pinned } });
    try { await pinConversation(id, pinned); } catch (e) { dispatch({ type: 'CONV_PATCH', id, patch: { pinned: !pinned } }); throw e; }
  }, []);
  // Deleting mid-reply: cancel on the server and drop the stream now.
  const remove = useCallback(async (id) => {
    const inf = stateRef.current.inflight[id];
    if (inf?.messageId) cancelReply(inf.messageId).catch(() => {});
    ctrls.current[id]?.abort('stop');
    watchers.current[id]?.cancel?.();
    dispatch({ type: 'STOPPED', key: id });
    await deleteConversation(id);
    dispatch({ type: 'CONV_REMOVE', id });
  }, []);

  const greeting = greetingText(greetingTpl, firstName(profile));

  const value = useMemo(() => ({
    allowed, gateReady, role, profile, greeting,
    state,
    mood: deriveMood(state),
    unreadCount: nUnread,
    send, stop, regenerate, retry, loadThread, refreshConvs, markRead,
    openPanel, minimise, closePanel, togglePanel, newQuickChat, selectPage,
    setPageActive, rename, pin, remove, serverNow,
    feedback: sendFeedback,
  }), [allowed, gateReady, role, profile, greeting, state, nUnread, send, stop, regenerate, retry, loadThread, refreshConvs, markRead,
    openPanel, minimise, closePanel, togglePanel, newQuickChat, selectPage, rename, pin, remove, serverNow]);

  return <BuddyCtx.Provider value={value}>{children}</BuddyCtx.Provider>;
}
