-- ============================================================
-- WurxOS v2 — Migration 430: OL removes a flag directly, with a reason
--
-- Until now an OL could only ask the Boss to remove a flag they created
-- (mig 152). An OL may now remove ANY flag — on a TL, APC or IPC —
-- straight away, as long as they give a reason.
--
-- performance_flags rows are hard-deleted (the month's score recovers
-- because it is summed over existing rows), so the reason and a snapshot
-- of the flag are kept in flag_removal_log. A pending Boss request for the
-- same flag is deleted with it (flag_removal_requests cascades).
-- ============================================================

create table if not exists public.flag_removal_log (
  id             uuid primary key default gen_random_uuid(),
  flag_id        uuid not null,
  user_id        uuid not null references public.profiles(id) on delete cascade, -- the flagged user
  flag_type      text not null,
  flag_severity  text,
  flag_reason    text,
  flag_created_by uuid references public.profiles(id) on delete set null,
  flag_created_at timestamptz,
  removed_by     uuid not null references public.profiles(id) on delete restrict,
  removal_reason text not null,
  removed_at     timestamptz not null default now()
);

create index if not exists flag_removal_log_user_idx on public.flag_removal_log(user_id, removed_at desc);
create index if not exists flag_removal_log_by_idx   on public.flag_removal_log(removed_by, removed_at desc);

alter table public.flag_removal_log enable row level security;

drop policy if exists "flag_removal_log_select" on public.flag_removal_log;
create policy "flag_removal_log_select"
  on public.flag_removal_log for select
  using (
    auth.uid() = removed_by
    or auth.uid() = user_id
    or public.is_boss(auth.uid())
    or exists (select 1 from public.profiles p
                where p.id = auth.uid() and p.role = 'ol' and p.is_active = true)
  );

-- Written only by flag_remove_by_ol below.
drop policy if exists "flag_removal_log_no_direct_write" on public.flag_removal_log;
create policy "flag_removal_log_no_direct_write"
  on public.flag_removal_log for all
  using (false)
  with check (false);

create or replace function public.flag_remove_by_ol(
  p_flag_id uuid,
  p_reason  text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_me   uuid := auth.uid();
  v_flag public.performance_flags;
  v_reason text := trim(coalesce(p_reason, ''));
  v_name text;
begin
  if v_me is null then raise exception 'not authenticated'; end if;

  if not exists (select 1 from public.profiles
                  where id = v_me and role = 'ol' and is_active = true and deleted_at is null) then
    raise exception 'only an OL may remove a flag this way';
  end if;

  if length(v_reason) < 3 then
    raise exception 'reason is required (min 3 characters)';
  end if;

  select * into v_flag from public.performance_flags where id = p_flag_id for update;
  if not found then raise exception 'flag not found'; end if;

  insert into public.flag_removal_log (
    flag_id, user_id, flag_type, flag_severity, flag_reason,
    flag_created_by, flag_created_at, removed_by, removal_reason
  ) values (
    v_flag.id, v_flag.user_id, v_flag.type, v_flag.severity, v_flag.reason,
    v_flag.created_by, v_flag.created_at, v_me, v_reason
  );

  delete from public.performance_flags where id = p_flag_id;

  v_name := coalesce(public.profile_display_name(v_me), 'An OL');

  -- Flagged user, the TL/OL who raised the flag (if someone else), and Boss.
  perform public.emit_notification(
    r.id, v_me, 'flag_removal', 'flag_removal.applied',
    'A flag was removed',
    case when r.id = v_flag.user_id
      then 'A flag on your performance was removed by ' || v_name || '. Reason: ' || v_reason
      else v_name || ' removed a flag on '
           || coalesce(public.profile_display_name(v_flag.user_id), 'a teammate')
           || '. Reason: ' || v_reason
    end,
    'flag', p_flag_id, '/performance'
  )
  from (
    select v_flag.user_id as id
    union
    select v_flag.created_by where v_flag.created_by is not null
    union
    select b.id from public.profiles b where b.role = 'boss' and b.is_active = true
  ) r
  where r.id <> v_me;
end;
$$;

grant execute on function public.flag_remove_by_ol(uuid, text) to authenticated;
