import { useAuth } from '../../contexts/AuthContext';
import MonthlyReportsPage from './MonthlyReportsPage';
import AllMonthlyReportsPage from './AllMonthlyReportsPage';

/**
 * Single /monthly-reports entry point.
 *   boss / ol / developer → AllMonthlyReportsPage  (All view)
 *   everyone else         → MonthlyReportsPage     (my-brand view)
 */
export default function MonthlyReportsRouter() {
  const { profile } = useAuth();
  const role = profile?.role || '';
  if (role === 'boss' || role === 'ol' || role === 'developer') return <AllMonthlyReportsPage />;
  return <MonthlyReportsPage />;
}
