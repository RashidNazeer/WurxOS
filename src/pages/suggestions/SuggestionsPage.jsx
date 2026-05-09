import { useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '../../contexts/AuthContext';
import {
  listSuggestions, createSuggestion, updateSuggestion, deleteSuggestion, toggleUpvote,
  SUGGESTION_CATEGORIES, SUGGESTION_STATUSES,
  suggestionCategoryMeta, suggestionStatusMeta,
} from '../../lib/suggestionsApi';
import {
  PlusIcon, AlertIcon, RefreshIcon, SearchIcon, XIcon,
  LightbulbIcon, ArrowUpIcon, TrashIcon,
} from '../../components/common/Icon';
import '../../styles/table.css';

export default function SuggestionsPage() {
  const { user, profile } = useAuth();
  const role = profile?.role;
  const isDev  = role === 'developer';
  const isBoss = role === 'boss';
  const canTriage = isDev || isBoss;

  const [tab, setTab]       = useState('all');    // all | mine
  const [statusF, setStatusF]     = useState('all');
  const [categoryF, setCategoryF] = useState('all');
  const [q, setQ]           = useState('');
  const [showForm, setShowForm] = useState(false);
  const [editing, setEditing]   = useState(null);   // row being edited (author)
  const [reviewing, setReviewing] = useState(null); // row being triaged (dev)

  const qc = useQueryClient();
  const { data: rows = [], isPending, error, refetch } = useQuery({
    queryKey: ['suggestions', { tab, statusF, categoryF, q }],
    queryFn: () => listSuggestions({ status: statusF, category: categoryF, q, scope: tab }),
  });

  const stats = useMemo(() => {
    const out = { total: rows.length, mine: 0 };
    for (const s of SUGGESTION_STATUSES) out[s.key] = 0;
    for (const r of rows) {
      out[r.status] = (out[r.status] || 0) + 1;
      if (r.submitted_by === user?.id) out.mine += 1;
    }
    return out;
  }, [rows, user]);

  async function doVote(row) {
    qc.setQueryData(['suggestions', { tab, statusF, categoryF, q }], (prev = []) =>
      prev.map((r) => r.id === row.id ? {
        ...r,
        i_upvoted: !r.i_upvoted,
        upvote_count: r.upvote_count + (r.i_upvoted ? -1 : 1),
      } : r));
    try { await toggleUpvote(row.id, row.i_upvoted); }
    catch (e) { alert(e.message); refetch(); }
  }

  async function doDelete(row) {
    if (!confirm('Delete this suggestion?')) return;
    try { await deleteSuggestion(row.id); refetch(); }
    catch (e) { alert(e.message); }
  }

  return (
    <>
      <div className="page-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: 12 }}>
        <div>
          <h1 className="page-title">Suggestions</h1>
          <p className="page-subtitle">Ideas, improvements and feature requests.</p>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="wx-btn wx-btn-ghost" onClick={() => refetch()} title="Refresh">
            <RefreshIcon width="15" height="15" />
          </button>
          <button className="wx-btn wx-btn-primary" onClick={() => setShowForm(true)}>
            <PlusIcon width="15" height="15" /> New suggestion
          </button>
        </div>
      </div>

      {error && (
        <div className="wx-alert wx-alert-danger" style={{ marginBottom: 14 }}>
          <AlertIcon width="16" height="16" /> <span>{error.message}</span>
        </div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(120px, 100%), 1fr))', gap: 10, marginBottom: 14 }}>
        <Stat label="Total"       value={stats.total}      tone="#1f2937" />
        <Stat label="New"         value={stats.new}        tone="#4b5563" />
        <Stat label="Planned"     value={stats.planned}    tone="#92400e" />
        <Stat label="Implemented" value={stats.implemented} tone="#166534" />
        <Stat label="My ideas"    value={stats.mine}       tone="#2563eb" />
      </div>

      <div style={{ display: 'flex', gap: 6, marginBottom: 12, flexWrap: 'wrap' }}>
        {[{ k: 'all', label: 'All suggestions' }, { k: 'mine', label: 'My suggestions' }].map((t) => (
          <button key={t.k} className="wx-btn"
            onClick={() => setTab(t.k)}
            style={{
              background: tab === t.k ? '#2563eb' : 'transparent',
              color: tab === t.k ? '#fff' : '#475569',
              border: tab === t.k ? 'none' : '1px solid #e5e7eb',
            }}>{t.label}</button>
        ))}
      </div>

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 12 }}>
        <div style={{ position: 'relative', flex: '1 1 240px', maxWidth: 320 }}>
          <SearchIcon width="14" height="14" style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: '#94a3b8' }} />
          <input className="wx-input" placeholder="Search…" style={{ paddingLeft: 32 }}
            value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <select className="wx-input" style={{ maxWidth: 170 }} value={statusF} onChange={(e) => setStatusF(e.target.value)}>
          <option value="all">All statuses</option>
          {SUGGESTION_STATUSES.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
        </select>
        <select className="wx-input" style={{ maxWidth: 170 }} value={categoryF} onChange={(e) => setCategoryF(e.target.value)}>
          <option value="all">All categories</option>
          {SUGGESTION_CATEGORIES.map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}
        </select>
      </div>

      {isPending ? (
        <div style={{ padding: 30, textAlign: 'center', color: '#64748b' }}>
          <span className="wx-spinner" /> Loading…
        </div>
      ) : rows.length === 0 ? (
        <div style={{ padding: 40, textAlign: 'center', color: '#94a3b8', border: '1px dashed #e5e7eb', borderRadius: 10, background: '#fff' }}>
          <LightbulbIcon width="28" height="28" />
          <div style={{ marginTop: 8, fontWeight: 600, color: '#475569' }}>No suggestions yet.</div>
        </div>
      ) : (
        <div style={{ display: 'grid', gap: 10 }}>
          {rows.map((r) => {
            const c = suggestionCategoryMeta(r.category);
            const s = suggestionStatusMeta(r.status);
            const mine = r.submitted_by === user?.id;
            const editable = mine && r.status === 'new';
            return (
              <div key={r.id} className="suggestion-card" style={{ display: 'grid', gridTemplateColumns: 'auto 1fr auto', gap: 12, padding: 14, borderRadius: 10, border: '1px solid #e5e7eb', background: '#fff' }}>
                {/* Vote */}
                <button onClick={() => doVote(r)}
                  style={{
                    all: 'unset', cursor: 'pointer',
                    display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
                    padding: '6px 10px', borderRadius: 10,
                    background: r.i_upvoted ? '#dbeafe' : '#f8fafc',
                    border: `1px solid ${r.i_upvoted ? '#93c5fd' : '#e5e7eb'}`,
                    minWidth: 46,
                  }}>
                  <ArrowUpIcon width="14" height="14" color={r.i_upvoted ? '#2563eb' : '#64748b'} />
                  <strong style={{ fontSize: 13, color: r.i_upvoted ? '#2563eb' : '#475569' }}>{r.upvote_count}</strong>
                </button>

                <div style={{ minWidth: 0 }}>
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 4, flexWrap: 'wrap' }}>
                    <strong style={{ fontSize: 14, color: '#0f172a' }}>{r.title}</strong>
                    <span style={{ padding: '2px 8px', borderRadius: 999, fontSize: 11, fontWeight: 600, background: c.color + '22', color: c.color }}>{c.label}</span>
                    <span style={{ padding: '2px 8px', borderRadius: 999, fontSize: 11, fontWeight: 700, background: s.bg, color: s.fg }}>{s.label}</span>
                  </div>
                  <div style={{ fontSize: 13, color: '#475569', whiteSpace: 'pre-wrap', marginBottom: 6 }}>{r.description}</div>
                  {r.dev_notes && (
                    <div style={{ padding: 8, background: '#eff6ff', color: '#1e40af', borderRadius: 6, fontSize: 12, marginBottom: 6 }}>
                      <strong>Dev response:</strong> {r.dev_notes}
                    </div>
                  )}
                  <div style={{ fontSize: 12, color: '#64748b' }}>
                    {r.submitted_by_name || '—'}{r.submitted_by_role ? ` · ${r.submitted_by_role}` : ''}
                    {' · '}{new Date(r.created_at).toLocaleDateString()}
                  </div>
                </div>

                <div style={{ display: 'flex', gap: 6, alignSelf: 'start' }}>
                  {canTriage && (
                    <button className="wx-btn wx-btn-ghost" onClick={() => setReviewing(r)} title="Review">
                      Review
                    </button>
                  )}
                  {editable && (
                    <button className="wx-btn wx-btn-ghost" onClick={() => setEditing(r)} title="Edit">
                      Edit
                    </button>
                  )}
                  {(mine || isDev || isBoss) && (
                    <button className="shell-icon-btn" onClick={() => doDelete(r)} title="Delete">
                      <TrashIcon width="14" height="14" />
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {showForm && <SuggestionForm onClose={() => setShowForm(false)} onDone={() => { setShowForm(false); refetch(); }} />}
      {editing && <SuggestionForm editing={editing} onClose={() => setEditing(null)} onDone={() => { setEditing(null); refetch(); }} />}
      {reviewing && <ReviewModal row={reviewing} onClose={() => setReviewing(null)} onDone={() => { setReviewing(null); refetch(); }} />}
    </>
  );
}

function Stat({ label, value, tone }) {
  return (
    <div style={{ padding: 12, borderRadius: 10, border: '1px solid #e5e7eb', background: '#fff' }}>
      <div style={{ fontSize: 11, color: '#64748b', textTransform: 'uppercase', letterSpacing: 0.4 }}>{label}</div>
      <div style={{ fontSize: 22, fontWeight: 700, color: tone, marginTop: 2 }}>{value}</div>
    </div>
  );
}

// ---- Submit / edit modal ----
function SuggestionForm({ editing, onClose, onDone }) {
  const [category, setCategory] = useState(editing?.category || 'feature');
  const [title, setTitle]       = useState(editing?.title || '');
  const [description, setDesc]  = useState(editing?.description || '');
  const [busy, setBusy]   = useState(false);
  const [err, setErr]     = useState('');

  const ok = category && title.trim() && description.trim();
  async function save() {
    if (!ok || busy) return;
    setBusy(true); setErr('');
    try {
      if (editing) {
        await updateSuggestion(editing.id, {
          category, title: title.trim(), description: description.trim(),
        });
      } else {
        await createSuggestion({ category, title, description });
      }
      onDone();
    } catch (e) { setErr(e.message); }
    finally { setBusy(false); }
  }

  return (
    <div className="wx-modal-backdrop" onClick={onClose}>
      <div className="wx-modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 520 }}>
        <div className="wx-modal-header">
          <div className="wx-modal-title">{editing ? 'Edit suggestion' : 'New suggestion'}</div>
          <button className="shell-icon-btn" onClick={onClose}><XIcon width="16" height="16" /></button>
        </div>
        <div className="wx-modal-body">
          {err && <div className="wx-alert wx-alert-danger" style={{ marginBottom: 10 }}>{err}</div>}
          <div className="wx-label">Category</div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 12 }}>
            {SUGGESTION_CATEGORIES.map((c) => (
              <button key={c.key} className="wx-btn"
                onClick={() => setCategory(c.key)}
                style={{
                  background: category === c.key ? c.color : 'transparent',
                  color: category === c.key ? '#fff' : c.color,
                  border: category === c.key ? 'none' : `1px solid ${c.color}55`,
                  fontWeight: 600,
                }}>{c.label}</button>
            ))}
          </div>
          <div className="wx-label">Title</div>
          <input className="wx-input" value={title} onChange={(e) => setTitle(e.target.value)} style={{ marginBottom: 10 }} />
          <div className="wx-label">Description</div>
          <textarea className="wx-input" rows="5" value={description} onChange={(e) => setDesc(e.target.value)} />
        </div>
        <div className="wx-modal-footer">
          <button className="wx-btn wx-btn-ghost" onClick={onClose} disabled={busy}>Cancel</button>
          <button className="wx-btn wx-btn-primary" onClick={save} disabled={!ok || busy}>
            {busy ? <><span className="wx-spinner" /> Saving…</> : <>{editing ? 'Save' : 'Submit'}</>}
          </button>
        </div>
      </div>
    </div>
  );
}

// ---- Dev/Boss triage modal ----
function ReviewModal({ row, onClose, onDone }) {
  const { profile } = useAuth();
  const [status, setStatus]   = useState(row.status);
  const [devNotes, setDevNotes] = useState(row.dev_notes || '');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  async function save() {
    setBusy(true); setErr('');
    try {
      await updateSuggestion(row.id, {
        status, dev_notes: devNotes,
        reviewed_by_name: profile?.display_name || null,
      });
      onDone();
    } catch (e) { setErr(e.message); }
    finally { setBusy(false); }
  }

  return (
    <div className="wx-modal-backdrop" onClick={onClose}>
      <div className="wx-modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 520 }}>
        <div className="wx-modal-header">
          <div className="wx-modal-title">Review suggestion</div>
          <button className="shell-icon-btn" onClick={onClose}><XIcon width="16" height="16" /></button>
        </div>
        <div className="wx-modal-body">
          {err && <div className="wx-alert wx-alert-danger" style={{ marginBottom: 10 }}>{err}</div>}
          <div style={{ marginBottom: 12, fontSize: 13 }}><strong>{row.title}</strong></div>
          <div style={{ fontSize: 13, color: '#475569', whiteSpace: 'pre-wrap', marginBottom: 12 }}>{row.description}</div>

          <div className="wx-label">Status</div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 12 }}>
            {SUGGESTION_STATUSES.map((s) => (
              <button key={s.key} className="wx-btn"
                onClick={() => setStatus(s.key)}
                style={{
                  background: status === s.key ? s.fg : s.bg,
                  color: status === s.key ? '#fff' : s.fg,
                  border: 'none', fontWeight: 600,
                }}>{s.label}</button>
            ))}
          </div>

          <div className="wx-label">Developer notes (shown to submitter)</div>
          <textarea className="wx-input" rows="4" value={devNotes} onChange={(e) => setDevNotes(e.target.value)} />
        </div>
        <div className="wx-modal-footer">
          <button className="wx-btn wx-btn-ghost" onClick={onClose} disabled={busy}>Cancel</button>
          <button className="wx-btn wx-btn-primary" onClick={save} disabled={busy}>
            {busy ? <><span className="wx-spinner" /> Saving…</> : 'Save'}
          </button>
        </div>
      </div>
    </div>
  );
}
