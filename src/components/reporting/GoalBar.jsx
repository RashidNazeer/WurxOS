import React from 'react';

// Sample-goal progress bar — shows MTD approved vs a monthly goal, with the
// pending count. Gradient fill (turns green when the goal is met). Shared by
// the weekly/biweekly + monthly report views. Token-driven (light/dark safe).
//
// Props: approved (MTD samples approved), goal (monthly goal), label (optional),
//        compact (smaller, for per-product rows).
// Replaces the whole progress bar when the brand's sample goal is UNLIMITED
// (mig 348). Shown once per report, not once per product row: repeating
// "Unlimited" on every line is noise, but saying nothing at all reads as a
// missing goal rather than a deliberate one.
export function UnlimitedGoalNote({ approved, label = 'Sample goal', note = 'No monthly cap on approvals' }) {
  const a = Number(approved) || 0;
  return (
    <div className="d-flex justify-content-between align-items-center" style={{ fontSize: '0.7rem', gap: 10 }}>
      <span style={{ color: 'var(--text-muted)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.04em' }}>
        {label}
      </span>
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
        <span style={{
          padding: '2px 9px', borderRadius: 999, fontWeight: 700, letterSpacing: '0.02em',
          color: 'var(--success)',
          background: 'color-mix(in srgb, var(--success) 12%, transparent)',
          border: '1px solid color-mix(in srgb, var(--success) 32%, transparent)',
        }}>
          Unlimited
        </span>
        <span style={{ color: 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {note}{a > 0 ? ` · ${a.toLocaleString()} approved` : ''}
        </span>
      </span>
    </div>
  );
}

export default function GoalBar({ approved, goal, label, compact = false }) {
  const a = Number(approved) || 0;
  const g = Number(goal) || 0;
  if (g <= 0) return null;                 // no goal set → no bar
  const pct = Math.min(100, (a / g) * 100);
  const pending = Math.max(0, g - a);
  const met = a >= g;
  const fill = met
    ? 'linear-gradient(90deg, var(--success), color-mix(in srgb, var(--success) 55%, white))'
    : 'linear-gradient(90deg, var(--accent), color-mix(in srgb, var(--accent) 55%, white))';
  return (
    <div style={{ marginTop: compact ? 6 : 10 }}>
      <div className="d-flex justify-content-between align-items-center"
        style={{ fontSize: compact ? '0.64rem' : '0.7rem', marginBottom: 3 }}>
        <span style={{ color: 'var(--text-muted)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.04em' }}>
          {label || 'Sample goal'}
        </span>
        <span style={{ fontWeight: 700, color: 'var(--text-secondary)', fontVariantNumeric: 'tabular-nums' }}>
          {a.toLocaleString()} / {g.toLocaleString()}
          {met
            ? <span style={{ color: 'var(--success)', marginLeft: 6 }}>✓ met</span>
            : <span style={{ color: 'var(--text-muted)', marginLeft: 6 }}>· {pending.toLocaleString()} pending</span>}
        </span>
      </div>
      <div style={{ height: compact ? 6 : 8, background: 'var(--surface-2)', borderRadius: 999, overflow: 'hidden' }}>
        <div style={{ height: '100%', width: `${pct}%`, background: fill, borderRadius: 999, transition: 'width 0.4s var(--ease-out)' }} />
      </div>
    </div>
  );
}
