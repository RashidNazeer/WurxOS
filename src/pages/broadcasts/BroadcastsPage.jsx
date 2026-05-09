import { useEffect, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '../../contexts/AuthContext';
import { supabase } from '../../lib/supabase';
import {
  listBroadcasts, createBroadcast, allowedTargetsFor, canBroadcast,
  BROADCAST_TARGETS, listRecipientCandidates, previewRecipientCount,
  submitResponse, getMyResponse, listResponses, listRecipients,
  renotifyUser, renotifyPending,
} from '../../lib/broadcastsApi';
import { ROLES } from '../../lib/roles';
import {
  PlusIcon, AlertIcon, RefreshIcon, XIcon, CheckIcon, MegaphoneIcon,
  UsersIcon, UserIcon, StoreIcon, ShieldIcon, ClockIcon,
} from '../../components/common/Icon';
import '../../styles/table.css';
import '../../styles/modal.css';

export default function BroadcastsPage() {
  const { profile, user } = useAuth();
  const role = profile?.role;
  const allowCompose = canBroadcast(role);

  const [compose, setCompose] = useState(false);
  const [openRow, setOpen]    = useState(null);

  const qc = useQueryClient();
  const { data: rows = [], isLoading: loading, error: queryError } = useQuery({
    queryKey: ['broadcasts'],
    queryFn: listBroadcasts,
  });
  const err  = queryError?.message || '';
  const load = () => qc.invalidateQueries({ queryKey: ['broadcasts'] });

  return (
    <>
      <div className="page-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: 12 }}>
        <div>
          <h1 className="page-title">Broadcasts</h1>
          <p className="page-subtitle">
            {allowCompose
              ? 'Send an announcement that fans out as notifications.'
              : 'Announcements sent to you by your leads.'}
          </p>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="wx-btn wx-btn-ghost" onClick={load} title="Refresh">
            <RefreshIcon width="15" height="15" />
          </button>
          {allowCompose && (
            <button className="wx-btn wx-btn-primary" onClick={() => setCompose(true)}>
              <PlusIcon width="15" height="15" /> New broadcast
            </button>
          )}
        </div>
      </div>

      {err && (
        <div className="wx-alert wx-alert-danger" style={{ marginBottom: 14 }}>
          <AlertIcon width="16" height="16" /> <span>{err}</span>
        </div>
      )}

      {loading ? (
        <div className="wx-empty"><span className="wx-spinner" /> Loading…</div>
      ) : rows.length === 0 ? (
        <div className="wx-empty">
          <div style={{ display: 'grid', placeItems: 'center', width: 52, height: 52, borderRadius: '50%', background: 'var(--surface-2)', color: 'var(--text-muted)', margin: '0 auto 12px' }}>
            <MegaphoneIcon width="22" height="22" />
          </div>
          <div className="wx-empty-title">No broadcasts yet</div>
          <div>{allowCompose ? 'Click New broadcast to send one.' : 'Announcements from your leads will appear here.'}</div>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {rows.map((r) => (
            <BroadcastCard
              key={r.id}
              row={r}
              isMine={r.author_id === user?.id}
              onClick={() => setOpen(r)}
            />
          ))}
        </div>
      )}

      {compose && (
        <ComposeStepModal
          authorId={user?.id}
          authorRole={role}
          onClose={() => setCompose(false)}
          onSent={() => { setCompose(false); load(); }}
        />
      )}
      {openRow && (
        <BroadcastDetailModal
          broadcast={openRow}
          meId={user?.id}
          onClose={() => setOpen(null)}
          onChanged={load}
        />
      )}
    </>
  );
}

function BroadcastCard({ row, isMine, onClick }) {
  const targetLabel = targetSummary(row);
  const hasPoll     = (row.response_options || []).length > 0;
  const pct = isMine && hasPoll && row.sent_count
    ? Math.min(100, Math.round(((row.response_count || 0) / row.sent_count) * 100))
    : null;

  return (
    <div className="wx-card" style={{ padding: 16, cursor: 'pointer' }} onClick={onClick}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 10, flexWrap: 'wrap' }}>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ fontWeight: 700, fontSize: 14, display: 'flex', alignItems: 'center', gap: 6 }}>
            {row.title}
            {hasPoll && (
              <span style={{
                fontSize: 10, fontWeight: 700, padding: '1px 7px', borderRadius: 999,
                background: 'color-mix(in srgb, var(--accent) 18%, transparent)',
                color: 'var(--accent)', textTransform: 'uppercase', letterSpacing: '0.04em',
              }}>Poll</span>
            )}
          </div>
          <div style={{ fontSize: 11.5, color: 'var(--text-muted)', marginTop: 2 }}>
            {row.author?.display_name || '—'}
            {row.author?.role && ` · ${row.author.role.toUpperCase()}`}
            {' · '}{new Date(row.created_at).toLocaleString()}
          </div>
        </div>
        {row.sent_at
          ? <span className="wx-badge wx-badge-success">Delivered · {row.sent_count ?? 0}</span>
          : row.scheduled_for
            ? <span className="wx-badge">Scheduled</span>
            : <span className="wx-badge">Pending…</span>}
      </div>
      {row.body && (
        <div style={{ fontSize: 13, color: 'var(--text-secondary)', marginTop: 8, whiteSpace: 'pre-wrap' }}>
          {row.body}
        </div>
      )}
      <div style={{ fontSize: 11.5, color: 'var(--text-muted)', marginTop: 10, display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'center' }}>
        <span>Audience: <strong style={{ color: 'var(--text-primary)' }}>{targetLabel}</strong></span>
        {row.scheduled_for && !row.sent_at && (
          <span>
            <ClockIcon width="12" height="12" style={{ verticalAlign: '-2px', marginRight: 4 }} />
            Sends at {new Date(row.scheduled_for).toLocaleString()}
          </span>
        )}
        {isMine && hasPoll && row.sent_at && (
          <span style={{ color: 'var(--accent)' }}>
            {row.response_count || 0} / {row.sent_count || 0} responded
            {pct != null && ` · ${pct}%`}
          </span>
        )}
      </div>
    </div>
  );
}

