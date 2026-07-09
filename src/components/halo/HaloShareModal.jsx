import { useEffect, useState } from 'react';
import {
  listHaloShares, createHaloShare, revokeHaloShare, buildHaloShareUrl,
} from '../../lib/haloShareApi';
import {
  XIcon, AlertIcon, CheckIcon, CopyIcon, PlusIcon, LinkIcon,
} from '../common/Icon';

export default function HaloShareModal({ onClose }) {
  const [shares, setShares]   = useState([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr]         = useState('');
  const [busy, setBusy]       = useState(false);
  const [label, setLabel]     = useState('');
  const [expiry, setExpiry]   = useState('');     // 'YYYY-MM-DD' or empty
  const [justCreated, setJustCreated] = useState(null);

  async function load() {
    setLoading(true); setErr('');
    try {
      const list = await listHaloShares();
      setShares(list);
    } catch (e) { setErr(e.message); }
    finally { setLoading(false); }
  }
  useEffect(() => { load(); }, []);

  async function handleCreate() {
    setBusy(true); setErr('');
    try {
      const expiresAt = expiry ? new Date(expiry + 'T23:59:59').toISOString() : null;
      const row = await createHaloShare({ label: label.trim(), expiresAt });
      setJustCreated(row.token);
      setLabel('');
      setTimeout(() => setJustCreated(null), 5000);
      await load();
    } catch (e) { setErr(e.message); }
    finally { setBusy(false); }
  }

  async function handleRevoke(token) {
    if (!confirm('Revoke this link? Anyone with it will no longer be able to open the Amazon Halo explorer.')) return;
    try { await revokeHaloShare(token); await load(); }
    catch (e) { setErr(e.message); }
  }

  return (
    <div className="wx-modal-backdrop" onClick={onClose}>
      <div className="wx-modal" style={{ maxWidth: 560 }} onClick={(e) => e.stopPropagation()}>
        <div className="wx-modal-header">
          <div className="wx-modal-title">Share Amazon Halo</div>
          <button type="button" className="shell-icon-btn" onClick={onClose} aria-label="Close">
            <XIcon width="16" height="16" />
          </button>
        </div>

        <div className="wx-modal-body">
          {err && (
            <div className="wx-alert wx-alert-danger" style={{ marginBottom: 10 }}>
              <AlertIcon width="14" height="14" /> <span>{err}</span>
            </div>
          )}

          <div style={{ color: 'var(--text-muted)', fontSize: 13, marginBottom: 14 }}>
            Anyone with the link can view the Amazon Halo explorer (all datasets, read-only) — no login required. Revoke any time.
          </div>

          <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end', marginBottom: 18, flexWrap: 'wrap' }}>
            <div style={{ flex: '1 1 180px' }}>
              <label className="wx-label">Label (optional)</label>
              <input
                type="text"
                className="wx-input"
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                disabled={busy}
                placeholder="e.g. Acme client"
              />
            </div>
            <div style={{ flex: '1 1 160px' }}>
              <label className="wx-label">Expires</label>
              <input
                type="date"
                className="wx-input"
                value={expiry}
                onChange={(e) => setExpiry(e.target.value)}
                disabled={busy}
                min={new Date().toISOString().slice(0, 10)}
              />
              <div style={{ fontSize: 11.5, color: 'var(--text-muted)', marginTop: 4 }}>
                {expiry ? 'Link stops working after this date.' : 'Leave blank for a never-expiring link.'}
              </div>
            </div>
            <button className="wx-btn wx-btn-primary" onClick={handleCreate} disabled={busy}>
              {busy ? <><span className="wx-spinner" /> Creating…</> : <><PlusIcon width="14" height="14" /> New link</>}
            </button>
          </div>

          <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 6 }}>
            Existing links
          </div>

          {loading ? (
            <div style={{ color: 'var(--text-muted)', fontSize: 13 }}>
              <span className="wx-spinner" /> Loading…
            </div>
          ) : shares.length === 0 ? (
            <div style={{
              border: '1px dashed var(--border-default)', padding: '14px', borderRadius: 'var(--radius-md)',
              color: 'var(--text-muted)', fontSize: 13, textAlign: 'center',
            }}>
              No share links yet. Click "New link" to create one.
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {shares.map((s) => (
                <ShareRow
                  key={s.token}
                  share={s}
                  justCreated={justCreated === s.token}
                  onRevoke={() => handleRevoke(s.token)}
                />
              ))}
            </div>
          )}
        </div>

        <div className="wx-modal-footer">
          <button className="wx-btn wx-btn-ghost" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}

function ShareRow({ share, justCreated, onRevoke }) {
  const [copied, setCopied] = useState(false);
  const url = buildHaloShareUrl(share.token);
  const isRevoked = !!share.revoked_at;
  const isExpired = share.expires_at && new Date(share.expires_at) < new Date();
  const state = isRevoked ? 'revoked' : isExpired ? 'expired' : 'active';

  async function copy() {
    try { await navigator.clipboard.writeText(url); setCopied(true); setTimeout(() => setCopied(false), 1800); }
    catch {}
  }

  return (
    <div style={{
      border: `1px solid ${justCreated ? 'var(--accent)' : 'var(--border-subtle)'}`,
      background: justCreated ? 'var(--accent-soft)' : 'var(--surface-1)',
      borderRadius: 'var(--radius-md)',
      padding: '10px 12px',
      display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap',
    }}>
      <LinkIcon width="14" height="14" style={{ color: state === 'active' ? 'var(--accent)' : 'var(--text-muted)', flex: '0 0 auto' }} />
      <div style={{ flex: 1, minWidth: 0 }}>
        {share.label && (
          <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-primary)', marginBottom: 2 }}>
            {share.label}
          </div>
        )}
        <div style={{
          fontFamily: 'ui-monospace, monospace', fontSize: 11.5,
          color: state === 'active' ? 'var(--text-primary)' : 'var(--text-muted)',
          textDecoration: state !== 'active' ? 'line-through' : 'none',
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        }}>
          {url}
        </div>
        <div style={{ fontSize: 10.5, color: 'var(--text-muted)', marginTop: 2 }}>
          {state === 'revoked'  && 'Revoked'}
          {state === 'expired'  && 'Expired'}
          {state === 'active'   && (share.expires_at
            ? `Expires ${new Date(share.expires_at).toLocaleDateString()}`
            : 'Never expires')}
          {' · '}
          {share.view_count} {share.view_count === 1 ? 'view' : 'views'}
        </div>
      </div>
      {state === 'active' && (
        <>
          <button className="wx-btn wx-btn-ghost" style={{ padding: '5px 10px', fontSize: 12 }} onClick={copy}>
            {copied ? <><CheckIcon width="12" height="12" /> Copied</> : <><CopyIcon width="12" height="12" /> Copy</>}
          </button>
          <button className="wx-btn wx-btn-ghost" style={{ padding: '5px 10px', fontSize: 12 }} onClick={onRevoke}>
            <XIcon width="12" height="12" /> Revoke
          </button>
        </>
      )}
    </div>
  );
}
