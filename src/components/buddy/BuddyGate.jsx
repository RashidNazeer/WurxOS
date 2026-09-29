import { Navigate } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext';
import { useBuddy } from '../../contexts/BuddyContext';

// Route guard for /buddy: the roles in ai_assistant_config.allowed_roles (read
// by BuddyProvider). Like RoleGuard, an unauthorised role goes to /dashboard.
// While the profile or the config is still loading, show a spinner rather
// than redirecting, so an auth blip doesn't throw the user off the page.
export default function BuddyGate({ children }) {
  const { profile, loading } = useAuth();
  const buddy = useBuddy();
  if (loading || !profile?.role || !buddy?.gateReady) {
    return (
      <div style={{ display: 'grid', placeItems: 'center', minHeight: '40vh', color: 'var(--text-muted)' }}>
        <span className="wx-spinner" style={{ color: 'var(--accent)' }} />
      </div>
    );
  }
  if (!buddy.allowed) return <Navigate to="/dashboard" replace />;
  return children;
}
