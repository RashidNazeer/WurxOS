// VERBATIM PORT of v1 components/teamManagement/ReassignApcLeadTab.js (276 LOC).
// Surgical patches:
//   1. useAuth() v2 shape → reconstruct v1 currentUser
//   2. loadTeamMembers/reassignApcLead come from utils/teamManagementService.js
//      (already shimmed to wrap v2's teamApi RPC)
import React, { useEffect, useMemo, useState } from 'react';
import { useAuth } from '../../contexts/AuthContext';
import { loadTeamMembers, reassignApcLead, setApcExtraTl } from '../../utils/teamManagementService';
import { Button } from '../ui';

export default function ReassignApcLeadTab() {
  const { user, profile } = useAuth();
  const currentUser = user ? { uid: user.id, email: user.email, displayName: profile?.display_name || '' } : null;
  const userName = currentUser?.displayName || currentUser?.email?.split('@')[0] || '';

  const [tls, setTls] = useState([]);
  const [apcs, setApcs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [selectedApcId, setSelectedApcId] = useState('');
  const [selectedTLId, setSelectedTLId] = useState('');
  const [saving, setSaving] = useState(false);
  const [success, setSuccess] = useState('');
  const [error, setError] = useState('');
  const [confirming, setConfirming] = useState(false);
  const [linkBusy, setLinkBusy] = useState('');

  // `silent` reloads in place: toggling an additional TL must not blank the
  // picker the user is standing in.
  const refresh = React.useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    try {
      const data = await loadTeamMembers();
      setTls(data.tls);
      setApcs(data.apcs);
    } finally { setLoading(false); }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  const filteredApcs = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return apcs;
    return apcs.filter(a =>
      (a.name || '').toLowerCase().includes(q) ||
      (a.email || '').toLowerCase().includes(q) ||
      (a.ownerName || '').toLowerCase().includes(q)
    );
  }, [apcs, search]);

  const selectedApc = apcs.find(a => a.id === selectedApcId) || null;
  const selectedTL = tls.find(t => t.id === selectedTLId) || null;
  const sameTl = selectedApc && selectedTL && selectedApc.ownerId === selectedTL.id;

  // APCs sit under TLs, IPCs under PCTLs (team_move_apc_to_tl accepts either,
  // so only offer the valid ones — otherwise an APC could be parked under a
  // paid-collab lead by mistake). Falls back to the full list if none match.
  const eligibleTls = useMemo(() => {
    if (!selectedApc) return tls;
    const want = selectedApc.role === 'ipc' ? 'pctl' : 'tl';
    const scoped = tls.filter(t => t.role === want);
    return scoped.length ? scoped : tls;
  }, [tls, selectedApc]);

  // TLs whose live brand the APC holds can't be unlinked (the server refuses);
  // say so up front instead of offering a toggle that will fail.
  const heldBrandsByTl = useMemo(() => {
    const m = new Map();
    for (const b of selectedApc?.assignedBrands || []) {
      if (!m.has(b.ownerId)) m.set(b.ownerId, []);
      m.get(b.ownerId).push(b.brandName);
    }
    return m;
  }, [selectedApc]);

  async function toggleExtraTl(tl, on) {
    setLinkBusy(tl.id); setError(''); setSuccess('');
    try {
      await setApcExtraTl({ apcId: selectedApc.id, tlId: tl.id, on });
      setSuccess(on ? `${selectedApc.name} now also works under ${tl.name}.` : `${selectedApc.name} no longer works under ${tl.name}.`);
      await refresh(true);
    } catch (e) {
      setError(e?.message || 'Could not update the team lead.');
    } finally { setLinkBusy(''); }
  }

  async function handleReassign() {
    if (!selectedApc || !selectedTL) return;
    if (sameTl) { setError('That APC is already on this TL.'); return; }
    setSaving(true); setError(''); setSuccess('');
    try {
      const result = await reassignApcLead({
        apcId: selectedApc.id,
        apcName: selectedApc.name,
        oldTLId: selectedApc.ownerId,
        newTL: selectedTL,
        brandCount: (selectedApc.assignedBrands || []).length,
        actor: { uid: currentUser?.uid, name: userName },
      });
      setSuccess(
        `${selectedApc.name} moved to ${selectedTL.name}. ` +
        `${result.changed} brand${result.changed === 1 ? '' : 's'} moved with them.`
      );
      setSelectedApcId('');
      setSelectedTLId('');
      setConfirming(false);
      await refresh();
    } catch (e) {
      setError(e?.message || 'Failed to reassign.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div>
      <div className="d-flex align-items-center gap-2 mb-3 flex-wrap">
        <div className="rounded-2 d-flex align-items-center justify-content-center"
          style={{ width: 32, height: 32, background: 'var(--warning-soft)', color: 'var(--warning-text)' }}>
          <i className="bi bi-arrow-left-right" style={{ fontSize: '0.9rem' }} />
        </div>
        <div>
          <h6 className="fw-bold mb-0" style={{ fontSize: '0.95rem' }}>Reassign APC's Team Lead</h6>
          <p className="text-muted mb-0" style={{ fontSize: '0.72rem' }}>
            Move an APC to a different Team Lead. Their assigned brands move with them.
          </p>
        </div>
      </div>

      {success && (
        <div className="alert alert-success py-2 small d-flex align-items-center gap-2 mb-3">
          <i className="bi bi-check-circle-fill" />{success}
        </div>
      )}
      {error && (
        <div className="alert alert-danger py-2 small d-flex align-items-center gap-2 mb-3">
          <i className="bi bi-exclamation-circle-fill" />{error}
        </div>
      )}

      {loading ? (
        <div className="text-center py-5 text-muted small"><span className="spinner-border spinner-border-sm me-2" />Loading team…</div>
      ) : (
        <div className="row g-3">
          {/* APC picker */}
          <div className="col-md-6">
            <div className="card border-0 shadow-sm h-100" style={{ borderRadius: 'var(--radius-lg)' }}>
              <div className="card-body p-3">
                <div className="d-flex align-items-center justify-content-between mb-2">
                  <h6 className="fw-bold mb-0" style={{ fontSize: '0.85rem' }}>
                    <i className="bi bi-person-badge me-1" />1. Pick APC
                  </h6>
                  <span className="text-muted" style={{ fontSize: '0.7rem' }}>{filteredApcs.length}</span>
                </div>
                <input className="form-control form-control-sm mb-2" placeholder="Search APC by name, email or current TL…"
                  value={search} onChange={e => setSearch(e.target.value)} />
                <div className="d-flex flex-column gap-1" style={{ maxHeight: 360, overflowY: 'auto' }}>
                  {filteredApcs.length === 0 ? (
                    <div className="text-muted text-center py-3 small">No APCs match.</div>
                  ) : filteredApcs.map(a => {
                    const isSel = a.id === selectedApcId;
                    return (
                      <button key={a.id} type="button"
                        className="btn text-start"
                        style={{
                          background: isSel ? 'var(--info-soft)' : 'var(--surface-1)',
                          border: `1px solid ${isSel ? 'var(--info)' : 'var(--border-subtle)'}`,
                          color: isSel ? 'var(--info-text)' : 'var(--text-primary)',
                          borderRadius: 'var(--radius-md)',
                          padding: '8px 12px',
                          fontSize: '0.78rem',
                          fontWeight: isSel ? 600 : 500,
                        }}
                        onClick={() => { setSelectedApcId(a.id); setError(''); }}>
                        <div className="d-flex align-items-center justify-content-between gap-2">
                          <div style={{ minWidth: 0 }}>
                            <div className="text-truncate fw-semibold">{a.name}</div>
                            <div className="text-muted text-truncate" style={{ fontSize: '0.66rem' }}>
                              {a.role?.toUpperCase()} · {(a.assignedBrands || []).length} brand{(a.assignedBrands || []).length === 1 ? '' : 's'}
                              {a.ownerName ? ` · TL: ${a.ownerName}` : ' · No TL'}
                              {a.teamLeadIds.length > 1 ? ` +${a.teamLeadIds.length - 1} more` : ''}
                            </div>
                          </div>
                          {isSel && <i className="bi bi-check-circle-fill" style={{ color: 'var(--info-text)' }} />}
                        </div>
                      </button>
                    );
                  })}
                </div>
              </div>
            </div>
          </div>

          {/* TL picker */}
          <div className="col-md-6">
            <div className="card border-0 shadow-sm h-100" style={{ borderRadius: 'var(--radius-lg)' }}>
              <div className="card-body p-3">
                <h6 className="fw-bold mb-2" style={{ fontSize: '0.85rem' }}>
                  <i className="bi bi-people-fill me-1" />2. Pick new Team Lead
                </h6>
                {!selectedApc ? (
                  <div className="text-muted small text-center py-4">Select an APC first.</div>
                ) : (
                  <div className="d-flex flex-column gap-1" style={{ maxHeight: 360, overflowY: 'auto' }}>
                    {eligibleTls.length === 0 && (
                      <div className="text-muted text-center py-3 small">No eligible team leads found.</div>
                    )}
                    {eligibleTls.map(t => {
                      const isSel = t.id === selectedTLId;
                      const isCurrent = t.id === selectedApc.ownerId;
                      return (
                        <button key={t.id} type="button"
                          className="btn text-start"
                          disabled={isCurrent}
                          style={{
                            background: isSel ? 'var(--success-soft)' : isCurrent ? 'var(--surface-2)' : 'var(--surface-1)',
                            border: `1px solid ${isSel ? 'var(--success)' : isCurrent ? 'var(--border-default)' : 'var(--border-subtle)'}`,
                            color: isSel ? 'var(--success-text)' : isCurrent ? 'var(--text-muted)' : 'var(--text-primary)',
                            borderRadius: 'var(--radius-md)',
                            padding: '8px 12px',
                            fontSize: '0.78rem',
                            fontWeight: isSel ? 600 : 500,
                            opacity: isCurrent ? 0.7 : 1,
                          }}
                          onClick={() => { setSelectedTLId(t.id); setError(''); }}>
                          <div className="d-flex align-items-center justify-content-between gap-2">
                            <div style={{ minWidth: 0 }}>
                              <div className="text-truncate fw-semibold">{t.name}</div>
                              <div className="text-muted text-truncate" style={{ fontSize: '0.66rem' }}>
                                {t.role?.toUpperCase()}{isCurrent ? ' · Currently this APC\'s TL' : ''}
                              </div>
                            </div>
                            {isSel && <i className="bi bi-check-circle-fill" style={{ color: 'var(--success-text)' }} />}
                          </div>
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* Additional TLs: a second team, without moving the APC */}
          {selectedApc && (
            <div className="col-12">
              <div className="card border-0 shadow-sm" style={{ borderRadius: 'var(--radius-lg)' }}>
                <div className="card-body p-3">
                  <h6 className="fw-bold mb-1" style={{ fontSize: '0.85rem' }}>
                    <i className="bi bi-diagram-3 me-1" />Also works under
                  </h6>
                  <p className="text-muted mb-2" style={{ fontSize: '0.72rem' }}>
                    For an APC who runs brands for more than one Team Lead. They appear in each lead's team and keep every brand;
                    {' '}{selectedApc.ownerName || 'their primary TL'} stays their manager for attendance, leave and incentives.
                  </p>
                  <div className="d-flex flex-wrap gap-2">
                    {eligibleTls.filter(t => t.id !== selectedApc.ownerId).map(t => {
                      const on = selectedApc.teamLeadIds.includes(t.id);
                      const held = heldBrandsByTl.get(t.id);
                      return (
                        <label key={t.id} className="d-flex align-items-center gap-2 px-3 py-2"
                          title={on && held ? `Still manages ${held.join(', ')} for ${t.name}` : undefined}
                          style={{
                            border: `1px solid ${on ? 'var(--success)' : 'var(--border-subtle)'}`,
                            background: on ? 'var(--success-soft)' : 'var(--surface-1)',
                            borderRadius: 'var(--radius-md)', fontSize: '0.78rem',
                            opacity: on && held ? 0.75 : 1,
                            cursor: linkBusy || (on && held) ? 'not-allowed' : 'pointer',
                          }}>
                          <input type="checkbox" checked={on}
                            disabled={!!linkBusy || (on && !!held)}
                            onChange={(e) => toggleExtraTl(t, e.target.checked)} />
                          <span className="fw-semibold">{t.name}</span>
                          {on && held && <span className="text-muted" style={{ fontSize: '0.66rem' }}>· {held.length} brand{held.length === 1 ? '' : 's'}</span>}
                          {linkBusy === t.id && <span className="spinner-border spinner-border-sm" />}
                        </label>
                      );
                    })}
                    {eligibleTls.filter(t => t.id !== selectedApc.ownerId).length === 0 && (
                      <span className="text-muted small">No other team leads available.</span>
                    )}
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* Confirm bar */}
          {selectedApc && selectedTL && !sameTl && (
            <div className="col-12">
              <div className="card border-0 shadow-sm" style={{ borderRadius: 'var(--radius-lg)', background: 'linear-gradient(135deg, var(--warning-soft), var(--surface-1))', border: '1px solid color-mix(in srgb, var(--warning) 35%, transparent)' }}>
                <div className="card-body p-3 d-flex align-items-center justify-content-between flex-wrap gap-2">
                  <div className="d-flex align-items-center gap-2">
                    <i className="bi bi-info-circle-fill" style={{ color: 'var(--warning-text)', fontSize: '1rem' }} />
                    <div className="small">
                      <strong>{selectedApc.name}</strong>
                      {' will move from '}
                      <span style={{ color: 'var(--danger-text)', fontWeight: 600 }}>{selectedApc.ownerName || 'no TL'}</span>
                      {' to '}
                      <span style={{ color: 'var(--success-text)', fontWeight: 600 }}>{selectedTL.name}</span>
                      {`. ${(selectedApc.assignedBrands || []).length} brand${(selectedApc.assignedBrands || []).length === 1 ? '' : 's'} will follow.`}
                    </div>
                  </div>
                  <div className="d-flex gap-2">
                    <Button variant="secondary" size="sm"
                      onClick={() => { setSelectedApcId(''); setSelectedTLId(''); }}
                      disabled={saving}>Cancel</Button>
                    <Button size="sm" icon={<i className="bi bi-arrow-left-right" />}
                      onClick={() => setConfirming(true)} disabled={saving}>
                      Reassign
                    </Button>
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Confirm modal */}
      {confirming && selectedApc && selectedTL && (
        <div style={{ position: 'fixed', inset: 0, zIndex: 1080, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
          <div style={{ position: 'absolute', inset: 0, background: 'var(--backdrop)' }} onClick={() => setConfirming(false)} />
          <div className="card border-0 shadow-lg" style={{ position: 'relative', maxWidth: 460, borderRadius: 'var(--radius-lg)' }}>
            <div className="card-body p-4">
              <div className="d-flex align-items-center gap-3 mb-3">
                <div className="rounded-circle d-flex align-items-center justify-content-center"
                  style={{ width: 48, height: 48, background: 'var(--warning-soft)', color: 'var(--warning-text)' }}>
                  <i className="bi bi-exclamation-triangle-fill" style={{ fontSize: '1.2rem' }} />
                </div>
                <div>
                  <h6 className="fw-bold mb-0">Confirm reassignment</h6>
                  <div className="text-muted small">This affects ownership and notifications.</div>
                </div>
              </div>
              <div className="mb-3 small">
                <div className="rounded-2 p-3" style={{ background: 'var(--surface-2)', border: '1px solid var(--border-subtle)' }}>
                  <div><strong>APC:</strong> {selectedApc.name}</div>
                  <div><strong>From TL:</strong> {selectedApc.ownerName || '—'}</div>
                  <div><strong>To TL:</strong> {selectedTL.name}</div>
                  <div className="mt-1 text-muted">
                    {(selectedApc.assignedBrands || []).length} brand{(selectedApc.assignedBrands || []).length === 1 ? '' : 's'} will move with them to {selectedTL.name}.
                    The APC, old TL, and new TL will all be notified.
                  </div>
                </div>
              </div>
              <div className="d-flex gap-2 justify-content-end">
                <Button variant="secondary" size="sm" onClick={() => setConfirming(false)} disabled={saving}>Cancel</Button>
                <Button size="sm" onClick={handleReassign} loading={saving} icon={<i className="bi bi-check2" />}>
                  {saving ? 'Reassigning…' : 'Confirm'}
                </Button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
