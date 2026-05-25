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
  // Attendance helpers (re-exported from attendanceApi for parity)
  fetchRosterMonth, computeMonthlyDays, getAdjustmentsForMonth,
} from '../../lib/performanceApi';
import { expandLeaveWeekdays } from '../../lib/attendanceApi';
import { listHolidayDatesForMonth } from '../../lib/holidaysApi';

// ── Helpers ──────────────────────────────────────────────────────────────────

function getCurrentMonth() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}
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
  { key: 'punctuality',       label: 'Punctuality',           icon: 'bi-clock',
    description: 'Clocking in on shift time consistently and not leaving early — reflects reliability beyond just being present.' },
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
      <i className="bi bi-info-circle" style={{ color: '#94a3b8', fontSize: '0.72rem' }} />
      {/* Anchor the tooltip's left edge to the icon and let it grow to
          the right. A previous centered-and-translateX layout overflowed
          left when the icon was near a panel/viewport edge, getting
          clipped. Left-anchored + min(viewport-aware width) keeps the
          full text on-screen regardless of where the icon sits. */}
      <span className="wx-metric-tip" role="tooltip"
        style={{
          position: 'absolute', bottom: 'calc(100% + 6px)', left: 0,
          background: '#0f172a', color: '#fff',
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
  { key: 'low',      label: 'Low',      color: '#6c757d', bg: '#f3f4f6', pts: 3 },
  { key: 'medium',   label: 'Medium',   color: '#fd7e14', bg: '#fff3e0', pts: 5 },
  { key: 'high',     label: 'High',     color: '#dc3545', bg: '#fce4ec', pts: 8 },
  { key: 'critical', label: 'Critical', color: '#7b1fa2', bg: '#f3e5f5', pts: 12 },
];

function getLevel(score) {
  if (score >= 90) return { label: 'Promotion',   color: '#198754', bg: '#e6f4ea', icon: 'bi-trophy-fill' };
  if (score >= 70) return { label: 'Good',         color: '#0d6efd', bg: '#e8f0fe', icon: 'bi-hand-thumbs-up-fill' };
  if (score >= 50) return { label: 'Warning',      color: '#fd7e14', bg: '#fff3e0', icon: 'bi-exclamation-triangle' };
  return              { label: 'Termination',   color: '#dc3545', bg: '#fce4ec', icon: 'bi-x-octagon-fill' };
}

function calcMetricsAvg(metrics) {
  if (!metrics) return 0;
  const vals = METRICS.map(m => Number(metrics[m.key]) || 0);
  return Math.round(vals.reduce((a, b) => a + b, 0) / METRICS.length);
}

function calcIncentiveScore(incRecord) {
  if (!incRecord) return null;
  const items = [...(incRecord.incentives || []), ...(incRecord.bonuses || [])];
  if (items.length === 0) return null;
  const completed = items.filter(i => i.completed).length;
  return Math.round((completed / items.length) * 100);
}

/**
 * Calculate attendance score from effective days (real clock-ins + manager
 * adjustments) divided by working days (Mon-Fri) of the month.
 */
function calcAttendanceScore(coveredDays, workingDays) {
  if (!workingDays || workingDays <= 0) return 100;
  return Math.min(100, Math.round((coveredDays / workingDays) * 100));
}

/**
 * Days elapsed in the month — the attendance-score denominator.
 *   • Current month → today's day-of-month (inclusive).
 *   • Past months   → the full month's last day.
 *   • Future months → 0 (nothing has happened).
 *
 * Using elapsed days (not full month) prevents the score from
 * claiming credit for future weekends / holidays / leaves before
 * they have actually occurred.
 */
function workingDaysInMonth(monthStr) {
  if (!monthStr) return 0;
  const [y, m] = monthStr.split('-').map(Number);
  const today = new Date();
  const firstOfMonth = new Date(y, m - 1, 1);
  if (today < firstOfMonth) return 0;
  if (today.getFullYear() === y && today.getMonth() + 1 === m) return today.getDate();
  return new Date(y, m, 0).getDate();
}

/** "YYYY-MM-DD" string for the inclusive end of the elapsed window. */
function cutoffYmdForMonth(monthStr) {
  if (!monthStr) return '0000-01-01';
  const [y, m] = monthStr.split('-').map(Number);
  const today = new Date();
  const firstOfMonth = new Date(y, m - 1, 1);
  const pad = (n) => String(n).padStart(2, '0');
  if (today < firstOfMonth) return '0000-01-01';
  if (today.getFullYear() === y && today.getMonth() + 1 === m) {
    return `${y}-${pad(m)}-${pad(today.getDate())}`;
  }
  const lastDay = new Date(y, m, 0).getDate();
  return `${y}-${pad(m)}-${pad(lastDay)}`;
}

/** Keep only dates on or before the cutoff (inclusive). */
function clipDateSet(set, cutoffYmd) {
  const out = new Set();
  if (!cutoffYmd || !set) return out;
  for (const d of set) if (d <= cutoffYmd) out.add(d);
  return out;
}

/** Count of Sat + Sun in a month — auto-credited toward "covered". */
function weekendDaysInMonth(monthStr) {
  if (!monthStr) return 0;
  const [y, m] = monthStr.split('-').map(Number);
  const last = new Date(y, m, 0).getDate();
  let n = 0;
  for (let d = 1; d <= last; d++) {
    const dow = new Date(y, m - 1, d).getDay();
    if (dow === 0 || dow === 6) n++;
  }
  return n;
}

/** Set of every Sat/Sun YYYY-MM-DD in a month — joins the coverage union. */
function weekendDateSetInMonth(monthStr) {
  const out = new Set();
  if (!monthStr) return out;
  const [y, m] = monthStr.split('-').map(Number);
  const last = new Date(y, m, 0).getDate();
  const pad = (n) => String(n).padStart(2, '0');
  for (let d = 1; d <= last; d++) {
    const dow = new Date(y, m - 1, d).getDay();
    if (dow === 0 || dow === 6) out.add(`${y}-${pad(m)}-${pad(d)}`);
  }
  return out;
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

function calcFlagsScore(flags, month) {
  const monthFlags = flags.filter(f => {
    if (!f.createdAt) return false;
    const d = f.createdAt.toDate ? f.createdAt.toDate() : new Date(f.createdAt);
    const fm = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
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

const ROLE_LABEL = { apc: 'APC', tl: 'Team Lead', ol: 'Operation Lead', boss: 'Boss' };

function canRate(viewer, target) {
  if (viewer === 'boss' && target === 'ol') return true;
  if (viewer === 'ol' && (target === 'tl' || target === 'apc')) return true;
  if (viewer === 'tl' && target === 'apc') return true;
  return false;
}

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

          <div className="rounded-3 p-3 mb-3 text-center" style={{ background: level.bg, border: `1.5px solid ${level.color}30` }}>
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
  const color = isGreen ? '#198754' : '#dc3545';

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
              style={{ width: 36, height: 36, background: isGreen ? '#e6f4ea' : '#fce4ec' }}>
              <i className="bi bi-flag-fill" style={{ color, fontSize: '0.9rem' }} />
            </div>
            <div>
              <h6 className="fw-bold mb-0">Add {isGreen ? 'Green' : 'Red'} Flag</h6>
              <p className="text-muted small mb-0">{user.displayName || user.userName}</p>
            </div>
          </div>
          <div className="mb-3">
            <label className="form-label small fw-semibold mb-1">Weightage</label>
            <div className="d-flex gap-2 flex-wrap">
              {WEIGHTAGES.map(w => (
                <button key={w.key} type="button" className="btn btn-sm px-3"
                  style={{ background: weightage === w.key ? w.color : w.bg, color: weightage === w.key ? '#fff' : w.color, border: `1.5px solid ${w.color}40`, borderRadius: 8, fontSize: '0.75rem', fontWeight: 600 }}
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
                  style={{ borderRadius: 8, fontSize: '0.78rem', fontWeight: 600, background: tab === t ? (g ? '#198754' : '#dc3545') : '#f3f4f6', color: tab === t ? '#fff' : '#6c757d', border: 'none' }}>
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
                  <div key={f.id} className="rounded-3 p-3" style={{ background: tab === 'green' ? '#f0fdf4' : '#fef2f2', border: `1px solid ${tab === 'green' ? '#b7dfc4' : '#fecaca'}` }}>
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
                        style={{ background: '#fff7ed', border: '1px solid #fed7aa', fontSize: '0.66rem', color: '#9a3412' }}>
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
                              background: '#fff', border: '1px solid #fecaca', color: '#b91c1c',
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
                              background: '#fff', border: '1px solid #c7d2fe', color: '#4338ca',
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
              <button className="btn btn-sm flex-grow-1" style={{ background: '#e6f4ea', color: '#198754', border: '1.5px solid #b7dfc4', borderRadius: 8, fontSize: '0.75rem' }}
                onClick={() => onAddFlag('green')}><i className="bi bi-plus-lg me-1" />Green Flag</button>
              <button className="btn btn-sm flex-grow-1" style={{ background: '#fce4ec', color: '#dc3545', border: '1.5px solid #fecaca', borderRadius: 8, fontSize: '0.75rem' }}
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
    <div className="rounded-3 p-3 mb-3" style={{ background: '#fff7ed', border: '1px solid #fed7aa' }}>
      <div className="d-flex align-items-center gap-2 mb-2">
        <i className="bi bi-hourglass-split" style={{ color: '#c2410c' }} />
        <h6 className="fw-bold mb-0" style={{ fontSize: '0.88rem', color: '#9a3412' }}>
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
            <div key={r.id} className="rounded-3 p-3" style={{ background: '#fff', border: '1px solid #fed7aa' }}>
              <div className="d-flex flex-wrap align-items-start justify-content-between gap-2 mb-2">
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div className="small fw-semibold" style={{ color: '#1a1a2e' }}>
                    {r.requester?.display_name || 'OL'} requested removal of a flag on{' '}
                    <span style={{ color: '#7c2d12' }}>{r.user?.display_name || 'a teammate'}</span>
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
                    style={{ background: '#dcfce7', color: '#166534', border: '1px solid #86efac', borderRadius: 6, fontSize: '0.72rem' }}
                    disabled={isBusy}
                    onClick={() => handleDecide(r, 'approve')}>
                    <i className="bi bi-check-lg" /> Approve
                  </button>
                  <button
                    className="btn btn-sm d-inline-flex align-items-center gap-1"
                    style={{ background: '#fee2e2', color: '#991b1b', border: '1px solid #fecaca', borderRadius: 6, fontSize: '0.72rem' }}
                    disabled={isBusy}
                    onClick={() => handleDecide(r, 'reject')}>
                    <i className="bi bi-x-lg" /> Reject
                  </button>
                </div>
              </div>
              {/* OL's reason */}
              <div className="rounded-2 p-2" style={{ background: '#f9fafb', border: '1px solid #e5e7eb', fontSize: '0.74rem' }}>
                <div className="text-muted mb-1" style={{ fontSize: '0.62rem', fontWeight: 600, textTransform: 'uppercase', letterSpacing: 0.4 }}>
                  Reason
                </div>
                <div style={{ color: '#1f2937', whiteSpace: 'pre-wrap' }}>{r.reason}</div>
              </div>
              {/* Original flag's reason for context */}
              {r.flag?.reason && (
                <div className="rounded-2 p-2 mt-2" style={{ background: '#fef2f2', border: '1px solid #fecaca', fontSize: '0.72rem' }}>
                  <div className="text-muted mb-1" style={{ fontSize: '0.62rem', fontWeight: 600, textTransform: 'uppercase', letterSpacing: 0.4 }}>
                    Original flag
                  </div>
                  <div style={{ color: '#7f1d1d', whiteSpace: 'pre-wrap' }}>{r.flag.reason}</div>
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
          <div className="rounded-3 p-3 mb-3" style={{ background: '#f0f9ff', border: '1px solid #bae6fd' }}>
            <div className="d-flex align-items-center gap-2 mb-1">
              <i className="bi bi-calendar-check" style={{ color: '#0284c7', fontSize: '0.9rem' }} />
              <span className="small fw-bold" style={{ color: '#0284c7' }}>Attendance score is now automatic</span>
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
            style={{ background: total === 100 ? '#e6f4ea' : '#fce4ec', borderRadius: 8 }}>
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
            <div className="rounded-2 d-flex align-items-center justify-content-center flex-shrink-0" style={{ width: 40, height: 40, background: '#fce4ec' }}>
              <i className="bi bi-exclamation-triangle-fill" style={{ color: '#dc3545', fontSize: '1rem' }} />
            </div>
            <div>
              <h6 className="fw-bold mb-0">Issue Warning #{next}</h6>
              <p className="text-muted small mb-0">{user.displayName || user.userName}</p>
            </div>
          </div>
          {next >= 3 && (
            <div className="alert py-2 small mb-3" style={{ background: '#fce4ec', border: '1px solid #fecaca', borderRadius: 8, color: '#dc3545' }}>
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
            <button className="btn btn-sm px-3" style={{ background: '#dc3545', color: '#fff', border: 'none', borderRadius: 8 }}
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
  const {
    myRecord, myIncRecord, myAttendanceDays, myFlags, month,
    workingDays,
  } = ctx;

  if (pillarKey === 'performance') {
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
              <i className={`bi ${m.icon}`} style={{ color: '#6c757d', fontSize: '0.78rem', flex: '0 0 14px' }} />
              <span style={{ flex: 1, color: '#374151', display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                {m.label}
                <MetricInfoTip text={m.description} />
              </span>
              <div className="rounded-pill" style={{ flex: '0 0 90px', height: 5, background: '#e9ecef', overflow: 'hidden' }}>
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
              background: it.completed ? '#f0fdf4' : '#f9fafb',
              border: `1px solid ${it.completed ? '#b7dfc4' : '#e9ecef'}`,
              fontSize: '0.74rem',
            }}>
            <i className={`bi ${it.completed ? 'bi-check-circle-fill text-success' : 'bi-circle text-muted'}`}
              style={{ fontSize: '0.8rem', marginTop: 2 }} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div className="fw-semibold" style={{ color: '#1f2937' }}>
                {it.title || it.label || (it._kind === 'bonus' ? 'Bonus' : 'Incentive')}
                <span className="text-muted ms-1" style={{ fontSize: '0.6rem', fontWeight: 500 }}>
                  · {it._kind}
                </span>
              </div>
              {it.amount != null && it.amount !== '' && (
                <div className="text-muted" style={{ fontSize: '0.68rem' }}>
                  {Number(it.amount).toLocaleString('en-US')} PKR
                </div>
              )}
              {it.description && (
                <div style={{ color: '#374151', marginTop: 2 }}>{it.description}</div>
              )}
            </div>
          </div>
        ))}
      </div>
    );
  }

  if (pillarKey === 'attendance') {
    const effective   = myAttendanceDays.effective || 0;
    const leaveDays   = myAttendanceDays.leaveDays || 0;
    const holidayDays = myAttendanceDays.holidayDays || 0;
    const weekendDays = myAttendanceDays.weekendDays || weekendDaysInMonth(month);
    // Set-union covered — a clock-in that also falls on a holiday
    // or weekend is counted once, so the score can never be padded
    // beyond reality.
    const covered     = myAttendanceDays.coveredDays || 0;
    const wd          = workingDays;
    const pct         = wd > 0 ? Math.round((covered / wd) * 100) : 100;
    const missed      = Math.max(0, wd - covered);
    return (
      <div className="d-flex flex-column gap-2" style={{ fontSize: '0.75rem' }}>
        <div className="text-muted" style={{ fontSize: '0.68rem' }}>
          Score = covered days / total days in the month. Weekends,
          company holidays and any approved leave (medical,
          emergency, other) are auto-credited &mdash; only weekdays
          you were expected to work but didn&apos;t clock in count
          against the score. WFH days are treated as present.
        </div>
        <div className="d-flex justify-content-between rounded-2 p-2"
          style={{ background: '#fff7ed', border: '1px solid #fed7aa' }}>
          <span>Days this month</span>
          <strong>{wd}</strong>
        </div>
        <div className="d-flex justify-content-between rounded-2 p-2"
          style={{ background: '#f0fdf4', border: '1px solid #b7dfc4' }}>
          <span>Days present (real clock-ins + adjustments)</span>
          <strong>{effective}</strong>
        </div>
        <div className="d-flex justify-content-between rounded-2 p-2"
          style={{ background: '#f8fafc', border: '1px solid #cbd5e1' }}>
          <span>Weekends</span>
          <strong>{weekendDays}</strong>
        </div>
        <div className="d-flex justify-content-between rounded-2 p-2"
          style={{ background: '#eff6ff', border: '1px solid #93c5fd' }}>
          <span>Approved leave days</span>
          <strong>{leaveDays}</strong>
        </div>
        {holidayDays > 0 && (
          <div className="d-flex justify-content-between rounded-2 p-2"
            style={{ background: '#fdf4ff', border: '1px solid #e9d5ff' }}>
            <span>Company holidays</span>
            <strong>{holidayDays}</strong>
          </div>
        )}
        {missed > 0 && (
          <div className="d-flex justify-content-between rounded-2 p-2"
            style={{ background: '#fef2f2', border: '1px solid #fecaca' }}>
            <span>Days not covered</span>
            <strong className="text-danger">{missed}</strong>
          </div>
        )}
        <div className="d-flex justify-content-between rounded-2 p-2 fw-bold"
          style={{ background: '#f3f4f6', border: '1px solid #e9ecef' }}>
          <span>Covered ({covered} / {wd})</span>
          <span>{pct}%</span>
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
          style={{ background: '#f0fdf4', border: '1px solid #b7dfc4' }}>
          <span><i className="bi bi-flag-fill me-1" style={{ color: '#198754' }} />Green flags this month</span>
          <strong>{greens}</strong>
        </div>
        <div className="d-flex justify-content-between rounded-2 p-2"
          style={{ background: '#fef2f2', border: '1px solid #fecaca' }}>
          <span><i className="bi bi-flag-fill me-1" style={{ color: '#dc3545' }} />Red flags this month</span>
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
  // PCTL is treated like TL by the page (same can-rate rules apply
  // because PCTL also evaluates IPCs reporting to them).
  const normalisedRole = userRole === 'pctl' ? 'tl' : userRole === 'developer' ? 'boss' : userRole;
  const effectiveRole = ['boss','ol','tl','apc','ipc'].includes(normalisedRole)
    ? (normalisedRole === 'ipc' ? 'apc' : normalisedRole)
    : 'apc';
  const isBoss = effectiveRole === 'boss';
  const hasTeamTab = effectiveRole !== 'apc';

  const [month, setMonth]     = useState(getCurrentMonth());
  const [mainTab, setMainTab] = useState(hasTeamTab ? 'team' : 'my');
  const [loading, setLoading] = useState(true);
  const [weights, setWeights] = useState(DEFAULT_WEIGHTS);

  // My data
  const [myRecord, setMyRecord]       = useState(null);
  const [myFlags, setMyFlags]         = useState([]);
  const [myWarnings, setMyWarnings]   = useState(0);
  const [myAttendanceDays, setMyAttendanceDays] = useState({ actual: 0, effective: 0, leaveDays: 0, holidayDays: 0 });
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

  // ── Load ──
  useEffect(() => {
    async function load() {
      if (!currentUser) return;
      setLoading(true);

      // Pillar weights (Boss-editable). v2 stores per-pillar columns
      // and getV1Weights converts to the v1 {performance,...} shape.
      try { setWeights(await getV1Weights()); } catch { /* keep defaults */ }

      // My performance (non-boss).
      if (effectiveRole !== 'boss') {
        const [myRec, myFlagsList, myWarnCount] = await Promise.all([
          getRatingFor(currentUser.uid, month),
          listFlagsForUser(currentUser.uid),
          countWarningsForUser(currentUser.uid),
        ]);
        setMyRecord(myRec);
        setMyFlags(myFlagsList);
        setMyWarnings(myWarnCount);

        // My incentives for the month — server filters by user.
        const myIncRows = (await listAllIncentivesForMonth(month))
          .filter((r) => r.userId === currentUser.uid);
        setMyIncRecord(myIncRows[0] || null);

        // My attendance for the month — same helpers the Roster tab uses
        // so the per-user widget can never disagree with the Performance score.
        const { records: monthRecords } = await fetchRosterMonth(month);
        const myAdjList = await getAdjustmentsForMonth(month).catch(() => []);
        // listApprovedLeaveDatesForMonth lives in attendanceApi (re-export
        // not added here); compute leave days inline from fetchRosterMonth
        // which already returns leaves filtered to medical/emergency only.
        const myMonth = monthRecords.filter((r) => r.user_id === currentUser.uid || r.userId === currentUser.uid);
        const { actualDays: myActual, effectiveDays: myEffective, effectiveSet: myEffectiveSet } =
          computeMonthlyDays(currentUser.uid, myMonth, myAdjList);

        // For leave days, use the rosterMonth.leaves payload (already
        // medical/emergency only, intersected with month).
        const { leaves: myLeavesAll } = await fetchRosterMonth(month);
        const myLeaves = myLeavesAll.filter((l) => l.requestedBy === currentUser.uid);
        const [yLm, mLm] = month.split('-').map(Number);
        const lastDay = new Date(yLm, mLm, 0).getDate();
        const mStartDate = `${yLm}-${String(mLm).padStart(2, '0')}-01`;
        const mEndDate = `${yLm}-${String(mLm).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`;
        // Company holidays inside the month (Mon-Fri only). Used as both the
        // "exclude from leave count" set and the "counts as covered" set.
        const myHolidaySet = await listHolidayDatesForMonth(month).catch(() => new Set());
        const myLeaveDates = new Set();
        myLeaves.forEach((l) => {
          const days = expandLeaveWeekdays(
            l.startDate || l.start_date,
            l.endDate   || l.end_date,
            { mStart: mStartDate, mEnd: mEndDate, holidaySet: myHolidaySet },
          );
          days.forEach((d) => myLeaveDates.add(d));
        });
        // Clip every credit-set to days that have actually elapsed.
        // For the current month, that's today inclusive; for past
        // months the whole month is elapsed; for future months
        // nothing has elapsed. This prevents the score from
        // claiming credit for tomorrow's weekend / next week's
        // holiday / a future approved-leave day.
        const cutoffYmd = cutoffYmdForMonth(month);
        const myWeekendSet = clipDateSet(weekendDateSetInMonth(month), cutoffYmd);
        const myHolidayClipped = clipDateSet(myHolidaySet, cutoffYmd);
        const myLeaveClipped   = clipDateSet(myLeaveDates, cutoffYmd);
        // Set-union of every "covered" date — clock-ins, approved
        // leaves, holidays, weekends. Counts each date once so a
        // clock-in on a holiday (or any other overlap) is not
        // counted twice and cannot inflate the score.
        const myCoveredSet = new Set([
          ...myEffectiveSet, ...myLeaveClipped, ...myHolidayClipped, ...myWeekendSet,
        ]);
        setMyAttendanceDays({
          actual: myActual,
          effective: myEffective,
          leaveDays: myLeaveClipped.size,
          holidayDays: myHolidayClipped.size,
          weekendDays: myWeekendSet.size,
          coveredDays: myCoveredSet.size,
        });
      }

      // Team data.
      if (hasTeamTab) {
        const users = await listEvaluableUsers({
          uid: currentUser.uid, viewerRole: effectiveRole,
        });
        setTeamUsers(users);
        const userIds = users.map((u) => u.id);
        const idSet = new Set(userIds);

        // 7 parallel reads — performance / flags / warnings / incentives /
        // attendance / adjustments / approved-leaves — same as v1.
        const [perfList, flagList, warnList, incList, rosterMonthData, adjList] =
          await Promise.all([
            listAllRatingsForMonth(month),
            listAllFlags(),
            listAllWarnings(),
            listAllIncentivesForMonth(month),
            fetchRosterMonth(month),
            getAdjustmentsForMonth(month).catch(() => []),
          ]);
        const monthRecords = rosterMonthData.records;
        const monthLeaves  = rosterMonthData.leaves;

        const recMap = {}, flagMap = {}, warnMap = {}, incMap = {}, attMap = {};
        perfList.forEach((x) => { if (idSet.has(x.userId)) recMap[x.userId] = x; });
        flagList.forEach((x) => {
          if (!idSet.has(x.userId)) return;
          if (!flagMap[x.userId]) flagMap[x.userId] = [];
          flagMap[x.userId].push(x);
        });
        warnList.forEach((x) => { if (idSet.has(x.userId)) warnMap[x.userId] = (warnMap[x.userId] || 0) + 1; });
        incList.forEach((x) => { const uid = x.userId; if (uid && idSet.has(uid)) incMap[uid] = x; });

        const [yr, mo] = month.split('-').map(Number);
        const mLastDay = new Date(yr, mo, 0).getDate();
        const mStart = `${yr}-${String(mo).padStart(2, '0')}-01`;
        const mEnd   = `${yr}-${String(mo).padStart(2, '0')}-${String(mLastDay).padStart(2, '0')}`;

        const teamHolidaySet = await listHolidayDatesForMonth(month).catch(() => new Set());

        // Clip credit-sets to days that have elapsed in `month`, so
        // future weekends / holidays / leaves don't pre-credit the
        // score during the current month.
        const teamCutoffYmd = cutoffYmdForMonth(month);
        const teamWeekendSet = clipDateSet(weekendDateSetInMonth(month), teamCutoffYmd);
        const teamHolidayClipped = clipDateSet(teamHolidaySet, teamCutoffYmd);
        userIds.forEach((uid) => {
          const { actualDays, effectiveDays, effectiveSet } =
            computeMonthlyDays(uid, monthRecords, adjList);
          const userLeaves = monthLeaves.filter((l) => l.requestedBy === uid);
          const leaveDates = new Set();
          userLeaves.forEach((l) => {
            const days = expandLeaveWeekdays(
              l.startDate || l.start_date,
              l.endDate   || l.end_date,
              { mStart, mEnd, holidaySet: teamHolidaySet },
            );
            days.forEach((d) => leaveDates.add(d));
          });
          const leaveClipped = clipDateSet(leaveDates, teamCutoffYmd);
          // Set-union dedupes overlaps (e.g. clock-in on a holiday)
          // so a missed weekday cannot be hidden by double-counting.
          const coveredSet = new Set([
            ...effectiveSet, ...leaveClipped, ...teamHolidayClipped, ...teamWeekendSet,
          ]);
          attMap[uid] = {
            actualDays,
            effectiveDays,
            leaveDays: leaveClipped.size,
            holidayDays: teamHolidayClipped.size,
            weekendDays: teamWeekendSet.size,
            coveredDays: coveredSet.size,
          };
        });

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
        const map = {};
        pendingList.forEach((p) => { map[p.flagId] = p; });
        setPendingRemovals(map);
        setPendingRemovalRequests(pendingList);
      } catch {
        // RLS may reject for users not involved in any request — that
        // just means no pending state to show. Silent fallback.
        setPendingRemovals({});
        setPendingRemovalRequests([]);
      }

      setLoading(false);
    }
    load();
  // Include effectiveRole — on first render the profile may not be
  // loaded yet, so userRole='' and effectiveRole defaults to 'apc'.
  // Once the profile resolves and effectiveRole becomes 'ol'/'boss'/
  // 'tl', we MUST re-run the load to fetch team data. Without this,
  // the OL hits the page, the load runs with hasTeamTab=false, then
  // never re-fires — Team tab shows empty until a hard refresh.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [month, currentUser?.uid, effectiveRole]);

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
    return t;
  }, [isBoss, effectiveRole]);

  const filteredTeam = useMemo(() => {
    const tabRoleMap = { ols: 'ol', tls: 'tl', apcs: 'apc' };
    let list = teamUsers.filter(u => u._tab === teamSubTab).map(u => {
      const name = u.displayName || u.userName || u.email || '—';
      const rec = teamRecords[u.id];
      const perfScore = rec ? calcMetricsAvg(rec.metrics) : null;
      const incScore = calcIncentiveScore(teamIncentives[u.id]);
      const attData = teamAttendance[u.id] || { actualDays: 0, effectiveDays: 0, leaveDays: 0, holidayDays: 0 };
      const wd = workingDaysInMonth(month);
      // attData.coveredDays is the set-union (clock-ins ∪ leaves ∪
      // holidays ∪ weekends), so an overlap (e.g. clock-in on a
      // holiday) is counted once — no inflated score.
      const covered = attData.coveredDays || 0;
      const attScore = calcAttendanceScore(covered, wd);
      const flagScore = calcFlagsScore(teamFlags[u.id] || [], month);
      const pillarScores = { performance: perfScore, incentives: incScore, attendance: attScore, flags: flagScore };
      const composite = calcComposite(pillarScores, weights);
      const gCount = (teamFlags[u.id] || []).filter(f => f.type === 'green').length;
      const rCount = (teamFlags[u.id] || []).filter(f => f.type === 'red').length;
      const wCount = teamWarnings[u.id] || 0;
      const canEdit = canRate(effectiveRole, tabRoleMap[teamSubTab]);
      return { ...u, name, rec, perfScore, incScore, attScore, flagScore, pillarScores, composite, gCount, rCount, wCount, canEdit, attData, workingDays: wd };
    });
    if (search) { const s = search.toLowerCase(); list = list.filter(u => u.name.toLowerCase().includes(s)); }
    if (levelFilter !== 'all') {
      if (levelFilter === 'no_data') list = list.filter(u => !u.rec);
      else list = list.filter(u => getLevel(u.composite).label.toLowerCase() === levelFilter);
    }
    return list;
  }, [teamUsers, teamRecords, teamIncentives, teamAttendance, teamFlags, teamWarnings, teamSubTab, search, levelFilter, effectiveRole, weights, month]);

  // My pillar scores
  const myPerfScore = myRecord ? calcMetricsAvg(myRecord.metrics) : null;
  const myIncScore  = calcIncentiveScore(myIncRecord);
  const myAttScore  = calcAttendanceScore(
    myAttendanceDays.coveredDays || 0,
    workingDaysInMonth(month),
  );
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
            onChange={e => setMonth(e.target.value)} style={{ width: 160 }} />
          {isBoss && (
            <button className="btn btn-sm btn-outline-secondary d-inline-flex align-items-center gap-1"
              onClick={() => setShowWeights(true)} title="Configure weightages">
              <i className="bi bi-gear" />
            </button>
          )}
        </div>
      </div>

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
        <div className="d-flex gap-1 mb-4" style={{ borderBottom: '2px solid #e9ecef' }}>
          {[
            { key: 'team', label: 'Team Performance', icon: 'bi-people' },
            ...(effectiveRole !== 'boss' ? [{ key: 'my', label: 'My Performance', icon: 'bi-person' }] : []),
          ].map(t => (
            <button key={t.key} onClick={() => setMainTab(t.key)}
              className="btn btn-sm px-3 py-2 d-inline-flex align-items-center gap-1"
              style={{
                borderRadius: '8px 8px 0 0', fontWeight: 600, fontSize: '0.78rem',
                background: mainTab === t.key ? '#1a1a2e' : 'transparent',
                color: mainTab === t.key ? '#fff' : '#6c757d',
                border: 'none', marginBottom: -2,
                borderBottom: mainTab === t.key ? '2px solid #1a1a2e' : '2px solid transparent',
              }}>
              <i className={`bi ${t.icon}`} /> {t.label}
            </button>
          ))}
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
          {myPerfScore === null ? (
            <div className="card border-0 shadow-sm mb-4" style={{ borderRadius: 14, overflow: 'hidden' }}>
              <div style={{ height: 4, background: 'linear-gradient(90deg,#94a3b8,#cbd5e1)' }} />
              <div className="card-body p-4 text-center">
                <div className="d-inline-flex align-items-center justify-content-center rounded-circle mb-2"
                  style={{ width: 100, height: 100, background: '#f1f5f9', border: '3px solid #cbd5e1' }}>
                  <i className="bi bi-hourglass-split" style={{ fontSize: '1.8rem', color: '#64748b' }} />
                </div>
                <div className="d-flex align-items-center justify-content-center gap-1 mb-1">
                  <span className="fw-bold" style={{ color: '#475569' }}>Not Rated Yet</span>
                </div>
                <p className="text-muted small mb-0">Performance is rated at the end of {getMonthLabel(month)}</p>
              </div>
            </div>
          ) : (
            <div className="card border-0 shadow-sm mb-4" style={{ borderRadius: 14, overflow: 'hidden' }}>
              <div style={{ height: 4, background: `linear-gradient(90deg,${myLevel.color},${myLevel.color}88)` }} />
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
                    ctx={{
                      myRecord,
                      myIncRecord,
                      myAttendanceDays,
                      myFlags,
                      month,
                      workingDays: workingDaysInMonth(month),
                    }}
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
                    <div key={f.id} className="rounded-3 p-3" style={{ background: f.type === 'green' ? '#f0fdf4' : '#fef2f2', border: `1px solid ${f.type === 'green' ? '#b7dfc4' : '#fecaca'}` }}>
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
            <div className="mt-4 rounded-3 p-3" style={{ background: '#fce4ec', border: '1px solid #fecaca' }}>
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
                  style={{ borderRadius: 8, fontWeight: 600, fontSize: '0.75rem', background: teamSubTab === t.key ? '#1a1a2e' : '#f3f4f6', color: teamSubTab === t.key ? '#fff' : '#6c757d', border: 'none' }}>
                  <i className={`bi ${t.icon}`} /> {t.label}
                  <span className="badge ms-1" style={{ background: teamSubTab === t.key ? 'rgba(255,255,255,0.2)' : '#e9ecef', color: teamSubTab === t.key ? '#fff' : '#6c757d', fontSize: '0.55rem' }}>
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
            <div className="text-center py-5" style={{ border: '2px dashed #dee2e6', borderRadius: 12 }}>
              <i className="bi bi-bar-chart text-muted" style={{ fontSize: '2.5rem', opacity: 0.3 }} />
              <p className="text-muted mt-3 mb-0">{search || levelFilter !== 'all' ? 'No matching results.' : 'No users found.'}</p>
            </div>
          ) : (
            <div className="row g-3">
              {filteredTeam.map(u => {
                const isRated = u.perfScore !== null;
                const level = getLevel(u.composite);
                // When not rated, dim the top stripe + show "Not Rated Yet"
                // pill in place of the composite number. Auto-calculated
                // pillars below stay visible so the manager can still see
                // attendance / incentives / flags trending.
                const stripe = isRated
                  ? `linear-gradient(90deg,${level.color},${level.color}88)`
                  : 'linear-gradient(90deg,#cbd5e1,#e2e8f0)';
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
                              <span className="badge rounded-pill" style={{ background: '#f1f5f9', color: '#475569', fontSize: '0.6rem', padding: '6px 10px' }}>
                                <i className="bi bi-hourglass-split me-1" />Not Rated Yet
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
                            const adj = isAtt && u.attData ? (u.attData.effectiveDays - u.attData.actualDays) : 0;
                            const leaveD = isAtt && u.attData ? (u.attData.leaveDays || 0) : 0;
                            const holD = isAtt && u.attData ? (u.attData.holidayDays || 0) : 0;
                            const weekendD = isAtt && u.attData ? (u.attData.weekendDays || 0) : 0;
                            // Use the deduped set-union count so an
                            // overlap (e.g. clock-in on a holiday)
                            // isn't double-counted in the tooltip.
                            const coveredD = isAtt && u.attData ? (u.attData.coveredDays || 0) : 0;
                            return (
                              <div key={p.key}>
                                <div className="d-flex align-items-center justify-content-between mb-1" style={{ fontSize: '0.68rem' }}>
                                  <span className="text-muted d-flex align-items-center gap-1">
                                    <i className={`bi ${p.icon}`} style={{ color: p.color, fontSize: '0.7rem' }} />{p.label}
                                    {isAtt && u.attData && (
                                      <span className="text-muted" style={{ fontSize: '0.6rem' }}
                                        title={`${u.attData.actualDays} clocked-in${adj > 0 ? ` + ${adj} manager-adjusted` : ''}${leaveD > 0 ? ` + ${leaveD} approved leave` : ''}${holD > 0 ? ` + ${holD} holiday` : ''} + ${weekendD} weekend = ${coveredD} of ${u.workingDays} days`}>
                                        · {coveredD}/{u.workingDays} days
                                        {adj > 0 && <span style={{ color: '#92400e' }}> (+{adj} adj)</span>}
                                        {leaveD > 0 && <span style={{ color: '#1d4ed8' }}> (+{leaveD} leave)</span>}
                                      </span>
                                    )}
                                  </span>
                                  <span className="fw-semibold" style={{ color: lv?.color || '#adb5bd' }}>{s !== null ? s : '—'}</span>
                                </div>
                                <div className="rounded-pill overflow-hidden" style={{ height: 4, background: '#e9ecef' }}>
                                  <div className="h-100 rounded-pill" style={{ width: `${s || 0}%`, background: lv?.color || '#e9ecef', transition: 'width 0.4s' }} />
                                </div>
                              </div>
                            );
                          })}
                        </div>

                        {/* Flags + warnings strip */}
                        <div className="d-flex gap-1 mb-2 flex-wrap">
                          <span className="badge rounded-pill" style={{ background: '#e6f4ea', color: '#198754', fontSize: '0.55rem' }}>
                            <i className="bi bi-flag-fill me-1" />{u.gCount} green
                          </span>
                          <span className="badge rounded-pill" style={{ background: '#fce4ec', color: '#dc3545', fontSize: '0.55rem' }}>
                            <i className="bi bi-flag-fill me-1" />{u.rCount} red
                          </span>
                          {u.wCount > 0 && (
                            <span className="badge rounded-pill" style={{ background: '#fce4ec', color: '#dc3545', fontSize: '0.55rem' }}>
                              <i className="bi bi-exclamation-triangle me-1" />{u.wCount} warn
                            </span>
                          )}
                        </div>

                        {/* Actions */}
                        <div className="d-flex gap-2 mt-auto">
                          {u.canEdit && (
                            <button className="btn btn-sm flex-grow-1 d-inline-flex align-items-center justify-content-center gap-1"
                              style={{ background: '#1a1a2e', color: '#fff', border: 'none', borderRadius: 8, fontSize: '0.72rem' }}
                              onClick={() => setRateTarget(u)}>
                              <i className="bi bi-pencil" /> Rate
                            </button>
                          )}
                          <button className="btn btn-sm d-inline-flex align-items-center justify-content-center gap-1"
                            style={{ border: '1.5px solid #dee2e6', borderRadius: 8, background: '#fff', color: '#495057', fontSize: '0.72rem' }}
                            onClick={() => setFlagsTarget(u)}>
                            <i className="bi bi-flag" /> Flags
                          </button>
                          {isBoss && isRated && u.composite < 50 && (
                            <button className="btn btn-sm d-inline-flex align-items-center justify-content-center gap-1"
                              style={{ background: '#fce4ec', color: '#dc3545', border: '1.5px solid #fecaca', borderRadius: 8, fontSize: '0.72rem' }}
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
