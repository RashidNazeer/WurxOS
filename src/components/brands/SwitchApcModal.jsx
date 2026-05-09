import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { listAssignableApcs, switchBrandApc, listBrandsForUsers } from '../../lib/brandsApi';
import { submitApcSwitchRequest } from '../../lib/brandSwitchApi';
import { useAuth } from '../../contexts/AuthContext';
import {
  XIcon, AlertIcon, CheckIcon, SearchIcon, RefreshIcon,
} from '../common/Icon';

/**
 * Modal for moving a brand to a different APC.
 *
 * Two modes, picked automatically by role:
 *   * Boss → always applies directly via `brand_switch_apc`.
 *   * OL   → defaults to direct but can flip to "Request from Boss",
 *            which writes a pending row to brand_switch_requests.
 */
export default function SwitchApcModal({ brand, onClose, onDone }) {
  const { profile } = useAuth();
  const role = profile?.role;
  const canDirectSwitch = ['boss', 'ol', 'developer'].includes(role);
  const canRequest      = role === 'ol';        // OL is the only role that benefits from the toggle
  const [mode, setMode] = useState(canDirectSwitch ? 'direct' : 'request');

  const [q, setQ] = useState('');
  const [pickedId, setPickedId] = useState('');
  const [note, setNote] = useState('');
  // Notifications are opt-in — the new APC + their TL only get a
  // heads-up when the caller explicitly ticks this box.
  const [notify, setNotify] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const { data: candidates = [], isLoading } = useQuery({
    queryKey: ['assignable-apcs'],
    queryFn: () => listAssignableApcs(),
  });

  // Every row in brand_assignments is considered "currently assigned" —
  // the schema only lets APCs/IPCs be added there via the UI, and we'd
  // rather show an unknown role than silently hide a real assignee.
  const current = (brand.assignedUsers || []).filter(Boolean);
  const currentIds = new Set(current.map((u) => u.id));

  const filtered = useMemo(() => {
    const qq = q.trim().toLowerCase();
    return candidates
      .filter((c) => !currentIds.has(c.id))  // don't offer who's already on this brand
      .filter((c) => {
        if (!qq) return true;
        return (
          (c.display_name || '').toLowerCase().includes(qq) ||
          (c.email || '').toLowerCase().includes(qq) ||
          (c.manager?.display_name || '').toLowerCase().includes(qq)
        );
      });
  }, [candidates, currentIds, q]);

  const picked = candidates.find((c) => c.id === pickedId) || null;

  // The first assignee is the "other side" of the swap — the old
  // APC whose book of brands will move to the picked APC and vice
  // versa. If the brand has no APC yet, the swap degenerates to a
  // one-way assignment; we don't render the Y→X column in that case.
  const oldApc = current[0] || null;
  const { data: swapLoads = {}, isLoading: loadingLoads } = useQuery({
    queryKey: ['swap-brand-loads', oldApc?.id, pickedId],
    queryFn: () => listBrandsForUsers([oldApc?.id, pickedId].filter(Boolean)),
    enabled: !!pickedId,
  });
  const brandsXtoY = oldApc ? (swapLoads[oldApc.id] || []) : [];
  const brandsYtoX = picked ? (swapLoads[picked.id] || []) : [];

  async function confirm() {
    if (!pickedId) return setErr('Pick an APC to switch the brand to.');
    setBusy(true); setErr('');
    try {
      if (mode === 'request') {
        await submitApcSwitchRequest({
          brandId: brand.id,
          toApcId: pickedId,
          reason: note.trim() || '',
          notify,
        });
      } else {
        await switchBrandApc(brand.id, pickedId, note.trim() || null, notify);
      }
      onDone?.(mode);
    } catch (e) { setErr(e.message); }
    finally { setBusy(false); }
  }

  return (
    <div className="wx-modal-backdrop" onClick={onClose}>
      <div className="wx-modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 560 }}>
        <div className="wx-modal-header">
          <div className="wx-modal-title">Switch APC — {brand.brand_name}</div>
          <button type="button" className="shell-icon-btn" onClick={onClose}>
            <XIcon width="16" height="16" />
          </button>
        </div>
        <div className="wx-modal-body">
          {err && (
            <div className="wx-alert wx-alert-danger" style={{ marginBottom: 12 }}>
              <AlertIcon width="14" height="14" /> <span>{err}</span>
            </div>
          )}

          {/* Mode toggle — only OL sees a choice. Boss is always direct,
              anyone else (shouldn't reach here) is always request. */}
          {canDirectSwitch && canRequest && (
            <div className="wx-seg" role="tablist" style={{ marginBottom: 12 }}>
              <button type="button" role="tab" aria-selected={mode === 'direct'}
                className={`wx-seg-btn ${mode === 'direct' ? 'is-active' : ''}`}
                onClick={() => setMode('direct')}>
                Switch directly
              </button>
              <button type="button" role="tab" aria-selected={mode === 'request'}
                className={`wx-seg-btn ${mode === 'request' ? 'is-active' : ''}`}
                onClick={() => setMode('request')}>
                Request from Boss
              </button>
            </div>
          )}

          {/* Current APC summary */}
          <div style={{
            padding: '10px 12px',
            background: 'var(--surface-2)',
            borderRadius: 'var(--radius-md)',
            fontSize: 12.5,
            marginBottom: 12,
          }}>
            <div style={{ color: 'var(--text-muted)', fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 4 }}>
              Currently assigned
            </div>
            {current.length === 0 ? (
              <span style={{ color: 'var(--text-muted)', fontStyle: 'italic' }}>No APC assigned.</span>
            ) : current.map((u) => (
              <span key={u.id} style={{
                display: 'inline-block',
                marginRight: 8, padding: '2px 8px',
                background: 'var(--surface-1)',
                borderRadius: 'var(--radius-pill)',
                fontWeight: 700,
              }}>{u.display_name} <span style={{ color: 'var(--text-muted)', fontWeight: 500 }}>· {u.role}</span></span>
            ))}
            {brand.owner?.display_name && (
              <div style={{ marginTop: 6, color: 'var(--text-muted)', fontSize: 11.5 }}>
                Team Lead: <strong style={{ color: 'var(--text-secondary)' }}>{brand.owner.display_name}</strong>
              </div>
            )}
          </div>

          {/* Search */}
          <div className="wx-search" style={{ marginBottom: 10 }}>
            <span className="wx-search-icon"><SearchIcon width="14" height="14" /></span>
            <input className="wx-input" placeholder="Search APC by name, email, or TL…"
              value={q} onChange={(e) => setQ(e.target.value)} autoFocus />
          </div>

          {/* Candidate list */}
          <div style={{
            maxHeight: 280, overflowY: 'auto',
            display: 'flex', flexDirection: 'column', gap: 4,
            border: '1px solid var(--border-subtle)',
            borderRadius: 'var(--radius-md)',
            padding: 6,
          }}>
            {isLoading ? (
              <div style={{ padding: 14, textAlign: 'center', color: 'var(--text-muted)' }}>
                <span className="wx-spinner" /> Loading…
              </div>
            ) : filtered.length === 0 ? (
              <div style={{ padding: 14, textAlign: 'center', color: 'var(--text-muted)', fontSize: 12.5 }}>
                No APCs match that search.
              </div>
            ) : filtered.map((c) => {
              const on = pickedId === c.id;
              return (
                <button key={c.id} type="button"
                  onClick={() => setPickedId(c.id)}
                  style={{
                    display: 'grid',
                    gridTemplateColumns: '32px 1fr auto',
                    gap: 10, alignItems: 'center',
                    padding: '8px 10px',
                    background: on ? 'var(--accent-soft)' : 'transparent',
                    border: `1px solid ${on ? 'var(--accent)' : 'transparent'}`,
                    borderRadius: 'var(--radius-md)',
                    cursor: 'pointer',
                    textAlign: 'left',
                  }}>
                  <Avatar user={c} />
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontWeight: 700, fontSize: 13 }}>{c.display_name}</div>
                    <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                      {c.role.toUpperCase()} · reports to <strong style={{ color: 'var(--text-secondary)' }}>{c.manager?.display_name || '—'}</strong>
                    </div>
                  </div>
                  {on && <CheckIcon width="14" height="14" style={{ color: 'var(--accent)' }} />}
                </button>
              );
            })}
          </div>

          {/* Swap preview — shows exactly which brands move which way. */}
          {picked && (
            <div style={{
              marginTop: 12, padding: '12px 14px',
              background: 'var(--accent-soft)',
              border: '1px solid color-mix(in srgb, var(--accent) 30%, transparent)',
              borderRadius: 'var(--radius-md)',
              fontSize: 12.5,
              color: 'var(--text-primary)',
            }}>
              <div style={{ fontWeight: 700, marginBottom: 8, display: 'flex', alignItems: 'center', gap: 6 }}>
                <RefreshIcon width="12" height="12" />
                {mode === 'request' ? 'On approval — swap:' : 'On confirm — swap:'}
              </div>

              {loadingLoads ? (
                <div style={{ color: 'var(--text-muted)' }}>
                  <span className="wx-spinner" /> Checking current brand lists…
                </div>
              ) : (
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                  <SwapColumn
                    from={oldApc}
                    to={picked}
                    brands={brandsXtoY}
                    fallback="Only this brand will move."
                  />
                  <SwapColumn
                    from={picked}
                    to={oldApc}
                    brands={brandsYtoX}
                    fallback={oldApc
                      ? `${picked.display_name} has no brands to send back.`
                      : 'No current APC — nothing comes back.'}
                  />
                </div>
              )}

              <div style={{
                marginTop: 10, paddingTop: 8,
                borderTop: '1px solid color-mix(in srgb, var(--accent) 22%, transparent)',
                fontSize: 11.5, color: 'var(--text-secondary)',
              }}>
                Each moved brand retargets its TL, reassigns open tasks, and is
                audit-logged.
                {mode === 'request' && ' Nothing moves until Boss approves the request.'}
              </div>
            </div>
          )}

          <div style={{ marginTop: 12 }}>
            <label className="wx-label">
              {mode === 'request' ? 'Reason for Boss' : 'Note (optional)'}
            </label>
            <input className="wx-input" value={note} onChange={(e) => setNote(e.target.value)}
              placeholder={mode === 'request'
                ? 'Why are you proposing this switch?'
                : 'Reason for the switch (kept in audit log)…'} />
          </div>

          {/* Notifications are opt-in. Scoped to the new APC + TL only. */}
          <label style={{
            display: 'flex', alignItems: 'flex-start', gap: 10,
            padding: '10px 12px', marginTop: 12,
            border: '1px solid var(--border-subtle)',
            borderRadius: 'var(--radius-md)',
            background: notify ? 'var(--accent-soft)' : 'var(--surface-1)',
            cursor: 'pointer',
            transition: 'background var(--dur-fast)',
          }}>
            <input type="checkbox" checked={notify}
              onChange={(e) => setNotify(e.target.checked)}
              disabled={busy}
              style={{ marginTop: 2 }} />
            <span style={{ fontSize: 13, color: 'var(--text-primary)' }}>
              <strong>Notify the new APC and their Team Lead</strong>
              <div style={{ color: 'var(--text-muted)', fontSize: 12, marginTop: 2 }}>
                {mode === 'request'
                  ? 'When Boss approves this request, the new APC and their TL will get an in-app + push notification.'
                  : 'The new APC and their TL will get an in-app + push notification. Leave off for a silent switch.'}
              </div>
            </span>
          </label>
        </div>
        <div className="wx-modal-footer">
          <button type="button" className="wx-btn wx-btn-ghost" onClick={onClose} disabled={busy}>Cancel</button>
          <button type="button" className="wx-btn wx-btn-primary" onClick={confirm} disabled={busy || !pickedId}>
            {busy
              ? <><span className="wx-spinner" />{mode === 'request' ? ' Submitting…' : ' Switching…'}</>
              : mode === 'request'
                ? <><CheckIcon width="14" height="14" /> Submit request</>
                : <><CheckIcon width="14" height="14" /> Confirm switch</>}
          </button>
        </div>
      </div>
    </div>
  );
}

