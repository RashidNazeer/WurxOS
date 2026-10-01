import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useBrands } from '../../../contexts/BrandsContext';
import { StatCard, StatGrid, Skeleton } from '../../../components/ui';
import { useReportStatuses } from './ReportsDueCard';
import { computeCompliance } from './ComplianceGrid';
import { currentReportableWeek } from '../../../lib/reportDue';
import { useApprovals } from '../../../lib/approvalsApi';
import { todayKeys, fetchCompanyToday, fetchHeadcount, POLL } from '../../../lib/todayApi';

const HEAD = [
  ['ol', 'Operation Leads', '/boss/manage/ols'],
  ['tl', 'Team Leads', '/boss/manage/tls'],
  ['pctl', 'Paid Collab TLs', '/boss/manage/pctls'],
  ['apc', 'APCs', '/boss/manage/apcs'],
  ['ipc', 'IPCs', '/boss/manage/ipcs'],
  ['ads_manager', 'Ads Managers', '/boss/manage/ads-managers'],
  ['developer', 'Developers', '/boss/manage/developers'],
];

const val = (q, fn) => (q.isPending ? <Skeleton w={48} h={22} /> : q.error ? '—' : fn(q.data));

// Boss KPI row. GMV month-to-date and salary-run tiles are left out until a
// verified data source exists (spec F1 Boss notes).
export function BossKpis() {
  const { brands } = useBrands();
  const statuses = useReportStatuses();
  const att = useQuery({ queryKey: ['today', 'companyToday'], queryFn: fetchCompanyToday, staleTime: 30_000, ...POLL });
  const { count: pending, loading: apprLoading } = useApprovals();
  const week = useMemo(() => currentReportableWeek(), []);
  const compliance = useMemo(() => {
    const cells = computeCompliance(brands, statuses.data, week);
    if (!cells.length) return null;
    const ok = cells.filter((c) => ['submitted', 'verified', 'approved'].includes(c.state)).length;
    return Math.round((ok / cells.length) * 100);
  }, [brands, statuses.data, week]);
  const activeBrands = (brands || []).filter((b) => (b.status || 'active') === 'active').length;
  return (
    <StatGrid min={190}>
      <StatCard label="Active brands" value={activeBrands} footer={<Link to="/brands">Brands</Link>} />
      <StatCard label="Weekly reports in" value={statuses.isPending ? <Skeleton w={48} h={22} /> : compliance == null ? '—' : `${compliance}%`}
        hint="Submitted or further, this week" footer={<Link to="/weekly-reports">All weekly</Link>} />
      <StatCard label="Clocked in today" value={val(att, (d) => `${d.present}/${d.expected}`)} footer={<Link to="/attendance">Attendance</Link>} />
      <StatCard label="Pending approvals" value={apprLoading ? <Skeleton w={48} h={22} /> : pending} footer={<Link to="/approvals">Approvals</Link>} />
    </StatGrid>
  );
}

export function HeadcountRow() {
  const q = useQuery({ queryKey: todayKeys.headcount(), queryFn: fetchHeadcount, staleTime: 30 * 60_000 });
  return (
    <section className="today-card">
      <header className="today-card__head"><h2 className="today-card__title"><i className="bi bi-people" aria-hidden="true" /> Team</h2></header>
      <div className="today-headcount">
        {HEAD.map(([role, label, to]) => (
          <Link key={role} to={to} className="today-headcount__item">
            <span className="today-headcount__n">{q.isPending ? <Skeleton w={24} h={18} /> : q.data?.[role] || 0}</span>
            <span className="today-headcount__l">{label}</span>
          </Link>
        ))}
      </div>
    </section>
  );
}
