import { useEffect, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '../../contexts/AuthContext';
import { supabase } from '../../lib/supabase';
import {
  PlusIcon, AlertIcon, RefreshIcon, XIcon, CheckIcon, SearchIcon,
  BookmarkIcon, PencilIcon, TrashIcon, UserIcon, UsersIcon, ShieldIcon,
  MessageIcon, ClockIcon, LinkIcon,
} from '../../components/common/Icon';
import {
  KB_CATEGORIES, KB_VISIBILITIES, categoryLabel,
  listArticles, listPending, listVersions, listComments, ackDashboard,
  getMyAckMap, proposeArticle, approveArticle, rejectArticle,
  setAck, addComment, replyToComment, deleteArticle, detectVideo,
  isSopCategory,
} from '../../lib/kbApi';
import BulkImportKnowledgeBaseModal from '../../components/knowledge/BulkImportKnowledgeBaseModal';
import DuplicateCheckerModal from '../../components/knowledge/DuplicateCheckerModal';
import '../../styles/table.css';
import '../../styles/modal.css';

const TABS = [
  { value: 'all', label: 'All' },
  ...KB_CATEGORIES,
];

export default function KnowledgeBasePage() {
  const { user, profile } = useAuth();
  const isAdmin = ['boss','ol','developer'].includes(profile?.role);
  const isBoss  = profile?.role === 'boss';

  const [q, setQ]                 = useState('');
  const [tab, setTab]             = useState('all');
  const [openArticle, setOpen]    = useState(null);
  const [editArticle, setEdit]    = useState(null);
  const [showPending, setPending] = useState(false);
  const [ackOpen, setAckOpen]     = useState(null);
  const [localErr, setLocalErr]   = useState('');
  const [showBulkImport, setBulkImport] = useState(false);
  const [showDupCheck, setDupCheck]     = useState(false);

  const qc = useQueryClient();
  const { data: rows = [], isLoading: loading, error: queryError } = useQuery({
    queryKey: ['kb', 'approved'],
    queryFn: () => listArticles({ onlyLatest: true, status: 'approved' }),
  });
  const { data: pending = [] } = useQuery({
    queryKey: ['kb', 'pending'],
    queryFn: listPending,
    enabled: isBoss,
  });
  const { data: myAcks = new Set() } = useQuery({
    queryKey: ['kb', 'myacks', user?.id],
    queryFn: () => getMyAckMap(user.id),
    enabled: !!user?.id,
  });

  const err = localErr || queryError?.message || '';
  const reload = () => {
    qc.invalidateQueries({ queryKey: ['kb'] });
  };

  const filtered = useMemo(() => {
    const qq = q.trim().toLowerCase();
    return rows.filter((r) => {
      if (tab !== 'all' && r.category !== tab) return false;
      if (qq && !(
        (r.title || '').toLowerCase().includes(qq) ||
        (r.body  || '').toLowerCase().includes(qq) ||
        (r.tags || []).some((t) => (t || '').toLowerCase().includes(qq))
      )) return false;
      return true;
    });
  }, [rows, q, tab]);

  // Per-category counts for the tab chips. 'all' is rows.length.
  const counts = useMemo(() => {
    const m = { all: rows.length };
    for (const r of rows) {
      const c = r.category || 'general';
      m[c] = (m[c] || 0) + 1;
    }
    return m;
  }, [rows]);

  async function handleDelete(row) {
    if (!confirm(`Delete "${row.title}"? This removes all versions in this group.`)) return;
    try {
      // Delete the whole sop_group, not just this version
      const { error } = await supabase
        .from('kb_articles').delete()
        .eq('sop_group_id', row.sop_group_id || row.id);
      if (error) throw error;
      reload();
    } catch (e) { setLocalErr(e.message); }
  }

  return (
    <>
      <div className="page-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: 12 }}>
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            <h1 className="page-title" style={{ margin: 0 }}>Knowledge base</h1>
            <span style={{
              display: 'inline-flex', alignItems: 'center', gap: 4,
              padding: '3px 10px', borderRadius: 999,
              background: 'var(--accent-soft, color-mix(in srgb, var(--accent) 14%, transparent))',
              color: 'var(--accent)',
              fontSize: 12, fontWeight: 700, letterSpacing: '0.02em',
            }} title={`${rows.length} approved article${rows.length === 1 ? '' : 's'}`}>
              {loading ? '…' : rows.length} {rows.length === 1 ? 'article' : 'articles'}
            </span>
          </div>
          <p className="page-subtitle">SOPs, policies, and team references — versioned and acknowledged.</p>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="wx-btn wx-btn-ghost" onClick={reload} title="Refresh">
            <RefreshIcon width="15" height="15" />
          </button>
          {isBoss && (
            <>
              <button className="wx-btn wx-btn-ghost" onClick={() => setPending(true)}>
                <ShieldIcon width="14" height="14" />
                Pending
                {pending.length > 0 && (
                  <span style={{
                    marginLeft: 4, padding: '1px 7px', borderRadius: 999,
                    background: 'var(--accent)', color: '#fff',
                    fontSize: 11, fontWeight: 700,
                  }}>{pending.length}</span>
                )}
              </button>
              <button className="wx-btn wx-btn-ghost" onClick={() => setDupCheck(true)} title="Find duplicate articles">
                Duplicates
              </button>
              <button className="wx-btn wx-btn-ghost" onClick={() => setBulkImport(true)} title="Import KB articles from CSV">
                Bulk import
              </button>
            </>
          )}
          <button className="wx-btn wx-btn-primary" onClick={() => setEdit({})}>
            <PlusIcon width="15" height="15" /> {isBoss ? 'New article' : 'Propose article'}
          </button>
        </div>
      </div>

      <div className="wx-toolbar">
        <div className="wx-search" style={{ flex: 1, minWidth: 240 }}>
          <span className="wx-search-icon"><SearchIcon width="16" height="16" /></span>
          <input
            className="wx-input"
            placeholder="Search title, body, tags…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
        </div>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {TABS.map((t) => {
            const n = counts[t.value] || 0;
            const isActive = tab === t.value;
            return (
              <button key={t.value} type="button"
                className={`wx-role-chip ${isActive ? 'wx-role-chip-active' : ''}`}
                onClick={() => setTab(t.value)}
                style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                {t.label}
                <span style={{
                  fontSize: 10.5, fontWeight: 700,
                  padding: '1px 7px', borderRadius: 999,
                  background: isActive
                    ? 'rgba(255,255,255,0.25)'
                    : 'color-mix(in srgb, var(--text-muted) 14%, transparent)',
                  color: isActive ? '#fff' : 'var(--text-muted)',
                  minWidth: 18, textAlign: 'center',
                }}>{n}</span>
              </button>
            );
          })}
        </div>
      </div>

      {err && (
        <div className="wx-alert wx-alert-danger" style={{ marginBottom: 14 }}>
          <AlertIcon width="16" height="16" /> <span>{err}</span>
        </div>
      )}

      {loading ? (
        <div className="wx-empty"><span className="wx-spinner" /> Loading…</div>
      ) : filtered.length === 0 ? (
        <div className="wx-empty">
          <div style={{
            display: 'grid', placeItems: 'center', width: 52, height: 52,
            borderRadius: '50%', background: 'var(--surface-2)',
            color: 'var(--text-muted)', margin: '0 auto 12px',
          }}>
            <BookmarkIcon width="22" height="22" />
          </div>
          <div className="wx-empty-title">No articles yet</div>
          <div>{isBoss ? 'Click New article to add the first one.' : 'Propose an article to populate this tab.'}</div>
        </div>
      ) : (
        <div style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fill, minmax(min(280px, 100%), 1fr))',
          gap: 12,
        }}>
          {filtered.map((r) => (
            <ArticleCard
              key={r.id}
              article={r}
              canEdit={r.created_by === user?.id || isAdmin}
              canAddVersion={isAdmin && isSopCategory(r.category)}
              isRead={myAcks.has(r.id)}
              onOpen={() => setOpen(r)}
              onEdit={(e) => { e.stopPropagation(); setEdit(r); }}
              onNewVersion={(e) => {
                e.stopPropagation();
                setEdit({
                  __newVersion: true,
                  sop_group_id: r.sop_group_id || r.id,
                  title: r.title,
                  category: r.category,
                  visibility: r.visibility,
                  visible_to_roles: r.visible_to_roles,
                  visible_to_users: r.visible_to_users,
                  requires_ack: r.requires_ack,
                });
              }}
              onDelete={(e) => { e.stopPropagation(); handleDelete(r); }}
            />
          ))}
        </div>
      )}

      {openArticle && (
        <ArticleViewerModal
          article={openArticle}
          uid={user?.id}
          isAdmin={isAdmin}
          isBoss={isBoss}
          isRead={myAcks.has(openArticle.id)}
          onClose={() => setOpen(null)}
          onAckDashboard={() => setAckOpen(openArticle)}
          onEdit={() => { setEdit(openArticle); setOpen(null); }}
          onNewVersion={() => {
            setEdit({
              __newVersion: true,
              sop_group_id: openArticle.sop_group_id || openArticle.id,
              title: openArticle.title,
              category: openArticle.category,
              visibility: openArticle.visibility,
              visible_to_roles: openArticle.visible_to_roles,
              visible_to_users: openArticle.visible_to_users,
              requires_ack: openArticle.requires_ack,
            });
            setOpen(null);
          }}
          onChanged={reload}
        />
      )}
      {editArticle && (
        <ArticleFormModal
          article={editArticle}
          uid={user?.id}
          isBoss={isBoss}
          isAdmin={isAdmin}
          onClose={() => setEdit(null)}
          onSaved={() => { setEdit(null); reload(); }}
        />
      )}
      {showPending && (
        <PendingQueueModal
          items={pending}
          onClose={() => setPending(false)}
          onDecided={reload}
        />
      )}
      {ackOpen && (
        <AckDashboardModal article={ackOpen} onClose={() => setAckOpen(null)} />
      )}
      {showBulkImport && (
        <BulkImportKnowledgeBaseModal
          existingItems={rows}
          onClose={() => setBulkImport(false)}
          onImported={reload}
        />
      )}
      {showDupCheck && (
        <DuplicateCheckerModal
          items={rows}
          onClose={() => setDupCheck(false)}
          onChanged={reload}
        />
      )}
    </>
  );
}

