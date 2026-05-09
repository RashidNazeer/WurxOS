-- ============================================================
-- WurxOS v2 — Migration 030: Attendance
--
-- Adds:
--   * attendance table (one row per user per day)
--   * RPCs: clock_in, clock_out (APC/IPC → pending-approval, others → clocked-out),
--           start_break, end_break, approve_clock_out, reject_clock_out
--   * pg_cron: auto_clock_out_overdue_shifts() every 5 min (8h cap)
--   * RLS: self read/write; TL reads team (reports_to them); Boss/OL read all;
--          Boss/OL/TL decide approval for their reports
-- ============================================================

create table if not exists public.attendance (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null references public.profiles(id) on delete cascade,
  date           date not null,
  clock_in       timestamptz not null default now(),
  clock_out      timestamptz,
  location       text not null default 'wfh' check (location in ('wfh','bahria','lakecity','office')),
  status         text not null default 'clocked-in'
                   check (status in ('clocked-in','on-break','pending-approval','clocked-out')),
  breaks         jsonb not null default '[]'::jsonb,
  approval_by    uuid references public.profiles(id) on delete set null,
  approval_at    timestamptz,
  approval_note  text,
  auto_closed    boolean not null default false,
  total_work_ms  int,
  total_break_ms int,
  created_at     timestamptz not null default now(),
  unique (user_id, date)
);

create index if not exists attendance_user_date_idx on public.attendance(user_id, date desc);
create index if not exists attendance_status_idx    on public.attendance(status);

alter table public.attendance enable row level security;

-- SELECT: self; Boss/OL/dev all; TL → their direct reports
drop policy if exists "att_select" on public.attendance;
create policy "att_select"
  on public.attendance for select
  using (
    auth.uid() = user_id
    or public.is_boss(auth.uid())
    or exists (
      select 1 from public.profiles p
      where p.id = auth.uid() and p.role in ('ol','developer') and p.is_active = true
    )
    or exists (
      select 1 from public.profiles p
      where p.id = attendance.user_id and p.reports_to = auth.uid()
    )
  );

-- INSERT (clock-in) — self only
drop policy if exists "att_insert_self" on public.attendance;
create policy "att_insert_self"
  on public.attendance for insert
  with check (auth.uid() = user_id);

-- UPDATE — self (clock-out requests, breaks) OR approver (Boss/OL/TL-of-them)
drop policy if exists "att_update" on public.attendance;
create policy "att_update"
  on public.attendance for update
  using (
    auth.uid() = user_id
    or public.is_boss(auth.uid())
    or exists (
      select 1 from public.profiles p
      where p.id = auth.uid() and p.role in ('ol','developer') and p.is_active = true
    )
    or exists (
      select 1 from public.profiles p
      where p.id = attendance.user_id and p.reports_to = auth.uid()
    )
  );

-- --------------------------------------------------------------
-- RPCs
-- --------------------------------------------------------------
create or replace function public.att_clock_in(p_location text default 'wfh')
returns public.attendance
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid  uuid := auth.uid();
  v_row  public.attendance;
begin
  if v_uid is null then raise exception 'not authenticated'; end if;
  insert into public.attendance (user_id, date, location, status, clock_in)
  values (v_uid, current_date, p_location, 'clocked-in', now())
  on conflict (user_id, date) do update
    set status = 'clocked-in',
        clock_in = coalesce(public.attendance.clock_in, now()),
        location = excluded.location
    where public.attendance.clock_out is null
  returning * into v_row;
  return v_row;
end;
$$;
grant execute on function public.att_clock_in(text) to authenticated;

create or replace function public.att_request_clock_out()
returns public.attendance
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid  uuid := auth.uid();
  v_role text;
  v_row  public.attendance;
  v_end  timestamptz := now();
  v_new_status text;
begin
  select role into v_role from public.profiles where id = v_uid;
  -- APC/IPC need approval; everyone else clocks out directly
  v_new_status := case when v_role in ('apc','ipc') then 'pending-approval' else 'clocked-out' end;

  update public.attendance
     set status = v_new_status,
         clock_out = case when v_new_status = 'clocked-out' then v_end else clock_out end,
         total_work_ms = case when v_new_status = 'clocked-out'
                              then greatest(0, extract(epoch from (v_end - clock_in))::int * 1000
                                   - coalesce(total_break_ms, 0))
                              else total_work_ms end
   where user_id = v_uid and date = current_date
   returning * into v_row;
  return v_row;
end;
$$;
grant execute on function public.att_request_clock_out() to authenticated;

create or replace function public.att_approve_clock_out(p_id uuid, p_approve boolean, p_note text default null)
returns public.attendance
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row  public.attendance;
  v_end  timestamptz := now();
