import React, { useEffect, useState, useMemo } from 'react';
import { useAuth } from '../../contexts/AuthContext';
import {
  // Bulk loaders
  listAllRatingsForMonth, listAllFlags, listAllWarnings, listAllIncentivesForMonth,
  listEvaluableUsers, listFlagsForUser, getRatingFor, countWarningsForUser,
  // Mutations
  saveRating, saveFlag, saveWarning, getV1Weights, saveV1Weights,
  // Flag removal request flow
  requestFlagRemoval, decideFlagRemoval, removeFlagDirect,
  listFlagRemovalRequests,
  // Attendance — single source of truth (SQL). Never recompute here.
  fetchAttendanceBreakdown, fetchAttendanceBreakdownBulk,
  // Shared role/rating helpers — single source, no local copies.
  ROLE_LABEL, canRate,
} from '../../lib/performanceApi';
import {
  listPendingApcRatings, getWeeklyRatingsEnabled, setWeeklyRatingsEnabled,
} from '../../lib/weeklyRatingsApi';
import {
  getTlPerfEnabled, setTlPerfEnabled, listTlReporting, tlPerfPreview,
} from '../../lib/tlPerfApi';
import WeeklyBreakdownModal from './WeeklyBreakdownModal';
import TlPerfBreakdownModal from './TlPerfBreakdownModal';
import { karachiMonth } from '../../lib/serverTime';

// ── Helpers ──────────────────────────────────────────────────────────────────

function getMonthLabel(ym) {
  if (!ym) return '';
  const [y, m] = ym.split('-');
  return new Date(y, m - 1).toLocaleString('en-US', { month: 'long', year: 'numeric' });
}

const METRICS = [
  { key: 'dailyTasksQuality', label: 'Daily Tasks Quality',  icon: 'bi-check2-all',
    description: 'How well daily tasks are completed — accuracy, attention to detail, and whether the output actually meets the brief without needing rework.' },
  { key: 'reporting',         label: 'Reporting',             icon: 'bi-file-earmark-text',
    description: 'Quality and timeliness of weekly, bi-weekly, and monthly reports — submitted on time, complete sections, useful insights vs. filler.' },
  // Punctuality was removed (mig 243): it double-counted. Attendance is its own
  // auto-fetched pillar, and the incentive items already cover punctuality —
  // rating it by hand a third time just diluted the other five metrics.
  { key: 'overallWorkflow',   label: 'Overall Workflow',      icon: 'bi-diagram-3',
    description: 'How organized and process-driven the person is — following SOPs, keeping their work area tidy, and managing their day without constant supervision.' },
  { key: 'responseTime',      label: 'Response Time',         icon: 'bi-chat-dots',
    description: 'How quickly they reply to messages, brand requests, and team pings on Discord/chat during their working hours.' },
  { key: 'tasksProcessing',   label: 'Efficiency',             icon: 'bi-list-task',
    description: 'Speed and efficiency of getting through assigned tasks — finishing what is on the plate vs. letting items pile up.' },
];

// Small hover-tooltip beside each metric label. Pure CSS — the tip is
// always in the DOM but invisible until the wrapper is hovered/focused.
// We render the icon as a button so keyboard users can focus it and
// read the description, and so :focus-within shows the tip on touch
// devices that fire focus on tap.
function MetricInfoTip({ text }) {
  if (!text) return null;
  return (
    <span className="wx-metric-tip-wrap" tabIndex={0}
      aria-label={text}
      style={{ position: 'relative', display: 'inline-flex', alignItems: 'center', cursor: 'help', outline: 'none' }}>
      <i className="bi bi-info-circle" style={{ color: 'var(--text-muted)', fontSize: '0.72rem' }} />
      {/* Anchor the tooltip's left edge to the icon and let it grow to
          the right. A previous centered-and-translateX layout overflowed
          left when the icon was near a panel/viewport edge, getting
          clipped. Left-anchored + min(viewport-aware width) keeps the
          full text on-screen regardless of where the icon sits. */}
      <span className="wx-metric-tip" role="tooltip"
        style={{
          position: 'absolute', bottom: 'calc(100% + 6px)', left: 0,
          background: 'var(--accent)', color: 'var(--on-accent)',
          padding: '8px 10px', borderRadius: 8,
          fontSize: '0.72rem', lineHeight: 1.45, fontWeight: 400,
          width: 'max-content', maxWidth: 'min(320px, calc(100vw - 32px))',
          textAlign: 'left',
          boxShadow: '0 8px 24px rgba(15,23,42,0.25)',
          opacity: 0, visibility: 'hidden',
          transition: 'opacity 0.12s ease',
          pointerEvents: 'none', zIndex: 1080,
          whiteSpace: 'normal',
        }}>
        {text}
      </span>
    </span>
  );
}

const PILLARS = [
  { key: 'performance', label: 'Performance Tracking', icon: 'bi-bar-chart-fill', color: '#0d6efd' },
  { key: 'incentives',  label: 'Bonus & Incentives',   icon: 'bi-award-fill',     color: '#198754' },
  { key: 'attendance',  label: 'Attendance',            icon: 'bi-calendar-check', color: '#fd7e14' },
  { key: 'flags',       label: 'Monthly Flags',         icon: 'bi-flag-fill',      color: '#7b1fa2' },
];

const DEFAULT_WEIGHTS = { performance: 40, incentives: 25, attendance: 20, flags: 15 };

const WEIGHTAGES = [
  { key: 'low',      label: 'Low',      color: 'var(--text-secondary)', bg: 'var(--surface-2)', pts: 3 },
  { key: 'medium',   label: 'Medium',   color: 'var(--warning)', bg: 'var(--warning-soft)', pts: 5 },
  { key: 'high',     label: 'High',     color: 'var(--danger)', bg: 'var(--danger-soft)', pts: 8 },
  { key: 'critical', label: 'Critical', color: 'var(--text-secondary)', bg: 'var(--surface-2)', pts: 12 },
];

function getLevel(score) {
  if (score >= 90) return { label: 'Promotion',   color: 'var(--success)', bg: 'var(--success-soft)', icon: 'bi-trophy-fill' };
  if (score >= 70) return { label: 'Good',         color: 'var(--info)', bg: 'var(--info-soft)', icon: 'bi-hand-thumbs-up-fill' };
  if (score >= 50) return { label: 'Warning',      color: 'var(--warning)', bg: 'var(--warning-soft)', icon: 'bi-exclamation-triangle' };
  return              { label: 'Termination',   color: 'var(--danger)', bg: 'var(--danger-soft)', icon: 'bi-x-octagon-fill' };
}

function calcMetricsAvg(metrics) {
  if (!metrics) return 0;
  // Integer-hundredths sum to mirror SQL round(sum/5) — metric values are ≤2dp
  // once weekly rollups exist; plain FP Math.round(sum/5) can drift 1 point.
  const sum = METRICS.reduce((a, m) => a + Math.round((Number(metrics[m.key]) || 0) * 100), 0);
  return Math.round(sum / (METRICS.length * 100));
}

// An incentive/bonus line item stores its name under `text` (see
// incentivesApi.setIncentivesTemplate) — NOT `title`/`label`, and there is no
// `description`. This page used to read those, so every item rendered as the
// generic word "Incentive" with no detail. Same helper as ApcIncentivesPage.
function itemSuffix(item) {
  if (item?.suffix != null && item.suffix !== '') return item.suffix;
  if (item?.unit === 'percent') return '%';
  return '';
}

function calcIncentiveScore(incRecord) {
  if (!incRecord) return null;
  const items = [...(incRecord.incentives || []), ...(incRecord.bonuses || [])];
  if (items.length === 0) return null;
  const completed = items.filter(i => i.completed).length;
  return Math.round((completed / items.length) * 100);
}

// The composite is withheld until the OL has VERIFIED the incentive plan (mig 257):
// self-reported item completion must not move the score before an OL confirms it.
// A plan that EXISTS but isn't verified => pending. No plan => nothing to verify.
function isIncPending(incRecord) {
  if (!incRecord) return false;
  const items = [...(incRecord.incentives || []), ...(incRecord.bonuses || [])];
  return items.length > 0 && !incRecord.verified;
}

/**
 * Attendance pillar score from an AttendanceBreakdown (the SQL RPC).
 *   • null breakdown  → null ("—"). NEVER 0: a failed/missing row must not
 *     render as a real, terrible score, and calcComposite drops null pillars.
 *   • daysThisMonth 0 (future month) → 100, matching the old zero-guard.
 */
function attendanceScoreFrom(b) {
  if (!b) return null;
  // Use the 1-dp EXACT coverage (pctExact), NOT the integer-rounded pct_display,
  // so this pillar == the incentive auto-fill == the SQL composite. The two
  // surfaces score the same underlying coverage; a rounded-vs-exact split could
  // differ by ~0.5 and straddle the incentive's completion boundary.
  return b.daysThisMonth > 0 ? b.pctExact : 100;
}

// Flag scoring: base 80, every green flag adds 10, every red flag
// subtracts 20. The per-flag weightage (low/medium/high/critical) is a
// visual label only — severity does not affect the score so a TL marking
// a flag 'critical' vs 'low' just helps with at-a-glance triage. To
// reintroduce severity-based scoring later, swap in the WEIGHTAGES
// table-driven version that previously lived here.
const FLAG_BASE_SCORE  = 80;
const FLAG_GREEN_DELTA = 10;
const FLAG_RED_DELTA   = -20;

// Bucket each flag by its Asia/Karachi month (the DB business zone), NOT the
// browser-local month — so the flags pillar matches get_performance_composite's
// Karachi-windowed count for a viewer in any timezone. No-op for PKT browsers.
const _KHI_YM = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Karachi', year: 'numeric', month: '2-digit' });
function calcFlagsScore(flags, month) {
  const monthFlags = flags.filter(f => {
    if (!f.createdAt) return false;
    const d = f.createdAt.toDate ? f.createdAt.toDate() : new Date(f.createdAt);
    const p = _KHI_YM.formatToParts(d);
    const fm = `${p.find(x => x.type === 'year').value}-${p.find(x => x.type === 'month').value}`;
    return fm === month;
  });
  let score = FLAG_BASE_SCORE;
  monthFlags.forEach(f => {
    score += f.type === 'green' ? FLAG_GREEN_DELTA : FLAG_RED_DELTA;
  });
  return Math.max(0, Math.min(100, score));
}

function calcComposite(pillarScores, weights) {
  let totalWeight = 0, weightedSum = 0;
  PILLARS.forEach(p => {
    const s = pillarScores[p.key];
    const w = weights[p.key] || 0;
    if (s !== null && s !== undefined) { weightedSum += s * w; totalWeight += w; }
  });
  return totalWeight > 0 ? Math.round(weightedSum / totalWeight) : 0;
}

// ROLE_LABEL (complete apc/ipc/tl/pctl/ol/boss/developer map) and canRate are
// imported from performanceApi so this page and the API can never drift — the
// old local ROLE_LABEL was missing pctl/ipc (blank role on IPC rows) and the
// local canRate diverged from the exported one.

// ── Rate Modal (Performance Tracking pillar) ─────────────────────────────────

