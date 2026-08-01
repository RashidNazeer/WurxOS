// ============================================================
// Creator Library — IPC / PCTL / TL / OL.
//
// Creators come from ONE shared published Google Sheet the IPCs manage (read via
// the creator-sheet edge function). The OS owns the APPROVAL status: pending →
// approved by the brand's Team Lead → approved by an Operation Lead. Brand access
// is the reporting scope (OL/PCTL/Boss = all, owner TL = own, assigned IPC =
// assigned) so a TL who loses a brand instantly stops seeing its creators.
//   • TL/OL/Boss approve (TL = own brands, OL/Boss = any).
//   • IPC nudges the TL + OLs to review.  • PCTL is read-only.
//
// Layout: the landing view GROUPS creators into per-brand cards (totals +
// pending-on-TL / awaiting-OL / approved + a progress bar). Clicking a brand
// (or arriving via a ?brand= deep link from a review nudge) drills into that
// brand's creators as approve/reject rows.
// ============================================================
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext';
import { useNotifications } from '../../contexts/NotificationsContext';
import { supabase } from '../../lib/supabase';
import {
  fetchCreatorSheet, listCreatorBrands, listApprovals,
  setApproval, notifyPending, normHandle, creatorStatus, writeSheetStatus,
} from '../../lib/creatorLibraryApi';

// Segment colours for the pending → TL → OL pipeline (+ rejected), reused across
// pills, bars, badges. TL blue isn't a token but matches the badge blue.
const SEG = {
  pending:  { fg: 'var(--warning)', bg: 'var(--warning-soft)', label: 'Pending' },
  tl:       { fg: '#2563eb',        bg: '#e8f0fe',             label: 'Awaiting OL' },
  ol:       { fg: 'var(--success)', bg: 'var(--success-soft)', label: 'Approved' },
  rejected: { fg: 'var(--danger)',  bg: 'var(--danger-soft)',  label: 'Rejected' },
};

