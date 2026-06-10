-- ============================================================
-- WurxOS v2 — Migration 199: a Boss salary change immediately
-- syncs the OPEN per-month incentive snapshot.
--
-- Bug: set_user_salary (mig 185) writes employee_compensation (the
-- source of truth shown on /me/compensation) but never touched
-- public.incentives.basic_salary. That column is a per-month snapshot
-- and was only refreshed at month rollover (inc_reset_and_roll, mig
-- 189). So after a raise the employee saw the new salary on My
-- Compensation but the OLD basic salary on the Incentives page (and
-- the incentive grand-total, which is basic_salary + incentives +
-- bonuses, was understated/overstated).
--
-- Fix:
--   1. set_user_salary now also UPDATEs incentives.basic_salary for
--      the employee's OPEN (not payout_cleared) months from the
--      effective month forward. Cleared/paid months keep their
--      historical snapshot. The Boss runs as auth.uid()=boss, so the
--      incentives_guard trigger (mig 132) treats it as admin and lets
--      the basic_salary edit through. incentives is in the realtime
--      publication (mig 091) so any open Incentives page updates live.
--   2. One-shot backfill aligns already-stale OPEN snapshots with the
--      current comp (triggers don't fire retroactively — CLAUDE.md).
--
-- Idempotent.
-- ============================================================

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
  if not public.is_boss(v_caller) then
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

  -- Prior salary (null if first-ever entry).
  select basic_salary into v_prev
    from public.employee_compensation
   where user_id = p_uid;

  -- No-op short-circuit only when reason isn't initial_seed.
  if v_prev is not null and v_prev = p_new_amount and p_change_reason <> 'initial_seed' then
    return null;
  end if;

  -- Upsert the current-salary row.
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

  -- Append history row.
  insert into public.salary_history (
    user_id, effective_from, previous_amount, new_amount, increment_pct, change_reason, boss_notes, changed_by
  )
  values (
    p_uid, v_effective, v_prev, p_new_amount, p_increment_pct, p_change_reason, p_boss_notes, v_caller
  )
  returning id into v_history_id;

  -- ── NEW: propagate into the OPEN per-month incentive snapshot ──
  -- Keeps the Incentives page (and its grand-total = basic_salary +
  -- incentives + bonuses) in lock-step with the new salary instead of
  -- waiting for the next rollover. Only OPEN (not payout_cleared)
  -- months at/after the effective month are touched — cleared/paid and
  -- pre-effective months keep their historical snapshot. Runs as the
  -- Boss (admin), so incentives_guard allows the basic_salary edit.
  update public.incentives
     set basic_salary    = p_new_amount,
         last_updated_by = v_caller,
         updated_at      = now()
   where user_id = p_uid
     and payout_cleared is not true
     and month >= to_char(v_effective, 'YYYY-MM')
     and basic_salary is distinct from p_new_amount;

  -- Audit log entry.
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

  -- Notify the employee — only if it's a real change (not the silent seed).
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
grant execute on function public.set_user_salary(uuid, numeric, text, numeric, text, date) to authenticated;

-- ── One-shot backfill: align already-stale OPEN snapshots ──────────
-- The incentives_guard trigger (mig 132) blocks basic_salary edits by
-- non-admin callers and has no GUC bypass, so disable it for this
-- admin backfill inside the migration transaction, then re-enable.
alter table public.incentives disable trigger incentives_guard;

update public.incentives i
   set basic_salary = ec.basic_salary,
       updated_at   = now()
  from public.employee_compensation ec
 where i.user_id = ec.user_id
   and i.payout_cleared is not true
   and i.month >= to_char(ec.effective_from, 'YYYY-MM')
   and i.basic_salary is distinct from ec.basic_salary;

alter table public.incentives enable trigger incentives_guard;
