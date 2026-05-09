-- ============================================================
-- Migration 059 — Incentives verification + payout + reset/roll
--
-- Adds to public.incentives:
--   verified_by / verified_at         — who marked verified and when
--   payout_cleared_by / payout_cleared_at
--   notified / notified_at            — sent the employee a ping
--
-- RPCs:
--   inc_verify(p_id, p_verified)      — Boss / OL / dev flip verified
--   inc_clear_payout(p_id, p_cleared) — flip payout_cleared (needs verified=true)
--   inc_notify_employee(p_id)         — mark notified + emit notification
--   inc_reset_and_roll(p_source, p_target)
--     → for every row in source month, mark payout_cleared (so it's
--       finalized), then for each user, create a new row in target
--       month carrying over basic_salary + incentives/bonuses line
--       items with achievedValue reset to 0 and completed = false.
--
-- Also loosens RLS so the target user's direct-report manager
-- (profiles.reports_to) can UPDATE the row to help track progress,
-- while the existing guard still blocks them from flipping admin-
-- only fields.
-- ============================================================

alter table public.incentives
  add column if not exists verified_by        uuid references public.profiles(id) on delete set null,
  add column if not exists verified_at        timestamptz,
  add column if not exists payout_cleared_by  uuid references public.profiles(id) on delete set null,
  add column if not exists payout_cleared_at  timestamptz,
  add column if not exists notified           boolean not null default false,
  add column if not exists notified_at        timestamptz;

-- --------------------------------------------------------------
-- RLS: also allow the direct-report manager to UPDATE incentives.
-- The guard still prevents them from flipping admin-only columns.
-- --------------------------------------------------------------
drop policy if exists "inc_update" on public.incentives;
create policy "inc_update"
  on public.incentives for update
  using (
    auth.uid() = user_id
    or public.is_boss(auth.uid())
    or exists (select 1 from public.profiles p where p.id = auth.uid() and p.role in ('ol','developer') and p.is_active = true)
    or exists (select 1 from public.profiles p where p.id = incentives.user_id and p.reports_to = auth.uid())
  )
  with check (
    auth.uid() = user_id
    or public.is_boss(auth.uid())
    or exists (select 1 from public.profiles p where p.id = auth.uid() and p.role in ('ol','developer') and p.is_active = true)
    or exists (select 1 from public.profiles p where p.id = incentives.user_id and p.reports_to = auth.uid())
  );

-- Guard tightened: direct-report manager allowed through UPDATE but
-- still cannot flip verified / payout_cleared / basic_salary.
-- payout_cleared may only flip when verified = true.
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
    if new.verified         is distinct from old.verified         then raise exception 'only admin can verify'; end if;
    if new.payout_cleared   is distinct from old.payout_cleared   then raise exception 'only admin can clear payout'; end if;
    if new.basic_salary     is distinct from old.basic_salary     then raise exception 'only admin can edit salary'; end if;
  end if;

  -- Cannot flip payout_cleared unless the row is also verified.
  if new.payout_cleared is true and new.verified is false then
    raise exception 'cannot clear payout before verification';
  end if;

  -- Stamp verified_by / cleared_by on the transition
  if old.verified is distinct from new.verified and new.verified then
    new.verified_by := auth.uid();
    new.verified_at := now();
  end if;
  if old.payout_cleared is distinct from new.payout_cleared and new.payout_cleared then
    new.payout_cleared_by := auth.uid();
    new.payout_cleared_at := now();
  end if;

  return new;
end;
$$;

drop trigger if exists incentives_guard on public.incentives;
create trigger incentives_guard
  before update on public.incentives
  for each row execute function public.incentives_guard();

-- --------------------------------------------------------------
-- inc_verify — admin flips verified on/off. On turn-on, emit a
-- notification to the employee. Turning off also undoes payout
-- cleared.
-- --------------------------------------------------------------
create or replace function public.inc_verify(p_id uuid, p_verified boolean)
returns public.incentives
language plpgsql
security definer
set search_path = public
as $$
declare
  v_me  uuid := auth.uid();
  v_row public.incentives;
begin
  if not (public.is_boss(v_me) or exists (
    select 1 from public.profiles p where p.id = v_me and p.role in ('ol','developer') and p.is_active = true
  )) then raise exception 'only Boss/OL can verify'; end if;

  update public.incentives
     set verified       = p_verified,
         payout_cleared = case when p_verified then payout_cleared else false end
   where id = p_id
   returning * into v_row;
  if not found then raise exception 'incentives row not found'; end if;

  if p_verified then
    perform public.emit_notification(
      v_row.user_id, v_me, 'system', 'incentives.verified',
      'Incentives verified',
      'Your ' || v_row.month || ' incentives have been verified.',
      'incentives', v_row.id, '/incentives'
    );
  end if;

  return v_row;
end;
$$;
grant execute on function public.inc_verify(uuid, boolean) to authenticated;

