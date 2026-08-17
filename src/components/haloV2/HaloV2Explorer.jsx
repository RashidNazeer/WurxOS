// ============================================================
// Halo V2 — the explorer, built to the implementation brief's three-layer rule
// (§23, §32, §37):
//
//   Layer A  Observed Relationship   — correlation is EVIDENCE
//   Layer B  Adjusted Halo Model     — regression is an ESTIMATE
//   Layer C  Investment Planning     — assumptions are a BUSINESS DECISION
//
// They are kept visually and structurally apart on purpose: the entire point of
// V2 is that these three things stop being blended into one confident number.
// Nothing here writes; nothing here touches V1.
// ============================================================

import { useEffect, useMemo, useState } from 'react';
import {
  ResponsiveContainer, ComposedChart, Line, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend,
  ScatterChart, Scatter, ZAxis,
} from 'recharts';
import { setHaloCurrency, getHaloCurrency, fmtValue } from '../../lib/haloFields';
import { sourceForGran, availableGrans, availableFields, buildPeriods, detectControls } from '../../lib/haloV2/dataAdapter';
import { analyseHalo } from '../../lib/haloV2/index.js';
import { fmtSignedPct, signedCorrColor, signedCorrTextColor, describeCorrelation } from '../../lib/haloV2/correlation.js';
import { haloFinder } from '../../lib/haloV2/lagAnalysis.js';
import { refitWithout } from '../../lib/haloV2/distributedLag.js';
import { modelEstimateAsAssumption, DEFAULT_ASSUMPTIONS } from '../../lib/haloV2/planningScenarios.js';
import { inverseNote, metricLabel } from '../../lib/haloV2/metricMetadata.js';

const TT_STYLE = { background: 'var(--surface-1, #16161c)', border: '1px solid var(--border-default, #2b2b35)', borderRadius: 8, fontSize: 12, color: 'var(--text-primary, #e8e8ee)' };
const GRID = 'var(--border-subtle, #2b2b3522)';
const UNIT = { day: 'day', week: 'week', month: 'month' };

