import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '../../contexts/AuthContext';
import {
  listBugs, submitBug, updateBug, deleteBug,
  listBugMessages, postBugMessage,
  BUG_TYPES, BUG_PRIORITIES, BUG_STATUSES,
  bugTypeMeta, bugPriorityMeta, bugStatusMeta,
} from '../../lib/bugsApi';
import {
  PlusIcon, AlertIcon, RefreshIcon, SearchIcon, XIcon, CheckIcon,
  BugIcon, MessageIcon, TrashIcon, MoreIcon,
} from '../../components/common/Icon';
import '../../styles/table.css';

// Role-aware single page:
//   * Any authenticated user: submit + see their own bugs + thread on their own
//   * Developer: see all + full edit/delete + thread on any
//   * Boss: see all read-only + thread
export default function BugsPage() {
  const { user, profile } = useAuth();
  const role = profile?.role;
  const isDev  = role === 'developer';
  const isBoss = role === 'boss';
  const isAdminView = isDev || isBoss;

  const [tab, setTab] = useState(isAdminView ? 'all' : 'mine');
  const [showForm, setShowForm] = useState(false);
  const [selected, setSelected] = useState(null);

  const [statusF, setStatusF]   = useState('all');
  const [typeF, setTypeF]       = useState('all');
  const [priorityF, setPriorityF] = useState('all');
  const [sort, setSort]         = useState('newest');
  const [q, setQ]               = useState('');

  const qc = useQueryClient();
  const { data: bugs = [], isPending, error, refetch, isFetching } = useQuery({
    queryKey: ['bugs', { statusF, typeF, priorityF, sort, q, tab, uid: user?.id }],
    queryFn: () => listBugs({ status: statusF, type: typeF, priority: priorityF, sort, q }),
    enabled: !!user?.id,
  });

  // Non-admin users only see their own — RLS already filters, but we
  // also filter client-side in the 'mine' tab for admin users.
  const rows = useMemo(() => {
    if (tab === 'mine' && user?.id) return bugs.filter((b) => b.reporter_id === user.id);
    return bugs;
  }, [bugs, tab, user]);

  const stats = useMemo(() => {
    const out = { total: rows.length };
    for (const s of BUG_STATUSES) out[s.key] = 0;
    for (const r of rows) out[r.status] = (out[r.status] || 0) + 1;
    return out;
  }, [rows]);

  return (
    <>
      <div className="page-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: 12 }}>
        <div>
          <h1 className="page-title">Bug Reports</h1>
          <p className="page-subtitle">Report broken behavior and track its fix.</p>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="wx-btn wx-btn-ghost" onClick={() => refetch()} title="Refresh">
            <RefreshIcon width="15" height="15" />
          </button>
          <button className="wx-btn wx-btn-primary" onClick={() => setShowForm(true)}>
            <PlusIcon width="15" height="15" /> Report a bug
          </button>
        </div>
      </div>

      {error && (
        <div className="wx-alert wx-alert-danger" style={{ marginBottom: 14 }}>
          <AlertIcon width="16" height="16" /> <span>{error.message}</span>
        </div>
      )}

      {isAdminView && (
        <div style={{ display: 'flex', gap: 6, marginBottom: 12, flexWrap: 'wrap' }}>
          {[
            { k: 'all', label: 'All bugs' },
            { k: 'mine', label: 'Reported by me' },
          ].map((t) => (
            <button key={t.k}
              className="wx-btn"
              onClick={() => setTab(t.k)}
              style={{
                background: tab === t.k ? 'var(--accent)' : 'transparent',
                color: tab === t.k ? 'var(--on-accent)' : 'var(--text-secondary)',
                border: tab === t.k ? 'none' : '1px solid var(--border-subtle)',
              }}>{t.label}</button>
          ))}
        </div>
      )}

      {isAdminView && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(130px, 100%), 1fr))', gap: 10, marginBottom: 14 }}>
          <StatCard label="Total"       value={stats.total}       tone="var(--text-primary)" />
          <StatCard label="Open"        value={stats.open}        tone="var(--info)" />
          <StatCard label="In Progress" value={stats.in_progress} tone="var(--warning)" />
          <StatCard label="Fixed"       value={stats.fixed}       tone="var(--success)" />
          <StatCard label="Closed"      value={stats.closed + stats.temp_closed} tone="var(--text-secondary)" />
          <StatCard label="Won't Fix"   value={stats.wont_fix}    tone="var(--danger)" />
        </div>
      )}

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 12 }}>
        <div style={{ position: 'relative', flex: '1 1 240px', maxWidth: 320 }}>
          <SearchIcon width="14" height="14" style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: 'var(--text-muted)' }} />
          <input className="wx-input" placeholder="Search title / description…"
            style={{ paddingLeft: 32 }}
            value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <select className="wx-input" style={{ maxWidth: 160 }} value={statusF} onChange={(e) => setStatusF(e.target.value)}>
          <option value="all">All statuses</option>
          {BUG_STATUSES.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
        </select>
        <select className="wx-input" style={{ maxWidth: 160 }} value={typeF} onChange={(e) => setTypeF(e.target.value)}>
          <option value="all">All types</option>
          {BUG_TYPES.map((t) => <option key={t.key} value={t.key}>{t.label}</option>)}
        </select>
        <select className="wx-input" style={{ maxWidth: 160 }} value={priorityF} onChange={(e) => setPriorityF(e.target.value)}>
          <option value="all">All priorities</option>
          {BUG_PRIORITIES.map((p) => <option key={p.key} value={p.key}>{p.label}</option>)}
        </select>
        <select className="wx-input" style={{ maxWidth: 160, marginLeft: 'auto' }} value={sort} onChange={(e) => setSort(e.target.value)}>
          <option value="newest">Newest</option>
          <option value="oldest">Oldest</option>
          <option value="priority">Priority first</option>
        </select>
      </div>

      {isPending || isFetching ? (
        <div style={{ padding: 30, textAlign: 'center', color: 'var(--text-muted)' }}>
          <span className="wx-spinner" /> Loading…
        </div>
      ) : rows.length === 0 ? (
        <div style={{ padding: 40, textAlign: 'center', color: 'var(--text-muted)', border: '1px dashed var(--border-subtle)', borderRadius: 10, background: 'var(--surface-1)' }}>
          <BugIcon width="28" height="28" />
          <div style={{ marginTop: 8, fontWeight: 600, color: 'var(--text-secondary)' }}>No bugs match.</div>
          <div style={{ marginTop: 2, fontSize: 13 }}>Report one with the button above.</div>
        </div>
      ) : (
        <div style={{ display: 'grid', gap: 10 }}>
          {rows.map((b) => (
            <BugCard key={b.id} bug={b}
              canEdit={isDev}
              canDelete={isDev || isBoss}
              onOpen={() => setSelected(b)} />
          ))}
        </div>
      )}

      {showForm && (
        <BugForm onClose={() => setShowForm(false)} onDone={() => {
          setShowForm(false);
          qc.invalidateQueries({ queryKey: ['bugs'] });
        }} />
      )}

      {selected && (
        <BugDetail bug={selected}
          canEdit={isDev}
          canDelete={isDev || isBoss}
          onClose={() => setSelected(null)}
          onChanged={() => qc.invalidateQueries({ queryKey: ['bugs'] })} />
      )}
    </>
  );
}

