import { useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  fetchCreators, PAYMENT_STATUSES, VIDEO_STATUSES, statusLabel,
} from '../../lib/paidCollabRemote';
import {
  SearchIcon, AlertIcon, RefreshIcon, MegaphoneIcon, UserIcon, CalendarIcon,
} from '../../components/common/Icon';
import {
  MonthNavigator, CreatorAvatar, TiktokHandle, currentMonthKey,
} from './_shared';
import '../../styles/table.css';
import '../../styles/paidCollab.css';

export default function PaidCollabCreatorsPage() {
  const [month, setMonth]   = useState(currentMonthKey());
  const [q, setQ]           = useState('');
  const [brand, setBrand]   = useState('all');
  const [pay, setPay]       = useState('all');
  const [vid, setVid]       = useState('all');
  const [hiredBy, setHired] = useState('all');

  const qc = useQueryClient();
  const { data: rows = [], isLoading: loading, error: queryError } = useQuery({
    queryKey: ['paid-collab', 'creators'],
    queryFn: () => fetchCreators({ force: false }),
  });
  const err  = queryError?.message || '';
  const load = async ({ force = false } = {}) => {
    if (force) { try { await fetchCreators({ force: true }); } catch {} }
    qc.invalidateQueries({ queryKey: ['paid-collab'] });
  };

  const months = useMemo(() => {
    const s = new Set(rows.map((r) => r.hiringMonth).filter(Boolean));
    return Array.from(s).sort().reverse();
  }, [rows]);

  const brands = useMemo(() => {
    const s = new Set(rows.map((r) => r.brand).filter(Boolean));
    return Array.from(s).sort();
  }, [rows]);

  const hirers = useMemo(() => {
    const s = new Set(rows.map((r) => r.hiredBy).filter(Boolean));
    return Array.from(s).sort();
  }, [rows]);

  const filtered = useMemo(() => {
    const qq = q.trim().toLowerCase();
    return rows.filter((r) => {
      if (month !== 'all' && r.hiringMonth !== month) return false;
      if (brand !== 'all' && r.brand !== brand) return false;
      if (pay   !== 'all' && r.paymentStatus !== pay) return false;
      if (vid   !== 'all' && r.videosStatus  !== vid) return false;
      if (hiredBy !== 'all' && r.hiredBy !== hiredBy) return false;
      if (qq && !(
        (r.name || '').toLowerCase().includes(qq) ||
        (r.brand || '').toLowerCase().includes(qq) ||
        (r.product || '').toLowerCase().includes(qq)
      )) return false;
      return true;
    });
  }, [rows, month, brand, pay, vid, hiredBy, q]);

  const brandsVisible = useMemo(() => new Set(filtered.map((r) => r.brand).filter(Boolean)).size, [filtered]);

  return (
    <>
      <div className="page-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: 12 }}>
        <div>
          <h1 className="page-title">Creators</h1>
          <p className="page-subtitle">
            {loading
              ? 'Loading…'
              : `${rows.length} creator${rows.length === 1 ? '' : 's'} across ${new Set(rows.map((r) => r.brand).filter(Boolean)).size} brand${rows.length === 1 ? '' : 's'}`}
          </p>
        </div>
        <button className="wx-btn wx-btn-ghost" onClick={() => load({ force: true })} disabled={loading}>
          <RefreshIcon width="15" height="15" /> Refresh
        </button>
      </div>

      <MonthNavigator month={month} onChange={setMonth} availableMonths={months} />

      <div className="pc-toolbar">
        <div className="wx-search" style={{ flex: 1, minWidth: 240 }}>
          <span className="wx-search-icon"><SearchIcon width="16" height="16" /></span>
          <input className="wx-input" placeholder="Search name, brand, product…" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <select className="wx-input" style={{ maxWidth: 170 }} value={brand} onChange={(e) => setBrand(e.target.value)}>
          <option value="all">All Brands</option>
          {brands.map((b) => <option key={b} value={b}>{b}</option>)}
        </select>
        <select className="wx-input" style={{ maxWidth: 160 }} value={pay} onChange={(e) => setPay(e.target.value)}>
          <option value="all">All Payments</option>
          {PAYMENT_STATUSES.map((s) => <option key={s.v} value={s.v}>{s.label}</option>)}
        </select>
        <select className="wx-input" style={{ maxWidth: 150 }} value={vid} onChange={(e) => setVid(e.target.value)}>
          <option value="all">All Videos</option>
          {VIDEO_STATUSES.map((s) => <option key={s.v} value={s.v}>{s.label}</option>)}
        </select>
        <select className="wx-input" style={{ maxWidth: 160 }} value={hiredBy} onChange={(e) => setHired(e.target.value)}>
          <option value="all">All Hired By</option>
          {hirers.map((h) => <option key={h} value={h}>{h}</option>)}
        </select>
      </div>

      <div style={{ fontSize: 12.5, color: 'var(--text-muted)', marginBottom: 10 }}>
        {filtered.length} creator{filtered.length === 1 ? '' : 's'}
        {brandsVisible > 0 && ` · ${brandsVisible} brand${brandsVisible === 1 ? '' : 's'}`}
      </div>

      {err && (
        <div className="wx-alert wx-alert-danger" style={{ marginBottom: 14 }}>
          <AlertIcon width="16" height="16" /> <span>{err}</span>
        </div>
      )}

      {loading ? (
        <div className="wx-empty">
          <span className="wx-spinner" style={{ color: 'var(--accent)' }} /> Loading creators…
        </div>
      ) : filtered.length === 0 ? (
        <div className="wx-empty">
          <div style={{ display: 'grid', placeItems: 'center', width: 52, height: 52, borderRadius: '50%', background: 'var(--surface-2)', color: 'var(--text-muted)', margin: '0 auto 12px' }}>
            <MegaphoneIcon width="22" height="22" />
          </div>
          <div className="wx-empty-title">No creators match</div>
          <div>Try clearing filters or the month navigator.</div>
        </div>
      ) : (
        <div className="pc-card-grid">
          {filtered.map((r) => <CreatorCard key={r.id} row={r} />)}
        </div>
      )}
    </>
  );
}

