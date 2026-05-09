import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { listBrands } from '../../lib/brandsApi';
import GmvMaxTab from '../../components/brands/tabs/GmvMaxTab';
import BrandAvatar from '../../components/brands/BrandAvatar';
import { SearchIcon, ChevronRightIcon, ReportIcon } from '../../components/common/Icon';

/**
 * Standalone "GMV Max Reporting" page accessible from the main nav.
 *
 * Compact brand picker on the left, GmvMaxTab on the right (same UI as
 * BrandDetail's GMV Max tab). RLS gates writes — anyone authenticated can
 * read.
 */
export default function GmvMaxReportingPage() {
  const { data: brands = [], isLoading } = useQuery({
    queryKey: ['brands', { status: 'active' }],
    queryFn: () => listBrands({ status: 'active' }),
  });

  const [search, setSearch] = useState('');
  const [selectedId, setSelectedId] = useState(null);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return [...brands]
      .sort((a, b) => (a.brand_name || '').localeCompare(b.brand_name || ''))
      .filter(b => !q || (b.brand_name || '').toLowerCase().includes(q));
  }, [brands, search]);

  const selected = useMemo(
    () => brands.find(b => b.id === selectedId) || null,
    [brands, selectedId]
  );

  return (
    <div style={{ padding: '20px 24px 40px' }}>
      <div style={{ marginBottom: 18, display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12 }}>
        <div>
          <h4 style={{ fontWeight: 800, margin: '0 0 4px', color: 'var(--text-primary)', letterSpacing: '-0.02em', fontSize: 20, display: 'inline-flex', alignItems: 'center', gap: 8 }}>
            <span style={{ color: '#0ea5e9' }}>📊</span>
            GMV Max Reporting
          </h4>
          <p style={{ color: 'var(--text-muted)', fontSize: 13, margin: 0 }}>
            Enter monthly GMV Max metrics from TikTok Ads Manager / Seller Center for each brand.
          </p>
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(260px, 1fr) 2fr', gap: 16 }}>
        {/* Brand picker */}
        <div className="wx-card" style={{ borderRadius: 14, position: 'sticky', top: 16, padding: 14, alignSelf: 'flex-start' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
            <h6 style={{ fontWeight: 800, margin: 0, fontSize: 13.5, display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              <ReportIcon width="14" height="14" /> Brands
            </h6>
            <span style={{ color: 'var(--text-muted)', fontSize: 11 }}>{filtered.length}</span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '4px 8px', background: 'var(--surface-2)', borderRadius: 8, marginBottom: 10 }}>
            <SearchIcon width="13" height="13" />
            <input style={{ flex: 1, border: 0, background: 'transparent', outline: 'none', fontSize: 12.5, padding: '4px 0' }}
              placeholder="Search brand…"
              value={search} onChange={e => setSearch(e.target.value)} />
          </div>
          {isLoading ? (
            <div style={{ color: 'var(--text-muted)', fontSize: 12, textAlign: 'center', padding: 14 }}>
              <span className="wx-spinner" /> Loading brands…
            </div>
          ) : filtered.length === 0 ? (
            <div style={{ color: 'var(--text-muted)', fontSize: 12, textAlign: 'center', padding: 14 }}>No brands available.</div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4, maxHeight: '60vh', overflowY: 'auto' }}>
              {filtered.map(b => {
                const isSel = b.id === selectedId;
                return (
                  <button key={b.id} type="button" onClick={() => setSelectedId(b.id)}
                    style={{
                      borderRadius: 10, padding: '8px 10px', textAlign: 'left',
                      background: isSel ? '#0ea5e91a' : 'transparent',
                      border: `1px solid ${isSel ? '#0ea5e9' : 'transparent'}`,
                      color: isSel ? '#0369a1' : 'var(--text-primary)',
                      fontSize: 13, fontWeight: isSel ? 700 : 500,
                      display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer',
                    }}>
                    <BrandAvatar brand={b} size={26} radius={6} />
                    <span style={{ flex: 1, textOverflow: 'ellipsis', overflow: 'hidden', whiteSpace: 'nowrap' }}>{b.brand_name}</span>
                    {isSel && <ChevronRightIcon width="12" height="12" />}
                  </button>
                );
              })}
            </div>
          )}
        </div>

        {/* Selected brand → GMV Max entry UI */}
        <div>
          {selected ? (
            <div className="wx-card" style={{ borderRadius: 14, padding: 18 }}>
              <GmvMaxTab brand={selected} />
            </div>
          ) : (
            <div className="wx-card" style={{ borderRadius: 14, padding: 36, textAlign: 'center' }}>
              <div style={{ fontSize: 28, opacity: 0.5 }}>👈</div>
              <h6 style={{ fontWeight: 800, marginTop: 8, marginBottom: 4 }}>Pick a brand to start</h6>
              <p style={{ color: 'var(--text-muted)', fontSize: 12.5, margin: 0 }}>
                Select a brand from the list to enter monthly GMV Max data.
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
