import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { supabase } from '../../lib/supabase';
import { useAuth } from '../../contexts/AuthContext';

// Consent screen for "Connect WurxOS to Claude". The sign-in layer is our own (edge function `mcp`,
// migration 436): Claude's browser lands on /oauth/authorize, which sends the person here with ?request=…;
// they approve or deny and the browser goes back to Claude. The connector is read-only, only the Boss and
// OLs may use it, and its tokens work nowhere but the connector (they are not Supabase sessions).

// Same rule as the `mcp` function (supabase/functions/_shared/mcp/access.ts), which is the real gate:
// it refuses every other role on every request. This only spares them a confusing Allow button.
const CONNECTOR_ROLES = ['boss', 'ol'];
// Defence in depth: whatever the server returns, the browser only ever goes back to Claude's own callback.
const CLAUDE_CALLBACKS = ['https://claude.ai/api/mcp/auth_callback', 'https://claude.com/api/mcp/auth_callback'];
export const isClaudeCallback = (url) => {
  try { const u = new URL(String(url)); return u.protocol === 'https:' && !u.username && !u.password && CLAUDE_CALLBACKS.includes(`${u.origin}${u.pathname}`); } catch { return false; }
};

const wrap = { minHeight: '100vh', display: 'grid', placeItems: 'center', padding: 24, background: 'var(--surface-0)' };
const card = {
  width: '100%', maxWidth: 480, background: 'var(--surface-1)', border: '1px solid var(--border-subtle)',
  borderRadius: 'var(--radius-lg)', padding: 28,
};

async function decide(request, decision) {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session?.access_token) throw new Error('Please sign in again.');
  const res = await fetch('/oauth/decision', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.access_token}` },
    body: JSON.stringify({ request, decision }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error_description || 'This request is no longer valid. Start again from Claude.');
  return body;
}

export default function ConnectorConsentPage() {
  const [params] = useSearchParams();
  const { profile, loading } = useAuth();
  const allowed = profile?.is_active === true && CONNECTOR_ROLES.includes(profile?.role);
  const request = params.get('request') || '';
  const [info, setInfo] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (loading || !allowed) return undefined;
    if (!request) { setError('This page was opened without a connection request. Start from Claude.'); return undefined; }
    let live = true;
    decide(request, 'info').then((d) => { if (live) setInfo(d); }).catch((e) => { if (live) setError(e.message); });
    return () => { live = false; };
  }, [request, loading, allowed]);

  async function answer(decision) {
    if (!allowed || busy) return;
    setBusy(true);
    try {
      const d = await decide(request, decision);
      if (!isClaudeCallback(d.redirect_url)) throw new Error('Unexpected response. Nothing was connected.');
      window.location.assign(d.redirect_url);
    } catch (e) { setBusy(false); setError(e.message); }
  }

  const fromClaude = info && ['claude.ai', 'claude.com'].includes(info.redirect_host);
  return (
    <div style={wrap}>
      <div style={card}>
        <h1 style={{ fontSize: 20, margin: '0 0 8px', color: 'var(--text-primary)' }}>Connect WurxOS to Claude</h1>
        {error ? (
          <p style={{ color: 'var(--danger)', fontSize: 14 }}>{error}</p>
        ) : !info ? (
          <p style={{ color: 'var(--text-muted)', fontSize: 14 }}>Loading…</p>
        ) : !fromClaude ? (
          <p style={{ color: 'var(--danger)', fontSize: 14 }}>This request does not come from Claude. Do not approve it.</p>
        ) : (
          <>
            <p style={{ color: 'var(--text-secondary)', fontSize: 14, lineHeight: 1.5 }}>
              <strong>Claude</strong> is asking to read WurxOS data as <strong>{info.email || 'you'}</strong>.
            </p>
            <ul style={{ color: 'var(--text-secondary)', fontSize: 14, lineHeight: 1.6, paddingLeft: 20 }}>
              <li>Read-only: Claude cannot change anything in WurxOS.</li>
              <li>It only sees what your own WurxOS account can see.</li>
              <li>Every question it asks WurxOS is logged for the Boss, and the Boss can disconnect it at any time.</li>
            </ul>
            <p style={{ color: 'var(--text-secondary)', fontSize: 13, lineHeight: 1.5 }}>
              Only approve if you just pressed Connect in your own Claude. If someone sent you this link, press Deny.
            </p>
            <div style={{ display: 'flex', gap: 10, marginTop: 20 }}>
              <button type="button" className="btn btn-primary" disabled={busy} onClick={() => answer('allow')}>Allow</button>
              <button type="button" className="btn btn-secondary" disabled={busy} onClick={() => answer('deny')}>Deny</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