export default function HaloV2Explorer({ datasets, loadRows }) {
  const [rowsById, setRowsById] = useState({});
  const [loading, setLoading]   = useState(false);
  const [error, setError]       = useState('');

  const [gran, setGran]   = useState('week');            // §14 — weekly is the model's frequency
  const [range, setRange] = useState({ start: '', end: '' });
  const [xKey, setXKey]   = useState('gmv');
  const [yKey, setYKey]   = useState('revenue_per_day');
  const [maxLag, setMaxLag] = useState(3);
  const [useTrend, setUseTrend] = useState(true);
  const [useSeasonality, setUseSeasonality] = useState(true);
  const [refMethod, setRefMethod] = useState('period_median');
  const [scenarioPct, setScenarioPct] = useState(10);
  const [customChange, setCustomChange] = useState('');
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [excludeIndex, setExcludeIndex] = useState(null);

  const [planning, setPlanning] = useState({ ttsRevenue: '', marketingSpend: '', assumptions: { ...DEFAULT_ASSUMPTIONS } });

  const list = datasets || [];
  const dsKey = list.map((d) => d.id).join(',');
  const grans = useMemo(() => availableGrans(list), [dsKey]);        // eslint-disable-line react-hooks/exhaustive-deps
  const src = useMemo(() => sourceForGran(list, gran), [dsKey, gran]); // eslint-disable-line react-hooks/exhaustive-deps
  const srcRows = src?.dataset?.id ? (rowsById[src.dataset.id] || null) : null;

  useEffect(() => {
    const present = list.filter((d) => d.id);
    if (!present.length) { setRowsById({}); return undefined; }
    let alive = true;
    setLoading(true); setError('');
    Promise.all(present.map((d) => Promise.resolve(loadRows(d.id)).then((r) => [d.id, r])))
      .then((pairs) => { if (alive) setRowsById(Object.fromEntries(pairs)); })
      .catch((e) => alive && setError(e.message || String(e)))
      .finally(() => alive && setLoading(false));
    return () => { alive = false; };
  }, [dsKey, loadRows]);   // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { if (grans.length && !grans.includes(gran)) setGran(grans.includes('week') ? 'week' : grans[0]); }, [grans, gran]);
  useEffect(() => { setHaloCurrency(src?.dataset?.currency || '$'); }, [src]);
  useEffect(() => {
    if (srcRows && srcRows.length) setRange({ start: srcRows[0].date, end: srcRows[srcRows.length - 1].date });
    else setRange({ start: '', end: '' });
  }, [src?.dataset?.id, srcRows]);   // eslint-disable-line react-hooks/exhaustive-deps

  const fields = useMemo(() => availableFields(srcRows), [srcRows]);
  const tiktokFields = fields.filter((f) => f.group === 'tiktok');
  const amazonFields = fields.filter((f) => f.group === 'amazon');
  useEffect(() => { if (tiktokFields.length && !tiktokFields.some((f) => f.key === xKey)) setXKey(tiktokFields[0].key); }, [tiktokFields, xKey]);
  useEffect(() => { if (amazonFields.length && !amazonFields.some((f) => f.key === yKey)) setYKey(amazonFields[0].key); }, [amazonFields, yKey]);

  const { periods } = useMemo(() => buildPeriods({
    rows: srcRows, sourceGran: src?.sourceGran, gran, xKey, yKey, range,
  }), [srcRows, src?.sourceGran, gran, xKey, yKey, range]);

  const controlsFound = useMemo(() => detectControls(periods), [periods]);

  const result = useMemo(() => analyseHalo(periods, {
    xKey, yKey, maxLag,
    controls: { trend: useTrend, seasonality: useSeasonality, promo: true, stockout: true },
    reference: { method: refMethod },
    scenarioSpec: customChange !== '' ? { type: 'absolute', value: Number(customChange) } : { type: 'percent', value: Number(scenarioPct) || 10 },
    planning: (planning.ttsRevenue !== '' || planning.marketingSpend !== '') ? planning : null,
  }), [periods, xKey, yKey, maxLag, useTrend, useSeasonality, refMethod, scenarioPct, customChange, planning]);

  const cur = getHaloCurrency();
  const unit = UNIT[gran];

  if (loading) return <div style={{ color: 'var(--text-muted)', fontSize: 13 }}><span className="wx-spinner" /> Loading data…</div>;
  if (error) return <div className="wx-alert wx-alert-danger"><span>{error}</span></div>;
  if (!srcRows?.length) return <div className="wx-card" style={{ padding: 24, color: 'var(--text-muted)' }}>No rows in this sheet yet.</div>;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {/* ── Controls bar ─────────────────────────────────────────── */}
      <div className="wx-card" style={{ padding: 14, display: 'flex', gap: 14, flexWrap: 'wrap', alignItems: 'flex-end' }}>
        <Picker label="View" value={gran} onChange={setGran}
          options={grans.map((g) => ({ value: g, label: `${g === 'day' ? 'Daily' : g === 'week' ? 'Weekly' : 'Monthly'}${g === 'week' ? ' — recommended' : ''}` }))} />
        <Picker label="TikTok metric" value={xKey} onChange={setXKey} options={tiktokFields.map((f) => ({ value: f.key, label: f.label }))} />
        <Picker label="Amazon metric" value={yKey} onChange={setYKey} options={amazonFields.map((f) => ({ value: f.key, label: f.label }))} />
        <Picker label="Max halo lag" value={String(maxLag)} onChange={(v) => setMaxLag(Number(v))}
          options={[0, 1, 2, 3].map((l) => ({ value: String(l), label: l === 0 ? `Same ${unit} only` : `${l} ${unit}${l === 1 ? '' : 's'}` }))} />
        <div>
          <FieldLabel>Date range</FieldLabel>
          <div style={{ display: 'flex', gap: 6 }}>
            <input type="date" className="wx-input" style={{ width: 145 }} value={range.start} onChange={(e) => setRange((r) => ({ ...r, start: e.target.value }))} />
            <input type="date" className="wx-input" style={{ width: 145 }} value={range.end} onChange={(e) => setRange((r) => ({ ...r, end: e.target.value }))} />
          </div>
        </div>
        <div style={{ display: 'flex', gap: 12, alignItems: 'center', paddingBottom: 6 }}>
          <Check label="Trend" checked={useTrend} onChange={setUseTrend} />
          <Check label="Seasonality" checked={useSeasonality} onChange={setUseSeasonality} />
        </div>
      </div>

      {gran !== 'week' && (
        <Note tone="info">
          Recommended for the Halo Model: <strong>Weekly</strong>. Daily data is usually too noisy and monthly leaves too few
          observations to estimate a lag model — {gran === 'day' ? 'daily' : 'monthly'} is here for exploration.
        </Note>
      )}

      {/* ══ LAYER A — OBSERVED ═══════════════════════════════════ */}
      <Layer letter="A" title="Observed Relationship" subtitle="What the data shows. Correlation is evidence of movement together — not proof that one caused the other.">
        <ObservedLayer result={result} unit={unit} xKey={xKey} yKey={yKey} periods={periods} />
      </Layer>

      {/* ══ LAYER B — ADJUSTED MODEL ═════════════════════════════ */}
      <Layer letter="B" title="Adjusted Halo Model" subtitle="A distributed-lag estimate that adjusts for the other variables we have. An estimate, not a measurement of cause.">
        <AdjustedLayer
          result={result} unit={unit} cur={cur} xKey={xKey} yKey={yKey}
          controlsFound={controlsFound}
          refMethod={refMethod} setRefMethod={setRefMethod}
          scenarioPct={scenarioPct} setScenarioPct={setScenarioPct}
          customChange={customChange} setCustomChange={setCustomChange}
          showAdvanced={showAdvanced} setShowAdvanced={setShowAdvanced}
          periods={periods} maxLag={maxLag} useTrend={useTrend} useSeasonality={useSeasonality}
          excludeIndex={excludeIndex} setExcludeIndex={setExcludeIndex}
        />
      </Layer>

      {/* ══ LAYER C — PLANNING ═══════════════════════════════════ */}
      <Layer letter="C" title="Investment Planning" subtitle="Planning assumptions — not measured results." tone="planning">
        <PlanningLayer result={result} planning={planning} setPlanning={setPlanning} cur={cur} />
      </Layer>

      {/* Halo Finder V2 + heatmap */}
      <HaloFinderV2 periods={periods} srcRows={srcRows} src={src} gran={gran} yKey={yKey} range={range} tiktokFields={tiktokFields} maxLag={maxLag} unit={unit} />
    </div>
  );
}

