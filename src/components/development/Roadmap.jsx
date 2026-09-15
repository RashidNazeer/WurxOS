// The roadmap: products down the side, the running block and the two after it
// across the top, then an unscheduled "Later" column. The Boss plans by
// dragging a feature into a block; developers see the same board read-only.
// Clicking a product's name shows only that product.
import { useState } from 'react';
import { ROLLUP_META } from '../../lib/devTasksApi';
import FeatureCard from './FeatureCard';
import { currentBlock, roadmapBlocks, columnName } from './devBlocks';
import { dateRange, isoToday } from './devFormat';

// From a developer's fourth feature in the running block, their avatar turns red.
const NOW_LIMIT = 3;
const LATER = { id: 'later' };

export default function Roadmap({ products, blocks, features, canPlan, productId = null, onPickProduct, onOpen, onMove }) {
  const [over, setOver] = useState(null);
  const today = isoToday();
  const current = currentBlock(blocks, today);
  const columns = roadmapBlocks(blocks, today);
  const allColumns = [...columns, LATER];
  const blockById = Object.fromEntries(blocks.map((block) => [block.id, block]));

  // Which column a feature is drawn in. Unfinished work planned into a block
  // that has ended stays visible in Now, marked, instead of disappearing.
  function placement(feature) {
    if (!feature.block_id) return { columnId: LATER.id };
    if (columns.some((block) => block.id === feature.block_id)) return { columnId: feature.block_id };
    const block = blockById[feature.block_id];
    if (!block || block.ends_on < today) {
      const from = block ? dateRange(block.starts_on, block.ends_on) : 'an earlier block';
      return { columnId: (current || columns[0])?.id, note: `carried over from ${from}` };
    }
    return { columnId: columns[columns.length - 1]?.id, note: `planned for ${dateRange(block.starts_on, block.ends_on)}` };
  }

  const placed = features.map((feature) => ({ feature, ...placement(feature) }));

  const overloaded = new Set();
  const countByOwner = {};
  placed
    .filter((item) => current && item.columnId === current.id && item.feature.owner_id)
    .sort((a, b) => String(a.feature.created_at).localeCompare(String(b.feature.created_at)))
    .forEach(({ feature }) => {
      countByOwner[feature.owner_id] = (countByOwner[feature.owner_id] || 0) + 1;
      if (countByOwner[feature.owner_id] > NOW_LIMIT) overloaded.add(feature.id);
    });

  function drop(event, block) {
    event.preventDefault();
    setOver(null);
    if (!canPlan) return;
    const feature = features.find((item) => item.id === event.dataTransfer.getData('text/dev-feature'));
    if (!feature) return;
    const target = block.id === LATER.id ? null : block.id;
    // Dropping a card where it already is must not re-plan it: that would reset
    // the "+1 since planning" count.
    if (target === (feature.block_id || null)) return;
    const intoRunningBlock = current && target === current.id && current.starts_on < today;
    if (intoRunningBlock && !window.confirm('This block is already running. Move anyway?')) return;
    onMove(feature, target);
  }

  function startDrag(event, feature) {
    event.dataTransfer.setData('text/dev-feature', feature.id);
    event.dataTransfer.effectAllowed = 'move';
  }

  const rows = productId ? products.filter((product) => product.id === productId) : products;

  return (
    <div className="dev-roadmap-scroll">
      <div className="dev-roadmap" style={{ '--dev-cols': allColumns.length }}>
        <div className="dev-roadmap-head product">Product</div>
        {allColumns.map((block) => (
          <div key={block.id} className={`dev-roadmap-head${block.id === current?.id ? ' is-now' : ''}`}>
            <b>{block === LATER ? 'Later' : columnName(block, columns, today)}</b>
            <small>{block === LATER ? 'unscheduled' : dateRange(block.starts_on, block.ends_on)}</small>
          </div>
        ))}

        {rows.map((product) => {
          const picked = productId === product.id;
          return (
            <div className="dev-roadmap-product-row" key={product.id}>
              <button
                type="button"
                className={`dev-product${picked ? ' is-picked' : ''}`}
                aria-pressed={picked}
                title={picked ? 'Show every product' : `Show only ${product.name}`}
                onClick={() => onPickProduct?.(picked ? null : product.id)}
              >
                <span className={`dev-product-dot is-${product.colour}`} aria-hidden="true" />
                <strong>{product.name}</strong>
                <small>{product.stage === 'live' ? 'live' : 'pre-launch'}</small>
              </button>

              {allColumns.map((block) => {
                const isNow = block.id === current?.id;
                const cellKey = `${product.id}:${block.id}`;
                const cell = placed.filter((item) => item.feature.project_id === product.id && item.columnId === block.id);

                return (
                  <div
                    key={block.id}
                    className={`dev-roadmap-cell${isNow ? ' is-now' : ''}${over === cellKey ? ' is-over' : ''}`}
                    onDragOver={(event) => {
                      if (!canPlan) return;
                      event.preventDefault();
                      setOver(cellKey);
                    }}
                    onDragLeave={() => setOver(null)}
                    onDrop={(event) => drop(event, block)}
                  >
                    {cell.map(({ feature, note }) => (
                      <FeatureCard
                        key={feature.id}
                        feature={feature}
                        now={isNow}
                        note={note}
                        draggable={canPlan}
                        overload={overloaded.has(feature.id)}
                        onOpen={onOpen}
                        onDragStart={startDrag}
                      />
                    ))}
                  </div>
                );
              })}
            </div>
          );
        })}
      </div>

      <div className="dev-legend">
        {Object.entries(ROLLUP_META).map(([key, meta]) => (
          <span key={key}><i className={`is-${meta.tone}`} aria-hidden="true" />{meta.label}</span>
        ))}
      </div>
    </div>
  );
}
