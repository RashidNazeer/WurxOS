import { Suspense } from 'react';
import { lazyWithRetry as lazy } from '../../../lib/lazyWithRetry';
import { useAuth } from '../../../contexts/AuthContext';
import { canEditSettings } from '../../../lib/buddyLogic';
import '../../../styles/buddy.css';

// Settings › Wurx Buddy: the Buddy settings screen (models, usage, ingestion,
// who can use Buddy, …). The Boss and active developers only; the registry in
// SettingsPage hides it from everyone else. Its own chunk, so the Settings
// page stays light for the rest of the team.
const BuddySettings = lazy(() => import('../../buddy/BuddySettings'));

export default function BuddySection() {
  const { profile } = useAuth();
  return (
    <Suspense fallback={<div style={{ display: 'grid', placeItems: 'center', minHeight: 160 }}><span className="wx-spinner" style={{ color: 'var(--accent)' }} /></div>}>
      <BuddySettings canEdit={canEditSettings(profile)} />
    </Suspense>
  );
}
