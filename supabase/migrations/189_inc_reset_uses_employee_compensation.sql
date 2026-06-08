-- ============================================================
-- WurxOS v2 — Migration 189: month rollover reads salary from
-- employee_compensation, falling back to last month if unset.
--
-- Before: inc_reset_and_roll copied v_source.basic_salary forward
-- verbatim. Salary changes mid-quarter via Boss → Salaries wouldn't
-- propagate into future month plans until Boss manually edited
-- every per-month incentive row.
--
-- After: the rollover looks up public.employee_compensation as the
-- source of truth. If the user has no comp row (newly created
-- profile, never seeded), it falls back to the source month's
-- basic_salary so old behavior is preserved for edge cases.
--
-- Coexistence: the incentives.basic_salary column stays in place
-- as the per-month snapshot (preserves "what was Ali's salary in
-- March?" reporting). Reads in the React app still come from
-- incentives.basic_salary; only the rollover write source changes.
-- ============================================================

create or replace function public.inc_reset_and_roll(
  p_source text,
  p_target text,
  p_force_clear boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_me      uuid := auth.uid();
  v_source  record;
  v_cleared int := 0;
  v_created int := 0;
  v_skipped int := 0;
  v_items   jsonb;
  v_bonuses jsonb;
  v_salary  numeric;
begin
  if not public.is_boss(v_me) then raise exception 'only Boss can reset & roll'; end if;
  if p_source is null or p_target is null then raise exception 'source & target month required'; end if;
  if p_source = p_target then raise exception 'source and target must differ'; end if;

  for v_source in select * from public.incentives where month = p_source loop
    if v_source.verified or p_force_clear then
      update public.incentives
         set payout_cleared    = true,
             payout_cleared_by = v_me,
             payout_cleared_at = now()
       where id = v_source.id;
      v_cleared := v_cleared + 1;
    else
      v_skipped := v_skipped + 1;
    end if;

    v_items := coalesce((
      select jsonb_agg(
        jsonb_set(
          jsonb_set(it::jsonb, '{achievedValue}', '0'::jsonb),
          '{completed}', 'false'::jsonb
        )
      )
      from jsonb_array_elements(v_source.incentives) it
    ), '[]'::jsonb);

    v_bonuses := coalesce((
      select jsonb_agg(
        jsonb_set(
          jsonb_set(it::jsonb, '{achievedValue}', '0'::jsonb),
          '{completed}', 'false'::jsonb
        )
      )
      from jsonb_array_elements(v_source.bonuses) it
    ), '[]'::jsonb);

    -- Look up the CURRENT source-of-truth salary; fall back to
    -- the source month's snapshot if no comp row exists yet.
    select basic_salary into v_salary
      from public.employee_compensation
     where user_id = v_source.user_id;
    if v_salary is null then v_salary := v_source.basic_salary; end if;

    insert into public.incentives
      (user_id, month, basic_salary, incentives, bonuses, last_updated_by, updated_at)
    values
      (v_source.user_id, p_target, v_salary, v_items, v_bonuses, v_me, now())
    on conflict (user_id, month) do nothing;

    if found then v_created := v_created + 1; end if;
  end loop;

  return jsonb_build_object(
    'cleared', v_cleared,
    'created', v_created,
    'skipped', v_skipped
  );
end;
$$;
