// VERBATIM PORT of v1 components/changes/ChangeManagementPage.js (722 LOC).
// Submitter-side view (everyone except Boss).
//
// Surgical patches only:
//   1. Firebase imports → changesApiV1 shim
//   2. useAuth() v2 shape → reconstruct v1's {currentUser, userRole}
//   3. createNotification dropped — v2 server-side trigger handles fan-out
//   4. onSnapshot → subscribeAllChanges / subscribeChangeThread
//   5. addDoc/updateDoc → submitChangeV1/updateChangeV1/postChangeMessageV1
import React, { useEffect, useState, useMemo } from 'react';
import { useAuth } from '../../contexts/AuthContext';
import {
  subscribeAllChanges, subscribeChangeThread,
  listAllUsersForChanges, listSopVersions, listSopDocs,
  submitChangeV1, updateChangeV1, postChangeMessageV1,
} from '../../lib/changesApiV1';

const SOP_TAB_MAP = { delivery_roadmap: 'delivery_roadmap', policies: 'policies', operational: 'operational_sops', training: 'training_sops' };

const SOP_TYPES = [
  { key: 'delivery_roadmap', label: 'Delivery Roadmap', icon: 'bi-map',           color: '#0ea5e9' },
  { key: 'policies',         label: 'Policies',         icon: 'bi-shield-check',  color: '#2563eb' },
  { key: 'operational',      label: 'Operational SOPs', icon: 'bi-gear-wide',     color: '#7c3aed' },
  { key: 'training',         label: 'Training SOPs',    icon: 'bi-mortarboard',   color: '#059669' },
];

const PRIORITIES = [
  { key: 'low',    label: 'Low',    color: '#6c757d', bg: '#f3f4f6' },
  { key: 'medium', label: 'Medium', color: '#fd7e14', bg: '#fff3e0' },
  { key: 'high',   label: 'High',   color: '#dc3545', bg: '#fce4ec' },
];

const STATUS_MAP = {
  pending:       { label: 'Pending Review', color: '#fd7e14', bg: '#fff3e0', icon: 'bi-clock' },
  approved:      { label: 'Approved',       color: '#198754', bg: '#e6f4ea', icon: 'bi-check-circle' },
  rejected:      { label: 'Rejected',       color: '#dc3545', bg: '#fce4ec', icon: 'bi-x-circle' },
  in_progress:   { label: 'In Progress',    color: '#0d6efd', bg: '#e8f0fe', icon: 'bi-arrow-repeat' },
  paused:        { label: 'Paused',         color: '#f59e0b', bg: '#fffbeb', icon: 'bi-pause-circle' },
  delayed:       { label: 'Delayed',        color: '#ef4444', bg: '#fef2f2', icon: 'bi-exclamation-triangle' },
  completed:     { label: 'Completed',      color: '#8b5cf6', bg: '#f5f3ff', icon: 'bi-check-circle-fill' },
  implemented:   { label: 'Implemented',    color: '#198754', bg: '#e6f4ea', icon: 'bi-check-all' },
};

const OWNER_STATUSES = [
  { key: 'in_progress', label: 'In Progress', icon: 'bi-arrow-repeat',        color: '#0d6efd' },
  { key: 'paused',      label: 'Paused',      icon: 'bi-pause-circle',        color: '#f59e0b' },
  { key: 'delayed',     label: 'Delayed',     icon: 'bi-exclamation-triangle', color: '#ef4444' },
  { key: 'completed',   label: 'Completed',   icon: 'bi-check-circle-fill',   color: '#8b5cf6' },
];

function fmtDate(ts) {
  if (!ts) return '—';
  const d = ts.toDate ? ts.toDate() : new Date(ts);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function fmtTime(ts) {
  if (!ts) return '';
  const d = ts.toDate ? ts.toDate() : new Date(ts);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) + ' ' + d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
}

