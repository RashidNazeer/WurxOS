// ============================================================
// Amazon Halo: upload and replace a brand's sheets.
//
// MOVED HERE FROM THE ORIGINAL HALO PAGE when that page was retired and this
// became the only Amazon Halo (2026-09-21). Until then this page had no upload
// of its own; its empty state sent people to the old page to add a sheet. So
// retiring the old page without moving this would have left nowhere to upload
// a sheet at all.
//
// The logic is unchanged: the same parser (parseHaloGranularitySheet), the same
// weekly build from a search-volume roll-up, the same REPLACE-by-granularity RPC
// (createHaloDataset). Only the words changed, to drop em dashes, and client
// links were left out: they already live in the explorer's Share menu and in
// Settings, and a third way in is a third place for them to disagree.
// ============================================================

import { useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Link } from 'react-router-dom';
import { parseHaloGranularitySheet } from '../../lib/haloParse';
import { parseSearchVolumeSheet, buildWeeklyFromDaily } from '../../lib/haloWeeklyBuild';
import { getHaloRows, createHaloDataset } from '../../lib/haloApi';

const GRANS = [
  { key: 'day', label: 'Daily sheet', hint: 'One row per day.' },
  { key: 'week', label: 'Weekly sheet', hint: 'One row per week, for example "1 June - 7 June".' },
  { key: 'month', label: 'Monthly sheet', hint: 'One row per month, for example "June 2026".' },
];

/**
 * Right-side drawer holding a brand's three sheet slots.
 *
 * `selected` is one entry of listHaloEnabledBrands(): { brand, datasets:{day?,week?,month?} }.
 */
export default function HaloSheetsDrawer({ selected, onClose, onRefresh, onDelete }) {
  const brand = selected.brand;
  return createPortal(
    // z-index 995 keeps the share modal (backdrop 1000) able to stack on top.
    <div style={{ position: 'fixed', inset: 0, zIndex: 995 }}>
      <div onClick={onClose} style={{ position: 'absolute', inset: 0, background: 'var(--backdrop)', backdropFilter: 'blur(2px)' }} />
      <div
        role="dialog"
        aria-label={`Sheets for ${brand.brand_name}`}
        style={{ position: 'absolute', top: 0, right: 0, height: '100%', width: 'min(460px, 94vw)', background: 'var(--surface-1, #16161c)', borderLeft: '1px solid var(--border-default)', boxShadow: 'var(--shadow-xl)', display: 'flex', flexDirection: 'column' }}
      >
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '14px 16px', borderBottom: '1px solid var(--border-subtle)', flex: '0 0 auto' }}>
          <div>
            <div style={{ fontWeight: 700, fontSize: 14 }}>Manage sheets</div>
            <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>{brand.brand_name}</div>
          </div>
          <button type="button" className="wx-btn wx-btn-ghost wx-btn-sm" onClick={onClose} aria-label="Close">✕</button>
        </div>

        <div style={{ overflowY: 'auto', padding: 16, display: 'flex', flexDirection: 'column', gap: 16 }}>
          <div style={{ fontSize: 12, color: 'var(--text-muted)', lineHeight: 1.5 }}>
            Upload up to three sheets: a <strong>daily</strong>, a <strong>weekly</strong> and a <strong>monthly</strong> one.
            At least one is needed. Each view reads its own sheet, and falls back to rolling up the daily sheet when a
            weekly or monthly one is missing. Choose which brands appear here in{' '}
            <Link to="/settings?section=amazonHalo" style={{ color: 'var(--accent)' }} onClick={onClose}>Settings, Amazon Halo</Link>.
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            {GRANS.map((g) => (
              <UploadSlot
                key={g.key}
                granularity={g.key}
                meta={g}
                brand={brand}
                dataset={selected.datasets[g.key] || null}
                dailyDataset={selected.datasets.day || null}
                onDone={onRefresh}
                onDelete={() => selected.datasets[g.key] && onDelete(selected.datasets[g.key].id, g.label.toLowerCase())}
              />
            ))}
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}

