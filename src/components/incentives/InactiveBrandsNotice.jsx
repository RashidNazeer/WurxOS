import React, { useEffect, useState } from 'react';
import { listInactiveBrandsForUser } from '../../lib/incentivesApi';

// Amber notice listing the inactive brands a person manages that are therefore
// left OUT of incentives. Self-fetches and self-hides (renders nothing when the
// person has no inactive brands). Drop it at the end of an incentive list.
export default function InactiveBrandsNotice({ userId, role }) {
  const [brands, setBrands] = useState([]);
  useEffect(() => {
    if (!userId) { setBrands([]); return; }
    let cancelled = false;
    listInactiveBrandsForUser(userId, role)
      .then((list) => { if (!cancelled) setBrands(list || []); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [userId, role]);

  if (!brands.length) return null;
  const many = brands.length > 1;
  return (
    <div className="rounded-3 p-2 px-3 mb-2" style={{ background: 'var(--warning-soft)', border: '1px solid color-mix(in srgb, var(--warning) 40%, transparent)' }}>
      <div className="d-flex align-items-start gap-2">
        <i className="bi bi-exclamation-triangle-fill flex-shrink-0" style={{ color: 'var(--warning-text)', fontSize: '0.8rem', marginTop: 2 }} />
        <div style={{ fontSize: '0.7rem', color: 'var(--warning-text)', lineHeight: 1.45 }}>
          <strong>Not included in incentives.</strong>{' '}
          {many ? 'These inactive brands are' : 'This inactive brand is'} excluded because {many ? 'they are' : 'it is'} inactive:{' '}
          <span className="fw-semibold">{brands.map((b) => b.name).join(', ')}</span>.
        </div>
      </div>
    </div>
  );
}
