// ============================================================
// Amazon Halo — read-only explorer.
//
// One "View by" switch (Daily / Weekly / Monthly) sets the FLOOR granularity;
// metrics are bucketed into that unit and correlated with a lag in the same
// unit. Each metric also has a NATIVE granularity detected from the dataset
// (metricGran) — a metric is only offered at its native granularity and coarser
// (day < week < month), and a metric with no data is hidden. When a selected
// metric is coarser than the current View-by (e.g. a weekly Branded Search
// Volume while viewing Daily) the affected view auto-bumps to that metric's
// granularity and shows an inline notice.
//
// Amazon Revenue carries a per-product picker; Branded Search Volume a keyword
// picker; Keyword Search Rank its own rank-keyword picker.
//
// Extracted from AmazonHaloPage so the Boss page and the public portal render
// the SAME UI. Boss passes onDelete (Delete button); the portal omits it.
// loadRows(datasetId) => Promise<rows> keeps it loader-agnostic.
// ============================================================

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ResponsiveContainer, ComposedChart, LineChart, Line, XAxis, YAxis,
  CartesianGrid, Tooltip, Legend, ScatterChart, Scatter,
} from 'recharts';
import {
  HALO_FIELDS, FIELD_BY_KEY, KSV_KEY, KSR_KEY, PRODUCT_REVENUE_FIELD, GRAN_ORDER,
  fieldsForGran, AMAZON_FIELDS_FOR, TIKTOK_FIELDS_FOR, nativeGranOf, coarsestGran,
  fmtValue, setHaloCurrency,
} from '../../lib/haloFields';
import {
  indexByDate, buildBuckets, pairBuckets, correlationMatrix, overlaySeries,
  directionSentence, strengthLabel, corrColor,
} from '../../lib/haloMath';

const PALETTE = ['#6366f1', '#22c55e', '#f59e0b', '#ef4444', '#06b6d4', '#a855f7', '#ec4899', '#14b8a6'];
const TT_STYLE = { background: 'var(--surface-1, #16161c)', border: '1px solid var(--border-default, #2b2b35)', borderRadius: 8, fontSize: 12, color: 'var(--text-primary, #e8e8ee)' };
const GRID = 'var(--border-subtle, #2b2b3522)';
const REV = PRODUCT_REVENUE_FIELD;
const KSV = KSV_KEY;
const KSR = KSR_KEY;
const LAG_MAX = { day: 14, week: 8, month: 6 };
const UNIT = { day: 'day', week: 'week', month: 'month' };
const GRAN_ADJ = { day: 'daily', week: 'weekly', month: 'monthly' };
const unitLabel = (gran, n) => `${n} ${UNIT[gran]}${n === 1 ? '' : 's'}`;

// Merge the dataset's stored metricGran with what the loaded rows actually carry
// (covers legacy datasets that predate metric_gran, and fills any gaps). Keeps
// the FINEST granularity per metric (day < week < month).
function buildMetricGran(ds, rows) {
  const g = {};
  const setFinest = (k, gran) => { if (!g[k] || GRAN_ORDER[gran] < GRAN_ORDER[g[k]]) g[k] = gran; };
  const stored = ds && ds.metric_gran && typeof ds.metric_gran === 'object' ? ds.metric_gran : null;
  if (stored) for (const k in stored) if (stored[k]) setFinest(k, stored[k]);
  for (const r of rows || []) {
    for (const k in (r.metrics || {})) if (r.metrics[k] != null) setFinest(k, 'day');
    if (Object.keys(r.productRevenue || {}).length) setFinest(REV, 'day');
    // All-zero branded-search is "not available" — don't let it claim day-native
    // and pre-empt a weekly Branded Demand source (mirrors the parser rule).
    if (Object.values(r.keywords || {}).some((v) => v)) setFinest(KSV, 'day');
    if (Object.keys(r.keywordRanks || {}).length) setFinest(KSR, 'day');
  }
  for (const w of ds?.weekly_metrics || []) for (const k in (w.metrics || {})) if (w.metrics[k] != null) setFinest(k, 'week');
  if (!g[KSV] && ds?.weekly_keywords?.length) setFinest(KSV, 'week');
  for (const m of ds?.monthly_metrics || []) for (const k in (m.metrics || {})) if (m.metrics[k] != null) setFinest(k, 'month');
  return g;
}

