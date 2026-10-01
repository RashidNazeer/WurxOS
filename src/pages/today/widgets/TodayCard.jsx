import { Link } from 'react-router-dom';
import { Button, EmptyState, SkeletonRows } from '../../../components/ui';

// Shell for every Today card: title + optional link, then exactly one of
// skeleton / inline error with Retry / empty state / content. A failing card
// never affects the others. `stale` shows when cached data is on screen but
// the latest refresh failed (flaky connections).
export default function TodayCard({
  title, icon, linkTo, linkLabel = 'Open', query, empty, emptyText = "You're all caught up",
  children, className = '', count,
}) {
  const loading = query?.isPending;
  const error = query?.error;
  const hasData = query ? query.data !== undefined : true;
  return (
    <section className={`today-card ${className}`.trim()} aria-busy={loading || undefined}>
      <header className="today-card__head">
        <h2 className="today-card__title">
          {icon && <i className={`bi ${icon}`} aria-hidden="true" />}
          {title}
          {count > 0 && <span className="today-card__count">{count}</span>}
        </h2>
        {linkTo && <Link to={linkTo} className="today-card__link">{linkLabel} <i className="bi bi-arrow-right" aria-hidden="true" /></Link>}
      </header>
      {loading ? (
        <SkeletonRows n={3} />
      ) : error && !hasData ? (
        <div className="today-card__error" role="alert">
          <span>Couldn't load this. {error.message}</span>
          <Button size="sm" variant="secondary" onClick={() => query.refetch()}>Retry</Button>
        </div>
      ) : empty ? (
        <EmptyState compact title={emptyText} />
      ) : (
        <>
          {error && query?.dataUpdatedAt ? (
            <p className="today-card__stale">
              Showing data from {new Date(query.dataUpdatedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}
            </p>
          ) : null}
          {children}
        </>
      )}
    </section>
  );
}

// "n more" disclosure for lists capped at 5 rows.
export function ShowAll({ total, shown, to }) {
  if (total <= shown) return null;
  return <Link to={to} className="today-card__more">Show all {total}</Link>;
}
