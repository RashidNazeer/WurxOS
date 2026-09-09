import { useEffect, useState } from 'react';
import { updateBrand, listActiveTLs, listAPCsUnderTL, setBrandAssignments } from '../../lib/brandsApi';
import BrandAvatar from './BrandAvatar';
import { XIcon, AlertIcon, ArrowRightIcon } from '../common/Icon';

/**
 * Reassign a brand from its current TL to another.
 * Default: APC assignments are kept (brands follow APCs, not managers).
 * Optional: drop all APC assignments on switch.
 *
 * Props:
 *   brand   — brand row (with owner + assignedUsers)
 *   onClose — () => void
 *   onDone  — () => void
 */
export default function BrandSwitcherModal({ brand, onClose, onDone }) {
  const [tls, setTls]                 = useState([]);
  const [loading, setLoading]         = useState(true);
  const [newOwnerId, setNewOwnerId]   = useState('');
  const [dropAssignments, setDrop]    = useState(false);
  const [saving, setSaving]           = useState(false);
  const [error, setError]             = useState('');
  const [warning, setWarning]         = useState('');

  useEffect(() => {
    let cancelled = false;
    listActiveTLs()
      .then((list) => {
        if (cancelled) return;
        setTls(list.filter((t) => t.id !== brand.owner_id));
      })
      .catch((err) => { if (!cancelled) setError(err.message); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [brand.owner_id]);

  // When user picks a new TL, check if current APCs still belong under them.
  // If not, surface a warning so Boss knows keeping assignments may leave
  // APCs on a brand whose TL no longer manages them.
  useEffect(() => {
    if (!newOwnerId || dropAssignments) { setWarning(''); return; }
    const currentApcIds = (brand.assignedUsers || []).map((u) => u.id);
    if (currentApcIds.length === 0) { setWarning(''); return; }
    listAPCsUnderTL(newOwnerId).then((list) => {
      const newTlApcIds = new Set(list.map((a) => a.id));
      const orphans = currentApcIds.filter((id) => !newTlApcIds.has(id));
      if (orphans.length) {
        setWarning(
          `${orphans.length} assigned APC${orphans.length > 1 ? 's' : ''} do${orphans.length === 1 ? 'es' : ''} not report to the new TL. They will still be assigned to this brand — consider reassigning their reports-to as well, or enable "Drop APC assignments" below.`,
        );
      } else {
        setWarning('');
      }
    }).catch(() => {});
  }, [newOwnerId, dropAssignments, brand.assignedUsers]);

  async function handleSwitch() {
    setError('');
    if (!newOwnerId) return setError('Please select a new Team Lead.');
    setSaving(true);
    try {
      await updateBrand(brand.id, { ownerId: newOwnerId });
      if (dropAssignments) {
        // Changing the owning TL drops the APC assignments that belonged to the
        // old team. IPC allocations are managed by OL/PCTL on a different screen
        // and are not this modal to clear.
        await setBrandAssignments(brand.id, [], ['apc']);
      }
      onDone();
    } catch (err) {
      setError(err.message || 'Failed to switch brand.');
    } finally {
      setSaving(false);
    }
  }

  const newOwner = tls.find((t) => t.id === newOwnerId);

  return (
    <div className="wx-modal-backdrop" onClick={onClose}>
      <div className="wx-modal" onClick={(e) => e.stopPropagation()}>
        <div className="wx-modal-header">
          <div className="wx-modal-title">Switch brand owner</div>
          <button className="shell-icon-btn" onClick={onClose} aria-label="Close">
            <XIcon width="16" height="16" />
          </button>
        </div>

        <div className="wx-modal-body">
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 14,
              padding: '14px 16px',
              background: 'var(--surface-2)',
              border: '1px solid var(--border-subtle)',
              borderRadius: 'var(--radius-md)',
              marginBottom: 16,
            }}
          >
            <BrandAvatar brand={brand} size={44} />
            <div style={{ minWidth: 0 }}>
              <div style={{ fontWeight: 700, color: 'var(--text-primary)', fontSize: 14 }}>
                {brand.brand_name}
              </div>
              <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                Currently owned by <strong style={{ color: 'var(--text-secondary)' }}>{brand.owner?.display_name || '—'}</strong>
                {' · '}
                {(brand.assignedUsers || []).length} APC{(brand.assignedUsers || []).length === 1 ? '' : 's'} assigned
              </div>
            </div>
          </div>

          {error && (
            <div className="wx-alert wx-alert-danger" style={{ marginBottom: 14 }}>
              <AlertIcon width="16" height="16" /> <span>{error}</span>
            </div>
          )}

          <div style={{ marginBottom: 14 }}>
            <label className="wx-label">New Team Lead owner</label>
            {loading ? (
              <div style={{ color: 'var(--text-muted)', fontSize: 13 }}>
                <span className="wx-spinner" style={{ color: 'var(--accent)' }} /> Loading TLs…
              </div>
            ) : tls.length === 0 ? (
              <div style={{
                border: '1px dashed var(--border-default)',
                padding: '12px 14px',
                borderRadius: 'var(--radius-md)',
                color: 'var(--text-muted)',
                fontSize: 13,
              }}>
                No other active TLs available.
              </div>
            ) : (
              <select
                className="wx-input"
                value={newOwnerId}
                onChange={(e) => setNewOwnerId(e.target.value)}
                disabled={saving}
              >
                <option value="">— Select a Team Lead —</option>
                {tls.map((tl) => (
                  <option key={tl.id} value={tl.id}>{tl.display_name} · {tl.email}</option>
                ))}
              </select>
            )}
          </div>

          {newOwnerId && (
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                padding: '10px 14px',
                background: 'var(--accent-soft)',
                borderRadius: 'var(--radius-md)',
                fontSize: 13,
                color: 'var(--accent)',
                marginBottom: 14,
              }}
            >
              <strong>{brand.owner?.display_name}</strong>
              <ArrowRightIcon width="14" height="14" />
              <strong>{newOwner?.display_name}</strong>
            </div>
          )}

          <label
            style={{
              display: 'flex',
              alignItems: 'flex-start',
              gap: 10,
              padding: '10px 12px',
              border: '1px solid var(--border-subtle)',
              borderRadius: 'var(--radius-md)',
              background: 'var(--surface-1)',
              cursor: 'pointer',
              marginBottom: 8,
            }}
          >
            <input
              type="checkbox"
              checked={dropAssignments}
              onChange={(e) => setDrop(e.target.checked)}
              disabled={saving}
              style={{ marginTop: 3 }}
            />
            <span style={{ fontSize: 13, color: 'var(--text-primary)' }}>
              <strong>Drop APC assignments</strong>
              <div style={{ color: 'var(--text-muted)', fontSize: 12, marginTop: 2 }}>
                By default, assigned APCs stay on the brand. Enable this to clear them and let the new TL reassign.
              </div>
            </span>
          </label>

          {warning && (
            <div className="wx-alert wx-alert-info" style={{ marginTop: 6 }}>
              <AlertIcon width="16" height="16" /> <span>{warning}</span>
            </div>
          )}
        </div>

        <div className="wx-modal-footer">
          <button className="wx-btn wx-btn-ghost" onClick={onClose} disabled={saving}>Cancel</button>
          <button className="wx-btn wx-btn-primary" onClick={handleSwitch} disabled={saving || !newOwnerId}>
            {saving ? <><span className="wx-spinner" /> Switching…</> : 'Switch brand'}
          </button>
        </div>
      </div>
    </div>
  );
}
