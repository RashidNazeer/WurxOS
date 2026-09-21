// ============================================================
// Halo V2 - See: do TikTok and Amazon move together?
//
// Stage 1 and 2 of the ladder, in client language. Two rules drive the design:
//
//   1. Moving together is not proof of cause, and that sentence has to be next
//      to the number rather than in a footnote further down.
//   2. A lag with too little overlap is a threshold not yet met, not a result.
//      The old grid of four large cards rendered those as dashes, which reads
//      as a broken page. They are now one compact strip plus a readiness line
//      naming exactly which lags are waiting and for how much.
//
// Correlation chips are deliberately NEUTRAL. Painting a positive correlation
// green made co-movement look like proven success, which is the one reading
// this whole tool exists to prevent. Direction is carried by the sign and an
// arrow; the accent is reserved for modelled figures.
// ============================================================

import {
  ResponsiveContainer, ComposedChart, Line, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend,
  ScatterChart, Scatter, ZAxis,
} from 'recharts';
import { fmtSignedPct, describeCorrelation, MIN_CORRELATION_OBS } from '../../lib/haloV2/correlation.js';
import { inverseNote } from '../../lib/haloV2/metricMetadata.js';
import { plainMetricLabel, formatMetricValue, coverageNote } from '../../lib/haloV2/plainLanguage.js';
import { TT_STYLE, GRID, SERIES_TIKTOK, SERIES_AMAZON, Note, Chip, indexToHundred } from './shared.jsx';

export default function SeeLayer({
  result, unit, xKey, yKey, periods, normalize, assessment, showScatter = false,
  filledFromDaily = [], lab = false,
}) {
  const o = result.observed;
  const best = o.lagCorrelations.find((r) => r.lag === o.bestObservedLag);
  const invNote = inverseNote(xKey) || inverseNote(yKey);
  const computable = o.lagCorrelations.filter((r) => r.correlation != null);
  const waiting = o.lagCorrelations.filter((r) => r.correlation == null);

  const xName = plainMetricLabel(xKey);
  const yName = plainMetricLabel(yKey);

  return (
    <>
      {computable.length === 0 ? (
        <ReadinessRow unit={unit} assessment={assessment} />
      ) : (
        <>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'stretch' }}>
            {o.lagCorrelations.map((r) => (
              <LagChip key={r.lag} row={r} unit={unit} isBest={r.lag === o.bestObservedLag} lab={lab} />
            ))}
          </div>

          {/* Everything below was on the Meeting face until round 3: the
              per-lag observation counts, a sentence naming the strongest lag,
              the coverage footer and a causation caveat that the badge on the
              takeaway already carries. A CMO reads four percentages and the
              chart. Analysts keep the lot in Lab. */}
          {lab && waiting.length > 0 && (
            <div style={{ fontSize: 11.5, color: 'var(--text-muted)', marginTop: 8 }}>
              {waiting.length === 1 ? 'One lag is' : `${waiting.length} lags are`} still waiting on overlap:
              {' '}they need {MIN_CORRELATION_OBS} overlapping {unit}s and this window gives them
              {' '}{waiting.map((r) => r.numberOfObservations).join(', ')}. A longer lag always has fewer
              {' '}{unit}s to work with, because the first ones have nothing to pair against.
            </div>
          )}

          {lab && (
            <p style={{ fontSize: 13, color: 'var(--text-secondary)', margin: '12px 0 0', maxWidth: 820 }}>
              {best?.correlation != null ? (
                <>
                  Strongest observed: <strong>{best.lag === 0 ? `same ${unit}` : `${best.lag} ${unit}${best.lag === 1 ? '' : 's'} later`}</strong>
                  {' '}at {fmtSignedPct(best.correlation)}, a {describeCorrelation(best.correlation).toLowerCase()} between {xName} and {yName}.
                  {' '}<strong>Moving together is not proof of cause.</strong> A confounder, such as a promotion
                  both channels ran, produces the same picture.
                </>
              ) : 'No correlation could be computed for this pair over this period.'}
            </p>
          )}

          {/* Kept in both views: with an inverse metric such as keyword rank,
              a negative number is GOOD news, and a reader who is not told that
              draws the opposite conclusion. */}
          {invNote && (
            <Note tone="info">
              {invNote} Raw correlation at the strongest lag: <strong>{fmtSignedPct(best?.rawCorrelation) ?? 'not available'}</strong>,
              {' '}business adjusted: <strong>{fmtSignedPct(best?.correlation) ?? 'not available'}</strong>.
            </Note>
          )}

          {lab && o.warnings.map((w) => <Note key={w.code} tone="warn">{w.message}</Note>)}
        </>
      )}

      {normalize && (
        <Note tone="info">
          Both series are indexed to 100 at the first period so two different scales can be compared for
          shape. Index values are for reading the shape only. Every figure elsewhere on this page is in
          real units.
        </Note>
      )}

      <OverTimeChart
        periods={periods} xKey={xKey} yKey={yKey} unit={unit} normalize={normalize}
        height={300}
      />

      {lab && showScatter && (
        <ScatterPanel periods={periods} xKey={xKey} yKey={yKey} />
      )}

      {lab && (
        <div style={{ fontSize: 11.5, color: 'var(--text-muted)', marginTop: 8 }}>
          {coverageNote({
            periodsSupplied: result.meta.periodsSupplied,
            completeObservations: result.meta.completeObservations,
            unit,
          })}
          {filledFromDaily.length > 0 && (
            <>
              {' '}{filledFromDaily.map(plainMetricLabel).join(' and ')} per {unit}{' '}
              {filledFromDaily.length > 1 ? 'are' : 'is'} totalled from the daily sheet for every {unit} it covers.
            </>
          )}
        </div>
      )}
    </>
  );
}

