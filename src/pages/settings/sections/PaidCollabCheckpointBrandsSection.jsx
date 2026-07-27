import { useCallback, useEffect, useMemo, useState } from 'react';
import { BoxIcon } from '../../../components/common/Icon';
import SectionShell from './SectionShell';
import { listBrands } from '../../../lib/brandsApi';
import { listManagedBrandIds, addManagedBrand, removeManagedBrand } from '../../../lib/paidCollabCheckpointApi';

// pctl/ipc (+ Boss/OL) curate the SHARED list of brands the paid collab team fills
// the weekly Paid Collab section (§09) for. Listed brands appear in the team's
// Weekly Checkpoint dashboard to fill each week; on unlisted brands §09 is hidden
// in the APC's checkpoint.
export default function PaidCollabCheckpointBrandsSection() {
  const [allBrands, setAllBrands] = useState([]);
  const [managedIds, setManagedIds] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');
  const [busyId, setBusyId] = useState(null);

  const load = useCallback(async () => {
    setLoading(true); setError('');
    try {
      const [brands, ids] = await Promise.all([listBrands({ status: 'active' }), listManagedBrandIds()]);
      setAllBrands(brands || []);
      setManagedIds(ids || []);
    } catch (e) { setError(e.message || String(e)); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { load(); }, [load]);

  const managedSet = useMemo(() => new Set(managedIds), [managedIds]);
  const filtered = useMemo(
    () => allBrands.filter((b) => (b.brand_name || '').toLowerCase().includes(search.trim().toLowerCase())),
    [allBrands, search],
  );

  async function toggle(brandId, on) {
    setBusyId(brandId); setError('');
    setManagedIds((cur) => (on ? [...new Set([...cur, brandId])] : cur.filter((x) => x !== brandId)));
    try {
      if (on) await addManagedBrand(brandId); else await removeManagedBrand(brandId);
    } catch (e) {
      setError(e.message || String(e));
      setManagedIds((cur) => (on ? cur.filter((x) => x !== brandId) : [...new Set([...cur, brandId])])); // revert
    } finally { setBusyId(null); }
  }

  return (
    <SectionShell icon={BoxIcon} title="Paid Collab brands"
      subtitle="Pick the brands your team fills the weekly Paid Collab section for. Listed brands show in your Weekly Checkpoint dashboard to fill each week; on unlisted brands the section is hidden for the APC.">
      {error && <div className="wx-alert wx-alert-danger" style={{ marginBottom: 10 }}><span>{error}</span></div>}
      {loading ? (
        <div style={{ color: 'var(--text-muted)', fontSize: 13 }}><span className="wx-spinner" /> Loading brands…</div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            <input type="text" className="wx-input" placeholder="Search brands…" value={search}
              onChange={(e) => setSearch(e.target.value)} style={{ maxWidth: 280 }} />
            <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
              <strong style={{ color: 'var(--text-primary)' }}>{managedSet.size}</strong> on the list
            </span>
          </div>
          <div style={{ maxHeight: 340, overflowY: 'auto', border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius-md)', padding: 6, display: 'flex', flexDirection: 'column', gap: 2 }}>
            {filtered.length === 0 ? (
              <div style={{ fontSize: 12.5, color: 'var(--text-muted)', padding: 10 }}>No brands match.</div>
            ) : filtered.map((b) => {
              const on = managedSet.has(b.id);
              return (
                <label key={b.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '6px 8px', borderRadius: 6, background: on ? 'var(--accent-soft)' : 'transparent', cursor: 'pointer', fontSize: 13 }}>
                  <input type="checkbox" checked={on} disabled={busyId === b.id} onChange={(e) => toggle(b.id, e.target.checked)} />
                  <span style={{ color: 'var(--text-primary)', fontWeight: on ? 600 : 400 }}>{b.brand_name}</span>
                  {b.client_name && <span style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>· {b.client_name}</span>}
                </label>
              );
            })}
          </div>
        </div>
      )}
    </SectionShell>
  );
}