function Avatar({ user }) {
  const style = { width: 32, height: 32, borderRadius: '50%', overflow: 'hidden', background: 'var(--surface-2)', color: 'var(--text-secondary)', display: 'grid', placeItems: 'center', fontSize: 11, fontWeight: 800 };
  if (user?.avatar_url) {
    return <div style={style}><img src={user.avatar_url} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} /></div>;
  }
  const init = String(user?.display_name || '?').split(/\s+/).map((s) => s[0]).slice(0, 2).join('').toUpperCase();
  return <div style={style}>{init}</div>;
}

// One side of the swap preview. Renders the list of brand names that
// will move from `from` to `to`. Brands have `id, brand_name, logo_url`.
function SwapColumn({ from, to, brands, fallback }) {
  if (!from || !to) return null;
  return (
    <div>
      <div style={{
        display: 'flex', alignItems: 'center', gap: 6,
        fontSize: 10.5, fontWeight: 800, textTransform: 'uppercase',
        letterSpacing: '0.08em', color: 'var(--text-muted)', marginBottom: 6,
      }}>
        <strong style={{ color: 'var(--text-secondary)' }}>{from.display_name}</strong>
        → <strong style={{ color: 'var(--text-secondary)' }}>{to.display_name}</strong>
      </div>
      {brands.length === 0 ? (
        <div style={{ fontSize: 12, color: 'var(--text-muted)', fontStyle: 'italic' }}>
          {fallback}
        </div>
      ) : (
        <ul style={{ margin: 0, paddingLeft: 16, fontSize: 12.5, lineHeight: 1.45 }}>
          {brands.map((b) => <li key={b.id}><strong>{b.brand_name}</strong></li>)}
        </ul>
      )}
    </div>
  );
}
