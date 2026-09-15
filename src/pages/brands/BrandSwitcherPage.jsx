import { useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { listBrands } from '../../lib/brandsApi';
import { listBrandSwitchRequests, decideBrandSwitch, cancelBrandSwitch } from '../../lib/brandSwitchApi';
import { useAuth } from '../../contexts/AuthContext';
import BrandAvatar from '../../components/brands/BrandAvatar';
import SwitchApcModal from '../../components/brands/SwitchApcModal';
import {
  RefreshIcon, CheckIcon, XIcon, AlertIcon, SearchIcon, UsersIcon,
  ChecklistIcon, StoreIcon,
} from '../../components/common/Icon';
import '../../styles/brandSwitcher.css';

/**
 * Brand Switcher — central hub for Boss and OL to move a brand
 * between APCs. Boss acts directly; OL can switch directly or
 * request Boss approval. A second tab shows the request queue.
 */
export default function BrandSwitcherPage() {
  const { profile, user } = useAuth();
  const role   = profile?.role;
  const isBoss = role === 'boss';
  const qc = useQueryClient();

  const [tab, setTab] = useState('brands');
  const [q, setQ] = useState('');
  const [switchBrand, setSwitchBrand] = useState(null);
  const [localErr, setLocalErr] = useState('');

  const { data: brands = [], isLoading: brandsLoading } = useQuery({
    queryKey: ['brands', { status: 'active' }],
    queryFn: () => listBrands({ status: 'active' }),
  });

  const { data: requests = [], isLoading: reqLoading } = useQuery({
    queryKey: ['brand-switch-requests'],
    queryFn: () => listBrandSwitchRequests(),
  });

  const pending = useMemo(() => requests.filter((r) => r.status === 'pending'), [requests]);
  const history = useMemo(() => requests.filter((r) => r.status !== 'pending'), [requests]);

  const filteredBrands = useMemo(() => {
    const qq = q.trim().toLowerCase();
    if (!qq) return brands;
    return brands.filter((b) => {
      const names = [
        b.brand_name, b.client_name, b.owner?.display_name,
        ...(b.assignedUsers || []).map((u) => u.display_name),
      ].filter(Boolean).join(' ').toLowerCase();
      return names.includes(qq);
    });
  }, [brands, q]);

  async function decide(row, approve) {
    // Approving used to be one click with no confirmation, on a row that did
    // not say what would happen. Now that a request is either an Assign (one
    // brand) or a Swap (two whole portfolios), the Boss must see which before
    // committing — they are very different amounts of change.
    if (approve && row.to_apc_id) {
      const brandName = row.brand?.brand_name || 'this brand';
      const target = row.to_apc?.display_name || 'the new APC';
      const msg = requestMode(row) === 'swap'
        ? `Approve SWAP for "${brandName}"?\n\n${target} and whoever currently holds this brand will EXCHANGE THEIR WHOLE BRAND PORTFOLIOS.\n\nThis is applied to the assignments as they are now, not as they were when the request was made.`
        : `Approve ASSIGN for "${brandName}"?\n\n${target} gets this brand and keeps every brand they already have. The current APC loses only this one.`;
      if (!confirm(msg)) return;
    }
    const note = approve ? '' : (prompt('Rejection note (optional):') || '');
    if (!approve && note === null) return;
    try {
      await decideBrandSwitch(row.id, { approve, note });
      qc.invalidateQueries({ queryKey: ['brand-switch-requests'] });
      qc.invalidateQueries({ queryKey: ['brands'] });
    } catch (e) { setLocalErr(e.message); }
  }
  async function cancelRow(row) {
    if (!confirm('Cancel this request?')) return;
    try {
      await cancelBrandSwitch(row.id);
      qc.invalidateQueries({ queryKey: ['brand-switch-requests'] });
    } catch (e) { setLocalErr(e.message); }
  }

  const err = localErr;

  return (
    <>
      {/* Hero */}
      <div className="bsw-hero">
        <div style={{ position: 'relative', zIndex: 1 }}>
          <div className="bsw-hero-title">Brand Switcher</div>
          <div className="bsw-hero-sub">
            Reassign any brand to a different APC.{' '}
            {isBoss
              ? 'Your changes take effect instantly.'
              : 'Switch directly when you have authority, or request Boss approval.'}
          </div>
        </div>
        <div className="bsw-stat">
          <div className="bsw-stat-num">{pending.length}</div>
          <div className="bsw-stat-label">Pending</div>
          <div className="bsw-stat-sub">
            {isBoss ? 'Awaiting your decision' : 'Awaiting Boss decision'}
          </div>
        </div>
      </div>

      {/* Tabs */}
      <div className="wx-seg" style={{ marginBottom: 14 }}>
        <button type="button" className={`wx-seg-btn ${tab === 'brands' ? 'is-active' : ''}`}
          onClick={() => setTab('brands')}>
          <StoreIcon width="13" height="13" /> All brands
        </button>
        <button type="button" className={`wx-seg-btn ${tab === 'pending' ? 'is-active' : ''}`}
          onClick={() => setTab('pending')}>
          Pending {pending.length > 0 && <span style={{
            marginLeft: 6, padding: '1px 7px', borderRadius: 999,
            background: 'color-mix(in srgb, var(--accent) 22%, transparent)',
            color: 'var(--accent)', fontSize: 10.5,
          }}>{pending.length}</span>}
        </button>
        <button type="button" className={`wx-seg-btn ${tab === 'history' ? 'is-active' : ''}`}
          onClick={() => setTab('history')}>
          History
        </button>
      </div>

      {err && (
        <div className="wx-alert wx-alert-danger" style={{ marginBottom: 14 }}>
          <AlertIcon width="16" height="16" /> <span>{err}</span>
        </div>
      )}

      {/* All brands tab */}
      {tab === 'brands' && (
        <>
          <div className="bsw-toolbar">
            <div className="wx-search">
              <span className="wx-search-icon"><SearchIcon width="14" height="14" /></span>
              <input className="wx-input"
                placeholder="Search by brand, client, APC, or TL…"
                value={q} onChange={(e) => setQ(e.target.value)} />
            </div>
            <div className="bsw-section-title" style={{ marginLeft: 'auto' }}>
              <strong>{filteredBrands.length}</strong> of {brands.length}
            </div>
          </div>

          {brandsLoading ? (
            <div className="bsw-empty"><span className="wx-spinner" /> Loading brands…</div>
          ) : filteredBrands.length === 0 ? (
            <div className="bsw-empty">
              <div className="bsw-empty-title">No brands match</div>
              <div>{q ? 'Try a different search.' : 'No active brands found.'}</div>
            </div>
          ) : (
            <div>
              {filteredBrands.map((b) => (
                <BrandRow key={b.id} brand={b}
                  onSwitch={() => setSwitchBrand(b)} />
              ))}
            </div>
          )}
        </>
      )}

      {/* Pending tab */}
      {tab === 'pending' && (
        <RequestList
          rows={pending}
          loading={reqLoading}
          emptyText={isBoss ? 'No pending requests to review.' : 'You have no pending requests.'}
          isBoss={isBoss}
          currentUserId={user?.id}
          onDecide={decide}
          onCancel={cancelRow} />
      )}

      {/* History tab */}
      {tab === 'history' && (
        <RequestList
          rows={history}
          loading={reqLoading}
          emptyText="No resolved requests yet."
          isBoss={isBoss}
          currentUserId={user?.id}
          onDecide={decide}
          onCancel={cancelRow} />
      )}

      {/* Switch modal */}
      {switchBrand && (
        <SwitchApcModal
          brand={switchBrand}
          onClose={() => setSwitchBrand(null)}
          onDone={(mode) => {
            setSwitchBrand(null);
            qc.invalidateQueries({ queryKey: ['brands'] });
            qc.invalidateQueries({ queryKey: ['brand-switch-requests'] });
            if (mode === 'request') setTab('pending');
          }} />
      )}
    </>
  );
}

// ============================================================
function BrandRow({ brand, onSwitch }) {
  const owner   = brand.owner;
  const apcs    = brand.assignedUsers || [];
  const primary = apcs[0];

  return (
    <div className="bsw-row">
      <BrandAvatar brand={brand} size={40} radius={10} />
      <div style={{ minWidth: 0 }}>
        <div className="bsw-row-name">{brand.brand_name}</div>
        <div className="bsw-row-sub">
          {brand.client_name || <span style={{ color: 'var(--text-muted)' }}>No client set</span>}
          {brand.tier && <> · <strong style={{ color: 'var(--text-secondary)' }}>{brand.tier}</strong></>}
        </div>
      </div>
      <div className="bsw-row-to">
        {primary ? (
          <div className="bsw-row-chip">
            <Avatar user={primary} size={22} />
            <div style={{ minWidth: 0 }}>
              <div style={{ fontWeight: 700, fontSize: 12.5 }}>{primary.display_name}</div>
              <div style={{ fontSize: 10.5, color: 'var(--text-muted)', fontWeight: 700, letterSpacing: '0.05em' }}>
                {(primary.role || 'APC').toUpperCase()}{apcs.length > 1 ? ` +${apcs.length - 1}` : ''}
              </div>
            </div>
          </div>
        ) : (
          <div className="bsw-row-chip is-empty">No APC assigned</div>
        )}
      </div>
      <div className="bsw-row-tl">
        {owner ? (
          <div className="bsw-row-chip">
            <Avatar user={owner} size={22} />
            <div style={{ minWidth: 0 }}>
              <div style={{ fontWeight: 700, fontSize: 12.5 }}>{owner.display_name}</div>
              <div style={{ fontSize: 10.5, color: 'var(--text-muted)', fontWeight: 700, letterSpacing: '0.05em' }}>TL</div>
            </div>
          </div>
        ) : (
          <div className="bsw-row-chip is-empty">No TL</div>
        )}
      </div>
      <button className="wx-btn wx-btn-primary" onClick={onSwitch}
        style={{ padding: '7px 12px', fontSize: 12.5 }}>
        <RefreshIcon width="13" height="13" /> Reassign APC
      </button>
    </div>
  );
}

// ============================================================
function RequestList({ rows, loading, emptyText, isBoss, currentUserId, onDecide, onCancel }) {
  if (loading) return <div className="bsw-empty"><span className="wx-spinner" /> Loading…</div>;
  if (rows.length === 0) {
    return (
      <div className="bsw-empty">
        <div className="bsw-empty-title">Nothing here yet</div>
        <div>{emptyText}</div>
      </div>
    );
  }
  return (
    <div>
      {rows.map((r) => (
        <RequestRow key={r.id} row={r} isBoss={isBoss} currentUserId={currentUserId}
          onDecide={onDecide} onCancel={() => onCancel(r)} />
      ))}
    </div>
  );
}

function RequestRow({ row, isBoss, currentUserId, onDecide, onCancel }) {
  const pending = row.status === 'pending';
  const canCancel = pending && row.requested_by === currentUserId;
  // The new shape carries target in `to_apc`; legacy rows may carry `to_owner`.
  const target = row.to_apc || row.to_owner;
  const targetRole = (row.to_apc ? 'APC' : 'TL').toUpperCase();
  // Only APC requests have an action; a legacy TL row just changes the owner.
  const action = row.to_apc_id ? requestMode(row) : null;

  return (
    <div className={`bsw-req ${pending ? 'is-pending' : ''}`}>
      <BrandAvatar brand={row.brand} size={36} radius={8} />
      <div style={{ minWidth: 0 }}>
        <div style={{ fontWeight: 700, fontSize: 13.5 }}>{row.brand?.brand_name || '—'}</div>
        <div className="bsw-req-meta">
          by <strong style={{ color: 'var(--text-secondary)' }}>{row.requester?.display_name || '—'}</strong>
          {' · '}{formatDate(row.created_at)}
        </div>
      </div>
      <div className="bsw-req-to">
        {target ? (
          <div className="bsw-row-chip">
            <Avatar user={target} size={22} />
            <div style={{ minWidth: 0 }}>
              <div style={{ fontWeight: 700, fontSize: 12.5 }}>{target.display_name}</div>
              <div style={{ fontSize: 10.5, color: 'var(--text-muted)', fontWeight: 700, letterSpacing: '0.05em', display: 'flex', gap: 6, alignItems: 'center' }}>
                → {targetRole}
                {action && <ActionChip action={action} />}
              </div>
            </div>
          </div>
        ) : <span style={{ color: 'var(--text-muted)', fontSize: 12 }}>—</span>}
      </div>
      <div className="bsw-req-reason">
        {row.reason || <span style={{ color: 'var(--text-muted)' }}>(no reason given)</span>}
        {row.decision_note && <em>"{row.decision_note}"</em>}
      </div>
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 6 }}>
        {pending && isBoss ? (
          <>
            <button className="wx-btn wx-btn-primary" onClick={() => onDecide(row, true)}
              style={{ padding: '5px 10px', fontSize: 12 }}>
              <CheckIcon width="12" height="12" /> Approve
            </button>
            <button className="wx-btn wx-btn-ghost" onClick={() => onDecide(row, false)}
              style={{ padding: '5px 10px', fontSize: 12 }}>
              <XIcon width="12" height="12" /> Reject
            </button>
          </>
        ) : canCancel ? (
          <button className="wx-btn wx-btn-ghost" onClick={onCancel}
            style={{ padding: '5px 10px', fontSize: 12 }}>
            <XIcon width="12" height="12" /> Cancel
          </button>
        ) : (
          <span className={`bsw-req-status is-${row.status}`}>{row.status}</span>
        )}
      </div>
    </div>
  );
}

