-- ============================================================
-- WurxOS v2 — Migration 185: Salary Management foundation
--
-- Establishes the source of truth for an employee's fixed salary,
-- the append-only history audit trail, and the Boss-only RPCs to
-- mutate them.
--
-- Coexists with public.incentives.basic_salary (mig 033). That
-- column remains the per-month snapshot used by every existing
-- incentive UI/calc path. This migration introduces:
--
--   • public.employee_compensation     — 1 row per user, current salary
--   • public.salary_history            — append-only, every change recorded
--   • public.anniversary_celebrations  — tracks last anniversary banner shown
--
--   • set_user_hire_date()             — Boss-only RPC, writes profiles.start_date
--   • set_user_salary()                — Boss-only RPC, upserts comp + history
--   • mark_anniversary_seen()          — employee dismisses their banner
--
-- RLS posture (per design decision 2026-05-31):
--   • Boss + self + OL can SELECT salary
--   • Boss only can mutate (writes are blocked at policy level;
--     only the SECURITY DEFINER RPCs may write)
--   • Developer role is NOT granted write access (user-decided)
--   • Incentives table RLS is untouched — TLs retain historical
--     visibility into incentives.basic_salary (user-decided)
-- ============================================================

-- ── employee_compensation ─────────────────────────────────────
create table if not exists public.employee_compensation (
  user_id            uuid primary key references public.profiles(id) on delete cascade,
  basic_salary       numeric not null check (basic_salary >= 0),
  effective_from     date    not null default current_date,
  last_change_reason text,
  last_changed_by    uuid references public.profiles(id) on delete set null,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

create index if not exists employee_compensation_changed_by_idx
  on public.employee_compensation(last_changed_by);

alter table public.employee_compensation enable row level security;

-- SELECT: self OR Boss OR OL (active, non-deleted). Developer excluded by design.
drop policy if exists "ec_select" on public.employee_compensation;
create policy "ec_select"
  on public.employee_compensation for select
  using (
    auth.uid() = user_id
    or public.is_boss(auth.uid())
    or exists (
      select 1 from public.profiles p
      where p.id = auth.uid()
        and p.role = 'ol'
        and p.is_active = true
        and p.deleted_at is null
    )
  );

-- INSERT / UPDATE / DELETE blocked at policy level. Only the SECURITY
-- DEFINER RPCs below may write.
drop policy if exists "ec_insert_block" on public.employee_compensation;
create policy "ec_insert_block"
  on public.employee_compensation for insert with check (false);

drop policy if exists "ec_update_block" on public.employee_compensation;
create policy "ec_update_block"
  on public.employee_compensation for update using (false);

drop policy if exists "ec_delete_block" on public.employee_compensation;
create policy "ec_delete_block"
  on public.employee_compensation for delete using (false);

-- ── salary_history ────────────────────────────────────────────
-- Append-only. Every salary change inserts exactly one row here.
create table if not exists public.salary_history (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references public.profiles(id) on delete cascade,
  effective_from  date not null,
  previous_amount numeric,                    -- null on the very first row (initial seed)
  new_amount      numeric not null check (new_amount >= 0),
  increment_pct   numeric,                    -- null when not an increment (e.g. initial seed)
  change_reason   text not null check (
    change_reason in ('initial_seed', 'annual_increment', 'promotion', 'adjustment', 'correction')
  ),
  boss_notes      text,
  changed_by      uuid references public.profiles(id) on delete set null,
  created_at      timestamptz not null default now()
);

create index if not exists salary_history_user_idx
  on public.salary_history(user_id, effective_from desc);

alter table public.salary_history enable row level security;

-- SELECT: same audience as employee_compensation.
drop policy if exists "sh_select" on public.salary_history;
create policy "sh_select"
  on public.salary_history for select
  using (
    auth.uid() = user_id
    or public.is_boss(auth.uid())
    or exists (
      select 1 from public.profiles p
      where p.id = auth.uid()
        and p.role = 'ol'
        and p.is_active = true
        and p.deleted_at is null
    )
  );

-- INSERT / UPDATE / DELETE blocked — append-only via RPC.
drop policy if exists "sh_insert_block" on public.salary_history;
create policy "sh_insert_block"
  on public.salary_history for insert with check (false);

drop policy if exists "sh_update_block" on public.salary_history;
create policy "sh_update_block"
  on public.salary_history for update using (false);

drop policy if exists "sh_delete_block" on public.salary_history;
create policy "sh_delete_block"
  on public.salary_history for delete using (false);

-- ── anniversary_celebrations ──────────────────────────────────
-- Tracks the most recent anniversary YEAR for which the employee
-- has been shown the celebration banner. Anniversary is detected
-- by comparing profiles.start_date to today; the banner only
-- shows when last_year_shown < years_completed.
create table if not exists public.anniversary_celebrations (
  user_id          uuid primary key references public.profiles(id) on delete cascade,
  last_year_shown  int not null check (last_year_shown >= 0),
  shown_at         timestamptz not null default now()
);

alter table public.anniversary_celebrations enable row level security;

-- Self read; Boss can read all (for debugging).
drop policy if exists "ac_select" on public.anniversary_celebrations;
create policy "ac_select"
  on public.anniversary_celebrations for select
  using (auth.uid() = user_id or public.is_boss(auth.uid()));

-- Self write/upsert is allowed — the employee dismisses their own
-- banner. The RPC mark_anniversary_seen() is still provided as the
-- canonical path so the dismiss timestamp is uniform.
drop policy if exists "ac_self_insert" on public.anniversary_celebrations;
create policy "ac_self_insert"
  on public.anniversary_celebrations for insert
  with check (auth.uid() = user_id);

drop policy if exists "ac_self_update" on public.anniversary_celebrations;
create policy "ac_self_update"
  on public.anniversary_celebrations for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- ════════════════════════════════════════════════════════════════
-- RPC: set_user_hire_date — Boss-only, writes profiles.start_date
-- ════════════════════════════════════════════════════════════════
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
  if not public.is_boss(v_caller) then
    raise exception 'only Boss can set hire date';
  end if;

  select start_date into v_old_date from public.profiles where id = p_uid;
  if not found then
    raise exception 'user not found';
  end if;

  if v_old_date is not distinct from p_hire_date then
    return;  -- no-op
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
grant execute on function public.set_user_hire_date(uuid, date) to authenticated;

-- ════════════════════════════════════════════════════════════════
-- RPC: set_user_salary — Boss-only
--
-- Upserts employee_compensation, appends to salary_history,
-- records audit_log, and emits a notification to the employee.
-- ════════════════════════════════════════════════════════════════
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

-- ════════════════════════════════════════════════════════════════
-- RPC: mark_anniversary_seen — employee dismisses their banner
-- ════════════════════════════════════════════════════════════════
create or replace function public.mark_anniversary_seen(p_year int)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_caller uuid := auth.uid();
begin
  if v_caller is null then
    raise exception 'unauthenticated';
  end if;
  if p_year is null or p_year < 0 then
    raise exception 'invalid year';
  end if;

  insert into public.anniversary_celebrations (user_id, last_year_shown, shown_at)
  values (v_caller, p_year, now())
  on conflict (user_id) do update
     set last_year_shown = greatest(public.anniversary_celebrations.last_year_shown, excluded.last_year_shown),
         shown_at        = now();
end;
$$;
grant execute on function public.mark_anniversary_seen(int) to authenticated;

-- ── Realtime publication ──────────────────────────────────────
-- Salary changes propagate to any open employee/Boss UI without
-- a manual refresh. RLS still gates per-subscriber visibility.
alter publication supabase_realtime add table public.employee_compensation;
alter publication supabase_realtime add table public.salary_history;
