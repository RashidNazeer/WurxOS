import { useMemo, useState } from 'react';
import { useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '../../lib/supabase';
import {
  listAdjustmentsForMonth,
  addAdjustment, deleteAdjustment, bulkMarkMissedAsPresent,
  summarizeMonth, fmtMs,
} from '../../lib/attendanceApi';
import { useAuth } from '../../contexts/AuthContext';
import { XIcon, AlertIcon, CheckIcon } from '../common/Icon';

// --------------------------------------------------------------
// Roster tab — Boss + OL: per-user monthly summary cards with a
// click-to-toggle calendar modal for manual adjustments and a
// bulk "Mark all missed as present" action.
// --------------------------------------------------------------
export default function RosterTab() {
  const { user, profile } = useAuth();
  const role = profile?.role;
  const canManage = ['boss', 'ol', 'developer'].includes(role);

  // Month picker — defaults to current month.
  const [monthStr, setMonthStr] = useState(() => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  });
  const monthRange = useMemo(() => monthRangeFor(monthStr), [monthStr]);

  // People — every active user. RLS already restricts what Boss/OL
  // can see; the table-level select policy returns everyone.
  const usersQ = useQuery({
    queryKey: ['roster', 'users'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('profiles')
        .select('id, display_name, email, role, avatar_url, is_active')
        .eq('is_active', true)
        .order('role')
        .order('display_name');
      if (error) throw new Error(error.message);
      return data || [];
    },
  });

  // Attendance rows for the whole month, all users in scope.
  const attendanceQ = useQuery({
    queryKey: ['roster', 'attendance', monthStr],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('attendance')
        .select('id, user_id, date, clock_in, clock_out, total_work_ms')
        .gte('date', monthRange.start)
        .lte('date', monthRange.end);
      if (error) throw new Error(error.message);
      return data || [];
    },
  });

  // Manual adjustments for the month.
  const adjustQ = useQuery({
    queryKey: ['roster', 'adjustments', monthStr],
    queryFn: () => listAdjustmentsForMonth(monthStr),
  });

  // Approved leaves overlapping the month (one fetch covers everyone).
  const leavesQ = useQuery({
    queryKey: ['roster', 'leaves', monthStr],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('leave_requests')
        .select('requester_id, start_date, end_date')
        .eq('status', 'approved')
        // WFH days still have a clock-in (from home), so they're not
        // leaves for attendance-coverage math — only medical/emergency
        // count. Avoids painting a WFH day blue when the user didn't
        // happen to clock in.
        .in('type', ['medical', 'emergency'])
        .lte('start_date', monthRange.end)
        .gte('end_date',   monthRange.start);
      if (error) throw new Error(error.message);
      return data || [];
    },
  });

  const loading = usersQ.isPending || attendanceQ.isPending || adjustQ.isPending || leavesQ.isPending;
  const error = [usersQ, attendanceQ, adjustQ, leavesQ].find((q) => q.error)?.error;

  // Per-user leave date sets (Mon–Fri only, clamped to month).
  const leaveDatesByUser = useMemo(() => {
    const map = new Map();
    const start = monthRange.start;
    const end   = monthRange.end;
    (leavesQ.data || []).forEach((lv) => {
      let set = map.get(lv.requester_id);
      if (!set) { set = new Set(); map.set(lv.requester_id, set); }
      const cur = new Date(lv.start_date + 'T00:00:00');
      const stop = new Date(lv.end_date  + 'T00:00:00');
      while (cur <= stop) {
        const dow = cur.getDay();
        if (dow !== 0 && dow !== 6) {
          const ds = ymd(cur);
          if (ds >= start && ds <= end) set.add(ds);
        }
        cur.setDate(cur.getDate() + 1);
      }
    });
    return map;
  }, [leavesQ.data, monthRange.start, monthRange.end]);

  // Per-user summaries.
  const summaries = useMemo(() => {
    if (!usersQ.data || !attendanceQ.data || !adjustQ.data) return [];
    const today = new Date();
    return usersQ.data.map((u) => {
      const rows = attendanceQ.data.filter((r) => r.user_id === u.id);
      const adjusts = adjustQ.data.filter((a) => a.user_id === u.id);
      const leaveDates = leaveDatesByUser.get(u.id) || new Set();
      const s = summarizeMonth({ rows, adjustments: adjusts, leaveDates, monthStr, today });
      return { user: u, summary: s };
    });
  }, [usersQ.data, attendanceQ.data, adjustQ.data, leaveDatesByUser, monthStr]);

  // OL can't adjust self or other OLs; Boss/Developer can adjust everyone.
  function canAdjustUser(u) {
    if (!canManage) return false;
    if (role === 'boss' || role === 'developer') return true;
    if (role === 'ol') {
      if (u.id === user?.id) return false;
      if (u.role === 'ol') return false;
      return true;
    }
    return false;
  }

  const totalMissedAcrossTargets = useMemo(() => {
    return summaries
      .filter((s) => canAdjustUser(s.user))
      .reduce((n, s) => n + s.summary.missedDays, 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [summaries, role, user?.id]);

  const [adjustTarget, setAdjustTarget] = useState(null);
  const [bulkOpen, setBulkOpen] = useState(false);

  if (!canManage) {
    return (
      <div className="wx-alert wx-alert-warning" style={{ marginTop: 12 }}>
        <AlertIcon width="14" height="14" />
        <span>Roster is available to Boss, OL, and Developer only.</span>
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <MonthStepper value={monthStr} onChange={setMonthStr} />
        <button
          type="button"
          className="wx-btn wx-btn-primary"
          disabled={totalMissedAcrossTargets === 0 || loading}
          onClick={() => setBulkOpen(true)}>
          Mark all {totalMissedAcrossTargets} missed day{totalMissedAcrossTargets === 1 ? '' : 's'} as present
        </button>
      </div>

      {error && (
        <div className="wx-alert wx-alert-danger">
          <AlertIcon width="14" height="14" /> <span>{error.message}</span>
        </div>
      )}

      {loading ? (
        <div className="att-empty" style={{ padding: 32 }}>
          <span className="wx-spinner" /> Loading roster…
        </div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 12 }}>
          {summaries.map(({ user: u, summary: s }) => (
            <RosterCard
              key={u.id}
              user={u}
              summary={s}
              canAdjust={canAdjustUser(u)}
              onAdjust={() => setAdjustTarget(u)}
            />
          ))}
        </div>
      )}

      {adjustTarget && (
        <RosterAdjustModal
          user={adjustTarget}
          monthStr={monthStr}
          onClose={() => setAdjustTarget(null)}
        />
      )}

      {bulkOpen && (
        <BulkMarkModal
          monthStr={monthStr}
          summaries={summaries.filter((s) => canAdjustUser(s.user))}
          onClose={() => setBulkOpen(false)}
        />
      )}
    </div>
  );
}

