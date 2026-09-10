// ============================================================
// Halo V2 — shared UI primitives.
//
// Extracted from HaloV2Explorer so the explorer reads as composition rather
// than a single 600-line file, and so the epistemic badge in particular has one
// definition. A badge that says "not incremental" is worth nothing if a later
// panel renders its own slightly different version.
// ============================================================

export const TT_STYLE = {
  background: 'var(--surface-1, #16161c)',
  border: '1px solid var(--border-default, #2b2b35)',
  borderRadius: 8,
  fontSize: 12,
  color: 'var(--text-primary, #e8e8ee)',
};
export const GRID = 'var(--border-subtle, #2b2b3522)';

// Chart series colours are literals rather than tokens on purpose: Recharts
// paints SVG attributes, which cannot resolve a CSS custom property, and these
// two hues read correctly against both the light portal and the dark app.
export const SERIES_TIKTOK = '#6366f1';
export const SERIES_AMAZON = '#22c55e';
export const SERIES_BASELINE = '#94a3b8';

export const FieldLabel = ({ children }) => (
  <div style={{
    fontSize: 10.5, color: 'var(--text-muted)', textTransform: 'uppercase',
    letterSpacing: '.05em', fontWeight: 700, marginBottom: 4,
  }}>{children}</div>
);

export function Picker({ label, value, onChange, options, width = 150, hint = null }) {
  return (
    <div>
      <FieldLabel>{label}</FieldLabel>
      <select
        className="wx-input"
        style={{ minWidth: width }}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      >
        {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
      {hint && <div style={{ fontSize: 10.5, color: 'var(--text-muted)', marginTop: 3, maxWidth: 260 }}>{hint}</div>}
    </div>
  );
}

export const Check = ({ label, checked, onChange, title = null }) => (
  <label title={title || undefined} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, cursor: 'pointer' }}>
    <input type="checkbox" className="form-check-input mt-0" checked={checked} onChange={(e) => onChange(e.target.checked)} />
    {label}
  </label>
);

