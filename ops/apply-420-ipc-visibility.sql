-- ============================================================================
-- FIX: an IPC cannot see brands the Boss made visible to them, nor their
-- reports.  Run in the SQL Editor of PRODUCTION, and then of DEV.
--
-- This is migration 420_ipc_sees_paid_collab_brands.sql, which has never been
-- applied anywhere. It was merged in PR #50, but another migration was also
-- numbered 419 at the time; the Supabase CLI keys its ledger on the numeric
-- prefix alone, so one of the two was recorded and this one was skipped
-- SILENTLY, while the push reported success. It was later renumbered to 420,
-- but renumbering a file does not apply it.
--
-- WHY IT FIXES BOTH SYMPTOMS. can_view_brand (last really applied: mig 316)
-- lets an IPC see a brand only through a brand_assignments row. Paid Collab
-- (mig 279) was designed for Boss/OL to hand the TEAM a brand regardless of
-- who its regular APC/TL is, so an IPC on paid_collab_brands was never meant
-- to need an individual assignment as well. And because report visibility
-- runs through the same function —
--     reports_select -> can_view_report -> can_view_brand
-- — the reports vanished along with the brand. One cause, both symptoms.
--
-- SAFE TO RUN TWICE: `create or replace function` is idempotent, and the
-- ledger insert is `on conflict do nothing`.
--
-- SCOPE OF THE WIDENING, so it is a deliberate choice and not a surprise: any
-- ACTIVE user with role 'ipc' can see EVERY brand on paid_collab_brands. It
-- grants nothing to any other role, and it does not touch salaries,
-- attendance, performance or incentives — those have their own policies.
-- ============================================================================

create or replace function public.can_view_brand(b_owner uuid, b_id uuid, uid uuid)
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select
    public.is_boss(uid)
    or exists (
      select 1 from public.profiles p
      where p.id = uid
        and p.is_active = true
        and (p.role = 'ol'
             or p.role = 'pctl'
             or coalesce((p.permissions->>'canViewAllBrands')::boolean, false))
    )
    or b_owner = uid
    or exists (
      select 1 from public.brand_assignments ba
      where ba.brand_id = b_id and ba.user_id = uid
    )
    or exists (
      select 1 from public.pctl_brand_selections s
      where s.brand_id = b_id and s.pctl_id = uid
    )
    or exists (
      select 1 from public.ads_manager_brands amb
      where amb.brand_id = b_id and amb.ads_manager_id = uid
    )
    or exists (
      select 1 from public.paid_collab_brands pcb
      join public.profiles p on p.id = uid
      where pcb.brand_id = b_id
        and p.is_active = true
        and p.role = 'ipc'
    );
$$;

-- Record it, so a later `supabase db push` does not treat 420 as outstanding.
insert into supabase_migrations.schema_migrations (version, name)
values ('420', 'ipc_sees_paid_collab_brands')
on conflict (version) do nothing;


-- ── verify ──────────────────────────────────────────────────────────────────
-- 1. The IPC clause is now live. Expect true.
select position('paid_collab_brands' in
       pg_get_functiondef('public.can_view_brand(uuid,uuid,uuid)'::regprocedure)) > 0
       as ipc_clause_present;

-- 2. Every active IPC against every Paid Collab brand: can they see it, and
--    how many of its reports can they read? Expect can_see_brand = true
--    throughout, and visible_reports to match reports_on_brand.
select
  ipc.display_name                                 as ipc,
  b.brand_name,
  public.can_view_brand(b.owner_id, b.id, ipc.id)  as can_see_brand,
  (select count(*) from public.reports r where r.brand_id = b.id)                as reports_on_brand,
  (select count(*) from public.reports r
    where r.brand_id = b.id
      and public.can_view_report(r.brand_id, r.author_id, ipc.id))               as visible_reports
from public.profiles ipc
cross join public.paid_collab_brands pcb
join public.brands b on b.id = pcb.brand_id
where ipc.role = 'ipc' and ipc.is_active and ipc.deleted_at is null
  and b.status = 'active'
order by ipc.display_name, b.brand_name;
