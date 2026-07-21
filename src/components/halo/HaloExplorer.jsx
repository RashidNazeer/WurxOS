// ============================================================
// Amazon Halo — read-only explorer.
//
// Two resolutions, matching the data:
//   * DAILY views (Compare / Heatmap / Overlay / Lag finder): TikTok daily vs
//     Amazon Revenue daily, with a day-lag. Revenue carries a per-PRODUCT
//     picker (All products = the day's total, or one product's revenue).
//   * WEEKLY "Search demand" view: TikTok rolled up to Sun–Sat weeks vs the
//     branded Keyword Search Volume from the subsheet (weekly-only), with a
//     WEEK-lag. Honest small-n caveat since only a handful of weeks overlap.
//
// Extracted from AmazonHaloPage so the Boss page and the public portal render
// the SAME UI. Boss passes an `onDelete` prop (per-dataset Delete button); the
// public page omits it. loadRows(datasetId) => Promise<rows> keeps it loader-
// agnostic (Boss uses getHaloRows; portal uses the anon RPC). Weekly search data
// rides on the dataset object (dataset.weekly_keywords).
// ============================================================

import { useEffect, useMemo, useState } from 'react';
import {
  ResponsiveContainer, ComposedChart, LineChart, Line, XAxis, YAxis,
  CartesianGrid, Tooltip, Legend, ScatterChart, Scatter,
} from 'recharts';
import {
  HALO_FIELDS, FIELD_BY_KEY, AMAZON_FIELDS, TIKTOK_FIELDS, KSV_META,
  PRODUCT_REVENUE_FIELD, fmtValue, setHaloCurrency,
} from '../../lib/haloFields';
import {
  indexByDate, pairSeries, correlationMatrix, overlaySeries,
  directionSentence, strengthLabel, corrColor,
  rollupWeeklyTikTok, weeklySearchPairs, ksvWeekValue,
} from '../../lib/haloMath';

const PALETTE = ['#6366f1', '#22c55e', '#f59e0b', '#ef4444', '#06b6d4', '#a855f7', '#ec4899', '#14b8a6'];
const TT_STYLE = { background: 'var(--surface-1, #16161c)', border: '1px solid var(--border-default, #2b2b35)', borderRadius: 8, fontSize: 12, color: 'var(--text-primary, #e8e8ee)' };
const GRID = 'var(--border-subtle, #2b2b3522)';
const REV = PRODUCT_REVENUE_FIELD; // 'revenue_per_day'
const MIN_WEEK_DAYS = 7;           // a week counts only when all 7 days are present (no partial-sum bias)
const WEEKLY_DIRECTIONAL_UNTIL = 12; // below this many overlap weeks, flag correlations as directional
const WEEK_LAGS = [0, 1, 2, 3, 4];