// ────────────────────────────────────────────────────────────────
// Layer A
// ────────────────────────────────────────────────────────────────
function ObservedLayer({ result, unit, xKey, yKey, periods }) {
  const o = result.observed;
  const best = o.lagCorrelations.find((r) => r.lag === o.bestObservedLag);
  const invNoteX = inverseNote(xKey), invNoteY = inverseNote(yKey);

  const chartData = periods.filter((p) => p.x != null || p.y != null).map((p) => ({ label: p.label || p.key, x: p.x, y: p.y }));
  const scatter = periods.filter((p) => p.x != null && p.y != null).map((p) => ({ x: p.x, y: p.y, label: p.label }));

  return (
    <>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 10, marginBottom: 14 }}>
        {o.lagCorrelations.map((r) => {
          const isBest = r.lag === o.bestObservedLag;
          return (
            <div key={r.lag} style={{
              padding: '12px 14px', borderRadius: 10, background: signedCorrColor(r.correlation),
              border: `1.5px solid ${isBest ? 'var(--accent)' : 'var(--border-subtle)'}`,
            }}>
              <div style={{ fontSize: 11, color: 'var(--text-muted)', fontWeight: 600 }}>
                {r.lag === 0 ? `Same ${unit}` : `+${r.lag} ${unit}${r.lag === 1 ? '' : 's'}`}
              </div>
              <div style={{ fontSize: '1.35rem', fontWeight: 800, color: signedCorrTextColor(r.correlation) }}>
                {fmtSignedPct(r.correlation) ?? '—'}
              </div>
              <div style={{ fontSize: 10.5, color: 'var(--text-muted)' }}>
                {r.numberOfObservations} pts · {r.sufficiency?.label}
              </div>
              {isBest && <div style={{ fontSize: 10, color: 'var(--accent)', fontWeight: 700, marginTop: 2 }}>STRONGEST OBSERVED</div>}
            </div>
          );
        })}
      </div>

      <p style={{ fontSize: 13, color: 'var(--text-secondary)', margin: '0 0 10px' }}>
        {best?.correlation != null ? (
          <>Strongest observed relationship: <strong>{best.lag === 0 ? `same ${unit}` : `+${best.lag} ${unit}${best.lag === 1 ? '' : 's'}`}</strong>{' '}
            ({fmtSignedPct(best.correlation)}) — {describeCorrelation(best.correlation).toLowerCase()} between {o.xLabel} and {o.yLabel}.
            This is the strongest relationship <em>observed in this period</em>, not a measured halo delay.</>
        ) : 'No correlation could be computed for this pair over this period.'}
      </p>

      {(invNoteX || invNoteY) && <Note tone="info">{invNoteX || invNoteY}{' '}
        Raw correlation at the strongest lag: <strong>{fmtSignedPct(best?.rawCorrelation) ?? '—'}</strong>; business-adjusted: <strong>{fmtSignedPct(best?.correlation) ?? '—'}</strong>.</Note>}

      {o.warnings.map((w) => <Note key={w.code} tone="warn">{w.message}</Note>)}

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: 14, marginTop: 12 }}>
        <div style={{ height: 240 }}>
          <div style={{ fontSize: 12, fontWeight: 700, marginBottom: 6 }}>Over time</div>
          <ResponsiveContainer width="100%" height="100%">
            <ComposedChart data={chartData}>
              <CartesianGrid stroke={GRID} vertical={false} />
              <XAxis dataKey="label" tick={{ fontSize: 10 }} minTickGap={20} />
              <YAxis yAxisId="l" tick={{ fontSize: 10 }} />
              <YAxis yAxisId="r" orientation="right" tick={{ fontSize: 10 }} />
              <Tooltip contentStyle={TT_STYLE} />
              <Legend wrapperStyle={{ fontSize: 11 }} />
              <Bar yAxisId="l" dataKey="x" name={metricLabel(xKey)} fill="#6366f1" opacity={0.65} />
              <Line yAxisId="r" dataKey="y" name={metricLabel(yKey)} stroke="#22c55e" dot={false} strokeWidth={2} />
            </ComposedChart>
          </ResponsiveContainer>
        </div>
        <div style={{ height: 240 }}>
          <div style={{ fontSize: 12, fontWeight: 700, marginBottom: 6 }}>Scatter</div>
          <ResponsiveContainer width="100%" height="100%">
            <ScatterChart>
              <CartesianGrid stroke={GRID} />
              <XAxis type="number" dataKey="x" name={metricLabel(xKey)} tick={{ fontSize: 10 }} />
              <YAxis type="number" dataKey="y" name={metricLabel(yKey)} tick={{ fontSize: 10 }} />
              <ZAxis range={[45, 45]} />
              <Tooltip contentStyle={TT_STYLE} cursor={{ strokeDasharray: '3 3' }} />
              <Scatter data={scatter} fill="#6366f1" />
            </ScatterChart>
          </ResponsiveContainer>
        </div>
      </div>
    </>
  );
}

