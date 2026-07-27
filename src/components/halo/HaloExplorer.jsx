// ============================================================
// Amazon Halo — read-only explorer (per-brand, 3-sheet model).
//
// A brand has up to three datasets (day / week / month), passed in `datasets`.
// The "View by" switch picks the SOURCE for that granularity: the matching sheet
// if uploaded, else the finest available FINER sheet rolled up (daily→week/month,
// week→month). A view is never a mix — one source per granularity.
//
// Fields offered at a granularity come from THAT source's rows (a metric with no
// non-zero data there is hidden — e.g. NTB blank in the daily sheet is hidden in
// Daily but shows in Weekly where it was filled). Lag is in the view's own unit.
//
// Extracted so the Boss page and the public portal render the SAME UI.
// loadRows(datasetId) => Promise<rows> keeps it loader-agnostic. Upload/delete of
// the per-granularity slots is handled by the page, not here.
// ============================================================

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ResponsiveContainer, ComposedChart, LineChart, Line, XAxis, YAxis,
  CartesianGrid, Tooltip, Legend, ScatterChart, Scatter,
} from 'recharts';
import {
  HALO_FIELDS, FIELD_BY_KEY, KSV_KEY, KSR_KEY, PRODUCT_REVENUE_FIELD,
  availSetForRows, fieldsAvail, amazonAvail, tiktokAvail,
  fmtValue, setHaloCurrency,
} from '../../lib/haloFields';
import {
  buildBucketsFromSource, pairBuckets, correlationMatrix, overlaySeries,
  directionSentence, strengthLabel, corrColor, corrTextColor, fmtCorrPct,
} from '../../lib/haloMath';

const PALETTE = ['#6366f1', '#22c55e', '#f59e0b', '#ef4444', '#06b6d4', '#a855f7', '#ec4899', '#14b8a6'];
const TT_STYLE = { background: 'var(--surface-1, #16161c)', border: '1px solid var(--border-default, #2b2b35)', borderRadius: 8, fontSize: 12, color: 'var(--text-primary, #e8e8ee)' };
const GRID = 'var(--border-subtle, #2b2b3522)';
const REV = PRODUCT_REVENUE_FIELD;
const KSV = KSV_KEY;
const KSR = KSR_KEY;
const LAG_MAX = { day: 14, week: 8, month: 6 };
const UNIT = { day: 'day', week: 'week', month: 'month' };
const GRAN_LABEL = { day: 'daily', week: 'weekly', month: 'monthly' };
const unitLabel = (gran, n) => `${n} ${UNIT[gran]}${n === 1 ? '' : 's'}`;

