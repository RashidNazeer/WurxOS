import { useEffect, useRef } from 'react';
import { supabase } from './supabase';

/**
 * Live-sync for the report LIST pages. Subscribes to the `reports` table and
 * calls `onChange` (debounced) whenever any report row changes — so status
 * changes (submitted → approved → verified / rejected) and new/removed reports
 * appear automatically, no manual refresh.
 *
 * We deliberately trigger a debounced BACKGROUND REFETCH rather than patching
 * the raw DB row into the list: report changes are low-frequency (a handful of
 * approvals a day), the refetch already re-scopes correctly by role/brand/type,
 * and it avoids any snake_case→normalized shape or scope-filtering bugs. RLS on
 * `reports` (realtime side) means each client only hears about reports it can
 * see, so unrelated changes never even reach the browser.
 *
 * Pass the page's React Query `refetch` as `onChange`. The subscription mounts
 * once (a callback ref keeps the latest onChange without re-subscribing).
 *
 * @param {Function} onChange  called (debounced ~500ms) on any reports change
 * @param {{ enabled?: boolean }} [opts]
 */
export function useReportsRealtime(onChange, { enabled = true } = {}) {
  const cbRef = useRef(onChange);
  useEffect(() => { cbRef.current = onChange; }, [onChange]);

  useEffect(() => {
    if (!enabled) return undefined;
    let timer = null;
    const ch = supabase
      .channel(`reports-live-${Math.random().toString(36).slice(2, 10)}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'reports' }, () => {
        // Coalesce a burst (e.g. a bulk status change) into one refetch.
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => { if (typeof cbRef.current === 'function') cbRef.current(); }, 500);
      })
      .subscribe();
    return () => {
      if (timer) clearTimeout(timer);
      supabase.removeChannel(ch);
    };
  }, [enabled]);
}
