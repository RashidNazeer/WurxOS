-- ============================================================
-- 386 — Wurx Buddy: turn safety (QA 2026-09-30 M1, M2, m2).
--
--   ai_messages.cancel_requested_at   set by the assistant function when the
--                        owner presses Stop (POST {cancel: messageId}); the
--                        running turn polls it, stops, and saves what it has
--                        as status 'error' with meta.cancelled. Clients still
--                        have no write access to ai_messages.
--   ai_finish_stale_replies(minutes)  a reply row left 'generating' longer
--                        than that (the function was killed mid-turn) becomes
--                        'error'. Run every 5 minutes by pg_cron, and at the
--                        start of every turn.
--   ai_turn_begin(...)   the rate limit, counted and recorded atomically at
--                        the START of a turn (a per-user advisory lock), so
--                        parallel sends cannot get past the hourly cap; the
--                        ai_request_log row is created here and completed at
--                        the end of the turn.
-- All three functions are service-role only.  Idempotent.
-- ============================================================

alter table public.ai_messages
  add column if not exists cancel_requested_at timestamptz;

create or replace function public.ai_finish_stale_replies(p_minutes int default 10)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare n int;
begin
  update public.ai_messages
     set status = 'error',
         meta = coalesce(meta, '{}'::jsonb) || jsonb_build_object('error', 'The reply did not finish (timed out).', 'stale', true)
   where status = 'generating'
     and created_at < now() - make_interval(mins => greatest(coalesce(p_minutes, 10), 1));
  get diagnostics n = row_count;
  return n;
end;
$$;
revoke execute on function public.ai_finish_stale_replies(int) from public, anon, authenticated;
grant  execute on function public.ai_finish_stale_replies(int) to service_role;

-- Returns 'ok' (and logs the request) or 'rate_limited' (and logs nothing).
-- p_limit null = exempt (still logged).
create or replace function public.ai_turn_begin(p_request_id uuid, p_user_id uuid, p_question text,
                                                p_model text, p_limit int default 30)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare n int;
begin
  perform pg_advisory_xact_lock(hashtext('ai_turn_begin'), hashtext(p_user_id::text));
  if p_limit is not null then
    select count(*) into n from public.ai_request_log
     where user_id = p_user_id and created_at > now() - interval '1 hour';
    if n >= p_limit then return 'rate_limited'; end if;
  end if;
  insert into public.ai_request_log (id, user_id, engine, provider, model, question)
  values (p_request_id, p_user_id, 'v2', 'openai', p_model, left(p_question, 4000));
  return 'ok';
end;
$$;
revoke execute on function public.ai_turn_begin(uuid, uuid, text, text, int) from public, anon, authenticated;
grant  execute on function public.ai_turn_begin(uuid, uuid, text, text, int) to service_role;

-- cron.schedule(name, …) replaces a job of the same name, so re-running is safe.
do $$ begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.schedule('ai-finish-stale-replies', '*/5 * * * *', 'select public.ai_finish_stale_replies(10)');
  end if;
end $$;
