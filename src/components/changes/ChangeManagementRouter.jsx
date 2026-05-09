import { useAuth } from '../../contexts/AuthContext';
import ChangeManagementPage from './ChangeManagementPage';
import BossChangeManagementPage from './BossChangeManagementPage';

/**
 * Single /changes entry point.
 *   boss  → BossChangeManagementPage (review queue + change log)
 *   else  → ChangeManagementPage (submitter / owner view)
 *
 * Mirrors the v1 split (boss/BossChangeManagementPage.js vs
 * changes/ChangeManagementPage.js).
 */
export default function ChangeManagementRouter() {
  const { profile } = useAuth();
  const role = profile?.role || '';
  if (role === 'boss') return <BossChangeManagementPage />;
  return <ChangeManagementPage />;
}
