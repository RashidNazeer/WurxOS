// VERBATIM PORT of v1 components/resources/AllResourcesPage.js (986 LOC).
// Surgical patches only:
//   1. Firebase imports → v1-compat shim (resourcesApiV1)
//   2. useAuth() returns {user, profile} in v2 → reconstruct v1's
//      {currentUser, userRole, apcProfile, userProfile}
//   3. createNotification import → dropped (v2's resources_notify
//      trigger handles fan-out server-side via the `notify` field)
//   4. serverTimestamp() → dropped (v2 created_at default)
//   5. getDocs/addDoc/updateDoc/deleteDoc → addResourceV1/updateResourceV1/
//      deleteResourceV1/listAllResourcesV1
import React, { useEffect, useState, useMemo } from 'react';
import { useAuth } from '../../contexts/AuthContext';
import { useBrands } from '../../contexts/BrandsContext';
import {
  listAllResourcesV1, listAllUsersV1,
  addResourceV1, updateResourceV1, deleteResourceV1,
} from '../../lib/resourcesApiV1';
import {
  VISIBILITY_OPTIONS, VISIBILITY_GROUP_ROLE_OPTIONS,
  canUserSeeGeneralResource, allowedVisibilitiesForRole, allowedGroupTargetsForRole,
} from '../../utils/resourceVisibility';

const BRAND_PALETTE = ['#0d6efd','#6610f2','#198754','#fd7e14','#dc3545','#0dcaf0','#6f42c1','#d63384'];
function brandColor(name = '') {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = name.charCodeAt(i) + ((h << 5) - h);
  return BRAND_PALETTE[Math.abs(h) % BRAND_PALETTE.length];
}

const TYPE_CFG = {
  link:  { icon: 'bi-link-45deg',       label: 'Link',  color: '#0d6efd', bg: '#e8f0fe' },
  image: { icon: 'bi-image-fill',        label: 'Image', color: '#6610f2', bg: '#f3e8ff' },
  video: { icon: 'bi-camera-video-fill', label: 'Video', color: '#dc3545', bg: '#ffe8e8' },
  file:  { icon: 'bi-file-earmark-text', label: 'File',  color: '#0dcaf0', bg: '#e0f7fa' },
};

function detectType(url = '') {
  const u = url.toLowerCase();
  if (/\.(jpg|jpeg|png|gif|webp|svg|avif)(\?|$)/.test(u)) return 'image';
  if (/\.(mp4|webm|mov|avi)(\?|$)/.test(u) || /youtube\.com|youtu\.be|vimeo\.com/.test(u)) return 'video';
  if (/\.(pdf|docx?|xlsx?|pptx?|csv|zip|rar|7z|txt|md)(\?|$)/.test(u)) return 'file';
  return 'link';
}

