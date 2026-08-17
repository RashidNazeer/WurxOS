// ============================================================
// Amazon Halo V2 — page shell.
//
// A SEPARATE surface from /halo. V1 stays exactly as it is: this page reuses
// the same brand list and the same uploaded sheets read-only, and adds no
// upload, delete or share controls of its own — sheet management stays where it
// already lives, on the V1 page.
// ============================================================

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { getHaloRows } from '../../lib/haloApi';
import { listHaloEnabledBrands } from '../../lib/haloBrandsApi';
import HaloV2Explorer from '../../components/haloV2/HaloV2Explorer';

export default function HaloV2Page() {
  const [brands, setBrands] = useState([]);
  const [selectedBrandId, setSelectedBrandId] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

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
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            <h1 className="page-title" style={{ margin: 0 }}>Amazon Halo</h1>
            <span className="rounded-pill px-2 py-1" style={{ background: 'var(--accent-soft)', color: 'var(--accent)', fontSize: '0.62rem', fontWeight: 800 }}>MODEL V2</span>
          </div>
          <p className="page-subtitle" style={{ margin: '4px 0 0' }}>
            A neutral measurement model: signed relationships, an adjusted estimate with its uncertainty, and planning
            assumptions kept separate. <Link to="/halo" style={{ color: 'var(--accent)' }}>The original Halo tool</Link> is unchanged.
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
          </div>
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