// Tolerant column lookup (sheet headers vary in case / spacing).
function pick(row, ...keys) {
  for (const k of keys) {
    const hit = Object.keys(row).find((h) => h.trim().toLowerCase() === k.toLowerCase());
    if (hit && row[hit]) return row[hit];
  }
  return '';
}
function initials(name, handle) {
  const s = (name || handle || '?').trim();
  const parts = s.split(/\s+/).filter(Boolean);
  return ((parts[0]?.[0] || '') + (parts[1]?.[0] || parts[0]?.[1] || '')).toUpperCase() || '?';
}
function timeAgo(iso) {
  if (!iso) return '';
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

export default function CreatorLibraryPage() {
  const { profile } = useAuth();
  const { markCategoryRead } = useNotifications();
  const role = profile?.role;
  const uid = profile?.id;
  const isOL   = ['ol', 'boss', 'developer'].includes(role);
  const isIPC  = role === 'ipc';
  const isPCTL = role === 'pctl';

  const [searchParams, setSearchParams] = useSearchParams();
  const brandParam = searchParams.get('brand') || '';
  const setBrandParam = (v) => {
    const next = new URLSearchParams(searchParams);
    if (v) next.set('brand', v); else next.delete('brand');
    setSearchParams(next, { replace: true });
  };

  const [brands, setBrands] = useState([]);
  const [sheet, setSheet] = useState(null);
  const [approvals, setApprovals] = useState({});
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');

  const [q, setQ] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');
  const [busyKey, setBusyKey] = useState('');
  const [notify, setNotify] = useState(null); // { brandId, message } modal state
  const [toast, setToast] = useState('');
  useEffect(() => { if (!toast) return undefined; const t = setTimeout(() => setToast(''), 3500); return () => clearTimeout(t); }, [toast]);

  // Opening the library acknowledges the review nudges → stops the blinking
  // sidebar alert. Runs once on mount (the category clears for this user).
  useEffect(() => { markCategoryRead('creator_library'); }, [markCategoryRead]);

  const brandByKey = useMemo(() => {
    const m = new Map();
    for (const b of brands) if (b.matchKey) m.set(b.matchKey, b);
    return m;
  }, [brands]);

  const reloadApprovals = useCallback(async (bs) => {
    try { setApprovals(await listApprovals((bs || brands).map((b) => b.id))); } catch { /* keep old */ }
  }, [brands]);

  const load = useCallback(async (withSheet) => {
    if (!role || !uid) return;
    setError('');
    try {
      const bs = await listCreatorBrands({ role, uid, permissions: profile?.permissions });
      setBrands(bs);
      const [sh, appr] = await Promise.all([
        withSheet ? fetchCreatorSheet() : Promise.resolve(null),
        listApprovals(bs.map((b) => b.id)),
      ]);
      if (withSheet && sh) setSheet(sh);
      setApprovals(appr);
    } catch (e) { setError(e.message || String(e)); }
    finally { setLoading(false); setRefreshing(false); }
  }, [role, uid, profile?.permissions]);

  useEffect(() => { setLoading(true); load(true); }, [load]);

  // Live updates: approvals (badges) + brands/brand_assignments (so losing a
  // brand re-scopes the creators live, not just on manual Sync). Refs keep the
  // single subscription pointed at the latest callbacks.
  const loadRef = useRef(load);
  const reloadApprRef = useRef(reloadApprovals);
  loadRef.current = load;
  reloadApprRef.current = reloadApprovals;
  useEffect(() => {
    const ch = supabase.channel('creator_lib_rt')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'creator_approvals' }, () => reloadApprRef.current())
      .on('postgres_changes', { event: '*', schema: 'public', table: 'brands' }, () => loadRef.current(true))
      .on('postgres_changes', { event: '*', schema: 'public', table: 'brand_assignments' }, () => loadRef.current(true))
      .subscribe();
    return () => { supabase.removeChannel(ch); };
  }, []);

  // Merge the (already server-scoped) sheet rows with the OS approvals. Rows are
  // matched to the accessible brand by name to attach brand.id/ownerId; the edge
  // function has already dropped rows for brands the user can't view.
  const creators = useMemo(() => {
    const rows = sheet?.rows || [];
    const out = [];
    for (const r of rows) {
      const nh = normHandle(pick(r, 'Tiktok Handle', 'TikTok Handle', 'Handle'));
      if (!nh) continue; // no usable handle → can't key or approve
      const brand = brandByKey.get(pick(r, 'Brand').trim().toLowerCase());
      if (!brand) continue; // defensive — server already scoped
      const appr = approvals[`${brand.id}|${nh}`] || null;
      out.push({
        key: `${brand.id}|${nh}`,
        handle: pick(r, 'Tiktok Handle', 'TikTok Handle', 'Handle'),
        name: pick(r, 'Name', 'Creator', 'Creator Name'), brand, appr,
        paypal: pick(r, 'Paypal details', 'PayPal', 'Paypal'),
        discord: pick(r, 'Discord'),
        note: pick(r, 'Notes', 'Note', 'Remarks'),   // free-text column in the sheet
        status: creatorStatus(appr),
      });
    }
    return out;
  }, [sheet, brandByKey, approvals]);
  const unmatched = sheet?.unmatched || 0;

  // Per-brand roll-up for the landing cards (over ALL accessible creators).
  const brandStats = useMemo(() => {
    const m = new Map();
    for (const b of brands) m.set(b.id, { brand: b, total: 0, pending: 0, tl: 0, ol: 0, rejected: 0 });
    for (const c of creators) {
      const s = m.get(c.brand.id);
      if (!s) continue;
      s.total += 1; s[c.status] += 1;
    }
    return [...m.values()].map((s) => ({ ...s, awaiting: s.pending + s.tl }));
  }, [brands, creators]);

  // Landing view = brand cards (only brands that actually have creators),
  // searchable by brand name and sorted most-urgent first.
  const visibleBrandCards = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return brandStats
      .filter((s) => s.total > 0)
      .filter((s) => !needle || s.brand.name.toLowerCase().includes(needle))
      .sort((a, b) => (b.awaiting - a.awaiting) || a.brand.name.localeCompare(b.brand.name));
  }, [brandStats, q]);

  // Drill-down view = one brand's creators as rows.
  const activeBrand = brands.find((b) => b.id === brandParam) || null;
  const activeStats = brandStats.find((s) => s.brand.id === brandParam) || null;
  const brandCreators = useMemo(() => creators.filter((c) => {
    if (c.brand.id !== brandParam) return false;
    if (statusFilter !== 'all' && c.status !== statusFilter) return false;
    if (q.trim() && !`${c.name} ${c.handle}`.toLowerCase().includes(q.trim().toLowerCase())) return false;
    return true;
  }).sort((a, b) => {
    const rank = { pending: 0, tl: 1, ol: 2, rejected: 3 };
    return (rank[a.status] - rank[b.status]) || (a.name || a.handle).localeCompare(b.name || b.handle);
  }), [creators, brandParam, statusFilter, q]);

  const globalStats = useMemo(() => {
    const s = { total: creators.length, pending: 0, tl: 0, ol: 0, rejected: 0 };
    creators.forEach((c) => { s[c.status] += 1; });
    return s;
  }, [creators]);

  const canApproveTL = (brand) => isOL || (role === 'tl' && brand.ownerId === uid);

  // Approve/reject flows through a modal (so a note can be attached); "Undo"
  // (clear) runs straight through with no note.
  const [decision, setDecision] = useState(null); // { c, level, decision }

  async function decide(c, level, dec, note) {
    setBusyKey(c.key + level);
    try {
      await setApproval({ brandId: c.brand.id, handle: c.handle, level, decision: dec, note });
      await reloadApprovals();
      // Mirror the new status into the sheet (best-effort; OS is authoritative).
      writeSheetStatus({ brandId: c.brand.id, handle: c.handle, note })
        .catch((e) => console.warn('[creator-library] sheet write-back failed:', e.message));
    } catch (e) { setError(e.message || String(e)); }
    finally { setBusyKey(''); }
  }
  async function submitDecision(note) {
    const d = decision;
    setDecision(null);
    if (d) await decide(d.c, d.level, d.decision, note);
  }

  async function sendNotify() {
    const bId = notify?.brandId;
    if (!bId) return;
    setBusyKey('notify');
    try {
      const n = await notifyPending({ brandId: bId, message: notify?.message });
      setNotify(null);
      setError('');
      setToast(n > 0 ? `Nudged ${n} reviewer${n === 1 ? '' : 's'} to review.` : 'No reviewers to notify.');
    } catch (e) { setError(e.message || String(e)); }
    finally { setBusyKey(''); }
  }

  return (
    <div>
      {/* Header */}
      <div className="d-flex align-items-center justify-content-between flex-wrap gap-3 mb-3">
        <div>
          <h5 className="fw-bold mb-1" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <i className="bi bi-people-fill" style={{ color: 'var(--accent)' }} /> Creator Library
          </h5>
          <p className="text-muted mb-0" style={{ fontSize: '0.82rem' }}>
            Creators the IPCs shortlist per brand · approved by Team Lead → Operation Lead
            {sheet?.fetchedAt && <span> · synced {timeAgo(sheet.fetchedAt)}</span>}
          </p>
        </div>
        <button className="wx-btn wx-btn-ghost wx-btn-sm" disabled={refreshing}
          onClick={() => { setRefreshing(true); load(true); }}>
          {refreshing ? <><span className="wx-spinner" /> Syncing…</> : <><i className="bi bi-arrow-clockwise me-1" /> Sync sheet</>}
        </button>
      </div>

      {error && <div className="wx-alert wx-alert-danger" style={{ marginBottom: 12 }}><span>{error}</span></div>}
      {toast && <div className="wx-alert" style={{ marginBottom: 12, background: 'var(--success-soft)', color: 'var(--success)', border: '1px solid var(--success)' }}><span><i className="bi bi-check2-circle me-1" />{toast}</span></div>}

      {loading ? (
        <div className="text-muted small d-flex align-items-center gap-2"><span className="wx-spinner" /> Loading creators…</div>
      ) : activeBrand ? (
        /* ───────────────────────── DRILL-DOWN: one brand's creators ───────── */
        <BrandDetail
          brand={activeBrand} stats={activeStats} rows={brandCreators}
          allInBrand={creators.filter((c) => c.brand.id === brandParam).length}
          q={q} setQ={setQ} statusFilter={statusFilter} setStatusFilter={setStatusFilter}
          isIPC={isIPC} isViewer={isPCTL || isIPC} isOL={isOL}
          canTL={canApproveTL(activeBrand)} busyKey={busyKey}
          onBack={() => { setBrandParam(''); setQ(''); setStatusFilter('all'); }}
          onDecide={(c, level, dec) => setDecision({ c, level, decision: dec })}
          onClear={(c, level) => decide(c, level, 'clear', null)}
          onNotify={() => setNotify({ brandId: activeBrand.id, message: '' })} />
      ) : (
        /* ───────────────────────── LANDING: brand cards ───────────────────── */
        <>
          <div className="d-flex gap-2 flex-wrap mb-3">
            <StatPill label="Creators" value={globalStats.total} tone="ink" />
            <StatPill label="Pending" value={globalStats.pending} tone="amber" />
            <StatPill label="Awaiting OL" value={globalStats.tl} tone="blue" />
            <StatPill label="Approved" value={globalStats.ol} tone="green" />
            {globalStats.rejected > 0 && <StatPill label="Rejected" value={globalStats.rejected} tone="red" />}
          </div>

          <div className="d-flex flex-wrap gap-2 align-items-center mb-3">
            <div className="position-relative" style={{ minWidth: 220, flex: '1 1 240px', maxWidth: 340 }}>
              <i className="bi bi-search position-absolute text-muted" style={{ left: 10, top: '50%', transform: 'translateY(-50%)', fontSize: '0.8rem', pointerEvents: 'none' }} />
              <input className="wx-input" placeholder="Search brands…" style={{ paddingLeft: 30 }} value={q} onChange={(e) => setQ(e.target.value)} />
            </div>
            <select className="wx-input" style={{ width: 220 }} value={brandParam}
              onChange={(e) => setBrandParam(e.target.value)}
              title="Filter to a brand">
              <option value="">{isOL || isPCTL ? 'All brands' : 'All my brands'}</option>
              {brands.slice().sort((a, b) => a.name.localeCompare(b.name)).map((b) => (
                <option key={b.id} value={b.id}>{b.name}</option>
              ))}
            </select>
          </div>

          {unmatched > 0 && isOL && (
            <div className="text-muted mb-2" style={{ fontSize: '0.75rem' }}>
              <i className="bi bi-info-circle me-1" />{unmatched} sheet row{unmatched === 1 ? '' : 's'} couldn't be matched to a brand (check the “Brand” column spelling).
            </div>
          )}

          {visibleBrandCards.length === 0 ? (
            <div className="text-center py-5" style={{ border: '2px dashed var(--border-subtle)', borderRadius: 14 }}>
              <i className="bi bi-people" style={{ fontSize: '2.4rem', color: 'var(--text-muted)', opacity: 0.4 }} />
              <p className="text-muted mt-3 mb-0">
                {creators.length === 0
                  ? 'No creators yet — the IPC adds them in the shared sheet, then Sync.'
                  : `No brands match “${q}”.`}
              </p>
            </div>
          ) : (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))', gap: 14 }}>
              {visibleBrandCards.map((s) => (
                <BrandCard key={s.brand.id} s={s} isIPC={isIPC}
                  onOpen={() => setBrandParam(s.brand.id)}
                  onRemind={() => setNotify({ brandId: s.brand.id, message: '' })} />
              ))}
            </div>
          )}
        </>
      )}

      {notify && (
        <NotifyModal
          brandName={brands.find((b) => b.id === notify.brandId)?.name || 'this brand'}
          value={notify.message} busy={busyKey === 'notify'}
          onChange={(m) => setNotify((s) => ({ ...s, message: m }))}
          onClose={() => setNotify(null)} onSend={sendNotify} />
      )}

      {decision && (
        <DecisionModal
          decision={decision}
          busy={busyKey === decision.c.key + decision.level}
          onClose={() => setDecision(null)}
          onSubmit={submitDecision} />
      )}
    </div>
  );
}