export default function HaloExplorer({ datasets, loadRows, onDelete, initialDatasetId = null }) {
  const [selectedId, setSelectedId] = useState(initialDatasetId);
  const [rows, setRows] = useState(null);
  const [rowsFor, setRowsFor] = useState(null);  // which dataset `rows` belongs to
  const [rowsLoading, setRowsLoading] = useState(false);
  const [error, setError] = useState('');

  const [gran, setGran] = useState('day');       // day | week | month (the floor)
  const [rawLag, setRawLag] = useState(0);       // halo delay; clamped per gran below
  const [view, setView] = useState('compare');   // compare | heatmap | overlay | lagfinder
  const [range, setRange] = useState({ start: '', end: '' });
  const [product, setProduct] = useState(null);  // null = All products (revenue total)
  const [keyword, setKeyword] = useState(null);  // null = All keywords (branded search volume)
  const [rankKeyword, setRankKeyword] = useState(null); // null = All keywords (avg rank)
  const [downloading, setDownloading] = useState(false);

  const selectedDs = datasets.find((d) => d.id === selectedId) || null;

  useEffect(() => {
    if (!datasets.length) { setSelectedId(null); return; }
    if (!datasets.find((d) => d.id === selectedId)) setSelectedId(datasets[0].id);
  }, [datasets]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (initialDatasetId && datasets.find((d) => d.id === initialDatasetId)) setSelectedId(initialDatasetId);
  }, [initialDatasetId]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { setHaloCurrency(selectedDs?.currency || '$'); }, [selectedDs?.currency]);

  useEffect(() => {
    if (!selectedId) { setRows(null); return; }
    let alive = true;
    setRowsLoading(true); setError('');
    Promise.resolve(loadRows(selectedId))
      .then((r) => {
        if (!alive) return;
        setRows(r);
        setRowsFor(selectedId);
        if (r.length) setRange({ start: r[0].date, end: r[r.length - 1].date });
      })
      .catch((e) => alive && setError(e.message || String(e)))
      .finally(() => alive && setRowsLoading(false));
    return () => { alive = false; };
  }, [selectedId, loadRows]);

  const metricGran = useMemo(() => buildMetricGran(selectedDs, rows), [selectedDs, rows]);

  const productList = useMemo(() => {
    const s = new Set();
    (rows || []).forEach((r) => Object.keys(r.productRevenue || {}).forEach((k) => s.add(k)));
    return [...s].sort();
  }, [rows]);

  const ksvByWeek = useMemo(
    () => new Map((selectedDs?.weekly_keywords || []).map((w) => [w.week_ending, w.keywords || {}])),
    [selectedDs?.weekly_keywords],
  );
  const weeklyMetrics = useMemo(() => selectedDs?.weekly_metrics || [], [selectedDs?.weekly_metrics]);
  const monthlyMetrics = useMemo(() => selectedDs?.monthly_metrics || [], [selectedDs?.monthly_metrics]);

  // Keyword lists: daily keyword data lives on the rows; weekly branded search
  // lives on the dataset's weekly_keywords. Union both so the picker works
  // whichever granularity Branded Search Volume is native to.
  const keywordList = useMemo(() => {
    const s = new Set();
    (rows || []).forEach((r) => Object.keys(r.keywords || {}).forEach((k) => s.add(k)));
    (selectedDs?.weekly_keywords || []).forEach((w) => Object.keys(w.keywords || {}).forEach((k) => s.add(k)));
    return [...s].sort();
  }, [rows, selectedDs?.weekly_keywords]);
  const rankKeywordList = useMemo(() => {
    const s = new Set();
    (rows || []).forEach((r) => Object.keys(r.keywordRanks || {}).forEach((k) => s.add(k)));
    return [...s].sort();
  }, [rows]);

  useEffect(() => { setProduct(null); setKeyword(null); setRankKeyword(null); }, [selectedId]);
  useEffect(() => { if (product && !productList.includes(product)) setProduct(null); }, [productList, product]);
  useEffect(() => { if (keyword && !keywordList.includes(keyword)) setKeyword(null); }, [keywordList, keyword]);
  useEffect(() => { if (rankKeyword && !rankKeywordList.includes(rankKeyword)) setRankKeyword(null); }, [rankKeywordList, rankKeyword]);

  // Resolve the scoped metrics: revenue → picked product, branded search → picked
  // keyword, rank → picked rank-keyword (each only when day-native rows carry it;
  // weekly branded search resolves per-keyword inside the math instead).
  const byDate = useMemo(() => {
    const base = rows || [];
    if (!product && !keyword && !rankKeyword) return indexByDate(base);
    const m = {};
    for (const r of base) {
      const metrics = { ...r.metrics };
      if (product) metrics[REV] = r.productRevenue?.[product] ?? null;
      if (keyword) metrics[KSV] = r.keywords?.[keyword] ?? null;
      if (rankKeyword) metrics[KSR] = r.keywordRanks?.[rankKeyword] ?? null;
      m[r.date] = metrics;
    }
    return m;
  }, [rows, product, keyword, rankKeyword]);

  const dates = useMemo(() => {
    if (!rows) return [];
    return rows.map((r) => r.date).filter((d) => (!range.start || d >= range.start) && (!range.end || d <= range.end));
  }, [rows, range]);

  // Loader-agnostic bucket factory: build buckets at ANY granularity from the
  // same inputs, so each view can bump to its selected metrics' native gran.
  const getBuckets = useCallback(
    (g) => buildBuckets({
      byDate, dates, gran: g, metricGran, weeklyMetrics, monthlyMetrics,
      ksvByWeek, keyword, allKeywords: keywordList,
    }),
    [byDate, dates, metricGran, weeklyMetrics, monthlyMetrics, ksvByWeek, keyword, keywordList],
  );

  const rowsReady = !!rows && rowsFor === selectedId; // don't render one frame of old rows + new dataset
  const topBuckets = useMemo(() => getBuckets(gran), [getBuckets, gran]);

  // Field lists offered at the current floor granularity (metricGran gating).
  const amazonFields = AMAZON_FIELDS_FOR(gran, metricGran);
  const tiktokFields = TIKTOK_FIELDS_FOR(gran, metricGran);
  const allFields = fieldsForGran(gran, metricGran);
  // Any metric that only exists coarser than Daily → surfaces the "switch up" hint.
  const hasCoarserMetric = Object.values(metricGran).some((g) => GRAN_ORDER[g] > 0);

  async function downloadXlsx() {
    if (!rows || !selectedDs || downloading) return;
    setDownloading(true);
    try {
      const XLSX = await import('xlsx');
      const rowVolKw = [...new Set((rows || []).flatMap((r) => Object.keys(r.keywords || {})))].sort();
      const rowRankKw = [...new Set((rows || []).flatMap((r) => Object.keys(r.keywordRanks || {})))].sort();
      const cols = [{ label: 'Date', get: (r) => r.date }];
      for (const f of HALO_FIELDS) {
        if (f.key === KSV) {
          if (rowVolKw.length) rowVolKw.forEach((k) => cols.push({ label: k, get: (r) => r.keywords?.[k] ?? '' }));
          else if (metricGran[KSV] === 'day') cols.push({ label: f.label, get: (r) => r.metrics?.[f.key] ?? '' });
          // weekly branded search is written to the Branded Demand sheet below
          continue;
        }
        if (f.key === REV) {
          // Suffix each per-product column with "Revenue/Day" so re-importing this
          // export detects them as revenue columns (not branded-search keywords).
          productList.forEach((p) => cols.push({ label: `${p} Revenue/Day`, get: (r) => r.productRevenue?.[p] ?? '' }));
          cols.push({ label: f.sheetHeader || f.label, get: (r) => r.metrics?.[f.key] ?? '' });
          continue;
        }
        if (f.key === KSR) {
          if (rowRankKw.length) rowRankKw.forEach((k) => cols.push({ label: k, get: (r) => r.keywordRanks?.[k] ?? '' }));
          else if (metricGran[KSR] === 'day') cols.push({ label: f.label, get: (r) => r.metrics?.[f.key] ?? '' });
          continue;
        }
        if (metricGran[f.key] && metricGran[f.key] !== 'day') continue; // coarse-native → not on the daily sheet
        cols.push({ label: f.sheetHeader || f.label, get: (r) => r.metrics?.[f.key] ?? '' });
      }
      const daily = [cols.map((c) => c.label), ...rows.map((r) => cols.map((c) => c.get(r)))];
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(daily), 'Daily');
      const wk = selectedDs.weekly_keywords || [];
      if (wk.length) {
        const kws = [...new Set(wk.flatMap((w) => Object.keys(w.keywords || {})))];
        const weekly = [['Week Ending', ...kws], ...wk.map((w) => [w.week_ending, ...kws.map((k) => w.keywords?.[k] ?? '')])];
        XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(weekly), 'Branded Demand');
      }
      const safe = String(selectedDs.name || 'dataset').replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '') || 'dataset';
      XLSX.writeFile(wb, `halo-${safe}.xlsx`);
    } catch (e) {
      setError(e.message || String(e));
    } finally {
      setDownloading(false);
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      {error && <div className="wx-alert wx-alert-danger"><span>{error}</span></div>}

      <DatasetBar datasets={datasets} selectedId={selectedId} onSelect={setSelectedId}
        onDelete={onDelete} onDownload={downloadXlsx} downloading={downloading} canDownload={!!rows && !rowsLoading} />

      {!selectedId ? (
        <div className="wx-card" style={{ padding: 28, textAlign: 'center', color: 'var(--text-muted)' }}>No dataset selected.</div>
      ) : rowsLoading || !rowsReady ? (
        <div className="wx-card" style={{ padding: 28, textAlign: 'center' }}><span className="wx-spinner" /> Loading data…</div>
      ) : (
        <>
          <FiltersBar gran={gran} setGran={setGran} lag={Math.min(rawLag, LAG_MAX[gran])} setLag={setRawLag} range={range} setRange={setRange}
            period={{ start: selectedDs?.period_start, end: selectedDs?.period_end }} showCoarserHint={gran === 'day' && hasCoarserMetric} />

          <ScopeBar
            productList={productList} product={product} setProduct={setProduct}
            keywordList={metricGran[KSV] ? keywordList : []} keyword={keyword} setKeyword={setKeyword}
            rankKeywordList={metricGran[KSR] ? rankKeywordList : []} rankKeyword={rankKeyword} setRankKeyword={setRankKeyword} />

          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {[['compare', 'Compare two'], ['heatmap', 'Correlation heatmap'], ['overlay', 'Multi-metric overlay'], ['lagfinder', 'Lag finder']].map(([k, label]) => (
              <button key={k} type="button" className={`wx-btn ${view === k ? 'wx-btn-primary' : 'wx-btn-ghost'} wx-btn-sm`} onClick={() => setView(k)}>{label}</button>
            ))}
          </div>

          {topBuckets.length < 3 ? (
            <div className="wx-card" style={{ padding: 24, textAlign: 'center', color: 'var(--text-muted)' }}>
              Not enough {UNIT[gran]}s in range to correlate (need at least 3) — try a wider range or a finer granularity.
            </div>
          ) : view === 'compare' ? (
            <CompareView getBuckets={getBuckets} gran={gran} setGran={setGran} rawLag={rawLag}
              metricGran={metricGran} amazonFields={amazonFields} tiktokFields={tiktokFields} />
          ) : view === 'heatmap' ? (
            <HeatmapView getBuckets={getBuckets} gran={gran} lag={Math.min(rawLag, LAG_MAX[gran])}
              amazonFields={amazonFields} tiktokFields={tiktokFields} allFields={allFields} />
          ) : view === 'overlay' ? (
            <OverlayView getBuckets={getBuckets} gran={gran} allFields={allFields} />
          ) : (
            <LagFinderView getBuckets={getBuckets} gran={gran} setGran={setGran} rawLag={rawLag}
              metricGran={metricGran} amazonFields={amazonFields} tiktokFields={tiktokFields} />
          )}
        </>
      )}
    </div>
  );
}

