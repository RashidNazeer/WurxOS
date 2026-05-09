-- ============================================================
-- WurxOS v2 — Migration 046: APC-oriented brand switch requests
--
-- Migration 025 set up brand_switch_requests as a TL-ownership
-- approval workflow (to_owner_id = new TL). Migration 045 replaced
-- that model with brand_switch_apc(p_brand, p_new_apc, p_note),
-- which moves the APC, retargets the TL to the new APC's manager,
-- reassigns open tasks, and fans out notifications in one call.
--
-- This migration retrofits brand_switch_requests so that OLs (and
-- any role without direct switch authority) can propose an APC move
-- and Boss approves it — approval simply invokes brand_switch_apc().
--
-- Steps:
--   1. Add to_apc_id column; allow to_owner_id to be null so new
--      rows can skip it. Legacy rows remain untouched.
--   2. Relax RLS insert check to accept APC targets (APC/IPC with
--      a Team Lead), keeping the legacy TL-target branch for any
--      in-flight rows.
--   3. Rewrite the approval trigger: when to_apc_id is set we call
--      brand_switch_apc(); otherwise we fall back to the legacy
--      owner_id flip.
--   4. Repoint the insert-side notification to the unified page.
-- ============================================================

alter table public.brand_switch_requests
  add column if not exists to_apc_id uuid references public.profiles(id) on delete cascade;

alter table public.brand_switch_requests
  alter column to_owner_id drop not null;

create index if not exists bsr_to_apc_idx on public.brand_switch_requests(to_apc_id);

-- --------------------------------------------------------------
-- RLS insert: APC target (canonical) OR legacy TL target
-- --------------------------------------------------------------
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
        where p.id = auth.uid() and p.role in ('ol','developer') and p.is_active = true
      )
    )
    and (
      -- New canonical shape: APC-switch request.
      (
        to_apc_id is not null
        and exists (
          select 1 from public.profiles apc
          where apc.id = to_apc_id
            and apc.role in ('apc','ipc')
            and apc.is_active = true
            and apc.reports_to is not null
        )
      )
      -- Legacy: TL-ownership change request (kept for compatibility).
      or (
        to_owner_id is not null
        and exists (
          select 1 from public.profiles tl
          where tl.id = to_owner_id and tl.role = 'tl' and tl.is_active = true
        )
      )
    )
  );

-- --------------------------------------------------------------
-- Approval trigger: prefer APC path (invokes brand_switch_apc)
-- --------------------------------------------------------------
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
    if new.to_apc_id is not null then
      -- New path: one SECURITY DEFINER call handles assignments,
      -- TL retarget, task reassignment, audit, and fanout.
      perform public.brand_switch_apc(
        new.brand_id,
        new.to_apc_id,
        coalesce(nullif(new.decision_note, ''), new.reason)
      );
    elsif new.to_owner_id is not null then
      -- Legacy owner_id flip (pre-045 requests).
      perform set_config('wurxos.bypass_owner_guard', 'on', true);
      update public.brands set owner_id = new.to_owner_id where id = new.brand_id;
      perform set_config('wurxos.bypass_owner_guard', 'off', true);
    end if;

    select brand_name into v_brand from public.brands where id = new.brand_id;
    perform public.emit_notification(
      new.requested_by, v_actor, 'brand', 'brand.switch_approved',
      'Brand switch approved',
      'Your switch request for "' || coalesce(v_brand, '?') || '" was approved.',
      'brand', new.brand_id, '/brand-switcher'
    );
  elsif old.status is distinct from new.status and new.status = 'rejected' then
    select brand_name into v_brand from public.brands where id = new.brand_id;
    perform public.emit_notification(
      new.requested_by, v_actor, 'brand', 'brand.switch_rejected',
      'Brand switch rejected',
      'Your switch request for "' || coalesce(v_brand, '?') || '" was rejected.',
      'brand', new.brand_id, '/brand-switcher'
    );
  end if;
  return new;
end;
$$;

-- Refresh the submit-side notification URL to match the new page.
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

  for v_boss in select id from public.profiles where role = 'boss' and is_active = true loop
    perform public.emit_notification(
      v_boss, new.requested_by, 'brand', 'brand.switch_requested',
      'Brand switch requested',
      v_name || ' proposed reassigning brand "' || coalesce(v_brand, '?') || '".',
      'brand', new.brand_id, '/brand-switcher'
    );
  end loop;
  return new;
end;
$$;
