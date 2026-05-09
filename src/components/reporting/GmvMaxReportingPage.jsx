import React, { useMemo, useState } from 'react';
import { useBrands } from '../../contexts/BrandsContext';
import GmvMaxTab from '../brands/tabs/GmvMaxTab';

/**
 * Standalone "GMV Max Reporting" page accessible from the main nav.
 *
 * Shows a compact brand picker on the left, the existing GmvMaxTab on the
 * right (so the entry/list UI is identical to what's in Brand Detail).
 * Whatever brand list useBrands returns for the current role is what the
 * picker lists — APC sees their assigned brands, TL/PCTL see their owned
 * ones, Boss/OL see all.
 */
export default function GmvMaxReportingPage() {
  const { brands, loading } = useBrands();
  const [search, setSearch] = useState('');
  const [selectedId, setSelectedId] = useState(null);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return [...brands]
      .sort((a, b) => (a.brandName || a.name || '').localeCompare(b.brandName || b.name || ''))
      .filter(b => !q || (b.brandName || b.name || '').toLowerCase().includes(q));
  }, [brands, search]);

  const selected = useMemo(
    () => brands.find(b => b.id === selectedId) || null,
    [brands, selectedId]
  );

  return (
    <div style={{ padding: '24px 28px 48px' }}>
      {/* Header */}
      <div className="d-flex align-items-start justify-content-between mb-4 flex-wrap gap-3">
        <div>
          <h4 className="fw-bold mb-1" style={{ color: '#0f172a' }}>
            <i className="bi bi-bar-chart-line-fill me-2" style={{ color: '#0ea5e9' }} />
            GMV Max Reporting
          </h4>
          <p className="text-muted small mb-0">Enter monthly and weekly GMV Max metrics from TikTok Ads Manager / Seller Center for each brand.</p>
        </div>
      </div>

      <div className="row g-3">
        {/* Brand picker */}
        <div className="col-lg-4">
          <div className="card border-0 shadow-sm" style={{ borderRadius: 14, position: 'sticky', top: 16 }}>
            <div className="card-body p-3">
              <div className="d-flex align-items-center justify-content-between mb-2">
                <h6 className="fw-bold mb-0" style={{ fontSize: '0.85rem' }}>
                  <i className="bi bi-shop me-1" />Brands
                </h6>
                <span className="text-muted" style={{ fontSize: '0.7rem' }}>{filtered.length}</span>
              </div>
              <div className="input-group input-group-sm mb-2">
                <span className="input-group-text border-0" style={{ background: '#f1f5f9' }}>
                  <i className="bi bi-search text-muted" style={{ fontSize: '0.7rem' }} />
                </span>
                <input className="form-control border-0" placeholder="Search brand…" style={{ background: '#f1f5f9' }}
                  value={search} onChange={e => setSearch(e.target.value)} />
              </div>
              {loading ? (
                <div className="text-muted small text-center py-3">Loading brands…</div>
              ) : filtered.length === 0 ? (
                <div className="text-muted small text-center py-3">No brands available.</div>
              ) : (
                <div className="d-flex flex-column gap-1" style={{ maxHeight: '60vh', overflowY: 'auto' }}>
                  {filtered.map(b => {
                    const name = b.brandName || b.name || 'Untitled';
                    const isSel = b.id === selectedId;
                    return (
                      <button key={b.id} type="button"
                        className="btn text-start d-flex align-items-center gap-2"
                        style={{
                          borderRadius: 10,
                          padding: '8px 10px',
                          background: isSel ? '#0ea5e91a' : '#fff',
                          border: `1px solid ${isSel ? '#0ea5e9' : '#e9ecef'}`,
                          color: isSel ? '#0369a1' : '#1e293b',
                          fontSize: '0.82rem', fontWeight: isSel ? 600 : 500,
                        }}
                        onClick={() => setSelectedId(b.id)}>
                        <div className="rounded-circle d-flex align-items-center justify-content-center text-white"
                          style={{ width: 26, height: 26, background: '#0ea5e9', fontSize: '0.62rem', fontWeight: 700, flexShrink: 0 }}>
                          {(name || '??').slice(0, 2).toUpperCase()}
                        </div>
                        <span className="text-truncate flex-grow-1">{name}</span>
                        {isSel && <i className="bi bi-arrow-right" style={{ fontSize: '0.7rem' }} />}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Selected brand → GMV Max entry UI */}
        <div className="col-lg-8">
          {selected ? (
            <div className="card border-0 shadow-sm" style={{ borderRadius: 14 }}>
              <div className="card-body p-3 p-md-4">
                <GmvMaxTab brand={selected} />
              </div>
            </div>
          ) : (
            <div className="card border-0 shadow-sm" style={{ borderRadius: 14 }}>
              <div className="card-body p-5 text-center">
                <i className="bi bi-arrow-left-circle" style={{ fontSize: '2rem', color: '#94a3b8' }} />
                <h6 className="fw-bold mt-3 mb-1">Pick a brand to start</h6>
                <p className="text-muted small mb-0">Select a brand from the list to enter monthly or weekly GMV Max data.</p>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
