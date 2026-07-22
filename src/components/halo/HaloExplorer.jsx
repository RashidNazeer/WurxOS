// ============================================================
// Amazon Halo — read-only explorer.
//
// One granularity switch (Daily / Weekly / Monthly) drives everything. Metrics
// are bucketed into that unit and correlated with a lag measured in the same
// unit. Branded Search Volume is a normal dropdown metric, but WEEKLY-ONLY — it
// only appears at Weekly/Monthly (no daily data), injected into the buckets from
// the dataset's weekly_keywords. Amazon Revenue carries a per-product picker.
//
// Extracted from AmazonHaloPage so the Boss page and the public portal render
// the SAME UI. Boss passes onDelete (Delete button); the portal omits it.
// loadRows(datasetId) => Promise<rows> keeps it loader-agnostic. Weekly search
// data rides on the dataset object (dataset.weekly_keywords).
// ============================================================

import { useEffect, useMemo, useState } from 'react';
import {
  ResponsiveContainer, ComposedChart, LineChart, Line, XAxis, YAxis,
  CartesianGrid, Tooltip, Legend, ScatterChart, Scatter,
} from 'recharts';
import {
  HALO_FIELDS, FIELD_BY_KEY, KSV_KEY, PRODUCT_REVENUE_FIELD,
  fieldsForGran, AMAZON_FIELDS_FOR, TIKTOK_FIELDS_FOR, fmtValue, setHaloCurrency,
} from '../../lib/haloFields';
import {
  indexByDate, buildBuckets, pairBuckets, correlationMatrix, overlaySeries,
  directionSentence, strengthLabel, corrColor,
} from '../../lib/haloMath';

const PALETTE = ['#6366f1', '#22c55e', '#f59e0b', '#ef4444', '#06b6d4', '#a855f7', '#ec4899', '#14b8a6'];
const TT_STYLE = { background: 'var(--surface-1, #16161c)', border: '1px solid var(--border-default, #2b2b35)', borderRadius: 8, fontSize: 12, color: 'var(--text-primary, #e8e8ee)' };
const GRID = 'var(--border-subtle, #2b2b3522)';
const REV = PRODUCT_REVENUE_FIELD;
const LAG_MAX = { day: 14, week: 8, month: 6 };
const UNIT = { day: 'day', week: 'week', month: 'month' };
const unitLabel = (gran, n) => `${n} ${UNIT[gran]}${n === 1 ? '' : 's'}`;

