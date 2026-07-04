import { useEffect, useMemo, useState } from 'react';
import {
  createBrand, updateBrand, setBrandAssignments,
  uploadBrandLogo, removeBrandLogo,
  listActiveTLs, listAPCsUnderTLWithLoad, listEukaStores,
} from '../../lib/brandsApi';
import { useAuth } from '../../contexts/AuthContext';
import LogoPicker from './LogoPicker';
import { XIcon, AlertIcon, ShieldIcon } from '../common/Icon';
import { PAID_COLLAB_STATUSES } from '../../lib/roles';
import BrandCustomFieldsPanel from './BrandCustomFieldsPanel';
import BrandActivityPanel from './BrandActivityPanel';
import BrandResourcesPanel from './BrandResourcesPanel';

/**
 * Create or edit a brand.
 * Props:
 *   brand    — brand row + assignedUsers (edit mode) OR null (create mode)
 *   onClose  — () => void
 *   onSaved  — (brand) => void
 */
export default function BrandForm({ brand, onClose, onSaved }) {
  const { profile } = useAuth();
  const isEdit = !!brand;
  const isBossOrOL = profile?.role === 'boss' || profile?.role === 'ol';
  const isTL = profile?.role === 'tl';

  // TL creating a brand — they're the only possible owner
  const lockedOwner = isTL && !isEdit ? profile.id : null;

  // --- Fields ---
  const [brandName, setBrandName]   = useState(brand?.brand_name  || '');
  const [clientName, setClientName] = useState(brand?.client_name || '');
  const [tier, setTier]             = useState(brand?.tier        || '');
  const [gmv, setGmv]               = useState(brand?.gmv != null ? String(brand.gmv) : '');
  const [status, setStatus]         = useState(brand?.status      || 'active');
  const [paidCollabStatus, setPaidCollabStatus] = useState(
    brand?.paid_collab_status || 'not_applicable',
  );
  const [ownerId, setOwnerId]       = useState(brand?.owner_id    || lockedOwner || '');
  const [assignedIds, setAssignedIds] = useState(
    (brand?.assignedUsers || []).map((u) => u.id),
  );

  // Euka link — "on Euka" simply means a store is picked. Seeded from the
  // brand's existing euka_store_id (edit mode).
  const [onEuka, setOnEuka]           = useState(!!brand?.euka_store_id);
  const [eukaStoreId, setEukaStoreId] = useState(brand?.euka_store_id || '');
  const [eukaStores, setEukaStores]   = useState([]);
  const [loadingStores, setLoadingStores] = useState(false);

  // Logo state
  const [logoFile, setLogoFile]   = useState(null);            // staged File
  const [removeLogo, setRemoveLogo] = useState(false);         // clear existing
  const currentLogo = brand?.logo_url || null;

  // Lookups
  const [tls, setTls]         = useState([]);
  const [apcs, setApcs]       = useState([]);
  const [loadingTls, setLoadingTls] = useState(false);
  const [loadingApcs, setLoadingApcs] = useState(false);

  const [error, setError]     = useState('');
  const [saving, setSaving]   = useState(false);

  // Load TL list (Boss/OL only)
  useEffect(() => {
    if (!isBossOrOL) return;
    let cancelled = false;
    setLoadingTls(true);
    listActiveTLs()
      .then((list) => { if (!cancelled) setTls(list); })
      .catch((err) => { if (!cancelled) setError(err.message); })
      .finally(() => { if (!cancelled) setLoadingTls(false); });
    return () => { cancelled = true; };
  }, [isBossOrOL]);

  // Load APCs for the selected owner TL (with brand-count so we can
  // split them into "Already managing" vs "Available" groups).
  useEffect(() => {
    if (!ownerId) { setApcs([]); return; }
    let cancelled = false;
    setLoadingApcs(true);
    listAPCsUnderTLWithLoad(ownerId)
      .then((list) => {
        if (cancelled) return;
        setApcs(list);
        // prune any assigned APCs that no longer belong to this TL's team
        setAssignedIds((cur) => cur.filter((id) => list.some((a) => a.id === id)));
      })
      .catch((err) => { if (!cancelled) setError(err.message); })
      .finally(() => { if (!cancelled) setLoadingApcs(false); });
    return () => { cancelled = true; };
  }, [ownerId]);

  // Load the Euka store list the first time the brand is marked "on Euka"
  // (and in edit mode when it already is), so the dropdown can populate.
  useEffect(() => {
    if (!onEuka || eukaStores.length) return;
    let cancelled = false;
    setLoadingStores(true);
    listEukaStores()
      .then((list) => { if (!cancelled) setEukaStores(list); })
      .catch((err) => { if (!cancelled) setError(err.message); })
      .finally(() => { if (!cancelled) setLoadingStores(false); });
    return () => { cancelled = true; };
  }, [onEuka, eukaStores.length]);

  const eukaSlugFor = (storeId) => eukaStores.find((s) => s.store_id === storeId)?.slug || null;

  // Partition APCs by current workload. In edit mode, APCs already on
  // this brand will show their total count including this one — that's
  // accurate since they *are* assigned to a brand.
  const { managingApcs, availableApcs } = useMemo(() => {
    const managing = []; const available = [];
    for (const a of apcs) {
      (a.brand_count > 0 ? managing : available).push(a);
    }
    return { managingApcs: managing, availableApcs: available };
  }, [apcs]);

  const toggleAssigned = (id) =>
    setAssignedIds((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]));

  const ownerName = useMemo(() => {
    if (lockedOwner) return profile.display_name;
    return tls.find((t) => t.id === ownerId)?.display_name || '';
  }, [lockedOwner, profile, tls, ownerId]);

  async function handleSubmit(e) {
    e.preventDefault();
    setError('');
    if (!brandName.trim()) return setError('Brand name is required.');
    if (!ownerId)          return setError('Please select a Team Lead to own this brand.');
    // Euka store is REQUIRED once a brand is marked as being on Euka.
    if (onEuka && !eukaStoreId) return setError('Pick the Euka store for this brand (or turn off "This brand is on Euka").');

    // Resolve the Euka link to persist. Off → un-link (both null).
    const eukaStoreToSave = onEuka ? eukaStoreId : null;
    const eukaSlugToSave  = onEuka ? eukaSlugFor(eukaStoreId) : null;

    setSaving(true);
    try {
      // Handle logo: upload new, or clear existing, or keep as-is
      let nextLogoUrl = currentLogo;
      if (logoFile) {
        nextLogoUrl = await uploadBrandLogo(logoFile);
      } else if (removeLogo) {
        if (currentLogo) await removeBrandLogo(currentLogo);
        nextLogoUrl = null;
      }

      let saved;
      if (isEdit) {
        saved = await updateBrand(brand.id, {
          brandName, clientName, tier, gmv, status, ownerId, paidCollabStatus,
          logoUrl: nextLogoUrl,
          eukaStoreId: eukaStoreToSave, eukaSlug: eukaSlugToSave,
        });
      } else {
        saved = await createBrand({
          brandName, clientName, tier, gmv, status, ownerId, paidCollabStatus,
          logoUrl: nextLogoUrl,
          eukaStoreId: eukaStoreToSave, eukaSlug: eukaSlugToSave,
        });
      }

      await setBrandAssignments(saved.id, assignedIds);
      onSaved(saved);
    } catch (err) {
      setError(err.message || 'Failed to save brand.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="wx-modal-backdrop" onClick={onClose}>
      <div className="wx-modal" style={{ maxWidth: 560 }} onClick={(e) => e.stopPropagation()}>
        <form onSubmit={handleSubmit}>
          <div className="wx-modal-header">
            <div className="wx-modal-title">{isEdit ? 'Edit brand' : 'Add brand'}</div>
            <button type="button" className="shell-icon-btn" onClick={onClose} aria-label="Close">
              <XIcon width="16" height="16" />
            </button>
          </div>

          <div className="wx-modal-body">
            {error && (
              <div className="wx-alert wx-alert-danger" style={{ marginBottom: 14 }}>
                <AlertIcon width="16" height="16" /> <span>{error}</span>
              </div>
            )}

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14, marginBottom: 14 }}>
              <div>
                <label className="wx-label">Brand name <span style={{ color: 'var(--danger)' }}>*</span></label>
                <input
                  className="wx-input"
                  value={brandName}
                  onChange={(e) => setBrandName(e.target.value)}
                  disabled={saving}
                  placeholder="Glow Beauty"
                />
              </div>
              <div>
                <label className="wx-label">Client name</label>
                <input
                  className="wx-input"
                  value={clientName}
                  onChange={(e) => setClientName(e.target.value)}
                  disabled={saving}
                  placeholder="Sarah Johnson"
                />
              </div>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 14, marginBottom: 14 }}>
              <div>
                <label className="wx-label">Tier <span style={{ color: 'var(--text-muted)', fontWeight: 500 }}>(optional)</span></label>
                <input
                  className="wx-input"
                  value={tier}
                  onChange={(e) => setTier(e.target.value)}
                  disabled={saving}
                  placeholder="e.g. Unlimited, 7000"
                />
              </div>
              <div>
                <label className="wx-label">GMV (30d) <span style={{ color: 'var(--text-muted)', fontWeight: 500 }}>(optional)</span></label>
                <div style={{ position: 'relative' }}>
                  <span
                    style={{
                      position: 'absolute',
                      left: 12,
                      top: '50%',
                      transform: 'translateY(-50%)',
                      color: 'var(--text-muted)',
                      fontSize: 13,
                      pointerEvents: 'none',
                    }}
                  >$</span>
                  <input
                    type="number"
                    min="0"
                    step="0.01"
                    className="wx-input"
                    value={gmv}
                    onChange={(e) => setGmv(e.target.value)}
                    disabled={saving}
                    placeholder="0"
                    style={{ paddingLeft: 24 }}
                  />
                </div>
              </div>
              <div>
                <label className="wx-label">Status</label>
                <div style={{ display: 'flex', gap: 6 }}>
                  {['active', 'inactive'].map((s) => (
                    <button
                      key={s}
                      type="button"
                      onClick={() => setStatus(s)}
                      disabled={saving}
                      className={`wx-role-chip ${status === s ? 'wx-role-chip-active' : ''}`}
                      style={{ flex: 1, textAlign: 'center', padding: '8px 6px' }}
                    >
                      {s[0].toUpperCase() + s.slice(1)}
                    </button>
                  ))}
                </div>
              </div>
            </div>

            {/* Paid collab status */}
            <div style={{ marginBottom: 14 }}>
              <label className="wx-label">Paid collab status</label>
              <select
                className="wx-input"
                value={paidCollabStatus}
                onChange={(e) => setPaidCollabStatus(e.target.value)}
                disabled={saving}
              >
                {PAID_COLLAB_STATUSES.map((s) => (
                  <option key={s.value} value={s.value}>{s.label}</option>
                ))}
              </select>
              <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 4 }}>
                {PAID_COLLAB_STATUSES.find((s) => s.value === paidCollabStatus)?.blurb}
              </div>
            </div>

            {/* Euka link */}
            <div style={{ marginBottom: 14 }}>
              <label className="wx-label" style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <span>Euka store</span>
                <span className="form-check form-switch mb-0" style={{ paddingLeft: '2.4em' }}>
                  <input
                    className="form-check-input"
                    type="checkbox"
                    role="switch"
                    checked={onEuka}
                    disabled={saving}
                    onChange={(e) => {
                      setOnEuka(e.target.checked);
                      if (!e.target.checked) setEukaStoreId('');
                    }}
                    style={{ cursor: 'pointer' }}
                    title="Turn on if this brand is on Euka"
                  />
                </span>
                <span style={{ fontSize: 12, fontWeight: 500, color: 'var(--text-muted)' }}>
                  This brand is on Euka
                </span>
              </label>
              {onEuka && (
                <>
                  <div style={{ fontSize: 11.5, color: 'var(--text-muted)', margin: '2px 0 6px' }}>
                    Required. Links this brand to its Euka store for analytics and video-review targeting.
                  </div>
                  {loadingStores ? (
                    <div style={{ color: 'var(--text-muted)', fontSize: 13 }}>
                      <span className="wx-spinner" style={{ color: 'var(--accent)' }} /> Loading Euka stores…
                    </div>
                  ) : (
                    <select
                      className="wx-input"
                      value={eukaStoreId}
                      onChange={(e) => setEukaStoreId(e.target.value)}
                      disabled={saving}
                    >
                      <option value="">— Select the Euka store —</option>
                      {eukaStores.map((s) => (
                        <option key={s.store_id} value={s.store_id}>{s.label}</option>
                      ))}
                    </select>
                  )}
                </>
              )}
            </div>

            {/* Owner TL */}
            <div style={{ marginBottom: 14 }}>
              <label className="wx-label">Team Lead owner <span style={{ color: 'var(--danger)' }}>*</span></label>
              {lockedOwner ? (
                <div
                  style={{
                    padding: '10px 14px',
                    background: 'var(--accent-soft)',
                    color: 'var(--accent)',
                    border: '1px solid var(--accent)',
                    borderRadius: 'var(--radius-md)',
                    fontSize: 13.5,
                    fontWeight: 600,
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                  }}
                >
                  <ShieldIcon width="14" height="14" /> You ({profile.display_name})
                </div>
              ) : loadingTls ? (
                <div style={{ color: 'var(--text-muted)', fontSize: 13 }}>
                  <span className="wx-spinner" style={{ color: 'var(--accent)' }} /> Loading TLs…
                </div>
              ) : tls.length === 0 ? (
                <div
                  style={{
                    border: '1px dashed var(--border-default)',
                    padding: '12px 14px',
                    borderRadius: 'var(--radius-md)',
                    color: 'var(--text-muted)',
                    fontSize: 13,
                  }}
                >
                  No active TLs exist. Create one from Manage Users first.
                </div>
              ) : (
                <select
                  className="wx-input"
                  value={ownerId}
                  onChange={(e) => setOwnerId(e.target.value)}
                  disabled={saving}
                >
                  <option value="">— Select a Team Lead —</option>
                  {tls.map((tl) => (
                    <option key={tl.id} value={tl.id}>{tl.display_name} · {tl.email}</option>
                  ))}
                </select>
              )}
            </div>

            {/* Assigned APCs */}
            <div style={{ marginBottom: 14 }}>
              <label className="wx-label">
                Assigned APCs{' '}
                <span style={{ color: 'var(--text-muted)', fontWeight: 500 }}>
                  ({assignedIds.length} selected)
                </span>
              </label>
              {!ownerId ? (
                <div
                  style={{
                    border: '1px dashed var(--border-default)',
                    padding: '12px 14px',
                    borderRadius: 'var(--radius-md)',
                    color: 'var(--text-muted)',
                    fontSize: 13,
                  }}
                >
                  Pick a Team Lead above to see their APCs.
                </div>
              ) : loadingApcs ? (
                <div style={{ color: 'var(--text-muted)', fontSize: 13 }}>
                  <span className="wx-spinner" style={{ color: 'var(--accent)' }} /> Loading APCs…
                </div>
              ) : apcs.length === 0 ? (
                <div
                  style={{
                    border: '1px dashed var(--border-default)',
                    padding: '12px 14px',
                    borderRadius: 'var(--radius-md)',
                    color: 'var(--text-muted)',
                    fontSize: 13,
                  }}
                >
                  {ownerName || 'This TL'} has no APCs yet. Assign APCs to this TL first.
                </div>
              ) : (
                <div
                  style={{
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 10,
                    maxHeight: 220,
                    overflowY: 'auto',
                    border: '1px solid var(--border-subtle)',
                    borderRadius: 'var(--radius-md)',
                    padding: 10,
                  }}
                >
                  <ApcGroup
                    label="Available"
                    hint="No brand assigned yet"
                    apcs={availableApcs}
                    assignedIds={assignedIds}
                    onToggle={toggleAssigned}
                    disabled={saving}
                    tone="available"
                  />
                  <ApcGroup
                    label="Already managing"
                    hint="Currently assigned to other brands"
                    apcs={managingApcs}
                    assignedIds={assignedIds}
                    onToggle={toggleAssigned}
                    disabled={saving}
                    tone="managing"
                  />
                </div>
              )}
            </div>

            <LogoPicker
              currentUrl={removeLogo ? null : currentLogo}
              file={logoFile}
              onFileChange={(f) => { setLogoFile(f); if (f) setRemoveLogo(false); }}
              onClearExisting={() => setRemoveLogo(true)}
              disabled={saving}
            />

            {isEdit && brand?.id && (
              <BrandCustomFieldsPanel
                brandId={brand.id}
                canEdit={isBossOrOL || (isTL && brand.owner_id === profile?.id)}
              />
            )}
            {isEdit && brand?.id && (
              <BrandResourcesPanel
                brandId={brand.id}
                canEdit={isBossOrOL || (isTL && brand.owner_id === profile?.id) || ['apc','ipc'].includes(profile?.role)}
              />
            )}
            {isEdit && brand?.id && <BrandActivityPanel brandId={brand.id} />}
          </div>

          <div className="wx-modal-footer">
            <button type="button" className="wx-btn wx-btn-ghost" onClick={onClose} disabled={saving}>
              Cancel
            </button>
            <button type="submit" className="wx-btn wx-btn-primary" disabled={saving}>
              {saving ? <><span className="wx-spinner" /> Saving…</> : (isEdit ? 'Save changes' : 'Create brand')}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

