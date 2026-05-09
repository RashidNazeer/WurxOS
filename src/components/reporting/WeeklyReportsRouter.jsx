import { useAuth } from '../../contexts/AuthContext';
import WeeklyReportsPage from './WeeklyReportsPage';
import AllWeeklyReportsPage from './AllWeeklyReportsPage';

/**
 * Single /weekly-reports entry point. v1 used separate routes per role
 * (boss/ol got the "All" listing, tl/pctl/apc/ipc got the my-brand
 * listing). v2 collapses them into one URL with a role-based router.
 */
export default function WeeklyReportsRouter() {
  const { profile } = useAuth();
  const role = profile?.role || '';
  if (role === 'boss' || role === 'ol' || role === 'developer') return <AllWeeklyReportsPage />;
  return <WeeklyReportsPage />;
}
