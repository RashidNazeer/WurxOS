import { useEffect, useState } from 'react';
import { getAchievementOdds } from '../../lib/achievementsApi';

const PILLAR_LABEL = { performance: 'Performance', incentives: 'Incentives', attendance: 'Attendance', flags: 'Flags' };

// "Your chance of APC / TL of the Month". An estimate from the month so far and the last three
// finalised months, not a promise: the Boss or an OL makes the final call (mig 445).
// APCs can also slide how many incentive goals they complete to see the effect.
export default function AchievementOddsCard({ month, role, goalsTotal = 0, goalsDone = 0 }) {
  const [base, setBase] = useState(undefined);
  const [what, setWhat] = useState(null);
  const [n, setN] = useState(goalsDone);
  useEffect(() => { setN(goalsDone); }, [goalsDone, month]);

  useEffect(() => {
    let off = false;
    setBase(undefined);
    getAchievementOdds(month).then((r) => { if (!off) setBase(r); }).catch(() => { if (!off) setBase(null); });
    return () => { off = true; };
  }, [month]);

  const canPlay = role === 'apc' && goalsTotal > 0;
  const changed = canPlay && n !== goalsDone;
  useEffect(() => {
    if (!changed) { setWhat(null); return undefined; }
    let off = false;
    const t = setTimeout(() => {
      getAchievementOdds(month, (n / goalsTotal) * 100).then((r) => { if (!off) setWhat(r); }).catch(() => {});
    }, 250);
    return () => { off = true; clearTimeout(t); };
  }, [changed, n, goalsTotal, month]);

  if (!base) return null;
  const title = base.pool === 'tl' ? 'TL of the Month' : 'APC of the Month';
  const shown = changed && what?.probability != null ? what : base;

  return (
    <div className="card border-0 shadow-sm mb-4" style={{ borderRadius: 'var(--radius-lg)' }}>
      <div className="card-body p-3">
        <div className="d-flex align-items-center justify-content-between mb-1">
          <span className="fw-bold" style={{ fontSize: '0.85rem' }}><i className="bi bi-trophy-fill me-1" style={{ color: 'var(--warning)' }} />Your chance of {title}</span>
          <span className="text-muted" style={{ fontSize: '0.62rem' }}>estimate</span>
        </div>
        {!base.eligible ? (
          <div className="text-muted small">{base.reason}</div>
        ) : (
          <>
            <div className="d-flex align-items-baseline gap-2">
              <span className="fw-bold" style={{ fontSize: '1.9rem', color: 'var(--accent)' }}>{shown.probability}%</span>
              <span className="text-muted small">
                rank {shown.rank} of {shown.poolSize} · projected score {shown.score}
              </span>
            </div>
            {changed && what?.probability != null && (
              <div className="small" style={{ color: what.probability >= base.probability ? 'var(--success-text)' : 'var(--danger-text)' }}>
                {what.probability >= base.probability ? '▲' : '▼'} from {base.probability}% with {goalsDone} of {goalsTotal} goals done
              </div>
            )}
            {base.focusPillar && base.focusGap > 0 && (
              <div className="text-muted mt-1" style={{ fontSize: '0.72rem' }}>
                Biggest gap: <strong>{PILLAR_LABEL[base.focusPillar]}</strong> — about {base.focusGap} points below the top 3.
              </div>
            )}
            {canPlay && (
              <div className="mt-2 pt-2" style={{ borderTop: '1px dashed var(--border-subtle)' }}>
                <div className="d-flex justify-content-between" style={{ fontSize: '0.72rem' }}>
                  <span className="text-muted">What if I complete…</span>
                  <strong>{n} of {goalsTotal} incentive goals</strong>
                </div>
                <input type="range" className="form-range" min={0} max={goalsTotal} step={1} value={n} onChange={(e) => setN(Number(e.target.value))} />
              </div>
            )}
            {(base.provisional || changed) && (
              <div className="text-muted" style={{ fontSize: '0.64rem' }}>
                {changed ? 'What-if only; nothing is saved. ' : ''}Counts your goals as filled in, even before they are verified.
              </div>
            )}
          </>
        )}
        <div className="text-muted mt-1" style={{ fontSize: '0.62rem' }}>
          Based on this month so far and your last 3 finalised months. The Boss or OL makes the final choice.
        </div>
      </div>
    </div>
  );
}
