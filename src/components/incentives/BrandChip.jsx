import React from 'react';

// Small brand tag shown on a linked incentive/bonus line so a user can see which
// brand the item belongs to (an APC often handles several brands). The brand name
// is snapshotted onto each item at creation (item.brandName, migs 296/297), so this
// needs no lookup. Renders nothing for unlinked "Other"/legacy items (no brandName).
export default function BrandChip({ name }) {
  if (!name) return null;
  return (
    <span
      className="badge rounded-pill d-inline-flex align-items-center"
      style={{
        maxWidth: '100%',
        background: '#eef2ff',
        color: '#4338ca',
        border: '1px solid #e0e7ff',
        fontSize: '0.58rem',
        fontWeight: 600,
        letterSpacing: '0.01em',
      }}
      title={`Brand: ${name}`}
    >
      <i className="bi bi-shop me-1" style={{ fontSize: '0.55rem', flexShrink: 0 }} />
      <span className="text-truncate">{name}</span>
    </span>
  );
}
