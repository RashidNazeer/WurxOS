/**
 * Global error reporter — surfaces a friendly modal whenever something
 * breaks for the user, so they can DM the actual error text to the
 * developer (Mr Rashid) on Discord instead of just saying "the app
 * doesn't work."
 *
 * Catches three classes of failure:
 *   1. Unhandled promise rejections (Supabase queries, fetch calls).
 *   2. Uncaught runtime errors (sync exceptions outside React).
 *   3. Errors surfaced explicitly by feature code via `reportError(...)`.
 *      (React-tree render errors still go through RouteErrorBoundary,
 *      which forwards into this same modal.)
 *
 * Every reported error is also written to app_events for later
 * forensic queries.
 */

import {
  createContext, useCallback, useContext, useEffect, useRef, useState,
} from 'react';
import { useAuth } from './AuthContext';
import { logAppEvent } from '../lib/appEvents';
import { requestAppReload } from '../lib/appUpdate';

const ErrorReporterContext = createContext(null);

// Throttle: avoid spamming the user when a broken page produces a
// dozen errors per second. We only surface the first one, log all of
// them.
const DEDUP_WINDOW_MS = 5000;

function extractMessage(err) {
  if (!err) return 'Unknown error';
  if (typeof err === 'string') return err;
  if (err.message) return String(err.message);
  try { return JSON.stringify(err); } catch { return 'Unknown error'; }
}

// Stale-deploy detector. After we redeploy, users who had the old
// index.html in memory still reference content-hashed asset filenames
// that no longer exist on the CDN. The recovery is handled by the
// app-update coordinator (requestAppReload): it reloads only when the
// user has no unsaved work, otherwise raises the non-blocking "update
// available" banner. This is a transient state, not a bug, so we
// never escalate it to the scary "DM Mr Rashid" modal.
const STALE_DEPLOY_PATTERNS = [
  /Unable to preload CSS/i,
  /Failed to fetch dynamically imported module/i,
  /Importing a module script failed/i,
  /ChunkLoadError/i,
  /Loading chunk \d+ failed/i,
  /error loading dynamically imported module/i,
];
function isStaleDeployError(msg) {
  return STALE_DEPLOY_PATTERNS.some((re) => re.test(msg));
}

// Browser-extension noise. MetaMask, Phantom, other wallet extensions
// inject scripts into every page; some of them throw rejections on
// load (e.g. "Failed to connect to MetaMask") that the page can't
// handle and that the user can't act on. Same goes for password
// managers, screenshot tools, ad blockers, etc.
//
// We detect them two ways:
//   (a) stack frame from chrome-extension:// / moz-extension:// /
//       safari-web-extension:// — extension origin = not our code
//   (b) message matches a known wallet/extension pattern — fallback
//       when no stack is captured (cross-origin script errors)
const EXTENSION_STACK_PATTERN = /(chrome|moz|safari-web)-extension:\/\//i;
const EXTENSION_MSG_PATTERNS = [
  /Failed to connect to MetaMask/i,
  /MetaMask.*RPC/i,
  /window\.ethereum/i,
  /No Ethereum provider/i,
  /Phantom.*not found/i,
  /tronWeb/i,
];
function isExtensionNoise(err) {
  const msg = extractMessage(err);
  const stack = String(err?.stack || '');
  if (EXTENSION_STACK_PATTERN.test(stack)) return true;
  return EXTENSION_MSG_PATTERNS.some((re) => re.test(msg));
}
function handleStaleDeploy() {
  // Coordinator decides whether to reload now or defer to the banner.
  // Either way the stale-deploy error is handled — never surface it.
  requestAppReload('stale-deploy');
  return true;
}

function extractDetails(err) {
  const out = { message: extractMessage(err) };
  if (err?.stack) out.stack = String(err.stack);
  if (err?.code)  out.code  = String(err.code);
  if (err?.details) out.details = String(err.details);
  if (err?.hint)    out.hint = String(err.hint);
  return out;
}

