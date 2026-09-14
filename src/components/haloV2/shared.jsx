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

// Money with an EXPLICIT symbol, for the planning table and the one-pager.
// The period being planned may be quoted in a different currency from the
// sheet, and fmtValue reads one module-level symbol for the whole app. Two
// decimals exact, matching every other money figure in WurxOS.
export const moneyWith = (sym, v) => `${sym}${Number(v || 0).toLocaleString(undefined, {
  minimumFractionDigits: 2, maximumFractionDigits: 2,
})}`;

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
  const color = tone === 'pos' ? 'var(--success)'
    : tone === 'neg' ? 'var(--danger)'
    : tone === 'warn' ? 'var(--warning)'
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
  const soft = (token, pct) => `color-mix(in srgb, var(${token}) ${pct}%, transparent)`;
  const c = tone === 'warn' ? { bg: 'var(--warning-soft)', bd: soft('--warning', 35), ic: 'bi-exclamation-triangle' }
    : tone === 'danger' ? { bg: 'var(--danger-soft)', bd: soft('--danger', 35), ic: 'bi-exclamation-octagon' }
    : tone === 'planning' ? { bg: 'var(--warning-soft)', bd: soft('--warning', 25), ic: 'bi-sliders' }
    : tone === 'success' ? { bg: 'var(--success-soft)', bd: soft('--success', 30), ic: 'bi-check-circle' }
    : { bg: 'var(--info-soft)', bd: soft('--info', 28), ic: 'bi-info-circle' };
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

// ── The client spine: See, Adjust, Estimate, Plan ───────────────────
// These replaced LAYER A / B / C. The layer names were the tool's internal
// vocabulary: someone looking for "the counterfactual" could not find it,
// because it lived inside Layer B under a stage number nobody had been shown.
// The four step names are the questions a client actually walks through, and
// the Book 4 stage ladder now lives in the Depth drawer where an operator can
// still map one to the other.
export function Section({ step, title, question, tone, children, right = null, id = null }) {
  const accent = tone === 'planning' ? 'var(--warning)' : 'var(--accent)';
  return (
    <section id={id} className="wx-card" style={{ padding: 18, borderLeft: `3px solid ${accent}` }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
        <div>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginBottom: 2, flexWrap: 'wrap' }}>
            <span style={{ fontSize: 10, fontWeight: 800, color: accent, letterSpacing: '.08em', textTransform: 'uppercase' }}>
              {step}
            </span>
            <h2 style={{ fontSize: '1.05rem', fontWeight: 800, margin: 0 }}>{title}</h2>
          </div>
          {question && <p style={{ fontSize: 12, color: 'var(--text-muted)', margin: '0 0 14px', maxWidth: 760 }}>{question}</p>}
        </div>
        {right}
      </div>
      {children}
    </section>
  );
}

// ── Meeting / Lab ───────────────────────────────────────────────────
// One audience wants an answer and one wants the apparatus, and building for
// the average of the two produced a page that served neither. The toggle is
// always visible, including on a share link: a client who wants to see the
// working should be able to, and an operator opening a client's link needs the
// same controls they have internally.
export function ModeToggle({ mode, onChange }) {
  const opt = (value, label, hint) => {
    const on = mode === value;
    return (
      <button
        key={value}
        type="button"
        onClick={() => onChange(value)}
        title={hint}
        aria-pressed={on}
        style={{
          border: 'none', background: on ? 'var(--surface-1)' : 'transparent',
          color: on ? 'var(--text-primary)' : 'var(--text-muted)',
          fontWeight: on ? 800 : 600, fontSize: 12, padding: '5px 14px', borderRadius: 999,
          boxShadow: on ? 'var(--shadow-sm)' : 'none', cursor: 'pointer',
        }}
      >{label}</button>
    );
  };
  return (
    <div
      role="group"
      aria-label="View mode"
      style={{
        display: 'inline-flex', gap: 2, padding: 3, borderRadius: 999,
        background: 'var(--surface-3)', border: '1px solid var(--border-subtle)',
      }}
    >
      {opt('meeting', 'Meeting', 'The client view: the answer, the evidence behind it, and the plan.')}
      {opt('lab', 'Lab', 'Everything in Meeting plus metric pickers, diagnostics and the stage ladder.')}
    </div>
  );
}

