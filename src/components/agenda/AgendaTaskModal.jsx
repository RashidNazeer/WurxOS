import React, { useEffect, useMemo, useState } from 'react';
import { useAuth } from '../../contexts/AuthContext';
import {
  createAgendaTask, listAgendaAssignableUsers, listBrandsForApc,
} from '../../lib/agendaApi';

// Assign / add an agenda meeting task.
//
//  * APC      → self-assign only (assignee locked to themselves).
//  * TL/OL/Boss → pick an APC, then a brand assigned to that APC
//                 (auto-selected when the APC has only one).
//  * presetAssignee → APC-detail mode: assignee is fixed, picker hidden.

export default function AgendaTaskModal({ presetAssignee, onClose, onSaved }) {
  const { user, profile } = useAuth();
  const role = profile?.role || '';
  const isApcSelf = role === 'apc';

  // assignee: APC self -> themselves; preset -> fixed; else picked.
  const lockedAssignee = isApcSelf
    ? { id: user?.id, display_name: profile?.display_name || 'Me' }
    : (presetAssignee || null);

  const [apcs, setApcs]         = useState([]);
  const [assigneeId, setAssigneeId] = useState(lockedAssignee?.id || '');
  const [brands, setBrands]     = useState([]);
  const [brandId, setBrandId]   = useState('');
  const [title, setTitle]       = useState('');
  const [details, setDetails]   = useState('');
  const [dueDate, setDueDate]   = useState('');
  const [link, setLink]         = useState('');
  const [saving, setSaving]     = useState(false);
  const [error, setError]       = useState('');

  // Load the APC list for managers picking an assignee.
  useEffect(() => {
    if (lockedAssignee) return;
    let cancelled = false;
    listAgendaAssignableUsers({ creatorRole: role, creatorId: user?.id, brandId: null })
      .then((rows) => {
        if (cancelled) return;
        setApcs((rows || []).filter((u) => u.role === 'apc'));
      })
      .catch(() => { if (!cancelled) setApcs([]); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [role, user?.id]);

  // Load the chosen APC's brands; auto-select when there's only one.
  useEffect(() => {
    if (!assigneeId) { setBrands([]); setBrandId(''); return; }
    let cancelled = false;
    listBrandsForApc(assigneeId)
      .then((rows) => {
        if (cancelled) return;
        setBrands(rows || []);
        setBrandId((rows || []).length === 1 ? rows[0].id : '');
      })
      .catch(() => { if (!cancelled) { setBrands([]); setBrandId(''); } });
    return () => { cancelled = true; };
  }, [assigneeId]);

  const assigneeName = useMemo(() => {
    if (lockedAssignee) return lockedAssignee.display_name || lockedAssignee.userName || 'APC';
    return apcs.find((a) => a.id === assigneeId)?.display_name || '';
  }, [lockedAssignee, apcs, assigneeId]);

  async function handleSave() {
    if (!assigneeId) { setError('Select an APC.'); return; }
    if (!title.trim()) { setError('Task title is required.'); return; }
    setSaving(true);
    setError('');
    try {
      await createAgendaTask({
        brandId: brandId || null,
        assigneeId,
        title,
        details,
        dueDate: dueDate || null,
        link,
      });
      onSaved();
    } catch (e) {
      setError(e.message || 'Failed to create task.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 1070, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
      <div style={{ position: 'absolute', inset: 0, background: 'rgba(0,0,0,0.45)', backdropFilter: 'blur(2px)' }} onClick={onClose} />
      <div className="card border-0 shadow-lg" style={{ position: 'relative', width: '100%', maxWidth: 500, zIndex: 1, borderRadius: 14 }}>
        <div className="card-body p-4">
          <p className="fw-semibold mb-3">
            {isApcSelf ? 'Add agenda task' : 'Assign agenda task'}
          </p>

          {error && <div className="alert alert-danger py-2 small mb-3">{error}</div>}

          {/* Assignee */}
          {lockedAssignee ? (
            <div className="mb-3">
              <label className="form-label small fw-semibold">APC</label>
              <div className="rounded-2 px-3 py-2" style={{ background: 'var(--surface-2)', fontSize: '0.84rem' }}>
                <i className="bi bi-person-fill me-1 text-muted" />{assigneeName}
              </div>
            </div>
          ) : (
            <div className="mb-3">
              <label className="form-label small fw-semibold">APC <span className="text-danger">*</span></label>
              <select className="form-select form-select-sm" style={{ borderRadius: 8 }}
                value={assigneeId} onChange={(e) => setAssigneeId(e.target.value)}>
                <option value="">Select an APC…</option>
                {apcs.map((a) => <option key={a.id} value={a.id}>{a.display_name || a.email}</option>)}
              </select>
            </div>
          )}

          {/* Brand */}
          <div className="mb-3">
            <label className="form-label small fw-semibold">Brand</label>
            <select className="form-select form-select-sm" style={{ borderRadius: 8 }}
              value={brandId} onChange={(e) => setBrandId(e.target.value)}
              disabled={!assigneeId}>
              <option value="">{assigneeId ? 'No specific brand' : 'Select an APC first'}</option>
              {brands.map((b) => <option key={b.id} value={b.id}>{b.brand_name}</option>)}
            </select>
            {assigneeId && brands.length === 0 && (
              <div className="text-muted mt-1" style={{ fontSize: '0.72rem' }}>This APC has no active brands assigned.</div>
            )}
          </div>

          {/* Title */}
          <div className="mb-3">
            <label className="form-label small fw-semibold">Task title <span className="text-danger">*</span></label>
            <input type="text" className="form-control form-control-sm" style={{ borderRadius: 8 }}
              placeholder="What needs to be done" value={title} onChange={(e) => setTitle(e.target.value)} />
          </div>

          {/* Details */}
          <div className="mb-3">
            <label className="form-label small fw-semibold">Details</label>
            <textarea className="form-control form-control-sm" rows={2} style={{ borderRadius: 8 }}
              placeholder="Optional details…" value={details} onChange={(e) => setDetails(e.target.value)} />
          </div>

          <div className="row g-2 mb-3">
            <div className="col-6">
              <label className="form-label small fw-semibold">Due date</label>
              <input type="date" className="form-control form-control-sm" style={{ borderRadius: 8 }}
                value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
            </div>
            <div className="col-6">
              <label className="form-label small fw-semibold">Link <span className="text-muted fw-normal">(optional)</span></label>
              <input type="url" className="form-control form-control-sm" style={{ borderRadius: 8 }}
                placeholder="https://…" value={link} onChange={(e) => setLink(e.target.value)} />
            </div>
          </div>

          {!isApcSelf && assigneeName && (
            <div className="text-muted mb-3" style={{ fontSize: '0.72rem' }}>
              <i className="bi bi-bell me-1" />{assigneeName || 'The APC'} will be notified of this assignment.
            </div>
          )}

          <div className="d-flex gap-2 justify-content-end">
            <button className="btn btn-sm btn-outline-secondary px-3" onClick={onClose} disabled={saving}>Cancel</button>
            <button className="btn btn-sm btn-dark px-3 d-inline-flex align-items-center gap-1" onClick={handleSave} disabled={saving}>
              {saving ? <><span className="spinner-border spinner-border-sm" /> Saving…</> : <><i className="bi bi-check-lg" /> {isApcSelf ? 'Add task' : 'Assign task'}</>}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
