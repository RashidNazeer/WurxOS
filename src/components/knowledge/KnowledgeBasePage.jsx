import React, { useEffect, useState, useMemo } from 'react';
import { useAuth } from '../../contexts/AuthContext';
import {
  subscribeArticles,
  subscribeComments,
  subscribeLinkedChanges,
  getMyAckMap,
  ackArticle,
  unackArticle,
  userAddComment,
  userProposeArticle,
  findDuplicateByUrl,
  listAllArticles,
} from '../../lib/kbApi';

const SOP_TABS = ['delivery_roadmap', 'operational_sops', 'training_sops', 'policies'];
const SOP_TAB_TO_CHANGE_TYPE = { delivery_roadmap: 'delivery_roadmap', operational_sops: 'operational', training_sops: 'training', policies: 'policies' };

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
              <iframe
                src={info.src}
                title="Video"
                style={{ position: 'absolute', top: 0, left: 0, width: '100%', height: '100%', border: 'none' }}
                allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
                allowFullScreen
              />
            </div>
          ) : (
            <video controls autoPlay style={{ width: '100%', maxHeight: 400, display: 'block' }}>
              <source src={info.src} />
            </video>
          )}
        </div>
      )}
    </div>
  );
}

// ── Comment Section ───────────────────────────────────────────────────────────

