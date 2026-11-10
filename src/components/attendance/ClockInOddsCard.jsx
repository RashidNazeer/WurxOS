// The card shown right after an APC / TL clocks in: their chance of APC / TL of the Month,
// as a ring, with a short motivating headline, their rank, the pillar to work on and, while the
// number is still provisional, a prompt to update their incentive progress (mig 445-447).
// Centered over a dimmed page so it cannot be missed; closes on click, Esc, "Let's go!" or after 12 s.
import { useEffect } from 'react';
import { createPortal } from 'react-dom';
import { Link } from 'react-router-dom';

const AUTO_CLOSE_MS = 12000;
const PILLAR = { performance: 'Performance', incentives: 'Incentives', attendance: 'Attendance', flags: 'Flags' };

// Tone follows how close the person is to the top.
function copyFor(p, title) {
  if (p >= 40) return { headline: "You're leading the race!", body: `Keep that streak going. ${title} is within reach.`, emoji: '🏆' };
  if (p >= 20) return { headline: "You're right in the mix!", body: `Today can move your chance of becoming ${title}.`, emoji: '🚀' };
  if (p >= 8) return { headline: "You're in the race!", body: 'Every goal you finish today pushes your chance higher.', emoji: '💪' };
  return { headline: 'The month is wide open!', body: `Small wins today add up. Your chance of ${title} starts building now.`, emoji: '🌟' };
}

export default function ClockInOddsCard({ odds, onClose }) {
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    const t = setTimeout(onClose, AUTO_CLOSE_MS);
    return () => { window.removeEventListener('keydown', onKey); clearTimeout(t); };
  }, [onClose]);

  const title = odds.pool === 'tl' ? 'TL of the Month' : 'APC of the Month';
  const p = odds.probability;
  const { headline, body, emoji } = copyFor(p, title);
  const R = 54;
  const C = 2 * Math.PI * R;
  const showGap = odds.focusPillar && odds.focusGap > 0;

  return createPortal(
    <div style={{ position: 'fixed', inset: 0, zIndex: 1200, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
      <style>{`
        @keyframes wxOddsPop { from { opacity: 0; transform: translateY(16px) scale(.95); } to { opacity: 1; transform: none; } }
        @keyframes wxOddsRing { from { stroke-dashoffset: ${C}; } to { stroke-dashoffset: ${C * (1 - Math.min(100, p) / 100)}; } }
        @keyframes wxOddsShrink { from { width: 100%; } to { width: 0%; } }
      `}</style>
      <div style={{ position: 'absolute', inset: 0, background: 'var(--backdrop)', backdropFilter: 'blur(3px)' }} onClick={onClose} />
      <div className="wx-odds-card" role="dialog" aria-label={`Your chance of ${title}`}
        style={{
          position: 'relative', width: '100%', maxWidth: 400, borderRadius: 'var(--radius-lg)', overflow: 'hidden',
          background: 'linear-gradient(160deg, color-mix(in srgb, var(--accent) 16%, var(--surface-1)), var(--surface-1) 55%)',
          border: '1px solid color-mix(in srgb, var(--accent) 50%, transparent)', boxShadow: 'var(--shadow-lg)',
          animation: 'wxOddsPop .35s cubic-bezier(.2,.9,.3,1.2) both',
        }}>
        <div className="px-4 pt-4 pb-3 text-center">
          <div className="d-inline-flex align-items-center gap-2 rounded-pill px-3 py-1 mb-3"
            style={{ background: 'var(--success-soft)', color: 'var(--success-text)', fontSize: '0.74rem', fontWeight: 700 }}>
            <i className="bi bi-check-circle-fill" /> You're clocked in
          </div>

          <div style={{ position: 'relative', width: 140, height: 140, margin: '0 auto' }}>
            <svg width="140" height="140" viewBox="0 0 140 140" style={{ transform: 'rotate(-90deg)' }}>
              <circle cx="70" cy="70" r={R} fill="none" stroke="var(--surface-3)" strokeWidth="11" />
              <circle cx="70" cy="70" r={R} fill="none" stroke="var(--accent)" strokeWidth="11" strokeLinecap="round"
                strokeDasharray={C} strokeDashoffset={C * (1 - Math.min(100, p) / 100)}
                style={{ animation: 'wxOddsRing 1.1s .25s cubic-bezier(.3,.7,.2,1) both' }} />
            </svg>
            <div className="d-flex flex-column align-items-center justify-content-center" style={{ position: 'absolute', inset: 0 }}>
              <span className="fw-bold" style={{ fontSize: '2.3rem', lineHeight: 1, color: 'var(--accent)' }}>{p}%</span>
              <span className="text-muted" style={{ fontSize: '0.62rem', letterSpacing: '.06em', textTransform: 'uppercase' }}>chance</span>
            </div>
          </div>

          <div className="fw-bold mt-3" style={{ fontSize: '1.15rem' }}>{headline} {emoji}</div>
          <div className="text-muted mt-1" style={{ fontSize: '0.82rem' }}>
            of becoming <strong style={{ color: 'var(--text-primary)' }}>{title}</strong>
          </div>
          <div className="mt-2" style={{ fontSize: '0.84rem', color: 'var(--text-secondary)' }}>{body}</div>

          <div className="d-flex justify-content-center gap-2 flex-wrap mt-3">
            <span className="rounded-pill px-3 py-1" style={{ background: 'var(--surface-2)', fontSize: '0.74rem', fontWeight: 600 }}>
              Rank {odds.rank} of {odds.poolSize}
            </span>
            <span className="rounded-pill px-3 py-1" style={{ background: 'var(--surface-2)', fontSize: '0.74rem', fontWeight: 600 }}>
              Projected score {odds.score}
            </span>
          </div>

          {showGap && (
            <div className="mt-3 text-start rounded-3 px-3 py-2" style={{ background: 'var(--surface-2)', fontSize: '0.78rem', color: 'var(--text-secondary)' }}>
              <i className="bi bi-bullseye me-1" style={{ color: 'var(--accent)' }} />
              Biggest chance to climb: <strong style={{ color: 'var(--text-primary)' }}>{PILLAR[odds.focusPillar]}</strong>, about {odds.focusGap} points below the top 3.
            </div>
          )}

          {odds.provisional && (
            <div className="mt-2 text-start rounded-3 px-3 py-2 d-flex align-items-center justify-content-between gap-2"
              style={{ background: 'var(--warning-soft)', color: 'var(--warning-text)', fontSize: '0.76rem', fontWeight: 600 }}>
              <span><i className="bi bi-pencil-square me-1" />Update your completed incentive goals to make this number exact.</span>
              <Link to="/incentives" onClick={onClose} className="btn btn-sm flex-shrink-0"
                style={{ background: 'var(--accent)', color: 'var(--on-accent)', border: 'none', fontSize: '0.7rem' }}>Update</Link>
            </div>
          )}

          <button type="button" className="btn w-100 mt-3" onClick={onClose}
            style={{ background: 'var(--accent)', color: 'var(--on-accent)', border: 'none', fontWeight: 700, borderRadius: 'var(--radius-md)', padding: '10px 14px' }}>
            Let's go!
          </button>
        </div>
        <div style={{ height: 3, background: 'var(--surface-3)' }}>
          <div className="wx-odds-timer" style={{ height: '100%', background: 'var(--accent)', animation: `wxOddsShrink ${AUTO_CLOSE_MS}ms linear forwards` }} />
        </div>
      </div>
    </div>,
    document.body,
  );
}
