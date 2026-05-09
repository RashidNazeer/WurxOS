// VERBATIM PORT of v1 brands/tabs/CampaignsTab.js (457 LOC).
// Surgical patches:
//   1. Firebase imports → v1-compat shim (campaignsApiV1.js)
//   2. useAuth() returns {user, profile} → reconstruct {currentUser}
//   3. Brand prop comes in v2-shape (snake_case) → adapter at top
import React, { useState, useEffect, useMemo } from 'react';
import { useAuth } from '../../../contexts/AuthContext';
import {
  subscribeBrandCampaigns, addCampaign, updateCampaign,
  deleteCampaign, bulkDeleteCampaigns,
} from '../../../lib/campaignsApiV1';

const STATUS_OPTIONS = ['Ongoing', 'Upcoming', 'Ended', 'Deactivated'];

const STATUS_STYLE = {
  Ongoing:     { bg: 'rgba(34,197,94,0.12)',   color: '#15803d', border: 'rgba(34,197,94,0.3)'    },
  Upcoming:    { bg: 'rgba(59,130,246,0.12)',  color: '#1d4ed8', border: 'rgba(59,130,246,0.3)'   },
  Ended:       { bg: 'rgba(107,114,128,0.10)', color: '#6b7280', border: 'rgba(107,114,128,0.25)' },
  Deactivated: { bg: 'rgba(239,68,68,0.10)',   color: '#dc2626', border: 'rgba(239,68,68,0.25)'   },
};

const EMPTY_FORM = {
  _id: null, promotionName: '', status: 'Ongoing', startTime: '', endTime: '', type: '', notes: '',
};

function toLocalInput(ts) {
  if (!ts) return '';
  try {
    const d = ts.toDate ? ts.toDate() : new Date(ts);
    const pad = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  } catch { return ''; }
}

function formatDateTime(ts) {
  if (!ts) return '—';
  try {
    const d = ts.toDate ? ts.toDate() : new Date(ts);
    return d.toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  } catch { return '—'; }
}

function DaysLeftBadge({ ts, status }) {
  const isActive = status === 'Ongoing' || status === 'Upcoming';
  if (!isActive || !ts) return <span className="text-muted">—</span>;
  try {
    const end = ts.toDate ? ts.toDate() : new Date(ts);
    const days = Math.ceil((end - new Date()) / (1000 * 60 * 60 * 24));
    const [bg, color] =
      days <= 0 ? ['rgba(239,68,68,0.12)',   '#dc2626'] :
      days <= 1 ? ['rgba(239,68,68,0.12)',   '#dc2626'] :
      days <= 3 ? ['rgba(249,115,22,0.12)',  '#ea580c'] :
      days <= 7 ? ['rgba(234,179,8,0.12)',   '#ca8a04'] :
                  ['rgba(34,197,94,0.12)',   '#16a34a'];
    return (
      <span style={{ display:'inline-block', borderRadius:9999, padding:'1px 8px', fontSize:'0.72rem', fontWeight:600, background:bg, color }}>
        {days <= 0 ? 'Today' : `${days}d`}
      </span>
    );
  } catch { return <span className="text-muted">—</span>; }
}

