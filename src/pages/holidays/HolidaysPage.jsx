import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  listAllHolidays, createHoliday, updateHoliday, deleteHoliday,
} from '../../lib/holidaysApi';
import { PlusIcon, PencilIcon, TrashIcon, CalendarIcon, XIcon } from '../../components/common/Icon';

function fmtDate(ds) {
  if (!ds) return '';
  const [y, m, d] = ds.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  return dt.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

function rangeDays(startDate, endDate) {
  if (!startDate || !endDate) return 0;
  const a = new Date(startDate + 'T00:00:00').getTime();
  const b = new Date(endDate   + 'T00:00:00').getTime();
  if (b < a) return 0;
  return Math.round((b - a) / 86400000) + 1;
}

function weekdayCount(startDate, endDate) {
  if (!startDate || !endDate) return 0;
  let count = 0;
  const a = new Date(startDate + 'T00:00:00').getTime();
  const b = new Date(endDate   + 'T00:00:00').getTime();
  for (let t = a; t <= b; t += 86400000) {
    const dow = new Date(t).getDay();
    if (dow !== 0 && dow !== 6) count++;
  }
  return count;
}

export default function HolidaysPage() {
  const qc = useQueryClient();
  const { data: holidays = [], isLoading, error, refetch } = useQuery({
    queryKey: ['company-holidays', 'all'],
    queryFn: listAllHolidays,
    staleTime: 60_000,
  });

  const [editTarget, setEditTarget] = useState(null);
  const [creating, setCreating]     = useState(false);

  function reload() {
    qc.invalidateQueries({ queryKey: ['company-holidays'] });
    // Also bust the per-month caches used by attendance/perf pages so the
    // change reflects immediately without a hard reload.
    qc.invalidateQueries({ queryKey: ['attendance', 'monthly-holidays'] });
    refetch();
  }

  return (
    <>
      <div className="page-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: 12 }}>
        <div>
          <h1 className="page-title">Company Holidays</h1>
          <p className="page-subtitle">
            Days marked here are credited as present for everyone. Leaves that overlap a holiday don't charge those days against the quota.
          </p>
        </div>
        <button className="wx-btn wx-btn-primary" onClick={() => setCreating(true)}>
          <PlusIcon width="15" height="15" /> Add holiday
        </button>
      </div>

      <div className="wx-card" style={{ padding: 0 }}>
        {isLoading ? (
          <EmptyState icon="bi-hourglass-split" title="Loading…" sub="" />
        ) : error ? (
          <EmptyState icon="bi-exclamation-triangle" title="Couldn't load holidays" sub={error.message} />
        ) : holidays.length === 0 ? (
          <EmptyState
            icon="bi-calendar-event"
            title="No holidays yet"
            sub="Click Add holiday to mark days like Eid or company-wide off-days."
          />
        ) : (
          <div>
            {holidays.map((h, i) => (
              <HolidayRow
                key={h.id}
                h={h}
                isLast={i === holidays.length - 1}
                onEdit={() => setEditTarget(h)}
                onDelete={async () => {
                  if (!confirm(`Delete holiday "${h.label}"?`)) return;
                  try {
                    await deleteHoliday(h.id);
                    reload();
                  } catch (err) {
                    alert(err.message || 'Failed to delete');
                  }
                }}
              />
            ))}
          </div>
        )}
      </div>

      {(creating || editTarget) && (
        <HolidayModal
          target={editTarget}
          onClose={() => { setCreating(false); setEditTarget(null); }}
          onSaved={() => { setCreating(false); setEditTarget(null); reload(); }}
        />
      )}
    </>
  );
}

function HolidayRow({ h, isLast, onEdit, onDelete }) {
  const totalDays = rangeDays(h.startDate, h.endDate);
  const weekdays  = weekdayCount(h.startDate, h.endDate);
  const sameDay   = h.startDate === h.endDate;
  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: '44px 1fr auto',
        gap: 14,
        alignItems: 'center',
        padding: '14px 18px',
        borderBottom: isLast ? 0 : '1px solid var(--border-subtle)',
        background: 'var(--surface-1)',
      }}
    >
      <div
        style={{
          width: 40, height: 40, borderRadius: 'var(--radius-md)',
          background: 'rgba(168, 85, 247, 0.15)',
          color: '#a855f7',
          display: 'grid', placeItems: 'center',
        }}
      >
        <CalendarIcon width="18" height="18" />
      </div>
      <div style={{ minWidth: 0 }}>
        <div style={{ fontWeight: 700, fontSize: 14, color: 'var(--text-primary)' }}>
          {h.label}
        </div>
        <div style={{ fontSize: 12.5, color: 'var(--text-secondary)' }}>
          {sameDay
            ? fmtDate(h.startDate)
            : `${fmtDate(h.startDate)} → ${fmtDate(h.endDate)}`
          }
          {' · '}
          <span style={{ color: 'var(--text-muted)' }}>
            {totalDays} day{totalDays === 1 ? '' : 's'}
            {totalDays !== weekdays && ` (${weekdays} weekday${weekdays === 1 ? '' : 's'})`}
          </span>
        </div>
        {h.notes && (
          <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 2 }}>{h.notes}</div>
        )}
      </div>
      <div style={{ display: 'flex', gap: 6 }}>
        <button className="wx-btn wx-btn-ghost" onClick={onEdit} title="Edit">
          <PencilIcon width="14" height="14" />
        </button>
        <button className="wx-btn wx-btn-ghost" onClick={onDelete} title="Delete">
          <TrashIcon width="14" height="14" />
        </button>
      </div>
    </div>
  );
}

