-- ============================================================
-- WurxOS v2 — Migration 164: company holidays
--
-- Boss can declare company-wide holidays (Eid, etc.). On a holiday
-- date, attendance counts as present for everyone — no clock-in
-- needed, no penalty in performance scoring, and any leave request
-- that overlaps a holiday won't charge those days against the
-- user's quota.
--
-- Schema mirrors leave_requests for symmetry: a single row covers
-- a date range with a human label and optional notes.
--
-- Idempotent.
-- ============================================================

create table if not exists public.company_holidays (
  id           uuid        primary key default gen_random_uuid(),
  start_date   date        not null,
  end_date     date        not null,
  label        text        not null,
  notes        text        null,
  created_by   uuid        null references public.profiles(id) on delete set null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  constraint company_holidays_range_valid check (end_date >= start_date)
);

create index if not exists company_holidays_start_idx on public.company_holidays(start_date);
create index if not exists company_holidays_end_idx   on public.company_holidays(end_date);

-- Keep updated_at fresh.
create or replace function public._touch_company_holidays() returns trigger
language plpgsql as $$
begin new.updated_at := now(); return new; end;
$$;
drop trigger if exists trg_company_holidays_touch on public.company_holidays;
create trigger trg_company_holidays_touch
  before update on public.company_holidays
  for each row execute function public._touch_company_holidays();

alter table public.company_holidays enable row level security;

-- Read: any authenticated user (attendance UI and leave form need to see them).
drop policy if exists holidays_select_all on public.company_holidays;
create policy holidays_select_all
  on public.company_holidays for select
  to authenticated
  using (true);

-- Write: Boss only.
drop policy if exists holidays_write_boss on public.company_holidays;
create policy holidays_write_boss
  on public.company_holidays for all
  to authenticated
  using (
    exists (
      select 1 from public.profiles p
      where p.id = auth.uid()
        and lower(coalesce(p.role, '')) = 'boss'
    )
  )
  with check (
    exists (
      select 1 from public.profiles p
      where p.id = auth.uid()
        and lower(coalesce(p.role, '')) = 'boss'
    )
  );

-- ------------------------------------------------------------
-- Holiday membership helper. Returns true if `p_date` falls inside
-- any company_holidays row. Used by _leave_working_days below and
-- can be called from the client for ad-hoc checks.
-- ------------------------------------------------------------
create or replace function public._is_company_holiday(p_date date)
returns boolean
language sql
stable
set search_path = public
as $$
  select exists (
    select 1 from public.company_holidays
     where p_date between start_date and end_date
  );
$$;
grant execute on function public._is_company_holiday(date) to authenticated;

-- ------------------------------------------------------------
-- Update _leave_working_days (mig 159) to also exclude company
-- holidays. Volatility drops from immutable -> stable because the
-- function now reads a table. CREATE OR REPLACE permits this
-- change in Postgres 14+.
--
-- This automatically corrects future leave_requests inserts:
-- consumed_leaves_month, consumed_leaves, and the BEFORE INSERT
-- trigger (leave_compute_paid_days) all call this helper, so a
-- leave that overlaps a holiday will compute fewer paid/unpaid days
-- without any further changes.
-- ------------------------------------------------------------
create or replace function public._leave_working_days(p_start date, p_end date)
returns numeric
language sql
stable
set search_path = public
as $$
  select coalesce(count(*), 0)::numeric
  from generate_series(p_start, p_end, interval '1 day') d
  where extract(isodow from d) between 1 and 5
    and not public._is_company_holiday(d::date);
$$;
grant execute on function public._leave_working_days(date, date) to authenticated;