export default function HaloExplorer({ datasets, loadRows }) {
  const [rowsById, setRowsById] = useState({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const [gran, setGran] = useState('day');       // day | week | month (the view)
  const [rawLag, setRawLag] = useState(0);       // halo delay; clamped per gran below
  const [view, setView] = useState('compare');   // compare | heatmap | overlay | lagfinder
  const [range, setRange] = useState({ start: '', end: '' });
  const [product, setProduct] = useState(null);
  const [keyword, setKeyword] = useState(null);
  const [rankKeyword, setRankKeyword] = useState(null);
  const [downloading, setDownloading] = useState(false);

  const list = datasets || [];
  const dsByGran = useMemo(() => {
    const m = {};
    for (const d of list) if (d.granularity) m[d.granularity] = d;
    return m;
  }, [list]);

  // Source for a view granularity: the matching sheet, else the finest finer one.
  const sourceFor = useCallback((g) => {
    if (g === 'day') return dsByGran.day ? { dataset: dsByGran.day, sourceGran: 'day' } : null;
    if (g === 'week') {
      if (dsByGran.week) return { dataset: dsByGran.week, sourceGran: 'week' };
      if (dsByGran.day) return { dataset: dsByGran.day, sourceGran: 'day' };
      return null;
    }
    if (dsByGran.month) return { dataset: dsByGran.month, sourceGran: 'month' };
    if (dsByGran.week) return { dataset: dsByGran.week, sourceGran: 'week' };
    if (dsByGran.day) return { dataset: dsByGran.day, sourceGran: 'day' };
    return null;
  }, [dsByGran]);

  const availGrans = useMemo(() => ['day', 'week', 'month'].filter((g) => sourceFor(g)), [sourceFor]);
  const dsKey = list.map((d) => d.id).join(',');

  // Eager-load rows for every present dataset (≤3, small).
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
  }, [dsKey, loadRows]); // eslint-disable-line react-hooks/exhaustive-deps

  // Keep gran on an available granularity (finest available by default).
  useEffect(() => {
    if (availGrans.length && !availGrans.includes(gran)) setGran(availGrans[0]);
  }, [availGrans, gran]);

  const src = useMemo(() => sourceFor(gran), [sourceFor, gran]);
  const srcId = src?.dataset?.id || null;
  const srcRows = srcId ? (rowsById[srcId] || null) : null;
  const rolledUp = !!src && src.sourceGran !== gran;

  // Money formatting follows the ACTIVE source's currency (each sheet detects its own).
  useEffect(() => { setHaloCurrency(src?.dataset?.currency || '$'); }, [src]);

  const productList = useMemo(() => {
    const s = new Set();
    (srcRows || []).forEach((r) => Object.keys(r.productRevenue || {}).forEach((k) => s.add(k)));
    return [...s].sort();
  }, [srcRows]);
  const keywordList = useMemo(() => {
    const s = new Set();
    (srcRows || []).forEach((r) => Object.keys(r.keywords || {}).forEach((k) => s.add(k)));
    return [...s].sort();
  }, [srcRows]);
  const rankKeywordList = useMemo(() => {
    const s = new Set();
    (srcRows || []).forEach((r) => Object.keys(r.keywordRanks || {}).forEach((k) => s.add(k)));
    return [...s].sort();
  }, [srcRows]);

  // Reset scope + range when the source dataset changes.
  useEffect(() => { setProduct(null); setKeyword(null); setRankKeyword(null); }, [srcId]);
  useEffect(() => {
    if (srcRows && srcRows.length) setRange({ start: srcRows[0].date, end: srcRows[srcRows.length - 1].date });
    else setRange({ start: '', end: '' });
  }, [srcId, srcRows]);
  useEffect(() => { if (product && !productList.includes(product)) setProduct(null); }, [productList, product]);
  useEffect(() => { if (keyword && !keywordList.includes(keyword)) setKeyword(null); }, [keywordList, keyword]);
  useEffect(() => { if (rankKeyword && !rankKeywordList.includes(rankKeyword)) setRankKeyword(null); }, [rankKeywordList, rankKeyword]);

  const availSet = useMemo(() => availSetForRows(srcRows), [srcRows]);
  const amazonFields = useMemo(() => amazonAvail(availSet), [availSet]);
  const tiktokFields = useMemo(() => tiktokAvail(availSet), [availSet]);
  const allFields = useMemo(() => fieldsAvail(availSet), [availSet]);

  // Scope the source rows (product → revenue, keyword → branded search, rank →
  // rank keyword) and apply the date range, then bucket at the view granularity.
  const scopedRows = useMemo(() => {
    if (!srcRows) return [];
    return srcRows
      .filter((r) => (!range.start || r.date >= range.start) && (!range.end || r.date <= range.end))
      .map((r) => {
        const metrics = { ...r.metrics };
        if (product) metrics[REV] = r.productRevenue?.[product] ?? null;
        if (keyword) metrics[KSV] = r.keywords?.[keyword] ?? null;
        if (rankKeyword) metrics[KSR] = r.keywordRanks?.[rankKeyword] ?? null;
        return { date: r.date, periodLabel: r.periodLabel, metrics };
      });
  }, [srcRows, range, product, keyword, rankKeyword]);

  const lag = Math.min(rawLag, LAG_MAX[gran]);
  const buckets = useMemo(
    () => (src ? buildBucketsFromSource({ rows: scopedRows, sourceGran: src.sourceGran, targetGran: gran }) : []),
    [src, scopedRows, gran],
  );

  async function downloadXlsx() {
    if (!srcRows || !src || downloading) return;
    setDownloading(true);
    try {
      const XLSX = await import('xlsx');
      const volKw = [...new Set(srcRows.flatMap((r) => Object.keys(r.keywords || {})))].sort();
      const rankKw = [...new Set(srcRows.flatMap((r) => Object.keys(r.keywordRanks || {})))].sort();
      const cols = [{ label: 'Date', get: (r) => r.periodLabel || r.date }];
      for (const f of HALO_FIELDS) {
        if (f.key === KSV) { volKw.forEach((k) => cols.push({ label: k, get: (r) => r.keywords?.[k] ?? '' })); continue; }
        if (f.key === REV) {
          productList.forEach((p) => cols.push({ label: `${p} Revenue/Day`, get: (r) => r.productRevenue?.[p] ?? '' }));
          cols.push({ label: f.sheetHeader || f.label, get: (r) => r.metrics?.[f.key] ?? '' });
          continue;
        }
        if (f.key === KSR) { rankKw.forEach((k) => cols.push({ label: k, get: (r) => r.keywordRanks?.[k] ?? '' })); continue; }
        cols.push({ label: f.sheetHeader || f.label, get: (r) => r.metrics?.[f.key] ?? '' });
      }
      const aoa = [cols.map((c) => c.label), ...srcRows.map((r) => cols.map((c) => c.get(r)))];
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), src.dataset.granularity || 'Data');
      const safe = String(src.dataset.name || 'dataset').replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '') || 'dataset';
      XLSX.writeFile(wb, `halo-${safe}.xlsx`);
    } catch (e) {
      setError(e.message || String(e));
    } finally {
      setDownloading(false);
    }
  }

  if (!list.length) {
    return <div className="wx-card" style={{ padding: 28, textAlign: 'center', color: 'var(--text-muted)' }}>No Halo sheets uploaded for this brand yet.</div>;
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      {error && <div className="wx-alert wx-alert-danger"><span>{error}</span></div>}

      {loading || !srcRows ? (
        <div className="wx-card" style={{ padding: 28, textAlign: 'center' }}><span className="wx-spinner" /> Loading data…</div>
      ) : (
        <>
          <FiltersBar
            gran={gran} setGran={setGran} availGrans={availGrans}
            lag={lag} setLag={setRawLag}
            range={range} setRange={setRange}
            period={{ start: srcRows[0]?.date, end: srcRows[srcRows.length - 1]?.date }}
            rolledUp={rolledUp} sourceGran={src?.sourceGran}
            onDownload={downloadXlsx} downloading={downloading} />

          <ScopeBar
            productList={productList} product={product} setProduct={setProduct}
            keywordList={availSet.has(KSV) ? keywordList : []} keyword={keyword} setKeyword={setKeyword}
            rankKeywordList={availSet.has(KSR) ? rankKeywordList : []} rankKeyword={rankKeyword} setRankKeyword={setRankKeyword} />

          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {[['compare', 'Compare two'], ['heatmap', 'Correlation heatmap'], ['overlay', 'Multi-metric overlay'], ['lagfinder', 'Lag finder']].map(([k, label]) => (
              <button key={k} type="button" className={`wx-btn ${view === k ? 'wx-btn-primary' : 'wx-btn-ghost'} wx-btn-sm`} onClick={() => setView(k)}>{label}</button>
            ))}
          </div>

          {buckets.length < 3 ? (
            <div className="wx-card" style={{ padding: 24, textAlign: 'center', color: 'var(--text-muted)' }}>
              Not enough {UNIT[gran]}s in range to correlate (need at least 3) — try a wider range or a finer granularity.
            </div>
          ) : view === 'compare' ? (
            <CompareView buckets={buckets} gran={gran} lag={lag} amazonFields={amazonFields} tiktokFields={tiktokFields} />
          ) : view === 'heatmap' ? (
            <HeatmapView buckets={buckets} gran={gran} lag={lag} amazonFields={amazonFields} tiktokFields={tiktokFields} allFields={allFields} />
          ) : view === 'overlay' ? (
            <OverlayView buckets={buckets} allFields={allFields} />
          ) : (
            <LagFinderView buckets={buckets} gran={gran} amazonFields={amazonFields} tiktokFields={tiktokFields} />
          )}
        </>
      )}
    </div>
  );
}

