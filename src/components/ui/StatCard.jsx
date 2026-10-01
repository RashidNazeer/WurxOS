/**
 * <StatGrid> lays cards out with auto-fit + equal heights.
 * <StatCard label value hint icon delta={12.5} deltaLabel="vs last month"
 *           invertTrend footer />
 * delta is a number (shown as a signed %) or a preformatted string; set
 * `trend` to override the direction. invertTrend: lower is better.
 */
export function StatGrid({ min = 200, children, className = '' }) {
  return (
    <div className={`ui-stat-grid ${className}`.trim()} style={{ '--ui-stat-min': `${min}px` }}>
      {children}
    </div>
  );
}

export default function StatCard({
  label,
  value,
  hint,
  icon,
  delta,
  deltaLabel,
  trend,
  invertTrend = false,
  footer,
  className = '',
}) {
  const num = typeof delta === 'number' && Number.isFinite(delta) ? delta : null;
  const dir = trend || (num === null ? 'flat' : num > 0 ? 'up' : num < 0 ? 'down' : 'flat');
  const good = dir === 'flat' ? null : (dir === 'up') !== invertTrend;
  const deltaText = num === null ? delta : `${num > 0 ? '+' : ''}${num.toFixed(1)}%`;
  const arrow = dir === 'up' ? '▲' : dir === 'down' ? '▼' : '—';

  return (
    <div className={`ui-stat-card ${className}`.trim()}>
      <div className="ui-stat-card__head">
        <span className="ui-stat-card__label">{label}</span>
        {icon && <span className="ui-stat-card__icon" aria-hidden="true">{icon}</span>}
      </div>
      <div className="ui-stat-card__value">{value}</div>
      {(delta !== undefined && delta !== null) && (
        <div className={`ui-stat-card__delta${good === null ? '' : good ? ' is-good' : ' is-bad'}`}>
          <span aria-hidden="true">{arrow}</span>
          <span className="visually-hidden">{dir === 'up' ? 'Up' : dir === 'down' ? 'Down' : 'No change'}</span>
          {' '}{deltaText}
          {deltaLabel && <span className="ui-stat-card__delta-label"> {deltaLabel}</span>}
        </div>
      )}
      {hint && <div className="ui-stat-card__hint">{hint}</div>}
      {footer && <div className="ui-stat-card__footer">{footer}</div>}
    </div>
  );
}
