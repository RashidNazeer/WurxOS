-- ============================================================
-- WurxOS v2 — Migration 033: Bonus & Incentives
--
-- One row per (user, month). Line items are stored inline as jsonb
-- arrays (incentives / bonuses). Each item:
--   { id, text, amount, targetValue, achievedValue, suffix, completed }
--
-- Auto-complete rule: achieved/target ≥ 0.9 → completed = true
-- (applied client-side on save; kept as a flag in the row).
-- ============================================================

create table if not exists public.incentives (
  id                  uuid primary key default gen_random_uuid(),
  user_id             uuid not null references public.profiles(id) on delete cascade,
  month               text not null,   -- "YYYY-MM"
  basic_salary        numeric not null default 0,
  incentives          jsonb not null default '[]'::jsonb,
  bonuses             jsonb not null default '[]'::jsonb,
  verified            boolean not null default false,
  payout_cleared      boolean not null default false,
  last_updated_by     uuid references public.profiles(id) on delete set null,
  updated_at          timestamptz not null default now(),
  created_at          timestamptz not null default now(),
  unique (user_id, month)
);

create index if not exists incentives_user_month_idx on public.incentives(user_id, month desc);

alter table public.incentives enable row level security;

-- SELECT: self, Boss, OL/dev, manager (reports_to)
drop policy if exists "inc_select" on public.incentives;
create policy "inc_select"
  on public.incentives for select
  using (
    auth.uid() = user_id
    or public.is_boss(auth.uid())
    or exists (select 1 from public.profiles p where p.id = auth.uid() and p.role in ('ol','developer') and p.is_active = true)
    or exists (select 1 from public.profiles p where p.id = incentives.user_id and p.reports_to = auth.uid())
  );

-- INSERT / UPDATE: Boss, OL/dev full; the target user may UPDATE their row
-- (to record progress on achievedValue) but may NOT flip verified/payout_cleared.
drop policy if exists "inc_insert" on public.incentives;
create policy "inc_insert"
  on public.incentives for insert
  with check (
    public.is_boss(auth.uid())
    or exists (select 1 from public.profiles p where p.id = auth.uid() and p.role in ('ol','developer') and p.is_active = true)
  );

drop policy if exists "inc_update" on public.incentives;
create policy "inc_update"
  on public.incentives for update
  using (
    auth.uid() = user_id
    or public.is_boss(auth.uid())
    or exists (select 1 from public.profiles p where p.id = auth.uid() and p.role in ('ol','developer') and p.is_active = true)
  )
  with check (
    auth.uid() = user_id
    or public.is_boss(auth.uid())
    or exists (select 1 from public.profiles p where p.id = auth.uid() and p.role in ('ol','developer') and p.is_active = true)
  );

-- Guard: non-admin users cannot flip verified / payout_cleared / basic_salary
create or replace function public.incentives_guard()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_is_admin bool := public.is_boss(auth.uid()) or exists (
    select 1 from public.profiles p
    where p.id = auth.uid() and p.role in ('ol','developer') and p.is_active = true
  );
begin
  if not v_is_admin then
    if new.verified       is distinct from old.verified       then raise exception 'only admin can verify'; end if;
    if new.payout_cleared is distinct from old.payout_cleared then raise exception 'only admin can clear payout'; end if;
    if new.basic_salary   is distinct from old.basic_salary   then raise exception 'only admin can edit salary'; end if;
  end if;
  return new;
end;
$$;

drop trigger if exists incentives_guard on public.incentives;
create trigger incentives_guard
  before update on public.incentives
  for each row execute function public.incentives_guard();