function targetSummary(row) {
  if (row.target === 'all')     return 'Everyone';
  if (row.target === 'my_team') return 'My team';
  if (row.target === 'role')    return `Roles: ${(row.target_roles || []).map((r) => r.toUpperCase()).join(', ') || '—'}`;
  if (row.target === 'users')   return `${(row.target_user_ids || []).length} specific user${(row.target_user_ids || []).length === 1 ? '' : 's'}`;
  if (row.target === 'brand')   return 'Brand team';
  return row.target || '—';
}

// ============================================================
// Compose — 3-step stepper (Details → Access → Review)
// ============================================================
const STEPS = [
  { key: 'details', label: 'Details' },
  { key: 'access',  label: 'Access'  },
  { key: 'review',  label: 'Review'  },
];

function ComposeStepModal({ authorId, authorRole, onClose, onSent }) {
  const allowed = useMemo(() => allowedTargetsFor(authorRole), [authorRole]);
  const [step, setStep]       = useState(0);
  const [title, setTitle]     = useState('');
  const [body, setBody]       = useState('');
  const [target, setTarget]   = useState(allowed[0] || 'users');
  const [roles, setRoles]     = useState([]);
  const [userIds, setUserIds] = useState([]);
  const [brandId, setBrandId] = useState('');
  const [schedule, setSched]  = useState('');
  const [saving, setSaving]   = useState(false);
  const [err, setErr]         = useState('');

  // Poll options: start disabled. When enabled, seed with an "Acknowledged"
  // option to match v1's default. Options are local; sent on save.
  const [pollOn, setPollOn]      = useState(false);
  const [pollOptions, setPollOpts] = useState([{ id: 'opt_ack', label: 'Acknowledged' }]);
  function addOption() {
    setPollOpts((cur) => [...cur, { id: 'opt_' + Math.random().toString(36).slice(2, 8), label: '' }]);
  }
  function removeOption(id) {
    setPollOpts((cur) => cur.length <= 1 ? cur : cur.filter((o) => o.id !== id));
  }
  function updateOption(id, label) {
    setPollOpts((cur) => cur.map((o) => o.id === id ? { ...o, label } : o));
  }

  const { data: candidates = [] } = useQuery({
    queryKey: ['broadcasts', 'candidates', authorRole, authorId],
    queryFn:  () => listRecipientCandidates({ role: authorRole, uid: authorId }),
  });

  const { data: brands = [] } = useQuery({
    queryKey: ['broadcasts', 'brands'],
    queryFn: async () => {
      const { data, error } = await supabase.from('brands').select('id, brand_name').order('brand_name');
      if (error) throw new Error(error.message);
      return data || [];
    },
    enabled: allowed.includes('brand'),
  });

  // Recipient count preview for Review step
  const [recipientCount, setRecipientCount] = useState(null);
  useEffect(() => {
    if (step !== 2) return;
    let cancelled = false;
    previewRecipientCount({ target, targetRoles: roles, targetUserIds: userIds, targetBrandId: brandId, authorId })
      .then((n) => { if (!cancelled) setRecipientCount(n); })
      .catch(() => { if (!cancelled) setRecipientCount(null); });
    return () => { cancelled = true; };
  }, [step, target, roles, userIds, brandId, authorId]);

  function canAdvance() {
    if (step === 0) return !!title.trim();
    if (step === 1) {
      if (target === 'role'  && roles.length === 0)   return false;
      if (target === 'users' && userIds.length === 0) return false;
      if (target === 'brand' && !brandId)             return false;
      return true;
    }
    return true;
  }

  async function send() {
    setErr(''); setSaving(true);
    try {
      const optsClean = pollOn
        ? pollOptions.map((o) => ({ id: o.id, label: (o.label || '').trim() })).filter((o) => o.label)
        : [];
      if (pollOn && optsClean.length === 0) throw new Error('Add at least one response option.');
      await createBroadcast({
        authorId, title, body, target,
        targetRoles: roles, targetUserIds: userIds, targetBrandId: brandId || null,
        scheduledFor: schedule ? new Date(schedule).toISOString() : null,
        responseOptions: optsClean,
      });
      onSent();
    } catch (e) { setErr(e.message); }
    finally { setSaving(false); }
  }

  useEffect(() => {
    function onKey(e) {
      if (e.key === 'Escape') onClose();
      else if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
        if (step < 2 && canAdvance()) setStep(step + 1);
        else if (step === 2 && !saving) send();
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, title, target, roles, userIds, brandId, saving]);

  return (
    <div className="wx-modal-backdrop wx-m-backdrop" onClick={onClose}>
      <div className="wx-modal" style={{ maxWidth: 640 }} onClick={(e) => e.stopPropagation()}>
        {/* Header */}
        <div className="wx-m-head">
          <div className="wx-m-head-icon"><MegaphoneIcon width="18" height="18" /></div>
          <div className="wx-m-head-text">
            <div className="wx-m-head-title">New broadcast</div>
            <div className="wx-m-head-sub">Announcements turn into notifications for the people you pick.</div>
          </div>
          <button type="button" className="wx-m-head-close" onClick={onClose}><XIcon width="14" height="14" /></button>
        </div>

        <div className="wx-m-stepper">
          {STEPS.map((s, i) => (
            <span key={s.key} className={`wx-m-step ${i === step ? 'is-active' : i < step ? 'is-done' : ''}`}>
              <span className="wx-m-step-dot">{i < step ? <CheckIcon width="10" height="10" /> : i + 1}</span>
              {s.label}
              {i < STEPS.length - 1 && <span className="wx-m-step-sep" style={{ width: 24, flex: 'none' }} />}
            </span>
          ))}
        </div>

        <div className="wx-m-body">
          {err && <div className="wx-alert wx-alert-danger"><AlertIcon width="14" height="14" /> <span>{err}</span></div>}

          {step === 0 && (
            <>
              <div className="wx-m-field">
                <div className="wx-m-field-head">
                  <div className="wx-m-field-label">Title</div>
                  <div className="wx-m-field-meta is-required">Required</div>
                </div>
                <input className="wx-m-input" value={title} onChange={(e) => setTitle(e.target.value)}
                  placeholder="e.g. Team meeting tomorrow 10am" autoFocus />
              </div>
              <div className="wx-m-field">
                <div className="wx-m-field-head">
                  <div className="wx-m-field-label">Message</div>
                  <div className="wx-m-field-meta">Optional</div>
                </div>
                <div className="wx-m-textarea-shell">
                  <textarea rows={5} value={body} onChange={(e) => setBody(e.target.value)}
                    placeholder="Write the announcement. Keep it short — it appears in the notification body." />
                </div>
              </div>
              <div className="wx-m-field">
                <div className="wx-m-field-head">
                  <div className="wx-m-field-label">Schedule</div>
                  <div className="wx-m-field-meta">Optional — leave blank to send now</div>
                </div>
                <input type="datetime-local" className="wx-m-input" value={schedule} onChange={(e) => setSched(e.target.value)} />
              </div>

              {/* Poll opt-in — like WhatsApp poll, only the author sees results */}
              <label className={`wx-m-optin ${pollOn ? 'is-active' : ''}`}>
                <input type="checkbox" checked={pollOn} onChange={(e) => setPollOn(e.target.checked)} />
                <div>
                  <div className="wx-m-optin-title">Collect responses (poll)</div>
                  <div className="wx-m-optin-sub">
                    Recipients pick one of your options. Only you see who picked what.
                  </div>
                </div>
              </label>

              {pollOn && (
                <div className="wx-m-field">
                  <div className="wx-m-field-head">
                    <div className="wx-m-field-label">Response options</div>
                    <div className="wx-m-field-meta">1 to 6 buttons</div>
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                    {pollOptions.map((o, i) => (
                      <div key={o.id} style={{ display: 'flex', gap: 6 }}>
                        <input
                          className="wx-m-input"
                          style={{ flex: 1 }}
                          value={o.label}
                          onChange={(e) => updateOption(o.id, e.target.value)}
                          placeholder={i === 0 ? 'e.g. Acknowledged' : 'Add another…'}
                        />
                        <button type="button"
                          className="wx-btn wx-btn-ghost"
                          disabled={pollOptions.length <= 1}
                          onClick={() => removeOption(o.id)}
                          aria-label="Remove">
                          <XIcon width="13" height="13" />
                        </button>
                      </div>
                    ))}
                    {pollOptions.length < 6 && (
                      <button type="button" className="wx-btn wx-btn-ghost"
                        onClick={addOption} style={{ alignSelf: 'flex-start' }}>
                        <PlusIcon width="13" height="13" /> Add option
                      </button>
                    )}
                  </div>
                </div>
              )}
            </>
          )}

          {step === 1 && (
            <>
              <div className="wx-m-field">
                <div className="wx-m-field-head">
                  <div className="wx-m-field-label">Audience</div>
                  <div className="wx-m-field-meta">
                    {allowed.length === 1 ? '1 option available' : `${allowed.length} options available`}
                  </div>
                </div>
                <div className="wx-m-cards" data-cols="2">
                  {allowed.map((t) => {
                    const Icon = t === 'all' ? UsersIcon
                               : t === 'role' ? ShieldIcon
                               : t === 'users' ? UserIcon
                               : t === 'my_team' ? UsersIcon
                               : StoreIcon;
                    return (
                      <button key={t} type="button"
                        className={`wx-m-card ${target === t ? 'is-active' : ''}`}
                        onClick={() => setTarget(t)}>
                        <div className="wx-m-card-icon"><Icon width="15" height="15" /></div>
                        <div className="wx-m-card-main">
                          <div className="wx-m-card-title">{BROADCAST_TARGETS[t].label}</div>
                          <div className="wx-m-card-sub">{BROADCAST_TARGETS[t].desc}</div>
                        </div>
                        <span className="wx-m-card-check"><CheckIcon width="11" height="11" /></span>
                      </button>
                    );
                  })}
                </div>
              </div>

              {target === 'role' && (
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                  {ROLES.filter((r) => r.value !== 'boss').map((r) => (
                    <button key={r.value} type="button"
                      className={`wx-role-chip ${roles.includes(r.value) ? 'wx-role-chip-active' : ''}`}
                      onClick={() => setRoles((cur) => cur.includes(r.value) ? cur.filter((x) => x !== r.value) : [...cur, r.value])}>
                      {r.label}
                    </button>
                  ))}
                </div>
              )}

              {target === 'users' && (
                <div style={{ maxHeight: 260, overflow: 'auto', border: '1px solid var(--border-subtle)', borderRadius: 10 }}>
                  {candidates.length === 0 ? (
                    <div style={{ padding: 16, fontSize: 13, color: 'var(--text-muted)' }}>
                      No candidates available.
                    </div>
                  ) : candidates.map((u) => {
                    const on = userIds.includes(u.id);
                    return (
                      <label key={u.id} style={{
                        display: 'flex', alignItems: 'center', gap: 10,
                        padding: '8px 12px', cursor: 'pointer',
                        borderBottom: '1px solid var(--border-subtle)',
                        background: on ? 'var(--accent-soft)' : 'transparent',
                      }}>
                        <input type="checkbox" checked={on}
                          onChange={() => setUserIds((cur) => on ? cur.filter((x) => x !== u.id) : [...cur, u.id])} />
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ fontSize: 13, fontWeight: 600 }}>{u.display_name}</div>
                          <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>{u.email} · {u.role}</div>
                        </div>
                      </label>
                    );
                  })}
                </div>
              )}

              {target === 'brand' && (
                <select className="wx-m-input" value={brandId} onChange={(e) => setBrandId(e.target.value)}>
                  <option value="">— pick a brand —</option>
                  {brands.map((b) => <option key={b.id} value={b.id}>{b.brand_name}</option>)}
                </select>
              )}

              {target === 'my_team' && (
                <div style={{
                  padding: 12, background: 'var(--surface-1)',
                  border: '1px solid var(--border-subtle)', borderRadius: 8,
                  fontSize: 12.5, color: 'var(--text-secondary)',
                }}>
                  Goes to your {candidates.length} direct report{candidates.length === 1 ? '' : 's'}:{' '}
                  {candidates.slice(0, 4).map((u) => u.display_name).join(', ')}
                  {candidates.length > 4 && ` …and ${candidates.length - 4} more`}
                </div>
              )}
            </>
          )}

          {step === 2 && (
            <div className="wx-m-review">
              <Review k="Title"   v={title || '—'} />
              {body && <Review k="Message" v={body.length > 200 ? body.slice(0, 200) + '…' : body} />}
              <Review k="Audience" v={targetDescription(target, roles, userIds, candidates, brands, brandId)} />
              <Review k="Recipients" v={recipientCount === null ? 'calculating…' : `${recipientCount}`} />
              {schedule && <Review k="When" v={new Date(schedule).toLocaleString()} />}
              {pollOn && (
                <Review k="Poll" v={
                  pollOptions.filter((o) => (o.label || '').trim()).map((o) => o.label).join(' · ')
                  || '—'
                } />
              )}
            </div>
          )}
        </div>

        <div className="wx-m-foot">
          <div className="wx-m-kbd-hints">
            <kbd>Esc</kbd> cancel <span>·</span> <kbd>⌘</kbd><kbd>↵</kbd> {step < 2 ? 'next' : 'send'}
          </div>
          <div className="wx-m-foot-actions">
            {step > 0 && (
              <button type="button" className="wx-btn wx-btn-ghost" onClick={() => setStep(step - 1)} disabled={saving}>Back</button>
            )}
            {step < 2 ? (
              <button type="button" className="wx-btn wx-btn-primary"
                onClick={() => setStep(step + 1)} disabled={!canAdvance()}>Continue</button>
            ) : (
              <button type="button" className="wx-btn wx-btn-primary" onClick={send} disabled={saving}>
                {saving
                  ? <><span className="wx-spinner" /> Sending…</>
                  : <><CheckIcon width="14" height="14" /> {schedule ? 'Schedule' : 'Send'}</>}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function targetDescription(target, roles, userIds, candidates, brands, brandId) {
  if (target === 'all')     return 'Everyone in the workspace';
  if (target === 'my_team') return 'Your direct reports';
  if (target === 'role')    return `Roles: ${roles.map((r) => r.toUpperCase()).join(', ') || '—'}`;
  if (target === 'users') {
    const names = candidates.filter((c) => userIds.includes(c.id)).map((c) => c.display_name);
    return names.length > 3 ? `${names.slice(0, 3).join(', ')} +${names.length - 3} more` : names.join(', ');
  }
  if (target === 'brand') return brands.find((b) => b.id === brandId)?.brand_name || 'Brand team';
  return target;
}

function Review({ k, v }) {
  return (
    <div className="wx-m-review-row">
      <div className="wx-m-review-k">{k}</div>
      <div className="wx-m-review-v">{v}</div>
    </div>
  );
}

// ============================================================
// Detail modal — author sees poll aggregates; recipient votes
// ============================================================
function BroadcastDetailModal({ broadcast, meId, onClose, onChanged }) {
  const isAuthor = broadcast.author_id === meId;
  const hasPoll  = (broadcast.response_options || []).length > 0;
  const qc = useQueryClient();

  const { data: myResponse } = useQuery({
    queryKey: ['broadcast', broadcast.id, 'me', meId],
    queryFn: () => getMyResponse(broadcast.id, meId),
    enabled: !!meId && hasPoll && !isAuthor,
  });
  const { data: allResponses = [] } = useQuery({
    queryKey: ['broadcast', broadcast.id, 'responses'],
    queryFn: () => listResponses(broadcast.id),
    enabled: hasPoll && isAuthor,
  });
  const { data: recipients = [] } = useQuery({
    queryKey: ['broadcast', broadcast.id, 'recipients'],
    queryFn: () => listRecipients(broadcast),
    enabled: hasPoll && isAuthor,
  });

  const [busy, setBusy]       = useState(false);
  const [err, setErr]         = useState('');
  const [filterTab, setFilter] = useState('all');

  async function vote(opt) {
    setBusy(true); setErr('');
    try {
      await submitResponse(broadcast.id, opt);
      qc.invalidateQueries({ queryKey: ['broadcast', broadcast.id] });
      onChanged();
    } catch (e) { setErr(e.message); }
    finally { setBusy(false); }
  }

  async function pingOne(userId) {
    try {
      await renotifyUser(broadcast.id, userId);
    } catch (e) { setErr(e.message); }
  }
  async function pingAllPending() {
    try {
      const n = await renotifyPending(broadcast.id);
      alert(`Pinged ${n} pending responder${n === 1 ? '' : 's'}.`);
    } catch (e) { setErr(e.message); }
  }

  // Aggregate counts per option
  const counts = useMemo(() => {
    const out = {};
    for (const o of (broadcast.response_options || [])) out[o.id] = 0;
    for (const r of allResponses) {
      if (out[r.option_id] != null) out[r.option_id] += 1;
    }
    return out;
  }, [allResponses, broadcast.response_options]);

  const respondedIds = useMemo(() => new Set(allResponses.map((r) => r.user_id)), [allResponses]);
  const pendingRecipients = useMemo(
    () => recipients.filter((r) => !respondedIds.has(r.id)),
    [recipients, respondedIds],
  );

  const filteredRecipients =
    filterTab === 'responded' ? recipients.filter((r) => respondedIds.has(r.id))
  : filterTab === 'pending'   ? pendingRecipients
                               : recipients;

  return (
    <div className="wx-modal-backdrop wx-m-backdrop" onClick={onClose}>
      <div className="wx-modal" style={{ maxWidth: 760 }} onClick={(e) => e.stopPropagation()}>
        <div className="wx-m-head">
          <div className="wx-m-head-icon"><MegaphoneIcon width="18" height="18" /></div>
          <div className="wx-m-head-text">
            <div className="wx-m-head-title">{broadcast.title}</div>
            <div className="wx-m-head-sub">
              {broadcast.author?.display_name || '—'} · {new Date(broadcast.created_at).toLocaleString()}
            </div>
          </div>
          <button type="button" className="wx-m-head-close" onClick={onClose}><XIcon width="14" height="14" /></button>
        </div>

        <div className="wx-m-body">
          {err && <div className="wx-alert wx-alert-danger"><AlertIcon width="14" height="14" /> <span>{err}</span></div>}

          {broadcast.body && (
            <div style={{ fontSize: 13.5, lineHeight: 1.5, whiteSpace: 'pre-wrap' }}>
              {broadcast.body}
            </div>
          )}

          {!hasPoll && (
            <div style={{ fontSize: 12.5, color: 'var(--text-muted)' }}>
              No response options — this is an announcement only.
            </div>
          )}

          {/* ----- Recipient view ----- */}
          {hasPoll && !isAuthor && (
            <div>
              <div style={{ fontSize: 11.5, color: 'var(--text-muted)', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 8 }}>
                {myResponse ? 'Your response' : 'Tap to respond'}
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {(broadcast.response_options || []).map((opt) => {
                  const selected = myResponse?.option_id === opt.id;
                  return (
                    <button key={opt.id} type="button"
                      className={`wx-m-card ${selected ? 'is-active' : ''}`}
                      onClick={() => vote(opt)}
                      disabled={busy}
                      style={{ display: 'block', textAlign: 'left' }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                        <span className="wx-m-card-title">{opt.label}</span>
                        {selected && <CheckIcon width="14" height="14" style={{ color: 'var(--accent)' }} />}
                      </div>
                    </button>
                  );
                })}
              </div>
              {myResponse && (
                <div style={{ fontSize: 11.5, color: 'var(--text-muted)', marginTop: 8 }}>
                  You can change your answer — just tap another option.
                </div>
              )}
            </div>
          )}

          {/* ----- Author (poll) view ----- */}
          {hasPoll && isAuthor && (
            <>
              <div>
                <div style={{
                  display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                  marginBottom: 10,
                }}>
                  <div style={{ fontSize: 11.5, color: 'var(--text-muted)', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                    Results · {allResponses.length} / {recipients.length} responded
                  </div>
                  {pendingRecipients.length > 0 && (
                    <button className="wx-btn wx-btn-ghost" onClick={pingAllPending}>
                      <RefreshIcon width="13" height="13" /> Re-notify pending
                    </button>
                  )}
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  {(broadcast.response_options || []).map((opt) => {
                    const n   = counts[opt.id] || 0;
                    const total = allResponses.length || 1;
                    const pct = Math.round((n / total) * 100);
                    return (
                      <div key={opt.id} style={{
                        padding: 10, border: '1px solid var(--border-subtle)',
                        borderRadius: 8, background: 'var(--surface-1)',
                      }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12.5, fontWeight: 700 }}>
                          <span>{opt.label}</span>
                          <span style={{ color: 'var(--text-muted)' }}>{n} · {pct}%</span>
                        </div>
                        <div style={{ height: 6, background: 'var(--surface-2)', borderRadius: 999, marginTop: 6, overflow: 'hidden' }}>
                          <div style={{ width: `${pct}%`, height: '100%', background: 'var(--accent)' }} />
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>

              <div>
                <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', marginBottom: 8 }}>
                  <TabChip active={filterTab === 'all'}       onClick={() => setFilter('all')}       label={`All · ${recipients.length}`} />
                  <TabChip active={filterTab === 'responded'} onClick={() => setFilter('responded')} label={`Responded · ${allResponses.length}`} />
                  <TabChip active={filterTab === 'pending'}   onClick={() => setFilter('pending')}   label={`Pending · ${pendingRecipients.length}`} />
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 4, maxHeight: 260, overflow: 'auto' }}>
                  {filteredRecipients.length === 0 ? (
                    <div style={{ fontSize: 12.5, color: 'var(--text-muted)', padding: 12 }}>No one in this bucket.</div>
                  ) : filteredRecipients.map((u) => {
                    const resp = allResponses.find((r) => r.user_id === u.id);
                    return (
                      <div key={u.id} style={{
                        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                        padding: '8px 12px', borderRadius: 8,
                        background: resp
                          ? 'color-mix(in srgb, var(--success) 10%, var(--surface-1))'
                          : 'color-mix(in srgb, var(--warning) 10%, var(--surface-1))',
                        border: '1px solid var(--border-subtle)',
                      }}>
                        <div style={{ minWidth: 0 }}>
                          <div style={{ fontSize: 13, fontWeight: 600 }}>{u.display_name}</div>
                          <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                            {u.role?.toUpperCase()}
                            {resp && ` · ${resp.option_label || resp.option_id}`}
                          </div>
                        </div>
                        {!resp && (
                          <button className="wx-btn wx-btn-ghost" onClick={() => pingOne(u.id)}>
                            <RefreshIcon width="12" height="12" /> Ping
                          </button>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            </>
          )}
        </div>

        <div className="wx-m-foot">
          <div className="wx-m-kbd-hints"><kbd>Esc</kbd> close</div>
          <div className="wx-m-foot-actions">
            <button className="wx-btn wx-btn-primary" onClick={onClose}>Done</button>
          </div>
        </div>
      </div>
    </div>
  );
}

function TabChip({ active, onClick, label }) {
  return (
    <button type="button" onClick={onClick}
      className={`wx-role-chip ${active ? 'wx-role-chip-active' : ''}`}>
      {label}
    </button>
  );
}