export default function HaloExplorer({ datasets, loadRows, onDelete, initialDatasetId = null }) {
  const [selectedId, setSelectedId] = useState(initialDatasetId);
  const [rows, setRows] = useState(null);
  const [rowsLoading, setRowsLoading] = useState(false);
  const [error, setError] = useState('');

  // explorer controls
  const [gran, setGran] = useState('day');       // day | week | month (daily views)
  const [lag, setLag] = useState(0);             // halo delay in days (daily views)
  const [view, setView] = useState('compare');   // compare | heatmap | overlay | lagfinder | weekly
  const [range, setRange] = useState({ start: '', end: '' });
  const [product, setProduct] = useState(null);  // null = "All products" (revenue total)
  const [downloading, setDownloading] = useState(false);

  const selectedDs = datasets.find((d) => d.id === selectedId) || null;

  // Keep a valid selection as the dataset list changes.
  useEffect(() => {
    if (!datasets.length) { setSelectedId(null); return; }
    if (!datasets.find((d) => d.id === selectedId)) setSelectedId(datasets[0].id);
  }, [datasets]); // eslint-disable-line react-hooks/exhaustive-deps

  // A new upload (or any parent-driven change) updates initialDatasetId AFTER
  // mount — adopt it so the just-uploaded dataset actually becomes the one shown
  // (useState only reads the initial prop at mount).
  useEffect(() => {
    if (initialDatasetId && datasets.find((d) => d.id === initialDatasetId)) setSelectedId(initialDatasetId);
  }, [initialDatasetId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Currency symbol is a per-dataset display setting read by fmtValue.
  useEffect(() => { setHaloCurrency(selectedDs?.currency || '$'); }, [selectedDs?.currency]);

  useEffect(() => {
    if (!selectedId) { setRows(null); return; }
    let alive = true;
    setRowsLoading(true); setError('');
    Promise.resolve(loadRows(selectedId))
      .then((r) => {
        if (!alive) return;
        setRows(r);
        if (r.length) setRange({ start: r[0].date, end: r[r.length - 1].date });
      })
      .catch((e) => alive && setError(e.message || String(e)))
      .finally(() => alive && setRowsLoading(false));
    return () => { alive = false; };
  }, [selectedId, loadRows]);

  // Per-product revenue product names present in this dataset (empty → the
  // revenue product picker stays hidden).
  const productList = useMemo(() => {
    const s = new Set();
    (rows || []).forEach((r) => Object.keys(r.productRevenue || {}).forEach((k) => s.add(k)));
    return [...s].sort();
  }, [rows]);

  // Reset product on dataset change / when it's no longer present.
  useEffect(() => { setProduct(null); }, [selectedId]);
  useEffect(() => { if (product && !productList.includes(product)) setProduct(null); }, [productList, product]);

  // When a product is picked, revenue_per_day resolves to that product's daily
  // revenue; "All products" keeps the stored total. Other metrics untouched.
  const byDate = useMemo(() => {
    const base = rows || [];
    if (!product) return indexByDate(base);
    const m = {};
    for (const r of base) {
      m[r.date] = { ...r.metrics, [REV]: r.productRevenue?.[product] ?? null };
    }
    return m;
  }, [rows, product]);

  const dates = useMemo(() => {
    if (!rows) return [];
    return rows.map((r) => r.date).filter((d) => (!range.start || d >= range.start) && (!range.end || d <= range.end));
  }, [rows, range]);

  // Export the current dataset to .xlsx, mirroring the source layout so a
  // downloaded workbook re-imports cleanly: a daily sheet (Date | …fixed… |
  // <product revenue cols> | Total Revenue/Day | …), plus a weekly "Branded
  // Demand" sheet when the dataset carries weekly search data.
  async function downloadXlsx() {
    if (!rows || !selectedDs || downloading) return;
    setDownloading(true);
    try {
      const XLSX = await import('xlsx');
      const cols = [{ label: 'Date', get: (r) => r.date }];
      for (const f of HALO_FIELDS) {
        if (f.key === REV) {
          // per-product revenue cols sit immediately BEFORE Total Revenue/Day
          productList.forEach((p) => cols.push({ label: p, get: (r) => r.productRevenue?.[p] ?? '' }));
          cols.push({ label: f.sheetHeader || f.label, get: (r) => r.metrics?.[f.key] ?? '' });
        } else {
          cols.push({ label: f.sheetHeader || f.label, get: (r) => r.metrics?.[f.key] ?? '' });
        }
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

      <DatasetBar
        datasets={datasets} selectedId={selectedId} onSelect={setSelectedId}
        onDelete={onDelete} onDownload={downloadXlsx} downloading={downloading}
        canDownload={!!rows && !rowsLoading}
      />

      {!selectedId ? (
        <div className="wx-card" style={{ padding: 28, textAlign: 'center', color: 'var(--text-muted)' }}>No dataset selected.</div>
      ) : rowsLoading || !rows ? (
        <div className="wx-card" style={{ padding: 28, textAlign: 'center' }}><span className="wx-spinner" /> Loading data…</div>
      ) : (
        <>
          {view !== 'weekly' && (
            <FiltersBar gran={gran} setGran={setGran} lag={lag} setLag={setLag}
              range={range} setRange={setRange}
              period={{ start: selectedDs?.period_start, end: selectedDs?.period_end }} />
          )}

          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {[['compare', 'Compare two'], ['heatmap', 'Correlation heatmap'], ['overlay', 'Multi-metric overlay'], ['lagfinder', 'Lag finder'], ['weekly', '🔎 Search demand (weekly)']].map(([k, label]) => (
              <button key={k} type="button"
                className={`wx-btn ${view === k ? 'wx-btn-primary' : 'wx-btn-ghost'} wx-btn-sm`}
                onClick={() => setView(k)}>{label}</button>
            ))}
          </div>

          {view === 'weekly' ? (
            <WeeklySearchView rows={rows} weeklyKeywords={selectedDs?.weekly_keywords || []} />
          ) : dates.length < 3 ? (
            <div className="wx-card" style={{ padding: 24, textAlign: 'center', color: 'var(--text-muted)' }}>
              Not enough days in the selected range to correlate (need at least 3).
            </div>
          ) : view === 'compare' ? (
            <CompareView byDate={byDate} dates={dates} gran={gran} lag={lag}
              product={product} setProduct={setProduct} productList={productList} />
          ) : view === 'heatmap' ? (
            <HeatmapView byDate={byDate} dates={dates} gran={gran} lag={lag}
              product={product} setProduct={setProduct} productList={productList} />
          ) : view === 'overlay' ? (
            <OverlayView byDate={byDate} dates={dates} gran={gran}
              product={product} setProduct={setProduct} productList={productList} />
          ) : (
            <LagFinderView byDate={byDate} dates={dates} gran={gran}
              product={product} setProduct={setProduct} productList={productList} />
          )}
        </>
      )}
    </div>
  );
}

// ============================================================
// Dataset switcher
// ============================================================
function DatasetBar({ datasets, selectedId, onSelect, onDelete, onDownload, downloading, canDownload }) {
  if (!datasets.length) return null;
  const sel = datasets.find((d) => d.id === selectedId);
  return (
    <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
      <select className="wx-input" style={{ maxWidth: 380 }} value={selectedId || ''} onChange={(e) => onSelect(e.target.value)}>
        {datasets.map((d) => (
          <option key={d.id} value={d.id}>{d.name} · {d.row_count} days</option>
        ))}
      </select>
      {sel && onDownload && (
        <button type="button" className="wx-btn wx-btn-ghost wx-btn-sm"
          disabled={!canDownload || downloading} onClick={onDownload}
          title="Download this dataset as an Excel workbook">
          {downloading ? <><span className="wx-spinner" /> Preparing…</> : <><i className="bi bi-download" /> Download</>}
        </button>
      )}
      {sel && onDelete && (
        <button type="button" className="wx-btn wx-btn-ghost wx-btn-sm" onClick={() => onDelete(sel.id)}>Delete</button>
      )}
    </div>
  );
}

// ============================================================
// Global filters (daily views only)
// ============================================================
function FiltersBar({ gran, setGran, lag, setLag, range, setRange, period }) {
  return (
    <div className="wx-card" style={{ padding: 12, display: 'flex', gap: 18, alignItems: 'center', flexWrap: 'wrap' }}>
      <Segmented label="View by" value={gran} onChange={setGran}
        options={[['day', 'Daily'], ['week', 'Weekly'], ['month', 'Monthly']]} />
      <div style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 200 }}>
        <span style={{ fontSize: 11, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '.05em' }}>
          Halo lag: <strong style={{ color: 'var(--accent)' }}>{lag} day{lag === 1 ? '' : 's'}</strong>
        </span>
        <input type="range" min={0} max={14} value={lag} onChange={(e) => setLag(Number(e.target.value))} />
      </div>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <label style={{ fontSize: 11, color: 'var(--text-muted)' }}>From
          <input type="date" className="wx-input" style={{ marginLeft: 4 }}
            min={period.start} max={period.end} value={range.start}
            onChange={(e) => setRange((r) => ({ ...r, start: e.target.value }))} />
        </label>
        <label style={{ fontSize: 11, color: 'var(--text-muted)' }}>To
          <input type="date" className="wx-input" style={{ marginLeft: 4 }}
            min={period.start} max={period.end} value={range.end}
            onChange={(e) => setRange((r) => ({ ...r, end: e.target.value }))} />
        </label>
      </div>
    </div>
  );
}

function Segmented({ label, value, onChange, options }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <span style={{ fontSize: 11, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '.05em' }}>{label}</span>
      <div style={{ display: 'flex', gap: 4 }}>
        {options.map(([k, l]) => (
          <button key={k} type="button"
            className={`wx-btn ${value === k ? 'wx-btn-primary' : 'wx-btn-ghost'} wx-btn-sm`}
            onClick={() => onChange(k)}>{l}</button>
        ))}
      </div>
    </div>
  );
}

// A field <select> with Amazon / TikTok optgroups.
function FieldSelect({ value, onChange }) {
  const opt = (f) => <option key={f.key} value={f.key}>{f.label}</option>;
  return (
    <select className="wx-input" value={value} onChange={(e) => onChange(e.target.value)} style={{ maxWidth: 240 }}>
      <optgroup label="Amazon">{AMAZON_FIELDS.map(opt)}</optgroup>
      <optgroup label="TikTok / GMV Max">{TIKTOK_FIELDS.map(opt)}</optgroup>
    </select>
  );
}

// Scopes Amazon Revenue to one product. Shown only where revenue is in play and
// the dataset actually has per-product data.
function ProductPicker({ product, setProduct, productList }) {
  if (!productList?.length) return null;
  return (
    <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
      <span style={{ fontSize: 11, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '.05em', fontWeight: 600 }}>Product</span>
      <select className="wx-input" style={{ maxWidth: 220, height: 30, padding: '2px 8px', fontSize: 12.5 }}
        value={product || ''} onChange={(e) => setProduct(e.target.value || null)}
        title="Which product's Amazon revenue feeds Amazon Revenue">
        <option value="">All products (total)</option>
        {productList.map((p) => <option key={p} value={p}>{p}</option>)}
      </select>
      {product && (
        <span style={{ background: 'var(--surface-2)', color: 'var(--accent)', borderRadius: 999, padding: '3px 10px', fontSize: 11, fontWeight: 700, whiteSpace: 'nowrap' }}>
          Revenue: {product}
        </span>
      )}
    </div>
  );
}

// ============================================================
// Compare view (daily)
// ============================================================
function CompareView({ byDate, dates, gran, lag, product, setProduct, productList }) {
  const [a, setA] = useState('video_per_day');
  const [b, setB] = useState('revenue_per_day');
  const fa = FIELD_BY_KEY[a], fb = FIELD_BY_KEY[b];
  const { points, r } = useMemo(() => pairSeries(byDate, dates, a, b, lag, gran), [byDate, dates, a, b, lag, gran]);
  const lineData = points.map((p) => ({ label: p.label, a: p.x, b: p.y }));

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div className="wx-card" style={{ padding: 14, display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
          <FieldSelect value={a} onChange={setA} />
          <span style={{ color: 'var(--text-muted)' }}>vs</span>
          <FieldSelect value={b} onChange={setB} />
          <RBadge r={r} />
          {(a === REV || b === REV) && <ProductPicker product={product} setProduct={setProduct} productList={productList} />}
        </div>
        <div style={{ fontSize: 13, color: 'var(--text-muted)' }}>{directionSentence(a, b, r)}</div>

        <div style={{ width: '100%', height: 280 }}>
          <ResponsiveContainer width="100%" height="100%">
            <ComposedChart data={lineData} margin={{ top: 8, right: 8, bottom: 4, left: 0 }}>
              <CartesianGrid stroke={GRID} strokeDasharray="3 3" />
              <XAxis dataKey="label" tick={{ fontSize: 10, fill: 'var(--text-muted)' }} minTickGap={20} />
              <YAxis yAxisId="l" tick={{ fontSize: 10, fill: PALETTE[0] }} width={54} />
              <YAxis yAxisId="r" orientation="right" tick={{ fontSize: 10, fill: PALETTE[1] }} width={54} />
              <Tooltip contentStyle={TT_STYLE}
                formatter={(val, key) => [fmtValue(val, key === 'a' ? fa.fmt : fb.fmt), key === 'a' ? fa.label : fb.label]} />
              <Legend formatter={(k) => (k === 'a' ? fa.label : fb.label)} wrapperStyle={{ fontSize: 12 }} />
              <Line yAxisId="l" type="monotone" dataKey="a" stroke={PALETTE[0]} dot={false} strokeWidth={2} />
              <Line yAxisId="r" type="monotone" dataKey="b" stroke={PALETTE[1]} dot={false} strokeWidth={2} />
            </ComposedChart>
          </ResponsiveContainer>
        </div>
        {lag > 0 && (
          <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
            {(fa.group === 'amazon' || fb.group === 'amazon')
              ? `Amazon side sampled ${lag} day${lag === 1 ? '' : 's'} after the TikTok day.`
              : 'Lag has no effect when both metrics are on the same side.'}
          </div>
        )}
      </div>

      <div className="wx-card" style={{ padding: 14 }}>
        <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 8 }}>
          Scatter — each point is one {gran === 'day' ? 'day' : gran}. A tighter diagonal band = stronger correlation.
        </div>
        <div style={{ width: '100%', height: 260 }}>
          <ResponsiveContainer width="100%" height="100%">
            <ScatterChart margin={{ top: 8, right: 12, bottom: 16, left: 0 }}>
              <CartesianGrid stroke={GRID} strokeDasharray="3 3" />
              <XAxis type="number" dataKey="x" name={fa.label} tick={{ fontSize: 10, fill: 'var(--text-muted)' }}
                label={{ value: fa.label, position: 'insideBottom', offset: -8, fontSize: 11, fill: 'var(--text-muted)' }} />
              <YAxis type="number" dataKey="y" name={fb.label} width={54} tick={{ fontSize: 10, fill: 'var(--text-muted)' }} />
              <Tooltip contentStyle={TT_STYLE} cursor={{ strokeDasharray: '3 3' }}
                formatter={(val, key) => [fmtValue(val, key === 'x' ? fa.fmt : fb.fmt), key === 'x' ? fa.label : fb.label]} />
              <Scatter data={points} fill={PALETTE[4]} fillOpacity={0.7} />
            </ScatterChart>
          </ResponsiveContainer>
        </div>
      </div>
    </div>
  );
}

