import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useBrands } from '../../../contexts/BrandsContext';
import { Button, StatusBadge } from '../../../components/ui';
import TodayCard from './TodayCard';
import { todayKeys, fetchReportStatuses } from '../../../lib/todayApi';
import { currentReportableWeek, reportState, dueRank, DONE_STATES } from '../../../lib/reportDue';
import { reportUrl, reportNewUrl } from '../../../lib/reportLinks';

const STATE_BADGE = {
  returned:    { tone: 'danger',  label: 'Returned' },
  not_started: { tone: 'warning', label: 'Not started' },
  draft:       { tone: 'neutral', label: 'Draft' },
  submitted:   { tone: 'info',    label: 'Submitted' },
  verified:    { tone: 'purple',  label: 'Verified' },
  approved:    { tone: 'success', label: 'Approved' },
};
const TYPE_LABEL = { weekly: 'Weekly', biweekly: 'Bi-weekly', monthly: 'Monthly' };
const brandName = (b) => b?.brand_name || b?.brandName || b?.name || 'Brand';
const rangeOf = (label) => (String(label || '').match(/\(([^)]+)\)/) || [])[1] || label;

export function useReportStatuses(enabled = true) {
  return useQuery({ queryKey: todayKeys.reportStatuses(), queryFn: fetchReportStatuses, enabled, staleTime: 60_000, refetchInterval: 60_000, refetchIntervalInBackground: false });
}

function ReportRow({ brand, type, state, row, overdue, periodLabel }) {
  const badge = STATE_BADGE[state];
  const action = state === 'not_started'
    ? { label: 'Start', to: reportNewUrl(type, brand.id), variant: 'primary' }
    : state === 'draft' || state === 'returned'
      ? { label: 'Continue', to: reportUrl({ id: row.id, brandId: brand.id, type }, { edit: true }), variant: 'primary' }
      : { label: 'View', to: reportUrl({ id: row.id, brandId: brand.id, type }), variant: 'ghost' };
  return (
    <li className="today-row">
      <div className="today-row__main">
        <div className="today-row__title">{brandName(brand)}</div>
        <div className="today-row__sub">
          {TYPE_LABEL[type]} · {rangeOf(periodLabel)}
          {state === 'returned' && row?.rejectionNote ? <span className="today-row__note"> · “{row.rejectionNote}”</span> : null}
        </div>
      </div>
      <StatusBadge tone={overdue && !DONE_STATES.has(state) && state !== 'returned' ? 'danger' : badge.tone}>
        {overdue && (state === 'not_started' || state === 'draft') ? 'Overdue' : badge.label}
      </StatusBadge>
      <Button as={Link} to={action.to} size="sm" variant={action.variant}>{action.label}</Button>
    </li>
  );
}

// APC: one row per brand for the weekly report that's due now, most urgent
// first; done ones collapse under "Done this period". Returned reports of any
// cadence are listed on top (they need the APC before anything else).
export default function ReportsDueCard() {
  const { brands, loading: brandsLoading } = useBrands();
  const q = useReportStatuses();
  const week = useMemo(() => currentReportableWeek(), []);

  const { open, done } = useMemo(() => {
    const rows = q.data || [];
    const active = (brands || []).filter((b) => (b.status || 'active') === 'active');
    const list = active.map((b) => {
      const row = rows.find((r) => r.brandId === b.id && r.type === 'weekly' && r.periodStart === week.startDate) || null;
      const state = reportState(row);
      return { brand: b, type: 'weekly', row, state, overdue: true, periodLabel: row?.periodLabel || week.label };
    });
    const brandById = new Map(active.map((b) => [b.id, b]));
    const returned = rows
      .filter((r) => reportState(r) === 'returned' && !(r.type === 'weekly' && r.periodStart === week.startDate) && brandById.has(r.brandId))
      .map((r) => ({ brand: brandById.get(r.brandId), type: r.type, row: r, state: 'returned', overdue: false, periodLabel: r.periodLabel || r.periodStart }));
    const all = [...returned, ...list].sort((a, b) => dueRank(a.state, a.overdue) - dueRank(b.state, b.overdue));
    return {
      open: all.filter((x) => !DONE_STATES.has(x.state)),
      done: all.filter((x) => DONE_STATES.has(x.state)),
    };
  }, [q.data, brands, week]);

  const query = { ...q, isPending: q.isPending || brandsLoading };
  return (
    <TodayCard title="Reports due" icon="bi-file-earmark-bar-graph" linkTo="/weekly-reports" linkLabel="All reports"
      query={query} empty={open.length === 0 && done.length === 0} emptyText="No reports due this week"
      count={open.length}>
      {open.length === 0 && <p className="today-card__ok"><i className="bi bi-check-circle-fill" aria-hidden="true" /> Everything for this week is in.</p>}
      <ul className="today-list">
        {open.map((x) => <ReportRow key={`${x.type}:${x.brand.id}:${x.row?.id || 'new'}`} {...x} />)}
      </ul>
      {done.length > 0 && (
        <details className="today-done">
          <summary>Done this period ({done.length})</summary>
          <ul className="today-list">
            {done.map((x) => <ReportRow key={`${x.type}:${x.brand.id}:${x.row?.id}`} {...x} />)}
          </ul>
        </details>
      )}
    </TodayCard>
  );
}
