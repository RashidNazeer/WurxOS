import { createContext, useContext, useEffect, useState, useCallback, useRef, useMemo } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { supabase } from '../lib/supabase';
import { logAppEvent } from '../lib/appEvents';
import { hasUnsavedWork } from '../lib/appUpdate';

const AuthContext = createContext(null);

// Minimum gap between focus/online-triggered session rechecks.
// Without this, rapidly switching tabs would fire one call per focus.
const RECHECK_THROTTLE_MS = 15 * 1000;
// Require this many CONSECUTIVE failed checks before flagging the
// session as dead. A single null from getSession() or a single
// refresh error can fire during normal token rotation or a brief
// network blip — tearing the user out of an in-progress task (and
// losing their unsaved form data) over one transient hiccup is
// unacceptable. We only sign out when we're confident.
const SESSION_FAIL_THRESHOLD = 3;

export function AuthProvider({ children }) {
  const qc = useQueryClient();
  // The user id we last loaded a profile for. Used to detect a user
  // SWAP (boss → apc) so we can purge the React Query cache before
  // the new user's RLS-scoped data lands. Without this, the previous
  // user's cached lists (brands, tasks, attendance, etc.) render for
  // a beat under the new account because queryClient still has them
  // hot — staleTime is 5 min and refetchOnMount is off by design.
  const lastLoadedUidRef = useRef(null);
  const [session, setSession] = useState(null);
  const [profile, setProfile] = useState(null);
  const [loading, setLoading] = useState(true);
  // When true, the current client-side session state is out of sync
  // with the server (token expired, refresh failed, or auth.uid() no
  // longer maps to a real profile). Surfaces the "Session expired"
  // modal and forces a clean sign-out.
  const [sessionInvalid, setSessionInvalid] = useState(false);

  // Tracks whether the very first session check has resolved.
  // Keeps `loading` true only until we know if the user is signed in.
  const bootstrapped = useRef(false);
  // Throttle repeated focus/online rechecks.
  const lastRecheckRef = useRef(0);
  // Count consecutive failures so we only flag the session dead when
  // we're sure — see SESSION_FAIL_THRESHOLD above.
  const failCountRef = useRef(0);
  // Prevent concurrent recheckSession runs from stacking failures.
  // Multiple triggers (focus, online, startup) can fire within a few
  // ms; without this guard, two parallel checks could each fail and
  // double-count, hitting the threshold faster than the user expects.
  const recheckInFlightRef = useRef(false);

  // Returns true on success, false on any failure (network, timeout, RLS
  // error, or row not found).
  //
  // The `isRefresh` opt is critical. On INITIAL load we want to null the
  // profile + surface the re-login modal if loading fails (a half-broken
  // app is worse than a clear "sign in again"). But on REFRESH calls
  // (tab focus / online event), nulling the profile is exactly the bug:
  // Topbar shows "—", RoleGuard sees no role and Navigates to /login,
  // PublicOnly bounces back to /dashboard, and the user is stuck on a
  // broken UI until they manually reload. Haider Ali reported this on
  // 2026-06-03 — after fighting it across several rounds of partial
  // fixes, the right answer is: on a refresh, preserve the last-known
  // profile; the next refresh will sort it out, and the realtime UPDATE
  // / DELETE subscription elsewhere in this file already handles real
  // deletions cleanly via setSessionInvalid.
  //
  // 15s timeout. Pakistan-ISP slow queries finish in 2-4s; this only
  // aborts genuinely-zombied requests (TCP connection that survived a
  // network change). Without this the spinner can hang indefinitely.
  const loadProfile = useCallback(async (userId, opts = {}) => {
    const isRefresh = !!opts.isRefresh;
    if (!userId) {
      setProfile(null);
      return false;
    }
    try {
      const { data, error } = await supabase
        .from('profiles')
        .select('*')
        .eq('id', userId)
        .maybeSingle()
        .abortSignal(AbortSignal.timeout(15000));
      if (error) {
        console.warn('[auth] loadProfile error:', error.message);
        if (isRefresh) return false;       // keep existing profile
        setProfile(null);
        return false;
      }
      if (!data) {
        // Row not found. On initial load this means the auth user has
        // no profile row → half-broken session, surface the re-login
        // modal. On a refresh it is most likely a momentary RLS /
        // replica lag, NOT a real deletion (the realtime subscription
        // below handles real deletions). Preserve profile.
        if (isRefresh) return false;
        setProfile(null);
        return false;
      }
      // Defense in depth: refuse to bootstrap a session for a profile
      // that's already soft-deleted or inactive. The realtime UPDATE
      // listener catches deletions that happen DURING a session, but
      // if a user's profile is already deleted at sign-in time and
      // their auth.users row somehow isn't (e.g. a partial admin
      // cleanup left the auth-side intact), they'd reach a zombie
      // state with profile.deleted_at set but no SessionExpiredModal.
      // Surface the modal up front. Refresh path doesn't trip this —
      // an established session that suddenly sees deleted_at via a
      // refresh poll goes through the realtime UPDATE path instead.
      if (!isRefresh && (data.deleted_at || data.is_active === false)) {
        console.warn('[auth] profile is soft-deleted or inactive — rejecting bootstrap');
        setProfile(null);
        return false;
      }
      setProfile(data);
      return true;
    } catch (err) {
      console.warn('[auth] loadProfile threw:', err?.message || err);
      if (isRefresh) return false;          // keep existing profile
      setProfile(null);
      return false;
    }
    // Note: timezone is locked to Asia/Karachi at the DB level (migration
    // 095). We deliberately do NOT auto-sync from the browser — every user
    // is on Pakistan time regardless of their laptop's clock.
  }, []);

  // 1) Initial session check — runs once.
  useEffect(() => {
    let mounted = true;
    supabase.auth.getSession()
      .then(({ data }) => {
        if (!mounted) return;
        setSession(data.session);
        bootstrapped.current = true;
        logAppEvent(data.session?.user?.id, 'auth.bootstrap', {
          hasSession: !!data.session,
          expiresAt: data.session?.expires_at || null,
        });
        // If no session we can finish loading immediately;
        // otherwise the profile effect below will finish it.
        if (!data.session) setLoading(false);
      })
      .catch((err) => {
        // getSession() can reject if the localStorage auth store throws
        // (corrupted JSON, Safari ITP eviction, quota exceeded). Without
        // this catch the spinner hangs forever and the user has to hard
        // reload. Treat as logged-out: the next sign-in will rebuild
        // clean state from scratch.
        if (!mounted) return;
        console.warn('[auth] getSession failed:', err?.message || err);
        logAppEvent(null, 'auth.bootstrap_failed', {
          message: String(err?.message || err).slice(0, 200),
        });
        bootstrapped.current = true;
        setSession(null);
        setLoading(false);
      });

    // 2) Subscribe to auth changes. DO NOT call any Supabase DB method
    //    inside this callback — it will deadlock the auth listener.
    //    We only update session state here; the effect below reacts to it.
    const { data: sub } = supabase.auth.onAuthStateChange((event, newSession) => {
      if (!mounted) return;
      // Diagnostic — log every auth event so we can correlate refreshes
      // with their trigger.
      logAppEvent(newSession?.user?.id, `auth.${event}`, {
        hasSession: !!newSession,
        expiresAt: newSession?.expires_at || null,
      });
      // Drop no-op updates. Supabase fires TOKEN_REFRESHED with a brand-
      // new session object every hour AND every time the tab regains
      // focus after long inactivity — in both cases the access_token is
      // a new JWT string but the underlying user hasn't changed.
      // Without this guard, every refresh would re-render every
      // useAuth() consumer and re-fire any effect whose deps include
      // `user` or `session` by reference (we have several), making a
      // routine focus-recheck look like a full app reload.
      //
      // Dedupe on user id alone — that's what consumers actually care
      // about. The Supabase client manages its own token internally;
      // the session object we hold is just a snapshot for the UI, so
      // keeping the old reference when only tokens rotated is safe.
      setSession((prev) => {
        if (!prev && !newSession) return prev;
        if (prev && newSession && prev.user?.id === newSession.user?.id) {
          return prev;
        }
        return newSession;
      });
      // If session disappeared and a dirty form is open, DON'T null
      // profile immediately. Multi-tab signout, refresh-token flutter,
      // and BroadcastChannel sync events can all fire a transient
      // SIGNED_OUT — without this guard, profile=null cascades into
      // RoleGuard's Navigate-to-/login and the editor is destroyed.
      // recheckSession's 3-strike threshold will catch a real sign-out
      // and surface SessionExpiredModal; until then, keep the user
      // mounted on whatever they were doing.
      if (!newSession) {
        if (hasUnsavedWork()) {
          logAppEvent(null, 'auth.profile_null_deferred', {
            event,
            reason: 'unsaved-work',
          });
        } else {
          setProfile(null);
        }
      }
    });

    return () => {
      mounted = false;
      sub.subscription.unsubscribe();
    };
  }, []);

  // 3) Whenever the authenticated user changes, (re)load their profile,
  //    then subscribe to live changes on the profiles row so reassigns
  //    (reports_to flips, role change, deactivation, brand assignments
  //    via team_move_* RPCs) propagate without a manual refresh.
  useEffect(() => {
    const uid = session?.user?.id;
    if (!uid) { setSessionInvalid(false); return; }
    // User id swapped (sign-in OR switch-user): nuke every cached query
    // so we never render Boss's brand list under an APC account, etc.
    // First load fires this too — clear() on an empty cache is cheap.
    if (lastLoadedUidRef.current !== uid) {
      qc.clear();
      lastLoadedUidRef.current = uid;
    }
    let cancelled = false;
    (async () => {
      // Single retry on the initial profile load. Haider Ali reported
      // 2026-06-03 that he had to reload the app 3 times before the
      // UI rendered cleanly — Pakistan-ISP transient failures were
      // tearing down the first load. A 1s retry catches most of those
      // without making real failures (deleted row, dead session) feel
      // sluggish.
      let ok = await loadProfile(uid);
      if (cancelled) return;
      if (!ok) {
        await new Promise((r) => setTimeout(r, 1000));
        if (cancelled) return;
        ok = await loadProfile(uid);
        if (cancelled) return;
      }
      // Always clear the loading flag — even on failure. A stuck
      // spinner with no recovery is the worst UX; surfacing the
      // session-expired modal lets the user act.
      if (bootstrapped.current) setLoading(false);
      // If we authenticated but couldn't load a profile after two
      // tries, the session is functionally dead (RLS misconfigured,
      // profile row missing, network zombie). Surface the re-login
      // modal instead of leaving the user on a half-rendered app.
      if (!ok) setSessionInvalid(true);
    })();

    const channel = supabase
      .channel(`profile:${uid}`)
      .on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'profiles', filter: `id=eq.${uid}` },
        (payload) => {
          if (cancelled) return;
          // If the row was soft-deleted or deactivated, fall through to
          // recheckSession so the SessionExpiredModal can take over.
          if (payload.new?.deleted_at || payload.new?.is_active === false) {
            setSessionInvalid(true);
            return;
          }
          // Merge instead of replace. Supabase Realtime delivers only
          // the columns that changed when REPLICA IDENTITY is not FULL;
          // a partial UPDATE (e.g. last_seen_at) would otherwise wipe
          // display_name, role, reports_to, etc. The full row from
          // loadProfile is the source of truth for missing fields.
          setProfile((prev) => (prev ? { ...prev, ...payload.new } : payload.new));
        },
      )
      .on(
        'postgres_changes',
        { event: 'DELETE', schema: 'public', table: 'profiles', filter: `id=eq.${uid}` },
        () => { if (!cancelled) setSessionInvalid(true); },
      )
      .subscribe();

    return () => {
      cancelled = true;
      supabase.removeChannel(channel);
    };
  }, [session?.user?.id, loadProfile]);

  // 4) Verify the in-memory session still works against the server.
  //    Two failure modes we care about:
  //      (a) getSession() returns null — Supabase has already decided
  //          we're signed out (refresh token rejected, localStorage
  //          cleared, etc.) but React state still thinks we are.
  //      (b) auth.uid() server-side no longer matches our profile id
  //          — extremely rare, but the symptom is empty RLS reads
  //          across the whole app. We catch it by doing one cheap
  //          authenticated query and checking it sees our own row.
  //    If either fails, flip `sessionInvalid` so the UI can show the
  //    re-login modal; the user's click in the modal calls signOut.
  const recheckSession = useCallback(async () => {
    if (!session?.user?.id) return;
    // Don't stack concurrent rechecks — the focus/online/startup
    // triggers can all fire within milliseconds. If one is already
    // running, the second is redundant.
    if (recheckInFlightRef.current) return;
    const now = Date.now();
    if (now - lastRecheckRef.current < RECHECK_THROTTLE_MS) return;
    lastRecheckRef.current = now;
    recheckInFlightRef.current = true;

    // Count failures across checks so a single transient hiccup
    // doesn't tear an in-progress user out of their form. Any
    // SUCCESSFUL step resets the counter.
    const fail = (why) => {
      failCountRef.current += 1;
      // eslint-disable-next-line no-console
      console.warn(`[auth] session check failed (${failCountRef.current}/${SESSION_FAIL_THRESHOLD}): ${why}`);
      logAppEvent(session?.user?.id, 'auth.recheck_fail', {
        why,
        count: failCountRef.current,
        threshold: SESSION_FAIL_THRESHOLD,
      });
      if (failCountRef.current >= SESSION_FAIL_THRESHOLD) {
        logAppEvent(session?.user?.id, 'auth.session_invalid', { why });
        setSessionInvalid(true);
      }
    };
    const pass = () => { failCountRef.current = 0; };

    try {
      // getSession() returns the cached session without contacting
      // the server, so if the access token expired while the tab
      // was hidden it would still come back "valid" until the next
      // request 401s. If the access token is past its expiry, drive
      // a refresh through Supabase first; the refresh token is good
      // for ~30 days. Only escalate to "session expired" when the
      // refresh itself fails (refresh token revoked / clock skewed
      // beyond grace) AND we've failed several checks in a row.
      const { data: sess } = await supabase.auth.getSession();
      if (!sess?.session) {
        fail('getSession returned null');
        return;
      }
      const expiresAt = sess.session.expires_at;            // unix seconds
      const nowSec    = Math.floor(Date.now() / 1000);
      // Refresh slightly ahead of the deadline so a request fired
      // immediately after this check still has a fresh token.
      if (typeof expiresAt === 'number' && expiresAt - nowSec < 60) {
        const { error: refreshErr } = await supabase.auth.refreshSession();
        if (refreshErr) {
          fail(`refreshSession error: ${refreshErr.message || refreshErr}`);
          return;
        }
        // refreshSession() updates the client's session in place;
        // onAuthStateChange will sync our state.
      }

      // Cheap RLS-bound read — if it returns 0 rows, auth.uid() on
      // the server doesn't equal our profile id (profile soft-deleted
      // or row deleted server-side while we were gone).
      const { data: own, error } = await supabase
        .from('profiles')
        .select('id')
        .eq('id', session.user.id)
        .limit(1);
      if (error) {
        // Transient network/RLS error — don't penalize. But also
        // don't reset the counter; let a future successful read
        // clear it. This avoids a flapping pattern from counting
        // as a "clean" check.
        return;
      }
      if (!own || own.length === 0) {
        fail('profile self-read returned 0 rows');
        return;
      }
      // All checks passed.
      pass();
    } catch (err) {
      // Network blip — let the next focus/online event retry. Don't
      // count this as a failure; if it really is dead, the next
      // check will report it cleanly.
      // eslint-disable-next-line no-console
      console.warn('[auth] recheckSession threw (ignored):', err);
    } finally {
      recheckInFlightRef.current = false;
    }
  }, [session?.user?.id]);

  useEffect(() => {
    // Startup invariant check — fires once after we boot with a
    // session in hand. Skips the throttle so it runs immediately.
    if (!session?.user?.id) return;
    lastRecheckRef.current = 0;
    recheckSession();
  }, [session?.user?.id, recheckSession]);

  useEffect(() => {
    let lastProfileRefresh = 0;
    const refreshProfileIfStale = () => {
      // If we missed a realtime UPDATE event on the profiles table
      // (WebSocket dropped, tab was sleeping, network blip), the
      // user's `reports_to`, role, or brand-assignment can be stale
      // — which produces "my TL says he's offline but he's actually
      // clocked in" and similar reassignment-related symptoms.
      // Re-fetch the profile on tab focus, throttled to once / minute.
      const uid = session?.user?.id;
      if (!uid) return;
      const now = Date.now();
      if (now - lastProfileRefresh < 60 * 1000) return;
      lastProfileRefresh = now;
      // isRefresh: true → if this fails (Pakistan ISP blip, etc.) we
      // preserve the existing profile rather than nulling it. See the
      // long-form comment at loadProfile().
      loadProfile(uid, { isRefresh: true }).catch(() => {});
    };
    const onVisible = () => {
      if (document.visibilityState === 'visible') {
        recheckSession();
        refreshProfileIfStale();
      }
    };
    const onOnline = () => {
      recheckSession();
      refreshProfileIfStale();
    };
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('online', onOnline);
    return () => {
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('online', onOnline);
    };
  }, [recheckSession, session?.user?.id, loadProfile]);

  const signUp = useCallback(async ({ email, password, displayName }) => {
    const { data, error } = await supabase.auth.signUp({
      email,
      password,
      options: { data: { display_name: displayName } },
    });
    if (error) throw error;
    return data;
  }, []);

  const signIn = useCallback(async ({ email, password }) => {
    const { data, error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) throw error;
    return data;
  }, []);

  const signOut = useCallback(async () => {
    // Log BEFORE the await so we capture the trigger even if the
    // sign-out network call hangs.
    logAppEvent(session?.user?.id, 'auth.signed_out_explicit', {
      from: typeof window !== 'undefined' ? window.location.pathname : null,
    });
    // Wipe both layers BEFORE the auth call so nothing stale paints
    // between sign-out and the redirect to /login. lastLoadedUidRef
    // also flips so the next sign-in's user-swap branch fires even
    // if the same person logs back in (their data should still be
    // fetched fresh, never served from a previous-session cache).
    qc.clear();
    lastLoadedUidRef.current = null;
    setProfile(null);
    setSessionInvalid(false);
    // scope: 'local' kills the refresh token in THIS browser only.
    // Default (global) revokes every refresh token for this user,
    // which logs them out of all other devices too — surprising
    // behavior when a user is signed in on their phone and laptop
    // and signs out of one expecting the other to keep working.
    //
    // Wrapped in try/catch: signOut acquires the Web Locks auth-token
    // lock, which can race a mid-flight token refresh / SIGNED_OUT
    // teardown and reject with 'Lock … was released because another
    // request stole it'. The sign-out still completes (we've already
    // wiped local state above and the local token is cleared), so
    // swallow the benign lock-contention rejection instead of letting
    // it bubble up as an unhandled rejection.
    try {
      await supabase.auth.signOut({ scope: 'local' });
    } catch (e) {
      console.warn('[auth] signOut lock contention (benign):', e?.message);
    }
  }, [qc, session?.user?.id]);

  const refreshProfile = useCallback(
    () => (session?.user?.id ? loadProfile(session.user.id) : null),
    [session?.user?.id, loadProfile],
  );

  // Memoize so consumers that compare by reference (effects with
  // `user`/`session` in deps) don't re-fire on unrelated re-renders
  // of this provider. The setSession dedupe above already prevents
  // most spurious renders, but this is cheap defense-in-depth.
  const value = useMemo(
    () => ({
      session,
      user: session?.user ?? null,
      profile,
      loading,
      sessionInvalid,
      signUp,
      signIn,
      signOut,
      refreshProfile,
    }),
    [session, profile, loading, sessionInvalid, signUp, signIn, signOut, refreshProfile],
  );

  return (
    <AuthContext.Provider value={value}>
      {children}
      {sessionInvalid && <SessionExpiredModal onSignIn={signOut} />}
    </AuthContext.Provider>
  );
}

