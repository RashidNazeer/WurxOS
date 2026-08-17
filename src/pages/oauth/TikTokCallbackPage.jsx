import { useEffect, useRef, useState } from 'react';
import { useSearchParams, Link } from 'react-router-dom';
import { completeTikTokAuth } from '../../lib/tiktokAdsApi';
import { CheckIcon, AlertIcon, TiktokIcon } from '../../components/common/Icon';

// Landing page for TikTok's OAuth redirect:
//   /oauth/tiktok/callback?auth_code=…&state=…
//
// PUBLIC on purpose. The person approving the authorization is an advertiser,
// and they may not have a WurxOS session — a client authorising their own ad
// account never will. What makes this safe is the single-use `state` nonce the
// server minted before we sent them to TikTok; the server refuses anything
// else. See supabase/functions/tiktok-oauth/index.ts.
//
// The page itself does no exchange. It hands the code straight to the edge
// function, because the app secret required to complete the trade must never
// exist in a browser bundle.

const wrap = {
  minHeight: '100vh', display: 'grid', placeItems: 'center',
  padding: 24, background: 'var(--surface-2, #f6f7f9)',
};
const card = {
  width: '100%', maxWidth: 520, background: 'var(--surface-1, #fff)',
  border: '1px solid var(--border-subtle, #e4e7ec)',
  borderRadius: 'var(--radius-lg, 14px)', padding: 28,
  boxShadow: '0 8px 28px rgba(16,24,40,0.08)',
};

export default function TikTokCallbackPage() {
  const [params] = useSearchParams();
  const [phase, setPhase] = useState('working'); // working | done | error
  const [result, setResult] = useState(null);
  const [error, setError] = useState('');
  const ran = useRef(false);

  const authCode = params.get('auth_code') || params.get('code') || '';
  const state = params.get('state') || '';
  const denied = params.get('error') || '';

  useEffect(() => {
    // The auth code is single-use. React StrictMode double-invokes effects in
    // dev, and a second POST would spend an already-burned nonce and show a
    // spurious failure — so this runs exactly once per mount.
    if (ran.current) return;
    ran.current = true;

    if (denied) {
      setError(params.get('error_description') || `TikTok returned: ${denied}`);
      setPhase('error');
      return;
    }
    if (!authCode || !state) {
      setError('This page was opened without an authorization code. Start the connection from Settings in WurxOS.');
      setPhase('error');
      return;
    }

    completeTikTokAuth({ authCode, state })
      .then((res) => { setResult(res); setPhase('done'); })
      .catch((e) => { setError(e.message || 'Could not complete the connection.'); setPhase('error'); });
  }, [authCode, state, denied, params]);

  const accounts = result?.accounts || [];

  return (
    <div style={wrap}>
      <div style={card}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 18 }}>
          <div style={{
            width: 40, height: 40, borderRadius: 10, display: 'grid', placeItems: 'center',
            background: phase === 'error' ? 'var(--danger-soft, #fee4e2)' : 'var(--surface-2, #f2f4f7)',
            color: phase === 'error' ? 'var(--danger, #d92d20)' : 'var(--text-primary, #1f2430)',
            flex: '0 0 auto',
          }}>
            {phase === 'error' ? <AlertIcon width="20" height="20" /> : <TiktokIcon width="20" height="20" />}
          </div>
          <div>
            <div style={{ fontWeight: 700, fontSize: 17, color: 'var(--text-primary, #1f2430)' }}>
              {phase === 'working' && 'Connecting your TikTok Ads account'}
              {phase === 'done' && 'TikTok Ads account connected'}
              {phase === 'error' && 'We could not finish the connection'}
            </div>
            <div style={{ fontSize: 13, color: 'var(--text-muted, #667085)' }}>
              Wurx Ads Reporting
            </div>
          </div>
        </div>

        {phase === 'working' && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, fontSize: 14, color: 'var(--text-secondary, #475467)' }}>
            <span className="wx-spinner" style={{ width: 20, height: 20 }} />
            <span>Verifying the authorization with TikTok. This takes a few seconds.</span>
          </div>
        )}

        {phase === 'done' && (
          <>
            <div style={{
              display: 'flex', alignItems: 'flex-start', gap: 10, padding: 12, marginBottom: 14,
              borderRadius: 10, background: 'var(--success-soft, #ecfdf3)', color: 'var(--success, #027a48)',
              fontSize: 13.5, lineHeight: 1.5,
            }}>
              <CheckIcon width="18" height="18" style={{ flex: '0 0 auto', marginTop: 1 }} />
              <span>
                Authorization complete. You can close this tab, and reporting can now read
                this account&apos;s ad data.
              </span>
            </div>

            <div style={{ fontSize: 12.5, fontWeight: 700, textTransform: 'uppercase',
                          letterSpacing: 0.4, color: 'var(--text-muted, #667085)', marginBottom: 8 }}>
              Accounts connected ({accounts.length})
            </div>

            {accounts.length === 0 ? (
              <div style={{ fontSize: 13.5, color: 'var(--warning, #b54708)', lineHeight: 1.55 }}>
                {result?.noteIfNoAccounts
                  || 'TikTok did not return any ad accounts for this authorization.'}
              </div>
            ) : (
              <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: 6 }}>
                {accounts.map((a) => (
                  <li key={a.advertiserId} style={{
                    display: 'flex', justifyContent: 'space-between', gap: 12, padding: '9px 12px',
                    border: '1px solid var(--border-subtle, #e4e7ec)', borderRadius: 8,
                    fontSize: 13.5, color: 'var(--text-primary, #1f2430)',
                  }}>
                    <span style={{ fontWeight: 600 }}>{a.name || 'Unnamed ad account'}</span>
                    <span style={{ color: 'var(--text-muted, #667085)', fontVariantNumeric: 'tabular-nums' }}>
                      {a.advertiserId}
                    </span>
                  </li>
                ))}
              </ul>
            )}

            <div style={{ marginTop: 16, fontSize: 13, color: 'var(--text-secondary, #475467)', lineHeight: 1.55 }}>
              Next: in WurxOS, open <strong>Settings &rarr; TikTok Ads</strong> and match each
              account to the brand it belongs to.
            </div>
          </>
        )}

        {phase === 'error' && (
          <>
            <div style={{
              padding: 12, borderRadius: 10, background: 'var(--danger-soft, #fee4e2)',
              color: 'var(--danger, #b42318)', fontSize: 13.5, lineHeight: 1.55, marginBottom: 14,
            }}>
              {error}
            </div>
            <div style={{ fontSize: 13, color: 'var(--text-secondary, #475467)', lineHeight: 1.6 }}>
              Nothing was saved, and your TikTok account was not changed. Authorization links
              can only be used once and expire after 15 minutes, so the safest fix is to start
              again from the beginning.
            </div>
          </>
        )}

        <div style={{ marginTop: 22, paddingTop: 14, borderTop: '1px solid var(--border-subtle, #e4e7ec)' }}>
          <Link to="/settings?section=tiktokAds" style={{ fontSize: 13, fontWeight: 600, color: 'var(--primary, #4338ca)' }}>
            Go to TikTok Ads settings
          </Link>
        </div>
      </div>
    </div>
  );
}
