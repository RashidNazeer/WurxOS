// VERBATIM PORT of v1 components/teamManagement/ReassignApcLeadTab.js (276 LOC).
// Surgical patches:
//   1. useAuth() v2 shape → reconstruct v1 currentUser
//   2. loadTeamMembers/reassignApcLead come from utils/teamManagementService.js
//      (already shimmed to wrap v2's teamApi RPC)
import React, { useEffect, useMemo, useState } from 'react';
import { useAuth } from '../../contexts/AuthContext';
import { loadTeamMembers, reassignApcLead } from '../../utils/teamManagementService';

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

  const refresh = React.useCallback(async () => {
    setLoading(true);
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
          style={{ width: 32, height: 32, background: '#fef3c7', color: '#d97706' }}>
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
            <div className="card border-0 shadow-sm h-100" style={{ borderRadius: 14 }}>
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
                          background: isSel ? '#0ea5e91a' : '#fff',
                          border: `1px solid ${isSel ? '#0ea5e9' : '#e9ecef'}`,
                          color: isSel ? '#0369a1' : '#1e293b',
                          borderRadius: 10,
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
                            </div>
                          </div>
                          {isSel && <i className="bi bi-check-circle-fill" style={{ color: '#0ea5e9' }} />}
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
            <div className="card border-0 shadow-sm h-100" style={{ borderRadius: 14 }}>
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
                            background: isSel ? '#16a34a1a' : isCurrent ? '#f8fafc' : '#fff',
                            border: `1px solid ${isSel ? '#16a34a' : isCurrent ? '#cbd5e1' : '#e9ecef'}`,
                            color: isSel ? '#15803d' : isCurrent ? '#94a3b8' : '#1e293b',
                            borderRadius: 10,
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
                            {isSel && <i className="bi bi-check-circle-fill" style={{ color: '#16a34a' }} />}
                          </div>
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* Confirm bar */}
          {selectedApc && selectedTL && !sameTl && (
            <div className="col-12">
              <div className="card border-0 shadow-sm" style={{ borderRadius: 14, background: 'linear-gradient(135deg, #fffbeb, #ffffff)', border: '1px solid #fde68a' }}>
                <div className="card-body p-3 d-flex align-items-center justify-content-between flex-wrap gap-2">
                  <div className="d-flex align-items-center gap-2">
                    <i className="bi bi-info-circle-fill" style={{ color: '#d97706', fontSize: '1rem' }} />
                    <div className="small">
                      <strong>{selectedApc.name}</strong>
                      {' will move from '}
                      <span style={{ color: '#dc2626', fontWeight: 600 }}>{selectedApc.ownerName || 'no TL'}</span>
                      {' to '}
                      <span style={{ color: '#16a34a', fontWeight: 600 }}>{selectedTL.name}</span>
                      {`. ${(selectedApc.assignedBrands || []).length} brand${(selectedApc.assignedBrands || []).length === 1 ? '' : 's'} will follow.`}
                    </div>
                  </div>
                  <div className="d-flex gap-2">
                    <button className="btn btn-sm btn-outline-secondary px-3"
                      onClick={() => { setSelectedApcId(''); setSelectedTLId(''); }}
                      disabled={saving}>Cancel</button>
                    <button className="btn btn-sm btn-warning px-3 d-inline-flex align-items-center gap-1"
                      style={{ borderRadius: 8 }}
                      onClick={() => setConfirming(true)} disabled={saving}>
                      <i className="bi bi-arrow-left-right" /> Reassign
                    </button>
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
          <div style={{ position: 'absolute', inset: 0, background: 'rgba(15,23,42,0.5)' }} onClick={() => setConfirming(false)} />
          <div className="card border-0 shadow-lg" style={{ position: 'relative', maxWidth: 460, borderRadius: 14 }}>
            <div className="card-body p-4">
              <div className="d-flex align-items-center gap-3 mb-3">
                <div className="rounded-circle d-flex align-items-center justify-content-center"
                  style={{ width: 48, height: 48, background: '#fef3c7', color: '#d97706' }}>
                  <i className="bi bi-exclamation-triangle-fill" style={{ fontSize: '1.2rem' }} />
                </div>
                <div>
                  <h6 className="fw-bold mb-0">Confirm reassignment</h6>
                  <div className="text-muted small">This affects ownership and notifications.</div>
                </div>
              </div>
              <div className="mb-3 small">
                <div className="rounded-2 p-3" style={{ background: '#f8fafc', border: '1px solid #e2e8f0' }}>
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
                <button className="btn btn-sm btn-outline-secondary px-3" onClick={() => setConfirming(false)} disabled={saving}>Cancel</button>
                <button className="btn btn-sm btn-warning px-3 d-inline-flex align-items-center gap-1" onClick={handleReassign} disabled={saving}>
                  {saving ? <><span className="spinner-border spinner-border-sm" /> Reassigning…</> : <><i className="bi bi-check2" /> Confirm</>}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
