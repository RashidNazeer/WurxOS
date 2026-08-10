-- ============================================================
-- WurxOS v2 — Migration 316: the Ads Manager role.
--
-- WHY: Abdul Subhan has been carried as a `tl` since day one purely because the
-- app had no role for what he actually does — run paid ads / GMV Max for a set
-- of brands. That fiction cost us a hand-set `canViewAllBrands` override (mig
-- 192) and an explicit agenda guest-team row (mig 249), i.e. one person's job
-- modelled as a pile of special cases. Mig 249 wrote the exit plan itself:
-- "Paid Media is not a role yet; when it becomes one, add it to member_roles."
-- This is that migration.
--
-- THE MODEL (deliberately NOT brand_assignments):
--   An APC/IPC is assigned to a brand to RUN it; an Ads Manager is attached to a
--   brand to run its ADS. Reusing brand_assignments would have made every
--   "who are this brand's coordinators" query — reports, checkpoints, video
--   reviews, agenda — quietly include an ads manager. So the link gets its own
--   table, `ads_manager_brands`, curated by an OL (Settings → Ads Manager
--   Brands), and it feeds exactly two things:
--     1. VISIBILITY — one new clause in can_view_brand, so an ads manager sees
--        their brands and nothing else (this is what replaces canViewAllBrands).
--     2. INCENTIVES — the OL's brand-grouped plan editor reads it the same way
--        it reads brands.owner_id for a TL and brand_assignments for an APC.
--
-- INCENTIVES NEED NO RLS CHANGE: mig 301 gates OL writes on the TARGET not
-- being ol/developer/boss, so an ads_manager target is already OL-manageable
-- and Boss-payable. Verified before writing this.
--
-- PERFORMANCE IS UNTOUCHED: listProfilesForPerf filters role in
-- (ol,tl,pctl,apc,ipc), so an ads manager simply doesn't appear — which is the
-- intent (no rating model for ads yet). Subhan's 4 historical performance_ratings
-- rows are left in place, unread, and can be surfaced later if the Boss wants
-- ads managers rated.
--
-- Idempotent. can_view_brand is reproduced VERBATIM from mig 247 with exactly
-- one clause added; reversible by dropping that clause.
-- ============================================================

-- ── 1. Let the role exist ───────────────────────────────────────────
-- mig 001 created the check inline, so its name is whatever Postgres chose.
-- Find it by shape rather than trusting a name.
do $$
declare c record;
begin
  for c in
    select conname from pg_constraint
    where conrelid = 'public.profiles'::regclass
      and contype = 'c'
      and pg_get_constraintdef(oid) ilike '%role%'
      and pg_get_constraintdef(oid) ilike '%apc%'
  loop
    execute format('alter table public.profiles drop constraint %I', c.conname);
  end loop;
end $$;

alter table public.profiles add constraint profiles_role_check
  check (role in ('boss','ol','tl','pctl','apc','ipc','developer','ads_manager'));

-- ── 2. Which brands each ads manager runs ads for ───────────────────
create table if not exists public.ads_manager_brands (
  ads_manager_id uuid not null references public.profiles(id) on delete cascade,
  brand_id       uuid not null references public.brands(id)   on delete cascade,
  assigned_by    uuid references public.profiles(id) on delete set null,
  created_at     timestamptz not null default now(),
  primary key (ads_manager_id, brand_id)
);
create index if not exists ads_manager_brands_brand_idx on public.ads_manager_brands (brand_id);

comment on table public.ads_manager_brands is
  'OL-curated: the brands an ads manager runs paid ads for. Drives BOTH their '
  'brand visibility (can_view_brand) and the brand groups in their incentive plan. '
  'Deliberately separate from brand_assignments, which means "coordinates this brand".';

alter table public.ads_manager_brands enable row level security;

-- Read: the ads manager themself, the Boss, any active OL. (A TL does not need
-- to see the ads roster to do their job; widen later if that changes.)
drop policy if exists amb_select on public.ads_manager_brands;
create policy amb_select on public.ads_manager_brands for select
  using (
    ads_manager_id = auth.uid()
    or public.is_boss(auth.uid())
    or exists (select 1 from public.profiles p
               where p.id = auth.uid() and p.role = 'ol' and p.is_active = true)
  );

