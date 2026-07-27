import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Link } from 'react-router-dom';
import { parseHaloGranularitySheet } from '../../lib/haloParse';
import { getHaloRows, createHaloDataset, deleteHaloDataset } from '../../lib/haloApi';
import { listHaloEnabledBrands } from '../../lib/haloBrandsApi';
import HaloExplorer from '../../components/halo/HaloExplorer';
import HaloShareModal from '../../components/halo/HaloShareModal';
import { LinkIcon } from '../../components/common/Icon';

const GRANS = [
  { key: 'day', label: 'Daily sheet', hint: 'one row per day' },
  { key: 'week', label: 'Weekly sheet', hint: 'one row per week (e.g. "1 June - 7 June")' },
  { key: 'month', label: 'Monthly sheet', hint: 'one row per month (e.g. "June 2026")' },
];

export default function AmazonHaloPage() {
  const [brands, setBrands] = useState([]); // [{ brand, datasets:{day?,week?,month?} }]
  const [selectedBrandId, setSelectedBrandId] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [shareOpen, setShareOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);

  const refresh = useCallback(async () => {
    setError('');
    try {
      const list = await listHaloEnabledBrands();
      setBrands(list);
      setSelectedBrandId((cur) => (cur && list.find((x) => x.brand.id === cur) ? cur : (list[0]?.brand?.id || null)));
    } catch (e) { setError(e.message || String(e)); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { refresh(); }, [refresh]);

  const selected = brands.find((x) => x.brand.id === selectedBrandId) || null;
  const brandDatasets = useMemo(() => (selected ? Object.values(selected.datasets) : []), [selected]);
  const loadRows = useCallback((id) => getHaloRows(id), []);

  async function handleDelete(id, granLabel) {
    if (!window.confirm(`Delete the ${granLabel} for this brand?`)) return;
    try { await deleteHaloDataset(id); await refresh(); }
    catch (e) { setError(e.message || String(e)); }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14, paddingBottom: 40 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap' }}>
          <h1 className="page-title" style={{ margin: 0 }}>Amazon Halo Effect</h1>
          {!loading && brands.length > 0 && (
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <span style={{ fontSize: 11, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '.05em', fontWeight: 600 }}>Brand</span>
              <select className="wx-input" style={{ maxWidth: 300, minWidth: 170 }} value={selectedBrandId || ''} onChange={(e) => setSelectedBrandId(e.target.value)}>
                {brands.map((x) => (
                  <option key={x.brand.id} value={x.brand.id}>
                    {x.brand.brand_name}{['day', 'week', 'month'].filter((g) => x.datasets[g]).length ? '' : ' — no sheets yet'}
                  </option>
                ))}
              </select>
            </div>
          )}
        </div>
        {!loading && brands.length > 0 && (
          <button type="button" className="wx-btn wx-btn-ghost wx-btn-sm" onClick={() => setSettingsOpen(true)} title="Upload sheets and manage client links">
            <i className="bi bi-gear" /> Manage
          </button>
        )}
      </div>

      {error && <div className="wx-alert wx-alert-danger"><span>{error}</span></div>}

      {loading ? (
        <div style={{ color: 'var(--text-muted)', fontSize: 13 }}><span className="wx-spinner" /> Loading…</div>
      ) : !brands.length ? (
        <div className="wx-card" style={{ padding: 28, textAlign: 'center', color: 'var(--text-muted)' }}>
          No brands are enabled for Halo yet. Enable them in{' '}
          <Link to="/settings?section=amazonHalo" style={{ color: 'var(--accent)' }}>Settings → Amazon Halo</Link>.
        </div>
      ) : brandDatasets.length ? (
        <HaloExplorer key={selectedBrandId} datasets={brandDatasets} loadRows={loadRows} />
      ) : (
        <div className="wx-card" style={{ padding: 28, textAlign: 'center', color: 'var(--text-muted)' }}>
          No sheets for <strong>{selected?.brand?.brand_name}</strong> yet. Click <strong>Manage</strong> (top right) to upload a daily, weekly or monthly sheet.
        </div>
      )}

      {settingsOpen && selected && (
        <HaloSettingsDrawer
          selected={selected}
          onClose={() => setSettingsOpen(false)}
          onRefresh={refresh}
          onDelete={handleDelete}
          onOpenShare={() => setShareOpen(true)}
        />
      )}
      {shareOpen && <HaloShareModal brands={brands.map((x) => x.brand)} onClose={() => setShareOpen(false)} />}
    </div>
  );
}

// ============================================================
// Right-side drawer: per-brand sheet uploads + client-link management.
// Keeps the main page to just the brand switcher + the explorer (gear opens this).
// ============================================================
function HaloSettingsDrawer({ selected, onClose, onRefresh, onDelete, onOpenShare }) {
  const brand = selected.brand;
  return createPortal(
    <div style={{ position: 'fixed', inset: 0, zIndex: 995 }}>
      <div onClick={onClose} style={{ position: 'absolute', inset: 0, background: 'rgba(0,0,0,0.5)', backdropFilter: 'blur(2px)' }} />
      <div style={{ position: 'absolute', top: 0, right: 0, height: '100%', width: 'min(460px, 94vw)', background: 'var(--surface-1, #16161c)', borderLeft: '1px solid var(--border-default)', boxShadow: '-10px 0 40px rgba(0,0,0,0.28)', display: 'flex', flexDirection: 'column' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '14px 16px', borderBottom: '1px solid var(--border-subtle)', flex: '0 0 auto' }}>
          <div>
            <div style={{ fontWeight: 700, fontSize: 14 }}>Manage Halo</div>
            <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>{brand.brand_name}</div>
          </div>
          <button type="button" className="wx-btn wx-btn-ghost wx-btn-sm" onClick={onClose} aria-label="Close">✕</button>
        </div>

        <div style={{ overflowY: 'auto', padding: 16, display: 'flex', flexDirection: 'column', gap: 16 }}>
          <div style={{ fontSize: 12, color: 'var(--text-muted)', lineHeight: 1.5 }}>
            Upload up to three sheets — a <strong>daily</strong>, a <strong>weekly</strong> and a <strong>monthly</strong> one (at least one).
            Each granularity reads its own sheet, falling back to rolling up the daily sheet when a weekly/monthly one isn't uploaded.
            Enable brands in <Link to="/settings?section=amazonHalo" style={{ color: 'var(--accent)' }} onClick={onClose}>Settings → Amazon Halo</Link>.
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            {GRANS.map((g) => (
              <UploadSlot
                key={g.key}
                granularity={g.key}
                meta={g}
                brand={brand}
                dataset={selected.datasets[g.key] || null}
                onDone={onRefresh}
                onDelete={() => selected.datasets[g.key] && onDelete(selected.datasets[g.key].id, g.label.toLowerCase())}
              />
            ))}
          </div>

          <div style={{ borderTop: '1px solid var(--border-subtle)', paddingTop: 14 }}>
            <div style={{ fontWeight: 700, fontSize: 13, marginBottom: 4 }}>Client links</div>
            <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 10 }}>
              Create read-only links to share a brand's Halo with clients — no login needed.
            </div>
            <button type="button" className="wx-btn wx-btn-ghost wx-btn-sm" onClick={onOpenShare}>
              <LinkIcon width="14" height="14" /> Manage client links
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}

// ============================================================
// One upload slot for a brand's daily / weekly / monthly sheet.
// ============================================================
function UploadSlot({ granularity, meta, brand, dataset, onDone, onDelete }) {
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
        name: `${brand.brand_name} — ${granularity} (${parsed.periodStart} → ${parsed.periodEnd})`,
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
    <div style={{ border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius-md, 8px)', padding: 12, display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 8 }}>
        <strong style={{ fontSize: 12.5 }}>{meta.label}</strong>
        {dataset ? (
          <span style={{ fontSize: 10.5, color: '#22c55e', fontWeight: 700 }}>✓ uploaded</span>
        ) : (
          <span style={{ fontSize: 10.5, color: 'var(--text-muted)' }}>none yet</span>
        )}
      </div>
      <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>{meta.hint}</div>

      {dataset && (
        <div style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>
          <strong style={{ color: 'var(--text-primary)' }}>{dataset.row_count}</strong> {rowsWord} · {dataset.period_start} → {dataset.period_end}
          {' · '}<button type="button" onClick={onDelete} style={{ background: 'none', border: 'none', color: 'var(--danger, #ef4444)', cursor: 'pointer', padding: 0, fontSize: 11.5 }}>Delete</button>
        </div>
      )}

      <input ref={inputRef} type="file" accept=".xlsx,.xls,.csv" className="wx-input" style={{ fontSize: 11.5 }}
        onChange={(e) => onFile(e.target.files?.[0] || null)} />

      {parseErr && <div style={{ fontSize: 11.5, color: 'var(--danger, #ef4444)' }}>{parseErr}</div>}

      {parsed && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, fontSize: 11.5, color: 'var(--text-muted)' }}>
          <div>
            Parsed <strong style={{ color: 'var(--text-primary)' }}>{parsed.rows.length}</strong> {rowsWord}
            {' '}({parsed.periodStart} → {parsed.periodEnd}) · {parsed.foundKeys.length} columns · {parsed.currency}
          </div>
          {parsed.products?.length > 0 && <div>Products: <strong style={{ color: 'var(--text-primary)' }}>{parsed.products.join(', ')}</strong></div>}
          {parsed.volumeKeywords?.length > 0 && <div>Search keywords: <strong style={{ color: 'var(--text-primary)' }}>{parsed.volumeKeywords.join(', ')}</strong></div>}
          {parsed.warnings?.length > 0 && <div style={{ color: 'var(--warning, #f59e0b)' }}>⚠ {parsed.warnings.join(' ')}</div>}
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
    </div>
  );
}