// ── Landing brand card ─────────────────────────────────────────────────────
function BrandCard({ s, isIPC, onOpen, onRemind }) {
  const [hover, setHover] = useState(false);
  const { brand, total, pending, tl, ol, rejected, awaiting } = s;
  const pct = (n) => (total ? `${(n / total) * 100}%` : '0%');
  return (
    <div className="wx-card" role="button" tabIndex={0}
      onClick={onOpen}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen(); } }}
      onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}
      style={{ padding: 16, cursor: 'pointer', transition: 'box-shadow .15s, transform .15s', transform: hover ? 'translateY(-2px)' : 'none', boxShadow: hover ? '0 16px 34px -20px rgba(15,23,42,.55)' : undefined }}>
      <div className="d-flex align-items-center gap-2 mb-3">
        <div style={{ width: 42, height: 42, borderRadius: 12, flexShrink: 0, background: 'linear-gradient(135deg, var(--accent), color-mix(in srgb, var(--accent) 55%, #fff))', color: 'var(--on-accent)', display: 'grid', placeItems: 'center', fontWeight: 800, fontSize: 14 }}>
          {initials(brand.name)}
        </div>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div className="fw-bold text-truncate" style={{ fontSize: '0.98rem' }} title={brand.name}>{brand.name}</div>
          <div className="text-muted" style={{ fontSize: '0.74rem' }}>{total} creator{total === 1 ? '' : 's'}</div>
        </div>
        {awaiting > 0
          ? <span className="badge" style={{ background: 'var(--warning-soft)', color: 'var(--warning)', fontSize: '0.66rem', fontWeight: 800, padding: '5px 9px' }}>{awaiting} to review</span>
          : <span className="badge" style={{ background: 'var(--success-soft)', color: 'var(--success)', fontSize: '0.66rem', fontWeight: 800, padding: '5px 9px' }}><i className="bi bi-check2-all me-1" />All approved</span>}
      </div>

      {/* Segmented pipeline bar: pending | awaiting-OL | approved | rejected */}
      <div style={{ display: 'flex', height: 9, borderRadius: 999, overflow: 'hidden', background: 'var(--surface-2)', marginBottom: 10 }}>
        <div style={{ width: pct(pending), background: SEG.pending.fg }} title={`${pending} pending`} />
        <div style={{ width: pct(tl), background: SEG.tl.fg }} title={`${tl} awaiting OL`} />
        <div style={{ width: pct(ol), background: SEG.ol.fg }} title={`${ol} approved`} />
        <div style={{ width: pct(rejected), background: SEG.rejected.fg }} title={`${rejected} rejected`} />
      </div>

      <div className="d-flex flex-wrap gap-3" style={{ fontSize: '0.72rem' }}>
        <Legend color={SEG.pending.fg} label="Pending TL" value={pending} />
        <Legend color={SEG.tl.fg} label="Awaiting OL" value={tl} />
        <Legend color={SEG.ol.fg} label="Approved" value={ol} />
        {rejected > 0 && <Legend color={SEG.rejected.fg} label="Rejected" value={rejected} />}
      </div>

      <div className="d-flex align-items-center gap-2 mt-3 pt-2" style={{ borderTop: '1px solid var(--border-subtle)' }}>
        {isIPC && (
          <button className="wx-btn wx-btn-sm" style={{ fontSize: '0.72rem' }}
            onClick={(e) => { e.stopPropagation(); onRemind(); }}
            title="Notify the Team Lead & Operation Leads to review">
            <i className="bi bi-bell me-1" /> Remind
          </button>
        )}
        <span className="ms-auto d-inline-flex align-items-center gap-1" style={{ fontSize: '0.74rem', color: 'var(--accent)', fontWeight: 600 }}>
          Open <i className="bi bi-arrow-right" />
        </span>
      </div>
    </div>
  );
}

