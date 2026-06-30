import React from 'react';

// Hierarchical GMV donut: an SVG ring of parent slices (Affiliate / Organic)
// over a center "Total GMV", with an expandable per-parent child breakdown
// (e.g. LIVE + Video under Affiliate). Shared by the monthly AND weekly
// report views so the chart stays identical. Token-driven so it themes
// for light/dark. Self-contained — no module-local deps.
//
// Props:
//   parents: [{ key, label, value, color, children?: [{ label, value, color }] }]
//   total:   number (sum of the parent values only — do NOT include children,
//            they roll up into their parent; this avoids double-counting)
//   currencySym, size, thickness: presentation.

const DONUT_C = {
  ink:    'var(--text-primary)',
  inkDim: 'var(--text-secondary)',
  muted:  'var(--text-muted)',
  track:  'var(--surface-2)',
};

export default function HierarchicalGmvDonut({ parents, total, currencySym = '$', size = 180, thickness = 28 }) {
  const [open, setOpen] = React.useState({});
  const toggle = (key) => setOpen((m) => ({ ...m, [key]: !m[key] }));

  const filtered = (parents || []).filter((p) => Number(p.value) > 0);
  if (filtered.length === 0 || !Number(total)) {
    return <div className="text-muted small text-center py-3">No GMV data to chart.</div>;
  }
  const cx = size / 2;
  const cy = size / 2;
  const r  = (size - thickness) / 2;
  const Circ = 2 * Math.PI * r;

  let acc = 0;
  return (
    <div className="d-flex align-items-center gap-3 flex-wrap" style={{ minHeight: size }}>
      <svg width={size} height={size} style={{ display: 'block', flexShrink: 0 }}>
        <circle cx={cx} cy={cy} r={r} fill="none" stroke={DONUT_C.track} strokeWidth={thickness} />
        {filtered.map((p, i) => {
          const v = Number(p.value);
          const pct = v / total;
          const len = pct * Circ;
          const offset = -acc * Circ + Circ / 4;
          acc += pct;
          return (
            <circle
              key={i}
              cx={cx} cy={cy} r={r}
              fill="none"
              stroke={p.color}
              strokeWidth={thickness}
              strokeDasharray={`${len} ${Circ - len}`}
              strokeDashoffset={offset}
              transform={`rotate(-90 ${cx} ${cy})`}
            />
          );
        })}
        <text x={cx} y={cy - 4} textAnchor="middle" style={{ fontSize: 11, fill: DONUT_C.muted, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em' }}>Total GMV</text>
        <text x={cx} y={cy + 14} textAnchor="middle" style={{ fontSize: 15, fill: DONUT_C.ink, fontWeight: 700 }}>
          {currencySym}{Number(total).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
        </text>
      </svg>
      <div className="flex-grow-1" style={{ minWidth: 240 }}>
        {filtered.map((p) => {
          const v = Number(p.value);
          const pct = (v / total) * 100;
          const visibleChildren = (p.children || []).filter((c) => Number(c.value) > 0);
          const hasChildren = visibleChildren.length > 0;
          const isOpen = !!open[p.key];
          return (
            <div key={p.key}>
              <div
                role={hasChildren ? 'button' : undefined}
                onClick={hasChildren ? () => toggle(p.key) : undefined}
                onKeyDown={hasChildren ? (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(p.key); } } : undefined}
                tabIndex={hasChildren ? 0 : -1}
                className="d-flex align-items-center gap-2 mb-2"
                style={{ cursor: hasChildren ? 'pointer' : 'default', userSelect: 'none' }}
              >
                {hasChildren ? (
                  <i
                    className="bi bi-chevron-right"
                    style={{
                      fontSize: '0.6rem', color: DONUT_C.muted, width: 10, textAlign: 'center',
                      transition: 'transform 160ms ease',
                      transform: isOpen ? 'rotate(90deg)' : 'rotate(0deg)',
                    }}
                  />
                ) : (
                  <span style={{ width: 10 }} />
                )}
                <span style={{ width: 10, height: 10, borderRadius: 3, background: p.color, flexShrink: 0 }} />
                <span style={{ fontSize: '0.78rem', color: DONUT_C.ink, flex: 1, fontWeight: 600 }}>{p.label}</span>
                <span style={{ fontSize: '0.78rem', fontWeight: 700, color: DONUT_C.ink, fontVariantNumeric: 'tabular-nums' }}>
                  {currencySym}{v.toLocaleString(undefined, { maximumFractionDigits: 2 })}
                </span>
                <span style={{ fontSize: '0.7rem', color: DONUT_C.muted, minWidth: 44, textAlign: 'right' }}>
                  {pct.toFixed(1)}%
                </span>
              </div>
              {hasChildren && isOpen && (
                <div style={{ paddingLeft: 26, marginTop: -4, marginBottom: 8 }}>
                  {visibleChildren.map((c, ci) => {
                    const cv = Number(c.value);
                    // Share-of-parent (children inside Affiliate/Organic),
                    // not share-of-total — clearer for the breakdown logic.
                    const childPct = v > 0 ? (cv / v) * 100 : 0;
                    return (
                      <div key={ci} className="d-flex align-items-center gap-2 mb-1" style={{ paddingLeft: 4 }}>
                        <span style={{
                          width: 8, height: 8, borderRadius: 2,
                          background: c.color, flexShrink: 0, opacity: 0.85,
                        }} />
                        <span style={{ fontSize: '0.72rem', color: DONUT_C.inkDim, flex: 1 }}>{c.label}</span>
                        <span style={{ fontSize: '0.72rem', fontWeight: 600, color: DONUT_C.inkDim, fontVariantNumeric: 'tabular-nums' }}>
                          {currencySym}{cv.toLocaleString(undefined, { maximumFractionDigits: 2 })}
                        </span>
                        <span style={{ fontSize: '0.66rem', color: DONUT_C.muted, minWidth: 40, textAlign: 'right' }}>
                          {childPct.toFixed(1)}%
                        </span>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
