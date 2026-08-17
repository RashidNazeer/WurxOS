import { useCallback, useEffect, useMemo, useState } from 'react';
import { supabase } from '../../../lib/supabase';
import { useAuth } from '../../../contexts/AuthContext';
import {
  startTikTokAuth, listTikTokConnections, verifyTikTokConnections,
  disconnectTikTok, setAdAccountBrand,
} from '../../../lib/tiktokAdsApi';
import {
  TiktokIcon, AlertIcon, CheckIcon, RefreshIcon, LinkIcon, TrashIcon, ClockIcon,
} from '../../../components/common/Icon';
import SectionShell from './SectionShell';

// Boss / OL / ads manager. Connects TikTok ad accounts to WurxOS through the
// approved "Wurx Ads Reporting" Business API app, and maps each connected
// advertiser to the brand it belongs to.
//
// Connecting sends the user to TikTok and they come back on the public
// /oauth/tiktok/callback route. Nothing sensitive passes through the browser:
// the token exchange happens in the tiktok-oauth edge function, which never
// returns the token to us.

function relTime(iso) {
  if (!iso) return null;
  const ms = Date.now() - new Date(iso).getTime();
  if (Number.isNaN(ms)) return null;
  const mins = Math.floor(ms / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs} hour${hrs === 1 ? '' : 's'} ago`;
  const days = Math.floor(hrs / 24);
  return days === 1 ? 'yesterday' : `${days} days ago`;
}

export default function TikTokAdsSection() {
  const { profile } = useAuth();
  const canManage = profile?.role === 'boss' || profile?.role === 'ol';

  const [state, setState] = useState(null);   // { accounts, connections, configured, sandbox }
  const [brands, setBrands] = useState([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState('');       // 'connect' | 'verify' | advertiserId | connectionId
  const [err, setErr] = useState('');
  const [ok, setOk] = useState('');
  const [verifyOut, setVerifyOut] = useState(null);

  const load = useCallback(async () => {
    setErr('');
    try {
      const [res, { data: bs, error: be }] = await Promise.all([
        listTikTokConnections(),
        supabase.from('brands')
          .select('id, brand_name, client_name')
          .eq('status', 'active')
          .order('client_name', { ascending: true }),
      ]);
      if (be) throw new Error(be.message);
      setState(res);
      setBrands(bs || []);
    } catch (e) {
      setErr(e.message || String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const brandLabel = useCallback((b) => (
    b.client_name && b.client_name !== b.brand_name
      ? `${b.client_name} — ${b.brand_name}` : (b.brand_name || b.client_name || 'Brand')
  ), []);

  const connById = useMemo(() => {
    const m = new Map();
    for (const c of state?.connections || []) m.set(c.id, c);
    return m;
  }, [state]);

  async function connect() {
    setErr(''); setOk(''); setBusy('connect');
    try {
      const { url } = await startTikTokAuth('Connected from Settings');
      // Full navigation, not a popup: TikTok's consent screen sets cookies and
      // popups get blocked or lost on mobile. The callback page brings the user
      // back with a clear result.
      window.location.href = url;
    } catch (e) {
      setErr(e.message || String(e));
      setBusy('');
    }
  }

  async function verify() {
    setErr(''); setOk(''); setVerifyOut(null); setBusy('verify');
    try {
      const res = await verifyTikTokConnections();
      setVerifyOut(res);
      if (!res?.results?.length) setOk(res?.message || 'Nothing to check yet.');
      await load();
    } catch (e) { setErr(e.message || String(e)); }
    finally { setBusy(''); }
  }

  async function mapBrand(advertiserId, brandId) {
    setErr(''); setOk(''); setBusy(advertiserId);
    try {
      await setAdAccountBrand(advertiserId, brandId);
      setState((s) => ({
        ...s,
        accounts: (s?.accounts || []).map((a) => (
          a.advertiser_id === advertiserId ? { ...a, brand_id: brandId || null } : a
        )),
      }));
      setOk('Saved.');
    } catch (e) { setErr(e.message || String(e)); }
    finally { setBusy(''); }
  }

  async function disconnect(connectionId) {
    // eslint-disable-next-line no-alert
    if (!window.confirm('Disconnect this TikTok account? Reporting will stop until it is authorized again.')) return;
    setErr(''); setOk(''); setBusy(connectionId);
    try {
      await disconnectTikTok(connectionId);
      setOk('Disconnected.');
      await load();
    } catch (e) { setErr(e.message || String(e)); }
    finally { setBusy(''); }
  }

  const accounts = state?.accounts || [];
  const configured = state?.configured;

  return (
    <SectionShell
      icon={TiktokIcon}
      title="TikTok Ads"
      subtitle="Connect ad accounts so GMV Max spend and per-video results can be read into WurxOS."
      action={canManage && configured ? (
        <button type="button" className="wx-btn wx-btn-ghost" onClick={verify} disabled={busy === 'verify'}>
          <RefreshIcon width="14" height="14" /> {busy === 'verify' ? 'Checking…' : 'Check connection'}
        </button>
      ) : null}
    >
      {loading && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, color: 'var(--text-muted)', fontSize: 13 }}>
          <span className="wx-spinner" style={{ width: 18, height: 18 }} /> Loading…
        </div>
      )}

      {!loading && (
        <>
          {state?.sandbox && (
            <div className="wx-alert wx-alert-info" style={{ marginBottom: 12 }}>
              <AlertIcon width="16" height="16" />
              <span>Pointing at TikTok&apos;s <strong>sandbox</strong>, not live ad accounts. Numbers here are not real.</span>
            </div>
          )}

          {!configured && (
            <div className="wx-alert wx-alert-danger" style={{ marginBottom: 12 }}>
              <AlertIcon width="16" height="16" />
              <span>
                The TikTok app is not configured on the server yet. Set the
                <code> TIKTOK_APP_ID</code>, <code>TIKTOK_APP_SECRET</code> and
                <code> TIKTOK_REDIRECT_URI</code> secrets, then reload.
              </span>
            </div>
          )}

          {err && (
            <div className="wx-alert wx-alert-danger" style={{ marginBottom: 12 }}>
              <AlertIcon width="16" height="16" /><span>{err}</span>
            </div>
          )}
          {ok && (
            <div className="wx-alert wx-alert-success" style={{ marginBottom: 12 }}>
              <CheckIcon width="16" height="16" /><span>{ok}</span>
            </div>
          )}

          {/* ── Connect ─────────────────────────────────────────── */}
          {canManage && (
            <div style={{
              padding: 16, marginBottom: 16, borderRadius: 'var(--radius-md)',
              border: '1px solid var(--border-subtle)', background: 'var(--surface-2)',
            }}>
              <div style={{ fontWeight: 700, fontSize: 14, color: 'var(--text-primary)', marginBottom: 4 }}>
                Connect an ad account
              </div>
              <div style={{ fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.55, marginBottom: 12 }}>
                You will be taken to TikTok to choose which ad accounts this app may read.
                Sign in there as the person who owns the ad account. Read-only reporting
                access only, and it can be withdrawn at any time from TikTok Business Center.
              </div>
              <button
                type="button"
                className="wx-btn wx-btn-primary"
                style={{ fontWeight: 600 }}
                onClick={connect}
                disabled={!configured || busy === 'connect'}
              >
                <LinkIcon width="14" height="14" />
                {busy === 'connect' ? 'Opening TikTok…' : 'Connect TikTok Ads account'}
              </button>
            </div>
          )}

          {/* ── Connected accounts ──────────────────────────────── */}
          <div style={{ fontSize: 12.5, fontWeight: 700, textTransform: 'uppercase',
                        letterSpacing: 0.4, color: 'var(--text-muted)', marginBottom: 8 }}>
            Connected accounts ({accounts.length})
          </div>

          {accounts.length === 0 ? (
            <div style={{ fontSize: 13.5, color: 'var(--text-secondary)', lineHeight: 1.55 }}>
              No TikTok ad account is connected yet. Until one is, no ad spend or GMV Max
              data can be read.
            </div>
          ) : (
            <div style={{ display: 'grid', gap: 8 }}>
              {accounts.map((a) => {
                const conn = connById.get(a.connection_id);
                return (
                  <div key={a.advertiser_id} style={{
                    padding: 12, border: '1px solid var(--border-subtle)',
                    borderRadius: 'var(--radius-md)', background: 'var(--surface-1)',
                  }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                      <div style={{ minWidth: 0, flex: 1 }}>
                        <div style={{ fontWeight: 600, fontSize: 14, color: 'var(--text-primary)' }}>
                          {a.advertiser_name || 'Unnamed ad account'}
                        </div>
                        <div style={{ fontSize: 12, color: 'var(--text-muted)', fontVariantNumeric: 'tabular-nums' }}>
                          ID {a.advertiser_id}
                          {conn?.lastVerifiedAt && <> · checked {relTime(conn.lastVerifiedAt)}</>}
                        </div>
                      </div>

                      {canManage && (
                        <select
                          className="wx-input"
                          style={{ maxWidth: 260 }}
                          value={a.brand_id || ''}
                          disabled={busy === a.advertiser_id}
                          onChange={(e) => mapBrand(a.advertiser_id, e.target.value)}
                        >
                          <option value="">Not mapped to a brand</option>
                          {brands.map((b) => (
                            <option key={b.id} value={b.id}>{brandLabel(b)}</option>
                          ))}
                        </select>
                      )}

                      {canManage && conn && (
                        <button
                          type="button"
                          className="wx-btn wx-btn-ghost"
                          title="Disconnect"
                          onClick={() => disconnect(conn.id)}
                          disabled={busy === conn.id}
                        >
                          <TrashIcon width="14" height="14" />
                        </button>
                      )}
                    </div>

                    {conn?.lastError && (
                      <div style={{
                        marginTop: 8, fontSize: 12.5, color: 'var(--danger)',
                        display: 'flex', alignItems: 'flex-start', gap: 6,
                      }}>
                        <AlertIcon width="13" height="13" style={{ marginTop: 2, flex: '0 0 auto' }} />
                        <span>TikTok last reported: {conn.lastError}. Reconnect this account.</span>
                      </div>
                    )}

                    {!a.brand_id && (
                      <div style={{
                        marginTop: 8, fontSize: 12.5, color: 'var(--warning)',
                        display: 'flex', alignItems: 'flex-start', gap: 6,
                      }}>
                        <ClockIcon width="13" height="13" style={{ marginTop: 2, flex: '0 0 auto' }} />
                        <span>Not mapped to a brand yet, so its spend cannot be attributed.</span>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}

          {/* ── Verify output ───────────────────────────────────── */}
          {verifyOut?.results?.length > 0 && (
            <div style={{
              marginTop: 16, padding: 12, borderRadius: 'var(--radius-md)',
              border: '1px solid var(--border-subtle)', background: 'var(--surface-2)',
            }}>
              <div style={{ fontWeight: 700, fontSize: 13, color: 'var(--text-primary)', marginBottom: 8 }}>
                Connection check
              </div>
              {verifyOut.results.map((r) => (
                <div key={r.connectionId} style={{
                  display: 'flex', alignItems: 'flex-start', gap: 8, fontSize: 13,
                  color: r.ok ? 'var(--success)' : 'var(--danger)', marginBottom: 4,
                }}>
                  {r.ok ? <CheckIcon width="14" height="14" style={{ marginTop: 2 }} />
                        : <AlertIcon width="14" height="14" style={{ marginTop: 2 }} />}
                  <span>
                    {r.message}
                    {r.ok && r.accounts?.length > 0 && ` — ${r.accounts.length} account${r.accounts.length === 1 ? '' : 's'} readable`}
                  </span>
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </SectionShell>
  );
}
