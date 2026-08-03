import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext';
import {
  getV1Weights, getCompositeFor, getRatingFor, listFlags, listAllIncentivesForMonth,
  calcMetricsAvg, calcComposite, getLevelTokens,
  currentMonth, ROLE_LABEL, V1_METRICS,
} from '../../lib/performanceApi';
import { getTlPerfEnabled, tlPerfPreview } from '../../lib/tlPerfApi';
import { getWeeklyRatingsEnabled, listWeeklyRatingsForApcMonth } from '../../lib/weeklyRatingsApi';
import { listAgendaMeetings } from '../../lib/agendaApi';

// ============================================================
// Performance Simulator — a private, READ-ONLY what-if tool.
//
// Every number is computed with the SAME functions the real Performance page
// scores with (calcComposite / calcMetricsAvg / getLevelTokens) + the TL blend
// from migs 271/276, so a simulation always matches what the user would actually
// be scored. It NEVER writes anything — it only READS the user's own current
// values (composite RPC, weekly ratings, the TL's agenda meetings, incentives,
// flags) to pre-fill, and everything after that is local state.
//
// It mirrors the REAL weekly system: an APC's month = the average of that
// month's weekly ratings (each = the 5 metrics, with Reporting = OL 0–90 + a
// report chunk + a checkpoint chunk); a TL's month = 0.6·team + 0.4·reporting,
// where reporting = 0.6·(avg of the OL's per-week stars ×20) + 0.4·accountability.
// ============================================================

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const monthLabel = (m) => { const [y, mm] = (m || '').split('-'); return mm ? `${MONTHS[+mm - 1]} ${y}` : m; };
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const clone = (x) => JSON.parse(JSON.stringify(x));

// TL reporting blend (mig 276) + pillar blend (mig 271), null-safe — verbatim.
function tlReportingScore(starScore, accountability) {
  if (starScore != null && accountability != null) return 0.6 * starScore + 0.4 * accountability;
  if (starScore != null) return starScore;
  if (accountability != null) return accountability;
  return null;
}
function tlPerfPillar(team, reporting) {
  let v;
  if (team != null && reporting != null) v = Math.round(0.6 * team + 0.4 * reporting);
  else if (team != null) v = Math.round(team);
  else if (reporting != null) v = Math.round(reporting);
  else return null;
  return clamp(v, 0, 100);
}

// ── APC weekly roll-up — mirrors the SQL rollup (average each metric across the
//    month's weeks, then average the 5). Reporting per week = OL + the 2 chunks.
function apcWeekReporting(w) {
  return clamp((Number(w.repOl) || 0) + Math.max(0, 5 - (w.repDocks || 0)) + Math.max(0, 5 - (w.cpDocks || 0)), 0, 100);
}
function apcWeekOverall(w) {
  return calcMetricsAvg({
    dailyTasksQuality: Number(w.dailyTasksQuality) || 0, reporting: apcWeekReporting(w),
    overallWorkflow: Number(w.overallWorkflow) || 0, responseTime: Number(w.responseTime) || 0, tasksProcessing: Number(w.tasksProcessing) || 0,
  });
}
function apcMonthlyPerf(weeks) {
  if (!weeks || !weeks.length) return 0;
  // Average each metric across the weeks, rounded to 2dp — mirrors the SQL rollup
  // (averageWeeklyMetrics) — then calcMetricsAvg over the five, like the real page.
  const avg2 = (vals) => Math.round((vals.reduce((a, v) => a + v, 0) / vals.length) * 100) / 100;
  const mm = {};
  ['dailyTasksQuality', 'overallWorkflow', 'responseTime', 'tasksProcessing'].forEach((k) => {
    mm[k] = avg2(weeks.map((w) => Number(w[k]) || 0));
  });
  mm.reporting = avg2(weeks.map((w) => apcWeekReporting(w)));
  return calcMetricsAvg(mm);
}
// Seed one APC week from a metrics object so it reproduces that week's reporting
// exactly: OL = the stored 0–90 slider (or reporting−10), docks make up the rest.
function seedApcWeek(m, label) {
  const mm = m || {};
  const folded = Number(mm.reporting) || 0;
  const ol = mm.reportingOl != null ? clamp(Number(mm.reportingOl), 0, 90) : clamp(folded - 10, 0, 90);
  const totalDocks = clamp(10 - clamp(folded - ol, 0, 10), 0, 10);
  const repDocks = Math.min(5, totalDocks);
  const cpDocks = clamp(totalDocks - repDocks, 0, 5);
  return {
    label, dailyTasksQuality: Number(mm.dailyTasksQuality) || 0, overallWorkflow: Number(mm.overallWorkflow) || 0,
    responseTime: Number(mm.responseTime) || 0, tasksProcessing: Number(mm.tasksProcessing) || 0, repOl: ol, repDocks, cpDocks,
  };
}
function tlStarScore(weeks) {
  if (!weeks || !weeks.length) return null;
  return clamp((weeks.reduce((a, w) => a + (Number(w.stars) || 0), 0) / weeks.length) * 20, 0, 100);
}
// The Performance pillar (0–100 or null), from a full input set — shared by the
// live sim and the initial-baseline so `dirty` compares the actual scores.
function computePerf(mode, s) {
  if (mode === 'tl') {
    const team = s.hasTeam ? clamp(s.team, 0, 100) : null; // dropped when no rated APCs (mig 271:252)
    const starScore = tlStarScore(s.tlWeeks);
    const acct = (s.hasReports && s.n > 0) ? clamp(Math.max(0, s.n - s.d) / s.n * 100, 0, 100) : null;
    return tlPerfPillar(team, tlReportingScore(starScore, acct));
  }
  if (mode === 'apc') return apcMonthlyPerf(s.apcWeeks);
  return calcMetricsAvg(s.metrics);
}