export function ErrorReporterProvider({ children }) {
  const { user, profile } = useAuth();
  const [active, setActive] = useState(null); // { message, details, when }
  const lastShownRef = useRef(0);

  const reportError = useCallback((err, source = 'manual') => {
    const now = Date.now();
    const details = extractDetails(err);
    // Always log
    logAppEvent(user?.id, 'error.reported', {
      source,
      message: details.message?.slice(0, 500),
      code: details.code,
      hint: details.hint?.slice(0, 200),
      stack: details.stack?.slice(0, 1500),
      route: typeof window !== 'undefined' ? window.location.pathname : null,
    });
    // Only surface if we haven't shown one recently (avoids spam)
    if (now - lastShownRef.current < DEDUP_WINDOW_MS) return;
    lastShownRef.current = now;
    setActive({
      message: details.message,
      details,
      source,
      when: new Date().toISOString(),
      userName: profile?.display_name || user?.email || '',
    });
  }, [user?.id, profile?.display_name, user?.email]);

  // Global listeners for unhandled errors. Mount once.
  useEffect(() => {
    if (typeof window === 'undefined') return undefined;

    const onRejection = (e) => {
      // Some errors we never want to surface (cancelled fetches,
      // ResizeObserver loops, etc.). Filter conservatively — better
      // a false positive than missing a real bug.
      const r = e.reason;
      const msg  = extractMessage(r);
      const name = String(r?.name || '');
      // AbortError covers two common benign rejections:
      //   1. Cancelled fetches (TanStack Query/AbortController teardown)
      //   2. Supabase Auth cross-tab lock coordination — when a new
      //      tab opens it calls navigator.locks.request with
      //      `steal: true` to take over auth state; the older tabs
      //      see "Lock broken by another request with the 'steal'
      //      option." with name=AbortError, code=20. This is the
      //      auth client working as designed — older tabs' refresh
      //      requests fail loudly so the new tab can take over.
      //      The SAME contention also surfaces during signOut() as
      //      "Lock "lock:sb-...-auth-token" was released because
      //      another request stole it" — sign-out vs. a mid-flight
      //      token refresh / SIGNED_OUT teardown racing for the auth
      //      lock. The sign-out still completes (local token is wiped
      //      regardless); it's just noisy internal coordination, not a
      //      failure the user can act on.
      // Match on err.name first because err.message varies; fall
      // back to message text for older browsers that don't set name.
      if (name === 'AbortError') return;
      if (/AbortError|ResizeObserver loop|cancell?ed|Lock broken|another request stole it|was released because another/i.test(msg)) return;
      // Inactive-brand task freeze (mig 171) — local handlers in
      // TaskRow / TaskKanban / TasksPage already show a friendly
      // notice. If one slips through, don't escalate to the
      // "report to developer" modal; the user knows their brand
      // is inactive.
      if (/brand is inactive|inactive brand/i.test(msg)) return;
      // Browser-extension noise (MetaMask, wallets, etc.) — not our
      // code, user can't act on it.
      if (isExtensionNoise(r)) return;
      // Transient network failures. "TypeError: Failed to fetch"
      // (Chromium), "NetworkError" (Firefox), "Load failed" (Safari)
      // all mean "the request did not reach a server". Pakistan-ISP
      // blips, Wi-Fi handoffs, VPN reconnects, mobile-radio sleep —
      // none of these are app bugs and the user can't act on them.
      // A page refresh always recovers. Don't escalate to the modal.
      if (/Failed to fetch|NetworkError when attempting|Load failed|network request failed|net::ERR_/i.test(msg)) return;
      // Stale-deploy: silently reload instead of showing the modal.
      if (isStaleDeployError(msg) && handleStaleDeploy()) return;
      reportError(r, 'unhandled_rejection');
    };
    const onError = (e) => {
      const msg  = String(e?.message || '');
      const name = String(e?.error?.name || '');
      if (name === 'AbortError') return;
      if (/ResizeObserver loop|Script error|Lock broken/i.test(msg)) return;
      if (/brand is inactive|inactive brand/i.test(msg)) return;
      if (isExtensionNoise(e?.error || e)) return;
      if (/Failed to fetch|NetworkError when attempting|Load failed|network request failed|net::ERR_/i.test(msg)) return;
      if (isStaleDeployError(msg) && handleStaleDeploy()) return;
      reportError(e?.error || e, 'window_error');
    };
    window.addEventListener('unhandledrejection', onRejection);
    window.addEventListener('error', onError);
    return () => {
      window.removeEventListener('unhandledrejection', onRejection);
      window.removeEventListener('error', onError);
    };
  }, [reportError]);

  const dismiss = useCallback(() => setActive(null), []);

  return (
    <ErrorReporterContext.Provider value={{ reportError }}>
      {children}
      {active && <ErrorModal err={active} onClose={dismiss} />}
    </ErrorReporterContext.Provider>
  );
}

export function useErrorReporter() {
  const ctx = useContext(ErrorReporterContext);
  // Return a no-op if the provider isn't mounted (e.g. unit tests).
  return ctx || { reportError: () => {} };
}