// ============================================================
// Card
// ============================================================
function BugCard({ bug, onOpen }) {
  const t = bugTypeMeta(bug.bug_type);
  const s = bugStatusMeta(bug.status);
  const p = bugPriorityMeta(bug.priority);
  return (
    <button onClick={onOpen} className="bug-card"
      style={{
        all: 'unset', cursor: 'pointer',
        display: 'grid', gridTemplateColumns: '1fr auto', gap: 12,
        padding: 14, borderRadius: 10, border: '1px solid var(--border-subtle)', background: 'var(--surface-1)',
      }}>
      <div style={{ minWidth: 0 }}>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 4 }}>
          <span style={{ color: t.color, display: 'inline-flex', alignItems: 'center' }}>
            <BugIcon width="15" height="15" />
          </span>
          <strong style={{ fontSize: 14, color: 'var(--text-primary)' }}>{bug.title}</strong>
          <span style={{ padding: '2px 8px', borderRadius: 999, fontSize: 11, fontWeight: 600, background: t.color + '22', color: t.color }}>
            {t.label}
          </span>
        </div>
        <div style={{ fontSize: 12, color: 'var(--text-secondary)', display: 'flex', gap: 10, flexWrap: 'wrap' }}>
          <span>{bug.reporter_name || '—'} {bug.reporter_role ? `· ${bug.reporter_role}` : ''}</span>
          <span>·</span>
          <span>{new Date(bug.created_at).toLocaleDateString()}</span>
        </div>
      </div>
      <div style={{ display: 'flex', gap: 6, alignSelf: 'center' }}>
        <Pill {...p} />
        <Pill {...s} />
      </div>
    </button>
  );
}

