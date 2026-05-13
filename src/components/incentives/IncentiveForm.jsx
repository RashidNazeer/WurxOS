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
function LineRow({ item, onChange, onRemove, index }) {
  const suffix = item.suffix ?? (item.unit === 'percent' ? '%' : '');
  return (
    <div className="rounded-3 p-2 mb-2" style={{ background: '#f8f9fa', border: '1px solid #e9ecef' }}>
      {/* Description */}
      <div className="d-flex align-items-center gap-2 mb-2">
        <input
          type="text"
          className="form-control form-control-sm flex-grow-1"
          placeholder="e.g. 250 affiliates with 3+ videos"
          value={item.text}
          onChange={e => onChange(index, 'text', e.target.value)}
        />
        <button
          type="button"
          className="btn btn-sm btn-link text-danger p-0 flex-shrink-0"
          onClick={() => onRemove(index)}
          title="Remove"
        >
          <i className="bi bi-x-lg" />
        </button>
      </div>
      {/* Target + Compensation on same row */}
      <div className="d-flex gap-2">
        <div className="flex-grow-1">
          <label className="form-label mb-1" style={{ fontSize: '0.65rem', color: '#6c757d' }}>
            Target value <span className="text-muted">(suffix optional — e.g. %, $, pts)</span>
          </label>
          <div className="input-group input-group-sm">
            <input
              type="number"
              className="form-control"
              placeholder="e.g. 250"
              min="0"
              value={item.targetValue ?? ''}
              onChange={e => onChange(index, 'targetValue', e.target.value)}
            />
            <input
              type="text"
              className="form-control"
              placeholder="—"
              maxLength={6}
              value={suffix}
              onChange={e => onChange(index, 'suffix', e.target.value)}
              style={{ maxWidth: 60, fontSize: '0.78rem', textAlign: 'center' }}
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
              onChange={e => onChange(index, 'amount', e.target.value)}
            />
            <span className="input-group-text" style={{ fontSize: '0.7rem' }}>PKR</span>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Section block (Incentives or Bonuses) ────────────────────────────────────
function Section({ title, color, icon, items, setItems, addLabel }) {
  function handleChange(idx, field, val) {
    setItems(prev => prev.map((it, i) => i === idx ? { ...it, [field]: val } : it));
  }
  function handleRemove(idx) {
    setItems(prev => prev.filter((_, i) => i !== idx));
  }
  function handleAdd() {
    setItems(prev => [...prev, { id: uid4(), text: '', amount: '', suffix: '' }]);
  }

  const total = items.reduce((s, i) => s + (Number(i.amount) || 0), 0);

  return (
    <div className="card border-0 shadow-sm mb-3" style={{ borderRadius: 12 }}>
      <div className="card-body p-3">
        <div className="d-flex align-items-center justify-content-between mb-3">
          <div className="d-flex align-items-center gap-2">
            <div
              className="rounded-2 d-flex align-items-center justify-content-center"
              style={{ width: 30, height: 30, background: color + '20' }}
            >
              <i className={`bi ${icon}`} style={{ color, fontSize: '0.85rem' }} />
            </div>
            <span className="fw-semibold small">{title}</span>
          </div>
          {total > 0 && (
            <span className="fw-bold small" style={{ color }}>
              +{total.toLocaleString()} PKR
            </span>
          )}
        </div>

        {items.length === 0 ? (
          <p className="text-muted small mb-2" style={{ fontSize: '0.75rem' }}>
            No {title.toLowerCase()} added yet.
          </p>
        ) : (
          items.map((item, idx) => (
            <LineRow
              key={item.id}
              item={item}
              index={idx}
              onChange={handleChange}
              onRemove={handleRemove}
            />
          ))
        )}

        <button
          type="button"
          className="btn btn-sm btn-outline-secondary d-inline-flex align-items-center gap-1 mt-1"
          style={{ fontSize: '0.75rem' }}
          onClick={handleAdd}
        >
          <i className="bi bi-plus-lg" /> {addLabel}
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
            setIncentives((prior.incentives || []).map((i) => ({
              id: uid4(), text: i.text, amount: i.amount,
              targetValue: i.targetValue ?? '', suffix: itemSuffix(i),
              achievedValue: 0, completed: false, completedBy: null,
            })));
            setBonuses((prior.bonuses || []).map((b) => ({
              id: uid4(), text: b.text, amount: b.amount,
              targetValue: b.targetValue ?? '', suffix: itemSuffix(b),
              achievedValue: 0, completed: false, completedBy: null,
            })));
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
    })));
    setBonuses((tplData.bonuses || []).map(b => ({
      id: uid4(), text: b.text, amount: b.amount,
      targetValue: b.targetValue ?? '', suffix: itemSuffix(b),
      achievedValue: 0, completed: false, completedBy: null,
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
      const incPayload = incentives.map((i) => ({
        id: i.id, text: i.text, amount: Number(i.amount) || 0,
        targetValue: Number(i.targetValue) || 0, suffix: itemSuffix(i),
        completed: i.completed || false,
        achievedValue: i.achievedValue || 0,
        completedBy: i.completedBy || null,
      }));
      const bonPayload = bonuses.map((b) => ({
        id: b.id, text: b.text, amount: Number(b.amount) || 0,
        targetValue: Number(b.targetValue) || 0, suffix: itemSuffix(b),
        completed: b.completed || false,
        achievedValue: b.achievedValue || 0,
        completedBy: b.completedBy || null,
      }));

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
        {/* Basic Salary */}
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
            </div>
            <div className="input-group input-group-sm" style={{ maxWidth: 220 }}>
              <input
                type="number"
                className="form-control"
                placeholder="e.g. 60000"
                min="0"
                value={basicSalary}
                onChange={e => setBasicSalary(e.target.value)}
              />
              <span className="input-group-text">PKR</span>
            </div>
          </div>
        </div>

        {/* Incentives */}
        <Section
          title="Incentives"
          color="#198754"
          icon="bi-graph-up-arrow"
          items={incentives}
          setItems={setIncentives}
          addLabel="Add incentive"
        />

        {/* Bonuses */}
        <Section
          title="Bonuses"
          color="#0d6efd"
          icon="bi-trophy"
          items={bonuses}
          setItems={setBonuses}
          addLabel="Add bonus"
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
