import { Navigate } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext';

// Silent redirect for unauthorized roles. Rendering an "Access denied"
// card would confirm the route exists to a user poking around; sending
// them to /dashboard makes the URL indistinguishable from any unknown
// path (which the router's `*` fallback also redirects to /dashboard).
// Real protection lives at the API / RLS layer — this just removes the
// client-side enumeration signal.
export default function RoleGuard({ allow, children }) {
  const { profile, loading } = useAuth();
  if (loading) return null;
  const role = profile?.role;
  if (!role) return <Navigate to="/login" replace />;

  const allowed = Array.isArray(allow) ? allow.includes(role) : allow === role;
  if (!allowed) return <Navigate to="/dashboard" replace />;

  return children;
}