// ── Small presentational pieces (module scope so inputs never lose focus) ──
function Slider({ label, value, min = 0, max = 100, step = 1, onChange, suffix = '', hint, accent }) {
  // The slider VALUE stays exact (so a decimal seed keeps composite parity);
  // only the readout is rounded for whole-number sliders.
  const shown = step < 1 ? value : Math.round(value);
  const color = accent || getLevelTokens(Number(value)).color;
  return (
    <div className="mb-3">
      <div className="d-flex justify-content-between align-items-baseline mb-1">
        <span style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', fontWeight: 600 }}>{label}</span>
        <span style={{ fontWeight: 800, color: 'var(--text-primary)', fontVariantNumeric: 'tabular-nums' }}>{shown}{suffix}</span>
      </div>
      <input type="range" className="form-range" min={min} max={max} step={step} value={value}
        aria-label={label} aria-valuetext={`${shown}${suffix}`}
        onChange={(e) => onChange(Number(e.target.value))} style={{ '--range-c': color }} />
      {hint && <div style={{ fontSize: '0.66rem', color: 'var(--text-muted)', marginTop: -2 }}>{hint}</div>}
    </div>
  );
}

function Stepper({ label, value, min = 0, max = 20, onChange, color = 'var(--text-primary)', hint }) {
  const set = (v) => onChange(clamp(v, min, max));
  return (
    <div className="mb-2">
      <div className="d-flex align-items-center justify-content-between">
        <span style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', fontWeight: 600 }}>{label}</span>
        <div className="d-flex align-items-center gap-2">
          <button type="button" aria-label={`Decrease ${label}`} className="btn btn-sm btn-outline-secondary" style={{ width: 30, height: 30, borderRadius: 8, padding: 0, lineHeight: 1 }}
            onClick={() => set(value - 1)} disabled={value <= min}>−</button>
          <span style={{ minWidth: 24, textAlign: 'center', fontWeight: 800, color, fontVariantNumeric: 'tabular-nums' }} aria-live="polite">{value}</span>
          <button type="button" aria-label={`Increase ${label}`} className="btn btn-sm btn-outline-secondary" style={{ width: 30, height: 30, borderRadius: 8, padding: 0, lineHeight: 1 }}
            onClick={() => set(value + 1)} disabled={value >= max}>+</button>
        </div>
      </div>
      {hint && <div style={{ fontSize: '0.66rem', color: 'var(--text-muted)' }}>{hint}</div>}
    </div>
  );
}

function Toggle({ label, checked, onChange, hint }) {
  return (
    <div className="mb-2">
      <label className="d-flex align-items-center justify-content-between" style={{ cursor: 'pointer' }}>
        <span style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', fontWeight: 600 }}>{label}</span>
        <span className="form-check form-switch m-0">
          <input className="form-check-input" type="checkbox" role="switch" checked={checked} onChange={(e) => onChange(e.target.checked)} style={{ cursor: 'pointer' }} />
        </span>
      </label>
      {hint && <div style={{ fontSize: '0.66rem', color: 'var(--text-muted)' }}>{hint}</div>}
    </div>
  );
}

function WeekTab({ active, label, value, onClick }) {
  return (
    <button type="button" onClick={onClick} className="btn btn-sm px-3 flex-shrink-0"
      style={{
        borderRadius: 10, fontSize: '0.72rem', fontWeight: 700, whiteSpace: 'nowrap',
        background: active ? 'var(--accent-soft)' : 'var(--surface-2)',
        color: active ? 'var(--accent)' : 'var(--text-secondary)',
        border: `1px solid ${active ? 'color-mix(in srgb, var(--accent) 40%, transparent)' : 'transparent'}`,
      }}>
      {label}{value != null && <span className="ms-1" style={{ opacity: 0.75 }}>· {value}</span>}
    </button>
  );
}

function ControlCard({ icon, title, weight, pillarValue, dropped, children }) {
  const lv = pillarValue == null ? null : getLevelTokens(pillarValue);
  return (
    <div className="card border-0 shadow-sm mb-3" style={{ borderRadius: 14 }}>
      <div className="card-body p-3 p-md-4">
        <div className="d-flex align-items-center justify-content-between mb-3">
          <h6 className="fw-bold mb-0 d-inline-flex align-items-center gap-2" style={{ fontSize: '0.92rem' }}>
            <i className={`bi ${icon}`} style={{ color: 'var(--accent)' }} />
            {title}
            <span className="badge rounded-pill" style={{ background: 'var(--surface-2)', color: 'var(--text-muted)', fontWeight: 700, fontSize: '0.62rem' }}>{weight}% of score</span>
          </h6>
          {dropped ? (
            <span className="badge rounded-pill" style={{ background: 'var(--surface-2)', color: 'var(--text-muted)', fontWeight: 700 }}>Not counted</span>
          ) : lv && (
            <span className="badge rounded-pill" style={{ background: lv.bg, color: lv.color, fontWeight: 800, fontSize: '0.8rem' }}>{Math.round(pillarValue)}<span style={{ opacity: 0.7 }}>/100</span></span>
          )}
        </div>
        {children}
      </div>
    </div>
  );
}

