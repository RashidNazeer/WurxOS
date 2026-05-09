import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '../../contexts/AuthContext';
import {
  listChanges, getChange, submitChange, updateChange, deleteChange,
  listChangeThread, postChangeMessage, listPotentialOwners, listKbForPicker,
  SOP_TYPES, CHANGE_STATUSES, CHANGE_PRIORITIES, OWNER_TRANSITIONS,
  sopTypeMeta, changeStatusMeta, changePriorityMeta,
} from '../../lib/changesApi';
import {
  PlusIcon, AlertIcon, RefreshIcon, SearchIcon, XIcon, CheckIcon,
  ArrowLeftRightIcon, MessageIcon, TrashIcon,
} from '../../components/common/Icon';
import '../../styles/table.css';

export default function ChangesPage() {
  const { user, profile } = useAuth();
  const role = profile?.role;
  const isBoss = role === 'boss';
  const isDev  = role === 'developer';
  // Boss submits via the same flow as everyone else — request enters as
  // 'pending' and goes through the standard approval lifecycle.
  const canSubmit = ['boss', 'tl', 'ol', 'pctl', 'apc', 'ipc'].includes(role);

  // Tabs: non-boss see My / Assigned; boss sees All / Pending
  const defaultTab = isBoss ? 'all' : 'mine';
  const [tab, setTab]     = useState(defaultTab);
  const [statusF, setStatusF]   = useState('all');
  const [sopF, setSopF]   = useState('all');
  const [q, setQ]         = useState('');
  const [showForm, setShowForm]     = useState(false);
  const [selected, setSelected]     = useState(null);

  const qc = useQueryClient();
  const { data: rows = [], isPending, error, refetch } = useQuery({
    queryKey: ['changes', { tab, statusF, sopF, q, uid: user?.id }],
    queryFn: () => listChanges({ scope: tab, status: statusF, sopType: sopF, q }),
    enabled: !!user?.id,
  });

  const stats = useMemo(() => {
    const out = { total: rows.length };
    for (const s of CHANGE_STATUSES) out[s.key] = 0;
    for (const r of rows) out[r.status] = (out[r.status] || 0) + 1;
    return out;
  }, [rows]);

  const tabs = isBoss
    ? [{ k: 'all', label: 'All changes' }, { k: 'mine', label: 'Submitted by me' }]
    : [{ k: 'mine', label: 'My requests' }, { k: 'assigned', label: 'Assigned to me' }];

  return (
    <>
      <div className="page-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: 12 }}>
        <div>
          <h1 className="page-title">Changes</h1>
          <p className="page-subtitle">SOP and process change requests.</p>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="wx-btn wx-btn-ghost" onClick={() => refetch()} title="Refresh">
            <RefreshIcon width="15" height="15" />
          </button>
          {canSubmit && (
            <button className="wx-btn wx-btn-primary" onClick={() => setShowForm(true)}>
              <PlusIcon width="15" height="15" /> Submit change
            </button>
          )}
        </div>
      </div>

      {error && (
        <div className="wx-alert wx-alert-danger" style={{ marginBottom: 14 }}>
          <AlertIcon width="16" height="16" /> <span>{error.message}</span>
        </div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(130px, 1fr))', gap: 10, marginBottom: 14 }}>
        <Stat label="Total"       value={stats.total}       tone="#1f2937" />
        <Stat label="Pending"     value={stats.pending}     tone="#92400e" />
        <Stat label="In flight"   value={(stats.in_progress || 0) + (stats.paused || 0) + (stats.delayed || 0)} tone="#1e40af" />
        <Stat label="Completed"   value={stats.completed}   tone="#5b21b6" />
        <Stat label="Implemented" value={stats.implemented} tone="#14532d" />
      </div>

      <div style={{ display: 'flex', gap: 6, marginBottom: 12, flexWrap: 'wrap' }}>
        {tabs.map((t) => (
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
          <input className="wx-input" placeholder="Search title / code…" style={{ paddingLeft: 32 }}
            value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <select className="wx-input" style={{ maxWidth: 180 }} value={sopF} onChange={(e) => setSopF(e.target.value)}>
          <option value="all">All SOP types</option>
          {SOP_TYPES.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
        </select>
        <select className="wx-input" style={{ maxWidth: 170 }} value={statusF} onChange={(e) => setStatusF(e.target.value)}>
          <option value="all">All statuses</option>
          {CHANGE_STATUSES.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
        </select>
      </div>

      {isPending ? (
        <div style={{ padding: 30, textAlign: 'center', color: '#64748b' }}><span className="wx-spinner" /> Loading…</div>
      ) : rows.length === 0 ? (
        <div style={{ padding: 40, textAlign: 'center', color: '#94a3b8', border: '1px dashed #e5e7eb', borderRadius: 10, background: '#fff' }}>
          <ArrowLeftRightIcon width="28" height="28" />
          <div style={{ marginTop: 8, fontWeight: 600, color: '#475569' }}>No changes yet.</div>
        </div>
      ) : (
        <div style={{ display: 'grid', gap: 10 }}>
          {rows.map((r) => <ChangeCard key={r.id} row={r} onOpen={() => setSelected(r.id)} />)}
        </div>
      )}

      {showForm && (
        <SubmitModal onClose={() => setShowForm(false)} onDone={() => { setShowForm(false); refetch(); }} />
      )}
      {selected && (
        <DetailModal id={selected}
          isBoss={isBoss} isDev={isDev}
          onClose={() => setSelected(null)}
          onChanged={() => { refetch(); }} />
      )}
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

function ChangeCard({ row, onOpen }) {
  const s = changeStatusMeta(row.status);
  const sop = row.sop_type ? sopTypeMeta(row.sop_type) : null;
  const p = changePriorityMeta(row.priority);
  return (
    <button onClick={onOpen} style={{
      all: 'unset', cursor: 'pointer',
      display: 'grid', gridTemplateColumns: '1fr auto', gap: 12,
      padding: 14, borderRadius: 10, border: '1px solid #e5e7eb', background: '#fff',
    }}>
      <div style={{ minWidth: 0 }}>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 4, flexWrap: 'wrap' }}>
          <strong style={{ fontSize: 14, color: '#0f172a' }}>{row.title}</strong>
          <span style={{ fontSize: 11, color: '#64748b', fontFamily: 'monospace' }}>{row.change_code}</span>
          {sop ? (
            <span style={{ padding: '2px 8px', borderRadius: 999, fontSize: 11, fontWeight: 600, background: sop.color + '22', color: sop.color }}>{sop.label}</span>
          ) : (
            <span style={{ padding: '2px 8px', borderRadius: 999, fontSize: 11, fontWeight: 600, background: 'var(--surface-2)', color: 'var(--text-muted)' }}>General</span>
          )}
        </div>
        <div style={{ fontSize: 12, color: '#64748b' }}>
          {row.submitted_by_name || '—'} → owner: <strong>{row.owner_name || '—'}</strong>
          {' · '}{new Date(row.created_at).toLocaleDateString()}
          {row.affected_kb_ids?.length ? ` · ${row.affected_kb_ids.length} SOP(s) affected` : ''}
        </div>
      </div>
      <div style={{ display: 'flex', gap: 6, alignSelf: 'center', flexWrap: 'wrap' }}>
        {p && <span style={{ padding: '3px 10px', borderRadius: 999, fontSize: 11, fontWeight: 700, background: p.bg, color: p.fg }}>{p.label}</span>}
        <span style={{ padding: '3px 10px', borderRadius: 999, fontSize: 11, fontWeight: 700, background: s.bg, color: s.fg }}>{s.label}</span>
      </div>
    </button>
  );
}

// ============================================================
// Submit modal
// ============================================================
function SubmitModal({ onClose, onDone }) {
  const [title, setTitle] = useState('');
  // affectsSop tri-state: null=not chosen, true=affects SOP, false=general.
  // Mirrors v1's Yes/No toggle. SOP picker is hidden until user picks Yes.
  const [affectsSop, setAffectsSop] = useState(null);
  const [sopType, setSopType] = useState('');
  const [currentProcess, setCurrentProcess] = useState('');
  const [proposedChange, setProposedChange] = useState('');
  const [expectedImpact, setExpectedImpact] = useState('');
  const [risks, setRisks] = useState('');
  const [ownerId, setOwnerId] = useState('');
  const [priority, setPriority] = useState('');
  const [selectedKbIds, setSelectedKbIds] = useState([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const { data: owners = [] } = useQuery({
    queryKey: ['changes', 'owners'], queryFn: listPotentialOwners,
  });
  const { data: kbRows = [] } = useQuery({
    queryKey: ['changes', 'kb-picker'], queryFn: listKbForPicker,
  });

  // Valid when: Yes/No has been chosen, AND if Yes then sopType is picked.
  const ok = title.trim()
    && affectsSop !== null
    && (affectsSop === false || sopType)
    && currentProcess.trim()
    && proposedChange.trim()
    && ownerId;
  const ownerRow = owners.find((o) => o.id === ownerId);
  const kbFiltered = useMemo(() => {
    // Pragmatic mapping: if sopType is selected, prefer KB articles
    // whose category matches a human-readable version of the type.
    if (!sopType) return kbRows;
    const map = {
      delivery_roadmap: ['delivery', 'roadmap'],
      policies:         ['policy', 'policies'],
      operational:      ['operational', 'sop'],
      training:         ['training'],
    };
    const tokens = map[sopType] || [];
    return kbRows.filter((k) => tokens.some((t) => (k.category || '').toLowerCase().includes(t)));
  }, [kbRows, sopType]);

  function toggleKb(id, title) {
    setSelectedKbIds((prev) => prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]);
  }

  async function save() {
    if (!ok || busy) return;
    setBusy(true); setErr('');
    try {
      // General-change branch: don't send sopType or KB picks.
      const ids    = affectsSop ? selectedKbIds : [];
      const titles = affectsSop
        ? ids.map((id) => kbRows.find((k) => k.id === id)?.title || '').filter(Boolean)
        : [];
      await submitChange({
        title,
        sopType: affectsSop ? sopType : null,
        currentProcess, proposedChange, expectedImpact, risks,
        ownerId, ownerName: ownerRow?.display_name || null,
        priority: priority || null,
        affectedKbIds: ids, affectedKbTitles: titles,
      });
      onDone();
    } catch (e) { setErr(e.message); }
    finally { setBusy(false); }
  }

  return (
    <div className="wx-modal-backdrop" onClick={onClose}>
      <div className="wx-modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 640 }}>
        <div className="wx-modal-header">
          <div className="wx-modal-title">Submit change</div>
          <button className="shell-icon-btn" onClick={onClose}><XIcon width="16" height="16" /></button>
        </div>
        <div className="wx-modal-body">
          {err && <div className="wx-alert wx-alert-danger" style={{ marginBottom: 10 }}>{err}</div>}

          <div className="wx-label">Change title</div>
          <input className="wx-input" value={title} onChange={(e) => setTitle(e.target.value)} style={{ marginBottom: 10 }} />

          {/* Affects-SOP Yes/No — replaces v1's always-required SOP picker.
              Picking "No" hides the SOP-specific fields and the change is
              recorded as a general change. */}
          <div className="wx-label">Will this change affect any SOP?</div>
          <div style={{ display: 'flex', gap: 8, marginBottom: 10 }}>
            <button type="button" className="wx-btn"
              onClick={() => setAffectsSop(true)}
              style={{
                flex: 1,
                background: affectsSop === true ? 'var(--success)' : 'transparent',
                color:      affectsSop === true ? '#fff' : 'var(--success)',
                border:     affectsSop === true ? 'none' : '1px solid color-mix(in srgb, var(--success) 35%, transparent)',
                fontWeight: 600,
              }}>
              ✓ Yes — affects SOP
            </button>
            <button type="button" className="wx-btn"
              onClick={() => {
                setAffectsSop(false);
                // Clear SOP-specific selections when switching to "No"
                setSopType('');
                setSelectedKbIds([]);
              }}
              style={{
                flex: 1,
                background: affectsSop === false ? 'var(--text-secondary)' : 'transparent',
                color:      affectsSop === false ? '#fff' : 'var(--text-secondary)',
                border:     affectsSop === false ? 'none' : '1px solid var(--border-default)',
                fontWeight: 600,
              }}>
              − No — general change
            </button>
          </div>

          {/* SOP picker — only when "Yes" is chosen */}
          {affectsSop === true && (
            <>
              <div className="wx-label">SOP affected</div>
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 10 }}>
                {SOP_TYPES.map((s) => (
                  <button key={s.key} className="wx-btn"
                    onClick={() => setSopType(s.key)}
                    style={{
                      background: sopType === s.key ? s.color : 'transparent',
                      color: sopType === s.key ? '#fff' : s.color,
                      border: sopType === s.key ? 'none' : `1px solid ${s.color}55`,
                      fontWeight: 600,
                    }}>{s.label}</button>
                ))}
              </div>

              {sopType && kbFiltered.length > 0 && (
                <>
                  <div className="wx-label">Affected SOP documents (optional)</div>
                  <div style={{ maxHeight: 160, overflowY: 'auto', border: '1px solid var(--border-subtle)', borderRadius: 8, padding: 8, marginBottom: 10 }}>
                    {kbFiltered.map((k) => (
                      <label key={k.id} style={{ display: 'flex', gap: 8, alignItems: 'center', padding: 6, cursor: 'pointer' }}>
                        <input type="checkbox" checked={selectedKbIds.includes(k.id)} onChange={() => toggleKb(k.id, k.title)} />
                        <span style={{ fontSize: 13 }}>{k.title} <span style={{ color: 'var(--text-muted)', fontSize: 11 }}>· {k.category}</span></span>
                      </label>
                    ))}
                  </div>
                </>
              )}
            </>
          )}

          <div className="wx-label">Current process</div>
          <textarea className="wx-input" rows="3" value={currentProcess} onChange={(e) => setCurrentProcess(e.target.value)} placeholder="What happens today?" style={{ marginBottom: 10 }} />

          <div className="wx-label">Proposed change</div>
          <textarea className="wx-input" rows="3" value={proposedChange} onChange={(e) => setProposedChange(e.target.value)} placeholder="What should change, and why?" style={{ marginBottom: 10 }} />

          <div className="wx-label">Expected impact (optional)</div>
          <textarea className="wx-input" rows="2" value={expectedImpact} onChange={(e) => setExpectedImpact(e.target.value)} style={{ marginBottom: 10 }} />

          <div className="wx-label">Risks (optional)</div>
          <textarea className="wx-input" rows="2" value={risks} onChange={(e) => setRisks(e.target.value)} style={{ marginBottom: 10 }} />

          <div className="wx-label">Implementation owner</div>
          <select className="wx-input" value={ownerId} onChange={(e) => setOwnerId(e.target.value)} style={{ marginBottom: 10 }}>
            <option value="">Select someone…</option>
            {owners.map((o) => <option key={o.id} value={o.id}>{o.display_name} ({o.role})</option>)}
          </select>

          <div className="wx-label">Priority (optional)</div>
          <div style={{ display: 'flex', gap: 6 }}>
            {CHANGE_PRIORITIES.map((p) => (
              <button key={p.key} className="wx-btn"
                onClick={() => setPriority(priority === p.key ? '' : p.key)}
                style={{
                  background: priority === p.key ? p.fg : p.bg,
                  color: priority === p.key ? '#fff' : p.fg,
                  border: 'none', fontWeight: 600,
                }}>{p.label}</button>
            ))}
          </div>
        </div>
        <div className="wx-modal-footer">
          <button className="wx-btn wx-btn-ghost" onClick={onClose} disabled={busy}>Cancel</button>
          <button className="wx-btn wx-btn-primary" onClick={save} disabled={!ok || busy}>
            {busy ? <><span className="wx-spinner" /> Submitting…</> : 'Submit'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ============================================================
// Detail modal — read, owner transitions, boss review, thread
// ============================================================
function DetailModal({ id, isBoss, isDev, onClose, onChanged }) {
  const { user, profile } = useAuth();
  const qc = useQueryClient();
  const [showReview, setShowReview] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const { data: row, refetch } = useQuery({
    queryKey: ['change', id],
    queryFn: () => getChange(id),
    refetchInterval: 8000,
  });

  if (!row) {
    return (
      <div className="wx-modal-backdrop" onClick={onClose}>
        <div className="wx-modal" onClick={(e) => e.stopPropagation()}>
          <div className="wx-modal-body"><span className="wx-spinner" /> Loading…</div>
        </div>
      </div>
    );
  }

  const s = changeStatusMeta(row.status);
  const sop = row.sop_type ? sopTypeMeta(row.sop_type) : null;
  const p = changePriorityMeta(row.priority);
  const isOwner = row.owner_id === user?.id;
  const isSubmitter = row.submitted_by === user?.id;
  const canOwnerAct = isOwner && OWNER_TRANSITIONS[row.status]?.length;
  const canBossAct = isBoss || isDev;
  const canDelete = isBoss || isDev || (isSubmitter && row.status === 'pending');

  async function ownerTransition(next) {
    setBusy(true); setErr('');
    try {
      const patch = { status: next };
      if (next === 'completed') patch.completed_at = new Date().toISOString();
      await updateChange(row.id, patch);
      await refetch(); onChanged();
    } catch (e) { setErr(e.message); }
    finally { setBusy(false); }
  }

  async function remove() {
    if (!confirm('Delete this change? This cannot be undone.')) return;
    try { await deleteChange(row.id); onChanged(); onClose(); }
    catch (e) { setErr(e.message); }
  }

  return (
    <div className="wx-modal-backdrop" onClick={onClose}>
      <div className="wx-modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 780 }}>
        <div className="wx-modal-header">
          <div>
            <div className="wx-modal-title" style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              {row.title}
              <span style={{ padding: '3px 10px', borderRadius: 999, fontSize: 11, fontWeight: 700, background: s.bg, color: s.fg }}>{s.label}</span>
            </div>
            <div style={{ fontSize: 12, color: '#64748b', display: 'flex', gap: 8, alignItems: 'center', marginTop: 4 }}>
              <span style={{ fontFamily: 'monospace' }}>{row.change_code}</span>
              {sop ? (
                <span style={{ padding: '1px 8px', borderRadius: 999, fontSize: 11, fontWeight: 600, background: sop.color + '22', color: sop.color }}>{sop.label}</span>
              ) : (
                <span style={{ padding: '1px 8px', borderRadius: 999, fontSize: 11, fontWeight: 600, background: 'var(--surface-2)', color: 'var(--text-muted)' }}>General</span>
              )}
              {p && <span style={{ padding: '1px 8px', borderRadius: 999, fontSize: 11, fontWeight: 700, background: p.bg, color: p.fg }}>{p.label}</span>}
            </div>
          </div>
          <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            {canDelete && (
              <button className="shell-icon-btn" onClick={remove} title="Delete"><TrashIcon width="16" height="16" /></button>
            )}
            <button className="shell-icon-btn" onClick={onClose}><XIcon width="16" height="16" /></button>
          </div>
        </div>

        <div className="wx-modal-body">
          {err && <div className="wx-alert wx-alert-danger" style={{ marginBottom: 10 }}>{err}</div>}

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 10, marginBottom: 12, fontSize: 12 }}>
            <Meta label="Submitted by"    value={row.submitted_by_name || '—'} />
            <Meta label="Date"            value={new Date(row.created_at).toLocaleDateString()} />
            <Meta label="Current version" value={row.current_version || '—'} />
            <Meta label="New version"     value={row.new_version || '—'} />
            <Meta label="Owner"           value={row.owner_name || '—'} />
            <Meta label="Approved by"     value={row.approved_by_name || '—'} />
            <Meta label="Start"           value={row.implementation_start || '—'} />
            <Meta label="End"             value={row.implementation_end   || '—'} />
          </div>

          {row.affected_kb_titles?.length > 0 && (
            <>
              <div className="wx-label">Affected SOP documents</div>
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 12 }}>
                {row.affected_kb_titles.map((t, i) => (
                  <span key={i} style={{ padding: '3px 10px', borderRadius: 999, fontSize: 11, background: '#f1f5f9', color: '#475569' }}>{t}</span>
                ))}
              </div>
            </>
          )}

          <Block label="Current process" text={row.current_process} />
          <Block label="Proposed change" text={row.proposed_change} />
          {row.expected_impact && <Block label="Expected impact" text={row.expected_impact} />}
          {row.risks           && <Block label="Risks"           text={row.risks} />}

          {row.status === 'rejected' && row.rejection_reason && (
            <div style={{ padding: 10, background: '#fef2f2', color: '#991b1b', borderRadius: 8, marginBottom: 10 }}>
              <strong>Rejection reason:</strong> {row.rejection_reason}
            </div>
          )}
          {row.boss_comment && (
            <div style={{ padding: 10, background: '#eff6ff', color: '#1e40af', borderRadius: 8, marginBottom: 10 }}>
              <strong>Boss comment:</strong> {row.boss_comment}
            </div>
          )}

          {canOwnerAct && (
            <div style={{ padding: 10, background: '#f0fdf4', border: '1px solid #bbf7d0', borderRadius: 8, marginBottom: 12 }}>
              <div style={{ fontSize: 12, fontWeight: 600, color: '#166534', marginBottom: 6 }}>
                You are the owner — advance the work:
              </div>
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                {OWNER_TRANSITIONS[row.status].map((next) => {
                  const meta = changeStatusMeta(next);
                  return (
                    <button key={next} className="wx-btn" onClick={() => ownerTransition(next)}
                      disabled={busy}
                      style={{ background: meta.bg, color: meta.fg, border: `1px solid ${meta.fg}33`, fontWeight: 600 }}>
                      {meta.label}
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          {canBossAct && !showReview && (
            <button className="wx-btn wx-btn-primary" onClick={() => setShowReview(true)} style={{ marginBottom: 12 }}>
              Review decision
            </button>
          )}
          {canBossAct && showReview && (
            <ReviewForm row={row}
              onCancel={() => setShowReview(false)}
              onSaved={async () => { setShowReview(false); await refetch(); onChanged(); }} />
          )}

          <ChangeThread changeId={row.id} />
        </div>
      </div>
    </div>
  );
}

function Meta({ label, value }) {
  return (
    <div>
      <div style={{ fontSize: 11, color: '#64748b', textTransform: 'uppercase', letterSpacing: 0.3 }}>{label}</div>
      <div style={{ fontSize: 13, fontWeight: 600, color: '#0f172a', marginTop: 2 }}>{value}</div>
    </div>
  );
}
function Block({ label, text }) {
  return (
    <>
      <div className="wx-label">{label}</div>
      <div style={{ padding: 10, background: '#f8fafc', borderRadius: 8, whiteSpace: 'pre-wrap', marginBottom: 12, fontSize: 13 }}>{text}</div>
    </>
  );
}

// ---- Boss review form (inline) ----
function ReviewForm({ row, onCancel, onSaved }) {
  const { user, profile } = useAuth();
  const [status, setStatus]       = useState(row.status);
  const [newVersion, setNewVer]   = useState(row.new_version || '');
  const [ownerId, setOwnerId]     = useState(row.owner_id || '');
  const [startDate, setStart]     = useState(row.implementation_start || '');
  const [endDate, setEnd]         = useState(row.implementation_end || '');
  const [comment, setComment]     = useState(row.boss_comment || '');
  const [reason, setReason]       = useState(row.rejection_reason || '');
  const [busy, setBusy]   = useState(false);
  const [err, setErr]     = useState('');

  const { data: owners = [] } = useQuery({ queryKey: ['changes', 'owners'], queryFn: listPotentialOwners });
  const ownerRow = owners.find((o) => o.id === ownerId);

  const isRejecting = status === 'rejected';
  const canSave = status && (!isRejecting || reason.trim());

  async function save() {
    if (!canSave || busy) return;
    setBusy(true); setErr('');
    try {
      const patch = {
        status,
        new_version: newVersion || null,
        owner_id: ownerId || row.owner_id,
        owner_name: ownerRow?.display_name || row.owner_name,
        implementation_start: startDate || null,
        implementation_end:   endDate   || null,
        boss_comment:      comment.trim() || null,
        rejection_reason:  isRejecting ? reason.trim() : null,
      };
      if (['approved', 'rejected'].includes(status)) {
        patch.approved_by      = user?.id || null;
        patch.approved_by_name = profile?.display_name || null;
        patch.approval_date    = new Date().toISOString();
      }
      if (status === 'completed'   && !row.completed_at)   patch.completed_at   = new Date().toISOString();
      if (status === 'implemented' && !row.implemented_at) patch.implemented_at = new Date().toISOString();

      await updateChange(row.id, patch);
      onSaved();
    } catch (e) { setErr(e.message); }
    finally { setBusy(false); }
  }

  return (
    <div style={{ padding: 12, border: '1px dashed #c7d2fe', background: '#eef2ff', borderRadius: 8, marginBottom: 12 }}>
      {err && <div className="wx-alert wx-alert-danger" style={{ marginBottom: 10 }}>{err}</div>}

      <div className="wx-label">Status</div>
      <select className="wx-input" value={status} onChange={(e) => setStatus(e.target.value)} style={{ marginBottom: 10 }}>
        {CHANGE_STATUSES.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
      </select>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 10, marginBottom: 10 }}>
        <div>
          <div className="wx-label">New SOP version</div>
          <input className="wx-input" placeholder="e.g. v2.0" value={newVersion} onChange={(e) => setNewVer(e.target.value)} />
        </div>
        <div>
          <div className="wx-label">Implementation owner</div>
          <select className="wx-input" value={ownerId} onChange={(e) => setOwnerId(e.target.value)}>
            {owners.map((o) => <option key={o.id} value={o.id}>{o.display_name} ({o.role})</option>)}
          </select>
        </div>
        <div>
          <div className="wx-label">Start</div>
          <input type="date" className="wx-input" value={startDate} onChange={(e) => setStart(e.target.value)} />
        </div>
        <div>
          <div className="wx-label">End</div>
          <input type="date" className="wx-input" value={endDate} onChange={(e) => setEnd(e.target.value)} />
        </div>
      </div>

      {isRejecting && (
        <>
          <div className="wx-label">Rejection reason <span style={{ color: '#dc2626' }}>*</span></div>
          <textarea className="wx-input" rows="2" value={reason} onChange={(e) => setReason(e.target.value)} style={{ marginBottom: 10 }} />
        </>
      )}

      <div className="wx-label">Comment (shown to submitter)</div>
      <textarea className="wx-input" rows="2" value={comment} onChange={(e) => setComment(e.target.value)} style={{ marginBottom: 10 }} />

      <div style={{ display: 'flex', gap: 6 }}>
        <button className="wx-btn wx-btn-ghost" onClick={onCancel} disabled={busy}>Cancel</button>
        <button className="wx-btn wx-btn-primary" onClick={save} disabled={!canSave || busy}>
          {busy ? <><span className="wx-spinner" /> Saving…</> : 'Save decision'}
        </button>
      </div>
    </div>
  );
}

// ---- Thread ----
function ChangeThread({ changeId }) {
  const { user } = useAuth();
  const qc = useQueryClient();
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const endRef = useRef(null);

  const { data: messages = [] } = useQuery({
    queryKey: ['change', changeId, 'thread'],
    queryFn: () => listChangeThread(changeId),
    refetchInterval: 8000,
  });

  useEffect(() => {
    const t = setTimeout(() => endRef.current?.scrollIntoView({ behavior: 'smooth' }), 20);
    return () => clearTimeout(t);
  }, [messages.length]);

  async function send() {
    if (!text.trim() || busy) return;
    setBusy(true);
    try {
      await postChangeMessage(changeId, text);
      setText('');
      qc.invalidateQueries({ queryKey: ['change', changeId, 'thread'] });
    } catch (e) { alert(e.message); }
    finally { setBusy(false); }
  }

  return (
    <>
      <div className="wx-label" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <MessageIcon width="14" height="14" /> Discussion
      </div>
      <div style={{ border: '1px solid #e5e7eb', borderRadius: 8, maxHeight: 260, overflowY: 'auto', padding: 10, background: '#fff' }}>
        {messages.length === 0 && (
          <div style={{ padding: 12, textAlign: 'center', color: '#94a3b8', fontSize: 13 }}>No messages yet.</div>
        )}
        {messages.map((m) => {
          if (m.type === 'status_change') {
            return (
              <div key={m.id} style={{ textAlign: 'center', margin: '6px 0' }}>
                <span style={{ padding: '3px 10px', borderRadius: 999, background: '#f1f5f9', color: '#475569', fontSize: 11, fontWeight: 600 }}>
                  {m.text}
                </span>
              </div>
            );
          }
          const mine = m.user_id === user?.id;
          return (
            <div key={m.id} style={{ display: 'flex', justifyContent: mine ? 'flex-end' : 'flex-start', marginBottom: 6 }}>
              <div style={{
                maxWidth: '82%',
                padding: '6px 10px', borderRadius: 10,
                background: mine ? '#2563eb' : '#f1f5f9',
                color: mine ? '#fff' : '#0f172a',
                fontSize: 13,
              }}>
                {!mine && (
                  <div style={{ fontSize: 11, fontWeight: 700, marginBottom: 2, color: '#64748b' }}>
                    {m.user_name || '—'}{m.user_role ? ` · ${m.user_role}` : ''}
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
        <input className="wx-input" value={text} placeholder="Write a message…"
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }} />
        <button className="wx-btn wx-btn-primary" onClick={send} disabled={!text.trim() || busy}>
          {busy ? <span className="wx-spinner" /> : 'Send'}
        </button>
      </div>
    </>
  );
}
