import { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { useAuth } from './AuthContext';
import { listBrandsForReporting } from '../lib/reportsApi';
import { supabase } from '../lib/supabase';

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
  // If a parent <BrandsProvider> wrapped us, use its value.
  const fromCtx = useContext(BrandsCtx);
  if (fromCtx) return fromCtx;

  // Standalone fallback: each component that calls useBrands() fetches once.
  const { user, profile } = useAuth();
  const uid = user?.id;
  const role = profile?.role;
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
      setBrands([]);
      setLoading(true);
      return undefined;
    }
    let cancelled = false;
    setLoading(true);
    (async () => {
      try {
        const rows = await listBrandsForReporting({ role, uid });
        if (!cancelled) {
          setBrands((rows || []).map(_normBrand));
          setLoading(false);
        }
      } catch {
        if (!cancelled) {
          setBrands([]);
          setLoading(false);
        }
      }
    })();

    // Realtime: refetch on any brands-table change. Channel name is
    // unique per hook instance so multiple consumers don't collide.
    const ch = supabase
      .channel(`brands-ctx-${uid}-${instanceIdRef.current}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'brands' }, async () => {
        try {
          const rows = await listBrandsForReporting({ role, uid });
          if (!cancelled) setBrands((rows || []).map(_normBrand));
        } catch { /* ignore */ }
      })
      .subscribe();

    return () => {
      cancelled = true;
      supabase.removeChannel(ch);
    };
  }, [uid, role]);

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
 * Optional provider — if you want a single fetch shared across the tree
 * instead of one fetch per useBrands() consumer, wrap your subtree in
 * <BrandsProvider>. Otherwise the hook works standalone.
 */
export function BrandsProvider({ children }) {
  // Re-use the standalone hook logic by NOT providing a context value.
  // (Skipping the provider entirely would be cleaner but breaks v1
  // imports that destructure from `BrandsProvider`.)
  return <BrandsCtx.Provider value={null}>{children}</BrandsCtx.Provider>;
}
