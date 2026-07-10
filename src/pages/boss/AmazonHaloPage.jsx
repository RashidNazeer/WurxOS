import { useEffect, useRef, useState } from 'react';
import { parseHaloSheet } from '../../lib/haloParse';
import { fillDummyColumns } from '../../lib/haloDummy';
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
          <p style={{ color: 'var(--text-muted)', fontSize: 13, margin: '4px 0 0', maxWidth: 720 }}>
            Upload a daily performance sheet and explore how TikTok activity drives Amazon demand.
            Correlate any two metrics, browse the full correlation heatmap, and shift the{' '}
            <strong>halo lag</strong> to see the delayed spillover (TikTok today → Amazon a few days later).
          </p>
        </div>
        <button type="button" className="wx-btn wx-btn-ghost wx-btn-sm" onClick={() => setShareOpen(true)}>
          <LinkIcon width="14" height="14" /> Share
        </button>
      </div>

      {error && (
        <div className="wx-alert wx-alert-danger"><span>{error}</span></div>
      )}

      <UploadPanel dummyDefault onUploaded={(id) => { setSelectedId(id); refreshDatasets(); }} />

      {loading ? (
        <div style={{ color: 'var(--text-muted)', fontSize: 13 }}>
          <span className="wx-spinner" /> Loading datasets…
        </div>
      ) : !datasets.length ? (
        <div className="wx-card" style={{ padding: 28, textAlign: 'center', color: 'var(--text-muted)' }}>
          No dataset yet. Upload a sheet above to get started.
        </div>
      ) : (
        <HaloExplorer
          datasets={datasets}
          loadRows={getHaloRows}
          onDelete={handleDelete}
          initialDatasetId={selectedId}
        />
      )}

      {shareOpen && <HaloShareModal onClose={() => setShareOpen(false)} />}
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

          {parsed.missingColumns?.length > 0 && (
            <div style={{
              border: `1px solid ${parsed.missingAnchors?.length ? 'var(--danger, #ef4444)' : 'var(--warning, #f59e0b)'}`,
              background: parsed.missingAnchors?.length ? 'rgba(239,68,68,.10)' : 'rgba(245,158,11,.10)',
              borderRadius: 'var(--radius-md)', padding: '12px 14px', fontSize: 13,
              display: 'flex', flexDirection: 'column', gap: 6,
            }}>
              <strong style={{ color: parsed.missingAnchors?.length ? 'var(--danger, #ef4444)' : 'var(--warning, #f59e0b)' }}>
                ⚠ {parsed.missingAnchors?.length ? 'Required columns not recognised' : 'Some standard columns not recognised'}
              </strong>
              <span style={{ color: 'var(--text-muted)' }}>
                These expected columns weren't found — did you rename or remove them? Renamed columns won't be read.
              </span>
              <span>
                Not found: <strong>{parsed.missingColumns.map((m) => m.label).join(', ')}</strong>
              </span>
              {parsed.missingAnchors?.length > 0 && (
                <span style={{ color: 'var(--danger, #ef4444)' }}>
                  <strong>NTB</strong>, <strong>Revenue/Day</strong> and <strong>Product clicks</strong> are the anchors that locate your
                  keyword columns — if one is renamed, your <em>keyword</em> columns will be skipped. Rename it back to the exact
                  name and re-upload.
                </span>
              )}
            </div>
          )}
          {(parsed.keywordColumns?.volume?.length || parsed.keywordColumns?.rank?.length) ? (
            <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
              Keyword columns —{' '}
              <strong style={{ color: 'var(--text-primary)' }}>volume:</strong>{' '}
              {parsed.keywordColumns.volume.length ? parsed.keywordColumns.volume.join(', ') : '—'}
              {'  ·  '}
              <strong style={{ color: 'var(--text-primary)' }}>rank:</strong>{' '}
              {parsed.keywordColumns.rank.length ? parsed.keywordColumns.rank.join(', ') : '—'}
            </div>
          ) : (
            <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
              No named keyword columns found (blank/placeholder headers) — test data will seed keywords if enabled.
            </div>
          )}
          <label style={{ fontSize: 12, color: 'var(--text-muted)' }}>
            Dataset name
            <input className="wx-input" style={{ marginTop: 4 }} value={name} onChange={(e) => setName(e.target.value)} />
          </label>
          <label style={{ display: 'flex', gap: 8, alignItems: 'flex-start', fontSize: 12.5 }}>
            <input type="checkbox" checked={fillDummy} onChange={(e) => setFillDummy(e.target.checked)} style={{ marginTop: 2 }} />
            <span>
              Fill empty Amazon columns (Keyword Search Volume, Keyword Search Rank, Revenue/Day) with <strong>meaningful test data</strong> so
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
