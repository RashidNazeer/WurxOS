// Lightweight, dependency-free UI + chart kit for the Euka Analytics page.
// All SVG so it themes via design tokens and adds no bundle weight.

export const fmtMoney = (v, cur = '$') =>
  v == null || Number.isNaN(Number(v)) ? '—'
    : `${cur}${Number(v).toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
export const fmtMoney0 = (v, cur = '$') =>
  v == null || Number.isNaN(Number(v)) ? '—'
    : `${cur}${Number(v).toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
export const fmtNum = (v) =>
  v == null || Number.isNaN(Number(v)) ? '—' : Number(v).toLocaleString();
export const fmtPct = (v, d = 1) =>
  v == null || Number.isNaN(Number(v)) ? '—' : `${Number(v).toFixed(d)}%`;
export const fmtCompact = (v) =>
  v == null || Number.isNaN(Number(v)) ? '—'
    : Number(v).toLocaleString(undefined, { notation: 'compact', maximumFractionDigits: 1 });

// A signed delta chip. `pct` is a percentage-change number (Euka's *Difference).
export function Delta({ pct, invert = false }) {
  if (pct == null || Number.isNaN(Number(pct))) return null;
  const up = Number(pct) >= 0;
  const good = invert ? !up : up;
  const color = Number(pct) === 0 ? 'var(--text-muted)' : good ? 'var(--success)' : 'var(--danger)';
  return (
    <span style={{ fontSize: '0.7rem', fontWeight: 700, color }}>
      <i className={`bi bi-arrow-${up ? 'up' : 'down'}-right`} /> {Math.abs(Number(pct)).toFixed(1)}%
    </span>
  );
}

export function Section({ title, eyebrow, icon, color = 'var(--accent)', right, children, span = 12 }) {
  return (
    <div className={`col-12 col-xl-${span}`}>
      <div style={{ background: 'var(--surface-1)', border: '1px solid var(--border-subtle)', borderRadius: 14, padding: '18px 20px', height: '100%' }}>
        <div className="d-flex align-items-center gap-2 mb-3">
          {icon && (
            <div className="rounded-2 d-flex align-items-center justify-content-center flex-shrink-0"
              style={{ width: 34, height: 34, background: `color-mix(in srgb, ${color} 14%, transparent)`, color }}>
              <i className={`bi ${icon}`} style={{ fontSize: '0.95rem' }} />
            </div>
          )}
          <div className="flex-grow-1 min-w-0">
            <div className="fw-bold" style={{ fontSize: '0.95rem', color: 'var(--text-primary)' }}>{title}</div>
            {eyebrow && <div className="text-muted" style={{ fontSize: '0.7rem' }}>{eyebrow}</div>}
          </div>
          {right}
        </div>
        {children}
      </div>
    </div>
  );
}

export function Kpi({ label, value, delta, invertDelta = false, sub }) {
  return (
    <div className="col-6 col-md-4 col-xl-3">
      <div style={{ background: 'var(--surface-1)', border: '1px solid var(--border-subtle)', borderRadius: 12, padding: '14px 16px', height: '100%' }}>
        <div className="text-muted" style={{ fontSize: '0.62rem', fontWeight: 700, letterSpacing: '0.05em', textTransform: 'uppercase' }}>{label}</div>
        <div className="fw-bold" style={{ fontSize: '1.35rem', color: 'var(--text-primary)', lineHeight: 1.1, marginTop: 4, fontVariantNumeric: 'tabular-nums' }}>{value}</div>
        <div className="d-flex align-items-center gap-2 mt-1" style={{ minHeight: 16 }}>
          {delta != null && <Delta pct={delta} invert={invertDelta} />}
          {sub && <span className="text-muted" style={{ fontSize: '0.66rem' }}>{sub}</span>}
        </div>
      </div>
    </div>
  );
}

export function Empty({ msg = 'No data for this range.' }) {
  return <div className="text-muted small py-3 text-center">{msg}</div>;
}

// ── Multi-series line chart (responsive SVG) ──────────────────────
// series = [{ label, color, points: [{ x: label, y: number }] }]
export function LineChart({ series = [], height = 220, yFmt = fmtCompact }) {
  const all = series.flatMap((s) => s.points || []);
  if (all.length < 2) return <Empty />;
  const W = 760, H = height, padL = 48, padR = 12, padT = 12, padB = 26;
  const n = Math.max(...series.map((s) => s.points.length));
  const maxY = Math.max(1, ...all.map((p) => Number(p.y) || 0));
  const x = (i) => padL + (i / Math.max(1, n - 1)) * (W - padL - padR);
  const y = (v) => padT + (1 - (Number(v) || 0) / maxY) * (H - padT - padB);
  const ticks = 4;
  return (
    <div style={{ width: '100%', overflow: 'hidden' }}>
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" preserveAspectRatio="xMidYMid meet" style={{ display: 'block' }}>
        {Array.from({ length: ticks + 1 }).map((_, i) => {
          const gy = padT + (i / ticks) * (H - padT - padB);
          const val = maxY * (1 - i / ticks);
          return (
            <g key={i}>
              <line x1={padL} y1={gy} x2={W - padR} y2={gy} stroke="var(--border-subtle)" strokeWidth="1" />
              <text x={padL - 6} y={gy + 3} textAnchor="end" fontSize="9" fill="var(--text-muted)">{yFmt(val)}</text>
            </g>
          );
        })}
        {series.map((s, si) => {
          const pts = (s.points || []).map((p, i) => `${x(i)},${y(p.y)}`).join(' ');
          return <polyline key={si} points={pts} fill="none" stroke={s.color} strokeWidth="2.5" strokeLinejoin="round" strokeLinecap="round" />;
        })}
        {series[0] && series[0].points.map((p, i) => (
          (i === 0 || i === series[0].points.length - 1 || i === Math.floor(series[0].points.length / 2)) && (
            <text key={i} x={x(i)} y={H - 8} textAnchor="middle" fontSize="9" fill="var(--text-muted)">{p.x}</text>
          )
        ))}
      </svg>
      <div className="d-flex flex-wrap gap-3 mt-1 justify-content-center">
        {series.map((s, i) => (
          <span key={i} className="d-inline-flex align-items-center gap-1" style={{ fontSize: '0.7rem', color: 'var(--text-secondary)' }}>
            <span style={{ width: 10, height: 3, borderRadius: 2, background: s.color, display: 'inline-block' }} /> {s.label}
          </span>
        ))}
      </div>
    </div>
  );
}

// ── Horizontal funnel / ranked bars ───────────────────────────────
// rows = [{ label, value, sub }]
export function FunnelBars({ rows = [], color = 'var(--accent)', valueFmt = fmtNum }) {
  if (!rows.length) return <Empty />;
  const max = Math.max(1, ...rows.map((r) => Number(r.value) || 0));
  return (
    <div className="d-flex flex-column gap-2">
      {rows.map((r, i) => (
        <div key={i}>
          <div className="d-flex justify-content-between" style={{ fontSize: '0.74rem', marginBottom: 2 }}>
            <span style={{ color: 'var(--text-secondary)', fontWeight: 600 }}>{r.label}</span>
            <span style={{ color: 'var(--text-primary)', fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}>
              {valueFmt(r.value)}{r.sub != null && <span className="text-muted fw-normal"> · {r.sub}</span>}
            </span>
          </div>
          <div style={{ height: 12, borderRadius: 6, background: 'var(--surface-2)', overflow: 'hidden' }}>
            <div style={{ height: '100%', width: `${Math.max(2, ((Number(r.value) || 0) / max) * 100)}%`, background: color, borderRadius: 6 }} />
          </div>
        </div>
      ))}
    </div>
  );
}

// ── Simple table ──────────────────────────────────────────────────
// cols = [{ key, label, align?, render?(row) }]
export function Table({ cols, rows, empty = 'No data.' }) {
  if (!rows || !rows.length) return <Empty msg={empty} />;
  return (
    <div style={{ overflowX: 'auto' }}>
      <table className="w-100" style={{ borderCollapse: 'collapse', fontSize: '0.78rem' }}>
        <thead>
          <tr>
            {cols.map((c) => (
              <th key={c.key} style={{ textAlign: c.align || 'left', padding: '6px 10px', color: 'var(--text-muted)', fontSize: '0.62rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.04em', borderBottom: '1px solid var(--border-subtle)', whiteSpace: 'nowrap' }}>{c.label}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i}>
              {cols.map((c) => (
                <td key={c.key} style={{ textAlign: c.align || 'left', padding: '8px 10px', color: 'var(--text-primary)', borderBottom: '1px solid var(--border-subtle)', verticalAlign: 'middle', fontVariantNumeric: c.align === 'right' ? 'tabular-nums' : undefined }}>
                  {c.render ? c.render(r) : r[c.key]}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
