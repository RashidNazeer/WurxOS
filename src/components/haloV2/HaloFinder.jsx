// ============================================================
// Halo V2 - Halo Finder, as a dropdown.
//
// It ranks every TikTok metric against the chosen Amazon outcome. As an
// always-open card it owned a screen for a question nobody had asked yet, so
// it is now a closed control in the scope bar: open it, see the ranking, pick
// a metric, and it is gone again.
//
// The ranking is computed INSIDE the popover, so opening it is what pays for
// it. Closed, it costs nothing: it used to run a regression per TikTok metric
// on every render of the page.
//
// The row worth acting on is the metric with the strongest DELAYED
// relationship, because that is the halo question. Negative rows are kept:
// they are findings, not omissions.
// ============================================================

import { useMemo, useState } from 'react';
import { fmtSignedPct, signedCorrTextColor, MIN_CORRELATION_OBS } from '../../lib/haloV2/correlation.js';
import { haloFinder } from '../../lib/haloV2/lagAnalysis.js';
import { buildPeriods } from '../../lib/haloV2/dataAdapter';
import { plainMetricLabel } from '../../lib/haloV2/plainLanguage.js';
import { Popover, Chip, BarButton } from './shared.jsx';

export default function HaloFinderMenu(props) {
  const [open, setOpen] = useState(false);
  return (
    <div style={{ position: 'relative' }}>
      {/* Same primitive as every other control in the scope bar, so it cannot
          drift to a different height or radius. */}
      <BarButton
        icon="bi-search" chevron open={open} ariaExpanded={open}
        title="Rank every TikTok metric against this Amazon outcome"
        onClick={() => setOpen((s) => !s)}
      >
        Halo Finder
      </BarButton>
      {/* Mounted only while open, which is what keeps the ranking lazy. */}
      {open && (
        <Popover open onClose={() => setOpen(false)} width={430}>
          <FinderList {...props} onClose={() => setOpen(false)} />
        </Popover>
      )}
    </div>
  );
}

function FinderList({
  srcRows, dailyRows, src, gran, xKey, yKey, range, tiktokFields, maxLag, unit,
  suggestion, onSwitchGrain, onPickMetric, onClose,
}) {
  const rows = useMemo(() => {
    if (!srcRows?.length || !src) return [];
    const keys = tiktokFields.map((f) => f.key);
    const seriesFor = (k) => buildPeriods({
      rows: srcRows, sourceGran: src.sourceGran, gran, xKey: k, yKey, range, dailyRows,
    }).periods;
    return haloFinder(keys, yKey, seriesFor, maxLag);
  }, [srcRows, dailyRows, src, gran, yKey, range, tiktokFields, maxLag]);

  const usable = rows.filter((r) => r.correlation != null);

  if (!rows.length || !usable.length) {
    return (
      <div style={{ fontSize: 12.5, color: 'var(--text-secondary)', padding: 4 }}>
        No TikTok metric has {MIN_CORRELATION_OBS} or more overlapping {unit}s against{' '}
        {plainMetricLabel(yKey)} over this range, so there is nothing to rank yet.
        {suggestion && (
          <button
            type="button"
            className="wx-btn wx-btn-primary wx-btn-sm"
            style={{ marginTop: 10, width: '100%' }}
            onClick={() => { onClose(); onSwitchGrain(suggestion.grain); }}
          >
            {suggestion.cta}
          </button>
        )}
      </div>
    );
  }

  const sorted = [...rows].sort((a, b) => Math.abs(b.correlation ?? 0) - Math.abs(a.correlation ?? 0));
  const laggedBest = [...usable]
    .map((r) => {
      const best = (r.lags || []).filter((l) => l.lag >= 1 && l.correlation != null)
        .reduce((a, b) => (Math.abs(b.correlation) > Math.abs(a?.correlation ?? 0) ? b : a), null);
      return best ? { metric: r.metric, lag: best.lag, correlation: best.correlation } : null;
    })
    .filter(Boolean)
    .sort((a, b) => Math.abs(b.correlation) - Math.abs(a.correlation))[0];

  const pick = (metric) => { onClose(); if (onPickMetric) onPickMetric(metric); };

  return (
    <div>
      <div style={{ fontSize: 11, fontWeight: 800, letterSpacing: '.05em', textTransform: 'uppercase', color: 'var(--text-muted)', padding: '2px 4px 8px' }}>
        TikTok metrics against {plainMetricLabel(yKey)}
      </div>

      {laggedBest && (
        <div style={{
          fontSize: 11.5, color: 'var(--text-secondary)', background: 'var(--surface-2)',
          border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius-md)',
          padding: '7px 9px', marginBottom: 8, lineHeight: 1.45,
        }}>
          Strongest <strong>delayed</strong> relationship: {plainMetricLabel(laggedBest.metric)} at{' '}
          {laggedBest.lag} {unit}{laggedBest.lag === 1 ? '' : 's'} ({fmtSignedPct(laggedBest.correlation)}).
        </div>
      )}

      <div style={{ maxHeight: 270, overflowY: 'auto' }}>
        {sorted.map((r) => {
          const inUse = r.metric === xKey;
          return (
            <button
              key={r.metric}
              type="button"
              onClick={() => pick(r.metric)}
              disabled={inUse}
              style={{
                display: 'flex', alignItems: 'center', gap: 8, width: '100%', textAlign: 'left',
                background: 'none', border: 'none', padding: '6px 8px', borderRadius: 'var(--radius-md)',
                cursor: inUse ? 'default' : 'pointer', color: 'var(--text-primary)', font: 'inherit', fontSize: 12.5,
              }}
              onMouseEnter={(e) => { if (!inUse) e.currentTarget.style.background = 'var(--surface-2)'; }}
              onMouseLeave={(e) => { e.currentTarget.style.background = 'none'; }}
            >
              <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {plainMetricLabel(r.metric)}
                {inUse && <span style={{ marginLeft: 6 }}><Chip tone="accent">In use</Chip></span>}
              </span>
              <span style={{ fontSize: 11, color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>
                {r.bestLag == null ? '' : r.bestLag === 0 ? `same ${unit}` : `+${r.bestLag} ${unit}${r.bestLag === 1 ? '' : 's'}`}
              </span>
              <span style={{ fontWeight: 700, color: signedCorrTextColor(r.correlation), whiteSpace: 'nowrap', minWidth: 44, textAlign: 'right' }}>
                {fmtSignedPct(r.correlation) ?? 'n/a'}
              </span>
            </button>
          );
        })}
      </div>

      <div style={{ fontSize: 10.5, color: 'var(--text-muted)', padding: '8px 4px 2px', borderTop: '1px solid var(--border-subtle)', marginTop: 6 }}>
        Pick one to compare it against {plainMetricLabel(yKey)}.
      </div>
    </div>
  );
}
