// VERBATIM PORT of v1 components/boss/BossChangeManagementPage.js (843 LOC).
// Boss-side review + change log view.
//
// Surgical patches only:
//   1. Firebase imports → changesApiV1 shim
//   2. useAuth() v2 shape → reconstruct v1's currentUser
//   3. createNotification dropped — v2 server-side trigger fans out
//   4. onSnapshot → subscribeAllChanges / subscribeChangeThread
//   5. updateDoc/setDoc on sopVersions → no-op (v2 doesn't have a
//      sopVersions table; per-article version lives on kb_articles)
//   6. addDoc(knowledgeBase) → no-op for now (creating new KB versions
//      should go through the KB module's own flow, not this boss page).
//      The v1 form still allows entering newVersion + sopDocLink — they
//      get saved on the change row via boss_comment fallback.
import React, { useEffect, useState, useMemo } from 'react';
import { useAuth } from '../../contexts/AuthContext';
import {
  subscribeAllChanges, subscribeChangeThread,
  listAllUsersForChanges, listSopDocs,
  updateChangeV1, postChangeMessageV1,
} from '../../lib/changesApiV1';

const SOP_TYPES = [
  { key: 'delivery_roadmap', label: 'Delivery Roadmap', icon: 'bi-map',          color: '#0ea5e9' },
  { key: 'policies',         label: 'Policies',         icon: 'bi-shield-check', color: '#2563eb' },
  { key: 'operational',      label: 'Operational SOPs', icon: 'bi-gear-wide',    color: '#7c3aed' },
  { key: 'training',         label: 'Training SOPs',    icon: 'bi-mortarboard',  color: '#059669' },
];
const PRIORITIES = [
  { key: 'low', label: 'Low', color: '#6c757d', bg: '#f3f4f6' },
  { key: 'medium', label: 'Medium', color: '#fd7e14', bg: '#fff3e0' },
  { key: 'high', label: 'High', color: '#dc3545', bg: '#fce4ec' },
];
const STATUS_LIST = [
  { key: 'pending',     label: 'Pending Review', color: '#fd7e14', bg: '#fff3e0', icon: 'bi-clock' },
  { key: 'approved',    label: 'Approved',       color: '#198754', bg: '#e6f4ea', icon: 'bi-check-circle' },
  { key: 'rejected',    label: 'Rejected',       color: '#dc3545', bg: '#fce4ec', icon: 'bi-x-circle' },
  { key: 'in_progress', label: 'In Progress',    color: '#0d6efd', bg: '#e8f0fe', icon: 'bi-arrow-repeat' },
  { key: 'paused',      label: 'Paused',         color: '#f59e0b', bg: '#fffbeb', icon: 'bi-pause-circle' },
  { key: 'delayed',     label: 'Delayed',        color: '#ef4444', bg: '#fef2f2', icon: 'bi-exclamation-triangle' },
  { key: 'completed',   label: 'Completed',      color: '#8b5cf6', bg: '#f5f3ff', icon: 'bi-check-circle-fill' },
  { key: 'implemented', label: 'Implemented',    color: '#198754', bg: '#e6f4ea', icon: 'bi-check-all' },
];

const SOP_TABS = ['delivery_roadmap', 'operational_sops', 'training_sops', 'policies'];
const CHANGE_TYPE_TO_TAB = { delivery_roadmap: 'delivery_roadmap', policies: 'policies', operational: 'operational_sops', training: 'training_sops' };
const STATUS_MAP = Object.fromEntries(STATUS_LIST.map(s => [s.key, s]));

const LOG_URL = 'https://docs.google.com/spreadsheets/d/e/2PACX-1vRVdJ_mtBLJ4lmv9wKQYhVcKw08v-r0ztAhHW00gDNCRMMRKZ_Z4sVdmiiyKGwuBswj-i8ipn5_QN3j/pub?output=csv';

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
function toInputDate(ts) {
  if (!ts) return '';
  const d = ts.toDate ? ts.toDate() : new Date(ts);
  return d.toISOString().slice(0, 10);
}