// ────────────────────────────────────────────────────────────────
// Layer B
// ────────────────────────────────────────────────────────────────
function AdjustedLayer({
  result, unit, cur, xKey, yKey, controlsFound, refMethod, setRefMethod,
  scenarioPct, setScenarioPct, customChange, setCustomChange,
  showAdvanced, setShowAdvanced, periods, maxLag, useTrend, useSeasonality,
  excludeIndex, setExcludeIndex,
}) {
  const m = result.adjustedModel;
  const contrib = result.historicalContribution;
  const marg = result.marginal;

  const refit = useMemo(() => {
    if (excludeIndex == null) return null;
    return refitWithout(periods, excludeIndex, {
      maxLag, controls: { trend: useTrend, seasonality: useSeasonality, promo: true, stockout: true }, xKey, yKey,
    });
  }, [excludeIndex, periods, maxLag, useTrend, useSeasonality, xKey, yKey]);

  if (!m.available) {
    return (
      <>
        <Note tone="warn"><strong>Not enough history for an adjusted halo estimate.</strong> {m.message}</Note>
        <p style={{ fontSize: 12.5, color: 'var(--text-muted)', margin: 0 }}>
          The signed correlations and lag relationships above are still valid — they need far less data than a
          distributed-lag regression with controls.
        </p>
      </>
    );
  }

  const cumLabel = `${cur}${m.cumulativeCoefficient.toFixed(2)}`;
  const spansZero = m.confidenceInterval.lower != null && m.confidenceInterval.lower < 0 && m.confidenceInterval.upper > 0;

  return (
    <>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 12 }}>
        <Stat
          label="Cumulative relationship"
          value={`${cumLabel} per ${cur}1`}
          sub={`${metricLabel(yKey)} per 1 unit of ${metricLabel(xKey)}, across ${m.maxLag === 0 ? `the same ${unit}` : `this ${unit} + ${m.maxLag}`}`}
          tone={m.cumulativeCoefficient >= 0 ? 'pos' : 'neg'}
        />
        <Stat
          label="95% interval"
          value={m.confidenceInterval.lower == null ? '—'
            : `${cur}${m.confidenceInterval.lower.toFixed(2)} to ${cur}${m.confidenceInterval.upper.toFixed(2)}`}
          sub={spansZero ? 'Includes zero — direction uncertain' : 'Interval excludes zero'}
          tone={spansZero ? 'warn' : 'pos'}
        />
        <Stat label="Model confidence" value={m.confidenceLabel} sub={`${m.sampleSize} usable ${unit}s · adj R² ${m.adjustedR2 == null ? '—' : m.adjustedR2.toFixed(2)}`} />
        <Stat
          label="Modelled contribution"
          value={contrib ? fmtValue(contrib.amount, 'money') : '—'}
          sub={contrib ? contrib.referenceLabel : 'Unavailable'}
          tone={contrib && contrib.amount < 0 ? 'neg' : 'pos'}
        />
      </div>

      <p style={{ fontSize: 12.5, color: 'var(--text-secondary)', marginTop: 12 }}>
        Across the current and following {m.maxLag} {unit}{m.maxLag === 1 ? '' : 's'}, an additional {cur}1 of{' '}
        {metricLabel(xKey)} is <strong>associated with</strong> approximately <strong>{cumLabel}</strong> of {metricLabel(yKey)},
        after the included controls. {contrib && <>{contrib.label}</>}
      </p>

      <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', marginTop: 10, fontSize: 12 }}>
        <div>
          <FieldLabel>Controls included</FieldLabel>
          <div style={{ color: 'var(--success, #22c55e)' }}>{m.controls.length ? m.controls.map((c) => `✓ ${c}`).join('  ') : '—'}</div>
        </div>
        <div>
          <FieldLabel>Not controlled for</FieldLabel>
          <div style={{ color: 'var(--text-muted)' }}>
            {m.controlsUnavailable.length ? m.controlsUnavailable.map((c) => `✗ ${c}`).join('  ') : 'Nothing outstanding'}
          </div>
        </div>
        <div>
          <FieldLabel>Reference for contribution</FieldLabel>
          <select className="wx-input" style={{ width: 210 }} value={refMethod} onChange={(e) => setRefMethod(e.target.value)}>
            <option value="period_median">Median activity (default)</option>
            <option value="period_average">Period average</option>
          </select>
        </div>
      </div>

      {!controlsFound.promo && !controlsFound.stockout && (
        <Note tone="info">
          No promotion or stock-out columns exist in this sheet, so the estimate is adjusted for trend and seasonality only.
          Those two are the most common reasons a halo estimate is overstated — add the columns to the sheet and the model will use them automatically.
        </Note>
      )}
      {/* Guarded: a missing array here used to take the whole route down via
          the error boundary. Degrading to "no warnings" beats a white screen. */}
      {(m.warnings || []).map((w) => (
        <Note key={w.code} tone="warn">
          {w.message}
          {w.code === 'influential_observation' && (
            <button type="button" className="wx-btn wx-btn-ghost wx-btn-sm" style={{ marginLeft: 8 }}
              onClick={() => setExcludeIndex(excludeIndex == null ? w.index : null)}>
              {excludeIndex == null ? 'Run without it' : 'Restore'}
            </button>
          )}
        </Note>
      ))}
      {refit && (
        <Note tone="info">
          Without that period the cumulative relationship is{' '}
          <strong>{refit.available ? `${cur}${refit.cumulativeCoefficient.toFixed(2)}` : 'not estimable'}</strong>
          {refit.available && <> (was {cumLabel}).</>}
        </Note>
      )}

      {/* Forward scenario (§18) */}
      <div className="wx-card" style={{ padding: 12, marginTop: 12, background: 'var(--surface-2)' }}>
        <div style={{ fontSize: 12, fontWeight: 700, marginBottom: 8 }}>What if TikTok activity increases?</div>
        <div style={{ display: 'flex', gap: 10, alignItems: 'flex-end', flexWrap: 'wrap' }}>
          <div>
            <FieldLabel>By percent</FieldLabel>
            <select className="wx-input" style={{ width: 110 }} value={String(scenarioPct)}
              onChange={(e) => { setScenarioPct(Number(e.target.value)); setCustomChange(''); }}>
              {[5, 10, 20, 50].map((p) => <option key={p} value={p}>+{p}%</option>)}
            </select>
          </div>
          <div>
            <FieldLabel>Or by amount</FieldLabel>
            <input className="wx-input" style={{ width: 150 }} placeholder={`e.g. 2000`} value={customChange}
              onChange={(e) => setCustomChange(e.target.value)} />
          </div>
          {marg && (
            <div style={{ fontSize: 13 }}>
              <span style={{ color: 'var(--text-muted)' }}>{marg.changeLabel} on an average {unit} of {fmtValue(marg.basePeriodActivity, 'num')} →{' '}</span>
              <strong style={{ color: marg.estimated >= 0 ? 'var(--success)' : 'var(--danger)' }}>{fmtValue(marg.estimated, 'money')}</strong>
              {marg.lower != null && <span style={{ color: 'var(--text-muted)' }}> ({fmtValue(marg.lower, 'money')} to {fmtValue(marg.upper, 'money')})</span>}
            </div>
          )}
        </div>
      </div>

      {/* Advanced diagnostics (§21) */}
      <button type="button" className="wx-btn wx-btn-ghost wx-btn-sm" style={{ marginTop: 12 }} onClick={() => setShowAdvanced((s) => !s)}>
        <i className={`bi bi-chevron-${showAdvanced ? 'up' : 'down'}`} /> Model details
      </button>
      {showAdvanced && (
        <div className="wx-card" style={{ padding: 12, marginTop: 8, fontSize: 12 }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <tbody>
              <Row k="Observations (after lagging)" v={`${m.sampleSize}${m.droppedToLags ? ` — ${m.droppedToLags} dropped to lags` : ''}`} />
              <Row k="Adjusted R²" v={m.adjustedR2 == null ? '—' : m.adjustedR2.toFixed(3)} />
              <Row k="Selected max lag" v={`${m.maxLag} ${unit}${m.maxLag === 1 ? '' : 's'}`} />
              <Row k="Standard errors" v={m.covarianceKind} />
              <Row k="Cumulative coefficient" v={m.cumulativeCoefficient.toFixed(4)} />
              <Row k="95% confidence interval" v={m.confidenceInterval.lower == null ? '—' : `${m.confidenceInterval.lower.toFixed(4)} to ${m.confidenceInterval.upper.toFixed(4)}`} />
              <Row k="Max VIF (lag terms)" v={m.maxVif == null ? '—' : m.maxVif.toFixed(1)} />
            </tbody>
          </table>
          <div style={{ fontWeight: 700, margin: '10px 0 4px' }}>Coefficients by lag</div>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <tbody>
              {(m.lagCoefficients || []).map((c) => (
                <Row key={c.lag} k={c.label} v={`${c.coefficient >= 0 ? '+' : ''}${c.coefficient.toFixed(4)}${c.standardError != null ? `  (± ${(1.96 * c.standardError).toFixed(4)})` : ''}`} />
              ))}
              <Row k="Cumulative" v={`${m.cumulativeCoefficient >= 0 ? '+' : ''}${m.cumulativeCoefficient.toFixed(4)}`} />
            </tbody>
          </table>
          <div style={{ fontWeight: 700, margin: '10px 0 4px' }}>Why this confidence rating</div>
          <ul style={{ margin: 0, paddingLeft: 18, color: 'var(--text-secondary)' }}>
            {(m.confidenceReasons || []).map((r, i) => <li key={i}>{r}</li>)}
          </ul>
        </div>
      )}
    </>
  );
}

