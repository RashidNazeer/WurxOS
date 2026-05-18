import React, { useEffect, useMemo, useState } from 'react';
import { useAuth } from '../../contexts/AuthContext';
import {
  listEukaMetrics, triggerEukaSync, subscribeEukaMetrics,
  listLinkableBrands, linkEukaStore,
} from '../../lib/eukaApi';

// TikTok Shop Metrics — the full per-store metric set synced from
// Euka (sales, creators & content, ads, outreach, top performers).
// Snapshots are written by the euka-sync edge function.

function money(n) {
  if (n == null) return '—';
  return `$${Number(n).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;
}
function intf(n) {
  return n == null ? '—' : Number(n).toLocaleString('en-US');
}
function ratio(n) {
  return n == null ? '—' : `${Number(n).toLocaleString('en-US', { maximumFractionDigits: 2 })}x`;
}
function relTime(iso) {
  if (!iso) return '';
  const diff = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (diff < 60) return 'just now';
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

// Metric groups — each entry is [key, label, formatter].
const GROUPS = [
  {
    label: 'Sales', icon: 'bi-cash-stack',
    metrics: [
      ['gmv', 'GMV', money],
      ['video_gmv', 'Video GMV', money],
      ['units', 'Units sold', intf],
      ['orders', 'Orders', intf],
      ['aov', 'Avg order value', money],
    ],
  },
  {
    label: 'Creators & content', icon: 'bi-camera-video',
    metrics: [
      ['active_creators', 'Active creators', intf],
      ['videos_posted', 'Videos posted', intf],
      ['video_views', 'Video views', intf],
    ],
  },
  {
    label: 'Ads (GMV Max)', icon: 'bi-megaphone',
    metrics: [
      ['ad_spend', 'Ad spend', money],
      ['roas', 'ROAS', ratio],
    ],
  },
  {
    label: 'Outreach', icon: 'bi-send',
    metrics: [
      ['sample_requests', 'Sample requests', intf],
      ['outreach_messages', 'Outreach messages', intf],
      ['collab_invites', 'Collab invites', intf],
    ],
  },
];

export default function EukaShopMetricsPage() {
  const { profile } = useAuth();
  const role = profile?.role || '';
  const isOL = role === 'ol' || role === 'boss' || role === 'developer';

  const [rows, setRows]       = useState([]);
  const [brands, setBrands]   = useState([]);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [flash, setFlash]     = useState('');
  const [rawOpen, setRawOpen] = useState({});
  const [win, setWin]         = useState({});   // per-store '7d' | '30d'

  function reload() {
    listEukaMetrics().then((r) => setRows(r || [])).catch(() => {}).finally(() => setLoading(false));
  }

  useEffect(() => {
    reload();
    if (isOL) listLinkableBrands().then(setBrands).catch(() => {});
    const unsub = subscribeEukaMetrics(reload);
    return () => unsub();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function handleSync() {
    setSyncing(true); setFlash('');
    try {
      const res = await triggerEukaSync();
      setFlash(res?.skipped
        ? 'Already synced recently — the figures are current.'
        : `Synced ${res?.synced ?? 0} store(s) from Euka.`);
      reload();
      setTimeout(() => setFlash(''), 5000);
    } catch (e) {
      setFlash('Sync failed: ' + (e.message || 'unknown'));
    } finally {
      setSyncing(false);
    }
  }

  async function handleLink(eukaStoreId, brandId) {
    if (!brandId) return;
    try {
      await linkEukaStore(eukaStoreId, brandId);
      setFlash('Brand linked — run Sync now to apply it to the figures.');
      setTimeout(() => setFlash(''), 5000);
    } catch (e) {
      setFlash('Link failed: ' + (e.message || 'unknown'));
    }
  }

  const lastSynced = useMemo(
    () => rows.reduce((a, r) => (r.synced_at > a ? r.synced_at : a), ''),
    [rows],
  );

  return (
    <div style={{ padding: '32px 32px 48px' }}>
      <div className="d-flex align-items-start justify-content-between mb-4 flex-wrap gap-2">
        <div>
          <h5 className="fw-bold mb-1 d-flex align-items-center gap-2" style={{ color: 'var(--text-primary)' }}>
            <i className="bi bi-shop-window" style={{ fontSize: '1.15rem' }} />
            TikTok Shop Metrics
          </h5>
          <p className="text-muted small mb-0">
            Per-store sales, creators, ads and outreach — synced from Euka
            {lastSynced ? ` · updated ${relTime(lastSynced)}` : ''}.
          </p>
        </div>
        {isOL && (
          <button className="btn btn-sm btn-dark d-inline-flex align-items-center gap-1"
            style={{ borderRadius: 8, fontSize: '0.8rem' }}
            onClick={handleSync} disabled={syncing}>
            {syncing
              ? <><span className="spinner-border spinner-border-sm" /> Syncing…</>
              : <><i className="bi bi-arrow-repeat" /> Sync now</>}
          </button>
        )}
      </div>

      {flash && <div className="alert alert-info py-2 small">{flash}</div>}

      {loading ? (
        <div className="d-flex align-items-center gap-2 py-5 text-muted"><span className="spinner-border spinner-border-sm" /><span className="small">Loading…</span></div>
      ) : rows.length === 0 ? (
        <div className="d-flex flex-column align-items-center justify-content-center py-5"
          style={{ border: '2px dashed var(--border-default)', borderRadius: 16, background: 'var(--surface-1)' }}>
          <div className="rounded-circle d-flex align-items-center justify-content-center mb-3"
            style={{ width: 64, height: 64, background: 'var(--surface-2)' }}>
            <i className="bi bi-shop-window text-muted" style={{ fontSize: '1.6rem', opacity: 0.4 }} />
          </div>
          <p className="fw-semibold text-dark mb-1">No shop metrics yet</p>
          <p className="text-muted small mb-2">
            {isOL ? 'Run a sync to pull figures from Euka.' : 'Figures will appear once a sync runs.'}
          </p>
        </div>
      ) : (
        <div className="row g-3">
          {rows.map((r) => {
            const period = win[r.euka_store_id] || '30d';
            const m = r.metrics || {};
            const data = period === '7d' ? (m.d7 || {}) : (m.d30 || {});
            const top = m.top || {};
            return (
              <div key={r.euka_store_id} className="col-12 col-xl-6">
                <div className="card border-0 shadow-sm h-100" style={{ borderRadius: 14 }}>
                  <div className="card-body p-3">
                    {/* Header */}
                    <div className="d-flex align-items-start justify-content-between gap-2 mb-3">
                      <div className="min-w-0">
                        <div className="fw-bold d-flex align-items-center gap-2" style={{ fontSize: '1rem', color: 'var(--text-primary)' }}>
                          <i className="bi bi-shop text-primary" />{r.store_name || 'Store'}
                          {r.region && (
                            <span className="rounded-pill px-2" style={{ background: 'var(--surface-2)', color: 'var(--text-secondary)', fontSize: '0.6rem', fontWeight: 700 }}>
                              {r.region}
                            </span>
                          )}
                        </div>
                        {r.brand?.brand_name ? (
                          <div className="text-muted mt-1" style={{ fontSize: '0.72rem' }}>
                            <i className="bi bi-link-45deg me-1" />Linked to brand: <strong>{r.brand.brand_name}</strong>
                          </div>
                        ) : isOL ? (
                          <div className="d-flex align-items-center gap-1 mt-1">
                            <span className="text-muted" style={{ fontSize: '0.72rem' }}>Not linked to a brand:</span>
                            <select className="form-select form-select-sm" style={{ borderRadius: 6, width: 'auto', fontSize: '0.72rem', padding: '1px 22px 1px 6px' }}
                              defaultValue=""
                              onChange={(e) => handleLink(r.euka_store_id, e.target.value)}>
                              <option value="">Link brand…</option>
                              {brands.map((b) => <option key={b.id} value={b.id}>{b.brand_name}</option>)}
                            </select>
                          </div>
                        ) : null}
                      </div>

                      {/* 7d / 30d toggle */}
                      <div className="btn-group btn-group-sm" role="group">
                        {['7d', '30d'].map((p) => (
                          <button key={p} type="button"
                            className="btn"
                            style={{
                              fontSize: '0.68rem', fontWeight: 700, padding: '2px 10px',
                              background: period === p ? 'var(--accent)' : 'var(--surface-2)',
                              color: period === p ? 'var(--on-accent)' : 'var(--text-secondary)',
                              border: '1px solid var(--border-subtle)',
                            }}
                            onClick={() => setWin((w) => ({ ...w, [r.euka_store_id]: p }))}>
                            {p === '7d' ? 'Last 7 days' : 'Last 30 days'}
                          </button>
                        ))}
                      </div>
                    </div>

                    {/* Metric groups */}
                    {r.metrics ? (
                      <>
                        {GROUPS.map((g) => (
                          <div key={g.label} className="mb-2">
                            <div className="text-muted mb-1 d-flex align-items-center gap-1"
                              style={{ fontSize: '0.6rem', fontWeight: 700, letterSpacing: '0.05em', textTransform: 'uppercase' }}>
                              <i className={`bi ${g.icon}`} />{g.label}
                            </div>
                            <div className="row g-2">
                              {g.metrics.map(([key, label, fmt]) => (
                                <Metric key={key} label={label} value={fmt(data[key])} />
                              ))}
                            </div>
                          </div>
                        ))}

                        {/* Top performers (last 30 days) */}
                        {(top.creator_name || top.product_name) && (
                          <div className="mb-1">
                            <div className="text-muted mb-1 d-flex align-items-center gap-1"
                              style={{ fontSize: '0.6rem', fontWeight: 700, letterSpacing: '0.05em', textTransform: 'uppercase' }}>
                              <i className="bi bi-trophy" />Top performers · 30 days
                            </div>
                            <div className="row g-2">
                              <TopItem icon="bi-person-badge" label="Top creator"
                                name={top.creator_name} value={money(top.creator_gmv)} />
                              <TopItem icon="bi-box-seam" label="Top product"
                                name={top.product_name} value={money(top.product_gmv)} />
                            </div>
                          </div>
                        )}
                      </>
                    ) : (
                      // Legacy snapshot — no metrics jsonb yet.
                      <div className="row g-2">
                        <Metric label="GMV" value={money(period === '7d' ? r.gmv_7d : r.gmv_30d)} />
                        <Metric label="Units sold" value={intf(period === '7d' ? r.units_7d : r.units_30d)} />
                        <Metric label="Orders" value={intf(period === '7d' ? r.orders_7d : r.orders_30d)} />
                      </div>
                    )}

                    {/* Footer */}
                    <div className="d-flex align-items-center justify-content-between mt-3 pt-2"
                      style={{ borderTop: '1px solid var(--border-subtle)' }}>
                      <span className="text-muted" style={{ fontSize: '0.68rem' }}>
                        <i className="bi bi-clock-history me-1" />Synced {relTime(r.synced_at)} · via Euka
                      </span>
                      {r.raw?.summary && (
                        <button className="btn btn-sm p-0 text-muted" style={{ fontSize: '0.68rem' }}
                          onClick={() => setRawOpen((o) => ({ ...o, [r.euka_store_id]: !o[r.euka_store_id] }))}>
                          {rawOpen[r.euka_store_id] ? 'Hide source' : 'Source'}
                        </button>
                      )}
                    </div>
                    {rawOpen[r.euka_store_id] && (
                      <pre className="rounded-2 p-2 mt-2 mb-0" style={{
                        background: 'var(--surface-2)', color: 'var(--text-secondary)',
                        fontSize: '0.66rem', whiteSpace: 'pre-wrap', maxHeight: 160, overflowY: 'auto',
                      }}>{r.raw.summary}</pre>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function Metric({ label, value }) {
  return (
    <div className="col-6 col-md-4">
      <div className="rounded-3 p-2 h-100" style={{ background: 'var(--surface-2)' }}>
        <div className="fw-bold" style={{ fontSize: '1rem', color: 'var(--text-primary)', lineHeight: 1.2 }}>{value}</div>
        <div className="text-muted" style={{ fontSize: '0.6rem' }}>{label}</div>
      </div>
    </div>
  );
}

function TopItem({ icon, label, name, value }) {
  return (
    <div className="col-6">
      <div className="rounded-3 p-2 h-100" style={{ background: 'var(--surface-2)' }}>
        <div className="text-muted d-flex align-items-center gap-1" style={{ fontSize: '0.6rem' }}>
          <i className={`bi ${icon}`} />{label}
        </div>
        <div className="fw-semibold text-truncate" style={{ fontSize: '0.8rem', color: 'var(--text-primary)' }} title={name || ''}>
          {name || '—'}
        </div>
        <div className="fw-bold" style={{ fontSize: '0.9rem', color: 'var(--accent)' }}>{value}</div>
      </div>
    </div>
  );
}