function Legend({ color, label, value }) {
  return (
    <span className="d-inline-flex align-items-center gap-1" style={{ color: 'var(--text-secondary)' }}>
      <span style={{ width: 8, height: 8, borderRadius: 2, background: color, flexShrink: 0 }} />
      <strong style={{ color: 'var(--text-primary)' }}>{value}</strong> {label}
    </span>
  );
}

// ── Drill-down: one brand's creators as approve/reject rows ─────────────────
function BrandDetail({
  brand, stats, rows, allInBrand, q, setQ, statusFilter, setStatusFilter,
  isIPC, isViewer, isOL, canTL, busyKey, onBack, onDecide, onClear, onNotify,
}) {
  return (
    <div>
      {/* Brand header */}
      <div className="d-flex align-items-center gap-2 flex-wrap mb-3">
        <button className="wx-btn wx-btn-ghost wx-btn-sm" onClick={onBack}>
          <i className="bi bi-arrow-left me-1" /> All brands
        </button>
        <div style={{ width: 34, height: 34, borderRadius: 10, background: 'linear-gradient(135deg, var(--accent), color-mix(in srgb, var(--accent) 55%, #fff))', color: 'var(--on-accent)', display: 'grid', placeItems: 'center', fontWeight: 800, fontSize: 12 }}>
          {initials(brand.name)}
        </div>
        <div className="fw-bold" style={{ fontSize: '1.05rem' }}>{brand.name}</div>
      </div>

      {stats && (
        <div className="d-flex gap-2 flex-wrap mb-3">
          <StatPill label="Creators" value={stats.total} tone="ink" />
          <StatPill label="Pending TL" value={stats.pending} tone="amber" />
          <StatPill label="Awaiting OL" value={stats.tl} tone="blue" />
          <StatPill label="Approved" value={stats.ol} tone="green" />
          {stats.rejected > 0 && <StatPill label="Rejected" value={stats.rejected} tone="red" />}
        </div>
      )}

      {/* Toolbar */}
      <div className="d-flex flex-wrap gap-2 align-items-center mb-3">
        <div className="position-relative" style={{ minWidth: 220, flex: '1 1 240px', maxWidth: 340 }}>
          <i className="bi bi-search position-absolute text-muted" style={{ left: 10, top: '50%', transform: 'translateY(-50%)', fontSize: '0.8rem', pointerEvents: 'none' }} />
          <input className="wx-input" placeholder="Search name or @handle…" style={{ paddingLeft: 30 }} value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <select className="wx-input" style={{ width: 190 }} value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
          <option value="all">All statuses</option>
          <option value="pending">Pending</option>
          <option value="tl">Approved by TL</option>
          <option value="ol">Approved by OL</option>
        </select>
        {isIPC && (
          <button className="wx-btn wx-btn-primary wx-btn-sm" style={{ marginLeft: 'auto' }}
            title="Notify the Team Lead & Operation Leads to review" onClick={onNotify}>
            <i className="bi bi-bell me-1" /> Notify to review
          </button>
        )}
      </div>

      {rows.length === 0 ? (
        <div className="text-center py-5" style={{ border: '2px dashed var(--border-subtle)', borderRadius: 14 }}>
          <i className="bi bi-people" style={{ fontSize: '2.2rem', color: 'var(--text-muted)', opacity: 0.4 }} />
          <p className="text-muted mt-3 mb-0">
            {allInBrand === 0
              ? 'No creators for this brand yet — the IPC adds them in the shared sheet, then Sync.'
              : 'No creators match your filters.'}
          </p>
        </div>
      ) : (
        <div className="d-flex flex-column gap-2">
          {rows.map((c) => (
            <CreatorRow key={c.key} c={c}
              canTL={canTL} canOL={isOL} viewer={isViewer}
              busyKey={busyKey} onDecide={onDecide} onClear={onClear} />
          ))}
        </div>
      )}
    </div>
  );
}

