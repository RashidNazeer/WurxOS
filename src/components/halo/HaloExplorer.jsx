// ============================================================
// Amazon Halo — read-only explorer (Compare / Heatmap / Overlay +
// lag slider + metric pickers + dataset switcher).
//
// Extracted from AmazonHaloPage so the Boss page and the public
// portal page render the SAME UI. The only difference is the Boss
// passes an `onDelete` prop (which shows a per-dataset Delete button);
// the public page omits it. loadRows(datasetId) => Promise<rows> makes
// this loader-agnostic (Boss uses getHaloRows; portal uses the anon RPC).
// ============================================================

import { useEffect, useMemo, useState } from 'react';
import {
  ResponsiveContainer, ComposedChart, LineChart, Line, XAxis, YAxis,
  CartesianGrid, Tooltip, Legend, ScatterChart, Scatter,
} from 'recharts';
import {
  HALO_FIELDS, FIELD_BY_KEY, AMAZON_FIELDS, TIKTOK_FIELDS, fmtValue,
} from '../../lib/haloFields';
import {
  indexByDate, pairSeries, correlationMatrix, overlaySeries,
  directionSentence, strengthLabel, corrColor,
} from '../../lib/haloMath';

const PALETTE = ['#6366f1', '#22c55e', '#f59e0b', '#ef4444', '#06b6d4', '#a855f7', '#ec4899', '#14b8a6'];
const TT_STYLE = { background: 'var(--surface-1, #16161c)', border: '1px solid var(--border-default, #2b2b35)', borderRadius: 8, fontSize: 12, color: 'var(--text-primary, #e8e8ee)' };
const GRID = 'var(--border-subtle, #2b2b3522)';

