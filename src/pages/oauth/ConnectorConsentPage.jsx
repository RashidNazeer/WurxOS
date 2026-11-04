import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { supabase } from '../../lib/supabase';
import { useAuth } from '../../contexts/AuthContext';

// Same rule as the `mcp` function (supabase/functions/_shared/mcp/access.ts), which is the real gate:
// it refuses every other role on every request. This only spares them a confusing Allow button.
const CONNECTOR_ROLES = ['boss', 'ol'];

// Consent screen for "Connect WurxOS to Claude". Supabase Auth's OAuth server sends the person here
// (Authentication → OAuth Server → Authorization Path = /oauth/consent) with ?authorization_id=…;
// they approve or deny and the browser is sent back to Claude. The connector itself is the `mcp`
// edge function: read-only, and every answer is limited to what that person can already see.

const wrap = { minHeight: '100vh', display: 'grid', placeItems: 'center', padding: 24, background: 'var(--surface-0)' };
const card = {
  width: '100%', maxWidth: 480, background: 'var(--surface-1)', border: '1px solid var(--border-subtle)',
  borderRadius: 'var(--radius-lg)', padding: 28,
};

export default function ConnectorConsentPage() {
  const [params] = useSearchParams();
  const { profile, loading } = useAuth();
  const allowed = CONNECTOR_ROLES.includes(String(profile?.role || '').toLowerCase());
  const authorizationId = params.get('authorization_id') || '';
  const [details, setDetails] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (loading || !allowed) return undefined;
    if (!authorizationId) { setError('This page was opened without an authorization request. Start the connection from Claude.'); return; }
    let live = true;
    supabase.auth.oauth.getAuthorizationDetails(authorizationId).then(({ data, error: e }) => {
      if (!live) return;
      if (e || !data) { setError(e?.message || 'This authorization request has expired. Start again from Claude.'); return; }
      // Already decided: go straight back.
      if (data.redirect_url && !data.client) { window.location.assign(data.redirect_url); return; }
      setDetails(data);
    });
    return () => { live = false; };
  }, [authorizationId, loading, allowed]);

  async function decide(approve) {
    if (!allowed) return;
    setBusy(true);
    const call = approve ? supabase.auth.oauth.approveAuthorization : supabase.auth.oauth.denyAuthorization;
    const { data, error: e } = await call.call(supabase.auth.oauth, authorizationId);
    if (e || !data?.redirect_url) { setBusy(false); setError(e?.message || 'Could not complete the request. Start again from Claude.'); return; }
    window.location.assign(data.redirect_url);
  }

  return (
    <div style={wrap}>
      <div style={card}>
        <h1 style={{ fontSize: 20, margin: '0 0 8px', color: 'var(--text-primary)' }}>Connect WurxOS to Claude</h1>
        {loading ? (
          <p style={{ color: 'var(--text-muted)', fontSize: 14 }}>Loading…</p>
        ) : !allowed ? (
          <p style={{ color: 'var(--danger)', fontSize: 14 }}>
            The Claude connector is only available to the Boss and Operations Leads. Your account can't connect it.
          </p>
        ) : error ? (
          <p style={{ color: 'var(--danger)', fontSize: 14 }}>{error}</p>
        ) : !details ? (
          <p style={{ color: 'var(--text-muted)', fontSize: 14 }}>Loading…</p>
        ) : (
          <>
            <p style={{ color: 'var(--text-secondary)', fontSize: 14, lineHeight: 1.5 }}>
              <strong>{details.client?.name || 'Claude'}</strong> is asking to read WurxOS data as you.
            </p>
            <ul style={{ color: 'var(--text-secondary)', fontSize: 14, lineHeight: 1.6, paddingLeft: 20 }}>
              <li>Read-only: Claude cannot change anything in WurxOS.</li>
              <li>It only sees what your own account can see.</li>
              <li>Every question it asks WurxOS is logged for the Boss.</li>
            </ul>
            <div style={{ display: 'flex', gap: 10, marginTop: 20 }}>
              <button type="button" className="btn btn-primary" disabled={busy} onClick={() => decide(true)}>Allow</button>
              <button type="button" className="btn btn-secondary" disabled={busy} onClick={() => decide(false)}>Deny</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
