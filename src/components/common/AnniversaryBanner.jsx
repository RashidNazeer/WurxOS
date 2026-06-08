import { useEffect, useState } from 'react';
import { useAuth } from '../../contexts/AuthContext';
import { pendingAnniversaryFor, markAnniversarySeen } from '../../lib/salariesApi';
import { StarIcon, XIcon } from './Icon';

// One-shot celebration banner. Shows when the user has completed a
// new work-year anniversary that:
//   (a) falls on or after SALARY_FEATURE_LAUNCH_DATE — no retroactive
//   (b) is greater than anniversary_celebrations.last_year_shown
//
// Dismiss calls mark_anniversary_seen RPC so it never re-appears for
// the same year, on any device.
export default function AnniversaryBanner() {
  const { user, profile } = useAuth();
  const [year, setYear] = useState(null);
  const [dismissing, setDismissing] = useState(false);
  const [animateOut, setAnimateOut] = useState(false);

  useEffect(() => {
    if (!user?.id || !profile?.start_date) return;
    let cancelled = false;
    pendingAnniversaryFor(user.id, profile.start_date)
      .then((y) => { if (!cancelled) setYear(y); })
      .catch(() => { /* non-fatal */ });
    return () => { cancelled = true; };
  }, [user?.id, profile?.start_date]);

  async function handleDismiss() {
    if (dismissing || !year) return;
    setDismissing(true);
    setAnimateOut(true);
    try {
      await markAnniversarySeen(year);
    } catch (e) {
      console.warn('Failed to dismiss anniversary banner:', e?.message);
    }
    // Wait for fade-out then unmount.
    setTimeout(() => setYear(null), 220);
  }

  if (!year) return null;

  return (
    <div style={{
      position: 'relative',
      padding: '16px 18px',
      marginBottom: 16,
      borderRadius: 'var(--radius-lg)',
      background: 'linear-gradient(135deg, var(--accent-soft), color-mix(in srgb, var(--accent-soft) 60%, transparent))',
      border: '1px solid color-mix(in srgb, var(--accent) 35%, transparent)',
      display: 'flex',
      alignItems: 'center',
      gap: 14,
      opacity: animateOut ? 0 : 1,
      transform: animateOut ? 'translateY(-6px)' : 'translateY(0)',
      transition: 'opacity 200ms ease, transform 200ms ease',
    }}>
      <div style={{
        width: 48, height: 48, borderRadius: 'var(--radius-pill)',
        background: 'var(--accent)', color: '#fff',
        display: 'grid', placeItems: 'center', flex: '0 0 auto',
        boxShadow: '0 4px 14px color-mix(in srgb, var(--accent) 40%, transparent)',
      }}>
        <StarIcon width="22" height="22" />
      </div>

      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontWeight: 700, fontSize: 15, color: 'var(--text-primary)', marginBottom: 2 }}>
          Congratulations on {year} {year === 1 ? 'year' : 'years'} at WurxOS! 🎉
        </div>
        <div style={{ fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.45 }}>
          Thank you for everything you've contributed. The Boss has been notified and will review your compensation.
        </div>
      </div>

      <button
        type="button"
        onClick={handleDismiss}
        aria-label="Dismiss"
        disabled={dismissing}
        style={{
          flex: '0 0 auto',
          width: 30, height: 30, borderRadius: '50%',
          background: 'transparent', border: '1px solid color-mix(in srgb, var(--accent) 30%, transparent)',
          color: 'var(--accent)', cursor: dismissing ? 'wait' : 'pointer',
          display: 'grid', placeItems: 'center',
        }}
      >
        <XIcon width="14" height="14" />
      </button>
    </div>
  );
}
