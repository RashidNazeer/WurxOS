-- ============================================================
-- WurxOS v2 — Migration 002: profiles admin capabilities
--
-- Adds:
--   * is_active + created_by columns
--   * is_boss() helper for RLS
--   * Boss-admin RLS policies (Boss can SELECT / UPDATE all profiles)
--   * Updated handle_new_user trigger: honors role passed via
--     signup metadata (used by the create-user Edge Function)
--     but still bootstraps the very first user as 'boss'.
--
-- Safe to re-run.
-- ============================================================

-- --------------------------------------------------------------
-- 1. New columns
-- --------------------------------------------------------------
alter table public.profiles
  add column if not exists is_active  boolean     not null default true,
  add column if not exists created_by uuid        references auth.users(id) on delete set null;

create index if not exists profiles_is_active_idx on public.profiles(is_active);

-- --------------------------------------------------------------
-- 2. is_boss() helper
--    security definer so it can read profiles regardless of RLS.
--    Used inside RLS policies without causing recursion because
--    it runs with owner privileges.
-- --------------------------------------------------------------
create or replace function public.is_boss(uid uuid)
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists (
    select 1 from public.profiles
    where id = uid and role = 'boss' and is_active = true
  );
$$;

grant execute on function public.is_boss(uuid) to anon, authenticated;

-- --------------------------------------------------------------
-- 3. Updated handle_new_user trigger
--    * First-ever user = boss bootstrap (ignores metadata role).
--    * Otherwise: use metadata role if present, else default 'apc'.
--    * Also copies created_by from metadata (set by Edge Function).
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
  v_created_by uuid;
begin
  select not exists (select 1 from public.profiles) into v_is_first;

  if v_is_first then
    v_role := 'boss';
  else
    v_role := coalesce(new.raw_user_meta_data->>'role', 'apc');
    -- guard: never promote to boss through metadata
    if v_role = 'boss' then v_role := 'apc'; end if;
  end if;

  begin
    v_created_by := (new.raw_user_meta_data->>'created_by')::uuid;
  exception when others then
    v_created_by := null;
  end;

  insert into public.profiles (id, email, display_name, role, created_by)
  values (
    new.id,
    new.email,
    coalesce(new.raw_user_meta_data->>'display_name', split_part(new.email, '@', 1)),
    v_role,
    v_created_by
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

-- --------------------------------------------------------------
-- 4. RLS policies — admin capabilities for Boss
-- --------------------------------------------------------------
-- SELECT: self OR boss sees all
drop policy if exists "profiles_select_own" on public.profiles;
drop policy if exists "profiles_select_self_or_boss" on public.profiles;
create policy "profiles_select_self_or_boss"
  on public.profiles for select
  using (auth.uid() = id or public.is_boss(auth.uid()));

-- UPDATE: self OR boss (Boss can change role/is_active/display_name of anyone)
drop policy if exists "profiles_update_own" on public.profiles;
drop policy if exists "profiles_update_self_or_boss" on public.profiles;
create policy "profiles_update_self_or_boss"
  on public.profiles for update
  using (auth.uid() = id or public.is_boss(auth.uid()))
  with check (auth.uid() = id or public.is_boss(auth.uid()));

-- INSERT remains blocked — only the trigger (security definer) inserts.
-- Leave the existing "profiles_insert_block" policy in place.
