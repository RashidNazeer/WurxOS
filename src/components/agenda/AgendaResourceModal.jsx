import React, { useEffect, useState } from 'react';
import { useAuth } from '../../contexts/AuthContext';
import {
  createAgendaResource, updateAgendaResource, listAgendaBrands,
} from '../../lib/agendaApi';

// Add / edit an agenda meeting resource. Brand is optional — a
// resource with no brand is a general agenda resource.

const TYPES = [
  ['link',  'Link',  'bi-link-45deg'],
  ['file',  'File',  'bi-file-earmark'],
  ['image', 'Image', 'bi-image'],
  ['video', 'Video', 'bi-camera-video'],
];

export default function AgendaResourceModal({ resource, onClose, onSaved }) {
  const { user, profile } = useAuth();
  const isEdit = !!resource;

  const [brands, setBrands]       = useState([]);
  const [brandId, setBrandId]     = useState(resource?.brand_id || '');
  const [type, setType]           = useState(resource?.type || 'link');
  const [name, setName]           = useState(resource?.name || '');
  const [url, setUrl]             = useState(resource?.url || '');
  const [description, setDescription] = useState(resource?.description || '');
  const [saving, setSaving]       = useState(false);
  const [error, setError]         = useState('');

  useEffect(() => {
    let cancelled = false;
    listAgendaBrands({ creatorRole: profile?.role, creatorId: user?.id })
      .then((rows) => { if (!cancelled) setBrands(rows || []); })
      .catch(() => { if (!cancelled) setBrands([]); });
    return () => { cancelled = true; };
  }, [profile?.role, user?.id]);

  async function handleSave() {
    if (!name.trim()) { setError('Name is required.'); return; }
    if (!url.trim())  { setError('URL is required.'); return; }
    setSaving(true);
    setError('');
    try {
      if (isEdit) {
        await updateAgendaResource(resource.id, { brandId: brandId || null, type, name, url, description });
      } else {
        await createAgendaResource({ brandId: brandId || null, type, name, url, description });
      }
      onSaved();
    } catch (e) {
      setError(e.message || 'Failed to save resource.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 1070, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
      <div style={{ position: 'absolute', inset: 0, background: 'rgba(0,0,0,0.45)', backdropFilter: 'blur(2px)' }} onClick={onClose} />
      <div className="card border-0 shadow-lg" style={{ position: 'relative', width: '100%', maxWidth: 500, zIndex: 1, borderRadius: 14 }}>
        <div className="card-body p-4">
          <p className="fw-semibold mb-3">{isEdit ? 'Edit resource' : 'Add agenda resource'}</p>

          {error && <div className="alert alert-danger py-2 small mb-3">{error}</div>}

          <div className="mb-3">
            <label className="form-label small fw-semibold">Type</label>
            <div className="d-flex gap-2 flex-wrap">
              {TYPES.map(([v, l, icon]) => (
                <button key={v} type="button"
                  className={`btn btn-sm d-inline-flex align-items-center gap-1 ${type === v ? 'btn-dark' : 'btn-outline-secondary'}`}
                  style={{ borderRadius: 8, fontSize: '0.76rem' }}
                  onClick={() => setType(v)}>
                  <i className={`bi ${icon}`} /> {l}
                </button>
              ))}
            </div>
          </div>

          <div className="mb-3">
            <label className="form-label small fw-semibold">Name <span className="text-danger">*</span></label>
            <input type="text" className="form-control form-control-sm" style={{ borderRadius: 8 }}
              placeholder="e.g. Q2 agenda template" value={name} onChange={(e) => setName(e.target.value)} />
          </div>

          <div className="mb-3">
            <label className="form-label small fw-semibold">URL <span className="text-danger">*</span></label>
            <input type="url" className="form-control form-control-sm" style={{ borderRadius: 8 }}
              placeholder="https://…" value={url} onChange={(e) => setUrl(e.target.value)} />
          </div>

          <div className="mb-3">
            <label className="form-label small fw-semibold">Brand <span className="text-muted fw-normal">(optional)</span></label>
            <select className="form-select form-select-sm" style={{ borderRadius: 8 }}
              value={brandId} onChange={(e) => setBrandId(e.target.value)}>
              <option value="">No brand — general agenda resource</option>
              {brands.map((b) => <option key={b.id} value={b.id}>{b.brand_name}</option>)}
            </select>
          </div>

          <div className="mb-3">
            <label className="form-label small fw-semibold">Description</label>
            <textarea className="form-control form-control-sm" rows={2} style={{ borderRadius: 8 }}
              placeholder="Optional note…" value={description} onChange={(e) => setDescription(e.target.value)} />
          </div>

          <div className="d-flex gap-2 justify-content-end">
            <button className="btn btn-sm btn-outline-secondary px-3" onClick={onClose} disabled={saving}>Cancel</button>
            <button className="btn btn-sm btn-dark px-3 d-inline-flex align-items-center gap-1" onClick={handleSave} disabled={saving}>
              {saving ? <><span className="spinner-border spinner-border-sm" /> Saving…</> : <><i className="bi bi-check-lg" /> {isEdit ? 'Save' : 'Add resource'}</>}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
