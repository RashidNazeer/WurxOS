// ============================================================
// Halo V2 - Halo Finder (Lab only).
//
// It ranks every TikTok metric against the chosen Amazon outcome. In the old
// layout it sat under the client sections repeating what See had already said,
// with no reason to read it. It is an operator tool, and it needs a decision
// cue: the row worth acting on is the metric with the strongest DELAYED
// relationship, because that is the one to drive the Estimate step with.
//
// Negative rows are kept. They are findings, not omissions.
// ============================================================

import { useMemo } from 'react';
import { fmtSignedPct, signedCorrTextColor, MIN_CORRELATION_OBS } from '../../lib/haloV2/correlation.js';
import { haloFinder } from '../../lib/haloV2/lagAnalysis.js';
import { buildPeriods } from '../../lib/haloV2/dataAdapter';
import { plainMetricLabel } from '../../lib/haloV2/plainLanguage.js';
import { Note, Chip } from './shared.jsx';

export default function HaloFinder({
  srcRows, dailyRows, src, gran, xKey, yKey, range, tiktokFields, maxLag, unit,
  suggestion, onSwitchGrain, onPickMetric,
}) {
  const rows = useMemo(() => {
    if (!srcRows?.length || !src) return [];
    const keys = tiktokFields.map((f) => f.key);
    const seriesFor = (k) => buildPeriods({
      rows: srcRows, sourceGran: src.sourceGran, gran, xKey: k, yKey, range, dailyRows,
    }).periods;
    return haloFinder(keys, yKey, seriesFor, maxLag);
  }, [srcRows, dailyRows, src, gran, yKey, range, tiktokFields, maxLag]);

  if (!rows.length) return null;
  const usable = rows.filter((r) => r.correlation != null);
  const sorted = [...rows].sort((a, b) => Math.abs(b.correlation ?? 0) - Math.abs(a.correlation ?? 0));

  if (!usable.length) {
    return (
      <div className="wx-card" style={{ padding: 16 }}>
        <div style={{ fontSize: 14, fontWeight: 800, marginBottom: 2 }}>Halo Finder</div>
        <div style={{ fontSize: 12.5, color: 'var(--text-secondary)' }}>
          No TikTok metric has {MIN_CORRELATION_OBS} or more overlapping {unit}s against{' '}
          {plainMetricLabel(yKey)} over this range, so there is nothing to rank yet. A table of zeros would
          say we had measured no relationship, rather than that we could not look.
        </div>
        {suggestion && (
          <button type="button" className="wx-btn wx-btn-primary wx-btn-sm" style={{ marginTop: 10 }}
            onClick={() => onSwitchGrain(suggestion.grain)}>{suggestion.cta}</button>
        )}
      </div>
    );
  }

  // Strongest DELAYED relationship, which is a different question from
  // strongest overall: same-period movement usually wins that one.
  const laggedBest = [...usable]
    .map((r) => {
      const best = (r.lags || []).filter((l) => l.lag >= 1 && l.correlation != null)
        .reduce((a, b) => (Math.abs(b.correlation) > Math.abs(a?.correlation ?? 0) ? b : a), null);
      return best ? { metric: r.metric, lag: best.lag, correlation: best.correlation } : null;
    })
    .filter(Boolean)
    .sort((a, b) => Math.abs(b.correlation) - Math.abs(a.correlation))[0];

  return (
    <div className="wx-card" style={{ padding: 16 }}>
      <div style={{ fontSize: 14, fontWeight: 800, marginBottom: 2 }}>Halo Finder</div>
      <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 10 }}>
        Every TikTok metric ranked against {plainMetricLabel(yKey)}, at its own strongest lag.
      </div>

      {laggedBest && (
        <Note tone="info">
          <strong>Best metric to drive the Estimate step:</strong> {plainMetricLabel(laggedBest.metric)}, at{' '}
          {laggedBest.lag} {unit}{laggedBest.lag === 1 ? '' : 's'} later ({fmtSignedPct(laggedBest.correlation)}).
          {' '}It has the strongest delayed relationship here, which is the halo question.
          {onPickMetric && laggedBest.metric !== xKey && (
            <button type="button" className="wx-btn wx-btn-ghost wx-btn-sm" style={{ marginLeft: 8 }}
              onClick={() => onPickMetric(laggedBest.metric)}>
              Use it
            </button>
          )}
        </Note>
      )}

      <div style={{ overflowX: 'auto', marginTop: 10 }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12.5, minWidth: 560 }}>
          <thead>
            <tr style={{ color: 'var(--text-muted)', textAlign: 'left' }}>
              <th style={{ padding: '6px 8px' }}>TikTok metric</th>
              <th style={{ padding: '6px 8px' }}>Best observed lag</th>
              <th style={{ padding: '6px 8px' }}>Correlation</th>
              <th style={{ padding: '6px 8px' }}>Observations</th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((r) => (
              <tr key={r.metric} style={{ borderTop: '1px solid var(--border-subtle)' }}>
                <td style={{ padding: '6px 8px' }}>
                  {plainMetricLabel(r.metric)}
                  {r.metric === xKey && <span style={{ marginLeft: 6 }}><Chip tone="accent">In use</Chip></span>}
                </td>
                <td style={{ padding: '6px 8px' }}>
                  {r.bestLag == null ? 'not available'
                    : r.bestLag === 0 ? `Same ${unit}`
                    : `${r.bestLag} ${unit}${r.bestLag === 1 ? '' : 's'} later`}
                </td>
                <td style={{ padding: '6px 8px', fontWeight: 700, color: signedCorrTextColor(r.correlation) }}>
                  {fmtSignedPct(r.correlation) ?? 'not available'}
                </td>
                <td style={{ padding: '6px 8px', color: 'var(--text-muted)' }}>{r.numberOfObservations}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