-- --------------------------------------------------------------
-- inc_clear_payout — admin flips payout_cleared on/off. Row must
-- be verified first. Emits a notification on turn-on.
-- --------------------------------------------------------------
create or replace function public.inc_clear_payout(p_id uuid, p_cleared boolean)
returns public.incentives
language plpgsql
security definer
set search_path = public
as $$
declare
  v_me  uuid := auth.uid();
  v_row public.incentives;
begin
  if not (public.is_boss(v_me) or exists (
    select 1 from public.profiles p where p.id = v_me and p.role in ('ol','developer') and p.is_active = true
  )) then raise exception 'only Boss/OL can clear payout'; end if;

  update public.incentives
     set payout_cleared = p_cleared
   where id = p_id
   returning * into v_row;
  if not found then raise exception 'incentives row not found'; end if;

  if p_cleared then
    perform public.emit_notification(
      v_row.user_id, v_me, 'system', 'incentives.paid',
      'Payout cleared',
      'Your ' || v_row.month || ' payout has been cleared.',
      'incentives', v_row.id, '/incentives'
    );
  end if;

  return v_row;
end;
$$;
grant execute on function public.inc_clear_payout(uuid, boolean) to authenticated;

-- --------------------------------------------------------------
-- inc_notify_employee — explicit ping, e.g. after manager first
-- drafts an incentive structure. Marks notified + emits notification.
-- --------------------------------------------------------------
create or replace function public.inc_notify_employee(p_id uuid)
returns public.incentives
language plpgsql
security definer
set search_path = public
as $$
declare
  v_me  uuid := auth.uid();
  v_row public.incentives;
begin
  if not (public.is_boss(v_me) or exists (
    select 1 from public.profiles p where p.id = v_me and p.role in ('ol','developer') and p.is_active = true
  ) or exists (
    select 1 from public.incentives i join public.profiles p on p.id = i.user_id
    where i.id = p_id and p.reports_to = v_me
  )) then raise exception 'not authorized'; end if;

  update public.incentives
     set notified    = true,
         notified_at = now()
   where id = p_id
   returning * into v_row;
  if not found then raise exception 'incentives row not found'; end if;

  perform public.emit_notification(
    v_row.user_id, v_me, 'system', 'incentives.assigned',
    'Incentives updated',
    'Your ' || v_row.month || ' incentives have been updated — review your progress.',
    'incentives', v_row.id, '/incentives'
  );

  return v_row;
end;
$$;
grant execute on function public.inc_notify_employee(uuid) to authenticated;

-- --------------------------------------------------------------
-- inc_reset_and_roll — end-of-month workflow. Marks every source-
-- month row as payout_cleared (if verified) and creates matching
-- target-month rows carrying over the incentive/bonus structure
-- with achieved values reset to 0 and completed = false.
--
-- Only Boss can run this. Returns the count of rolled rows.
-- --------------------------------------------------------------
create or replace function public.inc_reset_and_roll(
  p_source text,  -- "YYYY-MM"
  p_target text,  -- "YYYY-MM"
  p_force_clear boolean default false  -- clear even if not verified
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_me      uuid := auth.uid();
  v_source  record;
  v_cleared int := 0;
  v_created int := 0;
  v_skipped int := 0;
  v_items   jsonb;
  v_bonuses jsonb;
begin
  if not public.is_boss(v_me) then raise exception 'only Boss can reset & roll'; end if;
  if p_source is null or p_target is null then raise exception 'source & target month required'; end if;
  if p_source = p_target then raise exception 'source and target must differ'; end if;

  for v_source in select * from public.incentives where month = p_source loop
    -- Step 1: mark source row payout_cleared (if verified or forced)
    if v_source.verified or p_force_clear then
      update public.incentives
         set payout_cleared    = true,
             payout_cleared_by = v_me,
             payout_cleared_at = now()
       where id = v_source.id;
      v_cleared := v_cleared + 1;
    else
      v_skipped := v_skipped + 1;
    end if;

    -- Step 2: prepare target-month items (zero out achieved + completed)
    v_items := coalesce((
      select jsonb_agg(
        jsonb_set(
          jsonb_set(it::jsonb, '{achievedValue}', '0'::jsonb),
          '{completed}', 'false'::jsonb
        )
      )
      from jsonb_array_elements(v_source.incentives) it
    ), '[]'::jsonb);

    v_bonuses := coalesce((
      select jsonb_agg(
        jsonb_set(
          jsonb_set(it::jsonb, '{achievedValue}', '0'::jsonb),
          '{completed}', 'false'::jsonb
        )
      )
      from jsonb_array_elements(v_source.bonuses) it
    ), '[]'::jsonb);

    -- Step 3: insert target-month row (skip if already exists)
    insert into public.incentives
      (user_id, month, basic_salary, incentives, bonuses, last_updated_by, updated_at)
    values
      (v_source.user_id, p_target, v_source.basic_salary, v_items, v_bonuses, v_me, now())
    on conflict (user_id, month) do nothing;

    if found then v_created := v_created + 1; end if;
  end loop;

  return jsonb_build_object(
    'cleared', v_cleared,
    'created', v_created,
    'skipped', v_skipped
  );
end;
$$;
grant execute on function public.inc_reset_and_roll(text, text, boolean) to authenticated;