/* ── Submit Modal ──────────────────────────────────────────────────────────── */
function SubmitModal({ onClose, onSubmitted, allUsers, sopVersions, sopDocs }) {
  const { user, profile } = useAuth();
  const currentUser = user ? { uid: user.id, email: user.email, displayName: profile?.display_name || '' } : null;
  const userRole = profile?.role || '';

  const [form, setForm] = useState({
    title: '', sopType: '', currentProcess: '', proposedChange: '',
    expectedImpact: '', risks: '', ownerId: '', priority: '',
    affectedSopIds: [],
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const f = (k, v) => setForm(p => ({ ...p, [k]: v }));

  const availableSopDocs = useMemo(() => {
    if (!form.sopType) return [];
    const tab = SOP_TAB_MAP[form.sopType];
    return (sopDocs || []).filter(d => d.tab === tab);
  }, [form.sopType, sopDocs]);

  const selectedSop = SOP_TYPES.find(s => s.key === form.sopType);
  const currentVersion = form.sopType ? (sopVersions[form.sopType] || 'v1.0') : '';
  const selectedOwner = allUsers.find(u => u.id === form.ownerId);

  const valid = form.title.trim() && form.sopType && form.currentProcess.trim() && form.proposedChange.trim() && form.ownerId;

  async function handleSubmit() {
    if (!valid) return;
    setSaving(true); setError('');
    try {
      const affectedNames = form.affectedSopIds.map(id => {
        const d = (sopDocs || []).find(x => x.id === id);
        return d?.title || '';
      }).filter(Boolean);
      await submitChangeV1({
        title: form.title, sopType: form.sopType,
        currentVersion,
        currentProcess: form.currentProcess, proposedChange: form.proposedChange,
        expectedImpact: form.expectedImpact, risks: form.risks,
        ownerId: form.ownerId, ownerName: selectedOwner?.name || '',
        priority: form.priority || null,
        affectedSopIds: form.affectedSopIds, affectedSopNames: affectedNames,
      });
      onSubmitted();
    } catch (err) { setError(err?.message || 'Failed.'); }
    finally { setSaving(false); }
  }

  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 1070, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
      <div style={{ position: 'absolute', inset: 0, background: 'rgba(0,0,0,0.5)', backdropFilter: 'blur(3px)' }} onClick={onClose} />
      <div className="card border-0 shadow-lg" style={{ position: 'relative', width: '100%', maxWidth: 600, zIndex: 1, borderRadius: 18, maxHeight: '92vh', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        <div className="px-4 pt-4 pb-2 flex-shrink-0" style={{ borderBottom: '1px solid #f1f5f9' }}>
          <h6 className="fw-bold mb-1">Submit Change Request</h6>
          <p className="text-muted small mb-0">Request a change to an SOP</p>
        </div>
        <div className="px-4 py-3 flex-grow-1" style={{ overflowY: 'auto' }}>
          {/* Title */}
          <div className="mb-3">
            <label className="form-label small fw-semibold">Change Title *</label>
            <input type="text" className="form-control form-control-sm" placeholder="Short and clear title..." value={form.title} onChange={e => f('title', e.target.value)} />
          </div>

          {/* SOP Type */}
          <div className="mb-3">
            <label className="form-label small fw-semibold">SOP Affected *</label>
            <div className="d-flex gap-2">
              {SOP_TYPES.map(s => (
                <button key={s.key} type="button" className="btn btn-sm flex-fill d-flex align-items-center justify-content-center gap-1"
                  style={{ borderRadius: 10, fontSize: '0.78rem', fontWeight: 600, padding: '8px 12px', background: form.sopType === s.key ? s.color : '#f8f9fa', color: form.sopType === s.key ? '#fff' : s.color, border: `2px solid ${form.sopType === s.key ? s.color : '#e2e8f0'}` }}
                  onClick={() => f('sopType', s.key)}>
                  <i className={`bi ${s.icon}`} />{s.label}
                </button>
              ))}
            </div>
            {currentVersion && (
              <div className="d-flex align-items-center gap-2 mt-2 rounded-2 px-3 py-2" style={{ background: '#eff6ff', border: '1px solid #bfdbfe' }}>
                <i className="bi bi-info-circle text-primary" style={{ fontSize: '0.75rem' }} />
                <span style={{ fontSize: '0.75rem', color: '#2563eb' }}>Current version: <strong>{currentVersion}</strong></span>
              </div>
            )}
          </div>

          {/* Affected SOP Documents */}
          {availableSopDocs.length > 0 && (
            <div className="mb-3">
              <label className="form-label small fw-semibold">Affected SOP Documents</label>
              <div className="rounded-2 p-2" style={{ background: '#f8f9fa', border: '1px solid #e9ecef', maxHeight: 150, overflowY: 'auto' }}>
                {availableSopDocs.map(d => {
                  const sel = form.affectedSopIds.includes(d.id);
                  return (
                    <div key={d.id} className="d-flex align-items-center gap-2 rounded-2 px-2 py-1 mb-1"
                      style={{ background: sel ? '#e8f0fe' : '#fff', border: `1px solid ${sel ? '#bfdbfe' : '#e9ecef'}`, cursor: 'pointer', transition: 'all 0.1s' }}
                      onClick={() => f('affectedSopIds', sel ? form.affectedSopIds.filter(x => x !== d.id) : [...form.affectedSopIds, d.id])}>
                      <input type="checkbox" className="form-check-input flex-shrink-0" checked={sel} readOnly style={{ cursor: 'pointer' }} />
                      <div className="flex-grow-1" style={{ minWidth: 0 }}>
                        <div className="fw-medium text-truncate" style={{ fontSize: '0.75rem' }}>{d.title}</div>
                        {d.version && <span className="text-muted" style={{ fontSize: '0.6rem' }}>{d.version}</span>}
                      </div>
                    </div>
                  );
                })}
              </div>
              <div className="text-muted mt-1" style={{ fontSize: '0.65rem' }}>Select which SOP documents will be affected by this change.</div>
            </div>
          )}

          {/* Current Process */}
          <div className="mb-3">
            <label className="form-label small fw-semibold">Current Process *</label>
            <textarea className="form-control form-control-sm" rows={3} placeholder="How does it currently work..." value={form.currentProcess} onChange={e => f('currentProcess', e.target.value)} />
          </div>

          {/* Proposed Change */}
          <div className="mb-3">
            <label className="form-label small fw-semibold">Proposed Change *</label>
            <textarea className="form-control form-control-sm" rows={3} placeholder="What should change and why..." value={form.proposedChange} onChange={e => f('proposedChange', e.target.value)} />
          </div>

          {/* Impact & Risks */}
          <div className="row g-3 mb-3">
            <div className="col-6">
              <label className="form-label small fw-semibold">Expected Impact</label>
              <textarea className="form-control form-control-sm" rows={2} placeholder="Improvements expected..." value={form.expectedImpact} onChange={e => f('expectedImpact', e.target.value)} />
            </div>
            <div className="col-6">
              <label className="form-label small fw-semibold">Risks</label>
              <textarea className="form-control form-control-sm" rows={2} placeholder="Potential downsides..." value={form.risks} onChange={e => f('risks', e.target.value)} />
            </div>
          </div>

          {/* Owner */}
          <div className="mb-3">
            <label className="form-label small fw-semibold">Implementation Owner *</label>
            <select className="form-select form-select-sm" value={form.ownerId} onChange={e => f('ownerId', e.target.value)}>
              <option value="">Select a person...</option>
              {allUsers.map(u => <option key={u.id} value={u.id}>{u.name} ({u.role})</option>)}
            </select>
          </div>

          {/* Priority */}
          <div className="mb-3">
            <label className="form-label small fw-semibold">Priority</label>
            <div className="d-flex gap-2">
              {PRIORITIES.map(p => (
                <button key={p.key} type="button" className="btn btn-sm px-3"
                  style={{ borderRadius: 8, fontSize: '0.75rem', fontWeight: 600, background: form.priority === p.key ? p.color : p.bg, color: form.priority === p.key ? '#fff' : p.color, border: `1.5px solid ${p.color}40` }}
                  onClick={() => f('priority', form.priority === p.key ? '' : p.key)}>{p.label}</button>
              ))}
            </div>
          </div>

          {error && <div className="alert alert-danger py-2 small">{error}</div>}
        </div>
        <div className="px-4 py-3 flex-shrink-0 d-flex gap-2 justify-content-end" style={{ borderTop: '1px solid #f1f5f9' }}>
          <button className="btn btn-sm btn-outline-secondary px-3" onClick={onClose} disabled={saving}>Cancel</button>
          <button className="btn btn-sm btn-dark px-4 d-inline-flex align-items-center gap-1" onClick={handleSubmit} disabled={saving || !valid}>
            {saving ? <><span className="spinner-border spinner-border-sm" /> Submitting...</> : <><i className="bi bi-send" /> Submit</>}
          </button>
        </div>
      </div>
    </div>
  );
}

/* ── Discussion Thread ─────────────────────────────────────────────────────── */
function ChangeThread({ changeId, changeDocId, participants }) {
  const { user, profile } = useAuth();
  const currentUser = user ? { uid: user.id, email: user.email, displayName: profile?.display_name || '' } : null;
  const userRole = profile?.role || '';
  const [messages, setMessages] = useState([]);
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const userName = currentUser?.displayName || currentUser?.email?.split('@')[0] || 'User';

  useEffect(() => {
    const unsub = subscribeChangeThread(changeDocId, (msgs) => setMessages(msgs));
    return unsub;
  }, [changeDocId]);

  async function handleSend() {
    if (!text.trim()) return;
    setSending(true);
    try {
      await postChangeMessageV1(changeDocId, text.trim(), { userRole: userRole || 'user' });
      setText('');
    } catch { /* ignore */ } finally { setSending(false); }
  }

  const roleColors = { boss: '#dc2626', tl: '#0d6efd', ol: '#6610f2', apc: '#198754', pctl: '#0ea5e9', ipc: '#14b8a6' };

  return (
    <div className="mt-3">
      <div className="d-flex align-items-center gap-2 mb-2">
        <i className="bi bi-chat-left-dots" style={{ fontSize: '0.72rem', color: '#64748b' }} />
        <span className="fw-semibold" style={{ fontSize: '0.72rem', color: '#475569' }}>Discussion Thread</span>
        <span className="text-muted" style={{ fontSize: '0.6rem' }}>({messages.length})</span>
      </div>

      {/* Participants */}
      <div className="d-flex gap-1 mb-2 flex-wrap">
        {participants.filter(p => p.id).map(p => (
          <span key={p.id} className="badge rounded-pill d-inline-flex align-items-center gap-1"
            style={{ background: '#f1f5f9', color: '#475569', fontSize: '0.58rem', fontWeight: 500 }}>
            <span className="rounded-circle d-inline-flex align-items-center justify-content-center text-white fw-bold"
              style={{ width: 14, height: 14, background: roleColors[p.role] || '#6c757d', fontSize: '0.4rem' }}>
              {(p.name || '?').slice(0, 1).toUpperCase()}
            </span>
            {p.name} <span className="text-muted">({p.roleLabel})</span>
          </span>
        ))}
      </div>

      {/* Messages */}
      {messages.length > 0 && (
        <div className="d-flex flex-column gap-1 mb-2" style={{ maxHeight: 240, overflowY: 'auto' }}>
          {messages.map(m => {
            const isMe = m.userId === currentUser.uid;
            const isSysMsg = m.type === 'status_change';
            if (isSysMsg) {
              return (
                <div key={m.id} className="text-center py-1">
                  <span className="badge rounded-pill" style={{ background: '#f1f5f9', color: '#64748b', fontSize: '0.58rem', fontWeight: 500 }}>
                    <i className="bi bi-arrow-repeat me-1" />{m.text}
                  </span>
                  <div className="text-muted" style={{ fontSize: '0.52rem' }}>{fmtTime(m.createdAt)}</div>
                </div>
              );
            }
            return (
              <div key={m.id} className={`d-flex ${isMe ? 'justify-content-end' : 'justify-content-start'}`}>
                <div className="rounded-3 px-3 py-2" style={{
                  maxWidth: '80%', background: isMe ? '#0d6efd' : '#f1f5f9',
                  color: isMe ? '#fff' : '#1e293b', borderRadius: isMe ? '14px 14px 4px 14px' : '14px 14px 14px 4px',
                }}>
                  {!isMe && (
                    <div className="d-flex align-items-center gap-1 mb-1">
                      <span className="fw-semibold" style={{ fontSize: '0.65rem', color: roleColors[m.userRole] || '#6c757d' }}>{m.userName}</span>
                    </div>
                  )}
                  <div style={{ fontSize: '0.78rem', whiteSpace: 'pre-wrap' }}>{m.text}</div>
                  <div className="text-end" style={{ fontSize: '0.52rem', opacity: 0.7, marginTop: 2 }}>{fmtTime(m.createdAt)}</div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Input */}
      <div className="d-flex gap-2">
        <input type="text" className="form-control form-control-sm" style={{ borderRadius: 10 }}
          placeholder="Type a message…" value={text}
          onChange={e => setText(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend(); } }} />
        <button className="btn btn-sm btn-dark flex-shrink-0 d-inline-flex align-items-center gap-1"
          style={{ borderRadius: 10 }} onClick={handleSend} disabled={sending || !text.trim()}>
          <i className="bi bi-send" style={{ fontSize: '0.7rem' }} />
        </button>
      </div>
    </div>
  );
}

/* ── Detail Modal ──────────────────────────────────────────────────────────── */
function DetailModal({ change, onStatusUpdate, isOwner, isBoss, isSubmitter, allUsers, onClose }) {
  const { user, profile } = useAuth();
  const currentUser = user ? { uid: user.id, email: user.email, displayName: profile?.display_name || '' } : null;
  const userRole = profile?.role || '';
  const st = STATUS_MAP[change.status] || STATUS_MAP.pending;
  const sop = SOP_TYPES.find(s => s.key === change.sopType);
  const pr = PRIORITIES.find(p => p.key === change.priority);
  const [updating, setUpdating] = useState(false);

  const canOwnerAct = isOwner && ['approved', 'in_progress', 'paused', 'delayed'].includes(change.status);

  async function handleOwnerStatus(newStatus) {
    setUpdating(true);
    try { await onStatusUpdate(change, newStatus); } finally { setUpdating(false); }
  }

  const participants = useMemo(() => {
    const pMap = {};
    if (change.submittedBy) pMap[change.submittedBy] = { id: change.submittedBy, name: change.submittedByName, role: change.submittedByRole, roleLabel: 'Requester' };
    if (change.ownerId) {
      const ownerUser = allUsers.find(u => u.id === change.ownerId);
      pMap[change.ownerId] = { id: change.ownerId, name: change.ownerName || ownerUser?.name || '', role: ownerUser?.role?.toLowerCase() || 'tl', roleLabel: 'Owner' };
    }
    allUsers.filter(u => u.role === 'Boss').forEach(b => {
      if (!pMap[b.id]) pMap[b.id] = { id: b.id, name: b.name, role: 'boss', roleLabel: 'Boss' };
    });
    return Object.values(pMap);
  }, [change, allUsers]);

  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 1070, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
      <div style={{ position: 'absolute', inset: 0, background: 'rgba(0,0,0,0.5)', backdropFilter: 'blur(3px)' }} onClick={onClose} />
      <div className="card border-0 shadow-lg" style={{ position: 'relative', width: '100%', maxWidth: 620, zIndex: 1, borderRadius: 18, maxHeight: '92vh', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        <div className="px-4 pt-4 pb-2 flex-shrink-0" style={{ borderBottom: '1px solid #f1f5f9' }}>
          <div className="d-flex align-items-start justify-content-between">
            <div>
              <h6 className="fw-bold mb-1">{change.title}</h6>
              <div className="d-flex gap-2 flex-wrap">
                <span className="badge rounded-pill" style={{ background: st.bg, color: st.color, fontSize: '0.62rem' }}><i className={`bi ${st.icon} me-1`} />{st.label}</span>
                <span className="badge rounded-pill" style={{ background: '#f1f5f9', color: '#64748b', fontSize: '0.62rem' }}>{change.changeId}</span>
                {sop && <span className="badge rounded-pill" style={{ background: `${sop.color}15`, color: sop.color, fontSize: '0.62rem' }}><i className={`bi ${sop.icon} me-1`} />{sop.label}</span>}
                {pr && <span className="badge rounded-pill" style={{ background: pr.bg, color: pr.color, fontSize: '0.62rem' }}>{pr.label}</span>}
              </div>
            </div>
            <button className="btn btn-sm btn-light border-0 rounded-circle" onClick={onClose} style={{ width: 32, height: 32 }}><i className="bi bi-x-lg" style={{ fontSize: '0.8rem' }} /></button>
          </div>
        </div>
        <div className="px-4 py-3 flex-grow-1" style={{ overflowY: 'auto' }}>
          {/* Meta */}
          <div className="row g-2 mb-3">
            {[
              { l: 'Submitted By', v: change.submittedByName },
              { l: 'Date', v: fmtDate(change.dateSubmitted) },
              { l: 'Current Version', v: change.currentVersion || '—' },
              { l: 'New Version', v: change.newVersion || '—' },
              { l: 'Owner', v: change.ownerName || '—' },
              { l: 'Start', v: fmtDate(change.implementationStart) },
              { l: 'End', v: fmtDate(change.implementationEnd) },
              { l: 'Approved By', v: change.approvedBy || '—' },
            ].map(ff => (
              <div key={ff.l} className="col-6 col-md-3">
                <div style={{ fontSize: '0.58rem', color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '0.05em' }}>{ff.l}</div>
                <div className="small fw-medium">{ff.v}</div>
              </div>
            ))}
          </div>

          {(change.affectedSopNames || []).length > 0 && (
            <div className="mb-3">
              <div className="text-muted small fw-semibold mb-1" style={{ fontSize: '0.68rem' }}>Affected SOP Documents</div>
              <div className="d-flex gap-1 flex-wrap">
                {change.affectedSopNames.map((name, i) => (
                  <span key={i} className="badge rounded-pill" style={{ background: '#f5f3ff', color: '#7c3aed', fontSize: '0.62rem', border: '1px solid #ddd6fe' }}>
                    <i className="bi bi-file-earmark-text me-1" />{name}
                  </span>
                ))}
              </div>
            </div>
          )}

          {[
            { l: 'Current Process', v: change.currentProcess },
            { l: 'Proposed Change', v: change.proposedChange },
            { l: 'Expected Impact', v: change.expectedImpact },
            { l: 'Risks', v: change.risks },
          ].filter(ff => ff.v).map(ff => (
            <div key={ff.l} className="mb-3">
              <div className="text-muted small fw-semibold mb-1" style={{ fontSize: '0.68rem' }}>{ff.l}</div>
              <div className="rounded-2 p-2 small" style={{ background: '#f8f9fa', whiteSpace: 'pre-wrap' }}>{ff.v}</div>
            </div>
          ))}

          {change.rejectionReason && (
            <div className="rounded-3 p-3 mb-2" style={{ background: '#fef2f2', border: '1px solid #fecaca' }}>
              <div className="small fw-semibold text-danger mb-1"><i className="bi bi-x-circle me-1" />Rejection Reason</div>
              <div className="small">{change.rejectionReason}</div>
            </div>
          )}

          {change.bossComment && (
            <div className="rounded-3 p-3 mb-2" style={{ background: '#eff6ff', border: '1px solid #bfdbfe' }}>
              <div className="small fw-semibold text-primary mb-1"><i className="bi bi-chat-left-text me-1" />Boss Comment</div>
              <div className="small">{change.bossComment}</div>
            </div>
          )}

          {canOwnerAct && (
            <div className="rounded-3 p-3 mb-3" style={{ background: '#fafafa', border: '1px solid #e2e8f0' }}>
              <div className="fw-semibold small mb-2" style={{ fontSize: '0.72rem', color: '#334155' }}>
                <i className="bi bi-toggles me-1" />Update Status
              </div>
              <div className="d-flex gap-2 flex-wrap">
                {OWNER_STATUSES.filter(s => s.key !== change.status).map(s => (
                  <button key={s.key} className="btn btn-sm d-inline-flex align-items-center gap-1 px-3"
                    style={{ borderRadius: 8, fontSize: '0.75rem', fontWeight: 600, background: s.color, color: '#fff', border: 'none', opacity: updating ? 0.6 : 1 }}
                    onClick={() => handleOwnerStatus(s.key)} disabled={updating}>
                    {updating ? <span className="spinner-border spinner-border-sm" /> : <i className={`bi ${s.icon}`} />}
                    {s.label}
                  </button>
                ))}
              </div>
            </div>
          )}

          {change.status !== 'pending' && change.status !== 'rejected' && (
            <ChangeThread changeId={change.changeId} changeDocId={change.id} participants={participants} />
          )}
        </div>
        <div className="px-4 py-3 flex-shrink-0" style={{ borderTop: '1px solid #f1f5f9' }}>
          <button className="btn btn-sm btn-outline-secondary px-3 w-100" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}

/* ── Main Page ─────────────────────────────────────────────────────────────── */
export default function ChangeManagementPage() {
  const { user, profile } = useAuth();
  const currentUser = user ? { uid: user.id, email: user.email, displayName: profile?.display_name || '' } : null;

  const [changes, setChanges] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showSubmit, setShowSubmit] = useState(false);
  const [viewChange, setViewChange] = useState(null);
  const [allUsers, setAllUsers] = useState([]);
  const [sopVersions, setSopVersions] = useState({});
  const [sopDocs, setSopDocs] = useState([]);
  const [viewTab, setViewTab] = useState('my');

  const [search, setSearch] = useState('');
  const [sopFilter, setSopFilter] = useState('all');
  const [statusFilter, setStatusFilter] = useState('all');

  // Realtime listener (capped to 500)
  useEffect(() => {
    const unsub = subscribeAllChanges(
      (rows) => { setChanges(rows); setLoading(false); },
      () => setLoading(false),
    );
    return unsub;
  }, []);

  useEffect(() => {
    Promise.all([
      listAllUsersForChanges(),
      listSopVersions(),
      listSopDocs(),
    ]).then(([us, vs, docs]) => {
      setAllUsers(us);
      setSopVersions(vs);
      setSopDocs(docs);
    });
  }, []);

  async function handleStatusUpdate(change, newStatus) {
    const userName = currentUser?.displayName || currentUser?.email?.split('@')[0] || '';
    const statusLabel = STATUS_MAP[newStatus]?.label || newStatus;
    const patch = { status: newStatus };
    if (newStatus === 'completed') patch.completedAt = new Date().toISOString();
    await updateChangeV1(change.id, patch);
    // System message in thread
    await postChangeMessageV1(change.id, `${userName} changed status to ${statusLabel}`, { userRole: 'system', type: 'status_change' });
    setViewChange(prev => prev ? { ...prev, status: newStatus } : null);
  }

  const myChanges = useMemo(() => changes.filter(c => c.submittedBy === currentUser?.uid), [changes, currentUser?.uid]);
  const assignedChanges = useMemo(() => changes.filter(c => c.ownerId === currentUser?.uid && c.submittedBy !== currentUser?.uid), [changes, currentUser?.uid]);
  const activeList = viewTab === 'my' ? myChanges : assignedChanges;

  const filtered = useMemo(() => {
    let list = activeList;
    if (search) { const s = search.toLowerCase(); list = list.filter(c => c.title.toLowerCase().includes(s) || c.changeId.toLowerCase().includes(s)); }
    if (sopFilter !== 'all') list = list.filter(c => c.sopType === sopFilter);
    if (statusFilter !== 'all') list = list.filter(c => c.status === statusFilter);
    return list;
  }, [activeList, search, sopFilter, statusFilter]);

  const stats = {
    total: myChanges.length,
    pending: myChanges.filter(c => c.status === 'pending').length,
    approved: myChanges.filter(c => ['approved', 'in_progress', 'implemented', 'completed'].includes(c.status)).length,
    rejected: myChanges.filter(c => c.status === 'rejected').length,
  };

  return (
    <div>
      <div className="d-flex align-items-start justify-content-between mb-4 flex-wrap gap-3">
        <div>
          <h4 className="fw-bold mb-1" style={{ color: '#0f172a' }}>Change Management</h4>
          <p className="text-muted small mb-0">Submit and track SOP change requests</p>
        </div>
        <div className="d-flex gap-2">
          {['my', 'assigned'].map(t => (
            <button key={t} className={`btn btn-sm px-3 ${viewTab === t ? 'btn-dark' : 'btn-outline-secondary'}`}
              style={{ borderRadius: 8, fontSize: '0.82rem', fontWeight: 600 }} onClick={() => setViewTab(t)}>
              {t === 'my' ? 'My Requests' : 'Assigned to Me'}
              {t === 'assigned' && assignedChanges.length > 0 && (
                <span className="badge bg-primary rounded-pill ms-1" style={{ fontSize: '0.55rem' }}>{assignedChanges.length}</span>
              )}
            </button>
          ))}
          <button className="btn btn-sm btn-dark d-inline-flex align-items-center gap-1" onClick={() => setShowSubmit(true)}>
            <i className="bi bi-plus-lg" /> Submit Change
          </button>
        </div>
      </div>

      <div className="d-flex gap-2 flex-wrap mb-4">
        {[
          { label: 'Total', value: stats.total, color: '#3b82f6', bg: '#eff6ff' },
          { label: 'Pending', value: stats.pending, color: '#fd7e14', bg: '#fff3e0' },
          { label: 'Approved', value: stats.approved, color: '#198754', bg: '#e6f4ea' },
          { label: 'Rejected', value: stats.rejected, color: '#dc3545', bg: '#fce4ec' },
        ].map(s => (
          <div key={s.label} className="rounded-3 px-3 py-2 text-center" style={{ background: s.bg, minWidth: 80 }}>
            <div className="fw-bold" style={{ fontSize: '1.1rem', color: s.color }}>{s.value}</div>
            <div style={{ fontSize: '0.58rem', color: s.color, textTransform: 'uppercase', letterSpacing: '0.06em', fontWeight: 600 }}>{s.label}</div>
          </div>
        ))}
      </div>

      <div className="d-flex gap-2 mb-3 flex-wrap">
        <div className="input-group input-group-sm" style={{ maxWidth: 230 }}>
          <span className="input-group-text border-0" style={{ background: '#f1f5f9' }}><i className="bi bi-search text-muted" style={{ fontSize: '0.7rem' }} /></span>
          <input type="text" className="form-control border-0" placeholder="Search..." value={search} onChange={e => setSearch(e.target.value)} style={{ background: '#f1f5f9' }} />
        </div>
        <select className="form-select form-select-sm" value={sopFilter} onChange={e => setSopFilter(e.target.value)} style={{ maxWidth: 170 }}>
          <option value="all">All SOPs</option>
          {SOP_TYPES.map(s => <option key={s.key} value={s.key}>{s.label}</option>)}
        </select>
        <select className="form-select form-select-sm" value={statusFilter} onChange={e => setStatusFilter(e.target.value)} style={{ maxWidth: 160 }}>
          <option value="all">All Status</option>
          {Object.entries(STATUS_MAP).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
        </select>
      </div>

      {loading ? (
        <div className="text-center py-4"><div className="spinner-border text-primary" /></div>
      ) : filtered.length === 0 ? (
        <div className="text-center py-5" style={{ border: '2px dashed var(--border-subtle)', borderRadius: 16, background: 'var(--surface-1)' }}>
          <i className="bi bi-file-earmark-diff text-muted" style={{ fontSize: '2.5rem', opacity: 0.55 }} />
          <p className="mt-3 mb-0" style={{ color: 'var(--text-muted)' }}>{changes.length === 0 ? 'No change requests yet.' : 'No matching results.'}</p>
        </div>
      ) : (
        <div className="d-flex flex-column gap-2">
          {filtered.map(c => {
            const st = STATUS_MAP[c.status] || STATUS_MAP.pending;
            const sop = SOP_TYPES.find(s => s.key === c.sopType);
            return (
              <div key={c.id} className="card border-0 shadow-sm" style={{ borderRadius: 14, cursor: 'pointer' }} onClick={() => setViewChange(c)}>
                <div className="card-body p-3 d-flex align-items-center gap-3">
                  <div className="rounded-2 d-flex align-items-center justify-content-center flex-shrink-0" style={{ width: 38, height: 38, background: st.bg }}>
                    <i className={`bi ${st.icon}`} style={{ color: st.color, fontSize: '1rem' }} />
                  </div>
                  <div className="flex-grow-1" style={{ minWidth: 0 }}>
                    <div className="fw-semibold small text-truncate">{c.title}</div>
                    <div className="d-flex gap-2 mt-1 flex-wrap">
                      <span className="text-muted" style={{ fontSize: '0.65rem' }}>{c.changeId}</span>
                      {sop && <span className="badge rounded-pill" style={{ background: `${sop.color}12`, color: sop.color, fontSize: '0.55rem' }}>{sop.label}</span>}
                      {viewTab === 'assigned' && <span className="badge rounded-pill" style={{ background: '#f5f3ff', color: '#7c3aed', fontSize: '0.55rem' }}>Owner</span>}
                      {(c.affectedSopNames || []).length > 0 && <span className="text-muted" style={{ fontSize: '0.6rem' }}>{c.affectedSopNames.length} SOP{c.affectedSopNames.length > 1 ? 's' : ''} affected</span>}
                      <span className="text-muted" style={{ fontSize: '0.65rem' }}>{fmtDate(c.dateSubmitted)}</span>
                    </div>
                  </div>
                  <span className="badge rounded-pill" style={{ background: st.bg, color: st.color, fontSize: '0.6rem' }}>{st.label}</span>
                  <i className="bi bi-chevron-right text-muted" style={{ fontSize: '0.7rem' }} />
                </div>
              </div>
            );
          })}
        </div>
      )}

      {showSubmit && <SubmitModal onClose={() => setShowSubmit(false)} onSubmitted={() => setShowSubmit(false)} allUsers={allUsers} sopVersions={sopVersions} sopDocs={sopDocs} />}
      {viewChange && <DetailModal change={viewChange} onClose={() => setViewChange(null)} onStatusUpdate={handleStatusUpdate}
        isOwner={viewChange.ownerId === currentUser?.uid}
        isBoss={false}
        isSubmitter={viewChange.submittedBy === currentUser?.uid}
        allUsers={allUsers} />}
    </div>
  );
}