// ────────────────────────────────────────────────────────────────
// Layer C
// ────────────────────────────────────────────────────────────────
function PlanningLayer({ result, planning, setPlanning, cur }) {
  const p = result.planning;
  const meta = result.meta;
  const fromModel = modelEstimateAsAssumption(result.adjustedModel._model || result.adjustedModel, {
    xIsMonetary: meta.xIsMonetary, yIsMonetary: meta.yIsMonetary,
  });
  const set = (k, v) => setPlanning((s) => ({ ...s, [k]: v }));
  const setA = (k, v) => setPlanning((s) => ({ ...s, assumptions: { ...s.assumptions, [k]: Number(v) || 0 } }));

  return (
    <>
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'flex-end', marginBottom: 12 }}>
        <div><FieldLabel>TikTok Shop revenue</FieldLabel>
          <input className="wx-input" style={{ width: 160 }} value={planning.ttsRevenue} onChange={(e) => set('ttsRevenue', e.target.value)} placeholder="100000" /></div>
        <div><FieldLabel>TikTok marketing spend</FieldLabel>
          <input className="wx-input" style={{ width: 160 }} value={planning.marketingSpend} onChange={(e) => set('marketingSpend', e.target.value)} placeholder="30000" /></div>
        <div><FieldLabel>Conservative %</FieldLabel>
          <input className="wx-input" style={{ width: 110 }} value={planning.assumptions.conservative} onChange={(e) => setA('conservative', e.target.value)} /></div>
        <div><FieldLabel>Base %</FieldLabel>
          <input className="wx-input" style={{ width: 110 }} value={planning.assumptions.base} onChange={(e) => setA('base', e.target.value)} /></div>
        <div><FieldLabel>Upside %</FieldLabel>
          <input className="wx-input" style={{ width: 110 }} value={planning.assumptions.upside} onChange={(e) => setA('upside', e.target.value)} /></div>
        {fromModel.usable && (
          <button type="button" className="wx-btn wx-btn-ghost wx-btn-sm"
            title={fromModel.note}
            onClick={() => setA('base', fromModel.haloPercent)}>
            Use adjusted model estimate as Base ({fromModel.haloPercent}%)
          </button>
        )}
      </div>

      {!p.base ? (
        <p style={{ fontSize: 12.5, color: 'var(--text-muted)', margin: 0 }}>
          Enter a TikTok Shop revenue figure to model conservative, base and upside halo assumptions.
        </p>
      ) : (
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12.5 }}>
          <thead>
            <tr style={{ color: 'var(--text-muted)', textAlign: 'left' }}>
              <th style={{ padding: '6px 8px' }}>Scenario</th>
              <th style={{ padding: '6px 8px' }}>Halo</th>
              <th style={{ padding: '6px 8px' }}>Off-platform</th>
              <th style={{ padding: '6px 8px' }}>Total influenced</th>
              <th style={{ padding: '6px 8px' }}>Blended multiple</th>
            </tr>
          </thead>
          <tbody>
            {[['Conservative', p.conservative], ['Base', p.base], ['Upside', p.upside]].map(([name, s]) => (
              <tr key={name} style={{ borderTop: '1px solid var(--border-subtle)' }}>
                <td style={{ padding: '6px 8px', fontWeight: 600 }}>{name}</td>
                <td style={{ padding: '6px 8px' }}>{s.haloPercent}% ({cur}{s.haloPerCurrencyUnit.toFixed(2)} per {cur}1)</td>
                <td style={{ padding: '6px 8px' }}>{fmtValue(s.offPlatformRevenue, 'money')}</td>
                <td style={{ padding: '6px 8px', fontWeight: 700 }}>{fmtValue(s.totalInfluencedRevenue, 'money')}</td>
                <td style={{ padding: '6px 8px' }}>{s.blendedMultiple == null ? '—' : `${s.blendedMultiple.toFixed(2)}x`}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <Note tone="planning">Planning assumptions — not measured results. The model estimate is only applied here when you explicitly choose it.</Note>
    </>
  );
}

// ────────────────────────────────────────────────────────────────
// Halo Finder V2 (§26)
// ────────────────────────────────────────────────────────────────
function HaloFinderV2({ srcRows, src, gran, yKey, range, tiktokFields, maxLag, unit }) {
  const rows = useMemo(() => {
    if (!srcRows?.length || !src) return [];
    const keys = tiktokFields.map((f) => f.key);
    const seriesFor = (k) => buildPeriods({ rows: srcRows, sourceGran: src.sourceGran, gran, xKey: k, yKey, range }).periods;
    return haloFinder(keys, yKey, seriesFor, maxLag);
  }, [srcRows, src, gran, yKey, range, tiktokFields, maxLag]);

  if (!rows.length) return null;
  const sorted = [...rows].sort((a, b) => Math.abs(b.correlation ?? 0) - Math.abs(a.correlation ?? 0));

  return (
    <div className="wx-card" style={{ padding: 16 }}>
      <div style={{ fontSize: 14, fontWeight: 800, marginBottom: 2 }}>Halo Finder</div>
      <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 10 }}>
        Strongest observed lag relationship for every TikTok metric against {metricLabel(yKey)}. Negative rows are kept —
        they are findings, not omissions.
      </div>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12.5 }}>
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
              <td style={{ padding: '6px 8px' }}>{metricLabel(r.metric)}</td>
              <td style={{ padding: '6px 8px' }}>{r.bestLag == null ? '—' : r.bestLag === 0 ? `Same ${unit}` : `+${r.bestLag} ${unit}${r.bestLag === 1 ? '' : 's'}`}</td>
              <td style={{ padding: '6px 8px', fontWeight: 700, color: signedCorrTextColor(r.correlation) }}>{fmtSignedPct(r.correlation) ?? '—'}</td>
              <td style={{ padding: '6px 8px', color: 'var(--text-muted)' }}>{r.numberOfObservations}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ────────────────────────────────────────────────────────────────
