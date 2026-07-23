import { useEffect, useRef, useState } from 'react';
import { parseHaloSheet } from '../../lib/haloParse';
import {
  listHaloDatasets, getHaloRows, createHaloDataset, deleteHaloDataset,
} from '../../lib/haloApi';
import HaloExplorer from '../../components/halo/HaloExplorer';
import HaloShareModal from '../../components/halo/HaloShareModal';
import { LinkIcon } from '../../components/common/Icon';

export default function AmazonHaloPage() {
  const [datasets, setDatasets] = useState([]);
  const [selectedId, setSelectedId] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [shareOpen, setShareOpen] = useState(false);

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

  async function handleDelete(id) {
    if (!window.confirm('Delete this dataset and all its rows?')) return;
    await deleteHaloDataset(id);
    if (id === selectedId) setSelectedId(null);
    refreshDatasets(true);
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14, paddingBottom: 40 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12, flexWrap: 'wrap' }}>
        <div>
          <h1 className="page-title">Amazon Halo Effect</h1>
          <p style={{ color: 'var(--text-muted)', fontSize: 13, margin: '4px 0 0', maxWidth: 760 }}>
            Upload the whole performance workbook (both tabs) and explore how TikTok activity drives Amazon demand.
            The <strong>daily</strong> views correlate TikTok against Amazon revenue with a day-lag; the{' '}
            <strong>Search demand (weekly)</strong> view correlates TikTok against branded search volume week over week.
          </p>
        </div>
        <button type="button" className="wx-btn wx-btn-ghost wx-btn-sm" onClick={() => setShareOpen(true)}>
          <LinkIcon width="14" height="14" /> Share
        </button>
      </div>

      {error && <div className="wx-alert wx-alert-danger"><span>{error}</span></div>}

      <UploadPanel onUploaded={(id) => { setSelectedId(id); refreshDatasets(); }} />

      {loading ? (
        <div style={{ color: 'var(--text-muted)', fontSize: 13 }}><span className="wx-spinner" /> Loading datasets…</div>
      ) : !datasets.length ? (
        <div className="wx-card" style={{ padding: 28, textAlign: 'center', color: 'var(--text-muted)' }}>
          No dataset yet. Upload a workbook above to get started.
        </div>
      ) : (
        <HaloExplorer datasets={datasets} loadRows={getHaloRows} onDelete={handleDelete} initialDatasetId={selectedId} />
      )}

      {shareOpen && <HaloShareModal onClose={() => setShareOpen(false)} />}
    </div>
  );
}

