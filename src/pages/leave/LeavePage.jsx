import { useMemo, useState } from 'react';
import { useQueries, useQueryClient } from '@tanstack/react-query';
import { Navigate } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext';
import {
  LEAVE_TYPES, leaveTypeLabel, listMyLeaves, submitLeave, cancelLeave,
  getConsumedLeaves, getConsumedLeavesMonth, computePaidPreview,
  decisionTimeline, daysBetween, LEVEL_LABEL,
} from '../../lib/leaveApi';
import {
  PlusIcon, AlertIcon, RefreshIcon, XIcon, CheckIcon, ChevronRightIcon, ClockIcon,
} from '../../components/common/Icon';
import '../../styles/table.css';

const STATUS_TONE = {
  pending:   { bg: 'color-mix(in srgb, var(--warning) 18%, transparent)', fg: 'var(--warning)' },
  approved:  { bg: 'color-mix(in srgb, var(--success) 18%, transparent)', fg: 'var(--success)' },
  rejected:  { bg: 'color-mix(in srgb, var(--danger) 18%, transparent)',  fg: 'var(--danger)' },
  cancelled: { bg: 'var(--surface-3)', fg: 'var(--text-muted)' },
};

// Balance cards show the three quota-backed buckets. half_leave is
// counted inside medical; "other" isn't quota-backed and needs no card.
const BALANCE_TYPES = LEAVE_TYPES.filter((t) => ['wfh','medical','emergency'].includes(t.v));

