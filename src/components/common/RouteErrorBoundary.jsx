import React from 'react';
import { logAppEvent } from '../../lib/appEvents';
import { supabase } from '../../lib/supabase';

/**
 * Catches render errors inside the AppShell's route outlet so a
 * single bug on one page doesn't leave the user staring at a totally
 * blank screen. Logs the error to app_events so we can correlate
 * "blank page" reports with the actual stack trace later.
 *
 * Resets when the user navigates (pathname changes) — so a transient
 * error on /tasks doesn't keep /reports broken too.
 */
export default class RouteErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    // Best-effort: log to the diagnostic table so we can see what
    // exploded. The user_id comes from the global supabase client's
    // current session — we don't import useAuth here because class
    // components + hooks don't mix; we read it lazily.
    try {
      supabase.auth.getUser().then(({ data }) => {
        const uid = data?.user?.id;
        if (!uid) return;
        logAppEvent(uid, 'route.error_boundary', {
          message: String(error?.message || error).slice(0, 500),
          stack: String(error?.stack || '').slice(0, 1500),
          componentStack: String(info?.componentStack || '').slice(0, 1500),
        });
      }).catch(() => {});
    } catch { /* never let the logger crash the boundary */ }
  }

  componentDidUpdate(prevProps) {
    // Reset on route change so the user isn't stuck on the error
    // screen after navigating away.
    if (this.state.error && prevProps.routeKey !== this.props.routeKey) {
      this.setState({ error: null });
    }
  }

  render() {
    if (this.state.error) {
      return (
        <div style={{
          padding: 24,
          maxWidth: 560,
          margin: '40px auto',
          background: 'var(--surface-1)',
          border: '1px solid var(--border-subtle)',
          borderRadius: 12,
          textAlign: 'center',
        }}>
          <i className="bi bi-exclamation-triangle-fill"
            style={{ fontSize: 32, color: 'var(--warning, #fb923c)' }} />
          <h5 style={{ margin: '12px 0 6px', color: 'var(--text-primary)' }}>
            Something went wrong on this page
          </h5>
          <p style={{ color: 'var(--text-muted)', fontSize: 13, margin: '0 0 16px' }}>
            We've logged the error so we can fix it. Try switching to another
            page or reloading.
          </p>
          <details style={{ textAlign: 'left', fontSize: 11, color: 'var(--text-muted)' }}>
            <summary style={{ cursor: 'pointer' }}>Technical details</summary>
            <pre style={{
              marginTop: 8, padding: 10, borderRadius: 8,
              background: 'var(--surface-2)', whiteSpace: 'pre-wrap',
              wordBreak: 'break-word', maxHeight: 200, overflow: 'auto',
            }}>{String(this.state.error?.message || this.state.error)}</pre>
          </details>
          <div style={{ marginTop: 16, display: 'flex', gap: 8, justifyContent: 'center' }}>
            <button
              type="button"
              className="wx-btn wx-btn-primary"
              onClick={() => { this.setState({ error: null }); }}
            >
              Try again
            </button>
            <button
              type="button"
              className="wx-btn wx-btn-secondary"
              onClick={() => window.location.reload()}
            >
              Reload page
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
