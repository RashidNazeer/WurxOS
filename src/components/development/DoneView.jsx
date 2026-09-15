// Shipped features — every task Live — grouped by the block they shipped in,
// newest first. A feature ships in the block containing the day its last task
// went live, which is not always the block it was planned into. This is the
// changelog.
import { Avatar, Empty } from './Primitives';
import { dateRange, isoDay, shortDate } from './devFormat';

export default function DoneView({ features, tasks, products, blocks, productId = null, onOpen }) {
  const done = features.filter((feature) => feature.subtask_total > 0
    && feature.subtask_live === feature.subtask_total
    && (!productId || feature.project_id === productId));

  if (!done.length) {
    return (
      <Empty
        icon="bi-check2-circle"
        title="No shipped features yet"
        body="Features appear here when every task is Live."
      />
    );
  }

  const shippedDay = (feature) => tasks
    .filter((task) => task.task_id === feature.id && task.completed_at)
    .map((task) => isoDay(task.completed_at))
    .sort()
    .pop() || null;

  const groups = new Map();
  done.forEach((feature) => {
    const day = shippedDay(feature);
    const block = day ? blocks.find((item) => item.starts_on <= day && item.ends_on >= day) : null;
    const key = block?.id || 'earlier';
    if (!groups.has(key)) groups.set(key, { key, block, items: [] });
    groups.get(key).items.push({ feature, day });
  });

  const ordered = [...groups.values()]
    .sort((a, b) => (b.block?.starts_on || '').localeCompare(a.block?.starts_on || ''));

  return (
    <div className="dev-done-groups">
      {ordered.map(({ key, block, items }) => (
        <section key={key}>
          <h3>{block ? `Shipped ${dateRange(block.starts_on, block.ends_on)}` : 'Shipped before the planning calendar'}</h3>
          {items
            .sort((a, b) => String(b.day || '').localeCompare(String(a.day || '')))
            .map(({ feature, day }) => (
              <button type="button" key={feature.id} className="dev-done-row" onClick={() => onOpen(feature)}>
                <i className="bi bi-check-circle-fill" aria-hidden="true" />
                <span>
                  <strong>{feature.title}</strong>
                  <small>
                    {products.find((product) => product.id === feature.project_id)?.name}
                    {day ? ` · live ${shortDate(day)}` : ''}
                  </small>
                </span>
                <Avatar person={feature.owner} />
                <i className="bi bi-chevron-right" aria-hidden="true" />
              </button>
            ))}
        </section>
      ))}
    </div>
  );
}
