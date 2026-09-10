// ============================================================
// Halo V2 — Stage 5: actual vs counterfactual (brief §G2).
//
// The contribution used to be one number with a reference-method label. A
// single figure cannot show WHERE it came from — whether it accumulated evenly
// or came almost entirely from three unusual weeks — and that is exactly what
// someone needs to see before quoting it.
//
// Two predicted series:
//   A  Amazon predicted under the TikTok activity that actually happened
//   B  Amazon predicted with TikTok held at the reference level
// The gap between them IS the contribution, so the area between the lines is
// the number in the panel above, drawn.
//
// The per-period interval is drawn as a band on the difference rather than on
// either series, because the difference is the estimated quantity and the thing
// whose uncertainty was computed.
// ============================================================

import {
  ResponsiveContainer, ComposedChart, Line, Area, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ReferenceLine,
} from 'recharts';
import { fmtValue } from '../../lib/haloFields';
import { TT_STYLE, GRID, SERIES_AMAZON, SERIES_BASELINE, FieldLabel } from './shared.jsx';

export default function ContributionChart({ contribution, unit, yLabel }) {
  if (!contribution?.perPeriod?.length) return null;

  const data = contribution.perPeriod.map((p) => ({
    label: p.label,
    actual: p.predictedActual,
    baseline: p.predictedBaseline,
    contribution: p.contribution,
    // Recharts draws a stacked Area from a [low, high] tuple, which is how the
    // interval becomes a band rather than two more lines competing with the
    // series.
    band: p.lower != null && p.upper != null ? [p.lower, p.upper] : null,
  }));
  const hasBand = data.some((d) => d.band != null);

  return (
    <div style={{ marginTop: 14 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap', alignItems: 'baseline' }}>
        <FieldLabel>Actual vs counterfactual</FieldLabel>
        <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
          The gap between the two lines is the contribution.
        </div>
      </div>

      <div style={{ height: 260 }}>
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={data} margin={{ top: 8, right: 12, bottom: 22, left: 8 }}>
            <CartesianGrid stroke={GRID} vertical={false} />
            <XAxis
              dataKey="label"
              tick={{ fontSize: 10 }}
              minTickGap={20}
              label={{ value: `Period (${unit})`, position: 'insideBottom', offset: -14, style: { fontSize: 10.5, fill: 'var(--text-muted)' } }}
            />
            <YAxis
              tick={{ fontSize: 10 }}
              label={{ value: yLabel, angle: -90, position: 'insideLeft', style: { fontSize: 10.5, fill: 'var(--text-muted)', textAnchor: 'middle' } }}
            />
            <Tooltip
              contentStyle={TT_STYLE}
              formatter={(v, name) => {
                if (Array.isArray(v)) return [`${fmtValue(v[0], 'money')} to ${fmtValue(v[1], 'money')}`, name];
                return [fmtValue(v, 'money'), name];
              }}
            />
            <Legend wrapperStyle={{ fontSize: 11 }} />
            <ReferenceLine y={0} stroke={GRID} />
            {hasBand && (
              <Area
                dataKey="band"
                name="95% interval on the difference"
                stroke="none"
                fill={SERIES_AMAZON}
                fillOpacity={0.13}
                isAnimationActive={false}
                connectNulls
              />
            )}
            <Line
              dataKey="actual"
              name="Predicted under actual TikTok activity"
              stroke={SERIES_AMAZON}
              strokeWidth={2}
              dot={false}
              isAnimationActive={false}
            />
            <Line
              dataKey="baseline"
              name="Predicted at the reference level"
              stroke={SERIES_BASELINE}
              strokeWidth={2}
              strokeDasharray="5 4"
              dot={false}
              isAnimationActive={false}
            />
          </ComposedChart>
        </ResponsiveContainer>
      </div>

      <div style={{ fontSize: 11.5, color: 'var(--text-muted)', marginTop: 4 }}>
        Reference: {contribution.referenceLabel} ({fmtValue(contribution.referenceValue, 'num')}).
        {' '}Periods above it add to the contribution; periods below it subtract, and are kept rather than floored.
      </div>
    </div>
  );
}
