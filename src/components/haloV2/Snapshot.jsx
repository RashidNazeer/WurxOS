// ============================================================
// Halo V2 - the key takeaway.
//
// TWO cards, one type scale:
//   the modelled effect, with its range as a quieter second line
//   signal strength, with the one reason that decided it
//
// Round 2 had five cards here (effect, a standalone 95% range, signal, "what
// this is not", and a next action), which forced the type down to fit a
// five-up grid and turned the first viewport into a scoreboard. The range now
// rides along under the number it belongs to, and the claim ceiling is carried
// by the badge and the methodology rather than by a card of its own.
//
// The badge sits on this block and nowhere else on Meeting. It is the one
// place the product truth needs stating: the figure beside it is a modelled
// association, not incremental lift.
//
// buildSnapshot still computes the next action and the claim line. They are
// not dead: both travel in the CSV and the one-pager, where a figure leaves
// the page without the page around it.
// ============================================================

import { ModelledBadge, Chip } from './shared.jsx';

export default function Snapshot({ snapshot, headline, chart, chartCaption }) {
  if (!snapshot) return null;
  const { effect, range, signal } = snapshot;

  return (
    <section className="wx-card" style={{ padding: '18px 20px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
        <div style={{ fontSize: 11, fontWeight: 800, letterSpacing: '.08em', textTransform: 'uppercase', color: 'var(--text-muted)' }}>
          The TikTok Shop effect on Amazon
        </div>
        <ModelledBadge />
      </div>

      {headline && (
        <h1 style={{
          fontSize: 'clamp(1.1rem, 2.4vw, 1.45rem)', fontWeight: 800, margin: '6px 0 0',
          lineHeight: 1.3, color: 'var(--text-primary)', maxWidth: 900,
        }}>
          {headline}
        </h1>
      )}

      {/* Two equal cards, stacked once there is no room for two. */}
      <div style={{
        display: 'grid', gap: 12, marginTop: 14,
        gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))',
      }}>
        <Card
          label={effect.label}
          value={effect.value}
          secondary={effect.available && range.available ? range.value : null}
          sub={effect.sub}
          accent
          muted={!effect.available}
        />
        <Card
          label="Signal strength"
          value={signal.level}
          secondary={signal.confidenceLabel ? <Chip>{signal.confidenceLabel}</Chip> : null}
          sub={signal.why}
        />
      </div>

      {chart && (
        <div style={{ marginTop: 16 }}>
          {chart}
          {chartCaption && (
            <div style={{ fontSize: 11.5, color: 'var(--text-muted)', marginTop: 6 }}>{chartCaption}</div>
          )}
        </div>
      )}
    </section>
  );
}

// One card shape for both, so neither can drift to its own type scale.
function Card({ label, value, secondary, sub, accent = false, muted = false }) {
  return (
    <div style={{
      padding: '14px 16px', borderRadius: 'var(--radius-lg)',
      background: accent ? 'var(--accent-soft)' : 'var(--surface-2)',
      border: `1px solid ${accent ? 'var(--accent)' : 'var(--border-subtle)'}`,
    }}>
      <div style={{ fontSize: 10.5, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '.05em', fontWeight: 700 }}>
        {label}
      </div>
      <div style={{
        fontSize: '1.6rem', fontWeight: 800, lineHeight: 1.2, marginTop: 4,
        color: muted ? 'var(--text-muted)' : 'var(--text-primary)',
      }}>
        {value}
      </div>
      {secondary && (
        <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 4, fontWeight: 600 }}>{secondary}</div>
      )}
      {sub && (
        <div style={{ fontSize: 11.5, color: 'var(--text-muted)', marginTop: 6, lineHeight: 1.45 }}>{sub}</div>
      )}
    </div>
  );
}
