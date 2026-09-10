// ============================================================
// Halo V2 — the measurement ladder as a stepper (brief §J).
//
// Thin data used to read as a broken page. The same screen with the stages
// named and marked reads as a position on a journey: Stage 1 done, Stage 3
// needs more history. Nothing changes about the data — only whether the user
// can see where they are.
// ============================================================

import { stageProgress } from '../../lib/haloV2/stages.js';

const TONE = {
  done:       { fg: 'var(--success, #22c55e)', bg: 'rgba(34,197,94,.12)',   bd: 'rgba(34,197,94,.35)',   icon: 'bi-check-circle-fill' },
  partial:    { fg: 'var(--warning, #f59e0b)', bg: 'rgba(245,158,11,.12)',  bd: 'rgba(245,158,11,.35)',  icon: 'bi-hourglass-split' },
  needs_data: { fg: 'var(--text-muted)',       bg: 'rgba(148,163,184,.10)', bd: 'rgba(148,163,184,.28)', icon: 'bi-circle' },
  later:      { fg: 'var(--text-muted)',       bg: 'transparent',           bd: 'rgba(148,163,184,.22)', icon: 'bi-clock' },
};

export default function StageStepper({ statuses }) {
  if (!statuses?.length) return null;
  const { done, total } = stageProgress(statuses);

  return (
    <div className="wx-card" style={{ padding: '12px 14px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 10, flexWrap: 'wrap', marginBottom: 10 }}>
        <div style={{ fontSize: 11, fontWeight: 800, letterSpacing: '.06em', color: 'var(--text-muted)', textTransform: 'uppercase' }}>
          Measurement stages
        </div>
        <div style={{ fontSize: 11.5, color: 'var(--text-secondary)' }}>
          <strong style={{ color: 'var(--text-primary)' }}>{done}</strong> of {total} complete
          <span style={{ color: 'var(--text-muted)' }}> · validation comes later</span>
        </div>
      </div>

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        {statuses.map((s) => {
          const t = TONE[s.status] || TONE.needs_data;
          return (
            <div
              key={s.key}
              title={s.detail}
              style={{
                flex: '1 1 150px',
                minWidth: 140,
                padding: '8px 10px',
                borderRadius: 8,
                background: t.bg,
                border: `1px solid ${t.bd}`,
                cursor: 'help',
                // A future stage should read as quieter than an unmet one, not
                // as another thing that failed.
                opacity: s.status === 'later' ? 0.6 : 1,
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <i className={`bi ${t.icon}`} style={{ color: t.fg, fontSize: 12 }} />
                <span style={{ fontSize: 10, fontWeight: 800, color: 'var(--text-muted)' }}>{s.n}</span>
                <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-primary)' }}>{s.title}</span>
              </div>
              <div style={{ fontSize: 10.5, color: t.fg, fontWeight: 600, marginTop: 3 }}>
                {s.statusLabel}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
