import { Suspense } from 'react';
import { lazyWithRetry as lazy } from '../../../lib/lazyWithRetry';
import { useAuth } from '../../../contexts/AuthContext';
import { BUDDY_TABS, buddyTab, canEditSettings } from '../../../lib/buddyLogic';
import '../../../styles/buddy.css';

// Settings › Wurx Buddy › <tab>. The Boss and active developers only; the
// registry in SettingsPage hides it from everyone else. Its own chunk, so the
// Settings page stays light for the rest of the team. The tabs live in the
// Settings nav; on phones (single-column Settings) they also show here as pills.
const BuddySettings = lazy(() => import('../../buddy/BuddySettings'));

export default function BuddySection({ tab, onTab }) {
  const { profile } = useAuth();
  const current = buddyTab(tab);
  return (
    <>
      <div className="bd-subtabs" role="tablist" aria-label="Wurx Buddy settings">
        {BUDDY_TABS.map(([id, label]) => (
          <button key={id} type="button" role="tab" aria-selected={current === id}
            className={`bd-pill ${current === id ? 'is-on' : ''}`} onClick={() => onTab?.(id)}>{label}</button>
        ))}
      </div>
      <Suspense fallback={<div style={{ display: 'grid', placeItems: 'center', minHeight: 160 }}><span className="wx-spinner" style={{ color: 'var(--accent)' }} /></div>}>
        <BuddySettings canEdit={canEditSettings(profile)} tab={current} />
      </Suspense>
    </>
  );
}
