import { useAuth } from '../../contexts/AuthContext';
import BossIncentivesPage from './BossIncentivesPage';
import OLIncentivesPage from './OLIncentivesPage';
import MyIncentivesPage from './MyIncentivesPage';
import ApcIncentivesPage from './ApcIncentivesPage';

/**
 * Single /incentives entry point that hands off to the correct
 * v1-shaped page per role:
 *   boss / developer → BossIncentivesPage
 *   ol               → OLIncentivesPage
 *   tl / pctl        → MyIncentivesPage
 *   ads_manager      → MyIncentivesPage (own plan only; an OL builds it)
 *   apc / ipc        → ApcIncentivesPage
 *
 * Mirrors v1's separate role routes (boss/incentives, ol/incentives,
 * apc/incentives, /incentives) inside one URL so v2 keeps a single
 * menu entry while still rendering the role-specific UI.
 */
export default function IncentivesRouter() {
  const { profile } = useAuth();
  const role = profile?.role || '';
  if (role === 'boss' || role === 'developer') return <BossIncentivesPage />;
  if (role === 'ol')                          return <OLIncentivesPage />;
  if (role === 'tl' || role === 'pctl' || role === 'ads_manager') return <MyIncentivesPage />;
  return <ApcIncentivesPage />;
}
