import { useEffect, useMemo, useState } from 'react';
import { fetchCreators } from '../../lib/paidCollabRemote';

/**
 * Public paid-collab viewer. The portal RPC returns the brand list; we
 * fetch the actual creator/video data from the external wurx-base API
 * client-side and filter to the permitted brands.
 */
export default function ClientPaidCollabSection({ brands = [] }) {
  const [creators, setCreators] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const allowed = useMemo(() => new Set(brands.map(b => b.brand_name.toLowerCase().trim())), [brands]);

  useEffect(() => {
    let cancelled = false;
    fetchCreators()
      .then((all) => {
        if (cancelled) return;
        const filtered = all.filter(c => {
          const brandName = (c.brand || '').toLowerCase().trim();
          return allowed.has(brandName);
        });
        setCreators(filtered);
      })
      .catch((e) => { if (!cancelled) setError(e.message || 'Could not load.'); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [allowed]);

  const stats = useMemo(() => {
    const totals = {
      creators: creators.length,
      brands: new Set(creators.map(c => c.brand)).size,
      paid: creators.filter(c => (c.payment || '').toLowerCase() === 'paid').length,
      pending: creators.filter(c => (c.payment || '').toLowerCase() === 'pending').length,
      videosDone: creators.filter(c => (c.videoStatus || '').toLowerCase() === 'done').length,
      totalAmount: creators.reduce((s, c) => s + (Number(c.dealAmount) || 0), 0),
    };
    return totals;
  }, [creators]);

  if (loading) {
    return <div className="wx-empty"><span className="wx-spinner" /> Loading paid-collab data…</div>;
  }
  if (error) {
    return <div className="wx-alert wx-alert-danger">{error}</div>;
  }
  if (creators.length === 0) {
    return (
      <div className="wx-card" style={{ padding: 32, textAlign: 'center' }}>
        <div style={{ fontSize: 28, opacity: 0.4 }}>🎬</div>
        <div style={{ fontWeight: 700, marginTop: 8, color: 'var(--text-secondary)' }}>No creators on file yet</div>
        <p style={{ color: 'var(--text-muted)', fontSize: 12.5, margin: '4px 0 0' }}>
          Paid-collab activity for your brands will appear here as it's logged.
        </p>
      </div>
    );
  }

  return (
    <div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))', gap: 12, marginBottom: 18 }}>
        <Stat label="Creators" value={stats.creators} tint="#3b82f6" />
        <Stat label="Brands" value={stats.brands} tint="#8b5cf6" />
        <Stat label="Paid" value={stats.paid} tint="#16a34a" />
        <Stat label="Pending" value={stats.pending} tint="#f59e0b" />
        <Stat label="Videos done" value={stats.videosDone} tint="#0ea5e9" />
        <Stat label="Total deals" value={`$${stats.totalAmount.toLocaleString('en-US')}`} tint="#ec4899" />
      </div>

      <div className="wx-card" style={{ padding: 0, overflow: 'hidden' }}>
        <div style={{ padding: 14, borderBottom: '1px solid var(--border)', fontSize: 13, fontWeight: 800 }}>
          Creators ({creators.length})
        </div>
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12.5 }}>
            <thead>
              <tr style={{ background: 'var(--surface-2)', textTransform: 'uppercase', fontSize: 10.5, letterSpacing: '0.05em', color: 'var(--text-muted)' }}>
                <Th>Creator</Th>
                <Th>Brand</Th>
                <Th>Deal</Th>
                <Th>Payment</Th>
                <Th>Video</Th>
                <Th>Hired</Th>
              </tr>
            </thead>
            <tbody>
              {creators.map((c, i) => (
                <tr key={c.id || i} style={{ borderTop: '1px solid var(--border)' }}>
                  <Td><strong>{c.name}</strong>{c.tiktokAccount && <div style={{ color: 'var(--text-muted)', fontSize: 11 }}>{c.tiktokAccount}</div>}</Td>
                  <Td>{c.brand}</Td>
                  <Td>{c.deal || '—'}</Td>
                  <Td><PayBadge value={c.payment} /></Td>
                  <Td><VidBadge value={c.videoStatus} link={c.videoLink} /></Td>
                  <Td>{c.hiringDate || '—'}</Td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

function Stat({ label, value, tint }) {
  return (
    <div className="wx-card" style={{ padding: 14, borderRadius: 12 }}>
      <div style={{ fontSize: 10.5, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.06em', fontWeight: 700, marginBottom: 6 }}>
        {label}
      </div>
      <div style={{ fontSize: 22, fontWeight: 800, color: tint, letterSpacing: '-0.02em' }}>{value}</div>
    </div>
  );
}

function Th({ children }) { return <th style={{ padding: '10px 14px', textAlign: 'left', fontWeight: 700 }}>{children}</th>; }
function Td({ children }) { return <td style={{ padding: '10px 14px', verticalAlign: 'top' }}>{children}</td>; }

function PayBadge({ value }) {
  const v = (value || '').toLowerCase();
  const cfg = v === 'paid'    ? { bg: '#dcfce7', fg: '#16a34a' }
            : v === 'pending' ? { bg: '#fef3c7', fg: '#d97706' }
                              : { bg: '#f1f5f9', fg: '#64748b' };
  return <span style={{ ...cfgToCss(cfg), padding: '2px 8px', borderRadius: 999, fontSize: 11, fontWeight: 700 }}>{value || 'Not Yet'}</span>;
}
function VidBadge({ value, link }) {
  const v = (value || '').toLowerCase();
  const cfg = v === 'done'        ? { bg: '#dcfce7', fg: '#16a34a' }
            : v === 'in progress' ? { bg: '#dbeafe', fg: '#2563eb' }
                                  : { bg: '#f1f5f9', fg: '#64748b' };
  const label = value || 'Not Yet';
  if (link) {
    return <a href={link} target="_blank" rel="noopener noreferrer" style={{ ...cfgToCss(cfg), padding: '2px 8px', borderRadius: 999, fontSize: 11, fontWeight: 700, textDecoration: 'none' }}>{label} ↗</a>;
  }
  return <span style={{ ...cfgToCss(cfg), padding: '2px 8px', borderRadius: 999, fontSize: 11, fontWeight: 700 }}>{label}</span>;
}
function cfgToCss(cfg) { return { background: cfg.bg, color: cfg.fg }; }
