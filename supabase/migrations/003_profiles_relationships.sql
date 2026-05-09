-- ============================================================
-- WurxOS v2 — Migration 003: reports_to + permissions
--
-- Adds the parent/child relationship (APC→TL, IPC→PCTL, future OL→Boss etc.)
-- and a flexible permissions bag used by TL / PCTL to gate what they can do.
--
-- Safe to re-run.
-- ============================================================

-- --------------------------------------------------------------
-- 1. New columns
-- --------------------------------------------------------------
alter table public.profiles
  add column if not exists reports_to  uuid  references public.profiles(id) on delete set null,
  add column if not exists permissions jsonb not null default '{}'::jsonb;

create index if not exists profiles_reports_to_idx on public.profiles(reports_to);

-- --------------------------------------------------------------
-- 2. Trigger: honor reports_to + permissions from signup metadata
-- --------------------------------------------------------------
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_is_first     boolean;
  v_role         text;
  v_created_by   uuid;
  v_reports_to   uuid;
  v_permissions  jsonb;
begin
  select not exists (select 1 from public.profiles) into v_is_first;

  if v_is_first then
    v_role := 'boss';
  else
    v_role := coalesce(new.raw_user_meta_data->>'role', 'apc');
    if v_role = 'boss' then v_role := 'apc'; end if;
  end if;

  begin
    v_created_by := (new.raw_user_meta_data->>'created_by')::uuid;
  exception when others then v_created_by := null;
  end;

  begin
    v_reports_to := (new.raw_user_meta_data->>'reports_to')::uuid;
  exception when others then v_reports_to := null;
  end;

  begin
    v_permissions := coalesce((new.raw_user_meta_data->'permissions')::jsonb, '{}'::jsonb);
  exception when others then v_permissions := '{}'::jsonb;
  end;

  insert into public.profiles (id, email, display_name, role, created_by, reports_to, permissions)
  values (
    new.id,
    new.email,
    coalesce(new.raw_user_meta_data->>'display_name', split_part(new.email, '@', 1)),
    v_role,
    v_created_by,
    v_reports_to,
    v_permissions
  )
  on conflict (id) do nothing;
  return new;
end;
$$;