function CommentSection({ docId, docTitle, currentUser, userName }) {
  const [comments, setComments] = useState([]);
  const [text, setText]         = useState('');
  const [sending, setSending]   = useState(false);

  useEffect(() => {
    const unsub = subscribeComments(docId, (rows) => setComments(rows));
    return () => unsub();
  }, [docId]);

  async function handleSend() {
    if (!text.trim()) return;
    setSending(true);
    try {
      await userAddComment(docId, text.trim());
      setText('');
    } catch { /* ignore */ } finally { setSending(false); }
  }

  return (
    <div className="mt-3">
      <div className="small fw-semibold text-muted mb-2" style={{ fontSize: '0.72rem' }}>
        <i className="bi bi-chat-dots me-1" />Comments & Suggestions
      </div>

      {comments.length > 0 && (
        <div className="d-flex flex-column gap-2 mb-2" style={{ maxHeight: 240, overflowY: 'auto' }}>
          {comments.map(c => (
            <div key={c.id} className="rounded-2 p-2" style={{ background: c.userId === currentUser.uid ? 'var(--info-soft)' : 'var(--surface-2)', border: '1px solid var(--border-subtle)', color: 'var(--text-primary)' }}>
              <div className="d-flex align-items-center gap-2 mb-1">
                <span className="rounded-circle d-inline-flex align-items-center justify-content-center fw-bold flex-shrink-0"
                  style={{ width: 20, height: 20, background: c.userId === currentUser.uid ? 'var(--info)' : 'var(--text-muted)', color: 'var(--text-inverse)', fontSize: '0.5rem' }}>
                  {(c.userName || '?').slice(0, 2).toUpperCase()}
                </span>
                <span className="fw-semibold" style={{ fontSize: '0.72rem', color: 'var(--text-primary)' }}>{c.userName}</span>
                <span style={{ fontSize: '0.62rem', color: 'var(--text-muted)' }}>{formatTime(c.createdAt)}</span>
              </div>
              <p className="mb-0 small" style={{ fontSize: '0.78rem', color: 'var(--text-primary)' }}>{c.text}</p>
              {c.bossReply && (
                <div className="mt-2 rounded-2 p-2" style={{ background: 'var(--warning-soft)', border: '1px solid color-mix(in srgb, var(--warning) 35%, transparent)' }}>
                  <div className="d-flex align-items-center gap-1 mb-1">
                    <i className="bi bi-star-fill" style={{ color: 'var(--warning)', fontSize: '0.58rem' }} />
                    <span className="fw-semibold" style={{ fontSize: '0.68rem', color: 'var(--warning)' }}>Boss Reply</span>
                    <span style={{ fontSize: '0.58rem', color: 'var(--text-muted)' }}>{formatTime(c.bossReplyAt)}</span>
                  </div>
                  <p className="mb-0 small" style={{ fontSize: '0.76rem', color: 'var(--text-primary)' }}>{c.bossReply}</p>
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      <div className="d-flex gap-2">
        <input type="text" className="form-control form-control-sm" style={{ borderRadius: 8 }}
          placeholder="Add a comment or suggestion…" value={text}
          onChange={e => setText(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend(); } }} />
        <button className="btn btn-sm btn-dark flex-shrink-0 d-inline-flex align-items-center gap-1"
          style={{ borderRadius: 8 }} onClick={handleSend} disabled={sending || !text.trim()}>
          <i className="bi bi-send" style={{ fontSize: '0.7rem' }} />
        </button>
      </div>
    </div>
  );
}

// ── Main Page ─────────────────────────────────────────────────────────────────

export default function KnowledgeBasePage() {
  const { user, profile } = useAuth();
  // Stable primitives for useEffect dependencies — building a new
  // currentUser object every render caused effects to re-run forever
  // (subscription unmounts/remounts, never settles).
  const uid = user?.id || null;
  const userEmail = user?.email || '';
  const displayName = profile?.display_name || '';
  const currentUser = uid ? { uid, email: userEmail, displayName } : null;
  const userRole = profile?.role || '';
  const apcProfile = (userRole === 'apc' || userRole === 'ipc') ? { userName: profile?.display_name || '' } : null;
  const effectiveRole = userRole === 'tl' ? 'tl' : userRole === 'ol' ? 'ol' : (apcProfile ? 'apc' : (userRole || 'tl'));
  const canPropose = effectiveRole === 'tl' || effectiveRole === 'ol';
  const [allItems, setAllItems] = useState([]);
  const [acks, setAcks]         = useState({});
  const [loading, setLoading]   = useState(true);
  const [activeTab, setActiveTab] = useState('all');
  const [expandedId, setExpandedId] = useState(null);
  const [search, setSearch]     = useState('');
  const [versionFilter, setVersionFilter] = useState('all');
  const [linkedChanges, setLinkedChanges] = useState([]);
  const [showPropose, setShowPropose] = useState(false);
  const [proposeSaving, setProposeSaving] = useState(false);
  const [proposeSuccess, setProposeSuccess] = useState(false);

  const userName = apcProfile?.userName || currentUser?.displayName || currentUser?.email?.split('@')[0] || 'User';

  // Two-track data loading:
  //   1. Direct one-shot fetch — fires immediately so the user sees rows
  //      ASAP even if realtime is misbehaving on the network.
  //   2. Realtime subscription — picks up subsequent changes; if its
  //      initial payload arrives, it overwrites with the same data.
  // Either path flips loading=false. Plus a 5s watchdog as last resort.
  // Dep is `uid` (stable primitive), NOT `currentUser` (new object each
  // render — would cause the effect to re-run forever, unmounting and
  // remounting the subscription so it never settles).
  useEffect(() => {
    if (!uid) return;
    let alive = true;
    const safetyTimer = setTimeout(() => {
      if (!alive) return;
      setLoading((wasLoading) => {
        if (wasLoading) console.warn('[KB] loading watchdog: forcing loading=false after 5s');
        return false;
      });
    }, 5000);

    const applyRows = (rows) => {
      const visible = rows.filter(item => {
        if (item.approvalStatus && item.approvalStatus !== 'approved') return false;
        return true;
      });
      setAllItems(visible);
      setLoading(false);
      clearTimeout(safetyTimer);
    };

    listAllArticles()
      .then((rows) => { if (alive) applyRows(rows); })
      .catch((err) => {
        console.warn('[KB] direct listAllArticles failed:', err?.message);
        if (alive) {
          setAllItems([]);
          setLoading(false);
          clearTimeout(safetyTimer);
        }
      });

    const unsub = subscribeArticles(
      (rows) => { if (alive) applyRows(rows); },
      (err) => { console.warn('[KB] subscribeArticles error:', err?.message); },
    );
    return () => { alive = false; clearTimeout(safetyTimer); unsub(); };
  }, [uid]);

  // Linked changes (delivery roadmap) — dep is `uid` (primitive)
  useEffect(() => {
    if (!uid) return;
    const unsub = subscribeLinkedChanges((rows) => setLinkedChanges(rows));
    return () => unsub();
  }, [uid]);

  // Load user's acknowledgments — depends on `uid` + `allItems` length
  // (using length as a stable trigger; allItems contents change identity
  // but this effect only needs to re-run when the article SET changes).
  useEffect(() => {
    if (!uid || !allItems.length) return;
    let alive = true;
    (async () => {
      try {
        const ackSet = await getMyAckMap(uid);
        if (!alive) return;
        const ackMap = {};
        allItems.forEach(item => { ackMap[item.id] = ackSet.has(item.id); });
        setAcks(ackMap);
      } catch { /* ignore */ }
    })();
    return () => { alive = false; };
  }, [uid, allItems.length]);

  async function handleAcknowledge(itemId) {
    if (acks[itemId]) return;
    try {
      await ackArticle(itemId);
      setAcks(prev => ({ ...prev, [itemId]: true }));
    } catch { /* ignore */ }
  }

  async function handleUnacknowledge(itemId) {
    try {
      await unackArticle(itemId);
      setAcks(prev => ({ ...prev, [itemId]: false }));
    } catch { /* ignore */ }
  }

  // Compute available versions for current tab (SOP tabs only)
  const availableVersions = useMemo(() => {
    const isSopTab = SOP_TABS.includes(activeTab);
    if (!isSopTab && activeTab !== 'all') return [];
    const items = activeTab === 'all' ? allItems.filter(i => SOP_TABS.includes(i.tab)) : allItems.filter(i => i.tab === activeTab);
    const versions = [...new Set(items.map(i => i.version).filter(Boolean))];
    versions.sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
    return versions;
  }, [allItems, activeTab]);

  // Compute latest version per sopGroupId (or per id if no group)
  const latestVersionMap = useMemo(() => {
    const groups = {};
    allItems.forEach(item => {
      if (!item.version || !SOP_TABS.includes(item.tab)) return;
      const gid = item.sopGroupId || item.id;
      if (!groups[gid]) groups[gid] = [];
      groups[gid].push(item);
    });
    const latest = {};
    Object.entries(groups).forEach(([gid, docs]) => {
      docs.sort((a, b) => (b.createdAt?.seconds || 0) - (a.createdAt?.seconds || 0));
      latest[docs[0].id] = true;
    });
    return latest;
  }, [allItems]);

  const tabItems = useMemo(() => {
    let filtered = activeTab === 'all' ? allItems : allItems.filter(i => i.tab === activeTab);
    if (search) {
      const q = search.toLowerCase();
      filtered = filtered.filter(i => (i.title || '').toLowerCase().includes(q) || (i.description || '').toLowerCase().includes(q));
    }
    if (versionFilter === 'latest') {
      filtered = filtered.filter(i => !i.version || !SOP_TABS.includes(i.tab) || latestVersionMap[i.id]);
    } else if (versionFilter !== 'all') {
      filtered = filtered.filter(i => i.version === versionFilter || !SOP_TABS.includes(i.tab));
    }
    return filtered;
  }, [allItems, activeTab, search, versionFilter, latestVersionMap]);

  const tabCounts = useMemo(() => {
    const counts = {};
    TABS.forEach(t => { counts[t.value] = allItems.filter(i => i.tab === t.value).length; });
    return counts;
  }, [allItems]);

  const unreadCounts = useMemo(() => {
    const counts = {};
    TABS.forEach(t => {
      counts[t.value] = allItems.filter(i => i.tab === t.value && !acks[i.id]).length;
    });
    return counts;
  }, [allItems, acks]);

  async function handlePropose(data) {
    setProposeSaving(true);
    try {
      // Duplicate URL check across the full KB.
      const allDocs = await listAllArticles();
      const dupe = findDuplicateByUrl(data.url, allDocs);
      if (dupe) {
        setProposeSaving(false);
        alert(`This URL is already in the Knowledge Base as "${dupe.title}". Please use a different link.`);
        return;
      }
      await userProposeArticle({
        title:       data.title.trim(),
        url:         data.url.trim(),
        description: data.description.trim(),
        tab:         data.tab,
        version:     data.version?.trim() || '',
      });
      setShowPropose(false);
      setProposeSuccess(true);
    } catch (err) {
      // Surface the failure — a silent catch let a failed propose look like a
      // success while nothing was saved (the "added but never persisted" ghost).
      throw err;
    } finally { setProposeSaving(false); }
  }

  return (
    <div style={{ padding: '32px 32px 48px' }}>
      {/* Header */}
      <div className="d-flex align-items-start justify-content-between mb-4">
        <div>
          <h5 className="fw-bold mb-1 d-flex align-items-center gap-2" style={{ color: 'var(--text-primary)' }}>
            <i className="bi bi-book" style={{ fontSize: '1.15rem' }} />
            Knowledge Base
          </h5>
          <p className="small mb-0" style={{ color: 'var(--text-muted)' }}>Company documents, SOPs, and policies</p>
        </div>
        {canPropose && (
          <button
            className="btn btn-sm d-inline-flex align-items-center gap-2"
            style={{ borderRadius: 10, fontWeight: 600, fontSize: '0.82rem', padding: '7px 14px',
                     background: 'var(--accent)', color: 'var(--on-accent)', border: '1px solid var(--accent)' }}
            onClick={() => setShowPropose(true)}
          >
            <i className="bi bi-plus-lg" /> Propose Document
          </button>
        )}
      </div>

      {/* Tab nav */}
      <div className="d-flex flex-wrap gap-2 mb-3">
        {[{ value: 'all', label: 'All', icon: 'bi-grid-3x3-gap' }, ...TABS].map(tab => {
          const count = tab.value === 'all' ? allItems.length : tabCounts[tab.value];
          const unread = tab.value === 'all' ? allItems.filter(i => !acks[i.id]).length : unreadCounts[tab.value];
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
                <span className="rounded-pill px-1" style={{ fontSize: '0.6rem', fontWeight: 700,
                  background: activeTab === tab.value ? 'rgba(255,255,255,0.25)' : 'var(--surface-3)',
                  color: activeTab === tab.value ? 'var(--on-accent)' : 'var(--text-muted)',
                  lineHeight: '16px', minWidth: 16, textAlign: 'center' }}>
                  {count}
                </span>
              )}
              {unread > 0 && (
                <span className="rounded-circle flex-shrink-0" style={{ width: 6, height: 6, background: 'var(--danger)' }} />
              )}
            </button>
          );
        })}
      </div>

      {/* Search + Version Filter */}
      {!loading && allItems.length > 0 && (
        <div className="d-flex gap-2 mb-4 flex-wrap align-items-center">
          <div className="position-relative" style={{ maxWidth: 280 }}>
            <i className="bi bi-search position-absolute" style={{ left: 10, top: '50%', transform: 'translateY(-50%)', fontSize: '0.78rem', pointerEvents: 'none', color: 'var(--text-muted)' }} />
            <input type="text" className="form-control form-control-sm" placeholder="Search documents…"
              style={{ paddingLeft: 30, borderRadius: 8, background: 'var(--input-bg)', color: 'var(--input-text)', borderColor: 'var(--input-border)' }}
              value={search} onChange={e => setSearch(e.target.value)} />
          </div>
          {availableVersions.length > 0 && (
            <select className="form-select form-select-sm" style={{ maxWidth: 160, borderRadius: 8, background: 'var(--input-bg)', color: 'var(--input-text)', borderColor: 'var(--input-border)' }}
              value={versionFilter} onChange={e => setVersionFilter(e.target.value)}>
              <option value="all">All Versions</option>
              <option value="latest">Latest Only</option>
              {availableVersions.map(v => <option key={v} value={v}>{v}</option>)}
            </select>
          )}
        </div>
      )}

      {/* Content */}
      {loading ? (
        <div className="d-flex align-items-center gap-2 py-5" style={{ color: 'var(--text-muted)' }}><span className="spinner-border spinner-border-sm" /><span className="small">Loading…</span></div>
      ) : tabItems.length === 0 ? (
        <div className="d-flex flex-column align-items-center justify-content-center py-5" style={{ border: '2px dashed var(--border-default)', borderRadius: 16, background: 'var(--surface-1)' }}>
          <div className="rounded-circle d-flex align-items-center justify-content-center mb-3" style={{ width: 64, height: 64, background: 'var(--surface-2)' }}>
            <i className="bi bi-book" style={{ fontSize: '1.6rem', opacity: 0.45, color: 'var(--text-muted)' }} />
          </div>
          <p className="fw-semibold mb-1" style={{ color: 'var(--text-primary)' }}>{search ? 'No matching documents' : 'No documents yet'}</p>
          <p className="small mb-0" style={{ color: 'var(--text-muted)' }}>Documents will appear here once added by the boss.</p>
        </div>
      ) : (
        <div className="d-flex flex-column gap-3">
          {tabItems.map(item => {
            const isRead = acks[item.id];
            const isExpanded = expandedId === item.id;
            return (
              <div key={item.id} className="card border-0 shadow-sm" style={{ borderRadius: 12, borderLeft: `4px solid ${isRead ? 'var(--success)' : 'var(--warning)'}`, background: 'var(--surface-1)', color: 'var(--text-primary)' }}>
                <div className="card-body p-3">
                  <div className="d-flex align-items-start justify-content-between">
                    <div className="flex-grow-1">
                      <div className="d-flex align-items-center gap-2 mb-1">
                        <a href={item.url} target="_blank" rel="noopener noreferrer" className="fw-semibold small text-decoration-none"
                          style={{ color: 'var(--info)' }} onClick={e => e.stopPropagation()}>
                          <i className="bi bi-box-arrow-up-right me-1" style={{ fontSize: '0.68rem' }} />
                          {item.title}
                        </a>
                        {activeTab === 'all' && (() => { const t = TABS.find(x => x.value === item.tab); return t ? (
                          <span className="badge rounded-pill" style={{ background: 'var(--surface-2)', color: 'var(--text-muted)', fontSize: '0.56rem', fontWeight: 500 }}>{t.label}</span>
                        ) : null; })()}
                        {isRead ? (
                          <span className="badge rounded-pill" style={{ background: 'var(--success-soft)', color: 'var(--success)', fontSize: '0.58rem' }}>
                            <i className="bi bi-check-circle-fill me-1" style={{ fontSize: '0.52rem' }} />Read
                          </span>
                        ) : (
                          <span className="badge rounded-pill" style={{ background: 'var(--warning-soft)', color: 'var(--warning)', fontSize: '0.58rem' }}>
                            <i className="bi bi-circle me-1" style={{ fontSize: '0.52rem' }} />Unread
                          </span>
                        )}
                      </div>
                      {item.description && <p className="small mb-1" style={{ fontSize: '0.76rem', color: 'var(--text-secondary)' }}>{item.description}</p>}
                      <VideoEmbed url={item.url} />
                      <div className="d-flex align-items-center gap-2 flex-wrap" style={{ fontSize: '0.65rem', marginTop: 4 }}>
                        {item.version && (
                          <span className="badge rounded-pill" style={{ background: 'var(--success-soft)', color: 'var(--success)', fontSize: '0.6rem', border: '1px solid color-mix(in srgb, var(--success) 35%, transparent)' }}>
                            <i className="bi bi-tag-fill me-1" />{item.version}
                          </span>
                        )}
                        {item.version && latestVersionMap[item.id] && (
                          <span className="badge rounded-pill" style={{ background: 'var(--info-soft)', color: 'var(--info)', fontSize: '0.55rem', border: '1px solid color-mix(in srgb, var(--info) 35%, transparent)' }}>Latest</span>
                        )}
                        <span style={{ color: 'var(--text-muted)' }}>Added {formatDate(item.createdAt)}</span>
                        {item.updatedByName && (
                          <span style={{ color: 'var(--text-muted)' }}>· by {item.updatedByName}</span>
                        )}
                      </div>
                      {/* Delivery Roadmap — linked changes for this SOP */}
                      {SOP_TABS.includes(item.tab) && (() => {
                        const sopType = SOP_TAB_TO_CHANGE_TYPE[item.tab];
                        const docChanges = linkedChanges.filter(c =>
                          (c.affectedSopIds || []).includes(item.id) || (c.sopType === sopType && !c.affectedSopIds?.length)
                        );
                        if (docChanges.length === 0) return null;
                        return (
                          <div className="mt-2 rounded-2 p-2" style={{ background: 'var(--warning-soft)', border: '1px solid color-mix(in srgb, var(--warning) 35%, transparent)' }}>
                            <div className="d-flex align-items-center gap-1 mb-1">
                              <i className="bi bi-signpost-split" style={{ fontSize: '0.65rem', color: 'var(--warning)' }} />
                              <span className="fw-semibold" style={{ fontSize: '0.68rem', color: 'var(--warning)' }}>Delivery Roadmap</span>
                            </div>
                            {docChanges.map(c => {
                              // Use semantic-token CSS variables so the dots/pills read in both themes.
                              const stTokens = { pending: 'var(--warning)', approved: 'var(--success)', in_progress: 'var(--info)', completed: '#8b5cf6', implemented: 'var(--success)' };
                              const stLabels = { pending: 'Pending', approved: 'Approved', in_progress: 'In Progress', completed: 'Completed', implemented: 'Implemented' };
                              const tint = stTokens[c.status] || 'var(--text-muted)';
                              return (
                                <div key={c.id} className="d-flex align-items-center gap-2 py-1" style={{ fontSize: '0.68rem', color: 'var(--text-primary)' }}>
                                  <span className="rounded-circle flex-shrink-0" style={{ width: 6, height: 6, background: tint }} />
                                  <span className="fw-medium text-truncate" style={{ maxWidth: 200 }}>{c.title}</span>
                                  <span className="badge rounded-pill" style={{ background: `color-mix(in srgb, ${tint} 18%, transparent)`, color: tint, fontSize: '0.55rem' }}>{stLabels[c.status] || c.status}</span>
                                  {c.ownerName && <span style={{ fontSize: '0.6rem', color: 'var(--text-muted)' }}>· {c.ownerName}</span>}
                                </div>
                              );
                            })}
                          </div>
                        );
                      })()}
                    </div>

                    <div className="d-flex align-items-center gap-2 flex-shrink-0 ms-3">
                      {isRead ? (
                        <button className="btn btn-sm btn-outline-secondary d-inline-flex align-items-center gap-1 px-2"
                          style={{ fontSize: '0.7rem', borderRadius: 6, color: 'var(--text-secondary)', borderColor: 'var(--border-default)', background: 'transparent' }} onClick={() => handleUnacknowledge(item.id)}>
                          <i className="bi bi-x" /> Undo
                        </button>
                      ) : (
                        <button className="btn btn-sm d-inline-flex align-items-center gap-1 px-2"
                          style={{ fontSize: '0.7rem', borderRadius: 6, background: 'var(--success)', color: 'var(--text-inverse)', border: '1px solid var(--success)' }} onClick={() => handleAcknowledge(item.id)}>
                          <i className="bi bi-check2" /> Mark as Read
                        </button>
                      )}
                      <button className="btn btn-sm btn-outline-secondary px-2"
                        style={{ fontSize: '0.7rem', borderRadius: 6, color: 'var(--text-secondary)', borderColor: 'var(--border-default)', background: 'transparent' }}
                        onClick={() => setExpandedId(isExpanded ? null : item.id)}>
                        <i className={`bi bi-chat-dots${isExpanded ? '-fill' : ''}`} />
                      </button>
                    </div>
                  </div>

                  {isExpanded && (
                    <CommentSection docId={item.id} docTitle={item.title} currentUser={currentUser} userName={userName} />
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* ── Submission Success Dialog ── */}
      {proposeSuccess && (
        <div style={{ position: 'fixed', inset: 0, zIndex: 1070, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
          <div style={{ position: 'absolute', inset: 0, background: 'rgba(0,0,0,0.55)', backdropFilter: 'blur(2px)' }} onClick={() => setProposeSuccess(false)} />
          <div className="card border-0 shadow-lg text-center" style={{ position: 'relative', width: '100%', maxWidth: 400, zIndex: 1, borderRadius: 16, background: 'var(--surface-1)', color: 'var(--text-primary)' }}>
            <div className="card-body p-4">
              <div className="rounded-circle d-inline-flex align-items-center justify-content-center mb-3"
                style={{ width: 56, height: 56, background: 'var(--success-soft)' }}>
                <i className="bi bi-check-lg" style={{ fontSize: '1.6rem', color: 'var(--success)' }} />
              </div>
              <h6 className="fw-bold mb-2" style={{ color: 'var(--text-primary)' }}>Submitted for Review</h6>
              <p className="small mb-3" style={{ lineHeight: 1.5, color: 'var(--text-muted)' }}>
                Your document has been submitted successfully and will be reviewed by your Employer / Boss.
                You'll be notified once it's approved.
              </p>
              <button className="btn btn-sm px-4" style={{ borderRadius: 10, background: 'var(--accent)', color: 'var(--on-accent)', border: '1px solid var(--accent)' }} onClick={() => setProposeSuccess(false)}>
                Got it
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Propose Document Modal ── */}
      {showPropose && (
        <ProposeModal
          saving={proposeSaving}
          onClose={() => setShowPropose(false)}
          onSave={handlePropose}
        />
      )}
    </div>
  );
}

// ── Propose Document Modal (TL / OL) ─────────────────────────────────────────
function ProposeModal({ onClose, onSave, saving }) {
  const [title, setTitle] = useState('');
  const [url, setUrl]     = useState('');
  const [desc, setDesc]   = useState('');
  const [tab, setTab]     = useState('delivery_roadmap');
  const [version, setVersion] = useState('');
  const [error, setError] = useState('');

  async function handleSubmit(e) {
    e.preventDefault();
    if (!title.trim()) { setError('Title is required.'); return; }
    if (!url.trim()) { setError('URL / Link is required.'); return; }
    if (SOP_TABS.includes(tab) && !version.trim()) { setError('Version is required for SOP documents.'); return; }
    setError('');
    try {
      await onSave({ title, url, description: desc, tab, version });
    } catch (err) {
      setError(err?.message || 'Could not submit — please check your connection and try again. It was NOT saved.');
    }
  }

  // Themed input style — Bootstrap form-control doesn't honor our tokens
  // by default, so apply them inline here. Same shape as other v2 modals.
  const inputStyle = { background: 'var(--input-bg)', color: 'var(--input-text)', borderColor: 'var(--input-border)' };

  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 1050, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
      <div style={{ position: 'absolute', inset: 0, background: 'rgba(0,0,0,0.55)', backdropFilter: 'blur(2px)' }} onClick={onClose} />
      <div className="card border-0 shadow-lg" style={{ position: 'relative', width: '100%', maxWidth: 500, zIndex: 1, borderRadius: 16, maxHeight: '90vh', overflowY: 'auto', background: 'var(--surface-1)', color: 'var(--text-primary)' }}>
        <div className="card-body p-4">
          <div className="d-flex align-items-center justify-content-between mb-4">
            <div>
              <h6 className="fw-bold mb-0" style={{ color: 'var(--text-primary)' }}>Propose a Document</h6>
              <p className="small mb-0" style={{ color: 'var(--text-muted)' }}>Submit for boss approval — visibility will be set upon approval</p>
            </div>
            <button className="btn btn-sm border-0 rounded-circle" onClick={onClose}
              style={{ width: 32, height: 32, padding: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--surface-2)', color: 'var(--text-secondary)' }}>
              <i className="bi bi-x-lg" style={{ fontSize: '0.85rem' }} />
            </button>
          </div>
          <form onSubmit={handleSubmit}>
            {error && <div className="alert alert-danger py-2 small mb-3">{error}</div>}
            <div className="mb-3">
              <label className="form-label small fw-semibold" style={{ color: 'var(--text-primary)' }}>Title <span style={{ color: 'var(--danger)' }}>*</span></label>
              <input type="text" className="form-control" placeholder="Document title" value={title} onChange={e => setTitle(e.target.value)} autoFocus style={inputStyle} />
            </div>
            <div className="mb-3">
              <label className="form-label small fw-semibold" style={{ color: 'var(--text-primary)' }}>Link / URL <span style={{ color: 'var(--danger)' }}>*</span></label>
              <input type="url" className="form-control form-control-sm" placeholder="https://docs.google.com/…" value={url} onChange={e => setUrl(e.target.value)} style={inputStyle} />
            </div>
            <div className="mb-3">
              <label className="form-label small fw-semibold" style={{ color: 'var(--text-primary)' }}>Description <span className="fw-normal" style={{ color: 'var(--text-muted)' }}>(optional)</span></label>
              <textarea className="form-control" rows={2} placeholder="Brief description…" value={desc} onChange={e => setDesc(e.target.value)} style={inputStyle} />
            </div>
            <div className="mb-3">
              <label className="form-label small fw-semibold" style={{ color: 'var(--text-primary)' }}>Category</label>
              <div className="d-flex gap-2 flex-wrap">
                {TABS.map(t => (
                  <button key={t.value} type="button" onClick={() => setTab(t.value)}
                    className="d-inline-flex align-items-center gap-1 rounded-pill border"
                    style={{
                      fontSize: '0.75rem', fontWeight: 600, padding: '4px 10px',
                      background: tab === t.value ? 'var(--accent)' : 'var(--surface-2)',
                      color: tab === t.value ? 'var(--on-accent)' : 'var(--text-secondary)',
                      borderColor: tab === t.value ? 'var(--accent)' : 'var(--border-subtle)',
                      cursor: 'pointer', transition: 'all 0.12s',
                    }}>
                    <i className={`bi ${t.icon}`} style={{ fontSize: '0.65rem' }} />{t.label}
                  </button>
                ))}
              </div>
            </div>
            {SOP_TABS.includes(tab) && (
              <div className="mb-3">
                <label className="form-label small fw-semibold" style={{ color: 'var(--text-primary)' }}>SOP Version <span style={{ color: 'var(--danger)' }}>*</span></label>
                <input type="text" className="form-control form-control-sm" placeholder="e.g. v1.0" value={version} onChange={e => setVersion(e.target.value)} style={inputStyle} />
              </div>
            )}
            <div className="d-flex gap-2 justify-content-end">
              <button type="button" className="btn btn-sm btn-outline-secondary px-3" onClick={onClose}
                style={{ color: 'var(--text-secondary)', borderColor: 'var(--border-default)', background: 'transparent' }}>Cancel</button>
              <button type="submit" className="btn btn-sm px-3 d-inline-flex align-items-center gap-1" disabled={saving}
                style={{ background: 'var(--accent)', color: 'var(--on-accent)', border: '1px solid var(--accent)' }}>
                {saving ? <><span className="spinner-border spinner-border-sm" /> Submitting…</> : <><i className="bi bi-send" /> Submit for Approval</>}
              </button>
            </div>
          </form>
        </div>
      </div>
    </div>
  );
}
