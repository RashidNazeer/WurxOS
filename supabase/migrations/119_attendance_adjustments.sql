-- ============================================================
-- Migration 119 — Attendance manual adjustments (Roster)
--
-- Boss / OL can mark a missed weekday as "manually present" for
-- another user. Each row is one (user, date) override. The actual
-- attendance records are NEVER modified — Roster math just unions
-- (real present dates) ∪ (adjustment dates) when tallying a month.
--
-- Permissions:
--   Boss + Developer : adjust everyone (including self)
--   OL               : adjust everyone except self and other OLs
--   Anyone else      : no write access
-- All authenticated users can read so per-user widgets pick up
-- their own overrides; server-side notification is emitted on
-- create + bulk-create for transparency.
-- ============================================================

create table if not exists public.attendance_adjustments (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references public.profiles(id) on delete cascade,
  date            date not null,
  note            text,
  bulk            boolean not null default false,
  created_by      uuid references public.profiles(id) on delete set null,
  created_by_role text,
  created_at      timestamptz not null default now(),

  unique (user_id, date)
);

create index if not exists attendance_adjustments_user_date_idx
  on public.attendance_adjustments (user_id, date);
create index if not exists attendance_adjustments_date_idx
  on public.attendance_adjustments (date);

alter table public.attendance_adjustments enable row level security;

drop policy if exists "adjust_select_all" on public.attendance_adjustments;
create policy "adjust_select_all"
  on public.attendance_adjustments for select
  using (auth.role() = 'authenticated');

-- All writes go through SECURITY DEFINER RPCs below; block direct
-- inserts/updates/deletes from the client so the role gate is the
-- single source of truth.
drop policy if exists "adjust_no_direct_write" on public.attendance_adjustments;
create policy "adjust_no_direct_write"
  on public.attendance_adjustments for all
  using (false) with check (false);

-- --------------------------------------------------------------
-- Permission helper — true if v_actor can adjust v_target_role.
-- Boss + Developer: anyone. OL: anyone except self / other OLs.
-- Everyone else: no.
-- --------------------------------------------------------------
create or replace function public._adjust_can_act(
  v_actor_id   uuid,
  v_actor_role text,
  v_target_id  uuid,
  v_target_role text
) returns boolean
language sql
stable
as $$
  select case
    when v_actor_role in ('boss','developer') then true
    when v_actor_role = 'ol' then
      v_target_id <> v_actor_id and coalesce(v_target_role,'') <> 'ol'
    else false
  end;
$$;

-- --------------------------------------------------------------
-- Single-day mark / unmark
-- --------------------------------------------------------------
create or replace function public.att_adjust_create(
  p_user_id uuid,
  p_date    date,
  p_note    text default null
) returns public.attendance_adjustments
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor_id   uuid := auth.uid();
  v_actor_role text;
  v_target_role text;
  v_user_name  text;
  v_actor_name text;
  v_row public.attendance_adjustments;
  v_today date := (now() at time zone 'Asia/Karachi')::date;
begin
  if v_actor_id is null then raise exception 'not authenticated'; end if;

  select role into v_actor_role from public.profiles where id = v_actor_id;
  select role, display_name into v_target_role, v_user_name
    from public.profiles where id = p_user_id;
  if v_target_role is null then raise exception 'user not found'; end if;

  if not public._adjust_can_act(v_actor_id, v_actor_role, p_user_id, v_target_role) then
    raise exception 'not authorised to adjust this user';
  end if;

  if p_date is null then raise exception 'date is required'; end if;
  if p_date > v_today then raise exception 'cannot adjust a future date'; end if;
  if extract(dow from p_date) in (0, 6) then
    raise exception 'cannot adjust weekends';
  end if;

  insert into public.attendance_adjustments (
    user_id, date, note, created_by, created_by_role
  ) values (
    p_user_id, p_date, nullif(trim(coalesce(p_note,'')), ''),
    v_actor_id, v_actor_role
  )
  on conflict (user_id, date) do nothing
  returning * into v_row;

  if v_row.id is null then
    -- Idempotent: existing row stays; return it.
    select * into v_row from public.attendance_adjustments
      where user_id = p_user_id and date = p_date;
    return v_row;
  end if;

  select display_name into v_actor_name from public.profiles where id = v_actor_id;
  perform public.emit_notification(
    p_user_id,
    v_actor_id,
    'attendance',
    'attendance.manual_adjustment',
    coalesce(v_actor_name, 'Your manager') || ' marked you present on ' || to_char(p_date, 'YYYY-MM-DD'),
    case when nullif(trim(coalesce(p_note,'')),'') is not null
         then 'Note: ' || trim(p_note)
         else 'Your attendance was manually adjusted.' end,
    'attendance_adjustment',
    v_row.id,
    '/attendance'
  );

  return v_row;
end;
$$;
grant execute on function public.att_adjust_create(uuid, date, text) to authenticated;

create or replace function public.att_adjust_delete(
  p_user_id uuid,
  p_date    date
) returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor_id   uuid := auth.uid();
  v_actor_role text;
  v_target_role text;