function CreatorRow({ c, canTL, canOL, viewer, busyKey, onDecide, onClear }) {
  const a = c.appr || {};
  return (
    <div className="wx-card d-flex align-items-start flex-wrap gap-3" style={{ padding: '12px 14px' }}>
      {/* Identity */}
      <div className="d-flex align-items-center gap-2" style={{ minWidth: 200, flex: '1 1 220px' }}>
        <div style={{ width: 38, height: 38, borderRadius: 11, flexShrink: 0, background: 'linear-gradient(135deg, var(--accent), color-mix(in srgb, var(--accent) 60%, #fff))', color: 'var(--on-accent)', display: 'grid', placeItems: 'center', fontWeight: 800, fontSize: 12 }}>
          {initials(c.name, c.handle)}
        </div>
        <div style={{ minWidth: 0 }}>
          <div className="fw-semibold text-truncate" style={{ fontSize: '0.9rem' }}>{c.name || c.handle || '—'}</div>
          <a href={`https://www.tiktok.com/@${normHandle(c.handle)}`} target="_blank" rel="noreferrer"
            className="text-truncate d-block" style={{ fontSize: '0.74rem', color: 'var(--accent)', textDecoration: 'none' }} title={`@${normHandle(c.handle)}`}>
            @{normHandle(c.handle)}
          </a>
        </div>
      </div>

      {/* Contact + status + notes */}
      <div className="d-flex flex-column gap-1" style={{ flex: '1 1 240px', minWidth: 0 }}>
        {(c.paypal || c.discord) && (
          <div className="d-flex flex-wrap gap-1">
            <ContactChip icon="bi-paypal" value={c.paypal} />
            <ContactChip icon="bi-discord" value={c.discord} />
          </div>
        )}
        <div className="d-flex flex-wrap gap-1" style={{ alignItems: 'center' }}>
          <LevelBadge level="Team Lead"
            approvedBy={a.tl?.display_name} approvedOn={!!a.tl_approved_by}
            rejectedBy={a.tlr?.display_name} rejectedOn={!!a.tl_rejected_by} note={a.tl_note} />
          <LevelBadge level="Operation Lead"
            approvedBy={a.ol?.display_name} approvedOn={!!a.ol_approved_by}
            rejectedBy={a.olr?.display_name} rejectedOn={!!a.ol_rejected_by} note={a.ol_note} />
          {c.status === 'pending' && <span className="badge" style={{ background: 'var(--warning-soft)', color: 'var(--warning)', fontSize: '0.64rem', fontWeight: 700 }}>Pending</span>}
        </div>
        {c.note && (
          <div className="text-muted" style={{ fontSize: '0.72rem' }}>
            <i className="bi bi-sticky me-1" />{c.note}
          </div>
        )}
      </div>

      {/* Decision controls */}
      {!viewer && (canTL || canOL) && (
        <div className="d-flex flex-column gap-1 ms-auto" style={{ minWidth: 172 }}>
          {canTL && <LevelControls level="tl" label="TL" c={c}
            approvedOn={!!a.tl_approved_by} rejectedOn={!!a.tl_rejected_by}
            busy={busyKey === c.key + 'tl'} onDecide={onDecide} onClear={onClear} />}
          {canOL && <LevelControls level="ol" label="OL" c={c}
            approvedOn={!!a.ol_approved_by} rejectedOn={!!a.ol_rejected_by}
            busy={busyKey === c.key + 'ol'} onDecide={onDecide} onClear={onClear} />}
        </div>
      )}
    </div>
  );
}