// Blocks the app until the user clicks "Sign in again", which runs
// signOut to clear the dead session and drops them at /login.
function SessionExpiredModal({ onSignIn }) {
  return (
    <div style={{
      position: 'fixed', inset: 0,
      background: 'rgba(0, 0, 0, 0.5)',
      display: 'grid', placeItems: 'center',
      zIndex: 9999,
      padding: 20,
    }}>
      <div style={{
        background: 'var(--surface-1)',
        border: '1px solid var(--border-subtle)',
        borderRadius: 'var(--radius-lg)',
        boxShadow: 'var(--shadow-lg, 0 10px 40px rgba(0, 0, 0, 0.25))',
        padding: 24,
        maxWidth: 380,
        width: '100%',
        textAlign: 'center',
      }}>
        <div style={{
          width: 48, height: 48, margin: '0 auto 12px',
          borderRadius: '50%',
          background: 'var(--danger-soft)', color: 'var(--danger)',
          display: 'grid', placeItems: 'center',
          fontSize: 22, fontWeight: 800,
        }}>!</div>
        <h2 style={{ margin: '0 0 6px', fontSize: 17, color: 'var(--text-primary)' }}>
          Your session has expired
        </h2>
        <p style={{ color: 'var(--text-secondary)', fontSize: 13.5, margin: '0 0 18px' }}>
          You were signed out in the background. Please sign in again to
          continue.
        </p>
        <button
          className="wx-btn wx-btn-primary"
          onClick={onSignIn}
          autoFocus
          style={{ width: '100%', justifyContent: 'center' }}
        >
          Sign in again
        </button>
      </div>
    </div>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider');
  return ctx;
}