function ApcGroup({ label, hint, apcs, assignedIds, onToggle, disabled, tone }) {
  if (apcs.length === 0) return null;
  const accent = tone === 'available' ? 'var(--success)' : 'var(--warning)';
  return (
    <div>
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        fontSize: 10.5, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.08em',
        color: 'var(--text-muted)', marginBottom: 6, paddingLeft: 2,
      }}>
        <span>
          <span style={{
            display: 'inline-block', width: 6, height: 6, borderRadius: '50%',
            background: accent, marginRight: 6, verticalAlign: 'middle',
          }} />
          {label} <span style={{ color: 'var(--text-muted)', fontWeight: 700 }}>({apcs.length})</span>
        </span>
        <span style={{ fontWeight: 600, textTransform: 'none', letterSpacing: 0, fontSize: 11 }}>
          {hint}
        </span>
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
        {apcs.map((a) => {
          const on = assignedIds.includes(a.id);
          return (
            <button
              key={a.id}
              type="button"
              onClick={() => onToggle(a.id)}
              disabled={disabled}
              title={a.brand_count > 0
                ? `Currently on ${a.brand_count} brand${a.brand_count === 1 ? '' : 's'}`
                : 'Not assigned to any brand yet'}
              style={{
                borderRadius: 999,
                padding: '5px 12px',
                fontSize: 12.5,
                fontWeight: 600,
                cursor: 'pointer',
                background: on ? 'var(--accent)' : 'var(--surface-1)',
                color: on ? 'var(--on-accent)' : 'var(--text-secondary)',
                border: `1px solid ${on ? 'var(--accent)' : 'var(--border-default)'}`,
                transition: 'all var(--dur-fast)',
                display: 'inline-flex', alignItems: 'center', gap: 6,
              }}
            >
              {on && '✓ '}{a.display_name}
              {a.brand_count > 0 && (
                <span style={{
                  fontSize: 10.5, fontWeight: 800,
                  padding: '1px 6px', borderRadius: 999,
                  background: on
                    ? 'color-mix(in srgb, var(--on-accent) 25%, transparent)'
                    : 'var(--surface-2)',
                  color: on ? 'var(--on-accent)' : 'var(--text-muted)',
                }}>{a.brand_count}</span>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}