// ── One lag, as a chip ──────────────────────────────────────────────
// Meeting shows the label and the percentage. Nothing else: the observation
// count and the sufficiency wording were the "45 days · More stable
// directional evidence" fine print the review cut. The strongest lag keeps its
// accent border, which says the same thing as the chip that used to sit under
// it. Both details stay available on hover, and in full in Lab.
function LagChip({ row, unit, isBest, lab = false }) {
  const value = row.correlation;
  const pending = value == null;
  const arrow = pending ? null : value > 0.02 ? 'bi-arrow-up-right' : value < -0.02 ? 'bi-arrow-down-right' : 'bi-dash';
  const detail = pending
    ? `${row.numberOfObservations} of ${MIN_CORRELATION_OBS} ${unit}s`
    : `${row.numberOfObservations} ${unit}s · ${row.sufficiency?.label}`;
  return (
    <div
      title={row.reason || detail}
      style={{
        flex: '0 1 auto', minWidth: 124, padding: '9px 12px', borderRadius: 'var(--radius-md)',
        background: 'var(--surface-2)',
        border: `1px solid ${isBest ? 'var(--accent)' : 'var(--border-subtle)'}`,
        opacity: pending ? 0.7 : 1,
      }}
    >
      <div style={{ fontSize: 10.5, color: 'var(--text-muted)', fontWeight: 700 }}>
        {row.lag === 0 ? `Same ${unit}` : `${row.lag} ${unit}${row.lag === 1 ? '' : 's'}`}
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 5, marginTop: 1 }}>
        {arrow && <i className={`bi ${arrow}`} style={{ fontSize: 12, color: 'var(--text-muted)' }} />}
        <span style={{ fontSize: '1.1rem', fontWeight: 800, color: pending ? 'var(--text-muted)' : 'var(--text-primary)' }}>
          {pending ? 'Waiting' : fmtSignedPct(value)}
        </span>
      </div>
      {lab && <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 1 }}>{detail}</div>}
      {lab && isBest && !pending && (
        <div style={{ marginTop: 5 }}><Chip tone="accent">Strongest observed</Chip></div>
      )}
    </div>
  );
}

function ReadinessRow({ unit, assessment }) {
  return (
    <div style={{
      padding: '10px 14px', borderRadius: 'var(--radius-md)', background: 'var(--surface-2)',
      border: '1px dashed var(--border-default)', fontSize: 12.5, color: 'var(--text-secondary)',
      display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap',
    }}>
      <i className="bi bi-hourglass" style={{ color: 'var(--text-muted)' }} />
      <span>
        Correlations need <strong>{MIN_CORRELATION_OBS}</strong> overlapping {unit}s
        {assessment ? <>, and this view has <strong>{assessment.correlationObs}</strong></> : null}.
        {' '}The chart below needs far less and is shown regardless.
      </span>
    </div>
  );
}

