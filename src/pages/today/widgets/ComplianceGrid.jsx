import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useBrands } from '../../../contexts/BrandsContext';
import { StatusBadge } from '../../../components/ui';
import TodayCard from './TodayCard';
import { useReportStatuses } from './ReportsDueCard';
import { currentReportableWeek, reportState } from '../../../lib/reportDue';
import { reportUrl, reportListUrl } from '../../../lib/reportLinks';

const ORDER = ['missing', 'returned', 'draft', 'submitted', 'verified', 'approved'];
const BADGE = {
  missing:   { tone: 'danger',  label: 'Missing' },
  returned:  { tone: 'danger',  label: 'Returned' },
  draft:     { tone: 'warning', label: 'Draft' },
  submitted: { tone: 'info',    label: 'Submitted' },
  verified:  { tone: 'purple',  label: 'Verified' },
  approved:  { tone: 'success', label: 'Approved' },
};
const brandName = (b) => b?.brand_name || b?.brandName || b?.name || 'Brand';

// Weekly compliance for the current reportable week, worst first. Also feeds
// the Boss "report compliance %" KPI (computeCompliance).
export function computeCompliance(brands, rows, week) {
  const active = (brands || []).filter((b) => (b.status || 'active') === 'active');
  return active.map((b) => {
    const row = (rows || []).find((r) => r.brandId === b.id && r.type === 'weekly' && r.periodStart === week.startDate) || null;
    return { brand: b, row, state: row ? reportState(row) : 'missing' };
  }).sort((a, b) => ORDER.indexOf(a.state) - ORDER.indexOf(b.state) || brandName(a.brand).localeCompare(brandName(b.brand)));
}

export default function ComplianceGrid() {
  const { brands, loading } = useBrands();
  const q = useReportStatuses();
  const week = useMemo(() => currentReportableWeek(), []);
  const cells = useMemo(() => computeCompliance(brands, q.data, week), [brands, q.data, week]);
  const [showAll, setShowAll] = useState(false);
  const counts = ORDER.reduce((acc, s) => ({ ...acc, [s]: cells.filter((c) => c.state === s).length }), {});
  const range = (week.label.match(/\(([^)]+)\)/) || [])[1] || week.label;
  const shown = showAll ? cells : cells.slice(0, 10);
  return (
    <TodayCard title={`Weekly reports · ${range}`} icon="bi-grid-3x3-gap" linkTo="/weekly-reports" linkLabel="All weekly"
      query={{ ...q, isPending: q.isPending || loading }} empty={cells.length === 0} emptyText="No active brands">
      <div className="today-chips">
        {ORDER.filter((s) => counts[s]).map((s) => (
          <StatusBadge key={s} tone={BADGE[s].tone}>{BADGE[s].label} {counts[s]}</StatusBadge>
        ))}
      </div>
      <ul className="today-grid">
        {shown.map(({ brand, row, state }) => (
          <li key={brand.id}>
            <Link to={row ? reportUrl({ id: row.id, brandId: brand.id, type: 'weekly' }) : reportListUrl('weekly', brand.id)}
              className={`today-grid__cell is-${BADGE[state].tone}`}>
              <span className="today-grid__name">{brandName(brand)}</span>
              <span className="today-grid__state">{BADGE[state].label}</span>
            </Link>
          </li>
        ))}
      </ul>
      {cells.length > 10 && (
        <button type="button" className="today-card__more" onClick={() => setShowAll((v) => !v)}>
          {showAll ? 'Show fewer' : `Show all ${cells.length}`}
        </button>
      )}
    </TodayCard>
  );
}
