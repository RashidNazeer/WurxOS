-- ============================================================
-- Migration 058 — Apply live leave-quota default on profile insert
--
-- The profiles.leave_quota column has a static default, so changes
-- to the Boss-managed app_config['leave_quota_default'] don't flow
-- through to newly created profiles. This trigger closes that gap:
-- on insert, if leave_quota wasn't explicitly overridden, pull the
-- current default from app_config.
-- ============================================================

create or replace function public.apply_leave_quota_default()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_default jsonb;
begin
  -- Only populate when the caller left it blank/default-ish.
  -- The hard column default is {wfh:2,medical:1,emergency:1}; if the
  -- caller sent a different object, respect it.
  if new.leave_quota is null
     or new.leave_quota = '{}'::jsonb
     or new.leave_quota = '{"wfh":2,"medical":1,"emergency":1}'::jsonb then
    select value::jsonb into v_default
      from public.app_config
     where key = 'leave_quota_default';
    if v_default is not null then
      new.leave_quota := v_default;
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists apply_leave_quota_default_bi on public.profiles;
create trigger apply_leave_quota_default_bi
  before insert on public.profiles
  for each row execute function public.apply_leave_quota_default();