// ============================================================
function Avatar({ user, size = 28 }) {
  const style = {
    width: size, height: size, borderRadius: '50%', overflow: 'hidden',
    background: 'var(--surface-2)', color: 'var(--text-secondary)',
    display: 'grid', placeItems: 'center', fontSize: Math.max(10, size * 0.36),
    fontWeight: 800, flexShrink: 0,
  };
  if (user?.avatar_url) {
    return <div style={style}><img src={user.avatar_url} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} /></div>;
  }
  const init = String(user?.display_name || '?').split(/\s+/).map((s) => s[0]).slice(0, 2).join('').toUpperCase();
  return <div style={style}>{init}</div>;
}

// A request's action. Rows created before mig 360 have mode='swap' from the
// column default — correct, since swap was then the only thing a request did.
function requestMode(row) {
  return row?.mode === 'assign' ? 'assign' : 'swap';
}

// Swap is visually louder on purpose: it moves two people's whole portfolios.
function ActionChip({ action }) {
  const swap = action === 'swap';
  return (
    <span
      title={swap
        ? 'Swap: both APCs exchange their whole brand portfolios.'
        : 'Assign: only this brand moves; the new APC keeps their own.'}
      style={{
        padding: '1px 7px', borderRadius: 999, fontSize: 10, fontWeight: 800,
        letterSpacing: '0.04em', textTransform: 'uppercase',
        background: swap
          ? 'color-mix(in srgb, var(--warning, #f59e0b) 18%, transparent)'
          : 'color-mix(in srgb, var(--accent) 16%, transparent)',
        color: swap ? 'var(--warning, #b45309)' : 'var(--accent)',
      }}
    >
      {swap ? 'Swap' : 'Assign'}
    </span>
  );
}

function formatDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  if (sameDay) return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
}