export default function HaloExplorer({ datasets, loadRows, onDelete, initialDatasetId = null }) {
  const [selectedId, setSelectedId] = useState(initialDatasetId);
  const [rows, setRows] = useState(null);
  const [rowsLoading, setRowsLoading] = useState(false);
  const [error, setError] = useState('');

  // explorer controls
  const [gran, setGran] = useState('day');       // day | week | month
  const [lag, setLag] = useState(0);             // halo delay in days
  const [view, setView] = useState('compare');   // compare | heatmap | overlay
  const [range, setRange] = useState({ start: '', end: '' });
  const [keyword, setKeyword] = useState(null);       // null = "All keywords" (volume total)
  const [rankKeyword, setRankKeyword] = useState(null); // null = "All keywords" (avg rank)
  const [downloading, setDownloading] = useState(false);

  // Keep a valid selection as the dataset list changes.
  useEffect(() => {
    if (!datasets.length) { setSelectedId(null); return; }
    if (!datasets.find((d) => d.id === selectedId)) setSelectedId(datasets[0].id);
  }, [datasets]); // eslint-disable-line react-hooks/exhaustive-deps

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

  const selectedDs = datasets.find((d) => d.id === selectedId) || null;

  // dummy field keys present in the current dataset (for "(test)" badges)
  const dummyKeys = useMemo(() => {
    const s = new Set();
    (rows || []).forEach((r) => (r.dummyFields || []).forEach((k) => s.add(k)));
    return s;
  }, [rows]);

  // Union of per-keyword breakdown keys across the dataset (empty for
  // datasets that have no keyword-level data → picker stays hidden). Volume
  // and rank keep separate lists (a sheet may list different keywords in each).
  const keywordList = useMemo(() => {
    const s = new Set();
    (rows || []).forEach((r) => Object.keys(r.keywords || {}).forEach((k) => s.add(k)));
    return [...s].sort();
  }, [rows]);
  const rankKeywordList = useMemo(() => {
    const s = new Set();
    (rows || []).forEach((r) => Object.keys(r.keywordRanks || {}).forEach((k) => s.add(k)));
    return [...s].sort();
  }, [rows]);

  // A newly loaded dataset may not share the previous keyword → reset.
  useEffect(() => { setKeyword(null); setRankKeyword(null); }, [selectedId]);
  useEffect(() => {
    if (keyword && !keywordList.includes(keyword)) setKeyword(null);
  }, [keywordList, keyword]);
  useEffect(() => {
    if (rankKeyword && !rankKeywordList.includes(rankKeyword)) setRankKeyword(null);
  }, [rankKeywordList, rankKeyword]);

  // When a specific keyword is picked, keyword_search_volume resolves to that
  // keyword's daily number; keyword_search_rank likewise resolves to the picked
  // rank keyword. Other metrics untouched; null pickers = the stored aggregate.
  const byDate = useMemo(() => {
    const base = rows || [];
    if (!keyword && !rankKeyword) return indexByDate(base);
    const m = {};
    for (const r of base) {
      const metrics = { ...r.metrics };
      if (keyword) metrics.keyword_search_volume = r.keywords?.[keyword] ?? 0;
      if (rankKeyword) metrics.keyword_search_rank = r.keywordRanks?.[rankKeyword] ?? null;
      m[r.date] = metrics;
    }
    return m;
  }, [rows, keyword, rankKeyword]);
  const dates = useMemo(() => {
    if (!rows) return [];
    return rows.map((r) => r.date).filter((d) => (!range.start || d >= range.start) && (!range.end || d <= range.end));
  }, [rows, range]);

  // Export the CURRENTLY selected dataset's rows to .xlsx: Date + one column
  // per HALO_FIELDS (metrics), plus one column per dummy keyword (breakdown).
  async function downloadXlsx() {
    if (!rows || !selectedDs || downloading) return;
    setDownloading(true);
    try {
      const XLSX = await import('xlsx'); // heavy — loaded on demand (matches haloParse)
      // Mirror the UPLOAD layout so a downloaded sheet re-imports cleanly:
      // Date | …fixed… | NTB | <volume keyword cols> | Revenue/Day |
      // <rank keyword cols> | Product clicks | … Duplicate keyword names across
      // volume & rank are fine because we build an array-of-arrays, not an
      // object (which would collapse same-named keys).
      const cols = [{ label: 'Date', get: (r) => r.date }];
      for (const f of HALO_FIELDS) {
        if (f.key === 'keyword_search_volume') {
          if (keywordList.length) keywordList.forEach((kw) => cols.push({ label: kw, get: (r) => r.keywords?.[kw] ?? '' }));
          else cols.push({ label: f.label, get: (r) => r.metrics?.[f.key] ?? '' });
        } else if (f.key === 'keyword_search_rank') {
          if (rankKeywordList.length) rankKeywordList.forEach((kw) => cols.push({ label: kw, get: (r) => r.keywordRanks?.[kw] ?? '' }));
          else cols.push({ label: f.label, get: (r) => r.metrics?.[f.key] ?? '' });
        } else {
          // Use the sheet header (matches the source sheet's exact column name,
          // e.g. "NTB", "orders") so a downloaded sheet re-imports identically.
          cols.push({ label: f.sheetHeader || f.label, get: (r) => r.metrics?.[f.key] ?? '' });
        }
      }
      const aoa = [cols.map((c) => c.label), ...rows.map((r) => cols.map((c) => c.get(r)))];
      const ws = XLSX.utils.aoa_to_sheet(aoa);
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, 'Halo');
      const safe = String(selectedDs.name || 'dataset')
        .replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '') || 'dataset';
      XLSX.writeFile(wb, `halo-${safe}.xlsx`);
    } catch (e) {
      setError(e.message || String(e));
    } finally {
      setDownloading(false);
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      {error && (
        <div className="wx-alert wx-alert-danger"><span>{error}</span></div>
      )}

      <DatasetBar
        datasets={datasets}
        selectedId={selectedId}
        onSelect={setSelectedId}
        onDelete={onDelete}
        onDownload={downloadXlsx}
        downloading={downloading}
        canDownload={!!rows && !rowsLoading}
      />

      {!selectedId ? (
        <div className="wx-card" style={{ padding: 28, textAlign: 'center', color: 'var(--text-muted)' }}>
          No dataset selected.
        </div>
      ) : rowsLoading || !rows ? (
        <div className="wx-card" style={{ padding: 28, textAlign: 'center' }}>
          <span className="wx-spinner" /> Loading data…
        </div>
      ) : (
        <>
          <FiltersBar
            gran={gran} setGran={setGran}
            lag={lag} setLag={setLag}
            range={range} setRange={setRange}
            period={{ start: selectedDs?.period_start, end: selectedDs?.period_end }}
            hasDummy={selectedDs?.has_dummy}
          />

          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {[['compare', 'Compare two'], ['heatmap', 'Correlation heatmap'], ['overlay', 'Multi-metric overlay'], ['lagfinder', 'Lag finder']].map(([k, label]) => (
              <button key={k} type="button"
                className={`wx-btn ${view === k ? 'wx-btn-primary' : 'wx-btn-ghost'} wx-btn-sm`}
                onClick={() => setView(k)}>{label}</button>
            ))}
          </div>

          {dates.length < 3 ? (
            <div className="wx-card" style={{ padding: 24, textAlign: 'center', color: 'var(--text-muted)' }}>
              Not enough days in the selected range to correlate (need at least 3).
            </div>
          ) : view === 'compare' ? (
            <CompareView byDate={byDate} dates={dates} gran={gran} lag={lag} dummyKeys={dummyKeys}
              keyword={keyword} setKeyword={setKeyword} keywordList={keywordList}
              rankKeyword={rankKeyword} setRankKeyword={setRankKeyword} rankKeywordList={rankKeywordList} />
          ) : view === 'heatmap' ? (
            <HeatmapView byDate={byDate} dates={dates} gran={gran} lag={lag}
              keyword={keyword} setKeyword={setKeyword} keywordList={keywordList}
              rankKeyword={rankKeyword} setRankKeyword={setRankKeyword} rankKeywordList={rankKeywordList} />
          ) : view === 'overlay' ? (
            <OverlayView byDate={byDate} dates={dates} gran={gran} dummyKeys={dummyKeys}
              keyword={keyword} setKeyword={setKeyword} keywordList={keywordList}
              rankKeyword={rankKeyword} setRankKeyword={setRankKeyword} rankKeywordList={rankKeywordList} />
          ) : (
            <LagFinderView byDate={byDate} dates={dates} gran={gran}
              keyword={keyword} setKeyword={setKeyword} keywordList={keywordList}
              rankKeyword={rankKeyword} setRankKeyword={setRankKeyword} rankKeywordList={rankKeywordList} />
          )}
        </>
      )}
    </div>
  );
}

