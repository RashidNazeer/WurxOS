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
//
// This file is the composition and the state. Everything with its own reason to
// exist lives beside it: the stage stepper, the guided status panel, the
// actual-vs-counterfactual chart, the planning layer, and the shared
// primitives (including the one definition of the MODELLED · NOT INCREMENTAL
// badge, which is worthless if a second panel renders its own variant).
// ============================================================

import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ResponsiveContainer, ComposedChart, Line, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend,
  ScatterChart, Scatter, ZAxis,
} from 'recharts';
import { setHaloCurrency, getHaloCurrency, fmtValue } from '../../lib/haloFields';
import { sourceForGran, availableGrans, availableFields, buildPeriods, detectControls } from '../../lib/haloV2/dataAdapter';
import { analyseHalo } from '../../lib/haloV2/index.js';
import { fmtSignedPct, signedCorrColor, signedCorrTextColor, describeCorrelation, MIN_CORRELATION_OBS } from '../../lib/haloV2/correlation.js';
import { haloFinder } from '../../lib/haloV2/lagAnalysis.js';
import { refitWithout } from '../../lib/haloV2/distributedLag.js';
import { assessGrains, recommendGrain, grainSwitchSuggestion, GRAIN_LABEL, GRAIN_UNIT } from '../../lib/haloV2/grainRecommendation.js';
import { PERIODS_PER_YEAR } from '../../lib/haloV2/controls.js';
import { stageStatuses } from '../../lib/haloV2/stages.js';
import { REFERENCE_METHOD_SPECS } from '../../lib/haloV2/counterfactual.js';
import { inverseNote } from '../../lib/haloV2/metricMetadata.js';
import {
  plainMetricLabel, comparisonSentence, formatMetricValue, keyTakeaway, coverageNote,
} from '../../lib/haloV2/plainLanguage.js';
import { buildHaloV2Csv, downloadHaloV2Csv, haloV2CsvFilename } from '../../lib/haloV2/exportCsv.js';
import StageStepper from './StageStepper.jsx';
import StatusPanel from './StatusPanel.jsx';
import ContributionChart from './ContributionChart.jsx';
import PlanningLayer from './PlanningLayer.jsx';
import KeyTakeaway from './KeyTakeaway.jsx';
import { GlossaryPanel, Term } from './Glossary.jsx';
import {
  TT_STYLE, GRID, SERIES_TIKTOK, SERIES_AMAZON,
  FieldLabel, Picker, Check, Stat, Note, Row, Layer, ModelledBadge, ProgressMeter, indexToHundred,
} from './shared.jsx';

