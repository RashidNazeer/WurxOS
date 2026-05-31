import { useMemo, useState, useEffect } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '../../../contexts/AuthContext';
import { listProfilesByRole } from '../../../lib/adminApi';
import {
  listAllCompensation, listAllHistory, formatPKR,
  yearsCompletedSince, setUserHireDate, computePendingReviews,
} from '../../../lib/salariesApi';
import SalaryReviewModal from '../../../components/boss/SalaryReviewModal';
import {
  AlertIcon, RefreshIcon, SearchIcon, StarIcon, PencilIcon, UsersIcon,
} from '../../../components/common/Icon';
import '../../../styles/table.css';
import '../../../styles/tasks.css';

// Roles considered "payroll-eligible". Boss is intentionally
// excluded per spec (owner, not payroll employee). See
// memory/salary-management.md.
const PAYROLL_ROLES = ['ol', 'tl', 'pctl', 'apc', 'ipc', 'developer'];

export default function BossSalariesPage() {
  const [tab, setTab] = useState('active');
  const [search, setSearch] = useState('');
  const [roleFilter, setRoleFilter] = useState('all');
  const [reviewTarget, setReviewTarget] = useState(null);   // { user, currentSalary }
  const [editingHireDate, setEditingHireDate] = useState(null); // user object

  const qc = useQueryClient();

  // Load every payroll-eligible profile, then load every existing
  // compensation row, and merge them. Users with no comp row show
  // up as "Not set" so the Boss can spot who still needs an entry.
  const profilesQuery = useQuery({
    queryKey: ['salaries', 'profiles'],
    queryFn: async () => {
      // listProfilesByRole returns one role at a time. We need every
      // payroll role at once — fan out and concat.
      const all = await Promise.all(PAYROLL_ROLES.map((r) => listProfilesByRole(r)));
      return all.flat();
    },
  });
  const compQuery = useQuery({
    queryKey: ['salaries', 'compensation'],
    queryFn: () => listAllCompensation(),
  });

  const loading = profilesQuery.isLoading || compQuery.isLoading;
  const error = profilesQuery.error?.message || compQuery.error?.message || '';
  const reload = () => qc.invalidateQueries({ queryKey: ['salaries'] });

  // Realtime: any salary change anywhere refreshes the list.
  useEffect(() => {
    import('../../../lib/supabase').then(({ supabase }) => {
      const ch = supabase
        .channel('salaries-live')
        .on('postgres_changes',
          { event: '*', schema: 'public', table: 'employee_compensation' },
          () => qc.invalidateQueries({ queryKey: ['salaries'] }))
        .on('postgres_changes',
          { event: '*', schema: 'public', table: 'salary_history' },
          () => qc.invalidateQueries({ queryKey: ['salaries'] }))
        .subscribe();
      // store unsubscribe on a ref-like closure for cleanup
      window.__salariesCh = ch;
    });
    return () => {
      if (window.__salariesCh) {
        import('../../../lib/supabase').then(({ supabase }) => {
          supabase.removeChannel(window.__salariesCh);
          delete window.__salariesCh;
        });
      }
    };
  }, [qc]);

  const rows = useMemo(() => {
    const compByUid = new Map();
    (compQuery.data || []).forEach((c) => { if (c.userId) compByUid.set(c.userId, c); });
    return (profilesQuery.data || [])
      .filter((p) => p.is_active && !p.deleted_at)
      .map((p) => ({
        user: p,
        comp: compByUid.get(p.id) || null,
        yearsCompleted: yearsCompletedSince(p.start_date),
      }))
      .sort((a, b) => (a.user.display_name || '').localeCompare(b.user.display_name || ''));
  }, [profilesQuery.data, compQuery.data]);

  const filtered = useMemo(() => {
    let list = rows;
    if (roleFilter !== 'all') list = list.filter((r) => r.user.role === roleFilter);
    const q = search.trim().toLowerCase();
    if (q) {
      list = list.filter((r) =>
        (r.user.display_name || '').toLowerCase().includes(q) ||
        (r.user.email || '').toLowerCase().includes(q));
    }
    return list;
  }, [rows, search, roleFilter]);

  const stats = useMemo(() => {
    const total = rows.length;
    const set = rows.filter((r) => r.comp != null).length;
    return { total, set, unset: total - set };
  }, [rows]);

  // Pending Reviews uses the same fetched data plus full history.
  const pendingHistoryQuery = useQuery({
    queryKey: ['salaries', 'history-all'],
    queryFn: () => listAllHistory({ limit: 1000 }),
    // Reuse cache between History tab and Pending tab.
    staleTime: 30_000,
  });
  const pendingRows = useMemo(() => computePendingReviews({
    profiles: profilesQuery.data || [],
    compRows: compQuery.data || [],
    historyRows: pendingHistoryQuery.data || [],
  }), [profilesQuery.data, compQuery.data, pendingHistoryQuery.data]);
  const pendingCount = pendingRows.length;

  return (
    <>
      <div className="page-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: 12 }}>
        <div>
          <h1 className="page-title">Salaries</h1>
          <p className="page-subtitle">
            {stats.set} of {stats.total} employees have a salary set
            {stats.unset > 0 && ` · ${stats.unset} pending initial entry`}
          </p>
        </div>
        <button className="wx-btn wx-btn-ghost" onClick={reload} disabled={loading} title="Refresh">
          <RefreshIcon width="15" height="15" />
        </button>
      </div>

      {/* Tabs — Active live; Pending Reviews + History stubbed until later phases. */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 14 }}>
        <div className="task-tabs">
          <button type="button"
            className={`task-tab ${tab === 'active' ? 'task-tab-active' : ''}`}
            onClick={() => setTab('active')}>
            Active Salaries <span className="task-tab-count">{stats.total}</span>
          </button>
          <button type="button"
            className={`task-tab ${tab === 'pending' ? 'task-tab-active' : ''}`}
            onClick={() => setTab('pending')}>
            Pending Reviews <span className="task-tab-count">{pendingCount}</span>
          </button>
          <button type="button"
            className={`task-tab ${tab === 'history' ? 'task-tab-active' : ''}`}
            onClick={() => setTab('history')}>
            Salary History
          </button>
        </div>
      </div>

      {error && (
        <div className="wx-alert wx-alert-danger" style={{ marginBottom: 14 }}>
          <AlertIcon width="16" height="16" /> <span>{error}</span>
        </div>
      )}

      {tab === 'active' && (
        <ActiveSalariesTab
          rows={filtered}
          loading={loading}
          search={search}
          setSearch={setSearch}
          roleFilter={roleFilter}
          setRoleFilter={setRoleFilter}
          totalRows={rows.length}
          onReview={(r) => setReviewTarget({ user: r.user, currentSalary: r.comp?.basicSalary ?? null })}
          onEditHireDate={(user) => setEditingHireDate(user)}
        />
      )}

      {tab === 'pending' && (
        <PendingReviewsTab
          rows={pendingRows}
          loading={pendingHistoryQuery.isLoading}
          onReview={(r) => setReviewTarget({ user: r.user, currentSalary: r.comp?.basicSalary ?? null })}
        />
      )}

      {tab === 'history' && (
        <SalaryHistoryTab />
      )}

      {reviewTarget && (
        <SalaryReviewModal
          user={reviewTarget.user}
          currentSalary={reviewTarget.currentSalary}
          canEdit={true}
          onClose={() => setReviewTarget(null)}
          onSaved={() => { setReviewTarget(null); reload(); }}
        />
      )}

      {editingHireDate && (
        <HireDateModal
          user={editingHireDate}
          onClose={() => setEditingHireDate(null)}
          onSaved={() => { setEditingHireDate(null); reload(); }}
        />
      )}
    </>
  );
}