export default function LeavePage() {
  const { user, profile } = useAuth();
  // Boss doesn't apply for leave — redirect them to the approvals queue.
  if (profile?.role === 'boss') {
    return <Navigate to="/leave/approvals" replace />;
  }
  const uid = user?.id;
  const quota = profile?.leave_quota || { wfh: 0, medical: 0, emergency: 0 };

  const [showSubmit, setShowSubmit] = useState(false);
  const [localErr, setLocalErr]     = useState('');

  const now   = new Date();
  const year  = now.getFullYear();
  const month = now.getMonth() + 1;

  const qc = useQueryClient();
  const results = useQueries({
    queries: [
      { queryKey: ['leave', 'mine', uid],                    queryFn: () => listMyLeaves(uid),                        enabled: !!uid },
      { queryKey: ['leave', 'consumed', uid, year],          queryFn: () => getConsumedLeaves(uid, year),             enabled: !!uid },
      { queryKey: ['leave', 'consumed-month', uid, year, month], queryFn: () => getConsumedLeavesMonth(uid, year, month), enabled: !!uid },
    ],
  });
  const [listQ, consumedQ, consumedMonthQ] = results;
  const rows          = listQ.data || [];
  const consumed      = consumedQ.data || { wfh: 0, medical: 0, emergency: 0 };
  const consumedMonth = consumedMonthQ.data || { wfh: 0, medical: 0, emergency: 0 };
  const loading       = listQ.isPending;
  const err           = localErr || results.find((r) => r.error)?.error?.message || '';

  const reload = () => qc.invalidateQueries({ queryKey: ['leave'] });
  const pendingRow = rows.find((r) => r.status === 'pending');
  const hasPending = !!pendingRow;

  async function handleCancel(id) {
    if (!confirm('Cancel this leave request?')) return;
    try { await cancelLeave(id); reload(); }
    catch (e) { setLocalErr(e.message); }
  }

  return (
    <>
      <div className="page-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: 12 }}>
        <div>
          <h1 className="page-title">Leave</h1>
          <p className="page-subtitle">
            Your quota resets every month. Annual totals shown below for reference.
          </p>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="wx-btn wx-btn-ghost" onClick={reload} disabled={loading}>
            <RefreshIcon width="15" height="15" />
          </button>
          <button
            className="wx-btn wx-btn-primary"
            onClick={() => setShowSubmit(true)}
            disabled={hasPending}
            title={hasPending ? 'Wait for your current request to be decided first.' : ''}
          >
            <PlusIcon width="15" height="15" /> Request leave
          </button>
        </div>
      </div>

      {/* Pending-request banner — only shown when there's an in-flight
          request so the user knows why the submit button is disabled. */}
      {hasPending && (
        <div
          className="wx-card"
          style={{
            display: 'flex', alignItems: 'center', gap: 14,
            padding: '14px 16px', marginBottom: 16,
            borderColor: 'color-mix(in srgb, var(--warning) 40%, var(--border-subtle))',
            background: 'color-mix(in srgb, var(--warning) 8%, var(--surface-1))',
          }}
        >
          <div style={{
            width: 38, height: 38, borderRadius: 10, flexShrink: 0,
            display: 'grid', placeItems: 'center',
            background: 'color-mix(in srgb, var(--warning) 20%, transparent)',
            color: 'var(--warning)',
          }}>
            <ClockIcon width="18" height="18" />
          </div>
          <div style={{ minWidth: 0, flex: 1 }}>
            <div style={{ fontWeight: 700, fontSize: 13 }}>
              You have a pending request — {leaveTypeLabel(pendingRow.type)}
            </div>
            <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 2 }}>
              Waiting on {LEVEL_LABEL[pendingRow.current_level] || 'approval'}.
              You can submit another after it's approved, rejected, or cancelled.
            </div>
          </div>
          <button
            className="wx-btn wx-btn-ghost"
            style={{ flexShrink: 0 }}
            onClick={() => handleCancel(pendingRow.id)}
          >
            <XIcon width="13" height="13" /> Cancel it
          </button>
        </div>
      )}

      {/* Balance cards — this month's quota vs used. Negative balance is
          shown deliberately: requests still go through (Boss decides
          paid vs unpaid) but the user sees that they're over the cap. */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(180px, 100%), 1fr))', gap: 12, marginBottom: 16 }}>
        {BALANCE_TYPES.map((t) => {
          const monthlyQuota = Number(quota[t.v] || 0);
          const monthlyUsed  = Number(consumedMonth[t.v] || 0);
          const yearlyUsed   = Number(consumed[t.v] || 0);
          const remaining    = monthlyQuota - monthlyUsed;
          const overQuota    = remaining < 0;
          const pct          = monthlyQuota > 0 ? Math.min(100, Math.round((monthlyUsed / monthlyQuota) * 100)) : 0;
          return (
            <div key={t.v} className="wx-card" style={{ padding: 16 }}>
              <div style={{ fontSize: 11, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 6 }}>
                {t.label}
              </div>
              <div style={{ fontSize: 22, fontWeight: 800, color: overQuota ? 'var(--danger)' : 'var(--text-primary)' }}>
                {remaining}
                <span style={{ fontSize: 13, color: 'var(--text-muted)', fontWeight: 500 }}> / {monthlyQuota} left this month</span>
              </div>
              <div style={{ height: 6, background: 'var(--surface-2)', borderRadius: 999, marginTop: 10, overflow: 'hidden' }}>
                <div style={{
                  height: '100%', width: `${pct}%`,
                  background: pct >= 100 ? 'var(--danger)' : 'var(--accent)',
                  transition: 'width 0.2s',
                }} />
              </div>
              <div style={{ fontSize: 11.5, color: 'var(--text-muted)', marginTop: 4 }}>
                {monthlyUsed} used this month · {yearlyUsed} YTD
              </div>
              {overQuota && (
                <div style={{
                  marginTop: 8, fontSize: 11.5, padding: '6px 8px',
                  background: 'color-mix(in srgb, var(--danger) 10%, transparent)',
                  color: 'var(--danger)', borderRadius: 6, fontWeight: 600,
                }}>
                  Over quota by {Math.abs(remaining)} — new requests will be unpaid unless Boss approves them as paid.
                </div>
              )}
            </div>
          );
        })}
      </div>

      {err && (
        <div className="wx-alert wx-alert-danger" style={{ marginBottom: 14 }}>
          <AlertIcon width="16" height="16" /> <span>{err}</span>
        </div>
      )}

      <div className="wx-list leave-table">
        <div className="wx-list-row wx-list-header leave-row" style={{ gridTemplateColumns: '1fr 1fr 1fr 90px 120px 100px 80px' }}>
          <div>Type</div><div>Dates</div><div>Reason</div><div>Days</div><div>Paid / Unpaid</div><div>Status</div><div />
        </div>
        {loading ? (
          <div className="wx-empty"><span className="wx-spinner" /> Loading…</div>
        ) : rows.length === 0 ? (
          <div className="wx-empty">
            <div className="wx-empty-title">No leave requests yet</div>
            <div>Click Request leave to submit your first one.</div>
          </div>
        ) : rows.map((r) => (
          <LeaveRow key={r.id} row={r} onCancel={() => handleCancel(r.id)} />
        ))}
      </div>

      {showSubmit && (
        <SubmitLeaveModal
          quota={quota}
          consumedMonth={consumedMonth}
          onClose={() => setShowSubmit(false)}
          onSubmitted={() => { setShowSubmit(false); reload(); }}
        />
      )}
    </>
  );
}

