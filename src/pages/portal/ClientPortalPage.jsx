import { useEffect, useMemo, useState } from 'react';
import { useParams } from 'react-router-dom';
import { fetchSharedAccess } from '../../lib/clientAccessApi';
import ClientReportsSection from '../../components/portal/ClientReportsSection';
import ClientPaidCollabSection from '../../components/portal/ClientPaidCollabSection';
import ClientGmvMaxSection from '../../components/portal/ClientGmvMaxSection';
import { AlertIcon } from '../../components/common/Icon';
import { useForceLightTheme } from './useForceLightTheme';
import '../../styles/portal.css';

export default function ClientPortalPage() {
  // External clients always see the portal in light mode.
  useForceLightTheme();

  const { token } = useParams();
  const [data, setData]         = useState(null);
  const [loading, setLoading]   = useState(true);
  const [error, setError]       = useState('');
  const [activeTab, setActiveTab] = useState(null);

  const loadAccess = (preserveTab = false) => {
    return fetchSharedAccess(token)
      .then((d) => {
        setData(d);
        if (!preserveTab) {
          const types = d?.access?.share_types || [];
          const first = types.find(t => ['weekly','biweekly','monthly'].includes(t))
            ? 'reports'
            : types.includes('paidCollab') ? 'paidCollab'
            : types.includes('gmvMax')     ? 'gmvMax'
            : null;
          setActiveTab(first);
        }
      });
  };

  useEffect(() => {
    let cancelled = false;
    loadAccess(false)
      .catch((e) => { if (!cancelled) setError(e.message || 'Failed to load.'); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  // Called by BrandSectionsPanel after a successful add/rename/remove/set
  // so the portal re-renders with the updated sections + values without
  // dropping the user's current tab.
  const refresh = () => loadAccess(true).catch(() => {});

  const perms = useMemo(() => {
    const t = data?.access?.share_types || [];
    return {
      reports:    t.some(x => ['weekly','biweekly','monthly'].includes(x)),
      paidCollab: t.includes('paidCollab'),
      gmvMax:     t.includes('gmvMax'),
    };
  }, [data]);

  if (loading) {
    return (
      <div style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', background: 'var(--surface-2)' }}>
        <div style={{ color: 'var(--text-muted)' }}>
          <span className="wx-spinner" /> Loading dashboard…
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', background: 'var(--surface-2)', padding: 20 }}>
        <div className="wx-card" style={{ maxWidth: 440, padding: 28, textAlign: 'center' }}>
          <div style={{
            width: 52, height: 52, borderRadius: '50%',
            background: 'color-mix(in srgb, var(--danger) 20%, transparent)',
            color: 'var(--danger)', display: 'grid', placeItems: 'center', margin: '0 auto 12px',
          }}>
            <AlertIcon width="22" height="22" />
          </div>
          <div style={{ fontSize: 16, fontWeight: 800, marginBottom: 6 }}>Unable to load dashboard</div>
          <div style={{ color: 'var(--text-muted)', fontSize: 13.5 }}>{error}</div>
        </div>
      </div>
    );
  }

  const access        = data?.access || {};
  const brands        = data?.brands || [];
  const reports       = data?.reports || [];
  const gmv           = data?.gmv_max || [];
  const sections      = data?.sections || [];          // [{ brand_id, sections: [...] }]
  const sectionValues = data?.section_values || [];    // flat list across all permitted reports

  const tabsVisible = [perms.reports, perms.paidCollab, perms.gmvMax].filter(Boolean).length;
  const showTabs = tabsVisible >= 2;

  return (
    <div style={{ minHeight: '100vh', background: 'var(--surface-2)' }}>
      {/* Header — Wurx black + warm peach */}
      <div style={{ background: 'linear-gradient(135deg, #0a0a0a 0%, #1a1410 100%)', color: '#fff' }}>
        <div style={{ maxWidth: 1180, margin: '0 auto', padding: '24px 20px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
            <div style={{
              width: 52, height: 52, borderRadius: 12,
              background: 'rgba(245, 213, 168, 0.18)', backdropFilter: 'blur(4px)',
              display: 'grid', placeItems: 'center', fontSize: 24,
            }}>📊</div>
            <div style={{ minWidth: 0 }}>
              <div style={{ fontSize: 10.5, letterSpacing: '0.14em', textTransform: 'uppercase', opacity: 0.65 }}>Client Dashboard</div>
              <h3 style={{ fontWeight: 800, margin: '2px 0 4px', fontSize: 20, color: '#f5d5a8' }}>
                {access.client_name || access.label || 'Dashboard'}
              </h3>
              <div style={{ opacity: 0.7, fontSize: 12.5 }}>
                {brands.length} brand{brands.length !== 1 ? 's' : ''} · Powered by WurxOS
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Tabs */}
      {showTabs && (
        <div style={{ background: '#fff', borderBottom: '1px solid var(--border)', position: 'sticky', top: 0, zIndex: 10 }}>
          <div style={{ maxWidth: 1180, margin: '0 auto', padding: '0 20px' }}>
            <div style={{ display: 'flex', gap: 4 }}>
              {perms.reports && (
                <PortalTab label="Reports" emoji="📋" tint="#3b82f6"
                  active={activeTab === 'reports'} onClick={() => setActiveTab('reports')} />
              )}
              {perms.paidCollab && (
                <PortalTab label="Paid Collab" emoji="🎬" tint="#f59e0b"
                  active={activeTab === 'paidCollab'} onClick={() => setActiveTab('paidCollab')} />
              )}
              {perms.gmvMax && (
                <PortalTab label="GMV Max" emoji="📊" tint="#0ea5e9"
                  active={activeTab === 'gmvMax'} onClick={() => setActiveTab('gmvMax')} />
              )}
            </div>
          </div>
        </div>
      )}

      <div style={{ maxWidth: 1180, margin: '0 auto', padding: '24px 20px' }}>
        {activeTab === 'reports'    && (
          <ClientReportsSection
            reports={reports} brands={brands}
            shareTypes={access.share_types || []}
            sections={sections} sectionValues={sectionValues}
            token={access.token} onMutate={refresh}
          />
        )}
        {activeTab === 'paidCollab' && <ClientPaidCollabSection brands={brands} />}
        {activeTab === 'gmvMax'     && <ClientGmvMaxSection gmv={gmv} brands={brands} />}
      </div>

      <div style={{ textAlign: 'center', color: 'var(--text-muted)', fontSize: 11.5, padding: '20px 0 28px' }}>
        WurxOS Client Portal · Only approved data shown · Read-only
      </div>
    </div>
  );
}

function PortalTab({ label, emoji, tint, active, onClick }) {
  return (
    <button onClick={onClick}
      style={{
        background: 'transparent', border: 0,
        padding: '14px 16px', cursor: 'pointer',
        fontSize: 13.5, fontWeight: active ? 700 : 500,
        color: active ? tint : 'var(--text-secondary)',
        borderBottom: `3px solid ${active ? tint : 'transparent'}`,
        display: 'inline-flex', alignItems: 'center', gap: 6,
      }}>
      <span>{emoji}</span> {label}
    </button>
  );
}