// One level's approve/reject state → either a decided pill + Undo, or the
// Approve / Reject button pair.
function LevelControls({ level, label, c, approvedOn, rejectedOn, busy, onDecide, onClear }) {
  if (busy) return <div className="d-flex justify-content-end" style={{ height: 30 }}><span className="wx-spinner" /></div>;
  if (approvedOn || rejectedOn) {
    const ok = approvedOn;
    return (
      <div className="d-flex align-items-center gap-1 justify-content-end">
        <span className="badge d-inline-flex align-items-center gap-1"
          style={{ background: ok ? 'var(--success-soft)' : 'var(--danger-soft)', color: ok ? 'var(--success)' : 'var(--danger)', fontSize: '0.64rem', fontWeight: 700 }}>
          <i className={`bi ${ok ? 'bi-check2' : 'bi-x-lg'}`} />{label} {ok ? 'approved' : 'rejected'}
        </span>
        <button className="wx-btn wx-btn-sm" style={{ fontSize: '0.68rem', padding: '2px 8px' }}
          title="Undo this decision" onClick={() => onClear(c, level)}>Undo</button>
      </div>
    );
  }
  return (
    <div className="d-flex gap-1 justify-content-end">
      <span className="text-muted" style={{ fontSize: '0.66rem', alignSelf: 'center', marginRight: 2 }}>{label}</span>
      <button className="wx-btn wx-btn-sm" style={{ fontSize: '0.7rem', padding: '3px 9px', color: 'var(--success)', borderColor: 'var(--success)' }}
        onClick={() => onDecide(c, level, 'approve')}><i className="bi bi-check2 me-1" />Approve</button>
      <button className="wx-btn wx-btn-sm" style={{ fontSize: '0.7rem', padding: '3px 9px', color: 'var(--danger)', borderColor: 'var(--danger)' }}
        onClick={() => onDecide(c, level, 'reject')}><i className="bi bi-x-lg me-1" />Reject</button>
    </div>
  );
}