function ActiveSalariesTab({
  rows, loading, search, setSearch, roleFilter, setRoleFilter, totalRows,
  onReview, onEditHireDate,
}) {
  return (
    <>
      <div className="wx-toolbar">
        <div className="wx-search">
          <span className="wx-search-icon"><SearchIcon width="16" height="16" /></span>
          <input
            className="wx-input"
            placeholder="Search by name or email…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {['all', ...PAYROLL_ROLES].map((r) => (
            <button
              key={r}
              type="button"
              className={`wx-role-chip ${roleFilter === r ? 'wx-role-chip-active' : ''}`}
              onClick={() => setRoleFilter(r)}
            >
              {r === 'all' ? 'All roles' : r.toUpperCase()}
            </button>
          ))}
        </div>
      </div>

      <div className="wx-list">
        <div className="wx-list-row wx-list-header"
          style={{ gridTemplateColumns: '1.6fr 1fr 1fr 0.8fr 1fr 140px' }}>
          <div>Employee</div>
          <div>Hire date</div>
          <div>Current salary</div>
          <div>Years</div>
          <div>Last updated</div>
          <div />
        </div>

        {loading && (
          <div className="wx-empty">
            <span className="wx-spinner" style={{ color: 'var(--accent)' }} /> Loading…
          </div>
        )}

        {!loading && rows.length === 0 && (
          <div className="wx-empty">
            <div style={{ display: 'grid', placeItems: 'center', width: 48, height: 48, borderRadius: 'var(--radius-pill)', background: 'var(--surface-2)', color: 'var(--text-muted)', margin: '0 auto 12px' }}>
              <UsersIcon width="22" height="22" />
            </div>
            <div className="wx-empty-title">No employees match</div>
            <div>{totalRows === 0 ? 'No active payroll employees found.' : 'Try a different search or role filter.'}</div>
          </div>
        )}

        {!loading && rows.map((r) => (
          <SalaryRow
            key={r.user.id}
            r={r}
            onReview={() => onReview(r)}
            onEditHireDate={() => onEditHireDate(r.user)}
          />
        ))}
      </div>
    </>
  );
}