// ============================================================
// Card
// ============================================================
function ArticleCard({ article, canEdit, canAddVersion, isRead, onOpen, onEdit, onNewVersion, onDelete }) {
  const a = article;
  const needsAck = a.requires_ack && !isRead;
  const versionTag = a.version_label || ((a.version || 1) > 1 ? `v${a.version}` : null);
  return (
    <div className="wx-card" style={{ padding: 14, cursor: 'pointer', position: 'relative' }} onClick={onOpen}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 6 }}>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{
            fontSize: 10.5, color: 'var(--text-muted)',
            textTransform: 'uppercase', letterSpacing: '0.05em',
            display: 'flex', alignItems: 'center', gap: 6,
          }}>
            <span>{categoryLabel(a.category)}</span>
            {versionTag && (
              <span style={{
                padding: '1px 6px', borderRadius: 4,
                background: 'color-mix(in srgb, var(--accent) 18%, transparent)',
                color: 'var(--accent)', fontWeight: 700, letterSpacing: 0,
                textTransform: 'none',
              }}>{versionTag}</span>
            )}
          </div>
          <div style={{ fontWeight: 700, fontSize: 14, marginTop: 3, lineHeight: 1.3 }}>{a.title}</div>
        </div>
        <div style={{ display: 'flex', gap: 2 }}>
          {canAddVersion && (
            <button onClick={onNewVersion}
              style={{ border: 0, background: 'transparent', color: 'var(--accent)', cursor: 'pointer', padding: 4 }}
              title="Add new version"><PlusIcon width="13" height="13" /></button>
          )}
          {canEdit && (
            <>
              <button onClick={onEdit}
                style={{ border: 0, background: 'transparent', color: 'var(--text-muted)', cursor: 'pointer', padding: 4 }}
                title="Edit"><PencilIcon width="13" height="13" /></button>
              <button onClick={onDelete}
                style={{ border: 0, background: 'transparent', color: 'var(--text-muted)', cursor: 'pointer', padding: 4 }}
                title="Delete"><TrashIcon width="13" height="13" /></button>
            </>
          )}
        </div>
      </div>
      <div style={{
        fontSize: 12.5, color: 'var(--text-secondary)', marginTop: 6,
        display: '-webkit-box', WebkitLineClamp: 3, WebkitBoxOrient: 'vertical',
        overflow: 'hidden',
      }}>
        {a.body}
      </div>
      <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', marginTop: 8 }}>
        {(a.tags || []).slice(0, 4).map((t) => (
          <span key={t} style={{
            fontSize: 10, padding: '2px 6px', borderRadius: 'var(--radius-pill)',
            background: 'var(--accent-soft)', color: 'var(--accent)', fontWeight: 600,
          }}>{t}</span>
        ))}
      </div>
      <div style={{
        display: 'flex', justifyContent: 'space-between',
        alignItems: 'center', marginTop: 10, gap: 8,
      }}>
        <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
          by {a.created_by_profile?.display_name || '—'} · {new Date(a.updated_at).toLocaleDateString()}
        </div>
        {a.requires_ack && (
          <span style={{
            fontSize: 10, padding: '2px 7px', borderRadius: 999,
            fontWeight: 700,
            background: needsAck
              ? 'color-mix(in srgb, var(--warning) 16%, transparent)'
              : 'color-mix(in srgb, var(--success) 16%, transparent)',
            color: needsAck ? 'var(--warning)' : 'var(--success)',
          }}>{needsAck ? 'Unread' : 'Read'}</span>
        )}
      </div>
    </div>
  );
}

