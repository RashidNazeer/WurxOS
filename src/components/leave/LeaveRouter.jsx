import { useAuth } from '../../contexts/AuthContext';
import BossLeaveRequestsPage from './BossLeaveRequestsPage';
import LeaveRequestPage from './LeaveRequestPage';

/**
 * Single leave entry point. v1 had a per-role split:
 *   boss / developer → BossLeaveRequestsPage  (review + approve queue, CSV, unpaid summary)
 *   ol / tl / pctl   → LeaveRequestPage       (My + Team tabs)
 *   apc / ipc        → LeaveRequestPage       (My only)
 *
 * This router preserves that split. Both /leave and /leave/approvals
 * land here so the v1 single-page UX is preserved regardless of which
 * menu link the user clicked.
 */
export default function LeaveRouter() {
  const { profile } = useAuth();
  const role = profile?.role || '';
  if (role === 'boss' || role === 'developer') return <BossLeaveRequestsPage />;
  return <LeaveRequestPage />;
}