// A level's outcome badge (approved / rejected), with the approver/rejecter name
// and any note surfaced on hover.
function LevelBadge({ level, approvedBy, approvedOn, rejectedBy, rejectedOn, note }) {
  if (rejectedOn) {
    return (
      <span className="d-inline-flex align-items-center gap-1" title={note ? `Note: ${note}` : undefined}
        style={{ background: 'var(--danger-soft)', color: 'var(--danger)', border: '1px solid var(--danger)', borderRadius: 999, padding: '3px 10px', fontSize: '0.66rem', fontWeight: 700 }}>
        <i className="bi bi-x-circle-fill" /> {level} rejected{rejectedBy ? ` · ${rejectedBy}` : ''}{note ? ' 📝' : ''}
      </span>
    );
  }
  if (approvedOn) {
    const tone = level === 'Operation Lead' ? { bg: 'var(--success-soft)', fg: 'var(--success)', bd: 'var(--success)' } : { bg: '#e8f0fe', fg: '#1d4ed8', bd: '#bcd0fb' };
    return (
      <span className="d-inline-flex align-items-center gap-1" title={note ? `Note: ${note}` : undefined}
        style={{ background: tone.bg, color: tone.fg, border: `1px solid ${tone.bd}`, borderRadius: 999, padding: '3px 10px', fontSize: '0.66rem', fontWeight: 700 }}>
        <i className="bi bi-patch-check-fill" /> {level}{approvedBy ? ` · ${approvedBy}` : ''}{note ? ' 📝' : ''}
      </span>
    );
  }
  return null;
}