// ============================================================
function DatasetBar({ datasets, selectedId, onSelect, onDelete, onDownload, downloading, canDownload }) {
  if (!datasets.length) return null;
  const sel = datasets.find((d) => d.id === selectedId);
  return (
    <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
      <select className="wx-input" style={{ maxWidth: 380 }} value={selectedId || ''} onChange={(e) => onSelect(e.target.value)}>
        {datasets.map((d) => <option key={d.id} value={d.id}>{d.name} · {d.row_count} days</option>)}
      </select>
      {sel && onDownload && (
        <button type="button" className="wx-btn wx-btn-ghost wx-btn-sm" disabled={!canDownload || downloading} onClick={onDownload} title="Download this dataset as an Excel workbook">
          {downloading ? <><span className="wx-spinner" /> Preparing…</> : <><i className="bi bi-download" /> Download</>}
        </button>
      )}
      {sel && onDelete && <button type="button" className="wx-btn wx-btn-ghost wx-btn-sm" onClick={() => onDelete(sel.id)}>Delete</button>}
    </div>
  );
}

// ============================================================
function FiltersBar({ gran, setGran, lag, setLag, range, setRange, period, showCoarserHint }) {
  return (
    <div className="wx-card" style={{ padding: 12, display: 'flex', gap: 18, alignItems: 'center', flexWrap: 'wrap' }}>
      <Segmented label="View by" value={gran} onChange={setGran} options={[['day', 'Daily'], ['week', 'Weekly'], ['month', 'Monthly']]} />
      <div style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 200 }}>
        <span style={{ fontSize: 11, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '.05em' }}>
          Halo lag: <strong style={{ color: 'var(--accent)' }}>{unitLabel(gran, lag)}</strong>
        </span>
        <input type="range" min={0} max={LAG_MAX[gran]} value={lag} onChange={(e) => setLag(Number(e.target.value))} />
      </div>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <label style={{ fontSize: 11, color: 'var(--text-muted)' }}>From
          <input type="date" className="wx-input" style={{ marginLeft: 4 }} min={period.start} max={period.end} value={range.start}
            onChange={(e) => setRange((r) => ({ ...r, start: e.target.value }))} />
        </label>
        <label style={{ fontSize: 11, color: 'var(--text-muted)' }}>To
          <input type="date" className="wx-input" style={{ marginLeft: 4 }} min={period.start} max={period.end} value={range.end}
            onChange={(e) => setRange((r) => ({ ...r, end: e.target.value }))} />
        </label>
      </div>
      {showCoarserHint && (
        <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
          🔎 Some Amazon metrics are weekly — switch to <strong>Weekly</strong> to compare them.
        </span>
      )}
    </div>
  );
}

