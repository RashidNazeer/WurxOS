-- ============================================================
-- WurxOS v2 — Migration 342: Team Leads can SET the goals for the brands they
-- own — but not the achieved figures.
--
-- Mig 341 gave a TL read access to Brand Analytics for their own brands. This
-- adds the write half, so a TL sets their brands' monthly targets the way an OL
-- does, without waiting on one.
--
-- ── THE LINE, AND WHY IT IS DRAWN HERE ─────────────────────────────────────
-- brand_monthly_metrics holds five pairs: a target and an achieved, e.g.
-- gmv_target / gmv_achieved. A TL may now write the TARGET side. The ACHIEVED
-- side stays Boss/OL.
--
-- That is not tidiness, it is money. `gmv_achieved` is what a GMV Max incentive
-- line reads to decide whether it has hit 90% of its goal and become payable
-- (migs 317/339/340). Every TL carries such lines on their own brands — Azam
-- has six, worth PKR 5,000 each. A TL who could edit gmv_achieved could type a
-- number and pay themselves, with no second pair of eyes anywhere in the flow.
--
-- The target side is safe to hand over: an incentive line stores its own
-- targetValue on the item, set by the OL when the plan is built, and does NOT
-- read gmv_target from this table. So moving a goal here changes what the Brand
-- Analytics dashboard reports; it does not move anyone's payout threshold.
--
-- The guard is a trigger rather than RLS because RLS is row-level and this is a
-- COLUMN restriction. Same shape as the incentives guard in mig 033, which
-- stops a non-admin flipping verified / payout_cleared / basic_salary.
--
-- It fires only for role = 'tl', so it cannot interfere with apc_submit_gmv
-- (mig 311/338), which writes gmv_achieved at clock-in as role = 'apc'.
--
-- Idempotent. Reversible by dropping the two policies and the trigger.
-- ============================================================

-- ── 1. A TL may create and edit metric rows for brands they own ─────────────
drop policy if exists bmm_insert_tl_own on public.brand_monthly_metrics;
create policy bmm_insert_tl_own on public.brand_monthly_metrics for insert
  with check (
    exists (
      select 1
        from public.profiles p
        join public.brands b on b.id = brand_monthly_metrics.brand_id
       where p.id = auth.uid() and p.role = 'tl' and p.is_active = true
         and b.owner_id = p.id
    )
  );

drop policy if exists bmm_update_tl_own on public.brand_monthly_metrics;
create policy bmm_update_tl_own on public.brand_monthly_metrics for update
  using (
    exists (
      select 1
        from public.profiles p
        join public.brands b on b.id = brand_monthly_metrics.brand_id
       where p.id = auth.uid() and p.role = 'tl' and p.is_active = true
         and b.owner_id = p.id
    )
  )
  with check (
    -- Restated so a TL cannot move a row to a brand they do not own.
    exists (
      select 1
        from public.profiles p
        join public.brands b on b.id = brand_monthly_metrics.brand_id
       where p.id = auth.uid() and p.role = 'tl' and p.is_active = true
         and b.owner_id = p.id
    )
  );

-- ── 2. A TL may not touch the achieved side ────────────────────────────────
create or replace function public.bmm_guard_tl_actuals()
returns trigger
language plpgsql security definer set search_path = public
as $$
declare
  v_role text;
begin
  select role into v_role from public.profiles
   where id = auth.uid() and is_active = true;

  -- Only Team Leads are constrained. Boss/OL own these figures outright, and
  -- an APC writes gmv_achieved through apc_submit_gmv at clock-in.
  if v_role is distinct from 'tl' then
    return new;
  end if;

  if tg_op = 'INSERT' then
    if new.gmv_achieved     is not null
       or new.samples_achieved is not null
       or new.roi_achieved     is not null
       or new.gmv_max_used     is not null
       or new.paid_collab_used is not null then
      raise exception
        'A Team Lead sets the goals; the achieved figures are entered by the team and adjusted by an Operations Lead.';
    end if;
    return new;
  end if;

  if new.gmv_achieved     is distinct from old.gmv_achieved
     or new.samples_achieved is distinct from old.samples_achieved
     or new.roi_achieved     is distinct from old.roi_achieved
     or new.gmv_max_used     is distinct from old.gmv_max_used
     or new.paid_collab_used is distinct from old.paid_collab_used then
    raise exception
      'A Team Lead sets the goals; the achieved figures are entered by the team and adjusted by an Operations Lead.';
  end if;

  return new;
end;
$$;

drop trigger if exists bmm_guard_tl_actuals_trg on public.brand_monthly_metrics;
create trigger bmm_guard_tl_actuals_trg
  before insert or update on public.brand_monthly_metrics
  for each row execute function public.bmm_guard_tl_actuals();

-- ── 3. Verification ────────────────────────────────────────────────────────
do $verify$
declare
  v_ins int; v_upd int; v_trg int;
begin
  select count(*) into v_ins from pg_policies
   where schemaname='public' and tablename='brand_monthly_metrics'
     and policyname='bmm_insert_tl_own' and cmd='INSERT';
  select count(*) into v_upd from pg_policies
   where schemaname='public' and tablename='brand_monthly_metrics'
     and policyname='bmm_update_tl_own' and cmd='UPDATE';
  select count(*) into v_trg from pg_trigger
   where tgrelid='public.brand_monthly_metrics'::regclass
     and tgname='bmm_guard_tl_actuals_trg' and not tgisinternal;

  if v_ins <> 1 or v_upd <> 1 then
    raise exception 'mig 342: expected the TL insert+update policies (ins=%, upd=%)', v_ins, v_upd;
  end if;
  if v_trg <> 1 then
    raise exception 'mig 342: the achieved-column guard trigger is missing — a TL could pay themselves';
  end if;

  -- Neither new policy may be FOR ALL / DELETE.
  if exists (select 1 from pg_policies
              where schemaname='public' and tablename='brand_monthly_metrics'
                and policyname in ('bmm_insert_tl_own','bmm_update_tl_own')
                and cmd not in ('INSERT','UPDATE')) then
    raise exception 'mig 342: a TL policy grants more than insert/update';
  end if;

  raise notice 'mig 342: TLs can set goals on their own brands; achieved figures stay Boss/OL';
end;
$verify$;