begin
  if p_approve then
    update public.attendance
       set status      = 'clocked-out',
           clock_out   = v_end,
           approval_by = auth.uid(),
           approval_at = v_end,
           approval_note = p_note,
           total_work_ms = greatest(0, extract(epoch from (v_end - clock_in))::int * 1000
                                     - coalesce(total_break_ms, 0))
     where id = p_id
     returning * into v_row;
  else
    update public.attendance
       set status        = 'clocked-in',
           approval_by   = auth.uid(),
           approval_at   = v_end,
           approval_note = p_note
     where id = p_id
     returning * into v_row;
  end if;
  return v_row;
end;
$$;
grant execute on function public.att_approve_clock_out(uuid, boolean, text) to authenticated;

create or replace function public.att_start_break()
returns public.attendance
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid  uuid := auth.uid();
  v_row  public.attendance;
  v_breaks jsonb;
begin
  select breaks into v_breaks from public.attendance
    where user_id = v_uid and date = current_date for update;
  v_breaks := coalesce(v_breaks, '[]'::jsonb)
              || jsonb_build_array(jsonb_build_object('start', now()));
  update public.attendance
     set breaks = v_breaks, status = 'on-break'
   where user_id = v_uid and date = current_date
   returning * into v_row;
  return v_row;
end;
$$;
grant execute on function public.att_start_break() to authenticated;

create or replace function public.att_end_break()
returns public.attendance
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid  uuid := auth.uid();
  v_row  public.attendance;
  v_breaks jsonb;
  v_last jsonb;
  v_start timestamptz;
  v_add_ms int;
begin
  select breaks into v_breaks from public.attendance
    where user_id = v_uid and date = current_date for update;
  if v_breaks is null or jsonb_array_length(v_breaks) = 0 then
    return null;
  end if;
  v_last := v_breaks -> (jsonb_array_length(v_breaks) - 1);
  v_start := (v_last ->> 'start')::timestamptz;
  v_add_ms := greatest(0, extract(epoch from (now() - v_start))::int * 1000);
  v_breaks := jsonb_set(v_breaks, array[(jsonb_array_length(v_breaks) - 1)::text], v_last || jsonb_build_object('end', now()));
  update public.attendance
     set breaks = v_breaks,
         total_break_ms = coalesce(total_break_ms, 0) + v_add_ms,
         status = 'clocked-in'
   where user_id = v_uid and date = current_date
   returning * into v_row;
  return v_row;
end;
$$;
grant execute on function public.att_end_break() to authenticated;

-- --------------------------------------------------------------
-- Auto clock-out: cap any open shift older than 8 hours
-- --------------------------------------------------------------
create or replace function public.auto_clock_out_overdue_shifts()
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.attendance;
  v_count int := 0;
  v_cap_end timestamptz;
begin
  for v_row in
    select * from public.attendance
    where clock_out is null
      and clock_in < now() - interval '8 hours'
      and status in ('clocked-in','on-break','pending-approval')
  loop
    v_cap_end := v_row.clock_in + interval '8 hours';
    update public.attendance
       set status = 'clocked-out',
           clock_out = v_cap_end,
           auto_closed = true,
           total_work_ms = greatest(0, 8 * 3600 * 1000 - coalesce(total_break_ms, 0))
     where id = v_row.id;
    v_count := v_count + 1;
  end loop;
  return v_count;
end;
$$;

do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    begin
      perform cron.unschedule('auto-clock-out-overdue');
    exception when others then null;
    end;
  end if;
end;
$$;
do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.schedule(
      'auto-clock-out-overdue',
      '*/5 * * * *',
      $cron$select public.auto_clock_out_overdue_shifts();$cron$
    );
  end if;
end;
$$;

-- --------------------------------------------------------------
-- Notification: ping approver when APC/IPC requests clock-out
-- --------------------------------------------------------------
create or replace function public.att_notify_approval()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_approver uuid;
  v_name     text;
begin
  if old.status is distinct from new.status and new.status = 'pending-approval' then
    select reports_to into v_approver from public.profiles where id = new.user_id;
    if v_approver is null then
      select id into v_approver from public.profiles
       where role = 'boss' and is_active = true order by created_at asc limit 1;
    end if;
    if v_approver is not null and v_approver <> new.user_id then
      v_name := public.profile_display_name(new.user_id);
      perform public.emit_notification(
        v_approver, new.user_id, 'system', 'attendance.approval_requested',
        'Clock-out approval needed',
        v_name || ' requested clock-out approval.',
        'attendance', new.id, '/attendance'
      );
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists att_notify_au on public.attendance;
create trigger att_notify_au
  after update of status on public.attendance
  for each row execute function public.att_notify_approval();
