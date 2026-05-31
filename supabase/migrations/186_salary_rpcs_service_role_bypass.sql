-- ============================================================
-- WurxOS v2 — Migration 186: service_role bypass for salary RPCs
--
-- Mirrors mig 132's incentives_guard pattern. The Salary Management
-- RPCs set_user_hire_date() and set_user_salary() guard on
-- is_boss(auth.uid()), but the one-time backfill scripts
-- (migration/seed_salary_from_incentives.mjs and
-- migration/seed_hire_dates_from_sheet.mjs) connect with the
-- service-role key — auth.uid() is null there, so the Boss check
-- fails. Let service_role through; it's only used by admin
-- tooling, never by client requests.
-- ============================================================

create or replace function public.set_user_hire_date(
  p_uid        uuid,
  p_hire_date  date
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_caller   uuid := auth.uid();
  v_old_date date;
begin
  if not pg_has_role(current_user, 'service_role', 'member')
     and not public.is_boss(v_caller) then
    raise exception 'only Boss can set hire date';
  end if;

  select start_date into v_old_date from public.profiles where id = p_uid;
  if not found then
    raise exception 'user not found';
  end if;

  if v_old_date is not distinct from p_hire_date then
    return;
  end if;

  update public.profiles
     set start_date = p_hire_date,
         updated_at = now()
   where id = p_uid;

  insert into public.audit_log (actor_id, action, entity_type, entity_id, before, after)
  values (
    v_caller, 'salary.hire_date_set', 'profiles', p_uid,
    jsonb_build_object('start_date', v_old_date),
    jsonb_build_object('start_date', p_hire_date)
  );
end;
$$;

create or replace function public.set_user_salary(
  p_uid            uuid,
  p_new_amount     numeric,
  p_change_reason  text,
  p_increment_pct  numeric default null,
  p_boss_notes     text    default null,
  p_effective_from date    default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_caller     uuid := auth.uid();
  v_target     public.profiles%rowtype;
  v_prev       numeric;
  v_effective  date := coalesce(p_effective_from, current_date);
  v_history_id uuid;
begin
  if not pg_has_role(current_user, 'service_role', 'member')
     and not public.is_boss(v_caller) then
    raise exception 'only Boss can change salary';
  end if;

  if p_new_amount is null or p_new_amount < 0 then
    raise exception 'salary must be >= 0';
  end if;

  if p_change_reason not in ('initial_seed', 'annual_increment', 'promotion', 'adjustment', 'correction') then
    raise exception 'invalid change_reason: %', p_change_reason;
  end if;

  select * into v_target from public.profiles where id = p_uid;
  if not found then
    raise exception 'user not found';
  end if;

  select basic_salary into v_prev
    from public.employee_compensation
   where user_id = p_uid;

  if v_prev is not null and v_prev = p_new_amount and p_change_reason <> 'initial_seed' then
    return null;
  end if;

  insert into public.employee_compensation (
    user_id, basic_salary, effective_from, last_change_reason, last_changed_by, updated_at
  )
  values (
    p_uid, p_new_amount, v_effective, p_change_reason, v_caller, now()
  )
  on conflict (user_id) do update
     set basic_salary       = excluded.basic_salary,
         effective_from     = excluded.effective_from,
         last_change_reason = excluded.last_change_reason,
         last_changed_by    = excluded.last_changed_by,
         updated_at         = now();

  insert into public.salary_history (
    user_id, effective_from, previous_amount, new_amount, increment_pct, change_reason, boss_notes, changed_by
  )
  values (
    p_uid, v_effective, v_prev, p_new_amount, p_increment_pct, p_change_reason, p_boss_notes, v_caller
  )
  returning id into v_history_id;

  insert into public.audit_log (actor_id, action, entity_type, entity_id, before, after)
  values (
    v_caller, 'salary.update', 'employee_compensation', p_uid,
    jsonb_build_object('basic_salary', v_prev),
    jsonb_build_object(
      'basic_salary',   p_new_amount,
      'increment_pct',  p_increment_pct,
      'change_reason',  p_change_reason,
      'effective_from', v_effective
    )
  );

  if p_change_reason <> 'initial_seed' then
    perform public.emit_notification(
      p_uid, v_caller, 'salary', 'salary.updated',
      'Your salary has been updated',
      case
        when v_prev is null then
          'Your salary has been set to PKR ' || trim(to_char(p_new_amount, 'FM999,999,999'))
        when p_increment_pct is not null then
          'PKR ' || trim(to_char(v_prev, 'FM999,999,999')) || ' → PKR ' ||
          trim(to_char(p_new_amount, 'FM999,999,999')) ||
          ' (' || trim(to_char(p_increment_pct, 'FM990.0')) || '%)'
        else
          'PKR ' || trim(to_char(v_prev, 'FM999,999,999')) || ' → PKR ' ||
          trim(to_char(p_new_amount, 'FM999,999,999'))
      end,
      'employee_compensation', p_uid, '/me/compensation'
    );
  end if;

  return v_history_id;
end;
$$;