export default function HaloV2Explorer({ datasets, loadRows }) {
  const [rowsById, setRowsById] = useState({});
  const [loading, setLoading]   = useState(false);
  const [error, setError]       = useState('');

  const [gran, setGran]   = useState('week');
  const [range, setRange] = useState({ start: '', end: '' });
  const [xKey, setXKey]   = useState('gmv');
  const [yKey, setYKey]   = useState('revenue_per_day');
  const [maxLag, setMaxLag] = useState(3);
  const [useTrend, setUseTrend] = useState(true);
  const [useSeasonality, setUseSeasonality] = useState(true);
  const [refMethod, setRefMethod] = useState(null);       // null → the model's recommendation
  const [customRef, setCustomRef] = useState('');
  const [scenarioPct, setScenarioPct] = useState(10);
  const [customChange, setCustomChange] = useState('');
  const [showAdvanced, setShowAdvanced] = useState(false);      // model diagnostics
  const [scopeAdvanced, setScopeAdvanced] = useState(false);    // analyst knobs
  const [showScatter, setShowScatter] = useState(false);
  const [excludeIndex, setExcludeIndex] = useState(null);
  const [normalize, setNormalize] = useState(false);
  const [chartsOnly, setChartsOnly] = useState(false);
  const [glossaryOpen, setGlossaryOpen] = useState(false);
  const [planning, setPlanning] = useState({ ttsRevenue: '', marketingSpend: '', assumptions: null, mode: null });

  // Everything a "Reset to defaults" should put back. Kept as one list so the
  // button cannot drift from the initial state as options are added.
  const resetDefaults = () => {
    setMaxLag(3);
    setUseTrend(true);
    setUseSeasonality(true);
    setRefMethod(null);
    setCustomRef('');
    setScenarioPct(10);
    setCustomChange('');
    setNormalize(false);
    setExcludeIndex(null);
    setChartsOnly(false);
    setPlanning({ ttsRevenue: '', marketingSpend: '', assumptions: null, mode: null });
    // srcRows / grainPinned / autoAppliedFor are declared below; this closure
    // only ever runs from a click, long after the render that defines them.
    if (srcRows?.length) setRange({ start: srcRows[0].date, end: srcRows[srcRows.length - 1].date });
    grainPinned.current = false;
    autoAppliedFor.current = null;
  };

  // Once the user picks a grain deliberately, stop moving it under them. The
  // recommendation is still computed and still offered as a button — it just
  // stops being applied automatically.
  const grainPinned = useRef(false);

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

  // periodsPerYear is what makes seasonality ANNUAL rather than a fixed
  // 52-period wave: 365 on daily, 52 on weekly, 12 on monthly.
  const controlOpts = useMemo(
    () => ({ trend: useTrend, seasonality: useSeasonality, periodsPerYear: PERIODS_PER_YEAR[gran] }),
    [useTrend, useSeasonality, gran],
  );

  // ── Grain assessment across EVERY grain (§A1) ────────────────────
  // Recomputed on load, brand change, metric change, lag change and date
  // change — which is exactly the trigger list the brief specifies, because
  // each of them can move which grain is viable.
  const assessments = useMemo(() => {
    if (!srcRows?.length) return {};
    const periodsFor = (g) => {
      const s = sourceForGran(list, g);
      if (!s) return [];
      const rows = s.dataset?.id ? rowsById[s.dataset.id] : null;
      if (!rows?.length) return [];
      return buildPeriods({ rows, sourceGran: s.sourceGran, gran: g, xKey, yKey, range }).periods;
    };
    return assessGrains(grans, periodsFor, { maxLag, controls: controlOpts });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dsKey, rowsById, grans, xKey, yKey, range, maxLag, controlOpts, srcRows]);

  // currentGrain so the empty-state copy names the view the user is actually
  // on — selecting Monthly used to be explained with a sentence about Weekly.
  const recommendation = useMemo(
    () => recommendGrain(assessments, { currentGrain: gran }),
    [assessments, gran],
  );
  const assessment = assessments[gran] || null;
  const suggestion = useMemo(
    () => grainSwitchSuggestion(gran, assessments, recommendation),
    [gran, assessments, recommendation],
  );

  // Follow the recommendation ONCE per context, until the user takes the wheel.
  //
  // "Once" is load-bearing, not caution. Weekly and Daily can come from
  // DIFFERENT sheets (sourceForGran falls back to the day sheet for week, but
  // uses the week sheet when one exists), with different spans. Switching grain
  // therefore changes src.dataset.id, which resets the date range to that
  // sheet's span, which changes what every grain can support — so an unlatched
  // effect can oscillate forever: recommend Daily → switch → range widens →
  // Weekly now fits → recommend Weekly → switch → range narrows → recommend
  // Daily again.
  //
  // Applying it once per (sheets, metric pair) keeps the behaviour that matters
  // — landing on a grain that works instead of a blank Weekly — while making
  // the loop impossible. Every later change still surfaces the recommendation
  // as a button; it just stops moving the view under the user.
  const autoAppliedFor = useRef(null);
  useEffect(() => {
    if (grainPinned.current) return;
    const ctx = `${dsKey}|${xKey}|${yKey}`;
    if (autoAppliedFor.current === ctx) return;
    if (!recommendation?.grain || !grans.includes(recommendation.grain)) return;
    autoAppliedFor.current = ctx;
    if (recommendation.grain !== gran) setGran(recommendation.grain);
  }, [recommendation?.grain, gran, grans, dsKey, xKey, yKey]);

  const pickGrain = (g) => { grainPinned.current = true; setGran(g); setChartsOnly(false); };

  const { periods } = useMemo(() => buildPeriods({
    rows: srcRows, sourceGran: src?.sourceGran, gran, xKey, yKey, range,
  }), [srcRows, src?.sourceGran, gran, xKey, yKey, range]);

  const controlsFound = useMemo(() => detectControls(periods), [periods]);

  // ── Graceful lag degradation (§F) ────────────────────────────────
  // A hard fail at 23 usable against 24 required is a worse product than a
  // 1-lag model plus a sentence saying why. Stepping the window down drops a
  // parameter AND recovers a row, so it moves both sides of the inequality.
  const effectiveMaxLag = assessment?.feasibleLag != null ? assessment.feasibleLag : maxLag;
  const lagWasReduced = assessment?.canModel === true && effectiveMaxLag < maxLag;

  const result = useMemo(() => analyseHalo(periods, {
    xKey, yKey,
    maxLag: effectiveMaxLag,
    unit: gran,
    controls: controlOpts,
    reference: refMethod ? { method: refMethod, customValue: customRef === '' ? null : Number(customRef) } : null,
    scenarioSpec: customChange !== '' ? { type: 'absolute', value: Number(customChange) } : { type: 'percent', value: Number(scenarioPct) || 10 },
    planning: (planning.ttsRevenue !== '' || planning.marketingSpend !== '')
      ? { ...planning, grainLabel: GRAIN_LABEL[gran], rangeLabel: rangeText(range) }
      : null,
  }), [periods, xKey, yKey, effectiveMaxLag, controlOpts, refMethod, customRef, scenarioPct, customChange, planning, gran, range]);

  const periodsWithData = useMemo(() => periods.filter((p) => p.x != null || p.y != null).length, [periods]);
  const stages = useMemo(() => stageStatuses(result, { periodsWithData }), [result, periodsWithData]);
  const takeaway = useMemo(
    () => keyTakeaway(result, { unit: GRAIN_UNIT[gran], xKey, yKey }),
    [result, gran, xKey, yKey],
  );

  const cur = getHaloCurrency();
  const unit = GRAIN_UNIT[gran];

  if (loading) return <div style={{ color: 'var(--text-muted)', fontSize: 13 }}><span className="wx-spinner" /> Loading data…</div>;
  if (error) return <div className="wx-alert wx-alert-danger"><span>{error}</span></div>;
  if (!srcRows?.length) return <div className="wx-card" style={{ padding: 24, color: 'var(--text-muted)' }}>No rows in this sheet yet.</div>;

  const m = result.adjustedModel;
  const anyCorrelation = result.observed.lagCorrelations.some((r) => r.correlation != null);
  const blockedModel = !m.available;
  const blockedCorrelations = !anyCorrelation;
  const showStatusPanel = (blockedModel || blockedCorrelations) && !chartsOnly;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {glossaryOpen && <GlossaryPanel onClose={() => setGlossaryOpen(false)} />}

      {/* ══ 1 — KEY TAKEAWAY (first viewport) ════════════════════ */}
      <KeyTakeaway takeaway={takeaway} onOpenGlossary={() => setGlossaryOpen(true)} />

      {/* ══ 2 — SCOPE ════════════════════════════════════════════
          Only what a client needs to frame the question. Every analyst knob
          moved into Advanced below: the review's complaint was that the first
          screen was apparatus, and a lag selector is apparatus. */}
      <div className="wx-card" style={{ padding: 14 }}>
        <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <Picker
            label="View"
            value={gran}
            onChange={pickGrain}
            options={grans.map((g) => {
              const a = assessments[g];
              const tag = recommendation?.grain === g ? ' — recommended'
                : a && !a.canModel ? ' — charts only'
                : '';
              return { value: g, label: `${GRAIN_LABEL[g]}${tag}` };
            })}
            hint={assessment ? `${assessment.usable} usable ${assessment.unit}s here` : null}
          />
          <div>
            <FieldLabel>Date range</FieldLabel>
            <div style={{ display: 'flex', gap: 6 }}>
              <input type="date" className="wx-input" style={{ width: 145 }} value={range.start} onChange={(e) => setRange((r) => ({ ...r, start: e.target.value }))} />
              <input type="date" className="wx-input" style={{ width: 145 }} value={range.end} onChange={(e) => setRange((r) => ({ ...r, end: e.target.value }))} />
            </div>
          </div>
          <Picker
            label="TikTok activity"
            value={xKey}
            onChange={setXKey}
            options={tiktokFields.map((f) => ({ value: f.key, label: plainMetricLabel(f.key) }))}
            width={210}
          />
          <Picker
            label="Amazon outcome"
            value={yKey}
            onChange={setYKey}
            options={amazonFields.map((f) => ({ value: f.key, label: plainMetricLabel(f.key) }))}
            width={210}
          />
          <div style={{ paddingBottom: 4 }}>
            <button type="button" className="wx-btn wx-btn-ghost wx-btn-sm" onClick={resetDefaults}>
              <i className="bi bi-arrow-counterclockwise" style={{ marginRight: 6 }} />Reset to defaults
            </button>
          </div>
        </div>

        <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 10 }}>
          <strong>What are we comparing?</strong> {comparisonSentence(xKey, yKey)}
          {' '}— bucketed by {GRAIN_LABEL[gran].toLowerCase()}.
        </div>

        {/* ── Advanced (collapsed by default) ─────────────────── */}
        <button
          type="button"
          className="wx-btn wx-btn-ghost wx-btn-sm"
          style={{ marginTop: 10 }}
          aria-expanded={scopeAdvanced}
          onClick={() => setScopeAdvanced((s) => !s)}
        >
          <i className={`bi bi-chevron-${scopeAdvanced ? 'up' : 'down'}`} style={{ marginRight: 6 }} />
          Advanced options
        </button>
        {scopeAdvanced && (
          <div style={{
            marginTop: 10, paddingTop: 12, borderTop: '1px solid var(--border-subtle)',
            display: 'flex', gap: 14, flexWrap: 'wrap', alignItems: 'flex-end',
          }}>
            <Picker
              label="Halo window"
              value={String(maxLag)}
              onChange={(v) => setMaxLag(Number(v))}
              options={[0, 1, 2, 3].map((l) => ({ value: String(l), label: l === 0 ? `Same ${unit} only` : `${l} ${unit}${l === 1 ? '' : 's'}` }))}
              width={150}
              hint={`Effects that may show up over several ${unit}s.`}
            />
            <div style={{ display: 'flex', gap: 14, alignItems: 'center', paddingBottom: 6, flexWrap: 'wrap' }}>
              <Check label="Adjust for trend" checked={useTrend} onChange={setUseTrend}
                title="Adjust for a steady rise or fall over time, so growth the brand had anyway is not credited to TikTok" />
              <Check label="Adjust for seasonality" checked={useSeasonality} onChange={setUseSeasonality}
                title={`Adjust for an annual cycle — needs about ${PERIODS_PER_YEAR[gran]} ${unit}s of history`} />
              <Check label="Index to 100" checked={normalize} onChange={setNormalize}
                title="Index both series to 100 at the start so metrics on different scales can be compared for shape" />
              <Check label="Show scatter" checked={showScatter} onChange={setShowScatter}
                title="Show the scatter plot alongside the over-time chart" />
            </div>
          </div>
        )}
      </div>

      {lagWasReduced && (
        <Note tone="info">
          Reduced to <strong>{effectiveMaxLag} {unit}{effectiveMaxLag === 1 ? '' : 's'}</strong> because
          this view has {assessment.usable} usable {assessment.unit}s — a {maxLag}-{unit} window would need
          about {assessment.required}. Dropping a lag removes a parameter and recovers a period, so the
          shorter window fits where the requested one did not.
        </Note>
      )}

      {/* ── Guided status panel (§A3) ───────────────────────────── */}
      {showStatusPanel && (
        <StatusPanel
          assessment={assessment}
          recommendation={recommendation}
          suggestion={suggestion}
          onSwitchGrain={pickGrain}
          onKeepExploring={() => setChartsOnly(true)}
          hasSeries={periodsWithData >= 2}
          blockedCorrelations={blockedCorrelations}
          blockedModel={blockedModel}
        />
      )}

      {/* A working alternative should be offered even when nothing is blocked
          at all — but quietly, as a line rather than a panel. */}
      {!showStatusPanel && suggestion && (
        <Note tone="info">
          {recommendation.reason}{' '}
          <button type="button" className="wx-btn wx-btn-ghost wx-btn-sm" style={{ marginLeft: 6 }}
            onClick={() => pickGrain(suggestion.grain)}>{suggestion.cta}</button>
        </Note>
      )}

      {/* ══ 3 — EVIDENCE ═════════════════════════════════════════ */}
      <Layer
        letter="1"
        title="What the data shows"
        subtitle="How the two moved together over this period. Moving together is evidence — it is never proof that one caused the other."
      >
        <ObservedLayer
          result={result} unit={unit} xKey={xKey} yKey={yKey} periods={periods}
          normalize={normalize} assessment={assessment} showScatter={showScatter}
        />
      </Layer>

      {/* ══ 4 — ESTIMATE ═════════════════════════════════════════ */}
      <Layer
        letter="2"
        title="What the model suggests"
        subtitle="An estimate after adjusting for the other factors we have data for. An estimate of association — not proof of cause, and not incremental lift."
        right={m.available ? <ModelledBadge /> : null}
      >
        <AdjustedLayer
          result={result} unit={unit} cur={cur} xKey={xKey} yKey={yKey}
          controlsFound={controlsFound}
          refMethod={refMethod} setRefMethod={setRefMethod}
          customRef={customRef} setCustomRef={setCustomRef}
          scenarioPct={scenarioPct} setScenarioPct={setScenarioPct}
          customChange={customChange} setCustomChange={setCustomChange}
          showAdvanced={showAdvanced} setShowAdvanced={setShowAdvanced}
          periods={periods} maxLag={effectiveMaxLag} controlOpts={controlOpts}
          excludeIndex={excludeIndex} setExcludeIndex={setExcludeIndex}
          assessment={assessment} gran={gran} range={range}
        />
      </Layer>

      {/* ══ 5 — SCENARIOS ════════════════════════════════════════ */}
      <Layer
        letter="3"
        title="What if we invest more?"
        subtitle="Planning is a decision informed by the model, never a measurement of it. Every figure here is an assumption, not a forecast."
        tone="planning"
        right={result.planningEligibility?.eligible ? <ModelledBadge /> : null}
      >
        <PlanningLayer result={result} planning={planning} setPlanning={setPlanning} cur={cur} />
      </Layer>

      {/* ── Secondary: progress, ranking, provenance and export ──
          The measurement stages used to open the page. They are real and worth
          keeping, but they are apparatus: a client wants the answer first and
          the ladder second, so they sit down here as progress rather than as
          the story. */}
      <StageStepper statuses={stages} />
      <HaloFinderV2
        periods={periods} srcRows={srcRows} src={src} gran={gran} yKey={yKey} range={range}
        tiktokFields={tiktokFields} maxLag={effectiveMaxLag} unit={unit}
        suggestion={suggestion} onSwitchGrain={pickGrain}
      />
      <Provenance
        result={result} gran={gran} range={range} unit={unit}
        xKey={xKey} yKey={yKey} cur={cur} periods={periods}
      />
    </div>
  );
}

