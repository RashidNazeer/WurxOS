-- ============================================================
-- WurxOS v2 — Migration 001: profiles + RLS + auto-create trigger
--
-- Run this in the Supabase SQL Editor (Dashboard → SQL → New query).
-- Safe to re-run: uses IF NOT EXISTS / CREATE OR REPLACE where possible.
-- ============================================================

-- --------------------------------------------------------------
-- 1. profiles table
--    One row per auth.users row. Created automatically by trigger.
-- --------------------------------------------------------------
create table if not exists public.profiles (
  id            uuid primary key references auth.users(id) on delete cascade,
  email         text not null,
  display_name  text,
  role          text not null default 'apc'
                  check (role in ('boss','ol','tl','pctl','apc','ipc','developer')),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create index if not exists profiles_role_idx on public.profiles(role);

-- --------------------------------------------------------------
-- 2. updated_at auto-touch
-- --------------------------------------------------------------
create or replace function public.touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists profiles_touch_updated_at on public.profiles;
create trigger profiles_touch_updated_at
  before update on public.profiles
  for each row execute function public.touch_updated_at();

-- --------------------------------------------------------------
-- 3. Auto-create profile when a new auth.users row is inserted.
--
--    The flow in WurxOS:
--      * The first-ever signup is the Boss bootstrap → role = 'boss'.
--      * All subsequent users are created BY the Boss from the admin
--        panel (M2) — they should never reach this trigger via
--        self-signup. As a defensive guard we default them to 'apc'
--        but you should disable self-signup in the UI once a Boss
--        exists. SignupPage already enforces this.
-- --------------------------------------------------------------
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_is_first  boolean;
  v_role      text;
begin
  select not exists (select 1 from public.profiles) into v_is_first;
  v_role := case when v_is_first then 'boss' else 'apc' end;

  insert into public.profiles (id, email, display_name, role)
  values (
    new.id,
    new.email,
    coalesce(new.raw_user_meta_data->>'display_name', split_part(new.email, '@', 1)),
    v_role
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- --------------------------------------------------------------
-- 4. Row Level Security
--    Users can read and update their own profile only.
--    Role changes will be locked down in a later migration
--    (Boss-only via admin policy). For now the CHECK constraint
--    limits values but any logged-in user can update their own row.
-- --------------------------------------------------------------
alter table public.profiles enable row level security;

drop policy if exists "profiles_select_own" on public.profiles;
create policy "profiles_select_own"
  on public.profiles for select
  using (auth.uid() = id);

drop policy if exists "profiles_update_own" on public.profiles;
create policy "profiles_update_own"
  on public.profiles for update
  using (auth.uid() = id)
  with check (auth.uid() = id);

-- Insert is handled by the trigger with security definer; block direct inserts.
drop policy if exists "profiles_insert_block" on public.profiles;
create policy "profiles_insert_block"
  on public.profiles for insert
  with check (false);

-- --------------------------------------------------------------
-- 5. Bootstrap status check
--    A tiny security-definer function that anyone (incl. anon)
--    can call to find out whether the Boss has been created yet.
--    Used by the Signup page to gate itself.
-- --------------------------------------------------------------
create or replace function public.boss_exists()
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists (select 1 from public.profiles where role = 'boss');
$$;

grant execute on function public.boss_exists() to anon, authenticated;

-- ============================================================
-- Done. Verify with:
--   select * from public.profiles;
-- After the first signup a Boss row should appear automatically.
-- ============================================================
