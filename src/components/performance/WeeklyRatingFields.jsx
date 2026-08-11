import { useEffect, useMemo, useRef, useState } from 'react';
import {
  WEEKLY_METRIC_KEYS, weeklyOverall, getWeeklyRating, saveWeeklyRating,
} from '../../lib/weeklyRatingsApi';
import { getLevelTokens } from '../../lib/performanceApi';

// The 4-metric weekly CHECKPOINT rating (0–100 each), self-contained: loads the
// existing rating for (apc, meeting), autosaves on change. Used in the live
// agenda meeting (OngoingEvaluation) and in the late-rating modal. `enabled` is
// the trial switch — when false we show a "trial preview" note.
//
// This is the APC's "checkpoint" factor = 0.6 of their performance pillar. The
// external-reporting factor (0.4) is now the TL's per-report star (mig 303/304),
// NOT rated here — the old 0–90 "reporting" slider + return chunks are retired.
const METRIC_LABELS = {
  dailyTasksQuality: 'Daily task quality',
  overallWorkflow:   'Overall workflow',
  responseTime:      'Response time',
  tasksProcessing:   'Efficiency',
};

export default function WeeklyRatingFields({ apcId, meetingId, enabled = false, onSaved }) {
  const [metrics, setMetrics] = useState(null); // the 4 checkpoint keys
  const [loading, setLoading] = useState(true);
  const [saveState, setSaveState] = useState('idle');
  const metricsRef = useRef(null);
  const timer = useRef(null);

  useEffect(() => { metricsRef.current = metrics; }, [metrics]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true); setSaveState('idle');
    getWeeklyRating(apcId, meetingId)
      .then((r) => {
        if (cancelled) return;
        const base = {};
        WEEKLY_METRIC_KEYS.forEach((k) => { base[k] = Number(r?.metrics?.[k]) || 0; });
        setMetrics(base);
        setLoading(false);
      })
      .catch(() => {
        if (cancelled) return;
        const b = {}; WEEKLY_METRIC_KEYS.forEach((k) => { b[k] = 0; });
        setMetrics(b); setLoading(false);
      });
    return () => {
      cancelled = true;
      // Flush a pending debounced save so a fast unmount / presenter switch (the
      // meeting advancing changes apcId) doesn't silently drop the OL's last edit.
      if (timer.current) {
        clearTimeout(timer.current); timer.current = null;
        const cur = metricsRef.current;
        if (cur) saveWeeklyRating(apcId, meetingId, cur).catch(() => {});
      }
    };
  }, [apcId, meetingId]);

  function setMetric(k, v) {
    const val = Math.min(100, Math.max(0, v));
    setMetrics((m) => ({ ...m, [k]: val }));
    setSaveState('saving');
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(async () => {
      timer.current = null; // debounce fired — no longer pending (cleanup won't re-flush)
      try {
        await saveWeeklyRating(apcId, meetingId, metricsRef.current);
        setSaveState('saved'); onSaved?.();
      } catch { setSaveState('error'); }
    }, 650);
  }

  const overall = useMemo(() => (metrics ? weeklyOverall(metrics) : 0), [metrics]);
  const lvl = getLevelTokens(overall);

  if (loading || !metrics) {
    return <div className="text-muted small py-2"><span className="spinner-border spinner-border-sm me-2" />Loading rating…</div>;
  }

  return (
    <div>
      {WEEKLY_METRIC_KEYS.map((k) => (
        <div key={k} className="mb-2">
          <div className="d-flex align-items-center justify-content-between" style={{ fontSize: '0.76rem' }}>
            <span style={{ color: 'var(--text-secondary)', fontWeight: 600 }}>{METRIC_LABELS[k]}</span>
            <span style={{ color: 'var(--text-primary)', fontWeight: 800, fontVariantNumeric: 'tabular-nums' }}>{metrics[k]}<span className="text-muted">/100</span></span>
          </div>
          <input type="range" min={0} max={100} step={1} value={metrics[k]} className="form-range"
            onChange={(e) => setMetric(k, Number(e.target.value))} />
        </div>
      ))}

      <div className="d-flex align-items-center justify-content-between mt-2 pt-2" style={{ borderTop: '1px dashed var(--border-subtle)' }}>
        <div className="d-flex align-items-center gap-2">
          <span className="text-muted" style={{ fontSize: '0.68rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em' }}>Checkpoint score</span>
          <span className="rounded-pill px-2 py-1" style={{ background: lvl.bg, color: lvl.color, fontSize: '0.74rem', fontWeight: 800 }}>{overall}/100</span>
        </div>
        <span style={{ fontSize: '0.66rem', color: saveState === 'error' ? 'var(--danger)' : 'var(--text-muted)' }}>
          {saveState === 'saving' && <><span className="spinner-border spinner-border-sm me-1" style={{ width: 10, height: 10 }} />Saving…</>}
          {saveState === 'saved' && <><i className="bi bi-check-circle-fill me-1 text-success" />Saved</>}
          {saveState === 'error' && <><i className="bi bi-exclamation-triangle me-1" />Save failed</>}
        </span>
      </div>

      <div className="text-muted" style={{ fontSize: '0.64rem', marginTop: 4 }}>
        <i className="bi bi-info-circle me-1" />This is the APC's weekly checkpoint score (0.6 of their performance). External reporting is scored separately by the TL's per-report star.
      </div>

      {!enabled && (
        <div className="rounded-2 mt-2 px-2 py-1" style={{ background: 'var(--warning-soft)', border: '1px solid color-mix(in srgb, var(--warning) 30%, transparent)', fontSize: '0.66rem', color: 'var(--warning)' }}>
          <i className="bi bi-flask me-1" />Trial mode — this score is saved and previewed but does not yet affect the official monthly score.
        </div>
      )}
    </div>
  );
}