-- Write: Boss or an active OL. The setter RPC below is the intended path; these
-- policies keep a direct PostgREST write honest rather than open.
drop policy if exists amb_write on public.ads_manager_brands;
create policy amb_write on public.ads_manager_brands for all
  using (
    public.is_boss(auth.uid())
    or exists (select 1 from public.profiles p
               where p.id = auth.uid() and p.role = 'ol' and p.is_active = true)
  )
  with check (
    public.is_boss(auth.uid())
    or exists (select 1 from public.profiles p
               where p.id = auth.uid() and p.role = 'ol' and p.is_active = true)
  );

grant select, insert, update, delete on public.ads_manager_brands to authenticated;

-- Atomic setter — delete+insert in ONE transaction. Two autocommit statements
-- would leave the manager brand-less (= blind) for the gap between them; that
-- exact race is why ol_set_incentive_brands exists (mig 295).
create or replace function public.ads_manager_set_brands(p_user uuid, p_brand_ids uuid[])
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor uuid := auth.uid();
begin
  if v_actor is null then
    raise exception 'not authenticated';
  end if;
  if not (
    public.is_boss(v_actor)
    or exists (select 1 from public.profiles p
               where p.id = v_actor and p.role = 'ol' and p.is_active = true)
  ) then
    raise exception 'only the Boss or an Operation Lead can set ads-manager brands';
  end if;
  if not exists (
    select 1 from public.profiles p
    where p.id = p_user and p.role = 'ads_manager' and p.deleted_at is null
  ) then
    raise exception 'target user is not an ads manager';
  end if;

  delete from public.ads_manager_brands where ads_manager_id = p_user;

  insert into public.ads_manager_brands (ads_manager_id, brand_id, assigned_by)
  select p_user, b, v_actor
  from unnest(coalesce(p_brand_ids, '{}'::uuid[])) as b
  where exists (select 1 from public.brands br where br.id = b)
  on conflict do nothing;
end;
$$;
revoke all on function public.ads_manager_set_brands(uuid, uuid[]) from public, anon;
grant execute on function public.ads_manager_set_brands(uuid, uuid[]) to authenticated;

-- ── 3. Visibility: mig 247's body + ONE clause ──────────────────────
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
    );
$$;

-- ── 4. Brand Analytics: READ-only for the ads manager's own brands ──
-- bmm_all (mig 260) is FOR ALL gated on Boss/OL and is left exactly as-is.
-- Policies OR together, so this adds read access and grants no write.
drop policy if exists bmm_select_ads_manager on public.brand_monthly_metrics;
create policy bmm_select_ads_manager on public.brand_monthly_metrics for select
  using (
    exists (
      select 1
      from public.ads_manager_brands amb
      join public.profiles p on p.id = amb.ads_manager_id
      where amb.brand_id = brand_monthly_metrics.brand_id
        and amb.ads_manager_id = auth.uid()
        and p.is_active = true
    )
  );

-- ── 5. Agenda: the Paid Media guest team becomes role-driven ────────
-- Exactly what mig 249 said to do once the role existed. Subhan's explicit
-- member row stays (harmless, and it keeps the invite working if a future ads
-- manager is ever excluded from the role list).
update public.agenda_guest_teams
set member_roles = array(select distinct unnest(member_roles || array['ads_manager'])),
    updated_at   = now()
where slug = 'paid_media'
  and not ('ads_manager' = any(member_roles));

-- ── 6. Subhan becomes what he actually is ───────────────────────────
-- Safe to flip: he owns no brands, has no brand_assignments, nobody reports to
-- him, and he has no incentive rows (verified 2026-08-10). canViewAllBrands is
-- REMOVED — his visibility now comes from ads_manager_brands, which is the whole
-- point. canAttendAllMeetings is left alone (agenda access unchanged).
-- NOTE: his ads-brand set starts EMPTY, so an OL must tick his brands in
-- Settings → Ads Manager Brands before he can see any brand again.
update public.profiles
set role        = 'ads_manager',
    permissions = coalesce(permissions, '{}'::jsonb) - 'canViewAllBrands'
where id = 'f7ee4fd4-d422-5329-a658-fdc7a530b812'
  and role = 'tl';
