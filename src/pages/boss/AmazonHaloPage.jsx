import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ResponsiveContainer, ComposedChart, LineChart, Line, XAxis, YAxis,
  CartesianGrid, Tooltip, Legend, ScatterChart, Scatter,
} from 'recharts';
import {
  HALO_FIELDS, FIELD_BY_KEY, AMAZON_FIELDS, TIKTOK_FIELDS, fmtValue,
} from '../../lib/haloFields';
import { parseHaloSheet } from '../../lib/haloParse';
import { fillDummyColumns } from '../../lib/haloDummy';
import {
  indexByDate, pairSeries, correlationMatrix, overlaySeries,
  directionSentence, strengthLabel, corrColor,
} from '../../lib/haloMath';
import {
  listHaloDatasets, getHaloRows, createHaloDataset, deleteHaloDataset,
} from '../../lib/haloApi';

const PALETTE = ['#6366f1', '#22c55e', '#f59e0b', '#ef4444', '#06b6d4', '#a855f7', '#ec4899', '#14b8a6'];
const TT_STYLE = { background: 'var(--surface-1, #16161c)', border: '1px solid var(--border-default, #2b2b35)', borderRadius: 8, fontSize: 12, color: 'var(--text-primary, #e8e8ee)' };
const GRID = 'var(--border-subtle, #2b2b3522)';

export default function AmazonHaloPage() {
  const [datasets, setDatasets] = useState([]);
  const [selectedId, setSelectedId] = useState(null);
  const [rows, setRows] = useState(null);
  const [loading, setLoading] = useState(true);
  const [rowsLoading, setRowsLoading] = useState(false);
  const [error, setError] = useState('');

  // explorer controls
  const [gran, setGran] = useState('day');       // day | week | month
  const [lag, setLag] = useState(0);             // halo delay in days
  const [view, setView] = useState('compare');   // compare | heatmap | overlay
  const [range, setRange] = useState({ start: '', end: '' });

  async function refreshDatasets(selectFirst = false) {
    setLoading(true); setError('');
    try {
      const ds = await listHaloDatasets();
      setDatasets(ds);
      if (selectFirst && ds.length && !selectedId) setSelectedId(ds[0].id);
      else if (ds.length && !ds.find((d) => d.id === selectedId)) setSelectedId(ds[0]?.id || null);
    } catch (e) { setError(e.message || String(e)); }
    finally { setLoading(false); }
  }

  useEffect(() => { refreshDatasets(true); /* eslint-disable-next-line */ }, []);

  useEffect(() => {
    if (!selectedId) { setRows(null); return; }
    let alive = true;
    setRowsLoading(true);
    getHaloRows(selectedId)
      .then((r) => {
        if (!alive) return;
        setRows(r);
        if (r.length) setRange({ start: r[0].date, end: r[r.length - 1].date });
      })
      .catch((e) => alive && setError(e.message || String(e)))
      .finally(() => alive && setRowsLoading(false));
    return () => { alive = false; };
  }, [selectedId]);

  const selectedDs = datasets.find((d) => d.id === selectedId) || null;

  // dummy field keys present in the current dataset (for "(test)" badges)
  const dummyKeys = useMemo(() => {
    const s = new Set();
    (rows || []).forEach((r) => (r.dummyFields || []).forEach((k) => s.add(k)));
    return s;
  }, [rows]);

  const byDate = useMemo(() => indexByDate(rows || []), [rows]);
  const dates = useMemo(() => {
    if (!rows) return [];
    return rows.map((r) => r.date).filter((d) => (!range.start || d >= range.start) && (!range.end || d <= range.end));
  }, [rows, range]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14, paddingBottom: 40 }}>
      <div>
        <h1 className="page-title">Amazon Halo Effect</h1>
        <p style={{ color: 'var(--text-muted)', fontSize: 13, margin: '4px 0 0', maxWidth: 720 }}>
          Upload a daily performance sheet and explore how TikTok activity drives Amazon demand.
          Correlate any two metrics, browse the full correlation heatmap, and shift the{' '}
          <strong>halo lag</strong> to see the delayed spillover (TikTok today → Amazon a few days later).
        </p>
      </div>

      {error && (
        <div className="wx-alert wx-alert-danger"><span>{error}</span></div>
      )}

      <UploadPanel dummyDefault onUploaded={(id) => { setSelectedId(id); refreshDatasets(); }} />

      <DatasetBar
        datasets={datasets}
        loading={loading}
        selectedId={selectedId}
        onSelect={setSelectedId}
        onDelete={async (id) => {
          if (!window.confirm('Delete this dataset and all its rows?')) return;
          await deleteHaloDataset(id);
          if (id === selectedId) setSelectedId(null);
          refreshDatasets(true);
        }}
      />

      {!selectedId ? (
        <div className="wx-card" style={{ padding: 28, textAlign: 'center', color: 'var(--text-muted)' }}>
          No dataset selected. Upload a sheet above to get started.
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
            {[['compare', 'Compare two'], ['heatmap', 'Correlation heatmap'], ['overlay', 'Multi-metric overlay']].map(([k, label]) => (
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
            <CompareView byDate={byDate} dates={dates} gran={gran} lag={lag} dummyKeys={dummyKeys} />
          ) : view === 'heatmap' ? (
            <HeatmapView byDate={byDate} dates={dates} gran={gran} lag={lag} />
          ) : (
            <OverlayView byDate={byDate} dates={dates} gran={gran} dummyKeys={dummyKeys} />
          )}
        </>
      )}
    </div>
  );
}

