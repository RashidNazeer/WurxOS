-- ============================================================
-- WurxOS v2 — Migration 346: a Team Lead may edit EVERY figure on their own
-- brands in Brand Analytics, achieved values included. Requested by the Boss.
--
-- This reverses the column restriction migration 342 added a few hours earlier.
-- 342's reasoning was sound and is worth keeping on the record rather than
-- quietly deleting, because the exposure it described is now real:
--
--   `gmv_achieved` is the figure a GMV Max incentive line reads to decide it has
--   reached 90% of its goal and become payable. Every TL carries such lines on
--   the brands they own. A TL who can type that number can decide their own
--   bonus.
--
-- And since migration 345 it reaches further than it did this morning: the OL's
-- brand roll-up now derives its percentage from the same figure, so a TL
-- editing gmv_achieved moves the Operations Lead's incentive percentage too.
--
-- The Boss has asked for it with that understood. It is a reasonable call for a
-- small team where the TL is the person closest to the real number and the Boss
-- reviews the payout anyway — the control moves from prevention to review.
--
-- WHICH IS WHY THIS MIGRATION ALSO ADDS AN AUDIT TRAIL. Removing the guard
-- without one would leave brand_monthly_metrics with no history at all: it
-- carries only updated_by/updated_at, which record the LAST writer and silently
-- discard whatever was there before. A TL could raise a figure past its
-- threshold and the previous value would be gone. The generic audit_record()
-- trigger (mig 028) covers brands, tasks, reports, leave_requests and
-- brand_switch_requests — this table was never on that list.
--
-- A purpose-built trigger is used rather than the generic one because
-- audit_record() derives entity_id from a column named `id`, and this table is
-- keyed on (brand_id, month_key). The generic trigger would have written NULL
-- into every entity_id, leaving a trail nobody could query by brand.
--
-- Idempotent. Reversible: drop the audit trigger and re-apply mig 342 to
-- restore the restriction.
-- ============================================================

-- ── 1. Remove the column guard — a TL edits every field on their own brands ──
drop trigger if exists bmm_guard_tl_actuals_trg on public.brand_monthly_metrics;
drop function if exists public.bmm_guard_tl_actuals();

-- ── 2. Record every change, so a self-set figure is visible after the fact ───
create or replace function public.bmm_audit()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.audit_log(actor_id, entity_type, entity_id, action, before, after)
  values (
    auth.uid(),
    'brand_monthly_metrics',
    coalesce(new.brand_id, old.brand_id),   -- queryable per brand, unlike a null id
    lower(tg_op),
    case when tg_op = 'INSERT' then null else to_jsonb(old) end,
    case when tg_op = 'DELETE' then null else to_jsonb(new) end
  );
  return case when tg_op = 'DELETE' then old else new end;
end;
$$;

drop trigger if exists bmm_audit_trg on public.brand_monthly_metrics;
create trigger bmm_audit_trg
  after insert or update or delete on public.brand_monthly_metrics
  for each row execute function public.bmm_audit();

-- ── 3. Verification ─────────────────────────────────────────────────────────
do $verify$
declare
  v_guard  int;
  v_audit  int;
  v_brand  uuid;
  v_month  constant text := '1899-01';   -- a month no real row can collide with
  v_rows   int;
  v_actor  int;
begin
  select count(*) into v_guard from pg_trigger
   where tgrelid = 'public.brand_monthly_metrics'::regclass
     and tgname = 'bmm_guard_tl_actuals_trg' and not tgisinternal;
  if v_guard <> 0 then
    raise exception 'mig 346: the TL column guard is still attached';
  end if;

  select count(*) into v_audit from pg_trigger
   where tgrelid = 'public.brand_monthly_metrics'::regclass
     and tgname = 'bmm_audit_trg' and not tgisinternal;
  if v_audit <> 1 then
    raise exception 'mig 346: the audit trigger did not attach — a TL could change the money figure untraced';
  end if;

  -- Prove it actually writes, and that an achieved-value change is captured
  -- with both the old and the new number. A trail that silently records nothing
  -- is worse than none, because it invites trust.
  select id into v_brand from public.brands limit 1;
  if v_brand is null then
    raise notice 'mig 346: no brands to test against — trigger attached, behaviour unverified';
    return;
  end if;

  insert into public.brand_monthly_metrics (brand_id, month_key, gmv_achieved)
  values (v_brand, v_month, 111) on conflict (brand_id, month_key) do update set gmv_achieved = 111;
  update public.brand_monthly_metrics set gmv_achieved = 222
   where brand_id = v_brand and month_key = v_month;

  select count(*) into v_rows from public.audit_log
   where entity_type = 'brand_monthly_metrics' and entity_id = v_brand
     and (after->>'month_key') = v_month;
  if v_rows < 2 then
    raise exception 'mig 346: expected insert+update audit rows, found %', v_rows;
  end if;

  select count(*) into v_rows from public.audit_log
   where entity_type = 'brand_monthly_metrics' and entity_id = v_brand
     and action = 'update'
     and (before->>'gmv_achieved')::numeric = 111
     and (after->>'gmv_achieved')::numeric  = 222;
  if v_rows < 1 then
    raise exception 'mig 346: the audit row did not capture the before/after achieved figures';
  end if;

  delete from public.brand_monthly_metrics where brand_id = v_brand and month_key = v_month;
  delete from public.audit_log
   where entity_type = 'brand_monthly_metrics' and entity_id = v_brand
     and coalesce(after->>'month_key', before->>'month_key') = v_month;

  raise notice 'mig 346: TLs can now edit every Brand Analytics figure; every change is recorded in audit_log';
end;
$verify$;