function LeaveRow({ row, onCancel }) {
  const tone = STATUS_TONE[row.status] || STATUS_TONE.pending;
  const days = row.type === 'half_leave' ? 0.5 : daysBetween(row.start_date, row.end_date);
  const single = row.start_date === row.end_date;
  // Allow withdrawing both pending and rejected requests. Rejected ones
  // already don't count against the monthly quota (consumed_leaves only
  // sums approved rows), but withdrawing them cleans up the row from the
  // user's history view.
  const canCancel = row.status === 'pending' || row.status === 'rejected';
  const cancelLabel = row.status === 'pending' ? 'Cancel' : 'Withdraw';
  const timeline = decisionTimeline(row);
  const label = row.type === 'other' ? (row.other_title || 'Other') : leaveTypeLabel(row.type);

  return (
    <div className="wx-list-row leave-row" style={{ gridTemplateColumns: '1fr 1fr 1fr 90px 120px 100px 80px', alignItems: 'flex-start' }}>
      <div>
        <div style={{ fontWeight: 700, fontSize: 13 }}>{label}</div>
        <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>
          {new Date(row.created_at).toLocaleDateString()}
        </div>
      </div>
      <div style={{ fontSize: 12.5 }}>
        {fmt(row.start_date)}
        {!single && row.type !== 'half_leave' && <> – {fmt(row.end_date)}</>}
      </div>
      <div style={{ fontSize: 12.5, color: 'var(--text-secondary)', wordBreak: 'break-word' }}>
        {row.reason || <span style={{ color: 'var(--text-muted)' }}>—</span>}
        {row.decision_note && (
          <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4, fontStyle: 'italic' }}>
            "{row.decision_note}"
          </div>
        )}
        {timeline.length > 0 && (
          <div style={{ fontSize: 10.5, color: 'var(--text-muted)', marginTop: 4 }}>
            {timeline.map((d, i) => (
              <span key={i}>
                {i > 0 && ' · '}
                <strong>{d.by}</strong> {d.action}
              </span>
            ))}
          </div>
        )}
      </div>
      <div style={{ fontWeight: 700 }}>{days}</div>
      <div style={{ fontSize: 12 }}>
        <span style={{ color: 'var(--success)', fontWeight: 700 }}>{Number(row.paid_days || 0)} paid</span>
        {Number(row.unpaid_days || 0) > 0 && (
          <> · <span style={{ color: row.paid_override ? 'var(--success)' : 'var(--danger)', fontWeight: 700 }}>
            {Number(row.unpaid_days)} {row.paid_override ? 'paid*' : 'unpaid'}
          </span></>
        )}
      </div>
      <div>
        <span style={{
          display: 'inline-flex', alignItems: 'center', padding: '3px 9px',
          borderRadius: 'var(--radius-pill)', fontSize: 11, fontWeight: 700,
          textTransform: 'capitalize', background: tone.bg, color: tone.fg,
        }}>{row.status}</span>
      </div>
      <div style={{ textAlign: 'right' }}>
        {canCancel && (
          <button className="wx-btn wx-btn-ghost" onClick={onCancel} style={{ padding: '5px 8px', fontSize: 11.5 }}>
            <XIcon width="12" height="12" /> {cancelLabel}
          </button>
        )}
      </div>
    </div>
  );
}