// Small shared bits
// ────────────────────────────────────────────────────────────────
function Layer({ letter, title, subtitle, tone, children }) {
  const accent = tone === 'planning' ? 'var(--warning, #f59e0b)' : 'var(--accent)';
  return (
    <div className="wx-card" style={{ padding: 18, borderLeft: `3px solid ${accent}` }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginBottom: 2 }}>
        <span style={{ fontSize: 10, fontWeight: 800, color: accent, letterSpacing: '.08em' }}>LAYER {letter}</span>
        <h2 style={{ fontSize: '1.05rem', fontWeight: 800, margin: 0 }}>{title}</h2>
      </div>
      <p style={{ fontSize: 12, color: 'var(--text-muted)', margin: '0 0 14px' }}>{subtitle}</p>
      {children}
    </div>
  );
}
const FieldLabel = ({ children }) => (
  <div style={{ fontSize: 10.5, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '.05em', fontWeight: 700, marginBottom: 4 }}>{children}</div>
);
function Picker({ label, value, onChange, options }) {
  return (
    <div>
      <FieldLabel>{label}</FieldLabel>
      <select className="wx-input" style={{ minWidth: 150 }} value={value} onChange={(e) => onChange(e.target.value)}>
        {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
    </div>
  );
}
const Check = ({ label, checked, onChange }) => (
  <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, cursor: 'pointer' }}>
    <input type="checkbox" className="form-check-input mt-0" checked={checked} onChange={(e) => onChange(e.target.checked)} />
    {label}
  </label>
);
function Stat({ label, value, sub, tone }) {
  const color = tone === 'pos' ? 'var(--success, #22c55e)' : tone === 'neg' ? 'var(--danger, #ef4444)' : tone === 'warn' ? 'var(--warning, #f59e0b)' : 'var(--text-primary)';
  return (
    <div style={{ padding: '12px 14px', borderRadius: 10, background: 'var(--surface-2)', border: '1px solid var(--border-subtle)' }}>
      <div style={{ fontSize: 10.5, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '.05em', fontWeight: 700 }}>{label}</div>
      <div style={{ fontSize: '1.25rem', fontWeight: 800, color, lineHeight: 1.25 }}>{value}</div>
      {sub && <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>{sub}</div>}
    </div>
  );
}
function Note({ tone = 'info', children }) {
  const c = tone === 'warn' ? { bg: 'rgba(245,158,11,.10)', bd: 'rgba(245,158,11,.35)', ic: 'bi-exclamation-triangle' }
    : tone === 'planning' ? { bg: 'rgba(245,158,11,.07)', bd: 'rgba(245,158,11,.25)', ic: 'bi-sliders' }
    : { bg: 'rgba(99,102,241,.08)', bd: 'rgba(99,102,241,.28)', ic: 'bi-info-circle' };
  return (
    <div style={{ background: c.bg, border: `1px solid ${c.bd}`, borderRadius: 8, padding: '8px 12px', fontSize: 12, marginTop: 10, display: 'flex', gap: 8 }}>
      <i className={`bi ${c.ic}`} style={{ marginTop: 1 }} />
      <div>{children}</div>
    </div>
  );
}
const Row = ({ k, v }) => (
  <tr style={{ borderTop: '1px solid var(--border-subtle)' }}>
    <td style={{ padding: '5px 8px', color: 'var(--text-muted)' }}>{k}</td>
    <td style={{ padding: '5px 8px', textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{v}</td>
  </tr>
);