// Approve / reject confirmation with an optional note.
function DecisionModal({ decision, busy, onClose, onSubmit }) {
  const [note, setNote] = useState('');
  const isReject = decision.decision === 'reject';
  const levelName = decision.level === 'ol' ? 'Operation Lead' : 'Team Lead';
  const handle = normHandle(decision.c.handle);
  return (
    <div className="wx-modal-backdrop" onClick={onClose}>
      <div className="wx-modal" style={{ maxWidth: 440 }} onClick={(e) => e.stopPropagation()}>
        <div className="wx-modal-header">
          <div className="wx-modal-title">
            {isReject ? 'Reject' : 'Approve'} as {levelName}
          </div>
          <button type="button" className="shell-icon-btn" onClick={onClose} aria-label="Close">✕</button>
        </div>
        <div className="wx-modal-body">
          <p className="text-muted" style={{ fontSize: 13 }}>
            {isReject ? 'Rejecting' : 'Approving'} <strong>{decision.c.name || `@${handle}`}</strong> (@{handle}) for <strong>{decision.c.brand.name}</strong>.
          </p>
          <label className="wx-label">Note <span style={{ color: 'var(--text-muted)', fontWeight: 500 }}>(optional)</span></label>
          <textarea className="wx-input" rows={3} value={note} autoFocus
            placeholder={isReject ? 'e.g. off-brand / low engagement' : 'e.g. great fit, prioritise'}
            onChange={(e) => setNote(e.target.value)} style={{ resize: 'vertical' }} />
        </div>
        <div className="wx-modal-footer">
          <button className="wx-btn wx-btn-ghost" onClick={onClose} disabled={busy}>Cancel</button>
          <button className="wx-btn" style={{ color: '#fff', background: isReject ? 'var(--danger)' : 'var(--success)', borderColor: 'transparent' }}
            onClick={() => onSubmit(note)} disabled={busy}>
            {busy ? <><span className="wx-spinner" /> Saving…</> : <><i className={`bi ${isReject ? 'bi-x-lg' : 'bi-check2'} me-1`} />{isReject ? 'Reject' : 'Approve'}</>}
          </button>
        </div>
      </div>
    </div>
  );
}

function StatPill({ label, value, tone }) {
  const tones = {
    ink:   { bg: 'var(--surface-2)', fg: 'var(--text-primary)' },
    amber: { bg: 'var(--warning-soft)', fg: 'var(--warning)' },
    blue:  { bg: '#e8f0fe', fg: '#1d4ed8' },
    green: { bg: 'var(--success-soft)', fg: 'var(--success)' },
    red:   { bg: 'var(--danger-soft)', fg: 'var(--danger)' },
  }[tone] || {};
  return (
    <div className="rounded-3 px-3 py-2 text-center" style={{ background: tones.bg, color: tones.fg, minWidth: 96 }}>
      <div style={{ fontSize: '0.58rem', letterSpacing: '0.06em', textTransform: 'uppercase', opacity: 0.8, fontWeight: 700 }}>{label}</div>
      <div className="fw-bold" style={{ fontSize: '1.05rem' }}>{value}</div>
    </div>
  );
}

function ContactChip({ icon, value }) {
  const [copied, setCopied] = useState(false);
  if (!value) return null;
  return (
    <button type="button" className="d-inline-flex align-items-center gap-1"
      onClick={() => { navigator.clipboard?.writeText(value).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1200); }).catch(() => {}); }}
      title={`${value} — click to copy`}
      style={{ background: 'var(--surface-2)', border: '1px solid var(--border-subtle)', borderRadius: 999, padding: '2px 9px', fontSize: '0.68rem', color: 'var(--text-secondary)', cursor: 'pointer', maxWidth: '100%' }}>
      <i className={`bi ${icon}`} />
      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{copied ? 'Copied!' : value}</span>
    </button>
  );
}

function NotifyModal({ brandName, value, busy, onChange, onClose, onSend }) {
  return (
    <div className="wx-modal-backdrop" onClick={onClose}>
      <div className="wx-modal" style={{ maxWidth: 440 }} onClick={(e) => e.stopPropagation()}>
        <div className="wx-modal-header">
          <div className="wx-modal-title">Notify reviewers — {brandName}</div>
          <button type="button" className="shell-icon-btn" onClick={onClose} aria-label="Close">✕</button>
        </div>
        <div className="wx-modal-body">
          <p className="text-muted" style={{ fontSize: 13 }}>
            Sends a notification to this brand's <strong>Team Lead</strong> and the <strong>Operation Leads</strong> to review the creators. (The PCTL isn't notified.)
          </p>
          <label className="wx-label">Message <span style={{ color: 'var(--text-muted)', fontWeight: 500 }}>(optional)</span></label>
          <textarea className="wx-input" rows={3} value={value} placeholder="e.g. 4 new creators need approval"
            onChange={(e) => onChange(e.target.value)} style={{ resize: 'vertical' }} />
        </div>
        <div className="wx-modal-footer">
          <button className="wx-btn wx-btn-ghost" onClick={onClose} disabled={busy}>Cancel</button>
          <button className="wx-btn wx-btn-primary" onClick={onSend} disabled={busy}>
            {busy ? <><span className="wx-spinner" /> Sending…</> : <><i className="bi bi-bell me-1" /> Send</>}
          </button>
        </div>
      </div>
    </div>
  );
}
