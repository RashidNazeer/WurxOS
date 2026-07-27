import { useCallback, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { listBrands } from '../../lib/brandsApi';
import { useAuth } from '../../contexts/AuthContext';
import BrandCard, { formatTier } from '../../components/brands/BrandCard';
import BrandForm from '../../components/brands/BrandForm';
import BrandSwitcherModal from '../../components/brands/BrandSwitcherModal';
import RequestBrandSwitchModal from '../../components/brands/RequestBrandSwitchModal';
import {
  PlusIcon, SearchIcon, AlertIcon, RefreshIcon,
} from '../../components/common/Icon';
import '../../styles/table.css';
import '../../styles/brands.css';

export default function BrandsPage() {
  const { profile } = useAuth();
  const role = profile?.role;
  const isBossOrOL = role === 'boss' || role === 'ol';
  const isTL = role === 'tl';
  const canCreate = isBossOrOL || isTL;

  const [q, setQ]           = useState('');
  const [statusFilter, setStatusFilter] = useState('active');
  const [clientFilter, setClientFilter] = useState('');
  const [tierFilter, setTierFilter]     = useState('');
  const [tlFilter, setTlFilter]         = useState('');
  const [showForm, setShowForm]   = useState(false);
  const [editBrand, setEditBrand] = useState(null);
  const [switchBrand, setSwitchBrand] = useState(null);

  const qc = useQueryClient();
  const {
    data: rows = [],
    isLoading: loading,
    isFetching,
    error: queryError,
    refetch,
  } = useQuery({
    queryKey: ['brands'],
    queryFn: () => listBrands(),
  });
  const error = queryError?.message || '';
  const invalidate = useCallback(() => qc.invalidateQueries({ queryKey: ['brands'] }), [qc]);

  // Distinct filter options, drawn from all brands (so a choice never disappears
  // when another filter narrows the list).
  const clientOptions = useMemo(
    () => [...new Set(rows.map((b) => (b.client_name || '').trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b)),
    [rows],
  );
  const tierOptions = useMemo(() => {
    const set = new Set();
    rows.forEach((b) => { const t = formatTier(b.tier); if (t) set.add(t); });
    return [...set].sort((a, b) => {
      const na = Number(a), nb = Number(b), an = Number.isFinite(na), bn = Number.isFinite(nb);
      if (an && bn) return na - nb;       // numeric tiers ascending
      if (an) return -1; if (bn) return 1; // "Unlimited" etc. last
      return a.localeCompare(b);
    });
  }, [rows]);
  const tlOptions = useMemo(() => {
    const m = new Map();
    rows.forEach((b) => { if (b.owner?.id) m.set(b.owner.id, b.owner.display_name); });
    return [...m.entries()].map(([id, name]) => ({ id, name })).sort((a, b) => (a.name || '').localeCompare(b.name || ''));
  }, [rows]);

  const filtered = useMemo(() => {
    const qq = q.trim().toLowerCase();
    return rows.filter((b) => {
      if (statusFilter !== 'all' && b.status !== statusFilter) return false;
      if (clientFilter && (b.client_name || '') !== clientFilter) return false;
      if (tierFilter && formatTier(b.tier) !== tierFilter) return false;
      if (tlFilter && b.owner?.id !== tlFilter) return false;
      if (!qq) return true;
      return (
        (b.brand_name  || '').toLowerCase().includes(qq) ||
        (b.client_name || '').toLowerCase().includes(qq) ||
        (b.owner?.display_name || '').toLowerCase().includes(qq)
      );
    });
  }, [rows, q, statusFilter, clientFilter, tierFilter, tlFilter]);

  const canEditRow = useCallback((b) => {
    if (isBossOrOL) return true;
    if (isTL && b.owner_id === profile.id) return true;
    return false;
  }, [isBossOrOL, isTL, profile]);

  const pageTitle = isBossOrOL ? 'Brands' : 'My Brands';
  const pageSubtitle = (() => {
    if (loading) return '';
    const n = filtered.length;
    const total = rows.length;
    const base = `${n} of ${total} ${total === 1 ? 'brand' : 'brands'}`;
    return q ? `${base} · matching "${q}"` : base;
  })();

  return (
    <>
      <div className="page-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: 12 }}>
        <div>
          <h1 className="page-title">{pageTitle}</h1>
          <p className="page-subtitle">{pageSubtitle}</p>
        </div>
        {canCreate && (
          <button className="wx-btn wx-btn-primary" onClick={() => setShowForm(true)}>
            <PlusIcon width="16" height="16" /> Add brand
          </button>
        )}
      </div>

      <div className="wx-toolbar">
        <div className="wx-search">
          <span className="wx-search-icon"><SearchIcon width="16" height="16" /></span>
          <input
            className="wx-input"
            placeholder="Search by brand, client or TL…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
        </div>
        <div style={{ display: 'flex', gap: 6 }}>
          {['active', 'inactive', 'all'].map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => setStatusFilter(s)}
              className={`wx-role-chip ${statusFilter === s ? 'wx-role-chip-active' : ''}`}
              style={{ padding: '7px 14px' }}
            >
              {s[0].toUpperCase() + s.slice(1)}
            </button>
          ))}
        </div>
        <div className="wx-toolbar-spacer" />
        <button className="wx-btn wx-btn-ghost" onClick={() => refetch()} disabled={isFetching} title="Refresh">
          <RefreshIcon width="15" height="15" />
        </button>
      </div>

      {/* Filters on their own row so they line up instead of wrapping under search. */}
      <div className="wx-toolbar" style={{ marginTop: -6 }}>
        <select className="wx-input" value={clientFilter} onChange={(e) => setClientFilter(e.target.value)} style={{ width: 190 }} title="Filter by client">
          <option value="">All clients</option>
          {clientOptions.map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
        <select className="wx-input" value={tierFilter} onChange={(e) => setTierFilter(e.target.value)} style={{ width: 150 }} title="Filter by tier">
          <option value="">All tiers</option>
          {tierOptions.map((t) => <option key={t} value={t}>{t}</option>)}
        </select>
        {isBossOrOL && (
          <select className="wx-input" value={tlFilter} onChange={(e) => setTlFilter(e.target.value)} style={{ width: 190 }} title="Filter by Team Lead">
            <option value="">All Team Leads</option>
            {tlOptions.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select>
        )}
        {(clientFilter || tierFilter || tlFilter) && (
          <button type="button" className="wx-btn wx-btn-ghost" style={{ padding: '7px 12px', fontSize: 13 }}
            onClick={() => { setClientFilter(''); setTierFilter(''); setTlFilter(''); }}>
            Clear filters
          </button>
        )}
      </div>

      {error && (
        <div className="wx-alert wx-alert-danger" style={{ marginBottom: 14 }}>
          <AlertIcon width="16" height="16" /> <span>{error}</span>
        </div>
      )}

      {loading ? (
        <div className="wx-empty">
          <span className="wx-spinner" style={{ color: 'var(--accent)' }} /> Loading brands…
        </div>
      ) : filtered.length === 0 ? (
        <div className="wx-card wx-empty" style={{ padding: 40 }}>
          <div className="wx-empty-title">
            {rows.length === 0 ? 'No brands yet' : 'No brands match your filters'}
          </div>
          <div>
            {rows.length === 0 && canCreate && 'Click "Add brand" to create your first one.'}
            {rows.length === 0 && !canCreate && 'Your Team Lead or the Boss will assign brands to you.'}
          </div>
        </div>
      ) : (
        <div className="brand-grid">
          {filtered.map((b) => (
            <BrandCard
              key={b.id}
              brand={b}
              canEdit={canEditRow(b)}
              canSwitch={isBossOrOL}
              onEdit={() => setEditBrand(b)}
              onSwitch={() => setSwitchBrand(b)}
            />
          ))}
        </div>
      )}

      {showForm && (
        <BrandForm
          brand={null}
          onClose={() => setShowForm(false)}
          onSaved={() => { setShowForm(false); invalidate(); }}
        />
      )}
      {editBrand && (
        <BrandForm
          brand={editBrand}
          onClose={() => setEditBrand(null)}
          onSaved={() => { setEditBrand(null); invalidate(); }}
        />
      )}
      {switchBrand && role === 'boss' && (
        <BrandSwitcherModal
          brand={switchBrand}
          onClose={() => setSwitchBrand(null)}
          onDone={() => { setSwitchBrand(null); invalidate(); }}
        />
      )}
      {switchBrand && role !== 'boss' && (
        <RequestBrandSwitchModal
          brand={switchBrand}
          onClose={() => setSwitchBrand(null)}
          onSubmitted={() => { setSwitchBrand(null); invalidate(); }}
        />
      )}
    </>
  );
}
