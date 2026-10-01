import { Link } from 'react-router-dom';
import { Button, SkeletonRows } from '../../../components/ui';
import ApprovalRow from '../../../components/approvals/ApprovalRow';
import { useApprovals, KIND_LABEL } from '../../../lib/approvalsApi';

// Today widget: the top 5 approvals (actionable first), then "Open inbox".
// `kinds` narrows it (e.g. TL's "Reports awaiting my review" = ['reports']).
export default function ApprovalsCard({ role, title = 'Needs your approval', kinds = null, linkTo = '/approvals' }) {
  const { items, sources, loading } = useApprovals();
  const list = items.filter((x) => (!kinds || kinds.includes(x.kind)) && (x.canAct || x.openOnly || x.waitingOn));
  const actionable = list.filter((x) => x.canAct || x.openOnly).length;
  const failed = Object.entries(sources).filter(([k, s]) => s.error && (!kinds || kinds.includes(k)));
  return (
    <section className="today-card" aria-busy={loading || undefined}>
      <header className="today-card__head">
        <h2 className="today-card__title">
          <i className="bi bi-inbox" aria-hidden="true" /> {title}
          {actionable > 0 && <span className="today-card__count is-alert">{actionable}</span>}
        </h2>
        <Link to={linkTo} className="today-card__link">Open inbox <i className="bi bi-arrow-right" aria-hidden="true" /></Link>
      </header>
      {failed.map(([k, s]) => (
        <div key={k} className="today-card__error" role="alert">
          <span>{KIND_LABEL[k]} couldn't load.</span>
          <Button size="sm" variant="secondary" onClick={() => s.refetch()}>Retry</Button>
        </div>
      ))}
      {loading && list.length === 0 ? <SkeletonRows n={3} /> : list.length === 0 ? (
        <p className="today-card__ok"><i className="bi bi-check-circle-fill" aria-hidden="true" /> Nothing waiting for you.</p>
      ) : (
        <ul className="today-list">
          {list.slice(0, 5).map((it) => <ApprovalRow key={`${it.kind}:${it.id}`} item={it} role={role} />)}
        </ul>
      )}
      {list.length > 5 && <Link to={linkTo} className="today-card__more">Show all {list.length}</Link>}
    </section>
  );
}
