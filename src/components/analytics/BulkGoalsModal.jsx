// ============================================================
// Brand Analytics — Bulk update goals via a CSV round-trip.
//
// Pick brands -> download a sheet of their current goals -> edit it anywhere ->
// upload it back. Goals only; see src/lib/brandGoalsBulk.js for why the achieved
// side is not in the sheet, and why rows are keyed on brand_id and not on name.
//
// Nothing is written until the preview has been seen. The preview is built from
// the brands the viewer may actually edit and from the figures stored right now,
// not from whatever was on screen when the sheet was downloaded.
// ============================================================
import { useEffect, useMemo, useRef, useState } from 'react';
import BrandAvatar from '../brands/BrandAvatar';
import { listBrandMetricsForMonth, saveBrandGoals } from '../../lib/brandMetricsApi';
import {
  buildGoalsCsv, parseGoalsCsv, diffGoalRows, suggestedFilename, GOAL_FIELDS,
} from '../../lib/brandGoalsBulk';

const fmt = (v, unit) => {
  if (v === null || v === undefined) return '—';
  const n = Number(v);
  if (unit === '$') return '$' + n.toLocaleString(undefined, { maximumFractionDigits: 2 });
  if (unit === 'x') return n + '×';
  return n.toLocaleString();
};

export default function BulkGoalsModal({ brands = [], month, monthLabel, onClose, onApplied }) {
  const [selected, setSelected] = useState(() => new Set(brands.map((b) => b.id)));
  const [search, setSearch] = useState('');
  const [listOpen, setListOpen] = useState(true);
  const [metrics, setMetrics] = useState({});
  const [loading, setLoading] = useState(true);
  const [csvText, setCsvText] = useState('');
  const [preview, setPreview] = useState(null);     // { changes, errors, warnings, unchanged }
  const [headerError, setHeaderError] = useState('');
  const [applying, setApplying] = useState(false);
  const [progress, setProgress] = useState(null);   // { done, total }
  const [results, setResults] = useState(null);     // [{ brandName, ok, message }]
  const fileRef = useRef(null);

  useEffect(() => {
    let cancelled = false;
    listBrandMetricsForMonth(month)
      .then((m) => { if (!cancelled) setMetrics(m || {}); })
      .catch(() => { if (!cancelled) setMetrics({}); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [month]);

  const shown = useMemo(() => {
    const q = search.trim().toLowerCase();
    return q ? brands.filter((b) => (b.brand_name || '').toLowerCase().includes(q)) : brands;
  }, [brands, search]);

  const toggle = (id) => setSelected((prev) => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  async function download() {
    // Re-read rather than trusting state that may be minutes old, so the sheet
    // opens with the figures that are actually stored.
    let current = metrics;
    try { current = (await listBrandMetricsForMonth(month)) || {}; setMetrics(current); } catch { /* use what we have */ }
    const chosen = brands.filter((b) => selected.has(b.id));
    const csv = buildGoalsCsv({ brands: chosen, metricsByBrand: current, month });
    const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = suggestedFilename(month);
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function onFile(e) {
    const f = e.target.files?.[0];
    if (!f) return;
    const r = new FileReader();
    r.onload = () => { setCsvText(String(r.result || '')); setPreview(null); setResults(null); };
    r.readAsText(f);
  }

  async function buildPreview() {
    setResults(null); setHeaderError('');
    const parsed = parseGoalsCsv(csvText);
    if (parsed.headerError) { setHeaderError(parsed.headerError); setPreview(null); return; }
    let current = metrics;
    try { current = (await listBrandMetricsForMonth(month)) || {}; setMetrics(current); } catch { /* use what we have */ }
    // editableBrands, not the tick-boxes: the sheet may have been downloaded in
    // another session, and the brands a person may edit is the real authority.
    setPreview(diffGoalRows({ rows: parsed.rows, editableBrands: brands, metricsByBrand: current }));
  }

  async function apply() {
    if (!preview?.changes?.length) return;
    setApplying(true);
    setProgress({ done: 0, total: preview.changes.length });
    const out = [];
    for (let i = 0; i < preview.changes.length; i++) {
      const c = preview.changes[i];
      try {
        await saveBrandGoals(c.brandId, month, c.targets);
        out.push({ brandName: c.brandName, ok: true, message: `${c.fields.length} goal${c.fields.length === 1 ? '' : 's'} updated` });
      } catch (e) {
        out.push({ brandName: c.brandName, ok: false, message: e?.message || String(e) });
      }
      setProgress({ done: i + 1, total: preview.changes.length });
    }
    setResults(out);
    setApplying(false);
    setPreview(null);
    onApplied?.();
  }

  const chosenCount = selected.size;
  const incentiveCount = preview?.changes?.filter((c) => c.touchesIncentives).length || 0;
  const failed = results?.filter((r) => !r.ok).length || 0;

  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 1070, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
      <div style={{ position: 'absolute', inset: 0, background: 'var(--backdrop)', backdropFilter: 'blur(3.9px)' }} onClick={applying ? undefined : onClose} />
      <div className="wx-card" style={{ position: 'relative', width: '100%', maxWidth: 720, zIndex: 1, borderRadius: 'var(--radius-xl)', maxHeight: '92vh', display: 'flex', flexDirection: 'column', padding: 0, overflow: 'hidden' }}>

        <div style={{ padding: '16px 22px', borderBottom: '1px solid var(--border-subtle)', display: 'flex', alignItems: 'center', gap: 12 }}>
          <i className="bi bi-table" style={{ fontSize: 20, color: 'var(--accent)' }} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontWeight: 800, fontSize: 15, color: 'var(--text-primary)' }}>Bulk update goals</div>
            <div style={{ fontSize: 12.5, color: 'var(--text-muted)' }}>{monthLabel}</div>
          </div>
          <button type="button" onClick={onClose} disabled={applying} aria-label="Close" className="wx-btn wx-btn-ghost" style={{ padding: '6px 10px' }}>
            <i className="bi bi-x-lg" />
          </button>
        </div>

        <div style={{ padding: '16px 22px', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 18 }}>

          {/* 1 — choose brands */}
          <section>
            <button type="button" onClick={() => setListOpen((v) => !v)}
              style={{ all: 'unset', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 8, width: '100%' }}>
              <i className={`bi ${listOpen ? 'bi-chevron-down' : 'bi-chevron-right'}`} style={{ color: 'var(--text-muted)' }} />
              <span style={{ fontWeight: 700, fontSize: 13.5, color: 'var(--text-primary)' }}>1 · Choose brands</span>
              <span style={{ marginLeft: 'auto', fontSize: 12.5, color: 'var(--text-muted)' }}>
                {chosenCount} of {brands.length} selected
              </span>
            </button>

            {listOpen && (
              <div style={{ marginTop: 10 }}>
                <div style={{ display: 'flex', gap: 8, marginBottom: 8, flexWrap: 'wrap' }}>
                  <input className="wx-input" placeholder="Search brands…" value={search}
                    onChange={(e) => setSearch(e.target.value)} style={{ flex: 1, minWidth: 160 }} />
                  <button type="button" className="wx-btn wx-btn-ghost" onClick={() => setSelected(new Set(brands.map((b) => b.id)))}>Select all</button>
                  <button type="button" className="wx-btn wx-btn-ghost" onClick={() => setSelected(new Set())}>Clear</button>
                </div>
                <div style={{ maxHeight: 220, overflowY: 'auto', border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius-md)' }}>
                  {shown.length === 0 && <div style={{ padding: 14, fontSize: 13, color: 'var(--text-muted)' }}>No brands match.</div>}
                  {shown.map((b) => (
                    <label key={b.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 12px', cursor: 'pointer', borderBottom: '1px solid var(--border-subtle)' }}>
                      <input type="checkbox" checked={selected.has(b.id)} onChange={() => toggle(b.id)} />
                      <BrandAvatar brand={b} size={22} radius={5} />
                      <span style={{ fontSize: 13, color: 'var(--text-primary)', flex: 1, minWidth: 0 }}>{b.brand_name}</span>
                    </label>
                  ))}
                </div>
                <div style={{ marginTop: 10, display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                  <button type="button" className="wx-btn wx-btn-primary" onClick={download} disabled={!chosenCount || loading}>
                    <i className="bi bi-download me-1" /> Download CSV
                  </button>
                  <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                    Goals only — achieved figures are not editable here.
                  </span>
                </div>
              </div>
            )}
          </section>

          {/* 2 — upload it back */}
          <section>
            <div style={{ fontWeight: 700, fontSize: 13.5, color: 'var(--text-primary)', marginBottom: 8 }}>2 · Upload the edited sheet</div>
            <input ref={fileRef} type="file" accept=".csv,text/csv" className="wx-input" onChange={onFile} style={{ width: '100%' }} />
            <textarea className="wx-input" rows={4} placeholder="…or paste the CSV here"
              value={csvText} onChange={(e) => { setCsvText(e.target.value); setPreview(null); setResults(null); }}
              style={{ width: '100%', marginTop: 8, fontFamily: 'var(--font-mono, monospace)', fontSize: 12 }} />
            <div style={{ marginTop: 8, display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
              <button type="button" className="wx-btn wx-btn-ghost" onClick={buildPreview} disabled={!csvText.trim() || applying}>
                <i className="bi bi-eye me-1" /> Preview changes
              </button>
              <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                Applies to <strong style={{ color: 'var(--text-primary)' }}>{monthLabel}</strong> — the month selected on this page, not the sheet.
              </span>
            </div>
            {headerError && (
              <div style={{ marginTop: 10, padding: '10px 12px', borderRadius: 'var(--radius-md)', background: 'var(--danger-soft, rgba(220,38,38,.1))', color: 'var(--danger, #dc2626)', fontSize: 12.5 }}>
                {headerError}
              </div>
            )}
          </section>

          {/* 3 — preview */}
          {preview && (
            <section>
              <div style={{ fontWeight: 700, fontSize: 13.5, color: 'var(--text-primary)', marginBottom: 8 }}>
                3 · Review — {preview.changes.length} brand{preview.changes.length === 1 ? '' : 's'} will change
                {preview.unchanged > 0 && <span style={{ fontWeight: 500, color: 'var(--text-muted)' }}> · {preview.unchanged} unchanged</span>}
              </div>

              {incentiveCount > 0 && (
                <div style={{ marginBottom: 10, padding: '10px 12px', borderRadius: 'var(--radius-md)', background: 'var(--warning-soft, rgba(217,119,6,.12))', color: 'var(--text-primary)', fontSize: 12.5, display: 'flex', gap: 8 }}>
                  <i className="bi bi-cash-coin" style={{ color: 'var(--warning, #d97706)' }} />
                  <span>
                    {incentiveCount} brand{incentiveCount === 1 ? '' : 's'} change the <strong>Monthly GMV Goal</strong>, which sets the
                    target on every “Total Revenue in GMV Max” incentive line for that brand — APC, Team Lead, Ads Manager and OL.
                  </span>
                </div>
              )}

              {preview.errors.length > 0 && (
                <div style={{ marginBottom: 10, padding: '10px 12px', borderRadius: 'var(--radius-md)', background: 'var(--danger-soft, rgba(220,38,38,.1))', fontSize: 12.5 }}>
                  <div style={{ fontWeight: 700, color: 'var(--danger, #dc2626)', marginBottom: 4 }}>
                    {preview.errors.length} row{preview.errors.length === 1 ? '' : 's'} rejected
                  </div>
                  {preview.errors.slice(0, 8).map((e, i) => (
                    <div key={i} style={{ color: 'var(--text-muted)' }}>Line {e.line}{e.brand ? ` · ${e.brand}` : ''}: {e.message}</div>
                  ))}
                  {preview.errors.length > 8 && <div style={{ color: 'var(--text-muted)' }}>…and {preview.errors.length - 8} more.</div>}
                </div>
              )}

              {preview.warnings.length > 0 && (
                <div style={{ marginBottom: 10, padding: '10px 12px', borderRadius: 'var(--radius-md)', background: 'var(--surface-2)', fontSize: 12.5 }}>
                  {preview.warnings.slice(0, 6).map((w, i) => (
                    <div key={i} style={{ color: 'var(--text-muted)' }}>Line {w.line} · {w.brand}: {w.message}</div>
                  ))}
                </div>
              )}

              <div style={{ maxHeight: 240, overflowY: 'auto', border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius-md)' }}>
                {preview.changes.map((c) => (
                  <div key={c.brandId} style={{ padding: '10px 12px', borderBottom: '1px solid var(--border-subtle)' }}>
                    <div style={{ fontWeight: 700, fontSize: 13, color: 'var(--text-primary)', marginBottom: 4 }}>{c.brandName}</div>
                    {c.fields.map((f) => (
                      <div key={f.col} style={{ fontSize: 12.5, color: 'var(--text-muted)' }}>
                        {f.label}: <span style={{ textDecoration: 'line-through' }}>{fmt(f.before, f.unit)}</span>
                        {' → '}<strong style={{ color: 'var(--text-primary)' }}>{fmt(f.after, f.unit)}</strong>
                      </div>
                    ))}
                  </div>
                ))}
                {preview.changes.length === 0 && (
                  <div style={{ padding: 14, fontSize: 13, color: 'var(--text-muted)' }}>Nothing to apply — every value matches what is already stored.</div>
                )}
              </div>
            </section>
          )}

          {/* 4 — results */}
          {results && (
            <section>
              <div style={{ fontWeight: 700, fontSize: 13.5, color: 'var(--text-primary)', marginBottom: 8 }}>
                Done — {results.length - failed} applied{failed > 0 ? `, ${failed} failed` : ''}
              </div>
              <div style={{ maxHeight: 200, overflowY: 'auto', border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius-md)' }}>
                {results.map((r, i) => (
                  <div key={i} style={{ padding: '8px 12px', borderBottom: '1px solid var(--border-subtle)', fontSize: 12.5, display: 'flex', gap: 8 }}>
                    <i className={`bi ${r.ok ? 'bi-check-circle-fill' : 'bi-x-circle-fill'}`}
                      style={{ color: r.ok ? 'var(--success, #16a34a)' : 'var(--danger, #dc2626)' }} />
                    <span style={{ fontWeight: 600, color: 'var(--text-primary)' }}>{r.brandName}</span>
                    <span style={{ color: 'var(--text-muted)' }}>{r.message}</span>
                  </div>
                ))}
              </div>
              {failed > 0 && (
                <div style={{ marginTop: 8, fontSize: 12.5, color: 'var(--text-muted)' }}>
                  Nothing was half-written: each brand is its own save. Fix the sheet and upload it again — re-applying an unchanged value is a no-op.
                </div>
              )}
            </section>
          )}
        </div>

        <div style={{ padding: '14px 22px', borderTop: '1px solid var(--border-subtle)', display: 'flex', alignItems: 'center', gap: 10 }}>
          {applying && progress && (
            <span style={{ fontSize: 12.5, color: 'var(--text-muted)' }}>Saving {progress.done} of {progress.total}…</span>
          )}
          <div style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
            <button type="button" className="wx-btn wx-btn-ghost" onClick={onClose} disabled={applying}>Close</button>
            <button type="button" className="wx-btn wx-btn-primary" onClick={apply}
              disabled={applying || !preview?.changes?.length}>
              {applying ? <><span className="wx-spinner" /> Applying…</> : <><i className="bi bi-check2 me-1" /> Apply {preview?.changes?.length || 0} change{preview?.changes?.length === 1 ? '' : 's'}</>}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