function SalaryRow({ r, onReview, onEditHireDate }) {
  const initials = (r.user.display_name || r.user.email || '?')
    .split(/\s+/).map((s) => s[0]).slice(0, 2).join('').toUpperCase();
  const hasSalary = r.comp != null;
  const lastChanged = r.comp?.updatedAt
    ? new Date(r.comp.updatedAt).toLocaleDateString()
    : '—';

  return (
    <div className="wx-list-row"
      style={{ gridTemplateColumns: '1.6fr 1fr 1fr 0.8fr 1fr 140px' }}>
      <div className="wx-user-cell">
        <div className="wx-user-avatar">
          {r.user.avatar_url
            ? <img src={r.user.avatar_url} alt="" style={{ width: '100%', height: '100%', borderRadius: 'inherit', objectFit: 'cover' }} />
            : initials}
        </div>
        <div style={{ minWidth: 0 }}>
          <div className="wx-user-name">{r.user.display_name || '—'}</div>
          <div style={{ fontSize: 11.5, color: 'var(--text-muted)', marginTop: 2, display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
            <span style={{
              fontSize: 10.5,
              padding: '1px 7px',
              borderRadius: 'var(--radius-pill)',
              background: 'var(--accent-soft)',
              color: 'var(--accent)',
              fontWeight: 700,
            }}>
              {(r.user.role || '').toUpperCase()}
            </span>
            <span>{r.user.email}</span>
          </div>
        </div>
      </div>

      <div style={{ fontSize: 12.5, color: 'var(--text-primary)', display: 'flex', alignItems: 'center', gap: 6 }}>
        {r.user.start_date || <span style={{ color: 'var(--text-muted)', fontStyle: 'italic' }}>Not set</span>}
        <button
          type="button"
          className="shell-icon-btn"
          onClick={onEditHireDate}
          title="Edit hire date"
          aria-label="Edit hire date"
          style={{ padding: 2 }}
        >
          <PencilIcon width="11" height="11" />
        </button>
      </div>

      <div style={{ fontSize: 13, fontWeight: 600, color: hasSalary ? 'var(--text-primary)' : 'var(--text-muted)' }}>
        {hasSalary
          ? formatPKR(r.comp.basicSalary)
          : <span style={{ fontWeight: 500, fontStyle: 'italic' }}>Not set</span>}
      </div>

      <div style={{ fontSize: 12.5, color: 'var(--text-primary)' }}>
        {r.user.start_date
          ? `${r.yearsCompleted} ${r.yearsCompleted === 1 ? 'yr' : 'yrs'}`
          : '—'}
      </div>

      <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
        {lastChanged}
      </div>

      <div style={{ textAlign: 'right' }}>
        <button
          className="wx-btn wx-btn-primary"
          style={{ padding: '6px 12px', fontSize: 12.5 }}
          onClick={onReview}
        >
          <StarIcon width="13" height="13" /> {hasSalary ? 'Review' : 'Set salary'}
        </button>
      </div>
    </div>
  );
}

function HireDateModal({ user, onClose, onSaved }) {
  const [date, setDate] = useState(user.start_date || '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  async function handleSubmit(e) {
    e.preventDefault();
    setError('');
    if (!date) return setError('Pick a hire date.');
    setSaving(true);
    try {
      await setUserHireDate(user.id, date);
      onSaved?.();
    } catch (err) {
      setError(err.message || 'Failed to save hire date.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="wx-modal-backdrop" onClick={onClose}>
      <div className="wx-modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 420 }}>
        <form onSubmit={handleSubmit}>
          <div className="wx-modal-header">
            <div className="wx-modal-title">Edit hire date</div>
            <button type="button" className="shell-icon-btn" onClick={onClose} aria-label="Close">
              <span aria-hidden>×</span>
            </button>
          </div>
          <div className="wx-modal-body">
            {error && (
              <div className="wx-alert wx-alert-danger" style={{ marginBottom: 12 }}>
                <AlertIcon width="16" height="16" /> <span>{error}</span>
              </div>
            )}
            <div style={{ fontSize: 13, color: 'var(--text-primary)', marginBottom: 12 }}>
              Setting the hire date for <strong>{user.display_name || user.email}</strong>.
            </div>
            <label className="wx-label">Hire date</label>
            <input
              type="date"
              className="wx-input"
              value={date}
              onChange={(e) => setDate(e.target.value)}
              disabled={saving}
              required
              autoFocus
            />
            <div style={{ fontSize: 11.5, color: 'var(--text-muted)', marginTop: 6 }}>
              Anniversary celebrations and years-completed counts derive from this date.
            </div>
          </div>
          <div className="wx-modal-footer">
            <button type="button" className="wx-btn wx-btn-ghost" onClick={onClose} disabled={saving}>
              Cancel
            </button>
            <button type="submit" className="wx-btn wx-btn-primary" disabled={saving}>
              {saving ? <><span className="wx-spinner" /> Saving…</> : 'Save'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ── Pending Reviews tab ───────────────────────────────────────
// Employees who have completed ≥1 year AND have fewer
// annual_increment rows than years_completed. Pre-launch
// anniversaries surface here exactly the same as post-launch ones,
// per spec.
function PendingReviewsTab({ rows, loading, onReview }) {
  return (
    <>
      <div className="wx-list">
        <div className="wx-list-row wx-list-header"
          style={{ gridTemplateColumns: '1.6fr 1fr 1fr 0.9fr 1fr 140px' }}>
          <div>Employee</div>
          <div>Hire date</div>
          <div>Years</div>
          <div>Overdue</div>
          <div>Current salary</div>
          <div />
        </div>

        {loading && (
          <div className="wx-empty">
            <span className="wx-spinner" style={{ color: 'var(--accent)' }} /> Loading…
          </div>
        )}

        {!loading && rows.length === 0 && (
          <div className="wx-empty">
            <div style={{ display: 'grid', placeItems: 'center', width: 48, height: 48, borderRadius: 'var(--radius-pill)', background: 'var(--success-soft)', color: 'var(--success)', margin: '0 auto 12px' }}>
              <StarIcon width="22" height="22" />
            </div>
            <div className="wx-empty-title">All caught up</div>
            <div>Every employee with a completed work anniversary has a recent annual review on file.</div>
          </div>
        )}

        {!loading && rows.map((r) => (
          <PendingRow key={r.user.id} r={r} onReview={() => onReview(r)} />
        ))}
      </div>
    </>
  );
}

function PendingRow({ r, onReview }) {
  const initials = (r.user.display_name || r.user.email || '?')
    .split(/\s+/).map((s) => s[0]).slice(0, 2).join('').toUpperCase();
  return (
    <div className="wx-list-row"
      style={{ gridTemplateColumns: '1.6fr 1fr 1fr 0.9fr 1fr 140px' }}>
      <div className="wx-user-cell">
        <div className="wx-user-avatar">
          {r.user.avatar_url
            ? <img src={r.user.avatar_url} alt="" style={{ width: '100%', height: '100%', borderRadius: 'inherit', objectFit: 'cover' }} />
            : initials}
        </div>
        <div style={{ minWidth: 0 }}>
          <div className="wx-user-name">{r.user.display_name || '—'}</div>
          <div style={{ fontSize: 11.5, color: 'var(--text-muted)', marginTop: 2 }}>
            <span style={{
              fontSize: 10.5,
              padding: '1px 7px',
              borderRadius: 'var(--radius-pill)',
              background: 'var(--accent-soft)',
              color: 'var(--accent)',
              fontWeight: 700,
            }}>
              {(r.user.role || '').toUpperCase()}
            </span>
          </div>
        </div>
      </div>
      <div style={{ fontSize: 12.5, color: 'var(--text-primary)' }}>
        {r.user.start_date}
      </div>
      <div style={{ fontSize: 12.5, color: 'var(--text-primary)', fontWeight: 600 }}>
        {r.years} {r.years === 1 ? 'yr' : 'yrs'}
      </div>
      <div>
        <span style={{
          fontSize: 11, fontWeight: 700,
          padding: '3px 9px', borderRadius: 'var(--radius-pill)',
          background: r.overdueYears >= 2 ? 'var(--danger-soft)' : 'var(--warning-soft, #fff4e5)',
          color:      r.overdueYears >= 2 ? 'var(--danger)'      : 'var(--warning, #c46b00)',
        }}>
          {r.overdueYears} {r.overdueYears === 1 ? 'review due' : 'reviews due'}
        </span>
      </div>
      <div style={{ fontSize: 13, color: 'var(--text-primary)', fontWeight: 600 }}>
        {r.comp ? formatPKR(r.comp.basicSalary) : <span style={{ fontStyle: 'italic', color: 'var(--text-muted)' }}>Not set</span>}
      </div>
      <div style={{ textAlign: 'right' }}>
        <button
          className="wx-btn wx-btn-primary"
          style={{ padding: '6px 12px', fontSize: 12.5 }}
          onClick={onReview}
        >
          <StarIcon width="13" height="13" /> Review
        </button>
      </div>
    </div>
  );
}

// ── Salary History tab ────────────────────────────────────────
// Cross-employee audit feed — every salary_history row, newest first.
// Row shape mirrors AuditPage's wx-list pattern: When · Employee ·
// Action · Old → New · Reason · Notes · Changed-by. Filterable by
// employee name.
function SalaryHistoryTab() {
  const [search, setSearch] = useState('');
  const [reasonFilter, setReasonFilter] = useState('all');

  const { data: rows = [], isLoading: loading, error: queryError } = useQuery({
    queryKey: ['salaries', 'history-all'],
    queryFn: () => listAllHistory({ limit: 500 }),
  });
  const err = queryError?.message || '';

  const filtered = useMemo(() => {
    let list = rows;
    if (reasonFilter !== 'all') list = list.filter((r) => r.changeReason === reasonFilter);
    const q = search.trim().toLowerCase();
    if (q) {
      list = list.filter((r) =>
        (r.user?.displayName || '').toLowerCase().includes(q) ||
        (r.bossNotes || '').toLowerCase().includes(q));
    }
    return list;
  }, [rows, search, reasonFilter]);

  return (
    <>
      <div className="wx-toolbar">
        <div className="wx-search">
          <span className="wx-search-icon"><SearchIcon width="16" height="16" /></span>
          <input
            className="wx-input"
            placeholder="Search by employee name or note…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {[
            { k: 'all',              l: 'All' },
            { k: 'initial_seed',     l: 'Initial' },
            { k: 'annual_increment', l: 'Annual' },
            { k: 'promotion',        l: 'Promotion' },
            { k: 'adjustment',       l: 'Adjustment' },
            { k: 'correction',       l: 'Correction' },
          ].map((r) => (
            <button
              key={r.k}
              type="button"
              className={`wx-role-chip ${reasonFilter === r.k ? 'wx-role-chip-active' : ''}`}
              onClick={() => setReasonFilter(r.k)}
            >
              {r.l}
            </button>
          ))}
        </div>
      </div>

      {err && (
        <div className="wx-alert wx-alert-danger" style={{ marginBottom: 14 }}>
          <AlertIcon width="16" height="16" /> <span>{err}</span>
        </div>
      )}

      <div className="wx-list">
        <div className="wx-list-row wx-list-header"
          style={{ gridTemplateColumns: '120px 1.4fr 0.9fr 1.4fr 1fr 1.2fr' }}>
          <div>When</div>
          <div>Employee</div>
          <div>Reason</div>
          <div>Change</div>
          <div>By</div>
          <div>Notes</div>
        </div>

        {loading && (
          <div className="wx-empty">
            <span className="wx-spinner" style={{ color: 'var(--accent)' }} /> Loading…
          </div>
        )}

        {!loading && filtered.length === 0 && (
          <div className="wx-empty">
            <div className="wx-empty-title">No history yet</div>
            <div>Salary changes will appear here as they happen.</div>
          </div>
        )}

        {!loading && filtered.map((h) => (
          <HistoryFeedRow key={h.id} h={h} />
        ))}
      </div>
    </>
  );
}

const REASON_TONE = {
  initial_seed:     { bg: 'var(--surface-2)',  fg: 'var(--text-secondary)', label: 'Initial' },
  annual_increment: { bg: 'var(--success-soft)', fg: 'var(--success)',      label: 'Annual' },
  promotion:        { bg: 'var(--accent-soft)',  fg: 'var(--accent)',       label: 'Promotion' },
  adjustment:       { bg: 'var(--warning-soft, #fff4e5)', fg: 'var(--warning, #c46b00)', label: 'Adjustment' },
  correction:       { bg: 'var(--surface-2)',  fg: 'var(--text-secondary)', label: 'Correction' },
};

function HistoryFeedRow({ h }) {
  const tone = REASON_TONE[h.changeReason] || REASON_TONE.correction;
  const created = new Date(h.createdAt);
  const when = isNaN(created)
    ? h.effectiveFrom
    : created.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });

  return (
    <div className="wx-list-row"
      style={{ gridTemplateColumns: '120px 1.4fr 0.9fr 1.4fr 1fr 1.2fr', alignItems: 'flex-start' }}>
      <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
        {when}
        <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>
          eff. {h.effectiveFrom}
        </div>
      </div>
      <div style={{ fontSize: 13, color: 'var(--text-primary)', fontWeight: 600 }}>
        {h.user?.displayName || '—'}
        <div style={{ fontSize: 11, color: 'var(--text-muted)', textTransform: 'uppercase', fontWeight: 500, marginTop: 2 }}>
          {h.user?.role || ''}
        </div>
      </div>
      <div>
        <span style={{
          fontSize: 11, fontWeight: 700,
          padding: '3px 9px', borderRadius: 'var(--radius-pill)',
          background: tone.bg, color: tone.fg,
        }}>
          {tone.label}
        </span>
      </div>
      <div style={{ fontSize: 12.5, color: 'var(--text-primary)' }}>
        {h.previousAmount != null
          ? <>{formatPKR(h.previousAmount)} → {formatPKR(h.newAmount)}</>
          : <>{formatPKR(h.newAmount)}</>}
        {h.incrementPct != null && (
          <div style={{ fontSize: 11, fontWeight: 600, marginTop: 2,
            color: h.incrementPct >= 0 ? 'var(--success)' : 'var(--danger)' }}>
            {h.incrementPct >= 0 ? '+' : ''}{Number(h.incrementPct).toFixed(1)}%
          </div>
        )}
      </div>
      <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
        {h.changedByUser?.displayName || '—'}
        {h.changedByUser?.role && (
          <div style={{ fontSize: 10.5, textTransform: 'uppercase', marginTop: 2 }}>
            {h.changedByUser.role}
          </div>
        )}
      </div>
      <div style={{ fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.4 }}>
        {h.bossNotes ? <>“{h.bossNotes}”</> : <span style={{ color: 'var(--text-muted)', fontStyle: 'italic' }}>—</span>}
      </div>
    </div>
  );
}

function ComingSoonStub({ title, body }) {
  return (
    <div className="wx-empty" style={{ padding: 36 }}>
      <div style={{
        display: 'grid', placeItems: 'center', width: 56, height: 56,
        borderRadius: 'var(--radius-pill)', background: 'var(--accent-soft)',
        color: 'var(--accent)', margin: '0 auto 14px',
      }}>
        <StarIcon width="22" height="22" />
      </div>
      <div className="wx-empty-title" style={{ marginBottom: 6 }}>{title}</div>
      <div style={{ maxWidth: 380, margin: '0 auto', lineHeight: 1.5 }}>{body}</div>
    </div>
  );
}
