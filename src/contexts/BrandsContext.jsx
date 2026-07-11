import { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { useAuth } from './AuthContext';
import { listBrandsForReporting } from '../lib/reportsApi';
import { supabase } from '../lib/supabase';
import { hasUnsavedWork } from '../lib/appUpdate';

/**
 * v1 verbatim-port shim — v1 components import `useBrands()` to get the
 * role-scoped brand list (Boss/OL/Dev see all; TL/PCTL see owned;
 * APC/IPC see assigned). v2 has no top-level BrandsProvider; instead
 * each consumer fetches as needed via `listBrandsForReporting`.
 *
 * This shim wraps that fetch in a hook with the v1 return shape:
 *
 *   { brands, loading, getBrandById }
 *
 * Brands are normalized to expose v1's expected fields (`brandName`,
 * `name`, `ownerId`, `clientName`) alongside v2's snake_case columns,
 * so v1 markup keeps working unmodified. Reactive: subscribes to the
 * `brands` table via Supabase Realtime so the list updates as the org
 * adds/removes/updates brands.
 *
 * No top-level provider needed — the hook is self-contained. We still
 * export `BrandsProvider` as a pass-through so any v1 markup that wraps
 * children with it continues to work.
 */

const BrandsCtx = createContext(null);

function _normBrand(row) {
  if (!row) return row;
  return {
    id:          row.id,
    brandName:   row.brand_name || '',
    name:        row.brand_name || '',
    clientName:  row.client_name || '',
    logoUrl:     row.logo_url || '',
    ownerId:     row.owner_id || null,
    status:      row.status || 'active',
    // Pass-through any other columns we didn't rename
    ...row,
  };
}

export function useBrands() {
  // If a parent <BrandsProvider> wrapped us, use its shared value (one fetch +
  // one realtime channel for the whole app). Otherwise fall back to a
  // per-consumer standalone fetch. fromCtx is stable for a given mount (a
  // component is either under the provider or not, always), so the conditional
  // hook call below is safe in practice.
  const fromCtx = useContext(BrandsCtx);
  if (fromCtx) return fromCtx;
  // eslint-disable-next-line react-hooks/rules-of-hooks
  return useBrandsStandalone();
}

// The actual fetch + realtime + state. Used by BrandsProvider (once, shared)
// and as the standalone fallback inside useBrands().
function useBrandsStandalone() {
  const { user, profile } = useAuth();
  const uid = user?.id;
  const role = profile?.role;
  // Per-user 'canViewAllBrands' override (mig 192) — when true, a
  // TL/PCTL/APC sees the same brand list a Boss/OL would. Used for
  // special-case accounts (Abdul Subhan as of 2026-06-04). Profile
  // changes propagate via AuthContext's realtime UPDATE listener.
  const permissions = profile?.permissions || {};
  const [brands, setBrands] = useState([]);
  const [loading, setLoading] = useState(true);
  // Per-hook unique channel suffix. Multiple useBrands() consumers can
  // mount in the same render tree (e.g. weekly-report form + page);
  // sharing one channel name across them caused
  //   "cannot add `postgres_changes` callbacks ... after `subscribe()`"
  // because the second consumer would try to attach `.on()` to the
  // first consumer's already-subscribed channel object behind the scenes.
  const instanceIdRef = useRef(null);
  if (instanceIdRef.current === null) {
    instanceIdRef.current = Math.random().toString(36).slice(2, 10);
  }

  useEffect(() => {
    if (!uid || !role) {
      // If a dirty editor is mounted, this is probably a transient
      // auth flutter — keep the existing brand list around for 2s
      // before clearing. Same rationale as ProtectedRoute/RoleGuard
      // grace: don't yank state out from under an active edit on the
      // basis of one auth event that may reverse milliseconds later.
      if (hasUnsavedWork()) {
        const t = setTimeout(() => {
          setBrands([]);
          setLoading(true);
        }, 2000);
        return () => clearTimeout(t);
      }
      setBrands([]);
      setLoading(true);
      return undefined;
    }
    let cancelled = false;
    setLoading(true);
    // Safety: even if the initial fetch hangs forever (network blip
    // that never resolves), force loading=false after 8 seconds so
    // the page isn't stuck on a spinner.
    const safetyTimer = setTimeout(() => {
      if (!cancelled) setLoading(false);
    }, 8000);
    (async () => {
      try {
        const rows = await listBrandsForReporting({ role, uid, permissions });
        if (!cancelled) {
          setBrands((rows || []).map(_normBrand));
          setLoading(false);
          clearTimeout(safetyTimer);
        }
      } catch {
        if (!cancelled) {
          setBrands([]);
          setLoading(false);
          clearTimeout(safetyTimer);
        }
      }
    })();

    // Realtime: refetch on any brands-table change. Channel name is
    // unique per hook instance so multiple consumers don't collide.
    // A burst of row changes (e.g. a brand swap that touches several rows,
    // or a bulk edit) is COALESCED into a single refetch via a short debounce
    // so one action doesn't trigger a storm of identical list re-downloads.
    let refetchTimer = null;
    const ch = supabase
      .channel(`brands-ctx-${uid}-${instanceIdRef.current}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'brands' }, () => {
        if (refetchTimer) clearTimeout(refetchTimer);
        refetchTimer = setTimeout(async () => {
          try {
            const rows = await listBrandsForReporting({ role, uid, permissions });
            if (!cancelled) setBrands((rows || []).map(_normBrand));
          } catch { /* ignore */ }
        }, 400);
      })
      .subscribe();

    return () => {
      cancelled = true;
      clearTimeout(safetyTimer);
      if (refetchTimer) clearTimeout(refetchTimer);
      supabase.removeChannel(ch);
    };
  // canViewAllBrands flipping should re-fetch with the broader query.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [uid, role, permissions?.canViewAllBrands]);

  return useMemo(() => {
    const byId = new Map(brands.map((b) => [b.id, b]));
    return {
      brands,
      loading,
      getBrandById: (id) => byId.get(id) || null,
    };
  }, [brands, loading]);
}

/**
 * Provider — runs the brand fetch + realtime subscription ONCE and shares the
 * result with every useBrands() consumer in the tree. Wrapping the app in this
 * collapses what used to be 13 independent brand fetches + 13 realtime channels
 * (and 2 identical ones per report screen) down to a single fetch + channel.
 * Consumers rendered OUTSIDE the provider still work via the standalone fallback.
 */
export function BrandsProvider({ children }) {
  const value = useBrandsStandalone();
  return <BrandsCtx.Provider value={value}>{children}</BrandsCtx.Provider>;
}
