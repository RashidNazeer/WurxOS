import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '../../contexts/AuthContext';
import { supabase } from '../../lib/supabase';
import {
  PlusIcon, AlertIcon, RefreshIcon, XIcon, CheckIcon, BellIcon,
} from '../../components/common/Icon';
import '../../styles/table.css';

export default function RemindersPage() {
  const { user } = useAuth();
  const uid = user?.id;

  const [create, setCreate]   = useState(false);
  const [localErr, setLocalErr] = useState('');

  const qc = useQueryClient();
  const { data: rows = [], isLoading: loading, error: queryError } = useQuery({
    queryKey: ['reminders', uid],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('reminders').select('*')
        .eq('user_id', uid)
        .order('remind_at', { ascending: false })
        .limit(100);
      if (error) throw new Error(error.message);
      return data || [];
    },
    enabled: !!uid,
  });
  const err = localErr || queryError?.message || '';
  const load = () => qc.invalidateQueries({ queryKey: ['reminders'] });

  async function del(id) {
    if (!confirm('Delete this reminder?')) return;
    try {
      const { error } = await supabase.from('reminders').delete().eq('id', id);
      if (error) throw error; load();
    } catch (e) { setLocalErr(e.message); }
  }

  const upcoming = rows.filter((r) => !r.sent_at);
  const past     = rows.filter((r) =>  r.sent_at);

  return (
    <>
      <div className="page-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: 12 }}>
        <div>
          <h1 className="page-title">Reminders</h1>
          <p className="page-subtitle">Schedule a ping to yourself — fires as a notification.</p>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="wx-btn wx-btn-ghost" onClick={load}><RefreshIcon width="15" height="15" /></button>
          <button className="wx-btn wx-btn-primary" onClick={() => setCreate(true)}>
            <PlusIcon width="15" height="15" /> New reminder
          </button>
        </div>
      </div>

      {err && (
        <div className="wx-alert wx-alert-danger" style={{ marginBottom: 14 }}>
          <AlertIcon width="16" height="16" /> <span>{err}</span>
        </div>
      )}

      <Section title={`Upcoming (${upcoming.length})`} items={upcoming} onDelete={del} />
      <Section title={`Past (${past.length})`} items={past} past />

      {create && <CreateModal uid={uid} onClose={() => setCreate(false)} onSaved={() => { setCreate(false); load(); }} />}
    </>
  );
}

function relativeTime(target) {
  const ms = new Date(target).getTime() - Date.now();
  const past = ms < 0;
  const abs = Math.abs(ms);
  const m = Math.round(abs / 60000);
  if (m < 1)   return past ? 'just now' : 'now';
  if (m < 60)  return past ? `${m}m ago` : `in ${m}m`;
  const h = Math.round(m / 60);
  if (h < 24)  return past ? `${h}h ago` : `in ${h}h`;
  const d = Math.round(h / 24);
  if (d < 30)  return past ? `${d}d ago` : `in ${d}d`;
  const mo = Math.round(d / 30);
  return past ? `${mo}mo ago` : `in ${mo}mo`;
}

// Map "minutes until reminder" to an urgency color so the UI hints
// at how soon something fires at a glance.
function urgencyColor(target) {
  const ms = new Date(target).getTime() - Date.now();
  if (ms < 0)             return 'var(--text-muted)';
  const minutes = ms / 60000;
  if (minutes < 60)       return 'var(--danger)';
  if (minutes < 60 * 24)  return 'var(--warning)';
  return 'var(--accent)';
}

