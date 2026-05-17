import React, { useEffect, useMemo, useState } from 'react';
import { useAuth } from '../../contexts/AuthContext';
import {
  listAgendaResources, deleteAgendaResource, subscribeAgendaResources,
} from '../../lib/agendaApi';
import AgendaResourceModal from '../../components/agenda/AgendaResourceModal';

// Weekly Agenda Meetings — Resources foundation. A brand-scoped (or
// general) library of links/files used in agenda meetings.

const TYPE_META = {
  link:  { icon: 'bi-link-45deg',     color: '#0d6efd', label: 'Link' },
  file:  { icon: 'bi-file-earmark',   color: '#6610f2', label: 'File' },
  image: { icon: 'bi-image',          color: '#198754', label: 'Image' },
  video: { icon: 'bi-camera-video',   color: '#dc3545', label: 'Video' },
};

export default function AgendaResourcesPage() {
  const { user } = useAuth();
  const [rows, setRows]       = useState([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch]   = useState('');
  const [typeFilter, setTypeFilter] = useState('');
  const [modalOpen, setModalOpen]   = useState(false);
  const [editing, setEditing]       = useState(null);

  function reload() {
    listAgendaResources()
      .then((r) => setRows(r || []))
      .catch(() => setRows([]))
      .finally(() => setLoading(false));
  }

  useEffect(() => {
    reload();
    const unsub = subscribeAgendaResources(reload);
    return () => unsub();
  }, []);

  const filtered = useMemo(() => {
    return rows.filter((r) => {
      if (typeFilter && r.type !== typeFilter) return false;
      if (search) {
        const q = search.toLowerCase();
        if (!(r.name || '').toLowerCase().includes(q)
          && !(r.description || '').toLowerCase().includes(q)
          && !(r.brand?.brand_name || '').toLowerCase().includes(q)) return false;
      }
      return true;
    });
  }, [rows, search, typeFilter]);

  async function handleDelete(r) {
    if (!window.confirm(`Delete "${r.name}"?`)) return;
    try {
      await deleteAgendaResource(r.id);
      reload();
    } catch (e) {
      alert('Failed to delete: ' + (e.message || 'unknown'));
    }
  }

  return (
    <div style={{ padding: '32px 32px 48px' }}>
      <div className="d-flex align-items-start justify-content-between mb-4 flex-wrap gap-2">
        <div>
          <h5 className="fw-bold mb-1 d-flex align-items-center gap-2" style={{ color: '#1a1a2e' }}>
            <i className="bi bi-folder2-open" style={{ fontSize: '1.15rem' }} />
            Agenda Resources
          </h5>
          <p className="text-muted small mb-0">Shared links and files for the weekly agenda meeting.</p>
        </div>
        <button className="btn btn-sm btn-dark d-inline-flex align-items-center gap-1" style={{ borderRadius: 8, fontSize: '0.8rem' }}
          onClick={() => { setEditing(null); setModalOpen(true); }}>
          <i className="bi bi-plus-lg" style={{ fontSize: '0.72rem' }} /> Add resource
        </button>
      </div>

      <div className="card border-0 shadow-sm mb-4" style={{ borderRadius: 12 }}>
        <div className="card-body p-3 d-flex flex-wrap gap-2 align-items-center">
          <div className="position-relative" style={{ flex: '1 1 200px', minWidth: 180 }}>
            <i className="bi bi-search position-absolute text-muted" style={{ left: 10, top: '50%', transform: 'translateY(-50%)', fontSize: '0.78rem', pointerEvents: 'none' }} />
            <input type="text" className="form-control form-control-sm" placeholder="Search resources…"
              style={{ paddingLeft: 30, borderRadius: 8 }} value={search} onChange={(e) => setSearch(e.target.value)} />
          </div>
          <select className="form-select form-select-sm" style={{ borderRadius: 8, width: 'auto', minWidth: 130 }}
            value={typeFilter} onChange={(e) => setTypeFilter(e.target.value)}>
            <option value="">All types</option>
            {Object.entries(TYPE_META).map(([v, m]) => <option key={v} value={v}>{m.label}</option>)}
          </select>
        </div>
      </div>

      {loading ? (
        <div className="d-flex align-items-center gap-2 py-5 text-muted"><span className="spinner-border spinner-border-sm" /><span className="small">Loading…</span></div>
      ) : filtered.length === 0 ? (
        <div className="d-flex flex-column align-items-center justify-content-center py-5" style={{ border: '2px dashed #dee2e6', borderRadius: 16, background: '#fff' }}>
          <div className="rounded-circle d-flex align-items-center justify-content-center mb-3" style={{ width: 64, height: 64, background: '#f0f1f5' }}>
            <i className="bi bi-folder2-open text-muted" style={{ fontSize: '1.6rem', opacity: 0.4 }} />
          </div>
          <p className="fw-semibold text-dark mb-1">No resources yet</p>
          <p className="text-muted small mb-0">Add the first agenda resource.</p>
        </div>
      ) : (
        <div className="row g-3">
          {filtered.map((r) => {
            const m = TYPE_META[r.type] || TYPE_META.link;
            const mine = r.created_by === user?.id;
            return (
              <div key={r.id} className="col-12 col-md-6 col-xl-4">
                <div className="card border-0 shadow-sm h-100" style={{ borderRadius: 12 }}>
                  <div className="card-body p-3">
                    <div className="d-flex align-items-start gap-2">
                      <div className="rounded-2 d-flex align-items-center justify-content-center flex-shrink-0"
                        style={{ width: 38, height: 38, background: `${m.color}15`, color: m.color }}>
                        <i className={`bi ${m.icon}`} style={{ fontSize: '1rem' }} />
                      </div>
                      <div className="flex-grow-1 min-w-0">
                        <div className="fw-semibold text-truncate" style={{ fontSize: '0.86rem' }}>{r.name}</div>
                        <a href={r.url} target="_blank" rel="noreferrer"
                          className="d-block text-truncate" style={{ fontSize: '0.72rem' }}>{r.url}</a>
                      </div>
                    </div>
                    {r.description && (
                      <p className="text-muted mb-0 mt-2" style={{ fontSize: '0.76rem' }}>{r.description}</p>
                    )}
                    <div className="d-flex align-items-center gap-2 mt-2 flex-wrap" style={{ fontSize: '0.66rem' }}>
                      {r.brand?.brand_name && (
                        <span className="badge rounded-pill" style={{ background: '#fff7ed', color: '#9a3412', border: '1px solid #fed7aa' }}>
                          <i className="bi bi-shop me-1" />{r.brand.brand_name}
                        </span>
                      )}
                      <span className="text-muted">{r.creator?.display_name || ''}</span>
                      {mine && (
                        <div className="ms-auto d-flex gap-1">
                          <button className="btn btn-sm btn-outline-secondary px-2 py-0" style={{ fontSize: '0.66rem', borderRadius: 6 }}
                            onClick={() => { setEditing(r); setModalOpen(true); }}>
                            <i className="bi bi-pencil" />
                          </button>
                          <button className="btn btn-sm btn-outline-danger px-2 py-0" style={{ fontSize: '0.66rem', borderRadius: 6 }}
                            onClick={() => handleDelete(r)}>
                            <i className="bi bi-trash" />
                          </button>
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {modalOpen && (
        <AgendaResourceModal
          resource={editing}
          onClose={() => setModalOpen(false)}
          onSaved={() => { setModalOpen(false); reload(); }}
        />
      )}
    </div>
  );
}