// ============================================================
function FiltersBar({ gran, setGran, availGrans, lag, setLag, range, setRange, period, rolledUp, sourceGran, onDownload, downloading }) {
  return (
    <div className="wx-card" style={{ padding: 12, display: 'flex', gap: 18, alignItems: 'center', flexWrap: 'wrap' }}>
      <Segmented label="View by" value={gran} onChange={setGran}
        options={[['day', 'Daily'], ['week', 'Weekly'], ['month', 'Monthly']]}
        enabled={availGrans} />
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
      {rolledUp && (
        <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
          🔁 {GRAN_LABEL[gran]} view rolled up from the <strong>{GRAN_LABEL[sourceGran]}</strong> sheet (no {GRAN_LABEL[gran]} sheet uploaded).
        </span>
      )}
      {onDownload && (
        <button type="button" className="wx-btn wx-btn-ghost wx-btn-sm" style={{ marginLeft: 'auto' }} disabled={downloading} onClick={onDownload} title="Download this sheet as Excel">
          {downloading ? <><span className="wx-spinner" /> Preparing…</> : <><i className="bi bi-download" /> Download</>}
        </button>
      )}
    </div>
  );
}

function Segmented({ label, value, onChange, options, enabled }) {
  const isOn = (k) => !enabled || enabled.includes(k);
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <span style={{ fontSize: 11, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '.05em' }}>{label}</span>
      <div style={{ display: 'flex', gap: 4 }}>
        {options.map(([k, l]) => {
          const on = isOn(k);
          return (
            <button key={k} type="button" disabled={!on}
              title={on ? '' : `No ${GRAN_LABEL[k]} sheet uploaded`}
              className={`wx-btn ${value === k ? 'wx-btn-primary' : 'wx-btn-ghost'} wx-btn-sm`}
              style={on ? undefined : { opacity: 0.4, cursor: 'not-allowed' }}
              onClick={() => on && onChange(k)}>{l}</button>
          );
        })}
      </div>
    </div>
  );
}