// ============================================================
// Dataset switcher — Download for everyone; Delete only when onDelete is
// provided (Boss). Download exports the selected dataset to .xlsx.
// ============================================================
function DatasetBar({ datasets, selectedId, onSelect, onDelete, onDownload, downloading, canDownload }) {
  if (!datasets.length) return null;
  const sel = datasets.find((d) => d.id === selectedId);
  return (
    <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
      <select className="wx-input" style={{ maxWidth: 380 }} value={selectedId || ''} onChange={(e) => onSelect(e.target.value)}>
        {datasets.map((d) => (
          <option key={d.id} value={d.id}>
            {d.name} · {d.row_count} days{d.has_dummy ? ' · has test data' : ''}
          </option>
        ))}
      </select>
      {sel && onDownload && (
        <button type="button" className="wx-btn wx-btn-ghost wx-btn-sm"
          disabled={!canDownload || downloading} onClick={onDownload}
          title="Download this dataset as an Excel sheet">
          {downloading ? <><span className="wx-spinner" /> Preparing…</> : <><i className="bi bi-download" /> Download</>}
        </button>
      )}
      {sel && onDelete && (
        <button type="button" className="wx-btn wx-btn-ghost wx-btn-sm" onClick={() => onDelete(sel.id)}>
          Delete
        </button>
      )}
    </div>
  );
}