export default function PerformanceSimulatorPage() {
  const { profile } = useAuth();
  const navigate = useNavigate();
  const uid = profile?.id;
  const role = String(profile?.role || '').toLowerCase();
  const month = currentMonth();

  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState('');
  const [weights, setWeights] = useState({ performance: 40, incentives: 25, attendance: 20, flags: 15 });
  const [real, setReal] = useState({ perf: null, inc: null, att: null, flags: null, composite: null, level: null });

  const [mode, setMode] = useState('metric'); // 'tl' | 'apc' | 'metric'
  const [weeklyLive, setWeeklyLive] = useState(false);

  // ── Simulation state ──
  const [apcWeeks, setApcWeeks] = useState([]);
  const [activeApc, setActiveApc] = useState(0);
  const [simMetrics, setSimMetrics] = useState({ dailyTasksQuality: 0, reporting: 0, overallWorkflow: 0, responseTime: 0, tasksProcessing: 0 });
  const [tlWeeks, setTlWeeks] = useState([]);   // [{ label, stars }]
  const [simTeam, setSimTeam] = useState(0);
  const [simHasTeam, setSimHasTeam] = useState(true);
  const [simN, setSimN] = useState(0);
  const [simD, setSimD] = useState(0);
  const [simHasReports, setSimHasReports] = useState(true);
  const [includeInc, setIncludeInc] = useState(false);
  const [simIncPct, setSimIncPct] = useState(0);
  const [simVerified, setSimVerified] = useState(true);
  const [simAtt, setSimAtt] = useState(0);
  const [simGreen, setSimGreen] = useState(0);
  const [simRed, setSimRed] = useState(0);
  const [goal, setGoal] = useState(90);
  const [initial, setInitial] = useState(null);

  useEffect(() => {
    if (!uid) return;
    let cancelled = false;
    (async () => {
      setLoading(true); setErr('');
      try {
        const [w, comp, tlCfg, wkCfg] = await Promise.all([
          getV1Weights().catch(() => ({ performance: 40, incentives: 25, attendance: 20, flags: 15 })),
          getCompositeFor(uid, month).catch(() => null),
          getTlPerfEnabled().catch(() => ({ enabled: false, since: null })),
          getWeeklyRatingsEnabled().catch(() => ({ enabled: false, since: null })),
        ]);
        if (cancelled) return;
        setWeights(w);

        const tlLive = tlCfg.enabled && month >= (tlCfg.since || '2026-08-01').slice(0, 7);
        const wkLive = wkCfg.enabled && month >= (wkCfg.since || '2026-08-01').slice(0, 7);
        setWeeklyLive(wkLive);
        const m = (role === 'tl' && tlLive) ? 'tl' : (role === 'apc' && wkLive) ? 'apc' : 'metric';
        setMode(m);

        const realPerf = comp?.performance_score ?? null;
        const realInc = comp?.incentives_score ?? null;
        const realAtt = comp?.attendance_score ?? null;
        const realFlags = comp?.flags_score ?? null;
        setReal({ perf: realPerf, inc: realInc, att: realAtt, flags: realFlags, composite: comp?.composite_score ?? null, level: comp?.level ?? null });

        // ---- role-specific Performance pre-fill ----
        let weeks = [], metricVals = { dailyTasksQuality: 0, reporting: 0, overallWorkflow: 0, responseTime: 0, tasksProcessing: 0 };
        let tlW = [], team = 0, hasTeam = true, n = 0, d = 0, hasReports = true;

        if (m === 'tl') {
          const pv = await tlPerfPreview(uid, month).catch(() => null);
          if (!cancelled && pv) {
            hasTeam = pv.team != null; team = pv.team != null ? pv.team : 0;
            n = pv.n || 0; d = pv.deductions || 0; hasReports = pv.accountability != null;
          }
          // Per-week OL star ratings from the TL's own agenda meetings (read-only).
          const meetings = await listAgendaMeetings().catch(() => []);
          const mine = (meetings || [])
            .filter((mt) => mt.tl_id === uid && String(mt.meeting_date || '').slice(0, 7) === month && mt.tl_reporting_stars != null)
            .sort((a, b) => (a.meeting_date < b.meeting_date ? -1 : 1));
          tlW = mine.map((mt, i) => ({ label: `Wk ${i + 1}`, stars: Number(mt.tl_reporting_stars) || 0 }));
          // Fallback so parity holds if the meeting rows aren't readable but a star avg exists.
          if (!tlW.length && pv?.starAvg != null) tlW = [{ label: 'Wk 1', stars: pv.starAvg }];
        } else if (m === 'apc') {
          const rows = await listWeeklyRatingsForApcMonth(uid, month).catch(() => []);
          weeks = (rows || []).map((r, i) => seedApcWeek(r.metrics, `Wk ${i + 1}`));
          if (!weeks.length) { const r = await getRatingFor(uid, month).catch(() => null); weeks = [seedApcWeek(r?.metrics || {}, 'Wk 1')]; }
        } else {
          const r = await getRatingFor(uid, month).catch(() => null);
          const mm = r?.metrics || {};
          metricVals = {
            dailyTasksQuality: Number(mm.dailyTasksQuality) || 0, reporting: Number(mm.reporting) || 0,
            overallWorkflow: Number(mm.overallWorkflow) || 0, responseTime: Number(mm.responseTime) || 0, tasksProcessing: Number(mm.tasksProcessing) || 0,
          };
        }

        // ---- incentives (own row) ----
        let incPct = 0, hasPlan = false, verified = true;
        try {
          const rows = await listAllIncentivesForMonth(month);
          const mine = (rows || []).find((r) => r.user_id === uid || r.userId === uid);
          if (mine) {
            const items = [...(mine.incentives || []), ...(mine.bonuses || [])];
            hasPlan = items.length > 0; verified = !!mine.verified;
            if (hasPlan) incPct = realInc != null ? realInc : Math.round((items.filter((i) => i.completed).length / items.length) * 100);
          }
        } catch { /* leave defaults */ }

        // ---- flags (own, this month) ----
        let g = 0, rr = 0;
        try {
          const flags = await listFlags(uid, { month });
          g = (flags || []).filter((f) => f.type === 'green').length;
          rr = (flags || []).filter((f) => f.type !== 'green').length;
        } catch { /* leave 0/0 */ }

        if (cancelled) return;
        const att = realAtt != null ? realAtt : 0; // exact 1-dp — the real composite feeds it unrounded

        setApcWeeks(weeks); setActiveApc(0); setSimMetrics(metricVals);
        setTlWeeks(tlW); setSimTeam(team); setSimHasTeam(hasTeam); setSimN(n); setSimD(d); setSimHasReports(hasReports);
        setIncludeInc(hasPlan); setSimIncPct(incPct); setSimVerified(verified);
        setSimAtt(att); setSimGreen(g); setSimRed(rr);
        setInitial({
          apcWeeks: clone(weeks), metrics: metricVals, tlWeeks: clone(tlW), team, hasTeam, n, d, hasReports,
          includeInc: hasPlan, incPct, verified, att, green: g, red: rr,
        });
      } catch (e) {
        if (!cancelled) setErr(e?.message || 'Could not load your performance data.');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [uid, role, month]);

  // ── Derived pillar scores (the SAME math the real score uses) ──
  const simPerf = useMemo(
    () => computePerf(mode, { apcWeeks, metrics: simMetrics, tlWeeks, team: simTeam, hasTeam: simHasTeam, n: simN, d: simD, hasReports: simHasReports }),
    [mode, apcWeeks, simMetrics, tlWeeks, simTeam, simHasTeam, simN, simD, simHasReports],
  );

  const simIncScore = includeInc ? clamp(Math.round(simIncPct), 0, 100) : null;
  const simFlagsScore = clamp(80 + simGreen * 10 - simRed * 20, 0, 100);
  const simAttScore = clamp(simAtt, 0, 100);

  // A null Performance pillar → composite is withheld ('Not rated'), exactly like
  // get_performance_composite (mig 271:275-276) — don't fabricate a number.
  const simComposite = useMemo(
    () => (simPerf == null ? null : calcComposite({ performance: simPerf, incentives: simIncScore, attendance: simAttScore, flags: simFlagsScore }, weights)),
    [simPerf, simIncScore, simAttScore, simFlagsScore, weights],
  );

  const withheldReason = simPerf == null
    ? 'Performance is not rated yet — add a week or set your team to explore.'
    : (includeInc && !simVerified && simIncScore != null)
      ? 'In reality, your final score stays hidden until your OL verifies your incentives.'
      : null;

  const NOT_RATED_LEVEL = { label: 'Not rated', color: 'var(--text-muted)', bg: 'var(--surface-2)', icon: 'bi-hourglass-split' };
  const level = simComposite == null ? NOT_RATED_LEVEL : getLevelTokens(simComposite);

  const pillarRows = useMemo(() => {
    const defs = [
      { key: 'performance', label: 'Performance', score: simPerf, weight: weights.performance, icon: 'bi-bar-chart-fill' },
      { key: 'incentives', label: 'Bonus & Incentives', score: simIncScore, weight: weights.incentives, icon: 'bi-award-fill' },
      { key: 'attendance', label: 'Attendance', score: simAttScore, weight: weights.attendance, icon: 'bi-calendar-check' },
      { key: 'flags', label: 'Monthly Flags', score: simFlagsScore, weight: weights.flags, icon: 'bi-flag-fill' },
    ];
    const present = defs.filter((d) => d.score != null);
    const totalW = present.reduce((a, d) => a + (d.weight || 0), 0) || 1;
    return defs.map((d) => ({
      ...d, present: d.score != null,
      effWeight: d.score != null ? (d.weight / totalW) * 100 : 0,
      contribution: d.score != null ? (d.score * d.weight) / totalW : 0,
    }));
  }, [simPerf, simIncScore, simAttScore, simFlagsScore, weights]);

  const goalSeek = useMemo(() => {
    const others = pillarRows.filter((p) => p.key !== 'performance' && p.present);
    const perfW = weights.performance || 0;
    const totalW = perfW + others.reduce((a, p) => a + p.weight, 0);
    const otherWS = others.reduce((a, p) => a + p.score * p.weight, 0);
    if (perfW <= 0 || totalW <= 0) return null;
    const need = Math.ceil(Math.max(0, ((goal - 0.5) * totalW - otherWS) / perfW));
    return { need, reachable: need <= 100, maxComposite: Math.round((otherWS + 100 * perfW) / totalW), current: simPerf };
  }, [pillarRows, weights, goal, simPerf]);

  // ── APC week editing helpers ──
  const setApcWeekField = (idx, key, v) => setApcWeeks((prev) => prev.map((w, i) => (i === idx ? { ...w, [key]: v } : w)));
  const addApcWeek = () => {
    setApcWeeks((prev) => [...prev, { ...(prev[prev.length - 1] || { dailyTasksQuality: 0, overallWorkflow: 0, responseTime: 0, tasksProcessing: 0, repOl: 90, repDocks: 0, cpDocks: 0 }), label: `Wk ${prev.length + 1}` }]);
    setActiveApc(apcWeeks.length); // current length = the new week's index
  };
  const removeApcWeek = (idx) => {
    if (apcWeeks.length <= 1) return;
    setApcWeeks((prev) => prev.filter((_, i) => i !== idx).map((w, i) => ({ ...w, label: `Wk ${i + 1}` })));
    setActiveApc((a) => Math.min(a, apcWeeks.length - 2));
  };
  const setTlWeekStars = (idx, v) => setTlWeeks((prev) => prev.map((w, i) => (i === idx ? { ...w, stars: v } : w)));
  const addTlWeek = () => setTlWeeks((prev) => [...prev, { label: `Wk ${prev.length + 1}`, stars: prev[prev.length - 1]?.stars ?? 4 }]);
  const removeTlWeek = (idx) => setTlWeeks((prev) => prev.filter((_, i) => i !== idx).map((w, i) => ({ ...w, label: `Wk ${i + 1}` })));

  const reset = () => {
    if (!initial) return;
    setApcWeeks(clone(initial.apcWeeks)); setActiveApc(0); setSimMetrics(initial.metrics); setTlWeeks(clone(initial.tlWeeks));
    setSimTeam(initial.team); setSimHasTeam(initial.hasTeam); setSimN(initial.n); setSimD(initial.d); setSimHasReports(initial.hasReports);
    setIncludeInc(initial.includeInc); setSimIncPct(initial.incPct); setSimVerified(initial.verified);
    setSimAtt(initial.att); setSimGreen(initial.green); setSimRed(initial.red);
  };

  // Changed from real numbers? Compare the DERIVED pillar scores (what actually
  // feeds the composite) against the initial baseline — so a slider nudge that
  // doesn't move any pillar (and so can't move the composite) never shows a
  // phantom delta, and any real change does. Robust to off-grid decimal seeds.
  const dirty = useMemo(() => {
    if (!initial) return false;
    const perf0 = computePerf(mode, { apcWeeks: initial.apcWeeks, metrics: initial.metrics, tlWeeks: initial.tlWeeks, team: initial.team, hasTeam: initial.hasTeam, n: initial.n, d: initial.d, hasReports: initial.hasReports });
    const inc0 = initial.includeInc ? clamp(Math.round(initial.incPct), 0, 100) : null;
    const att0 = clamp(initial.att, 0, 100);
    const flags0 = clamp(80 + initial.green * 10 - initial.red * 20, 0, 100);
    return simPerf !== perf0 || simIncScore !== inc0 || simAttScore !== att0 || simFlagsScore !== flags0;
  }, [initial, mode, simPerf, simIncScore, simAttScore, simFlagsScore]);

  const roleLabel = ROLE_LABEL[role] || role.toUpperCase();
  const realCompositeText = real.composite != null ? real.composite
    : real.level === 'pending_verification' ? 'Withheld' : real.perf == null ? 'Not rated' : '—';
  const delta = (dirty && real.composite != null && simComposite != null) ? simComposite - real.composite : null;

  const starScoreNow = tlStarScore(tlWeeks);
  const acctNow = (simHasReports && simN > 0) ? clamp(Math.max(0, simN - simD) / simN * 100, 0, 100) : null;
  const reportingNow = tlReportingScore(starScoreNow, acctNow);
  const aw = apcWeeks[activeApc];

  if (!uid) return null;

  return (
    <div>
      <div className="page-header d-flex flex-wrap align-items-start justify-content-between gap-3">
        <div>
          <h1 className="page-title d-inline-flex align-items-center gap-2"><i className="bi bi-sliders" style={{ color: 'var(--accent)' }} />Performance Simulator</h1>
          <p className="page-subtitle mb-0">See exactly how your monthly score is built — week by week — then try what-if scenarios for {monthLabel(month)}.</p>
        </div>
        <button className="btn btn-sm btn-outline-secondary rounded-pill px-3 flex-shrink-0" onClick={() => navigate('/performance')}>
          <i className="bi bi-arrow-left me-1" />Back to Performance
        </button>
      </div>

      <div className="rounded-3 p-2 px-3 mb-4 d-inline-flex align-items-center gap-2"
        style={{ background: 'color-mix(in srgb, var(--info,#0d6efd) 12%, transparent)', border: '1px solid color-mix(in srgb, var(--info,#0d6efd) 30%, transparent)' }}>
        <i className="bi bi-shield-lock-fill" style={{ color: 'var(--info,#0d6efd)' }} />
        <span style={{ fontSize: '0.76rem', color: 'var(--text-secondary)' }}>This is a private what-if tool. Nothing here ever changes your real score or salary — it only reads your current numbers to start you off.</span>
      </div>

      {loading ? (
        <div className="text-muted small d-flex align-items-center gap-2"><span className="spinner-border spinner-border-sm" /> Loading your performance…</div>
      ) : err ? (
        <div className="rounded-3 p-3" style={{ background: 'var(--danger-soft)', border: '1px solid color-mix(in srgb, var(--danger) 35%, transparent)', color: 'var(--danger)', fontSize: '0.85rem' }}>
          <i className="bi bi-exclamation-triangle me-2" />{err}
        </div>
      ) : (
        <>
          {/* ── How your score works (role-aware explainer) ── */}
          <div className="card border-0 shadow-sm mb-4" style={{ borderRadius: 14, overflow: 'hidden' }}>
            <div style={{ height: 4, background: 'linear-gradient(90deg, var(--accent), color-mix(in srgb, var(--accent) 40%, transparent))' }} />
            <div className="card-body p-3 p-md-4">
              <h6 className="fw-bold mb-3" style={{ fontSize: '0.95rem' }}><i className="bi bi-info-circle me-2" style={{ color: 'var(--accent)' }} />How your score is built ({roleLabel})</h6>
              <p style={{ fontSize: '0.82rem', color: 'var(--text-secondary)' }} className="mb-3">Your monthly <strong>Composite Score</strong> is a weighted average of four pillars. If you have no incentive plan in a month, that 25% is shared out among the other three.</p>
              <div className="d-flex flex-wrap gap-2 mb-3">
                {[{ label: 'Performance', w: weights.performance, icon: 'bi-bar-chart-fill' }, { label: 'Bonus & Incentives', w: weights.incentives, icon: 'bi-award-fill' }, { label: 'Attendance', w: weights.attendance, icon: 'bi-calendar-check' }, { label: 'Monthly Flags', w: weights.flags, icon: 'bi-flag-fill' }].map((p) => (
                  <div key={p.label} className="rounded-3 px-3 py-2 d-inline-flex align-items-center gap-2" style={{ background: 'var(--surface-2)' }}>
                    <i className={`bi ${p.icon}`} style={{ color: 'var(--accent)' }} />
                    <span style={{ fontSize: '0.78rem', color: 'var(--text-primary)', fontWeight: 600 }}>{p.label}</span>
                    <span className="badge rounded-pill" style={{ background: 'var(--accent-soft)', color: 'var(--accent)', fontWeight: 800 }}>{p.w}%</span>
                  </div>
                ))}
              </div>
              <div className="rounded-3 p-3" style={{ background: 'var(--surface-2)', fontSize: '0.78rem', color: 'var(--text-secondary)' }}>
                <div className="fw-semibold mb-1" style={{ color: 'var(--text-primary)' }}><i className="bi bi-bar-chart-fill me-2" style={{ color: 'var(--accent)' }} />Your Performance pillar (40%)</div>
                {mode === 'tl' ? (
                  <ul className="mb-0 ps-3">
                    <li><strong>60% your team</strong> — the average of your APCs' overall scores.</li>
                    <li><strong>40% your reporting</strong> = 60% your OL's star rating (given <strong>each week</strong>, averaged ×20) + 40% report accountability (verified reports − deductions) ÷ verified.</li>
                  </ul>
                ) : mode === 'apc' ? (
                  <ul className="mb-0 ps-3">
                    <li>Rated <strong>every week</strong> after you present — your month is the <strong>average of those weekly ratings</strong>. Each week = the average of 5 metrics.</li>
                    <li><strong>Reporting</strong> (per week) = your OL's 0–90 rating + up to 5 for clean reports + up to 5 for clean checkpoints. Each returned/docked report or checkpoint lowers it.</li>
                  </ul>
                ) : (
                  <ul className="mb-0 ps-3"><li>The average of <strong>5 things your manager rates 0–100</strong>: daily task quality, reporting, overall workflow, response time, tasks processing.</li></ul>
                )}
                <div className="mt-2" style={{ fontSize: '0.74rem' }}>
                  <span className="fw-semibold" style={{ color: 'var(--text-primary)' }}>Attendance</span> = your monthly coverage % (weekends &amp; holidays already count). ·
                  <span className="fw-semibold ms-1" style={{ color: 'var(--text-primary)' }}>Incentives</span> = how much of your plan you complete (an item counts at ≥90% of its target). ·
                  <span className="fw-semibold ms-1" style={{ color: 'var(--text-primary)' }}>Flags</span> = start at 80, +10 green, −20 red.
                </div>
                <div className="mt-2" style={{ fontSize: '0.74rem', color: 'var(--text-muted)' }}><i className="bi bi-lock me-1" />If you have an incentive plan, your final score stays hidden until your OL verifies it. Levels: <strong>90+ Promotion</strong> · 70+ Good · 50+ Warning · below 50 Termination.</div>
              </div>
            </div>
          </div>

          <div className="row g-4">
            {/* ── LEFT: what-if controls (below the result on mobile) ── */}
            <div className="col-lg-7 order-2 order-lg-1">
              <div className="d-flex align-items-center justify-content-between mb-2">
                <h6 className="fw-bold mb-0" style={{ fontSize: '0.95rem' }}><i className="bi bi-sliders me-2" style={{ color: 'var(--accent)' }} />Try a scenario</h6>
                <button className="btn btn-sm btn-outline-secondary rounded-pill px-3" onClick={reset} style={{ fontSize: '0.72rem' }}><i className="bi bi-arrow-counterclockwise me-1" />Reset to my real numbers</button>
              </div>

              {/* Performance pillar */}
              <ControlCard icon="bi-bar-chart-fill" title="Performance" weight={weights.performance} pillarValue={simPerf}>
                {mode === 'tl' ? (
                  <>
                    <div className="mb-3">
                      <div className="fw-semibold mb-2" style={{ fontSize: '0.76rem', color: 'var(--text-primary)' }}>Team (60% of Performance){!simHasTeam && <span className="text-muted ms-1" style={{ fontWeight: 500 }}>· not counted yet</span>}</div>
                      <Slider label="Your team's average score" value={simTeam} onChange={(v) => { setSimTeam(v); setSimHasTeam(true); }} suffix="/100"
                        hint={simHasTeam ? 'The average overall score of your APCs.' : 'No APCs are rated yet, so team is dropped and reporting is your whole Performance. Drag to simulate a team.'} />
                    </div>
                    <div className="pt-2" style={{ borderTop: '1px dashed var(--border-subtle)' }}>
                      <div className="d-flex align-items-center justify-content-between mb-2 mt-1">
                        <div className="fw-semibold" style={{ fontSize: '0.76rem', color: 'var(--text-primary)' }}>OL star rating — each week (60% of reporting)</div>
                        <button className="btn btn-sm btn-outline-secondary" style={{ borderRadius: 8, fontSize: '0.68rem', padding: '2px 8px' }} onClick={addTlWeek}><i className="bi bi-plus" />Add week</button>
                      </div>
                      {tlWeeks.length === 0 && <div className="rounded-2 px-2 py-2 mb-2" style={{ background: 'var(--surface-2)', fontSize: '0.7rem', color: 'var(--text-muted)' }}>No weekly star ratings yet — add a week to simulate them.</div>}
                      {tlWeeks.map((wk, i) => (
                        <div key={i} className="d-flex align-items-center gap-2 mb-1">
                          <span className="flex-shrink-0" style={{ fontSize: '0.72rem', color: 'var(--text-secondary)', fontWeight: 700, minWidth: 42 }}>{wk.label}</span>
                          <input type="range" className="form-range flex-grow-1" min={0} max={5} step={0.5} value={wk.stars}
                            aria-label={`${wk.label} star rating`} onChange={(e) => setTlWeekStars(i, Number(e.target.value))} style={{ '--range-c': 'var(--accent)' }} />
                          <span className="flex-shrink-0" style={{ fontWeight: 800, minWidth: 34, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{wk.stars}★</span>
                          <button className="btn btn-sm btn-link text-muted p-0 flex-shrink-0" style={{ fontSize: '0.7rem' }} aria-label={`Remove ${wk.label}`} onClick={() => removeTlWeek(i)}><i className="bi bi-x-lg" /></button>
                        </div>
                      ))}
                      <div className="mt-2 mb-2" style={{ fontSize: '0.66rem', color: 'var(--text-muted)' }}>Monthly star score = {starScoreNow == null ? 'n/a' : `${Math.round(starScoreNow)}/100`} (avg stars × 20).</div>
                      <div className="fw-semibold mb-2 mt-3" style={{ fontSize: '0.76rem', color: 'var(--text-primary)' }}>Report accountability (40% of reporting)</div>
                      <div className="row g-2">
                        <div className="col-6"><Stepper label="Reports verified (N)" value={simN} min={0} max={40} onChange={(v) => { setSimN(v); setSimHasReports(true); }} /></div>
                        <div className="col-6"><Stepper label="Deductions (D)" value={simD} min={0} max={40} onChange={setSimD} color="var(--danger)" /></div>
                      </div>
                      <div style={{ fontSize: '0.66rem', color: 'var(--text-muted)' }}>Accountability = {acctNow == null ? 'n/a' : `${Math.round(acctNow)}/100`} · Reporting blends to {reportingNow == null ? 'n/a' : `${Math.round(reportingNow)}/100`}.</div>
                    </div>
                  </>
                ) : mode === 'apc' ? (
                  <>
                    <div className="mb-2" style={{ fontSize: '0.72rem', color: 'var(--text-muted)' }}>Your month = the average of your weekly ratings. Pick a week to edit it, or add a what-if week.</div>
                    <div className="d-flex gap-2 flex-nowrap mb-3" style={{ overflowX: 'auto', paddingBottom: 4 }}>
                      {apcWeeks.map((wk, i) => <WeekTab key={i} active={i === activeApc} label={wk.label} value={apcWeekOverall(wk)} onClick={() => setActiveApc(i)} />)}
                      <button type="button" className="btn btn-sm flex-shrink-0" style={{ borderRadius: 10, fontSize: '0.72rem', fontWeight: 700, border: '1px dashed var(--border-strong)', color: 'var(--text-secondary)' }} onClick={addApcWeek}><i className="bi bi-plus" />Week</button>
                    </div>
                    {aw && (
                      <div className="rounded-3 p-3" style={{ background: 'var(--surface-2)' }}>
                        <div className="d-flex align-items-center justify-content-between mb-2">
                          <span style={{ fontSize: '0.78rem', fontWeight: 800, color: 'var(--text-primary)' }}>{aw.label}</span>
                          <div className="d-flex align-items-center gap-2">
                            <span className="badge rounded-pill" style={{ background: getLevelTokens(apcWeekOverall(aw)).bg, color: getLevelTokens(apcWeekOverall(aw)).color, fontWeight: 800 }}>{apcWeekOverall(aw)}<span style={{ opacity: 0.7 }}>/100</span></span>
                            {apcWeeks.length > 1 && <button className="btn btn-sm btn-link text-muted p-0" style={{ fontSize: '0.7rem' }} onClick={() => removeApcWeek(activeApc)}>Remove</button>}
                          </div>
                        </div>
                        <Slider label="Daily task quality" value={Math.round(aw.dailyTasksQuality)} onChange={(v) => setApcWeekField(activeApc, 'dailyTasksQuality', v)} suffix="/100" />
                        {/* Reporting split — the return docks */}
                        <div className="rounded-3 p-2 mb-3" style={{ background: 'var(--surface-1)' }}>
                          <div className="d-flex justify-content-between align-items-baseline mb-1">
                            <span style={{ fontSize: '0.8rem', color: 'var(--text-primary)', fontWeight: 700 }}><i className="bi bi-file-earmark-text me-1" />Reporting</span>
                            <span className="badge rounded-pill" style={{ background: getLevelTokens(apcWeekReporting(aw)).bg, color: getLevelTokens(apcWeekReporting(aw)).color, fontWeight: 800 }}>{Math.round(apcWeekReporting(aw))}<span style={{ opacity: 0.7 }}>/100</span></span>
                          </div>
                          <Slider label="Your OL's reporting rating" value={aw.repOl} min={0} max={90} onChange={(v) => setApcWeekField(activeApc, 'repOl', v)} suffix="/90" accent="var(--accent)" />
                          <div className="row g-2">
                            <div className="col-6"><Stepper label="Reports returned" value={aw.repDocks} min={0} max={5} onChange={(v) => setApcWeekField(activeApc, 'repDocks', v)} color="var(--danger)" hint={`report chunk ${Math.max(0, 5 - aw.repDocks)}/5`} /></div>
                            <div className="col-6"><Stepper label="Checkpoints returned" value={aw.cpDocks} min={0} max={5} onChange={(v) => setApcWeekField(activeApc, 'cpDocks', v)} color="var(--danger)" hint={`checkpoint chunk ${Math.max(0, 5 - aw.cpDocks)}/5`} /></div>
                          </div>
                          <div style={{ fontSize: '0.64rem', color: 'var(--text-muted)' }}>OL rating (0–90) + up to 5 for clean reports + up to 5 for clean checkpoints. Every return your TL sends back docks a point.</div>
                        </div>
                        <Slider label="Overall workflow" value={Math.round(aw.overallWorkflow)} onChange={(v) => setApcWeekField(activeApc, 'overallWorkflow', v)} suffix="/100" />
                        <Slider label="Response time" value={Math.round(aw.responseTime)} onChange={(v) => setApcWeekField(activeApc, 'responseTime', v)} suffix="/100" />
                        <Slider label="Tasks processing" value={Math.round(aw.tasksProcessing)} onChange={(v) => setApcWeekField(activeApc, 'tasksProcessing', v)} suffix="/100" />
                      </div>
                    )}
                    <div className="mt-2" style={{ fontSize: '0.68rem', color: 'var(--text-muted)' }}>Month Performance <strong style={{ color: 'var(--text-secondary)' }}>{simPerf}/100</strong> — each metric averaged across {apcWeeks.length} week{apcWeeks.length === 1 ? '' : 's'} (so it can differ by a point from the rounded week badges).</div>
                  </>
                ) : (
                  <>
                    {V1_METRICS.map((mt) => (
                      <Slider key={mt.key} label={mt.label} value={Math.round(Number(simMetrics[mt.key]) || 0)} onChange={(v) => setSimMetrics((prev) => ({ ...prev, [mt.key]: v }))} suffix="/100" />
                    ))}
                    <div style={{ fontSize: '0.66rem', color: 'var(--text-muted)' }}>Performance = the average of these five.</div>
                  </>
                )}
              </ControlCard>

              {/* Incentives */}
              <ControlCard icon="bi-award-fill" title="Bonus & Incentives" weight={weights.incentives} pillarValue={simIncScore} dropped={!includeInc}>
                <Toggle label="I have an incentive plan this month" checked={includeInc} onChange={setIncludeInc} hint={includeInc ? undefined : 'With no plan, this 25% is shared among the other three pillars.'} />
                {includeInc && (
                  <>
                    <Slider label="Plan completion" value={simIncPct} onChange={setSimIncPct} suffix="%" hint="= completed items ÷ total items. An item completes at ≥90% of its own target." />
                    <Toggle label="OL has verified my incentives" checked={simVerified} onChange={setSimVerified} hint="Until this is on, your final composite stays hidden (the pillar value still counts once verified)." />
                  </>
                )}
              </ControlCard>

              {/* Attendance */}
              <ControlCard icon="bi-calendar-check" title="Attendance" weight={weights.attendance} pillarValue={simAttScore}>
                <Slider label="Monthly coverage" value={simAtt} onChange={setSimAtt} suffix="%" hint="Weekends, holidays and approved leave are already covered — each missed weekday lowers this." />
              </ControlCard>

              {/* Flags */}
              <ControlCard icon="bi-flag-fill" title="Monthly Flags" weight={weights.flags} pillarValue={simFlagsScore}>
                <div className="row g-2">
                  <div className="col-6"><Stepper label="Green flags" value={simGreen} min={0} max={5} onChange={setSimGreen} color="var(--success)" /></div>
                  <div className="col-6"><Stepper label="Red flags" value={simRed} min={0} max={5} onChange={setSimRed} color="var(--danger)" /></div>
                </div>
                <div style={{ fontSize: '0.66rem', color: 'var(--text-muted)' }}>Starts at 80 · +10 per green · −20 per red.</div>
              </ControlCard>
            </div>

            {/* ── RIGHT: live result + goal-seek (shown first on mobile) ── */}
            <div className="col-lg-5 order-1 order-lg-2">
              <div style={{ position: 'sticky', top: 'calc(var(--topbar-h, 68px) + 16px)' }}>
                <div className="card border-0 shadow-sm mb-3" style={{ borderRadius: 16, overflow: 'hidden' }}>
                  <div style={{ height: 4, background: `linear-gradient(90deg, ${level.color}, color-mix(in srgb, ${level.color} 45%, transparent))` }} />
                  <div className="card-body p-4 text-center">
                    <div className="text-uppercase" style={{ fontSize: '0.66rem', fontWeight: 800, letterSpacing: '0.08em', color: 'var(--text-muted)' }}>Simulated composite</div>
                    <div className="d-inline-flex align-items-center justify-content-center rounded-circle my-2" style={{ width: 118, height: 118, background: level.bg, border: `4px solid ${level.color}` }}>
                      <span className="fw-bold" style={{ fontSize: simComposite == null ? '1.2rem' : '2.6rem', color: level.color, fontVariantNumeric: 'tabular-nums' }}>{simComposite == null ? 'Not rated' : simComposite}</span>
                    </div>
                    <div className="d-flex align-items-center justify-content-center gap-1"><i className={`bi ${level.icon}`} style={{ color: level.color }} /><span className="fw-bold" style={{ color: level.color }}>{level.label}</span></div>
                    <div className="d-flex align-items-center justify-content-center gap-2 mt-2" style={{ fontSize: '0.74rem', color: 'var(--text-muted)' }}>
                      <span>Your current: <strong style={{ color: 'var(--text-secondary)' }}>{realCompositeText}</strong></span>
                      {delta != null && delta !== 0 && (
                        <span className="badge rounded-pill" style={{ background: delta > 0 ? 'var(--success-soft)' : 'var(--danger-soft)', color: delta > 0 ? 'var(--success)' : 'var(--danger)', fontWeight: 800 }}><i className={`bi ${delta > 0 ? 'bi-arrow-up' : 'bi-arrow-down'}`} /> {Math.abs(delta)}</span>
                      )}
                    </div>
                    {withheldReason && <div className="rounded-2 mt-3 px-2 py-2 text-start d-flex gap-2" style={{ background: 'var(--warning-soft)', fontSize: '0.68rem', color: 'var(--warning)' }}><i className="bi bi-info-circle mt-1" /><span>{withheldReason}</span></div>}
                  </div>
                </div>

                <div className="card border-0 shadow-sm mb-3" style={{ borderRadius: 14 }}>
                  <div className="card-body p-3 p-md-4">
                    <h6 className="fw-bold mb-3" style={{ fontSize: '0.85rem' }}><i className="bi bi-layers me-2" />What's driving it</h6>
                    {pillarRows.map((p) => (
                      <div key={p.key} className="mb-2">
                        <div className="d-flex align-items-center justify-content-between" style={{ fontSize: '0.74rem' }}>
                          <span style={{ color: 'var(--text-secondary)', fontWeight: 600 }}><i className={`bi ${p.icon} me-1`} style={{ opacity: 0.7 }} />{p.label}</span>
                          {p.present ? <span style={{ color: 'var(--text-primary)', fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}>{Math.round(p.score)}<span className="text-muted" style={{ fontWeight: 500 }}> × {Math.round(p.effWeight)}% = {Math.round(p.contribution)}</span></span> : <span className="text-muted" style={{ fontSize: '0.68rem' }}>Not counted</span>}
                        </div>
                        <div className="rounded-pill overflow-hidden mt-1" style={{ height: 6, background: 'var(--surface-2)' }}>
                          <div className="h-100 rounded-pill" style={{ width: `${p.present ? p.score : 0}%`, background: p.present ? getLevelTokens(p.score).color : 'var(--border-default)', transition: 'width .35s' }} />
                        </div>
                      </div>
                    ))}
                  </div>
                </div>

                <div className="card border-0 shadow-sm" style={{ borderRadius: 14 }}>
                  <div className="card-body p-3 p-md-4">
                    <h6 className="fw-bold mb-2" style={{ fontSize: '0.85rem' }}><i className="bi bi-bullseye me-2" style={{ color: 'var(--accent)' }} />Reach a goal</h6>
                    <Slider label="I want my composite to be" value={goal} min={40} max={100} onChange={setGoal} suffix=" +" accent="var(--accent)" />
                    {goalSeek && (
                      <div className="rounded-3 p-3 mt-1" style={{ background: 'var(--surface-2)', fontSize: '0.8rem' }}>
                        {goalSeek.reachable ? (
                          <><span style={{ color: 'var(--text-secondary)' }}>Keeping everything else as set, your </span><strong style={{ color: 'var(--text-primary)' }}>Performance pillar needs to be </strong><span className="badge rounded-pill" style={{ background: getLevelTokens(goalSeek.need).bg, color: getLevelTokens(goalSeek.need).color, fontWeight: 800, fontSize: '0.82rem' }}>{goalSeek.need}</span><span style={{ color: 'var(--text-muted)' }}> (now {goalSeek.current ?? 0}).</span></>
                        ) : (
                          <span style={{ color: 'var(--text-secondary)' }}>Performance alone can't reach {goal} — even at 100 your composite tops out at <strong>{goalSeek.maxComposite}</strong>. Raise your other pillars too.</span>
                        )}
                      </div>
                    )}
                    <div className="mt-2" style={{ fontSize: '0.66rem', color: 'var(--text-muted)' }}>Tip: set your attendance, incentives and flags first, then this tells you the Performance you'd need.</div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