// ============================================================
// Upload — reads the daily tab + the weekly "Branded Demand" tab in one file.
// ============================================================
function UploadPanel({ onUploaded }) {
  const [open, setOpen] = useState(false);
  const [file, setFile] = useState(null);
  const [name, setName] = useState('');
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
      const ds = await createHaloDataset({
        name, filename: file?.name,
        periodStart: parsed.periodStart, periodEnd: parsed.periodEnd,
        currency: parsed.currency, weeklyKeywords: parsed.weeklyKeywords,
        metricGran: parsed.metricGran, weeklyMetrics: parsed.weeklyMetrics,
        monthlyMetrics: parsed.monthlyMetrics,
        rows: parsed.rows,
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
          ⬆ Upload workbook
        </button>
      </div>
    );
  }

  return (
    <div className="wx-card" style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <strong>Upload performance workbook</strong>
        <button type="button" className="wx-btn wx-btn-ghost wx-btn-sm" onClick={() => setOpen(false)}>Close</button>
      </div>

      <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
        Download the whole Google Sheet as <strong>.xlsx</strong> (File → Download → Microsoft Excel) so both the daily tab and
        the weekly <strong>“Branded Demand”</strong> tab come in one file. A single daily .csv also works, but the weekly search
        view will be empty.
      </div>

      <input ref={inputRef} type="file" accept=".xlsx,.xls,.csv" className="wx-input"
        onChange={(e) => onFile(e.target.files?.[0] || null)} />

      {parseErr && <div className="wx-alert wx-alert-danger"><span>{parseErr}</span></div>}

      {parsed && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div style={{ fontSize: 13, color: 'var(--text-muted)' }}>
            Parsed <strong style={{ color: 'var(--text-primary)' }}>{parsed.rows.length}</strong> days
            ({parsed.periodStart} → {parsed.periodEnd}) · {parsed.foundKeys.length} columns recognised · currency <strong style={{ color: 'var(--text-primary)' }}>{parsed.currency}</strong>.
          </div>

          {parsed.missingColumns?.length > 0 && (
            <div style={{
              border: `1px solid ${parsed.missingAnchors?.length ? 'var(--danger, #ef4444)' : 'var(--warning, #f59e0b)'}`,
              background: parsed.missingAnchors?.length ? 'rgba(239,68,68,.10)' : 'rgba(245,158,11,.10)',
              borderRadius: 'var(--radius-md)', padding: '12px 14px', fontSize: 13, display: 'flex', flexDirection: 'column', gap: 6,
            }}>
              <strong style={{ color: parsed.missingAnchors?.length ? 'var(--danger, #ef4444)' : 'var(--warning, #f59e0b)' }}>
                ⚠ {parsed.missingAnchors?.length ? 'Required column not recognised' : 'Some standard columns not recognised'}
              </strong>
              <span style={{ color: 'var(--text-muted)' }}>These expected columns weren't found — did you rename or remove them?</span>
              <span>Not found: <strong>{parsed.missingColumns.map((m) => m.label).join(', ')}</strong></span>
              {parsed.missingAnchors?.length > 0 && (
                <span style={{ color: 'var(--danger, #ef4444)' }}>
                  <strong>Total Revenue/Day</strong> anchors the per-product Amazon revenue columns — without it, revenue and
                  the product breakdown are dropped. Rename it back and re-upload.
                </span>
              )}
            </div>
          )}

          <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
            Products (Amazon revenue): <strong style={{ color: 'var(--text-primary)' }}>{parsed.products?.length ? parsed.products.join(', ') : '—'}</strong>
          </div>

          {parsed.volumeKeywords?.length > 0 && (
            <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
              Daily branded search keywords: <strong style={{ color: 'var(--text-primary)' }}>{parsed.volumeKeywords.join(', ')}</strong>
            </div>
          )}
          {parsed.rankKeywords?.length > 0 && (
            <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
              Keyword search rank: <strong style={{ color: 'var(--text-primary)' }}>{parsed.rankKeywords.join(', ')}</strong>
            </div>
          )}

          {parsed.weeklyKeywords?.length ? (
            <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
              Weekly branded search: <strong style={{ color: 'var(--text-primary)' }}>{parsed.weeklyKeywords.length} weeks</strong> ·
              keywords: <strong style={{ color: 'var(--text-primary)' }}>{parsed.keywords?.join(', ') || '—'}</strong>
            </div>
          ) : !parsed.volumeKeywords?.length ? (
            <div style={{ fontSize: 12, color: 'var(--warning)' }}>
              ⚠ No branded search data found (no daily keyword columns and no weekly “Branded Demand” tab). The Branded Search Volume metric will be unavailable. Upload the full .xlsx, not just the daily sheet.
            </div>
          ) : null}

          {parsed.metricGran && Object.keys(parsed.metricGran).length > 0 && (() => {
            const coarse = Object.entries(parsed.metricGran).filter(([, g]) => g !== 'day');
            if (!coarse.length) return null;
            return (
              <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                Weekly/monthly metrics: <strong style={{ color: 'var(--text-primary)' }}>{coarse.map(([k, g]) => `${k} (${g})`).join(', ')}</strong>
              </div>
            );
          })()}

          <label style={{ fontSize: 12, color: 'var(--text-muted)' }}>
            Dataset name
            <input className="wx-input" style={{ marginTop: 4 }} value={name} onChange={(e) => setName(e.target.value)} />
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
