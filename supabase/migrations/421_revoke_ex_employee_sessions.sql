-- Kill an ex-employee's live sessions the moment they are retired
-- (Owner, 2026-10-12: "ex employee's access must be removed as well").
--
-- WHAT WAS ALREADY TRUE. delete-user soft-deletes the auth user and sets
-- is_active = false, deleted_at. That is enough for:
--   * role-privileged access — is_boss(), can_eval_perf() and friends all
--     require is_active = true, so those die instantly;
--   * sign-in — GoTrue rejects a banned/soft-deleted user;
--   * an open tab — AuthContext listens for the profile UPDATE over realtime
--     and force-logs them out.
--
-- WHAT WAS NOT. An access token already in the person's hands is a signed JWT:
-- it is stateless, so it stays valid until `exp` (an hour by default) no matter
-- what we write to the database. Any policy keyed only on auth.uid() — read
-- your own profile, your own attendance, your own chat — would keep answering
-- for that hour, and the realtime force-logout only helps if a tab is open.
-- Somebody who had just been laid off therefore kept a window of API access.
--
-- WHAT THIS DOES. Deletes the person's rows from auth.sessions and
-- auth.refresh_tokens, so the session is gone server-side: the refresh token
-- cannot mint a new access token, and the session-validating surfaces
-- (Realtime, Storage) drop them immediately. Combined with the above, the
-- residual exposure falls to "the remaining lifetime of one already-issued
-- access token against own-row policies only".
--
-- REMAINING RESIDUAL, stated plainly rather than hidden: that last window
-- cannot be closed from SQL, because verifying a JWT does not consult the
-- database. Closing it fully means either a shorter JWT expiry on the project
-- (Auth settings) or an is_active check inside every own-row policy, which is
-- a much larger change across most of the schema. Shortening the JWT TTL is
-- the cheap lever if the Owner wants the window smaller.

create or replace function public.admin_revoke_user_sessions(p_user uuid)
returns integer
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  n integer := 0;
begin
  if p_user is null then
    return 0;
  end if;

  -- Refresh tokens first: a session row removed on its own can leave the
  -- token usable on some GoTrue versions.
  delete from auth.refresh_tokens where user_id::uuid = p_user;
  delete from auth.sessions       where user_id = p_user;
  get diagnostics n = row_count;
  return n;
exception
  -- Never let this fail the retire itself. The caller reports what happened;
  -- a missed revoke is a smaller problem than a half-retired employee.
  when others then
    raise warning 'admin_revoke_user_sessions(%) failed: %', p_user, sqlerrm;
    return -1;
end $$;

-- Service role only: this is called by the delete-user edge function. No
-- client ever needs it, and it would be a logout-anyone weapon if exposed.
revoke all on function public.admin_revoke_user_sessions(uuid) from public, anon, authenticated;
grant execute on function public.admin_revoke_user_sessions(uuid) to service_role;
