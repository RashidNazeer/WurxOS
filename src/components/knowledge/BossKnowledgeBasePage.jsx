import React, { useEffect, useState, useMemo } from 'react';
import { useAuth } from '../../contexts/AuthContext';
import {
  subscribeArticles,
  subscribeComments,
  listAllUsers,
  listAcknowledgments,
  bossSaveArticle,
  bossUpdateArticle,
  bossApprove,
  bossReject,
  bossDeleteArticle,
  bossReplyComment,
  bossDeleteComment,
  findDuplicateByUrl,
  groupDuplicates,
} from '../../lib/kbApi';
import BulkImportKnowledgeBaseModal from './BulkImportKnowledgeBaseModal';
import DuplicateCheckerModal from './DuplicateCheckerModal';

const SOP_TABS = ['delivery_roadmap', 'operational_sops', 'training_sops', 'policies'];

const TABS = [
  { value: 'delivery_roadmap', label: 'Delivery Roadmap',    icon: 'bi-map' },
  { value: 'bootcamp',         label: 'BootCamp Curriculum', icon: 'bi-mortarboard' },
  { value: 'operational_sops', label: 'Operational SOPs',    icon: 'bi-gear' },
  { value: 'training_sops',    label: 'Training SOPs',       icon: 'bi-journal-text' },
  { value: 'policies',         label: 'Policies',            icon: 'bi-shield-check' },
];

function formatDate(ts) {
  if (!ts) return '';
  const d = ts.toDate ? ts.toDate() : new Date(ts);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}
function formatTime(ts) {
  if (!ts) return '';
  const d = ts.toDate ? ts.toDate() : new Date(ts);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) + ' ' + d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
}

const ROLE_LABELS = { tl: 'Team Lead', ol: 'Operation Lead', pctl: 'Paid Collab TL', apc: 'APC', ipc: 'IPC', boss: 'Boss' };

// ── Video Embed ───────────────────────────────────────────────────────────────

function getEmbedInfo(url) {
  if (!url) return null;
  try {
    const u = new URL(url);
    if (u.hostname.includes('youtube.com') || u.hostname.includes('youtu.be')) {
      let videoId = u.searchParams.get('v');
      if (!videoId && u.hostname.includes('youtu.be')) videoId = u.pathname.slice(1);
      if (!videoId && u.pathname.includes('/embed/')) videoId = u.pathname.split('/embed/')[1]?.split(/[?/]/)[0];
      if (videoId) return { type: 'iframe', src: `https://www.youtube.com/embed/${videoId}` };
    }
    if (u.hostname.includes('loom.com') && u.pathname.includes('/share/')) {
      const loomId = u.pathname.split('/share/')[1]?.split(/[?/]/)[0];
      if (loomId) return { type: 'iframe', src: `https://www.loom.com/embed/${loomId}` };
    }
    if (u.hostname.includes('vimeo.com')) {
      const vimeoId = u.pathname.split('/').filter(Boolean).pop();
      if (vimeoId && /^\d+$/.test(vimeoId)) return { type: 'iframe', src: `https://player.vimeo.com/video/${vimeoId}` };
    }
    if (u.hostname.includes('drive.google.com') && u.pathname.includes('/file/d/')) {
      const driveId = u.pathname.split('/file/d/')[1]?.split('/')[0];
      if (driveId) return { type: 'iframe', src: `https://drive.google.com/file/d/${driveId}/preview` };
    }
    const ext = u.pathname.split('.').pop()?.toLowerCase();
    if (['mp4', 'webm', 'ogg', 'mov'].includes(ext)) return { type: 'video', src: url };
  } catch { /* invalid URL */ }
  return null;
}

function VideoEmbed({ url }) {
  const [show, setShow] = useState(false);
  const info = getEmbedInfo(url);
  if (!info) return null;
  return (
    <div className="mt-2">
      {!show ? (
        <button className="btn btn-sm btn-outline-primary d-inline-flex align-items-center gap-1"
          style={{ fontSize: '0.72rem', borderRadius: 6 }} onClick={() => setShow(true)}>
          <i className="bi bi-play-circle" /> Play Video
        </button>
      ) : (
        <div className="position-relative" style={{ borderRadius: 10, overflow: 'hidden', background: '#000' }}>
          <button className="btn btn-sm btn-dark position-absolute d-inline-flex align-items-center justify-content-center"
            style={{ top: 8, right: 8, zIndex: 2, width: 28, height: 28, borderRadius: '50%', padding: 0, opacity: 0.8 }}
            onClick={() => setShow(false)} title="Close">
            <i className="bi bi-x" style={{ fontSize: '0.9rem' }} />
          </button>
          {info.type === 'iframe' ? (
            <div style={{ position: 'relative', paddingBottom: '56.25%', height: 0 }}>
              <iframe src={info.src} title="Video" style={{ position: 'absolute', top: 0, left: 0, width: '100%', height: '100%', border: 'none' }}
                allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture" allowFullScreen />
            </div>
          ) : (
            <video controls autoPlay style={{ width: '100%', maxHeight: 400, display: 'block' }}><source src={info.src} /></video>
          )}
        </div>
      )}
    </div>
  );
}

// ── Add/Edit Modal ────────────────────────────────────────────────────────────

