import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext';
import {
  getV1Weights, getCompositeFor, getRatingFor, listFlags, listAllIncentivesForMonth,
  calcMetricsAvg, calcComposite, getLevelTokens,
  currentMonth, ROLE_LABEL, V1_METRICS,
} from '../../lib/performanceApi';
import { getTlPerfEnabled, tlPerfPreview } from '../../lib/tlPerfApi';
import { getWeeklyRatingsEnabled } from '../../lib/weeklyRatingsApi';

// ============================================================
// Performance Simulator — a private, READ-ONLY what-if tool.
//
// Every number here is computed with the SAME functions the real Performance
// page scores with (calcComposite / calcMetricsAvg / getLevelTokens from
// performanceApi + the TL blend from migs 271/276), so a simulation always
// matches what the user would actually be scored. It NEVER writes anything —
// it only reads the user's own current values to pre-fill the sliders.
//
// Role-aware: a TL under the live method simulates 0.6·team + 0.4·reporting;
// everyone else simulates the 5 rated metrics. Attendance / incentives / flags
// are the same three pillars for all roles.
// ============================================================

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const monthLabel = (m) => { const [y, mm] = (m || '').split('-'); return mm ? `${MONTHS[+mm - 1]} ${y}` : m; };
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const roundHalf = (v) => Math.round(v * 2) / 2;

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

