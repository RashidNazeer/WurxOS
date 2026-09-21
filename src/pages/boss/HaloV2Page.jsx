// ============================================================
// Amazon Halo: page shell.
//
// THE ONLY AMAZON HALO (2026-09-21). This began as "Amazon Halo V2", a separate
// surface beside the original Halo tool, reading that tool's uploaded sheets
// read-only and adding no upload controls of its own. The original tool has
// now been retired, so this page lives at /halo, /halo-v2 redirects here, and
// sheet upload moved in (HaloSheetsDrawer), because it had nowhere else left
// to live.
//
// The file and folder keep their V2 names on purpose. They are code, not
// something a person reads, and renaming haloV2/ would collide with every
// change in flight there.
//
// Client links (mig 330) are managed here and in Settings. Links minted by the
// original tool still open, and now open this view: see AmazonHaloPortal.
// ============================================================

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { getHaloRows, deleteHaloDataset } from '../../lib/haloApi';
import { listHaloEnabledBrands } from '../../lib/haloBrandsApi';
import HaloV2Explorer from '../../components/haloV2/HaloV2Explorer';
import HaloV2ShareModal from '../../components/haloV2/HaloV2ShareModal';
import HaloSheetsDrawer from '../../components/haloV2/HaloSheetsDrawer';

export default function HaloV2Page() {
  const [brands, setBrands] = useState([]);
  const [selectedBrandId, setSelectedBrandId] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [shareOpen, setShareOpen] = useState(false);
  const [sheetsOpen, setSheetsOpen] = useState(false);

  // A CALLBACK, not a one-shot effect. The brand list carries each brand's
  // uploaded sheets, so after an upload, replace or delete it has to be read
  // again or the page keeps showing what was there before. When this page
  // could not upload, loading once was enough.
  const refresh = useCallback(async () => {
    setError('');
    try {
      const list = await listHaloEnabledBrands();
      setBrands(list);
      setSelectedBrandId((cur) => (cur && list.find((x) => x.brand.id === cur) ? cur : (list[0]?.brand?.id || null)));
    } catch (e) {
      setError(e.message || String(e));
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => { refresh(); }, [refresh]);

  const selected = brands.find((x) => x.brand.id === selectedBrandId) || null;
  const brandDatasets = useMemo(() => (selected ? Object.values(selected.datasets) : []), [selected]);
  const loadRows = useCallback((id) => getHaloRows(id), []);

  async function handleDelete(id, granLabel) {
    if (!window.confirm(`Delete the ${granLabel} for this brand?`)) return;
    try {
      await deleteHaloDataset(id);
      await refresh();
    } catch (e) {
      setError(e.message || String(e));
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14, paddingBottom: 40 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12, flexWrap: 'wrap' }}>
        <div>
          <h1 className="page-title" style={{ margin: 0 }}>Amazon Halo</h1>
          <p className="page-subtitle" style={{ margin: '4px 0 0' }}>
            How TikTok Shop activity moved with Amazon outcomes in this period, and how sure we are.
          </p>
        </div>
        {/* The brand dropdown is the ONLY place the brand is named. It used to
            be a "BRAND" label plus the dropdown plus the brand again in the
            explorer's top bar and again in the snapshot. */}
        {!loading && brands.length > 0 && (
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <select className="wx-input" style={{ maxWidth: 300, minWidth: 170 }} value={selectedBrandId || ''} onChange={(e) => setSelectedBrandId(e.target.value)}>
              {brands.map((x) => (
                <option key={x.brand.id} value={x.brand.id}>{x.brand.brand_name}</option>
              ))}
            </select>
            {/* Always reachable, sheets or not: it is how the first sheet gets
                in, and how a stale one gets replaced. */}
            <button type="button" className="wx-btn wx-btn-ghost" onClick={() => setSheetsOpen(true)}
              title="Upload, replace or delete this brand's sheets">
              <i className="bi bi-upload" style={{ marginRight: 6 }} />Manage sheets
            </button>
            {/* Client links normally live inside the explorer's Share menu.
                With no sheets there is no explorer, so keep one way in. */}
            {!brandDatasets.length && (
              <button type="button" className="wx-btn wx-btn-ghost" onClick={() => setShareOpen(true)}>
                <i className="bi bi-link-45deg" style={{ marginRight: 6 }} />Client links
              </button>
            )}
          </div>
        )}
      </div>

      {shareOpen && (
        <HaloV2ShareModal
          brands={brands.map((x) => x.brand)}
          onClose={() => setShareOpen(false)} />
      )}

      {sheetsOpen && selected && (
        <HaloSheetsDrawer
          selected={selected}
          onClose={() => setSheetsOpen(false)}
          onRefresh={refresh}
          onDelete={handleDelete}
        />
      )}

      {error && <div className="wx-alert wx-alert-danger"><span>{error}</span></div>}

      {loading ? (
        <div style={{ color: 'var(--text-muted)', fontSize: 13 }}><span className="wx-spinner" /> Loading…</div>
      ) : !brands.length ? (
        <div className="wx-card" style={{ padding: 28, textAlign: 'center', color: 'var(--text-muted)' }}>
          No brands are enabled for Halo yet. Enable them in{' '}
          <Link to="/settings?section=amazonHalo" style={{ color: 'var(--accent)' }}>Settings, Amazon Halo</Link>.
        </div>
      ) : brandDatasets.length ? (
        <HaloV2Explorer
          key={selectedBrandId}
          datasets={brandDatasets}
          loadRows={loadRows}
          brandName={selected?.brand?.brand_name || null}
          // Internal users move between both views all day, so this page
          // remembers the last one. A client link always opens in Meeting.
          rememberMode
          // Sharing sits in the explorer's Share menu beside the exports,
          // rather than as a separate button in the page header.
          onManageLinks={() => setShareOpen(true)}
        />
      ) : (
        <div className="wx-card" style={{ padding: 28, textAlign: 'center', color: 'var(--text-muted)' }}>
          No sheets for <strong>{selected?.brand?.brand_name}</strong> yet.{' '}
          <button type="button" onClick={() => setSheetsOpen(true)}
            style={{ background: 'none', border: 'none', padding: 0, color: 'var(--accent)', cursor: 'pointer', font: 'inherit' }}>
            Upload a daily, weekly or monthly sheet
          </button>
          {' '}to begin.
        </div>
      )}
    </div>
  );
}