// ============================================================
// One upload slot for a brand's daily, weekly or monthly sheet.
// ============================================================
function UploadSlot({ granularity, meta, brand, dataset, dailyDataset, onDone, onDelete }) {
  const [file, setFile] = useState(null);
  const [parsed, setParsed] = useState(null);
  const [parseErr, setParseErr] = useState('');
  const [saving, setSaving] = useState(false);
  const inputRef = useRef(null);

  async function onFile(f) {
    setFile(f); setParsed(null); setParseErr('');
    if (!f) return;
    try {
      const ab = await f.arrayBuffer();
      const p = await parseHaloGranularitySheet(ab, granularity);
      setParsed(p);
    } catch (e) { setParseErr(e.message || String(e)); }
  }

  function reset() {
    setFile(null); setParsed(null); setParseErr('');
    if (inputRef.current) inputRef.current.value = '';
  }

  async function save() {
    if (!parsed) return;
    setSaving(true); setParseErr('');
    try {
      await createHaloDataset({
        brandId: brand.id,
        granularity,
        name: `${brand.brand_name} · ${granularity} (${parsed.periodStart} → ${parsed.periodEnd})`,
        filename: file?.name,
        periodStart: parsed.periodStart,
        periodEnd: parsed.periodEnd,
        currency: parsed.currency,
        rows: parsed.rows,
      });
      reset();
      onDone?.();
    } catch (e) { setParseErr(e.message || String(e)); }
    finally { setSaving(false); }
  }

  const rowsWord = granularity === 'day' ? 'days' : granularity === 'week' ? 'weeks' : 'months';

  return (
    <div style={{ border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius-md)', padding: 12, display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 8 }}>
        <strong style={{ fontSize: 12.5 }}>{meta.label}</strong>
        {dataset ? (
          <span style={{ fontSize: 10.5, color: 'var(--success-text)', fontWeight: 700 }}>✓ uploaded</span>
        ) : (
          <span style={{ fontSize: 10.5, color: 'var(--text-muted)' }}>none yet</span>
        )}
      </div>
      <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>{meta.hint}</div>

      {dataset && (
        <div style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>
          <strong style={{ color: 'var(--text-primary)' }}>{dataset.row_count}</strong> {rowsWord} · {dataset.period_start} → {dataset.period_end}
          {' · '}<button type="button" onClick={onDelete} style={{ background: 'none', border: 'none', color: 'var(--danger, var(--danger-text))', cursor: 'pointer', padding: 0, fontSize: 11.5 }}>Delete</button>
        </div>
      )}

      <input ref={inputRef} type="file" accept=".xlsx,.xls,.csv" className="wx-input" style={{ fontSize: 11.5 }}
        aria-label={`Upload ${meta.label.toLowerCase()}`}
        onChange={(e) => onFile(e.target.files?.[0] || null)} />

      {parseErr && <div style={{ fontSize: 11.5, color: 'var(--danger, var(--danger-text))' }}>{parseErr}</div>}

      {parsed && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, fontSize: 11.5, color: 'var(--text-muted)' }}>
          <div>
            Parsed <strong style={{ color: 'var(--text-primary)' }}>{parsed.rows.length}</strong> {rowsWord}
            {' '}({parsed.periodStart} → {parsed.periodEnd}) · {parsed.foundKeys.length} columns · {parsed.currency}
          </div>
          {parsed.products?.length > 0 && <div>Products: <strong style={{ color: 'var(--text-primary)' }}>{parsed.products.join(', ')}</strong></div>}
          {parsed.volumeKeywords?.length > 0 && <div>Search keywords: <strong style={{ color: 'var(--text-primary)' }}>{parsed.volumeKeywords.join(', ')}</strong></div>}
          {parsed.warnings?.length > 0 && <div style={{ color: 'var(--warning, var(--warning-text))' }}>⚠ {parsed.warnings.join(' ')}</div>}
          {parsed.missingColumns?.length > 0 && (
            <div style={{ color: parsed.missingAnchors?.length ? 'var(--danger, #ef4444)' : 'var(--warning, #f59e0b)' }}>
              ⚠ Not recognised: {parsed.missingColumns.map((m) => m.label).join(', ')}
            </div>
          )}
          <div style={{ display: 'flex', gap: 6 }}>
            <button type="button" className="wx-btn wx-btn-primary wx-btn-sm" disabled={saving} onClick={save}>
              {saving ? 'Saving…' : (dataset ? 'Replace' : 'Save')}
            </button>
            <button type="button" className="wx-btn wx-btn-ghost wx-btn-sm" disabled={saving} onClick={reset}>Cancel</button>
          </div>
        </div>
      )}

      {/* Weekly only: build the weekly sheet from the daily data plus a
          search-volume roll-up sheet, so search volume never has to be
          reformatted by hand. */}
      {granularity === 'week' && (
        <WeeklySearchBuilder brand={brand} dailyDataset={dailyDataset} hasWeekly={!!dataset} onDone={onDone} />
      )}
    </div>
  );
}

