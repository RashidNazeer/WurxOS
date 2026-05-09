import { useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { listBrandSwitchRequests, decideBrandSwitch, cancelBrandSwitch } from '../../lib/brandSwitchApi';
import { useAuth } from '../../contexts/AuthContext';
import BrandAvatar from '../../components/brands/BrandAvatar';
import {
  RefreshIcon, CheckIcon, XIcon, AlertIcon,
} from '../../components/common/Icon';
import '../../styles/table.css';

export default function BrandSwitchRequestsPage() {
  const { profile, user } = useAuth();
  const isBoss = profile?.role === 'boss';

  const [tab, setTab]         = useState('pending');
  const [localErr, setLocalErr] = useState('');

  const qc = useQueryClient();
  const { data: rows = [], isLoading: loading, error: queryError } = useQuery({
    queryKey: ['brand-switch-requests'],
    queryFn: () => listBrandSwitchRequests(),
  });
  const err  = localErr || queryError?.message || '';
  const load = () => qc.invalidateQueries({ queryKey: ['brand-switch-requests'] });

  const filtered = useMemo(
    () => rows.filter((r) => tab === 'pending' ? r.status === 'pending' : r.status !== 'pending'),
    [rows, tab],
  );
  const pendingCount = rows.filter((r) => r.status === 'pending').length;

  async function decide(row, approve) {
    const note = approve ? '' : (prompt('Rejection note (optional):') || '');
    if (!approve && note === null) return;
    try { await decideBrandSwitch(row.id, { approve, note }); load(); }
    catch (e) { setLocalErr(e.message); }
  }

  async function cancelRow(row) {
    if (!confirm('Cancel this request?')) return;
    try { await cancelBrandSwitch(row.id); load(); }
    catch (e) { setLocalErr(e.message); }
  }

  return (
    <>
      <div className="page-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: 12 }}>
        <div>
          <h1 className="page-title">Brand switch requests</h1>
          <p className="page-subtitle">
            {isBoss
              ? `${pendingCount} pending · you decide`
              : `Your submitted requests and recent decisions`}
          </p>
        </div>
        <button className="wx-btn wx-btn-ghost" onClick={load} disabled={loading}>
          <RefreshIcon width="15" height="15" />
        </button>
      </div>

      <div className="task-tabs" style={{ marginBottom: 14 }}>
        <button type="button" className={`task-tab ${tab === 'pending' ? 'task-tab-active' : ''}`} onClick={() => setTab('pending')}>
          Pending <span className="task-tab-count">{pendingCount}</span>
        </button>
        <button type="button" className={`task-tab ${tab === 'recent' ? 'task-tab-active' : ''}`} onClick={() => setTab('recent')}>
          Recent <span className="task-tab-count">{rows.length - pendingCount}</span>
        </button>
      </div>

      {err && (
        <div className="wx-alert wx-alert-danger" style={{ marginBottom: 14 }}>
          <AlertIcon width="16" height="16" /> <span>{err}</span>
        </div>
      )}

      <div className="wx-list">
        <div className="wx-list-row wx-list-header" style={{ gridTemplateColumns: '1.4fr 1.2fr 1.2fr 1.4fr 170px' }}>
          <div>Brand</div><div>From</div><div>To</div><div>Reason</div><div>Action</div>
        </div>
        {loading ? (
          <div className="wx-empty"><span className="wx-spinner" /> Loading…</div>
        ) : filtered.length === 0 ? (
          <div className="wx-empty">
            <div className="wx-empty-title">Nothing here</div>
            <div>{tab === 'pending' ? 'No pending requests.' : 'No recent decisions.'}</div>
          </div>
        ) : filtered.map((r) => (
          <RequestRow key={r.id} row={r} isBoss={isBoss} currentUserId={user?.id}
            onDecide={decide} onCancel={() => cancelRow(r)} />
        ))}
      </div>
    </>
  );
}

function RequestRow({ row, isBoss, currentUserId, onDecide, onCancel }) {
  const isPending = row.status === 'pending';
  const canCancel = isPending && row.requested_by === currentUserId;
  return (
    <div className="wx-list-row" style={{ gridTemplateColumns: '1.4fr 1.2fr 1.2fr 1.4fr 170px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <BrandAvatar brand={row.brand} size={28} radius={6} />
        <div>
          <div style={{ fontWeight: 700, fontSize: 13 }}>{row.brand?.brand_name || '—'}</div>
          <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
            by {row.requester?.display_name || '—'}
          </div>
        </div>
      </div>
      <div style={{ fontSize: 12.5 }}>{row.from_owner?.display_name || '—'}</div>
      <div style={{ fontSize: 12.5, fontWeight: 600 }}>{row.to_owner?.display_name || '—'}</div>
      <div style={{ fontSize: 12.5, color: 'var(--text-secondary)', wordBreak: 'break-word' }}>
        {row.reason || <span style={{ color: 'var(--text-muted)' }}>—</span>}
        {row.decision_note && (
          <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 3, fontStyle: 'italic' }}>
            "{row.decision_note}"
          </div>
        )}
      </div>
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 6 }}>
        {isPending && isBoss ? (
          <>
            <button className="wx-btn wx-btn-primary" onClick={() => onDecide(row, true)} style={{ padding: '5px 10px', fontSize: 12 }}>
              <CheckIcon width="12" height="12" /> Approve
            </button>
            <button className="wx-btn wx-btn-ghost" onClick={() => onDecide(row, false)} style={{ padding: '5px 10px', fontSize: 12 }}>
              <XIcon width="12" height="12" /> Reject
            </button>
          </>
        ) : canCancel ? (
          <button className="wx-btn wx-btn-ghost" onClick={onCancel} style={{ padding: '5px 10px', fontSize: 12 }}>
            <XIcon width="12" height="12" /> Cancel
          </button>
        ) : (
          <span style={{
            fontSize: 11, fontWeight: 700, textTransform: 'capitalize',
            padding: '3px 9px', borderRadius: 'var(--radius-pill)',
            background: row.status === 'approved' ? 'color-mix(in srgb, var(--success) 18%, transparent)'
                      : row.status === 'rejected' ? 'color-mix(in srgb, var(--danger) 18%, transparent)'
                      : 'var(--surface-3)',
            color:      row.status === 'approved' ? 'var(--success)'
                      : row.status === 'rejected' ? 'var(--danger)'
                      : 'var(--text-muted)',
          }}>{row.status}</span>
        )}
      </div>
    </div>
  );
}