// ── Small presentational pieces (module scope so inputs never lose focus) ──
function Slider({ label, value, min = 0, max = 100, step = 1, onChange, suffix = '', hint, accent }) {
  // The slider VALUE stays exact (so decimals like a 96.8% attendance seed keep
  // composite parity); only the readout is rounded for whole-number sliders.
  const shown = step < 1 ? value : Math.round(value);
  const color = accent || getLevelTokens(Number(value)).color;
  return (
    <div className="mb-3">
      <div className="d-flex justify-content-between align-items-baseline mb-1">
        <span style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', fontWeight: 600 }}>{label}</span>
        <span style={{ fontWeight: 800, color: 'var(--text-primary)', fontVariantNumeric: 'tabular-nums' }}>
          {shown}{suffix}
        </span>
      </div>
      {/* --range-c drives the thumb/track via global.css .form-range theming
          (accent-color is inert under Bootstrap's appearance:none pseudo-bg). */}
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
          <input className="form-check-input" type="checkbox" role="switch" checked={checked}
            onChange={(e) => onChange(e.target.checked)} style={{ cursor: 'pointer' }} />
        </span>
      </label>
      {hint && <div style={{ fontSize: '0.66rem', color: 'var(--text-muted)' }}>{hint}</div>}
    </div>
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

  // Real (current) snapshot — read-only, for the "your current" reference.
  const [real, setReal] = useState({ perf: null, inc: null, att: null, flags: null, composite: null, level: null });

  // Method for THIS user + month.
  const [mode, setMode] = useState('metric'); // 'metric' | 'tl'
  const [weeklyLive, setWeeklyLive] = useState(false);

  // ── Simulation state ──────────────────────────────────────────
  const [simMetrics, setSimMetrics] = useState({ dailyTasksQuality: 0, reporting: 0, overallWorkflow: 0, responseTime: 0, tasksProcessing: 0 });
  const [simTeam, setSimTeam] = useState(0);
  const [simHasTeam, setSimHasTeam] = useState(true); // false when the TL has no rated APCs → team component drops
  const [simStars, setSimStars] = useState(0);      // 0..5
  const [simHasStars, setSimHasStars] = useState(true);
  const [simN, setSimN] = useState(0);              // reports verified
  const [simD, setSimD] = useState(0);              // deductions
  const [simHasReports, setSimHasReports] = useState(true);
  const [includeInc, setIncludeInc] = useState(false);
  const [simIncPct, setSimIncPct] = useState(0);
  const [simVerified, setSimVerified] = useState(true);
  const [simAtt, setSimAtt] = useState(0);
  const [simGreen, setSimGreen] = useState(0);
  const [simRed, setSimRed] = useState(0);

  const [goal, setGoal] = useState(90);

  // snapshot of the initial (real) sim values, for "Reset".
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

        const tlSince = (tlCfg.since || '2026-08-01').slice(0, 7);
        const tlLive = tlCfg.enabled && month >= tlSince;
        const wkSince = (wkCfg.since || '2026-08-01').slice(0, 7);
        const wkLive = wkCfg.enabled && month >= wkSince;
        setWeeklyLive(wkLive);
        const isTl = role === 'tl' && tlLive;
        setMode(isTl ? 'tl' : 'metric');

        const realPerf = comp?.performance_score ?? null;
        const realInc = comp?.incentives_score ?? null;
        const realAtt = comp?.attendance_score ?? null;
        const realFlags = comp?.flags_score ?? null;
        setReal({
          perf: realPerf, inc: realInc, att: realAtt, flags: realFlags,
          composite: comp?.composite_score ?? null, level: comp?.level ?? null,
        });

        // ---- pre-fill the role-specific Performance control ----
        // Seed levers at FULL precision (no rounding) so the JS recompute
        // reproduces the exact server pillar; sliders snap only once dragged.
        let metrics = null, team = 0, hasTeam = true, stars = 0, hasStars = true, n = 0, d = 0, hasReports = true;
        if (isTl) {
          const pv = await tlPerfPreview(uid, month).catch(() => null);
          if (!cancelled && pv) {
            hasTeam = pv.team != null;               // no rated APCs → team component is DROPPED, not 0
            team = pv.team != null ? pv.team : 0;
            stars = pv.starAvg != null ? pv.starAvg : 0;
            hasStars = pv.starScore != null;
            n = pv.n || 0; d = pv.deductions || 0;
            hasReports = pv.accountability != null;
          }
        } else {
          // Seed from the monthly rating row — the SAME source the live page reads
          // (getRatingFor). When weekly is live the rollup has already written the
          // averaged metrics into that row, so this matches in Trial and Live alike.
          const r = await getRatingFor(uid, month).catch(() => null);
          metrics = r?.metrics || null;
        }

        // ---- incentives (own row) ----
        let incPct = 0, hasPlan = false, verified = true;
        try {
          const rows = await listAllIncentivesForMonth(month);
          const mine = (rows || []).find((r) => r.user_id === uid || r.userId === uid);
          if (mine) {
            const items = [...(mine.incentives || []), ...(mine.bonuses || [])];
            hasPlan = items.length > 0;
            verified = !!mine.verified;
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

        const metricVals = {
          dailyTasksQuality: Number(metrics?.dailyTasksQuality) || 0,
          reporting: Number(metrics?.reporting) || 0,
          overallWorkflow: Number(metrics?.overallWorkflow) || 0,
          responseTime: Number(metrics?.responseTime) || 0,
          tasksProcessing: Number(metrics?.tasksProcessing) || 0,
        };
        // Keep attendance EXACT (1-dp) — the real composite feeds it in unrounded.
        const att = realAtt != null ? realAtt : 0;

        setSimMetrics(metricVals);
        setSimTeam(team); setSimHasTeam(hasTeam); setSimStars(stars); setSimHasStars(hasStars); setSimN(n); setSimD(d); setSimHasReports(hasReports);
        setIncludeInc(hasPlan); setSimIncPct(incPct); setSimVerified(verified);
        setSimAtt(att); setSimGreen(g); setSimRed(rr);
        setInitial({
          metrics: metricVals, team, hasTeam, stars, hasStars, n, d, hasReports,
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
  const simPerf = useMemo(() => {
    if (mode === 'tl') {
      // Drop the team component when the TL has no rated APCs (matches mig 271:
      // team-null → pillar = reporting only), rather than blending it as 0.
      const team = simHasTeam ? clamp(simTeam, 0, 100) : null;
      const starScore = simHasStars ? clamp(simStars * 20, 0, 100) : null;
      const acct = (simHasReports && simN > 0) ? clamp(Math.max(0, simN - simD) / simN * 100, 0, 100) : null;
      return tlPerfPillar(team, tlReportingScore(starScore, acct));
    }
    return calcMetricsAvg(simMetrics);
  }, [mode, simMetrics, simTeam, simHasTeam, simStars, simHasStars, simN, simD, simHasReports]);

  const simIncScore = includeInc ? clamp(Math.round(simIncPct), 0, 100) : null;
  const simFlagsScore = clamp(80 + simGreen * 10 - simRed * 20, 0, 100);
  const simAttScore = clamp(simAtt, 0, 100); // exact (1-dp) — the real composite feeds it unrounded

  const simComposite = useMemo(
    () => calcComposite({ performance: simPerf, incentives: simIncScore, attendance: simAttScore, flags: simFlagsScore }, weights),
    [simPerf, simIncScore, simAttScore, simFlagsScore, weights],
  );

  const withheldReason = simPerf == null
    ? 'Performance is not rated yet — drag the sliders to explore.'
    : (includeInc && !simVerified && simIncScore != null)
      ? 'In reality, your final score stays hidden until your OL verifies your incentives.'
      : null;

  const level = getLevelTokens(simComposite);

  // Pillar rows for the breakdown (present pillars only, effective weights).
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
      ...d,
      present: d.score != null,
      effWeight: d.score != null ? (d.weight / totalW) * 100 : 0,
      contribution: d.score != null ? (d.score * d.weight) / totalW : 0,
    }));
  }, [simPerf, simIncScore, simAttScore, simFlagsScore, weights]);

  // Goal-seek: what does the Performance pillar need to be, holding the other
  // (present) pillars at their current simulated values, to reach `goal`?
  const goalSeek = useMemo(() => {
    const others = pillarRows.filter((p) => p.key !== 'performance' && p.present);
    const perfW = weights.performance || 0;
    const totalW = perfW + others.reduce((a, p) => a + p.weight, 0);
    const otherWS = others.reduce((a, p) => a + p.score * p.weight, 0);
    if (perfW <= 0 || totalW <= 0) return null;
    // round(m) >= goal  ⟺  m >= goal-0.5  ⟺  perf >= ((goal-0.5)*totalW - otherWS)/perfW
    const needRaw = ((goal - 0.5) * totalW - otherWS) / perfW;
    const need = Math.ceil(Math.max(0, needRaw));
    const maxComposite = Math.round((otherWS + 100 * perfW) / totalW);
    return { need, reachable: need <= 100, maxComposite, current: simPerf };
  }, [pillarRows, weights, goal, simPerf]);

  const reset = () => {
    if (!initial) return;
    setSimMetrics(initial.metrics);
    setSimTeam(initial.team); setSimHasTeam(initial.hasTeam); setSimStars(initial.stars); setSimHasStars(initial.hasStars);
    setSimN(initial.n); setSimD(initial.d); setSimHasReports(initial.hasReports);
    setIncludeInc(initial.includeInc); setSimIncPct(initial.incPct); setSimVerified(initial.verified);
    setSimAtt(initial.att); setSimGreen(initial.green); setSimRed(initial.red);
  };

  // Has the user meaningfully changed anything? Compared at SLIDER resolution
  // (metrics/team/att rounded to int, stars to half-steps) so an exact decimal
  // seed can't flip `dirty` when the user clicks the slider at its shown value.
  const dirty = useMemo(() => {
    if (!initial) return false;
    const norm = (s) => JSON.stringify({
      metrics: Object.fromEntries(Object.keys(s.metrics).map((k) => [k, Math.round(Number(s.metrics[k]) || 0)])),
      team: Math.round(s.team), hasTeam: s.hasTeam, stars: roundHalf(s.stars), hasStars: s.hasStars,
      n: s.n, d: s.d, hasReports: s.hasReports, includeInc: s.includeInc, incPct: Math.round(s.incPct),
      verified: s.verified, att: Math.round(s.att), green: s.green, red: s.red,
    });
    const now = norm({ metrics: simMetrics, team: simTeam, hasTeam: simHasTeam, stars: simStars, hasStars: simHasStars, n: simN, d: simD, hasReports: simHasReports, includeInc, incPct: simIncPct, verified: simVerified, att: simAtt, green: simGreen, red: simRed });
    const was = norm({ metrics: initial.metrics, team: initial.team, hasTeam: initial.hasTeam, stars: initial.stars, hasStars: initial.hasStars, n: initial.n, d: initial.d, hasReports: initial.hasReports, includeInc: initial.includeInc, incPct: initial.incPct, verified: initial.verified, att: initial.att, green: initial.green, red: initial.red });
    return now !== was;
  }, [initial, simMetrics, simTeam, simHasTeam, simStars, simHasStars, simN, simD, simHasReports, includeInc, simIncPct, simVerified, simAtt, simGreen, simRed]);

  const roleLabel = ROLE_LABEL[role] || role.toUpperCase();
  const realCompositeText = real.composite != null ? real.composite
    : real.level === 'pending_verification' ? 'Withheld'
      : real.perf == null ? 'Not rated' : '—';
  const delta = (dirty && real.composite != null && simComposite != null) ? simComposite - real.composite : null;

  if (!uid) return null;

  return (
    <div>
      <div className="page-header d-flex flex-wrap align-items-start justify-content-between gap-3">
        <div>
          <h1 className="page-title d-inline-flex align-items-center gap-2">
            <i className="bi bi-sliders" style={{ color: 'var(--accent)' }} />Performance Simulator
          </h1>
          <p className="page-subtitle mb-0">See exactly how your monthly score is built — then try what-if scenarios for {monthLabel(month)}.</p>
        </div>
        <button className="btn btn-sm btn-outline-secondary rounded-pill px-3 flex-shrink-0" onClick={() => navigate('/performance')}>
          <i className="bi bi-arrow-left me-1" />Back to Performance
        </button>
      </div>

      {/* Read-only reassurance */}
      <div className="rounded-3 p-2 px-3 mb-4 d-inline-flex align-items-center gap-2"
        style={{ background: 'var(--info-soft, color-mix(in srgb, var(--info,#0d6efd) 12%, transparent))', border: '1px solid color-mix(in srgb, var(--info,#0d6efd) 30%, transparent)' }}>
        <i className="bi bi-shield-lock-fill" style={{ color: 'var(--info,#0d6efd)' }} />
        <span style={{ fontSize: '0.76rem', color: 'var(--text-secondary)' }}>
          This is a private what-if tool. Nothing here changes your real score or salary — it only reads your current numbers to start you off.
        </span>
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
              <p style={{ fontSize: '0.82rem', color: 'var(--text-secondary)' }} className="mb-3">
                Your monthly <strong>Composite Score</strong> is a weighted average of four pillars. If you have no incentive plan in a month, that 25% is shared out among the other three.
              </p>
              <div className="d-flex flex-wrap gap-2 mb-3">
                {[
                  { label: 'Performance', w: weights.performance, icon: 'bi-bar-chart-fill' },
                  { label: 'Bonus & Incentives', w: weights.incentives, icon: 'bi-award-fill' },
                  { label: 'Attendance', w: weights.attendance, icon: 'bi-calendar-check' },
                  { label: 'Monthly Flags', w: weights.flags, icon: 'bi-flag-fill' },
                ].map((p) => (
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
                    <li><strong>60% your team</strong> — the average of your APCs' overall scores. Raise it by helping your team score higher across all their pillars.</li>
                    <li><strong>40% your reporting</strong> = 60% your OL's star rating (0–5 stars → ×20) + 40% report accountability (verified reports − deductions) ÷ verified.</li>
                  </ul>
                ) : (
                  <ul className="mb-0 ps-3">
                    <li>The average of <strong>5 things your manager rates 0–100</strong>: daily task quality, reporting, overall workflow, response time, tasks processing.{weeklyLive && role === 'apc' ? ' Rated each week after you present — your month is the average of those weekly ratings.' : ''}</li>
                    {role === 'apc' && <li><strong>Reporting</strong> = your manager's 0–90 score + up to 5 for clean weekly reports + up to 5 for clean checkpoints. Each returned/docked report or checkpoint lowers it.</li>}
                  </ul>
                )}
                <div className="mt-2" style={{ fontSize: '0.74rem' }}>
                  <span className="fw-semibold" style={{ color: 'var(--text-primary)' }}>Attendance</span> = your monthly coverage % (weekends &amp; holidays are already covered — each missed weekday lowers it). ·
                  <span className="fw-semibold ms-1" style={{ color: 'var(--text-primary)' }}>Incentives</span> = how much of your plan you complete (an item counts at ≥90% of its target). ·
                  <span className="fw-semibold ms-1" style={{ color: 'var(--text-primary)' }}>Flags</span> = start at 80, +10 per green flag, −20 per red.
                </div>
                <div className="mt-2" style={{ fontSize: '0.74rem', color: 'var(--text-muted)' }}>
                  <i className="bi bi-lock me-1" />If you have an incentive plan, your final score stays hidden until your OL verifies it. Levels: <strong>90+ Promotion</strong> · 70+ Good · 50+ Warning · below 50 Termination.
                </div>
              </div>
            </div>
          </div>

          <div className="row g-4">
            {/* ── LEFT: what-if controls (below the result on mobile) ── */}
            <div className="col-lg-7 order-2 order-lg-1">
              <div className="d-flex align-items-center justify-content-between mb-2">
                <h6 className="fw-bold mb-0" style={{ fontSize: '0.95rem' }}><i className="bi bi-sliders me-2" style={{ color: 'var(--accent)' }} />Try a scenario</h6>
                <button className="btn btn-sm btn-outline-secondary rounded-pill px-3" onClick={reset} style={{ fontSize: '0.72rem' }}>
                  <i className="bi bi-arrow-counterclockwise me-1" />Reset to my real numbers
                </button>
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
                      <div className="fw-semibold mb-2 mt-1" style={{ fontSize: '0.76rem', color: 'var(--text-primary)' }}>Reporting (40% of Performance)</div>
                      <Slider label="OL star rating" value={simStars} min={0} max={5} step={0.5} onChange={(v) => { setSimStars(v); setSimHasStars(true); }}
                        suffix=" ★" accent="var(--accent)" hint={`= ${Math.round(clamp(simStars * 20, 0, 100))}/100 (stars × 20)`} />
                      <div className="row g-2">
                        <div className="col-6"><Stepper label="Reports verified (N)" value={simN} min={0} max={40} onChange={(v) => { setSimN(v); setSimHasReports(true); }} /></div>
                        <div className="col-6"><Stepper label="Deductions (D)" value={simD} min={0} max={40} onChange={setSimD} color="var(--danger)" /></div>
                      </div>
                      <div style={{ fontSize: '0.66rem', color: 'var(--text-muted)' }}>
                        Accountability = {simN > 0 ? `${Math.round(clamp(Math.max(0, simN - simD) / simN * 100, 0, 100))}/100` : 'n/a'} · Reporting blends to {(() => {
                          const s = simHasStars ? clamp(simStars * 20, 0, 100) : null;
                          const a = (simHasReports && simN > 0) ? clamp(Math.max(0, simN - simD) / simN * 100, 0, 100) : null;
                          const r = tlReportingScore(s, a);
                          return r == null ? 'n/a' : `${Math.round(r)}/100`;
                        })()}
                      </div>
                    </div>
                  </>
                ) : (
                  <>
                    {V1_METRICS.map((m) => (
                      <Slider key={m.key} label={m.label} value={Math.round(Number(simMetrics[m.key]) || 0)}
                        onChange={(v) => setSimMetrics((prev) => ({ ...prev, [m.key]: v }))} suffix="/100" />
                    ))}
                    <div style={{ fontSize: '0.66rem', color: 'var(--text-muted)' }}>Performance = the average of these five.</div>
                  </>
                )}
              </ControlCard>

              {/* Incentives */}
              <ControlCard icon="bi-award-fill" title="Bonus & Incentives" weight={weights.incentives} pillarValue={simIncScore} dropped={!includeInc}>
                <Toggle label="I have an incentive plan this month" checked={includeInc} onChange={setIncludeInc}
                  hint={includeInc ? undefined : 'With no plan, this 25% is shared among the other three pillars.'} />
                {includeInc && (
                  <>
                    <Slider label="Plan completion" value={simIncPct} onChange={setSimIncPct} suffix="%"
                      hint="= completed items ÷ total items. An item completes at ≥90% of its own target." />
                    <Toggle label="OL has verified my incentives" checked={simVerified} onChange={setSimVerified}
                      hint="Until this is on, your final composite stays hidden (the pillar value still counts once verified)." />
                  </>
                )}
              </ControlCard>

              {/* Attendance */}
              <ControlCard icon="bi-calendar-check" title="Attendance" weight={weights.attendance} pillarValue={simAttScore}>
                <Slider label="Monthly coverage" value={simAtt} onChange={setSimAtt} suffix="%"
                  hint="Weekends, holidays and approved leave are already covered — each missed weekday lowers this." />
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
                {/* Result tile */}
                <div className="card border-0 shadow-sm mb-3" style={{ borderRadius: 16, overflow: 'hidden' }}>
                  <div style={{ height: 4, background: `linear-gradient(90deg, ${level.color}, color-mix(in srgb, ${level.color} 45%, transparent))` }} />
                  <div className="card-body p-4 text-center">
                    <div className="text-uppercase" style={{ fontSize: '0.66rem', fontWeight: 800, letterSpacing: '0.08em', color: 'var(--text-muted)' }}>Simulated composite</div>
                    <div className="d-inline-flex align-items-center justify-content-center rounded-circle my-2"
                      style={{ width: 118, height: 118, background: level.bg, border: `4px solid ${level.color}` }}>
                      <span className="fw-bold" style={{ fontSize: '2.6rem', color: level.color, fontVariantNumeric: 'tabular-nums' }}>{simComposite}</span>
                    </div>
                    <div className="d-flex align-items-center justify-content-center gap-1">
                      <i className={`bi ${level.icon}`} style={{ color: level.color }} />
                      <span className="fw-bold" style={{ color: level.color }}>{level.label}</span>
                    </div>
                    <div className="d-flex align-items-center justify-content-center gap-2 mt-2" style={{ fontSize: '0.74rem', color: 'var(--text-muted)' }}>
                      <span>Your current: <strong style={{ color: 'var(--text-secondary)' }}>{realCompositeText}</strong></span>
                      {delta != null && delta !== 0 && (
                        <span className="badge rounded-pill" style={{ background: delta > 0 ? 'var(--success-soft)' : 'var(--danger-soft)', color: delta > 0 ? 'var(--success)' : 'var(--danger)', fontWeight: 800 }}>
                          <i className={`bi ${delta > 0 ? 'bi-arrow-up' : 'bi-arrow-down'}`} /> {Math.abs(delta)}
                        </span>
                      )}
                    </div>
                    {withheldReason && (
                      <div className="rounded-2 mt-3 px-2 py-2 text-start d-flex gap-2" style={{ background: 'var(--warning-soft)', fontSize: '0.68rem', color: 'var(--warning)' }}>
                        <i className="bi bi-info-circle mt-1" /><span>{withheldReason}</span>
                      </div>
                    )}
                  </div>
                </div>

                {/* Pillar contribution breakdown */}
                <div className="card border-0 shadow-sm mb-3" style={{ borderRadius: 14 }}>
                  <div className="card-body p-3 p-md-4">
                    <h6 className="fw-bold mb-3" style={{ fontSize: '0.85rem' }}><i className="bi bi-layers me-2" />What's driving it</h6>
                    {pillarRows.map((p) => (
                      <div key={p.key} className="mb-2">
                        <div className="d-flex align-items-center justify-content-between" style={{ fontSize: '0.74rem' }}>
                          <span style={{ color: 'var(--text-secondary)', fontWeight: 600 }}><i className={`bi ${p.icon} me-1`} style={{ opacity: 0.7 }} />{p.label}</span>
                          {p.present ? (
                            <span style={{ color: 'var(--text-primary)', fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}>
                              {Math.round(p.score)}<span className="text-muted" style={{ fontWeight: 500 }}> × {Math.round(p.effWeight)}% = {Math.round(p.contribution)}</span>
                            </span>
                          ) : <span className="text-muted" style={{ fontSize: '0.68rem' }}>Not counted</span>}
                        </div>
                        <div className="rounded-pill overflow-hidden mt-1" style={{ height: 6, background: 'var(--surface-2)' }}>
                          <div className="h-100 rounded-pill" style={{ width: `${p.present ? p.score : 0}%`, background: p.present ? getLevelTokens(p.score).color : 'var(--border-default)', transition: 'width .35s' }} />
                        </div>
                      </div>
                    ))}
                  </div>
                </div>

                {/* Goal seek */}
                <div className="card border-0 shadow-sm" style={{ borderRadius: 14 }}>
                  <div className="card-body p-3 p-md-4">
                    <h6 className="fw-bold mb-2" style={{ fontSize: '0.85rem' }}><i className="bi bi-bullseye me-2" style={{ color: 'var(--accent)' }} />Reach a goal</h6>
                    <Slider label="I want my composite to be" value={goal} min={40} max={100} onChange={setGoal} suffix=" +" accent="var(--accent)" />
                    {goalSeek && (
                      <div className="rounded-3 p-3 mt-1" style={{ background: 'var(--surface-2)', fontSize: '0.8rem' }}>
                        {goalSeek.reachable ? (
                          <>
                            <span style={{ color: 'var(--text-secondary)' }}>Keeping everything else as set, your </span>
                            <strong style={{ color: 'var(--text-primary)' }}>Performance pillar needs to be </strong>
                            <span className="badge rounded-pill" style={{ background: getLevelTokens(goalSeek.need).bg, color: getLevelTokens(goalSeek.need).color, fontWeight: 800, fontSize: '0.82rem' }}>{goalSeek.need}</span>
                            <span style={{ color: 'var(--text-muted)' }}> (now {goalSeek.current ?? 0}).</span>
                          </>
                        ) : (
                          <span style={{ color: 'var(--text-secondary)' }}>
                            Performance alone can't reach {goal} — even at 100 your composite tops out at <strong>{goalSeek.maxComposite}</strong>. Raise your other pillars too.
                          </span>
                        )}
                      </div>
                    )}
                    <div className="mt-2" style={{ fontSize: '0.66rem', color: 'var(--text-muted)' }}>
                      Tip: set your attendance, incentives and flags first, then this tells you the Performance you'd need.
                    </div>
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
