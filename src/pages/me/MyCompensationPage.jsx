import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useAuth } from '../../contexts/AuthContext';
import {
  getCompensationFor, getHistoryFor, yearsCompletedSince,
} from '../../lib/salariesApi';
import { formatPKR } from '../../lib/format';
import { PageHeader, StatCard, StatGrid } from '../../components/ui';
import { AlertIcon, StarIcon, CalendarIcon } from '../../components/common/Icon';
import '../../styles/table.css';

// Read-only employee view of their own salary, hire date, years
// completed, and full change history. Boss is intentionally redirected
// — Boss has no payroll record per memory/salary-management.md.
export default function MyCompensationPage() {
  const { user, profile } = useAuth();
  const uid = user?.id;
  const isBoss = profile?.role === 'boss';

  const compQuery = useQuery({
    queryKey: ['my-compensation', uid],
    queryFn: () => getCompensationFor(uid),
    enabled: !!uid && !isBoss,
  });
  const historyQuery = useQuery({
    queryKey: ['my-salary-history', uid],
    queryFn: () => getHistoryFor(uid),
    enabled: !!uid && !isBoss,
  });

  const yearsCompleted = useMemo(
    () => yearsCompletedSince(profile?.start_date),
    [profile?.start_date]
  );

  if (isBoss) {
    return (
      <div className="wx-empty" style={{ padding: 40 }}>
        <div className="wx-empty-title">No payroll record</div>
        <div>Boss accounts don't have a fixed salary in WurxOS.</div>
      </div>
    );
  }

  const comp = compQuery.data;
  const history = historyQuery.data || [];
  const loading = compQuery.isLoading || historyQuery.isLoading;
  const err = compQuery.error?.message || historyQuery.error?.message || '';

  return (
    <>
      <PageHeader
        title="My Compensation"
        subtitle="Your fixed salary, work anniversary, and the full record of every change."
      />

      {err && (
        <div className="wx-alert wx-alert-danger" style={{ marginBottom: 14 }}>
          <AlertIcon width="16" height="16" /> <span>{err}</span>
        </div>
      )}

      {/* Top stat tiles */}
      <StatGrid min={220} className="mb-3">
        <StatCard
          icon={<StarIcon width="18" height="18" />}
          label="Current fixed salary"
          value={comp ? formatPKR(comp.basicSalary) : (loading ? '…' : 'Not set')}
          hint={comp ? `Effective ${comp.effectiveFrom}` : 'Boss will set this shortly.'}
        />
        <StatCard
          icon={<CalendarIcon width="18" height="18" />}
          label="Hire date"
          value={profile?.start_date || 'Not set'}
          hint={profile?.start_date
            ? `${yearsCompleted} ${yearsCompleted === 1 ? 'year' : 'years'} completed`
            : 'Ask the Boss to add this.'}
        />
      </StatGrid>

      <div style={{ marginBottom: 8, display: 'flex', alignItems: 'center', gap: 8 }}>
        <h2 style={{ margin: 0, fontSize: 16, fontWeight: 700 }}>Change history</h2>
        <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
          {history.length === 0 ? 'No changes yet' : `${history.length} entries`}
        </span>
      </div>

      <div className="wx-list">
        <div className="wx-list-row wx-cols wx-list-header"
          style={{ '--cols': '110px 0.9fr 1.2fr 1fr 1.4fr' }}>
          <div>When</div>
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

        {!loading && history.length === 0 && (
          <div className="wx-empty">
            <div className="wx-empty-title">No changes yet</div>
            <div>When your salary is updated, every change will be recorded here.</div>
          </div>
        )}

        {!loading && history.map((h) => (
          <MyHistoryRow key={h.id} h={h} />
        ))}
      </div>
    </>
  );
}

const REASON_LABELS = {
  initial_seed:     'Initial',
  annual_increment: 'Annual increment',
  promotion:        'Promotion',
  adjustment:       'Adjustment',
  correction:       'Correction',
};

function MyHistoryRow({ h }) {
  return (
    <div className="wx-list-row wx-cols"
      style={{ '--cols': '110px 0.9fr 1.2fr 1fr 1.4fr', alignItems: 'flex-start' }}>
      <div className="wx-col-lead" style={{ fontSize: 12, color: 'var(--text-muted)' }}>
        {h.effectiveFrom}
      </div>
      <div style={{ fontSize: 12.5, color: 'var(--text-primary)', fontWeight: 600 }}>
        {REASON_LABELS[h.changeReason] || h.changeReason}
      </div>
      <div className="wx-col-key" style={{ fontSize: 12.5, color: 'var(--text-primary)' }}>
        {h.previousAmount != null
          ? <>{formatPKR(h.previousAmount)} → {formatPKR(h.newAmount)}</>
          : <>{formatPKR(h.newAmount)}</>}
        {h.incrementPct != null && (
          <div style={{ fontSize: 11, fontWeight: 600, marginTop: 2,
            color: h.incrementPct >= 0 ? 'var(--success-text)' : 'var(--danger-text)' }}>
            {h.incrementPct >= 0 ? '+' : ''}{Number(h.incrementPct).toFixed(1)}%
          </div>
        )}
      </div>
      <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
        {h.changedByUser?.displayName || '—'}
      </div>
      <div style={{ fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.4 }}>
        {h.bossNotes ? <>“{h.bossNotes}”</> : <span style={{ color: 'var(--text-muted)', fontStyle: 'italic' }}>—</span>}
      </div>
    </div>
  );
}