function DocModal({ editDoc, newVersionOf, tab: defaultTab, onClose, onSave, saving, allUsers, existingItems }) {
  const parent = newVersionOf || null;
  const [title, setTitle]     = useState(parent?.title || editDoc?.title || '');
  const [url, setUrl]         = useState(editDoc?.url || '');
  const [desc, setDesc]       = useState(editDoc?.description || '');
  const [selectedTab, setSelectedTab] = useState(parent?.tab || editDoc?.tab || defaultTab);
  const [version, setVersion] = useState(editDoc?.version || '');
  const [error, setError]     = useState('');

  const ev = parent?.visibility || editDoc?.visibility;
  const [visType, setVisType]       = useState(ev?.type || 'everyone');
  const [visRoles, setVisRoles]     = useState(ev?.roles || []);
  const [visUserIds, setVisUserIds] = useState(ev?.userIds || []);
  const [userSearch, setUserSearch] = useState('');

  function toggleRole(r) { setVisRoles(prev => prev.includes(r) ? prev.filter(x => x !== r) : [...prev, r]); }
  function toggleUser(id) { setVisUserIds(prev => prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]); }

  const filteredUsers = useMemo(() => {
    if (!userSearch) return allUsers;
    const q = userSearch.toLowerCase();
    return allUsers.filter(u => (u.displayName || u.userName || '').toLowerCase().includes(q) || (u.email || '').toLowerCase().includes(q));
  }, [allUsers, userSearch]);

  async function handleSubmit(e) {
    e.preventDefault();
    if (!title.trim()) { setError('Title is required.'); return; }
    if (!url.trim()) { setError('URL/Link is required.'); return; }
    if (visType === 'roles' && visRoles.length === 0) { setError('Select at least one role.'); return; }
    if (visType === 'users' && visUserIds.length === 0) { setError('Select at least one user.'); return; }
    if (SOP_TABS.includes(selectedTab) && !version.trim()) { setError('Version is required for SOP documents.'); return; }

    if (existingItems && existingItems.length) {
      const groupId = parent ? (parent.sopGroupId || parent.id) : (editDoc?.sopGroupId);
      const candidates = groupId ? existingItems.filter(x => (x.sopGroupId || x.id) !== groupId) : existingItems;
      const dupe = findDuplicateByUrl(url, candidates, { excludeId: editDoc?.id });
      if (dupe) {
        setError(`This URL is already used by "${dupe.title}". Pick a different link or edit that doc instead.`);
        return;
      }
    }

    setError('');
    const visibility = { type: visType, roles: visType === 'roles' ? visRoles : [], userIds: visType === 'users' ? visUserIds : [] };
    const payload = { title: title.trim(), url: url.trim(), description: desc.trim(), tab: selectedTab, visibility, ...(SOP_TABS.includes(selectedTab) ? { version: version.trim() } : {}) };
    if (parent) payload.sopGroupId = parent.sopGroupId || parent.id;
    try {
      await onSave(payload);   // parent closes the modal on success; on failure it re-throws
    } catch (err) {
      setError(err?.message || 'Could not save — please check your connection and try again. The document was NOT saved.');
    }
  }

  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 1050, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
      <div style={{ position: 'absolute', inset: 0, background: 'rgba(0,0,0,0.55)', backdropFilter: 'blur(2px)' }} onClick={onClose} />
      <div className="card border-0 shadow-lg" style={{ position: 'relative', width: '100%', maxWidth: 540, zIndex: 1, borderRadius: 16, maxHeight: '92vh', overflowY: 'auto' }}>
        <div className="card-body p-4">
          <div className="d-flex align-items-center justify-content-between mb-4">
            <h6 className="fw-bold mb-0">{parent ? `New Version of "${parent.title}"` : editDoc ? 'Edit Document' : 'Add Document'}</h6>
            <button className="btn btn-sm btn-light border-0 rounded-circle" onClick={onClose} style={{ width: 32, height: 32, padding: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <i className="bi bi-x-lg" style={{ fontSize: '0.85rem' }} />
            </button>
          </div>
          <form onSubmit={handleSubmit}>
            {error && <div className="alert alert-danger py-2 small mb-3">{error}</div>}
            <div className="mb-3">
              <label className="form-label small fw-semibold">Title <span className="text-danger">*</span></label>
              <input type="text" className="form-control" placeholder="Document title" value={title} onChange={e => setTitle(e.target.value)} autoFocus />
            </div>
            <div className="mb-3">
              <label className="form-label small fw-semibold">Link / URL <span className="text-danger">*</span></label>
              <input type="url" className="form-control form-control-sm" placeholder="https://docs.google.com/…" value={url} onChange={e => setUrl(e.target.value)} />
            </div>
            <div className="mb-3">
              <label className="form-label small fw-semibold">Description <span className="text-muted fw-normal">(optional)</span></label>
              <textarea className="form-control" rows={2} placeholder="Brief description…" value={desc} onChange={e => setDesc(e.target.value)} />
            </div>

            {/* Category */}
            <div className="mb-3">
              <label className="form-label small fw-semibold">Category</label>
              <div className="d-flex gap-2 flex-wrap">
                {TABS.map(t => (
                  <button key={t.value} type="button" onClick={() => setSelectedTab(t.value)}
                    className="d-inline-flex align-items-center gap-1 rounded-pill border"
                    style={{
                      fontSize: '0.75rem', fontWeight: 600, padding: '4px 10px',
                      background: selectedTab === t.value ? 'var(--accent)' : 'var(--surface-2)',
                      color: selectedTab === t.value ? 'var(--on-accent)' : 'var(--text-secondary)',
                      borderColor: selectedTab === t.value ? 'var(--accent)' : 'var(--border-subtle)',
                      cursor: 'pointer', transition: 'all 0.12s',
                    }}>
                    <i className={`bi ${t.icon}`} style={{ fontSize: '0.65rem' }} />{t.label}
                  </button>
                ))}
              </div>
            </div>

            {/* Version (SOP tabs only) */}
            {SOP_TABS.includes(selectedTab) && (
              <div className="mb-3">
                <label className="form-label small fw-semibold">SOP Version <span className="text-danger">*</span></label>
                <input type="text" className="form-control form-control-sm" placeholder="e.g. v1.0" value={version} onChange={e => setVersion(e.target.value)} />
                <div className="text-muted mt-1" style={{ fontSize: '0.68rem' }}>This version will be visible to all users in their Knowledge Base.</div>
              </div>
            )}

            {/* Visibility */}
            <div className="mb-4">
              <label className="form-label small fw-semibold">Visible to</label>
              <div className="d-flex gap-2 flex-wrap mb-2">
                {[
                  { value: 'everyone', label: 'Everyone',       icon: 'bi-globe' },
                  { value: 'roles',    label: 'By Role',        icon: 'bi-people' },
                  { value: 'users',    label: 'Specific Users', icon: 'bi-person-check' },
                ].map(v => (
                  <button key={v.value} type="button" onClick={() => setVisType(v.value)}
                    className="d-inline-flex align-items-center gap-1 rounded-pill border"
                    style={{
                      fontSize: '0.78rem', fontWeight: 600, padding: '5px 12px',
                      background: visType === v.value ? 'var(--accent)' : 'var(--surface-2)',
                      color: visType === v.value ? 'var(--on-accent)' : 'var(--text-secondary)',
                      borderColor: visType === v.value ? 'var(--accent)' : 'var(--border-subtle)',
                      cursor: 'pointer', transition: 'all 0.12s',
                    }}>
                    <i className={`bi ${v.icon}`} style={{ fontSize: '0.72rem' }} />{v.label}
                  </button>
                ))}
              </div>

              {/* Role selector */}
              {visType === 'roles' && (
                <div className="rounded-2 p-3" style={{ background: 'var(--surface-2)', border: '1px solid var(--border-subtle)' }}>
                  <div className="d-flex gap-2 flex-wrap">
                    {[
                      { value: 'tl',   label: 'Team Leads',          color: 'var(--info)' },
                      { value: 'ol',   label: 'Operation Leads',     color: '#6610f2' },
                      { value: 'pctl', label: 'Paid Collab TLs',     color: '#d63384' },
                      { value: 'apc',  label: 'APCs',                color: 'var(--success)' },
                      { value: 'ipc',  label: 'IPCs',                color: '#0dcaf0' },
                    ].map(r => {
                      const sel = visRoles.includes(r.value);
                      return (
                        <button key={r.value} type="button" onClick={() => toggleRole(r.value)}
                          className="d-inline-flex align-items-center gap-1 rounded-pill border"
                          style={{
                            fontSize: '0.76rem', fontWeight: 600, padding: '5px 12px',
                            background: sel ? r.color : 'var(--surface-1)', color: sel ? 'var(--text-inverse)' : r.color,
                            borderColor: sel ? r.color : `${r.color}55`, cursor: 'pointer',
                          }}>
                          <i className={`bi ${sel ? 'bi-check-circle-fill' : 'bi-circle'}`} style={{ fontSize: '0.65rem' }} />{r.label}
                        </button>
                      );
                    })}
                  </div>
                  <div className="text-muted mt-2" style={{ fontSize: '0.7rem' }}>
                    All users with the selected role(s) will see this document.
                  </div>
                </div>
              )}

              {/* User selector */}
              {visType === 'users' && (
                <div className="rounded-2 p-3" style={{ background: 'var(--surface-2)', border: '1px solid var(--border-subtle)' }}>
                  <div className="position-relative mb-2">
                    <i className="bi bi-search position-absolute text-muted" style={{ left: 10, top: '50%', transform: 'translateY(-50%)', fontSize: '0.72rem', pointerEvents: 'none' }} />
                    <input type="text" className="form-control form-control-sm" placeholder="Search users…"
                      style={{ paddingLeft: 28, borderRadius: 8 }} value={userSearch} onChange={e => setUserSearch(e.target.value)} />
                  </div>
                  {visUserIds.length > 0 && (
                    <div className="d-flex flex-wrap gap-1 mb-2">
                      {visUserIds.map(uid => {
                        const u = allUsers.find(x => x.id === uid);
                        return (
                          <span key={uid} className="d-inline-flex align-items-center gap-1 rounded-pill px-2 py-1"
                            style={{ background: 'var(--info-soft)', border: '1px solid color-mix(in srgb, var(--info) 35%, transparent)', fontSize: '0.68rem', fontWeight: 500, color: 'var(--info)' }}>
                            {u ? (u.displayName || u.userName || u.email) : uid}
                            <i className="bi bi-x" style={{ cursor: 'pointer', fontSize: '0.72rem' }} onClick={() => toggleUser(uid)} />
                          </span>
                        );
                      })}
                    </div>
                  )}
                  <div style={{ maxHeight: 160, overflowY: 'auto' }}>
                    {filteredUsers.map(u => {
                      const sel = visUserIds.includes(u.id);
                      const name = u.displayName || u.userName || u.email;
                      return (
                        <div key={u.id} className="d-flex align-items-center gap-2 rounded-2 p-2 mb-1"
                          style={{ background: sel ? 'var(--info-soft)' : 'var(--surface-1)', border: `1px solid ${sel ? 'color-mix(in srgb, var(--info) 35%, transparent)' : 'var(--border-subtle)'}`, cursor: 'pointer' }}
                          onClick={() => toggleUser(u.id)}>
                          <input type="checkbox" className="form-check-input flex-shrink-0" checked={sel} readOnly style={{ cursor: 'pointer' }} />
                          <span className="rounded-circle d-inline-flex align-items-center justify-content-center text-white fw-bold flex-shrink-0"
                            style={{ width: 22, height: 22, background: sel ? 'var(--info)' : 'var(--text-muted)', fontSize: '0.5rem' }}>
                            {name.slice(0, 2).toUpperCase()}
                          </span>
                          <div className="flex-grow-1" style={{ minWidth: 0 }}>
                            <div className="fw-medium text-truncate" style={{ fontSize: '0.75rem' }}>{name}</div>
                            <div className="text-muted text-truncate" style={{ fontSize: '0.62rem' }}>{u.email} · {ROLE_LABELS[u.role] || u.role}</div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>

            <div className="d-flex gap-2 justify-content-end">
              <button type="button" className="btn btn-sm btn-outline-secondary px-3" onClick={onClose}>Cancel</button>
              <button type="submit" className="btn btn-sm btn-dark px-3 d-inline-flex align-items-center gap-1" disabled={saving}>
                {saving ? <><span className="spinner-border spinner-border-sm" />Saving…</> : <><i className="bi bi-check" />{editDoc ? 'Update' : 'Add Document'}</>}
              </button>
            </div>
          </form>
        </div>
      </div>
    </div>
  );
}

// ── Acknowledgment Dashboard Modal ────────────────────────────────────────────

function AckDashboardModal({ item, allUsers: rawAllUsers, ackList, onClose }) {
  const allUsers = useMemo(() => {
    const vis = item.visibility;
    if (!vis || vis.type === 'everyone') return rawAllUsers;
    if (vis.type === 'roles') return rawAllUsers.filter(u => (vis.roles || []).includes(u.role));
    if (vis.type === 'users') return rawAllUsers.filter(u => (vis.userIds || []).includes(u.id));
    return rawAllUsers;
  }, [rawAllUsers, item.visibility]);
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState('all');

  const rows = useMemo(() => {
    const ackMap = {};
    ackList.forEach(a => { ackMap[a.userId] = a; });
    return allUsers.map(u => ({
      id: u.id, name: u.displayName || u.userName || u.email, email: u.email,
      role: u.role || (u.ownerId ? 'apc' : 'unknown'),
      ack: ackMap[u.id] || null,
    })).filter(r => {
      if (filter === 'read' && !r.ack) return false;
      if (filter === 'unread' && r.ack) return false;
      if (search) { const q = search.toLowerCase(); if (!r.name.toLowerCase().includes(q) && !r.email.toLowerCase().includes(q)) return false; }
      return true;
    });
  }, [allUsers, ackList, search, filter]);

  const readCount = ackList.length;
  const totalUsers = allUsers.length;

  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 1060, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
      <div style={{ position: 'absolute', inset: 0, background: 'rgba(0,0,0,0.55)', backdropFilter: 'blur(2px)' }} onClick={onClose} />
      <div className="card border-0 shadow-lg" style={{ position: 'relative', width: '100%', maxWidth: 580, zIndex: 1, borderRadius: 16, maxHeight: '85vh', display: 'flex', flexDirection: 'column' }}>
        <div className="card-header bg-white border-0 pt-4 pb-2 px-4 flex-shrink-0" style={{ borderRadius: '16px 16px 0 0' }}>
          <div className="d-flex align-items-center justify-content-between mb-2">
            <h6 className="fw-bold mb-0">Acknowledgment Status</h6>
            <button className="btn btn-sm btn-light border-0 rounded-circle" onClick={onClose} style={{ width: 32, height: 32, padding: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <i className="bi bi-x-lg" style={{ fontSize: '0.85rem' }} />
            </button>
          </div>
          <p className="text-muted small mb-2">{item.title}</p>

          <div className="d-flex align-items-center gap-2 mb-3">
            <div className="flex-grow-1 rounded-pill" style={{ height: 8, background: 'var(--surface-3)' }}>
              <div className="rounded-pill" style={{ height: 8, width: `${totalUsers > 0 ? (readCount / totalUsers) * 100 : 0}%`, background: 'var(--success)', transition: 'width 0.3s' }} />
            </div>
            <span className="small fw-semibold" style={{ color: 'var(--success)', whiteSpace: 'nowrap' }}>{readCount}/{totalUsers}</span>
          </div>

          <div className="d-flex gap-2 align-items-center">
            <div className="position-relative flex-grow-1">
              <i className="bi bi-search position-absolute text-muted" style={{ left: 10, top: '50%', transform: 'translateY(-50%)', fontSize: '0.75rem', pointerEvents: 'none' }} />
              <input type="text" className="form-control form-control-sm" placeholder="Search…" style={{ paddingLeft: 28, borderRadius: 8 }} value={search} onChange={e => setSearch(e.target.value)} />
            </div>
            {['all', 'read', 'unread'].map(f => (
              <button key={f} className={`btn btn-sm ${filter === f ? 'btn-dark' : 'btn-outline-secondary'}`}
                style={{ borderRadius: 8, fontSize: '0.72rem', textTransform: 'capitalize' }} onClick={() => setFilter(f)}>{f}</button>
            ))}
          </div>
        </div>

        <div className="card-body px-4 pb-4 pt-2" style={{ overflowY: 'auto' }}>
          {rows.length === 0 ? (
            <p className="text-muted small text-center py-3">No users match.</p>
          ) : (
            <table className="table table-sm mb-0" style={{ fontSize: '0.78rem' }}>
              <thead><tr style={{ color: 'var(--text-muted)' }}><th>User</th><th>Role</th><th>Status</th><th>Read At</th></tr></thead>
              <tbody>
                {rows.map(r => (
                  <tr key={r.id}>
                    <td>
                      <div className="d-flex align-items-center gap-2">
                        <span className="rounded-circle d-inline-flex align-items-center justify-content-center text-white fw-bold flex-shrink-0"
                          style={{ width: 24, height: 24, background: r.ack ? 'var(--success)' : 'var(--border-subtle)', fontSize: '0.5rem' }}>
                          {r.name.slice(0, 2).toUpperCase()}
                        </span>
                        <div>
                          <div className="fw-medium">{r.name}</div>
                          <div className="text-muted" style={{ fontSize: '0.65rem' }}>{r.email}</div>
                        </div>
                      </div>
                    </td>
                    <td><span className="text-muted">{ROLE_LABELS[r.role] || r.role}</span></td>
                    <td>
                      {r.ack ? (
                        <span className="badge rounded-pill" style={{ background: 'var(--success-soft)', color: 'var(--success)', fontSize: '0.62rem' }}><i className="bi bi-check-circle-fill me-1" />Read</span>
                      ) : (
                        <span className="badge rounded-pill" style={{ background: 'var(--warning-soft)', color: 'var(--warning)', fontSize: '0.62rem' }}><i className="bi bi-circle me-1" />Unread</span>
                      )}
                    </td>
                    <td className="text-muted" style={{ fontSize: '0.7rem' }}>{r.ack ? formatDate(r.ack.readAt) : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Comment Management (inline) ───────────────────────────────────────────────

function BossCommentSection({ docId }) {
  const [comments, setComments] = useState([]);
  const [replyTarget, setReplyTarget] = useState(null);
  const [replyText, setReplyText] = useState('');
  const [replying, setReplying] = useState(false);

  useEffect(() => {
    const unsub = subscribeComments(docId, (rows) => setComments(rows));
    return () => unsub();
  }, [docId]);

  async function handleReply() {
    if (!replyTarget || !replyText.trim()) return;
    setReplying(true);
    try {
      await bossReplyComment(replyTarget.id, replyText.trim());
      setReplyTarget(null); setReplyText('');
    } catch { /* ignore */ } finally { setReplying(false); }
  }

  async function handleDeleteComment(commentId) {
    try { await bossDeleteComment(commentId); } catch { /* ignore */ }
  }

  if (comments.length === 0) return <p className="text-muted small mt-2 mb-0" style={{ fontSize: '0.72rem' }}><i className="bi bi-chat-dots me-1" />No comments yet</p>;

  return (
    <div className="mt-3">
      <div className="small fw-semibold text-muted mb-2" style={{ fontSize: '0.72rem' }}>
        <i className="bi bi-chat-dots me-1" />{comments.length} Comment{comments.length !== 1 ? 's' : ''}
      </div>
      <div className="d-flex flex-column gap-2" style={{ maxHeight: 300, overflowY: 'auto' }}>
        {comments.map(c => (
          <div key={c.id} className="rounded-2 p-2" style={{ background: 'var(--surface-2)', border: '1px solid var(--border-subtle)' }}>
            <div className="d-flex align-items-center justify-content-between mb-1">
              <div className="d-flex align-items-center gap-2">
                <span className="rounded-circle d-inline-flex align-items-center justify-content-center fw-bold flex-shrink-0"
                  style={{ width: 20, height: 20, background: 'var(--text-muted)', color: 'var(--text-inverse)', fontSize: '0.5rem' }}>
                  {(c.userName || '?').slice(0, 2).toUpperCase()}
                </span>
                <span className="fw-semibold" style={{ fontSize: '0.72rem' }}>{c.userName}</span>
                <span className="text-muted" style={{ fontSize: '0.6rem' }}>{formatTime(c.createdAt)}</span>
              </div>
              <div className="d-flex gap-1">
                {!c.bossReply && (
                  <button className="btn btn-sm btn-link p-0 text-primary" style={{ fontSize: '0.7rem' }}
                    onClick={() => { setReplyTarget(c); setReplyText(''); }}>
                    <i className="bi bi-reply" /> Reply
                  </button>
                )}
                <button className="btn btn-sm btn-link p-0 text-danger" style={{ fontSize: '0.7rem' }}
                  onClick={() => handleDeleteComment(c.id)}>
                  <i className="bi bi-trash3" />
                </button>
              </div>
            </div>
            <p className="mb-0 small" style={{ fontSize: '0.76rem' }}>{c.text}</p>
            {c.bossReply && (
              <div className="mt-2 rounded-2 p-2" style={{ background: 'var(--warning-soft)', border: '1px solid color-mix(in srgb, var(--warning) 35%, transparent)' }}>
                <div className="d-flex align-items-center gap-1 mb-1">
                  <i className="bi bi-star-fill" style={{ color: 'var(--warning)', fontSize: '0.58rem' }} />
                  <span className="fw-semibold" style={{ fontSize: '0.68rem', color: 'var(--warning)' }}>Your Reply</span>
                  <span className="text-muted" style={{ fontSize: '0.58rem' }}>{formatTime(c.bossReplyAt)}</span>
                </div>
                <p className="mb-0 small" style={{ fontSize: '0.76rem' }}>{c.bossReply}</p>
              </div>
            )}
            {replyTarget?.id === c.id && (
              <div className="d-flex gap-2 mt-2">
                <input type="text" className="form-control form-control-sm" style={{ borderRadius: 8 }}
                  placeholder="Type your reply…" value={replyText} onChange={e => setReplyText(e.target.value)} autoFocus
                  onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); handleReply(); } }} />
                <button className="btn btn-sm btn-outline-secondary flex-shrink-0" style={{ borderRadius: 8 }} onClick={() => setReplyTarget(null)}>
                  <i className="bi bi-x" />
                </button>
                <button className="btn btn-sm btn-dark flex-shrink-0 d-inline-flex align-items-center gap-1"
                  style={{ borderRadius: 8 }} onClick={handleReply} disabled={replying || !replyText.trim()}>
                  <i className="bi bi-send" style={{ fontSize: '0.7rem' }} />
                </button>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Main Page ─────────────────────────────────────────────────────────────────

export default function BossKnowledgeBasePage() {
  const { user, profile } = useAuth();
  const currentUser = user ? { uid: user.id, email: user.email, displayName: profile?.display_name || '' } : null;

  const [items, setItems]       = useState([]);
  const [pendingItems, setPendingItems] = useState([]);
  const [loading, setLoading]   = useState(true);
  const [activeTab, setActiveTab] = useState('all');
  const [search, setSearch]     = useState('');
  const [showModal, setShowModal] = useState(false);
  const [editDoc, setEditDoc]   = useState(null);
  const [newVersionTarget, setNewVersionTarget] = useState(null);
  const [saving, setSaving]     = useState(false);
  const [expandedId, setExpandedId] = useState(null);
  const [approveTarget, setApproveTarget] = useState(null);
  const [approveSaving, setApproveSaving] = useState(false);

  const [ackTarget, setAckTarget] = useState(null);
  const [ackList, setAckList]     = useState([]);
  const [allUsers, setAllUsers]   = useState([]);
  const [showBulkImport, setShowBulkImport] = useState(false);
  const [showDuplicates, setShowDuplicates] = useState(false);
  const duplicateCount = useMemo(() => {
    const { urlGroups, titleGroups } = groupDuplicates([...items, ...pendingItems]);
    return urlGroups.length + titleGroups.length;
  }, [items, pendingItems]);

  useEffect(() => {
    const unsub = subscribeArticles((rows) => {
      setItems(rows.filter(d => !d.approvalStatus || d.approvalStatus === 'approved'));
      setPendingItems(rows.filter(d => d.approvalStatus === 'pending'));
      setLoading(false);
    });
    return () => unsub();
  }, []);

  useEffect(() => {
    async function loadUsers() {
      try {
        const us = await listAllUsers();
        setAllUsers(us.filter(u => u.role !== 'boss'));
      } catch { /* ignore */ }
    }
    loadUsers();
  }, []);

  async function openAckDashboard(item) {
    setAckTarget(item);
    setAckList([]);
    try {
      const rows = await listAcknowledgments(item.id);
      setAckList(rows);
    } catch { /* ignore */ }
  }

  async function handleSave(data) {
    setSaving(true);
    try {
      const isNewVersion = !!newVersionTarget;
      if (editDoc && !isNewVersion) {
        await bossUpdateArticle(editDoc.id, data);
      } else {
        await bossSaveArticle(data);
      }
      setShowModal(false); setEditDoc(null); setNewVersionTarget(null);
    } catch (err) {
      // NEVER swallow a save failure — a silent catch here let RLS/constraint/
      // network errors drop a doc while the user thought it saved (the "added
      // but never persisted" ghost). Surface it so the modal shows why + stays open.
      throw err;
    } finally { setSaving(false); }
  }

  async function handleDelete(itemId) {
    if (!window.confirm('Delete this document? This cannot be undone.')) return;
    try { await bossDeleteArticle(itemId); } catch { /* ignore */ }
  }

  async function handleApprove(pendingDoc, visibility) {
    setApproveSaving(true);
    try {
      await bossApprove(pendingDoc.id, visibility);
      setApproveTarget(null);
    } catch { /* ignore */ } finally { setApproveSaving(false); }
  }

  async function handleReject(pendingDoc) {
    const reason = window.prompt('Rejection reason (optional):');
    if (reason === null) return;
    try { await bossReject(pendingDoc.id, reason || ''); } catch { /* ignore */ }
  }

  const tabItems = useMemo(() => {
    let filtered = activeTab === 'all' ? items : items.filter(i => i.tab === activeTab);
    if (search) {
      const q = search.toLowerCase();
      filtered = filtered.filter(i => (i.title || '').toLowerCase().includes(q) || (i.description || '').toLowerCase().includes(q));
    }
    return filtered;
  }, [items, activeTab, search]);

  const tabCounts = useMemo(() => {
    const c = {};
    TABS.forEach(t => { c[t.value] = items.filter(i => i.tab === t.value).length; });
    return c;
  }, [items]);

  return (
    <div style={{ padding: '32px 32px 48px' }}>
      {/* Header */}
      <div className="d-flex align-items-start justify-content-between mb-4">
        <div>
          <h5 className="fw-bold mb-1 d-flex align-items-center gap-2" style={{ color: 'var(--text-primary)' }}>
            <i className="bi bi-book" style={{ fontSize: '1.15rem' }} />
            Knowledge Base
          </h5>
          <p className="text-muted small mb-0">Manage documents, SOPs, and policies for your team</p>
        </div>
        <div className="d-flex gap-2">
          <button className="btn btn-sm d-inline-flex align-items-center gap-1"
            style={{ borderRadius: 8, fontSize: '0.8rem',
              background: duplicateCount > 0 ? 'var(--warning-soft)' : 'var(--surface-2)',
              color: duplicateCount > 0 ? 'var(--warning)' : 'var(--text-secondary)',
              border: `1px solid ${duplicateCount > 0 ? 'color-mix(in srgb, var(--warning) 50%, transparent)' : 'var(--border-default)'}` }}
            onClick={() => setShowDuplicates(true)}
            title={duplicateCount > 0 ? `${duplicateCount} duplicate group(s) found` : 'Scan for duplicate docs'}>
            <i className="bi bi-clipboard-check" style={{ fontSize: '0.72rem' }} />
            Check Duplicates
            {duplicateCount > 0 && (
              <span className="badge rounded-pill"
                style={{ background: 'var(--warning)', color: 'var(--text-inverse)', fontSize: '0.62rem', marginLeft: 4 }}>
                {duplicateCount}
              </span>
            )}
          </button>
          <button className="btn btn-sm btn-outline-dark d-inline-flex align-items-center gap-1"
            style={{ borderRadius: 8, fontSize: '0.8rem' }}
            onClick={() => setShowBulkImport(true)}
            title="Upload a CSV to add many documents at once">
            <i className="bi bi-file-earmark-arrow-up" style={{ fontSize: '0.72rem' }} /> Bulk Import
          </button>
          <button className="btn btn-sm btn-dark d-inline-flex align-items-center gap-1" style={{ borderRadius: 8, fontSize: '0.8rem' }}
            onClick={() => { setEditDoc(null); setShowModal(true); }}>
            <i className="bi bi-plus-lg" style={{ fontSize: '0.72rem' }} /> Add Document
          </button>
        </div>
      </div>

      {/* ── Pending Submissions ── */}
      {pendingItems.length > 0 && (
        <div className="card border-0 shadow-sm mb-4" style={{ borderRadius: 14, border: '2px solid #fbbf24' }}>
          <div className="card-body p-3">
            <div className="d-flex align-items-center gap-2 mb-3">
              <div className="rounded-2 d-flex align-items-center justify-content-center" style={{ width: 32, height: 32, background: 'var(--warning-soft)' }}>
                <i className="bi bi-clock-history" style={{ color: 'var(--warning)', fontSize: '0.95rem' }} />
              </div>
              <div>
                <div className="fw-bold small" style={{ color: 'var(--warning)' }}>Pending Submissions</div>
                <div className="text-muted" style={{ fontSize: '0.68rem' }}>{pendingItems.length} document{pendingItems.length > 1 ? 's' : ''} awaiting your approval</div>
              </div>
            </div>
            {pendingItems.map(p => (
              <div key={p.id} className="rounded-3 p-3 mb-2 d-flex align-items-start justify-content-between gap-3"
                style={{ background: 'var(--warning-soft)', border: '1px solid #fde68a' }}>
                <div style={{ minWidth: 0 }}>
                  <div className="fw-semibold small">{p.title}</div>
                  {p.description && <div className="text-muted" style={{ fontSize: '0.72rem' }}>{p.description}</div>}
                  <div className="d-flex align-items-center gap-2 mt-1 flex-wrap" style={{ fontSize: '0.68rem', color: 'var(--text-muted)' }}>
                    <span><i className="bi bi-person-circle me-1" />Submitted by <strong>{p.submittedByName}</strong> ({(p.submittedByRole || '').toUpperCase()})</span>
                    <span><i className="bi bi-tag me-1" />{TABS.find(t => t.value === p.tab)?.label || p.tab}</span>
                    {p.url && <a href={p.url} target="_blank" rel="noreferrer" className="text-primary text-decoration-none"><i className="bi bi-link-45deg me-1" />View link</a>}
                  </div>
                </div>
                <div className="d-flex gap-1 flex-shrink-0">
                  <button className="btn btn-sm btn-success d-inline-flex align-items-center gap-1"
                    style={{ borderRadius: 8, fontSize: '0.75rem', padding: '4px 10px' }}
                    onClick={() => setApproveTarget(p)}>
                    <i className="bi bi-check-lg" /> Approve
                  </button>
                  <button className="btn btn-sm btn-outline-danger d-inline-flex align-items-center gap-1"
                    style={{ borderRadius: 8, fontSize: '0.75rem', padding: '4px 10px' }}
                    onClick={() => handleReject(p)}>
                    <i className="bi bi-x-lg" /> Reject
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ── Approval Modal (set visibility) ── */}
      {approveTarget && (
        <ApproveVisibilityModal
          pendingDoc={approveTarget}
          allUsers={allUsers}
          saving={approveSaving}
          onClose={() => setApproveTarget(null)}
          onApprove={(vis) => handleApprove(approveTarget, vis)}
        />
      )}

      {/* Tab nav */}
      <div className="d-flex flex-wrap gap-2 mb-3">
        {[{ value: 'all', label: 'All', icon: 'bi-grid-3x3-gap' }, ...TABS].map(tab => {
          const count = tab.value === 'all' ? items.length : tabCounts[tab.value];
          return (
            <button key={tab.value}
              className="d-inline-flex align-items-center gap-1 rounded-pill border px-3 py-1"
              style={{
                fontSize: '0.78rem', fontWeight: 600, cursor: 'pointer', transition: 'all 0.12s',
                background: activeTab === tab.value ? 'var(--accent)' : 'var(--surface-2)',
                color: activeTab === tab.value ? 'var(--on-accent)' : 'var(--text-secondary)',
                borderColor: activeTab === tab.value ? 'var(--accent)' : 'var(--border-subtle)',
              }}
              onClick={() => { setActiveTab(tab.value); setSearch(''); setExpandedId(null); }}>
              <i className={`bi ${tab.icon}`} style={{ fontSize: '0.72rem' }} />
              {tab.label}
              {count > 0 && (
                <span className="rounded-pill px-1" style={{ fontSize: '0.6rem', fontWeight: 700, background: activeTab === tab.value ? 'rgba(255,255,255,0.25)' : 'var(--surface-3)', color: activeTab === tab.value ? 'var(--on-accent)' : 'var(--text-muted)', lineHeight: '16px', minWidth: 16, textAlign: 'center' }}>
                  {count}
                </span>
              )}
            </button>
          );
        })}
      </div>

      {/* Search */}
      {!loading && items.length > 0 && (
        <div className="mb-4" style={{ maxWidth: 340 }}>
          <div className="position-relative">
            <i className="bi bi-search position-absolute text-muted" style={{ left: 10, top: '50%', transform: 'translateY(-50%)', fontSize: '0.78rem', pointerEvents: 'none' }} />
            <input type="text" className="form-control form-control-sm" placeholder="Search documents…"
              style={{ paddingLeft: 30, borderRadius: 8 }} value={search} onChange={e => setSearch(e.target.value)} />
          </div>
        </div>
      )}

      {/* Content */}
      {loading ? (
        <div className="d-flex align-items-center gap-2 py-5 text-muted"><span className="spinner-border spinner-border-sm" /><span className="small">Loading…</span></div>
      ) : tabItems.length === 0 ? (
        <div className="d-flex flex-column align-items-center justify-content-center py-5" style={{ border: '2px dashed var(--border-default)', borderRadius: 16, background: 'var(--surface-1)' }}>
          <div className="rounded-circle d-flex align-items-center justify-content-center mb-3" style={{ width: 64, height: 64, background: 'var(--surface-2)' }}>
            <i className="bi bi-book text-muted" style={{ fontSize: '1.6rem', opacity: 0.35 }} />
          </div>
          <p className="fw-semibold text-dark mb-1">{search ? 'No matching documents' : 'No documents in this category'}</p>
          <button className="btn btn-sm btn-dark mt-2" onClick={() => { setEditDoc(null); setShowModal(true); }}>Add first document</button>
        </div>
      ) : (
        <div className="d-flex flex-column gap-3">
          {tabItems.map(item => {
            const isExpanded = expandedId === item.id;
            return (
              <div key={item.id} className="card border-0 shadow-sm" style={{ borderRadius: 12 }}>
                <div className="card-body p-3">
                  <div className="d-flex align-items-start justify-content-between">
                    <div className="flex-grow-1">
                      <div className="d-flex align-items-center gap-2 mb-1">
                        <a href={item.url} target="_blank" rel="noopener noreferrer" className="fw-semibold small text-decoration-none" style={{ color: 'var(--info)' }}>
                          <i className="bi bi-box-arrow-up-right me-1" style={{ fontSize: '0.68rem' }} />
                          {item.title}
                        </a>
                        {activeTab === 'all' && (() => { const t = TABS.find(x => x.value === item.tab); return t ? (
                          <span className="badge rounded-pill" style={{ background: 'var(--surface-2)', color: 'var(--text-muted)', fontSize: '0.56rem', fontWeight: 500 }}>{t.label}</span>
                        ) : null; })()}
                      </div>
                      {item.description && <p className="text-muted small mb-1" style={{ fontSize: '0.76rem' }}>{item.description}</p>}
                      <VideoEmbed url={item.url} />
                      <div className="d-flex align-items-center gap-2 flex-wrap" style={{ fontSize: '0.65rem', marginTop: 4 }}>
                        {item.version && (
                          <span className="badge rounded-pill" style={{ background: 'var(--success-soft)', color: 'var(--success)', fontSize: '0.6rem', border: '1px solid color-mix(in srgb, var(--success) 35%, transparent)' }}>
                            <i className="bi bi-tag-fill me-1" />{item.version}
                          </span>
                        )}
                        <span className="text-muted">Added {formatDate(item.createdAt)}</span>
                        {item.updatedAt && item.updatedByName && (
                          <span className="text-muted">· Updated by {item.updatedByName} on {formatDate(item.updatedAt)}</span>
                        )}
                        {(!item.visibility || item.visibility.type === 'everyone') && (
                          <span className="badge rounded-pill" style={{ background: 'var(--info-soft)', color: 'var(--info)', fontSize: '0.58rem' }}><i className="bi bi-globe me-1" />Everyone</span>
                        )}
                        {item.visibility?.type === 'roles' && (
                          <span className="badge rounded-pill" style={{ background: 'color-mix(in srgb, #6610f2 14%, transparent)', color: '#6610f2', fontSize: '0.58rem' }}>
                            <i className="bi bi-people me-1" />{(item.visibility.roles || []).map(r => ROLE_LABELS[r] || r).join(', ')}
                          </span>
                        )}
                        {item.visibility?.type === 'users' && (
                          <span className="badge rounded-pill" style={{ background: 'var(--success-soft)', color: 'var(--success)', fontSize: '0.58rem' }}>
                            <i className="bi bi-person-check me-1" />{(item.visibility.userIds || []).length} user{(item.visibility.userIds || []).length !== 1 ? 's' : ''}
                          </span>
                        )}
                      </div>
                    </div>

                    <div className="d-flex align-items-center gap-1 flex-shrink-0 ms-3">
                      {SOP_TABS.includes(item.tab) && (
                        <button className="btn btn-sm btn-outline-primary d-inline-flex align-items-center gap-1 px-2"
                          style={{ fontSize: '0.68rem', borderRadius: 6 }}
                          onClick={() => { setNewVersionTarget(item); setEditDoc(null); setShowModal(true); }}>
                          <i className="bi bi-plus-circle" /> New Ver.
                        </button>
                      )}
                      <button className="btn btn-sm btn-outline-success d-inline-flex align-items-center gap-1 px-2"
                        style={{ fontSize: '0.68rem', borderRadius: 6 }} onClick={() => openAckDashboard(item)}>
                        <i className="bi bi-people" /> Reads
                      </button>
                      <button className="btn btn-sm btn-outline-secondary px-2"
                        style={{ fontSize: '0.68rem', borderRadius: 6 }}
                        onClick={() => setExpandedId(isExpanded ? null : item.id)}>
                        <i className={`bi bi-chat-dots${isExpanded ? '-fill' : ''}`} />
                      </button>
                      <button className="btn btn-sm btn-outline-secondary px-2"
                        style={{ fontSize: '0.68rem', borderRadius: 6 }}
                        onClick={() => { setEditDoc(item); setNewVersionTarget(null); setShowModal(true); }}>
                        <i className="bi bi-pencil" />
                      </button>
                      <button className="btn btn-sm btn-outline-danger px-2"
                        style={{ fontSize: '0.68rem', borderRadius: 6 }}
                        onClick={() => handleDelete(item.id)}>
                        <i className="bi bi-trash3" />
                      </button>
                    </div>
                  </div>

                  {isExpanded && <BossCommentSection docId={item.id} />}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Add/Edit Modal */}
      {showModal && <DocModal editDoc={editDoc} newVersionOf={newVersionTarget} tab={newVersionTarget?.tab || editDoc?.tab || (activeTab === 'all' ? 'delivery_roadmap' : activeTab)} onClose={() => { setShowModal(false); setEditDoc(null); setNewVersionTarget(null); }} onSave={handleSave} saving={saving} allUsers={allUsers} existingItems={[...items, ...pendingItems]} />}
      {showBulkImport && (
        <BulkImportKnowledgeBaseModal
          allUsers={allUsers}
          currentUser={currentUser}
          existingItems={[...items, ...pendingItems]}
          onClose={() => setShowBulkImport(false)}
          onImported={() => { /* realtime listener will refresh the list */ }}
        />
      )}

      {showDuplicates && (
        <DuplicateCheckerModal
          items={[...items, ...pendingItems]}
          onClose={() => setShowDuplicates(false)}
        />
      )}

      {ackTarget && <AckDashboardModal item={ackTarget} allUsers={allUsers} ackList={ackList} onClose={() => setAckTarget(null)} />}
    </div>
  );
}

// ── Approve + Set Visibility Modal ───────────────────────────────────────────
const VIS_ROLE_OPTIONS = [
  { value: 'tl',   label: 'Team Leads' },
  { value: 'ol',   label: 'Operation Leads' },
  { value: 'apc',  label: 'APCs' },
  { value: 'ipc',  label: 'IPCs' },
  { value: 'pctl', label: 'Paid Collab TLs' },
];

function ApproveVisibilityModal({ pendingDoc, allUsers, saving, onClose, onApprove }) {
  const [visType, setVisType]       = useState('everyone');
  const [visRoles, setVisRoles]     = useState([]);
  const [visUserIds, setVisUserIds] = useState([]);
  const [userSearch, setUserSearch] = useState('');

  function toggleRole(r) { setVisRoles(prev => prev.includes(r) ? prev.filter(x => x !== r) : [...prev, r]); }
  function toggleUser(id) { setVisUserIds(prev => prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]); }

  const filteredUsers = useMemo(() => {
    if (!userSearch) return allUsers;
    const q = userSearch.toLowerCase();
    return allUsers.filter(u => (u.displayName || u.userName || '').toLowerCase().includes(q) || (u.email || '').toLowerCase().includes(q));
  }, [allUsers, userSearch]);

  function handleApprove() {
    if (visType === 'roles' && visRoles.length === 0) return;
    if (visType === 'users' && visUserIds.length === 0) return;
    const visibility = {
      type: visType,
      roles: visType === 'roles' ? visRoles : [],
      userIds: visType === 'users' ? visUserIds : [],
    };
    onApprove(visibility);
  }

  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 1060, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
      <div style={{ position: 'absolute', inset: 0, background: 'rgba(0,0,0,0.55)', backdropFilter: 'blur(2px)' }} onClick={onClose} />
      <div className="card border-0 shadow-lg" style={{ position: 'relative', width: '100%', maxWidth: 500, zIndex: 1, borderRadius: 16, maxHeight: '90vh', overflowY: 'auto' }}>
        <div className="card-body p-4">
          <div className="d-flex align-items-center justify-content-between mb-3">
            <div>
              <h6 className="fw-bold mb-0">Approve &amp; Set Visibility</h6>
              <p className="text-muted small mb-0">"{pendingDoc.title}" by {pendingDoc.submittedByName}</p>
            </div>
            <button className="btn btn-sm btn-light border-0 rounded-circle" onClick={onClose}
              style={{ width: 32, height: 32, padding: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <i className="bi bi-x-lg" style={{ fontSize: '0.85rem' }} />
            </button>
          </div>

          {pendingDoc.url && (
            <div className="rounded-2 p-2 mb-3 d-flex align-items-center gap-2" style={{ background: 'var(--info-soft)', border: '1px solid color-mix(in srgb, var(--info) 35%, transparent)', fontSize: '0.78rem' }}>
              <i className="bi bi-link-45deg text-primary" />
              <a href={pendingDoc.url} target="_blank" rel="noreferrer" className="text-primary text-decoration-none text-truncate">{pendingDoc.url}</a>
            </div>
          )}

          <label className="form-label small fw-semibold">Who should see this document?</label>
          <div className="d-flex gap-2 flex-wrap mb-2">
            {[
              { value: 'everyone', label: 'Everyone',       icon: 'bi-globe' },
              { value: 'roles',    label: 'By Role',        icon: 'bi-people' },
              { value: 'users',    label: 'Specific Users', icon: 'bi-person-check' },
            ].map(v => (
              <button key={v.value} type="button" onClick={() => setVisType(v.value)}
                className="d-inline-flex align-items-center gap-1 rounded-pill border"
                style={{
                  fontSize: '0.78rem', fontWeight: 600, padding: '5px 12px',
                  background: visType === v.value ? 'var(--accent)' : 'var(--surface-2)',
                  color: visType === v.value ? 'var(--on-accent)' : 'var(--text-secondary)',
                  borderColor: visType === v.value ? 'var(--accent)' : 'var(--border-subtle)',
                  cursor: 'pointer',
                }}>
                <i className={`bi ${v.icon}`} style={{ fontSize: '0.72rem' }} />{v.label}
              </button>
            ))}
          </div>

          {visType === 'roles' && (
            <div className="rounded-2 p-3 mb-3" style={{ background: 'var(--surface-2)', border: '1px solid var(--border-subtle)' }}>
              <div className="d-flex gap-2 flex-wrap">
                {VIS_ROLE_OPTIONS.map(({ value, label }) => {
                  const sel = visRoles.includes(value);
                  return (
                    <button key={value} type="button" onClick={() => toggleRole(value)}
                      className="d-inline-flex align-items-center gap-1 rounded-pill border"
                      style={{
                        fontSize: '0.76rem', fontWeight: 600, padding: '5px 12px',
                        background: sel ? 'var(--info)' : 'var(--surface-1)', color: sel ? 'var(--text-inverse)' : 'var(--info)',
                        borderColor: sel ? 'var(--info)' : 'color-mix(in srgb, var(--info) 35%, transparent)', cursor: 'pointer',
                      }}>
                      <i className={`bi ${sel ? 'bi-check-circle-fill' : 'bi-circle'}`} style={{ fontSize: '0.65rem' }} />{label}
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          {visType === 'users' && (
            <div className="rounded-2 p-3 mb-3" style={{ background: 'var(--surface-2)', border: '1px solid var(--border-subtle)' }}>
              <input type="text" className="form-control form-control-sm mb-2" placeholder="Search users…"
                value={userSearch} onChange={e => setUserSearch(e.target.value)} style={{ borderRadius: 8 }} />
              {visUserIds.length > 0 && (
                <div className="d-flex flex-wrap gap-1 mb-2">
                  {visUserIds.map(uid => {
                    const u = allUsers.find(x => x.id === uid);
                    return (
                      <span key={uid} className="d-inline-flex align-items-center gap-1 rounded-pill px-2 py-1"
                        style={{ background: 'var(--info-soft)', border: '1px solid color-mix(in srgb, var(--info) 35%, transparent)', fontSize: '0.68rem', fontWeight: 500, color: 'var(--info)' }}>
                        {u ? (u.displayName || u.userName || u.email) : uid}
                        <i className="bi bi-x" style={{ cursor: 'pointer', fontSize: '0.72rem' }} onClick={() => toggleUser(uid)} />
                      </span>
                    );
                  })}
                </div>
              )}
              <div style={{ maxHeight: 160, overflowY: 'auto' }}>
                {filteredUsers.map(u => {
                  const sel = visUserIds.includes(u.id);
                  const name = u.displayName || u.userName || u.email;
                  return (
                    <div key={u.id} className="d-flex align-items-center gap-2 rounded-2 p-2 mb-1"
                      style={{ background: sel ? 'var(--info-soft)' : 'var(--surface-1)', border: `1px solid ${sel ? 'color-mix(in srgb, var(--info) 35%, transparent)' : 'var(--border-subtle)'}`, cursor: 'pointer' }}
                      onClick={() => toggleUser(u.id)}>
                      <input type="checkbox" className="form-check-input flex-shrink-0" checked={sel} readOnly />
                      <span className="fw-medium text-truncate" style={{ fontSize: '0.75rem' }}>{name}</span>
                      <span className="text-muted ms-auto" style={{ fontSize: '0.62rem' }}>{u.role?.toUpperCase()}</span>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          <div className="d-flex gap-2 justify-content-end mt-3">
            <button className="btn btn-sm btn-outline-secondary px-3" onClick={onClose}>Cancel</button>
            <button className="btn btn-sm btn-success px-3 d-inline-flex align-items-center gap-1" onClick={handleApprove} disabled={saving}>
              {saving ? <><span className="spinner-border spinner-border-sm" /> Approving…</> : <><i className="bi bi-check-lg" /> Approve &amp; Publish</>}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