export default function HaloExplorer({ datasets, loadRows, onDelete, initialDatasetId = null }) {
  const [selectedId, setSelectedId] = useState(initialDatasetId);
  const [rows, setRows] = useState(null);
  const [rowsFor, setRowsFor] = useState(null);  // which dataset `rows` belongs to
  const [rowsLoading, setRowsLoading] = useState(false);
  const [error, setError] = useState('');

  const [gran, setGran] = useState('day');       // day | week | month
  const [rawLag, setRawLag] = useState(0);       // halo delay; clamped per gran below
  const [view, setView] = useState('compare');   // compare | heatmap | overlay | lagfinder
  const [range, setRange] = useState({ start: '', end: '' });
  const [product, setProduct] = useState(null);  // null = All products (revenue total)
  const [keyword, setKeyword] = useState(null);  // null = All keywords (branded search)
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

  const productList = useMemo(() => {
    const s = new Set();
    (rows || []).forEach((r) => Object.keys(r.productRevenue || {}).forEach((k) => s.add(k)));
    return [...s].sort();
  }, [rows]);

  const ksvByWeek = useMemo(
    () => new Map((selectedDs?.weekly_keywords || []).map((w) => [w.week_ending, w.keywords || {}])),
    [selectedDs?.weekly_keywords],
  );
  const keywordList = useMemo(() => {
    const s = new Set();
    (selectedDs?.weekly_keywords || []).forEach((w) => Object.keys(w.keywords || {}).forEach((k) => s.add(k)));
    return [...s].sort();
  }, [selectedDs?.weekly_keywords]);

  useEffect(() => { setProduct(null); setKeyword(null); }, [selectedId]);
  useEffect(() => { if (product && !productList.includes(product)) setProduct(null); }, [productList, product]);
  useEffect(() => { if (keyword && !keywordList.includes(keyword)) setKeyword(null); }, [keywordList, keyword]);

  // Product-resolved daily metrics (revenue → the picked product's daily value).
  const byDate = useMemo(() => {
    const base = rows || [];
    if (!product) return indexByDate(base);
    const m = {};
    for (const r of base) m[r.date] = { ...r.metrics, [REV]: r.productRevenue?.[product] ?? null };
    return m;
  }, [rows, product]);

  const dates = useMemo(() => {
    if (!rows) return [];
    return rows.map((r) => r.date).filter((d) => (!range.start || d >= range.start) && (!range.end || d <= range.end));
  }, [rows, range]);

  const buckets = useMemo(
    () => buildBuckets({ byDate, dates, gran, ksvByWeek, keyword, allKeywords: keywordList }),
    [byDate, dates, gran, ksvByWeek, keyword, keywordList],
  );

  const lag = Math.min(rawLag, LAG_MAX[gran]);       // clamp at use (no post-render flash)
  const rowsReady = !!rows && rowsFor === selectedId; // don't render one frame of old rows + new dataset
  const showKsv = gran !== 'day' && keywordList.length > 0;
  const keepField = (f) => !f.weeklyOnly || showKsv;  // hide Branded Search when there's no keyword data
  const amazonFields = AMAZON_FIELDS_FOR(gran).filter(keepField);
  const tiktokFields = TIKTOK_FIELDS_FOR(gran);
  const allFields = fieldsForGran(gran).filter(keepField);
  const hasKsvHere = showKsv;

  async function downloadXlsx() {
    if (!rows || !selectedDs || downloading) return;
    setDownloading(true);
    try {
      const XLSX = await import('xlsx');
      // Daily sheet mirrors the source layout (weekly-only fields excluded, they
      // live in the weekly tab); product revenue cols sit before Total Revenue/Day.
      const cols = [{ label: 'Date', get: (r) => r.date }];
      for (const f of HALO_FIELDS) {
        if (f.weeklyOnly) continue;
        if (f.key === REV) productList.forEach((p) => cols.push({ label: p, get: (r) => r.productRevenue?.[p] ?? '' }));
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
          <FiltersBar gran={gran} setGran={setGran} lag={lag} setLag={setRawLag} range={range} setRange={setRange}
            period={{ start: selectedDs?.period_start, end: selectedDs?.period_end }} keywordAtDaily={keywordList.length > 0} />

          <ScopeBar
            productList={productList} product={product} setProduct={setProduct}
            keywordList={hasKsvHere ? keywordList : []} keyword={keyword} setKeyword={setKeyword} />

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
function FiltersBar({ gran, setGran, lag, setLag, range, setRange, period, keywordAtDaily }) {
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
      {gran === 'day' && keywordAtDaily && (
        <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
          🔎 Switch to <strong>Weekly</strong> to compare <strong>Branded Search Volume</strong> (it's weekly data).
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

// Shared scope: which product feeds Amazon Revenue, which keyword feeds Branded
// Search. Each shows only when it applies to the current dataset/granularity.
function ScopeBar({ productList, product, setProduct, keywordList, keyword, setKeyword }) {
  if (!productList.length && !keywordList.length) return null;
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
    </div>
  );
}

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
  const [a, setA] = useState('video_per_day');
  const [b, setB] = useState('revenue_per_day');
  const avail = useMemo(() => new Set([...amazonFields, ...tiktokFields].map((f) => f.key)), [amazonFields, tiktokFields]);
  useEffect(() => { if (!avail.has(a)) setA('video_per_day'); }, [avail, a]);
  useEffect(() => { if (!avail.has(b)) setB('revenue_per_day'); }, [avail, b]);

  const fa = FIELD_BY_KEY[a], fb = FIELD_BY_KEY[b];
  const { points, r, n } = useMemo(() => pairBuckets(buckets, a, b, lag, gran), [buckets, a, b, lag, gran]);
  const lineData = points.map((p) => ({ label: p.label, a: p.x, b: p.y }));
  const crossSide = fa?.group !== fb?.group; // lag is only applied across TikTok↔Amazon

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
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
function OverlayView({ buckets, allFields }) {
  const availKeys = useMemo(() => new Set(allFields.map((f) => f.key)), [allFields]);
  const [keys, setKeys] = useState(['video_per_day', 'revenue_per_day', 'product_impressions']);
  useEffect(() => {
    setKeys((cur) => { const kept = cur.filter((k) => availKeys.has(k)); return kept.length ? kept : ['video_per_day', 'revenue_per_day']; });
  }, [availKeys]);
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
// surfacing where the correlation peaks (lag in the current granularity's unit).
// ============================================================
function LagFinderView({ buckets, gran, amazonFields, tiktokFields }) {
  const lags = useMemo(() => Array.from({ length: LAG_MAX[gran] + 1 }, (_, i) => i), [gran]);
  const [amazonKey, setAmazonKey] = useState(amazonFields[0].key);
  const [rankBy, setRankBy] = useState('positive');
  useEffect(() => { if (!amazonFields.find((f) => f.key === amazonKey)) setAmazonKey(amazonFields[0].key); }, [amazonFields, amazonKey]);
  const amazonField = FIELD_BY_KEY[amazonKey];

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
                      <td key={c.lag} title={`${row.field.label} → ${amazonField?.label} @ lag ${c.lag} ${UNIT[gran]}: r=${c.r == null ? 'n/a' : c.r.toFixed(2)} (n=${c.n})`}
                        style={{ padding: '5px 6px', textAlign: 'center', minWidth: 34, background: corrColor(c.r), color: 'var(--text-primary)', fontWeight: isPeak ? 800 : (c.r != null && Math.abs(c.r) >= 0.6 ? 700 : 400), outline: isPeak ? '2px solid var(--accent)' : 'none', outlineOffset: -2, borderRadius: 3 }}>
                        {c.r == null ? '·' : c.r.toFixed(2)}
                      </td>
                    );
                  })}
                  <td style={{ padding: '4px 8px', whiteSpace: 'nowrap', color: 'var(--text-muted)' }}>
                    {row.best ? <>lag <strong style={{ color: 'var(--text-primary)' }}>{row.best.lag}{UNIT[gran][0]}</strong> · r <strong style={{ color: 'var(--text-primary)' }}>{row.best.r.toFixed(2)}</strong></> : '—'}
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