// ============================================================
// Upload
// ============================================================
function UploadPanel({ onUploaded, dummyDefault }) {
  const [open, setOpen] = useState(false);
  const [file, setFile] = useState(null);
  const [name, setName] = useState('');
  const [fillDummy, setFillDummy] = useState(!!dummyDefault);
  const [parsed, setParsed] = useState(null);
  const [parseErr, setParseErr] = useState('');
  const [saving, setSaving] = useState(false);
  const inputRef = useRef(null);

  async function onFile(f) {
    setFile(f); setParsed(null); setParseErr('');
    if (!f) return;
    try {
      const ab = await f.arrayBuffer();
      const p = await parseHaloSheet(ab);
      setParsed(p);
      if (!name) setName(f.name.replace(/\.(xlsx|xls|csv)$/i, '') + ` (${p.periodStart} → ${p.periodEnd})`);
    } catch (e) { setParseErr(e.message || String(e)); }
  }

  async function save() {
    if (!parsed) return;
    setSaving(true); setParseErr('');
    try {
      let outRows = parsed.rows.map((r) => ({ ...r, dummyFields: [] }));
      let hasDummy = false;
      if (fillDummy) {
        const res = fillDummyColumns(parsed.rows);
        outRows = res.rows;
        hasDummy = res.filled.length > 0;
      }
      const ds = await createHaloDataset({
        name, filename: file?.name,
        periodStart: parsed.periodStart, periodEnd: parsed.periodEnd,
        rows: outRows, hasDummy,
      });
      setOpen(false); setFile(null); setParsed(null); setName('');
      if (inputRef.current) inputRef.current.value = '';
      onUploaded?.(ds.id);
    } catch (e) { setParseErr(e.message || String(e)); }
    finally { setSaving(false); }
  }

  if (!open) {
    return (
      <div>
        <button type="button" className="wx-btn wx-btn-ghost wx-btn-sm" onClick={() => setOpen(true)}>
          ⬆ Upload sheet
        </button>
      </div>
    );
  }

  return (
    <div className="wx-card" style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <strong>Upload performance sheet</strong>
        <button type="button" className="wx-btn wx-btn-ghost wx-btn-sm" onClick={() => setOpen(false)}>Close</button>
      </div>

      <input ref={inputRef} type="file" accept=".xlsx,.xls,.csv" className="wx-input"
        onChange={(e) => onFile(e.target.files?.[0] || null)} />

      {parseErr && <div className="wx-alert wx-alert-danger"><span>{parseErr}</span></div>}

      {parsed && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div style={{ fontSize: 13, color: 'var(--text-muted)' }}>
            Parsed <strong style={{ color: 'var(--text-primary)' }}>{parsed.rows.length}</strong> days
            ({parsed.periodStart} → {parsed.periodEnd}) · {parsed.foundKeys.length} columns recognised.
          </div>
          <label style={{ fontSize: 12, color: 'var(--text-muted)' }}>
            Dataset name
            <input className="wx-input" style={{ marginTop: 4 }} value={name} onChange={(e) => setName(e.target.value)} />
          </label>
          <label style={{ display: 'flex', gap: 8, alignItems: 'flex-start', fontSize: 12.5 }}>
            <input type="checkbox" checked={fillDummy} onChange={(e) => setFillDummy(e.target.checked)} style={{ marginTop: 2 }} />
            <span>
              Fill empty Amazon columns (Keyword Search Volume, Revenue/Day) with <strong>meaningful test data</strong> so
              the graphs show a signal now. Clearly badged as test; replace by uploading a sheet with real values.
            </span>
          </label>
          <div>
            <button type="button" className="wx-btn wx-btn-primary" disabled={saving} onClick={save}>
              {saving ? 'Saving…' : 'Save dataset'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ============================================================
// Dataset switcher
// ============================================================
function DatasetBar({ datasets, loading, selectedId, onSelect, onDelete }) {
  if (loading) return <div style={{ color: 'var(--text-muted)', fontSize: 13 }}><span className="wx-spinner" /> Loading datasets…</div>;
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
      {sel && (
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

// ============================================================
// Compare view
// ============================================================
function CompareView({ byDate, dates, gran, lag, dummyKeys }) {
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
  const bg = r == null ? 'var(--surface-2)' : Math.abs(r) >= 0.6 ? 'rgba(34,197,94,.18)' : Math.abs(r) >= 0.3 ? 'rgba(245,158,11,.18)' : 'var(--surface-2)';
  const fg = r == null ? 'var(--text-muted)' : Math.abs(r) >= 0.6 ? '#22c55e' : Math.abs(r) >= 0.3 ? '#f59e0b' : 'var(--text-muted)';
  return (
    <span style={{ background: bg, color: fg, borderRadius: 999, padding: '4px 12px', fontWeight: 700, fontSize: 13 }}>
      r = {r == null ? '—' : r.toFixed(2)} · {strengthLabel(r)}
    </span>
  );
}

// ============================================================
// Heatmap view
// ============================================================
function HeatmapView({ byDate, dates, gran, lag }) {
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
function OverlayView({ byDate, dates, gran, dummyKeys }) {
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
        {HALO_FIELDS.map((f, i) => {
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
