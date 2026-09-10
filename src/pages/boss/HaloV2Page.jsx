// ============================================================
// Amazon Halo V2 — page shell.
//
// A SEPARATE surface from /halo. V1 stays exactly as it is: this page reuses
// the same brand list and the same uploaded sheets read-only, and adds no
// upload or delete controls of its own — sheet management stays where it
// already lives, on the V1 page.
//
// It DOES have its own client share links (mig 330): separate tokens, a
// separate table and a separate /portal/halo-v2/:token route, so a V1 link
// never renders V2 and revoking one does not touch the other.
// ============================================================

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { getHaloRows } from '../../lib/haloApi';
import { listHaloEnabledBrands } from '../../lib/haloBrandsApi';
import HaloV2Explorer from '../../components/haloV2/HaloV2Explorer';
import HaloV2ShareModal from '../../components/haloV2/HaloV2ShareModal';

export default function HaloV2Page() {
  const [brands, setBrands] = useState([]);
  const [selectedBrandId, setSelectedBrandId] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [shareOpen, setShareOpen] = useState(false);

  useEffect(() => {
    let alive = true;
    listHaloEnabledBrands()
      .then((list) => {
        if (!alive) return;
        setBrands(list);
        setSelectedBrandId((cur) => (cur && list.find((x) => x.brand.id === cur) ? cur : (list[0]?.brand?.id || null)));
      })
      .catch((e) => alive && setError(e.message || String(e)))
      .finally(() => alive && setLoading(false));
    return () => { alive = false; };
  }, []);

  const selected = brands.find((x) => x.brand.id === selectedBrandId) || null;
  const brandDatasets = useMemo(() => (selected ? Object.values(selected.datasets) : []), [selected]);
  const loadRows = useCallback((id) => getHaloRows(id), []);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14, paddingBottom: 40 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12, flexWrap: 'wrap' }}>
        <div>
          {/* The version belongs IN the title. It used to be an "Amazon Halo"
              H1 with a separate MODEL V2 pill, so the page read as the original
              tool at a glance and the share modal said "Share Amazon Halo" —
              a client could not tell which model they were looking at, and the
              two say materially different things. */}
          <h1 className="page-title" style={{ margin: 0 }}>Amazon Halo V2</h1>
          <p className="page-subtitle" style={{ margin: '4px 0 0' }}>
            Here&apos;s how TikTok Shop activity moved with Amazon outcomes in this period — and how sure we are.
            {' '}<Link to="/halo" style={{ color: 'var(--accent)' }}>The original Halo tool</Link> is unchanged.
          </p>
        </div>
        {!loading && brands.length > 0 && (
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <span style={{ fontSize: 11, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '.05em', fontWeight: 600 }}>Brand</span>
            <select className="wx-input" style={{ maxWidth: 300, minWidth: 170 }} value={selectedBrandId || ''} onChange={(e) => setSelectedBrandId(e.target.value)}>
              {brands.map((x) => (
                <option key={x.brand.id} value={x.brand.id}>{x.brand.brand_name}</option>
              ))}
            </select>
            {/* V2's own links. Separate tokens from V1's, so handing a client
                the V2 view never disturbs a V1 link they already have. */}
            <button type="button" className="wx-btn wx-btn-ghost"
              onClick={() => setShareOpen(true)}>
              <i className="bi bi-link-45deg" style={{ marginRight: 6 }} />Client links
            </button>
          </div>
        )}
      </div>

      {shareOpen && (
        <HaloV2ShareModal
          brands={brands.map((x) => x.brand)}
          onClose={() => setShareOpen(false)} />
      )}

      {error && <div className="wx-alert wx-alert-danger"><span>{error}</span></div>}

      {loading ? (
        <div style={{ color: 'var(--text-muted)', fontSize: 13 }}><span className="wx-spinner" /> Loading…</div>
      ) : !brands.length ? (
        <div className="wx-card" style={{ padding: 28, textAlign: 'center', color: 'var(--text-muted)' }}>
          No brands are enabled for Halo yet. Enable them in{' '}
          <Link to="/settings?section=amazonHalo" style={{ color: 'var(--accent)' }}>Settings → Amazon Halo</Link>.
        </div>
      ) : brandDatasets.length ? (
        <HaloV2Explorer key={selectedBrandId} datasets={brandDatasets} loadRows={loadRows} />
      ) : (
        <div className="wx-card" style={{ padding: 28, textAlign: 'center', color: 'var(--text-muted)' }}>
          No sheets for <strong>{selected?.brand?.brand_name}</strong> yet — upload one on the{' '}
          <Link to="/halo" style={{ color: 'var(--accent)' }}>Amazon Halo</Link> page.
        </div>
      )}
    </div>
  );
}
