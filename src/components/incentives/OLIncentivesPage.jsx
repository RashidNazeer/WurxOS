import React, { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext';
import {
  getIncentives, getMostRecentPriorPlan,
  listIncentivesMonth, listUsersByRoles,
  updateIncentivesProgress, savePlan,
  verifyIncentives, notifyIncentiveEmployee, autoComplete,
  applyAttendanceAutofill, applyDerivedAutofill, fetchOlBrandStatus, listOlBrandsByOl, brandHitByTL, fmtUnitValue,
} from '../../lib/incentivesApi';
import BrandChip from './BrandChip';
import CommissionNote from './CommissionNote';
import InactiveBrandsNotice from './InactiveBrandsNotice';

function getCurrentMonth() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}
function getMonthLabel(ym) {
  const [year, month] = ym.split('-');
  return new Date(year, month - 1).toLocaleString('en-US', { month: 'long', year: 'numeric' });
}
function pct(achieved, target) {
  if (!target || target <= 0) return 0;
  return Math.min(Math.round((Number(achieved) / Number(target)) * 100), 100);
}

// The OL's incentive-brand roll-up: which of their curated brands hit their GMV
// target (owning TL marked it complete), the live %, and progress to the 70%
// threshold. Curate the list in Settings → My Incentive Brands.
function OlBrandPanel({ status, olItem, paid }) {
  const list = Array.isArray(status) ? status : [];
  const total = list.length;
  const hits = list.filter((s) => s.is_hit).length;
  const unmatched = list.filter((s) => !s.matched_text).length;
  const target = Number(olItem?.targetValue) || 70;
  const hasItem = !!olItem;                       // is the roll-up wired to an earnable line item?
  // Once the month is PAID the payout was frozen from the snapshotted % in the
  // line item. Show THAT number (not a live recompute a backdated TL edit could
  // drift) so the panel always agrees with what the OL was actually paid.
  const frozenPct = paid && olItem ? Number(olItem.achievedValue) : NaN;
  const p = (paid && !Number.isNaN(frozenPct))
    ? Math.round(frozenPct)
    : (total ? Math.round((hits / total) * 100) : 0);
  const met = hasItem && (paid ? !!olItem.completed : (total > 0 && p >= target));

  return (
    <div className="card border-0 shadow-sm mt-3" style={{ borderRadius: 14, overflow: 'hidden' }}>
      <div className="p-3 d-flex align-items-center justify-content-between flex-wrap gap-2" style={{ borderBottom: '1px solid var(--border-subtle)' }}>
        <div>
          <div className="fw-bold" style={{ fontSize: '0.9rem' }}><i className="bi bi-bullseye me-1" style={{ color: 'var(--accent)' }} />Incentive brands</div>
          <div className="text-muted" style={{ fontSize: '0.72rem' }}>
            <Link to="/settings?section=olIncentiveBrands">Choose which brands count</Link> · a brand counts once its TL marks its GMV target complete
          </div>
        </div>
        <div className="text-end">
          <div className="fw-bold" style={{ fontSize: '1.25rem', color: met ? 'var(--success)' : 'var(--text-primary)' }}>{p}%</div>
          <div className="text-muted" style={{ fontSize: '0.68rem' }}>{paid ? 'frozen paid figure' : `${hits} of ${total} hit target`}</div>
        </div>
      </div>

      <div className="px-3 pt-3">
        {/* progress with a marker at the target% */}
        <div className="position-relative rounded-pill" style={{ height: 8, background: 'var(--surface-2)' }}>
          <div className="h-100 rounded-pill" style={{ width: `${p}%`, background: met ? 'var(--success)' : 'var(--accent)', transition: 'width .4s' }} />
          <div style={{ position: 'absolute', top: -3, bottom: -3, left: `${target}%`, width: 2, background: 'var(--text-primary)', opacity: 0.55 }} title={`Target ${target}%`} />
        </div>
        <div className="d-flex justify-content-between mt-1" style={{ fontSize: '0.66rem', color: 'var(--text-muted)' }}>
          <span>{met
            ? <span style={{ color: 'var(--success)', fontWeight: 700 }}>Above the {target}% target ✓ {paid ? '(paid · locked)' : '(locks at month-end)'}</span>
            : `${target}% needed`}</span>
          <span>{p}%{paid && <span className="ms-1" style={{ opacity: 0.7 }}>· paid</span>}</span>
        </div>
        {!hasItem && total > 0 && (
          <div className="mt-2 mb-1 px-2 py-1 rounded" style={{ background: 'var(--warning-soft)', color: 'var(--warning)', fontSize: '0.7rem' }}>
            <i className="bi bi-exclamation-triangle me-1" />This roll-up isn't wired to an incentive line item yet, so it can't be earned. Ask the Boss to add a "Brands hit their GMV targets" incentive item to your plan.
          </div>
        )}
        {unmatched > 0 && (
          <div className="mt-2 mb-1 px-2 py-1 rounded" style={{ background: 'var(--warning-soft)', color: 'var(--warning)', fontSize: '0.7rem' }}>
            <i className="bi bi-exclamation-triangle me-1" />{unmatched} brand{unmatched === 1 ? '' : 's'} have no matching TL GMV-target item yet — they can't count until the Team Lead adds/renames that item to include the brand name.
          </div>
        )}
      </div>

      <div className="p-2" style={{ maxHeight: 300, overflowY: 'auto' }}>
        {total === 0 ? (
          <div className="text-muted text-center py-3" style={{ fontSize: '0.8rem' }}>
            No brands selected yet — <Link to="/settings?section=olIncentiveBrands">pick your incentive brands</Link>.
          </div>
        ) : list.map((s) => {
          const state = s.is_hit ? 'hit' : (s.matched_text ? 'pending' : 'unmatched');
          const cfg = {
            hit:       { icon: 'bi-check-circle-fill', color: 'var(--success)', label: 'Hit' },
            pending:   { icon: 'bi-circle',            color: 'var(--text-muted)', label: 'Not yet' },
            unmatched: { icon: 'bi-exclamation-triangle-fill', color: 'var(--warning)', label: 'No TL item' },
          }[state];
          return (
            <div key={s.brand_id} className="d-flex align-items-center gap-2 px-2 py-1" style={{ fontSize: '0.8rem' }}>
              <i className={`bi ${cfg.icon}`} style={{ color: cfg.color, fontSize: '0.85rem' }} />
              <span className="fw-medium text-truncate" style={{ flex: '1 1 auto', minWidth: 0 }}>{s.brand_name}</span>
              <span className="text-muted text-truncate" style={{ fontSize: '0.68rem', maxWidth: 160 }}
                title={s.matched_text ? `Matched TL item: ${s.matched_text}` : 'No matching TL GMV item'}>
                TL: {s.owner_name || '—'}
              </span>
              <span style={{ color: cfg.color, fontSize: '0.66rem', fontWeight: 700, whiteSpace: 'nowrap' }}>{cfg.label}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
function calcBreakdown(rec) {
  const incTotal    = (rec.incentives || []).reduce((s, i) => s + (Number(i.amount) || 0), 0);
  const bonTotal    = (rec.bonuses    || []).reduce((s, b) => s + (Number(b.amount) || 0), 0);
  const incAchieved = (rec.incentives || []).filter(i => i.completed).reduce((s, i) => s + (Number(i.amount) || 0), 0);
  const bonAchieved = (rec.bonuses    || []).filter(b => b.completed).reduce((s, b) => s + (Number(b.amount) || 0), 0);
  const basic       = Number(rec.basicSalary) || 0;
  return { basic, incTotal, bonTotal, incAchieved, bonAchieved, total: basic + incAchieved + bonAchieved };
}

function itemSuffix(item) {
  if (item?.suffix != null && item.suffix !== '') return item.suffix;
  if (item?.unit === 'percent') return '%';
  return '';
}

// Cumulative payout/achievement snapshot for a set of users (base + incentives +
// bonuses earned, and the fully/partial/none achievement split). Reused for the
// APC+IPC combined view and the TL-only view.
function computeCombinedStats(users, records) {
  let totalBase = 0, incEarned = 0, incPotential = 0, bonEarned = 0, bonPotential = 0;
  let withPlans = 0, fullyAchieved = 0, partial = 0, noneEarned = 0, noPlan = 0;
  for (const u of users) {
    const r = records[u.id];
    if (!r) { noPlan++; continue; }
    withPlans++;
    const incs = r.incentives || [];
    const bons = r.bonuses    || [];
    totalBase    += Number(r.basicSalary) || 0;
    const ip = incs.reduce((s, i) => s + (Number(i.amount) || 0), 0);
    const ie = incs.filter(i => i.completed).reduce((s, i) => s + (Number(i.amount) || 0), 0);
    const bp = bons.reduce((s, b) => s + (Number(b.amount) || 0), 0);
    const be = bons.filter(b => b.completed).reduce((s, b) => s + (Number(b.amount) || 0), 0);
    incPotential += ip; incEarned += ie;
    bonPotential += bp; bonEarned += be;
    const incCount = incs.length;
    const completedInc = incs.filter(i => i.completed).length;
    if (incCount === 0)                 partial++;
    else if (completedInc === 0)        noneEarned++;
    else if (completedInc === incCount) fullyAchieved++;
    else                                partial++;
  }
  return {
    teamSize: users.length, withPlans, noPlan,
    totalBase, incEarned, incPotential, bonEarned, bonPotential,
    totalPayout: totalBase + incEarned + bonEarned,
    fullyAchieved, partial, noneEarned,
  };
}

// Small marker for incentive items whose Achieved is auto-filled from attendance.
function AttendanceBadge() {
  return (
    <span className="badge rounded-pill" title="Auto-filled from monthly attendance %"
      style={{ fontSize: '0.55rem', background: '#dbeafe', color: '#1e40af', fontWeight: 600 }}>
      <i className="bi bi-calendar-check me-1" />Auto
    </span>
  );
}

// Generic "Auto" marker for any read-time-derived item (attendance or ol_brands).
function AutoBadge({ source }) {
  const meta = {
    ol_brands:       { title: 'Auto-filled from your incentive-brands roll-up', icon: 'bi-bullseye' },
    gmv_max:         { title: "Auto-filled from the brand's GMV in Brand Analytics", icon: 'bi-graph-up-arrow' },
    commission_tier: { title: "Commission on the brand's GMV — pays once its monthly goal is reached", icon: 'bi-percent' },
  }[source] || { title: 'Auto-filled from monthly attendance %', icon: 'bi-calendar-check' };
  return (
    <span className="badge rounded-pill" title={meta.title}
      style={{ fontSize: '0.55rem', background: '#dbeafe', color: '#1e40af', fontWeight: 600 }}>
      <i className={`bi ${meta.icon} me-1`} />Auto
    </span>
  );
}

// Per-brand chip rendered in user cards. Shows name + a small tier dot
// (gold/silver/bronze/platinum) so the OL can spot tier mix at a glance
// when designing incentives. Inactive brands fade.
const _TIER_COLORS = {
  gold:     '#eab308',
  silver:   '#94a3b8',
  bronze:   '#b45309',
  platinum: '#6366f1',
};
function BrandTierChip({ brand }) {
  const tierKey = brand.tier ? String(brand.tier).toLowerCase() : null;
  const tierColor = tierKey ? _TIER_COLORS[tierKey] : null;
  const inactive = brand.status && String(brand.status).toLowerCase() !== 'active';
  const hit = brand.is_hit === true;
  return (
    <span
      className="badge d-inline-flex align-items-center gap-1"
      title={[
        hit ? 'Hit its GMV target' : null,
        brand.tier ? `Tier: ${brand.tier}` : null,
        brand.status ? `Status: ${brand.status}` : null,
        brand.notes || null,
      ].filter(Boolean).join('\n')}
      style={{
        background: hit ? '#e6f4ea' : '#f3f4f6',
        color: hit ? '#15803d' : '#495057',
        border: hit ? '1px solid #bbf7d0' : '1px solid transparent',
        fontSize: '0.6rem',
        fontWeight: 500,
        opacity: inactive ? 0.55 : 1,
      }}
    >
      {tierColor && (
        <span style={{
          width: 6, height: 6, borderRadius: '50%',
          background: tierColor, flexShrink: 0,
        }} />
      )}
      {brand.name}
      {hit && <i className="bi bi-check-circle-fill" style={{ color: '#16a34a', fontSize: '0.6rem', flexShrink: 0 }} />}
    </span>
  );
}

// ── Edit Row (own progress) ───────────────────────────────────────────────────
// lockTarget: when the OL edits their OWN progress, the Target is Boss-set and must
// be read-only (an OL must not lower their own target to pass it) — same rule as
// APC/TL. Left editable (default) when the OL manages an APC/IPC target.
function EditRow({ item, cat, onChange, lockTarget = false, month }) {
  const isAtt      = item.source === 'attendance';
  const isOlBrands = item.source === 'ol_brands';
  const isGmvMax   = item.source === 'gmv_max';
  const isComm     = item.source === 'commission_tier';
  const isDerived  = isAtt || isOlBrands || isGmvMax || isComm;   // achieved is read-time-filled → locked
  // GMV-Max differs from the others: only its ACHIEVED is derived. The target
  // is the per-brand money figure the OL sets, so it stays editable here. A
  // commission target is the brand's own GMV goal, so it locks like the rest.
  const lockTgt    = (isDerived && !isGmvMax) || lockTarget;
  const achieved = item.achievedValue ?? '';
  const target   = isAtt ? 100 : (item.targetValue ?? '');
  const sfx      = itemSuffix(item);
  const p        = pct(achieved, target);          // display % only (rounded, capped 100)
  // Completion rule per source: attendance/normal items use the ≥0.9 ratio;
  // ol_brands uses the exact ≥ target (≥70) rule the overlay + payout freeze use,
  // so this editor badge agrees with OlBrandPanel and the actual payout instead of
  // showing "Completed" at 65%.
  // A commission line is the same story as ol_brands, one step stricter: it pays
  // only when the brand's GMV goal is genuinely reached, so it takes the
  // overlay's own verdict rather than the ≥90% ratio.
  const done     = isComm
    ? !!item.completed
    : isOlBrands
      ? (Number(achieved) >= (Number(target) || 70))
      : autoComplete({ ...item, achievedValue: achieved, targetValue: target });
  const lock     = { background: '#eef2f7', cursor: 'not-allowed' };
  return (
    <div className="rounded-3 p-3 mb-2" style={{ background: done ? '#f0fdf4' : (isDerived ? '#eff6ff' : '#fafafa'), border: `1.5px solid ${done ? '#b7dfc4' : (isDerived ? '#bfdbfe' : '#e9ecef')}` }}>
      <div className="d-flex align-items-start justify-content-between gap-2 mb-2">
        <div>
          <div className="fw-semibold small">{item.text || '—'}</div>
          <div className="text-muted" style={{ fontSize: '0.7rem' }}>+{(Number(item.amount) || 0).toLocaleString()} PKR</div>
        </div>
        <div className="d-flex align-items-center gap-1 flex-shrink-0">
          {isDerived && <AutoBadge source={item.source} />}
          <span className="badge rounded-pill" style={{ fontSize: '0.6rem', background: done ? '#e6f4ea' : '#fff3e0', color: done ? '#198754' : '#fd7e14' }}>
            {done ? '✓ Completed' : `${p}%`}
          </span>
        </div>
      </div>
      <div className="row g-2">
        <div className="col-5">
          <label className="form-label mb-1" style={{ fontSize: '0.7rem', color: '#6c757d' }}>Target{lockTgt && !isDerived && <span className="text-muted" style={{ fontSize: '0.6rem' }}> (set by Boss · read-only)</span>}</label>
          <div className="input-group input-group-sm">
            <input type="number" className="form-control" min="0" value={target}
              onChange={e => onChange(cat, item.id, 'targetValue', e.target.value)}
              readOnly={lockTgt} disabled={lockTgt} style={lockTgt ? lock : undefined} />
            {sfx && <span className="input-group-text" style={{ fontSize: '0.7rem' }}>{sfx}</span>}
          </div>
        </div>
        <div className="col-5">
          <label className="form-label mb-1" style={{ fontSize: '0.7rem', color: '#6c757d' }}>Achieved{isDerived && <span className="text-muted"> (auto)</span>}</label>
          <div className="input-group input-group-sm">
            <input type="number" className="form-control" min="0" value={achieved}
              onChange={e => onChange(cat, item.id, 'achievedValue', e.target.value)}
              readOnly={isDerived} disabled={isDerived} style={isDerived ? lock : undefined} />
            {sfx && <span className="input-group-text" style={{ fontSize: '0.7rem' }}>{sfx}</span>}
          </div>
        </div>
        <div className="col-2">
          <label className="form-label mb-1" style={{ fontSize: '0.7rem', color: '#6c757d' }}>Unit</label>
          <input type="text" className="form-control form-control-sm" placeholder="%" maxLength={6}
            value={sfx} onChange={e => onChange(cat, item.id, 'suffix', e.target.value)}
            readOnly={isDerived} disabled={isDerived}
            style={{ textAlign: 'center', fontSize: '0.78rem', ...(isDerived ? lock : {}) }} />
        </div>
      </div>
      {isDerived && (
        <div className="mt-2" style={{ fontSize: '0.66rem', color: isComm ? '#166534' : '#1e40af' }}>
          <i className={`bi ${isAtt ? 'bi-calendar-check' : isGmvMax ? 'bi-graph-up-arrow' : isComm ? 'bi-percent' : 'bi-bullseye'} me-1`} />
          {isAtt
            ? "Filled automatically from this month's attendance %."
            : isComm
              ? <CommissionNote item={item} month={month} />
              : isGmvMax
                ? "Achieved comes from this brand's GMV in Brand Analytics — the figure the APC enters at clock-in. Set the target here; tick the item yourself when it's earned."
                : 'Filled automatically from your incentive-brands roll-up (Settings → My Incentive Brands). Completes at month-end once you clear the target.'}
        </div>
      )}
    </div>
  );
}

function EditOwnModal({ record, items, onClose, onSaved }) {
  // v2 auth shim
  const { user, profile } = useAuth();
  const currentUser = user ? { uid: user.id, email: user.email, displayName: profile?.display_name || '' } : null;
  const userProfile = profile ? { displayName: profile.display_name || '' } : null;
  const [editItems, setEditItems] = useState({
    incentives: items.incentives.map(i => ({ ...i })),
    bonuses:    items.bonuses.map(b => ({ ...b })),
  });
  const [saving, setSaving] = useState(false);
  const [error,  setError]  = useState('');

  function handleChange(cat, itemId, field, value) {
    setEditItems(prev => ({
      ...prev,
      [cat]: prev[cat].map(it => {
        if (it.id !== itemId) return it;
        const updated = { ...it, [field]: value };
        return { ...updated, completed: autoComplete(updated) };
      }),
    }));
  }

  async function handleSave() {
    setSaving(true); setError('');
    try {
      const myName = userProfile?.displayName || currentUser.displayName || currentUser.email?.split('@')[0] || 'OL';
      // The OL may only edit `achievedValue` + `completed` on their OWN progress.
      // Preserve every Boss-set field (text, amount, targetValue, suffix, source) by
      // re-reading from the original `items` — a lowered target can't be persisted,
      // even if the client state were tampered. Matches APC/TL handleSave.
      const origInc = new Map((items.incentives || []).map(i => [i.id, i]));
      const origBon = new Map((items.bonuses    || []).map(b => [b.id, b]));
      const mapItem = (it, orig) => {
        const o = orig.get(it.id) || {};
        const isAtt = o.source === 'attendance';
        return {
          id: it.id, text: o.text, amount: o.amount,
          targetValue:   isAtt ? 100 : (Number(o.targetValue) || 0),
          achievedValue: isAtt ? (Number(o.achievedValue) || 0) : (Number(it.achievedValue) || 0),
          suffix:        isAtt ? '%' : itemSuffix(o),
          completed:     isAtt ? !!o.completed : (it.completed || false),
          completedBy:   isAtt ? (o.completedBy || null) : (it.completed ? (o.completedBy || myName) : null),
          ...(o.source ? { source: o.source } : {}),
          ...(o.brandId ? { brandId: o.brandId, brandName: o.brandName || null } : {}),
          // Same reason as brandId above: a fixed-field rebuild drops what it does not name.
          ...(o.commissionPct != null ? { commissionPct: Number(o.commissionPct) || 0 } : {}),
        };
      };
      await updateIncentivesProgress({
        rowId: record.id,
        incentives: editItems.incentives.map(i => mapItem(i, origInc)),
        bonuses:    editItems.bonuses.map(b => mapItem(b, origBon)),
      });
      onSaved(editItems);
    } catch { setError('Failed to save.'); } finally { setSaving(false); }
  }

  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 1070, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
      <div style={{ position: 'absolute', inset: 0, background: 'rgba(0,0,0,0.5)', backdropFilter: 'blur(2px)' }} onClick={onClose} />
      <div className="card border-0 shadow-lg" style={{ position: 'relative', width: '100%', maxWidth: 500, zIndex: 1, borderRadius: 14, maxHeight: '90vh', overflowY: 'auto' }}>
        <div className="card-body p-4">
          <div className="d-flex align-items-center justify-content-between mb-4">
            <div>
              <h6 className="fw-bold mb-0">Edit My Progress</h6>
              <p className="text-muted small mb-0">Update your target & achieved values</p>
            </div>
            <button className="btn btn-sm btn-light border-0 rounded-circle" onClick={onClose}
              style={{ width: 32, height: 32, padding: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <i className="bi bi-x-lg" style={{ fontSize: '0.85rem' }} />
            </button>
          </div>
          {editItems.incentives.length > 0 && (
            <div className="mb-3">
              <p className="text-muted fw-semibold mb-2" style={{ fontSize: '0.7rem', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                <i className="bi bi-graph-up-arrow me-1 text-success" />Incentives
              </p>
              {editItems.incentives.map(i => <EditRow key={i.id} item={i} cat="incentives" onChange={handleChange} lockTarget month={record?.month} />)}
            </div>
          )}
          {editItems.bonuses.length > 0 && (
            <div className="mb-3">
              <p className="text-muted fw-semibold mb-2" style={{ fontSize: '0.7rem', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                <i className="bi bi-trophy me-1 text-primary" />Bonuses
              </p>
              {editItems.bonuses.map(b => <EditRow key={b.id} item={b} cat="bonuses" onChange={handleChange} lockTarget month={record?.month} />)}
            </div>
          )}
          {error && <div className="alert alert-danger py-2 small mb-3">{error}</div>}
          <div className="d-flex gap-2 justify-content-end">
            <button className="btn btn-sm btn-outline-secondary px-3" onClick={onClose} disabled={saving}>Cancel</button>
            <button className="btn btn-sm btn-dark px-3 d-inline-flex align-items-center gap-1" onClick={handleSave} disabled={saving}>
              {saving ? <><span className="spinner-border spinner-border-sm" /> Saving…</> : <><i className="bi bi-check-lg" /> Save Progress</>}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── User Details Modal (OL viewing an APC/IPC, with edit/toggle/verify) ──────
function UserDetailsModal({ rec, user, readOnly = false, onClose, onToggleItem, onVerify, onUnverify, verifying }) {
  const [editMode, setEditMode] = useState(false);
  const [editItems, setEditItems] = useState({ incentives: [], bonuses: [] });

  // Reset edit state whenever the record changes (different user or fresh data)
  useEffect(() => {
    if (rec) {
      setEditItems({
        incentives: (rec.incentives || []).map(i => ({ ...i })),
        bonuses:    (rec.bonuses    || []).map(b => ({ ...b })),
      });
    }
    setEditMode(false);
  }, [rec?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!rec) return null;
  const { basic, incTotal, bonTotal, incAchieved, bonAchieved } = calcBreakdown(rec);
  const allItems = [...(rec.incentives || []), ...(rec.bonuses || [])];
  const completed = allItems.filter(i => i.completed).length;

  function handleEditChange(cat, itemId, field, value) {
    setEditItems(prev => ({
      ...prev,
      [cat]: prev[cat].map(it => {
        if (it.id !== itemId) return it;
        const updated = { ...it, [field]: value };
        return { ...updated, completed: autoComplete(updated) };
      }),
    }));
  }

  function diffSummary() {
    const changes = [];
    for (const cat of ['incentives', 'bonuses']) {
      const orig = rec[cat] || [];
      for (const edited of editItems[cat]) {
        const o = orig.find(x => x.id === edited.id);
        if (!o) continue;
        const oT = Number(o.targetValue) || 0, eT = Number(edited.targetValue) || 0;
        const oA = Number(o.achievedValue) || 0, eA = Number(edited.achievedValue) || 0;
        if (oT !== eT || oA !== eA) {
          changes.push({ id: edited.id, text: edited.text, fromTarget: oT, toTarget: eT, fromAchieved: oA, toAchieved: eA });
        }
      }
    }
    return changes;
  }

  function ItemDetail({ item, category }) {
    const p = pct(item.achievedValue, item.targetValue);
    const unitSfx = itemSuffix(item);
    const fmtN = n => Number(n || 0).toLocaleString();
    return (
      <div className="rounded-3 p-2 mb-2" style={{ background: item.completed ? '#f0fdf4' : '#fafafa', border: `1px solid ${item.completed ? '#b7dfc4' : '#e9ecef'}` }}>
        <div className="d-flex align-items-start justify-content-between gap-2">
          <div style={{ minWidth: 0, flex: 1 }}>
            <div className="small fw-semibold">{item.text || '—'}</div>
            {item.brandName && <div className="mt-1"><BrandChip name={item.brandName} /></div>}
            <div className="text-muted mt-1" style={{ fontSize: '0.72rem' }}>+{fmtN(item.amount)} PKR</div>
            {item.targetValue > 0 && (
              <div className="d-flex flex-wrap gap-3 mt-1" style={{ fontSize: '0.82rem' }}>
                <span><span className="text-muted">Target:</span> <span className="fw-semibold" style={{ color: '#1e293b' }}>{fmtUnitValue(item.targetValue, unitSfx)}</span></span>
                {item.achievedValue != null && (
                  <span>
                    <span className="text-muted">Achieved:</span>{' '}
                    <span className="fw-semibold" style={{ color: item.completed ? '#15803d' : '#0f172a' }}>
                      {fmtUnitValue(item.achievedValue, unitSfx)}
                    </span>
                    <span className="ms-1" style={{ color: item.completed ? '#16a34a' : '#475569', fontWeight: 600 }}>({p}%)</span>
                  </span>
                )}
              </div>
            )}
            {item.completedBy && (
              <div style={{ fontSize: '0.68rem', color: '#198754', marginTop: 4 }}>
                <i className="bi bi-person-check me-1" />Marked by {item.completedBy}
              </div>
            )}
          </div>
          <div className="d-flex align-items-center gap-1 flex-shrink-0">
            {item.source === 'attendance' && <AttendanceBadge />}
            {item.source === 'commission_tier' && <AutoBadge source="commission_tier" />}
            <span className="badge rounded-pill" style={{ fontSize: '0.6rem', background: item.completed ? '#e6f4ea' : '#f3f4f6', color: item.completed ? '#198754' : '#6c757d' }}>
              {item.completed ? '✓ Done' : `${p}%`}
            </span>
            {/* No manual tick for a commission line either: whether it is earned
                is decided by the brand's GMV against its goal, and `completed`
                is stripped at rest, so a tick here would not survive a save. */}
            {!readOnly && item.source !== 'attendance' && item.source !== 'commission_tier' && (
              <button className="btn btn-sm btn-link p-0" style={{ fontSize: '0.7rem', color: item.completed ? '#dc3545' : '#198754' }}
                onClick={() => onToggleItem(rec, category, item.id, !item.completed)}
                title={item.completed ? 'Mark incomplete' : 'Mark complete'}>
                <i className={`bi ${item.completed ? 'bi-x-circle' : 'bi-check-circle'}`} />
              </button>
            )}
          </div>
        </div>
        {item.targetValue > 0 && (
          <div className="mt-2">
            <div className="rounded-pill overflow-hidden" style={{ height: 4, background: '#e9ecef' }}>
              <div className="h-100 rounded-pill" style={{ width: `${p}%`, background: item.completed ? '#198754' : '#0d6efd', transition: 'width 0.3s' }} />
            </div>
          </div>
        )}
      </div>
    );
  }

  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 1070, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
      <div style={{ position: 'absolute', inset: 0, background: 'rgba(0,0,0,0.5)', backdropFilter: 'blur(2px)' }} onClick={onClose} />
      <div className="card border-0 shadow-lg" style={{ position: 'relative', width: '100%', maxWidth: 520, zIndex: 1, borderRadius: 14, maxHeight: '90vh', overflowY: 'auto' }}>
        <div className="card-body p-4">
          <div className="d-flex align-items-center justify-content-between mb-3">
            <div>
              <h6 className="fw-bold mb-0">{user?.userName || user?.displayName} — Details</h6>
              <p className="text-muted small mb-0 d-flex align-items-center gap-2 flex-wrap">
                <span>{getMonthLabel(rec.month)} · {completed}/{allItems.length} completed</span>
                {rec.ghosted && rec.sourceMonth && (
                  <span className="badge rounded-pill" style={{ background: '#dbeafe', color: '#1e40af', fontSize: '0.6rem', fontWeight: 600 }}
                    title={`Plan carried forward from ${getMonthLabel(rec.sourceMonth)}; will be saved as a new doc on first edit/verify.`}>
                    <i className="bi bi-arrow-down-circle me-1" />Carried from {getMonthLabel(rec.sourceMonth)}
                  </span>
                )}
              </p>
            </div>
            <div className="d-flex align-items-center gap-1">
              {!readOnly && !rec.verified && !editMode && (
                <button className="btn btn-sm btn-outline-secondary d-inline-flex align-items-center gap-1"
                  style={{ borderRadius: 8, fontSize: '0.72rem' }}
                  onClick={() => setEditMode(true)}
                  title="Edit Target/Achieved values">
                  <i className="bi bi-pencil" /> Edit
                </button>
              )}
              <button className="btn btn-sm btn-light border-0 rounded-circle" onClick={onClose}
                style={{ width: 32, height: 32, padding: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <i className="bi bi-x-lg" style={{ fontSize: '0.85rem' }} />
              </button>
            </div>
          </div>

          <div className="rounded-3 p-3 mb-3" style={{ background: '#f8f9fa', border: '1px solid #e9ecef' }}>
            <div className="d-flex justify-content-between small">
              <span className="text-muted">Basic Salary</span>
              <span className="fw-medium">{basic.toLocaleString()} PKR</span>
            </div>
            <div className="d-flex justify-content-between small">
              <span className="text-muted">Incentives Earned</span>
              <span className="fw-medium text-success">+{incAchieved.toLocaleString()} / {incTotal.toLocaleString()} PKR</span>
            </div>
            <div className="d-flex justify-content-between small">
              <span className="text-muted">Bonuses Earned</span>
              <span className="fw-medium text-primary">+{bonAchieved.toLocaleString()} / {bonTotal.toLocaleString()} PKR</span>
            </div>
            <div className="d-flex justify-content-between fw-bold pt-2 mt-2" style={{ borderTop: '1.5px solid #dee2e6' }}>
              <span>Total Earned</span>
              <span>{(basic + incAchieved + bonAchieved).toLocaleString()} PKR</span>
            </div>
          </div>

          {editMode && (
            <div className="alert d-flex align-items-start gap-2 py-2 mb-3"
              style={{ background: '#fef3c7', border: '1px solid #fde68a', borderRadius: 10, color: '#78350f', fontSize: '0.78rem' }}>
              <i className="bi bi-info-circle-fill flex-shrink-0 mt-1" />
              <div>Edit Target / Achieved values below. Saving will verify the record and notify {user?.userName || user?.displayName} of the changes.</div>
            </div>
          )}

          {(rec.incentives || []).length > 0 && (
            <div className="mb-3">
              <p className="text-muted small fw-semibold mb-2" style={{ fontSize: '0.7rem', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                <i className="bi bi-graph-up-arrow me-1 text-success" />Incentives
              </p>
              {(editMode ? editItems.incentives : rec.incentives).map(i =>
                editMode
                  ? <EditRow key={i.id} item={i} cat="incentives" onChange={handleEditChange} month={rec?.month} />
                  : <ItemDetail key={i.id} item={i} category="incentives" />
              )}
            </div>
          )}
          {(rec.bonuses || []).length > 0 && (
            <div className="mb-3">
              <p className="text-muted small fw-semibold mb-2" style={{ fontSize: '0.7rem', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                <i className="bi bi-trophy me-1 text-primary" />Bonuses
              </p>
              {(editMode ? editItems.bonuses : rec.bonuses).map(b =>
                editMode
                  ? <EditRow key={b.id} item={b} cat="bonuses" onChange={handleEditChange} month={rec?.month} />
                  : <ItemDetail key={b.id} item={b} category="bonuses" />
              )}
            </div>
          )}

          <InactiveBrandsNotice userId={user?.id} role={user?.userType} />

          <div className="d-flex gap-2 justify-content-end mt-3">
            {editMode ? (
              <>
                <button className="btn btn-sm btn-outline-secondary px-3" onClick={() => setEditMode(false)} disabled={verifying === rec.id}>
                  Cancel edits
                </button>
                <button className="btn btn-sm btn-success px-3 d-inline-flex align-items-center gap-1"
                  onClick={() => onVerify(rec, { editedItems: editItems, changes: diffSummary() })}
                  disabled={verifying === rec.id}>
                  {verifying === rec.id ? <><span className="spinner-border spinner-border-sm" /> Saving…</> : <><i className="bi bi-patch-check-fill" /> Save & Verify</>}
                </button>
              </>
            ) : (
              <>
                <button className="btn btn-sm btn-outline-secondary px-3" onClick={onClose}>Close</button>
                {!readOnly && !rec.verified && (
                  <button className="btn btn-sm btn-success px-3 d-inline-flex align-items-center gap-1"
                    onClick={() => onVerify(rec)} disabled={verifying === rec.id}>
                    {verifying === rec.id ? <><span className="spinner-border spinner-border-sm" /> Verifying…</> : <><i className="bi bi-patch-check-fill" /> Verify</>}
                  </button>
                )}
                {rec.verified && (
                  <span className="badge rounded-pill px-3 py-2 d-inline-flex align-items-center gap-1"
                    style={{ background: '#e6f4ea', color: '#15803d', border: '1px solid #bbf7d0', fontSize: '0.75rem' }}>
                    <i className="bi bi-patch-check-fill" /> Verified{rec.verifiedByRole ? ` by ${rec.verifiedByRole === 'boss' ? 'Boss' : rec.verifiedByRole.toUpperCase()}` : ''}
                  </span>
                )}
                {!readOnly && rec.verified && (
                  <button className="btn btn-sm btn-outline-warning px-3 d-inline-flex align-items-center gap-1"
                    onClick={() => onUnverify(rec)} disabled={verifying === rec.id}
                    title="Mark as unverified and notify the user">
                    {verifying === rec.id ? <><span className="spinner-border spinner-border-sm" /> Working…</> : <><i className="bi bi-arrow-counterclockwise" /> Mark Unverified</>}
                  </button>
                )}
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Main Page ────────────────────────────────────────────────────────────────
export default function OLIncentivesPage() {
  // v2 auth shim
  const { user, profile } = useAuth();
  const currentUser = user ? { uid: user.id, email: user.email, displayName: profile?.display_name || '' } : null;
  const userProfile = profile ? { displayName: profile.display_name || '' } : null;
  const currentMonth = getCurrentMonth();

  // Filters live in the URL so back-navigation from the form preserves them.
  const [searchParams, setSearchParams] = useSearchParams();
  const tab          = searchParams.get('tab') || 'apcs';
  const month        = searchParams.get('month') || currentMonth;
  const search       = searchParams.get('q') || '';
  const filterStatus = searchParams.get('status') || '';
  const filterTeam   = searchParams.get('team') || '';
  function patchUrl(updates) {
    const next = new URLSearchParams(searchParams);
    for (const [k, v] of Object.entries(updates)) {
      if (v == null || v === '') next.delete(k);
      else next.set(k, v);
    }
    setSearchParams(next, { replace: true });
  }
  const setTab          = v => patchUrl({ tab: v === 'apcs' ? '' : v });
  const setMonth        = v => patchUrl({ month: v === currentMonth ? '' : v });
  const setSearch       = v => patchUrl({ q: v });
  const setFilterStatus = v => patchUrl({ status: v });
  const setFilterTeam   = v => patchUrl({ team: v });

  // Own incentives state
  const [myRecord, setMyRecord] = useState(null);
  const [myItems, setMyItems] = useState({ incentives: [], bonuses: [] });
  const [showEditOwn, setShowEditOwn] = useState(false);
  const [myBrandStatus, setMyBrandStatus] = useState(null); // OL's incentive-brand roll-up

  // APC/IPC management state
  const [allUsers, setAllUsers] = useState([]); // both APCs and IPCs
  const [tlUsers, setTlUsers] = useState([]);   // Team Leads (read-only breakdown for the OL)
  const [olUsers, setOlUsers] = useState([]);   // Operation Leads (read-only view; includes self)
  const [amUsers, setAmUsers] = useState([]);   // Ads Managers (OL-managed, like APCs)
  const [records, setRecords] = useState({}); // userId → incentive doc
  const [loading, setLoading] = useState(true);
  const [detailsTarget, setDetailsTarget] = useState(null);
  const [verifying, setVerifying] = useState(null);

  // Search + filters (apcs/ipcs tabs)
  // (search/filterStatus/filterTeam now derived from URL above)

  useEffect(() => {
    if (!currentUser) return;
    async function load() {
      setLoading(true);

      // 1. Load OL's own incentive record + their brand roll-up (best-effort)
      fetchOlBrandStatus(currentUser.uid, month)
        .then((s) => setMyBrandStatus(s))
        .catch(() => setMyBrandStatus([]));
      const myRec = await getIncentives(currentUser.uid, month);
      if (myRec) {
        setMyRecord(myRec);
        setMyItems({
          incentives: (myRec.incentives || []).map(i => ({ ...i, achievedValue: i.achievedValue ?? '', targetValue: i.targetValue ?? '', suffix: itemSuffix(i) })),
          bonuses:    (myRec.bonuses    || []).map(b => ({ ...b, achievedValue: b.achievedValue ?? '', targetValue: b.targetValue ?? '', suffix: itemSuffix(b) })),
        });
      } else {
        setMyRecord(null);
        setMyItems({ incentives: [], bonuses: [] });
      }

      // 2. Load ALL APCs and IPCs, and (for the read-only TL + OL breakdowns) all TLs and OLs.
      const [teamList, tlList, olList, amList] = await Promise.all([
        listUsersByRoles(['apc', 'ipc']),
        listUsersByRoles(['tl']),
        listUsersByRoles(['ol']),
        // Ads Managers — listUsersByRoles resolves their brands from
        // ads_manager_brands (mig 316), so the cards show the brands they run
        // ads for, exactly like an APC's assigned brands.
        listUsersByRoles(['ads_manager']),
      ]);
      setAllUsers(teamList);
      setTlUsers(tlList);
      setAmUsers(amList);
      // Show every OL the brands behind each OL's incentive. Load ALL OLs' curated
      // brands in one query (oib_select RLS lets an active OL/Boss read every row)
      // and attach per OL, so the OL Incentives tab cards render them.
      let olBrandMap = {};
      try { olBrandMap = await listOlBrandsByOl(); } catch { olBrandMap = {}; }
      setOlUsers((olList || []).map((ol) => ({ ...ol, assignedBrands: olBrandMap[ol.id] || [] })));

      // 3. Load all incentive records for the selected month (an active OL can read
      // every incentive row per RLS; we keep APC/IPC + TL and key them by user).
      const incList = await listIncentivesMonth(month);
      const map = {};
      incList.forEach((data) => {
        const uid = data.userId;
        if (!uid) return;
        if (['apc', 'ipc', 'tl', 'ol', 'ads_manager'].includes(data.userRole)) {
          map[uid] = data;
        }
      });

      // 3b. Auto carry-forward: for any managed user (APC/IPC/TL) without a plan
      // this month, fall back to their most recent prior plan and synthesise a
      // ghost record (no doc yet) with achieved/completed reset.
      const missing = [...teamList, ...tlList, ...olList, ...amList].filter(u => !map[u.id]);
      await Promise.all(missing.map(async (u) => {
        try {
          const prior = await getMostRecentPriorPlan(u.id, month);
          if (!prior) return;
          map[u.id] = {
            ...prior,
            id: `ghost:${u.id}`,
            _ghost: true,
            ghosted: true,
            sourceMonth: prior.month,
            month,
            verified: false, verifiedAt: null, verifiedBy: null, verifiedByName: null, verifiedByRole: null,
            payoutCleared: false, payoutClearedAt: null, payoutClearedBy: null,
            incentives: (prior.incentives || []).map(i => ({ ...i, completed: false, achievedValue: 0, completedBy: null })),
            bonuses:    (prior.bonuses    || []).map(b => ({ ...b, completed: false, achievedValue: 0, completedBy: null })),
          };
        } catch (err) {
          // eslint-disable-next-line no-console
          console.warn('Carry-forward lookup failed for', u.id, err);
        }
      }));

      setRecords(map);
      setLoading(false);
    }
    load();
  }, [currentUser?.uid, month]);  // eslint-disable-line react-hooks/exhaustive-deps

  // Materialise a ghost (carried-over) record into a real row.
  // Returns the rec with a real id assigned. Updates local state too.
  async function materializeGhost(rec) {
    if (!rec.ghosted) return rec;
    const userKey = rec.userId;
    const saved = await savePlan({
      id: null,
      userId: userKey,
      month,
      basicSalary: rec.basicSalary || 0,
      incentives: rec.incentives || [],
      bonuses:    rec.bonuses    || [],
    });
    const live = { ...rec, ...saved, id: saved.id, ghosted: false, _ghost: false, carriedFrom: rec.sourceMonth || null };
    setRecords(prev => ({ ...prev, [userKey]: live }));
    return live;
  }

  const apcs = allUsers.filter(u => !u.userType || u.userType === 'apc');
  const ipcs = allUsers.filter(u => u.userType === 'ipc');
  const baseList = tab === 'apcs' ? apcs : tab === 'ipcs' ? ipcs : tab === 'tls' ? tlUsers
    : tab === 'ols' ? olUsers : tab === 'ams' ? amUsers : [];
  // The OL manages APC/IPC, TL and Ads Manager incentives. OL incentives are the
  // Boss's to manage, so only the OL tab is read-only here. (Server-side too: mig
  // 301 lets an OL write/verify any target except roles ol/developer/boss, and
  // hard-locks the OL/admin rows — so every editable tab is backed by RLS.)
  const readOnly = tab === 'ols';
  const tabNoun = tab === 'apcs' ? 'APCs' : tab === 'ipcs' ? 'IPCs' : tab === 'tls' ? 'TLs'
    : tab === 'ams' ? 'Ads Managers' : 'OLs';
  const roleWord = tab === 'apcs' ? 'APC' : tab === 'ipcs' ? 'IPC' : tab === 'tls' ? 'TL'
    : tab === 'ams' ? 'Ads Manager' : tab === 'ols' ? 'OL' : '';

  // Apply search + filters before rendering and for stats
  const list = baseList.filter(u => {
    if (search.trim()) {
      const q = search.trim().toLowerCase();
      const haystack = `${u.userName || ''} ${u.email || ''} ${u.ownerName || ''}`.toLowerCase();
      if (!haystack.includes(q)) return false;
    }
    if (filterTeam && u.ownerId !== filterTeam) return false;
    const rec = records[u.id];
    if (filterStatus === 'no_plan' && rec) return false;
    if (filterStatus === 'has_plan' && !rec) return false;
    if (filterStatus === 'verified' && !rec?.verified) return false;
    if (filterStatus === 'unverified' && (!rec || rec.verified)) return false;
    return true;
  });

  // Team options for filter dropdown (unique TLs across the visible base list)
  const teamOptions = Array.from(
    baseList.reduce((m, u) => { if (u.ownerId) m.set(u.ownerId, u.ownerName || 'Team Lead'); return m; }, new Map())
  ).map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name));

  const hasFilters = !!(search || filterStatus || filterTeam);
  const clearFilters = () => { setSearch(''); setFilterStatus(''); setFilterTeam(''); };

  async function handleToggleItem(recArg, category, itemId, newCompleted) {
    const live = await materializeGhost(recArg);
    const updated = { ...live, [category]: live[category].map(i => i.id === itemId ? { ...i, completed: newCompleted, completedBy: newCompleted ? 'OL' : null } : i) };
    await updateIncentivesProgress({
      rowId: live.id,
      incentives: updated.incentives,
      bonuses:    updated.bonuses,
    });
    const key = live.userId;
    setRecords(prev => ({ ...prev, [key]: updated }));
    setDetailsTarget(prev => prev ? { ...prev, rec: updated } : prev);
  }

  async function handleVerify(recArg, editsPayload = null) {
    setVerifying(recArg.id);
    try {
      const rec = await materializeGhost(recArg);
      const myName = userProfile?.displayName || currentUser?.displayName || 'Operation Lead';

      // If OL adjusted any items inline, persist them first.
      const changes = editsPayload?.changes || [];
      let savedRec = rec;
      if (editsPayload?.editedItems && changes.length > 0) {
        const sanitize = (arr) => arr.map(i => ({
          id: i.id, text: i.text, amount: i.amount,
          targetValue: Number(i.targetValue) || 0,
          achievedValue: Number(i.achievedValue) || 0,
          suffix: itemSuffix(i),
          completed: !!i.completed,
          completedBy: i.completed ? (i.completedBy || myName) : null,
          ...(i.source ? { source: i.source } : {}),
          ...(i.brandId ? { brandId: i.brandId, brandName: i.brandName || null } : {}),
          // Same reason as brandId above: a fixed-field rebuild drops what it does not name.
          ...(i.commissionPct != null ? { commissionPct: Number(i.commissionPct) || 0 } : {}),
        }));
        savedRec = await updateIncentivesProgress({
          rowId: rec.id,
          incentives: sanitize(editsPayload.editedItems.incentives),
          bonuses:    sanitize(editsPayload.editedItems.bonuses),
        });
        // updateIncentivesProgress strips { source:'attendance' } items server-side
        // (achievedValue:null, completed:false). Re-apply the read-time overlay so
        // the row we write to state shows the live % / completion instead of the
        // stripped nulls (otherwise the Earned total visibly drops until reload).
        // Re-overlay ALL derived sources, not just attendance: the row was just
        // saved with commission/GMV-Max figures blanked at rest, so an
        // attendance-only refresh would leave those reading zero until reload.
        const [overlaid] = await applyDerivedAutofill([savedRec], rec.month);
        savedRec = overlaid;
      }

      // Flip verified via the SECURITY DEFINER RPC. The server stamps
      // verified_by + verified_at and emits a notification to the user.
      await verifyIncentives(rec.id, true);

      const key = rec.userId;
      const updatedRec = {
        ...savedRec,
        verified: true,
        verifiedByName: myName,
        verifiedByRole: 'ol',
      };
      setRecords(prev => ({ ...prev, [key]: updatedRec }));

      setDetailsTarget(null);
    } finally { setVerifying(null); }
  }

  async function handleUnverify(rec) {
    if (rec.ghosted) return;
    // eslint-disable-next-line no-alert
    if (!window.confirm(`Mark ${rec.userName || 'this user'}'s incentives as unverified for ${getMonthLabel(rec.month)}? They will be notified.`)) return;
    setVerifying(rec.id);
    try {
      // inc_verify(rec.id, false) un-verifies and resets payout_cleared
      // server-side. v2 RPC does NOT push a notification on unverify
      // by default, so we follow up with notifyIncentiveEmployee to
      // emit a "your incentives have been updated" ping. v1's body
      // text differed; close enough for parity since the action is
      // surfaced in the notifications list anyway.
      await verifyIncentives(rec.id, false);
      try { await notifyIncentiveEmployee(rec.id); } catch { /* non-fatal */ }
      const key = rec.userId;
      setRecords(prev => ({ ...prev, [key]: { ...rec, verified: false, verifiedByName: null, verifiedByRole: null, payoutCleared: false } }));
      setDetailsTarget(null);
    } finally { setVerifying(null); }
  }

  function handleSavedOwn(updatedItems) {
    setMyItems(updatedItems);
    setShowEditOwn(false);
  }

  // Stats for selected tab (APC or IPC)
  const totalPayout   = list.reduce((s, u) => { const r = records[u.id]; return r ? s + calcBreakdown(r).total : s; }, 0);
  const recordsCount  = list.filter(u => records[u.id]).length;
  const verifiedCount = list.filter(u => records[u.id]?.verified).length;

  // ── Combined payout snapshot — ONE cumulative figure across EVERYONE the office
  // pays below the Boss (APCs + IPCs + TLs + both OLs), shown identically on every
  // management tab. OLs are included so the total reflects the WHOLE payroll (the
  // OLs' own salary + incentives were previously excluded). ──
  const snapshotStats = computeCombinedStats([...apcs, ...ipcs, ...tlUsers, ...olUsers, ...amUsers], records);

  // My incentives summary
  const myAllItems     = [...myItems.incentives, ...myItems.bonuses];
  const myCompleted    = myAllItems.filter(i => i.completed);
  const myEarned       = myCompleted.reduce((s, i) => s + (Number(i.amount) || 0), 0);
  const myPotential    = myAllItems.reduce((s, i) => s + (Number(i.amount) || 0), 0);
  const myBasic        = Number(myRecord?.basicSalary) || 0;
  const myTotalEarned  = myBasic + myEarned;
  const myCompletionPct = myAllItems.length > 0 ? Math.round((myCompleted.length / myAllItems.length) * 100) : 0;
  const myName = userProfile?.displayName || currentUser?.displayName || 'Operation Lead';

  return (
    <div>
      {/* Header */}
      <div className="d-flex align-items-center justify-content-between flex-wrap gap-3 mb-4">
        <div>
          <h5 className="fw-bold mb-1">Incentives & Bonuses</h5>
          <p className="text-muted mb-0" style={{ fontSize: '0.82rem' }}>
            <i className="bi bi-calendar3 me-1" />{getMonthLabel(month)}
          </p>
        </div>
        <input type="month" className="form-control form-control-sm"
          value={month} onChange={e => setMonth(e.target.value)}
          style={{ width: 160, fontSize: '0.8rem', borderRadius: 8 }} />
      </div>

      {/* Combined payout snapshot — cumulative for the active management tab */}
      {!loading && tab !== 'my' && snapshotStats.teamSize > 0 && (
        <CombinedPayoutSnapshot stats={snapshotStats} monthLabel={getMonthLabel(month)} />
      )}

      {/* Tabs */}
      <div className="d-flex gap-1 mb-4" style={{ borderBottom: '2px solid #e9ecef' }}>
        {[
          { key: 'apcs', label: 'APC Incentives', icon: 'bi-people' },
          { key: 'ipcs', label: 'IPC Incentives', icon: 'bi-people-fill' },
          { key: 'tls',  label: 'TL Incentives',  icon: 'bi-person-badge' },
          { key: 'ams',  label: 'Ads Managers',   icon: 'bi-megaphone' },
          { key: 'ols',  label: 'OL Incentives',  icon: 'bi-person-workspace' },
          { key: 'my',   label: 'My Incentives',  icon: 'bi-person' },
        ].map(t => (
          <button key={t.key} onClick={() => setTab(t.key)}
            className="btn btn-sm px-3 py-2 d-inline-flex align-items-center gap-1"
            style={{
              borderRadius: '8px 8px 0 0', fontWeight: 600, fontSize: '0.78rem',
              background: tab === t.key ? '#1a1a2e' : 'transparent',
              color: tab === t.key ? '#fff' : '#6c757d',
              border: 'none', marginBottom: -2,
            }}>
            <i className={`bi ${t.icon}`} />{t.label}
          </button>
        ))}
      </div>

      {loading ? (
        <div className="text-muted small d-flex align-items-center gap-2">
          <span className="spinner-border spinner-border-sm" /> Loading…
        </div>
      ) : tab === 'my' ? (
        /* ── My Incentives Tab ── */
        !myRecord ? (
          <div className="text-center py-5 rounded-4" style={{ border: '2px dashed var(--border-subtle)', background: 'var(--surface-1)', maxWidth: 600 }}>
            <div className="rounded-circle d-flex align-items-center justify-content-center mx-auto mb-3" style={{ width: 64, height: 64, background: 'var(--surface-2)' }}>
              <i className="bi bi-trophy text-muted" style={{ fontSize: '1.8rem', opacity: 0.55 }} />
            </div>
            <p className="fw-semibold mb-1" style={{ color: 'var(--text-primary)' }}>No incentive plan yet</p>
            <p className="text-muted small mb-0">No plan has been set for {getMonthLabel(month)}.</p>
          </div>
        ) : (
          <div style={{ maxWidth: 600 }}>
            <div className="card border-0 shadow-sm" style={{ borderRadius: 14, overflow: 'hidden' }}>
              <div style={{ height: 4, background: myRecord.verified ? 'linear-gradient(90deg,#198754,#51cf66)' : 'linear-gradient(90deg,#fd7e14,#ffa94d)' }} />
              <div className="p-3 d-flex align-items-center gap-3" style={{ background: 'linear-gradient(135deg,#1a1a2e,#0f3460)', color: '#fff' }}>
                <div className="rounded-circle d-flex align-items-center justify-content-center fw-bold flex-shrink-0"
                  style={{ width: 42, height: 42, background: 'rgba(255,255,255,0.15)', fontSize: '0.85rem' }}>
                  {myName.slice(0, 2).toUpperCase()}
                </div>
                <div className="flex-grow-1">
                  <div className="fw-bold">{myName}</div>
                  <div style={{ fontSize: '0.72rem', opacity: 0.7 }}>{getMonthLabel(month)} · Operation Lead</div>
                </div>
                {myRecord.verified && (
                  <span className="badge rounded-pill" style={{ background: '#e6f4ea', color: '#198754', fontSize: '0.62rem' }}>
                    <i className="bi bi-patch-check-fill me-1" />Boss Verified
                  </span>
                )}
              </div>
              <div className="card-body p-3">
                <div className="d-flex flex-column gap-1 mb-3" style={{ fontSize: '0.82rem' }}>
                  <div className="d-flex justify-content-between"><span className="text-muted">Basic Salary</span><span className="fw-medium">{myBasic.toLocaleString()} PKR</span></div>
                  <div className="d-flex justify-content-between"><span className="text-muted">Earned ({myCompleted.length}/{myAllItems.length} items)</span><span className="fw-medium text-success">+{myEarned.toLocaleString()} PKR</span></div>
                  <div className="d-flex justify-content-between fw-bold pt-2 mt-1" style={{ borderTop: '1.5px solid #dee2e6', fontSize: '0.9rem' }}>
                    <span>Total Earned</span><span>{myTotalEarned.toLocaleString()} PKR</span>
                  </div>
                  <div className="text-muted text-end" style={{ fontSize: '0.68rem' }}>Potential: {(myBasic + myPotential).toLocaleString()} PKR</div>
                </div>
                <div className="mb-3">
                  <div className="d-flex justify-content-between mb-1" style={{ fontSize: '0.7rem' }}>
                    <span className="text-muted">Completion</span>
                    <span className="fw-semibold">{myCompleted.length}/{myAllItems.length} ({myCompletionPct}%)</span>
                  </div>
                  <div className="rounded-pill overflow-hidden" style={{ height: 6, background: '#e9ecef' }}>
                    <div className="h-100 rounded-pill" style={{ width: `${myCompletionPct}%`, background: myCompletionPct === 100 ? '#198754' : '#0d6efd', transition: 'width 0.4s' }} />
                  </div>
                </div>
                {!myRecord.payoutCleared && (
                  <button className="btn btn-sm btn-dark w-100 d-inline-flex align-items-center justify-content-center gap-1"
                    style={{ borderRadius: 8, fontSize: '0.78rem' }} onClick={() => setShowEditOwn(true)}>
                    <i className="bi bi-pencil" /> Edit Progress
                  </button>
                )}
              </div>
            </div>
            {myBrandStatus && (
              <OlBrandPanel status={myBrandStatus}
                paid={!!myRecord.payoutCleared}
                olItem={(myRecord.incentives || []).find((i) => i.source === 'ol_brands')} />
            )}
          </div>
        )
      ) : (
        /* ── APC/IPC Management Tab ── */
        <>
          {recordsCount > 0 && (
            <div className="d-flex gap-2 flex-wrap mb-3">
              {[
                // This section's OWN role total, sitting right beside the combined
                // (all-roles) total so the OL sees both figures in every section.
                { label: `${roleWord} Payout`,  value: `${totalPayout.toLocaleString()} PKR`,               bg: 'linear-gradient(135deg,#1a1a2e,#0f3460)', color: '#fff', sub: `${roleWord} total` },
                { label: 'Combined Payout',      value: `${snapshotStats.totalPayout.toLocaleString()} PKR`, bg: '#0f172a', color: '#fff', sub: 'all roles incl. OLs' },
                { label: 'With Plans',           value: `${recordsCount} / ${list.length}`,                  bg: '#e8f0fe', color: '#0d6efd' },
                { label: 'Verified',             value: `${verifiedCount} / ${recordsCount}`,                bg: '#e6f4ea', color: '#198754' },
              ].map(s => (
                <div key={s.label} className="rounded-3 px-3 py-2 text-center" style={{ background: s.bg, color: s.color, minWidth: 120 }}>
                  <div style={{ fontSize: '0.6rem', opacity: 0.7, letterSpacing: 1, textTransform: 'uppercase' }}>{s.label}</div>
                  <div className="fw-bold" style={{ fontSize: '1rem' }}>{s.value}</div>
                  {s.sub && <div style={{ fontSize: '0.55rem', opacity: 0.6, marginTop: 1 }}>{s.sub}</div>}
                </div>
              ))}
            </div>
          )}

          {/* Search + filters */}
          {baseList.length > 0 && (
            <div className="d-flex flex-wrap gap-2 align-items-center mb-3">
              <div className="position-relative flex-grow-1" style={{ minWidth: 200, maxWidth: 320 }}>
                <i className="bi bi-search position-absolute text-muted"
                  style={{ left: 10, top: '50%', transform: 'translateY(-50%)', fontSize: '0.78rem', pointerEvents: 'none' }} />
                <input type="text" className="form-control form-control-sm"
                  placeholder={`Search ${tabNoun}…`}
                  style={{ paddingLeft: 28, borderRadius: 8 }}
                  value={search} onChange={e => setSearch(e.target.value)} />
              </div>
              <select className="form-select form-select-sm"
                value={filterStatus} onChange={e => setFilterStatus(e.target.value)}
                style={{ width: 160, borderRadius: 8 }}>
                <option value="">All Statuses</option>
                <option value="no_plan">No Plan</option>
                <option value="has_plan">With Plan</option>
                <option value="verified">Verified</option>
                <option value="unverified">Unverified</option>
              </select>
              {!readOnly && teamOptions.length > 0 && (
                <select className="form-select form-select-sm"
                  value={filterTeam} onChange={e => setFilterTeam(e.target.value)}
                  style={{ width: 180, borderRadius: 8 }}>
                  <option value="">All Teams</option>
                  {teamOptions.map(t => (
                    <option key={t.id} value={t.id}>Team {t.name}</option>
                  ))}
                </select>
              )}
              {hasFilters && (
                <button className="btn btn-sm btn-outline-secondary d-inline-flex align-items-center gap-1"
                  style={{ borderRadius: 8, fontSize: '0.72rem' }} onClick={clearFilters}>
                  <i className="bi bi-x-circle" /> Clear
                </button>
              )}
              <span className="text-muted small ms-auto" style={{ fontSize: '0.75rem' }}>
                {list.length} of {baseList.length}
              </span>
            </div>
          )}

          {list.length === 0 ? (
            <div className="text-center py-5" style={{ border: '2px dashed #dee2e6', borderRadius: 12 }}>
              <i className="bi bi-people text-muted" style={{ fontSize: '2.5rem', opacity: 0.3 }} />
              <p className="text-muted mt-3 mb-0">
                {hasFilters
                  ? `No ${tabNoun} match your filters.`
                  : `No ${tabNoun} in the office yet.`}
              </p>
            </div>
          ) : (
            <div className="row g-3">
              {list.map(user => {
                const rec = records[user.id];
                const hasData = Boolean(rec);
                // For OL cards, flag each brand that already hit its GMV target (its
                // owning TL completed the linked item) so the OL sees who's tracking.
                const brands = (user.assignedBrands || []).map(b =>
                  b.ownerId ? { ...b, is_hit: brandHitByTL(records[b.ownerId], b) } : b);
                const totalItems = hasData ? (rec.incentives || []).length + (rec.bonuses || []).length : 0;
                const completedItems = hasData ? (rec.incentives || []).filter(i => i.completed).length + (rec.bonuses || []).filter(b => b.completed).length : 0;
                const breakdown = hasData ? calcBreakdown(rec) : null;
                return (
                  <div key={user.id} className="col-md-6 col-xl-4">
                    <div className="card border-0 shadow-sm h-100" style={{ borderRadius: 14, overflow: 'hidden' }}>
                      <div style={{ height: 4, background: hasData ? (rec.verified ? 'linear-gradient(90deg,#198754,#51cf66)' : 'linear-gradient(90deg,#fd7e14,#ffa94d)') : '#dee2e6' }} />
                      <div className="card-body p-3">
                        <div className="d-flex align-items-center gap-2 mb-2">
                          <div className="rounded-circle d-flex align-items-center justify-content-center fw-bold text-white flex-shrink-0"
                            style={{ width: 36, height: 36, background: '#1a1a2e', fontSize: '0.75rem' }}>
                            {(user.userName || '?').slice(0, 2).toUpperCase()}
                          </div>
                          <div className="flex-grow-1 min-width-0">
                            <div className="fw-semibold text-truncate small">{user.userName}</div>
                            <div className="text-muted text-truncate" style={{ fontSize: '0.68rem' }}>
                              {user.ownerName ? `Under ${user.ownerName}` : user.email}
                            </div>
                          </div>
                          {hasData && rec.verified && (
                            <span className="badge rounded-pill" title="Verified" style={{ background: '#e6f4ea', color: '#198754', fontSize: '0.58rem' }}>
                              <i className="bi bi-patch-check-fill" />
                            </span>
                          )}
                          {hasData && rec.ghosted && (
                            <span className="badge rounded-pill" title={`Carried over from ${getMonthLabel(rec.sourceMonth)}`}
                              style={{ background: '#dbeafe', color: '#1e40af', fontSize: '0.58rem', fontWeight: 600 }}>
                              <i className="bi bi-arrow-down-circle" /> Carried
                            </span>
                          )}
                        </div>

                        {brands.length > 0 && (
                          <div className="d-flex flex-wrap gap-1 mb-2">
                            {brands.map((b) => (
                              <BrandTierChip key={b.id || b.name} brand={b} />
                            ))}
                          </div>
                        )}

                        {hasData ? (
                          <>
                            <div className="rounded-3 p-2 mb-2" style={{ background: '#f8f9fa' }}>
                              <div className="d-flex justify-content-between" style={{ fontSize: '0.7rem' }}>
                                <span className="text-muted">Total Payout</span>
                                <span className="fw-bold text-dark">{breakdown.total.toLocaleString()} PKR</span>
                              </div>
                              <div className="d-flex justify-content-between" style={{ fontSize: '0.65rem' }}>
                                <span className="text-muted">Items</span>
                                <span className="text-muted">{completedItems}/{totalItems} done</span>
                              </div>
                            </div>
                            <div className="d-flex gap-1">
                              <button className="btn btn-sm flex-grow-1 d-inline-flex align-items-center justify-content-center gap-1"
                                style={{ border: '1.5px solid #dee2e6', borderRadius: 8, background: '#fff', color: '#495057', fontSize: '0.7rem' }}
                                onClick={() => setDetailsTarget({ user, rec })}>
                                <i className="bi bi-eye" /> Details
                              </button>
                              {!readOnly && (
                                <Link to={`/incentives/edit/${user.id}?month=${encodeURIComponent(month)}`} className="btn btn-sm flex-grow-1 d-inline-flex align-items-center justify-content-center gap-1 btn-dark"
                                  style={{ borderRadius: 8, fontSize: '0.7rem' }}>
                                  <i className="bi bi-pencil" /> Edit Plan
                                </Link>
                              )}
                            </div>
                          </>
                        ) : readOnly ? (
                          <div className="text-muted text-center py-1" style={{ fontSize: '0.72rem' }}>
                            No incentive plan set for {getMonthLabel(month)}.
                          </div>
                        ) : (
                          <Link to={`/incentives/edit/${user.id}?month=${encodeURIComponent(month)}`} className="btn btn-sm btn-outline-dark w-100 d-inline-flex align-items-center justify-content-center gap-1"
                            style={{ borderRadius: 8, fontSize: '0.72rem' }}>
                            <i className="bi bi-plus-lg" /> Create Plan
                          </Link>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </>
      )}

      {detailsTarget && (
        <UserDetailsModal
          rec={detailsTarget.rec}
          user={detailsTarget.user}
          // Only the OL section is read-only (Boss-managed). Drive off the section's
          // readOnly flag so the OL Details modal keeps hiding Verify/Edit/toggle,
          // while the TL modal now exposes them (OL manages TL incentives).
          readOnly={readOnly}
          onClose={() => setDetailsTarget(null)}
          onToggleItem={handleToggleItem}
          onVerify={handleVerify}
          onUnverify={handleUnverify}
          verifying={verifying}
        />
      )}
      {showEditOwn && myRecord && (
        <EditOwnModal record={myRecord} items={myItems} onClose={() => setShowEditOwn(false)} onSaved={handleSavedOwn} />
      )}
    </div>
  );
}

// ── Combined payout snapshot block (APCs + IPCs cumulative) ─────────────────
function CombinedPayoutSnapshot({ stats: s, monthLabel }) {
  const fmt = n => Number(n || 0).toLocaleString();
  const pkr = n => fmt(n) + ' PKR';
  const total = s.totalPayout || 1;
  const basePct = (s.totalBase    / total) * 100;
  const incPct  = (s.incEarned    / total) * 100;
  const bonPct  = (s.bonEarned    / total) * 100;

  const achTotal = Math.max(1, s.fullyAchieved + s.partial + s.noneEarned);
  const fullPct  = (s.fullyAchieved / achTotal) * 100;
  const partPct  = (s.partial       / achTotal) * 100;
  const nonePct  = (s.noneEarned    / achTotal) * 100;

  const incPotentialPct = s.incPotential > 0 ? Math.round((s.incEarned / s.incPotential) * 100) : 0;
  const bonPotentialPct = s.bonPotential > 0 ? Math.round((s.bonEarned / s.bonPotential) * 100) : 0;

  return (
    <div className="rounded-3 mb-4 p-3" style={{ background: '#fff', border: '1px solid #e2e8f0' }}>
      <div className="d-flex align-items-center justify-content-between mb-3 flex-wrap gap-2">
        <div>
          <div className="fw-bold" style={{ fontSize: '0.95rem', color: '#0f172a' }}>Combined payout · {monthLabel}</div>
          <div className="text-muted" style={{ fontSize: '0.72rem' }}>
            Cumulative across {s.teamSize} member{s.teamSize === 1 ? '' : 's'} ({s.withPlans} with plans, {s.noPlan} without)
          </div>
        </div>
        <span className="d-inline-flex align-items-center gap-1 rounded-pill px-2 py-1"
          style={{ background: '#0f172a', color: '#fff', fontSize: '0.78rem', fontWeight: 700 }}>
          <i className="bi bi-cash-coin" /> {pkr(s.totalPayout)}
        </span>
      </div>

      {/* 4 KPI tiles */}
      <div className="row g-2 mb-3">
        <div className="col-6 col-lg-3">
          <KpiTile label="Base Salary" value={pkr(s.totalBase)} sub={s.withPlans + ' members on payroll'} dot="#64748b" />
        </div>
        <div className="col-6 col-lg-3">
          <KpiTile label="Incentives Earned" value={pkr(s.incEarned)}
            sub={'of ' + pkr(s.incPotential) + ' (' + incPotentialPct + '%)'} dot="#16a34a" />
        </div>
        <div className="col-6 col-lg-3">
          <KpiTile label="Bonuses Earned" value={pkr(s.bonEarned)}
            sub={'of ' + pkr(s.bonPotential) + ' (' + bonPotentialPct + '%)'} dot="#3b82f6" />
        </div>
        <div className="col-6 col-lg-3">
          <KpiTile label="Total Payout" value={pkr(s.totalPayout)} sub="base + incentives + bonuses" dot="#0f172a" prominent />
        </div>
      </div>

      {/* Stacked breakdown — payout composition */}
      <div className="mb-3">
        <div className="d-flex align-items-center justify-content-between mb-1" style={{ fontSize: '0.78rem' }}>
          <span className="text-muted fw-semibold">Payout composition</span>
          <span className="text-muted">{pkr(s.totalPayout)} total</span>
        </div>
        <div className="rounded-pill d-flex overflow-hidden" style={{ height: 16, background: '#f1f5f9' }}>
          {basePct > 0 && <div title={'Base ' + pkr(s.totalBase)} style={{ width: basePct + '%', background: '#64748b', transition: 'width .3s' }} />}
          {incPct > 0  && <div title={'Incentives ' + pkr(s.incEarned)} style={{ width: incPct  + '%', background: '#16a34a', transition: 'width .3s' }} />}
          {bonPct > 0  && <div title={'Bonuses ' + pkr(s.bonEarned)}    style={{ width: bonPct  + '%', background: '#3b82f6', transition: 'width .3s' }} />}
        </div>
        <div className="d-flex flex-wrap gap-3 mt-2" style={{ fontSize: '0.78rem' }}>
          <Legend color="#64748b" label="Base" value={pkr(s.totalBase)} />
          <Legend color="#16a34a" label="Incentives" value={pkr(s.incEarned)} />
          <Legend color="#3b82f6" label="Bonuses" value={pkr(s.bonEarned)} />
        </div>
      </div>

      {/* Achievement breakdown */}
      <div style={{ borderTop: '1px solid #f1f5f9', paddingTop: 12 }}>
        <div className="d-flex align-items-center justify-content-between mb-1" style={{ fontSize: '0.78rem' }}>
          <span className="text-muted fw-semibold">Incentive achievement</span>
          <span className="text-muted">{s.fullyAchieved + s.partial} of {s.fullyAchieved + s.partial + s.noneEarned} earned something</span>
        </div>
        <div className="rounded-pill d-flex overflow-hidden" style={{ height: 16, background: '#f1f5f9' }}>
          {fullPct > 0 && <div title={'Fully achieved: ' + s.fullyAchieved} style={{ width: fullPct + '%', background: '#16a34a', transition: 'width .3s' }} />}
          {partPct > 0 && <div title={'Partial: ' + s.partial}              style={{ width: partPct + '%', background: '#fbbf24', transition: 'width .3s' }} />}
          {nonePct > 0 && <div title={'Nothing earned: ' + s.noneEarned}    style={{ width: nonePct + '%', background: '#cbd5e1', transition: 'width .3s' }} />}
        </div>
        <div className="d-flex flex-wrap gap-3 mt-2" style={{ fontSize: '0.78rem' }}>
          <Legend color="#16a34a" label="Fully achieved" value={s.fullyAchieved} />
          <Legend color="#fbbf24" label="Partial"        value={s.partial} />
          <Legend color="#cbd5e1" label="Nothing earned" value={s.noneEarned} />
        </div>
      </div>
    </div>
  );
}

function KpiTile({ label, value, sub, dot, prominent }) {
  return (
    <div className="rounded-3 h-100 p-3" style={{
      background: prominent ? '#0f172a' : '#f8fafc',
      border: prominent ? '1px solid #0f172a' : '1px solid #e2e8f0',
      color: prominent ? '#fff' : '#0f172a',
    }}>
      <div className="d-flex align-items-center gap-2" style={{ fontSize: '0.66rem', fontWeight: 700, letterSpacing: '0.04em', textTransform: 'uppercase', color: prominent ? 'rgba(255,255,255,0.7)' : '#64748b' }}>
        <span style={{ width: 7, height: 7, borderRadius: '50%', background: dot, display: 'inline-block' }} />
        {label}
      </div>
      <div className="fw-bold" style={{ fontSize: '1.05rem', letterSpacing: '-0.01em', lineHeight: 1.15, marginTop: 6 }}>{value}</div>
      {sub && <div style={{ fontSize: '0.7rem', marginTop: 2, color: prominent ? 'rgba(255,255,255,0.6)' : '#64748b' }}>{sub}</div>}
    </div>
  );
}

function Legend({ color, label, value }) {
  return (
    <div className="d-flex align-items-center gap-2">
      <span style={{ width: 8, height: 8, borderRadius: '50%', background: color }} />
      <span style={{ color: '#475569' }}>{label}</span>
      <span className="fw-bold" style={{ color: '#0f172a' }}>{value}</span>
    </div>
  );
}