function HolidayModal({ target, onClose, onSaved }) {
  const isEdit = !!target;
  const [startDate, setStartDate] = useState(target?.startDate || '');
  const [endDate, setEndDate]     = useState(target?.endDate   || '');
  const [label, setLabel]         = useState(target?.label     || '');
  const [notes, setNotes]         = useState(target?.notes     || '');
  const [saving, setSaving]       = useState(false);
  const [err, setErr]             = useState('');

  // If start is set and end isn't (or end < start), keep end in sync.
  useEffect(() => {
    if (startDate && (!endDate || endDate < startDate)) setEndDate(startDate);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [startDate]);

  const totalDays = rangeDays(startDate, endDate);
  const weekdays  = weekdayCount(startDate, endDate);

  async function submit(e) {
    e.preventDefault();
    setErr('');
    if (!startDate || !endDate || !label.trim()) {
      setErr('Start date, end date, and label are required.');
      return;
    }
    if (endDate < startDate) {
      setErr('End date must be on or after the start date.');
      return;
    }
    setSaving(true);
    try {
      if (isEdit) {
        await updateHoliday(target.id, { startDate, endDate, label, notes });
      } else {
        await createHoliday({ startDate, endDate, label, notes });
      }
      onSaved();
    } catch (e2) {
      setErr(e2.message || 'Failed to save');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0,
        background: 'rgba(15, 23, 42, 0.55)',
        display: 'grid', placeItems: 'center',
        zIndex: 1100,
        padding: 16,
      }}
    >
      <form
        onClick={(e) => e.stopPropagation()}
        onSubmit={submit}
        className="wx-card"
        style={{ width: 480, maxWidth: '100%', padding: 0, display: 'flex', flexDirection: 'column' }}
      >
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '14px 18px', borderBottom: '1px solid var(--border-subtle)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <div style={{
              width: 36, height: 36, borderRadius: 'var(--radius-md)',
              background: 'rgba(168, 85, 247, 0.15)', color: '#a855f7',
              display: 'grid', placeItems: 'center',
            }}>
              <CalendarIcon width="18" height="18" />
            </div>
            <div>
              <div style={{ fontSize: 15, fontWeight: 700, color: 'var(--text-primary)' }}>
                {isEdit ? 'Edit holiday' : 'Add holiday'}
              </div>
              <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                Counts as present for the whole team
              </div>
            </div>
          </div>
          <button type="button" onClick={onClose} className="wx-btn wx-btn-ghost" aria-label="Close">
            <XIcon width="14" height="14" />
          </button>
        </div>
        <div style={{ padding: 18, display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div>
            <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-secondary)', marginBottom: 4, display: 'block' }}>
              Label
            </label>
            <input
              type="text" value={label} onChange={(e) => setLabel(e.target.value)}
              placeholder="e.g. Eid-ul-Fitr"
              className="wx-input" autoFocus
              style={{ width: '100%' }}
            />
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <div>
              <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-secondary)', marginBottom: 4, display: 'block' }}>
                Start date
              </label>
              <input
                type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)}
                className="wx-input" style={{ width: '100%' }}
              />
            </div>
            <div>
              <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-secondary)', marginBottom: 4, display: 'block' }}>
                End date
              </label>
              <input
                type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} min={startDate || undefined}
                className="wx-input" style={{ width: '100%' }}
              />
            </div>
          </div>
          <div>
            <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-secondary)', marginBottom: 4, display: 'block' }}>
              Notes <span style={{ color: 'var(--text-muted)', fontWeight: 400 }}>(optional)</span>
            </label>
            <textarea
              value={notes} onChange={(e) => setNotes(e.target.value)} rows={2}
              className="wx-input" style={{ width: '100%', resize: 'vertical', minHeight: 60 }}
              placeholder="Anything the team should know"
            />
          </div>
          {totalDays > 0 && (
            <div style={{
              fontSize: 12.5, padding: '8px 12px', borderRadius: 8,
              background: 'rgba(168, 85, 247, 0.08)',
              color: 'var(--text-secondary)',
            }}>
              <strong>{totalDays}</strong> calendar day{totalDays === 1 ? '' : 's'}
              {totalDays !== weekdays && (
                <> · <strong>{weekdays}</strong> weekday{weekdays === 1 ? '' : 's'} (Sat/Sun skipped)</>
              )}
            </div>
          )}
          {err && (
            <div style={{ fontSize: 12, color: 'var(--danger)', padding: '8px 12px', background: 'rgba(239, 68, 68, 0.08)', borderRadius: 8 }}>
              {err}
            </div>
          )}
        </div>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, padding: '12px 18px', borderTop: '1px solid var(--border-subtle)' }}>
          <button type="button" onClick={onClose} className="wx-btn wx-btn-ghost" disabled={saving}>Cancel</button>
          <button type="submit" className="wx-btn wx-btn-primary" disabled={saving}>
            {saving ? 'Saving…' : isEdit ? 'Save changes' : 'Add holiday'}
          </button>
        </div>
      </form>
    </div>
  );
}

function EmptyState({ icon, title, sub }) {
  return (
    <div style={{ padding: 64, textAlign: 'center', color: 'var(--text-muted)' }}>
      <div style={{
        width: 52, height: 52, borderRadius: '50%',
        background: 'var(--surface-2)', color: 'var(--text-muted)',
        display: 'grid', placeItems: 'center', margin: '0 auto 14px',
      }}>
        <i className={`bi ${icon}`} style={{ fontSize: 22 }} />
      </div>
      <div style={{ fontSize: 15, fontWeight: 700, color: 'var(--text-primary)', marginBottom: 4 }}>{title}</div>
      {sub && <div style={{ fontSize: 13.5 }}>{sub}</div>}
    </div>
  );
}
