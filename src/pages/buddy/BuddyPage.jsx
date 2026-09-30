import { Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { lazyWithRetry as lazy } from '../../lib/lazyWithRetry';
import { useBuddy } from '../../contexts/BuddyContext';
import { groupConversations, isTmpKey, orderSources, starterCards } from '../../lib/buddyLogic';
import { searchConversationIds } from '../../lib/buddyApi';
import BuddyMascot from '../../components/buddy/BuddyMascot';
import BuddyThread, { LoadError, SourceChip } from '../../components/buddy/BuddyThread';
import { ComingSoon } from '../../components/buddy/BuddyPanel';
import '../../styles/buddy.css';

// The Wurx Buddy tab (ui-design.md §4): history · chat · sources.
const BuddySettings = lazy(() => import('./BuddySettings'));

const SETTINGS_ROLES = ['boss', 'developer'];

export default function BuddyPage() {
  const buddy = useBuddy();
  const { state, role, greeting, selectPage, setPageActive, send } = buddy;
  const [params, setParams] = useSearchParams();
  const showSettings = params.get('view') === 'settings' && SETTINGS_ROLES.includes(role);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [sourcesOpen, setSourcesOpen] = useState(() => window.matchMedia?.('(min-width: 1200px)').matches ?? false);
  const [sourceSel, setSourceSel] = useState(null); // { msg, id }
  const key = state.pageKey;

  useEffect(() => {
    setPageActive(true);
    return () => setPageActive(false);
  }, [setPageActive]);

  // ?c=<id> opens that conversation (links, reloads); the URL follows the selection.
  const didInit = useRef(false);
  useEffect(() => {
    if (didInit.current) return;
    didInit.current = true;
    const c = params.get('c');
    if (c && c !== key) selectPage(c);
    else if (key) selectPage(key);
  }, [params, key, selectPage]);
  useEffect(() => {
    if (!didInit.current) return;
    const want = key && !isTmpKey(key) ? key : null;
    if ((params.get('c') || null) === want) return;
    const next = new URLSearchParams(params);
    if (want) next.set('c', want); else next.delete('c');
    setParams(next, { replace: true });
  }, [key, params, setParams]);
  useEffect(() => { setSourceSel(null); }, [key]);

  // Esc closes the phone drawer / sources sheet (the history drawer first).
  useEffect(() => {
    if (!historyOpen && !sourcesOpen) return undefined;
    const onKey = (e) => {
      if (e.key !== 'Escape') return;
      if (historyOpen) setHistoryOpen(false);
      else if (window.matchMedia?.('(max-width: 991px)').matches) setSourcesOpen(false);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [historyOpen, sourcesOpen]);

  const messages = (key && state.threads[key]?.messages) || [];
  const conv = key ? state.convs.find((c) => c.id === key) : null;
  const panelMsg = sourceSel?.msg
    || [...messages].reverse().find((m) => m.role === 'assistant' && (m.sources || []).length);
  const panelSources = orderSources(panelMsg?.sources).filter((s) => s.cited !== false);

  const openSettings = (on) => {
    const next = new URLSearchParams(params);
    if (on) next.set('view', 'settings'); else next.delete('view');
    setParams(next);
  };
  const onCite = (id, msg) => {
    setSourceSel({ msg, id });
    setSourcesOpen(true);
  };
  const pick = (id) => {
    selectPage(id);
    setHistoryOpen(false);
    if (showSettings) openSettings(false);
  };

  const empty = (
    <div className="bd-empty">
      <BuddyMascot clip="full" size={150} />
      <h2 className="bd-empty-title">{greeting}</h2>
      <p className="bd-empty-sub">Ask about our SOPs, your brands' approved reports, TikTok Shop, or how to do something in WurxOS.</p>
      <div className="bd-starters">
        {starterCards(role).map((q) => (
          <button key={q} type="button" className="bd-starter"
            onClick={() => send({ key: null, text: q, surface: 'full', pageContext: { route: '/buddy' } })}>
            <i className="bi bi-stars" aria-hidden="true" />{q}
          </button>
        ))}
      </div>
    </div>
  );

  return (
    <div className="bd-page">
      <History
        open={historyOpen}
        onClose={() => setHistoryOpen(false)}
        activeKey={key}
        onPick={pick}
        onNew={() => pick(null)}
        canSettings={SETTINGS_ROLES.includes(role)}
        onSettings={() => { openSettings(true); setHistoryOpen(false); }}
        settingsActive={showSettings}
      />
      {historyOpen && <div className="bd-scrim" onClick={() => setHistoryOpen(false)} aria-hidden="true" />}

      <section className="bd-main" aria-label="Chat">
        <header className="bd-main-head">
          <button type="button" className="bd-icon-btn d-lg-none" onClick={() => setHistoryOpen(true)} aria-label="Show chat history"><i className="bi bi-list" /></button>
          <BuddyMascot clip={state.inflight[key] ? 'thinking' : 'idle'} size={34} />
          <div className="bd-main-title text-truncate">
            {showSettings ? 'Buddy settings' : (conv?.title || (key ? 'Chat' : 'New chat'))}
          </div>
          {showSettings
            ? <button type="button" className="bd-pill" onClick={() => openSettings(false)}><i className="bi bi-arrow-left" /> Back to chat</button>
            : (
              <button type="button" className={`bd-pill ${sourcesOpen ? 'is-on' : ''}`} onClick={() => setSourcesOpen((v) => !v)}
                aria-expanded={sourcesOpen} aria-controls="bd-sources-panel">
                <i className="bi bi-journal-text" /> Sources{panelSources.length ? ` (${panelSources.length})` : ''}
              </button>
            )}
        </header>
        {showSettings
          ? <Suspense fallback={<div className="bd-center"><span className="wx-spinner" style={{ color: 'var(--accent)' }} /></div>}><BuddySettings role={role} /></Suspense>
          : state.denied
            ? <ComingSoon />
            : <BuddyThread convKey={key} surface="full" pageContext={{ route: '/buddy' }} empty={empty} onCite={onCite} activeSourceMsg={sourceSel?.msg} />}
      </section>

      {!showSettings && sourcesOpen && (
        <>
          <div className="bd-scrim is-sheet" onClick={() => setSourcesOpen(false)} aria-hidden="true" />
          <aside id="bd-sources-panel" className="bd-sources-panel" aria-label="Sources">
            <div className="bd-side-head">
              <span>Sources</span>
              <button type="button" className="bd-icon-btn" onClick={() => setSourcesOpen(false)} aria-label="Close sources"><i className="bi bi-x-lg" /></button>
            </div>
            {panelSources.length === 0
              ? <div className="bd-side-empty">Sources for Buddy's answers show up here. Tap a number in an answer to jump to it.</div>
              : panelSources.map((s) => (
                <div key={s.id} className={`bd-side-source ${sourceSel?.id === s.id ? 'is-active' : ''}`}
                  ref={(el) => { if (el && sourceSel?.id === s.id) el.scrollIntoView({ block: 'nearest' }); }}>
                  <SourceChip s={s} block />
                </div>
              ))}
          </aside>
        </>
      )}
    </div>
  );
}

function HistorySkeleton() {
  return (
    <div className="bd-skeleton-list" aria-hidden="true">
      <div className="bd-skel is-label" />
      {[70, 85, 60, 90, 75, 55].map((w, i) => <div key={i} className="bd-skel is-row" style={{ width: `${w}%` }} />)}
    </div>
  );
}

function History({ open, onClose, activeKey, onPick, onNew, canSettings, onSettings, settingsActive }) {
  const { state, rename, pin, remove, refreshConvs } = useBuddy();
  const [q, setQ] = useState('');
  const [hits, setHits] = useState(null);
  const [editing, setEditing] = useState(null); // { id, title }
  const [err, setErr] = useState('');

  useEffect(() => {
    const term = q.trim();
    if (!term) { setHits(null); return undefined; }
    const t = setTimeout(async () => {
      setHits(new Set(await searchConversationIds(state.convs.map((c) => c.id), term)));
    }, 350);
    return () => clearTimeout(t);
  }, [q, state.convs]);

  const groups = useMemo(() => {
    const term = q.trim().toLowerCase();
    const list = term
      ? state.convs.filter((c) => (c.title || '').toLowerCase().includes(term) || hits?.has(c.id))
      : state.convs;
    return groupConversations(list);
  }, [state.convs, q, hits]);

  const act = async (fn) => {
    setErr('');
    try { await fn(); } catch (e) { setErr(e.message || 'That did not work, please try again.'); }
  };

  return (
    <aside className={`bd-history ${open ? 'is-open' : ''}`} aria-label="Chat history">
      <div className="bd-history-top">
        <button type="button" className="bd-new" onClick={onNew}><i className="bi bi-plus-lg" /> New chat</button>
        <button type="button" className="bd-icon-btn d-lg-none" onClick={onClose} aria-label="Close history"><i className="bi bi-x-lg" /></button>
      </div>
      <div className="bd-search">
        <i className="bi bi-search" aria-hidden="true" />
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search chats" aria-label="Search chats" />
      </div>
      {err && <div className="bd-error mx-2" role="alert">{err}</div>}
      <nav className="bd-history-list" aria-label="Chats" aria-busy={!state.convsLoaded}>
        {!state.convsLoaded && !state.convsError && <HistorySkeleton />}
        {state.convsError && !state.convs.length && <LoadError what="your chats" onRetry={refreshConvs} compact />}
        {state.convsLoaded && groups.length === 0 && <div className="bd-side-empty">{q ? 'No chats match.' : 'No chats yet. Ask Buddy something!'}</div>}
        {groups.map((g) => (
          <div key={g.label} className="bd-group">
            <div className="bd-group-label">{g.label}</div>
            {g.items.map((c) => (
              editing?.id === c.id
                ? (
                  <form key={c.id} className="bd-rename" onSubmit={(e) => { e.preventDefault(); act(() => rename(c.id, editing.title)); setEditing(null); }}>
                    <input autoFocus value={editing.title} maxLength={120} aria-label="Chat title"
                      onChange={(e) => setEditing({ ...editing, title: e.target.value })}
                      onKeyDown={(e) => { if (e.key === 'Escape') setEditing(null); }} />
                    <button type="submit" className="bd-icon-btn" aria-label="Save title"><i className="bi bi-check-lg" /></button>
                  </form>
                )
                : (
                  <div key={c.id} className={`bd-conv ${activeKey === c.id ? 'is-active' : ''}`}>
                    <button type="button" className="bd-conv-main" onClick={() => onPick(c.id)} aria-current={activeKey === c.id ? 'true' : undefined}>
                      {state.unread[c.id] && <span className="bd-dot" role="img" aria-label="Unread reply" />}
                      {state.inflight[c.id] && <span className="bd-spin" role="img" aria-label="Buddy is replying" />}
                      <span className="text-truncate">{c.title || 'New chat'}</span>
                    </button>
                    <div className="bd-conv-acts">
                      <button type="button" onClick={() => act(() => pin(c.id, !c.pinned))}
                        aria-label={`${c.pinned ? 'Unpin' : 'Pin'} “${c.title || 'New chat'}”`} title={c.pinned ? 'Unpin' : 'Pin'}>
                        <i className={`bi ${c.pinned ? 'bi-pin-angle-fill' : 'bi-pin-angle'}`} aria-hidden="true" />
                      </button>
                      <button type="button" onClick={() => setEditing({ id: c.id, title: c.title || '' })}
                        aria-label={`Rename “${c.title || 'New chat'}”`} title="Rename"><i className="bi bi-pencil" aria-hidden="true" /></button>
                      <button type="button" className="is-danger" aria-label={`Delete “${c.title || 'New chat'}”`} title="Delete"
                        onClick={() => { if (window.confirm('Delete this chat? This cannot be undone.')) act(() => remove(c.id)); }}>
                        <i className="bi bi-trash3" aria-hidden="true" />
                      </button>
                    </div>
                  </div>
                )
            ))}
          </div>
        ))}
      </nav>
      {canSettings && (
        <button type="button" className={`bd-settings-btn ${settingsActive ? 'is-active' : ''}`} onClick={onSettings}>
          <i className="bi bi-gear" /> Buddy settings
        </button>
      )}
    </aside>
  );
}
