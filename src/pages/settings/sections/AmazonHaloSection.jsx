import { useCallback, useEffect, useMemo, useState } from 'react';
import { DiagramIcon, LinkIcon } from '../../../components/common/Icon';
import SectionShell from './SectionShell';
import HaloShareModal from '../../../components/halo/HaloShareModal';
import {
  listAllBrandsForHaloSettings, listHaloEnabledBrandIds, enableHaloBrand, disableHaloBrand,
} from '../../../lib/haloBrandsApi';

// Boss/OL-only: curate which brands appear in the Amazon Halo brand dropdown,
// and manage the read-only client access links (scoped to specific brands).
export default function AmazonHaloSection() {
  const [allBrands, setAllBrands] = useState([]);
  const [enabledIds, setEnabledIds] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');
  const [busyId, setBusyId] = useState(null);
  const [linksOpen, setLinksOpen] = useState(false);

  const load = useCallback(async () => {
    setLoading(true); setError('');
    try {
      const [brands, ids] = await Promise.all([listAllBrandsForHaloSettings(), listHaloEnabledBrandIds()]);
      setAllBrands(brands);
      setEnabledIds(ids);
    } catch (e) { setError(e.message || String(e)); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { load(); }, [load]);

  const enabledSet = useMemo(() => new Set(enabledIds), [enabledIds]);
  const filtered = useMemo(
    () => allBrands.filter((b) => (b.brand_name || '').toLowerCase().includes(search.trim().toLowerCase())),
    [allBrands, search],
  );
  const enabledBrandObjs = useMemo(
    () => allBrands.filter((b) => enabledSet.has(b.id)).map((b) => ({ id: b.id, brand_name: b.brand_name })),
    [allBrands, enabledSet],
  );
  // Count what's actually manageable/shareable (enabled ∩ active), so an archived
  // but still-enabled brand can't inflate the count past what the list shows.
  const enabledCount = enabledBrandObjs.length;

  async function toggle(brandId, on) {
    setBusyId(brandId); setError('');
    // optimistic
    setEnabledIds((cur) => (on ? [...new Set([...cur, brandId])] : cur.filter((x) => x !== brandId)));
    try {
      if (on) await enableHaloBrand(brandId); else await disableHaloBrand(brandId);
    } catch (e) {
      setError(e.message || String(e));
      setEnabledIds((cur) => (on ? cur.filter((x) => x !== brandId) : [...new Set([...cur, brandId])])); // revert
    } finally { setBusyId(null); }
  }

  return (
    <>
      <SectionShell icon={DiagramIcon} title="Halo-enabled brands"
        subtitle="Pick which brands show in the Amazon Halo brand dropdown. Enable a brand, then upload its sheets on the Amazon Halo page.">
        {error && <div className="wx-alert wx-alert-danger" style={{ marginBottom: 10 }}><span>{error}</span></div>}
        {loading ? (
          <div style={{ color: 'var(--text-muted)', fontSize: 13 }}><span className="wx-spinner" /> Loading brands…</div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
              <input type="text" className="wx-input" placeholder="Search brands…" value={search}
                onChange={(e) => setSearch(e.target.value)} style={{ maxWidth: 280 }} />
              <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                <strong style={{ color: 'var(--text-primary)' }}>{enabledCount}</strong> enabled
              </span>
            </div>
            <div style={{ maxHeight: 340, overflowY: 'auto', border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius-md)', padding: 6, display: 'flex', flexDirection: 'column', gap: 2 }}>
              {filtered.length === 0 ? (
                <div style={{ fontSize: 12.5, color: 'var(--text-muted)', padding: 10 }}>No brands match.</div>
              ) : filtered.map((b) => {
                const on = enabledSet.has(b.id);
                return (
                  <label key={b.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '6px 8px', borderRadius: 6, background: on ? 'var(--accent-soft)' : 'transparent', cursor: 'pointer', fontSize: 13 }}>
                    <input type="checkbox" checked={on} disabled={busyId === b.id} onChange={(e) => toggle(b.id, e.target.checked)} />
                    <span style={{ color: 'var(--text-primary)', fontWeight: on ? 600 : 400 }}>{b.brand_name}</span>
                    {b.client_name && <span style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>· {b.client_name}</span>}
                    {b.tier && <span style={{ marginLeft: 'auto', fontSize: 11, color: 'var(--text-muted)' }}>Tier {b.tier}</span>}
                  </label>
                );
              })}
            </div>
          </div>
        )}
      </SectionShell>

      <SectionShell icon={LinkIcon} title="Client access links"
        subtitle="Create read-only links for clients, each scoped to one or more Halo-enabled brands.">
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          <span style={{ fontSize: 13, color: 'var(--text-muted)' }}>
            {enabledCount ? `${enabledCount} brand${enabledCount === 1 ? '' : 's'} available to share.` : 'Enable at least one brand above first.'}
          </span>
          <button type="button" className="wx-btn wx-btn-primary wx-btn-sm" disabled={!enabledCount} onClick={() => setLinksOpen(true)}>
            <LinkIcon width="14" height="14" /> Manage client links
          </button>
        </div>
      </SectionShell>

      {linksOpen && <HaloShareModal brands={enabledBrandObjs} onClose={() => setLinksOpen(false)} />}
    </>
  );
}
