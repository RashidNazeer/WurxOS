import React from 'react';

// Who runs the brand this line is about. Sits beside BrandChip on a
// brand-linked incentive, because an Ads Manager's plan is a column of
// identically-worded "Total Revenue in GMV Max" lines and the brand alone does
// not say who to ask about one that is behind.
//
// Unlike the brand name, this is NOT snapshotted onto the item: assignments
// change, and a stale name here would send someone to the wrong person. It is
// looked up live (fetchBrandHandlerMap) and simply absent when a brand has no
// APC — which is also what you see when an APC has just left.
export default function HandlerChip({ names }) {
  const list = (names || []).filter(Boolean);
  if (!list.length) return null;
  const label = list.join(', ');
  return (
    <span
      className="badge rounded-pill d-inline-flex align-items-center"
      style={{
        maxWidth: '100%',
        background: 'var(--info-soft)',
        color: 'var(--info-text)',
        border: '1px solid var(--info-soft)',
        fontSize: '0.58rem',
        fontWeight: 600,
        letterSpacing: '0.01em',
      }}
      title={list.length > 1 ? `APCs: ${label}` : `APC: ${label}`}
    >
      <i className="bi bi-person-fill me-1" style={{ fontSize: '0.55rem', flexShrink: 0 }} />
      <span className="text-truncate">{label}</span>
    </span>
  );
}
