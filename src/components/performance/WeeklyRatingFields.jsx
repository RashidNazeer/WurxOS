import { useEffect, useMemo, useRef, useState } from 'react';
import {
  WEEKLY_METRIC_KEYS, weeklyOverall, getWeeklyRating, saveWeeklyRating,
} from '../../lib/weeklyRatingsApi';
import { apcReturnChunks } from '../../lib/apcReportingApi';
import { getLevel } from '../../lib/performanceApi';

// The 5-metric weekly performance rating (0–100 each), self-contained: loads the
// existing rating for (apc, meeting), autosaves on change. Used in the live
// agenda meeting (OngoingEvaluation) and in the late-rating modal. `enabled` is
// the trial switch — when false we show a "trial preview" note.
//
// The REPORTING metric is split (mig 274): the OL rates 0–90; the remaining 10
// is auto — a weekly-report chunk (0–5) + a checkpoint chunk (0–5) that fall as
// the TL sends this APC's report/checkpoint back. The OL sees those read-only;
// the DB trigger folds metrics.reporting = reportingOl + the two chunks.
const METRIC_LABELS = {
  dailyTasksQuality: 'Daily task quality',
  reporting:         'Reporting',
  overallWorkflow:   'Overall workflow',
  responseTime:      'Response time',
  tasksProcessing:   'Efficiency',
};
const REPORTING_OL_MAX = 90;