function Pill({ label, fg, bg }) {
  return (
    <span style={{ padding: '3px 10px', borderRadius: 999, fontSize: 11, fontWeight: 700, background: bg, color: fg, whiteSpace: 'nowrap' }}>
      {label}
    </span>
  );
}

function StatCard({ label, value, tone }) {
  return (
    <div style={{ padding: 12, borderRadius: 10, border: '1px solid var(--border-subtle)', background: 'var(--surface-1)' }}>
      <div style={{ fontSize: 11, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: 0.4 }}>{label}</div>
      <div style={{ fontSize: 22, fontWeight: 700, color: tone, marginTop: 2 }}>{value}</div>
    </div>
  );
}

// ============================================================
// Submit modal
// ============================================================
function BugForm({ onClose, onDone }) {
  const [bugType, setBugType]   = useState('');
  const [priority, setPriority] = useState('medium');
  const [title, setTitle]       = useState('');
  const [description, setDesc]  = useState('');
  const [busy, setBusy]         = useState(false);
  const [err, setErr]           = useState('');

  const ok = bugType && title.trim() && description.trim();

  async function save() {
    if (!ok || busy) return;
    setBusy(true); setErr('');
    try {
      await submitBug({ bugType, priority, title, description });
      onDone();
    } catch (e) { setErr(e.message); }
    finally { setBusy(false); }
  }

  return (
    <div className="wx-modal-backdrop" onClick={onClose}>
      <div className="wx-modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 560 }}>
        <div className="wx-modal-header">
          <div className="wx-modal-title">Report a bug</div>
          <button className="shell-icon-btn" onClick={onClose}><XIcon width="16" height="16" /></button>
        </div>
        <div className="wx-modal-body">
          {err && <div className="wx-alert wx-alert-danger" style={{ marginBottom: 10 }}>{err}</div>}

          <div className="wx-label">Bug type</div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 12 }}>
            {BUG_TYPES.map((t) => (
              <button key={t.key} className="wx-btn"
                onClick={() => setBugType(t.key)}
                style={{
                  background: bugType === t.key ? t.color : 'transparent',
                  color: bugType === t.key ? 'var(--on-accent)' : t.color,
                  border: bugType === t.key ? 'none' : `1px solid ${t.color}55`,
                  fontWeight: 600,
                }}>{t.label}</button>
            ))}
          </div>

          <div className="wx-label">Priority</div>
          <div style={{ display: 'flex', gap: 6, marginBottom: 12 }}>
            {BUG_PRIORITIES.map((p) => (
              <button key={p.key} className="wx-btn"
                onClick={() => setPriority(p.key)}
                style={{
                  background: priority === p.key ? p.fg : p.bg,
                  color: priority === p.key ? 'var(--on-accent)' : p.fg,
                  border: 'none',
                  fontWeight: 600,
                }}>{p.label}</button>
            ))}
          </div>

          <div className="wx-label">Title</div>
          <input className="wx-input" value={title} onChange={(e) => setTitle(e.target.value)}
            placeholder="Short summary…" style={{ marginBottom: 10 }} />

          <div className="wx-label">Description</div>
          <textarea className="wx-input" rows="5"
            value={description} onChange={(e) => setDesc(e.target.value)}
            placeholder="What happened? What did you expect? Steps to reproduce…" />
        </div>
        <div className="wx-modal-footer">
          <button className="wx-btn wx-btn-ghost" onClick={onClose} disabled={busy}>Cancel</button>
          <button className="wx-btn wx-btn-primary" onClick={save} disabled={!ok || busy}>
            {busy ? <><span className="wx-spinner" /> Submitting…</> : <>Submit</>}
          </button>
        </div>
      </div>
    </div>
  );
}

