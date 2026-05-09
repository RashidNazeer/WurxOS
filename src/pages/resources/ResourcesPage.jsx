import { useEffect, useMemo, useState } from 'react';
import { useQueries, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '../../contexts/AuthContext';
import { supabase } from '../../lib/supabase';
import { listBrands } from '../../lib/brandsApi';
import {
  listResources, createResource, updateResource, deleteResource,
  detectSource, thumbnailFor, timeAgo, uniqueCreators,
} from '../../lib/resourcesApi';
import { ROLES, roleLabel } from '../../lib/roles';
import {
  PlusIcon, SearchIcon, AlertIcon, RefreshIcon, XIcon, LinkIcon,
  PencilIcon, CheckIcon, BookmarkIcon, StarIcon, UserIcon, UsersIcon,
  GridIcon, MenuIcon, FolderIcon, ChevronLeftIcon,
} from '../../components/common/Icon';
import BrandAvatar from '../../components/brands/BrandAvatar';
import '../../styles/table.css';
import '../../styles/modal.css';

const DESCRIPTION_MAX = 240;

const TYPE_FILTERS = ['all', 'link', 'image', 'video', 'file'];

export default function ResourcesPage() {
  const { user, profile } = useAuth();
  const role = profile?.role;
  const isAdmin = ['boss', 'ol', 'developer'].includes(role);

  const [q, setQ]                     = useState('');
  const [type, setType]               = useState('all');
  const [scope, setScope]             = useState('all');     // all | brand | general
  const [brandFilter, setBrandFilter] = useState('all');
  // 'folders' is the new default — resources are organized into
  // brand folders for navigation. Drilling into a folder switches
  // to grid view filtered to that brand.
  const [view, setView]               = useState('folders'); // folders | grid | list
  const [editing, setEditing]         = useState(null);
  const [showAdd, setShowAdd]         = useState(false);
  const [localErr, setLocalErr]       = useState('');

  const qc = useQueryClient();
  const results = useQueries({
    queries: [
      { queryKey: ['resources', 'list'],   queryFn: () => listResources() },
      { queryKey: ['resources', 'brands'], queryFn: () => listBrands() },
    ],
  });
  const [rowsQ, brandsQ] = results;
  const rows    = rowsQ.data   || [];
  const brands  = brandsQ.data || [];
  const loading = rowsQ.isPending;
  const err     = localErr || results.find((r) => r.error)?.error?.message || '';
  const reload  = () => qc.invalidateQueries({ queryKey: ['resources'] });

  // --- Stats (always computed against the unfiltered list) ---
  const stats = useMemo(() => {
    const out = { all: rows.length, link: 0, image: 0, video: 0, file: 0 };
    for (const r of rows) out[r.type] = (out[r.type] || 0) + 1;
    return out;
  }, [rows]);

  // --- Filtered list ---
  const filtered = useMemo(() => {
    const qq = q.trim().toLowerCase();
    return rows.filter((r) => {
      if (type !== 'all' && r.type !== type) return false;
      if (scope === 'brand'   && !r.brand_id) return false;
      if (scope === 'general' &&  r.brand_id) return false;
      if (brandFilter !== 'all' && r.brand_id !== brandFilter) return false;
      if (qq && !(
        (r.name || '').toLowerCase().includes(qq) ||
        (r.description || '').toLowerCase().includes(qq) ||
        (r.url || '').toLowerCase().includes(qq) ||
        (r.brand?.brand_name || '').toLowerCase().includes(qq)
      )) return false;
      return true;
    });
  }, [rows, q, type, scope, brandFilter]);

  // --- Folder groupings (brand_id → resources). Includes a
  // synthetic "general" bucket for resources without a brand.
  // Type/search filters DO apply so folders update with filters,
  // but brandFilter is intentionally ignored here (it's the very
  // thing folders express).
  const folders = useMemo(() => {
    const qq = q.trim().toLowerCase();
    const matchesText = (r) => !qq || (
      (r.name || '').toLowerCase().includes(qq) ||
      (r.description || '').toLowerCase().includes(qq) ||
      (r.url || '').toLowerCase().includes(qq) ||
      (r.brand?.brand_name || '').toLowerCase().includes(qq)
    );
    const matchesType  = (r) => type === 'all' || r.type === type;
    const matchesScope = (r) =>
      scope === 'all' || (scope === 'brand' && r.brand_id) || (scope === 'general' && !r.brand_id);

    const buckets = new Map();
    for (const r of rows) {
      if (!matchesText(r) || !matchesType(r) || !matchesScope(r)) continue;
      const key = r.brand_id || '__general';
      if (!buckets.has(key)) buckets.set(key, { brand: r.brand || null, items: [] });
      buckets.get(key).items.push(r);
    }
    // Add empty folders for brands the user can see but that have no
    // resources yet — useful so they can drill in and add the first.
    for (const b of brands) {
      if (!buckets.has(b.id)) buckets.set(b.id, { brand: b, items: [] });
    }
    return Array.from(buckets.entries()).map(([key, v]) => ({
      key,
      brand: v.brand,
      brandName: key === '__general' ? 'General' : (v.brand?.brand_name || 'Untitled'),
      items: v.items,
    })).sort((a, b) => {
      // General last; otherwise alphabetical with non-empty folders first
      if (a.key === '__general') return 1;
      if (b.key === '__general') return -1;
      if ((a.items.length === 0) !== (b.items.length === 0)) return a.items.length === 0 ? 1 : -1;
      return a.brandName.localeCompare(b.brandName);
    });
  }, [rows, brands, q, type, scope]);

  const insideFolder = view !== 'folders' && brandFilter !== 'all';
  const insideFolderName = insideFolder
    ? (brandFilter === '__general'
        ? 'General'
        : (brands.find((b) => b.id === brandFilter)?.brand_name || 'Folder'))
    : null;

  function openFolder(key) {
    setBrandFilter(key);
    setScope(key === '__general' ? 'general' : 'all');
    setView('grid');
  }
  function backToFolders() {
    setBrandFilter('all');
    setScope('all');
    setView('folders');
  }

  function canEdit(r) {
    if (r.created_by === user?.id) return true;
    if (isAdmin) return true;
    if (r.brand_id && r.brand?.owner_id === user?.id) return true;
    return false;
  }

  async function onDelete(row) {
    if (!confirm(`Delete "${row.name}"?`)) return;
    try { await deleteResource(row.id); reload(); }
    catch (e) { setLocalErr(e.message); }
  }

  return (
    <>
      <div className="page-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: 12 }}>
        <div>
          <h1 className="page-title">Resources</h1>
          <p className="page-subtitle">Links, images and videos shared across brands and the team.</p>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="wx-btn wx-btn-ghost" onClick={reload}><RefreshIcon width="15" height="15" /></button>
          <div className="wx-segmented" role="group" aria-label="View">
            <button
              type="button"
              className="wx-segmented-btn"
              data-active={view === 'folders'}
              onClick={backToFolders}
            >
              <FolderIcon width="14" height="14" /> Folders
            </button>
            <button
              type="button"
              className="wx-segmented-btn"
              data-active={view === 'grid'}
              onClick={() => setView('grid')}
            >
              <GridIcon width="14" height="14" /> Grid
            </button>
            <button
              type="button"
              className="wx-segmented-btn"
              data-active={view === 'list'}
              onClick={() => setView('list')}
            >
              <MenuIcon width="14" height="14" /> List
            </button>
          </div>
          <button className="wx-btn wx-btn-primary" onClick={() => setShowAdd(true)}>
            <PlusIcon width="15" height="15" /> Add resource
          </button>
        </div>
      </div>

      {/* Stats strip */}
      <div style={{
        display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(140px, 100%), 1fr))',
        gap: 10, marginBottom: 14,
      }}>
        <StatTile label="Total"    value={stats.all}    active={type === 'all'}   onClick={() => setType('all')} />
        <StatTile label="Links"    value={stats.link}   active={type === 'link'}  onClick={() => setType('link')} />
        <StatTile label="Images"   value={stats.image}  active={type === 'image'} onClick={() => setType('image')} />
        <StatTile label="Videos"   value={stats.video}  active={type === 'video'} onClick={() => setType('video')} />
        <StatTile label="Files"    value={stats.file}   active={type === 'file'}  onClick={() => setType('file')} />
      </div>

      <div className="wx-toolbar">
        <div className="wx-search" style={{ flex: 1, minWidth: 240 }}>
          <span className="wx-search-icon"><SearchIcon width="16" height="16" /></span>
          <input className="wx-input" placeholder="Search name, URL, description, brand…" value={q}
            onChange={(e) => setQ(e.target.value)} />
        </div>
        <select className="wx-input" value={brandFilter} onChange={(e) => setBrandFilter(e.target.value)} style={{ maxWidth: 200 }}>
          <option value="all">All brands</option>
          {brands.map((b) => <option key={b.id} value={b.id}>{b.brand_name}</option>)}
        </select>
        <div style={{ display: 'flex', gap: 6 }}>
          {['all','brand','general'].map((s) => (
            <button key={s} type="button"
              className={`wx-role-chip ${scope === s ? 'wx-role-chip-active' : ''}`}
              onClick={() => setScope(s)}>{s === 'all' ? 'All' : s === 'brand' ? 'Brand' : 'General'}</button>
          ))}
        </div>
        <div style={{ display: 'flex', gap: 6 }}>
          {TYPE_FILTERS.map((t) => (
            <button key={t} type="button"
              className={`wx-role-chip ${type === t ? 'wx-role-chip-active' : ''}`}
              onClick={() => setType(t)}>{t}</button>
          ))}
        </div>
      </div>

      {err && (
        <div className="wx-alert wx-alert-danger" style={{ marginBottom: 14 }}>
          <AlertIcon width="16" height="16" /> <span>{err}</span>
        </div>
      )}

      {/* Breadcrumb shown when drilled into a folder. Lets users
          jump back to the folder grid in one click. */}
      {insideFolder && (
        <div style={{
          display: 'flex', alignItems: 'center', gap: 10,
          marginBottom: 14,
          fontSize: 13, color: 'var(--text-secondary)',
        }}>
          <button
            type="button"
            onClick={backToFolders}
            className="wx-btn wx-btn-ghost"
            style={{ padding: '6px 10px', fontSize: 12.5 }}
          >
            <ChevronLeftIcon width="14" height="14" /> All folders
          </button>
          <span style={{ color: 'var(--text-muted)' }}>/</span>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontWeight: 600, color: 'var(--text-primary)' }}>
            <FolderIcon width="14" height="14" style={{ color: 'var(--accent)' }} />
            {insideFolderName}
          </span>
        </div>
      )}

      {loading ? (
        <div className="wx-empty"><span className="wx-spinner" /> Loading…</div>
      ) : view === 'folders' ? (
        folders.length === 0 ? (
          <div className="wx-empty">
            <div className="wx-empty-title">No folders yet</div>
            <div>Create a brand or add a general resource to see folders here.</div>
          </div>
        ) : (
          <div style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fill, minmax(min(200px, 100%), 1fr))',
            gap: 12,
          }}>
            {folders.map((f) => (
              <FolderCard
                key={f.key}
                folder={f}
                onOpen={() => openFolder(f.key)}
              />
            ))}
          </div>
        )
      ) : filtered.length === 0 ? (
        <div className="wx-empty">
          <div className="wx-empty-title">{rows.length === 0 ? 'No resources yet' : 'Nothing matches your filters'}</div>
          <div>{rows.length === 0 ? 'Click Add resource to share your first one.' : 'Try clearing the filters.'}</div>
        </div>
      ) : view === 'grid' ? (
        <div style={{
          display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(min(240px, 100%), 1fr))', gap: 12,
        }}>
          {filtered.map((r) => (
            <ResourceCard key={r.id} row={r}
              canEdit={canEdit(r)}
              onEdit={() => setEditing(r)}
              onDelete={() => onDelete(r)} />
          ))}
        </div>
      ) : (
        <ResourceTable rows={filtered} canEdit={canEdit} onEdit={setEditing} onDelete={onDelete} />
      )}

      {showAdd && (
        <ResourceModal mode="create" brands={brands} canPickBrand
          onClose={() => setShowAdd(false)}
          onSaved={() => { setShowAdd(false); reload(); }} />
      )}
      {editing && (
        <ResourceModal mode="edit" resource={editing} brands={brands} canPickBrand
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); reload(); }} />
      )}
    </>
  );
}

