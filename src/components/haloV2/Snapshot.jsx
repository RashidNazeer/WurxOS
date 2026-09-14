// ============================================================
// Halo V2 - Snapshot, the first viewport.
//
// Inverted pyramid: the answer, the range around it, how much weight it
// carries, what it is not, and what to do next. Five cards and one chart, with
// no control to operate. If a reader has to scroll or ask a question before
// they understand it, this section has failed.
//
// The "what this is not" card is not a disclaimer in small print. It sits at
// the same weight as the effect, because the effect is the figure that gets
// screenshotted into a deck and the caveat has to be inside the same crop.
// ============================================================

import { EvidenceTag, ModelledBadge, Chip } from './shared.jsx';

const VERDICT_TONE = {
  Scale: { fg: 'var(--success)', bg: 'var(--success-soft)', bd: 'var(--success)', icon: 'bi-graph-up-arrow' },
  Hold: { fg: 'var(--warning)', bg: 'var(--warning-soft)', bd: 'var(--warning)', icon: 'bi-pause-circle' },
  'Need more data': { fg: 'var(--text-secondary)', bg: 'var(--surface-3)', bd: 'var(--border-default)', icon: 'bi-hourglass-split' },
};

export default function Snapshot({ snapshot, headline, periodLabel, brandName, comparison, chart, chartCaption }) {
  if (!snapshot) return null;
  const { effect, range, signal, action, notClaim } = snapshot;
  const verdict = VERDICT_TONE[action.verdict] || VERDICT_TONE['Need more data'];

  return (
    <section className="wx-card" style={{ padding: '20px 22px' }}>
      {/* Framing line: who, what and when, before any number. */}
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap', alignItems: 'baseline' }}>
        <div style={{ fontSize: 11, fontWeight: 800, letterSpacing: '.08em', textTransform: 'uppercase', color: 'var(--text-muted)' }}>
          The TikTok Shop effect on Amazon
        </div>
        <div style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>
          {[brandName, periodLabel].filter(Boolean).join(' · ')}
        </div>
      </div>

      {headline && (
        <h1 style={{
          fontSize: 'clamp(1.1rem, 2.4vw, 1.5rem)', fontWeight: 800, margin: '8px 0 0',
          lineHeight: 1.3, color: 'var(--text-primary)', maxWidth: 900,
        }}>
          {headline}
        </h1>
      )}
      {comparison && (
        <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 6 }}>{comparison}</div>
      )}

      <div style={{
        display: 'grid', gap: 12, marginTop: 16,
        gridTemplateColumns: 'repeat(auto-fit, minmax(215px, 1fr))',
      }}>
        {/* 1 - the effect. The only card with the accent border. */}
        <Card
          label={effect.label}
          value={effect.value}
          sub={effect.sub}
          badge={effect.available ? <ModelledBadge compact weakHalo={effect.weakHalo} /> : null}
          primary
          muted={!effect.available}
        />

        {/* 2 - the range, in words rather than notation. */}
        <Card
          label={range.label}
          value={range.value}
          sub={range.sub}
          valueSize={16}
          muted={!range.available}
          tone={range.spansZero ? 'warn' : undefined}
        />

        {/* 3 - signal strength, with the reason that decided it. */}
        <Card
          label="Signal strength"
          value={signal.level}
          sub={signal.why}
          tone={signal.level === 'High' ? 'pos' : signal.level === 'Moderate' ? undefined : 'muted'}
          footer={signal.confidenceLabel ? <Chip>{signal.confidenceLabel}</Chip> : null}
        />

        {/* 4 - the claim ceiling. */}
        <Card
          label="What this is not"
          value={<span style={{ fontSize: 13, fontWeight: 700, lineHeight: 1.45 }}>{notClaim}</span>}
          sub="Showing that sales would not have happened otherwise needs a controlled test, such as a geo holdout. This tool does not run one."
          footer={<EvidenceTag />}
        />

        {/* 5 - the decision. */}
        <div style={{
          padding: '12px 14px', borderRadius: 'var(--radius-lg)',
          background: verdict.bg, border: `1px solid ${verdict.bd}`,
        }}>
          <div style={{ fontSize: 10.5, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '.05em', fontWeight: 700 }}>
            Next action
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginTop: 2 }}>
            <i className={`bi ${verdict.icon}`} style={{ color: verdict.fg, fontSize: 16 }} />
            <span style={{ fontSize: '1.25rem', fontWeight: 800, color: verdict.fg, lineHeight: 1.2 }}>{action.verdict}</span>
          </div>
          <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginTop: 4, lineHeight: 1.45 }}>{action.detail}</div>
        </div>
      </div>

      {chart && (
        <div style={{ marginTop: 18 }}>
          {chart}
          {chartCaption && (
            <div style={{ fontSize: 11.5, color: 'var(--text-muted)', marginTop: 6 }}>{chartCaption}</div>
          )}
        </div>
      )}
    </section>
  );
}

function Card({ label, value, sub, badge = null, footer = null, primary = false, muted = false, tone, valueSize }) {
  const color = tone === 'pos' ? 'var(--success)'
    : tone === 'warn' ? 'var(--warning)'
    : muted ? 'var(--text-muted)'
    : 'var(--text-primary)';
  return (
    <div style={{
      padding: '12px 14px', borderRadius: 'var(--radius-lg)',
      background: primary ? 'var(--accent-soft)' : 'var(--surface-2)',
      border: `1px solid ${primary ? 'var(--accent)' : 'var(--border-subtle)'}`,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 10.5, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '.05em', fontWeight: 700 }}>
          {label}
        </span>
        {badge}
      </div>
      <div style={{
        fontSize: valueSize ? valueSize : primary ? '1.5rem' : '1.25rem',
        fontWeight: 800, color, lineHeight: 1.25, marginTop: 2,
      }}>
        {value}
      </div>
      {sub && <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginTop: 4, lineHeight: 1.45 }}>{sub}</div>}
      {footer && <div style={{ marginTop: 8 }}>{footer}</div>}
    </div>
  );
}