begin
  if v_actor_id is null then raise exception 'not authenticated'; end if;

  select role into v_actor_role from public.profiles where id = v_actor_id;
  select role into v_target_role from public.profiles where id = p_user_id;
  if v_target_role is null then raise exception 'user not found'; end if;

  if not public._adjust_can_act(v_actor_id, v_actor_role, p_user_id, v_target_role) then
    raise exception 'not authorised to adjust this user';
  end if;

  delete from public.attendance_adjustments
    where user_id = p_user_id and date = p_date;
  return true;
end;
$$;
grant execute on function public.att_adjust_delete(uuid, date) to authenticated;

-- --------------------------------------------------------------
-- Bulk: mark every truly-missed weekday as present for each
-- targeted user. The actor passes user_ids and a month string
-- (YYYY-MM). The function:
--   1. Computes the set of weekdays in the month (Mon-Fri, not future).
--   2. Subtracts: dates with a real clock-in, dates already adjusted,
--      dates fully covered by an approved 'leave' request.
--   3. Inserts one adjustment per remaining date.
--   4. Emits ONE summary notification per user (not one per day).
-- Skips users the caller can't adjust (silent — UI already filters).
-- --------------------------------------------------------------
create or replace function public.att_adjust_bulk_mark_missed(
  p_month    text,        -- 'YYYY-MM'
  p_user_ids uuid[],
  p_note     text default null
) returns table (users_touched int, days_added int)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor_id   uuid := auth.uid();
  v_actor_role text;
  v_actor_name text;
  v_month_start date;
  v_month_end   date;
  v_today       date := (now() at time zone 'Asia/Karachi')::date;
  v_uid         uuid;
  v_target_role text;
  v_user_added  int;
  v_total_added int := 0;
  v_users       int := 0;
  v_note        text := nullif(trim(coalesce(p_note,'')), '');
begin
  if v_actor_id is null then raise exception 'not authenticated'; end if;
  select role, display_name into v_actor_role, v_actor_name
    from public.profiles where id = v_actor_id;
  if v_actor_role not in ('boss','ol','developer') then
    raise exception 'only Boss / OL / Developer can bulk-mark';
  end if;
  if p_month !~ '^\d{4}-\d{2}$' then
    raise exception 'month must be YYYY-MM';
  end if;

  v_month_start := to_date(p_month || '-01', 'YYYY-MM-DD');
  v_month_end   := (v_month_start + interval '1 month' - interval '1 day')::date;

  foreach v_uid in array coalesce(p_user_ids, '{}'::uuid[]) loop
    select role into v_target_role from public.profiles where id = v_uid;
    if v_target_role is null then continue; end if;
    if not public._adjust_can_act(v_actor_id, v_actor_role, v_uid, v_target_role) then
      continue;
    end if;

    -- Insert one adjustment per truly missed weekday for this user.
    with weekdays as (
      select d::date as date
      from generate_series(v_month_start, least(v_month_end, v_today), interval '1 day') as d
      where extract(dow from d) not in (0, 6)
    ),
    present as (
      select date::date as date
      from public.attendance
      where user_id = v_uid and clock_in is not null
        and date between v_month_start and v_month_end
    ),
    adjusted as (
      select date from public.attendance_adjustments
      where user_id = v_uid
        and date between v_month_start and v_month_end
    ),
    leaves as (
      -- Expand approved leave ranges day-by-day, intersected with month.
      select gs.d::date as date
      from public.leave_requests lr
      cross join lateral generate_series(
        greatest(lr.start_date, v_month_start),
        least(lr.end_date, v_month_end),
        interval '1 day'
      ) as gs(d)
      where lr.requester_id = v_uid
        and lr.status = 'approved'
        and lr.start_date <= v_month_end
        and lr.end_date   >= v_month_start
    ),
    missed as (
      select w.date from weekdays w
      where not exists (select 1 from present  p where p.date = w.date)
        and not exists (select 1 from adjusted a where a.date = w.date)
        and not exists (select 1 from leaves   l where l.date = w.date)
    ),
    inserted as (
      insert into public.attendance_adjustments (
        user_id, date, note, bulk, created_by, created_by_role
      )
      select v_uid, m.date, v_note, true, v_actor_id, v_actor_role from missed m
      on conflict (user_id, date) do nothing
      returning 1
    )
    select count(*)::int into v_user_added from inserted;

    if v_user_added > 0 then
      v_users := v_users + 1;
      v_total_added := v_total_added + v_user_added;
      perform public.emit_notification(
        v_uid,
        v_actor_id,
        'attendance',
        'attendance.manual_adjustment_bulk',
        coalesce(v_actor_name, 'Your manager') ||
          ' marked ' || v_user_added || ' day' ||
          case when v_user_added = 1 then '' else 's' end ||
          ' present in ' || p_month,
        case when v_note is not null then 'Note: ' || v_note
             else 'Your attendance was backfilled by your manager.' end,
        'attendance_adjustment_bulk',
        null,
        '/attendance'
      );
    end if;
  end loop;

  users_touched := v_users;
  days_added    := v_total_added;
  return next;
end;
$$;
grant execute on function public.att_adjust_bulk_mark_missed(text, uuid[], text) to authenticated;