// ============================================================
// Detail modal with inline edit + thread
// ============================================================
function BugDetail({ bug: initial, canEdit, canDelete, onClose, onChanged }) {
  const [bug, setBug] = useState(initial);
  const [editing, setEditing] = useState(false);
  const [status, setStatus] = useState(initial.status);
  const [devNotes, setDevNotes] = useState(initial.dev_notes || '');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const s = bugStatusMeta(bug.status);
  const p = bugPriorityMeta(bug.priority);
  const t = bugTypeMeta(bug.bug_type);

  async function save() {
    setBusy(true); setErr('');
    try {
      const updated = await updateBug(bug.id, { status, dev_notes: devNotes });
      setBug(updated); setEditing(false); onChanged();
    } catch (e) { setErr(e.message); }
    finally { setBusy(false); }
  }
  async function remove() {
    if (!confirm('Delete this bug report?')) return;
    try { await deleteBug(bug.id); onChanged(); onClose(); }
    catch (e) { setErr(e.message); }
  }

  return (
    <div className="wx-modal-backdrop" onClick={onClose}>
      <div className="wx-modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 720 }}>
        <div className="wx-modal-header">
          <div className="wx-modal-title" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ color: t.color }}><BugIcon width="18" height="18" /></span>
            {bug.title}
          </div>
          <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            {canDelete && (
              <button className="shell-icon-btn" onClick={remove} title="Delete">
                <TrashIcon width="16" height="16" />
              </button>
            )}
            <button className="shell-icon-btn" onClick={onClose}><XIcon width="16" height="16" /></button>
          </div>
        </div>
        <div className="wx-modal-body">
          {err && <div className="wx-alert wx-alert-danger" style={{ marginBottom: 10 }}>{err}</div>}

          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 12 }}>
            <Pill {...s} />
            <Pill {...p} />
            <span style={{ padding: '3px 10px', borderRadius: 999, fontSize: 11, fontWeight: 700, background: t.color + '22', color: t.color }}>{t.label}</span>
          </div>

          <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: 12 }}>
            Reported by <strong>{bug.reporter_name || '—'}</strong>
            {bug.reporter_role && <> ({bug.reporter_role})</>}
            {' · '}{new Date(bug.created_at).toLocaleString()}
          </div>

          <div className="wx-label">Description</div>
          <div style={{ padding: 12, background: 'var(--surface-0)', borderRadius: 8, whiteSpace: 'pre-wrap', marginBottom: 12, fontSize: 13 }}>
            {bug.description}
          </div>

          {bug.dev_notes && !editing && (
            <>
              <div className="wx-label">Dev notes</div>
              <div style={{ padding: 12, background: 'var(--info-soft)', borderRadius: 8, whiteSpace: 'pre-wrap', marginBottom: 12, fontSize: 13, color: 'var(--info)' }}>
                {bug.dev_notes}
              </div>
            </>
          )}

          {canEdit && !editing && (
            <button className="wx-btn wx-btn-ghost" onClick={() => setEditing(true)} style={{ marginBottom: 12 }}>
              Update status / notes
            </button>
          )}
          {editing && (
            <div style={{ padding: 12, border: '1px dashed color-mix(in srgb, var(--info) 35%, transparent)', background: 'var(--info-soft)', borderRadius: 8, marginBottom: 12 }}>
              <div className="wx-label">Status</div>
              <select className="wx-input" value={status} onChange={(e) => setStatus(e.target.value)} style={{ marginBottom: 10 }}>
                {BUG_STATUSES.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
              </select>
              <div className="wx-label">Dev notes</div>
              <textarea className="wx-input" rows="3" value={devNotes} onChange={(e) => setDevNotes(e.target.value)} />
              <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
                <button className="wx-btn wx-btn-ghost" onClick={() => setEditing(false)} disabled={busy}>Cancel</button>
                <button className="wx-btn wx-btn-primary" onClick={save} disabled={busy}>
                  {busy ? <><span className="wx-spinner" /> Saving…</> : <>Save</>}
                </button>
              </div>
            </div>
          )}

          <Thread bugId={bug.id} />
        </div>
      </div>
    </div>
  );
}