function timeAgo(ts) {
  if (!ts) return '';
  const d    = ts.seconds ? new Date(ts.seconds * 1000) : new Date(ts);
  const diff = Math.floor((Date.now() - d) / 60000);
  if (diff < 1)     return 'Just now';
  if (diff < 60)    return `${diff}m ago`;
  if (diff < 1440)  return `${Math.floor(diff / 60)}h ago`;
  if (diff < 10080) return `${Math.floor(diff / 1440)}d ago`;
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

export default function AllResourcesPage() {
  // v2 auth shim → v1 shape
  const { user, profile } = useAuth();
  const currentUser = user ? { uid: user.id, email: user.email, displayName: profile?.display_name || '' } : null;
  const userRole = profile?.role || '';
  const apcProfile = (userRole === 'apc' || userRole === 'ipc')
    ? { userName: profile?.display_name || '' }
    : null;
  const userProfile = { displayName: profile?.display_name || '' };

  const isApc = Boolean(apcProfile);
  const isAllBrands = userRole === 'boss' || userRole === 'ol';
  const myRole = userRole || 'tl';

  const { brands: ctxBrands } = useBrands();
  // v2 useBrands returns brands shaped with brandName/ownerId aliases — pass through.
  const brands = ctxBrands || [];

  const [resources, setResources] = useState([]);
  const [allUsers,  setAllUsers]  = useState([]); // for visibility picker
  const [loading,   setLoading]   = useState(true);
  const [viewMode,  setViewMode]  = useState('grid');

  const [search,      setSearch]      = useState('');
  const [filterBrand, setFilterBrand] = useState('');
  const [filterType,  setFilterType]  = useState('');
  const [filterScope, setFilterScope] = useState(''); // 'brand' | 'general'

  const [showAddModal,    setShowAddModal]    = useState(false);
  const [addSaving,       setAddSaving]       = useState(false);
  const [editingResource, setEditingResource] = useState(null);

  const fromName = isApc
    ? (apcProfile?.userName || currentUser?.displayName || currentUser?.email?.split('@')[0] || 'APC')
    : (userProfile?.displayName || currentUser?.displayName || currentUser?.email?.split('@')[0] || 'Team Lead');

  // ── Load everything (v2: single query — RLS does brand+general filtering)
  useEffect(() => {
    if (!currentUser) return;
    let cancelled = false;
    async function load() {
      setLoading(true);
      try {
        const [allResources, loadedUsers] = await Promise.all([
          listAllResourcesV1(),
          listAllUsersV1(),
        ]);
        if (cancelled) return;
        // RLS already filters out general resources the user can't see, but
        // run the v1 client guard as defense-in-depth.
        const uid = currentUser.uid;
        const filteredResources = allResources.filter((r) => {
          if (r._scope === 'brand') return true;
          return canUserSeeGeneralResource(r, { uid, role: myRole });
        });
        setResources(filteredResources);
        setAllUsers(loadedUsers);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    load();
    return () => { cancelled = true; };
  }, [currentUser?.uid, myRole]);

  // ── Create resource handler
  async function handleAdd(data) {
    setAddSaving(true);
    try {
      const newResource = await addResourceV1({
        type: data.type,
        name: data.name,
        url: data.url,
        description: data.description,
        brandId: data.brandId || null,
        visibility: data.visibility,
        visibleToUid: data.visibleToUid,
        visibleToRoles: data.visibleToRoles,
        notifyInApp: data.notifyInApp,
      });
      setResources((prev) => [newResource, ...prev]);
      setShowAddModal(false);
    } catch (e) {
      console.error('Failed to add resource:', e);
      alert('Failed to add resource: ' + (e.message || 'unknown error'));
    }
    setAddSaving(false);
  }

  // ── Delete
  async function handleDelete(resource) {
    // Permission: creator can always delete; Boss/OL can delete any; TL can delete brand resources they own
    const canDelete = resource.createdBy === currentUser?.uid
      || resource.addedBy?.uid === currentUser?.uid
      || myRole === 'boss'
      || myRole === 'ol'
      || (resource._scope === 'brand' && !!resource.brandId && brands.some(b => b.id === resource.brandId));
    if (!canDelete) { alert('You do not have permission to delete this resource.'); return; }
    if (!window.confirm(`Delete "${resource.name}"? This cannot be undone.`)) return;
    try {
      await deleteResourceV1(resource.id);
      setResources(prev => prev.filter(r => r.id !== resource.id));
    } catch (e) {
      alert('Failed to delete: ' + (e.message || 'unknown error'));
    }
  }

  // ── Edit resource handler
  async function handleEdit(data) {
    if (!editingResource) return;
    setAddSaving(true);
    try {
      const patch = {
        name: data.name,
        url: data.url,
        type: data.type,
        description: data.description,
        notifyInApp: false, // edits never re-notify (defense-in-depth)
      };
      if (editingResource._scope === 'general') {
        patch.visibility = data.visibility;
        patch.visibleToUid = data.visibleToUid;
        patch.visibleToRoles = data.visibleToRoles;
      }
      const updated = await updateResourceV1(editingResource.id, patch);
      setResources(prev => prev.map(r =>
        r.id === editingResource.id ? { ...r, ...updated } : r
      ));
      setEditingResource(null);
    } catch (e) {
      alert('Failed to update resource: ' + (e.message || 'unknown error'));
    }
    setAddSaving(false);
  }

  const filtered = useMemo(() => resources.filter(r => {
    if (filterBrand && r.brandId !== filterBrand) return false;
    if (filterType  && r.type   !== filterType)   return false;
    if (filterScope === 'brand' && r._scope !== 'brand') return false;
    if (filterScope === 'general' && r._scope !== 'general') return false;
    if (search) {
      const q = search.toLowerCase();
      if (!r.name?.toLowerCase().includes(q) &&
          !r.description?.toLowerCase().includes(q) &&
          !r.url?.toLowerCase().includes(q) &&
          !r.brandName?.toLowerCase().includes(q)) return false;
    }
    return true;
  }), [resources, search, filterBrand, filterType, filterScope]);

  const typeCounts = useMemo(() => {
    const c = { link: 0, image: 0, video: 0, file: 0 };
    resources.forEach(r => { if (c[r.type] !== undefined) c[r.type]++; });
    return c;
  }, [resources]);

  const hasFilters = search || filterBrand || filterType || filterScope;
  function clearFilters() { setSearch(''); setFilterBrand(''); setFilterType(''); setFilterScope(''); }

  return (
    <div style={{ padding: '32px 32px 48px' }}>
      {/* Header */}
      <div className="d-flex align-items-start justify-content-between mb-4 flex-wrap gap-3">
        <div>
          <h5 className="fw-bold mb-1 d-flex align-items-center gap-2" style={{ color: 'var(--text-primary)' }}>
            <i className="bi bi-collection-fill" style={{ fontSize: '1.15rem' }} />
            All Resources
          </h5>
          <p className="text-muted small mb-0">
            Links, images, and videos — brand resources plus general shared resources
          </p>
        </div>

        <div className="d-flex align-items-center gap-2">
          {/* View toggle */}
          <div className="btn-group btn-group-sm" role="group">
            <button
              className={`btn ${viewMode === 'grid' ? 'btn-dark' : 'btn-outline-secondary'}`}
              style={{ borderRadius: '8px 0 0 8px' }}
              onClick={() => setViewMode('grid')}
              title="Grid view"
            >
              <i className="bi bi-grid-3x3-gap-fill" />
            </button>
            <button
              className={`btn ${viewMode === 'list' ? 'btn-dark' : 'btn-outline-secondary'}`}
              style={{ borderRadius: '0 8px 8px 0' }}
              onClick={() => setViewMode('list')}
              title="List view"
            >
              <i className="bi bi-list-ul" />
            </button>
          </div>

          {/* Add Resource */}
          <button
            className="btn btn-sm btn-dark d-inline-flex align-items-center gap-1"
            style={{ borderRadius: 8, fontSize: '0.8rem' }}
            onClick={() => setShowAddModal(true)}
          >
            <i className="bi bi-plus-lg" style={{ fontSize: '0.72rem' }} />
            Add Resource
          </button>
        </div>
      </div>

      {/* Stats strip */}
      {!loading && (
        <div className="d-flex flex-wrap gap-2 mb-4">
          <div className="d-flex align-items-center gap-2 px-3 py-2 rounded-2" style={{ background: 'var(--surface-2)', border: '1px solid var(--border-subtle)' }}>
            <span className="fw-bold" style={{ color: 'var(--text-primary)', fontSize: '1.1rem', lineHeight: 1 }}>{resources.length}</span>
            <span style={{ fontSize: '0.72rem', color: 'var(--text-secondary)', fontWeight: 500 }}>Total</span>
          </div>
          {Object.entries(TYPE_CFG).map(([type, cfg]) => (
            <div
              key={type}
              className="d-flex align-items-center gap-2 px-3 py-2 rounded-2"
              style={{ background: cfg.bg, border: `1px solid ${cfg.color}22`, cursor: 'pointer' }}
              onClick={() => setFilterType(filterType === type ? '' : type)}
              title={`Filter by ${cfg.label}`}
            >
              <i className={`bi ${cfg.icon}`} style={{ color: cfg.color, fontSize: '0.9rem' }} />
              <span className="fw-bold" style={{ color: cfg.color, fontSize: '1.1rem', lineHeight: 1 }}>{typeCounts[type]}</span>
              <span style={{ fontSize: '0.72rem', color: cfg.color, opacity: 0.8, fontWeight: 500 }}>{cfg.label}s</span>
            </div>
          ))}
        </div>
      )}

      {/* Filters */}
      <div className="card border-0 shadow-sm mb-4" style={{ borderRadius: 12 }}>
        <div className="card-body p-3">
          <div className="d-flex flex-wrap gap-2 align-items-center">

            <div className="position-relative" style={{ flex: '1 1 200px', minWidth: 180 }}>
              <i className="bi bi-search position-absolute text-muted"
                style={{ left: 10, top: '50%', transform: 'translateY(-50%)', fontSize: '0.78rem', pointerEvents: 'none' }} />
              <input
                type="text"
                className="form-control form-control-sm"
                placeholder="Search by name, URL, description…"
                style={{ paddingLeft: 30, borderRadius: 8 }}
                value={search}
                onChange={e => setSearch(e.target.value)}
              />
            </div>

            <select
              className="form-select form-select-sm"
              style={{ borderRadius: 8, width: 'auto', minWidth: 140 }}
              value={filterBrand}
              onChange={e => setFilterBrand(e.target.value)}
            >
              <option value="">All Brands</option>
              {brands.map(b => <option key={b.id} value={b.id}>{b.brandName || b.brand_name}</option>)}
            </select>

            <select
              className="form-select form-select-sm"
              style={{ borderRadius: 8, width: 'auto', minWidth: 120 }}
              value={filterType}
              onChange={e => setFilterType(e.target.value)}
            >
              <option value="">All Types</option>
              {Object.entries(TYPE_CFG).map(([v, c]) => <option key={v} value={v}>{c.label}</option>)}
            </select>

            {/* Scope pills */}
            <div className="d-flex gap-1 flex-shrink-0">
              {[
                { key: 'brand',   label: 'Brand',   icon: 'bi-shop' },
                { key: 'general', label: 'General', icon: 'bi-globe2' },
              ].map(v => (
                <button key={v.key}
                  className="btn btn-sm d-inline-flex align-items-center gap-1"
                  style={{
                    borderRadius: 8, fontSize: '0.72rem', fontWeight: 600, whiteSpace: 'nowrap',
                    background: filterScope === v.key ? '#0d6efd' : 'var(--surface-2)',
                    color: filterScope === v.key ? '#fff' : 'var(--text-secondary)',
                    border: filterScope === v.key ? '1.5px solid #0d6efd' : '1.5px solid var(--border-subtle)',
                  }}
                  onClick={() => setFilterScope(filterScope === v.key ? '' : v.key)}>
                  <i className={`bi ${v.icon}`} style={{ fontSize: '0.65rem' }} />{v.label}
                </button>
              ))}
            </div>

            {hasFilters && (
              <button
                className="btn btn-sm btn-outline-secondary d-inline-flex align-items-center gap-1 ms-auto"
                style={{ borderRadius: 8, fontSize: '0.75rem', whiteSpace: 'nowrap' }}
                onClick={clearFilters}
              >
                <i className="bi bi-x-circle" /> Clear filters
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Content */}
      {loading ? (
        <div className="d-flex align-items-center gap-2 py-5 text-muted">
          <span className="spinner-border spinner-border-sm" />
          <span className="small">Loading resources…</span>
        </div>
      ) : filtered.length === 0 ? (
        <div
          className="d-flex flex-column align-items-center justify-content-center py-5"
          style={{ border: '2px dashed var(--border-subtle)', borderRadius: 16, background: 'var(--surface-1)' }}
        >
          <div className="rounded-circle d-flex align-items-center justify-content-center mb-3" style={{ width: 64, height: 64, background: 'var(--surface-2)' }}>
            <i className="bi bi-collection text-muted" style={{ fontSize: '1.6rem', opacity: 0.55 }} />
          </div>
          <p className="fw-semibold mb-1" style={{ color: 'var(--text-primary)' }}>
            {hasFilters ? 'No resources match your filters' : 'No resources yet'}
          </p>
          <p className="text-muted small mb-0">
            {hasFilters ? 'Try adjusting your search or filters.' : 'Click "Add Resource" to create one.'}
          </p>
          {hasFilters && (
            <button className="btn btn-sm btn-outline-secondary mt-3" style={{ borderRadius: 8 }} onClick={clearFilters}>
              Clear filters
            </button>
          )}
        </div>

      ) : viewMode === 'grid' ? (
        <>
          <div className="row g-3">
            {filtered.map(r => (
              <div key={`${r._scope}-${r.brandId || 'g'}-${r.id}`} className="col-md-6 col-xl-4">
                <ResourceCard r={r} onDelete={handleDelete} onEdit={setEditingResource} currentUid={currentUser?.uid} myRole={myRole} brands={brands} />
              </div>
            ))}
          </div>
          <div className="mt-3" style={{ fontSize: '0.72rem', color: 'var(--text-muted)' }}>
            Showing <strong style={{ color: 'var(--text-secondary)' }}>{filtered.length}</strong> of <strong style={{ color: 'var(--text-secondary)' }}>{resources.length}</strong> resource{resources.length !== 1 ? 's' : ''}
          </div>
        </>
      ) : (
        <ResourceListView resources={filtered} total={resources.length} onDelete={handleDelete} onEdit={setEditingResource} currentUid={currentUser?.uid} myRole={myRole} brands={brands} />
      )}

      {/* Add modal */}
      {showAddModal && (
        <AddResourceModal
          brands={brands}
          allUsers={allUsers}
          currentUser={currentUser}
          myRole={myRole}
          isApc={isApc}
          saving={addSaving}
          onClose={() => setShowAddModal(false)}
          onAdd={handleAdd}
        />
      )}

      {/* Edit modal */}
      {editingResource && (
        <AddResourceModal
          brands={brands}
          allUsers={allUsers}
          currentUser={currentUser}
          myRole={myRole}
          isApc={isApc}
          saving={addSaving}
          onClose={() => setEditingResource(null)}
          onAdd={handleEdit}
          editing={editingResource}
        />
      )}
    </div>
  );
}

// ── Resource card (grid view) ────────────────────────────────────────────

function ResourceCard({ r, onDelete, onEdit, currentUid, myRole, brands }) {
  const tCfg = TYPE_CFG[r.type] || TYPE_CFG.link;
  const bc   = brandColor(r.brandName);
  const isGeneral = r._scope === 'general';
  const visCfg = isGeneral ? VISIBILITY_OPTIONS[r.visibility] : null;

  const isCreator = r.createdBy === currentUid || r.addedBy?.uid === currentUid;
  const manageBrand = r._scope === 'brand' && !!r.brandId && brands.some(b => b.id === r.brandId);
  const canEdit = isCreator || myRole === 'boss' || myRole === 'ol' || manageBrand;
  const canDelete = canEdit;

  return (
    <div
      className="card border-0 shadow-sm h-100"
      style={{ borderRadius: 14, transition: 'transform 0.12s, box-shadow 0.12s', position: 'relative' }}
      onMouseEnter={e => { e.currentTarget.style.transform = 'translateY(-2px)'; e.currentTarget.style.boxShadow = '0 6px 24px rgba(0,0,0,0.1)'; }}
      onMouseLeave={e => { e.currentTarget.style.transform = ''; e.currentTarget.style.boxShadow = ''; }}
    >
      <div style={{ height: 4, borderRadius: '14px 14px 0 0', background: isGeneral ? `linear-gradient(90deg,${tCfg.color},#6610f2)` : `linear-gradient(90deg,${bc},${tCfg.color})` }} />

      <div className="card-body p-3 d-flex flex-column gap-2" style={{ minWidth: 0, overflow: 'hidden' }}>
        <div className="d-flex align-items-start gap-2" style={{ minWidth: 0 }}>
          <div className="rounded-2 d-flex align-items-center justify-content-center flex-shrink-0"
            style={{ width: 38, height: 38, background: tCfg.bg }}>
            <i className={`bi ${tCfg.icon}`} style={{ color: tCfg.color, fontSize: '1.05rem' }} />
          </div>
          <div className="flex-grow-1" style={{ minWidth: 0, overflow: 'hidden' }}>
            <p className="fw-semibold mb-0" style={{ fontSize: '0.88rem', color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {r.name}
            </p>
            <div className="d-flex align-items-center gap-1 flex-wrap mt-1">
              <span className="badge rounded-pill"
                style={{ background: tCfg.bg, color: tCfg.color, border: `1px solid ${tCfg.color}30`, fontSize: '0.6rem', fontWeight: 600 }}>
                {tCfg.label}
              </span>
              {isGeneral && visCfg && (
                <span className="badge rounded-pill d-inline-flex align-items-center gap-1"
                  style={{ background: `${visCfg.color}15`, color: visCfg.color, border: `1px solid ${visCfg.color}30`, fontSize: '0.58rem', fontWeight: 600 }}
                  title={visCfg.label}>
                  <i className={`bi ${visCfg.icon}`} style={{ fontSize: '0.55rem' }} />
                  {r.visibility === 'private' ? 'Private' : r.visibility === 'office' ? 'Office' : r.visibility === 'user' ? 'Shared' : 'Group'}
                </span>
              )}
            </div>
          </div>
          <div className="d-flex gap-1 flex-shrink-0">
            {canEdit && (
              <button
                className="btn btn-sm btn-light border-0 rounded-circle"
                style={{ width: 26, height: 26, padding: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-muted)' }}
                onClick={() => onEdit(r)}
                title="Edit"
              >
                <i className="bi bi-pencil" style={{ fontSize: '0.7rem' }} />
              </button>
            )}
            {canDelete && (
              <button
                className="btn btn-sm btn-light border-0 rounded-circle"
                style={{ width: 26, height: 26, padding: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-muted)' }}
                onClick={() => onDelete(r)}
                title="Delete"
              >
                <i className="bi bi-trash" style={{ fontSize: '0.7rem' }} />
              </button>
            )}
          </div>
        </div>

        {r.description && (
          <p className="text-muted mb-0" style={{ fontSize: '0.78rem', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>
            {r.description}
          </p>
        )}

        {r.url && (
          <a href={r.url} target="_blank" rel="noopener noreferrer"
            className="d-flex align-items-center gap-1"
            style={{ fontSize: '0.72rem', color: tCfg.color, textDecoration: 'none', minWidth: 0, overflow: 'hidden' }}
            onClick={e => e.stopPropagation()}>
            <i className="bi bi-box-arrow-up-right flex-shrink-0" style={{ fontSize: '0.65rem' }} />
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 }}>{r.url}</span>
          </a>
        )}

        <div className="d-flex align-items-center justify-content-between mt-auto pt-2" style={{ borderTop: '1px solid var(--border-subtle)' }}>
          {isGeneral ? (
            <span className="d-inline-flex align-items-center gap-1 rounded-pill px-2 py-1"
              style={{ background: 'var(--surface-2)', border: '1px solid var(--border-subtle)', fontSize: '0.65rem', fontWeight: 600, color: 'var(--text-secondary)' }}>
              <i className="bi bi-globe2" style={{ fontSize: '0.6rem' }} />
              General
            </span>
          ) : (
            <span className="d-inline-flex align-items-center gap-1 rounded-pill px-2 py-1"
              style={{ background: `${bc}15`, border: `1px solid ${bc}30`, fontSize: '0.65rem', fontWeight: 600, color: bc, maxWidth: 110, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              <span className="rounded-circle flex-shrink-0" style={{ width: 5, height: 5, background: bc, display: 'inline-block' }} />
              {r.brandName}
            </span>
          )}
          <div className="text-end">
            {r.addedBy?.name && <div style={{ fontSize: '0.62rem', color: 'var(--text-muted)' }}>{r.addedBy.name}</div>}
            <div style={{ fontSize: '0.62rem', color: 'var(--text-muted)' }}>{timeAgo(r.createdAt)}</div>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── List view ────────────────────────────────────────────────────────────

function ResourceListView({ resources, total, onDelete, onEdit, currentUid, myRole, brands }) {
  return (
    <div className="card border-0 shadow-sm" style={{ borderRadius: 14, overflow: 'hidden' }}>
      <div style={{ overflowX: 'auto' }}>
        <table className="table table-hover mb-0" style={{ fontSize: '0.83rem', minWidth: 640 }}>
          <thead>
            <tr style={{ background: 'var(--surface-0)' }}>
              {['Resource', 'Type', 'Scope', 'Added By', 'Date', ''].map(col => (
                <th key={col} style={{ padding: '10px 16px', fontSize: '0.68rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--text-muted)', borderBottom: '2px solid var(--border-subtle)' }}>
                  {col}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {resources.map(r => {
              const tCfg = TYPE_CFG[r.type] || TYPE_CFG.link;
              const bc   = brandColor(r.brandName);
              const isGeneral = r._scope === 'general';
              const isCreator = r.createdBy === currentUid || r.addedBy?.uid === currentUid;
              const manageBrand = r._scope === 'brand' && !!r.brandId && brands.some(b => b.id === r.brandId);
              const canEdit = isCreator || myRole === 'boss' || myRole === 'ol' || manageBrand;
              const canDelete = canEdit;
              return (
                <tr key={`${r._scope}-${r.brandId || 'g'}-${r.id}`}>
                  <td style={{ padding: '11px 16px', verticalAlign: 'middle', maxWidth: 280 }}>
                    <div className="d-flex align-items-center gap-2">
                      <div className="rounded-2 d-flex align-items-center justify-content-center flex-shrink-0" style={{ width: 30, height: 30, background: tCfg.bg }}>
                        <i className={`bi ${tCfg.icon}`} style={{ color: tCfg.color, fontSize: '0.85rem' }} />
                      </div>
                      <div className="min-width-0">
                        <div className="fw-medium text-truncate" style={{ maxWidth: 200 }}>{r.name}</div>
                        {r.url && (
                          <a href={r.url} target="_blank" rel="noopener noreferrer" className="text-truncate d-block" style={{ fontSize: '0.7rem', color: tCfg.color, textDecoration: 'none', maxWidth: 200 }}>
                            {r.url}
                          </a>
                        )}
                      </div>
                    </div>
                  </td>
                  <td style={{ padding: '11px 16px', verticalAlign: 'middle' }}>
                    <span className="badge rounded-pill" style={{ background: tCfg.bg, color: tCfg.color, border: `1px solid ${tCfg.color}30`, fontSize: '0.65rem', fontWeight: 600 }}>
                      {tCfg.label}
                    </span>
                  </td>
                  <td style={{ padding: '11px 16px', verticalAlign: 'middle' }}>
                    {isGeneral ? (
                      <span className="d-inline-flex align-items-center gap-1 rounded-pill px-2 py-1" style={{ background: 'var(--surface-2)', border: '1px solid var(--border-subtle)', fontSize: '0.68rem', fontWeight: 600, color: 'var(--text-secondary)' }}>
                        <i className="bi bi-globe2" style={{ fontSize: '0.6rem' }} />
                        General
                      </span>
                    ) : (
                      <span className="d-inline-flex align-items-center gap-1 rounded-pill px-2 py-1" style={{ background: `${bc}15`, border: `1px solid ${bc}30`, fontSize: '0.68rem', fontWeight: 600, color: bc }}>
                        <span className="rounded-circle" style={{ width: 5, height: 5, background: bc, display: 'inline-block', flexShrink: 0 }} />
                        {r.brandName}
                      </span>
                    )}
                  </td>
                  <td style={{ padding: '11px 16px', verticalAlign: 'middle', fontSize: '0.78rem', color: 'var(--text-secondary)' }}>{r.addedBy?.name || '—'}</td>
                  <td style={{ padding: '11px 16px', verticalAlign: 'middle', fontSize: '0.72rem', color: 'var(--text-muted)' }}>{timeAgo(r.createdAt)}</td>
                  <td style={{ padding: '11px 8px', verticalAlign: 'middle', textAlign: 'right' }}>
                    <div className="d-flex gap-1 justify-content-end">
                      {canEdit && (
                        <button className="btn btn-sm btn-link p-0" style={{ color: 'var(--text-muted)', fontSize: '0.82rem' }} onClick={() => onEdit(r)} title="Edit">
                          <i className="bi bi-pencil" />
                        </button>
                      )}
                      {canDelete && (
                        <button className="btn btn-sm btn-link p-0" style={{ color: 'var(--text-muted)', fontSize: '0.82rem' }} onClick={() => onDelete(r)} title="Delete">
                          <i className="bi bi-trash" />
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="px-4 py-2 border-top d-flex align-items-center justify-content-between" style={{ background: 'var(--surface-0)', fontSize: '0.72rem', color: 'var(--text-muted)' }}>
        <span>Showing <strong style={{ color: 'var(--text-secondary)' }}>{resources.length}</strong> of <strong style={{ color: 'var(--text-secondary)' }}>{total}</strong> resource{total !== 1 ? 's' : ''}</span>
      </div>
    </div>
  );
}

// ── Add Resource Modal ───────────────────────────────────────────────────

function AddResourceModal({ brands, allUsers, currentUser, myRole, isApc, saving, onClose, onAdd, editing }) {
  const isEdit = Boolean(editing);
  const defaultBrandId = isEdit ? (editing.brandId || '') : (isApc && brands.length === 1 ? brands[0].id : '');
  const [scope, setScope] = useState(isEdit ? (editing._scope || 'brand') : 'brand');
  const [brandId, setBrandId] = useState(defaultBrandId);
  const [name, setName] = useState(isEdit ? (editing.name || '') : '');
  const [url, setUrl] = useState(isEdit ? (editing.url || '') : '');
  const [description, setDescription] = useState(isEdit ? (editing.description || '') : '');
  const [notifyInApp, setNotifyInApp] = useState(!isEdit);
  const [error, setError] = useState('');

  // Visibility (only for general)
  const allowedVisibilities = allowedVisibilitiesForRole(myRole);
  const [visibility, setVisibility] = useState(isEdit ? (editing.visibility || allowedVisibilities[0] || 'private') : (allowedVisibilities[0] || 'private'));
  const [visibleToUid, setVisibleToUid] = useState(isEdit ? (editing.visibleToUid || '') : '');
  const [visibleToRoles, setVisibleToRoles] = useState(isEdit ? (editing.visibleToRoles || []) : []);
  const [userSearch, setUserSearch] = useState('');

  const allowedGroupRoles = allowedGroupTargetsForRole(myRole);

  const type = url ? detectType(url) : 'link';

  const userOptions = useMemo(() => {
    const list = allUsers.filter(u => u.id !== currentUser?.uid);
    if (!userSearch.trim()) return list;
    const s = userSearch.toLowerCase();
    return list.filter(u => u.name?.toLowerCase().includes(s) || u.role?.toLowerCase().includes(s));
  }, [allUsers, currentUser, userSearch]);

  function toggleRole(role) {
    setVisibleToRoles(prev => prev.includes(role) ? prev.filter(r => r !== role) : [...prev, role]);
  }

  function handleSubmit(e) {
    e.preventDefault();
    setError('');
    if (!name.trim()) { setError('Name is required.'); return; }
    if (!url.trim()) { setError('URL is required.'); return; }
    try { new URL(url.trim()); } catch { setError('URL looks invalid.'); return; }
    if (scope === 'brand' && !brandId) { setError('Please select a brand.'); return; }
    if (scope === 'general') {
      if (visibility === 'user' && !visibleToUid) { setError('Please select a user to share with.'); return; }
      if (visibility === 'group' && visibleToRoles.length === 0) { setError('Please select at least one role.'); return; }
    }

    onAdd({
      type,
      name: name.trim(),
      url: url.trim(),
      description: description.trim(),
      brandId: scope === 'brand' ? brandId : null,
      visibility: scope === 'general' ? visibility : null,
      visibleToUid,
      visibleToRoles,
      notifyInApp,
    });
  }

  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 1050, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
      <div style={{ position: 'absolute', inset: 0, background: 'rgba(0,0,0,0.5)', backdropFilter: 'blur(2px)' }} onClick={onClose} />
      <div className="card border-0 shadow-lg" style={{ position: 'relative', width: '100%', maxWidth: 560, zIndex: 1, borderRadius: 16, maxHeight: '92vh', overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
        <div className="card-body p-4" style={{ overflowY: 'auto' }}>
          <div className="d-flex align-items-center justify-content-between mb-4">
            <div>
              <h6 className="fw-bold mb-0">{isEdit ? 'Edit Resource' : 'Add Resource'}</h6>
              <p className="text-muted small mb-0">{isEdit ? 'Update resource details' : 'Share a link, image, or video'}</p>
            </div>
            <button className="btn btn-sm btn-light border-0 rounded-circle" onClick={onClose}
              style={{ width: 32, height: 32, padding: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <i className="bi bi-x-lg" style={{ fontSize: '0.85rem' }} />
            </button>
          </div>

          <form onSubmit={handleSubmit}>
            {error && (
              <div className="alert alert-danger py-2 small mb-3 d-flex align-items-center gap-2">
                <i className="bi bi-exclamation-circle flex-shrink-0" />{error}
              </div>
            )}

            {/* Scope selector */}
            <div className="mb-3">
              <label className="form-label small fw-semibold">Resource type</label>
              <div className="d-flex gap-2">
                <button type="button"
                  onClick={() => setScope('brand')}
                  className="d-inline-flex align-items-center gap-2 rounded-3 border flex-grow-1 p-2"
                  style={{
                    background: scope === 'brand' ? '#e8f0fe' : 'var(--surface-1)',
                    borderColor: scope === 'brand' ? '#0d6efd' : 'var(--border-subtle)',
                    cursor: 'pointer',
                  }}>
                  <i className="bi bi-shop" style={{ color: '#0d6efd' }} />
                  <div className="text-start" style={{ lineHeight: 1.2 }}>
                    <div className="small fw-semibold" style={{ color: scope === 'brand' ? '#0d6efd' : 'var(--text-secondary)' }}>Brand resource</div>
                    <div style={{ fontSize: '0.65rem', color: 'var(--text-muted)' }}>Tied to a specific brand</div>
                  </div>
                </button>
                <button type="button"
                  onClick={() => setScope('general')}
                  className="d-inline-flex align-items-center gap-2 rounded-3 border flex-grow-1 p-2"
                  style={{
                    background: scope === 'general' ? '#e8f0fe' : 'var(--surface-1)',
                    borderColor: scope === 'general' ? '#0d6efd' : 'var(--border-subtle)',
                    cursor: 'pointer',
                  }}>
                  <i className="bi bi-globe2" style={{ color: '#0d6efd' }} />
                  <div className="text-start" style={{ lineHeight: 1.2 }}>
                    <div className="small fw-semibold" style={{ color: scope === 'general' ? '#0d6efd' : 'var(--text-secondary)' }}>General</div>
                    <div style={{ fontSize: '0.65rem', color: 'var(--text-muted)' }}>Personal or shared</div>
                  </div>
                </button>
              </div>
            </div>

            {/* Brand picker (brand scope) */}
            {scope === 'brand' && (
              <div className="mb-3">
                <label className="form-label small fw-semibold">Brand <span className="text-danger">*</span></label>
                <select className="form-select form-select-sm" style={{ borderRadius: 8 }}
                  value={brandId} onChange={e => setBrandId(e.target.value)}>
                  <option value="">Select a brand…</option>
                  {brands.map(b => <option key={b.id} value={b.id}>{b.brandName || b.brand_name}</option>)}
                </select>
              </div>
            )}

            {/* Visibility picker (general scope) */}
            {scope === 'general' && (
              <div className="mb-3">
                <label className="form-label small fw-semibold">Who can see this?</label>
                <div className="d-flex flex-column gap-1">
                  {allowedVisibilities.map(v => {
                    const cfg = VISIBILITY_OPTIONS[v];
                    return (
                      <label key={v}
                        className="d-flex align-items-center gap-2 p-2 rounded-2"
                        style={{
                          background: visibility === v ? `${cfg.color}15` : 'var(--surface-1)',
                          border: `1.5px solid ${visibility === v ? cfg.color + '55' : 'var(--border-subtle)'}`,
                          cursor: 'pointer',
                        }}>
                        <input type="radio" className="form-check-input" checked={visibility === v} onChange={() => setVisibility(v)} />
                        <i className={`bi ${cfg.icon}`} style={{ color: cfg.color }} />
                        <span className="small fw-medium" style={{ color: visibility === v ? cfg.color : 'var(--text-secondary)' }}>
                          {cfg.label}
                        </span>
                      </label>
                    );
                  })}
                </div>

                {/* Specific user picker */}
                {visibility === 'user' && (
                  <div className="mt-2">
                    <input
                      type="text"
                      className="form-control form-control-sm mb-2"
                      placeholder="Search users…"
                      value={userSearch}
                      onChange={e => setUserSearch(e.target.value)}
                      style={{ borderRadius: 8 }}
                    />
                    <div style={{ maxHeight: 180, overflowY: 'auto', border: '1px solid var(--border-subtle)', borderRadius: 8 }}>
                      {userOptions.length === 0 && (
                        <div className="text-center py-2 small text-muted">No users match</div>
                      )}
                      {userOptions.map(u => (
                        <div key={u.id}
                          className="d-flex align-items-center gap-2 p-2"
                          style={{
                            cursor: 'pointer',
                            background: visibleToUid === u.id ? '#e8f0fe' : 'transparent',
                            borderBottom: '1px solid var(--border-subtle)',
                          }}
                          onClick={() => setVisibleToUid(u.id)}>
                          <input type="radio" checked={visibleToUid === u.id} onChange={() => setVisibleToUid(u.id)} />
                          <div style={{ flex: 1, minWidth: 0 }}>
                            <div className="small fw-semibold text-truncate">{u.name}</div>
                            <div style={{ fontSize: '0.65rem', color: 'var(--text-muted)' }}>{u.role?.toUpperCase()}</div>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* Group role picker */}
                {visibility === 'group' && (
                  <div className="mt-2 d-flex flex-wrap gap-1">
                    {allowedGroupRoles.map(r => {
                      const cfg = VISIBILITY_GROUP_ROLE_OPTIONS[r];
                      if (!cfg) return null;
                      const checked = visibleToRoles.includes(r);
                      return (
                        <button key={r} type="button"
                          onClick={() => toggleRole(r)}
                          className="btn btn-sm rounded-pill d-inline-flex align-items-center gap-1"
                          style={{
                            background: checked ? cfg.color : `${cfg.color}15`,
                            color: checked ? '#fff' : cfg.color,
                            border: `1px solid ${cfg.color}${checked ? '' : '55'}`,
                            fontSize: '0.72rem',
                            fontWeight: 600,
                          }}>
                          {checked && <i className="bi bi-check" />}
                          {cfg.label}
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            )}

            <div className="mb-3">
              <label className="form-label small fw-semibold">URL <span className="text-danger">*</span></label>
              <input type="url" className="form-control form-control-sm" style={{ borderRadius: 8 }}
                placeholder="https://…" value={url} onChange={e => setUrl(e.target.value)} autoFocus />
            </div>

            <div className="mb-3">
              <label className="form-label small fw-semibold">Name <span className="text-danger">*</span></label>
              <input type="text" className="form-control form-control-sm" style={{ borderRadius: 8 }}
                placeholder="A short name for this resource" value={name} onChange={e => setName(e.target.value)} />
            </div>

            <div className="mb-3">
              <label className="form-label small fw-semibold">Description <span className="text-muted fw-normal">(optional)</span></label>
              <textarea className="form-control form-control-sm" style={{ borderRadius: 8 }} rows={2}
                placeholder="What is this resource for?" value={description} onChange={e => setDescription(e.target.value)} />
            </div>

            {/* Notify checkbox — only when target notification makes sense */}
            {((scope === 'brand' && brandId) || (scope === 'general' && visibility === 'user' && visibleToUid)) && (
              <div
                className="d-flex align-items-center gap-2 rounded-2 p-2 mb-3"
                style={{ background: notifyInApp ? '#e8f0fe' : 'var(--surface-0)', border: `1.5px solid ${notifyInApp ? '#c5d5ff' : 'var(--border-subtle)'}`, cursor: 'pointer' }}
                onClick={() => setNotifyInApp(v => !v)}
              >
                <input type="checkbox" className="form-check-input flex-shrink-0"
                  checked={notifyInApp} onChange={e => setNotifyInApp(e.target.checked)}
                  onClick={e => e.stopPropagation()} style={{ cursor: 'pointer' }} />
                <span className="small mb-0" style={{ cursor: 'pointer', color: notifyInApp ? '#0d6efd' : 'var(--text-secondary)' }}>
                  <i className="bi bi-bell me-1" />
                  Notify {scope === 'brand' ? 'brand members' : 'the recipient'}
                </span>
              </div>
            )}

            <div className="d-flex gap-2 justify-content-end">
              <button type="button" className="btn btn-sm btn-outline-secondary px-3" onClick={onClose}>Cancel</button>
              <button type="submit" className="btn btn-sm btn-dark px-3 d-inline-flex align-items-center gap-1" disabled={saving}>
                {saving ? <><span className="spinner-border spinner-border-sm" />{isEdit ? 'Saving…' : 'Adding…'}</> : <><i className={`bi ${isEdit ? 'bi-check-lg' : 'bi-plus-lg'}`} />{isEdit ? 'Save Changes' : 'Add Resource'}</>}
              </button>
            </div>
          </form>
        </div>
      </div>
    </div>
  );
}
