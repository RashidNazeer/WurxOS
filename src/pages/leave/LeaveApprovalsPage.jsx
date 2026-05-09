import { useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '../../contexts/AuthContext';
import {
  listLeavesForApproval, decideLeave, setPaidOverride,
  leaveTypeLabel, daysBetween, decisionTimeline, LEVEL_LABEL,
} from '../../lib/leaveApi';
import { AlertIcon, RefreshIcon, CheckIcon, XIcon, ArrowRightIcon } from '../../components/common/Icon';
import '../../styles/table.css';

export default function LeaveApprovalsPage() {
  const { user, profile } = useAuth();
  const uid = user?.id;
  const isBoss = profile?.role === 'boss' || profile?.role === 'developer';

  const [tab, setTab]       = useState('pending'); // pending | recent
  const [localErr, setLocalErr] = useState('');
  const [decideModal, setDecideModal] = useState(null); // { row, action } where action = 'approve'|'reject'|'forward'
  const [overrideModal, setOverrideModal] = useState(null); // decided row to flip paid_override

  const qc = useQueryClient();
  const { data: rows = [], isLoading: loading, error: queryError } = useQuery({
    queryKey: ['leave', 'approvals', uid],
    queryFn: () => listLeavesForApproval(uid),
    enabled: !!uid,
  });
  const err = localErr || queryError?.message || '';
  const reload = () => qc.invalidateQueries({ queryKey: ['leave'] });

  const filtered = useMemo(() => {
    if (tab === 'pending') return rows.filter((r) => r.status === 'pending');
    return rows.filter((r) => r.status !== 'pending');
  }, [rows, tab]);

  const pendingCount = rows.filter((r) => r.status === 'pending').length;

  return (
    <>
      <div className="page-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: 12 }}>
        <div>
          <h1 className="page-title">Leave approvals</h1>
          <p className="page-subtitle">
            {pendingCount} pending · recent decisions from the last 60 days.
          </p>
        </div>
        <button className="wx-btn wx-btn-ghost" onClick={reload} disabled={loading}>
          <RefreshIcon width="15" height="15" />
        </button>
      </div>

      <div style={{ display: 'flex', gap: 8, marginBottom: 14 }}>
        <div className="task-tabs">
          <button type="button" className={`task-tab ${tab === 'pending' ? 'task-tab-active' : ''}`} onClick={() => setTab('pending')}>
            Pending <span className="task-tab-count">{pendingCount}</span>
          </button>
          <button type="button" className={`task-tab ${tab === 'recent' ? 'task-tab-active' : ''}`} onClick={() => setTab('recent')}>
            Recent <span className="task-tab-count">{rows.length - pendingCount}</span>
          </button>
        </div>
      </div>

      {err && (
        <div className="wx-alert wx-alert-danger" style={{ marginBottom: 14 }}>
          <AlertIcon width="16" height="16" /> <span>{err}</span>
        </div>
      )}

      <div className="wx-list leave-approvals-table">
        <div className="wx-list-row wx-list-header leave-approvals-row" style={{ gridTemplateColumns: '1.3fr 1fr 0.9fr 1.3fr 70px 110px 180px' }}>
          <div>Requester</div><div>Type</div><div>Dates</div><div>Reason & chain</div><div>Days</div><div>Paid / Unpaid</div><div>Action</div>
        </div>
        {loading ? (
          <div className="wx-empty"><span className="wx-spinner" /> Loading…</div>
        ) : filtered.length === 0 ? (
          <div className="wx-empty">
            <div className="wx-empty-title">{tab === 'pending' ? 'Nothing pending' : 'Nothing recent'}</div>
            <div>{tab === 'pending' ? 'All caught up.' : 'No recent decisions.'}</div>
          </div>
        ) : filtered.map((r) => (
          <ApprovalRow key={r.id} row={r} isBoss={isBoss}
            onAction={(action) => setDecideModal({ row: r, action })}
            onOverride={() => setOverrideModal(r)} />
        ))}
      </div>

      {decideModal && (
        <DecideModal
          row={decideModal.row}
          action={decideModal.action}
          isBoss={isBoss}
          onClose={() => setDecideModal(null)}
          onSubmitted={() => { setDecideModal(null); reload(); }}
        />
      )}

      {overrideModal && (
        <PaidOverrideModal
          row={overrideModal}
          onClose={() => setOverrideModal(null)}
          onSubmitted={() => { setOverrideModal(null); reload(); }}
        />
      )}
    </>
  );
}

function ApprovalRow({ row, isBoss, onAction, onOverride }) {
  const days = row.type === 'half_leave' ? 0.5 : daysBetween(row.start_date, row.end_date);
  const single = row.start_date === row.end_date;
  const quota  = row.requester?.leave_quota || { wfh: 0, medical: 0, emergency: 0 };
  const isPending = row.status === 'pending';
  const canForward = row.current_level < 3;
  const label = row.type === 'other' ? (row.other_title || 'Other') : leaveTypeLabel(row.type);
  const timeline = decisionTimeline(row);

  // Over-quota requests can only be approved by the Boss. Non-Boss
  // approvers must Forward. The DB rejects approve too, but we hide
  // the button so the path is obvious.
  const hasUnpaid    = Number(row.unpaid_days || 0) > 0;
  const canApproveHere = isPending && (isBoss || !hasUnpaid);

  return (
    <div className="wx-list-row leave-approvals-row" style={{ gridTemplateColumns: '1.3fr 1fr 0.9fr 1.3fr 70px 110px 180px', alignItems: 'flex-start' }}>
      <div>
        <div style={{ fontWeight: 700, fontSize: 13 }}>{row.requester?.display_name || '—'}</div>
        <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>{row.requester?.role} · {row.requester?.email}</div>
      </div>
      <div>
        <div style={{ fontWeight: 600, fontSize: 12.5 }}>{label}</div>
        {row.type !== 'other' && (
          <div style={{ fontSize: 10.5, color: 'var(--text-muted)' }}>Quota: {quota[row.type === 'half_leave' ? 'medical' : row.type] || 0}/mo</div>
        )}
      </div>
      <div style={{ fontSize: 12.5 }}>
        {fmt(row.start_date)}{!single && row.type !== 'half_leave' && <> – {fmt(row.end_date)}</>}
      </div>
      <div style={{ fontSize: 12.5, color: 'var(--text-secondary)' }}>
        {row.reason || <span style={{ color: 'var(--text-muted)' }}>—</span>}
        {isPending && (
          <div style={{ fontSize: 10.5, color: 'var(--accent)', marginTop: 4, fontWeight: 700 }}>
            Current: {LEVEL_LABEL[row.current_level] || `Level ${row.current_level}`}
          </div>
        )}
        {timeline.length > 0 && (
          <div style={{ fontSize: 10.5, color: 'var(--text-muted)', marginTop: 3 }}>
            {timeline.map((d, i) => (
              <div key={i}>• {d.by} {d.action}{d.note ? ` — "${d.note}"` : ''}</div>
            ))}
          </div>
        )}
      </div>
      <div style={{ fontWeight: 700 }}>{days}</div>
      <div style={{ fontSize: 11.5 }}>
        <span style={{ color: 'var(--success)', fontWeight: 700 }}>{Number(row.paid_days || 0)}</span>
        {Number(row.unpaid_days || 0) > 0 && (
          <> · <span style={{ color: row.paid_override ? 'var(--success)' : 'var(--danger)', fontWeight: 700 }}>
            {Number(row.unpaid_days)}{row.paid_override ? '*' : ''}
          </span></>
        )}
      </div>
      <div style={{ display: 'flex', gap: 5, justifyContent: 'flex-end', flexWrap: 'wrap' }}>
        {isPending ? (
          <>
            {canApproveHere && (
              <button className="wx-btn wx-btn-primary" onClick={() => onAction('approve')} style={{ padding: '5px 10px', fontSize: 11.5 }}>
                <CheckIcon width="11" height="11" /> Approve
              </button>
            )}
            {!canApproveHere && hasUnpaid && (
              <span
                title={`Over quota by ${row.unpaid_days} day(s) — only Boss can approve. Forward instead.`}
                style={{
                  padding: '5px 9px', fontSize: 10.5, fontWeight: 700,
                  color: 'var(--danger)',
                  background: 'color-mix(in srgb, var(--danger) 10%, transparent)',
                  border: '1px solid color-mix(in srgb, var(--danger) 30%, transparent)',
                  borderRadius: 6,
                }}
              >
                Boss approval needed
              </span>
            )}
            {canForward && (
              <button className="wx-btn wx-btn-ghost" onClick={() => onAction('forward')} style={{ padding: '5px 10px', fontSize: 11.5 }}>
                <ArrowRightIcon width="11" height="11" /> Forward
              </button>
            )}
            <button className="wx-btn wx-btn-ghost" onClick={() => onAction('reject')} style={{ padding: '5px 10px', fontSize: 11.5, color: 'var(--danger)' }}>
              <XIcon width="11" height="11" /> Reject
            </button>
          </>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 4 }}>
            <span style={{
              fontSize: 11, fontWeight: 700, textTransform: 'capitalize',
              padding: '3px 9px', borderRadius: 'var(--radius-pill)',
              background: row.status === 'approved' ? 'color-mix(in srgb, var(--success) 18%, transparent)'
                        : row.status === 'rejected' ? 'color-mix(in srgb, var(--danger) 18%, transparent)'
                        : 'var(--surface-3)',
              color:      row.status === 'approved' ? 'var(--success)'
                        : row.status === 'rejected' ? 'var(--danger)'
                        : 'var(--text-muted)',
            }}>{row.status}</span>
            {isBoss && row.status === 'approved' && Number(row.unpaid_days || 0) > 0 && (
              <button className="wx-btn wx-btn-ghost" onClick={onOverride} style={{ padding: '4px 8px', fontSize: 10.5 }}>
                {row.paid_override ? 'Undo paid override' : 'Mark as paid'}
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// --------------------------------------------------------------
// Decide modal — optional note for any action; forward shows a
// heads-up about the next approver.
// --------------------------------------------------------------
function DecideModal({ row, action, isBoss, onClose, onSubmitted }) {
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState('');

  // Boss approving an over-quota request: choose paid or unpaid up-front.
  // Default = unpaid (matches what the system already computed); selecting
  // "paid" triggers a paid_override after approval.
  const hasUnpaid    = Number(row.unpaid_days || 0) > 0;
  const isBossApprove = isBoss && action === 'approve' && hasUnpaid;
  const [markUnpaidAsPaid, setMarkUnpaidAsPaid] = useState(false);

  const title = action === 'approve' ? 'Approve request'
              : action === 'reject'  ? 'Reject request'
              :                        'Forward to next approver';
  const primaryLabel = action === 'approve' ? 'Approve'
                     : action === 'reject'  ? 'Reject'
                     :                        'Forward';
  const noteRequired = action === 'reject';
  const label = row.type === 'other' ? (row.other_title || 'Other') : leaveTypeLabel(row.type);

  async function submit(e) {
    e.preventDefault();
    setErr('');
    if (noteRequired && !note.trim()) return setErr('Please add a reason for rejecting.');
    setSaving(true);
    try {
      await decideLeave(row.id, { action, note: note.trim() });
      // Boss chose to mark the unpaid days as paid → flip the override.
      if (isBossApprove && markUnpaidAsPaid) {
        await setPaidOverride(row.id, true, note.trim());
      }
      onSubmitted();
    } catch (e) { setErr(e.message || 'Failed to decide.'); setSaving(false); }
  }

  return (
    <div className="wx-modal-backdrop" onClick={onClose}>
      <div className="wx-modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 460 }}>
        <form onSubmit={submit}>
          <div className="wx-modal-header">
            <div className="wx-modal-title">{title}</div>
            <button type="button" className="shell-icon-btn" onClick={onClose} aria-label="Close">
              <XIcon width="16" height="16" />
            </button>
          </div>
          <div className="wx-modal-body">
            {err && (
              <div className="wx-alert wx-alert-danger" style={{ marginBottom: 12 }}>
                <AlertIcon width="14" height="14" /> <span>{err}</span>
              </div>
            )}
            <div className="wx-card" style={{ padding: 12, marginBottom: 12, fontSize: 12.5 }}>
              <div style={{ fontWeight: 700 }}>{row.requester?.display_name}</div>
              <div style={{ color: 'var(--text-muted)', marginTop: 2 }}>
                {label} · {fmt(row.start_date)}{row.start_date !== row.end_date && row.type !== 'half_leave' ? ` – ${fmt(row.end_date)}` : ''}
              </div>
              {row.reason && (
                <div style={{ fontStyle: 'italic', color: 'var(--text-secondary)', marginTop: 6 }}>
                  "{row.reason}"
                </div>
              )}
              <div style={{ marginTop: 8, fontSize: 11.5 }}>
                <span style={{ color: 'var(--success)', fontWeight: 700 }}>{Number(row.paid_days || 0)} paid</span>
                {Number(row.unpaid_days || 0) > 0 && (
                  <> · <span style={{ color: 'var(--danger)', fontWeight: 700 }}>{Number(row.unpaid_days)} unpaid</span></>
                )}
              </div>
            </div>

            {action === 'forward' && (
              <div style={{
                padding: 10, background: 'var(--surface-2)',
                border: '1px solid var(--border-subtle)',
                borderRadius: 'var(--radius-md)', fontSize: 12, marginBottom: 12,
              }}>
                Forwarding escalates the decision to the next person up the chain.
                They'll see the request with your note attached.
              </div>
            )}

            {isBossApprove && (
              <div style={{
                padding: 12, marginBottom: 12,
                background: 'var(--surface-2)',
                border: '1px solid color-mix(in srgb, var(--danger) 30%, transparent)',
                borderRadius: 'var(--radius-md)',
              }}>
                <div style={{ fontWeight: 700, fontSize: 12.5, marginBottom: 8 }}>
                  Over-quota — your call on the {Number(row.unpaid_days)} extra day{Number(row.unpaid_days) === 1 ? '' : 's'}:
                </div>
                <label style={{ display: 'flex', alignItems: 'flex-start', gap: 8, marginBottom: 8, cursor: 'pointer' }}>
                  <input type="radio" name="paidchoice" checked={!markUnpaidAsPaid}
                    onChange={() => setMarkUnpaidAsPaid(false)} disabled={saving} />
                  <span style={{ fontSize: 12.5 }}>
                    <strong style={{ color: 'var(--danger)' }}>Approve as unpaid</strong> —
                    extra {Number(row.unpaid_days)} day{Number(row.unpaid_days) === 1 ? '' : 's'} won't be paid (will affect salary).
                  </span>
                </label>
                <label style={{ display: 'flex', alignItems: 'flex-start', gap: 8, cursor: 'pointer' }}>
                  <input type="radio" name="paidchoice" checked={markUnpaidAsPaid}
                    onChange={() => setMarkUnpaidAsPaid(true)} disabled={saving} />
                  <span style={{ fontSize: 12.5 }}>
                    <strong style={{ color: 'var(--success)' }}>Approve as paid</strong> —
                    pay the full {Number(row.paid_days) + Number(row.unpaid_days)} day{(Number(row.paid_days)+Number(row.unpaid_days)) === 1 ? '' : 's'} as a goodwill exception.
                  </span>
                </label>
              </div>
            )}

            <label className="wx-label">
              Note {noteRequired ? '(required)' : '(optional)'}
            </label>
            <textarea className="wx-input" rows={3} value={note}
              onChange={(e) => setNote(e.target.value)} disabled={saving}
              placeholder={action === 'reject' ? 'Why are you rejecting this?' : 'Anything to add?'} />
          </div>
          <div className="wx-modal-footer">
            <button type="button" className="wx-btn wx-btn-ghost" onClick={onClose} disabled={saving}>Cancel</button>
            <button type="submit"
              className={`wx-btn ${action === 'reject' ? 'wx-btn-ghost' : 'wx-btn-primary'}`}
              disabled={saving}
              style={action === 'reject' ? { color: 'var(--danger)' } : null}>
              {saving ? <><span className="wx-spinner" /> {primaryLabel}ing…</> : <>{primaryLabel}</>}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// --------------------------------------------------------------
// Boss-only paid override modal
// --------------------------------------------------------------
function PaidOverrideModal({ row, onClose, onSubmitted }) {
  const currently = row.paid_override;
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState('');

  async function submit(e) {
    e.preventDefault();
    setErr(''); setSaving(true);
    try {
      await setPaidOverride(row.id, !currently, note.trim());
      onSubmitted();
    } catch (e) { setErr(e.message); setSaving(false); }
  }

  return (
    <div className="wx-modal-backdrop" onClick={onClose}>
      <div className="wx-modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 440 }}>
        <form onSubmit={submit}>
          <div className="wx-modal-header">
            <div className="wx-modal-title">{currently ? 'Undo paid override' : 'Mark unpaid days as paid'}</div>
            <button type="button" className="shell-icon-btn" onClick={onClose} aria-label="Close">
              <XIcon width="16" height="16" />
            </button>
          </div>
          <div className="wx-modal-body">
            {err && (
              <div className="wx-alert wx-alert-danger" style={{ marginBottom: 12 }}>
                <AlertIcon width="14" height="14" /> <span>{err}</span>
              </div>
            )}
            <div style={{ fontSize: 13, marginBottom: 12, color: 'var(--text-secondary)' }}>
              {currently
                ? `Revert this request back to ${row.unpaid_days} unpaid day${Number(row.unpaid_days) === 1 ? '' : 's'}.`
                : `This will mark ${row.unpaid_days} currently-unpaid day${Number(row.unpaid_days) === 1 ? '' : 's'} as paid, without consuming additional quota.`}
            </div>
            <label className="wx-label">Reason (optional)</label>
            <textarea className="wx-input" rows={3} value={note}
              onChange={(e) => setNote(e.target.value)} disabled={saving}
              placeholder="Why are you overriding?" />
          </div>
          <div className="wx-modal-footer">
            <button type="button" className="wx-btn wx-btn-ghost" onClick={onClose} disabled={saving}>Cancel</button>
            <button type="submit" className="wx-btn wx-btn-primary" disabled={saving}>
              {saving ? <><span className="wx-spinner" /> Saving…</> : (currently ? 'Undo' : 'Mark paid')}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

function fmt(d) {
  if (!d) return '';
  return new Date(d).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}
