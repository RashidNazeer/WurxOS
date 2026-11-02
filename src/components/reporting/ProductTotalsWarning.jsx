/**
 * Live check under a report's product table. Always shows the summed product figure
 * next to the report's total so the APC can see, while typing, whether the rows add
 * up; any mismatch also blocks Submit (see reportTotalsCheck.js).
 *
 *   rows  productTotalsSummary() result: one entry per metric
 *   fmt   (n, money) => string in the form's currency
 */
export default function ProductTotalsWarning({ rows, fmt }) {
  if (!rows || !rows.length) return null;
  const bad = rows.filter((r) => r.state === 'mismatch');
  return (
    <div className="mt-2" data-testid="product-totals">
      <div className="rounded-2 px-3 py-2" style={{ background: 'var(--surface-2)', border: '1px solid var(--border-subtle)', fontSize: '0.76rem' }}>
        {rows.map((r) => {
          const ok = r.state === 'match';
          const color = ok ? 'var(--success-text)' : r.state === 'mismatch' ? 'var(--danger-text)' : 'var(--text-muted)';
          return (
            <div key={r.key} className="d-flex flex-wrap align-items-center gap-2" style={{ lineHeight: 1.6 }}>
              <span className="fw-semibold" style={{ minWidth: 170 }}>Product {r.label} (added up)</span>
              <span className="fw-bold">{fmt(r.productSum, r.money)}</span>
              <span className="text-muted">·</span>
              <span className="text-muted">Report total {r.label}: <b style={{ color: 'var(--text-primary)' }}>{r.total == null ? 'not entered yet' : fmt(r.total, r.money)}</b></span>
              {r.state !== 'no-total' && (
                <span className="ms-auto fw-bold" style={{ color }}>
                  <i className={`bi ${ok ? 'bi-check-circle-fill' : 'bi-x-circle-fill'} me-1`} />
                  {ok ? 'Matches' : `${r.diff > 0 ? '+' : '−'}${fmt(Math.abs(r.diff), r.money)}`}
                </span>
              )}
            </div>
          );
        })}
      </div>
      {bad.length > 0 && (
        <div role="alert" className="mt-2 d-flex align-items-start gap-2 rounded-2 px-3 py-2"
          style={{ background: 'var(--danger-soft)', border: '1px solid color-mix(in srgb, var(--danger) 35%, transparent)', color: 'var(--danger-text)', fontSize: '0.76rem', lineHeight: 1.5 }}>
          <i className="bi bi-exclamation-octagon-fill" style={{ marginTop: 2 }} />
          <div>
            <div className="fw-bold">Product-wise numbers don&apos;t match the totals — this report can&apos;t be submitted yet.</div>
            <ul className="mb-0 ps-3">{bad.map((r) => <li key={r.key}>{r.text}</li>)}</ul>
            <div style={{ opacity: 0.85 }}>Correct the product rows or the total. An &ldquo;Others&rdquo; row can hold whatever isn&apos;t listed individually.</div>
          </div>
        </div>
      )}
    </div>
  );
}