// ── The one primary chart ───────────────────────────────────────────
// Exported because the Snapshot shows the same series when there is no
// counterfactual to show instead, and two copies of a dual-axis Recharts
// configuration is two places for the axis formatters to drift.
// `width` is normally responsive. The one-pager passes an explicit pixel width
// because it renders off-screen for the raster export, where a container that
// measures itself as zero would capture an empty box.
export function OverTimeChart({ periods, xKey, yKey, unit, normalize = false, height = 280, compact = false, width = '100%' }) {
  const withData = periods.filter((p) => p.x != null || p.y != null);
  const xs = withData.map((p) => p.x);
  const ys = withData.map((p) => p.y);
  const nx = normalize ? indexToHundred(xs) : xs;
  const ny = normalize ? indexToHundred(ys) : ys;
  const data = withData.map((p, i) => ({ label: p.label || p.key, x: nx[i], y: ny[i] }));

  const xName = plainMetricLabel(xKey);
  const yName = plainMetricLabel(yKey);
  const axisSuffix = normalize ? ' (indexed to 100)' : '';

  return (
    <div style={{ height, marginTop: compact ? 0 : 12 }}>
      {!compact && <div style={{ fontSize: 12, fontWeight: 700, marginBottom: 6 }}>Over time</div>}
      <ResponsiveContainer width={width} height="100%">
        {/* Recharts puts the legend at the BOTTOM by default, which landed it
            on top of the centered "Period (day)" axis title. The legend moves
            to the top left; the axis title keeps the bottom margin to itself. */}
        <ComposedChart data={data} margin={{ top: 4, right: 10, bottom: compact ? 8 : 26, left: 6 }}>
          <CartesianGrid stroke={GRID} vertical={false} />
          <XAxis
            dataKey="label" tick={{ fontSize: 10 }} minTickGap={20}
            label={compact ? undefined : { value: `Period (${unit})`, position: 'insideBottom', offset: -16, style: { fontSize: 10.5, fill: 'var(--text-muted)' } }}
          />
          <YAxis
            yAxisId="l" tick={{ fontSize: 10 }} width={compact ? 44 : 60}
            tickFormatter={(v) => formatMetricValue(v, xKey, { indexed: normalize })}
            label={compact ? undefined : { value: `${xName}${axisSuffix}`, angle: -90, position: 'insideLeft', style: { fontSize: 10, fill: 'var(--text-muted)', textAnchor: 'middle' } }}
          />
          <YAxis
            yAxisId="r" orientation="right" tick={{ fontSize: 10 }} width={compact ? 44 : 60}
            tickFormatter={(v) => formatMetricValue(v, yKey, { indexed: normalize })}
            label={compact ? undefined : { value: `${yName}${axisSuffix}`, angle: 90, position: 'insideRight', style: { fontSize: 10, fill: 'var(--text-muted)', textAnchor: 'middle' } }}
          />
          <Tooltip
            contentStyle={TT_STYLE}
            formatter={(v, name) => [formatMetricValue(v, name === xName ? xKey : yKey, { indexed: normalize }), name]}
          />
          <Legend verticalAlign="top" align="left" height={22} iconSize={9} wrapperStyle={{ fontSize: 11, paddingLeft: 2 }} />
          <Bar yAxisId="l" dataKey="x" name={xName} fill={SERIES_TIKTOK} opacity={0.65} />
          <Line yAxisId="r" dataKey="y" name={yName} stroke={SERIES_AMAZON} dot={false} strokeWidth={2} />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}

function ScatterPanel({ periods, xKey, yKey }) {
  const points = periods.filter((p) => p.x != null && p.y != null).map((p) => ({ x: p.x, y: p.y, label: p.label }));
  const xName = plainMetricLabel(xKey);
  const yName = plainMetricLabel(yKey);
  return (
    <div style={{ height: 280, marginTop: 16 }}>
      <div style={{ fontSize: 12, fontWeight: 700, marginBottom: 6 }}>Scatter</div>
      <ResponsiveContainer width="100%" height="100%">
        <ScatterChart margin={{ top: 6, right: 12, bottom: 24, left: 6 }}>
          <CartesianGrid stroke={GRID} />
          <XAxis type="number" dataKey="x" name={xName} tick={{ fontSize: 10 }} tickFormatter={(v) => formatMetricValue(v, xKey)}
            label={{ value: xName, position: 'insideBottom', offset: -16, style: { fontSize: 10.5, fill: 'var(--text-muted)' } }} />
          <YAxis type="number" dataKey="y" name={yName} tick={{ fontSize: 10 }} tickFormatter={(v) => formatMetricValue(v, yKey)}
            label={{ value: yName, angle: -90, position: 'insideLeft', style: { fontSize: 10, fill: 'var(--text-muted)', textAnchor: 'middle' } }} />
          <ZAxis range={[45, 45]} />
          <Tooltip contentStyle={TT_STYLE} cursor={{ strokeDasharray: '3 3' }}
            formatter={(v, name) => [formatMetricValue(v, name === xName ? xKey : yKey), name]} />
          <Scatter data={points} fill={SERIES_TIKTOK} />
        </ScatterChart>
      </ResponsiveContainer>
    </div>
  );
}
