-- ============================================================
-- WurxOS v2 — Migration 023: Custom responsibilities
--
-- Adds profiles.responsibilities (text[]) — a free-text tag list
-- describing what each user is responsible for. Populated from
-- user_metadata by handle_new_user, editable self-or-Boss via
-- existing profiles RLS.
--
-- Safe to re-run.
-- ============================================================

alter table public.profiles
  add column if not exists responsibilities text[] not null default '{}';

-- Extend the signup trigger so create-user can seed the list.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_meta        jsonb := coalesce(new.raw_user_meta_data, '{}'::jsonb);
  v_display     text  := coalesce(v_meta ->> 'display_name',
                                  split_part(new.email, '@', 1));
  v_role        text;
  v_created_by  uuid;
  v_reports_to  uuid;
  v_perm        jsonb := coalesce(v_meta -> 'permissions', '{}'::jsonb);
  v_resp        text[] := coalesce(
                    (select array_agg(value #>> '{}')
                     from jsonb_array_elements(
                       case jsonb_typeof(v_meta -> 'responsibilities')
                         when 'array' then v_meta -> 'responsibilities'
                         else '[]'::jsonb
                       end
                     ) value),
                    '{}'::text[]
                  );
begin
  -- If no profile exists yet, this is the very first user → Boss.
  if not exists (select 1 from public.profiles limit 1) then
    v_role := 'boss';
    v_created_by := null;
    v_reports_to := null;
  else
    v_role       := coalesce(v_meta ->> 'role', 'apc');
    v_created_by := nullif(v_meta ->> 'created_by', '')::uuid;
    v_reports_to := nullif(v_meta ->> 'reports_to', '')::uuid;
  end if;

  insert into public.profiles (
    id, email, display_name, role, created_by, reports_to,
    permissions, responsibilities
  ) values (
    new.id, new.email, v_display, v_role,
    v_created_by, v_reports_to, v_perm, v_resp
  );
  return new;
end;
$$;
