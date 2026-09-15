// ============================================================
// Halo V2 - the explorer.
//
// Two audiences, one page. A client lead wants one defendable sentence and a
// plan; an operator wants the metric pickers, the diagnostics and the stage
// ladder. Building for the average of the two produced a page that served
// neither, so the page has a MEETING view and a LAB view, and the toggle is
// always available.
//
// The spine a client walks is Snapshot, then See, Adjust, Estimate, Plan. The
// Book 4 stage ladder (descriptive, correlations, regression, distributed lag,
// counterfactual, validation) still exists and still drives what is shown, but
// it lives in the Depth drawer: it is how the work is organised internally, not
// how a brand manager asks the question.
//
// Three rules hold everywhere on this page:
//   - modelled is never called incremental, and the badge travels with the number
//   - a figure the model cannot support is not rendered as though it could
//   - missing data is a threshold with a next step, never a wall of dashes
//
// This file is composition and state. Each step owns its own file.
// ============================================================

import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { setHaloCurrency, getHaloCurrency } from '../../lib/haloFields';
import {
  sourceForGran, dailySourceFor, availableGrans, availableFields, dataSpan, buildPeriods, detectControls,
} from '../../lib/haloV2/dataAdapter';
import { analyseHalo } from '../../lib/haloV2/index.js';
import { assessGrains, recommendGrain, grainSwitchSuggestion, GRAIN_LABEL, GRAIN_UNIT } from '../../lib/haloV2/grainRecommendation.js';
import { PERIODS_PER_YEAR } from '../../lib/haloV2/controls.js';
import { stageStatuses } from '../../lib/haloV2/stages.js';
import { buildSnapshot } from '../../lib/haloV2/snapshot.js';
import { plainMetricLabel, keyTakeaway } from '../../lib/haloV2/plainLanguage.js';
import { buildHaloV2Csv, downloadHaloV2Csv, haloV2CsvFilename } from '../../lib/haloV2/exportCsv.js';
import { exportNodeToPng } from '../../lib/haloV2/exportImage.js';
import { exportReportToPdf } from '../../utils/exportReportPdf';
import Snapshot from './Snapshot.jsx';
import ScopeBar from './ScopeBar.jsx';
import SeeLayer, { OverTimeChart } from './SeeLayer.jsx';
import AdjustLayer from './AdjustLayer.jsx';
import EstimateLayer from './EstimateLayer.jsx';
import PlanningLayer from './PlanningLayer.jsx';
import ContributionChart from './ContributionChart.jsx';
import DepthDrawer from './DepthDrawer.jsx';
import HaloFinder from './HaloFinder.jsx';
import StatusPanel from './StatusPanel.jsx';
import ClientSummarySheet, { summaryFilename } from './ClientSummarySheet.jsx';
import { GlossaryPanel } from './Glossary.jsx';
import { ProvenanceBlock } from './Provenance.jsx';
import { Picker, Check, Note, Section } from './shared.jsx';

const MODE_KEY = 'wx.haloV2.viewMode';

