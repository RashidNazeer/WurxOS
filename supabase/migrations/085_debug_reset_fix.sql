-- ============================================================
-- WurxOS v2 — Migration 085: fix debug_recurring_reset() schema path
--
-- The previous version (migration 084) had `set search_path = public,
-- extensions` but pg_cron lives in the `cron` schema, not extensions.
-- Looking up `cron.job` therefore failed silently and returned 400.
-- Fixed by:
--   1. Adding `cron` to the search_path
--   2. Wrapping each section in its own exception handler so a
--      partial failure (e.g. no read access to cron.job_run_details)
--      still returns a useful diagnostic instead of a hard error.
-- ============================================================

create or replace function public.debug_recurring_reset()
returns jsonb
language plpgsql
security definer
set search_path = public, cron, extensions
as $$
declare
  v_caller_role text;
  v_cron_job jsonb;
  v_recent_runs jsonb;
  v_done_tasks jsonb;
  v_pg_cron_enabled boolean;
  v_cron_err text;
begin
  select role into v_caller_role from public.profiles where id = auth.uid();
  if v_caller_role <> 'boss' then
    raise exception 'Forbidden — Boss only' using errcode = '42501';
  end if;

  select exists(select 1 from pg_extension where extname = 'pg_cron') into v_pg_cron_enabled;

  if v_pg_cron_enabled then
    begin
      select to_jsonb(j) into v_cron_job
        from cron.job j
       where j.jobname = 'reset-recurring-tasks';
    exception when others then
      v_cron_err := SQLERRM;
      v_cron_job := jsonb_build_object('error', v_cron_err);
    end;

    begin
      select jsonb_agg(to_jsonb(r) order by r.start_time desc) into v_recent_runs
        from (
          select start_time, end_time, status, return_message
            from cron.job_run_details
           where jobid = (select jobid from cron.job where jobname = 'reset-recurring-tasks')
           order by start_time desc
           limit 5
        ) r;
    exception when others then
      v_recent_runs := jsonb_build_object('error', SQLERRM);
    end;
  end if;

  begin
    select jsonb_agg(jsonb_build_object(
      'id', t.id,
      'title', t.title,
      'category', t.category,
      'status', t.status,
      'assignee_role', p.role,
      'assignee_name', p.display_name,
      'next_reset_at', t.next_reset_at,
      'now', now(),
      'past_reset_window', (t.next_reset_at is not null and t.next_reset_at <= now()),
      'is_eligible_to_reset', (
        t.category in ('daily','weekly','monthly')
        and t.status = 'done'
        and t.next_reset_at is not null
        and t.next_reset_at <= now()
      )
    )) into v_done_tasks
    from public.tasks t
    left join public.profiles p on p.id = t.assignee_id
    where t.category in ('daily','weekly','monthly')
      and t.status = 'done'
    order by t.updated_at desc nulls last
    limit 20;
  exception when others then
    v_done_tasks := jsonb_build_object('error', SQLERRM);
  end;

  return jsonb_build_object(
    'pg_cron_enabled', v_pg_cron_enabled,
    'job', v_cron_job,
    'recent_runs', v_recent_runs,
    'done_tasks_sample', coalesce(v_done_tasks, '[]'::jsonb),
    'now', now()
  );
end;
$$;
