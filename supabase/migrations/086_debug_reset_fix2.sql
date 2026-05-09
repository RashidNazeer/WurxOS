-- ============================================================
-- WurxOS v2 — Migration 086: fix done-tasks query in debug RPC
--
-- The previous version mixed jsonb_agg() with order by + limit at
-- the outer level, which Postgres rejects ("column must appear in
-- GROUP BY"). Restructure to do the ordering/limit in a subquery
-- and then aggregate.
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
      v_cron_job := jsonb_build_object('error', SQLERRM);
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
    -- Aggregate over a pre-ordered subquery so jsonb_agg has rows
    -- in the order we want.
    select jsonb_agg(row_to_json(s)) into v_done_tasks
      from (
        select
          t.id,
          t.title,
          t.category,
          t.status,
          p.role  as assignee_role,
          p.display_name as assignee_name,
          t.next_reset_at,
          now() as now_ts,
          (t.next_reset_at is not null and t.next_reset_at <= now()) as past_reset_window,
          (
            t.category in ('daily','weekly','monthly')
            and t.status = 'done'
            and t.next_reset_at is not null
            and t.next_reset_at <= now()
          ) as is_eligible_to_reset,
          t.updated_at
        from public.tasks t
        left join public.profiles p on p.id = t.assignee_id
        where t.category in ('daily','weekly','monthly')
          and t.status = 'done'
        order by t.updated_at desc nulls last
        limit 20
      ) s;
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
