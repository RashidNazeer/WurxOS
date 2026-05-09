import { useEffect, useRef, useState } from 'react';
import { useAuth } from '../../contexts/AuthContext';
import {
  listTaskComments, addTaskComment, deleteTaskComment, subscribeToTaskComments,
} from '../../lib/taskCommentsApi';
import { AlertIcon, XIcon } from '../common/Icon';

export default function TaskCommentsPanel({ taskId }) {
  const { user, profile } = useAuth();
  const isBoss = profile?.role === 'boss';

  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [body, setBody] = useState('');
  const [posting, setPosting] = useState(false);
  const [err, setErr] = useState('');
  const endRef = useRef(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    listTaskComments(taskId)
      .then((list) => { if (!cancelled) setItems(list); })
      .catch((e) => { if (!cancelled) setErr(e.message); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [taskId]);

  useEffect(() => {
    return subscribeToTaskComments(taskId, async (payload) => {
      if (payload.eventType === 'DELETE') {
        setItems((cur) => cur.filter((c) => c.id !== payload.old.id));
        return;
      }
      if (payload.eventType === 'INSERT') {
        // Fetch the joined author name the row arrives without it.
        try {
          const fresh = await listTaskComments(taskId);
          setItems(fresh);
        } catch {}
      }
    });
  }, [taskId]);

  // Auto-scroll to latest
  useEffect(() => { endRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [items.length]);

  async function submit(e) {
    e.preventDefault();
    if (!body.trim() || posting) return;
    setErr(''); setPosting(true);
    try {
      const row = await addTaskComment(taskId, body);
      setItems((cur) => cur.some((c) => c.id === row.id) ? cur : [...cur, row]);
      setBody('');
    } catch (e) { setErr(e.message); }
    finally { setPosting(false); }
  }

  async function handleDelete(id) {
    if (!confirm('Delete this comment?')) return;
    try { await deleteTaskComment(id); setItems((cur) => cur.filter((c) => c.id !== id)); }
    catch (e) { setErr(e.message); }
  }

  return (
    <div style={{
      marginTop: 14, paddingTop: 14,
      borderTop: '1px solid var(--border-subtle)',
    }}>
      <div style={{
        fontSize: 11.5, fontWeight: 700, color: 'var(--text-muted)',
        textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 10,
      }}>
        Comments {items.length > 0 && <span style={{ color: 'var(--text-secondary)' }}>· {items.length}</span>}
      </div>

      {err && (
        <div className="wx-alert wx-alert-danger" style={{ marginBottom: 10 }}>
          <AlertIcon width="14" height="14" /> <span>{err}</span>
        </div>
      )}

      <div style={{
        maxHeight: 260, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 8,
        padding: '4px 2px', marginBottom: 10,
      }}>
        {loading ? (
          <div style={{ color: 'var(--text-muted)', fontSize: 13 }}><span className="wx-spinner" /> Loading…</div>
        ) : items.length === 0 ? (
          <div style={{
            border: '1px dashed var(--border-default)', padding: '12px 14px',
            borderRadius: 'var(--radius-md)', color: 'var(--text-muted)',
            fontSize: 13, textAlign: 'center',
          }}>
            No comments yet. Start the thread.
          </div>
        ) : (
          items.map((c) => (
            <CommentBubble
              key={c.id}
              comment={c}
              mine={c.author_id === user?.id}
              canDelete={c.author_id === user?.id || isBoss}
              onDelete={() => handleDelete(c.id)}
            />
          ))
        )}
        <div ref={endRef} />
      </div>

      <form onSubmit={submit} style={{ display: 'flex', gap: 6 }}>
        <input
          className="wx-input"
          placeholder="Write a comment…"
          value={body}
          onChange={(e) => setBody(e.target.value)}
          disabled={posting}
          style={{ flex: 1 }}
        />
        <button type="submit" className="wx-btn wx-btn-primary" disabled={posting || !body.trim()}>
          {posting ? <span className="wx-spinner" /> : 'Post'}
        </button>
      </form>
    </div>
  );
}

function CommentBubble({ comment, mine, canDelete, onDelete }) {
  return (
    <div style={{
      alignSelf: mine ? 'flex-end' : 'flex-start',
      maxWidth: '85%',
      background: mine ? 'var(--accent-soft)' : 'var(--surface-2)',
      border: `1px solid ${mine ? 'color-mix(in srgb, var(--accent) 30%, transparent)' : 'var(--border-subtle)'}`,
      padding: '8px 10px',
      borderRadius: 'var(--radius-md)',
      position: 'relative',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 3 }}>
        <span style={{ fontWeight: 700, fontSize: 12, color: mine ? 'var(--accent)' : 'var(--text-primary)' }}>
          {comment.author?.display_name || '—'}
        </span>
        <span style={{ fontSize: 10.5, color: 'var(--text-muted)' }}>
          {timeAgo(comment.created_at)}
        </span>
        {canDelete && (
          <button
            onClick={onDelete}
            title="Delete"
            style={{
              marginLeft: 'auto', border: 0, background: 'transparent',
              color: 'var(--text-muted)', cursor: 'pointer', padding: 2,
            }}
          >
            <XIcon width="11" height="11" />
          </button>
        )}
      </div>
      <div style={{ fontSize: 13, color: 'var(--text-primary)', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
        {comment.body}
      </div>
    </div>
  );
}

function timeAgo(iso) {
  const d = new Date(iso);
  const sec = Math.floor((Date.now() - d.getTime()) / 1000);
  if (sec < 60)   return 'just now';
  if (sec < 3600) return `${Math.floor(sec / 60)}m`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}h`;
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}
