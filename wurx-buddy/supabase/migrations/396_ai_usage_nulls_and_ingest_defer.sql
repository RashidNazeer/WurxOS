-- ============================================================
-- 396 — QA 2026-10-01 F2 + F3.
--
--   F2  ai_usage_log: a bulk insert through PostgREST sends NULL for a column
--       that some rows omit, and a column default does not apply to an explicit
--       NULL. The defaults stay 0 and a BEFORE INSERT trigger turns NULL counts
--       and costs into 0, so no writer can lose a usage row that way again.
--   F3  ai_ingest_defer: an OpenAI account problem (no credits, a refused key)
--       is not the item's fault. The worker puts such items back as 'pending'
--       after a delay, WITHOUT spending one of their 5 attempts (the claim
--       counted one; this gives it back), so a credit outage cannot push the
--       queue into 'failed'.
-- Idempotent.
-- ============================================================

alter table public.ai_usage_log
  alter column calls         set default 1,
  alter column tokens_in     set default 0,
  alter column tokens_cached set default 0,
  alter column tokens_out    set default 0,
  alter column est_cost_usd  set default 0;

create or replace function public.ai_usage_log_fill() returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.calls         := coalesce(new.calls, 1);
  new.tokens_in     := coalesce(new.tokens_in, 0);
  new.tokens_cached := coalesce(new.tokens_cached, 0);
  new.tokens_out    := coalesce(new.tokens_out, 0);
  new.est_cost_usd  := coalesce(new.est_cost_usd, 0);
  return new;
end;
$$;
revoke execute on function public.ai_usage_log_fill() from public, anon, authenticated;
drop trigger if exists ai_usage_log_fill on public.ai_usage_log;
create trigger ai_usage_log_fill before insert on public.ai_usage_log
  for each row execute function public.ai_usage_log_fill();

-- Only the worker holding the item may defer it (as ai_ingest_fail, mig 372).
create or replace function public.ai_ingest_defer(p_id bigint, p_worker text, p_error text, p_delay_seconds int default 1800)
returns boolean
language plpgsql security definer
set search_path = public
as $$
begin
  update public.ai_ingest_queue
     set status     = 'pending',
         attempts   = greatest(attempts - 1, 0),
         not_before = now() + make_interval(secs => greatest(coalesce(p_delay_seconds, 1800), 60)),
         locked_at  = null,
         last_error = left(p_error, 1000)
   where id = p_id and status = 'processing' and locked_by = p_worker;
  return found;
end;
$$;
revoke execute on function public.ai_ingest_defer(bigint, text, text, int) from public, anon, authenticated;
grant  execute on function public.ai_ingest_defer(bigint, text, text, int) to service_role;