// ============================================================
// Global filters
// ============================================================
function FiltersBar({ gran, setGran, lag, setLag, range, setRange, period, hasDummy }) {
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

      {hasDummy && (
        <span style={{ fontSize: 11, color: 'var(--warning)', fontWeight: 700 }}>
          ⚠ contains test data
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
          <button key={k} type="button"
            className={`wx-btn ${value === k ? 'wx-btn-primary' : 'wx-btn-ghost'} wx-btn-sm`}
            onClick={() => onChange(k)}>{l}</button>
        ))}
      </div>
    </div>
  );
}

// A field <select> with Amazon / TikTok optgroups; marks test fields.
function FieldSelect({ value, onChange, dummyKeys }) {
  const opt = (f) => (
    <option key={f.key} value={f.key}>
      {f.label}{dummyKeys?.has(f.key) ? ' (test)' : ''}
    </option>
  );
  return (
    <select className="wx-input" value={value} onChange={(e) => onChange(e.target.value)} style={{ maxWidth: 240 }}>
      <optgroup label="Amazon">{AMAZON_FIELDS.map(opt)}</optgroup>
      <optgroup label="TikTok / GMV Max">{TIKTOK_FIELDS.map(opt)}</optgroup>
    </select>
  );
}

const KSV = 'keyword_search_volume';
const KSR = 'keyword_search_rank';

// Scopes a per-keyword Amazon metric (Search Volume or Search Rank) to a single
// keyword. Rendered only where that metric is actually in play (a Compare field,
// an Overlay chip, the Heatmap's row) — it does nothing to other metrics, so it
// stays hidden when its metric isn't in view (or the dataset has no keywords).
function KeywordPicker({
  keyword, setKeyword, keywordList,
  label = 'Keyword', allLabel = 'All keywords (total)', badge = 'Search volume', title,
}) {
  if (!keywordList?.length) return null;
  return (
    <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
      <span style={{ fontSize: 11, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '.05em', fontWeight: 600 }}>{label}</span>
      <select className="wx-input" style={{ maxWidth: 220, height: 30, padding: '2px 8px', fontSize: 12.5 }}
        value={keyword || ''} onChange={(e) => setKeyword(e.target.value || null)} title={title}>
        <option value="">{allLabel}</option>
        {keywordList.map((k) => <option key={k} value={k}>{k}</option>)}
      </select>
      {keyword && (
        <span style={{ background: 'var(--surface-2)', color: 'var(--accent)', borderRadius: 999, padding: '3px 10px', fontSize: 11, fontWeight: 700, whiteSpace: 'nowrap' }}>
          {badge}: {keyword}
        </span>
      )}
    </div>
  );
}

// The rank-flavoured picker (its own keyword list + "avg" wording).
function RankKeywordPicker({ rankKeyword, setRankKeyword, rankKeywordList }) {
  return (
    <KeywordPicker
      keyword={rankKeyword} setKeyword={setRankKeyword} keywordList={rankKeywordList}
      label="Rank keyword" allLabel="All keywords (avg)" badge="Search rank"
      title="Which keyword's daily search rank feeds Keyword Search Rank"
    />
  );
}