// Shared scope: product feeds Amazon Revenue, keyword feeds Branded Search
// Volume, rank keyword feeds Keyword Search Rank. Each shows only when it applies.
function ScopeBar({ productList, product, setProduct, keywordList, keyword, setKeyword, rankKeywordList, rankKeyword, setRankKeyword }) {
  if (!productList.length && !keywordList.length && !rankKeywordList.length) return null;
  const box = (label, value, onChange, listItems, allLabel, badge, tint) => (
    <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
      <span style={{ fontSize: 11, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '.05em', fontWeight: 600 }}>{label}</span>
      <select className="wx-input" style={{ maxWidth: 220, height: 30, padding: '2px 8px', fontSize: 12.5 }} value={value || ''} onChange={(e) => onChange(e.target.value || null)}>
        <option value="">{allLabel}</option>
        {listItems.map((x) => <option key={x} value={x}>{x}</option>)}
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

// A field <select> with Amazon / TikTok optgroups.
function FieldSelect({ value, onChange, amazonFields, tiktokFields }) {
  const opt = (f) => <option key={f.key} value={f.key}>{f.label}</option>;
  return (
    <select className="wx-input" value={value} onChange={(e) => onChange(e.target.value)} style={{ maxWidth: 240 }}>
      <optgroup label="Amazon">{amazonFields.map(opt)}</optgroup>
      <optgroup label="TikTok / GMV Max">{tiktokFields.map(opt)}</optgroup>
    </select>
  );
}

// ============================================================
// Compare
// ============================================================
function CompareView({ buckets, gran, lag, amazonFields, tiktokFields }) {
  const dfltTt = tiktokFields.find((f) => f.key === 'unique_impressions')?.key || tiktokFields[0]?.key || '';
  const dfltAz = amazonFields.find((f) => f.key === 'revenue_per_day')?.key || amazonFields[0]?.key || '';
  const availKeys = useMemo(() => new Set([...amazonFields, ...tiktokFields].map((f) => f.key)), [amazonFields, tiktokFields]);
  const [a, setA] = useState('');
  const [b, setB] = useState('');
  useEffect(() => { setA((cur) => (cur && availKeys.has(cur) ? cur : dfltTt)); }, [availKeys, dfltTt]);
  useEffect(() => { setB((cur) => (cur && availKeys.has(cur) ? cur : dfltAz)); }, [availKeys, dfltAz]);

  const fa = FIELD_BY_KEY[a], fb = FIELD_BY_KEY[b];
  const { points, r, n } = useMemo(() => pairBuckets(buckets, a, b, lag, gran), [buckets, a, b, lag, gran]);
  const lineData = points.map((p) => ({ label: p.label, a: p.x, b: p.y }));
  const crossSide = fa?.group !== fb?.group;

  // Halo statement (shown below the selectors). Money↔money cross pair → a dollar
  // MULTIPLIER (Amazon $ ÷ TikTok $ over the range) crediting the whole Amazon
  // figure to TikTok — the boss's method, shown as both "N×" and "NN%". Any other
  // cross-side pair → a "move together NN%" line + a per-1,000 benchmark.
  const tk = fa?.group === 'tiktok' ? fa : fb?.group === 'tiktok' ? fb : null;
  const az = fa?.group === 'amazon' ? fa : fb?.group === 'amazon' ? fb : null;
  const sumMetric = (key) => buckets.reduce((s, bkt) => { const v = bkt.metrics?.[key]; return v == null ? s : s + Number(v); }, 0);
  const tkTotal = tk ? sumMetric(tk.key) : 0;
  const azTotal = az ? sumMetric(az.key) : 0;
  const moneyPair = crossSide && tk && az && tk.fmt === 'money' && az.fmt === 'money' && tk.agg === 'sum' && az.agg === 'sum';
  const countPair = crossSide && tk && az && !moneyPair && tk.agg === 'sum' && az.agg === 'sum';
  const mult = moneyPair && tkTotal > 0 ? azTotal / tkTotal : null;
  const per1000 = countPair && tkTotal > 0 ? (azTotal * 1000) / tkTotal : null;
  const tkName = tk ? `TikTok ${tk.label}` : '';
  const azName = az ? (az.label.toLowerCase().startsWith('amazon') ? az.label : `Amazon ${az.label}`) : '';

  if (!fa || !fb) return <div className="wx-card" style={{ padding: 24, textAlign: 'center', color: 'var(--text-muted)' }}>No metrics available at this granularity.</div>;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div className="wx-card" style={{ padding: 14, display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
          <FieldSelect value={a} onChange={setA} amazonFields={amazonFields} tiktokFields={tiktokFields} />
          <span style={{ color: 'var(--text-muted)' }}>vs</span>
          <FieldSelect value={b} onChange={setB} amazonFields={amazonFields} tiktokFields={tiktokFields} />
          <RBadge r={r} />
        </div>
        <HaloStatement r={r} n={n} a={a} b={b} mult={mult} per1000={per1000} tkName={tkName} azName={azName} az={az} />

        <div style={{ width: '100%', height: 280 }}>
          <ResponsiveContainer width="100%" height="100%">
            <ComposedChart data={lineData} margin={{ top: 8, right: 8, bottom: 4, left: 0 }}>
              <CartesianGrid stroke={GRID} strokeDasharray="3 3" />
              <XAxis dataKey="label" tick={{ fontSize: 10, fill: 'var(--text-muted)' }} minTickGap={gran === 'day' ? 20 : 6} />
              <YAxis yAxisId="l" tick={{ fontSize: 10, fill: PALETTE[0] }} width={54} />
              <YAxis yAxisId="r" orientation="right" tick={{ fontSize: 10, fill: PALETTE[1] }} width={54} />
              <Tooltip contentStyle={TT_STYLE} formatter={(val, key) => [fmtValue(val, key === 'a' ? fa.fmt : fb.fmt), key === 'a' ? fa.label : fb.label]} />
              <Legend formatter={(k) => (k === 'a' ? fa.label : fb.label)} wrapperStyle={{ fontSize: 12 }} />
              <Line yAxisId="l" type="monotone" dataKey="a" stroke={PALETTE[0]} dot={gran !== 'day'} strokeWidth={2} />
              <Line yAxisId="r" type="monotone" dataKey="b" stroke={PALETTE[1]} dot={gran !== 'day'} strokeWidth={2} />
            </ComposedChart>
          </ResponsiveContainer>
        </div>
        {lag > 0 && (
          <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
            {crossSide ? `Amazon side sampled ${unitLabel(gran, lag)} after the TikTok ${UNIT[gran]}.` : 'Lag has no effect when both metrics are on the same side.'}
          </div>
        )}
      </div>

      <div className="wx-card" style={{ padding: 14 }}>
        <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 8 }}>
          Scatter — each point is one {UNIT[gran]}. A tighter diagonal band = stronger correlation.
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
  const fg = corrTextColor(r);
  const bg = r == null ? 'var(--surface-2)' : `color-mix(in srgb, ${fg} 15%, transparent)`;
  return (
    <span style={{ background: bg, color: fg, borderRadius: 999, padding: '4px 12px', fontWeight: 700, fontSize: 13 }}>
      {fmtCorrPct(r) ?? '—'} · {strengthLabel(r)}
    </span>
  );
}

// The plain-English "halo" line under the Compare selectors.
//  • money↔money  → dollar multiplier (Amazon $ ÷ TikTok $), shown as "N×" + "NN%".
//  • other cross  → "move together NN%" + a per-1,000 benchmark.
//  • same-side / averages / no-variation → the neutral direction sentence.
function HaloStatement({ r, n, a, b, mult, per1000, tkName, azName, az }) {
  if (r == null) return <div style={{ fontSize: 13, color: 'var(--text-muted)' }}>{directionSentence(a, b, r, n)}</div>;
  const box = (children) => (
    <div style={{ background: 'var(--surface-2)', border: '1px solid var(--border-subtle)', borderRadius: 10, padding: '10px 14px', display: 'flex', flexDirection: 'column', gap: 6 }}>{children}</div>
  );
  const badge = (text) => (
    <span style={{ background: 'color-mix(in srgb, #22c55e 15%, transparent)', color: '#22c55e', borderRadius: 999, padding: '3px 12px', fontWeight: 800, fontSize: 14 }}>{text}</span>
  );
  if (mult != null) {
    return box(
      <>
        <div style={{ fontSize: 14, color: 'var(--text-primary)' }}>
          For every <strong>{fmtValue(1, 'money')}</strong> of {tkName}, the brand did <strong>{fmtValue(mult, 'money')}</strong> of {azName}.
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          {badge(`${mult.toFixed(1)}×`)}
          {badge(`${Math.round(mult * 100)}%`)}
          <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>· they move together {fmtCorrPct(r)}</span>
        </div>
        <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
          Credits all {azName} to {tkName} over this range (a raw ratio, not a proven cause).
        </div>
      </>,
    );
  }
  if (per1000 != null) {
    // "tends to rise together" is only true when the correlation is meaningful
    // (>= 10%, the green line). At a low/0% correlation the per-1,000 figure is
    // just an average ratio of the totals, NOT a day-to-day rise-together pattern.
    const linked = r >= 0.1;
    return box(
      <>
        <div style={{ fontSize: 14, color: 'var(--text-primary)' }}>
          {linked
            ? <>{tkName} and {azName} move together <strong>{fmtCorrPct(r)}</strong> — when {tkName} rises, {azName} tends to rise too.</>
            : <>{tkName} and {azName} show little day-to-day link (<strong>{fmtCorrPct(r)}</strong>) over this range.</>}
        </div>
        <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
          {linked
            ? <>about <strong style={{ color: 'var(--text-primary)' }}>{fmtValue(per1000, az.fmt)}</strong> of {azName} for every 1,000 {tkName} (average over this range).</>
            : <>Across this range there was on average <strong style={{ color: 'var(--text-primary)' }}>{fmtValue(per1000, az.fmt)}</strong> of {azName} per 1,000 {tkName} — an overall ratio, not a move-together pattern.</>}
        </div>
      </>,
    );
  }
  return <div style={{ fontSize: 13, color: 'var(--text-muted)' }}>{directionSentence(a, b, r, n)}</div>;
}

// ============================================================
// Heatmap
// ============================================================
function HeatmapView({ buckets, gran, lag, amazonFields, tiktokFields, allFields }) {
  const [full, setFull] = useState(false);
  const rowFields = full ? allFields : amazonFields;
  const colFields = full ? allFields : tiktokFields;
  const matrix = useMemo(
    () => correlationMatrix(buckets, rowFields.map((f) => f.key), colFields.map((f) => f.key), lag, gran),
    [buckets, rowFields, colFields, lag, gran],
  );

  return (
    <div className="wx-card" style={{ padding: 14, display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
        <div style={{ fontSize: 13, color: 'var(--text-muted)' }}>
          Correlation of each <strong>{full ? 'metric' : 'Amazon'}</strong> row against each column ({UNIT[gran]}ly), shown as a percentage. Green ≥ 10%, orange below, light red at 0%. Stronger = more saturated.
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
                    <td key={cf.key} title={`${rf.label} vs ${cf.label}: ${fmtCorrPct(cell.r) ?? 'n/a'} (n=${cell.n})`}
                      style={{ padding: '6px 8px', textAlign: 'center', minWidth: 46, background: same ? 'var(--surface-2)' : corrColor(cell.r), color: 'var(--text-primary)', fontWeight: cell.r != null && cell.r >= 0.6 ? 700 : 400, borderRadius: 3 }}>
                      {same ? '—' : (fmtCorrPct(cell.r) ?? '·')}
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
function OverlayView({ buckets, allFields }) {
  const availKeys = useMemo(() => new Set(allFields.map((f) => f.key)), [allFields]);
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
// Lag finder — every TikTok metric vs ONE Amazon metric across lag 0..max.
// ============================================================
function LagFinderView({ buckets, gran, amazonFields, tiktokFields }) {
  const [amazonKey, setAmazonKey] = useState(amazonFields[0]?.key || '');
  const [rankBy, setRankBy] = useState('positive');
  useEffect(() => { if (!amazonFields.find((f) => f.key === amazonKey)) setAmazonKey(amazonFields[0]?.key || ''); }, [amazonFields, amazonKey]);
  const amazonField = FIELD_BY_KEY[amazonKey];

  const lags = useMemo(() => Array.from({ length: LAG_MAX[gran] + 1 }, (_, i) => i), [gran]);
  const grid = useMemo(() => tiktokFields.map((tf) => {
    const cells = lags.map((L) => { const { r, n } = pairBuckets(buckets, tf.key, amazonKey, L, gran); return { lag: L, r, n }; });
    const valid = cells.filter((c) => c.r != null);
    let best = null;
    if (valid.length) best = rankBy === 'magnitude' ? valid.reduce((a, b) => (Math.abs(b.r) > Math.abs(a.r) ? b : a)) : valid.reduce((a, b) => (b.r > a.r ? b : a));
    return { field: tf, cells, best };
  }), [buckets, tiktokFields, lags, amazonKey, rankBy, gran]);

  const topSignals = useMemo(() => {
    const all = [];
    grid.forEach((row) => row.cells.forEach((c) => { if (c.r != null) all.push({ field: row.field, lag: c.lag, r: c.r }); }));
    all.sort((a, b) => (rankBy === 'magnitude' ? Math.abs(b.r) - Math.abs(a.r) : b.r - a.r));
    return all.slice(0, 6);
  }, [grid, rankBy]);

  if (!amazonField || !amazonFields.length) return <div className="wx-card" style={{ padding: 24, textAlign: 'center', color: 'var(--text-muted)' }}>No Amazon metric available at this granularity.</div>;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div className="wx-card" style={{ padding: 14, display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
          <span style={{ fontSize: 13, color: 'var(--text-muted)' }}>Every TikTok metric vs</span>
          <select className="wx-input" style={{ maxWidth: 240 }} value={amazonKey} onChange={(e) => setAmazonKey(e.target.value)}>
            {amazonFields.map((f) => <option key={f.key} value={f.key}>{f.label}</option>)}
          </select>
          <span style={{ fontSize: 13, color: 'var(--text-muted)' }}>across halo lag 0–{LAG_MAX[gran]} {UNIT[gran]}s</span>
          <div style={{ marginLeft: 'auto', display: 'flex', gap: 4 }}>
            {[['positive', 'Strongest positive'], ['magnitude', 'Strongest (any)']].map(([k, l]) => (
              <button key={k} type="button" className={`wx-btn wx-btn-sm ${rankBy === k ? 'wx-btn-primary' : 'wx-btn-ghost'}`} onClick={() => setRankBy(k)}>{l}</button>
            ))}
          </div>
        </div>
        <div style={{ fontSize: 12.5, color: 'var(--text-muted)' }}>
          Each cell is Pearson <strong>r</strong> between that TikTok metric and <strong>{amazonField?.label}</strong> sampled that many {UNIT[gran]}s later. Peak lag per row is outlined.
        </div>
        <div style={{ overflowX: 'auto' }}>
          <table style={{ borderCollapse: 'collapse', fontSize: 11 }}>
            <thead>
              <tr>
                <th style={{ position: 'sticky', left: 0, background: 'var(--surface-1)', zIndex: 1, textAlign: 'left', padding: '4px 8px', color: 'var(--text-muted)', fontWeight: 600 }}>TikTok metric</th>
                <th colSpan={lags.length} style={{ padding: '2px 6px', color: 'var(--text-muted)', fontWeight: 600, fontSize: 10.5, textTransform: 'uppercase', letterSpacing: '.05em' }}>Halo lag ({UNIT[gran]}s)</th>
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
                      <td key={c.lag} title={`${row.field.label} → ${amazonField?.label} @ lag ${c.lag} ${UNIT[gran]}: ${fmtCorrPct(c.r) ?? 'n/a'} (n=${c.n})`}
                        style={{ padding: '5px 6px', textAlign: 'center', minWidth: 34, background: corrColor(c.r), color: 'var(--text-primary)', fontWeight: isPeak ? 800 : (c.r != null && c.r >= 0.6 ? 700 : 400), outline: isPeak ? '2px solid var(--accent)' : 'none', outlineOffset: -2, borderRadius: 3 }}>
                        {fmtCorrPct(c.r) ?? '·'}
                      </td>
                    );
                  })}
                  <td style={{ padding: '4px 8px', whiteSpace: 'nowrap', color: 'var(--text-muted)' }}>
                    {row.best ? <>lag <strong style={{ color: 'var(--text-primary)' }}>{row.best.lag}{UNIT[gran][0]}</strong> · <strong style={{ color: 'var(--text-primary)' }}>{fmtCorrPct(row.best.r)}</strong></> : '—'}
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
              <span style={{ color: 'var(--text-muted)' }}>at <strong style={{ color: 'var(--text-primary)' }}>lag {unitLabel(gran, s.lag)}</strong></span>
              <span style={{ marginLeft: 'auto', fontWeight: 700, color: corrTextColor(s.r) }}>
                {fmtCorrPct(s.r)} · {strengthLabel(s.r)}
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
