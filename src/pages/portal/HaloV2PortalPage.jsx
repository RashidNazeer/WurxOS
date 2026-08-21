import { useCallback, useEffect, useMemo, useState } from 'react';
import { useParams } from 'react-router-dom';
import { fetchSharedHaloV2, fetchSharedHaloV2Rows } from '../../lib/haloV2ShareApi';
import { AlertIcon } from '../../components/common/Icon';
import HaloV2Explorer from '../../components/haloV2/HaloV2Explorer';
import { useForceLightTheme } from './useForceLightTheme';
import '../../styles/portal.css';

// Anonymous client view of Amazon Halo V2 (mig 330).
//
// Deliberately a SEPARATE page and route from HaloPortalPage. V1 links stay on
// /portal/halo/:token and keep rendering V1; a V2 token only resolves here. A
// single page switching model by a flag would mean one wrong flag shows a
// client the other model, and the two say materially different things — V2 will
// report a negative relationship, or refuse to give a money figure at all,
// where V1 always produced an encouraging number.
export default function HaloV2PortalPage() {
  // External clients always see this in light mode, same as the V1 portal.
  useForceLightTheme();

  const { token } = useParams();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState('');
  const [brandId, setBrandId] = useState(null);

  useEffect(() => {
    let cancelled = false;
    fetchSharedHaloV2(token)
      .then((d) => { if (!cancelled) setData(d); })
      .catch((e) => { if (!cancelled) setErr(e.message || 'Could not load this page.'); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [token]);

  // Stable loader so the explorer's row-loading effect does not re-run on
  // every render.
  const loadRows = useCallback((id) => fetchSharedHaloV2Rows(token, id), [token]);

  const brands = useMemo(() => data?.brands || [], [data]);
  const datasets = useMemo(() => data?.datasets || [], [data]);
  useEffect(() => {
    if (brands.length && !brands.find((b) => b.id === brandId)) setBrandId(brands[0].id);
  }, [brands, brandId]);
  const brandDatasets = useMemo(
    () => datasets.filter((d) => d.brand_id === brandId),
    [datasets, brandId],
  );

  if (loading) {
    return (
      <div style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', background: 'var(--surface-0, var(--surface-2))' }}>
        <div style={{ color: 'var(--text-muted)' }}>
          <span className="wx-spinner" style={{ color: 'var(--accent)' }} /> Loading…
        </div>
      </div>
    );
  }

  if (err) {
    return (
      <div style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', background: 'var(--surface-0, var(--surface-2))', padding: 20 }}>
        <div className="wx-card" style={{ maxWidth: 440, padding: 28, textAlign: 'center' }}>
          <div style={{
            width: 52, height: 52, borderRadius: '50%',
            background: 'color-mix(in srgb, var(--danger) 20%, transparent)',
            color: 'var(--danger)', display: 'grid', placeItems: 'center', margin: '0 auto 12px',
          }}>
            <AlertIcon width="22" height="22" />
          </div>
          <div style={{ fontSize: 16, fontWeight: 700, color: 'var(--text-primary)', marginBottom: 6 }}>
            This link is no longer active
          </div>
          <div style={{ color: 'var(--text-muted)', fontSize: 13.5 }}>{err}</div>
        </div>
      </div>
    );
  }

  const label = data?.label;

  return (
    <div className="portal-page" style={{ minHeight: '100vh', background: 'var(--surface-0, var(--surface-2))', padding: '32px 16px' }}>
      <div style={{ maxWidth: 1040, margin: '0 auto' }}>
        <div className="wx-card portal-header" style={{ padding: 24, marginBottom: 16 }}>
          <div style={{ fontSize: 11, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 6 }}>
            Read-only explorer
          </div>
          <h1 style={{ fontSize: 22, fontWeight: 800, color: 'var(--text-primary)', margin: 0 }}>
            Amazon Halo <span style={{
              fontSize: 11, fontWeight: 800, letterSpacing: 0.6, verticalAlign: 'middle',
              padding: '3px 8px', borderRadius: 999, marginLeft: 8,
              background: 'color-mix(in srgb, var(--accent, #6366f1) 15%, transparent)',
              color: 'var(--accent, #6366f1)',
            }}>MODEL V2</span>
          </h1>
          {label && <div style={{ color: 'var(--text-muted)', fontSize: 13, marginTop: 6 }}>{label}</div>}
          {/* Set expectations before the numbers appear. V2 is willing to say
              "we cannot confidently detect a halo", and a client who was not
              told that reads a missing figure as a broken page. */}
          <p style={{ color: 'var(--text-muted)', fontSize: 13, margin: '10px 0 0', maxWidth: 720 }}>
            This measures whether TikTok activity and Amazon sales move together, in both
            directions. It reports negative results as readily as positive ones, and where
            there is not enough history it will say so rather than estimate. A missing
            figure is a deliberate answer, not a fault.
          </p>
        </div>

        {brands.length > 1 && (
          <div className="wx-card" style={{ padding: '12px 16px', marginBottom: 16, display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
            <span style={{ fontSize: 11, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '.05em', fontWeight: 600 }}>Brand</span>
            <select className="wx-input" style={{ maxWidth: 320 }} value={brandId || ''} onChange={(e) => setBrandId(e.target.value)}>
              {brands.map((b) => <option key={b.id} value={b.id}>{b.brand_name}</option>)}
            </select>
          </div>
        )}

        {!brandDatasets.length ? (
          <div className="wx-card" style={{ padding: 28, textAlign: 'center', color: 'var(--text-muted)', fontSize: 13.5 }}>
            No Halo data has been uploaded for this brand yet.
          </div>
        ) : (
          // key on the brand so switching resets the explorer's own state
          // rather than carrying one brand's selections onto another's data.
          <HaloV2Explorer key={brandId} datasets={brandDatasets} loadRows={loadRows} />
        )}
      </div>
    </div>
  );
}
