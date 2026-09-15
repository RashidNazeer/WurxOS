// The task thread: comments, one level of replies, @mentions, files, editing
// and deleting your own words. New comments from others arrive live.
import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useDev, WORKSPACE_KEY } from '../../pages/development/DevelopmentContext';
import { addComment, deleteComment, editComment, listComments, uploadFile } from '../../lib/developmentApi';
import MentionInput, { keptMentions, withMentions } from './MentionInput';
import { FileTile, useTaskFiles } from './TaskFiles';
import { Avatar, Spinner } from './ui';
import { exactTime, timeAgo } from './devModel';

export default function TaskThread({ task, highlightId }) {
  const qc = useQueryClient();
  const { maps, profile, isBoss, notify, confirm } = useDev();
  const comments = useQuery({
    queryKey: ['development', 'comments', task.id],
    queryFn: () => listComments(task.id),
    staleTime: 10_000,
  });
  const files = useTaskFiles(task.id);
  const [replyTo, setReplyTo] = useState(null);

  const rows = comments.data || [];
  const top = rows.filter((c) => !c.parent_id);
  const replies = useMemo(() => {
    const map = new Map();
    for (const c of rows) {
      if (!c.parent_id) continue;
      if (!map.has(c.parent_id)) map.set(c.parent_id, []);
      map.get(c.parent_id).push(c);
    }
    return map;
  }, [rows]);
  const filesByComment = useMemo(() => {
    const map = new Map();
    for (const f of files.data || []) {
      if (!f.comment_id) continue;
      if (!map.has(f.comment_id)) map.set(f.comment_id, []);
      map.get(f.comment_id).push(f);
    }
    return map;
  }, [files.data]);

  const sync = () => {
    qc.invalidateQueries({ queryKey: ['development', 'comments', task.id] });
    qc.invalidateQueries({ queryKey: ['development', 'files', task.id] });
    qc.invalidateQueries({ queryKey: WORKSPACE_KEY });
  };

  // Opened from a notification: bring that comment into view once.
  const scrolled = useRef(false);
  useEffect(() => {
    if (!highlightId || scrolled.current || !comments.data) return;
    const el = document.getElementById(`dv-comment-${highlightId}`);
    if (el) {
      scrolled.current = true;
      el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }
  }, [highlightId, comments.data]);

  async function remove(comment) {
    const yes = await confirm({
      title: 'Delete this comment?',
      body: 'Its place in the thread stays, with the text removed.',
      confirmLabel: 'Delete comment',
      danger: true,
    });
    if (!yes) return;
    try {
      await deleteComment(comment.id);
      sync();
    } catch (error) {
      notify(error.message, 'error');
    }
  }

  const renderComment = (comment, parentId) => (
    <Comment
      key={comment.id}
      comment={comment}
      author={maps.personById.get(comment.author_id)}
      personById={maps.personById}
      files={filesByComment.get(comment.id) || []}
      highlighted={comment.id === highlightId}
      canEdit={comment.author_id === profile?.id}
      canDelete={comment.author_id === profile?.id || isBoss}
      isBoss={isBoss}
      profileId={profile?.id}
      onReply={() => setReplyTo(parentId || comment.id)}
      onDelete={() => remove(comment)}
      onSaved={sync}
    />
  );

  return (
    <div className="dv-thread">
      {comments.isLoading ? (
        <div className="dv-loading is-inline"><Spinner /></div>
      ) : top.length === 0 ? (
        <p className="dv-muted dv-thread-empty">No comments yet. Start the conversation.</p>
      ) : (
        <ol className="dv-comments">
          {top.map((comment) => (
            <li key={comment.id} className="dv-comment-group">
              {renderComment(comment, null)}
              {(replies.get(comment.id)?.length > 0 || replyTo === comment.id) && (
                <ol className="dv-replies">
                  {(replies.get(comment.id) || []).map((reply) => (
                    <li key={reply.id}>{renderComment(reply, comment.id)}</li>
                  ))}
                  {replyTo === comment.id && (
                    <li>
                      <Composer
                        task={task}
                        parentId={comment.id}
                        autoFocus
                        placeholder="Write a reply…"
                        onCancel={() => setReplyTo(null)}
                        onPosted={() => { setReplyTo(null); sync(); }}
                      />
                    </li>
                  )}
                </ol>
              )}
            </li>
          ))}
        </ol>
      )}
      <Composer
        task={task}
        placeholder="Leave feedback or share an update. Type @ to mention someone."
        onPosted={sync}
      />
    </div>
  );
}