export default function HaloV2Explorer({
  datasets, loadRows, brandName = null,
  // Share links open in Meeting and stay there until someone asks for Lab.
  // The internal page remembers what the operator last used.
  defaultMode = 'meeting', rememberMode = false,
  // The internal page owns the client-links modal, so it hands the explorer a
  // way to open it: sharing belongs in the Share menu with the exports, not as
  // a fifth button somewhere else on the page.
  onManageLinks = null,
  // A quiet way back to V1, for Lab only. The portal has no route to it.
  v1Href = null,
}) {
  const [rowsById, setRowsById] = useState({});
  const [loading, setLoading] = useState(false);
  const [error, setError]     = useState('');

  const [mode, setMode]   = useState(() => readMode(defaultMode, rememberMode));
  const [gran, setGran]   = useState('week');
  const [range, setRange] = useState({ start: '', end: '' });
  const [xKey, setXKey]   = useState('gmv');
  const [yKey, setYKey]   = useState('revenue_per_day');
  const [maxLag, setMaxLag] = useState(3);
  const [useTrend, setUseTrend] = useState(true);
  const [useSeasonality, setUseSeasonality] = useState(true);
  const [refMethod, setRefMethod] = useState(null);       // null means the model's recommendation
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
  const [exportBusy, setExportBusy] = useState(null);
  const [toast, setToast] = useState('');
  const [planning, setPlanning] = useState({
    ttsRevenue: '', marketingSpend: '', assumptions: null, mode: null,
    periodLabel: '', currency: '',
  });

  const lab = mode === 'lab';
  const pickMode = (m) => {
    setMode(m);
    if (rememberMode) { try { localStorage.setItem(MODE_KEY, m); } catch { /* private mode */ } }
  };

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
    setPlanning({ ttsRevenue: '', marketingSpend: '', assumptions: null, mode: null, periodLabel: '', currency: '' });
    // srcRows / dailyRows / grainPinned / autoAppliedFor are declared below;
    // this closure only ever runs from a click, long after the render that
    // defines them.
    if (srcRows?.length) setRange(dataSpan(srcRows, dailyRows));
    grainPinned.current = false;
    autoAppliedFor.current = null;
  };

  // Once the user picks a grain deliberately, stop moving it under them. The
  // recommendation is still computed and still offered as a button; it just
  // stops being applied automatically.
  const grainPinned = useRef(false);
  // The off-screen one-page document both exports rasterise.
  const summaryRef = useRef(null);

  const list = datasets || [];
  const dsKey = list.map((d) => d.id).join(',');
  const grans = useMemo(() => availableGrans(list), [dsKey]);        // eslint-disable-line react-hooks/exhaustive-deps
  const src = useMemo(() => sourceForGran(list, gran), [dsKey, gran]); // eslint-disable-line react-hooks/exhaustive-deps
  const srcRows = src?.dataset?.id ? (rowsById[src.dataset.id] || null) : null;
  // Weekly and monthly take the charted metrics from the daily sheet wherever it
  // covers a whole period, so a weekly sheet built before the latest daily
  // upload cannot hold them back (dailyFill.js).
  const dailySrc = useMemo(() => dailySourceFor(list, src), [dsKey, src]); // eslint-disable-line react-hooks/exhaustive-deps
  const dailyRows = dailySrc?.id ? (rowsById[dailySrc.id] || null) : null;

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
  // Everything these sheets cover, which is both the default range and what the
  // date picker offers as "All data".
  const span = useMemo(() => dataSpan(srcRows, dailyRows), [srcRows, dailyRows]);
  useEffect(() => {
    if (srcRows && srcRows.length) setRange(span);
    else setRange({ start: '', end: '' });
  }, [src?.dataset?.id, srcRows, dailyRows]);   // eslint-disable-line react-hooks/exhaustive-deps

  const fields = useMemo(() => availableFields(srcRows, dailyRows), [srcRows, dailyRows]);
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

  // ── Grain assessment across EVERY grain ──────────────────────────
  const assessments = useMemo(() => {
    if (!srcRows?.length) return {};
    const periodsFor = (g) => {
      const s = sourceForGran(list, g);
      if (!s) return [];
      const rows = s.dataset?.id ? rowsById[s.dataset.id] : null;
      if (!rows?.length) return [];
      const daily = dailySourceFor(list, s);
      return buildPeriods({
        rows, sourceGran: s.sourceGran, gran: g, xKey, yKey, range,
        dailyRows: daily?.id ? rowsById[daily.id] : null,
      }).periods;
    };
    return assessGrains(grans, periodsFor, { maxLag, controls: controlOpts });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dsKey, rowsById, grans, xKey, yKey, range, maxLag, controlOpts, srcRows]);

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
  // sheet's span, which changes what every grain can support, so an unlatched
  // effect can oscillate forever: recommend Daily, switch, range widens, Weekly
  // now fits, recommend Weekly, switch, range narrows, recommend Daily again.
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

  const { periods, filledFromDaily } = useMemo(() => buildPeriods({
    rows: srcRows, sourceGran: src?.sourceGran, gran, xKey, yKey, range, dailyRows,
  }), [srcRows, src?.sourceGran, gran, xKey, yKey, range, dailyRows]);

  const controlsFound = useMemo(() => detectControls(periods), [periods]);

  // ── Graceful lag degradation ─────────────────────────────────────
  const effectiveMaxLag = assessment?.feasibleLag != null ? assessment.feasibleLag : maxLag;
  const lagWasReduced = assessment?.canModel === true && effectiveMaxLag < maxLag;

  const result = useMemo(() => analyseHalo(periods, {
    xKey, yKey,
    maxLag: effectiveMaxLag,
    unit: gran,
    controls: controlOpts,
    reference: refMethod ? { method: refMethod, customValue: customRef === '' ? null : Number(customRef) } : null,
    scenarioSpec: customChange !== '' ? { type: 'absolute', value: Number(customChange) } : { type: 'percent', value: Number(scenarioPct) || 10 },
    // Always handed the planning state, so an edited percentage survives before
    // any revenue has been typed. The Plan step decides what to render from it.
    planning: { ...planning, grainLabel: GRAIN_LABEL[gran], rangeLabel: rangeText(range) },
  }), [periods, xKey, yKey, effectiveMaxLag, controlOpts, refMethod, customRef, scenarioPct, customChange, planning, gran, range]);

  const periodsWithData = useMemo(() => periods.filter((p) => p.x != null || p.y != null).length, [periods]);
  const stages = useMemo(() => stageStatuses(result, { periodsWithData }), [result, periodsWithData]);
  const cur = getHaloCurrency();
  const unit = GRAIN_UNIT[gran];
  const takeaway = useMemo(() => keyTakeaway(result, { unit, xKey, yKey }), [result, unit, xKey, yKey]);
  const snapshot = useMemo(() => buildSnapshot(result, { unit, cur }), [result, unit, cur]);

  // ── Exports ──────────────────────────────────────────────────────
  // A download gives no feedback of its own in some browsers, and the Share
  // menu closes on click, so say what happened.
  const say = (msg) => { setToast(msg); setTimeout(() => setToast(''), 2600); };

  const exportCsv = () => {
    const text = buildHaloV2Csv({
      result, periods, gran, range, xKey, yKey, currency: cur, brandName, snapshot,
      planning: { ...planning, currency: planning.currency || cur },
    });
    downloadHaloV2Csv(text, haloV2CsvFilename({ brandName, gran, range }));
    say('CSV downloaded.');
  };
  const runExport = async (kind) => {
    if (!summaryRef.current || exportBusy) return;
    const title = summaryFilename({ brandName, gran, range });
    setExportBusy(kind);
    try {
      if (kind === 'pdf') await exportReportToPdf(summaryRef.current, { title });
      else await exportNodeToPng(summaryRef.current, { filename: title });
      say(kind === 'pdf' ? 'One-pager downloaded.' : 'Image downloaded.');
    } finally {
      setExportBusy(null);
    }
  };

  if (loading) return <div style={{ color: 'var(--text-muted)', fontSize: 13 }}><span className="wx-spinner" /> Loading data…</div>;
  if (error) return <div className="wx-alert wx-alert-danger"><span>{error}</span></div>;
  if (!srcRows?.length) return <div className="wx-card" style={{ padding: 24, color: 'var(--text-muted)' }}>No rows in this sheet yet.</div>;

  const m = result.adjustedModel;
  const anyCorrelation = result.observed.lagCorrelations.some((r) => r.correlation != null);
  const blockedModel = !m.available;
  const blockedCorrelations = !anyCorrelation;
  const showStatusPanel = (blockedModel || blockedCorrelations) && !chartsOnly;
  const contribution = result.historicalContribution;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {glossaryOpen && <GlossaryPanel onClose={() => setGlossaryOpen(false)} />}

      {/* ══ Scope: one row, everything else behind it ═════════════ */}
      <ScopeBar
        mode={mode} onMode={pickMode} lab={lab}
        grans={grans} gran={gran} onGran={pickGrain}
        assessments={assessments} recommendation={recommendation}
        range={range} setRange={setRange} span={span}
        xKey={xKey} yKey={yKey} setXKey={setXKey} setYKey={setYKey}
        tiktokFields={tiktokFields} amazonFields={amazonFields} onReset={resetDefaults}
        onManageLinks={onManageLinks}
        onPdf={() => runExport('pdf')} onPng={() => runExport('png')} onCsv={exportCsv}
        exportBusy={exportBusy}
        onGlossary={() => setGlossaryOpen(true)}
      >
        {lab && (
          <>
            <button
              type="button"
              className="wx-btn wx-btn-ghost wx-btn-sm"
              style={{ marginTop: 10 }}
              aria-expanded={scopeAdvanced}
              onClick={() => setScopeAdvanced((s) => !s)}
            >
              <i className={`bi bi-chevron-${scopeAdvanced ? 'up' : 'down'}`} style={{ marginRight: 6 }} />
              Analyst options
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
                    title={`Adjust for an annual cycle. Needs about ${PERIODS_PER_YEAR[gran]} ${unit}s of history`} />
                  <Check label="Index to 100" checked={normalize} onChange={setNormalize}
                    title="Index both series to 100 at the start so metrics on different scales can be compared for shape" />
                  <Check label="Show scatter" checked={showScatter} onChange={setShowScatter}
                    title="Show the scatter plot alongside the over-time chart" />
                </div>
              </div>
            )}
          </>
        )}
      </ScopeBar>

      {/* ══ 0 - SNAPSHOT ══════════════════════════════════════════ */}
      {/* Brand, period and the metric pair are all in the scope bar directly
          above, so the snapshot states the answer and nothing else. */}
      <Snapshot
        snapshot={snapshot}
        headline={takeaway.headline}
        chart={contribution?.perPeriod?.length
          ? <ContributionChart contribution={contribution} unit={unit} yLabel={plainMetricLabel(yKey)} />
          : <OverTimeChart periods={periods} xKey={xKey} yKey={yKey} unit={unit} normalize={normalize} height={220} compact />}
        chartCaption={contribution?.perPeriod?.length
          ? null
          : `${plainMetricLabel(yKey)} against ${plainMetricLabel(xKey)}, by ${unit}.`}
      />

      {/* Guided readiness, when something is blocked. */}
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
      {!showStatusPanel && suggestion && (
        <Note tone="info">
          {recommendation.reason}{' '}
          <button type="button" className="wx-btn wx-btn-ghost wx-btn-sm" style={{ marginLeft: 6 }}
            onClick={() => pickGrain(suggestion.grain)}>{suggestion.cta}</button>
        </Note>
      )}
      {lagWasReduced && (
        <Note tone="info">
          Reduced to <strong>{effectiveMaxLag} {unit}{effectiveMaxLag === 1 ? '' : 's'}</strong> because this
          view has {assessment.usable} usable {assessment.unit}s and a {maxLag}-{unit} window would need
          about {assessment.required}. Dropping a lag removes a parameter and recovers a period, so the
          shorter window fits where the requested one did not.
        </Note>
      )}

      {/* ══ 1 - SEE ═══════════════════════════════════════════════ */}
      <Section
        step="Step 1 · See"
        title="Do TikTok and Amazon move together?"
        question="How the two moved over this period."
      >
        <SeeLayer
          result={result} unit={unit} xKey={xKey} yKey={yKey} periods={periods}
          normalize={normalize} assessment={assessment} showScatter={showScatter}
          filledFromDaily={filledFromDaily} lab={lab}
        />
      </Section>

      {/* ══ 2 - ADJUST ════════════════════════════════════════════ */}
      <Section
        step="Step 2 · Adjust"
        title="What did we adjust for?"
        question="What else could explain the movement, and which of those we could account for."
      >
        <AdjustLayer
          result={result} unit={unit} cur={cur} xKey={xKey} yKey={yKey}
          periods={periods} maxLag={effectiveMaxLag} controlOpts={controlOpts}
          excludeIndex={excludeIndex} setExcludeIndex={setExcludeIndex}
          showAdvanced={showAdvanced} setShowAdvanced={setShowAdvanced}
          assessment={assessment} lab={lab}
        />
      </Section>

      {/* ══ 3 - ESTIMATE ══════════════════════════════════════════ */}
      <Section
        step="Step 3 · Estimate"
        title="How much Amazon looks tied to TikTok in this window?"
        question="An estimate of association after the adjustments above."
      >
        <EstimateLayer
          result={result} unit={unit} cur={cur} xKey={xKey} yKey={yKey}
          refMethod={refMethod} setRefMethod={setRefMethod}
          customRef={customRef} setCustomRef={setCustomRef}
          scenarioPct={scenarioPct} setScenarioPct={setScenarioPct}
          customChange={customChange} setCustomChange={setCustomChange}
          lab={lab}
        />
      </Section>

      {/* ══ 4 - PLAN ══════════════════════════════════════════════ */}
      <Section
        step="Step 4 · Plan"
        title="If we plan TikTok at these assumptions, what Amazon effect should we discuss?"
        question="Every figure here is a planning assumption, not a measurement."
        tone="planning"
      >
        <PlanningLayer result={result} planning={planning} setPlanning={setPlanning} cur={cur} />
      </Section>

      {/* ══ Depth, then the operator's tools ══════════════════════ */}
      <DepthDrawer
        statuses={stages}
        model={m}
        unit={unit}
        referenceLabel={contribution?.referenceLabel || null}
      />

      {lab && (
        <HaloFinder
          srcRows={srcRows} dailyRows={dailyRows} src={src} gran={gran} xKey={xKey} yKey={yKey}
          range={range} tiktokFields={tiktokFields} maxLag={effectiveMaxLag} unit={unit}
          suggestion={suggestion} onSwitchGrain={pickGrain} onPickMetric={setXKey}
        />
      )}
      {lab && (
        <ProvenanceBlock
          result={result} gran={gran} range={range} unit={unit} xKey={xKey} yKey={yKey} cur={cur}
        />
      )}
      {lab && (
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', fontSize: 11.5, color: 'var(--text-muted)' }}>
          {!controlsFound.promo && !controlsFound.stockout && (
            <span>
              This sheet carries no promotion or stock-out column. The model reads them automatically as
              soon as one appears.
            </span>
          )}
          {v1Href && (
            <Link to={v1Href} style={{ color: 'var(--text-muted)', marginLeft: 'auto', whiteSpace: 'nowrap' }}>
              Open the original Halo tool
            </Link>
          )}
        </div>
      )}

      {/* Downloads are silent in some browsers and the Share menu closes on
          click, so confirm what just happened, briefly. */}
      {toast && (
        <div
          role="status"
          style={{
            position: 'fixed', bottom: 20, left: '50%', transform: 'translateX(-50%)', zIndex: 60,
            background: 'var(--surface-1)', border: '1px solid var(--border-default)',
            borderRadius: 999, boxShadow: 'var(--shadow-lg)', padding: '8px 16px',
            fontSize: 12.5, fontWeight: 600, color: 'var(--text-primary)',
            display: 'inline-flex', alignItems: 'center', gap: 8,
          }}
        >
          <i className="bi bi-check-circle-fill" style={{ color: 'var(--success)' }} />{toast}
        </div>
      )}

      {/* Off-screen document both one-pager exports rasterise. Always mounted
          so the export has something laid out the moment it is asked; it is
          aria-hidden and outside the flow, so it costs a client nothing. */}
      <ClientSummarySheet
        sheetRef={summaryRef}
        result={result} takeaway={takeaway} snapshot={snapshot} planning={planning} periods={periods}
        gran={gran} range={range} xKey={xKey} yKey={yKey} cur={cur} brandName={brandName}
      />
    </div>
  );
}

const rangeText = (range) => (range?.start && range?.end ? `${range.start} to ${range.end}` : null);

function readMode(defaultMode, remember) {
  if (!remember) return defaultMode;
  try {
    const saved = localStorage.getItem(MODE_KEY);
    return saved === 'lab' || saved === 'meeting' ? saved : defaultMode;
  } catch {
    return defaultMode;        // private browsing, or storage blocked
  }
}