// --------------------------------------------------------------
// Per-user card
// --------------------------------------------------------------
function RosterCard({ user, summary, canAdjust, onAdjust }) {
  const pct = summary.workingDays > 0
    ? Math.round((summary.accountedDays / summary.workingDays) * 100)
    : 0;
  const tone = pct >= 80 ? 'success' : pct >= 50 ? 'warning' : 'danger';

  return (
    <div className="wx-card" style={{ padding: 14 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
        <Avatar user={user} />
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ fontWeight: 700, fontSize: 13.5, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {user.display_name || user.email}
          </div>
          <div style={{ fontSize: 11, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 0.4 }}>
            {user.role}
          </div>
        </div>
        <span style={{
          background: `color-mix(in srgb, var(--${tone}) 14%, transparent)`,
          color: `var(--${tone})`,
          border: `1px solid color-mix(in srgb, var(--${tone}) 35%, transparent)`,
          padding: '3px 8px', borderRadius: 999, fontSize: 11.5, fontWeight: 700,
        }}>
          {pct}%
        </span>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 6, marginBottom: 10 }}>
        <Cell tone="success" label="P" value={summary.presentDays}  />
        <Cell tone="info"    label="L" value={summary.leaveDays}    />
        <Cell tone="warning" label="A" value={summary.adjustedDays} />
        <Cell tone="danger"  label="M" value={summary.missedDays}   />
      </div>

      <div style={{ fontSize: 11.5, color: 'var(--text-muted)', marginBottom: 10 }}>
        {summary.accountedDays} / {summary.workingDays} days · {fmtMs(summary.totalWorkMs)}
      </div>

      {canAdjust && (
        <button type="button" className="wx-btn wx-btn-ghost wx-btn-sm" style={{ width: '100%' }}
          onClick={onAdjust}>
          Adjust
        </button>
      )}
    </div>
  );
}

