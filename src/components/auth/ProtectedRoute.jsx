import { useEffect, useState } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext';
import { hasUnsavedWork } from '../../lib/appUpdate';

// When session disappears AND a dirty form is mounted, ride out a
// short grace window before redirecting to /login. Without this, a
// transient Supabase SIGNED_OUT event (multi-tab signout, refresh-
// token flutter, BroadcastChannel sync) instantly unmounted the
// entire AppShell — taking the report editor with it. The window
// is bounded; if the session is really gone we still redirect.
const DIRTY_GRACE_MS = 2000;

export default function ProtectedRoute({ children }) {
  const { session, loading } = useAuth();
  const location = useLocation();
  const [graceExpired, setGraceExpired] = useState(false);

  useEffect(() => {
    if (session) {
      setGraceExpired(false);
      return undefined;
    }
    if (!hasUnsavedWork()) {
      setGraceExpired(true);
      return undefined;
    }
    const t = setTimeout(() => setGraceExpired(true), DIRTY_GRACE_MS);
    return () => clearTimeout(t);
  }, [session]);

  if (loading) {
    return (
      <div style={{
        minHeight: '100vh',
        display: 'grid',
        placeItems: 'center',
        background: 'var(--surface-0)',
        color: 'var(--text-muted)',
        fontSize: 14,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span className="wx-spinner" style={{ color: 'var(--accent)' }} />
          Loading…
        </div>
      </div>
    );
  }

  if (!session) {
    if (!graceExpired) return children; // ride out the flutter
    return <Navigate to="/login" replace state={{ from: location }} />;
  }

  return children;
}
