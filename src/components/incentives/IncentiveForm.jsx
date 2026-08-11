import React, { useEffect, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext';
import {
  getUserForEditor, getIncentives, getMostRecentPriorPlan, savePlan,
  getIncentivesTemplate, setIncentivesTemplate,
} from '../../lib/incentivesApi';

function getCurrentMonth() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function getMonthLabel(ym) {
  const [year, month] = ym.split('-');
  return new Date(year, month - 1).toLocaleString('en-US', { month: 'long', year: 'numeric' });
}

function uid4() {
  return Math.random().toString(36).slice(2, 10);
}

const ROLE_LABELS = { apc: 'APC', tl: 'Team Lead', ol: 'Operation Lead' };

// Backward-compat: old docs used `unit: 'percent'`. Prefer the free-form
// `suffix` field, fall back to '%' for legacy percent items.
function itemSuffix(item) {
  if (item.suffix != null && item.suffix !== '') return item.suffix;
  if (item.unit === 'percent') return '%';
  return '';
}

// ── Row editor (incentive or bonus line) ─────────────────────────────────────
// The attendance auto-fill toggle only belongs on the attendance / punctuality
// line — it makes no sense on a metric like "Onboarding L3+ Creators". Reveal
// it only when the row is already attendance-linked or its text names
// attendance / punctuality / absence(s).
const looksLikeAttendance = (text) => /attendance|punctual|absence/i.test(text || '');
// The ol_brands toggle belongs on an OL "% of my brands hit their GMV target"
// line — reveal it when the row is already flagged or its text names brands+GMV.
const looksLikeOlBrands = (text) => /brand.*gmv|gmv.*brand|brands hit/i.test(text || '');
// A per-brand GMV-Max line ("Total Revenue in GMV Max", "Total GMV from GMV Max",
// "... (Inno Supps)"). Its Achieved is filled from Brand Analytics (mig 317).
const looksLikeGmvMax = (text) => /gmvs*max/i.test(text || '');

function LineRow({ item, onChange, onRemove, hideToggles }) {
  const isAtt      = item.source === 'attendance';
  const isOlBrands = item.source === 'ol_brands';
  const isGmvMax   = item.source === 'gmv_max';
  // Brand rows only. Stamp the flag as soon as the line is recognisably a
  // GMV-Max one, so a new plan is auto-filled without anyone remembering to
  // flip a switch. `source === undefined` means "never decided"; toggling the
  // switch off writes null, which is a decision and is respected.
  const canGmvMax = !!hideToggles && looksLikeGmvMax(item.text);
  useEffect(() => {
    if (canGmvMax && item.source === undefined) onChange(item.id, 'source', 'gmv_max');
  }, [canGmvMax, item.source, item.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const suffix = isAtt ? '%' : (item.suffix ?? (item.unit === 'percent' ? '%' : ''));
  // Brand-linked rows (hideToggles) never show the attendance/ol_brands source
  // toggles — those only belong on "Other" (non-brand) lines.
  const showAttToggle = !hideToggles && !isOlBrands && (isAtt || looksLikeAttendance(item.text));
  const showOlToggle  = !hideToggles && !isAtt && (isOlBrands || looksLikeOlBrands(item.text));
  const showGmvToggle = canGmvMax || isGmvMax;

  // Toggling attendance mode pins Target=100 and unit=% so the ≥90% rule
  // means "≥90% attendance". Achieved is then filled from live attendance.
  function toggleAttendance(on) {
    if (on) {
      onChange(item.id, 'source', 'attendance');
      onChange(item.id, 'targetValue', 100);
      onChange(item.id, 'suffix', '%');
    } else {
      onChange(item.id, 'source', null);
    }
  }

  // Toggling ol_brands mode flags the item so the read-time overlay fills its
  // Achieved with the OL's brand roll-up %. Target stays editable (it's the
  // threshold, default 70); unit pinned to %.
  function toggleOlBrands(on) {
    if (on) {
      onChange(item.id, 'source', 'ol_brands');
      if (!Number(item.targetValue)) onChange(item.id, 'targetValue', 70);
      onChange(item.id, 'suffix', '%');
    } else {
      onChange(item.id, 'source', null);
    }
  }

  function toggleGmvMax(on) {
    onChange(item.id, 'source', on ? 'gmv_max' : null);
  }

  const lockStyle = isAtt ? { background: '#eef2f7', cursor: 'not-allowed' } : undefined;

  return (
    <div className="rounded-3 p-2 mb-2" style={{ background: isAtt ? '#eff6ff' : '#f8f9fa', border: `1px solid ${isAtt ? '#bfdbfe' : '#e9ecef'}` }}>
      {/* Description */}
      <div className="d-flex align-items-center gap-2 mb-2">
        <input
          type="text"
          className="form-control form-control-sm flex-grow-1"
          placeholder="e.g. 250 affiliates with 3+ videos"
          value={item.text}
          onChange={e => onChange(item.id, 'text', e.target.value)}
        />
        <button
          type="button"
          className="btn btn-sm btn-link text-danger p-0 flex-shrink-0"
          onClick={() => onRemove(item.id)}
          title="Remove"
        >
          <i className="bi bi-x-lg" />
        </button>
      </div>

      {/* Auto-fill from attendance toggle — only on the attendance line */}
      {showAttToggle && (
        <div className="form-check form-switch d-flex align-items-center gap-2 mb-2" style={{ paddingLeft: '2.4em' }}>
          <input
            className="form-check-input flex-shrink-0 mt-0"
            type="checkbox"
            role="switch"
            id={`att-${item.id}`}
            checked={isAtt}
            onChange={e => toggleAttendance(e.target.checked)}
          />
          <label className="form-check-label" htmlFor={`att-${item.id}`} style={{ fontSize: '0.72rem', color: isAtt ? '#1e40af' : '#6c757d' }}>
            <i className="bi bi-calendar-check me-1" />
            Auto-fill “Achieved” from monthly attendance
          </label>
        </div>
      )}
      {isAtt && (
        <div className="mb-2" style={{ fontSize: '0.68rem', color: '#1e40af' }}>
          <i className="bi bi-info-circle me-1" />
          Achieved fills automatically from this person's attendance % — no manual entry.
          Target is pinned to 100% (≥90% attendance completes it).
        </div>
      )}

      {/* Auto-fill from OL brand roll-up toggle — only on an OL brands+GMV line */}
      {showOlToggle && (
        <div className="form-check form-switch d-flex align-items-center gap-2 mb-2" style={{ paddingLeft: '2.4em' }}>
          <input
            className="form-check-input flex-shrink-0 mt-0"
            type="checkbox"
            role="switch"
            id={`olb-${item.id}`}
            checked={isOlBrands}
            onChange={e => toggleOlBrands(e.target.checked)}
          />
          <label className="form-check-label" htmlFor={`olb-${item.id}`} style={{ fontSize: '0.72rem', color: isOlBrands ? '#1e40af' : '#6c757d' }}>
            <i className="bi bi-bullseye me-1" />
            Auto-fill “Achieved” from this OL's incentive-brand roll-up
          </label>
        </div>
      )}
      {showGmvToggle && (
        <div className="form-check form-switch d-flex align-items-center gap-2 mb-2" style={{ paddingLeft: '2.4em' }}>
          <input
            className="form-check-input flex-shrink-0 mt-0"
            type="checkbox"
            role="switch"
            id={`gmvmax-${item.id}`}
            checked={isGmvMax}
            onChange={e => toggleGmvMax(e.target.checked)}
          />
          <label className="form-check-label" htmlFor={`gmvmax-${item.id}`} style={{ fontSize: '0.72rem', color: isGmvMax ? '#1e40af' : '#6c757d' }}>
            <i className="bi bi-graph-up-arrow me-1" />
            Auto-fill “Achieved” from this brand's GMV in Brand Analytics
          </label>
        </div>
      )}
      {isGmvMax && (
        <div className="mb-2" style={{ fontSize: '0.68rem', color: '#1e40af' }}>
          <i className="bi bi-info-circle me-1" />
          Achieved tracks the brand's month figure in Brand Analytics — the number
          the APC enters at clock-in — so nobody types it by hand. Set the Target
          here; ticking the item as earned stays a manual decision.
        </div>
      )}
      {isOlBrands && (
        <div className="mb-2" style={{ fontSize: '0.68rem', color: '#1e40af' }}>
          <i className="bi bi-info-circle me-1" />
          Achieved fills automatically with the % of the OL's curated brands whose TL
          marked the GMV target complete. Set Target to the threshold (e.g. 70%);
          it completes at month-end once the % reaches it.
        </div>
      )}

      {/* Target + Compensation on same row */}
      <div className="d-flex gap-2">
        <div className="flex-grow-1">
          <label className="form-label mb-1" style={{ fontSize: '0.65rem', color: '#6c757d' }}>
            {isAtt
              ? <>Target <span className="text-muted">(auto · attendance %)</span></>
              : <>Target value <span className="text-muted">(suffix optional — e.g. %, $, pts)</span></>}
          </label>
          <div className="input-group input-group-sm">
            <input
              type="number"
              className="form-control"
              placeholder="e.g. 250"
              min="0"
              value={isAtt ? 100 : (item.targetValue ?? '')}
              onChange={e => onChange(item.id, 'targetValue', e.target.value)}
              readOnly={isAtt}
              disabled={isAtt}
              style={lockStyle}
            />
            <input
              type="text"
              className="form-control"
              placeholder="—"
              maxLength={6}
              value={suffix}
              onChange={e => onChange(item.id, 'suffix', e.target.value)}
              readOnly={isAtt}
              disabled={isAtt}
              style={{ maxWidth: 60, fontSize: '0.78rem', textAlign: 'center', ...(lockStyle || {}) }}
              title="Optional unit (e.g. %, $, pts) — leave blank for plain numbers"
            />
          </div>
        </div>
        <div style={{ width: 150 }}>
          <label className="form-label mb-1" style={{ fontSize: '0.65rem', color: '#6c757d' }}>Compensation if achieved</label>
          <div className="input-group input-group-sm">
            <span className="input-group-text text-success fw-semibold">+</span>
            <input
              type="number"
              className="form-control"
              placeholder="Amount"
              min="0"
              value={item.amount}
              onChange={e => onChange(item.id, 'amount', e.target.value)}
            />
            <span className="input-group-text" style={{ fontSize: '0.7rem' }}>PKR</span>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── One brand's group of items inside a section ──────────────────────────────
function BrandGroup({ brand, items, color, onChange, onRemove, onAdd, noun }) {
  const total = items.reduce((s, i) => s + (Number(i.amount) || 0), 0);
  const tier = brand.tier ? TIER_STYLE[String(brand.tier).toLowerCase()] : null;
  return (
    <div className="rounded-3 mb-2" style={{ border: '1px solid #e2e8f0', background: '#fff', overflow: 'hidden' }}>
      <div className="d-flex align-items-center justify-content-between px-3 py-2"
        style={{ background: '#f8fafc', borderBottom: items.length ? '1px solid #eef2f7' : 'none' }}>
        <span className="d-inline-flex align-items-center gap-2">
          <i className="bi bi-shop" style={{ color, fontSize: '0.8rem' }} />
          <span className="fw-semibold" style={{ fontSize: '0.82rem' }}>{brand.name}</span>
          {tier && (
            <span className="rounded-pill" style={{ background: tier.bg, color: tier.fg, border: `1px solid ${tier.border}`, padding: '0 6px', fontSize: '0.58rem', fontWeight: 700 }}>{tier.label}</span>
          )}
        </span>
        {total > 0 && <span className="fw-bold" style={{ fontSize: '0.75rem', color }}>+{total.toLocaleString()} PKR</span>}
      </div>
      <div className="p-2">
        {items.length === 0
          ? <p className="text-muted mb-2 px-1" style={{ fontSize: '0.72rem' }}>No {noun} for this brand yet.</p>
          : items.map((item) => <LineRow key={item.id} item={item} onChange={onChange} onRemove={onRemove} hideToggles />)}
        <button type="button" className="btn btn-sm btn-outline-secondary d-inline-flex align-items-center gap-1"
          style={{ fontSize: '0.72rem' }} onClick={() => onAdd(brand)}>
          <i className="bi bi-plus-lg" /> Add {noun} for {brand.name}
        </button>
      </div>
    </div>
  );
}

// ── A full section (Incentives or Bonuses): brand groups + an "Other" bucket ──
// State stays a FLAT array; each item carries an optional brandId (+ brandName
// snapshot). Items are rendered grouped by their linked brand, driven by the
// user's CURRENT brands — so a newly-assigned brand shows an empty group to fill
// and an item linked to a brand the user no longer has surfaces as an orphan.
function PlanSection({ title, color, icon, items, setItems, brands, noun }) {
  const change = (id, field, val) => setItems(prev => prev.map(it => it.id === id ? { ...it, [field]: val } : it));
  const remove = (id) => setItems(prev => prev.filter(it => it.id !== id));
  const addBrand = (brand) => setItems(prev => [...prev, { id: uid4(), text: '', amount: '', suffix: '', brandId: brand.id, brandName: brand.name }]);
  const addOther = () => setItems(prev => [...prev, { id: uid4(), text: '', amount: '', suffix: '' }]);

  const brandIds = new Set((brands || []).map(b => b.id));
  const otherItems  = items.filter(i => !i.brandId);
  const orphanItems = items.filter(i => i.brandId && !brandIds.has(i.brandId));
  const total = items.reduce((s, i) => s + (Number(i.amount) || 0), 0);

  return (
    <div className="card border-0 shadow-sm mb-3" style={{ borderRadius: 12 }}>
      <div className="card-body p-3">
        <div className="d-flex align-items-center justify-content-between mb-3">
          <div className="d-flex align-items-center gap-2">
            <div className="rounded-2 d-flex align-items-center justify-content-center" style={{ width: 30, height: 30, background: color + '20' }}>
              <i className={`bi ${icon}`} style={{ color, fontSize: '0.85rem' }} />
            </div>
            <span className="fw-semibold small">{title}</span>
          </div>
          {total > 0 && <span className="fw-bold small" style={{ color }}>+{total.toLocaleString()} PKR</span>}
        </div>

        {brands && brands.length > 0 ? (
          <>
            <div className="text-muted fw-semibold mb-2" style={{ fontSize: '0.66rem', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
              <i className="bi bi-link-45deg me-1" />Brand {noun}s
            </div>
            {brands.map((brand) => (
              <BrandGroup key={brand.id} brand={brand} color={color} noun={noun}
                items={items.filter(i => i.brandId === brand.id)}
                onChange={change} onRemove={remove} onAdd={addBrand} />
            ))}
          </>
        ) : (
          <p className="text-muted mb-3" style={{ fontSize: '0.72rem' }}>No brands assigned to this person — add items under “Other” below.</p>
        )}

        {orphanItems.length > 0 && (
          <div className="rounded-3 mb-2 mt-2 p-2" style={{ border: '1px dashed #f59e0b', background: '#fffbeb' }}>
            <div className="fw-semibold mb-2" style={{ fontSize: '0.7rem', color: '#b45309' }}>
              <i className="bi bi-exclamation-triangle me-1" />Linked to a brand no longer assigned{orphanItems[0]?.brandName ? ` (${orphanItems.map(o => o.brandName).filter((v, i, a) => v && a.indexOf(v) === i).join(', ')})` : ''} — remove, or it drops on the next carry-forward
            </div>
            {orphanItems.map((item) => <LineRow key={item.id} item={item} onChange={change} onRemove={remove} hideToggles />)}
          </div>
        )}

        <div className="text-muted fw-semibold mt-3 mb-2" style={{ fontSize: '0.66rem', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
          Other {noun}s <span className="text-muted" style={{ fontWeight: 400, textTransform: 'none' }}>· not tied to a brand (e.g. attendance)</span>
        </div>
        {otherItems.length === 0
          ? <p className="text-muted mb-2 px-1" style={{ fontSize: '0.72rem' }}>None.</p>
          : otherItems.map((item) => <LineRow key={item.id} item={item} onChange={change} onRemove={remove} />)}
        <button type="button" className="btn btn-sm btn-outline-secondary d-inline-flex align-items-center gap-1 mt-1"
          style={{ fontSize: '0.72rem' }} onClick={addOther}>
          <i className="bi bi-plus-lg" /> Add other {noun}
        </button>
      </div>
    </div>
  );
}

// ── Brand context chip (used in the banner) ─────────────────────────────────
// Shows brand name + tier + status so the OL can spot premium brands at a
// glance and design tier-appropriate incentives. Tier styling matches the
// chips used on the Brands page.
const TIER_STYLE = {
  gold:     { bg: '#fef3c7', fg: '#92400e', border: '#fcd34d', label: 'Gold' },
  silver:   { bg: '#e2e8f0', fg: '#334155', border: '#cbd5e1', label: 'Silver' },
  bronze:   { bg: '#fed7aa', fg: '#9a3412', border: '#fb923c', label: 'Bronze' },
  platinum: { bg: '#e0e7ff', fg: '#3730a3', border: '#a5b4fc', label: 'Platinum' },
};
function BrandContextChip({ brand }) {
  const tier = brand.tier ? TIER_STYLE[String(brand.tier).toLowerCase()] : null;
  const inactive = brand.status && String(brand.status).toLowerCase() !== 'active';
  return (
    <span
      className="d-inline-flex align-items-center gap-2 rounded-pill"
      title={brand.notes || undefined}
      style={{
        background: '#fff',
        border: '1px solid #e2e8f0',
        padding: '4px 10px',
        fontSize: '0.72rem',
        color: '#0f172a',
        fontWeight: 600,
        opacity: inactive ? 0.65 : 1,
      }}
    >
      <span>{brand.name}</span>
      {tier && (
        <span
          className="rounded-pill"
          style={{
            background: tier.bg,
            color: tier.fg,
            border: `1px solid ${tier.border}`,
            padding: '1px 7px',
            fontSize: '0.62rem',
            fontWeight: 700,
            letterSpacing: '0.02em',
          }}
        >
          {tier.label}
        </span>
      )}
      {inactive && (
        <span style={{ fontSize: '0.62rem', color: '#64748b', fontWeight: 500 }}>
          · {brand.status}
        </span>
      )}
    </span>
  );
}

// ── Main IncentiveForm ────────────────────────────────────────────────────────
export default function IncentiveForm() {
  const { apcId, userId } = useParams();
  const targetId = userId || apcId;
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  // v2 auth shim — v1 read { currentUser, userRole, userProfile }.
  const { user, profile } = useAuth();
  const currentUser = user ? {
    uid: user.id,
    email: user.email,
    displayName: profile?.display_name || '',
  } : null;
  const userRole = profile?.role || '';
  const userProfile = profile ? { displayName: profile.display_name || '' } : null;

  // v2: single /incentives route resolves to the right page per role.
  const backPath = '/incentives';

  // Use ?month= from URL if provided (so OL editing while viewing April hits April,
  // not whatever today's month is); fall back to current month for direct visits.
  const currentMonth = searchParams.get('month') || getCurrentMonth();

  const [targetUser, setTargetUser]       = useState(null);
  const [targetRole, setTargetRole]       = useState(null); // 'apc' | 'tl' | 'ol'
  const [existingDocId, setExistingDocId] = useState(null);
  const [loadingData, setLoadingData]     = useState(true);

  const [basicSalary, setBasicSalary] = useState('');
  const [incentives, setIncentives]   = useState([]);
  const [bonuses, setBonuses]         = useState([]);
  const [saving, setSaving]           = useState(false);
  const [error, setError]             = useState('');
  const [saved, setSaved]             = useState(false);
  const [carryoverInfo, setCarryoverInfo] = useState(null); // { source: 'prior'|'template', sourceMonth?: string }
  const [hasTemplate, setHasTemplate] = useState(false);
  const [templateBusy, setTemplateBusy] = useState(false);

  useEffect(() => {
    async function load() {
      // Resolve target user from profiles (v2 has one table for everyone).
      const u = await getUserForEditor(targetId);
      if (!u) { navigate(backPath); return; }
      setTargetUser(u);
      setTargetRole(u.role);

      // Check whether a default template exists (for Load Default button).
      try {
        const tpl = await getIncentivesTemplate();
        setHasTemplate(!!tpl);
      } catch { /* ignore */ }

      // Existing record for this (user, month)?
      const existing = await getIncentives(targetId, currentMonth);
      if (existing) {
        setExistingDocId(existing.id);
        setBasicSalary(String(existing.basic_salary || ''));
        setIncentives((existing.incentives || []).map((i) => ({
          ...i, id: i.id || uid4(),
          targetValue: i.targetValue ?? '',
          suffix: itemSuffix(i),
        })));
        setBonuses((existing.bonuses || []).map((b) => ({
          ...b, id: b.id || uid4(),
          targetValue: b.targetValue ?? '',
          suffix: itemSuffix(b),
        })));
      } else {
        // Auto-prefill from most recent prior plan, with achieved reset to 0.
        try {
          const prior = await getMostRecentPriorPlan(targetId, currentMonth);
          if (prior) {
            setBasicSalary(String(prior.basicSalary || ''));
            // Carry the brand link forward and reset progress. DROP items linked to
            // a brand the user no longer has (brand switched away). Newly-assigned
            // brands surface automatically as empty groups (sections render from the
            // user's CURRENT brands).
            const curIds = new Set((u.assignedBrands || []).map((b) => b.id));
            const carry = (i) => ({
              id: uid4(), text: i.text, amount: i.amount,
              targetValue: i.targetValue ?? '', suffix: itemSuffix(i),
              achievedValue: 0, completed: false, completedBy: null,
              ...(i.source ? { source: i.source } : {}),
              ...(i.brandId ? { brandId: i.brandId, brandName: i.brandName || null } : {}),
            });
            // Drop links to brands the user no longer has — but NEVER when the brand
            // list is empty (that reconciles to "drop everything"); keep them as
            // orphans instead, so a mis-load can't wipe the whole plan.
            const keep = (i) => !i.brandId || curIds.size === 0 || curIds.has(i.brandId);
            setIncentives((prior.incentives || []).filter(keep).map(carry));
            setBonuses((prior.bonuses || []).filter(keep).map(carry));
            setCarryoverInfo({ source: 'prior', sourceMonth: prior.month });
          }
        } catch (err) {
          // eslint-disable-next-line no-console
          console.warn('Prior plan lookup failed:', err);
        }
      }
      setLoadingData(false);
    }
    load();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [targetId]);

  function loadFromTemplate(tplData) {
    setBasicSalary(String(tplData.basicSalary || ''));
    setIncentives((tplData.incentives || []).map(i => ({
      id: uid4(), text: i.text, amount: i.amount,
      targetValue: i.targetValue ?? '', suffix: itemSuffix(i),
      achievedValue: 0, completed: false, completedBy: null,
      ...(i.source ? { source: i.source } : {}),
    })));
    setBonuses((tplData.bonuses || []).map(b => ({
      id: uid4(), text: b.text, amount: b.amount,
      targetValue: b.targetValue ?? '', suffix: itemSuffix(b),
      achievedValue: 0, completed: false, completedBy: null,
      ...(b.source ? { source: b.source } : {}),
    })));
    setCarryoverInfo({ source: 'template' });
  }

  async function handleLoadTemplate() {
    setTemplateBusy(true); setError('');
    try {
      const tpl = await getIncentivesTemplate();
      if (!tpl) { setError('No default template saved yet.'); return; }
      loadFromTemplate(tpl);
    } catch { setError('Failed to load template.'); }
    finally { setTemplateBusy(false); }
  }

  async function handleSaveTemplate() {
    if (!window.confirm('Save the current basic salary, incentives and bonuses as the default template? This will overwrite any existing template.')) return;
    setTemplateBusy(true); setError('');
    try {
      const tplName = userProfile?.displayName || currentUser?.displayName || currentUser?.email || 'OL';
      await setIncentivesTemplate({
        basicSalary, incentives, bonuses, savedByName: tplName,
      });
      setHasTemplate(true);
      // eslint-disable-next-line no-alert
      alert('Default template saved.');
    } catch { setError('Failed to save template.'); }
    finally { setTemplateBusy(false); }
  }

  const incTotal = incentives.reduce((s, i) => s + (Number(i.amount) || 0), 0);
  const bonTotal = bonuses.reduce((s, b) => s + (Number(b.amount) || 0), 0);
  const grandTotal = (Number(basicSalary) || 0) + incTotal + bonTotal;

  async function handleSubmit(e) {
    e.preventDefault();
    setSaving(true);
    setError('');
    try {
      // v2 savePlan handles both update (by id) and upsert on (user_id, month).
      // Items keep v1's per-item shape (achievedValue, completed, completedBy)
      // so the existing rows that other pages read stay compatible.
      // Attendance-linked items pin Target=100 / unit=% so the ≥90% rule
      // means "≥90% attendance"; their Achieved is filled at read time.
      const mapItem = (i) => ({
        id: i.id, text: i.text, amount: Number(i.amount) || 0,
        targetValue: i.source === 'attendance' ? 100 : (Number(i.targetValue) || 0),
        suffix: i.source === 'attendance' ? '%' : itemSuffix(i),
        completed: i.completed || false,
        achievedValue: i.achievedValue || 0,
        completedBy: i.completedBy || null,
        ...(i.source ? { source: i.source } : {}),
        // Hard brand link (new model). Kept only when set, so "Other" items stay unlinked.
        ...(i.brandId ? { brandId: i.brandId, brandName: i.brandName || null } : {}),
      });
      const incPayload = incentives.map(mapItem);
      const bonPayload = bonuses.map(mapItem);

      const saved = await savePlan({
        id: existingDocId || null,
        userId: targetId,
        month: currentMonth,
        basicSalary: Number(basicSalary) || 0,
        incentives: incPayload,
        bonuses: bonPayload,
      });
      if (!existingDocId && saved?.id) setExistingDocId(saved.id);

      setSaved(true);
      // Brief flash, then go back to where the user came from
      setTimeout(() => { setSaved(false); navigate(-1); }, 700);
    } catch (err) {
      setError('Failed to save. Please try again.');
      // eslint-disable-next-line no-console
      console.error(err);
    } finally {
      setSaving(false);
    }
  }

  if (!currentUser) return null;
  if (loadingData) {
    return (
      <div className="text-muted small d-flex align-items-center gap-2">
        <span className="spinner-border spinner-border-sm" /> Loading…
      </div>
    );
  }

  const brands = targetUser?.assignedBrands || [];

  return (
    <div style={{ maxWidth: 640 }}>
      {/* Back + header */}
      <div className="mb-4">
        <button
          className="btn btn-link p-0 text-muted text-decoration-none small d-inline-flex align-items-center gap-1 mb-2"
          onClick={() => navigate(-1)}
        >
          <i className="bi bi-arrow-left" /> Back
        </button>

        {/* User identity banner */}
        <div
          className="rounded-3 p-3 mb-3 d-flex align-items-center gap-3"
          style={{ background: 'linear-gradient(135deg,#1a1a2e,#0f3460)', color: '#fff' }}
        >
          <div
            className="rounded-circle d-flex align-items-center justify-content-center fw-bold flex-shrink-0"
            style={{ width: 44, height: 44, background: 'rgba(255,255,255,0.15)', fontSize: '0.9rem' }}
          >
            {(targetUser?.displayName || '?').slice(0, 2).toUpperCase()}
          </div>
          <div>
            <div className="fw-bold">{targetUser?.displayName}</div>
            <div style={{ fontSize: '0.75rem', opacity: 0.75 }}>
              {ROLE_LABELS[targetRole] || targetRole} · {getMonthLabel(currentMonth)}
            </div>
          </div>
        </div>

        {/* Brand context panel — surfaces the brands this user manages, with
            tier so the author can design tier-aware incentives without
            having to switch tabs. Hidden when the user owns no brands
            (e.g. an IPC who hasn't been assigned anything yet). */}
        {brands.length > 0 && (
          <div className="rounded-3 mb-3 p-3" style={{ background: '#f8fafc', border: '1px solid #e2e8f0' }}>
            <div className="d-flex align-items-center justify-content-between mb-2">
              <span className="fw-semibold" style={{ fontSize: '0.78rem', color: '#0f172a' }}>
                <i className="bi bi-shop me-1" />
                Brands {targetUser?.displayName?.split(' ')[0] || 'they'} manage
                <span className="text-muted ms-1" style={{ fontWeight: 400 }}>· {brands.length}</span>
              </span>
              <span className="text-muted" style={{ fontSize: '0.68rem' }}>Use this context when designing goals</span>
            </div>
            <div className="d-flex flex-wrap gap-2">
              {brands.map((b) => (
                <BrandContextChip key={b.id || b.name} brand={b} />
              ))}
            </div>
          </div>
        )}
      </div>

      {error && (
        <div className="alert alert-danger py-2 small mb-3 d-flex align-items-center gap-2">
          <i className="bi bi-exclamation-circle" />{error}
        </div>
      )}

      {!existingDocId && carryoverInfo && (
        <div className="alert d-flex align-items-start gap-2 py-2 mb-3"
          style={{ background: '#eff6ff', border: '1px solid #bfdbfe', borderRadius: 10, color: '#1e40af', fontSize: '0.78rem' }}>
          <i className="bi bi-arrow-down-circle-fill flex-shrink-0 mt-1" />
          <div>
            {carryoverInfo.source === 'prior'
              ? <>Pre-filled from this user's previous plan ({getMonthLabel(carryoverInfo.sourceMonth)}). Targets and amounts carried over; progress reset. Click <b>Save</b> to lock it in for {getMonthLabel(currentMonth)}.</>
              : <>Pre-filled from your default template. Click <b>Save</b> to lock it in for {getMonthLabel(currentMonth)}.</>}
          </div>
        </div>
      )}

      {!existingDocId && !carryoverInfo && hasTemplate && (
        <div className="alert d-flex align-items-center justify-content-between gap-2 py-2 mb-3"
          style={{ background: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: 10, fontSize: '0.78rem' }}>
          <div className="d-flex align-items-center gap-2">
            <i className="bi bi-file-earmark-text" />
            <span>No prior plan for this user — load your default template to get started?</span>
          </div>
          <button type="button" className="btn btn-sm btn-outline-primary" onClick={handleLoadTemplate} disabled={templateBusy}>
            {templateBusy ? 'Loading…' : 'Load default'}
          </button>
        </div>
      )}

      <form onSubmit={handleSubmit}>
        {/* Basic Salary — READ-ONLY since the Salary Management
            feature owns this field. Edits happen at /boss/salaries.
            The value rendered here is whatever the editor last loaded
            (carried over from prior month's plan) — it remains the
            per-month snapshot the incentive math reads from. */}
        <div className="card border-0 shadow-sm mb-3" style={{ borderRadius: 12 }}>
          <div className="card-body p-3">
            <div className="d-flex align-items-center gap-2 mb-3">
              <div
                className="rounded-2 d-flex align-items-center justify-content-center"
                style={{ width: 30, height: 30, background: '#f3f4f6' }}
              >
                <i className="bi bi-wallet2" style={{ color: '#6c757d', fontSize: '0.85rem' }} />
              </div>
              <span className="fw-semibold small">Basic / Fixed Salary</span>
              <span className="badge ms-auto" style={{
                background: 'var(--accent-soft)', color: 'var(--accent)',
                fontWeight: 700, fontSize: '0.65rem', padding: '3px 8px',
              }}>
                <i className="bi bi-lock-fill me-1" /> Boss-managed
              </span>
            </div>
            <div className="input-group input-group-sm" style={{ maxWidth: 220 }}>
              <input
                type="number"
                className="form-control"
                placeholder="—"
                min="0"
                value={basicSalary}
                readOnly
                disabled
                style={{ background: 'var(--surface-2)', cursor: 'not-allowed' }}
              />
              <span className="input-group-text">PKR</span>
            </div>
            <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)', marginTop: 6 }}>
              Fixed salary is managed under <strong>Boss → Salaries</strong>. The amount
              shown here is the snapshot for this month's incentive plan and updates
              automatically when a new salary is set.
            </div>
          </div>
        </div>

        {/* Incentives — brand groups + Other */}
        <PlanSection
          title="Incentives"
          color="#198754"
          icon="bi-graph-up-arrow"
          items={incentives}
          setItems={setIncentives}
          brands={brands}
          noun="incentive"
        />

        {/* Bonuses — brand groups + Other */}
        <PlanSection
          title="Bonuses"
          color="#0d6efd"
          icon="bi-trophy"
          items={bonuses}
          setItems={setBonuses}
          brands={brands}
          noun="bonus"
        />

        {/* Summary */}
        <div className="card border-0 shadow-sm mb-4" style={{ borderRadius: 12, background: '#f8f9fa' }}>
          <div className="card-body p-3">
            <p className="text-muted small fw-semibold mb-2 text-uppercase" style={{ letterSpacing: '0.05em', fontSize: '0.65rem' }}>
              Summary
            </p>
            <div className="d-flex flex-column gap-1" style={{ fontSize: '0.82rem' }}>
              <div className="d-flex justify-content-between">
                <span className="text-muted">Basic Salary</span>
                <span>{(Number(basicSalary) || 0).toLocaleString()} PKR</span>
              </div>
              <div className="d-flex justify-content-between">
                <span className="text-muted">Total Incentives ({incentives.length})</span>
                <span className="text-success fw-medium">+{incTotal.toLocaleString()} PKR</span>
              </div>
              <div className="d-flex justify-content-between">
                <span className="text-muted">Total Bonuses ({bonuses.length})</span>
                <span className="text-primary fw-medium">+{bonTotal.toLocaleString()} PKR</span>
              </div>
              <div
                className="d-flex justify-content-between fw-bold pt-2 mt-1"
                style={{ borderTop: '1.5px solid #dee2e6', fontSize: '0.95rem' }}
              >
                <span>Total Salary</span>
                <span>{grandTotal.toLocaleString()} PKR</span>
              </div>
            </div>
          </div>
        </div>

        <div className="d-flex gap-2 align-items-center flex-wrap">
          <button type="submit" className="btn btn-dark d-inline-flex align-items-center gap-1" disabled={saving}>
            {saving
              ? <><span className="spinner-border spinner-border-sm" /> Saving…</>
              : <><i className="bi bi-check-lg" /> Save</>
            }
          </button>
          <button type="button" className="btn btn-outline-secondary" onClick={() => navigate(-1)}>
            Cancel
          </button>
          {(userRole === 'ol' || userRole === 'boss') && (incentives.length > 0 || bonuses.length > 0) && (
            <button type="button" className="btn btn-sm btn-outline-primary ms-auto d-inline-flex align-items-center gap-1"
              onClick={handleSaveTemplate} disabled={templateBusy}
              title="Save the current items as the default template for new plans">
              <i className="bi bi-bookmark-plus" /> Save as default template
            </button>
          )}
          {saved && (
            <span className="text-success small d-flex align-items-center gap-1 ms-1">
              <i className="bi bi-check-circle-fill" /> Saved!
            </span>
          )}
        </div>
      </form>
    </div>
  );
}
