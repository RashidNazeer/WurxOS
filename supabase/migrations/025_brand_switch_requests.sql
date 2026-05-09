-- ============================================================
-- WurxOS v2 — Migration 025: Brand TL switch-approval workflow
--
-- OLs can edit brands but cannot unilaterally change owner_id.
-- They open a brand_switch_requests row; Boss approves/rejects.
-- Approval triggers the actual owner_id update.
--
-- Adds:
--   * brand_switch_requests table + RLS
--   * brands BEFORE UPDATE trigger: block owner_id change except
--     by Boss or by the approval trigger itself (flagged via GUC).
--   * Notification triggers on submit + decision
--   * On approval: swap brands.owner_id
--
-- Safe to re-run.
-- ============================================================

-- --------------------------------------------------------------
-- 1. brand_switch_requests
-- --------------------------------------------------------------
create table if not exists public.brand_switch_requests (
  id             uuid primary key default gen_random_uuid(),
  brand_id       uuid not null references public.brands(id) on delete cascade,
  from_owner_id  uuid references public.profiles(id) on delete set null,
  to_owner_id    uuid not null references public.profiles(id) on delete cascade,
  requested_by   uuid not null references public.profiles(id) on delete set null,
  reason         text not null default '',
  status         text not null default 'pending'
                   check (status in ('pending', 'approved', 'rejected', 'cancelled')),
  decided_by     uuid references public.profiles(id) on delete set null,
  decided_at     timestamptz,
  decision_note  text,
  created_at     timestamptz not null default now()
);

create index if not exists bsr_brand_idx    on public.brand_switch_requests(brand_id);
create index if not exists bsr_status_idx   on public.brand_switch_requests(status);
create index if not exists bsr_requester_idx on public.brand_switch_requests(requested_by);

alter table public.brand_switch_requests enable row level security;

-- SELECT — requester, Boss, and OL/dev see everything relevant
drop policy if exists "bsr_select" on public.brand_switch_requests;
create policy "bsr_select"
  on public.brand_switch_requests for select
  using (
    auth.uid() = requested_by
    or public.is_boss(auth.uid())
    or exists (
      select 1 from public.profiles p
      where p.id = auth.uid() and p.role in ('ol', 'developer') and p.is_active = true
    )
  );

-- INSERT — OL (or Boss) only; must target a real active TL
drop policy if exists "bsr_insert" on public.brand_switch_requests;
create policy "bsr_insert"
  on public.brand_switch_requests for insert
  with check (
    requested_by = auth.uid()
    and status = 'pending'
    and (
      public.is_boss(auth.uid())
      or exists (
        select 1 from public.profiles p
        where p.id = auth.uid() and p.role = 'ol' and p.is_active = true
      )
    )
    and exists (
      select 1 from public.profiles tl
      where tl.id = to_owner_id and tl.role = 'tl' and tl.is_active = true
    )
  );

-- UPDATE — requester can cancel own pending; Boss decides
drop policy if exists "bsr_update" on public.brand_switch_requests;
create policy "bsr_update"
  on public.brand_switch_requests for update
  using (
    (auth.uid() = requested_by and status = 'pending')
    or public.is_boss(auth.uid())
  )
  with check (
    (auth.uid() = requested_by and status in ('pending', 'cancelled'))
    or public.is_boss(auth.uid())
  );

-- --------------------------------------------------------------
-- 2. Block non-Boss from changing brands.owner_id directly
-- --------------------------------------------------------------
create or replace function public.brands_block_owner_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_bypass text := current_setting('wurxos.bypass_owner_guard', true);
begin
  if old.owner_id is distinct from new.owner_id
     and coalesce(v_bypass, 'off') <> 'on'
     and not public.is_boss(auth.uid()) then
    raise exception 'Only Boss can reassign a brand''s TL. Submit a switch request instead.'
      using errcode = 'P0007';
  end if;
  return new;
end;
$$;

drop trigger if exists brands_block_owner_change on public.brands;
create trigger brands_block_owner_change
  before update of owner_id on public.brands
  for each row execute function public.brands_block_owner_change();

-- --------------------------------------------------------------
-- 3. Notification + auto-apply on decision
-- --------------------------------------------------------------
create or replace function public.bsr_notify_on_insert()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_boss uuid;
  v_brand text;
  v_name  text;
begin
  select brand_name into v_brand from public.brands where id = new.brand_id;
  v_name := coalesce(public.profile_display_name(new.requested_by), 'Someone');

  -- Notify every active Boss
  for v_boss in select id from public.profiles where role = 'boss' and is_active = true loop
    perform public.emit_notification(
      v_boss, new.requested_by, 'brand', 'brand.switch_requested',
      'Brand switch requested',
      v_name || ' proposed reassigning brand "' || coalesce(v_brand, '?') || '".',
      'brand', new.brand_id, '/boss/brand-switches'
    );
  end loop;
  return new;
end;
$$;

drop trigger if exists bsr_notify_ai on public.brand_switch_requests;
create trigger bsr_notify_ai
  after insert on public.brand_switch_requests
  for each row execute function public.bsr_notify_on_insert();

create or replace function public.bsr_apply_decision()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor uuid := auth.uid();
  v_brand text;
begin
  if old.status is distinct from new.status and new.status = 'approved' then
    -- Flip the owner through the guard using a per-statement GUC.
    perform set_config('wurxos.bypass_owner_guard', 'on', true);
    update public.brands set owner_id = new.to_owner_id where id = new.brand_id;
    perform set_config('wurxos.bypass_owner_guard', 'off', true);

    select brand_name into v_brand from public.brands where id = new.brand_id;
    perform public.emit_notification(
      new.requested_by, v_actor, 'brand', 'brand.switch_approved',
      'Brand switch approved',
      'Your switch request for "' || coalesce(v_brand, '?') || '" was approved.',
      'brand', new.brand_id, '/brands'
    );
  elsif old.status is distinct from new.status and new.status = 'rejected' then
    select brand_name into v_brand from public.brands where id = new.brand_id;
    perform public.emit_notification(
      new.requested_by, v_actor, 'brand', 'brand.switch_rejected',
      'Brand switch rejected',
      'Your switch request for "' || coalesce(v_brand, '?') || '" was rejected.',
      'brand', new.brand_id, '/brands'
    );
  end if;
  return new;
end;
$$;

drop trigger if exists bsr_decision_au on public.brand_switch_requests;
create trigger bsr_decision_au
  after update of status on public.brand_switch_requests
  for each row execute function public.bsr_apply_decision();