function Section({ title, items, onDelete, past }) {
  return (
    <div className="wx-card" style={{ padding: 0, marginBottom: 16 }}>
      <div style={{
        padding: '14px 18px',
        borderBottom: items.length > 0 ? '1px solid var(--border-subtle)' : 'none',
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      }}>
        <div style={{
          fontWeight: 700, fontSize: 13.5,
          letterSpacing: '0.01em',
          display: 'flex', alignItems: 'center', gap: 8,
        }}>
          {title}
        </div>
      </div>
      {items.length === 0 ? (
        <div style={{
          padding: '32px 16px',
          textAlign: 'center',
          color: 'var(--text-muted)',
          fontSize: 13,
        }}>
          <div style={{
            width: 44, height: 44,
            margin: '0 auto 10px',
            borderRadius: '50%',
            background: 'var(--surface-2)',
            display: 'grid', placeItems: 'center',
            color: 'var(--text-muted)',
          }}>
            <BellIcon width="20" height="20" />
          </div>
          {past ? 'Nothing fired yet.' : 'Nothing scheduled. Click "New reminder" to add one.'}
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column' }}>
          {items.map((r) => {
            const color = past ? 'var(--text-muted)' : urgencyColor(r.remind_at);
            return (
              <div
                key={r.id}
                className="reminder-row"
                style={{
                  display: 'grid',
                  gridTemplateColumns: '36px 1fr auto auto',
                  gap: 14,
                  padding: '14px 18px',
                  borderTop: '1px solid var(--border-subtle)',
                  alignItems: 'center',
                  transition: 'background var(--dur-fast)',
                }}
              >
                <div style={{
                  width: 36, height: 36,
                  borderRadius: 'var(--radius-md)',
                  background: `color-mix(in srgb, ${color} 14%, transparent)`,
                  color,
                  display: 'grid', placeItems: 'center',
                  flex: '0 0 auto',
                }}>
                  <BellIcon width="16" height="16" />
                </div>
                <div style={{ minWidth: 0 }}>
                  <div style={{
                    fontWeight: 600, fontSize: 14,
                    color: 'var(--text-primary)',
                    whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                  }}>
                    {r.title}
                  </div>
                  {r.body && (
                    <div style={{
                      fontSize: 12.5, color: 'var(--text-secondary)',
                      marginTop: 3, lineHeight: 1.4,
                      whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                    }}>
                      {r.body}
                    </div>
                  )}
                </div>
                <div style={{ textAlign: 'right' }}>
                  <div style={{
                    display: 'inline-flex', alignItems: 'center',
                    padding: '3px 10px',
                    borderRadius: 'var(--radius-pill)',
                    fontSize: 11.5, fontWeight: 700,
                    color,
                    background: `color-mix(in srgb, ${color} 12%, transparent)`,
                    letterSpacing: '0.02em',
                  }}>
                    {relativeTime(r.remind_at)}
                  </div>
                  <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4 }}>
                    {new Date(r.remind_at).toLocaleString(undefined, {
                      month: 'short', day: 'numeric',
                      hour: 'numeric', minute: '2-digit',
                    })}
                  </div>
                </div>
                {!past ? (
                  <button
                    onClick={() => onDelete(r.id)}
                    title="Delete reminder"
                    aria-label="Delete reminder"
                    style={{
                      width: 30, height: 30,
                      border: 0, background: 'transparent',
                      color: 'var(--text-muted)',
                      cursor: 'pointer',
                      borderRadius: 8,
                      display: 'grid', placeItems: 'center',
                      transition: 'background var(--dur-fast), color var(--dur-fast)',
                    }}
                    onMouseEnter={(e) => {
                      e.currentTarget.style.background = 'var(--danger-soft)';
                      e.currentTarget.style.color = 'var(--danger)';
                    }}
                    onMouseLeave={(e) => {
                      e.currentTarget.style.background = 'transparent';
                      e.currentTarget.style.color = 'var(--text-muted)';
                    }}
                  >
                    <XIcon width="14" height="14" />
                  </button>
                ) : (
                  <div style={{ width: 30 }} />
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function CreateModal({ uid, onClose, onSaved }) {
  const [title, setTitle] = useState('');
  const [body, setBody]   = useState('');
  const [when, setWhen]   = useState(() => {
    const d = new Date(Date.now() + 15 * 60 * 1000); // default 15m from now
    d.setSeconds(0, 0);
    return d.toISOString().slice(0, 16);
  });
  const [saving, setSaving] = useState(false);
  const [err, setErr]     = useState('');

  async function submit(e) {
    e.preventDefault(); setErr('');
    if (!title.trim()) return setErr('Title is required.');
    setSaving(true);
    try {
      const { error } = await supabase.from('reminders').insert({
        user_id: uid, title: title.trim(), body: body.trim(),
        remind_at: new Date(when).toISOString(),
      });
      if (error) throw error; onSaved();
    } catch (e) { setErr(e.message); }
    finally { setSaving(false); }
  }

  return (
    <div className="wx-modal-backdrop" onClick={onClose}>
      <div className="wx-modal" onClick={(e) => e.stopPropagation()}>
        <form onSubmit={submit}>
          <div className="wx-modal-header">
            <div className="wx-modal-title">New reminder</div>
            <button type="button" className="shell-icon-btn" onClick={onClose}><XIcon width="16" height="16" /></button>
          </div>
          <div className="wx-modal-body">
            {err && <div className="wx-alert wx-alert-danger" style={{ marginBottom: 10 }}><AlertIcon width="14" height="14" /> <span>{err}</span></div>}
            <div style={{ marginBottom: 12 }}>
              <label className="wx-label">Title</label>
              <input className="wx-input" value={title} onChange={(e) => setTitle(e.target.value)} disabled={saving} placeholder="Call Sara back" />
            </div>
            <div style={{ marginBottom: 12 }}>
              <label className="wx-label">Note (optional)</label>
              <textarea className="wx-input" rows={3} value={body} onChange={(e) => setBody(e.target.value)} disabled={saving} />
            </div>
            <div>
              <label className="wx-label">When</label>
              <input type="datetime-local" className="wx-input" value={when} onChange={(e) => setWhen(e.target.value)} disabled={saving} />
            </div>
          </div>
          <div className="wx-modal-footer">
            <button className="wx-btn wx-btn-ghost" onClick={onClose} disabled={saving}>Cancel</button>
            <button type="submit" className="wx-btn wx-btn-primary" disabled={saving}>
              {saving ? <><span className="wx-spinner" /> Saving…</> : <><CheckIcon width="14" height="14" /> Save</>}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
