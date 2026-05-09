import { useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '../../contexts/AuthContext';
import {
  listResources, deleteResource, detectSource, thumbnailFor, timeAgo,
  uniqueCreators, inDateRange,
} from '../../lib/resourcesApi';
import { ResourceModal } from '../../pages/resources/ResourcesPage';
import {
  PlusIcon, SearchIcon, AlertIcon, RefreshIcon, XIcon, LinkIcon,
  PencilIcon, BookmarkIcon,
} from '../common/Icon';

const TYPES = ['all', 'link', 'image', 'video', 'file'];
const RANGES = [
  { key: 'any',    label: 'Any' },
  { key: 'today',  label: 'Today' },
  { key: 'week',   label: 'This week' },
  { key: 'month',  label: 'This month' },
  { key: 'custom', label: 'Custom' },
];

// Compact, brand-scoped variant of ResourcesPage (mirrors v1 ResourcesTab).
export default function BrandResourcesPanel({ brandId, canEdit }) {
  const { user, profile } = useAuth();
  const role = profile?.role;
  const isAdmin = ['boss', 'ol', 'developer'].includes(role);

  const [q, setQ]                 = useState('');
  const [type, setType]           = useState('all');
  const [addedBy, setAddedBy]     = useState('all');
  const [range, setRange]         = useState('any');
  const [custom, setCustom]       = useState({ from: '', to: '' });
  const [editing, setEditing]     = useState(null);
  const [showAdd, setShowAdd]     = useState(false);
  const [localErr, setLocalErr]   = useState('');

  const qc = useQueryClient();
  const { data: rows = [], isLoading: loading, error: queryError } = useQuery({
    queryKey: ['resources', 'brand', brandId],
    queryFn: () => listResources({ brandId }),
    enabled: !!brandId,
  });
  const err = localErr || queryError?.message || '';
  const reload = () => qc.invalidateQueries({ queryKey: ['resources'] });

  const counts = useMemo(() => {
    const c = { all: rows.length, link: 0, image: 0, video: 0, file: 0 };
    for (const r of rows) c[r.type] = (c[r.type] || 0) + 1;
    return c;
  }, [rows]);

  const creators = useMemo(() => uniqueCreators(rows), [rows]);

  const filtered = useMemo(() => {
    const qq = q.trim().toLowerCase();
    return rows.filter((r) => {
      if (type !== 'all' && r.type !== type) return false;
      if (addedBy !== 'all' && r.created_by !== addedBy) return false;
      if (!inDateRange(r.created_at, range, custom)) return false;
      if (qq && !(
        (r.name || '').toLowerCase().includes(qq) ||
        (r.description || '').toLowerCase().includes(qq) ||
        (r.url || '').toLowerCase().includes(qq)
      )) return false;
      return true;
    });
  }, [rows, q, type, addedBy, range, custom]);

  function rowEditable(r) {
    return r.created_by === user?.id || isAdmin || canEdit;
  }
  async function onDelete(r) {
    if (!confirm(`Delete "${r.name}"?`)) return;
    try { await deleteResource(r.id); reload(); }
    catch (e) { setLocalErr(e.message); }
  }

  return (
    <div className="wx-card" style={{ padding: 14, marginTop: 14 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
        <BookmarkIcon width="16" height="16" style={{ color: 'var(--accent)' }} />
        <div style={{ fontWeight: 700, fontSize: 13.5 }}>Resources</div>
        <span style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>{counts.all}</span>
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
          <button type="button" className="wx-btn wx-btn-ghost" onClick={reload} title="Refresh"
            style={{ padding: '4px 8px' }}>
            <RefreshIcon width="13" height="13" />
          </button>
          {canEdit && (
            <button type="button" className="wx-btn wx-btn-primary"
              onClick={() => setShowAdd(true)} style={{ padding: '5px 10px', fontSize: 12 }}>
              <PlusIcon width="12" height="12" /> Add
            </button>
          )}
        </div>
      </div>

      {/* Filter bar */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 8, flexWrap: 'wrap' }}>
        <div className="wx-search" style={{ flex: 1, minWidth: 180 }}>
          <span className="wx-search-icon"><SearchIcon width="14" height="14" /></span>
          <input className="wx-input" placeholder="Search…" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <select className="wx-input" value={addedBy} onChange={(e) => setAddedBy(e.target.value)} style={{ maxWidth: 160 }}>
          <option value="all">Anyone</option>
          {creators.map((c) => <option key={c.id} value={c.id}>{c.display_name}</option>)}
        </select>
        <select className="wx-input" value={range} onChange={(e) => setRange(e.target.value)} style={{ maxWidth: 130 }}>
          {RANGES.map((r) => <option key={r.key} value={r.key}>{r.label}</option>)}
        </select>
      </div>
      {range === 'custom' && (
        <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
          <input type="date" className="wx-input" value={custom.from} onChange={(e) => setCustom({ ...custom, from: e.target.value })} style={{ maxWidth: 160 }} />
          <input type="date" className="wx-input" value={custom.to}   onChange={(e) => setCustom({ ...custom, to:   e.target.value })} style={{ maxWidth: 160 }} />
        </div>
      )}

      {/* Type chips with counts */}
      <div style={{ display: 'flex', gap: 6, marginBottom: 10, flexWrap: 'wrap' }}>
        {TYPES.map((t) => (
          <button key={t} type="button"
            className={`wx-role-chip ${type === t ? 'wx-role-chip-active' : ''}`}
            style={{ padding: '4px 10px', fontSize: 11.5 }}
            onClick={() => setType(t)}>
            {t}{' '}
            <span style={{ opacity: 0.7, marginLeft: 4 }}>{counts[t] || 0}</span>
          </button>
        ))}
      </div>

      {err && (
        <div className="wx-alert wx-alert-danger" style={{ marginBottom: 10 }}>
          <AlertIcon width="14" height="14" /> <span>{err}</span>
        </div>
      )}

      {loading ? (
        <div className="wx-empty" style={{ padding: 16 }}><span className="wx-spinner" /> Loading…</div>
      ) : filtered.length === 0 ? (
        <div className="wx-empty" style={{ padding: 16 }}>
          <div style={{ fontSize: 12.5, color: 'var(--text-muted)' }}>
            {rows.length === 0 ? 'No resources for this brand yet.' : 'No matches for the current filters.'}
          </div>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {filtered.map((r) => (
            <BrandResourceRow key={r.id} row={r}
              canEdit={rowEditable(r)}
              onEdit={() => setEditing(r)}
              onDelete={() => onDelete(r)} />
          ))}
        </div>
      )}

      {showAdd && (
        <ResourceModal mode="create" lockedBrandId={brandId}
          onClose={() => setShowAdd(false)}
          onSaved={() => { setShowAdd(false); reload(); }} />
      )}
      {editing && (
        <ResourceModal mode="edit" resource={editing} lockedBrandId={brandId}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); reload(); }} />
      )}
    </div>
  );
}