// ============================================================
// Article viewer — rich reader with ack, comments, version history
// ============================================================
function ArticleViewerModal({ article, uid, isAdmin, isBoss, isRead, onClose, onAckDashboard, onEdit, onNewVersion, onChanged }) {
  const [versions, setVersions] = useState([]);
  const [showVersions, setShowVersions] = useState(false);
  const [acked, setAcked] = useState(isRead);
  const qc = useQueryClient();

  const video = detectVideo(article.url);

  useEffect(() => { setAcked(isRead); }, [isRead, article.id]);

  async function toggleAck() {
    try {
      await setAck(article.id, !acked);
      setAcked(!acked);
      qc.invalidateQueries({ queryKey: ['kb', 'myacks'] });
    } catch (e) { alert(e.message); }
  }

  async function loadVersions() {
    if (versions.length) return setShowVersions((v) => !v);
    try {
      const v = await listVersions(article.sop_group_id || article.id);
      setVersions(v);
      setShowVersions(true);
    } catch (e) { alert(e.message); }
  }

  return (
    <div className="wx-modal-backdrop wx-m-backdrop" onClick={onClose}>
      <div className="wx-modal" style={{ maxWidth: 820 }} onClick={(e) => e.stopPropagation()}>
        <div className="wx-m-head">
          <div className="wx-m-head-icon"><BookmarkIcon width="18" height="18" /></div>
          <div className="wx-m-head-text">
            <div className="wx-m-head-title" style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              <span>{article.title}</span>
              {(article.version_label || (article.version || 1) > 1) && (
                <span style={{
                  fontSize: 11, padding: '2px 7px', borderRadius: 6,
                  background: 'color-mix(in srgb, var(--accent) 20%, transparent)',
                  color: 'var(--accent)',
                }}>{article.version_label || `v${article.version}`}</span>
              )}
              {article.requires_ack && (
                <span style={{
                  fontSize: 10, padding: '2px 7px', borderRadius: 999,
                  fontWeight: 700,
                  background: 'color-mix(in srgb, var(--warning) 16%, transparent)',
                  color: 'var(--warning)',
                }}>Requires acknowledgement</span>
              )}
            </div>
            <div className="wx-m-head-sub">{categoryLabel(article.category)} · updated {new Date(article.updated_at).toLocaleDateString()}</div>
          </div>
          <button type="button" className="wx-m-head-close" onClick={onClose} aria-label="Close">
            <XIcon width="14" height="14" />
          </button>
        </div>

        <div className="wx-m-body">
          {article.url && (
            <a href={article.url} target="_blank" rel="noreferrer"
              className="wx-btn wx-btn-ghost"
              style={{ alignSelf: 'flex-start', gap: 6 }}>
              <LinkIcon width="13" height="13" /> Open link
              <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>{new URL(article.url).hostname}</span>
            </a>
          )}
          {video && (
            <div style={{ position: 'relative', paddingBottom: '56.25%', height: 0, borderRadius: 10, overflow: 'hidden', background: '#000' }}>
              {video.kind === 'direct'
                ? <video src={video.embed} controls style={{ position: 'absolute', inset: 0, width: '100%', height: '100%' }} />
                : <iframe src={video.embed} allowFullScreen style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', border: 0 }} />
              }
            </div>
          )}
          {article.body && (
            <div style={{ whiteSpace: 'pre-wrap', fontSize: 13.5, lineHeight: 1.6, color: 'var(--text-primary)' }}>
              {article.body}
            </div>
          )}
          {(article.tags || []).length > 0 && (
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              {article.tags.map((t) => (
                <span key={t} style={{
                  fontSize: 11, padding: '2px 7px', borderRadius: 'var(--radius-pill)',
                  background: 'var(--accent-soft)', color: 'var(--accent)', fontWeight: 600,
                }}>#{t}</span>
              ))}
            </div>
          )}

          {/* Version history (if multi-version) */}
          {(article.version || 1) > 1 || versions.length > 1 ? (
            <div>
              <button type="button" className="wx-btn wx-btn-ghost"
                onClick={loadVersions} style={{ alignSelf: 'flex-start' }}>
                <ClockIcon width="13" height="13" /> {showVersions ? 'Hide' : 'Show'} version history
              </button>
              {showVersions && (
                <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 6 }}>
                  {versions.map((v) => (
                    <div key={v.id} style={{
                      padding: '8px 10px', border: '1px solid var(--border-subtle)',
                      borderRadius: 8, background: 'var(--surface-1)',
                      display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                    }}>
                      <div>
                        <span style={{ fontWeight: 700 }}>v{v.version}</span>
                        {' · '}
                        <span style={{ color: 'var(--text-muted)' }}>{new Date(v.updated_at).toLocaleString()}</span>
                      </div>
                      <span style={{
                        fontSize: 10, padding: '1px 6px', borderRadius: 4,
                        background: v.approval_status === 'approved' ? 'var(--accent-soft)' : 'var(--surface-2)',
                        color: v.approval_status === 'approved' ? 'var(--accent)' : 'var(--text-muted)',
                        fontWeight: 700, letterSpacing: '0.04em', textTransform: 'uppercase',
                      }}>{v.approval_status}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          ) : null}

          {/* Comments */}
          <CommentsSection articleId={article.id} isBoss={isBoss} uid={uid} />
        </div>

        <div className="wx-m-foot">
          <div className="wx-m-kbd-hints">
            <kbd>Esc</kbd> close
          </div>
          <div className="wx-m-foot-actions">
            {isAdmin && (
              <button type="button" className="wx-btn wx-btn-ghost" onClick={onAckDashboard}>
                <UsersIcon width="14" height="14" /> Reads
              </button>
            )}
            {isAdmin && isSopCategory(article.category) && onNewVersion && (
              <button type="button" className="wx-btn wx-btn-ghost" onClick={onNewVersion}>
                <PlusIcon width="14" height="14" /> New version
              </button>
            )}
            {(isAdmin || article.created_by === uid) && (
              <button type="button" className="wx-btn wx-btn-ghost" onClick={onEdit}>
                <PencilIcon width="14" height="14" /> Edit
              </button>
            )}
            {article.requires_ack && (
              <button
                type="button"
                className={`wx-btn ${acked ? 'wx-btn-ghost' : 'wx-btn-primary'}`}
                onClick={toggleAck}
              >
                <CheckIcon width="14" height="14" />
                {acked ? 'Marked read' : 'Mark as read'}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// ============================================================
// Comments
// ============================================================
function CommentsSection({ articleId, isBoss, uid }) {
  const qc = useQueryClient();
  const [text, setText] = useState('');
  const { data: comments = [] } = useQuery({
    queryKey: ['kb', 'comments', articleId],
    queryFn: () => listComments(articleId),
  });

  async function submit(e) {
    e.preventDefault();
    if (!text.trim()) return;
    try {
      await addComment(articleId, text);
      setText('');
      qc.invalidateQueries({ queryKey: ['kb', 'comments', articleId] });
    } catch (e) { alert(e.message); }
  }

  return (
    <div style={{ borderTop: '1px solid var(--border-subtle)', paddingTop: 14, marginTop: 4 }}>
      <div style={{ fontWeight: 700, fontSize: 13, display: 'flex', alignItems: 'center', gap: 6, marginBottom: 10 }}>
        <MessageIcon width="14" height="14" /> Comments
        {comments.length > 0 && <span style={{ color: 'var(--text-muted)', fontWeight: 500 }}>({comments.length})</span>}
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {comments.map((c) => (
          <CommentRow key={c.id} c={c} isBoss={isBoss} uid={uid} articleId={articleId} />
        ))}
      </div>
      <form onSubmit={submit} style={{ marginTop: 10, display: 'flex', gap: 6 }}>
        <input
          className="wx-input" style={{ flex: 1 }}
          placeholder="Write a comment…"
          value={text} onChange={(e) => setText(e.target.value)}
        />
        <button className="wx-btn wx-btn-primary" type="submit" disabled={!text.trim()}>Post</button>
      </form>
    </div>
  );
}

function CommentRow({ c, isBoss, uid, articleId }) {
  const [replying, setReplying] = useState(false);
  const [reply, setReply] = useState(c.boss_reply || '');
  const qc = useQueryClient();

  async function sendReply() {
    try {
      await replyToComment(c.id, reply);
      setReplying(false);
      qc.invalidateQueries({ queryKey: ['kb', 'comments', articleId] });
    } catch (e) { alert(e.message); }
  }

  return (
    <div style={{
      padding: 10, border: '1px solid var(--border-subtle)', borderRadius: 8,
      background: 'var(--surface-1)',
    }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12 }}>
        <span style={{ fontWeight: 700 }}>{c.author?.display_name || 'Someone'}</span>
        <span style={{ color: 'var(--text-muted)' }}>{new Date(c.created_at).toLocaleString()}</span>
      </div>
      <div style={{ fontSize: 13, marginTop: 4, whiteSpace: 'pre-wrap' }}>{c.body}</div>
      {c.boss_reply && (
        <div style={{
          marginTop: 8, padding: 8, background: 'var(--accent-soft)',
          borderRadius: 6, fontSize: 12.5,
        }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--accent)', marginBottom: 2 }}>
            Boss reply · {new Date(c.boss_reply_at).toLocaleDateString()}
          </div>
          <div style={{ whiteSpace: 'pre-wrap' }}>{c.boss_reply}</div>
        </div>
      )}
      {isBoss && !c.boss_reply && !replying && (
        <button
          className="wx-btn wx-btn-ghost"
          style={{ marginTop: 6, fontSize: 11 }}
          onClick={() => setReplying(true)}
        >Reply as Boss</button>
      )}
      {isBoss && replying && (
        <div style={{ marginTop: 6, display: 'flex', gap: 6 }}>
          <input
            className="wx-input" style={{ flex: 1 }}
            placeholder="Write a reply…"
            value={reply} onChange={(e) => setReply(e.target.value)}
          />
          <button className="wx-btn wx-btn-primary" onClick={sendReply} disabled={!reply.trim()}>Send</button>
          <button className="wx-btn wx-btn-ghost" onClick={() => setReplying(false)}>Cancel</button>
        </div>
      )}
    </div>
  );
}

// ============================================================
// Article form modal — flat v1-style single-page editor.
// Replaces the v2 multi-step wizard. Same sections, but everything
// scrolls in one column so creators don't lose context, and the
// SOP "Version label" field appears the moment a SOP category is
// chosen. New-version flow is triggered by the parent page setting
// `article.__newVersion = true` and inheriting sop_group_id.
// ============================================================
function ArticleFormModal({ article, uid, isBoss, isAdmin, onClose, onSaved }) {
  const isNewVersion = !!article.__newVersion;
  const isNew = !article.id || isNewVersion;
  const inheritedTitle = isNewVersion ? (article.title || '') : (article.title || '');

  const [title, setTitle]       = useState(inheritedTitle);
  const [url, setUrl]           = useState(isNewVersion ? '' : (article.url || ''));
  const [description, setDesc]  = useState('');
  const [body, setBody]         = useState(isNewVersion ? '' : (article.body || ''));
  const [category, setCategory] = useState(article.category || 'operational_sops');
  const [versionLabel, setVersionLabel] = useState(isNewVersion ? '' : (article.version_label || ''));
  const [tagsText, setTags]     = useState(isNewVersion ? '' : ((article.tags || []).join(', ')));
  const [visibility, setVis]    = useState(article.visibility || 'office');
  const [roles, setRoles]       = useState(article.visible_to_roles || []);
  const [userIds, setUserIds]   = useState(article.visible_to_users || []);
  const [requiresAck, setAck]   = useState(!!article.requires_ack);
  const [users, setUsers]       = useState([]);
  const [userSearch, setUserSearch] = useState('');
  const [saving, setSaving]     = useState(false);
  const [err, setErr]           = useState('');

  // Load full user list once visibility=='users' is selected.
  useEffect(() => {
    if (visibility === 'users' && users.length === 0) {
      supabase.from('profiles')
        .select('id, display_name, email, role')
        .eq('is_active', true).order('display_name')
        .then(({ data }) => setUsers(data || []));
    }
  }, [visibility, users.length]);

  const filteredUsers = useMemo(() => {
    if (!userSearch.trim()) return users;
    const q = userSearch.toLowerCase();
    return users.filter((u) =>
      (u.display_name || '').toLowerCase().includes(q) ||
      (u.email || '').toLowerCase().includes(q)
    );
  }, [users, userSearch]);

  const isSop = isSopCategory(category);
  const canSave = title.trim()
    && (!isSop || versionLabel.trim() || isNewVersion === false && !!article.id) // SOPs require label on create/new-version
    && (visibility !== 'role'  || roles.length > 0)
    && (visibility !== 'users' || userIds.length > 0);

  // Validation message for the save button tooltip.
  const validationHint = !title.trim() ? 'Title is required.'
    : (isSop && (isNew || isNewVersion) && !versionLabel.trim()) ? 'SOPs require a version label (e.g. v1.0).'
    : (visibility === 'role'  && roles.length === 0)   ? 'Pick at least one role.'
    : (visibility === 'users' && userIds.length === 0) ? 'Pick at least one user.'
    : '';

  async function submit() {
    if (validationHint) { setErr(validationHint); return; }
    setErr(''); setSaving(true);
    try {
      const tags = tagsText.split(',').map((s) => s.trim()).filter(Boolean);
      if (isNew) {
        await proposeArticle({
          title, body, url: url || null, description,
          category, tags, visibility,
          visibleToRoles: visibility === 'role'  ? roles   : [],
          visibleToUsers: visibility === 'users' ? userIds : [],
          requiresAck,
          sopGroupId: isNewVersion ? article.sop_group_id : null,
          // Boss is the approval queue — their posts always go live.
          autoApprove: isBoss,
          versionLabel: isSop ? versionLabel : null,
        });
      } else {
        // Direct edit (author-owner or admin).
        const { error } = await supabase.from('kb_articles').update({
          title,
          body,
          url: url || null,
          category,
          tags,
          visibility,
          visible_to_roles: visibility === 'role'  ? roles   : [],
          visible_to_users: visibility === 'users' ? userIds : [],
          requires_ack: requiresAck,
          version_label:  isSop ? (versionLabel || null) : null,
          updated_at: new Date().toISOString(),
        }).eq('id', article.id);
        if (error) throw error;
      }
      onSaved();
    } catch (e) { setErr(e.message); }
    finally { setSaving(false); }
  }

  // Esc to close, ⌘/Ctrl+Enter to submit.
  useEffect(() => {
    function onKey(e) {
      if (e.key === 'Escape') onClose();
      else if ((e.metaKey || e.ctrlKey) && e.key === 'Enter' && !saving) submit();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [title, url, body, category, versionLabel, tagsText, visibility, roles, userIds, requiresAck, saving]);

  const headerTitle = isNewVersion ? `New version of "${article.title}"`
                    : !article.id   ? (isBoss ? 'Add document' : 'Propose document')
                    : 'Edit document';

  return (
    <div className="wx-modal-backdrop wx-m-backdrop" onClick={onClose}>
      <div className="wx-modal" style={{ maxWidth: 620 }} onClick={(e) => e.stopPropagation()}>
        {/* Header */}
        <div className="wx-m-head">
          <div className="wx-m-head-icon"><BookmarkIcon width="18" height="18" /></div>
          <div className="wx-m-head-text">
            <div className="wx-m-head-title">{headerTitle}</div>
            <div className="wx-m-head-sub">
              {isNewVersion
                ? 'Inherit visibility from the parent SOP. Bump the version label and update the link.'
                : 'Share an SOP, policy, or reference with your team.'}
            </div>
          </div>
          <button type="button" className="wx-m-head-close" onClick={onClose}><XIcon width="14" height="14" /></button>
        </div>

        {/* Body — flat, no stepper */}
        <div className="wx-m-body">
          {err && (
            <div className="wx-alert wx-alert-danger">
              <AlertIcon width="14" height="14" /> <span>{err}</span>
            </div>
          )}

          {/* Title */}
          <div className="wx-m-field">
            <div className="wx-m-field-head">
              <div className="wx-m-field-label">Title</div>
              <div className="wx-m-field-meta is-required">Required</div>
            </div>
            <input className="wx-m-input" value={title} onChange={(e) => setTitle(e.target.value)}
              placeholder="Document title" disabled={isNewVersion} autoFocus />
            {isNewVersion && (
              <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4 }}>
                The title carries over from the parent SOP and can't be changed on a version bump.
              </div>
            )}
          </div>

          {/* URL */}
          <div className="wx-m-field">
            <div className="wx-m-field-head">
              <div className="wx-m-field-label">Link / URL</div>
              <div className="wx-m-field-meta is-required">Required</div>
            </div>
            <input className="wx-m-input" type="url" value={url} onChange={(e) => setUrl(e.target.value)}
              placeholder="https://docs.google.com/…" />
          </div>

          {/* Description */}
          <div className="wx-m-field">
            <div className="wx-m-field-head">
              <div className="wx-m-field-label">Description</div>
              <div className="wx-m-field-meta">Optional</div>
            </div>
            <textarea className="wx-m-input" rows={2} value={description}
              onChange={(e) => setDesc(e.target.value)}
              placeholder="Brief description shown above the body…" />
          </div>

          {/* Body (long-form) */}
          <div className="wx-m-field">
            <div className="wx-m-field-head">
              <div className="wx-m-field-label">Body</div>
              <div className="wx-m-field-meta">Optional — markdown-style</div>
            </div>
            <div className="wx-m-textarea-shell">
              <textarea rows={5} value={body}
                onChange={(e) => setBody(e.target.value)}
                placeholder="Write the full content here, or paste a summary if you only have a link above." />
              <div className="wx-m-char-count">{body.length}</div>
            </div>
          </div>

          {/* Category — pill chips, v1 style */}
          <div className="wx-m-field">
            <div className="wx-m-field-head">
              <div className="wx-m-field-label">Category</div>
              <div className="wx-m-field-meta">Pick a tab</div>
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
              {KB_CATEGORIES.map((c) => (
                <button type="button" key={c.value}
                  disabled={isNewVersion}
                  className={`wx-role-chip ${category === c.value ? 'wx-role-chip-active' : ''}`}
                  onClick={() => setCategory(c.value)}>
                  {c.label}
                </button>
              ))}
            </div>
          </div>

          {/* SOP Version label — only when category is SOP */}
          {isSop && (
            <div className="wx-m-field">
              <div className="wx-m-field-head">
                <div className="wx-m-field-label">SOP Version</div>
                <div className="wx-m-field-meta is-required">Required</div>
              </div>
              <input className="wx-m-input" value={versionLabel}
                onChange={(e) => setVersionLabel(e.target.value)}
                placeholder="e.g. v1.0, Q1 2026, 2026-04 update" />
              <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4 }}>
                {isNewVersion
                  ? 'This becomes the active version for everyone in the visibility list.'
                  : 'Used to label this SOP. Subsequent versions inherit visibility but bump the label.'}
              </div>
            </div>
          )}

          {/* Tags */}
          <div className="wx-m-field">
            <div className="wx-m-field-head">
              <div className="wx-m-field-label">Tags</div>
              <div className="wx-m-field-meta">Comma-separated</div>
            </div>
            <input className="wx-m-input" value={tagsText}
              onChange={(e) => setTags(e.target.value)}
              placeholder="e.g. reporting, weekly, brand" />
          </div>

          {/* Visibility — pill chips */}
          <div className="wx-m-field">
            <div className="wx-m-field-head">
              <div className="wx-m-field-label">Visible to</div>
              <div className="wx-m-field-meta">
                {visibility === 'private' ? 'Only you'
                  : visibility === 'office' ? 'Everyone in the workspace'
                  : visibility === 'role'   ? `${roles.length} role${roles.length === 1 ? '' : 's'}`
                  : `${userIds.length} user${userIds.length === 1 ? '' : 's'}`}
              </div>
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 8 }}>
              {KB_VISIBILITIES.map((v) => (
                <button key={v.value} type="button"
                  className={`wx-role-chip ${visibility === v.value ? 'wx-role-chip-active' : ''}`}
                  onClick={() => setVis(v.value)}
                  disabled={isNewVersion}>
                  {v.label}
                </button>
              ))}
            </div>

            {visibility === 'role' && (
              <div style={{
                background: 'var(--surface-2)', border: '1px solid var(--border-subtle)',
                borderRadius: 'var(--radius-md)', padding: 10,
              }}>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                  {['boss','ol','tl','pctl','apc','ipc','developer'].map((r) => (
                    <button key={r} type="button"
                      disabled={isNewVersion}
                      className={`wx-role-chip ${roles.includes(r) ? 'wx-role-chip-active' : ''}`}
                      onClick={() => setRoles((cur) =>
                        cur.includes(r) ? cur.filter((x) => x !== r) : [...cur, r])}>
                      {r.toUpperCase()}
                    </button>
                  ))}
                </div>
                <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 6 }}>
                  All users with the selected role(s) will see this document.
                </div>
              </div>
            )}

            {visibility === 'users' && (
              <div style={{
                background: 'var(--surface-2)', border: '1px solid var(--border-subtle)',
                borderRadius: 'var(--radius-md)', padding: 10,
              }}>
                <div className="wx-m-input-shell" style={{ marginBottom: 8 }}>
                  <input value={userSearch}
                    onChange={(e) => setUserSearch(e.target.value)}
                    placeholder="Search users…"
                    disabled={isNewVersion} />
                </div>
                {userIds.length > 0 && (
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginBottom: 8 }}>
                    {userIds.map((id) => {
                      const u = users.find((x) => x.id === id);
                      return (
                        <span key={id} style={{
                          display: 'inline-flex', alignItems: 'center', gap: 4,
                          padding: '2px 8px', borderRadius: 999,
                          background: 'var(--accent-soft)', color: 'var(--accent)',
                          fontSize: 11.5, fontWeight: 600,
                        }}>
                          {u ? u.display_name : id}
                          {!isNewVersion && (
                            <button type="button" onClick={() => setUserIds((cur) => cur.filter((x) => x !== id))}
                              style={{ border: 0, background: 'transparent', color: 'var(--accent)', cursor: 'pointer', padding: 0, fontSize: 11 }}>
                              ✕
                            </button>
                          )}
                        </span>
                      );
                    })}
                  </div>
                )}
                <div style={{ maxHeight: 180, overflow: 'auto', display: 'flex', flexDirection: 'column', gap: 4 }}>
                  {filteredUsers.map((u) => {
                    const on = userIds.includes(u.id);
                    return (
                      <label key={u.id} style={{
                        display: 'flex', alignItems: 'center', gap: 8, padding: '6px 8px',
                        borderRadius: 6, cursor: isNewVersion ? 'not-allowed' : 'pointer',
                        background: on ? 'var(--accent-soft)' : 'var(--surface-1)',
                        border: `1px solid ${on ? 'color-mix(in srgb, var(--accent) 40%, transparent)' : 'var(--border-subtle)'}`,
                        opacity: isNewVersion ? 0.6 : 1,
                      }}>
                        <input type="checkbox" checked={on} disabled={isNewVersion}
                          onChange={() => setUserIds((cur) => on ? cur.filter((x) => x !== u.id) : [...cur, u.id])} />
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ fontSize: 13, fontWeight: 600 }}>{u.display_name}</div>
                          <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>{u.email} · {u.role}</div>
                        </div>
                      </label>
                    );
                  })}
                </div>
              </div>
            )}

            {isNewVersion && (
              <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 6 }}>
                Visibility is locked to the parent SOP for new versions.
              </div>
            )}
          </div>

          {/* Requires acknowledgement */}
          <label className={`wx-m-optin ${requiresAck ? 'is-active' : ''}`}>
            <input type="checkbox" checked={requiresAck}
              onChange={(e) => setAck(e.target.checked)} />
            <div>
              <div className="wx-m-optin-title">Require acknowledgement</div>
              <div className="wx-m-optin-sub">
                Users must explicitly "mark as read". Admins see a dashboard of who has/hasn't read it.
              </div>
            </div>
          </label>

          {/* Boss is the approval queue, so their posts always go live
              immediately — no toggle needed. Non-Boss authors see the
              review-routing notice instead. */}
          {!isBoss && isNew && !isNewVersion && (
            <div className="wx-alert" style={{
              background: 'color-mix(in srgb, var(--accent) 10%, var(--surface-1))',
              border: '1px solid color-mix(in srgb, var(--accent) 30%, var(--border-subtle))',
              color: 'var(--text-primary)',
            }}>
              This will be submitted for Boss approval before going live.
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="wx-m-foot">
          <div className="wx-m-kbd-hints">
            <kbd>Esc</kbd> cancel <span>·</span> <kbd>⌘</kbd><kbd>↵</kbd> submit
          </div>
          <div className="wx-m-foot-actions">
            <button type="button" className="wx-btn wx-btn-ghost" onClick={onClose} disabled={saving}>
              Cancel
            </button>
            <button type="button" className="wx-btn wx-btn-primary" onClick={submit}
              disabled={saving || !canSave}
              title={canSave ? '' : validationHint}>
              {saving
                ? <><span className="wx-spinner" /> Saving…</>
                : <><CheckIcon width="14" height="14" /> {
                    isNewVersion       ? 'Save new version'
                    : !article.id      ? (isBoss && autoApprove ? 'Publish' : 'Submit')
                    : 'Save'
                  }</>}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ============================================================
// Pending queue (Boss)
// ============================================================
function PendingQueueModal({ items, onClose, onDecided }) {
  const [decidingId, setDeciding] = useState(null);
  const [reason, setReason]       = useState('');
  const [err, setErr]             = useState('');

  async function act(id, approve) {
    setErr('');
    try {
      if (approve) await approveArticle(id);
      else         await rejectArticle(id, reason || null);
      setDeciding(null); setReason('');
      onDecided();
    } catch (e) { setErr(e.message); }
  }

  return (
    <div className="wx-modal-backdrop wx-m-backdrop" onClick={onClose}>
      <div className="wx-modal" style={{ maxWidth: 720 }} onClick={(e) => e.stopPropagation()}>
        <div className="wx-m-head">
          <div className="wx-m-head-icon"><ShieldIcon width="18" height="18" /></div>
          <div className="wx-m-head-text">
            <div className="wx-m-head-title">Pending submissions</div>
            <div className="wx-m-head-sub">Review and approve articles proposed by the team.</div>
          </div>
          <button type="button" className="wx-m-head-close" onClick={onClose}><XIcon width="14" height="14" /></button>
        </div>
        <div className="wx-m-body">
          {err && <div className="wx-alert wx-alert-danger"><AlertIcon width="14" height="14" /> <span>{err}</span></div>}
          {items.length === 0 ? (
            <div style={{ textAlign: 'center', color: 'var(--text-muted)', padding: 20 }}>
              No pending submissions.
            </div>
          ) : items.map((it) => (
            <div key={it.id} style={{
              border: '1px solid var(--border-subtle)', borderRadius: 10,
              padding: 12, background: 'var(--surface-1)',
              display: 'flex', flexDirection: 'column', gap: 8,
            }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 10 }}>
                <div>
                  <div style={{ fontWeight: 700, fontSize: 14 }}>{it.title}</div>
                  <div style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>
                    {categoryLabel(it.category)} · by {it.submitter?.display_name || '—'} · {new Date(it.submitted_at).toLocaleDateString()}
                  </div>
                </div>
                {decidingId !== it.id && (
                  <div style={{ display: 'flex', gap: 6 }}>
                    <button className="wx-btn wx-btn-primary" onClick={() => act(it.id, true)}>
                      <CheckIcon width="13" height="13" /> Approve
                    </button>
                    <button className="wx-btn wx-btn-ghost" onClick={() => setDeciding(it.id)}>
                      <XIcon width="13" height="13" /> Reject
                    </button>
                  </div>
                )}
              </div>
              {it.body && (
                <div style={{
                  fontSize: 12.5, color: 'var(--text-secondary)',
                  whiteSpace: 'pre-wrap', maxHeight: 90, overflow: 'hidden',
                }}>{it.body}</div>
              )}
              {it.url && (
                <a href={it.url} target="_blank" rel="noreferrer"
                  style={{ fontSize: 12, color: 'var(--accent)' }}>{it.url}</a>
              )}
              {decidingId === it.id && (
                <div style={{ display: 'flex', gap: 6, marginTop: 4 }}>
                  <input className="wx-input" style={{ flex: 1 }}
                    placeholder="Reason (optional)"
                    value={reason} onChange={(e) => setReason(e.target.value)} />
                  <button className="wx-btn wx-btn-primary" onClick={() => act(it.id, false)}>Confirm reject</button>
                  <button className="wx-btn wx-btn-ghost" onClick={() => { setDeciding(null); setReason(''); }}>Cancel</button>
                </div>
              )}
            </div>
          ))}
        </div>
        <div className="wx-m-foot">
          <div className="wx-m-kbd-hints"><kbd>Esc</kbd> close</div>
          <div className="wx-m-foot-actions">
            <button className="wx-btn wx-btn-ghost" onClick={onClose}>Done</button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ============================================================
// Ack dashboard
// ============================================================
function AckDashboardModal({ article, onClose }) {
  const { data = [], isLoading } = useQuery({
    queryKey: ['kb', 'ack-dashboard', article.id],
    queryFn: () => ackDashboard(article.id),
  });
  const totalUsers = data.length;
  const readUsers  = data.filter((u) => u.read_at).length;
  const pct = totalUsers ? Math.round((readUsers / totalUsers) * 100) : 0;

  return (
    <div className="wx-modal-backdrop wx-m-backdrop" onClick={onClose}>
      <div className="wx-modal" style={{ maxWidth: 560 }} onClick={(e) => e.stopPropagation()}>
        <div className="wx-m-head">
          <div className="wx-m-head-icon"><UsersIcon width="18" height="18" /></div>
          <div className="wx-m-head-text">
            <div className="wx-m-head-title">Reads · {article.title}</div>
            <div className="wx-m-head-sub">{readUsers} of {totalUsers} ({pct}%)</div>
          </div>
          <button type="button" className="wx-m-head-close" onClick={onClose}><XIcon width="14" height="14" /></button>
        </div>
        <div className="wx-m-body">
          <div style={{ height: 8, borderRadius: 999, background: 'var(--surface-2)', overflow: 'hidden' }}>
            <div style={{ height: '100%', width: `${pct}%`, background: 'var(--accent)', transition: 'width 300ms' }} />
          </div>
          {isLoading ? (
            <div className="wx-empty"><span className="wx-spinner" /> Loading…</div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {data.map((u) => (
                <div key={u.user_id} style={{
                  display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                  padding: '8px 12px', borderRadius: 8, border: '1px solid var(--border-subtle)',
                  background: u.read_at ? 'color-mix(in srgb, var(--success) 8%, var(--surface-1))' : 'var(--surface-1)',
                }}>
                  <div>
                    <div style={{ fontSize: 13, fontWeight: 600 }}>{u.display_name}</div>
                    <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>{u.role}</div>
                  </div>
                  <div style={{ fontSize: 11, color: u.read_at ? 'var(--success)' : 'var(--text-muted)' }}>
                    {u.read_at
                      ? `Read · ${new Date(u.read_at).toLocaleDateString()}`
                      : 'Unread'}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
