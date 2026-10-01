/**
 * <ProgressBar value={72} max={100} label="Target" showValue tone="accent|success|warning|danger|info" size="sm|md" />
 * The bar clamps to 0–100% (negative or NaN → 0). Past `max` it shows a
 * full bar in the over-target state and the real percentage as text.
 */
export default function ProgressBar({
  value,
  max = 100,
  label,
  showValue = false,
  tone = 'accent',
  size = 'md',
  className = '',
}) {
  const v = Number(value);
  const m = Number(max) > 0 ? Number(max) : 100;
  const raw = Number.isFinite(v) ? (v / m) * 100 : 0;
  const pct = Math.min(100, Math.max(0, raw));
  const over = raw > 100;
  const text = `${Math.max(0, Math.round(raw * 10) / 10)}%`;

  return (
    <div className={`ui-progress ui-progress--${size}${over ? ' is-over' : ''} ${className}`.trim()}>
      {(label || showValue) && (
        <div className="ui-progress__meta">
          {label && <span className="ui-progress__label">{label}</span>}
          {showValue && <span className="ui-progress__value">{text}{over ? ' · over target' : ''}</span>}
        </div>
      )}
      <div
        className="ui-progress__track"
        role="progressbar"
        aria-label={typeof label === 'string' ? label : undefined}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(pct)}
        aria-valuetext={over ? `${text}, over target` : text}
      >
        <div className={`ui-progress__fill ui-progress__fill--${over ? 'success' : tone}`} style={{ transform: `scaleX(${pct / 100})` }} />
      </div>
    </div>
  );
}