// ============================================================
// Compare view
// ============================================================
function CompareView({ byDate, dates, gran, lag, dummyKeys, keyword, setKeyword, keywordList, rankKeyword, setRankKeyword, rankKeywordList }) {
  const [a, setA] = useState('video_per_day');
  const [b, setB] = useState('keyword_search_volume');
  const fa = FIELD_BY_KEY[a], fb = FIELD_BY_KEY[b];
  const { points, r } = useMemo(() => pairSeries(byDate, dates, a, b, lag, gran), [byDate, dates, a, b, lag, gran]);
  const lineData = points.map((p) => ({ label: p.label, a: p.x, b: p.y }));

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div className="wx-card" style={{ padding: 14, display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
          <FieldSelect value={a} onChange={setA} dummyKeys={dummyKeys} />
          <span style={{ color: 'var(--text-muted)' }}>vs</span>
          <FieldSelect value={b} onChange={setB} dummyKeys={dummyKeys} />
          <RBadge r={r} />
          {(a === KSV || b === KSV) && (
            <KeywordPicker keyword={keyword} setKeyword={setKeyword} keywordList={keywordList} />
          )}
          {(a === KSR || b === KSR) && (
            <RankKeywordPicker rankKeyword={rankKeyword} setRankKeyword={setRankKeyword} rankKeywordList={rankKeywordList} />
          )}
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
  // Colour by SIGN first: a negative correlation is the opposite of the halo
  // hypothesis, so ANY negative reads red — even a weak one (matches the
  // heatmap's corrColor semantics). Magnitude only controls tint saturation;
  // positive stays green (strong) / amber (moderate) / neutral (little/none).
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
// Heatmap view
// ============================================================
function HeatmapView({ byDate, dates, gran, lag, keyword, setKeyword, keywordList, rankKeyword, setRankKeyword, rankKeywordList }) {
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
          <KeywordPicker keyword={keyword} setKeyword={setKeyword} keywordList={keywordList} />
          <RankKeywordPicker rankKeyword={rankKeyword} setRankKeyword={setRankKeyword} rankKeywordList={rankKeywordList} />
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
                <th key={c.key} style={{ padding: '4px 6px', color: 'var(--text-muted)', fontWeight: 600, writingMode: 'vertical-rl', transform: 'rotate(180deg)', height: 96, whiteSpace: 'nowrap' }}>
                  {c.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rowFields.map((rf, i) => (
              <tr key={rf.key}>
                <td style={{ padding: '4px 8px', color: 'var(--text-primary)', fontWeight: 600, whiteSpace: 'nowrap', position: 'sticky', left: 0, background: 'var(--surface-1)' }}>
                  {rf.label}
                </td>
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
// Overlay view
// ============================================================
function OverlayView({ byDate, dates, gran, dummyKeys, keyword, setKeyword, keywordList, rankKeyword, setRankKeyword, rankKeywordList }) {
  const [keys, setKeys] = useState(['video_per_day', 'keyword_search_volume', 'ntb']);
  const data = useMemo(() => overlaySeries(byDate, dates, keys, gran), [byDate, dates, keys, gran]);

  function toggle(k) {
    setKeys((cur) => (cur.includes(k) ? cur.filter((x) => x !== k) : [...cur, k]));
  }

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
              {f.group === 'amazon' ? '🟠 ' : ''}{f.label}{dummyKeys?.has(f.key) ? ' (test)' : ''}
            </button>
          );
        })}
      </div>
      {keys.includes(KSV) && (
        <KeywordPicker keyword={keyword} setKeyword={setKeyword} keywordList={keywordList} />
      )}
      {keys.includes(KSR) && (
        <RankKeywordPicker rankKeyword={rankKeyword} setRankKeyword={setRankKeyword} rankKeywordList={rankKeywordList} />
      )}
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
// Lag finder view — sweep ALL TikTok metrics against ONE Amazon metric
// across every halo lag (0..14 days) and surface where the correlation
// peaks. Answers "which TikTok metric drives this Amazon metric, and after
// how many days?". Self-contained; sweeps its own lags (ignores the global
// lag slider). Cycle the Amazon metric to analyse each in turn.
// ============================================================
const LAGS = Array.from({ length: 15 }, (_, i) => i); // 0..14 days

function LagFinderView({ byDate, dates, gran, keyword, setKeyword, keywordList, rankKeyword, setRankKeyword, rankKeywordList }) {
  const [amazonKey, setAmazonKey] = useState(AMAZON_FIELDS[0].key);
  const [rankBy, setRankBy] = useState('positive'); // 'positive' = highest r | 'magnitude' = largest |r|

  const amazonField = FIELD_BY_KEY[amazonKey];

  // grid[row] = { field, cells:[{lag,r}], best:{lag,r} }
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
                onClick={() => setRankBy(k)} title="How the peak lag per row and the top-signals list are ranked">{l}</button>
            ))}
          </div>
        </div>

        {amazonKey === KSV && <KeywordPicker keyword={keyword} setKeyword={setKeyword} keywordList={keywordList} />}
        {amazonKey === KSR && <RankKeywordPicker rankKeyword={rankKeyword} setRankKeyword={setRankKeyword} rankKeywordList={rankKeywordList} />}

        <div style={{ fontSize: 12.5, color: 'var(--text-muted)' }}>
          Each cell is Pearson <strong>r</strong> between that TikTok metric (the cause) and <strong>{amazonField?.label}</strong> sampled
          that many days later. Green = positive, red = negative, stronger = more saturated. The <strong>peak lag per row</strong> is
          outlined. {amazonKey === KSR && <em>Note: rank is inverse — a strong NEGATIVE r (red) is the good signal (more reach → better rank).</em>}
        </div>

        <div style={{ overflowX: 'auto' }}>
          <table style={{ borderCollapse: 'collapse', fontSize: 11 }}>
            <thead>
              <tr>
                <th style={{ position: 'sticky', left: 0, background: 'var(--surface-1)', zIndex: 1, textAlign: 'left', padding: '4px 8px', color: 'var(--text-muted)', fontWeight: 600 }}>
                  TikTok metric
                </th>
                <th colSpan={LAGS.length} style={{ padding: '2px 6px', color: 'var(--text-muted)', fontWeight: 600, fontSize: 10.5, textTransform: 'uppercase', letterSpacing: '.05em' }}>
                  Halo lag (days)
                </th>
                <th style={{ padding: '4px 8px', color: 'var(--text-muted)', fontWeight: 600 }}>Peak</th>
              </tr>
              <tr>
                <th style={{ position: 'sticky', left: 0, background: 'var(--surface-1)', zIndex: 1 }} />
                {LAGS.map((L) => (
                  <th key={L} style={{ padding: '3px 6px', color: 'var(--text-muted)', fontWeight: 600, minWidth: 34, textAlign: 'center' }}>{L}</th>
                ))}
                <th />
              </tr>
            </thead>
            <tbody>
              {grid.map((row) => (
                <tr key={row.field.key}>
                  <td style={{ padding: '4px 8px', color: 'var(--text-primary)', fontWeight: 600, whiteSpace: 'nowrap', position: 'sticky', left: 0, background: 'var(--surface-1)' }}>
                    {row.field.label}
                  </td>
                  {row.cells.map((c) => {
                    const isPeak = row.best && c.lag === row.best.lag;
                    return (
                      <td key={c.lag}
                        title={`${row.field.label} → ${amazonField?.label} @ lag ${c.lag}d: r=${c.r == null ? 'n/a' : c.r.toFixed(2)}`}
                        style={{
                          padding: '5px 6px', textAlign: 'center', minWidth: 34,
                          background: corrColor(c.r),
                          color: 'var(--text-primary)',
                          fontWeight: isPeak ? 800 : (c.r != null && Math.abs(c.r) >= 0.6 ? 700 : 400),
                          outline: isPeak ? '2px solid var(--accent)' : 'none',
                          outlineOffset: -2, borderRadius: 3,
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
        <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--text-primary)' }}>
          Strongest signals for {amazonField?.label}
        </div>
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
