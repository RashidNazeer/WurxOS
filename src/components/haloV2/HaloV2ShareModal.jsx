import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  listHaloV2Shares, createHaloV2Share, revokeHaloV2Share, buildHaloV2ShareUrl,
} from '../../lib/haloV2ShareApi';
import {
  XIcon, AlertIcon, CheckIcon, CopyIcon, PlusIcon, LinkIcon,
} from '../common/Icon';
// Derived from HaloShareModal so the two behave identically, but pointed at
// the V2 share API. V1 is untouched.
//
// The wx-modal-* overlay styles live in table.css and are imported PER PAGE.
// HaloV2Page does not import it, so bring it in here or the modal renders
// unstyled with no fixed overlay.
import '../../styles/table.css';

export default function HaloV2ShareModal({ brands = [], onClose }) {
  const [shares, setShares]   = useState([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr]         = useState('');
  const [busy, setBusy]       = useState(false);
  const [label, setLabel]     = useState('');
  const [expiry, setExpiry]   = useState('');     // 'YYYY-MM-DD' or empty
  const [brandIds, setBrandIds] = useState([]);
  const [brandSearch, setBrandSearch] = useState('');
  const [justCreated, setJustCreated] = useState(null);

  const brandById = Object.fromEntries(brands.map((b) => [b.id, b]));
  const filteredBrands = brands.filter((b) => (b.brand_name || '').toLowerCase().includes(brandSearch.trim().toLowerCase()));
  const toggleBrand = (id) => setBrandIds((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]));

  async function load() {
    setLoading(true); setErr('');
    try {
      const list = await listHaloV2Shares();
      setShares(list);
    } catch (e) { setErr(e.message); }
    finally { setLoading(false); }
  }
  useEffect(() => { load(); }, []);

  // Lock the page behind the modal so it can't scroll under the overlay.
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = prev; };
  }, []);

  async function handleCreate() {
    if (!brandIds.length) { setErr('Pick at least one brand for this link.'); return; }
    setBusy(true); setErr('');
    try {
      const expiresAt = expiry ? new Date(expiry + 'T23:59:59').toISOString() : null;
      const row = await createHaloV2Share({ label: label.trim(), brandIds, expiresAt });
      setJustCreated(row.token);
      setLabel(''); setBrandIds([]); setBrandSearch('');
      setTimeout(() => setJustCreated(null), 5000);
      await load();
    } catch (e) { setErr(e.message); }
    finally { setBusy(false); }
  }

  async function handleRevoke(token) {
    if (!confirm('Revoke this link? Anyone with it will no longer be able to open the Amazon Halo V2 explorer.')) return;
    try { await revokeHaloV2Share(token); await load(); }
    catch (e) { setErr(e.message); }
  }

  return createPortal(
    <div className="wx-modal-backdrop" onClick={onClose}>
      <div className="wx-modal" style={{ maxWidth: 560 }} onClick={(e) => e.stopPropagation()}>
        <div className="wx-modal-header">
          <div className="wx-modal-title" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <LinkIcon width="16" height="16" style={{ color: 'var(--accent)' }} /> Share Amazon Halo V2
          </div>
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
            Anyone with the link can view the <strong>Amazon Halo V2</strong> explorer for the <strong>selected brands</strong> (read-only) — no login required. Revoke any time.
          </div>

          <div style={{ marginBottom: 14 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
              <label className="wx-label" style={{ margin: 0 }}>Brands for this link ({brandIds.length})</label>
              <div style={{ display: 'flex', gap: 8 }}>
                <button type="button" className="wx-btn wx-btn-ghost wx-btn-sm" onClick={() => setBrandIds(filteredBrands.map((b) => b.id))}>Select all</button>
                <button type="button" className="wx-btn wx-btn-ghost wx-btn-sm" onClick={() => setBrandIds([])}>Clear</button>
              </div>
            </div>
            <input type="text" className="wx-input" placeholder="Search brands…" value={brandSearch}
              onChange={(e) => setBrandSearch(e.target.value)} style={{ marginBottom: 6 }} />
            <div style={{ maxHeight: 176, overflowY: 'auto', border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius-md)', padding: 6, display: 'flex', flexDirection: 'column', gap: 2 }}>
              {brands.length === 0 ? (
                <div style={{ fontSize: 12, color: 'var(--text-muted)', padding: 8 }}>No Halo-enabled brands. Enable brands first (Settings → Amazon Halo).</div>
              ) : filteredBrands.map((b) => {
                const sel = brandIds.includes(b.id);
                return (
                  <label key={b.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '4px 6px', borderRadius: 6, background: sel ? 'var(--accent-soft)' : 'transparent', cursor: 'pointer', fontSize: 12.5 }}>
                    <input type="checkbox" checked={sel} onChange={() => toggleBrand(b.id)} />
                    <span style={{ color: 'var(--text-primary)' }}>{b.brand_name}</span>
                  </label>
                );
              })}
            </div>
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
                  brandById={brandById}
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
    </div>,
    document.body
  );
}

function ShareRow({ share, brandById = {}, justCreated, onRevoke }) {
  const [copied, setCopied] = useState(false);
  const url = buildHaloV2ShareUrl(share.token);
  const isRevoked = !!share.revoked_at;
  const isExpired = share.expires_at && new Date(share.expires_at) < new Date();
  const state = isRevoked ? 'revoked' : isExpired ? 'expired' : 'active';
  // Keep unresolved ids (e.g. a brand later disabled) so the count always equals
  // the link's real scope — get_shared_halo still serves those brands.
  const brandNames = (share.brand_ids || []).map((id) => brandById[id]?.brand_name || 'other brand');

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
        {brandNames.length > 0 && (
          <div style={{ fontSize: 10.5, color: 'var(--text-muted)', marginBottom: 2 }}>
            {brandNames.length} {brandNames.length === 1 ? 'brand' : 'brands'}: {brandNames.join(', ')}
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
