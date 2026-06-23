import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { listAssignableApcs, assignBrandUser, unassignBrandUser } from '../../lib/brandsApi';
import { XIcon, AlertIcon, CheckIcon, SearchIcon } from '../common/Icon';

/**
 * Assign a brand to an APC/IPC for temporary cover — ADD alongside any existing
 * assignees, with an end date after which the cron auto-removes them. Available
 * to the brand's owning TL (and OL/Boss); RLS gates the write to can_edit_brand.
 */
function fmtDate(d) {
  return new Date(d).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}
function defaultEndDate() {
  const d = new Date(); d.setDate(d.getDate() + 14);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export default function AssignBrandModal({ brand, onClose, onDone }) {
  const [q, setQ] = useState('');
  const [pickedId, setPickedId] = useState('');
  const [endDate, setEndDate] = useState(defaultEndDate());
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const { data: candidates = [], isLoading } = useQuery({
    queryKey: ['assignable-apcs'],
    queryFn: () => listAssignableApcs(),
  });

  const current = (brand.assignedUsers || []).filter(Boolean);
  const currentIds = new Set(current.map((u) => u.id));

  const filtered = useMemo(() => {
    const qq = q.trim().toLowerCase();
    return candidates
      .filter((c) => !currentIds.has(c.id))
      .filter((c) => !qq
        || (c.display_name || '').toLowerCase().includes(qq)
        || (c.email || '').toLowerCase().includes(qq)
        || (c.manager?.display_name || '').toLowerCase().includes(qq));
  }, [candidates, currentIds, q]);

  async function add() {
    if (!pickedId) return setErr('Pick an APC/IPC to assign.');
    if (!endDate)  return setErr('Pick an end date for the assignment.');
    const expiresAt = new Date(`${endDate}T23:59:59`).toISOString();
    if (new Date(expiresAt) <= new Date()) return setErr('End date must be in the future.');
    setBusy(true); setErr('');
    try {
      await assignBrandUser(brand.id, pickedId, expiresAt);
      setPickedId(''); setQ('');
      onDone?.();
    } catch (e) { setErr(e.message); } finally { setBusy(false); }
  }

  async function remove(userId) {
    setBusy(true); setErr('');
    try { await unassignBrandUser(brand.id, userId); onDone?.(); }
    catch (e) { setErr(e.message); } finally { setBusy(false); }
  }

  return (
    <div className="wx-modal-backdrop" onClick={onClose}>
      <div className="wx-modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 540 }}>
        <div className="wx-modal-header">
          <div className="wx-modal-title">Assign APC / IPC — {brand.brand_name}</div>
          <button type="button" className="shell-icon-btn" onClick={onClose}><XIcon width="16" height="16" /></button>
        </div>
        <div className="wx-modal-body">
          {err && (
            <div className="wx-alert wx-alert-danger" style={{ marginBottom: 12 }}>
              <AlertIcon width="14" height="14" /> <span>{err}</span>
            </div>
          )}

          {/* Current assignees */}
          <div style={{ marginBottom: 14 }}>
            <div style={{ color: 'var(--text-muted)', fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 6 }}>Currently assigned</div>
            {current.length === 0 ? (
              <div style={{ color: 'var(--text-muted)', fontStyle: 'italic', fontSize: 12.5 }}>No one assigned yet.</div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {current.map((u) => (
                  <div key={u.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 10px', background: 'var(--surface-2)', borderRadius: 'var(--radius-md)' }}>
                    <Avatar user={u} />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontWeight: 700, fontSize: 13 }}>{u.display_name} <span style={{ color: 'var(--text-muted)', fontWeight: 500 }}>· {String(u.role || '').toUpperCase()}</span></div>
                      <div style={{ fontSize: 11 }}>
                        {u.expiresAt
                          ? <span style={{ color: 'var(--warning)' }}>Temporary · until {fmtDate(u.expiresAt)}</span>
                          : <span style={{ color: 'var(--text-muted)' }}>Permanent</span>}
                      </div>
                    </div>
                    <button type="button" className="wx-btn wx-btn-ghost wx-btn-sm" style={{ color: 'var(--danger)' }} disabled={busy} onClick={() => remove(u.id)} title="Remove from this brand">
                      <XIcon width="12" height="12" /> Remove
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Add new */}
          <div style={{ color: 'var(--text-muted)', fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 6 }}>Assign someone (temporary cover)</div>
          <div className="wx-search" style={{ marginBottom: 10 }}>
            <span className="wx-search-icon"><SearchIcon width="14" height="14" /></span>
            <input className="wx-input" placeholder="Search APC/IPC by name, email, or TL…" value={q} onChange={(e) => setQ(e.target.value)} />
          </div>
          <div style={{ maxHeight: 220, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 4, border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius-md)', padding: 6 }}>
            {isLoading ? (
              <div style={{ padding: 14, textAlign: 'center', color: 'var(--text-muted)' }}><span className="wx-spinner" /> Loading…</div>
            ) : filtered.length === 0 ? (
              <div style={{ padding: 14, textAlign: 'center', color: 'var(--text-muted)', fontSize: 12.5 }}>No APC/IPC matches.</div>
            ) : filtered.map((c) => {
              const on = pickedId === c.id;
              return (
                <button key={c.id} type="button" onClick={() => setPickedId(c.id)}
                  style={{ display: 'grid', gridTemplateColumns: '32px 1fr auto', gap: 10, alignItems: 'center', padding: '8px 10px', background: on ? 'var(--accent-soft)' : 'transparent', border: `1px solid ${on ? 'var(--accent)' : 'transparent'}`, borderRadius: 'var(--radius-md)', cursor: 'pointer', textAlign: 'left' }}>
                  <Avatar user={c} />
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontWeight: 700, fontSize: 13 }}>{c.display_name}</div>
                    <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>{String(c.role).toUpperCase()} · reports to <strong style={{ color: 'var(--text-secondary)' }}>{c.manager?.display_name || '—'}</strong></div>
                  </div>
                  {on && <CheckIcon width="14" height="14" style={{ color: 'var(--accent)' }} />}
                </button>
              );
            })}
          </div>

          <div style={{ marginTop: 12, display: 'flex', alignItems: 'flex-end', gap: 12, flexWrap: 'wrap' }}>
            <div>
              <label className="wx-label">Assigned until</label>
              <input type="date" className="wx-input" value={endDate} onChange={(e) => setEndDate(e.target.value)} style={{ width: 'auto' }} />
            </div>
            <div style={{ fontSize: 11.5, color: 'var(--text-muted)', flex: 1, minWidth: 160 }}>
              They get full access to work this brand and are automatically removed after this date.
            </div>
          </div>
        </div>
        <div className="wx-modal-footer">
          <button type="button" className="wx-btn wx-btn-ghost" onClick={onClose} disabled={busy}>Close</button>
          <button type="button" className="wx-btn wx-btn-primary" onClick={add} disabled={busy || !pickedId}>
            {busy ? <><span className="wx-spinner" /> Assigning…</> : <><CheckIcon width="14" height="14" /> Assign</>}
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