// ─────────────────────────────────────────────────────────────────
// Modal
// ─────────────────────────────────────────────────────────────────
function ErrorModal({ err, onClose }) {
  const [copied, setCopied] = useState(false);

  const detailsText = (() => {
    const lines = [
      `User: ${err.userName || 'Unknown'}`,
      `Time: ${err.when}`,
      `Page: ${typeof window !== 'undefined' ? window.location.pathname : '?'}`,
      `Source: ${err.source}`,
      `Message: ${err.details.message}`,
    ];
    if (err.details.code)  lines.push(`Code: ${err.details.code}`);
    if (err.details.hint)  lines.push(`Hint: ${err.details.hint}`);
    if (err.details.stack) lines.push(`\nStack:\n${err.details.stack}`);
    return lines.join('\n');
  })();

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(detailsText);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      // Fallback: select the textarea
      const ta = document.querySelector('#wurxos-error-details');
      if (ta) { ta.select(); document.execCommand('copy'); }
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    }
  };

  const firstName = (err.userName || '').split(' ')[0] || 'there';

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0, zIndex: 10000,
        background: 'rgba(15, 23, 42, 0.55)',
        display: 'grid', placeItems: 'center',
        padding: 16,
        backdropFilter: 'blur(2px)',
      }}>
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: '100%', maxWidth: 480,
          background: 'var(--surface-1, #fff)',
          color: 'var(--text-primary, #0f172a)',
          border: '1px solid var(--border-subtle, #e5e7eb)',
          borderRadius: 16,
          boxShadow: '0 30px 60px rgba(15, 23, 42, 0.35)',
          overflow: 'hidden',
        }}>
        {/* Header strip */}
        <div style={{
          background: 'linear-gradient(135deg, #fb923c, #ef4444)',
          padding: '14px 18px',
          color: '#fff',
          display: 'flex', alignItems: 'center', gap: 10,
        }}>
          <div style={{
            width: 32, height: 32, borderRadius: '50%',
            background: 'rgba(255,255,255,0.22)',
            display: 'grid', placeItems: 'center',
            fontSize: 16,
          }}>
            <i className="bi bi-exclamation-triangle-fill" />
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontWeight: 700, fontSize: 15 }}>Hey {firstName} — sorry about that!</div>
            <div style={{ fontSize: 12, opacity: 0.92 }}>Something glitched. Help us fix it 👇</div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            style={{
              background: 'rgba(255,255,255,0.2)', border: 'none',
              color: '#fff', borderRadius: 8, width: 28, height: 28,
              cursor: 'pointer', fontSize: 14, lineHeight: 1,
            }}>×</button>
        </div>

        {/* Body */}
        <div style={{ padding: 18 }}>
          <p style={{ margin: '0 0 12px', fontSize: 13.5, lineHeight: 1.55 }}>
            Please DM this error to the developer{' '}
            <strong>Mr Rashid</strong> on Discord so it can be fixed quickly.
            Just copy the details below and paste them in your DM.
          </p>

          <div style={{
            background: 'var(--surface-2, #f9fafb)',
            border: '1px solid var(--border-subtle, #e5e7eb)',
            borderRadius: 10,
            padding: 10,
            fontSize: 12,
            marginBottom: 12,
            maxHeight: 220,
            overflow: 'auto',
          }}>
            <div style={{ fontWeight: 700, color: 'var(--danger, #b91c1c)', marginBottom: 6 }}>
              {err.details.message}
            </div>
            {err.details.code && (
              <div style={{ color: 'var(--text-muted, #6b7280)' }}>
                Code: <code>{err.details.code}</code>
              </div>
            )}
            {err.details.hint && (
              <div style={{ color: 'var(--text-muted, #6b7280)' }}>
                Hint: {err.details.hint}
              </div>
            )}
          </div>

          <textarea
            id="wurxos-error-details"
            readOnly
            value={detailsText}
            style={{
              width: '100%',
              minHeight: 80,
              maxHeight: 140,
              fontSize: 11,
              fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
              padding: 8,
              borderRadius: 8,
              border: '1px solid var(--border-subtle, #e5e7eb)',
              background: 'var(--surface-2, #f9fafb)',
              color: 'var(--text-primary, #0f172a)',
              resize: 'vertical',
              marginBottom: 14,
            }}
          />

          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button
              type="button"
              onClick={handleCopy}
              style={{
                flex: 1, minWidth: 140,
                background: copied ? '#16a34a' : 'var(--accent, #2563eb)',
                color: '#fff', border: 'none',
                padding: '10px 14px',
                borderRadius: 10,
                fontWeight: 600, fontSize: 13,
                cursor: 'pointer',
                display: 'inline-flex', alignItems: 'center', gap: 8,
                justifyContent: 'center',
                transition: 'background 0.15s',
              }}>
              <i className={`bi ${copied ? 'bi-check-circle-fill' : 'bi-clipboard'}`} />
              {copied ? 'Copied!' : 'Copy details'}
            </button>
            <button
              type="button"
              onClick={onClose}
              style={{
                flex: '0 0 auto',
                background: 'var(--surface-2, #f3f4f6)',
                color: 'var(--text-primary, #0f172a)',
                border: '1px solid var(--border-subtle, #e5e7eb)',
                padding: '10px 14px',
                borderRadius: 10,
                fontWeight: 600, fontSize: 13,
                cursor: 'pointer',
              }}>
              Dismiss
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
