import React, { useMemo, useState } from 'react';
import { bossDeleteArticle, groupDuplicates } from '../../lib/kbApi';

function formatDate(ts) {
  if (!ts) return '';
  const d = ts.toDate ? ts.toDate() : new Date(ts);
  if (isNaN(d.getTime())) return '';
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function GroupBlock({ title, subtitle, groups, onDelete, deletingId }) {
  if (!groups.length) return null;
  return (
    <div className="mb-4">
      <div className="d-flex align-items-center gap-2 mb-2">
        <h6 className="fw-bold mb-0 small">{title}</h6>
        <span className="badge rounded-pill" style={{ background: '#fee2e2', color: '#b91c1c', fontSize: '0.65rem' }}>
          {groups.length} group{groups.length === 1 ? '' : 's'}
        </span>
      </div>
      {subtitle && <div className="text-muted small mb-2" style={{ fontSize: '0.72rem' }}>{subtitle}</div>}
      <div className="d-flex flex-column gap-2">
        {groups.map(g => (
          <div key={g.key} className="rounded-3 p-2" style={{ background: '#fff7ed', border: '1px solid #fed7aa' }}>
            <div className="small text-muted mb-1" style={{ fontSize: '0.7rem', wordBreak: 'break-all' }}>
              <i className="bi bi-collection me-1" /><code>{g.key}</code> · {g.list.length} copies
            </div>
            <div className="d-flex flex-column gap-1">
              {g.list.map(it => (
                <div key={it.id} className="rounded-2 d-flex align-items-center gap-2 p-2"
                  style={{ background: '#fff', border: '1px solid #fde68a' }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div className="fw-semibold text-truncate" style={{ fontSize: '0.82rem' }}>{it.title || '(untitled)'}</div>
                    <div className="text-muted d-flex flex-wrap gap-2" style={{ fontSize: '0.68rem' }}>
                      <span><i className="bi bi-tag me-1" />{it.tab || '—'}</span>
                      {it.version && <span><i className="bi bi-bookmark me-1" />v{it.version}</span>}
                      {it.createdByName && <span><i className="bi bi-person me-1" />{it.createdByName}</span>}
                      {it.createdAt && <span><i className="bi bi-calendar3 me-1" />{formatDate(it.createdAt)}</span>}
                      {it.approvalStatus && it.approvalStatus !== 'approved' && (
                        <span className="badge" style={{ background: '#fef3c7', color: '#92400e', fontSize: '0.6rem' }}>{it.approvalStatus}</span>
                      )}
                    </div>
                    {it.url && (
                      <a href={it.url} target="_blank" rel="noopener noreferrer"
                        className="d-inline-block text-truncate" style={{ fontSize: '0.68rem', maxWidth: '100%' }}>
                        <i className="bi bi-link-45deg me-1" />{it.url}
                      </a>
                    )}
                  </div>
                  <button className="btn btn-sm btn-outline-danger d-inline-flex align-items-center gap-1 flex-shrink-0"
                    style={{ borderRadius: 6, fontSize: '0.72rem' }}
                    onClick={() => onDelete(it)}
                    disabled={deletingId === it.id}
                    title="Delete this copy">
                    {deletingId === it.id
                      ? <span className="spinner-border spinner-border-sm" style={{ width: 12, height: 12 }} />
                      : <i className="bi bi-trash3" />}
                    Delete
                  </button>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

export default function DuplicateCheckerModal({ items, onClose }) {
  const [deletingId, setDeletingId] = useState('');
  const { urlGroups, titleGroups } = useMemo(() => groupDuplicates(items || []), [items]);

  async function handleDelete(item) {
    if (!window.confirm(`Delete "${item.title || item.url}"? This cannot be undone.`)) return;
    setDeletingId(item.id);
    try {
      await bossDeleteArticle(item.id);
    } catch (e) {
      alert('Delete failed: ' + (e.message || e));
    } finally {
      setDeletingId('');
    }
  }

  const totalDupeItems = [...urlGroups, ...titleGroups].reduce((n, g) => n + g.list.length, 0);

  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 1060, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
      <div style={{ position: 'absolute', inset: 0, background: 'rgba(0,0,0,0.55)', backdropFilter: 'blur(3px)' }} onClick={onClose} />
      <div className="card border-0 shadow-lg" style={{ position: 'relative', width: '100%', maxWidth: 780, zIndex: 1, borderRadius: 14, maxHeight: '92vh', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        <div className="px-4 pt-4 pb-3 d-flex align-items-start justify-content-between" style={{ borderBottom: '1px solid #f1f5f9' }}>
          <div>
            <h6 className="fw-bold mb-0 d-flex align-items-center gap-2">
              <i className="bi bi-clipboard-check" style={{ color: '#d97706' }} />
              Duplicate Checker
            </h6>
            <div className="text-muted small mt-1">
              {(urlGroups.length + titleGroups.length) === 0
                ? 'Scanned all Knowledge Base docs — no duplicates found.'
                : `Found ${urlGroups.length} URL duplicate group${urlGroups.length === 1 ? '' : 's'} and ${titleGroups.length} title duplicate group${titleGroups.length === 1 ? '' : 's'} (${totalDupeItems} total copies).`}
            </div>
          </div>
          <button className="btn btn-sm btn-light border-0 rounded-circle" onClick={onClose}
            style={{ width: 32, height: 32, padding: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <i className="bi bi-x-lg" />
          </button>
        </div>

        <div className="flex-grow-1 p-4" style={{ overflowY: 'auto' }}>
          {urlGroups.length === 0 && titleGroups.length === 0 ? (
            <div className="rounded-3 p-4 text-center" style={{ background: '#ecfdf5', border: '1px solid #a7f3d0' }}>
              <i className="bi bi-check-circle-fill" style={{ color: '#16a34a', fontSize: '2rem' }} />
              <div className="fw-semibold mt-2" style={{ color: '#065f46' }}>No duplicates — you're clean.</div>
              <div className="text-muted small">All {items?.length || 0} docs have unique URLs and titles.</div>
            </div>
          ) : (
            <>
              <GroupBlock
                title="Same URL"
                subtitle="Two or more docs point to the exact same link (trailing slashes and tracking params are ignored)."
                groups={urlGroups}
                onDelete={handleDelete}
                deletingId={deletingId}
              />
              <GroupBlock
                title="Same Title"
                subtitle="Two or more docs have the same title. Could be intentional (different versions), but double-check."
                groups={titleGroups}
                onDelete={handleDelete}
                deletingId={deletingId}
              />
            </>
          )}
        </div>

        <div className="px-4 py-3 d-flex justify-content-end" style={{ borderTop: '1px solid #f1f5f9' }}>
          <button className="btn btn-sm btn-outline-secondary px-3" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}