export default function WeeklyRatingFields({ apcId, meetingId, enabled = false, onSaved }) {
  const [metrics, setMetrics] = useState(null); // 5 keys; `reporting` here = the OL's 0–90 slider
  const [chunks, setChunks] = useState(null);   // {report_score, checkpoint_score, report_deducted, checkpoint_deducted}
  const [loading, setLoading] = useState(true);
  const [saveState, setSaveState] = useState('idle');
  const metricsRef = useRef(null);
  const timer = useRef(null);

  useEffect(() => { metricsRef.current = metrics; }, [metrics]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true); setSaveState('idle');
    Promise.all([getWeeklyRating(apcId, meetingId), apcReturnChunks(apcId, meetingId).catch(() => null)])
      .then(([r, ch]) => {
        if (cancelled) return;
        const base = {};
        WEEKLY_METRIC_KEYS.forEach((k) => { base[k] = Number(r?.metrics?.[k]) || 0; });
        const chReport = Number.isFinite(Number(ch?.report_score)) ? Number(ch.report_score) : 5;
        const chCheckpoint = Number.isFinite(Number(ch?.checkpoint_score)) ? Number(ch.checkpoint_score) : 5;
        // reporting slider = the stored 0–90 value (reportingOl). For a legacy row with
        // no reportingOl, back it out of the stored total (reporting − chunks) so re-saving
        // is idempotent instead of re-adding the chunks (which would inflate by up to +10).
        const ol = r?.metrics?.reportingOl != null
          ? Number(r.metrics.reportingOl)
          : Math.min(REPORTING_OL_MAX, Math.max(0, (Number(r?.metrics?.reporting) || 0) - chReport - chCheckpoint));
        base.reporting = Math.min(REPORTING_OL_MAX, Math.max(0, ol));
        setMetrics(base);
        setChunks(ch || { report_score: 5, checkpoint_score: 5, report_deducted: 0, checkpoint_deducted: 0 });
        setLoading(false);
      })
      .catch(() => {
        if (cancelled) return;
        const b = {}; WEEKLY_METRIC_KEYS.forEach((k) => { b[k] = 0; });
        setMetrics(b); setChunks({ report_score: 5, checkpoint_score: 5, report_deducted: 0, checkpoint_deducted: 0 }); setLoading(false);
      });
    return () => { cancelled = true; if (timer.current) clearTimeout(timer.current); };
  }, [apcId, meetingId]);

  function setMetric(k, v) {
    const max = k === 'reporting' ? REPORTING_OL_MAX : 100;
    const val = Math.min(max, Math.max(0, v));
    setMetrics((m) => ({ ...m, [k]: val }));
    setSaveState('saving');
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(async () => {
      try {
        const cur = metricsRef.current;
        // Send reportingOl = the slider; the DB trigger folds in the chunks.
        await saveWeeklyRating(apcId, meetingId, { ...cur, reportingOl: cur.reporting });
        setSaveState('saved'); onSaved?.();
      } catch { setSaveState('error'); }
    }, 650);
  }

  const reportChunk = chunks ? chunks.report_score : 5;
  const checkpointChunk = chunks ? chunks.checkpoint_score : 5;
  const effReporting = metrics ? (Number(metrics.reporting) || 0) + reportChunk + checkpointChunk : 0;
  const overall = useMemo(
    () => (metrics ? weeklyOverall({ ...metrics, reporting: effReporting }) : 0),
    [metrics, effReporting],
  );
  const lvl = getLevel(overall);

  if (loading || !metrics) {
    return <div className="text-muted small py-2"><span className="spinner-border spinner-border-sm me-2" />Loading rating…</div>;
  }

  return (
    <div>
      {WEEKLY_METRIC_KEYS.map((k) => {
        if (k === 'reporting') {
          return (
            <div key={k} className="mb-2">
              <div className="d-flex align-items-center justify-content-between" style={{ fontSize: '0.76rem' }}>
                <span style={{ color: 'var(--text-secondary)', fontWeight: 600 }}>Reporting</span>
                <span style={{ color: 'var(--text-primary)', fontWeight: 800, fontVariantNumeric: 'tabular-nums' }}>{effReporting}<span className="text-muted">/100</span></span>
              </div>
              <div className="d-flex align-items-center justify-content-between" style={{ fontSize: '0.66rem', color: 'var(--text-muted)' }}>
                <span>Your rating</span><span>{metrics[k]}/90</span>
              </div>
              <input type="range" min={0} max={REPORTING_OL_MAX} step={1} value={metrics[k]} className="form-range"
                onChange={(e) => setMetric(k, Number(e.target.value))} />
              <div className="d-flex gap-2 flex-wrap" style={{ fontSize: '0.66rem' }}>
                <span className="rounded px-2 py-1" style={{ background: 'var(--surface-2)', color: 'var(--text-secondary)' }} title="Falls when the TL sends this APC's weekly report back">
                  Weekly report: <strong>{reportChunk}/5</strong>{chunks?.report_deducted > 0 && <span style={{ color: 'var(--danger)' }}> (−{chunks.report_deducted})</span>}
                </span>
                <span className="rounded px-2 py-1" style={{ background: 'var(--surface-2)', color: 'var(--text-secondary)' }} title="Falls when the TL sends this APC's checkpoint back">
                  Checkpoint: <strong>{checkpointChunk}/5</strong>{chunks?.checkpoint_deducted > 0 && <span style={{ color: 'var(--danger)' }}> (−{chunks.checkpoint_deducted})</span>}
                </span>
              </div>
              <div className="text-muted" style={{ fontSize: '0.62rem', marginTop: 2 }}>
                Auto from returns (10 pts) — read-only; they add to your 0–90 rating.
              </div>
            </div>
          );
        }
        return (
          <div key={k} className="mb-2">
            <div className="d-flex align-items-center justify-content-between" style={{ fontSize: '0.76rem' }}>
              <span style={{ color: 'var(--text-secondary)', fontWeight: 600 }}>{METRIC_LABELS[k]}</span>
              <span style={{ color: 'var(--text-primary)', fontWeight: 800, fontVariantNumeric: 'tabular-nums' }}>{metrics[k]}<span className="text-muted">/100</span></span>
            </div>
            <input type="range" min={0} max={100} step={1} value={metrics[k]} className="form-range"
              onChange={(e) => setMetric(k, Number(e.target.value))} />
          </div>
        );
      })}

      <div className="d-flex align-items-center justify-content-between mt-2 pt-2" style={{ borderTop: '1px dashed var(--border-subtle)' }}>
        <div className="d-flex align-items-center gap-2">
          <span className="text-muted" style={{ fontSize: '0.68rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em' }}>Week score</span>
          <span className="rounded-pill px-2 py-1" style={{ background: lvl.bg, color: lvl.color, fontSize: '0.74rem', fontWeight: 800 }}>{overall}/100</span>
        </div>
        <span style={{ fontSize: '0.66rem', color: saveState === 'error' ? 'var(--danger)' : 'var(--text-muted)' }}>
          {saveState === 'saving' && <><span className="spinner-border spinner-border-sm me-1" style={{ width: 10, height: 10 }} />Saving…</>}
          {saveState === 'saved' && <><i className="bi bi-check-circle-fill me-1 text-success" />Saved</>}
          {saveState === 'error' && <><i className="bi bi-exclamation-triangle me-1" />Save failed</>}
        </span>
      </div>

      {!enabled && (
        <div className="rounded-2 mt-2 px-2 py-1" style={{ background: 'var(--warning-soft)', border: '1px solid color-mix(in srgb, var(--warning) 30%, transparent)', fontSize: '0.66rem', color: 'var(--warning)' }}>
          <i className="bi bi-flask me-1" />Trial mode — this score is saved and previewed but does not yet affect the official monthly score.
        </div>
      )}
    </div>
  );
}