export default function CampaignsTab({ brand: rawBrand }) {
  // v2 brand prop is snake_case; expose v1 fields without re-touching markup
  const brand = useMemo(() => rawBrand ? ({
    ...rawBrand,
    id: rawBrand.id,
    brandName: rawBrand.brand_name || rawBrand.brandName || '',
    ownerId: rawBrand.owner_id || rawBrand.ownerId || null,
  }) : rawBrand, [rawBrand]);

  const { user, profile } = useAuth();
  const currentUser = user ? { uid: user.id, email: user.email, displayName: profile?.display_name || '' } : null;
  const userRole = profile?.role || '';

  const [campaigns,  setCampaigns]  = useState([]);
  const [loading,    setLoading]    = useState(true);

  // ── Filters ──────────────────────────────────────────────────────────────
  const [search,     setSearch]     = useState('');
  const [fStatus,    setFStatus]    = useState('');

  // ── Add / Edit modal ──────────────────────────────────────────────────────
  const [showModal,  setShowModal]  = useState(false);
  const [modalMode,  setModalMode]  = useState('add');
  const [form,       setForm]       = useState(EMPTY_FORM);
  const [saving,     setSaving]     = useState(false);
  const [formError,  setFormError]  = useState('');

  // ── Single delete ─────────────────────────────────────────────────────────
  const [deleteId,   setDeleteId]   = useState(null);

  // ── Bulk select ───────────────────────────────────────────────────────────
  const [selected,   setSelected]   = useState(new Set());   // Set of campaign IDs
  const [bulkConfirm, setBulkConfirm] = useState(false);
  const [bulkDeleting, setBulkDeleting] = useState(false);

  // ── Load campaigns ────────────────────────────────────────────────────────
  useEffect(() => {
    if (!brand?.id) return undefined;
    const unsub = subscribeBrandCampaigns(
      brand.id,
      (rows) => { setCampaigns(rows); setLoading(false); },
      () => setLoading(false),
    );
    return unsub;
  }, [brand?.id]);

  // ── Filtered list ─────────────────────────────────────────────────────────
  const filtered = useMemo(() => {
    const q = search.toLowerCase();
    return campaigns.filter(c => {
      if (fStatus && c.status !== fStatus) return false;
      if (q && !c.promotionName?.toLowerCase().includes(q) && !c.notes?.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [campaigns, search, fStatus]);

  // ── Select helpers ────────────────────────────────────────────────────────
  const allSelected = filtered.length > 0 && filtered.every(c => selected.has(c.id));
  const someSelected = selected.size > 0;

  function toggleOne(id) {
    setSelected(prev => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }

  function toggleAll() {
    if (allSelected) {
      setSelected(new Set());
    } else {
      setSelected(new Set(filtered.map(c => c.id)));
    }
  }

  // Clear selection when filters change
  useEffect(() => { setSelected(new Set()); }, [search, fStatus]);

  // ── Add / Edit ────────────────────────────────────────────────────────────
  function openAdd() {
    setForm(EMPTY_FORM);
    setModalMode('add');
    setFormError('');
    setShowModal(true);
  }

  function openEdit(c) {
    setForm({
      _id:           c.id,
      promotionName: c.promotionName || '',
      status:        c.status        || 'Ongoing',
      startTime:     toLocalInput(c.startTime),
      endTime:       toLocalInput(c.endTime),
      type:          c.type          || '',
      notes:         c.notes         || '',
    });
    setModalMode('edit');
    setFormError('');
    setShowModal(true);
  }

  async function handleSave() {
    if (!form.promotionName.trim()) { setFormError('Promotion name is required.'); return; }
    // endTime is optional (campaigns can be indefinite)

    setSaving(true);
    setFormError('');
    try {
      const payload = {
        brandId:       brand.id,
        brandName:     brand.brandName,
        promotionName: form.promotionName.trim(),
        status:        form.status,
        startTime:     form.startTime ? new Date(form.startTime) : null,
        endTime:       form.endTime ? new Date(form.endTime) : null,
        type:          form.type.trim(),
        notes:         form.notes.trim(),
        reminders:     {},
      };
      if (modalMode === 'add') {
        await addCampaign({
          ...payload,
          ownerId:   brand.ownerId || currentUser.uid,
          addedBy:   currentUser.uid,
          addedByRole: userRole || null,
        });
      } else {
        await updateCampaign(form._id, payload);
      }
      setShowModal(false);
    } catch {
      setFormError('Failed to save. Please try again.');
    }
    setSaving(false);
  }

  // ── Single delete ─────────────────────────────────────────────────────────
  async function handleDelete() {
    if (!deleteId) return;
    try { await deleteCampaign(deleteId); } catch {}
    setDeleteId(null);
  }

  // ── Bulk delete ───────────────────────────────────────────────────────────
  async function handleBulkDelete() {
    setBulkDeleting(true);
    try {
      await bulkDeleteCampaigns(selected);
    } catch {}
    setSelected(new Set());
    setBulkConfirm(false);
    setBulkDeleting(false);
  }

  // ─────────────────────────────────────────────────────────────────────────
  return (
    <>
      {/* ── Header ── */}
      <div className="d-flex align-items-center justify-content-between mb-3">
        <div>
          <h5 className="mb-0 fw-bold" style={{ color: '#1e293b' }}>Campaigns</h5>
          <p className="mb-0 text-muted" style={{ fontSize: '0.82rem' }}>
            {campaigns.length} campaign{campaigns.length !== 1 ? 's' : ''} for {brand.brandName}
          </p>
        </div>
        <div className="d-flex gap-2 align-items-center">
          {someSelected && (
            <button
              className="btn btn-danger btn-sm d-flex align-items-center gap-1"
              onClick={() => setBulkConfirm(true)}
            >
              <i className="bi bi-trash" style={{ fontSize: '0.8rem' }} />
              Delete {selected.size} selected
            </button>
          )}
          <button className="btn btn-primary btn-sm d-flex align-items-center gap-1" onClick={openAdd}>
            <i className="bi bi-plus-lg" style={{ fontSize: '0.8rem' }} />
            Add Campaign
          </button>
        </div>
      </div>

      {/* ── Filters ── */}
      <div className="d-flex gap-2 mb-3 flex-wrap align-items-center">
        <div className="position-relative flex-grow-1" style={{ minWidth: 180 }}>
          <i className="bi bi-search position-absolute"
            style={{ left: 9, top: '50%', transform: 'translateY(-50%)', color: '#9ca3af', fontSize: '0.8rem' }} />
          <input
            className="form-control form-control-sm"
            placeholder="Search campaigns..."
            value={search}
            onChange={e => setSearch(e.target.value)}
            style={{ paddingLeft: 28, fontSize: '0.83rem' }}
          />
        </div>
        <select
          className="form-select form-select-sm"
          value={fStatus}
          onChange={e => setFStatus(e.target.value)}
          style={{ width: 140, fontSize: '0.83rem' }}
        >
          <option value="">All Status</option>
          {STATUS_OPTIONS.map(s => <option key={s} value={s}>{s}</option>)}
        </select>
        <span className="text-muted" style={{ fontSize: '0.78rem', whiteSpace: 'nowrap' }}>
          {filtered.length} result{filtered.length !== 1 ? 's' : ''}
        </span>
      </div>

      {/* ── Table ── */}
      {loading ? (
        <div className="text-center py-5 text-muted">
          <div className="spinner-border spinner-border-sm" />
        </div>
      ) : campaigns.length === 0 ? (
        <div className="text-center py-5 text-muted">
          <i className="bi bi-megaphone" style={{ fontSize: '2.5rem', display: 'block', marginBottom: 10, opacity: 0.4 }} />
          <div style={{ fontWeight: 500 }}>No campaigns for this brand yet.</div>
          <button className="btn btn-primary btn-sm mt-3" onClick={openAdd}>
            <i className="bi bi-plus-lg me-1" />Add first campaign
          </button>
        </div>
      ) : filtered.length === 0 ? (
        <div className="text-center py-5 text-muted" style={{ fontSize: '0.9rem' }}>
          No campaigns match your filters.
          <button className="btn btn-link btn-sm ms-2" onClick={() => { setSearch(''); setFStatus(''); }}>
            Clear filters
          </button>
        </div>
      ) : (
        <div className="card border-0 shadow-sm">
          <div className="table-responsive">
            <table className="table table-hover mb-0" style={{ fontSize: '0.83rem' }}>
              <thead>
                <tr style={{ background: '#f8fafc', borderBottom: '2px solid #e2e8f0' }}>
                  <th className="px-3 py-2" style={{ width: 36 }}>
                    <input
                      type="checkbox"
                      className="form-check-input"
                      checked={allSelected}
                      onChange={toggleAll}
                      title={allSelected ? 'Deselect all' : 'Select all'}
                    />
                  </th>
                  {['Promotion Name', 'Status', 'Start Time', 'End Time', 'Type', 'Days Left', ''].map(h => (
                    <th key={h} className="px-3 py-2 fw-semibold" style={{ color: '#64748b', whiteSpace: 'nowrap' }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {filtered.map(c => {
                  const st = STATUS_STYLE[c.status] || STATUS_STYLE.Ended;
                  const isSelected = selected.has(c.id);
                  return (
                    <tr key={c.id} style={{
                      background: deleteId === c.id ? 'rgba(239,68,68,0.04)'
                                : isSelected ? 'rgba(99,102,241,0.04)' : undefined,
                    }}>
                      <td className="px-3 py-2">
                        <input
                          type="checkbox"
                          className="form-check-input"
                          checked={isSelected}
                          onChange={() => toggleOne(c.id)}
                        />
                      </td>
                      <td className="px-3 py-2" style={{ maxWidth: 240 }}>
                        <div className="fw-medium text-truncate">{c.promotionName}</div>
                        {c.notes && (
                          <div className="text-muted text-truncate" style={{ fontSize: '0.72rem' }}>{c.notes}</div>
                        )}
                      </td>
                      <td className="px-3 py-2">
                        <span className="badge rounded-pill" style={{
                          background: st.bg, color: st.color, border: `1px solid ${st.border}`,
                          fontSize: '0.72rem', fontWeight: 600, padding: '3px 9px',
                        }}>
                          {c.status}
                        </span>
                      </td>
                      <td className="px-3 py-2 text-muted" style={{ whiteSpace: 'nowrap' }}>{formatDateTime(c.startTime)}</td>
                      <td className="px-3 py-2 text-muted" style={{ whiteSpace: 'nowrap' }}>{formatDateTime(c.endTime)}</td>
                      <td className="px-3 py-2 text-muted">{c.type || '—'}</td>
                      <td className="px-3 py-2"><DaysLeftBadge ts={c.endTime} status={c.status} /></td>
                      <td className="px-3 py-2" style={{ whiteSpace: 'nowrap' }}>
                        {deleteId === c.id ? (
                          <div className="d-flex align-items-center gap-1">
                            <span style={{ fontSize: '0.72rem', color: '#dc2626' }}>Delete?</span>
                            <button className="btn btn-danger btn-sm py-0 px-2" style={{ fontSize: '0.72rem' }} onClick={handleDelete}>Yes</button>
                            <button className="btn btn-light btn-sm py-0 px-2" style={{ fontSize: '0.72rem' }} onClick={() => setDeleteId(null)}>No</button>
                          </div>
                        ) : (
                          <div className="d-flex gap-1">
                            <button className="btn btn-light btn-sm py-0 px-2" title="Edit" onClick={() => openEdit(c)}>
                              <i className="bi bi-pencil" style={{ fontSize: '0.75rem' }} />
                            </button>
                            <button className="btn btn-light btn-sm py-0 px-2" title="Delete" onClick={() => setDeleteId(c.id)}>
                              <i className="bi bi-trash" style={{ fontSize: '0.75rem' }} />
                            </button>
                          </div>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* ── Bulk delete confirm modal ── */}
      {bulkConfirm && (
        <div className="modal show d-block" style={{ background: 'rgba(0,0,0,0.45)', zIndex: 1060 }}>
          <div className="modal-dialog" style={{ maxWidth: 380 }}>
            <div className="modal-content">
              <div className="modal-header border-0 pb-0">
                <h5 className="modal-title fw-bold text-danger">Delete {selected.size} campaign{selected.size !== 1 ? 's' : ''}?</h5>
              </div>
              <div className="modal-body pt-2">
                <p className="text-muted mb-0" style={{ fontSize: '0.875rem' }}>
                  This will permanently delete the selected campaigns. Deleted campaigns will not trigger any reminders.
                </p>
              </div>
              <div className="modal-footer border-0 pt-0">
                <button className="btn btn-light" onClick={() => setBulkConfirm(false)} disabled={bulkDeleting}>Cancel</button>
                <button className="btn btn-danger" onClick={handleBulkDelete} disabled={bulkDeleting}>
                  {bulkDeleting ? <span className="spinner-border spinner-border-sm" /> : 'Delete'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ── Add / Edit modal ── */}
      {showModal && (
        <div className="modal show d-block" style={{ background: 'rgba(0,0,0,0.45)', zIndex: 1050 }}>
          <div className="modal-dialog modal-dialog-scrollable" style={{ maxWidth: 560 }}>
            <div className="modal-content">
              <div className="modal-header border-0 pb-0">
                <h5 className="modal-title fw-bold">
                  {modalMode === 'add' ? 'Add Campaign' : 'Edit Campaign'}
                </h5>
                <button className="btn-close" onClick={() => setShowModal(false)} />
              </div>
              <div className="modal-body pt-3">
                <div className="row g-3">
                  <div className="col-12">
                    <label className="form-label fw-medium mb-1">Promotion Name <span className="text-danger">*</span></label>
                    <input
                      className="form-control"
                      value={form.promotionName}
                      onChange={e => setForm(f => ({ ...f, promotionName: e.target.value }))}
                      placeholder="e.g. Summer Bundle Deal"
                    />
                  </div>
                  <div className="col-md-5">
                    <label className="form-label fw-medium mb-1">Status</label>
                    <select className="form-select" value={form.status} onChange={e => setForm(f => ({ ...f, status: e.target.value }))}>
                      {STATUS_OPTIONS.map(s => <option key={s}>{s}</option>)}
                    </select>
                  </div>
                  <div className="col-md-7">
                    <label className="form-label fw-medium mb-1">Type</label>
                    <input
                      className="form-control"
                      value={form.type}
                      onChange={e => setForm(f => ({ ...f, type: e.target.value }))}
                      placeholder="e.g. Coupon, Bundle, Flash Sale"
                    />
                  </div>
                  <div className="col-md-6">
                    <label className="form-label fw-medium mb-1">Start Time</label>
                    <input type="datetime-local" className="form-control" value={form.startTime} onChange={e => setForm(f => ({ ...f, startTime: e.target.value }))} />
                  </div>
                  <div className="col-md-6">
                    <label className="form-label fw-medium mb-1">End Time <span className="text-muted" style={{ fontSize: '0.72rem', fontWeight: 400 }}>(leave empty for indefinite)</span></label>
                    <input type="datetime-local" className="form-control" value={form.endTime} onChange={e => setForm(f => ({ ...f, endTime: e.target.value }))} />
                  </div>
                  <div className="col-12">
                    <label className="form-label fw-medium mb-1">Notes</label>
                    <textarea className="form-control" value={form.notes} onChange={e => setForm(f => ({ ...f, notes: e.target.value }))} rows={2} placeholder="Optional notes..." />
                  </div>
                </div>
                {formError && (
                  <div className="alert alert-danger py-2 mt-3" style={{ fontSize: '0.83rem' }}>{formError}</div>
                )}
              </div>
              <div className="modal-footer border-0 pt-0">
                <button className="btn btn-light" onClick={() => setShowModal(false)}>Cancel</button>
                <button className="btn btn-primary" onClick={handleSave} disabled={saving}>
                  {saving ? <span className="spinner-border spinner-border-sm" /> : (modalMode === 'add' ? 'Add Campaign' : 'Save Changes')}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
