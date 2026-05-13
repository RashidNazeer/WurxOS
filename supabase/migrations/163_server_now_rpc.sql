-- 163_server_now_rpc.sql
--
-- Expose Postgres `now()` as an RPC so the client can compute the drift
-- between the user's laptop clock and real time.
--
-- Why: the attendance live-elapsed timer used Date.now() on the client.
-- Users whose system clock was wrong (notably ~12h behind real time) saw
-- session = 00:00:00 because (Date.now() - clockInMs) went negative and
-- the Math.max(0, ...) clamp dropped it to zero. We now anchor running
-- calculations to server time so the timer stays correct regardless of
-- the user's local clock.
--
-- The function is `security definer` and locks `search_path` for safety,
-- but it does nothing privileged — it returns now(). Anyone authenticated
-- can call it.

create or replace function public.server_now()
returns timestamptz
language sql
security definer
set search_path = public
stable
as $$
  select now();
$$;

grant execute on function public.server_now() to authenticated;
