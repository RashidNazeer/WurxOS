import { useEffect, useState } from 'react';
import { listActiveTLs } from '../../lib/brandsApi';
import { submitBrandSwitch } from '../../lib/brandSwitchApi';
import { XIcon, AlertIcon, CheckIcon } from '../common/Icon';

export default function RequestBrandSwitchModal({ brand, onClose, onSubmitted }) {
  const [tls, setTls]     = useState([]);
  const [toId, setToId]   = useState('');
  const [reason, setReason] = useState('');
  const [err, setErr]     = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    listActiveTLs()
      .then((list) => setTls(list.filter((t) => t.id !== brand.owner_id)))
      .catch((e) => setErr(e.message));
  }, [brand.owner_id]);

  async function submit(e) {
    e.preventDefault();
    if (!toId) return setErr('Pick a new Team Lead.');
    setSaving(true); setErr('');
    try {
      await submitBrandSwitch({
        brandId: brand.id,
        fromOwnerId: brand.owner_id,
        toOwnerId: toId,
        reason: reason.trim(),
      });
      onSubmitted();
    } catch (e) { setErr(e.message); }
    finally { setSaving(false); }
  }

  return (
    <div className="wx-modal-backdrop" onClick={onClose}>
      <div className="wx-modal" onClick={(e) => e.stopPropagation()}>
        <form onSubmit={submit}>
          <div className="wx-modal-header">
            <div className="wx-modal-title">Request brand switch</div>
            <button type="button" className="shell-icon-btn" onClick={onClose} aria-label="Close">
              <XIcon width="16" height="16" />
            </button>
          </div>
          <div className="wx-modal-body">
            {err && (
              <div className="wx-alert wx-alert-danger" style={{ marginBottom: 12 }}>
                <AlertIcon width="14" height="14" /> <span>{err}</span>
              </div>
            )}
            <div style={{ color: 'var(--text-muted)', fontSize: 13, marginBottom: 12 }}>
              Only the Boss can reassign a brand's TL. Submit a request and the Boss will decide.
            </div>

            <div style={{ marginBottom: 12 }}>
              <label className="wx-label">Brand</label>
              <input className="wx-input" value={brand.brand_name} disabled />
            </div>

            <div style={{ marginBottom: 12 }}>
              <label className="wx-label">New Team Lead</label>
              <select className="wx-input" value={toId} onChange={(e) => setToId(e.target.value)} disabled={saving}>
                <option value="">— Pick a TL —</option>
                {tls.map((t) => <option key={t.id} value={t.id}>{t.display_name} · {t.email}</option>)}
              </select>
            </div>

            <div>
              <label className="wx-label">Reason</label>
              <textarea className="wx-input" rows={3} value={reason} onChange={(e) => setReason(e.target.value)} disabled={saving}
                placeholder="Why this change?" />
            </div>
          </div>
          <div className="wx-modal-footer">
            <button type="button" className="wx-btn wx-btn-ghost" onClick={onClose} disabled={saving}>Cancel</button>
            <button type="submit" className="wx-btn wx-btn-primary" disabled={saving || !toId}>
              {saving ? <><span className="wx-spinner" /> Submitting…</> : <><CheckIcon width="14" height="14" /> Submit request</>}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