// ============================================================
function StatTile({ label, value, active, onClick }) {
  return (
    <button type="button" onClick={onClick} className="wx-card"
      style={{
        padding: 14, textAlign: 'left', cursor: 'pointer',
        background: active ? 'var(--accent-soft)' : 'var(--surface-1)',
        borderColor: active ? 'var(--accent)' : 'var(--border-subtle)',
      }}>
      <div style={{ fontSize: 11, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>{label}</div>
      <div style={{ fontSize: 22, fontWeight: 800, color: active ? 'var(--accent)' : 'var(--text-primary)' }}>{value}</div>
    </button>
  );
}

function SourceBadge({ url }) {
  const src = detectSource(url);
  return (
    <span className="pc-pill pc-pill-muted" style={{ textTransform: 'none', fontSize: 10.5, fontWeight: 700 }}>
      {src.label}
    </span>
  );
}

// ============================================================
// FolderCard — one card per brand (plus a synthetic "General"
// folder for resources without a brand). Shows the brand avatar,
// name, resource count, and a hint of the most recent items.
function FolderCard({ folder, onOpen }) {
  const isGeneral = folder.key === '__general';
  const itemCount = folder.items.length;
  const latest = folder.items.slice(0, 3); // hint at content

  return (
    <button
      type="button"
      onClick={onOpen}
      className="wx-card"
      style={{
        padding: 14,
        textAlign: 'left',
        cursor: 'pointer',
        display: 'flex',
        flexDirection: 'column',
        gap: 12,
        minHeight: 130,
        transition: 'transform var(--dur-fast), border-color var(--dur-fast), box-shadow var(--dur-fast)',
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.borderColor = 'var(--accent)';
        e.currentTarget.style.transform = 'translateY(-1px)';
        e.currentTarget.style.boxShadow = '0 4px 14px -6px var(--accent-ring)';
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.borderColor = 'var(--border-subtle)';
        e.currentTarget.style.transform = 'translateY(0)';
        e.currentTarget.style.boxShadow = '';
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        {isGeneral ? (
          <div style={{
            width: 38, height: 38,
            borderRadius: 'var(--radius-md)',
            background: 'var(--surface-2)',
            display: 'grid', placeItems: 'center',
            color: 'var(--text-muted)',
            flex: '0 0 auto',
          }}>
            <FolderIcon width="18" height="18" />
          </div>
        ) : folder.brand ? (
          <BrandAvatar brand={folder.brand} size={38} />
        ) : (
          <div style={{
            width: 38, height: 38,
            borderRadius: 'var(--radius-md)',
            background: 'var(--accent-soft)',
            color: 'var(--accent)',
            display: 'grid', placeItems: 'center',
            flex: '0 0 auto',
          }}>
            <FolderIcon width="18" height="18" />
          </div>
        )}
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{
            fontWeight: 700, fontSize: 14,
            color: 'var(--text-primary)',
            whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
          }}>
            {folder.brandName}
          </div>
          <div style={{ fontSize: 11.5, color: 'var(--text-muted)', marginTop: 2 }}>
            {itemCount} {itemCount === 1 ? 'item' : 'items'}
            {isGeneral && ' · no brand'}
          </div>
        </div>
      </div>

      {latest.length > 0 ? (
        <div style={{
          display: 'flex', flexDirection: 'column', gap: 4,
          fontSize: 12, color: 'var(--text-secondary)',
          flex: 1, minHeight: 0,
        }}>
          {latest.map((r) => (
            <div
              key={r.id}
              style={{
                display: 'flex', alignItems: 'center', gap: 6,
                whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
              }}
            >
              <span style={{
                width: 5, height: 5, borderRadius: '50%',
                background: 'var(--accent)', flex: '0 0 auto',
              }} />
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>
                {r.name}
              </span>
            </div>
          ))}
          {itemCount > 3 && (
            <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>
              + {itemCount - 3} more
            </div>
          )}
        </div>
      ) : (
        <div style={{
          fontSize: 12, color: 'var(--text-muted)',
          fontStyle: 'italic',
          flex: 1, display: 'flex', alignItems: 'center',
        }}>
          Empty folder — open to add the first resource.
        </div>
      )}
    </button>
  );
}

function ResourceCard({ row, canEdit, onEdit, onDelete }) {
  const thumb = thumbnailFor(row);
  const src   = detectSource(row.url);
  return (
    <div className="wx-card" style={{ padding: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      {thumb ? (
        <a href={row.url} target="_blank" rel="noreferrer"
          style={{ display: 'block', position: 'relative', height: 140, background: 'var(--surface-2)' }}>
          <img src={thumb} alt={row.name}
            style={{ width: '100%', height: '100%', objectFit: 'cover' }}
            onError={(e) => { e.currentTarget.style.display = 'none'; }} />
          {src.source === 'youtube' && (
            <span style={{
              position: 'absolute', inset: 0, display: 'grid', placeItems: 'center',
              fontSize: 38, color: 'rgba(255,255,255,0.92)', textShadow: '0 0 6px rgba(0,0,0,0.6)',
              pointerEvents: 'none',
            }}>▶</span>
          )}
        </a>
      ) : (
        <div style={{ height: 90, background: 'var(--surface-2)', display: 'grid', placeItems: 'center' }}>
          <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase' }}>{src.label}</span>
        </div>
      )}

      <div style={{ padding: 12, display: 'flex', flexDirection: 'column', gap: 6, flex: 1 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
          <SourceBadge url={row.url} />
          {row.brand && (
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11, color: 'var(--text-muted)' }}>
              <BrandAvatar brand={row.brand} size={14} radius={3} /> {row.brand.brand_name}
            </span>
          )}
          {!row.brand_id && (
            <VisibilityBadge resource={row} />
          )}
          <div style={{ marginLeft: 'auto', display: 'flex', gap: 2 }}>
            {canEdit && (
              <>
                <button onClick={onEdit} title="Edit"
                  style={{ border: 0, background: 'transparent', color: 'var(--text-muted)', cursor: 'pointer', padding: 2 }}>
                  <PencilIcon width="13" height="13" />
                </button>
                <button onClick={onDelete} title="Delete"
                  style={{ border: 0, background: 'transparent', color: 'var(--text-muted)', cursor: 'pointer', padding: 2 }}>
                  <XIcon width="13" height="13" />
                </button>
              </>
            )}
          </div>
        </div>
        <a href={row.url} target="_blank" rel="noreferrer"
          style={{ color: 'var(--accent)', fontWeight: 700, fontSize: 13.5, textDecoration: 'none', wordBreak: 'break-word' }}>
          <LinkIcon width="12" height="12" style={{ marginRight: 4 }} />{row.name}
        </a>
        {row.description && (
          <div style={{ fontSize: 12.5, color: 'var(--text-secondary)' }}>{row.description}</div>
        )}
        <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 'auto' }}>
          {row.creator?.display_name || '—'} · {timeAgo(row.created_at)}
        </div>
      </div>
    </div>
  );
}

function ResourceTable({ rows, canEdit, onEdit, onDelete }) {
  return (
    <div className="wx-list resource-table">
      <div className="wx-list-row wx-list-header resource-table-row" style={{ gridTemplateColumns: '40px 1fr 1fr 110px 130px 90px' }}>
        <div /><div>Name</div><div>Brand / scope</div><div>Type</div><div>Added by</div><div />
      </div>
      {rows.map((r) => {
        const src = detectSource(r.url);
        const thumb = thumbnailFor(r);
        return (
          <div key={r.id} className="wx-list-row resource-table-row" style={{ gridTemplateColumns: '40px 1fr 1fr 110px 130px 90px', alignItems: 'center' }}>
            <div style={{ width: 40, height: 40, background: 'var(--surface-2)', borderRadius: 'var(--radius-sm)', overflow: 'hidden' }}>
              {thumb && <img src={thumb} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />}
            </div>
            <div style={{ minWidth: 0 }}>
              <a href={r.url} target="_blank" rel="noreferrer"
                style={{ color: 'var(--accent)', fontWeight: 700, fontSize: 13, textDecoration: 'none', wordBreak: 'break-word' }}>{r.name}</a>
              {r.description && <div style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>{r.description}</div>}
            </div>
            <div style={{ fontSize: 12 }}>
              {r.brand
                ? <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}><BrandAvatar brand={r.brand} size={14} radius={3} /> {r.brand.brand_name}</span>
                : <VisibilityBadge resource={r} />}
            </div>
            <div><SourceBadge url={r.url} /></div>
            <div style={{ fontSize: 11.5 }}>
              <div style={{ fontWeight: 600 }}>{r.creator?.display_name}</div>
              <div style={{ color: 'var(--text-muted)' }}>{timeAgo(r.created_at)}</div>
            </div>
            <div style={{ display: 'flex', gap: 4, justifyContent: 'flex-end' }}>
              {canEdit(r) && (
                <>
                  <button onClick={() => onEdit(r)} className="wx-btn wx-btn-ghost" style={{ padding: '4px 8px' }}>
                    <PencilIcon width="12" height="12" />
                  </button>
                  <button onClick={() => onDelete(r)} className="wx-btn wx-btn-ghost" style={{ padding: '4px 8px', color: 'var(--danger)' }}>
                    <XIcon width="12" height="12" />
                  </button>
                </>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function VisibilityBadge({ resource }) {
  if (resource.brand_id) return null;
  const v = resource.visibility;
  let label = 'Office';
  if (v === 'private') label = 'Private';
  if (v === 'user')    label = 'Shared with 1';
  if (v === 'group')   label = `${(resource.visible_to_roles || []).map(roleLabel).join(', ')}`;
  return (
    <span style={{
      fontSize: 10.5, fontWeight: 700, padding: '2px 7px',
      borderRadius: 'var(--radius-pill)',
      background: 'var(--surface-2)', color: 'var(--text-secondary)',
    }}>{label}</span>
  );
}

// ============================================================
// Add / Edit modal — covers all v1 visibility scopes.
// ============================================================
export function ResourceModal({
  mode = 'create', resource = null, brands = [],
  canPickBrand = false, lockedBrandId = null,
  onClose, onSaved,
}) {
  const isEdit = mode === 'edit';
  const [name, setName]               = useState(resource?.name || '');
  const [url,  setUrl]                = useState(resource?.url  || '');
  const [desc, setDesc]               = useState(resource?.description || '');
  const [brandId, setBrandId]         = useState(resource?.brand_id || lockedBrandId || '');
  const [scope, setScope]             = useState(
    (resource?.brand_id || lockedBrandId) ? 'brand' : 'general',
  );
  const [visibility, setVisibility]   = useState(resource?.visibility || 'office');
  const [visibleToUid, setUid]        = useState(resource?.visible_to_uid || '');
  const [visibleToRoles, setRoles]    = useState(resource?.visible_to_roles || []);
  const [users, setUsers]             = useState([]);
  // Opt-in notifications — default off so silent edits don't ping
  // the brand team / group.
  const [notify, setNotify]           = useState(false);
  const [saving, setSaving]           = useState(false);
  const [err, setErr]                 = useState('');

  const detected = detectSource(url);

  // Lazy-load profiles for the user picker only when needed
  if (visibility === 'user' && users.length === 0) {
    supabase.from('profiles').select('id, display_name, email, role')
      .eq('is_active', true).order('display_name')
      .then(({ data }) => setUsers(data || []));
  }

  function toggleRole(r) {
    setRoles((cur) => cur.includes(r) ? cur.filter((x) => x !== r) : [...cur, r]);
  }

  async function submit(e) {
    e.preventDefault(); setErr('');
    if (!name.trim() || !url.trim()) return setErr('Name and URL are required.');
    if (scope === 'brand' && !brandId) return setErr('Pick a brand for brand-scoped resources.');
    if (scope === 'general' && visibility === 'user' && !visibleToUid)
      return setErr('Pick the user this resource is shared with.');
    if (scope === 'general' && visibility === 'group' && visibleToRoles.length === 0)
      return setErr('Pick at least one role for group visibility.');
    setSaving(true);
    try {
      const payload = {
        brandId:        scope === 'brand'   ? brandId : null,
        type:           detected.type,
        name, url, description: desc,
        visibility:     scope === 'brand'   ? 'office' : visibility,
        visibleToUid:   visibility === 'user'  ? visibleToUid : null,
        visibleToRoles: visibility === 'group' ? visibleToRoles : [],
        notify,
      };
      if (isEdit) await updateResource(resource.id, payload);
      else        await createResource(payload);
      onSaved();
    } catch (e) { setErr(e.message); }
    finally { setSaving(false); }
  }

  // --- URL helpers ----------------------------------------------
  // Strip the protocol we render as a pill prefix so the input field
  // shows only what the user types after "https://". Paste also works —
  // the onChange handler normalizes either http/https away.
  const urlCore = url.replace(/^https?:\/\//i, '');
  const urlStatus = (() => {
    if (!urlCore.trim()) return null;
    if (!/^[a-z0-9.-]+\.[a-z]{2,}(\/.*)?$/i.test(urlCore)) return { tone: 'warn', label: 'Awaiting' };
    return { tone: 'ok', label: detected.label };
  })();

  // --- Keyboard shortcuts: Esc closes, Cmd/Ctrl+Enter submits ---
  useEffect(() => {
    function onKey(e) {
      if (e.key === 'Escape') { e.preventDefault(); onClose(); }
      else if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
        e.preventDefault();
        document.getElementById('wx-resource-form')?.requestSubmit();
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const scopeCards = [
    { v: 'brand',   title: 'Brand',   sub: 'Brand-specific',          Icon: StarIcon },
    { v: 'general', title: 'General', sub: 'Visible across the workspace', Icon: GlobeGlyph },
  ];
  const visCards = [
    { v: 'private', label: 'Only me',       Icon: UserIcon },
    { v: 'user',    label: 'Specific user', Icon: UserPlusGlyph },
    { v: 'group',   label: 'Roles',         Icon: UsersIcon },
    { v: 'office',  label: 'Everyone',      Icon: GlobeGlyph },
  ];

  return (
    <div className="wx-modal-backdrop wx-m-backdrop" onClick={onClose}>
      <div className="wx-modal" onClick={(e) => e.stopPropagation()}>
        <form id="wx-resource-form" onSubmit={submit}>
          {/* ---------- Header ---------- */}
          <div className="wx-m-head">
            <div className="wx-m-head-icon"><ResourceGlyph /></div>
            <div className="wx-m-head-text">
              <div className="wx-m-head-title">{isEdit ? 'Edit resource' : 'Add resource'}</div>
              <div className="wx-m-head-sub">Share a link, doc, or tool with your team</div>
            </div>
            <button type="button" className="wx-m-head-close" onClick={onClose} aria-label="Close">
              <XIcon width="14" height="14" />
            </button>
          </div>

          {/* ---------- Body ---------- */}
          <div className="wx-m-body">
            {err && (
              <div className="wx-alert wx-alert-danger">
                <AlertIcon width="14" height="14" /> <span>{err}</span>
              </div>
            )}

            {/* Name */}
            <div className="wx-m-field">
              <div className="wx-m-field-head">
                <div className="wx-m-field-label">Resource name</div>
                <div className="wx-m-field-meta is-required">Required</div>
              </div>
              <input
                className="wx-m-input"
                value={name}
                onChange={(e) => setName(e.target.value)}
                disabled={saving}
                autoFocus
                placeholder="e.g. Q2 Brand Guidelines"
              />
            </div>

            {/* URL */}
            <div className="wx-m-field">
              <div className="wx-m-field-head">
                <div className="wx-m-field-label">URL</div>
                <div className="wx-m-field-meta">Must be reachable</div>
              </div>
              <div className="wx-m-input-shell">
                <div className="wx-m-input-prefix">https://</div>
                <input
                  value={urlCore}
                  onChange={(e) => {
                    const stripped = e.target.value.replace(/^https?:\/\//i, '');
                    setUrl(stripped ? 'https://' + stripped : '');
                  }}
                  disabled={saving}
                  placeholder="notion.so/brand-guide"
                />
                {urlStatus && (
                  <span className={`wx-m-input-suffix is-${urlStatus.tone}`}>{urlStatus.label}</span>
                )}
              </div>
            </div>

            {/* Description */}
            <div className="wx-m-field">
              <div className="wx-m-field-head">
                <div className="wx-m-field-label">Description</div>
                <div className="wx-m-field-meta">Optional</div>
              </div>
              <div className="wx-m-textarea-shell">
                <textarea
                  rows={3}
                  value={desc}
                  onChange={(e) => setDesc(e.target.value.slice(0, DESCRIPTION_MAX))}
                  disabled={saving}
                  placeholder="A short note so teammates know what this is for…"
                />
                <div className={`wx-m-char-count ${desc.length > DESCRIPTION_MAX - 20 ? 'is-warn' : ''}`}>
                  {desc.length} / {DESCRIPTION_MAX}
                </div>
              </div>
            </div>

            {/* Scope */}
            {!lockedBrandId && (
              <div className="wx-m-field">
                <div className="wx-m-field-head">
                  <div className="wx-m-field-label">Scope</div>
                  <div className="wx-m-field-meta">
                    {scope === 'brand' ? 'Pinned to one brand' : 'Visible across the workspace'}
                  </div>
                </div>
                <div className="wx-m-cards" data-cols="2">
                  {scopeCards.map((c) => (
                    <button key={c.v} type="button"
                      className={`wx-m-card ${scope === c.v ? 'is-active' : ''}`}
                      onClick={() => setScope(c.v)} disabled={saving}>
                      <div className="wx-m-card-icon"><c.Icon width="15" height="15" /></div>
                      <div className="wx-m-card-main">
                        <div className="wx-m-card-title">{c.title}</div>
                        <div className="wx-m-card-sub">{c.sub}</div>
                      </div>
                      <span className="wx-m-card-check"><CheckIcon width="11" height="11" /></span>
                    </button>
                  ))}
                </div>
              </div>
            )}

            {scope === 'brand' && !lockedBrandId && (
              <div className="wx-m-field">
                <div className="wx-m-field-head">
                  <div className="wx-m-field-label">Brand</div>
                  <div className="wx-m-field-meta is-required">Required</div>
                </div>
                <select className="wx-m-input" value={brandId}
                  onChange={(e) => setBrandId(e.target.value)}
                  disabled={saving || !canPickBrand}>
                  <option value="">— pick a brand —</option>
                  {brands.map((b) => <option key={b.id} value={b.id}>{b.brand_name}</option>)}
                </select>
              </div>
            )}

            {scope === 'general' && (
              <div className="wx-m-field">
                <div className="wx-m-field-head">
                  <div className="wx-m-field-label">Visibility</div>
                  <div className="wx-m-field-meta">
                    {visibility === 'group' && visibleToRoles.length > 0
                      ? `${visibleToRoles.length} role${visibleToRoles.length === 1 ? '' : 's'} will see this`
                      : visibility === 'private' ? 'Only you will see this'
                      : visibility === 'office'  ? 'Everyone in the workspace'
                      : visibility === 'user'    ? 'One teammate will see this'
                      : ''}
                  </div>
                </div>
                <div className="wx-m-cards" data-cols="4">
                  {visCards.map((c) => (
                    <button key={c.v} type="button"
                      className={`wx-m-card is-compact ${visibility === c.v ? 'is-active' : ''}`}
                      onClick={() => setVisibility(c.v)} disabled={saving}>
                      <div className="wx-m-card-icon"><c.Icon width="15" height="15" /></div>
                      <div className="wx-m-card-title">{c.label}</div>
                      <span className="wx-m-card-check"><CheckIcon width="11" height="11" /></span>
                    </button>
                  ))}
                </div>

                {visibility === 'user' && (
                  <select className="wx-m-input" style={{ marginTop: 8 }}
                    value={visibleToUid} onChange={(e) => setUid(e.target.value)} disabled={saving}>
                    <option value="">— pick a user —</option>
                    {users.map((u) => <option key={u.id} value={u.id}>{u.display_name} · {u.role}</option>)}
                  </select>
                )}

                {visibility === 'group' && (
                  <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 8 }}>
                    {ROLES.map((r) => (
                      <button key={r.value} type="button"
                        className={`wx-role-chip ${visibleToRoles.includes(r.value) ? 'wx-role-chip-active' : ''}`}
                        onClick={() => toggleRole(r.value)} disabled={saving}>{r.label}</button>
                    ))}
                  </div>
                )}
              </div>
            )}

            {/* Opt-in notifications — default off. Audience follows scope. */}
            <label className={`wx-m-optin ${notify ? 'is-active' : ''}`}>
              <input type="checkbox" checked={notify}
                onChange={(e) => setNotify(e.target.checked)}
                disabled={saving} />
              <div>
                <div className="wx-m-optin-title">Notify the audience</div>
                <div className="wx-m-optin-sub">
                  {scope === 'brand'
                    ? 'Send the brand owner and assigned APCs an in-app + push notification.'
                    : visibility === 'user'
                      ? 'Send the selected user an in-app + push notification.'
                      : visibility === 'group'
                        ? 'Send everyone in the selected roles an in-app + push notification.'
                        : 'Leave off for a silent change — no notification is sent.'}
                </div>
              </div>
            </label>
          </div>

          {/* ---------- Footer ---------- */}
          <div className="wx-m-foot">
            <div className="wx-m-kbd-hints">
              <kbd>Esc</kbd> cancel
              <span>·</span>
              <kbd>⌘</kbd><kbd>↵</kbd> submit
            </div>
            <div className="wx-m-foot-actions">
              <button type="button" className="wx-btn wx-btn-ghost" onClick={onClose} disabled={saving}>Cancel</button>
              <button type="submit" className="wx-btn wx-btn-primary" disabled={saving}>
                {saving
                  ? <><span className="wx-spinner" /> {isEdit ? 'Saving…' : 'Adding…'}</>
                  : <><CheckIcon width="14" height="14" /> {isEdit ? 'Save changes' : 'Add resource'}</>}
              </button>
            </div>
          </div>
        </form>
      </div>
    </div>
  );
}

// ---- Inline glyphs used in the resource modal only --------------
function ResourceGlyph() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <polyline points="14 2 14 8 20 8" />
      <path d="M10 13a2 2 0 0 1 2-2h2" />
      <path d="M14 17a2 2 0 0 1-2 2h-2" />
    </svg>
  );
}
function GlobeGlyph(props) {
  return (
    <svg width={props.width || 15} height={props.height || 15} viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="10" />
      <line x1="2" y1="12" x2="22" y2="12" />
      <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
    </svg>
  );
}
function UserPlusGlyph(props) {
  return (
    <svg width={props.width || 15} height={props.height || 15} viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
      <circle cx="9" cy="7" r="4" />
      <line x1="19" y1="8" x2="19" y2="14" />
      <line x1="22" y1="11" x2="16" y2="11" />
    </svg>
  );
}
