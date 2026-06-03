import { useAuth } from '../../contexts/AuthContext';
import BossLeaveRequestsPage from './BossLeaveRequestsPage';
import LeaveRequestPage from './LeaveRequestPage';

/**
 * Single leave entry point. Per-role split:
 *   boss             → BossLeaveRequestsPage  (review + approve queue, CSV, unpaid summary)
 *   ol / tl / pctl   → LeaveRequestPage       (My + Team tabs)
 *   apc / ipc        → LeaveRequestPage       (My only)
 *   developer        → LeaveRequestPage       (My only — standalone employee reporting
 *                                              directly to Boss, who approves)
 *
 * Both /leave and /leave/approvals land here so the v1 single-page UX
 * is preserved regardless of which menu link the user clicked.
 *
 * Note 2026-06-03: developer was previously routed to the Boss page,
 * which meant the developer had NO way to submit their own leave
 * requests. They're a regular employee like APC for leave purposes;
 * the only role-specific bit is the approval chain — Boss is their
 * direct approver, no intermediate TL/OL. leave_current_approver
 * (mig 055) handles that automatically by walking profiles.reports_to.
 */
export default function LeaveRouter() {
  const { profile } = useAuth();
  const role = profile?.role || '';
  if (role === 'boss') return <BossLeaveRequestsPage />;
  return <LeaveRequestPage />;
}
