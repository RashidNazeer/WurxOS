import { useAuth } from '../../contexts/AuthContext';
import BiWeeklyReportsPage from './BiWeeklyReportsPage';
import AllBiWeeklyReportsPage from './AllBiWeeklyReportsPage';

/**
 * Single /biweekly-reports entry point.
 *   boss / ol / developer → AllBiWeeklyReportsPage  (All view)
 *   everyone else         → BiWeeklyReportsPage     (my-brand view)
 */
export default function BiWeeklyReportsRouter() {
  const { profile } = useAuth();
  const role = profile?.role || '';
  if (role === 'boss' || role === 'ol' || role === 'developer') return <AllBiWeeklyReportsPage />;
  return <BiWeeklyReportsPage />;
}