function Cell({ tone, label, value }) {
  return (
    <div title={LEGEND[label]} style={{
      padding: '6px 4px', borderRadius: 8, textAlign: 'center',
      background: `color-mix(in srgb, var(--${tone}) 10%, transparent)`,
      border: `1px solid color-mix(in srgb, var(--${tone}) 25%, transparent)`,
    }}>
      <div style={{ fontSize: 9.5, fontWeight: 700, color: `var(--${tone})`, letterSpacing: 0.4 }}>{label}</div>
      <div style={{ fontWeight: 700, fontSize: 14 }}>{value}</div>
    </div>
  );
}

const LEGEND = { P: 'Present (clocked in)', L: 'Approved leave', A: 'Manually adjusted', M: 'Missed' };

// --------------------------------------------------------------
// Adjust modal — full-month calendar with click-to-toggle
// --------------------------------------------------------------
function RosterAdjustModal({ user, monthStr, onClose }) {
  const qc = useQueryClient();
  const monthRange = useMemo(() => monthRangeFor(monthStr), [monthStr]);
  const [note, setNote] = useState('');
  const [busyDate, setBusyDate] = useState(null);
  const [err, setErr] = useState('');

  // Live per-user data so the calendar stays in sync after each toggle.
  const results = useQueries({
    queries: [
      {
        queryKey: ['roster', 'user-attendance', user.id, monthStr],
        queryFn: async () => {
          const { data, error } = await supabase
            .from('attendance')
            .select('date, clock_in')
            .eq('user_id', user.id)
            .gte('date', monthRange.start)
            .lte('date', monthRange.end);
          if (error) throw new Error(error.message);
          return data || [];
        },
      },
      {
        queryKey: ['roster', 'user-adjustments', user.id, monthStr],
        queryFn: async () => {
          const { data, error } = await supabase
            .from('attendance_adjustments')
            .select('date, note')
            .eq('user_id', user.id)
            .gte('date', monthRange.start)
            .lte('date', monthRange.end);
          if (error) throw new Error(error.message);
          return data || [];
        },
      },
      {
        queryKey: ['roster', 'user-leaves', user.id, monthStr],
        queryFn: async () => {
          const { data, error } = await supabase
            .from('leave_requests')
            .select('start_date, end_date')
            .eq('requester_id', user.id)
            .eq('status', 'approved')
            .in('type', ['medical', 'emergency'])
            .lte('start_date', monthRange.end)
            .gte('end_date',   monthRange.start);
          if (error) throw new Error(error.message);
          return data || [];
        },
      },
    ],
  });
  const [attQ, adjQ, leaveQ] = results;
  const presentSet = useMemo(() => {
    const s = new Set();
    (attQ.data || []).forEach((r) => { if (r.clock_in) s.add(r.date); });
    return s;
  }, [attQ.data]);
  const adjustSet = useMemo(() => new Set((adjQ.data || []).map((a) => a.date)), [adjQ.data]);
  const leaveSet = useMemo(() => {
    const s = new Set();
    (leaveQ.data || []).forEach((lv) => {
      const cur = new Date(lv.start_date + 'T00:00:00');
      const stop = new Date(lv.end_date  + 'T00:00:00');
      while (cur <= stop) {
        const dow = cur.getDay();
        if (dow !== 0 && dow !== 6) s.add(ymd(cur));
        cur.setDate(cur.getDate() + 1);
      }
    });
    return s;
  }, [leaveQ.data]);

  const todayStr = ymd(new Date());

  async function toggle(ds, kind) {
    if (busyDate) return;
    setBusyDate(ds); setErr('');
    try {
      if (kind === 'adjusted') {
        await deleteAdjustment({ userId: user.id, date: ds });
      } else if (kind === 'missed') {
        await addAdjustment({ userId: user.id, date: ds, note: note.trim() || null });
      }
      // Invalidate both this modal's queries and the parent roster's.
      await Promise.all([
        qc.invalidateQueries({ queryKey: ['roster', 'user-attendance', user.id, monthStr] }),
        qc.invalidateQueries({ queryKey: ['roster', 'user-adjustments', user.id, monthStr] }),
        qc.invalidateQueries({ queryKey: ['roster', 'adjustments', monthStr] }),
      ]);
    } catch (e) { setErr(e.message); }
    finally { setBusyDate(null); }
  }

  // Build calendar grid rows (6 × 7 max). Mon-first.
  const cells = useMemo(() => buildCalendar(monthStr), [monthStr]);

  return (
    <div className="wx-modal-backdrop" onClick={onClose}>
      <div className="wx-modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 560 }}>
        <div className="wx-modal-header">
          <div className="wx-modal-title">{user.display_name} — {monthLabel(monthStr)}</div>
          <button type="button" className="shell-icon-btn" onClick={onClose}>
            <XIcon width="16" height="16" />
          </button>
        </div>
        <div className="wx-modal-body" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {err && (
            <div className="wx-alert wx-alert-danger">
              <AlertIcon width="14" height="14" /> <span>{err}</span>
            </div>
          )}

          <div>
            <label className="wx-label">Note for next click (optional)</label>
            <input className="wx-input" value={note} onChange={(e) => setNote(e.target.value)}
              placeholder="Reason for marking missed days as present" />
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: 4 }}>
            {['Mon','Tue','Wed','Thu','Fri','Sat','Sun'].map((d) => (
              <div key={d} style={{ fontSize: 10.5, fontWeight: 700, textAlign: 'center', color: 'var(--text-muted)', letterSpacing: 0.4 }}>
                {d}
              </div>
            ))}
            {cells.map((c) => {
              if (!c) return <div key={Math.random()} />;
              const ds = c.ds;
              const isWeekend = c.dow === 0 || c.dow === 6;
              const isFuture  = ds > todayStr;
              const present   = presentSet.has(ds);
              const adjusted  = adjustSet.has(ds);
              const leave     = leaveSet.has(ds);
              const missed    = !present && !adjusted && !leave && !isWeekend && !isFuture;
              const kind      = present ? 'present' : leave ? 'leave' : adjusted ? 'adjusted' : missed ? 'missed' : 'inert';
              const tone      = ({ present:'success', leave:'info', adjusted:'warning', missed:'danger', inert:'muted' })[kind];
              const clickable = (kind === 'missed' || kind === 'adjusted') && !busyDate;
              return (
                <button
                  key={ds}
                  type="button"
                  disabled={!clickable}
                  onClick={() => clickable && toggle(ds, kind)}
                  title={`${ds} · ${kind}`}
                  style={{
                    padding: '10px 4px',
                    borderRadius: 6,
                    border: '1px solid var(--border-subtle)',
                    background: tone === 'muted'
                      ? 'transparent'
                      : `color-mix(in srgb, var(--${tone}) 14%, transparent)`,
                    color: tone === 'muted' ? 'var(--text-muted)' : `var(--${tone})`,
                    cursor: clickable ? 'pointer' : 'default',
                    opacity: busyDate === ds ? 0.5 : 1,
                    fontSize: 12, fontWeight: 700,
                    textAlign: 'center',
                  }}>
                  {c.day}
                </button>
              );
            })}
          </div>

          <div style={{ display: 'flex', gap: 12, fontSize: 11, color: 'var(--text-muted)', flexWrap: 'wrap' }}>
            <Legend tone="success" label="Present" />
            <Legend tone="info"    label="Leave" />
            <Legend tone="warning" label="Adjusted" />
            <Legend tone="danger"  label="Missed (click to add)" />
          </div>
        </div>
        <div className="wx-modal-footer">
          <button type="button" className="wx-btn wx-btn-ghost" onClick={onClose}>Done</button>
        </div>
      </div>
    </div>
  );
}