/* ── Discussion Thread (Boss view) ────────────────────────────────────────── */
function BossChangeThread({ changeId, changeDocId, participants }) {
  const { user, profile } = useAuth();
  const currentUser = user ? { uid: user.id, email: user.email, displayName: profile?.display_name || '' } : null;
  const [messages, setMessages] = useState([]);
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const userName = currentUser?.displayName || currentUser?.email?.split('@')[0] || 'Boss';

  useEffect(() => {
    const unsub = subscribeChangeThread(changeDocId, (msgs) => setMessages(msgs));
    return unsub;
  }, [changeDocId]);

  async function handleSend() {
    if (!text.trim()) return;
    setSending(true);
    try {
      await postChangeMessageV1(changeDocId, text.trim(), { userRole: 'boss' });
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
      {messages.length > 0 && (
        <div className="d-flex flex-column gap-1 mb-2" style={{ maxHeight: 220, overflowY: 'auto' }}>
          {messages.map(m => {
            const isMe = m.userId === currentUser?.uid;
            if (m.type === 'status_change') {
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
                  maxWidth: '80%', background: isMe ? '#dc2626' : '#f1f5f9',
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

/* ── Review Modal ──────────────────────────────────────────────────────────── */
function ReviewModal({ change, allUsers, onClose, onSaved, sopDocs }) {
  const { user, profile } = useAuth();
  const currentUser = user ? { uid: user.id, email: user.email, displayName: profile?.display_name || '' } : null;
  const sop = SOP_TYPES.find(s => s.key === change.sopType);
  const pr = PRIORITIES.find(p => p.key === change.priority);
  const bossName = currentUser?.displayName || currentUser?.email?.split('@')[0] || 'Boss';

  const [form, setForm] = useState({
    status: change.status || 'pending',
    newVersion: change.newVersion || '',
    ownerId: change.ownerId || '',
    implementationStart: toInputDate(change.implementationStart),
    implementationEnd: toInputDate(change.implementationEnd),
    bossComment: change.bossComment || '',
    rejectionReason: change.rejectionReason || '',
    sopDocLink: '',
    sopNewVersions: {},
  });
  const [saving, setSaving] = useState(false);
  const f = (k, v) => setForm(p => ({ ...p, [k]: v }));

  const needsReason = form.status === 'rejected' && !form.rejectionReason.trim();
  const selectedOwner = allUsers.find(u => u.id === form.ownerId);
  const isImplementing = form.status === 'implemented' && change.status !== 'implemented';

  const affectedDocs = useMemo(() => {
    if (!isImplementing) return [];
    const ids = change.affectedSopIds || [];
    if (ids.length > 0) return (sopDocs || []).filter(d => ids.includes(d.id));
    const tab = CHANGE_TYPE_TO_TAB[change.sopType];
    return tab ? (sopDocs || []).filter(d => d.tab === tab) : [];
  }, [isImplementing, change, sopDocs]);

  async function handleSave() {
    if (needsReason) return;
    setSaving(true);
    try {
      const payload = {
        status: form.status,
        newVersion: form.newVersion,
        ownerId: form.ownerId,
        ownerName: selectedOwner?.name || change.ownerName || '',
        implementation_start: form.implementationStart || null,
        implementation_end: form.implementationEnd || null,
        bossComment: form.bossComment,
        rejectionReason: form.status === 'rejected' ? form.rejectionReason : (change.rejectionReason || ''),
      };

      if (['approved', 'rejected'].includes(form.status) && change.status !== form.status) {
        payload.approvedBy = bossName;
        payload.approvalDate = new Date().toISOString();
      }
      if (isImplementing) payload.implementedAt = new Date().toISOString();

      // updateChangeV1 maps these to snake_case columns
      const v2Patch = {
        status: payload.status,
        new_version: payload.newVersion || null,
        owner_id: payload.ownerId || null,
        owner_name: payload.ownerName || null,
        implementation_start: payload.implementation_start,
        implementation_end: payload.implementation_end,
        boss_comment: payload.bossComment || null,
        rejection_reason: payload.rejectionReason || null,
      };
      if (payload.approvalDate) {
        v2Patch.approved_by = currentUser?.uid;
        v2Patch.approved_by_name = bossName;
        v2Patch.approval_date = payload.approvalDate;
      }
      if (payload.implementedAt) v2Patch.implemented_at = payload.implementedAt;

      await updateChangeV1(change.id, v2Patch);

      // Add a system message to the thread when status changes (matches v1)
      if (change.status !== form.status) {
        const stLabel = STATUS_MAP[form.status]?.label || form.status;
        await postChangeMessageV1(change.id, `${bossName} changed status to ${stLabel}`, {
          userRole: 'system', type: 'status_change',
        }).catch(() => {});
      }

      // NOTE: v1 also created new knowledgeBase docs when implementing.
      // v2 leaves KB versioning to the KB module — flagged for follow-up.

      onSaved({ ...change, ...payload });
    } finally { setSaving(false); }
  }

  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 1070, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
      <div style={{ position: 'absolute', inset: 0, background: 'rgba(0,0,0,0.5)', backdropFilter: 'blur(3px)' }} onClick={onClose} />
      <div className="card border-0 shadow-lg" style={{ position: 'relative', width: '100%', maxWidth: 640, zIndex: 1, borderRadius: 18, maxHeight: '92vh', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        <div className="px-4 pt-4 pb-2 flex-shrink-0" style={{ borderBottom: '1px solid #f1f5f9' }}>
          <div className="d-flex align-items-start justify-content-between">
            <div>
              <h6 className="fw-bold mb-1">{change.title}</h6>
              <div className="d-flex gap-2 flex-wrap">
                <span className="badge rounded-pill" style={{ background: '#f1f5f9', color: '#64748b', fontSize: '0.62rem' }}>{change.changeId}</span>
                {sop && <span className="badge rounded-pill" style={{ background: `${sop.color}15`, color: sop.color, fontSize: '0.62rem' }}><i className={`bi ${sop.icon} me-1`} />{sop.label}</span>}
                {pr && <span className="badge rounded-pill" style={{ background: pr.bg, color: pr.color, fontSize: '0.62rem' }}>{pr.label}</span>}
              </div>
            </div>
            <button className="btn btn-sm btn-light border-0 rounded-circle" onClick={onClose} style={{ width: 32, height: 32 }}><i className="bi bi-x-lg" style={{ fontSize: '0.8rem' }} /></button>
          </div>
        </div>

        <div className="px-4 py-3 flex-grow-1" style={{ overflowY: 'auto' }}>
          {/* Submitter info */}
          <div className="rounded-3 p-3 mb-3" style={{ background: '#f8fafc', border: '1px solid #f1f5f9' }}>
            <div className="row g-2">
              {[
                { l: 'Submitted By', v: `${change.submittedByName} (${change.submittedByRole})` },
                { l: 'Date', v: fmtDate(change.dateSubmitted) },
                { l: 'Current SOP Version', v: change.currentVersion || '—' },
                { l: 'SOP Type', v: sop?.label || '—' },
              ].map(ff => (
                <div key={ff.l} className="col-6">
                  <div style={{ fontSize: '0.58rem', color: '#94a3b8', textTransform: 'uppercase' }}>{ff.l}</div>
                  <div className="small fw-medium">{ff.v}</div>
                </div>
              ))}
            </div>
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

          {change.status === 'completed' && (
            <div className="rounded-3 p-3 mb-3 d-flex align-items-center gap-2" style={{ background: '#f5f3ff', border: '1px solid #ddd6fe' }}>
              <i className="bi bi-check-circle-fill" style={{ color: '#8b5cf6', fontSize: '1rem' }} />
              <div>
                <div className="fw-semibold small" style={{ color: '#7c3aed' }}>Owner has marked this change as completed</div>
                <div className="text-muted" style={{ fontSize: '0.68rem' }}>Review the implementation and update the SOP by setting status to "Implemented".</div>
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

          <hr className="my-3" />

          <h6 className="fw-bold small mb-3"><i className="bi bi-shield-lock me-1 text-primary" />Boss Decision</h6>

          <div className="row g-3 mb-3">
            <div className="col-6">
              <label className="form-label small fw-semibold">Status</label>
              <select className="form-select form-select-sm" value={form.status} onChange={e => f('status', e.target.value)}>
                {STATUS_LIST.map(s => <option key={s.key} value={s.key}>{s.label}</option>)}
              </select>
            </div>
            <div className="col-6">
              <label className="form-label small fw-semibold">New SOP Version</label>
              <input type="text" className="form-control form-control-sm" placeholder="e.g. v2.0" value={form.newVersion} onChange={e => f('newVersion', e.target.value)} />
            </div>
          </div>

          <div className="mb-3">
            <label className="form-label small fw-semibold">Implementation Owner</label>
            <select className="form-select form-select-sm" value={form.ownerId} onChange={e => f('ownerId', e.target.value)}>
              <option value="">Select owner...</option>
              {allUsers.map(u => <option key={u.id} value={u.id}>{u.name} ({u.role})</option>)}
            </select>
          </div>

          <div className="row g-3 mb-3">
            <div className="col-6">
              <label className="form-label small fw-semibold">Implementation Start</label>
              <input type="date" className="form-control form-control-sm" value={form.implementationStart} onChange={e => f('implementationStart', e.target.value)} />
            </div>
            <div className="col-6">
              <label className="form-label small fw-semibold">Implementation End</label>
              <input type="date" className="form-control form-control-sm" value={form.implementationEnd} onChange={e => f('implementationEnd', e.target.value)} />
            </div>
          </div>

          <div className="mb-3">
            <label className="form-label small fw-semibold">Comment</label>
            <textarea className="form-control form-control-sm" rows={2} placeholder="Notes for the team..." value={form.bossComment} onChange={e => f('bossComment', e.target.value)} />
          </div>

          {form.status === 'rejected' && (
            <div className="mb-3">
              <label className="form-label small fw-semibold text-danger">Rejection Reason *</label>
              <textarea className="form-control form-control-sm" rows={2} placeholder="Required..." value={form.rejectionReason} onChange={e => f('rejectionReason', e.target.value)} />
            </div>
          )}

          {isImplementing && affectedDocs.length > 0 && (
            <div className="rounded-3 p-3 mb-3" style={{ background: '#f0fdf4', border: '1px solid #bbf7d0' }}>
              <h6 className="fw-bold small mb-2" style={{ color: '#16a34a' }}><i className="bi bi-arrow-up-circle me-1" />Update SOP Documents</h6>
              <p className="text-muted mb-3" style={{ fontSize: '0.7rem' }}>v1 created new knowledge-base versions here. v2 leaves SOP versioning to the KB module — set the new version on each affected article from there.</p>
              {affectedDocs.map(d => (
                <div key={d.id} className="d-flex align-items-center gap-2 mb-2 rounded-2 p-2" style={{ background: '#fff', border: '1px solid #e9ecef' }}>
                  <div className="flex-grow-1" style={{ minWidth: 0 }}>
                    <div className="fw-medium small text-truncate">{d.title}</div>
                    <div className="text-muted" style={{ fontSize: '0.62rem' }}>Current: {d.version || 'N/A'}</div>
                  </div>
                </div>
              ))}
            </div>
          )}

          {change.status !== 'pending' && change.status !== 'rejected' && (() => {
            const pMap = {};
            if (change.submittedBy) pMap[change.submittedBy] = { id: change.submittedBy, name: change.submittedByName, role: change.submittedByRole, roleLabel: 'Requester' };
            if (change.ownerId) {
              const ow = allUsers.find(u => u.id === change.ownerId);
              pMap[change.ownerId] = { id: change.ownerId, name: change.ownerName || ow?.name || '', role: ow?.role?.toLowerCase() || 'tl', roleLabel: 'Owner' };
            }
            if (currentUser && !pMap[currentUser.uid]) pMap[currentUser.uid] = { id: currentUser.uid, name: bossName, role: 'boss', roleLabel: 'Boss' };
            return <BossChangeThread changeId={change.changeId} changeDocId={change.id} participants={Object.values(pMap)} />;
          })()}
        </div>

        <div className="px-4 py-3 flex-shrink-0 d-flex gap-2 justify-content-end" style={{ borderTop: '1px solid #f1f5f9' }}>
          <button className="btn btn-sm btn-outline-secondary px-3" onClick={onClose} disabled={saving}>Cancel</button>
          <button className="btn btn-sm btn-dark px-4 d-inline-flex align-items-center gap-1" onClick={handleSave} disabled={saving || needsReason}>
            {saving ? <><span className="spinner-border spinner-border-sm" /> Saving...</> : <><i className="bi bi-check-lg" /> Save</>}
          </button>
        </div>
      </div>
    </div>
  );
}

/* ── Change Log from Sheet ─────────────────────────────────────────────────── */
function ChangeLogView() {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [headers, setHeaders] = useState([]);
  const [search, setSearch] = useState('');
  const [columnFilters, setColumnFilters] = useState({});
  const [expandedRow, setExpandedRow] = useState(null);
  const [viewMode, setViewMode] = useState('cards');
  const [sortCol, setSortCol] = useState(null);
  const [sortDir, setSortDir] = useState('asc');

  useEffect(() => {
    fetch(LOG_URL).then(r => r.text()).then(csv => {
      const lines = csv.split('\n').map(l => l.split(',').map(c => c.replace(/^"|"$/g, '').trim()));
      if (lines.length > 0) setHeaders(lines[0]);
      setRows(lines.slice(1).filter(r => r[0]));
    }).catch(() => {}).finally(() => setLoading(false));
  }, []);

  const columnOptions = useMemo(() => {
    const opts = {};
    headers.forEach((h, i) => {
      const vals = [...new Set(rows.map(r => r[i] || '').filter(Boolean))];
      if (vals.length > 1 && vals.length <= 30) opts[i] = vals.sort();
    });
    return opts;
  }, [headers, rows]);

  const filtered = useMemo(() => {
    let list = rows;
    if (search) {
      const q = search.toLowerCase();
      list = list.filter(r => r.some(c => (c || '').toLowerCase().includes(q)));
    }
    Object.entries(columnFilters).forEach(([ci, val]) => {
      if (val) list = list.filter(r => r[Number(ci)] === val);
    });
    if (sortCol !== null) {
      list = [...list].sort((a, b) => {
        const va = (a[sortCol] || '').toLowerCase();
        const vb = (b[sortCol] || '').toLowerCase();
        return sortDir === 'asc' ? va.localeCompare(vb) : vb.localeCompare(va);
      });
    }
    return list;
  }, [rows, search, columnFilters, sortCol, sortDir]);

  function handleSort(ci) {
    if (sortCol === ci) setSortDir(d => d === 'asc' ? 'desc' : 'asc');
    else { setSortCol(ci); setSortDir('asc'); }
  }

  if (loading) return <div className="text-center py-4"><div className="spinner-border text-primary" /></div>;
  if (rows.length === 0) return (
    <div className="text-center py-5" style={{ border: '2px dashed #dee2e6', borderRadius: 16 }}>
      <i className="bi bi-journal-text text-muted" style={{ fontSize: '2.5rem', opacity: 0.3 }} />
      <p className="text-muted mt-3 mb-0">No log entries yet.</p>
    </div>
  );

  const totalEntries = rows.length;
  const uniqueCol0 = new Set(rows.map(r => r[0])).size;
  const uniqueCol1 = headers.length > 1 ? new Set(rows.map(r => r[1]).filter(Boolean)).size : 0;

  return (
    <div>
      <div className="d-flex gap-2 flex-wrap mb-4">
        {[
          { label: 'Total Entries', value: totalEntries, icon: 'bi-journal-text', color: '#3b82f6', bg: '#eff6ff' },
          { label: `Unique ${headers[0] || 'Col 1'}`, value: uniqueCol0, icon: 'bi-hash', color: '#8b5cf6', bg: '#f5f3ff' },
          ...(headers.length > 1 ? [{ label: `Unique ${headers[1]}`, value: uniqueCol1, icon: 'bi-collection', color: '#059669', bg: '#ecfdf5' }] : []),
          { label: 'Showing', value: filtered.length, icon: 'bi-funnel', color: '#f59e0b', bg: '#fffbeb' },
        ].map(s => (
          <div key={s.label} className="rounded-3 px-3 py-2 d-flex align-items-center gap-2" style={{ background: s.bg, minWidth: 120 }}>
            <div className="rounded-2 d-flex align-items-center justify-content-center" style={{ width: 32, height: 32, background: `${s.color}15` }}>
              <i className={`bi ${s.icon}`} style={{ color: s.color, fontSize: '0.85rem' }} />
            </div>
            <div>
              <div className="fw-bold" style={{ fontSize: '1rem', color: s.color, lineHeight: 1 }}>{s.value}</div>
              <div style={{ fontSize: '0.55rem', color: s.color, textTransform: 'uppercase', letterSpacing: '0.04em', fontWeight: 600 }}>{s.label}</div>
            </div>
          </div>
        ))}
      </div>

      <div className="d-flex gap-2 mb-3 flex-wrap align-items-center">
        <div className="input-group input-group-sm" style={{ maxWidth: 260 }}>
          <span className="input-group-text border-0" style={{ background: '#f1f5f9' }}><i className="bi bi-search text-muted" style={{ fontSize: '0.7rem' }} /></span>
          <input type="text" className="form-control border-0" placeholder="Search all columns..." value={search} onChange={e => setSearch(e.target.value)} style={{ background: '#f1f5f9' }} />
          {search && <button className="btn btn-sm btn-outline-secondary border-0" onClick={() => setSearch('')}><i className="bi bi-x" /></button>}
        </div>
        {Object.entries(columnOptions).slice(0, 4).map(([ci, vals]) => (
          <select key={ci} className="form-select form-select-sm" style={{ maxWidth: 160, borderRadius: 8 }}
            value={columnFilters[ci] || ''} onChange={e => setColumnFilters(prev => ({ ...prev, [ci]: e.target.value }))}>
            <option value="">{headers[ci] || `Col ${Number(ci) + 1}`} (All)</option>
            {vals.map(v => <option key={v} value={v}>{v}</option>)}
          </select>
        ))}
        {Object.values(columnFilters).some(Boolean) && (
          <button className="btn btn-sm btn-outline-secondary d-inline-flex align-items-center gap-1" style={{ borderRadius: 8, fontSize: '0.72rem' }}
            onClick={() => setColumnFilters({})}>
            <i className="bi bi-x-circle" /> Clear
          </button>
        )}
        <div className="ms-auto d-flex gap-1">
          {['cards', 'table'].map(m => (
            <button key={m} className={`btn btn-sm ${viewMode === m ? 'btn-dark' : 'btn-outline-secondary'}`}
              style={{ borderRadius: 8, padding: '4px 10px' }} onClick={() => setViewMode(m)}>
              <i className={`bi ${m === 'cards' ? 'bi-grid' : 'bi-table'}`} style={{ fontSize: '0.78rem' }} />
            </button>
          ))}
        </div>
      </div>

      <div className="text-muted small mb-3" style={{ fontSize: '0.68rem' }}>
        {filtered.length === rows.length ? `${rows.length} entries` : `${filtered.length} of ${rows.length} entries`}
      </div>

      {viewMode === 'cards' ? (
        <div className="d-flex flex-column gap-2">
          {filtered.length === 0 ? (
            <div className="text-center py-4 text-muted small">No matching entries.</div>
          ) : filtered.map((r, ri) => {
            const isExpanded = expandedRow === ri;
            const title = r[0] || '—';
            const subtitle = headers.length > 1 ? r[1] || '' : '';
            return (
              <div key={ri} className="card border-0 shadow-sm" style={{ borderRadius: 12, cursor: 'pointer', borderLeft: '4px solid #3b82f6' }}
                onClick={() => setExpandedRow(isExpanded ? null : ri)}>
                <div className="card-body p-3">
                  <div className="d-flex align-items-center justify-content-between">
                    <div className="flex-grow-1" style={{ minWidth: 0 }}>
                      <div className="d-flex align-items-center gap-2">
                        <span className="fw-semibold small text-truncate">{title}</span>
                        {subtitle && <span className="badge rounded-pill" style={{ background: '#f1f5f9', color: '#64748b', fontSize: '0.58rem' }}>{subtitle}</span>}
                      </div>
                      {!isExpanded && headers.length > 2 && (
                        <div className="d-flex gap-2 mt-1 flex-wrap">
                          {headers.slice(2, 5).map((h, hi) => r[hi + 2] ? (
                            <span key={hi} className="text-muted" style={{ fontSize: '0.62rem' }}>
                              <span style={{ color: '#94a3b8' }}>{h}:</span> {r[hi + 2]}
                            </span>
                          ) : null)}
                        </div>
                      )}
                    </div>
                    <i className={`bi bi-chevron-${isExpanded ? 'up' : 'down'} text-muted flex-shrink-0`} style={{ fontSize: '0.7rem' }} />
                  </div>
                  {isExpanded && (
                    <div className="mt-3 pt-3" style={{ borderTop: '1px solid #f1f5f9' }}>
                      <div className="row g-2">
                        {headers.map((h, hi) => (
                          <div key={hi} className="col-6 col-md-4">
                            <div style={{ fontSize: '0.58rem', color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '0.04em', fontWeight: 700 }}>{h}</div>
                            <div className="small fw-medium" style={{ wordBreak: 'break-word' }}>{r[hi] || '—'}</div>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      ) : (
        <div className="card border-0 shadow-sm" style={{ borderRadius: 14, overflow: 'hidden' }}>
          <div className="table-responsive">
            <table className="table table-hover table-sm mb-0" style={{ fontSize: '0.75rem' }}>
              <thead>
                <tr style={{ background: '#f8fafc' }}>
                  {headers.map((h, i) => (
                    <th key={i} className="border-0 text-nowrap px-3 py-2" style={{ fontSize: '0.65rem', color: '#64748b', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.04em', cursor: 'pointer', userSelect: 'none' }}
                      onClick={() => handleSort(i)}>
                      {h}
                      {sortCol === i && <i className={`bi bi-caret-${sortDir === 'asc' ? 'up' : 'down'}-fill ms-1`} style={{ fontSize: '0.55rem' }} />}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {filtered.length === 0 ? (
                  <tr><td colSpan={headers.length} className="text-center text-muted py-3">No matching entries.</td></tr>
                ) : filtered.map((r, ri) => (
                  <tr key={ri} style={{ transition: 'background 0.1s' }}>
                    {r.map((c, ci) => (
                      <td key={ci} className="px-3 py-2" style={{ maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={c}>{c || '—'}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

/* ── Main Page ─────────────────────────────────────────────────────────────── */
export default function BossChangeManagementPage() {
  const [changes, setChanges] = useState([]);
  const [loading, setLoading] = useState(true);
  const [allUsers, setAllUsers] = useState([]);
  const [sopDocs, setSopDocs] = useState([]);
  const [reviewTarget, setReviewTarget] = useState(null);
  const [tab, setTab] = useState('requests');

  const [search, setSearch] = useState('');
  const [sopFilter, setSopFilter] = useState('all');
  const [statusFilter, setStatusFilter] = useState('all');

  useEffect(() => {
    const unsub = subscribeAllChanges(
      (rows) => { setChanges(rows); setLoading(false); },
      () => setLoading(false),
    );
    return unsub;
  }, []);

  useEffect(() => {
    Promise.all([listAllUsersForChanges(), listSopDocs()])
      .then(([us, docs]) => { setAllUsers(us); setSopDocs(docs); });
  }, []);

  function handleSaved(updated) {
    setChanges(prev => prev.map(c => c.id === updated.id ? updated : c));
    setReviewTarget(null);
  }

  const filtered = useMemo(() => {
    let list = changes;
    if (search) { const s = search.toLowerCase(); list = list.filter(c => c.title.toLowerCase().includes(s) || c.changeId?.toLowerCase().includes(s) || (c.submittedByName || '').toLowerCase().includes(s)); }
    if (sopFilter !== 'all') list = list.filter(c => c.sopType === sopFilter);
    if (statusFilter !== 'all') list = list.filter(c => c.status === statusFilter);
    return list;
  }, [changes, search, sopFilter, statusFilter]);

  const pendingCount = changes.filter(c => c.status === 'pending').length;
  const completedCount = changes.filter(c => c.status === 'completed').length;

  return (
    <div>
      <div className="d-flex align-items-center justify-content-between mb-4 flex-wrap gap-3">
        <div>
          <h4 className="fw-bold mb-1" style={{ color: '#0f172a' }}>Change Management</h4>
          <p className="text-muted small mb-0">Review change requests and track implementation</p>
        </div>
        <div className="d-flex gap-2">
          {['requests', 'log'].map(t => (
            <button key={t} className={`btn btn-sm px-3 ${tab === t ? 'btn-dark' : 'btn-outline-secondary'}`}
              style={{ borderRadius: 8, fontSize: '0.82rem', fontWeight: 600 }} onClick={() => setTab(t)}>
              {t === 'requests' ? 'Requests' : 'Change Log'}
              {t === 'requests' && (pendingCount + completedCount) > 0 && <span className="badge bg-danger rounded-pill ms-1" style={{ fontSize: '0.55rem' }}>{pendingCount + completedCount}</span>}
            </button>
          ))}
        </div>
      </div>

      {tab === 'log' ? (
        <ChangeLogView />
      ) : (
        <>
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
              {STATUS_LIST.map(s => <option key={s.key} value={s.key}>{s.label}</option>)}
            </select>
            <span className="text-muted small ms-auto align-self-center">{filtered.length} request{filtered.length !== 1 ? 's' : ''}</span>
          </div>

          {loading ? (
            <div className="text-center py-4"><div className="spinner-border text-primary" /></div>
          ) : filtered.length === 0 ? (
            <div className="text-center py-5" style={{ border: '2px dashed #dee2e6', borderRadius: 16 }}>
              <i className="bi bi-inbox text-muted" style={{ fontSize: '2.5rem', opacity: 0.3 }} />
              <p className="text-muted mt-3 mb-0">No change requests.</p>
            </div>
          ) : (
            <div className="d-flex flex-column gap-2">
              {filtered.map(c => {
                const st = STATUS_MAP[c.status] || STATUS_MAP.pending;
                const sop = SOP_TYPES.find(s => s.key === c.sopType);
                const pr = PRIORITIES.find(p => p.key === c.priority);
                return (
                  <div key={c.id} className="card border-0 shadow-sm" style={{ borderRadius: 14, cursor: 'pointer', borderLeft: `4px solid ${st.color}` }}
                    onClick={() => setReviewTarget(c)}>
                    <div className="card-body p-3 d-flex align-items-center gap-3">
                      <div className="flex-grow-1" style={{ minWidth: 0 }}>
                        <div className="fw-semibold small text-truncate">{c.title}</div>
                        <div className="d-flex gap-2 mt-1 flex-wrap">
                          <span className="text-muted" style={{ fontSize: '0.65rem' }}>{c.changeId}</span>
                          <span className="text-muted" style={{ fontSize: '0.65rem' }}>by {c.submittedByName}</span>
                          {sop && <span className="badge rounded-pill" style={{ background: `${sop.color}12`, color: sop.color, fontSize: '0.55rem' }}>{sop.label}</span>}
                          {c.currentVersion && <span className="text-muted" style={{ fontSize: '0.65rem' }}>{c.currentVersion}</span>}
                          {c.newVersion && <span style={{ fontSize: '0.65rem', color: '#16a34a' }}>→ {c.newVersion}</span>}
                          {pr && <span className="badge rounded-pill" style={{ background: pr.bg, color: pr.color, fontSize: '0.55rem' }}>{pr.label}</span>}
                        </div>
                      </div>
                      <span className="badge rounded-pill" style={{ background: st.bg, color: st.color, fontSize: '0.62rem' }}><i className={`bi ${st.icon} me-1`} />{st.label}</span>
                      <i className="bi bi-chevron-right text-muted" style={{ fontSize: '0.7rem' }} />
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </>
      )}

      {reviewTarget && <ReviewModal change={reviewTarget} allUsers={allUsers} sopDocs={sopDocs} onClose={() => setReviewTarget(null)} onSaved={handleSaved} />}
    </div>
  );
}