function CreatorCard({ row }) {
  const payTone = PAYMENT_STATUSES.find((s) => s.v === row.paymentStatus)?.tone || 'muted';
  const vidTone = VIDEO_STATUSES.find((s) => s.v === row.videosStatus)?.tone  || 'muted';

  return (
    <div className="pc-creator-card">
      <div className="pc-creator-card-head">
        <CreatorAvatar name={row.name} />
        <div className="pc-creator-card-body">
          <div className="pc-creator-card-name">{row.name}</div>
          <div className="pc-creator-card-sub">{row.brand || '—'}</div>
        </div>
        <TiktokHandle handle={row.tiktokAccount} />
      </div>

      <div className="pc-creator-card-stats">
        <div className="pc-card-kv">
          <div className="pc-card-kv-k">Deal</div>
          <div className="pc-card-kv-v">{row.deal || '—'}</div>
        </div>
        <div className="pc-card-kv" style={{ textAlign: 'right' }}>
          <div className="pc-card-kv-k">Product</div>
          <div className="pc-card-kv-v is-sm">{row.product || '—'}</div>
        </div>
      </div>

      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 10 }}>
        <span className={`pc-pill pc-pill-${payTone}`}>{statusLabel(PAYMENT_STATUSES, row.paymentStatus)}</span>
        <span className={`pc-pill pc-pill-${vidTone}`}>{statusLabel(VIDEO_STATUSES,  row.videosStatus)}</span>
      </div>

      <div className="pc-creator-card-footer">
        <span>
          <UserIcon width="13" height="13" />
          {row.hiredBy || '—'}
        </span>
        <span>
          <CalendarIcon width="13" height="13" />
          {row.hiringDate || '—'}
        </span>
      </div>
    </div>
  );
}