const rangeText = (range) => (range?.start && range?.end ? `${range.start} to ${range.end}` : null);

// ────────────────────────────────────────────────────────────────
// Layer A
// ────────────────────────────────────────────────────────────────
function ObservedLayer({ result, unit, xKey, yKey, periods, normalize, assessment, showScatter }) {
  const o = result.observed;
  const best = o.lagCorrelations.find((r) => r.lag === o.bestObservedLag);
  const invNoteX = inverseNote(xKey), invNoteY = inverseNote(yKey);
  const anyCorrelation = o.lagCorrelations.some((r) => r.correlation != null);

  const withData = periods.filter((p) => p.x != null || p.y != null);
  const xs = withData.map((p) => p.x);
  const ys = withData.map((p) => p.y);
  const nx = normalize ? indexToHundred(xs) : xs;
  const ny = normalize ? indexToHundred(ys) : ys;
  const chartData = withData.map((p, i) => ({ label: p.label || p.key, x: nx[i], y: ny[i] }));
  const scatter = periods.filter((p) => p.x != null && p.y != null).map((p) => ({ x: p.x, y: p.y, label: p.label }));

  const xName = plainMetricLabel(xKey);
  const yName = plainMetricLabel(yKey);
  const axisSuffix = normalize ? ' (indexed to 100)' : '';

  // Bug B — the tooltip printed raw floats like 733.3333333333333, because
  // Recharts renders whatever it is handed and this tooltip had no formatter.
  // A tooltip is where a client reads an actual number, so it has to carry the
  // unit and stop at a sensible precision.
  const seriesFormatter = (v, name) => {
    const key = name === xName ? xKey : yKey;
    return [formatMetricValue(v, key, { indexed: normalize }), name];
  };

  return (
    <>
      {/* §A4 — when correlations cannot be computed, ONE compact row rather
          than four cards of em dashes. Four blank cards read as breakage; one
          sentence reads as a threshold not yet met. */}
      {!anyCorrelation ? (
        <div style={{
          padding: '10px 14px', borderRadius: 8, background: 'var(--surface-2)',
          border: '1px dashed var(--border-default)', fontSize: 12.5, color: 'var(--text-secondary)',
          display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap',
        }}>
          <i className="bi bi-hourglass" style={{ color: 'var(--text-muted)' }} />
          <span>
            Correlations unlock at <strong>≥ {MIN_CORRELATION_OBS}</strong> overlapping {unit}s
            {assessment ? <> — this view has <strong>{assessment.correlationObs}</strong></> : null}.
            The charts below do not need that much data and are shown regardless.
          </span>
        </div>
      ) : (
        <>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 10, marginBottom: 14 }}>
            {o.lagCorrelations.map((r) => {
              const isBest = r.lag === o.bestObservedLag;
              return (
                <div key={r.lag} title={r.reason || undefined} style={{
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
        </>
      )}

      {normalize && (
        <Note tone="info">
          Both series are indexed to 100 at the first period, so two metrics on different
          scales can be compared for co-movement. Index values are for reading the SHAPE only —
          every figure elsewhere on this page uses the real units.
        </Note>
      )}

      {/* ONE primary chart (§3). The scatter is a diagnostic that answers a
          different question and used to sit at equal weight beside this one,
          which made the section read as two things to interpret rather than
          one. It moves behind Advanced → Show scatter. */}
      <div style={{ display: 'grid', gridTemplateColumns: showScatter ? 'repeat(auto-fit, minmax(320px, 1fr))' : '1fr', gap: 14, marginTop: 12 }}>
        <div style={{ height: 280 }}>
          <div style={{ fontSize: 12, fontWeight: 700, marginBottom: 6 }}>Over time</div>
          <ResponsiveContainer width="100%" height="100%">
            <ComposedChart data={chartData} margin={{ top: 6, right: 10, bottom: 24, left: 6 }}>
              <CartesianGrid stroke={GRID} vertical={false} />
              <XAxis
                dataKey="label" tick={{ fontSize: 10 }} minTickGap={20}
                label={{ value: `Period (${unit})`, position: 'insideBottom', offset: -16, style: { fontSize: 10.5, fill: 'var(--text-muted)' } }}
              />
              <YAxis yAxisId="l" tick={{ fontSize: 10 }} tickFormatter={(v) => formatMetricValue(v, xKey, { indexed: normalize })}
                label={{ value: `${xName}${axisSuffix}`, angle: -90, position: 'insideLeft', style: { fontSize: 10, fill: 'var(--text-muted)', textAnchor: 'middle' } }} />
              <YAxis yAxisId="r" orientation="right" tick={{ fontSize: 10 }} tickFormatter={(v) => formatMetricValue(v, yKey, { indexed: normalize })}
                label={{ value: `${yName}${axisSuffix}`, angle: 90, position: 'insideRight', style: { fontSize: 10, fill: 'var(--text-muted)', textAnchor: 'middle' } }} />
              <Tooltip contentStyle={TT_STYLE} formatter={seriesFormatter} />
              <Legend wrapperStyle={{ fontSize: 11 }} />
              <Bar yAxisId="l" dataKey="x" name={xName} fill={SERIES_TIKTOK} opacity={0.65} />
              <Line yAxisId="r" dataKey="y" name={yName} stroke={SERIES_AMAZON} dot={false} strokeWidth={2} />
            </ComposedChart>
          </ResponsiveContainer>
        </div>
        {showScatter && (
          <div style={{ height: 280 }}>
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
                <Scatter data={scatter} fill={SERIES_TIKTOK} />
              </ScatterChart>
            </ResponsiveContainer>
          </div>
        )}
      </div>

      {/* Coverage note (§3) — plain, factual, never phrased as an error. Thin
          data is a fact about a young brand, not a fault in the page. */}
      <div style={{ fontSize: 11.5, color: 'var(--text-muted)', marginTop: 8 }}>
        {coverageNote({
          periodsSupplied: result.meta.periodsSupplied,
          completeObservations: result.meta.completeObservations,
          unit,
        })}
      </div>
    </>
  );
}

// ────────────────────────────────────────────────────────────────
// Layer B
// ────────────────────────────────────────────────────────────────
function AdjustedLayer({
  result, unit, cur, xKey, yKey, controlsFound, refMethod, setRefMethod,
  customRef, setCustomRef, scenarioPct, setScenarioPct, customChange, setCustomChange,
  showAdvanced, setShowAdvanced, periods, maxLag, controlOpts,
  excludeIndex, setExcludeIndex, assessment,
}) {
  const m = result.adjustedModel;
  const contrib = result.historicalContribution;
  const sens = result.referenceSensitivity;
  const marg = result.marginal;

  const refit = useMemo(() => {
    if (excludeIndex == null) return null;
    return refitWithout(periods, excludeIndex, { maxLag, controls: controlOpts, xKey, yKey });
  }, [excludeIndex, periods, maxLag, controlOpts, xKey, yKey]);

  if (!m.available) {
    return (
      <>
        {/* headline and message are separate fields precisely so this does not
            print the same sentence twice, as it used to. */}
        <Note tone="warn"><strong>{m.headline}</strong> {m.message}</Note>
        {assessment && m.requiredObservations && (
          <ProgressMeter
            usable={m.sampleSize}
            required={m.requiredObservations}
            unit={unit}
            almostThere={assessment.almostThere}
          />
        )}
      </>
    );
  }

  const lagged = m.laggedOnly;
  const hasLagged = m.laggedOnlyAvailable && lagged;
  const fullLabel = `${cur}${m.cumulativeCoefficient.toFixed(2)}`;
  const spansZero = m.confidenceInterval.lower != null && m.confidenceInterval.lower < 0 && m.confidenceInterval.upper > 0;
  const sharePct = m.samePeriodShare == null ? null : Math.round(m.samePeriodShare * 100);

  return (
    <>
      {/* ── The hero, split (§F) ────────────────────────────────── */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 12 }}>
        {hasLagged ? (
          <Stat
            label="Delayed halo (lagged only)"
            value={`${cur}${lagged.coefficient.toFixed(2)} per ${cur}1`}
            sub={lagged.lower == null ? 'No interval available'
              : `95%: ${cur}${lagged.lower.toFixed(2)} to ${cur}${lagged.upper.toFixed(2)}${lagged.spansZero ? ' — includes zero' : ''}`}
            tone={lagged.spansZero ? 'warn' : lagged.coefficient >= 0 ? 'pos' : 'neg'}
            badge={<ModelledBadge compact />}
            emphasis
          />
        ) : (
          <Stat
            label="Same-period association"
            value={`${fullLabel} per ${cur}1`}
            sub={`No lag window selected, so no delayed effect has been looked for.`}
            tone="warn"
            badge={<ModelledBadge compact weakHalo />}
            emphasis
          />
        )}
        <Stat
          label="Full cumulative"
          value={`${fullLabel} per ${cur}1`}
          sub={`Includes same-${unit} co-movement (not a delay)${sharePct != null ? ` — ${sharePct}% of this figure` : ''}`}
          tone="muted"
        />
        <Stat
          label="Model confidence"
          value={m.confidenceLabel}
          sub={`${m.sampleSize} usable ${unit}s · adj R² ${m.adjustedR2 == null ? '—' : m.adjustedR2.toFixed(2)}`}
          tone={m.confidenceCeiling ? 'warn' : undefined}
        />
        <Stat
          label="Modelled contribution"
          value={contrib ? fmtValue(contrib.amount, 'money') : '—'}
          sub={contrib
            ? (contrib.lower != null ? `95%: ${fmtValue(contrib.lower, 'money')} to ${fmtValue(contrib.upper, 'money')}` : contrib.referenceLabel)
            : 'Unavailable'}
          tone={contrib && contrib.amount < 0 ? 'neg' : 'pos'}
          badge={<ModelledBadge compact />}
        />
      </div>

      {/* The sentence that used to promote the combined figure as "the halo". */}
      <p style={{ fontSize: 12.5, color: 'var(--text-secondary)', marginTop: 12 }}>
        {hasLagged ? (
          <>Across the {maxLag} {unit}{maxLag === 1 ? '' : 's'} FOLLOWING a change, an additional {cur}1 of{' '}
            {plainMetricLabel(xKey)} is <strong>associated with</strong> approximately{' '}
            <strong>{cur}{lagged.coefficient.toFixed(2)}</strong> of {plainMetricLabel(yKey)}, after the included controls.
            Adding the same-{unit} movement brings the total to {fullLabel} — but movement inside one {unit} is
            not a delay, and a shared cause such as a promotion produces it just as readily.</>
        ) : (
          <>An additional {cur}1 of {plainMetricLabel(xKey)} moves with approximately <strong>{fullLabel}</strong> of{' '}
            {plainMetricLabel(yKey)} in the SAME {unit}. Nothing here separates a spillover from a shared cause —
            select a lag window above to look for a delayed effect.</>
        )}
      </p>

      {/* Inline definitions for the four terms this section leans on. A client
          reading "95% interval" and "lagged-only" without them is guessing. */}
      <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', marginTop: 10, fontSize: 11.5, color: 'var(--text-muted)' }}>
        <span>What these mean:</span>
        <Term term="Modelled" />
        <Term term="95% interval" />
        <Term term="Confidence" />
        <Term term="Lag" />
        <Term term="Incremental" />
      </div>

      {sharePct != null && (
        <div style={{ marginTop: 8 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11.5, marginBottom: 4 }}>
            <span style={{ color: 'var(--text-secondary)' }}>Same-{unit} share of the cumulative figure</span>
            <strong style={{ color: sharePct >= 60 ? 'var(--warning, #f59e0b)' : 'var(--text-primary)' }}>{sharePct}%</strong>
          </div>
          <div style={{ height: 6, borderRadius: 999, background: 'var(--surface-3, rgba(148,163,184,.18))', overflow: 'hidden', display: 'flex' }}>
            <div style={{ width: `${Math.min(100, Math.max(0, sharePct))}%`, background: 'var(--warning, #f59e0b)' }} />
            <div style={{ flex: 1, background: 'var(--success, #22c55e)' }} />
          </div>
          <div style={{ fontSize: 10.5, color: 'var(--text-muted)', marginTop: 3 }}>
            Amber is same-{unit} co-movement; green is the delayed part.
          </div>
        </div>
      )}
      {m.mixedLagSigns && (
        <Note tone="warn">
          The lag coefficients point in opposite directions, so the split between same-{unit} and
          delayed movement cannot be expressed as a share — the parts would exceed the whole.
          Read the two figures above separately.
        </Note>
      )}

      {/* ── Controls honesty (§E) ───────────────────────────────── */}
      <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', marginTop: 14, fontSize: 12 }}>
        <div>
          <FieldLabel>Controls included</FieldLabel>
          <div style={{ color: 'var(--success, #22c55e)' }}>
            {m.controls.length ? m.controls.map((c) => `✓ ${c}`).join('  ') : '— none'}
          </div>
        </div>
        <div>
          <FieldLabel>Not controlled for</FieldLabel>
          <div style={{ color: 'var(--text-muted)' }}>
            {m.controlsUnavailable.length ? m.controlsUnavailable.map((c) => `✗ ${c}`).join('  ') : 'Nothing outstanding'}
          </div>
        </div>
      </div>

      {/* The copy is now driven by what the model ACTUALLY did. It used to
          claim "adjusted for trend and seasonality" whenever promo and
          stock-out were missing, regardless of whether seasonality had been
          estimated — and below ~52 periods it had not. */}
      {m.controlsMissingMajor.length > 0 && (
        <Note tone="warn">
          Not adjusted for <strong>{m.controlsMissingMajor.map((c) => c.label).join(', ')}</strong>.
          {' '}These are the most common reasons a halo estimate is overstated: a promotion lifts both
          series at once, and a stock-out drops Amazon while TikTok keeps running.
          {!m.seasonalityIncluded && <> Seasonality is <strong>not</strong> controlled either ({m.seasonalityReason}).</>}
          {' '}Add the columns to the sheet and the model will use them automatically.
        </Note>
      )}
      {m.controlsMissingMajor.length === 0 && !m.seasonalityIncluded && (
        <Note tone="info">
          Seasonality is <strong>not</strong> controlled for — {m.seasonalityReason}.
        </Note>
      )}
      {m.confidenceCappedBy?.length > 0 && (
        <Note tone="warn">
          {m.confidenceCappedBy.map((r, i) => <div key={i}>{r}</div>)}
          <div style={{ color: 'var(--text-muted)', marginTop: 4 }}>
            Without that cap the score alone would have read “{m.confidenceEarned}”.
          </div>
        </Note>
      )}

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
          {refit.available && <> (was {fullLabel})</>}
          {refit.available && refit.laggedOnly && <>, and the delayed-only part is <strong>{cur}{refit.laggedOnly.coefficient.toFixed(2)}</strong></>}.
        </Note>
      )}

      {/* ══ STAGE 5 — counterfactual contribution (§G) ═══════════ */}
      <div style={{ marginTop: 20, paddingTop: 16, borderTop: '1px solid var(--border-subtle)' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap', alignItems: 'baseline' }}>
          <div>
            <div style={{ fontSize: 10, fontWeight: 800, letterSpacing: '.08em', color: 'var(--accent)' }}>STAGE 5</div>
            <h3 style={{ fontSize: '.98rem', fontWeight: 800, margin: '2px 0 0' }}>
              <Term term="Counterfactual">Counterfactual contribution</Term>
            </h3>
          </div>
          <ModelledBadge />
        </div>
        <p style={{ fontSize: 12, color: 'var(--text-muted)', margin: '4px 0 12px', maxWidth: 720 }}>
          Amazon revenue predicted under the TikTok activity that happened, minus the same
          prediction with TikTok held at a reference level. The reference is never zero — that
          would be far outside anything the model has seen.
        </p>

        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <Picker
            label="Reference level"
            value={refMethod || result.recommendedReference}
            onChange={(v) => setRefMethod(v)}
            options={REFERENCE_METHOD_SPECS.map((s) => ({
              value: s.name,
              label: s.name === result.recommendedReference ? `${s.short} — recommended` : s.short,
            }))}
            width={230}
            hint={contrib?.referenceDescribe}
          />
          {(refMethod || result.recommendedReference) === 'custom' && (
            <div>
              <FieldLabel>Custom baseline</FieldLabel>
              <input className="wx-input" style={{ width: 150 }} value={customRef}
                onChange={(e) => setCustomRef(e.target.value)} placeholder="e.g. 1200" />
            </div>
          )}
        </div>

        {contrib?.referenceNote && <Note tone="info">{contrib.referenceNote}</Note>}
        {sens?.message && (
          <Note tone={sens.signFlip ? 'danger' : 'warn'}>
            {sens.message}
            <table style={{ marginTop: 6, fontSize: 11.5, borderCollapse: 'collapse' }}>
              <tbody>
                {sens.entries.map((e) => (
                  <tr key={e.method}>
                    <td style={{ padding: '2px 10px 2px 0', color: 'var(--text-muted)' }}>{e.label}</td>
                    <td style={{ padding: '2px 0', fontVariantNumeric: 'tabular-nums' }}>{fmtValue(e.amount, 'money')}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Note>
        )}

        {contrib && (
          <>
            <ContributionChart contribution={contrib} unit={unit} yLabel={plainMetricLabel(yKey)} />
            <div style={{ display: 'flex', gap: 18, flexWrap: 'wrap', marginTop: 10, fontSize: 12 }}>
              <span style={{ color: 'var(--text-muted)' }}>
                Periods above reference: <strong style={{ color: 'var(--success, #22c55e)' }}>{fmtValue(contrib.positiveAmount, 'money')}</strong>
              </span>
              <span style={{ color: 'var(--text-muted)' }}>
                Periods below reference: <strong style={{ color: 'var(--danger, #ef4444)' }}>{fmtValue(contrib.negativeAmount, 'money')}</strong>
              </span>
              <span style={{ color: 'var(--text-muted)' }}>
                Net over {contrib.periods} {unit}s: <strong style={{ color: 'var(--text-primary)' }}>{fmtValue(contrib.amount, 'money')}</strong>
              </span>
            </div>
            {contrib.spansZero && (
              <Note tone="warn">
                The interval on the contribution includes zero, so the total cannot be
                distinguished from no contribution at all over this period.
              </Note>
            )}
          </>
        )}

        {/* §G3 — the what-if belongs UNDER Stage 5, clearly forward-looking. */}
        <div className="wx-card" style={{ padding: 12, marginTop: 14, background: 'var(--surface-2)' }}>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 8, flexWrap: 'wrap' }}>
            <span style={{ fontSize: 12, fontWeight: 700 }}>Forward scenario — what if TikTok activity increases?</span>
            <span style={{ fontSize: 10.5, color: 'var(--text-muted)' }}>Forward-looking, not historical contribution</span>
          </div>
          <div style={{ display: 'flex', gap: 10, alignItems: 'flex-end', flexWrap: 'wrap' }}>
            <Picker
              label="By percent"
              value={String(scenarioPct)}
              onChange={(v) => { setScenarioPct(Number(v)); setCustomChange(''); }}
              options={[5, 10, 20, 50].map((p) => ({ value: String(p), label: `+${p}%` }))}
              width={110}
            />
            <div>
              <FieldLabel>Or by amount</FieldLabel>
              <input className="wx-input" style={{ width: 150 }} placeholder="e.g. 2000" value={customChange}
                onChange={(e) => setCustomChange(e.target.value)} />
            </div>
            {marg && (
              <div style={{ fontSize: 13 }}>
                <span style={{ color: 'var(--text-muted)' }}>
                  {marg.changeLabel} on an average {unit} of {fmtValue(marg.basePeriodActivity, 'num')} →{' '}
                </span>
                <strong style={{ color: marg.estimated >= 0 ? 'var(--success)' : 'var(--danger)' }}>{fmtValue(marg.estimated, 'money')}</strong>
                {marg.lower != null && <span style={{ color: 'var(--text-muted)' }}> ({fmtValue(marg.lower, 'money')} to {fmtValue(marg.upper, 'money')})</span>}
                <div style={{ fontSize: 10.5, color: 'var(--text-muted)' }}>Basis: {marg.basisLabel}</div>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Advanced diagnostics (§21) */}
      {/* Coefficients, HAC standard errors, adjusted R2 and VIF live behind
          this disclosure only (§4). They are the reason an analyst trusts the
          number and the reason a client cannot read the page. */}
      <button
        type="button"
        className="wx-btn wx-btn-ghost wx-btn-sm"
        style={{ marginTop: 14 }}
        aria-expanded={showAdvanced}
        onClick={() => setShowAdvanced((s) => !s)}
      >
        <i className={`bi bi-chevron-${showAdvanced ? 'up' : 'down'}`} /> Technical details
      </button>
      {showAdvanced && (
        <div className="wx-card" style={{ padding: 12, marginTop: 8, fontSize: 12 }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <tbody>
              <Row k="Observations (after lagging)" v={`${m.sampleSize}${m.droppedToLags ? ` — ${m.droppedToLags} dropped to lags` : ''}`} />
              <Row k="Parameters estimated" v={m.parameterCount ?? '—'} />
              <Row k="Adjusted R²" v={m.adjustedR2 == null ? '—' : m.adjustedR2.toFixed(3)} />
              <Row k="Selected max lag" v={`${m.maxLag} ${unit}${m.maxLag === 1 ? '' : 's'}`} />
              <Row k="Standard errors" v={m.covarianceKind} />
              <Row k="Full cumulative coefficient" v={m.cumulativeCoefficient.toFixed(4)} />
              <Row k="Full cumulative 95% interval" v={m.confidenceInterval.lower == null ? '—' : `${m.confidenceInterval.lower.toFixed(4)} to ${m.confidenceInterval.upper.toFixed(4)}`} />
              <Row k="Lagged-only coefficient" v={hasLagged ? lagged.coefficient.toFixed(4) : 'n/a (no lag window)'} />
              <Row k="Lagged-only 95% interval" v={hasLagged && lagged.lower != null ? `${lagged.lower.toFixed(4)} to ${lagged.upper.toFixed(4)}` : '—'} />
              <Row k="Same-period coefficient" v={m.samePeriodCoefficient == null ? '—' : m.samePeriodCoefficient.toFixed(4)} />
              <Row k="Same-period share" v={sharePct == null ? 'withheld (opposing signs)' : `${sharePct}%`} />
              <Row k="Max VIF (lag terms)" v={m.maxVif == null ? '—' : m.maxVif.toFixed(1)} />
            </tbody>
          </table>
          <div style={{ fontWeight: 700, margin: '10px 0 4px' }}>Coefficients by lag</div>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <tbody>
              {(m.lagCoefficients || []).map((c) => (
                <Row key={c.lag} k={c.label} v={`${c.coefficient >= 0 ? '+' : ''}${c.coefficient.toFixed(4)}${c.standardError != null ? `  (± ${(1.96 * c.standardError).toFixed(4)})` : ''}`} />
              ))}
              <Row k="Cumulative (all lags)" v={`${m.cumulativeCoefficient >= 0 ? '+' : ''}${m.cumulativeCoefficient.toFixed(4)}`} />
            </tbody>
          </table>
          <div style={{ fontWeight: 700, margin: '10px 0 4px' }}>Why this confidence rating</div>
          <ul style={{ margin: 0, paddingLeft: 18, color: 'var(--text-secondary)' }}>
            {(m.confidenceReasons || []).map((r, i) => <li key={i}>{r}</li>)}
          </ul>
          {!controlsFound.promo && !controlsFound.stockout && (
            <div style={{ fontSize: 11.5, color: 'var(--text-muted)', marginTop: 8 }}>
              This sheet carries no promotion or stock-out column. The model reads them
              automatically as soon as one appears.
            </div>
          )}
        </div>
      )}
    </>
  );
}

// ────────────────────────────────────────────────────────────────
// Halo Finder V2 (§26, §I)
// ────────────────────────────────────────────────────────────────
function HaloFinderV2({ srcRows, src, gran, yKey, range, tiktokFields, maxLag, unit, suggestion, onSwitchGrain }) {
  const rows = useMemo(() => {
    if (!srcRows?.length || !src) return [];
    const keys = tiktokFields.map((f) => f.key);
    const seriesFor = (k) => buildPeriods({ rows: srcRows, sourceGran: src.sourceGran, gran, xKey: k, yKey, range }).periods;
    return haloFinder(keys, yKey, seriesFor, maxLag);
  }, [srcRows, src, gran, yKey, range, tiktokFields, maxLag]);

  if (!rows.length) return null;
  const usable = rows.filter((r) => r.correlation != null);
  const sorted = [...rows].sort((a, b) => Math.abs(b.correlation ?? 0) - Math.abs(a.correlation ?? 0));

  // §I — a table of zeros is worse than no table. When nothing is computable,
  // say why and offer the grain that would work.
  if (!usable.length) {
    return (
      <div className="wx-card" style={{ padding: 16 }}>
        <div style={{ fontSize: 14, fontWeight: 800, marginBottom: 2 }}>Halo Finder</div>
        <div style={{ fontSize: 12.5, color: 'var(--text-secondary)' }}>
          No TikTok metric has {MIN_CORRELATION_OBS} or more overlapping {unit}s against{' '}
          {plainMetricLabel(yKey)} over this range, so there is nothing to rank yet — a row of zeros
          would imply we had measured no relationship, rather than that we could not look.
        </div>
        {suggestion && (
          <button type="button" className="wx-btn wx-btn-primary wx-btn-sm" style={{ marginTop: 10 }}
            onClick={() => onSwitchGrain(suggestion.grain)}>{suggestion.cta}</button>
        )}
      </div>
    );
  }

  // Which metric has the strongest DELAYED relationship — the halo question,
  // as distinct from strongest overall (which same-period usually wins).
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
        Strongest observed lag relationship for every TikTok metric against {plainMetricLabel(yKey)}. Negative rows are kept —
        they are findings, not omissions.
      </div>
      {laggedBest && (
        <Note tone="info">
          Strongest <strong>delayed</strong> relationship: {plainMetricLabel(laggedBest.metric)} at{' '}
          +{laggedBest.lag} {unit}{laggedBest.lag === 1 ? '' : 's'} ({fmtSignedPct(laggedBest.correlation)}).
          That is a different question from the strongest overall, which same-{unit} movement usually wins.
        </Note>
      )}
      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12.5, minWidth: 520 }}>
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
                <td style={{ padding: '6px 8px' }}>{plainMetricLabel(r.metric)}</td>
                <td style={{ padding: '6px 8px' }}>{r.bestLag == null ? '—' : r.bestLag === 0 ? `Same ${unit}` : `+${r.bestLag} ${unit}${r.bestLag === 1 ? '' : 's'}`}</td>
                <td style={{ padding: '6px 8px', fontWeight: 700, color: signedCorrTextColor(r.correlation) }}>{fmtSignedPct(r.correlation) ?? '—'}</td>
                <td style={{ padding: '6px 8px', color: 'var(--text-muted)' }}>{r.numberOfObservations}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ────────────────────────────────────────────────────────────────
// Provenance (§B)
// ────────────────────────────────────────────────────────────────
// Everything the brief requires to travel WITH a modelled figure: n, the
// interval, controls included and missing, grain, date range, the same-period
// share, and the badge.
//
// It is rendered on the page rather than only attached to a file export,
// because the realistic way one of these numbers leaves the tool is a
// screenshot — and a caveat that only exists in a download does not survive
// that. The copy button produces the same block as text for pasting under a
// figure in a deck.
function Provenance({ result, gran, range, unit, xKey, yKey, cur, periods }) {
  const m = result.adjustedModel;
  const [copied, setCopied] = useState(false);

  // CSV is offered even when the model refused: the series is still real data
  // the client may want, and the summary block then records WHY there is no
  // estimate — which is more useful than no file at all.
  const exportCsv = () => {
    const text = buildHaloV2Csv({ result, periods, gran, range, xKey, yKey, currency: cur });
    downloadHaloV2Csv(text, haloV2CsvFilename({ gran, range }));
  };

  if (!m.available) {
    return (
      <div className="wx-card" style={{ padding: 16, display: 'flex', justifyContent: 'space-between', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
        <div style={{ fontSize: 12.5, color: 'var(--text-muted)' }}>
          No modelled estimate for this window — the series is still available to download.
        </div>
        <button type="button" className="wx-btn wx-btn-ghost wx-btn-sm" onClick={exportCsv}>
          <i className="bi bi-download" style={{ marginRight: 6 }} />Download CSV
        </button>
      </div>
    );
  }

  const lines = [
    `Halo V2 — modelled association, NOT incremental.`,
    `Metrics: ${plainMetricLabel(xKey)} → ${plainMetricLabel(yKey)}`,
    `Grain: ${GRAIN_LABEL[gran]}${rangeText(range) ? ` · ${rangeText(range)}` : ''}`,
    `Observations: ${m.sampleSize} usable ${unit}s (${m.parameterCount} parameters)`,
    m.laggedOnlyAvailable && m.laggedOnly
      ? `Delayed (lagged-only): ${cur}${m.laggedOnly.coefficient.toFixed(2)} per ${cur}1`
        + (m.laggedOnly.lower != null ? ` · 95% ${cur}${m.laggedOnly.lower.toFixed(2)} to ${cur}${m.laggedOnly.upper.toFixed(2)}` : '')
      : `No lag window selected — same-period association only.`,
    `Full cumulative: ${cur}${m.cumulativeCoefficient.toFixed(2)} per ${cur}1`
      + (m.confidenceInterval.lower != null ? ` · 95% ${cur}${m.confidenceInterval.lower.toFixed(2)} to ${cur}${m.confidenceInterval.upper.toFixed(2)}` : ''),
    m.samePeriodShare != null
      ? `Same-${unit} share of cumulative: ${Math.round(m.samePeriodShare * 100)}%`
      : `Same-${unit} share: withheld (lag coefficients oppose each other)`,
    `Standard errors: ${m.covarianceKind}`,
    `Controls included: ${m.controls.length ? m.controls.join(', ') : 'none'}`,
    `Controls missing: ${m.controlsUnavailable.length ? m.controlsUnavailable.join('; ') : 'none'}`,
    `Confidence: ${m.confidenceLabel}${m.confidenceCeiling ? ` (capped from ${m.confidenceEarned})` : ''}`,
    result.historicalContribution
      ? `Contribution vs ${result.historicalContribution.referenceLabel}: ${fmtValue(result.historicalContribution.amount, 'money')}`
      : null,
    `Incremental lift requires geo/holdout validation (Stage 6), which this tool does not perform.`,
  ].filter(Boolean);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(lines.join('\n'));
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch { /* clipboard blocked — the block is on screen to read anyway */ }
  };

  return (
    <div className="wx-card" style={{ padding: 16 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, alignItems: 'center', flexWrap: 'wrap', marginBottom: 8 }}>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <span style={{ fontSize: 13, fontWeight: 800 }}>Methodology &amp; provenance</span>
          <ModelledBadge />
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button type="button" className="wx-btn wx-btn-ghost wx-btn-sm" onClick={exportCsv}>
            <i className="bi bi-download" style={{ marginRight: 6 }} />Download CSV
          </button>
          <button type="button" className="wx-btn wx-btn-ghost wx-btn-sm" onClick={copy}>
            <i className={`bi ${copied ? 'bi-check2' : 'bi-clipboard'}`} style={{ marginRight: 6 }} />
            {copied ? 'Copied' : 'Copy methodology'}
          </button>
        </div>
      </div>
      <div style={{ fontSize: 11.5, color: 'var(--text-muted)', marginBottom: 8, maxWidth: 720 }}>
        Everything a figure from this page needs carried with it. If a number here reaches a deck,
        this block should go under it.
      </div>
      <pre style={{
        margin: 0, fontSize: 11.5, lineHeight: 1.6, whiteSpace: 'pre-wrap',
        color: 'var(--text-secondary)', fontFamily: 'inherit',
      }}>{lines.join('\n')}</pre>
    </div>
  );
}
