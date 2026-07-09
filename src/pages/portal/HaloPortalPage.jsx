import { useCallback, useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { fetchSharedHalo, fetchSharedHaloRows } from '../../lib/haloShareApi';
import { AlertIcon } from '../../components/common/Icon';
import HaloExplorer from '../../components/halo/HaloExplorer';
import { useForceLightTheme } from './useForceLightTheme';
import '../../styles/portal.css';

export default function HaloPortalPage() {
  // External clients always see the explorer in light mode.
  useForceLightTheme();

  const { token } = useParams();
  const [data, setData]       = useState(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr]         = useState('');

  useEffect(() => {
    let cancelled = false;
    fetchSharedHalo(token)
      .then((d) => { if (!cancelled) setData(d); })
      .catch((e) => { if (!cancelled) setErr(e.message || 'Could not load this page.'); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [token]);

  // Stable loader so HaloExplorer's row-loading effect doesn't re-run
  // every render.
  const loadRows = useCallback((id) => fetchSharedHaloRows(token, id), [token]);

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

  const datasets = data?.datasets || [];
  const label = data?.label;

  return (
    <div className="portal-page" style={{ minHeight: '100vh', background: 'var(--surface-0, var(--surface-2))', padding: '32px 16px' }}>
      <div style={{ maxWidth: 1040, margin: '0 auto' }}>
        {/* Header */}
        <div className="wx-card portal-header" style={{ padding: 24, marginBottom: 16 }}>
          <div style={{ fontSize: 11, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 6 }}>
            Read-only explorer
          </div>
          <h1 style={{ fontSize: 22, fontWeight: 800, color: 'var(--text-primary)', margin: 0 }}>
            Amazon Halo Effect
          </h1>
          {label && (
            <div style={{ color: 'var(--text-muted)', fontSize: 13, marginTop: 6 }}>{label}</div>
          )}
          <p style={{ color: 'var(--text-muted)', fontSize: 13, margin: '10px 0 0', maxWidth: 720 }}>
            Explore how TikTok activity drives Amazon demand. Correlate any two metrics,
            browse the full correlation heatmap, and shift the <strong>halo lag</strong> to
            see the delayed spillover (TikTok today → Amazon a few days later).
          </p>
        </div>

        {datasets.length === 0 ? (
          <div className="wx-card" style={{ padding: 24, color: 'var(--text-muted)', textAlign: 'center' }}>
            No data has been published yet.
          </div>
        ) : (
          <HaloExplorer datasets={datasets} loadRows={loadRows} />
        )}

        <div style={{ textAlign: 'center', color: 'var(--text-muted)', fontSize: 11.5, marginTop: 24 }}>
          Shared via WurxOS · Read-only
        </div>
      </div>
    </div>
  );
}
