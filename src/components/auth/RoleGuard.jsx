import { useEffect, useState } from 'react';
import { Navigate } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext';
import { hasUnsavedWork } from '../../lib/appUpdate';

// How long we tolerate a transient profile=null before redirecting,
// but only when an active editor is dirty. Without this, a Supabase
// auth flutter (multi-tab signout, refresh-token blip) instantly
// nulled profile -> Navigate to /login -> editor unmounted -> work
// lost. 2 seconds is enough for any legitimate auth flutter to
// resolve and far below the threshold where stale UI becomes a
// security concern (the access token is the real authority).
const DIRTY_GRACE_MS = 2000;

// Silent redirect for unauthorized roles. Rendering an "Access denied"
// card would confirm the route exists to a user poking around; sending
// them to /dashboard makes the URL indistinguishable from any unknown
// path (which the router's `*` fallback also redirects to /dashboard).
// Real protection lives at the API / RLS layer — this just removes the
// client-side enumeration signal.
export default function RoleGuard({ allow, children }) {
  const { profile, loading } = useAuth();
  const role = profile?.role;
  const [graceExpired, setGraceExpired] = useState(false);

  // When role disappears AND a dirty form is mounted, hold the current
  // tree for a brief grace window before redirecting. Lets the editor
  // ride out a transient profile=null without unmounting.
  useEffect(() => {
    if (role) {
      setGraceExpired(false);
      return undefined;
    }
    if (!hasUnsavedWork()) {
      // No work to protect — redirect immediately (preserves the
      // pre-fix behavior for users not in the middle of editing).
      setGraceExpired(true);
      return undefined;
    }
    const t = setTimeout(() => setGraceExpired(true), DIRTY_GRACE_MS);
    return () => clearTimeout(t);
  }, [role]);

  if (loading) return null;

  if (!role) {
    if (!graceExpired) return children; // ride out the flutter
    return <Navigate to="/login" replace />;
  }

  const allowed = Array.isArray(allow) ? allow.includes(role) : allow === role;
  if (!allowed) return <Navigate to="/dashboard" replace />;

  return children;
}