function SubmitLeaveModal({ quota, consumedMonth, onClose, onSubmitted }) {
  const today = new Date().toISOString().slice(0, 10);
  const [type, setType]       = useState('wfh');
  const [start, setStart]     = useState(today);
  const [end, setEnd]         = useState(today);
  const [reason, setReason]   = useState('');
  const [otherTitle, setOT]   = useState('');
  const [err, setErr]         = useState('');
  const [saving, setSaving]   = useState(false);
  const [confirming, setConfirming] = useState(false);  // show review card before final submit

  // half-day leaves are single-day by definition
  const singleDayOnly = type === 'half_leave';
  const effectiveEnd  = singleDayOnly ? start : end;

  const preview = useMemo(() => computePaidPreview({
    type,
    startDate: start,
    endDate:   effectiveEnd,
    quota,
    consumedMonth,
  }), [type, start, effectiveEnd, quota, consumedMonth]);

  async function doSubmit() {
    setErr('');
    if (!reason.trim())                                return setErr('Please share a short reason.');
    if (type === 'other' && !otherTitle.trim())        return setErr('Give your request a short title.');
    if (new Date(effectiveEnd) < new Date(start))      return setErr('End date must be on or after start date.');
    setSaving(true);
    try {
      await submitLeave({
        type,
        startDate:  start,
        endDate:    effectiveEnd,
        reason:     reason.trim(),
        otherTitle: type === 'other' ? otherTitle.trim() : null,
      });
      onSubmitted();
    } catch (e) { setErr(e.message || 'Failed to submit.'); setSaving(false); }
  }

  function handleNext(e) {
    e.preventDefault();
    setErr('');
    if (!reason.trim())                           return setErr('Please share a short reason.');
    if (type === 'other' && !otherTitle.trim())   return setErr('Give your request a short title.');
    if (new Date(effectiveEnd) < new Date(start)) return setErr('End date must be on or after start date.');
    setConfirming(true);
  }

  return (
    <div className="wx-modal-backdrop" onClick={onClose}>
      <div className="wx-modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 520 }}>
        <form onSubmit={confirming ? (e) => { e.preventDefault(); doSubmit(); } : handleNext}>
          <div className="wx-modal-header">
            <div className="wx-modal-title">
              {confirming ? 'Review & submit' : 'Request leave'}
            </div>
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

            {!confirming && (
              <>
                {/* Type picker — 5 options in two rows */}
                <div style={{ marginBottom: 12 }}>
                  <label className="wx-label">Category</label>
                  <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                    {LEAVE_TYPES.map((t) => (
                      <button key={t.v} type="button"
                        className={`wx-role-chip ${type === t.v ? 'wx-role-chip-active' : ''}`}
                        onClick={() => setType(t.v)} disabled={saving}>
                        {t.label}
                      </button>
                    ))}
                  </div>
                </div>

                {type === 'other' && (
                  <div style={{ marginBottom: 12 }}>
                    <label className="wx-label">Title</label>
                    <input className="wx-input" value={otherTitle} onChange={(e) => setOT(e.target.value)}
                           disabled={saving} placeholder="e.g. Early dismissal, bereavement" />
                  </div>
                )}

                <div style={{ display: 'grid', gridTemplateColumns: singleDayOnly ? '1fr' : '1fr 1fr', gap: 10, marginBottom: 12 }}>
                  <div>
                    <label className="wx-label">{singleDayOnly ? 'Date' : 'From'}</label>
                    <input type="date" className="wx-input" value={start} onChange={(e) => setStart(e.target.value)} disabled={saving} />
                  </div>
                  {!singleDayOnly && (
                    <div>
                      <label className="wx-label">To</label>
                      <input type="date" className="wx-input" value={end} onChange={(e) => setEnd(e.target.value)} disabled={saving} />
                    </div>
                  )}
                </div>

                <div style={{ marginBottom: 12 }}>
                  <label className="wx-label">Reason</label>
                  <textarea className="wx-input" rows={3} value={reason} onChange={(e) => setReason(e.target.value)} disabled={saving}
                            placeholder="Short context for your approver…" />
                </div>

                <PreviewCard preview={preview} type={type} />
              </>
            )}

            {confirming && (
              <ReviewCard
                type={type}
                otherTitle={otherTitle}
                start={start}
                end={effectiveEnd}
                reason={reason}
                preview={preview}
              />
            )}
          </div>

          <div className="wx-modal-footer">
            {confirming ? (
              <>
                <button type="button" className="wx-btn wx-btn-ghost" onClick={() => setConfirming(false)} disabled={saving}>
                  Back
                </button>
                <button type="submit" className="wx-btn wx-btn-primary" disabled={saving}>
                  {saving ? <><span className="wx-spinner" /> Submitting…</> : <><CheckIcon width="14" height="14" /> Submit request</>}
                </button>
              </>
            ) : (
              <>
                <button type="button" className="wx-btn wx-btn-ghost" onClick={onClose} disabled={saving}>Cancel</button>
                <button type="submit" className="wx-btn wx-btn-primary" disabled={saving}>
                  Next <ChevronRightIcon width="14" height="14" />
                </button>
              </>
            )}
          </div>
        </form>
      </div>
    </div>
  );
}