// ============================================================
// Build the weekly dataset from the brand's daily sheet plus a "Weekly Search
// Volume, Brand Roll-Ups" sheet. The user uploads ONLY the search-volume sheet;
// the daily data is rolled up to the same weeks and attached. No hand-merging,
// and the daily and weekly parser formats are untouched.
// ============================================================
function WeeklySearchBuilder({ brand, dailyDataset, hasWeekly, onDone }) {
  const [open, setOpen] = useState(false);
  const [file, setFile] = useState(null);
  const [sv, setSv] = useState(null);          // { columns, weeks }
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');
  const inputRef = useRef(null);

  function reset() {
    setFile(null); setSv(null); setErr(''); setNote('');
    if (inputRef.current) inputRef.current.value = '';
  }

  async function onFile(f) {
    setFile(f); setSv(null); setErr(''); setNote('');
    if (!f) return;
    try {
      setSv(await parseSearchVolumeSheet(await f.arrayBuffer()));
    } catch (e) { setErr(e.message || String(e)); }
  }

  async function build() {
    if (!sv || !dailyDataset) return;
    setBusy(true); setErr(''); setNote('');
    try {
      const dailyRows = await getHaloRows(dailyDataset.id);
      const out = buildWeeklyFromDaily({ dailyRows, searchWeeks: sv.weeks, columns: sv.columns, tailWeeks: 3 });
      await createHaloDataset({
        brandId: brand.id,
        granularity: 'week',
        name: `${brand.brand_name} · week (built from daily + search volume)`,
        filename: file?.name,
        periodStart: out.periodStart,
        periodEnd: out.periodEnd,
        currency: dailyDataset.currency || '$',
        rows: out.rows,
      });
      setNote(`Built ${out.weeksBuilt} weeks (${out.strictCount} with daily data${out.tailCount ? ` + ${out.tailCount} trailing` : ''}).`);
      reset();
      onDone?.();
    } catch (e) { setErr(e.message || String(e)); }
    finally { setBusy(false); }
  }

  return (
    <div style={{ marginTop: 4, borderTop: '1px dashed var(--border-subtle)', paddingTop: 8 }}>
      <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open}
        style={{ background: 'none', border: 'none', color: 'var(--accent)', cursor: 'pointer', padding: 0, fontSize: 11.5, fontWeight: 600 }}>
        {open ? '▾' : '▸'} Or build from a search-volume sheet
      </button>

      {open && (
        <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 8, fontSize: 11.5, color: 'var(--text-muted)' }}>
          <div style={{ lineHeight: 1.5 }}>
            Upload the <strong>Weekly Search Volume roll-up</strong> sheet only. Every keyword column in it is summed into
            this brand's branded search volume, and the daily data is rolled up to the same Saturday-ending weeks. There is
            nothing to pick and nothing to group by hand.
          </div>

          {!dailyDataset ? (
            <div style={{ color: 'var(--warning, var(--warning-text))' }}>⚠ Upload the daily sheet first. The weekly build rolls it up for the metrics.</div>
          ) : (
            <>
              <input ref={inputRef} type="file" accept=".xlsx,.xls,.csv" className="wx-input" style={{ fontSize: 11.5 }}
                aria-label="Upload a weekly search volume roll-up sheet"
                onChange={(e) => onFile(e.target.files?.[0] || null)} />

              {err && <div style={{ color: 'var(--danger, var(--danger-text))' }}>{err}</div>}
              {note && <div style={{ color: 'var(--success-text)' }}>✓ {note}</div>}

              {sv && (
                <>
                  <div>
                    Summing <strong style={{ color: 'var(--text-primary)' }}>{sv.columns.length}</strong> keyword column{sv.columns.length !== 1 ? 's' : ''} into {brand.brand_name}'s branded search volume:{' '}
                    <span style={{ color: 'var(--text-primary)' }}>{sv.columns.join(', ')}</span>
                  </div>
                  <div style={{ display: 'flex', gap: 6 }}>
                    <button type="button" className="wx-btn wx-btn-primary wx-btn-sm" disabled={busy} onClick={build}>
                      {busy ? 'Building…' : (hasWeekly ? 'Rebuild weekly' : 'Build weekly')}
                    </button>
                    <button type="button" className="wx-btn wx-btn-ghost wx-btn-sm" disabled={busy} onClick={reset}>Cancel</button>
                  </div>
                </>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
