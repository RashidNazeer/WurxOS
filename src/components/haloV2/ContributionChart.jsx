// ============================================================
// Halo V2 - actual vs counterfactual.
//
// MEETING (default). Two lines, nothing else:
//   solid   Actual Amazon revenue. Real data, straight off the sheet.
//   dashed  What the model predicts Amazon would have done with TikTok held
//           at the quieter reference path. Unobservable by definition, which
//           is why it is dashed.
//
// The gap between them is the modelled contribution. That sentence used to be
// printed under the chart, along with the reference level and a note about
// periods above and below it; the round 3 review cut all of it. A legend that
// names the two lines is enough, and the method belongs in the methodology
// modal rather than on the chart face.
//
// The previous Meeting chart plotted the model's prediction under ACTUAL
// TikTok activity as the solid line, which is a modelled series shown in the
// place a client reads as "what happened". Actual revenue now holds that
// position: the one line on this chart that is not an estimate.
//
// LAB keeps the analyst version: both predicted series plus the 95% band on
// the difference, which is the quantity whose uncertainty was computed.
// ============================================================

import {
  ResponsiveContainer, ComposedChart, Line, Area, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ReferenceLine,
} from 'recharts';
import { fmtValue } from '../../lib/haloFields';
import { TT_STYLE, GRID, SERIES_AMAZON, SERIES_BASELINE, FieldLabel } from './shared.jsx';

export default function ContributionChart({
  contribution, unit, yLabel, variant = 'meeting', actualByKey = null, height = 260,
}) {
  if (!contribution?.perPeriod?.length) return null;
  const lab = variant === 'lab';

  const data = contribution.perPeriod.map((p) => ({
    label: p.label,
    actual: actualByKey ? (actualByKey.get(String(p.key)) ?? null) : null,
    predicted: p.predictedActual,
    baseline: p.predictedBaseline,
    contribution: p.contribution,
    // Recharts draws a stacked Area from a [low, high] tuple, which is how the
    // interval becomes a band rather than two more lines competing with the
    // series. Lab only.
    band: p.lower != null && p.upper != null ? [p.lower, p.upper] : null,
  }));
  const hasBand = lab && data.some((d) => d.band != null);
  const hasActual = data.some((d) => d.actual != null);

  return (
    <div style={{ marginTop: lab ? 14 : 0 }}>
      {lab && (
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap', alignItems: 'baseline' }}>
          <FieldLabel>Actual vs counterfactual</FieldLabel>
          <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
            The gap between the two lines is the contribution.
          </div>
        </div>
      )}

      <div style={{ height }}>
        <ResponsiveContainer width="100%" height="100%">
          {/* Legend at the top: at the bottom it overlapped the centered axis
              title. */}
          <ComposedChart data={data} margin={{ top: 4, right: 12, bottom: lab ? 24 : 8, left: 8 }}>
            <CartesianGrid stroke={GRID} vertical={false} />
            <XAxis
              dataKey="label"
              tick={{ fontSize: 10 }}
              minTickGap={20}
              label={lab ? { value: `Period (${unit})`, position: 'insideBottom', offset: -14, style: { fontSize: 10.5, fill: 'var(--text-muted)' } } : undefined}
            />
            <YAxis
              tick={{ fontSize: 10 }}
              width={62}
              tickFormatter={(v) => fmtValue(v, 'money')}
              label={lab ? { value: yLabel, angle: -90, position: 'insideLeft', style: { fontSize: 10.5, fill: 'var(--text-muted)', textAnchor: 'middle' } } : undefined}
            />
            <Tooltip
              contentStyle={TT_STYLE}
              formatter={(v, name) => {
                if (Array.isArray(v)) return [`${fmtValue(v[0], 'money')} to ${fmtValue(v[1], 'money')}`, name];
                return [fmtValue(v, 'money'), name];
              }}
            />
            <Legend
              verticalAlign="top" align="left" height={lab ? 34 : 24} iconSize={9}
              wrapperStyle={{ fontSize: lab ? 10.5 : 11, paddingLeft: 2, lineHeight: '15px' }}
            />
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

            {/* Meeting: the real series leads. */}
            {!lab && hasActual && (
              <Line
                dataKey="actual"
                name="Actual Amazon"
                stroke={SERIES_AMAZON}
                strokeWidth={2.4}
                dot={false}
                connectNulls
                isAnimationActive={false}
              />
            )}

            {/* Lab also wants the fitted series under what actually happened. */}
            {lab && (
              <Line
                dataKey="predicted"
                name="Predicted under actual TikTok activity"
                stroke={SERIES_AMAZON}
                strokeWidth={2}
                dot={false}
                isAnimationActive={false}
              />
            )}

            <Line
              dataKey="baseline"
              name={lab ? 'Predicted at the reference level' : 'If TikTok quieter (model)'}
              stroke={SERIES_BASELINE}
              strokeWidth={2}
              strokeDasharray="5 4"
              dot={false}
              isAnimationActive={false}
            />
          </ComposedChart>
        </ResponsiveContainer>
      </div>

      {lab && (
        <div style={{ fontSize: 11.5, color: 'var(--text-muted)', marginTop: 4 }}>
          Reference: {contribution.referenceLabel} ({fmtValue(contribution.referenceValue, 'num')}).
          {' '}Periods above it add to the contribution; periods below it subtract, and are kept rather than floored.
        </div>
      )}
    </div>
  );
}
