import { useEffect, useMemo, useState } from 'react';
import { fetchCreators } from '../../lib/paidCollabRemote';
import {
  UsersIcon, StoreIcon, VideoIcon, ChartIcon, AlertIcon,
} from '../../components/common/Icon';
import '../../styles/paidCollab.css';

/**
 * PCTL Paid Collab Dashboard.
 *
 * Mirrors v1's PCTLDashboard with the unique-creator vs deal-records
 * distinction (the v1 fix from commit 7714294). Counts:
 *   * Unique Creators — dedupe by tiktok handle, fall back to name.
 *   * Brands         — distinct brand names.
 *   * Deal Value     — sum of dealAmount across all rows in the period.
 *   * Videos Posted  — sum of videoCodes.length across all rows.
 *
 * Top Brands lists each brand's unique-creator count, deal-record count
 * and total $ (sorted by deals desc).
 *
 * PCTL-only — wired into menu.js and routed in App.jsx.
 */
export default function PaidCollabDashboardPage() {
  const [creators, setCreators] = useState([]);
  const [loading, setLoading]   = useState(true);
  const [error, setError]       = useState('');
  const [month, setMonth]       = useState('all');

  useEffect(() => {
    let cancelled = false;
    fetchCreators()
      .then((data) => { if (!cancelled) { setCreators(data); setLoading(false); } })
      .catch((err)  => { if (!cancelled) { setError(err.message || String(err)); setLoading(false); } });
    return () => { cancelled = true; };
  }, []);

  const months = useMemo(() => {
    const s = new Set(creators.map((c) => c.hiringMonth).filter(Boolean));
    return Array.from(s).sort().reverse();
  }, [creators]);

  const filtered = useMemo(() => {
    if (month === 'all') return creators;
    return creators.filter((c) => c.hiringMonth === month);
  }, [creators, month]);

  // Stats — count unique creators (tiktok handle) separately from total deal records.
  const stats = useMemo(() => {
    const uniqKeys = new Set();
    let videosPosted = 0;
    let totalDeal    = 0;
    let paid = 0, pending = 0, notYet = 0, paymentUnknown = 0;
    let videosDone = 0, videosInProgress = 0, videosNotYet = 0, videosUnknown = 0;
    const brandSet = new Set();

    filtered.forEach((c) => {
      const handle = (c.tiktokAccount || '').toLowerCase().replace(/\/+$/, '').trim();
      const key = handle || `name:${(c.name || '').toLowerCase().trim()}`;
      if (key && key !== 'name:') uniqKeys.add(key);

      videosPosted += Array.isArray(c.videoCodes) ? c.videoCodes.length : 0;
      totalDeal    += Number(c.dealAmount || 0);

      if (c.brand) brandSet.add(c.brand.trim());

      switch (c.paymentStatus) {
        case 'paid':    paid++;    break;
        case 'pending': pending++; break;
        case 'not_yet': notYet++;  break;
        default:        paymentUnknown++; break;
      }
      switch (c.videosStatus) {
        case 'done':        videosDone++;       break;
        case 'in_progress': videosInProgress++; break;
        case 'not_yet':     videosNotYet++;     break;
        default:            videosUnknown++;    break;
      }
    });

    return {
      uniqueCreators:     uniqKeys.size,
      totalDealRecords:   filtered.length,
      totalBrands:        brandSet.size,
      totalDeal,
      videosPosted,
      paid, pending, notYetPaid: notYet, paymentUnknown,
      creatorsDone:       videosDone,
      creatorsInProgress: videosInProgress,
      creatorsNotYet:     videosNotYet,
      videosUnknown,
      totalCreators:      filtered.length,
    };
  }, [filtered]);

  // Top brands — unique-creator dedupe + deal count + $ sum.
  const topBrands = useMemo(() => {
    const byBrand = new Map();
    filtered.forEach((c) => {
      const name = (c.brand || '').trim();
      if (!name) return;
      if (!byBrand.has(name)) byBrand.set(name, []);
      byBrand.get(name).push(c);
    });
    return [...byBrand.entries()]
      .map(([name, list]) => {
        const uniq = new Set();
        list.forEach((c) => {
          const handle = (c.tiktokAccount || '').toLowerCase().replace(/\/+$/, '').trim();
          const key = handle || `name:${(c.name || '').toLowerCase().trim()}`;
          if (key && key !== 'name:') uniq.add(key);
        });
        return {
          name,
          creators: uniq.size,
          deals:    list.length,
          deal:     list.reduce((s, c) => s + Number(c.dealAmount || 0), 0),
        };
      })
      .sort((a, b) => b.deals - a.deals)
      .slice(0, 8);
  }, [filtered]);

  // Recent creators — sorted by hiringDate desc.
  const recent = useMemo(() => {
    return [...filtered]
      .sort((a, b) => (b.hiringDate || '').localeCompare(a.hiringDate || ''))
      .slice(0, 6);
  }, [filtered]);

  const monthLabel = (m) => {
    if (!m || m === 'all') return 'All time';
    const [y, mo] = m.split('-').map(Number);
    return new Date(y, mo - 1, 1).toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
  };

  if (loading) {
    return (
      <>
        <div className="page-header">
          <h1 className="page-title">Paid Collab Dashboard</h1>
        </div>
        <div className="wx-empty"><span className="wx-spinner" /> Loading paid collab data…</div>
      </>
    );
  }
  if (error) {
    return (
      <>
        <div className="page-header">
          <h1 className="page-title">Paid Collab Dashboard</h1>
        </div>
        <div className="wx-alert wx-alert-danger">
          <AlertIcon width="16" height="16" /> <span>{error}</span>
        </div>
      </>
    );
  }

  return (
    <>
      <div className="page-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: 12 }}>
        <div>
          <h1 className="page-title">Paid Collab Dashboard</h1>
          <p className="page-subtitle">Overview of creator partnerships &amp; deals</p>
        </div>
        <select className="wx-input" value={month} onChange={(e) => setMonth(e.target.value)}
          style={{ maxWidth: 240 }}>
          <option value="all">All Time ({creators.length} deals)</option>
          {months.map((m) => <option key={m} value={m}>{monthLabel(m)}</option>)}
        </select>
      </div>

      {/* Stats row */}
      <div style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(min(220px, 100%), 1fr))',
        gap: 12, marginBottom: 16,
      }}>
        <StatCard
          icon={<UsersIcon width="20" height="20" />}
          label="Unique Creators"
          value={stats.uniqueCreators.toLocaleString()}
          tone="#3b82f6"
          sub={`${stats.totalDealRecords} deals across ${stats.totalBrands} brands`}
        />
        <StatCard
          icon={<StoreIcon width="20" height="20" />}
          label="Brands"
          value={stats.totalBrands.toLocaleString()}
          tone="#8b5cf6"
        />
        <StatCard
          icon={<ChartIcon width="20" height="20" />}
          label="Deal Value"
          value={`$${stats.totalDeal.toLocaleString()}`}
          tone="#10b981"
          sub={`${stats.totalDealRecords} deals total`}
        />
        <StatCard
          icon={<VideoIcon width="20" height="20" />}
          label="Videos Posted"
          value={stats.videosPosted.toLocaleString()}
          tone="#f59e0b"
          sub={`${stats.creatorsDone} of ${stats.totalDealRecords} deals done · ${stats.creatorsInProgress} in progress`}
        />
      </div>

      {/* Progress bars */}
      <div style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(min(320px, 100%), 1fr))',
        gap: 12, marginBottom: 16,
      }}>
        <div className="wx-card" style={{ padding: 14 }}>
          <h6 style={{ margin: 0, fontSize: 13, fontWeight: 700, color: 'var(--text-primary)', marginBottom: 12 }}>
            Payment Status
          </h6>
          <StatusBar label="Paid"     done={stats.paid}        total={stats.totalCreators} color="#10b981" />
          {stats.pending > 0 && (
            <StatusBar label="Pending" done={stats.pending}    total={stats.totalCreators} color="#f59e0b" />
          )}
          <StatusBar label="Not Yet"  done={stats.notYetPaid}  total={stats.totalCreators} color="#94a3b8" />
          {stats.paymentUnknown > 0 && (
            <StatusBar label="Unknown" done={stats.paymentUnknown} total={stats.totalCreators} color="#cbd5e1" />
          )}
        </div>
        <div className="wx-card" style={{ padding: 14 }}>
          <h6 style={{ margin: 0, fontSize: 13, fontWeight: 700, color: 'var(--text-primary)', marginBottom: 12 }}>
            Video Delivery
          </h6>
          <StatusBar label="Done"        done={stats.creatorsDone}       total={stats.totalCreators} color="#10b981" />
          <StatusBar label="In Progress" done={stats.creatorsInProgress} total={stats.totalCreators} color="#3b82f6" />
          {stats.creatorsNotYet > 0 && (
            <StatusBar label="Not Yet"   done={stats.creatorsNotYet}     total={stats.totalCreators} color="#94a3b8" />
          )}
          {stats.videosUnknown > 0 && (
            <StatusBar label="Unknown"   done={stats.videosUnknown}      total={stats.totalCreators} color="#cbd5e1" />
          )}
        </div>
      </div>

      {/* Top Brands + Recent Creators */}
      <div style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(min(320px, 100%), 1fr))',
        gap: 12,
      }}>
        <div className="wx-card" style={{ padding: 14 }}>
          <h6 style={{ margin: 0, fontSize: 13, fontWeight: 700, color: 'var(--text-primary)', marginBottom: 12 }}>
            Top Brands
          </h6>
          {topBrands.length === 0 ? (
            <div style={{ color: 'var(--text-muted)', fontSize: 12.5 }}>No brands found.</div>
          ) : topBrands.map((b, i) => (
            <div key={b.name} style={{
              display: 'flex', alignItems: 'center', justifyContent: 'space-between',
              padding: '8px 0',
              borderBottom: i < topBrands.length - 1 ? '1px solid var(--border-subtle)' : 'none',
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
                <span style={{
                  width: 28, height: 28, borderRadius: 6,
                  display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                  flexShrink: 0,
                  fontSize: 10, fontWeight: 700, color: '#fff',
                  background: ['#3b82f6','#8b5cf6','#10b981','#f59e0b','#ef4444','#06b6d4','#ec4899','#6366f1'][i % 8],
                }}>
                  {b.name.slice(0, 2).toUpperCase()}
                </span>
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontWeight: 600, fontSize: 13, color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {b.name}
                  </div>
                  <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                    {b.creators} creator{b.creators !== 1 ? 's' : ''} · {b.deals} deal{b.deals !== 1 ? 's' : ''}
                  </div>
                </div>
              </div>
              <span style={{ fontWeight: 700, color: '#10b981', fontSize: 12.5, fontVariantNumeric: 'tabular-nums' }}>
                ${b.deal.toLocaleString()}
              </span>
            </div>
          ))}
        </div>

        <div className="wx-card" style={{ padding: 14 }}>
          <h6 style={{ margin: 0, fontSize: 13, fontWeight: 700, color: 'var(--text-primary)', marginBottom: 12 }}>
            Recent Creators
          </h6>
          {recent.length === 0 ? (
            <div style={{ color: 'var(--text-muted)', fontSize: 12.5 }}>No creators found.</div>
          ) : recent.map((c, i) => (
            <div key={c.id} style={{
              display: 'flex', alignItems: 'center', justifyContent: 'space-between',
              padding: '8px 0', gap: 8,
              borderBottom: i < recent.length - 1 ? '1px solid var(--border-subtle)' : 'none',
            }}>
              <div style={{ minWidth: 0 }}>
                <div style={{ fontWeight: 600, fontSize: 13, color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {c.name}
                </div>
                <div style={{ fontSize: 11, color: 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {c.brand || '—'} · {c.product || '—'}
                </div>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
                <Pill status={c.paymentStatus} kind="payment" />
                <Pill status={c.videosStatus}  kind="videos" />
              </div>
            </div>
          ))}
        </div>
      </div>
    </>
  );
}

// ============================================================
// Sub-components
// ============================================================
function StatCard({ icon, label, value, tone, sub }) {
  return (
    <div className="wx-card" style={{ padding: 14, display: 'flex', alignItems: 'center', gap: 12 }}>
      <div style={{
        width: 44, height: 44, borderRadius: 12,
        background: tone + '18', color: tone,
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        flexShrink: 0,
      }}>
        {icon}
      </div>
      <div style={{ minWidth: 0 }}>
        <div style={{ fontSize: 22, fontWeight: 700, color: 'var(--text-primary)', lineHeight: 1.1, fontVariantNumeric: 'tabular-nums' }}>
          {value}
        </div>
        <div style={{ fontSize: 11.5, color: 'var(--text-secondary)', fontWeight: 600, marginTop: 2 }}>{label}</div>
        {sub && <div style={{ fontSize: 10.5, color: 'var(--text-muted)', marginTop: 1 }}>{sub}</div>}
      </div>
    </div>
  );
}

function StatusBar({ label, done, total, color }) {
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;
  return (
    <div style={{ marginBottom: 8 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4, fontSize: 11.5 }}>
        <span style={{ fontWeight: 600, color: 'var(--text-primary)' }}>{label}</span>
        <span style={{ color: 'var(--text-muted)' }}>{done}/{total} ({pct}%)</span>
      </div>
      <div style={{ height: 6, background: 'var(--surface-2)', borderRadius: 999, overflow: 'hidden' }}>
        <div style={{ height: '100%', width: `${pct}%`, background: color, borderRadius: 999, transition: 'width 0.6s ease' }} />
      </div>
    </div>
  );
}

function Pill({ status, kind }) {
  // kind = 'payment' | 'videos'
  const map = kind === 'payment' ? {
    paid:    { bg: '#dcfce7', fg: '#166534', label: 'Paid' },
    pending: { bg: '#fef3c7', fg: '#92400e', label: 'Pending' },
    not_yet: { bg: '#f3f4f6', fg: '#475569', label: 'Not yet' },
  } : {
    done:        { bg: '#dcfce7', fg: '#166534', label: 'Done' },
    in_progress: { bg: '#dbeafe', fg: '#1e40af', label: 'In progress' },
    not_yet:     { bg: '#f3f4f6', fg: '#475569', label: 'Not yet' },
  };
  const meta = map[status] || { bg: '#f3f4f6', fg: '#475569', label: '—' };
  return (
    <span style={{
      padding: '2px 8px', borderRadius: 999,
      fontSize: 10, fontWeight: 700,
      background: meta.bg, color: meta.fg,
      whiteSpace: 'nowrap',
    }}>{meta.label}</span>
  );
}