// ============================================================
// Thread
// ============================================================
function Thread({ bugId }) {
  const { user, profile } = useAuth();
  const qc = useQueryClient();
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const endRef = useRef(null);

  const { data: messages = [], isFetching } = useQuery({
    queryKey: ['bugs', 'thread', bugId],
    queryFn: () => listBugMessages(bugId),
    refetchInterval: 10000,
  });

  useEffect(() => {
    const t = setTimeout(() => endRef.current?.scrollIntoView({ behavior: 'smooth' }), 20);
    return () => clearTimeout(t);
  }, [messages.length]);

  async function send() {
    if (!text.trim() || busy) return;
    setBusy(true);
    try {
      await postBugMessage(bugId, text);
      setText('');
      qc.invalidateQueries({ queryKey: ['bugs', 'thread', bugId] });
    } catch (e) { alert(e.message); }
    finally { setBusy(false); }
  }

  return (
    <>
      <div className="wx-label" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <MessageIcon width="14" height="14" /> Discussion
      </div>
      <div style={{ border: '1px solid var(--border-subtle)', borderRadius: 8, maxHeight: 260, overflowY: 'auto', padding: 10, background: 'var(--surface-1)' }}>
        {messages.length === 0 && !isFetching && (
          <div style={{ padding: 12, textAlign: 'center', color: 'var(--text-muted)', fontSize: 13 }}>
            No messages yet.
          </div>
        )}
        {messages.map((m) => {
          const mine = m.sender_id === user?.id;
          return (
            <div key={m.id} style={{ display: 'flex', justifyContent: mine ? 'flex-end' : 'flex-start', marginBottom: 6 }}>
              <div style={{
                maxWidth: '82%',
                padding: '6px 10px', borderRadius: 10,
                background: mine ? 'var(--accent)' : 'var(--surface-2)',
                color: mine ? 'var(--on-accent)' : 'var(--text-primary)',
                fontSize: 13,
              }}>
                {!mine && (
                  <div style={{ fontSize: 11, fontWeight: 700, marginBottom: 2, color: 'var(--text-secondary)' }}>
                    {m.sender_name || '—'}{m.sender_role ? ` · ${m.sender_role}` : ''}
                  </div>
                )}
                <div style={{ whiteSpace: 'pre-wrap' }}>{m.text}</div>
              </div>
            </div>
          );
        })}
        <div ref={endRef} />
      </div>
      <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
        <input className="wx-input" value={text} placeholder="Write a reply…"
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }} />
        <button className="wx-btn wx-btn-primary" onClick={send} disabled={!text.trim() || busy}>
          {busy ? <span className="wx-spinner" /> : 'Send'}
        </button>
      </div>
    </>
  );
}