function Segmented({ label, value, onChange, options }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <span style={{ fontSize: 11, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '.05em' }}>{label}</span>
      <div style={{ display: 'flex', gap: 4 }}>
        {options.map(([k, l]) => (
          <button key={k} type="button" className={`wx-btn ${value === k ? 'wx-btn-primary' : 'wx-btn-ghost'} wx-btn-sm`} onClick={() => onChange(k)}>{l}</button>
        ))}
      </div>
    </div>
  );
}

// Shared scope: product feeds Amazon Revenue, keyword feeds Branded Search
// Volume, rank keyword feeds Keyword Search Rank. Each shows only when it applies.
function ScopeBar({ productList, product, setProduct, keywordList, keyword, setKeyword, rankKeywordList, rankKeyword, setRankKeyword }) {
  if (!productList.length && !keywordList.length && !rankKeywordList.length) return null;
  const box = (label, value, onChange, list, allLabel, badge, tint) => (
    <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
      <span style={{ fontSize: 11, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '.05em', fontWeight: 600 }}>{label}</span>
      <select className="wx-input" style={{ maxWidth: 220, height: 30, padding: '2px 8px', fontSize: 12.5 }} value={value || ''} onChange={(e) => onChange(e.target.value || null)}>
        <option value="">{allLabel}</option>
        {list.map((x) => <option key={x} value={x}>{x}</option>)}
      </select>
      {value && <span style={{ background: 'var(--surface-2)', color: tint, borderRadius: 999, padding: '3px 10px', fontSize: 11, fontWeight: 700, whiteSpace: 'nowrap' }}>{badge}: {value}</span>}
    </div>
  );
  return (
    <div className="wx-card" style={{ padding: '10px 12px', display: 'flex', gap: 22, alignItems: 'center', flexWrap: 'wrap' }}>
      {productList.length > 0 && box('Product (revenue)', product, setProduct, productList, 'All products (total)', 'Revenue', 'var(--accent)')}
      {keywordList.length > 0 && box('Keyword (search)', keyword, setKeyword, keywordList, 'All keywords (total)', 'Search', '#f59e0b')}
      {rankKeywordList.length > 0 && box('Rank keyword', rankKeyword, setRankKeyword, rankKeywordList, 'All keywords (avg)', 'Rank', '#a855f7')}
    </div>
  );
}

// A field <select> with Amazon / TikTok optgroups. Keeps the currently-selected
// field visible even if it's coarser than the current floor gran (so switching
// View-by down doesn't drop the selection — the view auto-bumps instead).
function FieldSelect({ value, onChange, amazonFields, tiktokFields }) {
  const withSel = (fields, group) => {
    if (!value || fields.some((f) => f.key === value)) return fields;
    const f = FIELD_BY_KEY[value];
    return f && f.group === group ? [...fields, f] : fields;
  };
  const az = withSel(amazonFields, 'amazon');
  const tt = withSel(tiktokFields, 'tiktok');
  const opt = (f) => <option key={f.key} value={f.key}>{f.label}</option>;
  return (
    <select className="wx-input" value={value} onChange={(e) => onChange(e.target.value)} style={{ maxWidth: 240 }}>
      <optgroup label="Amazon">{az.map(opt)}</optgroup>
      <optgroup label="TikTok / GMV Max">{tt.map(opt)}</optgroup>
    </select>
  );
}