function RBadge({ r }) {
  // Colour by SIGN first: any negative reads red (opposite of the halo
  // hypothesis); magnitude only controls tint. Positive: green (strong) /
  // amber (moderate) / neutral.
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
// Heatmap view (daily)
// ============================================================
function HeatmapView({ byDate, dates, gran, lag, product, setProduct, productList }) {
  const [full, setFull] = useState(false);
  const rowFields = full ? HALO_FIELDS : AMAZON_FIELDS;
  const colFields = full ? HALO_FIELDS : TIKTOK_FIELDS;
  const matrix = useMemo(
    () => correlationMatrix(byDate, dates, rowFields.map((f) => f.key), colFields.map((f) => f.key), lag, gran),
    [byDate, dates, rowFields, colFields, lag, gran],
  );

  return (
    <div className="wx-card" style={{ padding: 14, display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
        <div style={{ fontSize: 13, color: 'var(--text-muted)' }}>
          Correlation (r) of each <strong>{full ? 'metric' : 'Amazon'}</strong> row against each column. Green = positive, red = negative, stronger = more saturated.
        </div>
        <div style={{ display: 'flex', gap: 16, alignItems: 'center', flexWrap: 'wrap' }}>
          <ProductPicker product={product} setProduct={setProduct} productList={productList} />
          <label style={{ fontSize: 12, display: 'flex', gap: 6, alignItems: 'center' }}>
            <input type="checkbox" checked={full} onChange={(e) => setFull(e.target.checked)} /> Show all fields
          </label>
        </div>
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
                    <td key={cf.key}
                      title={`${rf.label} vs ${cf.label}: r=${cell.r == null ? 'n/a' : cell.r.toFixed(2)}`}
                      style={{
                        padding: '6px 8px', textAlign: 'center', minWidth: 46,
                        background: same ? 'var(--surface-2)' : corrColor(cell.r),
                        color: 'var(--text-primary)', fontWeight: cell.r != null && Math.abs(cell.r) >= 0.6 ? 700 : 400,
                        borderRadius: 3,
                      }}>
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
// Overlay view (daily)
// ============================================================
function OverlayView({ byDate, dates, gran, product, setProduct, productList }) {
  const [keys, setKeys] = useState(['video_per_day', 'revenue_per_day', 'product_impressions']);
  const data = useMemo(() => overlaySeries(byDate, dates, keys, gran), [byDate, dates, keys, gran]);
  const toggle = (k) => setKeys((cur) => (cur.includes(k) ? cur.filter((x) => x !== k) : [...cur, k]));

  return (
    <div className="wx-card" style={{ padding: 14, display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
        Overlay several metrics on one timeline. Values are normalised to 0–100 so different scales share an axis — this compares <strong>shape</strong>, not magnitude. Tap a chip to add/remove.
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
        {HALO_FIELDS.map((f) => {
          const on = keys.includes(f.key);
          const color = PALETTE[keys.indexOf(f.key) % PALETTE.length];
          return (
            <button key={f.key} type="button" onClick={() => toggle(f.key)}
              className={`wx-btn wx-btn-sm ${on ? '' : 'wx-btn-ghost'}`}
              style={on ? { background: color, borderColor: color, color: '#fff' } : { fontSize: 11 }}>
              {f.group === 'amazon' ? '🟠 ' : ''}{f.label}
            </button>
          );
        })}
      </div>
      {keys.includes(REV) && <ProductPicker product={product} setProduct={setProduct} productList={productList} />}
      <div style={{ width: '100%', height: 320 }}>
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={data} margin={{ top: 8, right: 8, bottom: 4, left: 0 }}>
            <CartesianGrid stroke={GRID} strokeDasharray="3 3" />
            <XAxis dataKey="label" tick={{ fontSize: 10, fill: 'var(--text-muted)' }} minTickGap={20} />
            <YAxis tick={{ fontSize: 10, fill: 'var(--text-muted)' }} width={40} domain={[0, 100]} />
            <Tooltip contentStyle={TT_STYLE}
              formatter={(val, key, item) => {
                const f = FIELD_BY_KEY[key];
                const raw = item?.payload?.[`${key}__raw`];
                return [fmtValue(raw, f?.fmt), f?.label || key];
              }} />
            <Legend formatter={(k) => FIELD_BY_KEY[k]?.label || k} wrapperStyle={{ fontSize: 12 }} />
            {keys.map((k, i) => (
              <Line key={k} type="monotone" dataKey={k} stroke={PALETTE[i % PALETTE.length]} dot={false} strokeWidth={2} connectNulls />
            ))}
          </LineChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

// ============================================================
// Lag finder view (daily) — every TikTok metric vs ONE Amazon metric across
// halo lag 0..14 days; surfaces where the correlation peaks.
// ============================================================
const LAGS = Array.from({ length: 15 }, (_, i) => i);

function LagFinderView({ byDate, dates, gran, product, setProduct, productList }) {
  const [amazonKey, setAmazonKey] = useState(AMAZON_FIELDS[0].key);
  const [rankBy, setRankBy] = useState('positive');
  const amazonField = FIELD_BY_KEY[amazonKey];

  const grid = useMemo(() => TIKTOK_FIELDS.map((tf) => {
    const cells = LAGS.map((L) => ({ lag: L, r: pairSeries(byDate, dates, tf.key, amazonKey, L, gran).r }));
    const valid = cells.filter((c) => c.r != null);
    let best = null;
    if (valid.length) {
      best = rankBy === 'magnitude'
        ? valid.reduce((a, b) => (Math.abs(b.r) > Math.abs(a.r) ? b : a))
        : valid.reduce((a, b) => (b.r > a.r ? b : a));
    }
    return { field: tf, cells, best };
  }), [byDate, dates, gran, amazonKey, rankBy]);

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
            {AMAZON_FIELDS.map((f) => <option key={f.key} value={f.key}>{f.label}</option>)}
          </select>
          <span style={{ fontSize: 13, color: 'var(--text-muted)' }}>across halo lag 0–14 days</span>
          <div style={{ marginLeft: 'auto', display: 'flex', gap: 4 }}>
            {[['positive', 'Strongest positive'], ['magnitude', 'Strongest (any)']].map(([k, l]) => (
              <button key={k} type="button" className={`wx-btn wx-btn-sm ${rankBy === k ? 'wx-btn-primary' : 'wx-btn-ghost'}`}
                onClick={() => setRankBy(k)}>{l}</button>
            ))}
          </div>
        </div>

        {amazonKey === REV && <ProductPicker product={product} setProduct={setProduct} productList={productList} />}

        <div style={{ fontSize: 12.5, color: 'var(--text-muted)' }}>
          Each cell is Pearson <strong>r</strong> between that TikTok metric (the cause) and <strong>{amazonField?.label}</strong> sampled
          that many days later. Green = positive, red = negative, stronger = more saturated. The <strong>peak lag per row</strong> is outlined.
        </div>

        <div style={{ overflowX: 'auto' }}>
          <table style={{ borderCollapse: 'collapse', fontSize: 11 }}>
            <thead>
              <tr>
                <th style={{ position: 'sticky', left: 0, background: 'var(--surface-1)', zIndex: 1, textAlign: 'left', padding: '4px 8px', color: 'var(--text-muted)', fontWeight: 600 }}>TikTok metric</th>
                <th colSpan={LAGS.length} style={{ padding: '2px 6px', color: 'var(--text-muted)', fontWeight: 600, fontSize: 10.5, textTransform: 'uppercase', letterSpacing: '.05em' }}>Halo lag (days)</th>
                <th style={{ padding: '4px 8px', color: 'var(--text-muted)', fontWeight: 600 }}>Peak</th>
              </tr>
              <tr>
                <th style={{ position: 'sticky', left: 0, background: 'var(--surface-1)', zIndex: 1 }} />
                {LAGS.map((L) => <th key={L} style={{ padding: '3px 6px', color: 'var(--text-muted)', fontWeight: 600, minWidth: 34, textAlign: 'center' }}>{L}</th>)}
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
                      <td key={c.lag}
                        title={`${row.field.label} → ${amazonField?.label} @ lag ${c.lag}d: r=${c.r == null ? 'n/a' : c.r.toFixed(2)}`}
                        style={{
                          padding: '5px 6px', textAlign: 'center', minWidth: 34, background: corrColor(c.r),
                          color: 'var(--text-primary)',
                          fontWeight: isPeak ? 800 : (c.r != null && Math.abs(c.r) >= 0.6 ? 700 : 400),
                          outline: isPeak ? '2px solid var(--accent)' : 'none', outlineOffset: -2, borderRadius: 3,
                        }}>
                        {c.r == null ? '·' : c.r.toFixed(2)}
                      </td>
                    );
                  })}
                  <td style={{ padding: '4px 8px', whiteSpace: 'nowrap', color: 'var(--text-muted)' }}>
                    {row.best ? <>lag <strong style={{ color: 'var(--text-primary)' }}>{row.best.lag}d</strong> · r <strong style={{ color: 'var(--text-primary)' }}>{row.best.r.toFixed(2)}</strong></> : '—'}
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
              <span style={{ color: 'var(--text-muted)' }}>at <strong style={{ color: 'var(--text-primary)' }}>lag {s.lag} day{s.lag === 1 ? '' : 's'}</strong></span>
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

// ============================================================
// Search demand (weekly) view — TikTok rolled up to Sun–Sat weeks vs branded
// Keyword Search Volume (weekly-only, from the subsheet), with a WEEK lag.
// ============================================================
function weeklyDirection(tiktokLabel, r, n) {
  if (r == null) {
    if (n < 3) return `Not enough complete weeks (${n}) to correlate yet — need at least 3.`;
    return `No variation in one of the series across these ${n} weeks — a correlation can't be computed.`;
  }
  const a = Math.abs(r);
  if (a < 0.2) return `No clear weekly relationship between ${tiktokLabel} and branded search (${n} weeks).`;
  const dir = r >= 0 ? 'more' : 'less';
  return `${strengthLabel(r)} (r = ${r.toFixed(2)}, ${n} weeks): higher ${tiktokLabel} weeks tend to go with ${dir} branded search.`;
}

function WeeklySearchView({ rows, weeklyKeywords }) {
  const [keyword, setKeyword] = useState(null);            // null = All keywords (sum)
  const [tiktokKey, setTiktokKey] = useState('product_impressions');
  const [weekLag, setWeekLag] = useState(0);

  const hasData = (weeklyKeywords || []).length > 0;

  const keywordList = useMemo(() => {
    const s = new Set();
    (weeklyKeywords || []).forEach((w) => Object.keys(w.keywords || {}).forEach((k) => s.add(k)));
    return [...s].sort();
  }, [weeklyKeywords]);

  useEffect(() => { if (keyword && !keywordList.includes(keyword)) setKeyword(null); }, [keywordList, keyword]);

  const ksvByWeek = useMemo(() => new Map((weeklyKeywords || []).map((w) => [w.week_ending, w.keywords || {}])), [weeklyKeywords]);
  const weekly = useMemo(() => rollupWeeklyTikTok(rows || [], TIKTOK_FIELDS.map((f) => f.key)), [rows]);
  // True overlap = complete TikTok weeks that ALSO have a full branded-search row
  // (all keywords present). This — not the raw TikTok-week count — is what the
  // correlations actually run on, so headline + caveat must use it.
  const overlapWeeks = useMemo(
    () => weekly.filter((w) => w.days >= MIN_WEEK_DAYS && ksvWeekValue(ksvByWeek.get(w.week_ending), null, keywordList) != null).length,
    [weekly, ksvByWeek, keywordList],
  );

  // week-lag finder: every TikTok metric × week-lag 0..4 vs KSV(keyword)
  const grid = useMemo(() => TIKTOK_FIELDS.map((tf) => {
    const cells = WEEK_LAGS.map((L) => {
      const { r, n } = weeklySearchPairs({ weeklyTikTok: weekly, ksvByWeek, tiktokKey: tf.key, keyword, weekLag: L, minDays: MIN_WEEK_DAYS, allKeywords: keywordList });
      return { lag: L, r, n };
    });
    const valid = cells.filter((c) => c.r != null);
    const best = valid.length ? valid.reduce((a, b) => (b.r > a.r ? b : a)) : null;
    return { field: tf, cells, best };
  }), [weekly, ksvByWeek, keyword, keywordList]);

  const topSignals = useMemo(() => {
    const all = [];
    grid.forEach((row) => row.cells.forEach((c) => { if (c.r != null) all.push({ field: row.field, lag: c.lag, r: c.r }); }));
    all.sort((a, b) => b.r - a.r);
    return all.slice(0, 5);
  }, [grid]);

  const compare = useMemo(
    () => weeklySearchPairs({ weeklyTikTok: weekly, ksvByWeek, tiktokKey, keyword, weekLag, minDays: MIN_WEEK_DAYS, allKeywords: keywordList }),
    [weekly, ksvByWeek, tiktokKey, keyword, weekLag, keywordList],
  );
  const tf = FIELD_BY_KEY[tiktokKey];
  const lineData = compare.points.map((p) => ({ label: p.label, a: p.x, b: p.y }));

  if (!hasData) {
    return (
      <div className="wx-card" style={{ padding: 28, textAlign: 'center', color: 'var(--text-muted)', display: 'flex', flexDirection: 'column', gap: 8 }}>
        <div style={{ fontSize: 15, fontWeight: 700, color: 'var(--text-primary)' }}>No weekly search data in this dataset</div>
        <div style={{ fontSize: 13 }}>
          Branded search volume is weekly-only and lives in the workbook's <strong>“Branded Demand”</strong> tab.
          Re-upload the whole Google Sheet as one <strong>.xlsx</strong> (both tabs) to enable this view.
        </div>
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div className="wx-card" style={{ padding: 14, display: 'flex', flexDirection: 'column', gap: 10 }}>
        <div style={{ fontSize: 13, color: 'var(--text-muted)' }}>
          Branded <strong>Search Volume</strong> is only reported <strong>weekly</strong>, so this view rolls TikTok activity up to
          the same Sun–Sat weeks and correlates <strong>week over week</strong> (lag in weeks). It answers: which TikTok metric drives
          branded Amazon searches, and how many weeks later?
        </div>
        <div style={{ display: 'flex', gap: 16, alignItems: 'center', flexWrap: 'wrap' }}>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <span style={{ fontSize: 11, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '.05em', fontWeight: 600 }}>Keyword</span>
            <select className="wx-input" style={{ maxWidth: 220, height: 30, padding: '2px 8px', fontSize: 12.5 }}
              value={keyword || ''} onChange={(e) => setKeyword(e.target.value || null)}>
              <option value="">All keywords (total)</option>
              {keywordList.map((k) => <option key={k} value={k}>{k}</option>)}
            </select>
          </div>
          <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
            Based on <strong style={{ color: 'var(--text-primary)' }}>{overlapWeeks}</strong> complete week{overlapWeeks === 1 ? '' : 's'} where TikTok and branded-search data overlap.
          </span>
        </div>
        {overlapWeeks < WEEKLY_DIRECTIONAL_UNTIL && (
          <div style={{ fontSize: 12, color: 'var(--warning)', background: 'rgba(245,158,11,.10)', border: '1px solid var(--warning, #f59e0b)', borderRadius: 'var(--radius-md)', padding: '8px 12px' }}>
            ⚠ Only {overlapWeeks} overlapping week{overlapWeeks === 1 ? '' : 's'} — treat these correlations as <strong>directional</strong>.
            They sharpen as more weeks of data accumulate.
          </div>
        )}
      </div>

      {/* week-lag finder */}
      <div className="wx-card" style={{ padding: 14, display: 'flex', flexDirection: 'column', gap: 10 }}>
        <div style={{ fontSize: 12.5, color: 'var(--text-muted)' }}>
          Pearson <strong>r</strong> of each TikTok metric (rolled up weekly) vs <strong>branded search{keyword ? ` — ${keyword}` : ''}</strong>,
          sampled that many <strong>weeks</strong> later. Peak lag per row is outlined.
        </div>
        <div style={{ overflowX: 'auto' }}>
          <table style={{ borderCollapse: 'collapse', fontSize: 11 }}>
            <thead>
              <tr>
                <th style={{ position: 'sticky', left: 0, background: 'var(--surface-1)', zIndex: 1, textAlign: 'left', padding: '4px 8px', color: 'var(--text-muted)', fontWeight: 600 }}>TikTok metric</th>
                <th colSpan={WEEK_LAGS.length} style={{ padding: '2px 6px', color: 'var(--text-muted)', fontWeight: 600, fontSize: 10.5, textTransform: 'uppercase', letterSpacing: '.05em' }}>Lag (weeks)</th>
                <th style={{ padding: '4px 8px', color: 'var(--text-muted)', fontWeight: 600 }}>Peak</th>
              </tr>
              <tr>
                <th style={{ position: 'sticky', left: 0, background: 'var(--surface-1)', zIndex: 1 }} />
                {WEEK_LAGS.map((L) => <th key={L} style={{ padding: '3px 8px', color: 'var(--text-muted)', fontWeight: 600, minWidth: 40, textAlign: 'center' }}>{L}</th>)}
                <th />
              </tr>
            </thead>
            <tbody>
              {grid.map((row) => (
                <tr key={row.field.key}>
                  <td style={{ padding: '4px 8px', color: 'var(--text-primary)', fontWeight: 600, whiteSpace: 'nowrap', position: 'sticky', left: 0, background: 'var(--surface-1)' }}>{row.field.label}</td>
                  {row.cells.map((c) => {
                    const isPeak = row.best && c.lag === row.best.lag && row.best.r != null;
                    return (
                      <td key={c.lag}
                        title={`${row.field.label} → branded search @ ${c.lag} wk: r=${c.r == null ? 'n/a' : c.r.toFixed(2)} (n=${c.n})`}
                        style={{
                          padding: '5px 8px', textAlign: 'center', minWidth: 40, background: corrColor(c.r),
                          color: 'var(--text-primary)',
                          fontWeight: isPeak ? 800 : (c.r != null && Math.abs(c.r) >= 0.6 ? 700 : 400),
                          outline: isPeak ? '2px solid var(--accent)' : 'none', outlineOffset: -2, borderRadius: 3,
                        }}>
                        {c.r == null ? '·' : c.r.toFixed(2)}
                      </td>
                    );
                  })}
                  <td style={{ padding: '4px 8px', whiteSpace: 'nowrap', color: 'var(--text-muted)' }}>
                    {row.best ? <>lag <strong style={{ color: 'var(--text-primary)' }}>{row.best.lag}w</strong> · r <strong style={{ color: 'var(--text-primary)' }}>{row.best.r.toFixed(2)}</strong></> : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {topSignals.length > 0 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 4 }}>
            <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-primary)' }}>Strongest weekly signals</div>
            {topSignals.map((s, i) => (
              <div key={`${s.field.key}-${s.lag}`} style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 13 }}>
                <span style={{ width: 18, color: 'var(--text-muted)', fontVariantNumeric: 'tabular-nums' }}>{i + 1}.</span>
                <span style={{ width: 10, height: 10, borderRadius: 3, background: corrColor(s.r), flex: '0 0 auto', outline: '1px solid var(--border-subtle)' }} />
                <span style={{ color: 'var(--text-primary)', fontWeight: 600 }}>{s.field.label}</span>
                <span style={{ color: 'var(--text-muted)' }}>at <strong style={{ color: 'var(--text-primary)' }}>lag {s.lag} week{s.lag === 1 ? '' : 's'}</strong></span>
                <span style={{ marginLeft: 'auto', fontWeight: 700, color: s.r < 0 ? '#ef4444' : (s.r >= 0.3 ? '#22c55e' : 'var(--text-muted)') }}>
                  r = {s.r.toFixed(2)} · {strengthLabel(s.r)}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* weekly compare chart */}
      <div className="wx-card" style={{ padding: 14, display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
          <FieldSelectTikTok value={tiktokKey} onChange={setTiktokKey} />
          <span style={{ color: 'var(--text-muted)' }}>vs branded search{keyword ? ` — ${keyword}` : ''}</span>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <span style={{ fontSize: 11, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '.05em' }}>Week lag</span>
            <select className="wx-input" style={{ width: 64, height: 30, padding: '2px 8px' }} value={weekLag} onChange={(e) => setWeekLag(Number(e.target.value))}>
              {WEEK_LAGS.map((L) => <option key={L} value={L}>{L}</option>)}
            </select>
          </div>
          <RBadge r={compare.r} />
        </div>
        <div style={{ fontSize: 13, color: 'var(--text-muted)' }}>{weeklyDirection(tf?.label || tiktokKey, compare.r, compare.n)}</div>
        <div style={{ width: '100%', height: 280 }}>
          <ResponsiveContainer width="100%" height="100%">
            <ComposedChart data={lineData} margin={{ top: 8, right: 8, bottom: 4, left: 0 }}>
              <CartesianGrid stroke={GRID} strokeDasharray="3 3" />
              <XAxis dataKey="label" tick={{ fontSize: 10, fill: 'var(--text-muted)' }} minTickGap={10} />
              <YAxis yAxisId="l" tick={{ fontSize: 10, fill: PALETTE[0] }} width={54} />
              <YAxis yAxisId="r" orientation="right" tick={{ fontSize: 10, fill: PALETTE[1] }} width={54} />
              <Tooltip contentStyle={TT_STYLE}
                formatter={(val, key) => [fmtValue(val, key === 'a' ? tf?.fmt : KSV_META.fmt), key === 'a' ? (tf?.label || tiktokKey) : `Branded search${keyword ? ` — ${keyword}` : ''}`]} />
              <Legend formatter={(k) => (k === 'a' ? (tf?.label || tiktokKey) : 'Branded search')} wrapperStyle={{ fontSize: 12 }} />
              <Line yAxisId="l" type="monotone" dataKey="a" stroke={PALETTE[0]} dot strokeWidth={2} />
              <Line yAxisId="r" type="monotone" dataKey="b" stroke={PALETTE[1]} dot strokeWidth={2} />
            </ComposedChart>
          </ResponsiveContainer>
        </div>
      </div>
    </div>
  );
}

// A TikTok-only field <select> (weekly view correlates TikTok drivers only).
function FieldSelectTikTok({ value, onChange }) {
  return (
    <select className="wx-input" value={value} onChange={(e) => onChange(e.target.value)} style={{ maxWidth: 240 }}>
      {TIKTOK_FIELDS.map((f) => <option key={f.key} value={f.key}>{f.label}</option>)}
    </select>
  );
}