function Legend({ tone, label }) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
      <span style={{ width: 10, height: 10, borderRadius: 3, background: `color-mix(in srgb, var(--${tone}) 30%, transparent)`, border: `1px solid color-mix(in srgb, var(--${tone}) 60%, transparent)` }} />
      {label}
    </span>
  );
}

// --------------------------------------------------------------
// Bulk mark modal — confirms per-user breakdown then runs
// --------------------------------------------------------------
function BulkMarkModal({ monthStr, summaries, onClose }) {
  const qc = useQueryClient();
  const [note, setNote] = useState('');
  const [running, setRunning] = useState(false);
  const [err, setErr] = useState('');
  const [result, setResult] = useState(null);

  const breakdown = summaries
    .filter((s) => s.summary.missedDays > 0)
    .sort((a, b) => b.summary.missedDays - a.summary.missedDays);
  const total = breakdown.reduce((n, s) => n + s.summary.missedDays, 0);

  async function run() {
    setRunning(true); setErr('');
    try {
      const r = await bulkMarkMissedAsPresent({
        monthStr,
        userIds: breakdown.map((s) => s.user.id),
        note: note.trim() || null,
      });
      setResult(r);
      await Promise.all([
        qc.invalidateQueries({ queryKey: ['roster', 'adjustments', monthStr] }),
        qc.invalidateQueries({ queryKey: ['roster', 'attendance', monthStr] }),
      ]);
    } catch (e) { setErr(e.message); }
    finally { setRunning(false); }
  }

  return (
    <div className="wx-modal-backdrop" onClick={running ? undefined : onClose}>
      <div className="wx-modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 520 }}>
        <div className="wx-modal-header">
          <div className="wx-modal-title">Mark all missed days as present</div>
          <button type="button" className="shell-icon-btn" onClick={onClose} disabled={running}>
            <XIcon width="16" height="16" />
          </button>
        </div>
        <div className="wx-modal-body" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {err && (
            <div className="wx-alert wx-alert-danger">
              <AlertIcon width="14" height="14" /> <span>{err}</span>
            </div>
          )}

          {result ? (
            <div className="wx-alert" style={{
              background: 'color-mix(in srgb, var(--success) 14%, transparent)',
              color: 'var(--success)',
              border: '1px solid color-mix(in srgb, var(--success) 35%, transparent)',
            }}>
              <CheckIcon width="14" height="14" />
              <span>
                Marked {result.days_added} day{result.days_added === 1 ? '' : 's'} present across {result.users_touched} user{result.users_touched === 1 ? '' : 's'}.
              </span>
            </div>
          ) : (
            <>
              <div style={{ fontSize: 13 }}>
                <strong>{total}</strong> missed weekday{total === 1 ? '' : 's'} across <strong>{breakdown.length}</strong> user{breakdown.length === 1 ? '' : 's'} for {monthLabel(monthStr)}.
                Each will be marked present and notified.
              </div>

              <div style={{ maxHeight: 220, overflow: 'auto', border: '1px solid var(--border-subtle)', borderRadius: 8 }}>
                {breakdown.map((s) => (
                  <div key={s.user.id} style={{
                    display: 'flex', justifyContent: 'space-between', padding: '8px 12px',
                    borderBottom: '1px solid var(--border-subtle)', fontSize: 12.5,
                  }}>
                    <span>{s.user.display_name} <span style={{ color: 'var(--text-muted)' }}>({s.user.role})</span></span>
                    <strong>{s.summary.missedDays}</strong>
                  </div>
                ))}
              </div>

              <div>
                <label className="wx-label">Note (optional, sent to every affected user)</label>
                <textarea className="wx-input" rows={2} value={note}
                  onChange={(e) => setNote(e.target.value)} disabled={running}
                  placeholder="e.g. Backfilling missed days for the public holiday week." />
              </div>
            </>
          )}
        </div>
        <div className="wx-modal-footer">
          {result ? (
            <button type="button" className="wx-btn wx-btn-primary" onClick={onClose}>Done</button>
          ) : (
            <>
              <button type="button" className="wx-btn wx-btn-ghost" onClick={onClose} disabled={running}>Cancel</button>
              <button type="button" className="wx-btn wx-btn-primary" onClick={run}
                disabled={running || total === 0}>
                {running ? <><span className="wx-spinner" /> Marking…</> : `Mark ${total} present`}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// --------------------------------------------------------------
// Helpers
// --------------------------------------------------------------
function MonthStepper({ value, onChange }) {
  function step(delta) {
    const [y, m] = value.split('-').map(Number);
    const d = new Date(y, m - 1 + delta, 1);
    onChange(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`);
  }
  const isCurrent = (() => {
    const d = new Date();
    return value === `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  })();
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
      <button type="button" className="wx-btn wx-btn-ghost wx-btn-sm" onClick={() => step(-1)}>‹</button>
      <strong style={{ minWidth: 140, textAlign: 'center' }}>{monthLabel(value)}</strong>
      <button type="button" className="wx-btn wx-btn-ghost wx-btn-sm" onClick={() => step(1)} disabled={isCurrent}>›</button>
    </div>
  );
}

function Avatar({ user }) {
  if (user?.avatar_url) {
    return (
      <div className="att-avatar att-avatar-sm">
        <img src={user.avatar_url} alt={user.display_name || ''} />
      </div>
    );
  }
  const initials = (user?.display_name || user?.email || '?').slice(0, 1).toUpperCase();
  return (
    <div className="att-avatar att-avatar-sm" style={{ display: 'grid', placeItems: 'center', background: 'var(--surface-2)', color: 'var(--text-secondary)', fontWeight: 700 }}>
      {initials}
    </div>
  );
}

function ymd(d) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function monthRangeFor(monthStr) {
  const [y, m] = monthStr.split('-').map(Number);
  const last = new Date(y, m, 0).getDate();
  return {
    start: `${y}-${String(m).padStart(2, '0')}-01`,
    end:   `${y}-${String(m).padStart(2, '0')}-${String(last).padStart(2, '0')}`,
  };
}

function monthLabel(monthStr) {
  const [y, m] = monthStr.split('-').map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
}

function buildCalendar(monthStr) {
  const [y, m] = monthStr.split('-').map(Number);
  const last = new Date(y, m, 0).getDate();
  // Mon-first: shift so Mon=0..Sun=6
  const firstDow = (new Date(y, m - 1, 1).getDay() + 6) % 7;
  const cells = [];
  for (let i = 0; i < firstDow; i++) cells.push(null);
  for (let day = 1; day <= last; day++) {
    const d = new Date(y, m - 1, day);
    cells.push({ day, ds: ymd(d), dow: d.getDay() });
  }
  while (cells.length % 7 !== 0) cells.push(null);
  return cells;
}
