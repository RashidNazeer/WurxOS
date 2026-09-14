// The roadmap: products down the side, two-week blocks across the top, and an
// unscheduled "Later" column. The Boss plans by dragging a feature into a
// block; developers see the same board read-only.
import { useState } from 'react';
import { ROLLUP_META } from '../../lib/devTasksApi';
import FeatureCard from './FeatureCard';
import { isoToday, shortDate } from './devFormat';

// A developer holding more than this many features in the running block is
// flagged on every one of their cards.
const NOW_OVERLOAD = 3;

function columnLabel(block, index, blocks, current) {
  if (block.id === 'later') return 'Later';
  if (block.id === current?.id) return 'Now';
  return index === blocks.indexOf(current) + 1 ? 'Next' : 'After';
}

export default function Roadmap({ products, blocks, features, canPlan, onOpen, onMove }) {
  const [over, setOver] = useState(null);
  const today = isoToday();
  const current = blocks.find((block) => block.starts_on <= today && block.ends_on >= today);
  const columns = [...blocks, { id: 'later', starts_on: null, ends_on: null }];

  const nowCounts = {};
  features
    .filter((feature) => feature.block_id === current?.id)
    .forEach((feature) => {
      if (feature.owner_id) nowCounts[feature.owner_id] = (nowCounts[feature.owner_id] || 0) + 1;
    });

  function drop(event, block) {
    event.preventDefault();
    setOver(null);
    const featureId = event.dataTransfer.getData('text/dev-feature');
    const feature = features.find((item) => item.id === featureId);
    if (!feature) return;
    const intoRunningBlock = block?.id === current?.id && block.starts_on < today && feature.block_id !== current.id;
    if (intoRunningBlock && !window.confirm('This block is already running. Move anyway?')) return;
    onMove(feature, block?.id === 'later' ? null : block?.id);
  }

  function startDrag(event, feature) {
    event.dataTransfer.setData('text/dev-feature', feature.id);
    event.dataTransfer.effectAllowed = 'move';
  }

  return (
    <div className="dev-roadmap-scroll">
      <div className="dev-roadmap" style={{ '--dev-cols': columns.length }}>
        <div className="dev-roadmap-head product">Product</div>
        {columns.map((block, index) => (
          <div key={block.id} className={`dev-roadmap-head${block.id === current?.id ? ' is-now' : ''}`}>
            <b>{columnLabel(block, index, blocks, current)}</b>
            <small>
              {block.id === 'later' ? 'unscheduled' : `${shortDate(block.starts_on)} – ${shortDate(block.ends_on)}`}
            </small>
          </div>
        ))}

        {products.map((product) => (
          <div className="dev-roadmap-product-row" key={product.id}>
            <div className="dev-product">
              <span className={`dev-product-dot is-${product.colour}`} aria-hidden="true" />
              <strong>{product.name}</strong>
              <small>{product.stage === 'live' ? 'live' : 'pre-launch'}</small>
            </div>

            {columns.map((block) => {
              const isLater = block.id === 'later';
              const isNow = block.id === current?.id;
              const cellKey = `${product.id}:${block.id}`;
              const cellFeatures = features.filter((feature) => feature.project_id === product.id
                && (isLater ? !feature.block_id : feature.block_id === block.id));

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
                  {cellFeatures.map((feature) => (
                    <FeatureCard
                      key={feature.id}
                      feature={feature}
                      now={isNow}
                      draggable={canPlan}
                      overload={isNow && nowCounts[feature.owner_id] > NOW_OVERLOAD}
                      onOpen={onOpen}
                      onDragStart={startDrag}
                    />
                  ))}
                </div>
              );
            })}
          </div>
        ))}
      </div>

      <div className="dev-legend">
        {Object.entries(ROLLUP_META).map(([key, meta]) => (
          <span key={key}><i className={`is-${meta.tone}`} aria-hidden="true" />{meta.label}</span>
        ))}
      </div>
    </div>
  );
}