function BrandResourceRow({ row, canEdit, onEdit, onDelete }) {
  const src = detectSource(row.url);
  const thumb = thumbnailFor(row);
  return (
    <div style={{
      display: 'grid', gridTemplateColumns: '52px 1fr auto',
      gap: 10, alignItems: 'center',
      padding: '8px 10px',
      background: 'var(--surface-2)',
      borderRadius: 'var(--radius-md)',
    }}>
      <div style={{ width: 52, height: 52, background: 'var(--surface-1)', borderRadius: 'var(--radius-sm)', overflow: 'hidden', display: 'grid', placeItems: 'center' }}>
        {thumb
          ? <img src={thumb} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }}
              onError={(e) => { e.currentTarget.style.display = 'none'; }} />
          : <span style={{ fontSize: 9.5, fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase' }}>{src.label}</span>}
      </div>
      <div style={{ minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <a href={row.url} target="_blank" rel="noreferrer"
            style={{ color: 'var(--accent)', fontWeight: 700, fontSize: 13, textDecoration: 'none', wordBreak: 'break-word' }}>
            <LinkIcon width="11" height="11" style={{ marginRight: 4 }} />{row.name}
          </a>
          <span className="pc-pill pc-pill-muted" style={{ textTransform: 'none', fontSize: 10, fontWeight: 700 }}>
            {src.label}
          </span>
        </div>
        {row.description && <div style={{ fontSize: 11.5, color: 'var(--text-secondary)' }}>{row.description}</div>}
        <div style={{ fontSize: 10.5, color: 'var(--text-muted)', marginTop: 2 }}>
          {row.creator?.display_name || '—'} · {timeAgo(row.created_at)}
        </div>
      </div>
      <div style={{ display: 'flex', gap: 2 }}>
        {canEdit && (
          <>
            <button onClick={onEdit} title="Edit"
              style={{ border: 0, background: 'transparent', color: 'var(--text-muted)', cursor: 'pointer', padding: 3 }}>
              <PencilIcon width="13" height="13" />
            </button>
            <button onClick={onDelete} title="Delete"
              style={{ border: 0, background: 'transparent', color: 'var(--text-muted)', cursor: 'pointer', padding: 3 }}>
              <XIcon width="13" height="13" />
            </button>
          </>
        )}
      </div>
    </div>
  );
}