// Inline "comparing at weekly/monthly" notice + shortcuts to make it the primary
// View-by. Rendered when a selected metric's native gran is coarser than the
// current floor gran, so the view is auto-bumped.
function GranNotice({ effGran, userGran, coarseFieldLabel, setGran }) {
  if (GRAN_ORDER[effGran] <= GRAN_ORDER[userGran]) return null;
  return (
    <div style={{
      border: '1px solid var(--accent, #6366f1)', background: 'color-mix(in srgb, var(--accent, #6366f1) 10%, transparent)',
      borderRadius: 'var(--radius-md, 8px)', padding: '8px 12px', fontSize: 12.5, color: 'var(--text-primary)',
      display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap',
    }}>
      <span><strong>{coarseFieldLabel}</strong> is {GRAN_ADJ[effGran]} — comparing at <strong>{GRAN_ADJ[effGran]}</strong>.</span>
      {userGran !== 'week' && GRAN_ORDER.week >= GRAN_ORDER[effGran] && (
        <button type="button" className="wx-btn wx-btn-ghost wx-btn-sm" onClick={() => setGran('week')}>View weekly</button>
      )}
      {effGran !== 'month' && (
        <button type="button" className="wx-btn wx-btn-ghost wx-btn-sm" onClick={() => setGran('month')}>View monthly</button>
      )}
    </div>
  );
}

// ============================================================
// Compare
// ============================================================
function CompareView({ getBuckets, gran, setGran, rawLag, metricGran, amazonFields, tiktokFields }) {
  const dfltTt = tiktokFields.find((f) => f.key === 'video_per_day')?.key || tiktokFields[0]?.key || '';
  const dfltAz = amazonFields.find((f) => f.key === 'revenue_per_day')?.key || amazonFields[0]?.key || '';
  const [a, setA] = useState(dfltTt);
  const [b, setB] = useState(dfltAz);
  const avail = useMemo(() => new Set([...amazonFields, ...tiktokFields].map((f) => f.key)), [amazonFields, tiktokFields]);
  // Keep a valid selection: a metric with NO data at all (not in metricGran) is
  // reset; a metric that's merely coarser stays selected and bumps the gran.
  useEffect(() => { if (!metricGran[a]) setA(dfltTt); }, [metricGran, a, dfltTt]);
  useEffect(() => { if (!metricGran[b]) setB(dfltAz); }, [metricGran, b, dfltAz]);

  const effGran = coarsestGran(gran, nativeGranOf(a, metricGran), nativeGranOf(b, metricGran));
  const lag = Math.min(rawLag, LAG_MAX[effGran]);
  const buckets = useMemo(() => getBuckets(effGran), [getBuckets, effGran]);

  const fa = FIELD_BY_KEY[a], fb = FIELD_BY_KEY[b];
  const { points, r, n } = useMemo(() => pairBuckets(buckets, a, b, lag, effGran), [buckets, a, b, lag, effGran]);
  const lineData = points.map((p) => ({ label: p.label, a: p.x, b: p.y }));
  const crossSide = fa?.group !== fb?.group; // lag is only applied across TikTok↔Amazon
  const coarseField = GRAN_ORDER[nativeGranOf(a, metricGran)] >= GRAN_ORDER[nativeGranOf(b, metricGran)] ? fa : fb;

  if (!fa || !fb) return <div className="wx-card" style={{ padding: 24, textAlign: 'center', color: 'var(--text-muted)' }}>No metrics available at this granularity.</div>;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <GranNotice effGran={effGran} userGran={gran} coarseFieldLabel={coarseField?.label} setGran={setGran} />
      <div className="wx-card" style={{ padding: 14, display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
          <FieldSelect value={a} onChange={setA} amazonFields={amazonFields} tiktokFields={tiktokFields} />
          <span style={{ color: 'var(--text-muted)' }}>vs</span>
          <FieldSelect value={b} onChange={setB} amazonFields={amazonFields} tiktokFields={tiktokFields} />
          <RBadge r={r} />
        </div>
        <div style={{ fontSize: 13, color: 'var(--text-muted)' }}>{directionSentence(a, b, r, n)}</div>

        <div style={{ width: '100%', height: 280 }}>
          <ResponsiveContainer width="100%" height="100%">
            <ComposedChart data={lineData} margin={{ top: 8, right: 8, bottom: 4, left: 0 }}>
              <CartesianGrid stroke={GRID} strokeDasharray="3 3" />
              <XAxis dataKey="label" tick={{ fontSize: 10, fill: 'var(--text-muted)' }} minTickGap={effGran === 'day' ? 20 : 6} />
              <YAxis yAxisId="l" tick={{ fontSize: 10, fill: PALETTE[0] }} width={54} />
              <YAxis yAxisId="r" orientation="right" tick={{ fontSize: 10, fill: PALETTE[1] }} width={54} />
              <Tooltip contentStyle={TT_STYLE} formatter={(val, key) => [fmtValue(val, key === 'a' ? fa.fmt : fb.fmt), key === 'a' ? fa.label : fb.label]} />
              <Legend formatter={(k) => (k === 'a' ? fa.label : fb.label)} wrapperStyle={{ fontSize: 12 }} />
              <Line yAxisId="l" type="monotone" dataKey="a" stroke={PALETTE[0]} dot={effGran !== 'day'} strokeWidth={2} />
              <Line yAxisId="r" type="monotone" dataKey="b" stroke={PALETTE[1]} dot={effGran !== 'day'} strokeWidth={2} />
            </ComposedChart>
          </ResponsiveContainer>
        </div>
        {lag > 0 && (
          <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
            {crossSide ? `Amazon side sampled ${unitLabel(effGran, lag)} after the TikTok ${UNIT[effGran]}.` : 'Lag has no effect when both metrics are on the same side.'}
          </div>
        )}
      </div>

      <div className="wx-card" style={{ padding: 14 }}>
        <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 8 }}>
          Scatter — each point is one {UNIT[effGran]}. A tighter diagonal band = stronger correlation.
        </div>
        <div style={{ width: '100%', height: 260 }}>
          <ResponsiveContainer width="100%" height="100%">
            <ScatterChart margin={{ top: 8, right: 12, bottom: 16, left: 0 }}>
              <CartesianGrid stroke={GRID} strokeDasharray="3 3" />
              <XAxis type="number" dataKey="x" name={fa.label} tick={{ fontSize: 10, fill: 'var(--text-muted)' }}
                label={{ value: fa.label, position: 'insideBottom', offset: -8, fontSize: 11, fill: 'var(--text-muted)' }} />
              <YAxis type="number" dataKey="y" name={fb.label} width={54} tick={{ fontSize: 10, fill: 'var(--text-muted)' }} />
              <Tooltip contentStyle={TT_STYLE} cursor={{ strokeDasharray: '3 3' }} formatter={(val, key) => [fmtValue(val, key === 'x' ? fa.fmt : fb.fmt), key === 'x' ? fa.label : fb.label]} />
              <Scatter data={points} fill={PALETTE[4]} fillOpacity={0.7} />
            </ScatterChart>
          </ResponsiveContainer>
        </div>
      </div>
    </div>
  );
}