function RateModal({ user, existing, month, onClose, onSaved }) {
  const [metrics, setMetrics] = useState(() => {
    const m = {};
    METRICS.forEach(mt => { m[mt.key] = existing?.metrics?.[mt.key] ?? 50; });
    return m;
  });
  const [saving, setSaving] = useState(false);

  const overall = calcMetricsAvg(metrics);
  const level = getLevel(overall);

  async function handleSave() {
    setSaving(true);
    try {
      const metricsNum = {};
      METRICS.forEach(m => { metricsNum[m.key] = Number(metrics[m.key]) || 0; });
      // v2 saveRating returns the upserted row already shaped for v1.
      const saved = await saveRating({
        userId: user.id,
        userName: user.displayName || user.userName || user.email || '',
        userRole: user.role || user.userRole || 'apc',
        month,
        metrics: metricsNum,
      });
      onSaved(saved);
    } finally { setSaving(false); }
  }

  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 1070, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
      <div style={{ position: 'absolute', inset: 0, background: 'rgba(0,0,0,0.5)', backdropFilter: 'blur(2px)' }} onClick={onClose} />
      <div className="card border-0 shadow-lg" style={{ position: 'relative', width: '100%', maxWidth: 520, zIndex: 1, borderRadius: 14, maxHeight: '90vh', overflowY: 'auto' }}>
        <div className="card-body p-4">
          <div className="d-flex align-items-center justify-content-between mb-4">
            <div>
              <h6 className="fw-bold mb-0">Rate Performance — {user.displayName || user.userName}</h6>
              <p className="text-muted small mb-0">{getMonthLabel(month)}</p>
            </div>
            <button className="btn btn-sm btn-light border-0 rounded-circle" onClick={onClose}
              style={{ width: 32, height: 32, padding: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <i className="bi bi-x-lg" style={{ fontSize: '0.85rem' }} />
            </button>
          </div>

          <div className="d-flex flex-column gap-3 mb-4">
            {METRICS.map(m => {
              const val = Number(metrics[m.key]) || 0;
              const ml = getLevel(val);
              return (
                <div key={m.key}>
                  <div className="d-flex align-items-center justify-content-between mb-1">
                    <div className="d-flex align-items-center gap-2">
                      <i className={`bi ${m.icon} text-muted`} style={{ fontSize: '0.85rem' }} />
                      <span className="small fw-medium">{m.label}</span>
                      <MetricInfoTip text={m.description} />
                    </div>
                    <span className="badge rounded-pill" style={{ background: ml.bg, color: ml.color, fontSize: '0.58rem' }}>{val}/100</span>
                  </div>
                  <input type="range" className="form-range" min="0" max="100" step="1" value={val}
                    onChange={e => setMetrics(prev => ({ ...prev, [m.key]: Number(e.target.value) }))}
                    style={{ accentColor: ml.color }} />
                </div>
              );
            })}
          </div>

          <div className="rounded-3 p-3 mb-3 text-center" style={{ background: level.bg, border: `1.5px solid color-mix(in srgb, ${level.color} 19%, transparent)` }}>
            <div className="fw-bold" style={{ fontSize: '2rem', color: level.color }}>{overall}</div>
            <div className="d-flex align-items-center justify-content-center gap-1">
              <i className={`bi ${level.icon}`} style={{ color: level.color, fontSize: '0.8rem' }} />
              <span className="fw-semibold small" style={{ color: level.color }}>Performance Score</span>
            </div>
          </div>

          <div className="d-flex gap-2 justify-content-end">
            <button className="btn btn-sm btn-outline-secondary px-3" onClick={onClose} disabled={saving}>Cancel</button>
            <button className="btn btn-sm btn-dark px-3 d-inline-flex align-items-center gap-1" onClick={handleSave} disabled={saving}>
              {saving ? <><span className="spinner-border spinner-border-sm" /> Saving…</> : <><i className="bi bi-check-lg" /> Save</>}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Add Flag Modal ───────────────────────────────────────────────────────────

function AddFlagModal({ user, flagType, onClose, onSaved }) {
  const [weightage, setWeightage] = useState('medium');
  const [description, setDescription] = useState('');
  const [saving, setSaving] = useState(false);
  const isGreen = flagType === 'green';
  const color = isGreen ? 'var(--success)' : 'var(--danger)';

  async function handleSave() {
    if (!description.trim()) return;
    setSaving(true);
    try {
      await saveFlag({
        userId: user.id,
        type: flagType,
        weightage,
        description: description.trim(),
      });
      onSaved();
    } finally { setSaving(false); }
  }

  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 1080, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
      <div style={{ position: 'absolute', inset: 0, background: 'rgba(0,0,0,0.5)', backdropFilter: 'blur(2px)' }} onClick={onClose} />
      <div className="card border-0 shadow-lg" style={{ position: 'relative', width: '100%', maxWidth: 440, zIndex: 1, borderRadius: 14 }}>
        <div className="card-body p-4">
          <div className="d-flex align-items-center gap-2 mb-3">
            <div className="rounded-2 d-flex align-items-center justify-content-center flex-shrink-0"
              style={{ width: 36, height: 36, background: isGreen ? 'var(--success-soft)' : 'var(--danger-soft)' }}>
              <i className="bi bi-flag-fill" style={{ color, fontSize: '0.9rem' }} />
            </div>
            <div>
              <h6 className="fw-bold mb-0">Add {isGreen ? 'Green' : 'Red'} Flag</h6>
              <p className="text-muted small mb-0">{user.displayName || user.userName}</p>
            </div>
          </div>
          <div className="mb-3">
            <label className="form-label small fw-semibold mb-1 d-flex align-items-center gap-1">
              Severity
              <span className="text-muted fw-normal" style={{ fontSize: '0.68rem' }}>
                (triage only — does not affect the score)
              </span>
            </label>
            <div className="d-flex gap-2 flex-wrap">
              {WEIGHTAGES.map(w => (
                <button key={w.key} type="button" className="btn btn-sm px-3"
                  style={{ background: weightage === w.key ? w.color : w.bg, color: weightage === w.key ? '#fff' : w.color, border: `1.5px solid color-mix(in srgb, ${w.color} 25%, transparent)`, borderRadius: 8, fontSize: '0.75rem', fontWeight: 600 }}
                  onClick={() => setWeightage(w.key)}>{w.label}</button>
              ))}
            </div>
          </div>
          <div className="mb-3">
            <label className="form-label small fw-semibold mb-1">Description</label>
            <textarea className="form-control form-control-sm" rows={3}
              placeholder={isGreen ? 'What did they achieve?' : 'What happened?'}
              value={description} onChange={e => setDescription(e.target.value)} />
          </div>
          <div className="d-flex gap-2 justify-content-end">
            <button className="btn btn-sm btn-outline-secondary px-3" onClick={onClose} disabled={saving}>Cancel</button>
            <button className="btn btn-sm px-3 d-inline-flex align-items-center gap-1"
              style={{ background: color, color: '#fff', border: 'none', borderRadius: 8 }}
              onClick={handleSave} disabled={saving || !description.trim()}>
              {saving ? <><span className="spinner-border spinner-border-sm" /> Saving…</> : <><i className="bi bi-flag-fill" /> Add Flag</>}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── View Flags Modal ─────────────────────────────────────────────────────────

function ViewFlagsModal({
  user, flags, onClose, canManage, onAddFlag,
  currentUserId, currentUserRole, pendingRemovals = {}, onFlagsChanged,
}) {
  const [tab, setTab] = useState('green');
  const [busy, setBusy] = useState({}); // flagId → bool (per-flag spinner)
  const filtered = flags.filter(f => f.type === tab);

  const fmtTimestamp = (d) => {
    if (!d) return null;
    const dt = d?.toDate ? d.toDate() : new Date(d);
    if (isNaN(dt.getTime())) return null;
    return dt.toLocaleString(undefined, {
      year: 'numeric', month: 'short', day: 'numeric',
      hour: 'numeric', minute: '2-digit',
    });
  };
  const fmtMonth = (d) => {
    if (!d) return null;
    const dt = d?.toDate ? d.toDate() : new Date(d);
    if (isNaN(dt.getTime())) return null;
    return dt.toLocaleString(undefined, { year: 'numeric', month: 'long' });
  };

  const isBoss = currentUserRole === 'boss';
  const isOl   = currentUserRole === 'ol';

  // OL can request removal of flags THEY created; Boss can delete
  // directly. Both actions go through server-side RPCs that enforce
  // the same rules — these checks just hide the buttons when they
  // wouldn't succeed.
  const canRequestRemoval = (f) =>
    isOl && f.addedBy === currentUserId && !pendingRemovals[f.id];
  const canBossRemove = (f) => isBoss;

  async function handleRequestRemoval(flag) {
    const reason = window.prompt(
      'Why should this flag be removed? Boss will see your reason.\n\n(Short explanation, e.g. "Was a misunderstanding — the campaign was completed on time.")',
      ''
    );
    if (!reason || !reason.trim()) return;
    if (reason.trim().length < 3) {
      alert('Please give a longer reason (3+ characters).');
      return;
    }
    setBusy((b) => ({ ...b, [flag.id]: true }));
    try {
      await requestFlagRemoval(flag.id, reason.trim());
      onFlagsChanged?.({ kind: 'request', flag });
      alert('Removal request sent to Boss for approval.');
    } catch (err) {
      alert('Failed to send request: ' + (err.message || 'unknown error'));
    } finally {
      setBusy((b) => ({ ...b, [flag.id]: false }));
    }
  }

  async function handleBossRemove(flag) {
    if (!window.confirm('Remove this flag immediately? This cannot be undone.')) return;
    setBusy((b) => ({ ...b, [flag.id]: true }));
    try {
      await removeFlagDirect(flag.id);
      onFlagsChanged?.({ kind: 'removed', flag });
    } catch (err) {
      alert('Failed to remove flag: ' + (err.message || 'unknown error'));
    } finally {
      setBusy((b) => ({ ...b, [flag.id]: false }));
    }
  }

  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 1070, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
      <div style={{ position: 'absolute', inset: 0, background: 'rgba(0,0,0,0.5)', backdropFilter: 'blur(2px)' }} onClick={onClose} />
      <div className="card border-0 shadow-lg" style={{ position: 'relative', width: '100%', maxWidth: 500, zIndex: 1, borderRadius: 14, maxHeight: '90vh', overflowY: 'auto' }}>
        <div className="card-body p-4">
          <div className="d-flex align-items-center justify-content-between mb-3">
            <h6 className="fw-bold mb-0">{user.displayName || user.userName} — Flags</h6>
            <button className="btn btn-sm btn-light border-0 rounded-circle" onClick={onClose}
              style={{ width: 32, height: 32, padding: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <i className="bi bi-x-lg" style={{ fontSize: '0.85rem' }} />
            </button>
          </div>
          {/* Help banner so users understand the month-scope rule —
              a flag only affects the performance score of the month
              it was created in. It still shows in history forever. */}
          <div className="rounded-3 p-2 mb-3 d-flex align-items-start gap-2"
            style={{ background: 'var(--info-soft, #eff6ff)', border: '1px solid var(--info, #93c5fd)', fontSize: '0.7rem', color: 'var(--text-secondary)' }}>
            <i className="bi bi-info-circle-fill flex-shrink-0 mt-1" style={{ color: 'var(--info, #2563eb)' }} />
            <span>
              Each flag affects the performance score of <strong>only the month it was created in</strong>.
              The flag itself stays visible in history below.
            </span>
          </div>
          <div className="d-flex gap-1 mb-3">
            {['green', 'red'].map(t => {
              const count = flags.filter(f => f.type === t).length;
              const g = t === 'green';
              return (
                <button key={t} onClick={() => setTab(t)} className="btn btn-sm flex-grow-1 d-inline-flex align-items-center justify-content-center gap-1"
                  style={{ borderRadius: 8, fontSize: '0.78rem', fontWeight: 600, background: tab === t ? (g ? 'var(--success)' : 'var(--danger)') : 'var(--surface-2)', color: tab === t ? '#fff' : 'var(--text-secondary)', border: 'none' }}>
                  <i className="bi bi-flag-fill" /> {g ? 'Green' : 'Red'} ({count})
                </button>
              );
            })}
          </div>
          {filtered.length === 0 ? (
            <div className="text-center py-4 text-muted small">No {tab} flags yet.</div>
          ) : (
            <div className="d-flex flex-column gap-2 mb-3">
              {filtered.sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0)).map(f => {
                const w = WEIGHTAGES.find(x => x.key === f.weightage) || WEIGHTAGES[0];
                const ts = fmtTimestamp(f.createdAt);
                const month = fmtMonth(f.createdAt);
                const pending = pendingRemovals[f.id];
                const isBusy = !!busy[f.id];
                return (
                  <div key={f.id} className="rounded-3 p-3" style={{ background: tab === 'green' ? 'var(--success-soft)' : 'var(--danger-soft)', border: `1px solid ${tab === 'green' ? 'color-mix(in srgb, var(--success) 35%, transparent)' : 'color-mix(in srgb, var(--danger) 35%, transparent)'}` }}>
                    <div className="d-flex align-items-start justify-content-between gap-2 mb-2">
                      <span className="small fw-medium">{f.description}</span>
                      <span className="badge rounded-pill flex-shrink-0" style={{ background: w.bg, color: w.color, fontSize: '0.58rem' }}>{w.label}</span>
                    </div>
                    <div className="d-flex flex-column gap-1" style={{ fontSize: '0.68rem', color: 'var(--text-secondary)' }}>
                      <div className="d-flex align-items-center gap-1">
                        <i className="bi bi-person" style={{ opacity: 0.7 }} />
                        <span>Flagged by <strong>{f.addedByName || 'Unknown'}</strong></span>
                      </div>
                      {ts && (
                        <div className="d-flex align-items-center gap-1">
                          <i className="bi bi-clock" style={{ opacity: 0.7 }} />
                          <span>{ts}</span>
                        </div>
                      )}
                      {month && (
                        <div className="d-flex align-items-center gap-1">
                          <i className="bi bi-calendar3" style={{ opacity: 0.7 }} />
                          <span>Affects <strong>{month}</strong> score</span>
                        </div>
                      )}
                    </div>
                    {/* Pending-removal banner — visible to everyone who
                        can see this flag so the state is unambiguous. */}
                    {pending && (
                      <div className="mt-2 rounded-2 px-2 py-1 d-flex align-items-center gap-2"
                        style={{ background: 'var(--warning-soft)', border: '1px solid color-mix(in srgb, var(--warning) 35%, transparent)', fontSize: '0.66rem', color: 'var(--warning)' }}>
                        <i className="bi bi-hourglass-split" />
                        <span>
                          Removal pending Boss approval
                          {pending.requester?.display_name && <> · requested by {pending.requester.display_name}</>}
                        </span>
                      </div>
                    )}
                    {/* Action buttons — OL who created the flag can
                        request removal; Boss can remove directly. */}
                    {(canRequestRemoval(f) || canBossRemove(f)) && (
                      <div className="d-flex gap-2 mt-2">
                        {canBossRemove(f) ? (
                          <button
                            className="btn btn-sm d-inline-flex align-items-center gap-1"
                            style={{
                              background: 'var(--surface-1)', border: '1px solid color-mix(in srgb, var(--danger) 35%, transparent)', color: 'var(--danger)',
                              borderRadius: 6, fontSize: '0.7rem', padding: '3px 10px',
                            }}
                            disabled={isBusy}
                            onClick={() => handleBossRemove(f)}>
                            <i className="bi bi-trash" /> {isBusy ? 'Removing…' : 'Remove flag'}
                          </button>
                        ) : (
                          <button
                            className="btn btn-sm d-inline-flex align-items-center gap-1"
                            style={{
                              background: 'var(--surface-1)', border: '1px solid color-mix(in srgb, var(--info) 35%, transparent)', color: 'var(--info)',
                              borderRadius: 6, fontSize: '0.7rem', padding: '3px 10px',
                            }}
                            disabled={isBusy}
                            onClick={() => handleRequestRemoval(f)}>
                            <i className="bi bi-send" /> {isBusy ? 'Sending…' : 'Request removal'}
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
          {canManage && (
            <div className="d-flex gap-2">
              <button className="btn btn-sm flex-grow-1" style={{ background: 'var(--success-soft)', color: 'var(--success)', border: '1.5px solid color-mix(in srgb, var(--success) 35%, transparent)', borderRadius: 8, fontSize: '0.75rem' }}
                onClick={() => onAddFlag('green')}><i className="bi bi-plus-lg me-1" />Green Flag</button>
              <button className="btn btn-sm flex-grow-1" style={{ background: 'var(--danger-soft)', color: 'var(--danger)', border: '1.5px solid color-mix(in srgb, var(--danger) 35%, transparent)', borderRadius: 8, fontSize: '0.75rem' }}
                onClick={() => onAddFlag('red')}><i className="bi bi-plus-lg me-1" />Red Flag</button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Pending Flag-Removal Requests panel (Boss only) ──────────────────────────
// Renders the OL-submitted flag-removal requests that Boss has yet to decide.
// Each row: requester, flagged user, reason, original flag context, and
// Approve / Reject buttons (with note). Approve hard-deletes the flag and
// recalculates that month's score automatically (handled server-side).

function FlagRemovalRequestsPanel({ requests, onChanged }) {
  const [busy, setBusy] = useState({}); // requestId → bool

  async function handleDecide(req, action) {
    let note = null;
    if (action === 'reject') {
      note = window.prompt(
        'Optional note for the OL on why you rejected this:',
        ''
      );
      if (note === null) return; // cancelled
    }
    if (!window.confirm(
      action === 'approve'
        ? 'Approve removal? The flag will be deleted and the month\'s score will recalculate. The OL and the flagged user will be notified.'
        : 'Reject this removal request? The flag stays in place. The OL will be notified.'
    )) return;
    setBusy((b) => ({ ...b, [req.id]: true }));
    try {
      await decideFlagRemoval(req.id, action, note);
      onChanged?.();
    } catch (err) {
      alert('Failed to decide request: ' + (err.message || 'unknown error'));
    } finally {
      setBusy((b) => ({ ...b, [req.id]: false }));
    }
  }

  return (
    <div className="rounded-3 p-3 mb-3" style={{ background: 'var(--warning-soft)', border: '1px solid color-mix(in srgb, var(--warning) 35%, transparent)' }}>
      <div className="d-flex align-items-center gap-2 mb-2">
        <i className="bi bi-hourglass-split" style={{ color: 'var(--warning)' }} />
        <h6 className="fw-bold mb-0" style={{ fontSize: '0.88rem', color: 'var(--warning)' }}>
          Pending flag-removal requests ({requests.length})
        </h6>
      </div>
      <div className="d-flex flex-column gap-2">
        {requests.map((r) => {
          const isBusy = !!busy[r.id];
          const flagDate = r.flag?.created_at ? new Date(r.flag.created_at) : null;
          const monthLabel = flagDate && !isNaN(flagDate.getTime())
            ? flagDate.toLocaleString(undefined, { year: 'numeric', month: 'long' })
            : null;
          return (
            <div key={r.id} className="rounded-3 p-3" style={{ background: 'var(--surface-1)', border: '1px solid color-mix(in srgb, var(--warning) 35%, transparent)' }}>
              <div className="d-flex flex-wrap align-items-start justify-content-between gap-2 mb-2">
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div className="small fw-semibold" style={{ color: 'var(--text-primary)' }}>
                    {r.requester?.display_name || 'OL'} requested removal of a flag on{' '}
                    <span style={{ color: 'var(--warning)' }}>{r.user?.display_name || 'a teammate'}</span>
                  </div>
                  <div className="text-muted" style={{ fontSize: '0.7rem', marginTop: 2 }}>
                    {r.flag?.type === 'green' ? 'Green flag' : 'Red flag'}
                    {r.flag?.severity && <> · {r.flag.severity}</>}
                    {monthLabel && <> · affects {monthLabel} score</>}
                  </div>
                </div>
                <div className="d-flex gap-1 flex-shrink-0">
                  <button
                    className="btn btn-sm d-inline-flex align-items-center gap-1"
                    style={{ background: 'var(--success-soft)', color: 'var(--success)', border: '1px solid color-mix(in srgb, var(--success) 35%, transparent)', borderRadius: 6, fontSize: '0.72rem' }}
                    disabled={isBusy}
                    onClick={() => handleDecide(r, 'approve')}>
                    <i className="bi bi-check-lg" /> Approve
                  </button>
                  <button
                    className="btn btn-sm d-inline-flex align-items-center gap-1"
                    style={{ background: 'var(--danger-soft)', color: 'var(--danger)', border: '1px solid color-mix(in srgb, var(--danger) 35%, transparent)', borderRadius: 6, fontSize: '0.72rem' }}
                    disabled={isBusy}
                    onClick={() => handleDecide(r, 'reject')}>
                    <i className="bi bi-x-lg" /> Reject
                  </button>
                </div>
              </div>
              {/* OL's reason */}
              <div className="rounded-2 p-2" style={{ background: 'var(--surface-0)', border: '1px solid var(--border-subtle)', fontSize: '0.74rem' }}>
                <div className="text-muted mb-1" style={{ fontSize: '0.62rem', fontWeight: 600, textTransform: 'uppercase', letterSpacing: 0.4 }}>
                  Reason
                </div>
                <div style={{ color: 'var(--text-primary)', whiteSpace: 'pre-wrap' }}>{r.reason}</div>
              </div>
              {/* Original flag's reason for context */}
              {r.flag?.reason && (
                <div className="rounded-2 p-2 mt-2" style={{ background: 'var(--danger-soft)', border: '1px solid color-mix(in srgb, var(--danger) 35%, transparent)', fontSize: '0.72rem' }}>
                  <div className="text-muted mb-1" style={{ fontSize: '0.62rem', fontWeight: 600, textTransform: 'uppercase', letterSpacing: 0.4 }}>
                    Original flag
                  </div>
                  <div style={{ color: 'var(--danger)', whiteSpace: 'pre-wrap' }}>{r.flag.reason}</div>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── Weights Config Modal (Boss only) ─────────────────────────────────────────

function WeightsModal({ weights, onClose, onSaved }) {
  const [w, setW] = useState({ ...weights });
  const [saving, setSaving] = useState(false);
  const total = Object.values(w).reduce((a, b) => a + (Number(b) || 0), 0);

  async function handleSave() {
    if (total !== 100) return;
    setSaving(true);
    try {
      const nums = {};
      Object.keys(w).forEach(k => { nums[k] = Number(w[k]) || 0; });
      await saveV1Weights(nums);
      onSaved({ weights: nums });
    } finally { setSaving(false); }
  }

  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 1070, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
      <div style={{ position: 'absolute', inset: 0, background: 'rgba(0,0,0,0.5)', backdropFilter: 'blur(2px)' }} onClick={onClose} />
      <div className="card border-0 shadow-lg" style={{ position: 'relative', width: '100%', maxWidth: 420, zIndex: 1, borderRadius: 14 }}>
        <div className="card-body p-4">
          <h6 className="fw-bold mb-3"><i className="bi bi-gear me-2" />Configure Performance</h6>

          {/* Auto-attendance note */}
          <div className="rounded-3 p-3 mb-3" style={{ background: 'var(--info-soft)', border: '1px solid color-mix(in srgb, var(--info) 35%, transparent)' }}>
            <div className="d-flex align-items-center gap-2 mb-1">
              <i className="bi bi-calendar-check" style={{ color: 'var(--info)', fontSize: '0.9rem' }} />
              <span className="small fw-bold" style={{ color: 'var(--info)' }}>Attendance score is now automatic</span>
            </div>
            <p className="text-muted mb-0" style={{ fontSize: '0.72rem' }}>
              Calculated as effective days (clock-ins + manager-adjusted days) divided by the working days
              (Mon–Fri) of the selected month. Per-user fixes happen on the Roster tab in Attendance.
            </p>
          </div>

          {/* Pillar weights */}
          <p className="text-muted small mb-2 fw-semibold">Pillar Weightages (must total 100%)</p>
          <div className="d-flex flex-column gap-3 mb-3">
            {PILLARS.map(p => (
              <div key={p.key} className="d-flex align-items-center gap-2">
                <i className={`bi ${p.icon}`} style={{ color: p.color, fontSize: '0.9rem', width: 20 }} />
                <span className="small fw-medium flex-grow-1">{p.label}</span>
                <div className="input-group input-group-sm" style={{ width: 100 }}>
                  <input type="number" className="form-control" min="0" max="100" value={w[p.key] ?? ''}
                    onChange={e => setW(prev => ({ ...prev, [p.key]: e.target.value }))} />
                  <span className="input-group-text">%</span>
                </div>
              </div>
            ))}
          </div>
          <div className={`rounded-2 p-2 text-center small fw-bold mb-3 ${total === 100 ? 'text-success' : 'text-danger'}`}
            style={{ background: total === 100 ? 'var(--success-soft)' : 'var(--danger-soft)', borderRadius: 8 }}>
            Total: {total}% {total === 100 ? '✓' : `(must be 100%)`}
          </div>
          <div className="d-flex gap-2 justify-content-end">
            <button className="btn btn-sm btn-outline-secondary px-3" onClick={onClose}>Cancel</button>
            <button className="btn btn-sm btn-dark px-3" onClick={handleSave} disabled={saving || total !== 100}>
              {saving ? 'Saving…' : 'Save'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Warn Modal ───────────────────────────────────────────────────────────────

function WarnModal({ user, warningCount, onClose, onSaved }) {
  const [reason, setReason] = useState('');
  const [saving, setSaving] = useState(false);

  async function handleWarn() {
    if (!reason.trim()) return;
    setSaving(true);
    try {
      await saveWarning({ userId: user.id, reason: reason.trim() });
      onSaved();
    } finally { setSaving(false); }
  }

  const next = warningCount + 1;
  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 1080, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
      <div style={{ position: 'absolute', inset: 0, background: 'rgba(0,0,0,0.5)', backdropFilter: 'blur(2px)' }} onClick={onClose} />
      <div className="card border-0 shadow-lg" style={{ position: 'relative', width: '100%', maxWidth: 440, zIndex: 1, borderRadius: 14 }}>
        <div className="card-body p-4">
          <div className="d-flex align-items-start gap-3 mb-3">
            <div className="rounded-2 d-flex align-items-center justify-content-center flex-shrink-0" style={{ width: 40, height: 40, background: 'var(--danger-soft)' }}>
              <i className="bi bi-exclamation-triangle-fill" style={{ color: 'var(--danger)', fontSize: '1rem' }} />
            </div>
            <div>
              <h6 className="fw-bold mb-0">Issue Warning #{next}</h6>
              <p className="text-muted small mb-0">{user.displayName || user.userName}</p>
            </div>
          </div>
          {next >= 3 && (
            <div className="alert py-2 small mb-3" style={{ background: 'var(--danger-soft)', border: '1px solid color-mix(in srgb, var(--danger) 35%, transparent)', borderRadius: 8, color: 'var(--danger)' }}>
              <i className="bi bi-exclamation-octagon-fill me-1" />Warning #{next} — 3 warnings may lead to termination.
            </div>
          )}
          <div className="mb-3">
            <label className="form-label small fw-semibold mb-1">Reason</label>
            <textarea className="form-control form-control-sm" rows={3} placeholder="Describe the reason…"
              value={reason} onChange={e => setReason(e.target.value)} />
          </div>
          <div className="d-flex gap-2 justify-content-end">
            <button className="btn btn-sm btn-outline-secondary px-3" onClick={onClose} disabled={saving}>Cancel</button>
            <button className="btn btn-sm px-3" style={{ background: 'var(--danger)', color: '#fff', border: 'none', borderRadius: 8 }}
              onClick={handleWarn} disabled={saving || !reason.trim()}>
              {saving ? 'Issuing…' : 'Issue Warning'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Pillar Bar ───────────────────────────────────────────────────────────────

function PillarBar({ pillar, score, weight, detail }) {
  const level = score !== null ? getLevel(score) : null;
  const [open, setOpen] = useState(false);
  const hasDetail = !!detail;
  return (
    <div className="rounded-3" style={{ background: 'var(--surface-1)', border: '1px solid var(--border-subtle)', overflow: 'hidden' }}>
      <button
        type="button"
        onClick={() => hasDetail && setOpen((v) => !v)}
        className="w-100 text-start p-3"
        style={{
          background: 'transparent', border: 'none',
          cursor: hasDetail ? 'pointer' : 'default',
        }}
      >
        <div className="d-flex align-items-center justify-content-between mb-2">
          <div className="d-flex align-items-center gap-2">
            <i className={`bi ${pillar.icon}`} style={{ color: pillar.color, fontSize: '0.9rem' }} />
            <span className="small fw-semibold">{pillar.label}</span>
            <span className="text-muted" style={{ fontSize: '0.6rem' }}>({weight}%)</span>
          </div>
          <div className="d-flex align-items-center gap-2">
            {score !== null ? (
              <span className="fw-bold small" style={{ color: level.color }}>{score}/100</span>
            ) : (
              <span className="text-muted" style={{ fontSize: '0.7rem' }}>N/A</span>
            )}
            {hasDetail && (
              <i
                className={`bi ${open ? 'bi-chevron-up' : 'bi-chevron-down'} text-muted`}
                style={{ fontSize: '0.75rem' }}
              />
            )}
          </div>
        </div>
        <div className="rounded-pill overflow-hidden" style={{ height: 6, background: 'var(--surface-2)' }}>
          <div className="h-100 rounded-pill" style={{ width: `${score || 0}%`, background: level?.color || 'var(--border-default)', transition: 'width 0.4s' }} />
        </div>
      </button>
      {hasDetail && open && (
        <div className="px-3 pb-3" style={{ borderTop: '1px solid var(--border-subtle)' }}>
          <div className="pt-3">{detail}</div>
        </div>
      )}
    </div>
  );
}

// Renders the per-pillar drill-down on My Performance. Aggregates +
// key events only — no raw dumps. Each block knows how to handle
// missing data ("Not rated yet", "No incentives", etc.).
function PillarDetail({ pillarKey, ctx }) {
  const { myRecord, myIncRecord, myAttendanceDays, myFlags, month, effectiveRole, tlLive, myTlPreview } = ctx;

  if (pillarKey === 'performance') {
    // Team Leads under the live method: the pillar is auto-derived (team + reporting),
    // not the old 5-metric OL rating — show that instead of the metric sliders.
    if (effectiveRole === 'tl' && tlLive) {
      const p = myTlPreview;
      if (!p || p.blended == null) {
        return (
          <div className="text-muted small">
            Auto-derived from your team’s composites and your reporting — it appears once your
            APCs are rated and reports are verified.
          </div>
        );
      }
      return (
        <div className="d-flex flex-column gap-1" style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>
          <div className="text-muted" style={{ fontSize: '0.68rem' }}>Auto-derived: 0.6 × team score + 0.4 × reporting.</div>
          <div className="d-flex justify-content-between"><span>Team score (avg of your APCs)</span><strong>{p.team == null ? '—' : Math.round(p.team)}/100</strong></div>
          <div className="d-flex justify-content-between"><span>Reporting ({p.n || 0} verified · {Number(p.deductions || 0)} docked)</span><strong>{p.reporting == null ? '—' : Math.round(p.reporting)}/100</strong></div>
          <div className="d-flex justify-content-between pt-1" style={{ borderTop: '1px dashed var(--border-subtle)' }}><span className="fw-semibold">Performance pillar</span><strong>{p.blended}/100</strong></div>
        </div>
      );
    }
    const metrics = myRecord?.metrics || null;
    if (!metrics) {
      return (
        <div className="text-muted small">
          Not rated yet for {getMonthLabel(month)}. Your TL or OL will rate
          you on the metrics below at the end of the month.
        </div>
      );
    }
    return (
      <div className="d-flex flex-column gap-2">
        <div className="text-muted" style={{ fontSize: '0.68rem' }}>
          Each metric is rated 0–100. The pillar score is the average.
          {myRecord?.evaluatedByName && <> Rated by <strong>{myRecord.evaluatedByName}</strong>.</>}
        </div>
        {METRICS.map((m) => {
          const v = Number(metrics[m.key]) || 0;
          const lvl = getLevel(v);
          return (
            <div key={m.key} className="d-flex align-items-center gap-2"
              style={{ fontSize: '0.75rem' }}>
              <i className={`bi ${m.icon}`} style={{ color: 'var(--text-muted)', fontSize: '0.78rem', flex: '0 0 14px' }} />
              <span style={{ flex: 1, color: 'var(--text-secondary)', display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                {m.label}
                <MetricInfoTip text={m.description} />
              </span>
              <div className="rounded-pill" style={{ flex: '0 0 90px', height: 5, background: 'var(--surface-2)', overflow: 'hidden' }}>
                <div className="h-100 rounded-pill" style={{ width: `${v}%`, background: lvl.color }} />
              </div>
              <span className="fw-semibold" style={{ flex: '0 0 38px', textAlign: 'right', color: lvl.color }}>
                {v}/100
              </span>
            </div>
          );
        })}
      </div>
    );
  }

  if (pillarKey === 'incentives') {
    const items = [
      ...(myIncRecord?.incentives || []).map((x) => ({ ...x, _kind: 'incentive' })),
      ...(myIncRecord?.bonuses    || []).map((x) => ({ ...x, _kind: 'bonus' })),
    ];
    if (items.length === 0) {
      return (
        <div className="text-muted small">
          No incentives or bonuses set for {getMonthLabel(month)} yet.
        </div>
      );
    }
    const completedCount = items.filter((i) => i.completed).length;
    return (
      <div className="d-flex flex-column gap-2">
        <div className="text-muted" style={{ fontSize: '0.68rem' }}>
          Score = completed / total items, expressed as a percentage.
          Currently <strong>{completedCount}</strong> of <strong>{items.length}</strong> completed.
        </div>
        {items.map((it, i) => (
          <div key={i} className="d-flex align-items-start gap-2 rounded-2 p-2"
            style={{
              background: it.completed ? 'var(--success-soft)' : 'var(--surface-0)',
              border: `1px solid ${it.completed ? 'color-mix(in srgb, var(--success) 35%, transparent)' : 'var(--border-subtle)'}`,
              fontSize: '0.74rem',
            }}>
            <i className={`bi ${it.completed ? 'bi-check-circle-fill text-success' : 'bi-circle text-muted'}`}
              style={{ fontSize: '0.8rem', marginTop: 2 }} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div className="fw-semibold" style={{ color: 'var(--text-primary)' }}>
                {it.text || (it._kind === 'bonus' ? 'Bonus' : 'Incentive')}
                <span className="text-muted ms-1" style={{ fontSize: '0.6rem', fontWeight: 500 }}>
                  · {it._kind}
                </span>
              </div>
              <div className="d-flex flex-wrap align-items-center gap-2 text-muted"
                style={{ fontSize: '0.68rem', marginTop: 2 }}>
                {it.amount != null && it.amount !== '' && (
                  <span>{Number(it.amount).toLocaleString('en-US')} PKR</span>
                )}
                {(Number(it.targetValue) > 0 || Number(it.achievedValue) > 0) && (
                  <span>
                    Achieved{' '}
                    <strong style={{ color: 'var(--text-secondary)' }}>
                      {Number(it.achievedValue || 0).toLocaleString('en-US')}{itemSuffix(it)}
                    </strong>
                    {' / '}
                    <strong style={{ color: 'var(--text-secondary)' }}>
                      {Number(it.targetValue || 0).toLocaleString('en-US')}{itemSuffix(it)}
                    </strong>
                  </span>
                )}
              </div>
            </div>
          </div>
        ))}
      </div>
    );
  }

  if (pillarKey === 'attendance') {
    const b = myAttendanceDays;
    if (!b) {
      return <div className="text-muted small">Attendance data unavailable.</div>;
    }
    const effective   = b.daysPresent;
    const leaveDays   = b.approvedLeaveDays;
    const holidayDays = b.holidayDays;
    const weekendDays = b.weekendDays;
    // coveredDays is the SQL set-union (clock-ins ∪ adjustments ∪ leave ∪
    // holidays ∪ weekends) — an overlap is counted once, so the score can
    // never be padded beyond reality.
    const covered     = b.coveredDays;
    const wd          = b.daysThisMonth;
    const missed      = b.daysNotCovered;
    return (
      <div className="d-flex flex-column gap-2" style={{ fontSize: '0.75rem' }}>
        <div className="text-muted" style={{ fontSize: '0.68rem' }}>
          Score = covered days / total days in the month. Weekends,
          company holidays and any approved leave (medical, emergency,
          half-day, other) are auto-credited &mdash; only weekdays
          you were expected to work but didn&apos;t clock in count
          against the score. WFH days are treated as present.
        </div>
        <div className="d-flex justify-content-between rounded-2 p-2"
          style={{ background: 'var(--warning-soft)', border: '1px solid color-mix(in srgb, var(--warning) 35%, transparent)' }}>
          <span>Days this month</span>
          <strong>{wd}</strong>
        </div>
        <div className="d-flex justify-content-between rounded-2 p-2"
          style={{ background: 'var(--success-soft)', border: '1px solid color-mix(in srgb, var(--success) 35%, transparent)' }}>
          <span>Days present (real clock-ins + adjustments)</span>
          <strong>{effective}</strong>
        </div>
        <div className="d-flex justify-content-between rounded-2 p-2"
          style={{ background: 'var(--surface-0)', border: '1px solid var(--border-default)' }}>
          <span>Weekends</span>
          <strong>{weekendDays}</strong>
        </div>
        <div className="d-flex justify-content-between rounded-2 p-2"
          style={{ background: 'var(--info-soft)', border: '1px solid color-mix(in srgb, var(--info) 35%, transparent)' }}>
          <span>Approved leave days</span>
          <strong>{leaveDays}</strong>
        </div>
        {holidayDays > 0 && (
          <div className="d-flex justify-content-between rounded-2 p-2"
            style={{ background: 'var(--surface-2)', border: '1px solid var(--border-subtle)' }}>
            <span>Company holidays</span>
            <strong>{holidayDays}</strong>
          </div>
        )}
        {missed > 0 && (
          <div className="d-flex justify-content-between rounded-2 p-2"
            style={{ background: 'var(--danger-soft)', border: '1px solid color-mix(in srgb, var(--danger) 35%, transparent)' }}>
            <span>Days not covered</span>
            <strong className="text-danger">{missed}</strong>
          </div>
        )}
        <div className="d-flex justify-content-between rounded-2 p-2 fw-bold"
          style={{ background: 'var(--surface-2)', border: '1px solid var(--border-subtle)' }}>
          <span>Covered ({covered} / {wd})</span>
          <span>{wd > 0 ? `${b.pctExact}%` : '—'}</span>
        </div>
      </div>
    );
  }

  if (pillarKey === 'flags') {
    // Filter to this month only — same logic as calcFlagsScore so the
    // numbers shown match the score.
    const monthFlags = (myFlags || []).filter((f) => {
      if (!f.createdAt) return false;
      const d = f.createdAt?.toDate ? f.createdAt.toDate() : new Date(f.createdAt);
      const fm = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
      return fm === month;
    });
    const greens = monthFlags.filter((f) => f.type === 'green').length;
    const reds   = monthFlags.filter((f) => f.type === 'red').length;
    return (
      <div className="d-flex flex-column gap-2" style={{ fontSize: '0.75rem' }}>
        <div className="text-muted" style={{ fontSize: '0.68rem' }}>
          Score starts at <strong>{FLAG_BASE_SCORE}</strong>. Each green flag this
          month adds <strong>+{FLAG_GREEN_DELTA}</strong>; each red flag subtracts
          <strong> {FLAG_RED_DELTA}</strong>. Capped at 0–100. Flags from earlier
          months don't affect this score.
        </div>
        <div className="d-flex justify-content-between rounded-2 p-2"
          style={{ background: 'var(--success-soft)', border: '1px solid color-mix(in srgb, var(--success) 35%, transparent)' }}>
          <span><i className="bi bi-flag-fill me-1" style={{ color: 'var(--success)' }} />Green flags this month</span>
          <strong>{greens}</strong>
        </div>
        <div className="d-flex justify-content-between rounded-2 p-2"
          style={{ background: 'var(--danger-soft)', border: '1px solid color-mix(in srgb, var(--danger) 35%, transparent)' }}>
          <span><i className="bi bi-flag-fill me-1" style={{ color: 'var(--danger)' }} />Red flags this month</span>
          <strong>{reds}</strong>
        </div>
        {monthFlags.length === 0 && (
          <div className="text-muted small">No flags in {getMonthLabel(month)} yet.</div>
        )}
      </div>
    );
  }

  return null;
}

// ── Main Page ────────────────────────────────────────────────────────────────

export default function PerformancePage() {
  // v2 auth shape shim — v1 read { currentUser, userRole, apcProfile }.
  const { user, profile } = useAuth();
  const currentUser = user ? {
    uid: user.id,
    email: user.email,
    displayName: profile?.display_name || '',
  } : null;
  const userRole = profile?.role || '';
  // Keep PCTL distinct from TL: PCTL evaluates IPCs (canRate gates
  // pctl -> ipc), TL evaluates APCs. Conflating them broke the
  // permission check and hid every Rate / Flag button for PCTLs.
  // Developer maps to Boss (full visibility); IPC maps to APC (no
  // team tab — IPCs don't manage anyone).
  const normalisedRole = userRole === 'developer' ? 'boss' : userRole;
  const effectiveRole = ['boss','ol','tl','pctl','apc','ipc'].includes(normalisedRole)
    ? (normalisedRole === 'ipc' ? 'apc' : normalisedRole)
    : 'apc';
  const isBoss = effectiveRole === 'boss';
  const hasTeamTab = effectiveRole !== 'apc';

  const [month, setMonth]     = useState(karachiMonth());
  const [mainTab, setMainTab] = useState(hasTeamTab ? 'team' : 'my');
  const [loading, setLoading] = useState(true);
  const [weights, setWeights] = useState(DEFAULT_WEIGHTS);

  // My data
  const [myRecord, setMyRecord]       = useState(null);
  const [myFlags, setMyFlags]         = useState([]);
  const [myWarnings, setMyWarnings]   = useState(0);
  // AttendanceBreakdown | null. null = not loaded / not available — it must
  // render as '—', never as a zeroed (and therefore terrible-looking) score.
  const [myAttendanceDays, setMyAttendanceDays] = useState(null);
  // A FAILED attendance fetch is not the same as "no data". calcComposite
  // re-normalises the weights over the non-null pillars, so a swallowed error
  // would silently drop the attendance pillar and still render a confident
  // (wrong) composite. When this is set we refuse to show a composite at all.
  const [attError, setAttError] = useState('');
  const [attReloadKey, setAttReloadKey] = useState(0);
  const [myIncRecord, setMyIncRecord] = useState(null);
  // myLeaveCount removed — now using myAttendanceDays from attendance collection

  // Team data
  const [teamUsers, setTeamUsers]         = useState([]);
  const [teamRecords, setTeamRecords]     = useState({});
  const [teamFlags, setTeamFlags]         = useState({});
  const [teamWarnings, setTeamWarnings]   = useState({});
  const [teamIncentives, setTeamIncentives] = useState({});
  const [teamLeaves, setTeamLeaves]       = useState({});
  const [teamAttendance, setTeamAttendance] = useState({}); // { userId: daysPresent }
  const [teamSubTab, setTeamSubTab]       = useState(isBoss ? 'ols' : effectiveRole === 'ol' ? 'tls' : 'apcs');

  // Pending flag-removal requests, keyed by flag id — used by the
  // ViewFlagsModal to render the 'Removal pending Boss approval'
  // state inline. Loaded lazily (RLS scopes rows to involved users).
  const [pendingRemovals, setPendingRemovals] = useState({});
  // All pending removal requests Boss has yet to decide. Drives the
  // "Pending flag removal requests" panel on the Team tab.
  const [pendingRemovalRequests, setPendingRemovalRequests] = useState([]);

  // Filters
  const [search, setSearch]         = useState('');
  const [levelFilter, setLevelFilter] = useState('all');

  // Modals
  const [rateTarget, setRateTarget]       = useState(null);
  const [flagsTarget, setFlagsTarget]     = useState(null);
  const [addFlagTarget, setAddFlagTarget] = useState(null);
  const [warnTarget, setWarnTarget]       = useState(null);
  const [showWeights, setShowWeights]     = useState(false);
  // Weekly APC ratings (mig 269): the breakdown/late-rating modal target, the
  // Boss trial⇄live switch, and the OL "pending ratings" (2-day) list.
  const [weeklyTarget, setWeeklyTarget]   = useState(null);
  const [weeklyInitMeeting, setWeeklyInitMeeting] = useState(null);
  const [weeklyCfg, setWeeklyCfg]         = useState({ enabled: false, since: null });
  const [pendingRatings, setPendingRatings] = useState([]);
  const [switchBusy, setSwitchBusy]       = useState(false);

  useEffect(() => {
    let cancelled = false;
    getWeeklyRatingsEnabled().then((s) => { if (!cancelled) setWeeklyCfg(s); }).catch(() => {});
    return () => { cancelled = true; };
  }, []);
  useEffect(() => {
    if (!(isBoss || effectiveRole === 'ol')) { setPendingRatings([]); return undefined; }
    let cancelled = false;
    listPendingApcRatings(month)
      .then((p) => { if (!cancelled) setPendingRatings(p || []); })
      .catch(() => { if (!cancelled) setPendingRatings([]); });
    return () => { cancelled = true; };
  }, [month, isBoss, effectiveRole, weeklyCfg.enabled]);

  // Team-Lead performance method (migs 271/272): the switch, per-TL reporting
  // scores (boss/ol), the breakdown-modal target, and the viewer's own preview.
  const [tlCfg, setTlCfg]             = useState({ enabled: false, since: null });
  const [tlReporting, setTlReporting] = useState({});
  const [tlTarget, setTlTarget]       = useState(null);
  const [tlSwitchBusy, setTlSwitchBusy] = useState(false);
  const [myTlPreview, setMyTlPreview] = useState(null);

  useEffect(() => {
    let cancelled = false;
    getTlPerfEnabled().then((s) => { if (!cancelled) setTlCfg(s); }).catch(() => {});
    return () => { cancelled = true; };
  }, []);
  useEffect(() => {
    if (!(isBoss || effectiveRole === 'ol')) { setTlReporting({}); return undefined; }
    let cancelled = false;
    listTlReporting(month).then((m) => { if (!cancelled) setTlReporting(m || {}); }).catch(() => { if (!cancelled) setTlReporting({}); });
    return () => { cancelled = true; };
  }, [month, isBoss, effectiveRole]);
  useEffect(() => {
    if (effectiveRole !== 'tl' || !currentUser?.uid) { setMyTlPreview(null); return undefined; }
    let cancelled = false;
    tlPerfPreview(currentUser.uid, month).then((p) => { if (!cancelled) setMyTlPreview(p); }).catch(() => {});
    return () => { cancelled = true; };
  }, [effectiveRole, month]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Load ──
  useEffect(() => {
    // Stale-response guard: on a flaky connection a month switch can let the
    // PREVIOUS month's slower response land last and overwrite the new month's
    // attendance — the header would say June while the pillar showed July.
    let cancelled = false;
    async function load() {
      if (!currentUser) return;
      setLoading(true);
      setAttError('');

      // Pillar weights (Boss-editable). v2 stores per-pillar columns
      // and getV1Weights converts to the v1 {performance,...} shape.
      try {
        const w = await getV1Weights();
        if (cancelled) return;
        setWeights(w);
      } catch { /* keep defaults */ }

      // My performance (non-boss).
      if (effectiveRole !== 'boss') {
        const [myRec, myFlagsList, myWarnCount] = await Promise.all([
          getRatingFor(currentUser.uid, month),
          listFlagsForUser(currentUser.uid),
          countWarningsForUser(currentUser.uid),
        ]);
        if (cancelled) return;
        setMyRecord(myRec);
        setMyFlags(myFlagsList);
        setMyWarnings(myWarnCount);

        // My incentives for the month — server filters by user.
        const myIncRows = (await listAllIncentivesForMonth(month))
          .filter((r) => r.userId === currentUser.uid);
        if (cancelled) return;
        setMyIncRecord(myIncRows[0] || null);

        // My attendance for the month — one SQL RPC, the single source of
        // truth shared with the Roster tab and the incentive auto-fill.
        let myAtt = null;
        try {
          myAtt = await fetchAttendanceBreakdown(currentUser.uid, month);
        } catch (err) {
          console.warn('[attendance-breakdown]', err);
          if (!cancelled) setAttError(err?.message || 'Attendance coverage failed to load.');
        }
        if (cancelled) return;
        setMyAttendanceDays(myAtt);
      }

      // Team data.
      if (hasTeamTab) {
        const users = await listEvaluableUsers({
          uid: currentUser.uid, viewerRole: effectiveRole,
        });
        if (cancelled) return;
        setTeamUsers(users);
        const userIds = users.map((u) => u.id);
        const idSet = new Set(userIds);

        // 5 parallel reads — performance / flags / warnings / incentives /
        // attendance. Attendance is ONE batch RPC for the whole team (never
        // one call per employee — most users are on flaky Pakistan ISPs).
        const [perfList, flagList, warnList, incList, attByUser] =
          await Promise.all([
            listAllRatingsForMonth(month),
            listAllFlags(),
            listAllWarnings(),
            listAllIncentivesForMonth(month),
            fetchAttendanceBreakdownBulk(month, userIds).catch((err) => {
              console.warn('[attendance-breakdown]', err);
              // Do NOT let this degrade quietly into "every pillar is null":
              // the banner + composite suppression below depend on attError.
              if (!cancelled) setAttError(err?.message || 'Attendance coverage failed to load.');
              return new Map();
            }),
          ]);
        if (cancelled) return;

        const recMap = {}, flagMap = {}, warnMap = {}, incMap = {}, attMap = {};
        perfList.forEach((x) => { if (idSet.has(x.userId)) recMap[x.userId] = x; });
        flagList.forEach((x) => {
          if (!idSet.has(x.userId)) return;
          if (!flagMap[x.userId]) flagMap[x.userId] = [];
          flagMap[x.userId].push(x);
        });
        warnList.forEach((x) => { if (idSet.has(x.userId)) warnMap[x.userId] = (warnMap[x.userId] || 0) + 1; });
        incList.forEach((x) => { const uid = x.userId; if (uid && idSet.has(uid)) incMap[uid] = x; });

        // A Map miss is NOT a zero — it stays null so the card renders '—'
        // rather than a fabricated (and healthy-looking) score.
        userIds.forEach((uid) => { attMap[uid] = attByUser.get(uid) ?? null; });

        setTeamRecords(recMap);
        setTeamFlags(flagMap);
        setTeamWarnings(warnMap);
        setTeamIncentives(incMap);
        setTeamLeaves({});
        setTeamAttendance(attMap);
      }

      // Load pending flag-removal requests. RLS limits visibility to:
      // - the OL who requested (sees their own)
      // - the flagged user (sees pending state on their flag)
      // - Boss (sees everything in their approval queue)
      try {
        const pendingList = await listFlagRemovalRequests({ status: 'pending' });
        if (cancelled) return;
        const map = {};
        pendingList.forEach((p) => { map[p.flagId] = p; });
        setPendingRemovals(map);
        setPendingRemovalRequests(pendingList);
      } catch {
        // RLS may reject for users not involved in any request — that
        // just means no pending state to show. Silent fallback.
        if (cancelled) return;
        setPendingRemovals({});
        setPendingRemovalRequests([]);
      }

      if (!cancelled) setLoading(false);
    }
    load();
    return () => { cancelled = true; };
  // Include effectiveRole — on first render the profile may not be
  // loaded yet, so userRole='' and effectiveRole defaults to 'apc'.
  // Once the profile resolves and effectiveRole becomes 'ol'/'boss'/
  // 'tl', we MUST re-run the load to fetch team data. Without this,
  // the OL hits the page, the load runs with hasTeamTab=false, then
  // never re-fires — Team tab shows empty until a hard refresh.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [month, currentUser?.uid, effectiveRole, attReloadKey]);

  // Re-fetch flags + pending removals after a mutation (Boss direct
  // remove, OL request, Boss approve/reject). Keeps the modal + main
  // page in sync without reloading the entire performance dataset.
  async function refreshFlagState() {
    try {
      // My flags
      if (effectiveRole !== 'boss') {
        const myList = await listFlagsForUser(currentUser.uid);
        setMyFlags(myList);
      }
      // Team flags
      if (hasTeamTab) {
        const flagList = await listAllFlags();
        const idSet = new Set(teamUsers.map((u) => u.id));
        const flagMap = {};
        flagList.forEach((x) => {
          if (!idSet.has(x.userId)) return;
          if (!flagMap[x.userId]) flagMap[x.userId] = [];
          flagMap[x.userId].push(x);
        });
        setTeamFlags(flagMap);
      }
      // Pending removals
      const pendingList = await listFlagRemovalRequests({ status: 'pending' });
      const map = {};
      pendingList.forEach((p) => { map[p.flagId] = p; });
      setPendingRemovals(map);
      setPendingRemovalRequests(pendingList);
    } catch (err) {
      console.warn('[flag-refresh]', err);
    }
  }

  // ── Build user rows with pillar scores ──
  const teamSubTabs = useMemo(() => {
    const t = [];
    if (isBoss) t.push({ key: 'ols', label: 'Operation Leads', icon: 'bi-person-workspace' });
    if (isBoss || effectiveRole === 'ol') t.push({ key: 'tls', label: 'Team Leads', icon: 'bi-person-badge' });
    if (isBoss || effectiveRole === 'ol' || effectiveRole === 'tl') t.push({ key: 'apcs', label: 'APCs', icon: 'bi-person-lines-fill' });
    // PCTL's team is their IPCs (listEvaluableUsers tags them with
    // _tab='apcs', so we reuse that key and just relabel the tab).
    if (effectiveRole === 'pctl') t.push({ key: 'apcs', label: 'IPCs', icon: 'bi-person-lines-fill' });
    return t;
  }, [isBoss, effectiveRole]);

  // TL method is "live" for the selected month once the Boss switch is ON and the
  // month is >= the launch floor (mirrors the SQL gate in get_performance_composite).
  const tlSince = tlCfg.since ? String(tlCfg.since).slice(0, 7) : '2026-08';
  const tlLive = tlCfg.enabled && month >= tlSince;

  // Effective composite for EVERY loaded user (null when not-rated / pending /
  // attendance-failed) — the APC composites a TL's team score averages. Mirrors
  // get_performance_composite's composite_score domain.
  const baseCompositeById = useMemo(() => {
    const m = {};
    for (const u of teamUsers) {
      const rec = teamRecords[u.id];
      const perfScore = rec ? calcMetricsAvg(rec.metrics) : null;
      if (perfScore === null || attError || isIncPending(teamIncentives[u.id])) { m[u.id] = null; continue; }
      const incScore = calcIncentiveScore(teamIncentives[u.id]);
      const attScore = attendanceScoreFrom(teamAttendance[u.id] || null);
      const flagScore = calcFlagsScore(teamFlags[u.id] || [], month);
      m[u.id] = calcComposite({ performance: perfScore, incentives: incScore, attendance: attScore, flags: flagScore }, weights);
    }
    return m;
  }, [teamUsers, teamRecords, teamIncentives, teamAttendance, teamFlags, month, weights, attError]);

  // Per-TL blended pillar = round(0.6×team + 0.4×reporting). Always computed (the
  // preview); it becomes the OFFICIAL perf pillar for TL rows when tlLive.
  const tlBlendById = useMemo(() => {
    const m = {};
    if (attError) return m; // attendance failed → refuse a blend (bar shows "—", like the composite)
    for (const u of teamUsers) {
      if ((u.role || u.userRole) !== 'tl') continue;
      const comps = teamUsers
        .filter((a) => (a.role || a.userRole) === 'apc' && (a.reportsTo || a.reports_to) === u.id)
        .map((a) => baseCompositeById[a.id]).filter((v) => v != null);
      const team = comps.length ? comps.reduce((x, y) => x + y, 0) / comps.length : null;
      const repRaw = tlReporting[u.id]?.reporting_score;
      const rep = repRaw == null ? null : Number(repRaw);
      m[u.id] = (team != null && rep != null) ? Math.round(0.6 * team + 0.4 * rep)
        : team != null ? Math.round(team) : rep != null ? Math.round(rep) : null;
    }
    return m;
  }, [teamUsers, baseCompositeById, tlReporting, attError]);

  const filteredTeam = useMemo(() => {
    let list = teamUsers.filter(u => u._tab === teamSubTab).map(u => {
      const name = u.displayName || u.userName || u.email || '—';
      const isTlRow = (u.role || u.userRole) === 'tl';
      const tlBlend = isTlRow ? (tlBlendById[u.id] ?? null) : null;
      let rec = teamRecords[u.id];
      let perfScore = rec ? calcMetricsAvg(rec.metrics) : null;
      // When the TL method is live, the TL's perf pillar IS the blend (and the row
      // counts as "rated" via a synthetic rec even without an old OL rating).
      if (isTlRow && tlLive) {
        perfScore = tlBlend;
        rec = tlBlend == null ? null : (rec || { tl_derived: true });
      }
      const incScore = calcIncentiveScore(teamIncentives[u.id]);
      const attData = teamAttendance[u.id] || null;
      const wd = attData ? attData.daysThisMonth : 0;
      const attScore = attendanceScoreFrom(attData);
      const flagScore = calcFlagsScore(teamFlags[u.id] || [], month);
      const pillarScores = { performance: perfScore, incentives: incScore, attendance: attScore, flags: flagScore };
      const composite = calcComposite(pillarScores, weights);
      const incPending = isIncPending(teamIncentives[u.id]);
      const gCount = (teamFlags[u.id] || []).filter(f => f.type === 'green').length;
      const rCount = (teamFlags[u.id] || []).filter(f => f.type === 'red').length;
      const wCount = teamWarnings[u.id] || 0;
      // Check against the user's own role rather than the tab name,
      // so the "apcs" tab — which holds both APCs (TL view) and IPCs
      // (PCTL view) — gates each row by who can actually rate it.
      const canEdit = canRate(effectiveRole, u.role || u.userRole || 'apc');
      return { ...u, name, rec, perfScore, incScore, attScore, flagScore, pillarScores, composite, incPending, gCount, rCount, wCount, canEdit, attData, workingDays: wd, tlBlend, isTlRow };
    });
    if (search) { const s = search.toLowerCase(); list = list.filter(u => u.name.toLowerCase().includes(s)); }
    if (levelFilter !== 'all') {
      // Gate the level buckets on the SAME rated predicate the card uses
      // (rating row present AND attendance loaded). Without this, a never-rated
      // user — whose card says 'Not Rated Yet' — gets bucketed by a fabricated
      // composite (auto pillars, or 0 when all null → 'Termination'). no_data =
      // genuinely no rating row.
      if (levelFilter === 'no_data') list = list.filter(u => !u.rec);
      else list = list.filter(u => u.rec && !attError && !u.incPending
        && getLevel(u.composite).label.toLowerCase() === levelFilter);
    }
    return list;
  }, [teamUsers, teamRecords, teamIncentives, teamAttendance, teamFlags, teamWarnings, teamSubTab, search, levelFilter, effectiveRole, weights, month, attError, tlBlendById, tlLive]);

  // The attendance pillar failed to load → calcComposite silently re-weights
  // over the remaining pillars. Refuse to show a composite rather than show a
  // plausible-looking wrong one.
  const compositeOk = !attError;

  // My pillar scores. A TL viewing themselves under the live method sees the
  // blended pillar (team + reporting) instead of the old OL rating.
  const myPerfScore = (effectiveRole === 'tl' && tlLive)
    ? (myTlPreview?.blended ?? null)
    : (myRecord ? calcMetricsAvg(myRecord.metrics) : null);
  const myIncScore  = calcIncentiveScore(myIncRecord);
  const myIncPending = isIncPending(myIncRecord);
  const myAttScore  = attendanceScoreFrom(myAttendanceDays);
  const myFlagScore = calcFlagsScore(myFlags, month);
  const myPillarScores = { performance: myPerfScore, incentives: myIncScore, attendance: myAttScore, flags: myFlagScore };
  const myComposite = calcComposite(myPillarScores, weights);
  const myLevel = getLevel(myComposite);

  // Stats
  const tabUsers = teamUsers.filter(u => u._tab === teamSubTab);
  const rated = tabUsers.filter(u => teamRecords[u.id]).length;

  // ── Callbacks ──
  function handleRateSaved(payload) {
    setTeamRecords(prev => ({ ...prev, [payload.userId]: { ...prev[payload.userId], ...payload, id: payload.id || prev[payload.userId]?.id } }));
    setRateTarget(null);
  }
  // A weekly rating changed → refresh the APC's rolled-up monthly row (so the
  // team grid composite updates when live) and the OL pending list.
  async function handleWeeklyChanged(apcId) {
    try {
      const rec = await getRatingFor(apcId, month);
      setTeamRecords((prev) => ({ ...prev, [apcId]: rec || null }));
    } catch { /* ignore */ }
    if (isBoss || effectiveRole === 'ol') {
      try { setPendingRatings(await listPendingApcRatings(month)); } catch { /* ignore */ }
    }
  }
  async function toggleWeeklySwitch(next) {
    if (!isBoss || switchBusy) return;
    if (next && !window.confirm(
      'Go LIVE with weekly APC ratings?\n\n'
      + 'The average of each APC’s weekly scores becomes their OFFICIAL monthly performance score '
      + '(this feeds the composite used for salary). You can switch back to Trial any time.'
    )) return;
    setSwitchBusy(true);
    try {
      await setWeeklyRatingsEnabled(next);
      setWeeklyCfg((c) => ({ ...c, enabled: next }));
    } catch (e) { alert(`Couldn't change the mode: ${e?.message || e}`); } // eslint-disable-line no-alert
    finally { setSwitchBusy(false); }
  }
  async function toggleTlSwitch(next) {
    if (!isBoss || tlSwitchBusy) return;
    if (next && !window.confirm( // eslint-disable-line no-alert
      'Go LIVE with the Team-Lead performance method?\n\n'
      + 'Each TL’s performance pillar becomes 0.6 × their team’s score + 0.4 × reporting '
      + '(this feeds the composite used for salary). You can switch back to Trial any time.'
    )) return;
    setTlSwitchBusy(true);
    try {
      await setTlPerfEnabled(next);
      setTlCfg((c) => ({ ...c, enabled: next }));
    } catch (e) { alert(`Couldn't change the mode: ${e?.message || e}`); } // eslint-disable-line no-alert
    finally { setTlSwitchBusy(false); }
  }
  async function handleFlagAdded() {
    const flags = await listFlagsForUser(addFlagTarget.user.id);
    setTeamFlags((prev) => ({ ...prev, [addFlagTarget.user.id]: flags }));
    if (addFlagTarget.user.id === currentUser.uid) setMyFlags(flags);
    setAddFlagTarget(null);
  }
  async function handleWarnSaved() {
    const c = await countWarningsForUser(warnTarget.id);
    setTeamWarnings((prev) => ({ ...prev, [warnTarget.id]: c }));
    setWarnTarget(null);
  }

  // Auth not resolved yet — render nothing rather than crash.
  if (!currentUser) return null;

  return (
    <div>
      {/* Header */}
      <div className="d-flex align-items-start justify-content-between mb-4 flex-wrap gap-3">
        <div>
          <h5 className="fw-bold mb-0">Performance Review</h5>
          <p className="text-muted small mb-0">{getMonthLabel(month)}</p>
        </div>
        <div className="d-flex align-items-center gap-2">
          <input type="month" className="form-control form-control-sm" value={month}
            max={karachiMonth()}
            onChange={e => setMonth(e.target.value)} style={{ width: 160 }} />
          {isBoss && (
            <button className="btn btn-sm d-inline-flex align-items-center gap-1"
              style={{
                borderRadius: 8, fontSize: '0.74rem', fontWeight: 700,
                background: weeklyCfg.enabled ? 'var(--success-soft)' : 'var(--warning-soft)',
                color: weeklyCfg.enabled ? 'var(--success)' : 'var(--warning)',
                border: `1px solid color-mix(in srgb, ${weeklyCfg.enabled ? 'var(--success)' : 'var(--warning)'} 35%, transparent)`,
              }}
              disabled={switchBusy}
              onClick={() => toggleWeeklySwitch(!weeklyCfg.enabled)}
              title="Weekly APC ratings — Trial: collected & previewed without affecting scores. Live: the weekly average becomes the official monthly performance.">
              {switchBusy
                ? <span className="spinner-border spinner-border-sm" style={{ width: 12, height: 12 }} />
                : <i className={`bi ${weeklyCfg.enabled ? 'bi-broadcast' : 'bi-flask'}`} />}
              Weekly APC ratings: {weeklyCfg.enabled ? 'Live' : 'Trial'}
            </button>
          )}
          {isBoss && (
            <button className="btn btn-sm d-inline-flex align-items-center gap-1"
              style={{
                borderRadius: 8, fontSize: '0.74rem', fontWeight: 700,
                background: tlCfg.enabled ? 'var(--success-soft)' : 'var(--warning-soft)',
                color: tlCfg.enabled ? 'var(--success)' : 'var(--warning)',
                border: `1px solid color-mix(in srgb, ${tlCfg.enabled ? 'var(--success)' : 'var(--warning)'} 35%, transparent)`,
              }}
              disabled={tlSwitchBusy}
              onClick={() => toggleTlSwitch(!tlCfg.enabled)}
              title="Team-Lead performance — Trial: the new team+reporting blend is previewed without affecting scores. Live: the blend becomes the official TL performance pillar.">
              {tlSwitchBusy
                ? <span className="spinner-border spinner-border-sm" style={{ width: 12, height: 12 }} />
                : <i className={`bi ${tlCfg.enabled ? 'bi-broadcast' : 'bi-flask'}`} />}
              TL performance: {tlCfg.enabled ? 'Live' : 'Trial'}
            </button>
          )}
          {isBoss && (
            <button className="btn btn-sm btn-outline-secondary d-inline-flex align-items-center gap-1"
              onClick={() => setShowWeights(true)} title="Configure weightages">
              <i className="bi bi-gear" />
            </button>
          )}
        </div>
      </div>

      {/* OL / Boss: APC weekly ratings still pending from meetings 2+ days ago */}
      {(isBoss || effectiveRole === 'ol') && pendingRatings.length > 0 && (
        <div className="rounded-3 p-3 mb-3" style={{ background: 'var(--warning-soft)', border: '1px solid color-mix(in srgb, var(--warning) 30%, transparent)' }}>
          <div className="d-flex align-items-center gap-2 mb-2 flex-wrap">
            <i className="bi bi-clock-history text-warning" />
            <span className="fw-bold" style={{ fontSize: '0.84rem', color: 'var(--text-primary)' }}>
              {pendingRatings.length} weekly APC rating{pendingRatings.length === 1 ? '' : 's'} pending
            </span>
            <span className="text-muted" style={{ fontSize: '0.72rem' }}>— meetings 2+ days ago you haven’t scored yet. Click to rate.</span>
          </div>
          <div className="d-flex flex-wrap gap-2">
            {pendingRatings.slice(0, 15).map((p) => (
              <button key={`${p.meeting_id}-${p.apc_id}`} className="btn btn-sm d-inline-flex align-items-center gap-1"
                style={{ borderRadius: 999, fontSize: '0.72rem', background: 'var(--surface-1)', border: '1px solid var(--border-subtle)', color: 'var(--text-primary)' }}
                onClick={() => { setWeeklyInitMeeting(p.meeting_id); setWeeklyTarget({ id: p.apc_id, displayName: p.apc_name, reportsTo: p.tl_id, role: 'apc' }); }}>
                <i className="bi bi-person" />{p.apc_name}
                <span className="text-muted">· {new Date(p.meeting_date).toLocaleDateString()}</span>
              </button>
            ))}
            {pendingRatings.length > 15 && (
              <span className="text-muted align-self-center" style={{ fontSize: '0.72rem' }}>+{pendingRatings.length - 15} more</span>
            )}
          </div>
        </div>
      )}

      {/* Weight pills */}
      <div className="d-flex gap-2 flex-wrap mb-3">
        {PILLARS.map(p => (
          <span key={p.key} className="badge rounded-pill px-2 py-1 d-inline-flex align-items-center gap-1"
            style={{ background: `${p.color}15`, color: p.color, border: `1px solid ${p.color}30`, fontSize: '0.65rem' }}>
            <i className={`bi ${p.icon}`} style={{ fontSize: '0.7rem' }} />
            {p.label}: {weights[p.key]}%
          </span>
        ))}
      </div>

      {/* Main Tabs */}
      {hasTeamTab && (
        <div className="d-flex gap-1 mb-4" style={{ borderBottom: '2px solid var(--border-subtle)' }}>
          {[
            { key: 'team', label: 'Team Performance', icon: 'bi-people' },
            ...(effectiveRole !== 'boss' ? [{ key: 'my', label: 'My Performance', icon: 'bi-person' }] : []),
          ].map(t => (
            <button key={t.key} onClick={() => setMainTab(t.key)}
              className="btn btn-sm px-3 py-2 d-inline-flex align-items-center gap-1"
              style={{
                borderRadius: '8px 8px 0 0', fontWeight: 600, fontSize: '0.78rem',
                background: mainTab === t.key ? 'var(--accent)' : 'transparent',
                color: mainTab === t.key ? 'var(--on-accent)' : 'var(--text-secondary)',
                border: 'none', marginBottom: -2,
                borderBottom: mainTab === t.key ? '2px solid var(--accent)' : '2px solid transparent',
              }}>
              <i className={`bi ${t.icon}`} /> {t.label}
            </button>
          ))}
        </div>
      )}

      {!loading && attError && (
        <div className="rounded-3 p-3 mb-3 d-flex align-items-center justify-content-between gap-3"
          style={{ background: 'var(--danger-soft)', border: '1px solid color-mix(in srgb, var(--danger) 35%, transparent)' }}>
          <div style={{ fontSize: '0.8rem' }}>
            <span className="fw-semibold" style={{ color: 'var(--danger)' }}>
              <i className="bi bi-exclamation-triangle me-2" />Attendance coverage failed to load
            </span>
            <span className="text-muted ms-2">
              Composite scores are hidden because they would silently exclude the attendance pillar. ({attError})
            </span>
          </div>
          <button className="btn btn-sm btn-outline-danger rounded-pill px-3 flex-shrink-0"
            style={{ fontSize: '0.72rem' }}
            onClick={() => setAttReloadKey(k => k + 1)}>Retry</button>
        </div>
      )}

      {loading ? (
        <div className="text-muted small d-flex align-items-center gap-2"><span className="spinner-border spinner-border-sm" /> Loading…</div>
      ) : mainTab === 'my' ? (
        /* ═══ MY PERFORMANCE ═══ */
        <div style={{ maxWidth: 600 }}>
          {/* Composite score — "Not rated yet" when the OL/TL hasn't recorded
              a performance entry for this month. Auto-calculated pillars
              (incentives/attendance/flags) would otherwise produce a
              misleading partial composite at the start of the month. */}
          {!compositeOk || myPerfScore === null || myIncPending ? (
            <div className="card border-0 shadow-sm mb-4" style={{ borderRadius: 14, overflow: 'hidden' }}>
              <div style={{ height: 4, background: 'linear-gradient(90deg,var(--border-strong),var(--border-default))' }} />
              <div className="card-body p-4 text-center">
                <div className="d-inline-flex align-items-center justify-content-center rounded-circle mb-2"
                  style={{ width: 100, height: 100, background: 'var(--surface-2)', border: '3px solid var(--border-default)' }}>
                  <i className={`bi ${myPerfScore !== null && compositeOk && myIncPending ? 'bi-shield-check' : 'bi-hourglass-split'}`} style={{ fontSize: '1.8rem', color: 'var(--text-secondary)' }} />
                </div>
                <div className="d-flex align-items-center justify-content-center gap-1 mb-1">
                  <span className="fw-bold" style={{ color: 'var(--text-secondary)' }}>
                    {!compositeOk ? 'Score Unavailable' : myPerfScore === null ? 'Not Rated Yet' : 'Not Yet Verified by OL'}
                  </span>
                </div>
                <p className="text-muted small mb-0">
                  {!compositeOk
                    ? 'Attendance coverage failed to load — the composite would be misleading.'
                    : myPerfScore === null
                      ? `Performance is rated at the end of ${getMonthLabel(month)}`
                      : 'Your incentives must be verified by your OL before the composite score is calculated.'}
                </p>
              </div>
            </div>
          ) : (
            <div className="card border-0 shadow-sm mb-4" style={{ borderRadius: 14, overflow: 'hidden' }}>
              <div style={{ height: 4, background: `linear-gradient(90deg,${myLevel.color},color-mix(in srgb, ${myLevel.color} 53%, transparent))` }} />
              <div className="card-body p-4 text-center">
                <div className="d-inline-flex align-items-center justify-content-center rounded-circle mb-2"
                  style={{ width: 100, height: 100, background: myLevel.bg, border: `3px solid ${myLevel.color}` }}>
                  <span className="fw-bold" style={{ fontSize: '2.2rem', color: myLevel.color }}>{myComposite}</span>
                </div>
                <div className="d-flex align-items-center justify-content-center gap-1 mb-1">
                  <i className={`bi ${myLevel.icon}`} style={{ color: myLevel.color }} />
                  <span className="fw-bold" style={{ color: myLevel.color }}>{myLevel.label}</span>
                </div>
                <p className="text-muted small mb-0">Composite Score for {getMonthLabel(month)}</p>
                {myRecord?.evaluatedByName && <p className="text-muted" style={{ fontSize: '0.68rem' }}>Performance rated by {myRecord.evaluatedByName}</p>}
              </div>
            </div>
          )}

          {/* Pillar breakdown — click any pillar to expand and see how
              its score was computed. */}
          <h6 className="fw-bold mb-3" style={{ fontSize: '0.9rem' }}>
            <i className="bi bi-layers me-2" />Score Breakdown
            <span className="text-muted ms-2" style={{ fontSize: '0.65rem', fontWeight: 500 }}>
              · click a row to see the breakdown
            </span>
          </h6>
          <div className="d-flex flex-column gap-2 mb-4">
            {PILLARS.map(p => (
              <PillarBar
                key={p.key}
                pillar={p}
                score={myPillarScores[p.key]}
                weight={weights[p.key]}
                detail={
                  <PillarDetail
                    pillarKey={p.key}
                    ctx={{ myRecord, myIncRecord, myAttendanceDays, myFlags, month, effectiveRole, tlLive, myTlPreview }}
                  />
                }
              />
            ))}
          </div>

          {/* Flags summary */}
          {myFlags.length > 0 && (
            <>
              <h6 className="fw-bold mb-3" style={{ fontSize: '0.9rem' }}><i className="bi bi-flag me-2" />Flags</h6>
              {/* Scope banner — match the modal so the user understands
                  flags only affect the score of the month they were
                  created in. The flag itself stays visible in history. */}
              <div className="rounded-3 p-2 mb-3 d-flex align-items-start gap-2"
                style={{ background: 'var(--info-soft, #eff6ff)', border: '1px solid var(--info, #93c5fd)', fontSize: '0.7rem', color: 'var(--text-secondary)' }}>
                <i className="bi bi-info-circle-fill flex-shrink-0 mt-1" style={{ color: 'var(--info, #2563eb)' }} />
                <span>
                  Each flag affects the performance score of <strong>only the month it was created in</strong>.
                  The flag itself stays visible in history below.
                </span>
              </div>
              <div className="d-flex flex-column gap-2">
                {myFlags.sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0)).slice(0, 8).map(f => {
                  const w = WEIGHTAGES.find(x => x.key === f.weightage) || WEIGHTAGES[0];
                  const created = f.createdAt ? new Date(f.createdAt) : null;
                  const isValid = created && !isNaN(created.getTime());
                  const tsLabel = isValid
                    ? created.toLocaleString(undefined, {
                        year: 'numeric', month: 'short', day: 'numeric',
                        hour: 'numeric', minute: '2-digit',
                      })
                    : null;
                  const monthLabel = isValid
                    ? created.toLocaleString(undefined, { year: 'numeric', month: 'long' })
                    : null;
                  return (
                    <div key={f.id} className="rounded-3 p-3" style={{ background: f.type === 'green' ? 'var(--success-soft)' : 'var(--danger-soft)', border: `1px solid ${f.type === 'green' ? 'color-mix(in srgb, var(--success) 35%, transparent)' : 'color-mix(in srgb, var(--danger) 35%, transparent)'}` }}>
                      <div className="d-flex align-items-start justify-content-between gap-2 mb-2">
                        <span className="small fw-medium">{f.description}</span>
                        <span className="badge rounded-pill flex-shrink-0" style={{ background: w.bg, color: w.color, fontSize: '0.58rem' }}>{w.label}</span>
                      </div>
                      <div className="d-flex flex-column gap-1" style={{ fontSize: '0.68rem', color: 'var(--text-secondary)' }}>
                        <div className="d-flex align-items-center gap-1">
                          <i className="bi bi-person" style={{ opacity: 0.7 }} />
                          <span>Flagged by <strong>{f.addedByName || 'Unknown'}</strong></span>
                        </div>
                        {tsLabel && (
                          <div className="d-flex align-items-center gap-1">
                            <i className="bi bi-clock" style={{ opacity: 0.7 }} />
                            <span>{tsLabel}</span>
                          </div>
                        )}
                        {monthLabel && (
                          <div className="d-flex align-items-center gap-1">
                            <i className="bi bi-calendar3" style={{ opacity: 0.7 }} />
                            <span>Affects <strong>{monthLabel}</strong> score</span>
                          </div>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </>
          )}

          {/* Warnings */}
          {myWarnings > 0 && (
            <div className="mt-4 rounded-3 p-3" style={{ background: 'var(--danger-soft)', border: '1px solid color-mix(in srgb, var(--danger) 35%, transparent)' }}>
              <div className="d-flex align-items-center gap-2">
                <i className="bi bi-exclamation-triangle-fill text-danger" />
                <span className="fw-bold small text-danger">Warnings: {myWarnings}/3</span>
              </div>
              {myWarnings >= 3 && <p className="text-danger small mb-0 mt-1">3 warnings reached. Please contact management.</p>}
            </div>
          )}
        </div>
      ) : (
        /* ═══ TEAM PERFORMANCE ═══ */
        <>
          {/* Boss-only: pending flag-removal requests panel. Shown
              above the team table so Boss can act on them quickly. */}
          {isBoss && pendingRemovalRequests.length > 0 && (
            <FlagRemovalRequestsPanel
              requests={pendingRemovalRequests}
              onChanged={refreshFlagState}
            />
          )}

          {/* Sub-tabs */}
          {teamSubTabs.length > 1 && (
            <div className="d-flex gap-1 mb-3">
              {teamSubTabs.map(t => (
                <button key={t.key} onClick={() => { setTeamSubTab(t.key); setSearch(''); setLevelFilter('all'); }}
                  className="btn btn-sm px-3 py-2 d-inline-flex align-items-center gap-1"
                  style={{ borderRadius: 8, fontWeight: 600, fontSize: '0.75rem', background: teamSubTab === t.key ? 'var(--accent)' : 'var(--surface-2)', color: teamSubTab === t.key ? 'var(--on-accent)' : 'var(--text-secondary)', border: 'none' }}>
                  <i className={`bi ${t.icon}`} /> {t.label}
                  <span className="badge ms-1" style={{ background: teamSubTab === t.key ? 'rgba(255,255,255,0.2)' : 'var(--surface-3)', color: teamSubTab === t.key ? 'var(--on-accent)' : 'var(--text-secondary)', fontSize: '0.55rem' }}>
                    {teamUsers.filter(u => u._tab === t.key).length}
                  </span>
                </button>
              ))}
            </div>
          )}

          {/* Filters */}
          <div className="d-flex gap-2 mb-3 flex-wrap">
            <input type="text" className="form-control form-control-sm" placeholder="Search by name…"
              value={search} onChange={e => setSearch(e.target.value)} style={{ maxWidth: 220 }} />
            <select className="form-select form-select-sm" value={levelFilter}
              onChange={e => setLevelFilter(e.target.value)} style={{ maxWidth: 180 }}>
              <option value="all">All levels</option>
              <option value="promotion">Promotion (90+)</option>
              <option value="good">Good (70-89)</option>
              <option value="warning">Warning (50-69)</option>
              <option value="termination">Termination (&lt;50)</option>
              <option value="no_data">Not Rated</option>
            </select>
          </div>

          {/* Cards */}
          {filteredTeam.length === 0 ? (
            <div className="text-center py-5" style={{ border: '2px dashed var(--border-subtle)', borderRadius: 12 }}>
              <i className="bi bi-bar-chart text-muted" style={{ fontSize: '2.5rem', opacity: 0.3 }} />
              <p className="text-muted mt-3 mb-0">{search || levelFilter !== 'all' ? 'No matching results.' : 'No users found.'}</p>
            </div>
          ) : (
            <div className="row g-3">
              {filteredTeam.map(u => {
                // `compositeOk` false = the attendance RPC failed. calcComposite
                // would re-normalise over the surviving pillars and print a
                // plausible-but-wrong number, so we print nothing instead.
                const isRated = u.perfScore !== null && compositeOk && !u.incPending;
                const level = getLevel(u.composite);
                // When not rated, dim the top stripe + show "Not Rated Yet"
                // pill in place of the composite number. Auto-calculated
                // pillars below stay visible so the manager can still see
                // attendance / incentives / flags trending.
                const stripe = isRated
                  ? `linear-gradient(90deg,${level.color},color-mix(in srgb, ${level.color} 53%, transparent))`
                  : 'linear-gradient(90deg,var(--border-default),var(--border-subtle))';
                return (
                  <div key={u.id} className="col-sm-6 col-lg-4">
                    <div className="card border-0 shadow-sm h-100" style={{ borderRadius: 14, overflow: 'hidden' }}>
                      <div style={{ height: 4, background: stripe }} />
                      <div className="card-body p-3 d-flex flex-column">

                        {/* Identity */}
                        <div className="d-flex align-items-center gap-2 mb-3">
                          <div className="rounded-circle d-flex align-items-center justify-content-center fw-bold text-white flex-shrink-0"
                            style={{ width: 36, height: 36, background: 'linear-gradient(135deg,#1a1a2e,#0f3460)', fontSize: '0.7rem' }}>
                            {u.name.slice(0, 2).toUpperCase()}
                          </div>
                          <div className="flex-grow-1" style={{ minWidth: 0 }}>
                            <div className="fw-semibold small text-truncate">{u.name}</div>
                            <div className="text-muted" style={{ fontSize: '0.65rem' }}>{ROLE_LABEL[u.role || u.userRole || 'apc']}</div>
                          </div>
                          <div className="text-center flex-shrink-0">
                            {isRated ? (
                              <>
                                <div className="fw-bold" style={{ fontSize: '1.4rem', color: level.color, lineHeight: 1 }}>{u.composite}</div>
                                <span className="badge rounded-pill mt-1" style={{ background: level.bg, color: level.color, fontSize: '0.55rem' }}>
                                  <i className={`bi ${level.icon} me-1`} />{level.label}
                                </span>
                              </>
                            ) : (
                              <span className="badge rounded-pill" style={{ background: 'var(--surface-2)', color: 'var(--text-secondary)', fontSize: '0.6rem', padding: '6px 10px' }}
                                title={u.perfScore !== null && compositeOk && u.incPending ? 'Composite is withheld until the OL verifies this incentive plan' : undefined}>
                                {!compositeOk
                                  ? <><i className="bi bi-exclamation-triangle me-1" />Score Unavailable</>
                                  : u.perfScore === null
                                    ? <><i className="bi bi-hourglass-split me-1" />Not Rated Yet</>
                                    : <><i className="bi bi-shield-check me-1" />Not Verified</>}
                              </span>
                            )}
                          </div>
                        </div>

                        {/* 4 Pillar bars */}
                        <div className="flex-grow-1 d-flex flex-column gap-2 mb-3">
                          {PILLARS.map(p => {
                            const s = u.pillarScores[p.key];
                            const lv = s !== null ? getLevel(s) : null;
                            const isAtt = p.key === 'attendance';
                            const b = isAtt ? u.attData : null;
                            const clockedD = b ? b.daysClockedIn : 0;
                            const adj = b ? b.adjustedDays : 0;
                            const leaveD = b ? b.approvedLeaveDays : 0;
                            const holD = b ? b.holidayDays : 0;
                            const weekendD = b ? b.weekendDays : 0;
                            // The deduped set-union count, so an overlap
                            // (e.g. clock-in on a holiday) isn't
                            // double-counted in the tooltip.
                            const coveredD = b ? b.coveredDays : 0;
                            return (
                              <div key={p.key}>
                                <div className="d-flex align-items-center justify-content-between mb-1" style={{ fontSize: '0.68rem' }}>
                                  <span className="text-muted d-flex align-items-center gap-1">
                                    <i className={`bi ${p.icon}`} style={{ color: p.color, fontSize: '0.7rem' }} />{p.label}
                                    {b && (
                                      <span className="text-muted" style={{ fontSize: '0.6rem' }}
                                        title={`${clockedD} clocked-in${adj > 0 ? ` + ${adj} manager-adjusted` : ''}${leaveD > 0 ? ` + ${leaveD} approved leave` : ''}${holD > 0 ? ` + ${holD} holiday` : ''} + ${weekendD} weekend = ${coveredD} of ${u.workingDays} days`}>
                                        · {coveredD}/{u.workingDays} days
                                        {adj > 0 && <span style={{ color: 'var(--warning)' }}> (+{adj} adj)</span>}
                                        {leaveD > 0 && <span style={{ color: 'var(--info)' }}> (+{leaveD} leave)</span>}
                                      </span>
                                    )}
                                  </span>
                                  <span className="fw-semibold" style={{ color: lv?.color || 'var(--text-muted)' }}>{s !== null ? s : '—'}</span>
                                </div>
                                <div className="rounded-pill overflow-hidden" style={{ height: 4, background: 'var(--surface-2)' }}>
                                  <div className="h-100 rounded-pill" style={{ width: `${s || 0}%`, background: lv?.color || 'var(--surface-2)', transition: 'width 0.4s' }} />
                                </div>
                              </div>
                            );
                          })}
                        </div>

                        {/* Flags + warnings strip */}
                        <div className="d-flex gap-1 mb-2 flex-wrap">
                          <span className="badge rounded-pill" style={{ background: 'var(--success-soft)', color: 'var(--success)', fontSize: '0.55rem' }}>
                            <i className="bi bi-flag-fill me-1" />{u.gCount} green
                          </span>
                          <span className="badge rounded-pill" style={{ background: 'var(--danger-soft)', color: 'var(--danger)', fontSize: '0.55rem' }}>
                            <i className="bi bi-flag-fill me-1" />{u.rCount} red
                          </span>
                          {u.wCount > 0 && (
                            <span className="badge rounded-pill" style={{ background: 'var(--danger-soft)', color: 'var(--danger)', fontSize: '0.55rem' }}>
                              <i className="bi bi-exclamation-triangle me-1" />{u.wCount} warn
                            </span>
                          )}
                        </div>

                        {/* Actions */}
                        <div className="d-flex gap-2 mt-auto">
                          {(u.role || u.userRole) === 'apc' ? (
                            // APCs are rated WEEKLY in the agenda meeting — open the weekly
                            // breakdown (view + late/corrective rating) instead of the monthly modal.
                            <button className="btn btn-sm flex-grow-1 d-inline-flex align-items-center justify-content-center gap-1"
                              style={{ background: 'var(--accent)', color: 'var(--on-accent)', border: 'none', borderRadius: 8, fontSize: '0.72rem' }}
                              onClick={() => { setWeeklyInitMeeting(null); setWeeklyTarget(u); }}
                              title="Weekly performance ratings">
                              <i className="bi bi-bar-chart-fill" /> Weekly
                            </button>
                          ) : (u.role || u.userRole) === 'tl' ? (
                            // TLs: team + reporting breakdown. During Trial it's a preview and the
                            // old-method manual Rate stays available; when Live it's the official pillar.
                            <>
                              {!tlLive && u.canEdit && (
                                <button className="btn btn-sm d-inline-flex align-items-center justify-content-center gap-1"
                                  style={{ background: 'var(--accent)', color: 'var(--on-accent)', border: 'none', borderRadius: 8, fontSize: '0.72rem' }}
                                  onClick={() => setRateTarget(u)}>
                                  <i className="bi bi-pencil" /> Rate
                                </button>
                              )}
                              <button className="btn btn-sm flex-grow-1 d-inline-flex align-items-center justify-content-center gap-1"
                                style={{ background: tlLive ? 'var(--accent)' : 'var(--surface-1)', color: tlLive ? 'var(--on-accent)' : 'var(--text-secondary)', border: tlLive ? 'none' : '1.5px solid var(--border-subtle)', borderRadius: 8, fontSize: '0.72rem' }}
                                onClick={() => setTlTarget(u)}
                                title="Team + reporting performance breakdown">
                                <i className="bi bi-diagram-3" /> {tlLive ? 'Performance' : 'Preview'}
                              </button>
                            </>
                          ) : u.canEdit ? (
                            <button className="btn btn-sm flex-grow-1 d-inline-flex align-items-center justify-content-center gap-1"
                              style={{ background: 'var(--accent)', color: 'var(--on-accent)', border: 'none', borderRadius: 8, fontSize: '0.72rem' }}
                              onClick={() => setRateTarget(u)}>
                              <i className="bi bi-pencil" /> Rate
                            </button>
                          ) : null}
                          <button className="btn btn-sm d-inline-flex align-items-center justify-content-center gap-1"
                            style={{ border: '1.5px solid var(--border-subtle)', borderRadius: 8, background: 'var(--surface-1)', color: 'var(--text-secondary)', fontSize: '0.72rem' }}
                            onClick={() => setFlagsTarget(u)}>
                            <i className="bi bi-flag" /> Flags
                          </button>
                          {isBoss && isRated && u.composite < 50 && (
                            <button className="btn btn-sm d-inline-flex align-items-center justify-content-center gap-1"
                              style={{ background: 'var(--danger-soft)', color: 'var(--danger)', border: '1.5px solid color-mix(in srgb, var(--danger) 35%, transparent)', borderRadius: 8, fontSize: '0.72rem' }}
                              onClick={() => setWarnTarget(u)}>
                              <i className="bi bi-exclamation-triangle" />
                            </button>
                          )}
                        </div>

                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </>
      )}

      {/* Modals */}
      {rateTarget && <RateModal user={rateTarget} existing={teamRecords[rateTarget.id]} month={month} onClose={() => setRateTarget(null)} onSaved={handleRateSaved} />}
      {weeklyTarget && (
        <WeeklyBreakdownModal
          apc={weeklyTarget}
          month={month}
          enabled={weeklyCfg.enabled}
          canWrite={isBoss || effectiveRole === 'ol'}
          initialMeetingId={weeklyInitMeeting}
          onClose={() => { setWeeklyTarget(null); setWeeklyInitMeeting(null); }}
          onChanged={() => handleWeeklyChanged(weeklyTarget.id)}
        />
      )}
      {tlTarget && (
        <TlPerfBreakdownModal
          tl={tlTarget}
          month={month}
          enabled={tlLive}
          canManage={isBoss || effectiveRole === 'ol'}
          onClose={() => setTlTarget(null)}
          onChanged={() => { listTlReporting(month).then(setTlReporting).catch(() => {}); }}
        />
      )}
      {flagsTarget && <ViewFlagsModal
        user={flagsTarget}
        flags={teamFlags[flagsTarget.id] || []}
        canManage={canRate(effectiveRole, flagsTarget.role || flagsTarget.userRole || 'apc')}
        onClose={() => setFlagsTarget(null)}
        onAddFlag={type => setAddFlagTarget({ user: flagsTarget, type })}
        currentUserId={currentUser?.uid}
        currentUserRole={effectiveRole}
        pendingRemovals={pendingRemovals}
        onFlagsChanged={refreshFlagState}
      />}
      {addFlagTarget && <AddFlagModal user={addFlagTarget.user} flagType={addFlagTarget.type} onClose={() => setAddFlagTarget(null)} onSaved={handleFlagAdded} />}
      {warnTarget && <WarnModal user={warnTarget} warningCount={teamWarnings[warnTarget.id] || 0} onClose={() => setWarnTarget(null)} onSaved={handleWarnSaved} />}
      {showWeights && <WeightsModal weights={weights} onClose={() => setShowWeights(false)} onSaved={({ weights: w }) => { setWeights(w); setShowWeights(false); }} />}
    </div>
  );
}
