import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { getAchievementOdds } from '../../lib/achievementsApi';
import { karachiYmd } from '../../lib/serverTime';

const PILLAR_LABEL = { performance: 'Performance', incentives: 'Incentives', attendance: 'Attendance', flags: 'Flags' };

// "Your chance of APC / TL of the Month". An estimate from this month only,
// not a promise: the Boss or an OL makes the final call (mig 445).
// APCs can also slide how many incentive goals they complete to see the effect.
export default function AchievementOddsCard({ month, role, goalsTotal = 0, goalsDone = 0 }) {
  const [base, setBase] = useState(undefined);
  const [loadErr, setLoadErr] = useState('');
  const [what, setWhat] = useState(null);
  const [n, setN] = useState(goalsDone);
  useEffect(() => { setN(goalsDone); }, [goalsDone, month]);

  useEffect(() => {
    let off = false;
    setBase(undefined); setLoadErr('');
    getAchievementOdds(month)
      .then((r) => { if (!off) setBase(r); })
      .catch((e) => { if (!off) { setBase(null); setLoadErr(e.message || String(e)); } });
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

  if (base === undefined) {
    return (
      <div className="card border-0 shadow-sm mb-4" style={{ borderRadius: 'var(--radius-lg)' }}>
        <div className="card-body p-3 text-muted small"><span className="spinner-border spinner-border-sm me-2" />Calculating your chance of {role === 'tl' ? 'TL' : 'APC'} of the Month…</div>
      </div>
    );
  }
  if (!base) {
    return loadErr ? (
      <div className="card border-0 shadow-sm mb-4" style={{ borderRadius: 'var(--radius-lg)' }}>
        <div className="card-body p-3 small" style={{ color: 'var(--danger-text)' }}>
          <i className="bi bi-exclamation-triangle me-1" />Couldn't load your chance of {role === 'tl' ? 'TL' : 'APC'} of the Month: {loadErr}
        </div>
      </div>
    ) : null;
  }
  const title = base.pool === 'tl' ? 'TL of the Month' : 'APC of the Month';
  // The estimate is only exact once the incentive goals are filled in and verified, so ask for the
  // progress so far. Current month only; a finished month is already settled.
  const needsGoals = month === karachiYmd().slice(0, 7) && (goalsTotal === 0 || base.provisional);
  const shown = changed && what?.probability != null ? what : base;

  return (
    <div className="card border-0 shadow-sm mb-4" style={{ borderRadius: 'var(--radius-lg)', border: '1px solid color-mix(in srgb, var(--accent) 45%, transparent)', background: 'linear-gradient(135deg, color-mix(in srgb, var(--accent) 14%, var(--surface-1)), var(--surface-1))' }}>
      <div className="card-body p-4">
        <div className="d-flex align-items-center justify-content-between mb-1">
          <span className="fw-bold" style={{ fontSize: '1rem' }}><i className="bi bi-trophy-fill me-2" style={{ color: 'var(--warning)', fontSize: '1.2rem' }} />Your chance of becoming {title}</span>
          <span className="text-muted" style={{ fontSize: '0.62rem' }}>estimate</span>
        </div>
        {!base.eligible ? (
          <div className="text-muted small">{base.reason}</div>
        ) : (
          <>
            <div className="d-flex align-items-baseline gap-2">
              <span className="fw-bold" style={{ fontSize: '3rem', lineHeight: 1, color: 'var(--accent)' }}>{shown.probability}%</span>
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
        {needsGoals && (
          <div className="rounded-2 mt-2 px-2 py-2 d-flex align-items-center justify-content-between gap-2 flex-wrap"
            style={{ background: 'var(--warning-soft)', color: 'var(--warning-text)', fontSize: '0.74rem', fontWeight: 600 }}>
            <span><i className="bi bi-pencil-square me-1" />
              {goalsTotal === 0
                ? 'Add your incentive goals for this month, so your chance can be exact.'
                : `Update the incentive goals you've completed so far (${goalsDone} of ${goalsTotal}) to make this chance exact.`}
            </span>
            <Link to="/incentives" className="btn btn-sm" style={{ background: 'var(--accent)', color: 'var(--on-accent)', border: 'none', fontSize: '0.7rem' }}>Update incentives</Link>
          </div>
        )}
        <div className="text-muted mt-1" style={{ fontSize: '0.62rem' }}>
          Based on this month only. The Boss or OL makes the final choice.
        </div>
      </div>
    </div>
  );
}