function RBadge({ r }) {
  const a = r == null ? 0 : Math.abs(r);
  let bg = 'var(--surface-2)', fg = 'var(--text-muted)';
  if (r != null && r < 0) {
    bg = a >= 0.6 ? 'rgba(239,68,68,.20)' : a >= 0.3 ? 'rgba(239,68,68,.14)' : 'rgba(239,68,68,.10)';
    fg = '#ef4444';
  } else if (r != null) {
    bg = a >= 0.6 ? 'rgba(34,197,94,.18)' : a >= 0.3 ? 'rgba(245,158,11,.18)' : 'var(--surface-2)';
    fg = a >= 0.6 ? '#22c55e' : a >= 0.3 ? '#f59e0b' : 'var(--text-muted)';
  }
  return (
    <span style={{ background: bg, color: fg, borderRadius: 999, padding: '4px 12px', fontWeight: 700, fontSize: 13 }}>
      r = {r == null ? '—' : r.toFixed(2)} · {strengthLabel(r)}
    </span>
  );
}

// ============================================================
// Heatmap
// ============================================================
function HeatmapView({ getBuckets, gran, lag, amazonFields, tiktokFields, allFields }) {
  const [full, setFull] = useState(false);
  const rowFields = full ? allFields : amazonFields;
  const colFields = full ? allFields : tiktokFields;
  const buckets = useMemo(() => getBuckets(gran), [getBuckets, gran]);
  const matrix = useMemo(
    () => correlationMatrix(buckets, rowFields.map((f) => f.key), colFields.map((f) => f.key), lag, gran),
    [buckets, rowFields, colFields, lag, gran],
  );

  return (
    <div className="wx-card" style={{ padding: 14, display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
        <div style={{ fontSize: 13, color: 'var(--text-muted)' }}>
          Correlation (r) of each <strong>{full ? 'metric' : 'Amazon'}</strong> row against each column ({UNIT[gran]}ly). Green = positive, red = negative, stronger = more saturated.
        </div>
        <label style={{ fontSize: 12, display: 'flex', gap: 6, alignItems: 'center' }}>
          <input type="checkbox" checked={full} onChange={(e) => setFull(e.target.checked)} /> Show all fields
        </label>
      </div>
      <div style={{ overflowX: 'auto' }}>
        <table style={{ borderCollapse: 'collapse', fontSize: 11 }}>
          <thead>
            <tr>
              <th style={{ position: 'sticky', left: 0, background: 'var(--surface-1)', zIndex: 1 }} />
              {colFields.map((c) => (
                <th key={c.key} style={{ padding: '4px 6px', color: 'var(--text-muted)', fontWeight: 600, writingMode: 'vertical-rl', transform: 'rotate(180deg)', height: 96, whiteSpace: 'nowrap' }}>{c.label}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rowFields.map((rf, i) => (
              <tr key={rf.key}>
                <td style={{ padding: '4px 8px', color: 'var(--text-primary)', fontWeight: 600, whiteSpace: 'nowrap', position: 'sticky', left: 0, background: 'var(--surface-1)' }}>{rf.label}</td>
                {colFields.map((cf, j) => {
                  const cell = matrix[i][j];
                  const same = rf.key === cf.key;
                  return (
                    <td key={cf.key} title={`${rf.label} vs ${cf.label}: r=${cell.r == null ? 'n/a' : cell.r.toFixed(2)} (n=${cell.n})`}
                      style={{ padding: '6px 8px', textAlign: 'center', minWidth: 46, background: same ? 'var(--surface-2)' : corrColor(cell.r), color: 'var(--text-primary)', fontWeight: cell.r != null && Math.abs(cell.r) >= 0.6 ? 700 : 400, borderRadius: 3 }}>
                      {same ? '—' : cell.r == null ? '·' : cell.r.toFixed(2)}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ============================================================
// Overlay
// ============================================================
function OverlayView({ getBuckets, gran, allFields }) {
  const availKeys = useMemo(() => new Set(allFields.map((f) => f.key)), [allFields]);
  const buckets = useMemo(() => getBuckets(gran), [getBuckets, gran]);
  const [keys, setKeys] = useState(['video_per_day', 'revenue_per_day', 'product_impressions']);
  useEffect(() => {
    setKeys((cur) => {
      const kept = cur.filter((k) => availKeys.has(k));
      if (kept.length) return kept;
      return allFields.slice(0, 2).map((f) => f.key);
    });
  }, [availKeys]); // eslint-disable-line react-hooks/exhaustive-deps
  const data = useMemo(() => overlaySeries(buckets, keys), [buckets, keys]);
  const toggle = (k) => setKeys((cur) => (cur.includes(k) ? cur.filter((x) => x !== k) : [...cur, k]));

  return (
    <div className="wx-card" style={{ padding: 14, display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
        Overlay several metrics on one timeline. Values are normalised to 0–100 so different scales share an axis — this compares <strong>shape</strong>, not magnitude. Tap a chip to add/remove.
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
        {allFields.map((f) => {
          const on = keys.includes(f.key);
          const color = PALETTE[keys.indexOf(f.key) % PALETTE.length];
          return (
            <button key={f.key} type="button" onClick={() => toggle(f.key)} className={`wx-btn wx-btn-sm ${on ? '' : 'wx-btn-ghost'}`}
              style={on ? { background: color, borderColor: color, color: '#fff' } : { fontSize: 11 }}>
              {f.group === 'amazon' ? '🟠 ' : ''}{f.label}
            </button>
          );
        })}
      </div>
      <div style={{ width: '100%', height: 320 }}>
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={data} margin={{ top: 8, right: 8, bottom: 4, left: 0 }}>
            <CartesianGrid stroke={GRID} strokeDasharray="3 3" />
            <XAxis dataKey="label" tick={{ fontSize: 10, fill: 'var(--text-muted)' }} minTickGap={10} />
            <YAxis tick={{ fontSize: 10, fill: 'var(--text-muted)' }} width={40} domain={[0, 100]} />
            <Tooltip contentStyle={TT_STYLE} formatter={(val, key, item) => {
              const f = FIELD_BY_KEY[key]; const raw = item?.payload?.[`${key}__raw`];
              return [fmtValue(raw, f?.fmt), f?.label || key];
            }} />
            <Legend formatter={(k) => FIELD_BY_KEY[k]?.label || k} wrapperStyle={{ fontSize: 12 }} />
            {keys.map((k, i) => <Line key={k} type="monotone" dataKey={k} stroke={PALETTE[i % PALETTE.length]} dot={false} strokeWidth={2} connectNulls />)}
          </LineChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

// ============================================================
// Lag finder — every TikTok metric vs ONE Amazon metric across lag 0..max,
// surfacing where the correlation peaks (lag in the effective granularity's unit).
// ============================================================
function LagFinderView({ getBuckets, gran, setGran, rawLag, metricGran, amazonFields, tiktokFields }) {
  const [amazonKey, setAmazonKey] = useState(amazonFields[0]?.key || '');
  const [rankBy, setRankBy] = useState('positive');
  useEffect(() => { if (!amazonFields.find((f) => f.key === amazonKey)) setAmazonKey(amazonFields[0]?.key || ''); }, [amazonFields, amazonKey]);
  const amazonField = FIELD_BY_KEY[amazonKey];

  const effGran = coarsestGran(gran, nativeGranOf(amazonKey, metricGran));
  const buckets = useMemo(() => getBuckets(effGran), [getBuckets, effGran]);
  const lags = useMemo(() => Array.from({ length: LAG_MAX[effGran] + 1 }, (_, i) => i), [effGran]);

  const grid = useMemo(() => tiktokFields.map((tf) => {
    const cells = lags.map((L) => { const { r, n } = pairBuckets(buckets, tf.key, amazonKey, L, effGran); return { lag: L, r, n }; });
    const valid = cells.filter((c) => c.r != null);
    let best = null;
    if (valid.length) best = rankBy === 'magnitude' ? valid.reduce((a, b) => (Math.abs(b.r) > Math.abs(a.r) ? b : a)) : valid.reduce((a, b) => (b.r > a.r ? b : a));
    return { field: tf, cells, best };
  }), [buckets, tiktokFields, lags, amazonKey, rankBy, effGran]);

  const topSignals = useMemo(() => {
    const all = [];
    grid.forEach((row) => row.cells.forEach((c) => { if (c.r != null) all.push({ field: row.field, lag: c.lag, r: c.r }); }));
    all.sort((a, b) => (rankBy === 'magnitude' ? Math.abs(b.r) - Math.abs(a.r) : b.r - a.r));
    return all.slice(0, 6);
  }, [grid, rankBy]);

  if (!amazonField || !amazonFields.length) return <div className="wx-card" style={{ padding: 24, textAlign: 'center', color: 'var(--text-muted)' }}>No Amazon metric available at this granularity.</div>;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <GranNotice effGran={effGran} userGran={gran} coarseFieldLabel={amazonField?.label} setGran={setGran} />
      <div className="wx-card" style={{ padding: 14, display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
          <span style={{ fontSize: 13, color: 'var(--text-muted)' }}>Every TikTok metric vs</span>
          <select className="wx-input" style={{ maxWidth: 240 }} value={amazonKey} onChange={(e) => setAmazonKey(e.target.value)}>
            {amazonFields.map((f) => <option key={f.key} value={f.key}>{f.label}</option>)}
          </select>
          <span style={{ fontSize: 13, color: 'var(--text-muted)' }}>across halo lag 0–{LAG_MAX[effGran]} {UNIT[effGran]}s</span>
          <div style={{ marginLeft: 'auto', display: 'flex', gap: 4 }}>
            {[['positive', 'Strongest positive'], ['magnitude', 'Strongest (any)']].map(([k, l]) => (
              <button key={k} type="button" className={`wx-btn wx-btn-sm ${rankBy === k ? 'wx-btn-primary' : 'wx-btn-ghost'}`} onClick={() => setRankBy(k)}>{l}</button>
            ))}
          </div>
        </div>
        <div style={{ fontSize: 12.5, color: 'var(--text-muted)' }}>
          Each cell is Pearson <strong>r</strong> between that TikTok metric and <strong>{amazonField?.label}</strong> sampled that many {UNIT[effGran]}s later. Peak lag per row is outlined.
        </div>
        <div style={{ overflowX: 'auto' }}>
          <table style={{ borderCollapse: 'collapse', fontSize: 11 }}>
            <thead>
              <tr>
                <th style={{ position: 'sticky', left: 0, background: 'var(--surface-1)', zIndex: 1, textAlign: 'left', padding: '4px 8px', color: 'var(--text-muted)', fontWeight: 600 }}>TikTok metric</th>
                <th colSpan={lags.length} style={{ padding: '2px 6px', color: 'var(--text-muted)', fontWeight: 600, fontSize: 10.5, textTransform: 'uppercase', letterSpacing: '.05em' }}>Halo lag ({UNIT[effGran]}s)</th>
                <th style={{ padding: '4px 8px', color: 'var(--text-muted)', fontWeight: 600 }}>Peak</th>
              </tr>
              <tr>
                <th style={{ position: 'sticky', left: 0, background: 'var(--surface-1)', zIndex: 1 }} />
                {lags.map((L) => <th key={L} style={{ padding: '3px 6px', color: 'var(--text-muted)', fontWeight: 600, minWidth: 34, textAlign: 'center' }}>{L}</th>)}
                <th />
              </tr>
            </thead>
            <tbody>
              {grid.map((row) => (
                <tr key={row.field.key}>
                  <td style={{ padding: '4px 8px', color: 'var(--text-primary)', fontWeight: 600, whiteSpace: 'nowrap', position: 'sticky', left: 0, background: 'var(--surface-1)' }}>{row.field.label}</td>
                  {row.cells.map((c) => {
                    const isPeak = row.best && c.lag === row.best.lag;
                    return (
                      <td key={c.lag} title={`${row.field.label} → ${amazonField?.label} @ lag ${c.lag} ${UNIT[effGran]}: r=${c.r == null ? 'n/a' : c.r.toFixed(2)} (n=${c.n})`}
                        style={{ padding: '5px 6px', textAlign: 'center', minWidth: 34, background: corrColor(c.r), color: 'var(--text-primary)', fontWeight: isPeak ? 800 : (c.r != null && Math.abs(c.r) >= 0.6 ? 700 : 400), outline: isPeak ? '2px solid var(--accent)' : 'none', outlineOffset: -2, borderRadius: 3 }}>
                        {c.r == null ? '·' : c.r.toFixed(2)}
                      </td>
                    );
                  })}
                  <td style={{ padding: '4px 8px', whiteSpace: 'nowrap', color: 'var(--text-muted)' }}>
                    {row.best ? <>lag <strong style={{ color: 'var(--text-primary)' }}>{row.best.lag}{UNIT[effGran][0]}</strong> · r <strong style={{ color: 'var(--text-primary)' }}>{row.best.r.toFixed(2)}</strong></> : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="wx-card" style={{ padding: 14, display: 'flex', flexDirection: 'column', gap: 10 }}>
        <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--text-primary)' }}>Strongest signals for {amazonField?.label}</div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {topSignals.length === 0 ? (
            <div style={{ color: 'var(--text-muted)', fontSize: 13 }}>Not enough overlapping data to correlate yet.</div>
          ) : topSignals.map((s, i) => (
            <div key={`${s.field.key}-${s.lag}`} style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 13 }}>
              <span style={{ width: 18, color: 'var(--text-muted)', fontVariantNumeric: 'tabular-nums' }}>{i + 1}.</span>
              <span style={{ width: 10, height: 10, borderRadius: 3, background: corrColor(s.r), flex: '0 0 auto', outline: '1px solid var(--border-subtle)' }} />
              <span style={{ color: 'var(--text-primary)', fontWeight: 600 }}>{s.field.label}</span>
              <span style={{ color: 'var(--text-muted)' }}>at <strong style={{ color: 'var(--text-primary)' }}>lag {unitLabel(effGran, s.lag)}</strong></span>
              <span style={{ marginLeft: 'auto', fontWeight: 700, color: s.r < 0 ? '#ef4444' : (s.r >= 0.3 ? '#22c55e' : 'var(--text-muted)') }}>
                r = {s.r.toFixed(2)} · {strengthLabel(s.r)}
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
