/**
 * Loading placeholders that keep the page's shape while data arrives.
 *   <Skeleton w="60%" h={14} radius={6} />      one bar (w/h: number = px, or any CSS length)
 *   <SkeletonRows n={5} />                       a list of rows (avatar + two lines)
 *   <SkeletonCard lines={3} />                   a card-shaped block
 * Purely decorative: aria-hidden; put aria-busy on the region they fill.
 */
const len = (v) => (typeof v === 'number' ? `${v}px` : v);

export function Skeleton({ w = '100%', h = 12, radius = 'var(--radius-sm)', className = '', style }) {
  return (
    <span
      className={`ui-skeleton ${className}`.trim()}
      aria-hidden="true"
      style={{ width: len(w), height: len(h), borderRadius: len(radius), ...style }}
    />
  );
}

export function SkeletonRows({ n = 4, avatar = true }) {
  return (
    <div className="ui-skeleton-rows" aria-hidden="true">
      {Array.from({ length: n }, (_, i) => (
        <div key={i} className="ui-skeleton-row">
          {avatar && <Skeleton w={32} h={32} radius="50%" />}
          <div className="ui-skeleton-row__lines">
            <Skeleton w={`${70 - (i % 3) * 12}%`} h={12} />
            <Skeleton w={`${45 - (i % 2) * 10}%`} h={10} />
          </div>
        </div>
      ))}
    </div>
  );
}

export function SkeletonCard({ lines = 3, className = '' }) {
  return (
    <div className={`ui-skeleton-card ${className}`.trim()} aria-hidden="true">
      <Skeleton w="35%" h={11} />
      <Skeleton w="55%" h={22} />
      {Array.from({ length: Math.max(0, lines - 2) }, (_, i) => (
        <Skeleton key={i} w={`${85 - i * 15}%`} h={10} />
      ))}
    </div>
  );
}

export default Skeleton;
