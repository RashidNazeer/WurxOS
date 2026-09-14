// Shipped features — every task Live — grouped by the block they shipped in,
// newest block first.
import { Avatar, Empty } from './Primitives';
import { shortDate } from './devFormat';

export default function DoneView({ features, products, blocks, onOpen }) {
  const done = features.filter((feature) => feature.subtask_total > 0
    && feature.subtask_live === feature.subtask_total);

  if (!done.length) {
    return (
      <Empty
        icon="bi-check2-circle"
        title="No shipped features yet"
        body="Features appear here when every task is Live."
      />
    );
  }

  const groups = [...blocks, { id: 'later', starts_on: null }]
    .map((block) => ({
      block,
      features: done.filter((feature) => (block.id === 'later' ? !feature.block_id : feature.block_id === block.id)),
    }))
    .filter((group) => group.features.length)
    .reverse();

  return (
    <div className="dev-done-groups">
      {groups.map(({ block, features: items }) => (
        <section key={block.id}>
          <h3>{block.id === 'later' ? 'Unscheduled' : `Shipped · ${shortDate(block.starts_on)}`}</h3>
          {items.map((feature) => (
            <button type="button" key={feature.id} className="dev-done-row" onClick={() => onOpen(feature)}>
              <i className="bi bi-check-circle-fill" aria-hidden="true" />
              <span>
                <strong>{feature.title}</strong>
                <small>{products.find((product) => product.id === feature.project_id)?.name}</small>
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