function Comment({
  comment, author, personById, files, highlighted, canEdit, canDelete, isBoss, profileId, onReply, onDelete, onSaved,
}) {
  const { data, notify } = useDev();
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(comment.body);
  const [mentions, setMentions] = useState(comment.mentions || []);
  const [saving, setSaving] = useState(false);
  const deleted = !!comment.deleted_at;

  async function save() {
    const body = text.trim();
    if (!body) return;
    setSaving(true);
    try {
      await editComment(comment.id, body, keptMentions(body, mentions, personById));
      setEditing(false);
      onSaved();
    } catch (error) {
      notify(error.message, 'error');
    } finally {
      setSaving(false);
    }
  }

  return (
    <article
      id={`dv-comment-${comment.id}`}
      className={`dv-comment${deleted ? ' is-deleted' : ''}${highlighted ? ' is-highlighted' : ''}`}
    >
      <Avatar person={author} size={28} />
      <div className="dv-comment-main">
        <header>
          <strong>{author?.display_name || 'Former member'}</strong>
          <time dateTime={comment.created_at} title={exactTime(comment.created_at)}>{timeAgo(comment.created_at)}</time>
          {comment.edited_at && !deleted && <span className="dv-muted" title={exactTime(comment.edited_at)}>· edited</span>}
        </header>
        {deleted ? (
          <p className="dv-comment-body is-deleted">This comment was deleted.</p>
        ) : editing ? (
          <div className="dv-composer is-edit">
            <MentionInput
              value={text}
              onChange={setText}
              people={data.people}
              onMention={(person) => setMentions((list) => (list.includes(person.id) ? list : [...list, person.id]))}
              onSubmit={save}
              label="Edit comment"
              autoFocus
            />
            <div className="dv-composer-foot">
              <span className="dv-hint">Ctrl + Enter to save</span>
              <button type="button" className="dv-btn is-ghost is-sm" onClick={() => { setEditing(false); setText(comment.body); }}>Cancel</button>
              <button type="button" className="dv-btn is-primary is-sm" onClick={save} disabled={saving || !text.trim()}>
                {saving ? 'Saving…' : 'Save'}
              </button>
            </div>
          </div>
        ) : (
          <p className="dv-comment-body">{withMentions(comment.body, comment.mentions, personById)}</p>
        )}
        {!deleted && files.length > 0 && (
          <div className="dv-file-grid is-compact">
            {files.map((file) => (
              <FileTile key={file.id} file={file} compact canRemove={false} />
            ))}
          </div>
        )}
        {!deleted && !editing && (
          <div className="dv-comment-actions">
            <button type="button" className="dv-link" onClick={onReply}>Reply</button>
            {canEdit && <button type="button" className="dv-link" onClick={() => setEditing(true)}>Edit</button>}
            {canDelete && <button type="button" className="dv-link is-danger" onClick={onDelete}>Delete</button>}
          </div>
        )}
      </div>
    </article>
  );
}

function Composer({ task, parentId = null, placeholder, autoFocus = false, onPosted, onCancel }) {
  const { data, maps, notify } = useDev();
  const [text, setText] = useState('');
  const [mentions, setMentions] = useState([]);
  const [pending, setPending] = useState([]);
  const [busy, setBusy] = useState(false);
  const picker = useRef(null);

  async function submit() {
    const body = text.trim();
    if (!body || busy) return;
    setBusy(true);
    try {
      const row = await addComment({
        taskId: task.id,
        parentId,
        body,
        mentions: keptMentions(body, mentions, maps.personById),
      });
      for (const file of pending) {
        try {
          await uploadFile({ taskId: task.id, commentId: row.id, file });
        } catch (error) {
          notify(`${file.name}: ${error.message}`, 'error');
        }
      }
      setText('');
      setMentions([]);
      setPending([]);
      onPosted?.();
    } catch (error) {
      notify(error.message, 'error');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      className={`dv-composer${parentId ? ' is-reply' : ''}`}
      onPaste={(event) => {
        const pasted = [...(event.clipboardData?.files || [])];
        if (!pasted.length) return;
        event.preventDefault();
        setPending((list) => [...list, ...pasted]);
      }}
    >
      <MentionInput
        value={text}
        onChange={setText}
        people={data.people}
        onMention={(person) => setMentions((list) => (list.includes(person.id) ? list : [...list, person.id]))}
        onSubmit={submit}
        placeholder={placeholder}
        autoFocus={autoFocus}
        label={parentId ? 'Reply' : 'Comment'}
        rows={parentId ? 2 : 3}
      />
      {pending.length > 0 && (
        <ul className="dv-pending-files">
          {pending.map((file, index) => (
            <li key={`${file.name}-${index}`}>
              <i className="bi bi-paperclip" aria-hidden="true" />
              <span>{file.name}</span>
              <button
                type="button"
                aria-label={`Remove ${file.name}`}
                onClick={() => setPending((list) => list.filter((_, i) => i !== index))}
              >
                <i className="bi bi-x" aria-hidden="true" />
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="dv-composer-foot">
        <button type="button" className="dv-icon-btn" onClick={() => picker.current?.click()} aria-label="Attach files" title="Attach files">
          <i className="bi bi-paperclip" aria-hidden="true" />
        </button>
        <input
          ref={picker}
          type="file"
          multiple
          hidden
          onChange={(event) => {
            const picked = [...event.target.files];
            event.target.value = '';
            setPending((list) => [...list, ...picked]);
          }}
        />
        <span className="dv-hint">Ctrl + Enter to send</span>
        {onCancel && <button type="button" className="dv-btn is-ghost is-sm" onClick={onCancel}>Cancel</button>}
        <button type="button" className="dv-btn is-primary is-sm" onClick={submit} disabled={busy || !text.trim()}>
          {busy ? 'Sending…' : parentId ? 'Reply' : 'Comment'}
        </button>
      </div>
    </div>
  );
}
