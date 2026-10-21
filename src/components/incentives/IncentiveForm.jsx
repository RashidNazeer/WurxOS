import React, { useEffect, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext';
import {
  getUserForEditor, getIncentives, getMostRecentPriorPlan, savePlan,
  getIncentivesTemplate, setIncentivesTemplate, fetchBrandCommissionAllocations,
} from '../../lib/incentivesApi';
import { listBrandMetricsForMonth } from '../../lib/brandMetricsApi';
import { MAX_SELECTIONS_PER_APC } from '../../lib/incentiveWorkbook';
import WorkbookIncentivesModal from './WorkbookIncentivesModal';
import { currencySymbol } from '../../utils/currencies';
import { formatMoney, formatPKR } from '../../lib/format';
import { useToast, useConfirm } from '../ui';

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
// A per-brand GMV-Max line ("Total Revenue in GMV Max", "Total GMV from GMV Max",
// "... (Inno Supps)"). Its Achieved is filled from Brand Analytics (mig 317).
const looksLikeGmvMax = (text) => /gmv\s*max/i.test(text || '');

// Where an item's "Achieved" comes from. Manual is the default; the rest are
// read-time overlays (incentivesApi.applyDerivedAutofill) that fill the number
// server-side data already knows.
//
// This is a SELECT, always rendered, and that is deliberate. It used to be
// three switches, each shown only when the row's TEXT matched a regex. Two
// things went wrong with that: switching a source off could hide the switch
// itself (text didn't match → nothing to switch back on), and a typo in the
// GMV-Max pattern meant brand lines never offered it at all. A control that
// can disappear is worse than one that is occasionally irrelevant.
const SOURCE_LABELS = {
  '':               'Manual entry',
  attendance:       'Auto — monthly attendance %',
  ol_brands:        'Auto — OL brand roll-up %',
  gmv_max:          "Auto — brand's GMV in Brand Analytics",
  commission_tier:  'Commission Based Tier — % of GMV above a benchmark',
};
// Brand-linked rows own the two brand sources; "Other" rows can't have them
// (no brand to resolve) but own the two person-level ones.
const sourceOptionsFor = (hideToggles, current) => {
  const opts = hideToggles ? ['', 'gmv_max', 'commission_tier'] : ['', 'attendance', 'ol_brands'];
  // Never silently drop a source the row already carries.
  if (current && !opts.includes(current)) opts.push(current);
  return opts;
};

// Percentage of this brand already promised across everyone this month, not
// counting the line being edited — so it reads as "on top of what you are about
// to set". Includes the same person's OTHER lines on the brand, because two
// lines on one brand stack up exactly like two people do.
// eslint-disable-next-line no-unused-vars
function otherCommissionPct(commAlloc, brandId, targetId, itemId) {
  const rows = (commAlloc && commAlloc.get(brandId)) || [];
  return rows
    // Count this person's OTHER lines on the brand too — two lines on one
    // brand for the same person stack up just the same. Exclude only THIS line.
    .filter((r) => r.itemId !== itemId)
    .reduce((sum, r) => sum + (Number(r.pct) || 0), 0);
}

function LineRow({ item, onChange, onRemove, hideToggles, brandCurrency, othersPct, gmvGoal = 0 }) {
  const source     = item.source || '';
  const isAtt      = source === 'attendance';
  const isOlBrands = source === 'ol_brands';
  const isGmvMax   = source === 'gmv_max';
  const isComm     = source === 'commission_tier';
  const isAuto     = !!source;
  // A GMV-Max target is owned by the brand's monthly GMV goal (mig 366). Lock
  // it only when a goal actually exists: otherwise a brand nobody has set a
  // goal for could never be given a target, and the line could never complete.
  const goalLocked = isGmvMax && Number(gmvGoal) > 0;
  // Brand rows only. Stamp the flag as soon as the line is recognisably a
  // GMV-Max one, so a new plan is auto-filled without anyone remembering to
  // set it. `source === undefined` means "never decided"; picking Manual
  // writes null, which is a decision and is respected.
  const canGmvMax = !!hideToggles && looksLikeGmvMax(item.text);
  useEffect(() => {
    if (canGmvMax && item.source === undefined) onChange(item.id, 'source', 'gmv_max');
  }, [canGmvMax, item.source, item.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const suffix = isAtt ? '%' : (item.suffix ?? (item.unit === 'percent' ? '%' : ''));

  // Picking a source applies the invariants that source implies: attendance is
  // a /100 percentage, the OL roll-up defaults to a 70% threshold, GMV-Max
  // keeps whatever money target the OL set.
  function applySource(next) {
    onChange(item.id, 'source', next || null);
    if (next === 'attendance') {
      onChange(item.id, 'targetValue', 100);
      onChange(item.id, 'suffix', '%');
    } else if (next === 'ol_brands') {
      if (!Number(item.targetValue)) onChange(item.id, 'targetValue', 70);
      onChange(item.id, 'suffix', '%');
    } else if (next === 'commission_tier') {
      // The benchmark and achieved are money in the BRAND's currency, so pin
      // the unit to it rather than leaving a bare number.
      onChange(item.id, 'suffix', currencySymbol(brandCurrency));
    }
  }

  const lockStyle = isAtt ? { background: 'var(--surface-2)', cursor: 'not-allowed' } : undefined;
  const pct = item.commissionPct ?? '';
  const pctOverAllocated = Number(pct) > 100;

  // The commission arithmetic, shown live as it is typed. Mirrors
  // incentivesApi.commissionExcess/commissionEarnedRaw — including the rule
  // that a blank benchmark means the commission is paid on EVERYTHING achieved,
  // since "achieved minus zero" is simply the whole achieved figure.
  const sym         = isComm ? currencySymbol(brandCurrency) : '';
  const money       = (v) => formatMoney(v, brandCurrency || 'USD');
  const benchmark   = Math.max(Number(item.targetValue) || 0, 0);
  const achieved    = Number(item.achievedValue) || 0;
  const excess      = Math.max(achieved - benchmark, 0);
  const pctClamped  = Math.min(Math.max(Number(pct) || 0, 0), 100);
  const earnedRaw   = excess * (pctClamped / 100);

  return (
    <div className="rounded-3 p-2 mb-2" style={{ background: isAtt ? 'var(--info-soft)' : 'var(--surface-2)', border: `1px solid ${isAtt ? 'color-mix(in srgb, var(--info) 35%, transparent)' : 'var(--border-subtle)'}` }}>
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

      {/* Where "Achieved" comes from — ALWAYS shown, on every line. */}
      <div className="d-flex align-items-center gap-2 mb-2 flex-wrap">
        <span style={{ fontSize: '0.68rem', color: 'var(--text-muted)', fontWeight: 600 }}>
          <i className={`bi ${isAuto ? 'bi-magic' : 'bi-pencil'} me-1`} />Achieved
        </span>
        <select
          className="form-select form-select-sm"
          style={{ width: 'auto', minWidth: 210, fontSize: '0.72rem', borderRadius: 'var(--radius-sm)',
            ...(isAuto ? { borderColor: 'color-mix(in srgb, var(--info) 35%, transparent)', background: 'var(--info-soft)', color: 'var(--info-text)', fontWeight: 600 } : {}) }}
          value={source}
          onChange={e => applySource(e.target.value)}
        >
          {sourceOptionsFor(hideToggles, source).map(v => (
            <option key={v || 'manual'} value={v}>{SOURCE_LABELS[v] || v}</option>
          ))}
        </select>
      </div>
      {isAtt && (
        <div className="mb-2" style={{ fontSize: '0.68rem', color: 'var(--info-text)' }}>
          <i className="bi bi-info-circle me-1" />
          Achieved fills automatically from this person's attendance % — no manual entry.
          Target is pinned to 100% (≥90% attendance completes it).
        </div>
      )}
      {isGmvMax && (
        <div className="mb-2" style={{ fontSize: '0.68rem', color: 'var(--info-text)' }}>
          <i className="bi bi-info-circle me-1" />
          Achieved tracks the brand's month figure in Brand Analytics — the number
          the APC enters at clock-in — so nobody types it by hand. Set the Target
          here; ticking the item as earned stays a manual decision.
        </div>
      )}
      {isOlBrands && (
        <div className="mb-2" style={{ fontSize: '0.68rem', color: 'var(--info-text)' }}>
          <i className="bi bi-info-circle me-1" />
          Achieved fills automatically with the % of the OL's curated brands whose TL
          marked the GMV target complete. Set Target to the threshold (e.g. 70%);
          it completes at month-end once the % reaches it.
        </div>
      )}
      {isComm && (
        <div className="rounded-3 p-2 mb-2" style={{ background: 'var(--success-soft)', border: '1px solid color-mix(in srgb, var(--success) 35%, transparent)' }}>
          <div style={{ fontSize: '0.68rem', color: 'var(--success-text)', marginBottom: 8 }}>
            <i className="bi bi-percent me-1" />
            Pays a percentage of whatever this brand earns <strong>above the benchmark</strong> —
            leave the benchmark blank to pay on the whole figure. All three numbers are
            yours to set, and only an Operations Lead can change them afterwards.
          </div>
          <div className="d-flex gap-2 flex-wrap">
            <div style={{ flex: '1 1 120px', minWidth: 110 }}>
              <label className="form-label mb-1" style={{ fontSize: '0.62rem', color: 'var(--success-text)', fontWeight: 600 }}>
                GMV Benchmark <span style={{ fontWeight: 400 }}>(blank = all)</span>
              </label>
              <div className="input-group input-group-sm">
                <span className="input-group-text" style={{ fontSize: '0.7rem' }}>{sym}</span>
                <input type="number" className="form-control" placeholder="e.g. 1000" min="0" step="0.01"
                  value={item.targetValue ?? ''}
                  onChange={e => onChange(item.id, 'targetValue', e.target.value)}
                  />
              </div>
            </div>
            <div style={{ flex: '1 1 120px', minWidth: 110 }}>
              <label className="form-label mb-1" style={{ fontSize: '0.62rem', color: 'var(--success-text)', fontWeight: 600 }}>
                Achieved
              </label>
              <div className="input-group input-group-sm">
                <span className="input-group-text" style={{ fontSize: '0.7rem' }}>{sym}</span>
                <input type="number" className="form-control" placeholder="e.g. 1200" min="0" step="0.01"
                  value={item.achievedValue ?? ''}
                  onChange={e => onChange(item.id, 'achievedValue', e.target.value)} />
              </div>
            </div>
            <div style={{ flex: '0 1 110px', minWidth: 100 }}>
              <label className="form-label mb-1" style={{ fontSize: '0.62rem', color: 'var(--success-text)', fontWeight: 600 }}>
                Commission
              </label>
              <div className="input-group input-group-sm">
                <input type="number" className="form-control" placeholder="0.5" min="0" max="100" step="0.01"
                  value={pct}
                  onChange={e => onChange(item.id, 'commissionPct', e.target.value)}
                  style={pctOverAllocated ? { borderColor: 'color-mix(in srgb, var(--danger) 35%, transparent)' } : undefined} />
                <span className="input-group-text" style={{ fontSize: '0.7rem' }}>%</span>
              </div>
            </div>
          </div>

          {/* Show the arithmetic rather than just the answer — the payout is
              three numbers and an exchange rate deep, and an OL setting it
              should be able to see where the figure came from. */}
          <div style={{ fontSize: '0.66rem', color: 'var(--success-text)', marginTop: 8, borderTop: '1px dashed color-mix(in srgb, var(--success) 35%, transparent)', paddingTop: 6 }}>
            {!Number(pct) ? (
              <span style={{ color: 'var(--warning-text)' }}>
                <i className="bi bi-exclamation-triangle me-1" />
                No commission percentage set — this line will pay nothing.
              </span>
            ) : benchmark <= 0 ? (
              // A blank benchmark is a real mode — commission on everything —
              // so it is stated, not warned about. Stating the actual figure is
              // what makes a genuinely forgotten benchmark obvious: the OL sees
              // the whole achieved amount being paid on, not a silent zero.
              <>
                <strong>No benchmark</strong>, so this pays on the whole achieved figure.{' '}
                {pctClamped}% of {money(achieved)} is{' '}
                <strong>{money(earnedRaw)}</strong>,
                converted to PKR at the rate the Boss sets in Settings.
              </>
            ) : excess <= 0 ? (
              <>Achieved is at or below the benchmark, so there is no excess yet and this
                line pays nothing. It starts paying above {money(benchmark)}.</>
            ) : (
              <>
                {money(achieved)} − {money(benchmark)} = <strong>{money(excess)}</strong> excess.{' '}
                {pctClamped}% of that is <strong>{money(earnedRaw)}</strong>,
                converted to PKR at the rate the Boss sets in Settings.
              </>
            )}
          </div>

          {pctOverAllocated && (
            <div style={{ fontSize: '0.65rem', color: 'var(--danger-text)', marginTop: 4 }}>
              <i className="bi bi-exclamation-triangle-fill me-1" />
              Over 100%. It will be saved as 100%.
            </div>
          )}
          {/* Nothing in the data model knows about sibling lines: each person's
              items are independent JSONB, so several people can each be given a
              cut of the same brand and nothing would say so until payday. */}
          {othersPct > 0 && (
            <div style={{ fontSize: '0.65rem', color: 'var(--text-muted)', marginTop: 4 }}>
              <i className="bi bi-people me-1" />
              Other commission lines on this brand this month total {othersPct}%
              {Number(pct) > 0 && <> — <strong>{Math.round((othersPct + Number(pct)) * 100) / 100}% with this one</strong></>}.
              Each has its own benchmark, so this is a rough guide, not a total.
            </div>
          )}
        </div>
      )}

      {/* Target + Compensation on same row. A commission line sets its own
          benchmark and achieved above, and its money is calculated, so none of
          these three inputs apply to it. */}
      {!isComm && (
      <div className="d-flex gap-2">
        <div className="flex-grow-1">
          <label className="form-label mb-1" style={{ fontSize: '0.65rem', color: 'var(--text-muted)' }}>
            {isAtt   ? <>Target <span className="text-muted">(auto · attendance %)</span></>
             : isComm ? <>Target <span className="text-muted">(auto · the brand&apos;s GMV goal)</span></>
             : goalLocked ? <>Target <span className="text-muted">(auto · the brand&apos;s monthly GMV goal)</span></>
             : <>Target value <span className="text-muted">(suffix optional — e.g. %, $, pts)</span></>}
          </label>
          <div className="input-group input-group-sm">
            <input
              type="number"
              className="form-control"
              placeholder={isComm ? 'From Brand Analytics' : 'e.g. 250'}
              min="0"
              value={isAtt ? 100 : isComm ? '' : goalLocked ? gmvGoal : (item.targetValue ?? '')}
              onChange={e => onChange(item.id, 'targetValue', e.target.value)}
              readOnly={isAtt || isComm || goalLocked}
              disabled={isAtt || isComm || goalLocked}
              style={isAtt || isComm || goalLocked ? lockStyle : undefined}
            />
            <input
              type="text"
              className="form-control"
              placeholder="—"
              maxLength={6}
              value={suffix}
              onChange={e => onChange(item.id, 'suffix', e.target.value)}
              readOnly={isAtt || isComm}
              disabled={isAtt || isComm}
              style={{ maxWidth: 60, fontSize: '0.78rem', textAlign: 'center', ...(lockStyle || {}) }}
              title="Optional unit (e.g. %, $, pts) — leave blank for plain numbers"
            />
          </div>
          {/* The link is enforced in the database (mig 366), so say where the
              number comes from rather than letting someone type one that is
              silently replaced on save. When the brand has no goal yet the
              field stays editable, otherwise a brand nobody has set a goal for
              could never have a target at all. */}
          {isGmvMax && (
            <div className="form-text" style={{ fontSize: '0.62rem' }}>
              {goalLocked
                ? <>Set by this brand&apos;s GMV goal for the month in Brand Analytics. Everyone on the brand shares it.</>
                : <>No GMV goal set for this brand this month. Setting one in Brand Analytics will take over this target.</>}
            </div>
          )}
        </div>
        <div style={{ width: 150 }}>
          <label className="form-label mb-1" style={{ fontSize: '0.65rem', color: 'var(--text-muted)' }}>
            {isComm ? <>Compensation <span className="text-muted">(auto)</span></> : 'Compensation if achieved'}
          </label>
          <div className="input-group input-group-sm">
            <span className="input-group-text text-success fw-semibold">+</span>
            <input
              type="number"
              className="form-control"
              placeholder={isComm ? 'Calculated' : 'Amount'}
              min="0"
              value={isComm ? '' : item.amount}
              onChange={e => onChange(item.id, 'amount', e.target.value)}
              readOnly={isComm}
              disabled={isComm}
              style={lockStyle}
              title={isComm ? 'Calculated from the brand’s GMV — see the Incentives page for the live figure' : undefined}
            />
            <span className="input-group-text" style={{ fontSize: '0.7rem' }}>PKR</span>
          </div>
        </div>
      </div>
      )}
    </div>
  );
}

// ── One brand's group of items inside a section ──────────────────────────────
function BrandGroup({ brand, items, color, onChange, onRemove, onAdd, noun, commAlloc, targetId, gmvGoal }) {
  const total = items.reduce((s, i) => s + (Number(i.amount) || 0), 0);
  const tier = brand.tier ? TIER_STYLE[String(brand.tier).toLowerCase()] : null;
  return (
    <div className="rounded-3 mb-2" style={{ border: '1px solid var(--border-subtle)', background: 'var(--surface-1)', overflow: 'hidden' }}>
      <div className="d-flex align-items-center justify-content-between px-3 py-2"
        style={{ background: 'var(--surface-2)', borderBottom: items.length ? '1px solid var(--border-subtle)' : 'none' }}>
        <span className="d-inline-flex align-items-center gap-2">
          <i className="bi bi-shop" style={{ color, fontSize: '0.8rem' }} />
          <span className="fw-semibold" style={{ fontSize: '0.82rem' }}>{brand.name}</span>
          {tier && (
            <span className="rounded-pill" style={{ background: tier.bg, color: tier.fg, border: `1px solid ${tier.border}`, padding: '0 6px', fontSize: '0.58rem', fontWeight: 700 }}>{tier.label}</span>
          )}
        </span>
        {total > 0 && <span className="fw-bold" style={{ fontSize: '0.75rem', color }}>+{formatPKR(total)}</span>}
      </div>
      <div className="p-2">
        {items.length === 0
          ? <p className="text-muted mb-2 px-1" style={{ fontSize: '0.72rem' }}>No {noun} for this brand yet.</p>
          : items.map((item) => <LineRow key={item.id} item={item} onChange={onChange} onRemove={onRemove} hideToggles brandCurrency={brand.currency}
              gmvGoal={gmvGoal}
              othersPct={otherCommissionPct(commAlloc, brand.id, targetId, item.id)} />)}
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
function PlanSection({ title, color, icon, items, setItems, brands, noun, commAlloc, targetId, gmvGoals }) {
  const change = (id, field, val) => setItems(prev => prev.map(it => it.id === id ? { ...it, [field]: val } : it));
  const remove = (id) => setItems(prev => prev.filter(it => it.id !== id));
  const addBrand = (brand) => setItems(prev => [...prev, { id: uid4(), text: '', amount: '', suffix: '', brandId: brand.id, brandName: brand.name }]);
  const addOther = () => setItems(prev => [...prev, { id: uid4(), text: '', amount: '', suffix: '' }]);

  const brandIds = new Set((brands || []).map(b => b.id));
  const otherItems  = items.filter(i => !i.brandId);
  const orphanItems = items.filter(i => i.brandId && !brandIds.has(i.brandId));
  const total = items.reduce((s, i) => s + (Number(i.amount) || 0), 0);

  return (
    <div className="card border-0 shadow-sm mb-3" style={{ borderRadius: 'var(--radius-md)' }}>
      <div className="card-body p-3">
        <div className="d-flex align-items-center justify-content-between mb-3">
          <div className="d-flex align-items-center gap-2">
            <div className="rounded-2 d-flex align-items-center justify-content-center" style={{ width: 30, height: 30, background: color + '20' }}>
              <i className={`bi ${icon}`} style={{ color, fontSize: '0.85rem' }} />
            </div>
            <span className="fw-semibold small">{title}</span>
          </div>
          {total > 0 && <span className="fw-bold small" style={{ color }}>+{formatPKR(total)}</span>}
        </div>

        {brands && brands.length > 0 ? (
          <>
            <div className="text-muted fw-semibold mb-2" style={{ fontSize: '0.66rem', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
              <i className="bi bi-link-45deg me-1" />Brand {noun}s
            </div>
            {brands.map((brand) => (
              <BrandGroup key={brand.id} brand={brand} color={color} noun={noun} commAlloc={commAlloc} targetId={targetId}
                items={items.filter(i => i.brandId === brand.id)}
                gmvGoal={Number(gmvGoals?.[brand.id]?.gmv_target) || 0}
                onChange={change} onRemove={remove} onAdd={addBrand} />
            ))}
          </>
        ) : (
          <p className="text-muted mb-3" style={{ fontSize: '0.72rem' }}>No brands assigned to this person — add items under “Other” below.</p>
        )}

        {orphanItems.length > 0 && (
          <div className="rounded-3 mb-2 mt-2 p-2" style={{ border: '1px dashed color-mix(in srgb, var(--warning) 40%, transparent)', background: 'var(--warning-soft)' }}>
            <div className="fw-semibold mb-2" style={{ fontSize: '0.7rem', color: 'var(--warning-text)' }}>
              <i className="bi bi-exclamation-triangle me-1" />Linked to a brand no longer assigned{orphanItems[0]?.brandName ? ` (${orphanItems.map(o => o.brandName).filter((v, i, a) => v && a.indexOf(v) === i).join(', ')})` : ''} — remove, or it drops on the next carry-forward
            </div>
            {orphanItems.map((item) => <LineRow key={item.id} item={item} onChange={change} onRemove={remove} hideToggles
              brandCurrency={item.brandCurrency} gmvGoal={Number(gmvGoals?.[item.brandId]?.gmv_target) || 0} />)}
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
  gold:     { bg: 'var(--warning-soft)', fg: 'var(--warning-text)', border: 'color-mix(in srgb, var(--warning) 40%, transparent)', label: 'Gold' },
  silver:   { bg: 'var(--surface-3)', fg: 'var(--text-secondary)', border: 'var(--border-default)', label: 'Silver' },
  bronze:   { bg: 'var(--warning-soft)', fg: 'var(--warning-text)', border: 'color-mix(in srgb, var(--warning) 40%, transparent)', label: 'Bronze' },
  platinum: { bg: 'var(--purple-soft)', fg: 'var(--purple-text)', border: 'color-mix(in srgb, var(--purple) 35%, transparent)', label: 'Platinum' },
};
function BrandContextChip({ brand }) {
  const tier = brand.tier ? TIER_STYLE[String(brand.tier).toLowerCase()] : null;
  const inactive = brand.status && String(brand.status).toLowerCase() !== 'active';
  return (
    <span
      className="d-inline-flex align-items-center gap-2 rounded-pill"
      title={brand.notes || undefined}
      style={{
        background: 'var(--surface-1)',
        border: '1px solid var(--border-subtle)',
        padding: '4px 10px',
        fontSize: '0.72rem',
        color: 'var(--text-primary)',
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
        <span style={{ fontSize: '0.62rem', color: 'var(--text-muted)', fontWeight: 500 }}>
          · {brand.status}
        </span>
      )}
    </span>
  );
}

// ── Main IncentiveForm ────────────────────────────────────────────────────────
export default function IncentiveForm() {
  const toast = useToast();
  const confirm = useConfirm();
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
  // brandId -> [{ userId, userName, pct }] across EVERYONE this month, so a
  // commission line can show what is already promised on the same brand.
  const [commAlloc, setCommAlloc] = useState(new Map());
  // brand_id -> the month's brand_monthly_metrics row, for the GMV-Max targets.
  const [gmvGoals, setGmvGoals] = useState({});
  const [wbOpen, setWbOpen] = useState(false);

  // Apply the workbook picks onto the plan. The modal only decides WHAT was
  // chosen; the form owns the arrays, so a pick can never bypass the editing
  // rules or the save path.
  function applyWorkbookPicks({ add, updates, removed }) {
    const patch = (list) => list
      .filter((it) => !removed.has(it.id))
      .map((it) => (updates.has(it.id) ? { ...it, ...updates.get(it.id) } : it));
    setIncentives((prev) => [...patch(prev), ...(add.incentives || [])]);
    setBonuses((prev) => [...patch(prev), ...(add.bonuses || [])]);
    setWbOpen(false);
  }

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

      // Who else is already on a commission for these brands this month.
      // Advisory only, so a failure here must never block opening the editor.
      try {
        setCommAlloc(await fetchBrandCommissionAllocations(currentMonth));
      } catch { /* ignore — the hint just will not show */ }

      // The month's brand GMV goals, which own every GMV-Max target (mig 366).
      // Advisory in the same way: without it the target simply stays editable,
      // and the database still applies the goal on save.
      try {
        setGmvGoals(await listBrandMetricsForMonth(currentMonth));
      } catch { /* ignore — the field stays unlocked */ }

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
              // Carry the workbook marker too, so next month's plan still
              // reconciles against the picker instead of duplicating lines.
              ...(i.wbOption ? { wbOption: i.wbOption } : {}),
              // Carry the agreed share into the new month; without it the line
              // arrives set to nothing and quietly pays nothing.
              ...(i.commissionPct != null ? { commissionPct: Number(i.commissionPct) || 0 } : {}),
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
    const fromTemplate = (i) => ({
      id: uid4(), text: i.text, amount: i.amount,
      targetValue: i.targetValue ?? '', suffix: itemSuffix(i),
      achievedValue: 0, completed: false, completedBy: null,
      ...(i.source ? { source: i.source } : {}),
      ...(i.commissionPct != null ? { commissionPct: Number(i.commissionPct) || 0 } : {}),
    });
    // Templates carry no brand link, and a commission line without one can
    // never pay. New templates no longer store them at all; this also drops any
    // that a template saved before that change is still carrying.
    const templatable = (i) => i && i.source !== 'commission_tier';
    setBasicSalary(String(tplData.basicSalary || ''));
    setIncentives((tplData.incentives || []).filter(templatable).map(fromTemplate));
    setBonuses((tplData.bonuses || []).filter(templatable).map(fromTemplate));
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
    const ok = await confirm({
      title: 'Save as default template?',
      message: 'Save the current basic salary, incentives and bonuses as the default template? This will overwrite any existing template.',
      confirmLabel: 'Save template',
    });
    if (!ok) return;
    setTemplateBusy(true); setError('');
    try {
      const tplName = userProfile?.displayName || currentUser?.displayName || currentUser?.email || 'OL';
      await setIncentivesTemplate({
        basicSalary, incentives, bonuses, savedByName: tplName,
      });
      setHasTemplate(true);
      toast.success('Default template saved.');
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
        // Which workbook option produced this line. Without it the workbook
        // picker cannot tell an existing line from a new one and would offer to
        // add the same option a second time.
        ...(i.wbOption ? { wbOption: i.wbOption } : {}),
        // The OL's typed share for a Commission Based Tier line. This map is a
        // fixed field list, so an omitted field is a field deleted on save —
        // and this one is the whole input to the payout calculation.
        ...(i.commissionPct != null && i.commissionPct !== ''
          ? { commissionPct: Math.min(Math.max(Number(i.commissionPct) || 0, 0), 100) } : {}),
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
          style={{ background: 'var(--spotlight-bg)', color: 'var(--spotlight-fg)' }}
        >
          <div
            className="rounded-circle d-flex align-items-center justify-content-center fw-bold flex-shrink-0"
            style={{ width: 44, height: 44, background: 'color-mix(in srgb, var(--spotlight-fg) 15%, transparent)', fontSize: '0.9rem' }}
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
          <div className="rounded-3 mb-3 p-3" style={{ background: 'var(--surface-2)', border: '1px solid var(--border-subtle)' }}>
            <div className="d-flex align-items-center justify-content-between mb-2">
              <span className="fw-semibold" style={{ fontSize: '0.78rem', color: 'var(--text-primary)' }}>
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
          style={{ background: 'var(--info-soft)', border: '1px solid color-mix(in srgb, var(--info) 35%, transparent)', borderRadius: 'var(--radius-md)', color: 'var(--info-text)', fontSize: '0.78rem' }}>
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
          style={{ background: 'var(--surface-2)', border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius-md)', fontSize: '0.78rem' }}>
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
        <div className="card border-0 shadow-sm mb-3" style={{ borderRadius: 'var(--radius-md)' }}>
          <div className="card-body p-3">
            <div className="d-flex align-items-center gap-2 mb-3">
              <div
                className="rounded-2 d-flex align-items-center justify-content-center"
                style={{ width: 30, height: 30, background: 'var(--surface-2)' }}
              >
                <i className="bi bi-wallet2" style={{ color: 'var(--text-muted)', fontSize: '0.85rem' }} />
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

        {/* Pull this month's targets for the brand options out of the workbook.
            APC/IPC only: the five options are per-brand creator metrics, and a
            TL's or Ads Manager's plan is not built from them. */}
        {(targetRole === 'apc' || targetRole === 'ipc') && brands.length > 0 && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12, flexWrap: 'wrap' }}>
            <button type="button" className="wx-btn wx-btn-ghost" onClick={() => setWbOpen(true)}>
              <i className="bi bi-journal-arrow-down me-1" /> Add from brand workbook
            </button>
            <span style={{ fontSize: '0.72rem', color: 'var(--text-muted)' }}>
              Up to {MAX_SELECTIONS_PER_APC} options across all {brands.length} brand{brands.length === 1 ? '' : 's'} combined.
            </span>
          </div>
        )}

        {wbOpen && (
          <WorkbookIncentivesModal
            brands={brands}
            month={currentMonth}
            incentives={incentives}
            bonuses={bonuses}
            onClose={() => setWbOpen(false)}
            onApply={applyWorkbookPicks}
          />
        )}

        {/* Incentives — brand groups + Other */}
        <PlanSection
          title="Incentives"
          color="var(--success-text)"
          icon="bi-graph-up-arrow"
          items={incentives}
          setItems={setIncentives}
          brands={brands}
          noun="incentive"
          commAlloc={commAlloc}
          targetId={targetId}
          gmvGoals={gmvGoals}
        />

        {/* Bonuses — brand groups + Other */}
        <PlanSection
          title="Bonuses"
          color="var(--info-text)"
          icon="bi-trophy"
          items={bonuses}
          setItems={setBonuses}
          brands={brands}
          noun="bonus"
          commAlloc={commAlloc}
          gmvGoals={gmvGoals}
          targetId={targetId}
        />

        {/* Summary */}
        <div className="card border-0 shadow-sm mb-4" style={{ borderRadius: 'var(--radius-md)', background: 'var(--surface-2)' }}>
          <div className="card-body p-3">
            <p className="text-muted small fw-semibold mb-2 text-uppercase" style={{ letterSpacing: '0.05em', fontSize: '0.65rem' }}>
              Summary
            </p>
            <div className="d-flex flex-column gap-1" style={{ fontSize: '0.82rem' }}>
              <div className="d-flex justify-content-between">
                <span className="text-muted">Basic Salary</span>
                <span>{formatPKR((Number(basicSalary) || 0))}</span>
              </div>
              <div className="d-flex justify-content-between">
                <span className="text-muted">Total Incentives ({incentives.length})</span>
                <span className="text-success fw-medium">+{formatPKR(incTotal)}</span>
              </div>
              <div className="d-flex justify-content-between">
                <span className="text-muted">Total Bonuses ({bonuses.length})</span>
                <span className="text-info fw-medium">+{formatPKR(bonTotal)}</span>
              </div>
              <div
                className="d-flex justify-content-between fw-bold pt-2 mt-1"
                style={{ borderTop: '1px solid var(--border-subtle)', fontSize: '0.95rem' }}
              >
                <span>Total Salary</span>
                <span>{formatPKR(grandTotal)}</span>
              </div>
            </div>
          </div>
        </div>

        <div className="d-flex gap-2 align-items-center flex-wrap">
          <button type="submit" className="btn btn-primary d-inline-flex align-items-center gap-1" disabled={saving}>
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
