import React from 'react';
import { logAppEvent } from '../../lib/appEvents';
import { supabase } from '../../lib/supabase';
import { requestAppReload } from '../../lib/appUpdate';
import ChunkReloadNotice from './ChunkReloadNotice';

/**
 * Catches React render errors inside the AppShell's route outlet.
 * On an error we surface a friendly "Sorry — please DM Mr Rashid"
 * card (matching the global ErrorReporterContext modal) AND log the
 * full stack to app_events for later forensics.
 *
 * Exception: stale-deploy errors (asset filenames that no longer
 * exist after a redeploy) are routed through the app-update
 * coordinator — it reloads only when the user has no unsaved work,
 * otherwise it shows the update banner and we render a calm refresh
 * notice. They're transient state, not a real bug.
 */
const STALE_DEPLOY_RE = /Unable to preload CSS|Failed to fetch dynamically imported module|Importing a module script failed|ChunkLoadError|Loading chunk \d+ failed|error loading dynamically imported module/i;
function isStaleDeploy(err) {
  return STALE_DEPLOY_RE.test(String(err?.message || err || ''));
}

export default class RouteErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null, copied: false, userName: '', userFirst: '' };
  }

  static getDerivedStateFromError(error) {
    if (isStaleDeploy(error)) {
      // Coordinator reloads if safe; otherwise we render the notice.
      return requestAppReload('route-error') ? null : { staleDeploy: true };
    }
    return { error };
  }

  componentDidCatch(error, info) {
    // Stale-deploy errors are transient, not bugs — don't log them.
    if (isStaleDeploy(error)) return;
    try {
      supabase.auth.getUser().then(async ({ data }) => {
        const uid = data?.user?.id;
        if (!uid) return;
        logAppEvent(uid, 'route.error_boundary', {
          message: String(error?.message || error).slice(0, 500),
          stack: String(error?.stack || '').slice(0, 1500),
          componentStack: String(info?.componentStack || '').slice(0, 1500),
          route: typeof window !== 'undefined' ? window.location.pathname : null,
        });
        // Fetch display name so we can personalize the modal.
        try {
          const { data: p } = await supabase
            .from('profiles').select('display_name')
            .eq('id', uid).maybeSingle();
          if (p?.display_name) {
            const first = String(p.display_name).split(' ')[0] || '';
            this.setState({ userName: p.display_name, userFirst: first });
          }
        } catch { /* noop */ }
      }).catch(() => {});
    } catch { /* never let the logger crash the boundary */ }
  }

  componentDidUpdate(prevProps) {
    if ((this.state.error || this.state.staleDeploy) && prevProps.routeKey !== this.props.routeKey) {
      this.setState({ error: null, staleDeploy: false, copied: false });
    }
  }

  buildDetailsText() {
    const e = this.state.error;
    const lines = [
      `User: ${this.state.userName || 'Unknown'}`,
      `Time: ${new Date().toISOString()}`,
      `Page: ${typeof window !== 'undefined' ? window.location.pathname : '?'}`,
      `Source: route.error_boundary`,
      `Message: ${String(e?.message || e)}`,
    ];
    if (e?.stack) lines.push(`\nStack:\n${e.stack}`);
    return lines.join('\n');
  }

  handleCopy = async () => {
    const text = this.buildDetailsText();
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const ta = document.querySelector('#wurxos-boundary-details');
      if (ta) { ta.select(); document.execCommand('copy'); }
    }
    this.setState({ copied: true });
    setTimeout(() => this.setState({ copied: false }), 1800);
  };

  render() {
    // Stale deploy + unsaved work → calm refresh notice, not the
    // crash modal and not an auto-reload.
    if (this.state.staleDeploy) return <ChunkReloadNotice />;
    if (!this.state.error) return this.props.children;
    const { error, copied, userFirst } = this.state;
    const detailsText = this.buildDetailsText();
    const firstName = userFirst || 'there';

    return (
      <div style={{
        margin: '32px auto', maxWidth: 520, padding: 0,
        background: 'var(--surface-1, #fff)',
        color: 'var(--text-primary, #0f172a)',
        border: '1px solid var(--border-subtle, #e5e7eb)',
        borderRadius: 16,
        boxShadow: '0 20px 40px rgba(15, 23, 42, 0.18)',
        overflow: 'hidden',
      }}>
        <div style={{
          background: 'linear-gradient(135deg, #fb923c, #ef4444)',
          padding: '14px 18px', color: '#fff',
          display: 'flex', alignItems: 'center', gap: 10,
        }}>
          <div style={{
            width: 32, height: 32, borderRadius: '50%',
            background: 'rgba(255,255,255,0.22)',
            display: 'grid', placeItems: 'center', fontSize: 16,
          }}>
            <i className="bi bi-exclamation-triangle-fill" />
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontWeight: 700, fontSize: 15 }}>Hey {firstName} — sorry about that!</div>
            <div style={{ fontSize: 12, opacity: 0.92 }}>This page crashed. Help us fix it 👇</div>
          </div>
        </div>
        <div style={{ padding: 18 }}>
          <p style={{ margin: '0 0 12px', fontSize: 13.5, lineHeight: 1.55 }}>
            Please DM these details to the developer{' '}
            <strong>Mr Rashid</strong> on Discord so it can be fixed quickly.
          </p>
          <div style={{
            background: 'var(--surface-2, #f9fafb)',
            border: '1px solid var(--border-subtle, #e5e7eb)',
            borderRadius: 10, padding: 10, fontSize: 12, marginBottom: 12,
            maxHeight: 180, overflow: 'auto',
          }}>
            <div style={{ fontWeight: 700, color: 'var(--danger, #b91c1c)' }}>
              {String(error?.message || error)}
            </div>
          </div>
          <textarea
            id="wurxos-boundary-details"
            readOnly value={detailsText}
            style={{
              width: '100%', minHeight: 80, maxHeight: 140,
              fontSize: 11,
              fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
              padding: 8, borderRadius: 8,
              border: '1px solid var(--border-subtle, #e5e7eb)',
              background: 'var(--surface-2, #f9fafb)',
              color: 'var(--text-primary, #0f172a)',
              resize: 'vertical', marginBottom: 14,
            }}
          />
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button
              type="button"
              onClick={this.handleCopy}
              style={{
                flex: 1, minWidth: 140,
                background: copied ? '#16a34a' : 'var(--accent, #2563eb)',
                color: '#fff', border: 'none',
                padding: '10px 14px', borderRadius: 10,
                fontWeight: 600, fontSize: 13, cursor: 'pointer',
                display: 'inline-flex', alignItems: 'center', gap: 8,
                justifyContent: 'center', transition: 'background 0.15s',
              }}>
              <i className={`bi ${copied ? 'bi-check-circle-fill' : 'bi-clipboard'}`} />
              {copied ? 'Copied!' : 'Copy details'}
            </button>
            <button
              type="button"
              onClick={() => this.setState({ error: null, copied: false })}
              style={{
                background: 'var(--surface-2, #f3f4f6)',
                color: 'var(--text-primary, #0f172a)',
                border: '1px solid var(--border-subtle, #e5e7eb)',
                padding: '10px 14px', borderRadius: 10,
                fontWeight: 600, fontSize: 13, cursor: 'pointer',
              }}>
              Try again
            </button>
            <button
              type="button"
              onClick={() => window.location.reload()}
              style={{
                background: 'var(--surface-2, #f3f4f6)',
                color: 'var(--text-primary, #0f172a)',
                border: '1px solid var(--border-subtle, #e5e7eb)',
                padding: '10px 14px', borderRadius: 10,
                fontWeight: 600, fontSize: 13, cursor: 'pointer',
              }}>
              Reload
            </button>
          </div>
        </div>
      </div>
    );
  }
}
