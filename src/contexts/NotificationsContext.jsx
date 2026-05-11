import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { supabase } from '../lib/supabase';
import { useAuth } from './AuthContext';
import {
  fetchUnreadCounts, listNotifications,
  markRead as apiMarkRead,
  markManyRead as apiMarkManyRead,
  markAllRead as apiMarkAllRead,
  markCategoryRead as apiMarkCategoryRead,
} from '../lib/notificationsApi';

const NotificationsContext = createContext(null);

export function NotificationsProvider({ children }) {
  const { user } = useAuth();
  const uid = user?.id;
  const [items, setItems] = useState([]);      // Recent notifications (cap ~50)
  const [counts, setCounts] = useState({ total: 0, byCategory: {} });
  const [loading, setLoading] = useState(true);

  const channelRef = useRef(null);

  // CRITICAL: hold the latest items in a ref so the callbacks below
  // can read fresh data WITHOUT depending on `items` in their useCallback
  // dep array. The previous design recreated markRead/markVisibleRead
  // every time items changed, which (combined with effects depending
  // on those callbacks) caused an infinite render cascade that could
  // tip recheckSession over its failure threshold and force sign-out.
  // See audit Finding 1+2.
  const itemsRef = useRef(items);
  useEffect(() => { itemsRef.current = items; }, [items]);

  // --- Initial load --------------------------------------------------------
  // Load also lives in a ref so other effects (visibilitychange, SW
  // messages) can call it without putting it in their dep array. The
  // load logic itself only depends on the uid captured at call time.
  const loadRef = useRef(null);
  const load = useCallback(async () => {
    if (!uid) return;
    setLoading(true);
    try {
      const [list, c] = await Promise.all([
        listNotifications({ limit: 50 }),
        fetchUnreadCounts(),
      ]);
      setItems(list);
      setCounts(c);
    } catch (err) {
      console.warn('[notifications] load failed:', err.message);
    } finally {
      setLoading(false);
    }
  }, [uid]);
  useEffect(() => { loadRef.current = load; }, [load]);

  useEffect(() => {
    if (!uid) {
      setItems([]);
      setCounts({ total: 0, byCategory: {} });
      setLoading(false);
      return;
    }
    load();
  }, [uid, load]);

  // Service-worker relays (push arrivals + mark-read clicks). Deps
  // intentionally drop `load` and `items` — both read via refs.
  useEffect(() => {
    if (!uid) return;
    if (!('serviceWorker' in navigator)) return;
    function onMsg(e) {
      const m = e.data;
      if (!m || typeof m !== 'object') return;
      if (m.type === 'wurxos-notification') {
        loadRef.current?.();
        return;
      }
      if (m.type === 'wurxos-notification-read' && m.id) {
        setItems((prev) => prev.map((n) =>
          n.id === m.id && !n.read_at
            ? { ...n, read_at: new Date().toISOString() }
            : n,
        ));
        setCounts((c) => {
          // Read items via ref so we don't have to re-bind this effect
          // every time items changes.
          const target = itemsRef.current.find((n) => n.id === m.id && !n.read_at);
          if (!target) return c;
          const byCategory = { ...c.byCategory };
          byCategory[target.category] = Math.max(0, (byCategory[target.category] || 0) - 1);
          return { total: Math.max(0, c.total - 1), byCategory };
        });
      }
    }
    navigator.serviceWorker.addEventListener('message', onMsg);
    return () => navigator.serviceWorker.removeEventListener('message', onMsg);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [uid]);

  // Tab-focus safety net — if realtime dropped while the tab was in
  // the background, refetch counts the moment the user comes back.
  useEffect(() => {
    if (!uid) return;
    function onVisible() { if (document.visibilityState === 'visible') loadRef.current?.(); }
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [uid]);

  // --- Realtime subscription ----------------------------------------------
  useEffect(() => {
    if (!uid) return;
    const channel = supabase
      .channel(`notifications-${uid}`)
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'notifications',
          filter: `recipient_id=eq.${uid}`,
        },
        (payload) => {
          const n = payload.new;
          setItems((prev) => [n, ...prev].slice(0, 50));
          setCounts((c) => {
            const byCategory = { ...c.byCategory };
            byCategory[n.category] = (byCategory[n.category] || 0) + 1;
            return { total: c.total + 1, byCategory };
          });
        },
      )
      .on(
        'postgres_changes',
        {
          event: 'UPDATE',
          schema: 'public',
          table: 'notifications',
          filter: `recipient_id=eq.${uid}`,
        },
        (payload) => {
          const n = payload.new;
          setItems((prev) => prev.map((x) => (x.id === n.id ? { ...x, ...n } : x)));
        },
      )
      .subscribe();

    channelRef.current = channel;
    return () => {
      try { supabase.removeChannel(channel); } catch {}
      channelRef.current = null;
    };
  }, [uid]);

  // --- Mutations -----------------------------------------------------------
  // All read items via itemsRef.current so the callbacks have an
  // empty effective dep set — they stay stable across renders and
  // never re-bind effects that consume them. Failed API calls log
  // to console; we no longer auto-call `load()` on failure because
  // it could cascade into a recheckSession storm (audit Finding 1).
  const markRead = useCallback(async (id) => {
    const target = itemsRef.current.find((n) => n.id === id);
    if (!target || target.read_at) return;
    // Optimistic
    setItems((prev) => prev.map((n) => (n.id === id ? { ...n, read_at: new Date().toISOString() } : n)));
    setCounts((c) => {
      const byCategory = { ...c.byCategory };
      byCategory[target.category] = Math.max(0, (byCategory[target.category] || 0) - 1);
      return { total: Math.max(0, c.total - 1), byCategory };
    });
    try { await apiMarkRead(id); } catch (e) { console.warn('[notifications] markRead failed:', e.message); }
  }, []);

  const markAllRead = useCallback(async () => {
    setItems((prev) => prev.map((n) => (n.read_at ? n : { ...n, read_at: new Date().toISOString() })));
    setCounts({ total: 0, byCategory: {} });
    try { await apiMarkAllRead(); } catch (e) { console.warn('[notifications] markAllRead failed:', e.message); }
  }, []);

  const markCategoryRead = useCallback(async (category) => {
    setItems((prev) => prev.map((n) =>
      n.category === category && !n.read_at ? { ...n, read_at: new Date().toISOString() } : n,
    ));
    setCounts((c) => {
      const removed = c.byCategory[category] || 0;
      const byCategory = { ...c.byCategory, [category]: 0 };
      return { total: Math.max(0, c.total - removed), byCategory };
    });
    try { await apiMarkCategoryRead(category); } catch (e) { console.warn('[notifications] markCategoryRead failed:', e.message); }
  }, []);

  const markVisibleRead = useCallback(async (ids) => {
    if (!ids?.length) return;
    const changed = itemsRef.current.filter((n) => ids.includes(n.id) && !n.read_at);
    if (!changed.length) return;
    setItems((prev) => prev.map((n) =>
      ids.includes(n.id) && !n.read_at ? { ...n, read_at: new Date().toISOString() } : n,
    ));
    setCounts((c) => {
      const byCategory = { ...c.byCategory };
      changed.forEach((n) => { byCategory[n.category] = Math.max(0, (byCategory[n.category] || 0) - 1); });
      return { total: Math.max(0, c.total - changed.length), byCategory };
    });
    try { await apiMarkManyRead(ids); } catch (e) { console.warn('[notifications] markManyRead failed:', e.message); }
  }, []);

  return (
    <NotificationsContext.Provider
      value={{ items, counts, loading, reload: load, markRead, markAllRead, markCategoryRead, markVisibleRead }}
    >
      {children}
    </NotificationsContext.Provider>
  );
}

export function useNotifications() {
  const ctx = useContext(NotificationsContext);
  if (!ctx) throw new Error('useNotifications must be used inside NotificationsProvider');
  return ctx;
}