export function Stat({ label, value, sub, tone, badge = null, emphasis = false }) {
  const color = tone === 'pos' ? 'var(--success, #22c55e)'
    : tone === 'neg' ? 'var(--danger, #ef4444)'
    : tone === 'warn' ? 'var(--warning, #f59e0b)'
    : tone === 'muted' ? 'var(--text-muted)'
    : 'var(--text-primary)';
  return (
    <div style={{
      padding: '12px 14px',
      borderRadius: 10,
      background: 'var(--surface-2)',
      border: emphasis ? '1.5px solid var(--accent)' : '1px solid var(--border-subtle)',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
        <div style={{
          fontSize: 10.5, color: 'var(--text-muted)', textTransform: 'uppercase',
          letterSpacing: '.05em', fontWeight: 700,
        }}>{label}</div>
        {badge}
      </div>
      <div style={{ fontSize: emphasis ? '1.5rem' : '1.25rem', fontWeight: 800, color, lineHeight: 1.25 }}>{value}</div>
      {sub && <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>{sub}</div>}
    </div>
  );
}

export function Note({ tone = 'info', children }) {
  const c = tone === 'warn' ? { bg: 'rgba(245,158,11,.10)', bd: 'rgba(245,158,11,.35)', ic: 'bi-exclamation-triangle' }
    : tone === 'danger' ? { bg: 'rgba(239,68,68,.10)', bd: 'rgba(239,68,68,.35)', ic: 'bi-exclamation-octagon' }
    : tone === 'planning' ? { bg: 'rgba(245,158,11,.07)', bd: 'rgba(245,158,11,.25)', ic: 'bi-sliders' }
    : tone === 'success' ? { bg: 'rgba(34,197,94,.09)', bd: 'rgba(34,197,94,.30)', ic: 'bi-check-circle' }
    : { bg: 'rgba(99,102,241,.08)', bd: 'rgba(99,102,241,.28)', ic: 'bi-info-circle' };
  return (
    <div style={{
      background: c.bg, border: `1px solid ${c.bd}`, borderRadius: 8,
      padding: '8px 12px', fontSize: 12, marginTop: 10, display: 'flex', gap: 8,
    }}>
      <i className={`bi ${c.ic}`} style={{ marginTop: 1, flexShrink: 0 }} />
      <div>{children}</div>
    </div>
  );
}

export const Row = ({ k, v }) => (
  <tr style={{ borderTop: '1px solid var(--border-subtle)' }}>
    <td style={{ padding: '5px 8px', color: 'var(--text-muted)' }}>{k}</td>
    <td style={{ padding: '5px 8px', textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{v}</td>
  </tr>
);

export function Layer({ letter, title, subtitle, tone, children, right = null }) {
  const accent = tone === 'planning' ? 'var(--warning, #f59e0b)' : 'var(--accent)';
  return (
    <div className="wx-card" style={{ padding: 18, borderLeft: `3px solid ${accent}` }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
        <div>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginBottom: 2, flexWrap: 'wrap' }}>
            <span style={{ fontSize: 10, fontWeight: 800, color: accent, letterSpacing: '.08em' }}>LAYER {letter}</span>
            <h2 style={{ fontSize: '1.05rem', fontWeight: 800, margin: 0 }}>{title}</h2>
          </div>
          <p style={{ fontSize: 12, color: 'var(--text-muted)', margin: '0 0 14px', maxWidth: 760 }}>{subtitle}</p>
        </div>
        {right}
      </div>
      {children}
    </div>
  );
}

// ── The epistemic badge (brief §B) ──────────────────────────────────
// Required on every modelled output: the hero figure, the contribution, the
// planning scenarios and anything exported.
//
// It exists because "$1.67 per $1" is one screenshot away from a client deck as
// proof of causation. The number is an association after the controls we happen
// to have, and calling it incremental would require Stage 6 validation this
// tool does not do. The badge travels with the number so the caveat cannot be
// cropped away from it.
export const MODELLED_TOOLTIP = 'Association after the controls included in the model. '
  + 'Not proof of causal lift. Incremental requires geo or holdout validation '
  + '(Stage 6 — not in this tool yet).';

export function ModelledBadge({ compact = false, weakHalo = false }) {
  const text = weakHalo ? 'SAME-PERIOD · WEAK HALO CLAIM' : 'MODELLED · NOT INCREMENTAL';
  const tip = weakHalo
    ? `${MODELLED_TOOLTIP} This figure rests on same-period co-movement only, which a shared cause explains just as well as a spillover.`
    : MODELLED_TOOLTIP;
  return (
    <span
      title={tip}
      style={{
        display: 'inline-block',
        fontSize: compact ? 8.5 : 9.5,
        fontWeight: 800,
        letterSpacing: '.06em',
        padding: compact ? '2px 5px' : '3px 7px',
        borderRadius: 4,
        whiteSpace: 'nowrap',
        cursor: 'help',
        background: weakHalo ? 'rgba(245,158,11,.16)' : 'rgba(148,163,184,.18)',
        color: weakHalo ? 'var(--warning, #f59e0b)' : 'var(--text-secondary)',
        border: `1px solid ${weakHalo ? 'rgba(245,158,11,.4)' : 'rgba(148,163,184,.35)'}`,
      }}
    >{text}</span>
  );
}

// ── Progress meter (brief §A5) ──────────────────────────────────────
// "Usable periods: 5 / ~20". A bare refusal tells someone they cannot have the
// thing; a meter tells them how far away it is, which is the difference between
// a dead end and a next step. "Almost there" is called out separately because
// 19 of 20 deserves a different feeling from 5 of 20.
export function ProgressMeter({ usable, required, unit = 'period', almostThere = false }) {
  const pct = required > 0 ? Math.min(100, Math.round((usable / required) * 100)) : 0;
  const tone = almostThere ? 'var(--warning, #f59e0b)' : 'var(--accent)';
  return (
    <div style={{ marginTop: 10 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11.5, marginBottom: 4 }}>
        <span style={{ color: 'var(--text-secondary)' }}>
          Usable {unit}s: <strong style={{ color: 'var(--text-primary)' }}>{usable}</strong> / ~{required}
        </span>
        {almostThere && (
          <span style={{ color: tone, fontWeight: 700 }}>
            Almost there — {Math.max(0, required - usable)} more
          </span>
        )}
      </div>
      <div style={{ height: 6, borderRadius: 999, background: 'var(--surface-3, rgba(148,163,184,.18))', overflow: 'hidden' }}>
        <div style={{ width: `${pct}%`, height: '100%', background: tone, transition: 'width .3s ease' }} />
      </div>
    </div>
  );
}

/**
 * Index a series to 100 at its first usable point (brief §C).
 *
 * Lets two metrics on wildly different scales — GMV in thousands, a rank in
 * single digits — be compared for co-movement on one axis, which is the whole
 * reason the toggle exists. Anchoring on the first NON-ZERO value matters: a
 * series that opens at zero would otherwise divide by it and render as nothing.
 * Returns nulls unchanged so missing stays missing.
 */
export function indexToHundred(values) {
  const first = (values || []).find((v) => v != null && Number.isFinite(v) && v !== 0);
  if (first == null) return values;
  return values.map((v) => (v == null || !Number.isFinite(v) ? null : (v / first) * 100));
}