// A small labelled pill. One definition, because four hand-rolled pills drift
// apart in padding and weight within a release or two.
export function Chip({ children, tone = 'neutral', title = null, icon = null }) {
  const c = TONES[tone] || TONES.neutral;
  return (
    <span
      title={title || undefined}
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 5, whiteSpace: 'nowrap',
        fontSize: 11, fontWeight: 700, padding: '4px 9px', borderRadius: 999,
        background: c.bg, border: `1px solid ${c.bd}`, color: c.fg,
        cursor: title ? 'help' : undefined,
      }}
    >
      {icon && <i className={`bi ${icon}`} />}{children}
    </span>
  );
}

const TONES = {
  neutral:  { bg: 'var(--surface-3)',   bd: 'var(--border-subtle)',  fg: 'var(--text-secondary)' },
  accent:   { bg: 'var(--accent-soft)', bd: 'var(--accent)',         fg: 'var(--accent)' },
  assumed:  { bg: 'var(--warning-soft)', bd: 'var(--warning)',       fg: 'var(--warning)' },
  positive: { bg: 'var(--success-soft)', bd: 'var(--success)',       fg: 'var(--success)' },
  negative: { bg: 'var(--danger-soft)',  bd: 'var(--danger)',        fg: 'var(--danger)' },
};

// ── Evidence tag ────────────────────────────────────────────────────
// MODELLED or ASSUMED, on every figure that is one or the other. The two are
// routinely read as the same kind of number, and the difference is the whole
// reason the planning section is allowed to exist when the model is not.
export function EvidenceTag({ kind = 'modelled', compact = false }) {
  const assumed = kind === 'assumed';
  return (
    <span
      title={assumed
        ? 'A figure you or the placeholder set, multiplied through your own revenue. Nothing here was measured.'
        : MODELLED_TOOLTIP}
      style={{
        display: 'inline-block', fontSize: compact ? 8.5 : 9.5, fontWeight: 800, letterSpacing: '.06em',
        padding: compact ? '2px 5px' : '3px 7px', borderRadius: 4, whiteSpace: 'nowrap', cursor: 'help',
        background: assumed ? 'var(--warning-soft)' : 'var(--surface-3)',
        color: assumed ? 'var(--warning)' : 'var(--text-secondary)',
        border: `1px solid ${assumed ? 'var(--warning)' : 'var(--border-default)'}`,
      }}
    >{assumed ? 'ASSUMED' : 'MODELLED'}</span>
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
  + 'Not proof of causal lift. Incremental would require geo or holdout validation, '
  + 'which this tool does not run (Stage 6).';

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
        background: weakHalo ? 'var(--warning-soft)' : 'var(--surface-3)',
        color: weakHalo ? 'var(--warning)' : 'var(--text-secondary)',
        border: `1px solid ${weakHalo ? 'var(--warning)' : 'var(--border-default)'}`,
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
  const tone = almostThere ? 'var(--warning)' : 'var(--accent)';
  return (
    <div style={{ marginTop: 10 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11.5, marginBottom: 4 }}>
        <span style={{ color: 'var(--text-secondary)' }}>
          Usable {unit}s: <strong style={{ color: 'var(--text-primary)' }}>{usable}</strong> / ~{required}
        </span>
        {almostThere && (
          <span style={{ color: tone, fontWeight: 700 }}>
            Almost there: {Math.max(0, required - usable)} more
          </span>
        )}
      </div>
      <div style={{ height: 6, borderRadius: 999, background: 'var(--surface-3)', overflow: 'hidden' }}>
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