function PreviewCard({ preview, type }) {
  if (type === 'other') {
    return (
      <div style={{
        padding: '10px 12px', background: 'var(--surface-2)',
        border: '1px solid var(--border-subtle)',
        borderRadius: 'var(--radius-md)', fontSize: 12.5,
      }}>
        <strong>"Other" requests</strong> are always recorded as unpaid and don't consume any quota.
        The approver decides based on your reason.
      </div>
    );
  }
  const over = preview.unpaid > 0;
  return (
    <div style={{
      padding: '10px 12px',
      background: over ? 'var(--danger-soft)' : 'var(--surface-2)',
      border: `1px solid ${over ? 'color-mix(in srgb, var(--danger) 30%, transparent)' : 'var(--border-subtle)'}`,
      borderRadius: 'var(--radius-md)', fontSize: 12.5,
    }}>
      {preview.requested} day{preview.requested === 1 ? '' : 's'} requested ·
      <strong> {preview.remaining} left</strong> in {preview.bucket} this month.
      {over && (
        <div style={{ marginTop: 6, fontWeight: 600 }}>
          You're requesting {preview.unpaid} day{preview.unpaid === 1 ? '' : 's'} more than your monthly quota.
          The request will go up to the <strong>Boss</strong>, who decides whether the
          extra {preview.unpaid} day{preview.unpaid === 1 ? '' : 's'} {preview.unpaid === 1 ? 'is' : 'are'} <strong>paid or unpaid</strong>.
          Unpaid days affect your salary.
        </div>
      )}
    </div>
  );
}

function ReviewCard({ type, otherTitle, start, end, reason, preview }) {
  const label = type === 'other' ? `Other · ${otherTitle || 'untitled'}` : leaveTypeLabel(type);
  const single = start === end || type === 'half_leave';
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div className="wx-card" style={{ padding: 14, display: 'flex', flexDirection: 'column', gap: 8 }}>
        <Row k="Category" v={label} />
        <Row k="Dates"    v={single ? fmt(start) : `${fmt(start)} – ${fmt(end)}`} />
        <Row k="Days"     v={preview.requested} />
        <Row k="Reason"   v={reason} preserveLines />
      </div>
      <div style={{
        padding: 12,
        background: preview.unpaid > 0 ? 'var(--danger-soft)' : 'color-mix(in srgb, var(--success) 10%, transparent)',
        border: `1px solid ${preview.unpaid > 0 ? 'color-mix(in srgb, var(--danger) 28%, transparent)' : 'color-mix(in srgb, var(--success) 28%, transparent)'}`,
        borderRadius: 'var(--radius-md)', fontSize: 12.5,
      }}>
        <strong>{preview.paid}</strong> paid day{preview.paid === 1 ? '' : 's'}
        {preview.unpaid > 0 && <> · <strong>{preview.unpaid}</strong> unpaid</>}
        {preview.bucket && <> — consumes <strong>{preview.paid + (type === 'half_leave' ? 0 : 0)}</strong> from your <strong>{preview.bucket}</strong> balance.</>}
        {preview.unpaid > 0 && (
          <div style={{ marginTop: 6, color: 'var(--text-muted)' }}>
            Boss can retroactively mark unpaid days as paid after approval.
          </div>
        )}
      </div>
    </div>
  );
}

function Row({ k, v, preserveLines }) {
  return (
    <div style={{ display: 'flex', gap: 12, fontSize: 13 }}>
      <span style={{ minWidth: 80, color: 'var(--text-muted)', textTransform: 'uppercase', fontSize: 11, fontWeight: 700, letterSpacing: '0.06em' }}>{k}</span>
      <span style={{ color: 'var(--text-primary)', fontWeight: 600, whiteSpace: preserveLines ? 'pre-wrap' : 'normal' }}>{v}</span>
    </div>
  );
}

function fmt(d) {
  if (!d) return '';
  return new Date(d).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}
