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

  // --- Initial load --------------------------------------------------------
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

  useEffect(() => {
    if (!uid) {
      setItems([]);
      setCounts({ total: 0, byCategory: {} });
      setLoading(false);
      return;
    }
    load();
  }, [uid, load]);

  // Listen for service-worker relays. When a push arrives the SW
  // posts a message to every open window; we refresh counts + items
  // immediately so the bell updates before (or instead of) the
  // Realtime WebSocket catching up. When the user clicks "Mark as
  // read" on the popup, the SW posts a separate message and we flip
  // the row locally.
  useEffect(() => {
    if (!uid) return;
    if (!('serviceWorker' in navigator)) return;
    function onMsg(e) {
      const m = e.data;
      if (!m || typeof m !== 'object') return;
      if (m.type === 'wurxos-notification') {
        load();
        return;
      }
      if (m.type === 'wurxos-notification-read' && m.id) {
        setItems((prev) => prev.map((n) =>
          n.id === m.id && !n.read_at
            ? { ...n, read_at: new Date().toISOString() }
            : n,
        ));
        setCounts((c) => {
          const target = items.find((n) => n.id === m.id && !n.read_at);
          if (!target) return c;
          const byCategory = { ...c.byCategory };
          byCategory[target.category] = Math.max(0, (byCategory[target.category] || 0) - 1);
          return { total: Math.max(0, c.total - 1), byCategory };
        });
      }
    }
    navigator.serviceWorker.addEventListener('message', onMsg);
    return () => navigator.serviceWorker.removeEventListener('message', onMsg);
  }, [uid, load, items]);

  // Tab-focus safety net — if realtime dropped while the tab was in
  // the background, refetch counts the moment the user comes back.
  useEffect(() => {
    if (!uid) return;
    function onVisible() { if (document.visibilityState === 'visible') load(); }
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [uid, load]);

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
  const markRead = useCallback(async (id) => {
    const target = items.find((n) => n.id === id);
    if (!target || target.read_at) return;
    // Optimistic
    setItems((prev) => prev.map((n) => (n.id === id ? { ...n, read_at: new Date().toISOString() } : n)));
    setCounts((c) => {
      const byCategory = { ...c.byCategory };
      byCategory[target.category] = Math.max(0, (byCategory[target.category] || 0) - 1);
      return { total: Math.max(0, c.total - 1), byCategory };
    });
    try { await apiMarkRead(id); } catch (e) { console.warn(e.message); load(); }
  }, [items, load]);

  const markAllRead = useCallback(async () => {
    setItems((prev) => prev.map((n) => (n.read_at ? n : { ...n, read_at: new Date().toISOString() })));
    setCounts({ total: 0, byCategory: {} });
    try { await apiMarkAllRead(); } catch (e) { console.warn(e.message); load(); }
  }, [load]);

  const markCategoryRead = useCallback(async (category) => {
    setItems((prev) => prev.map((n) =>
      n.category === category && !n.read_at ? { ...n, read_at: new Date().toISOString() } : n,
    ));
    setCounts((c) => {
      const removed = c.byCategory[category] || 0;
      const byCategory = { ...c.byCategory, [category]: 0 };
      return { total: Math.max(0, c.total - removed), byCategory };
    });
    try { await apiMarkCategoryRead(category); } catch (e) { console.warn(e.message); load(); }
  }, [load]);

  const markVisibleRead = useCallback(async (ids) => {
    if (!ids?.length) return;
    const changed = items.filter((n) => ids.includes(n.id) && !n.read_at);
    if (!changed.length) return;
    setItems((prev) => prev.map((n) =>
      ids.includes(n.id) && !n.read_at ? { ...n, read_at: new Date().toISOString() } : n,
    ));
    setCounts((c) => {
      const byCategory = { ...c.byCategory };
      changed.forEach((n) => { byCategory[n.category] = Math.max(0, (byCategory[n.category] || 0) - 1); });
      return { total: Math.max(0, c.total - changed.length), byCategory };
    });
    try { await apiMarkManyRead(ids); } catch (e) { console.warn(e.message); load(); }
  }, [items, load]);

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
