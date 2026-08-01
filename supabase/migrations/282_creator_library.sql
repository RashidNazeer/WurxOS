-- ============================================================
-- 282 — Creator Library.
--
-- IPCs shortlist creators for a brand in ONE shared PUBLISHED Google Sheet
-- (columns: Tiktok Handle, Name, Brand, Status, Paypal details, Discord — the
-- "Brand" cell says which brand each creator belongs to). The OS reads that sheet
-- (via the `creator-sheet` edge function) and OWNS the approval status:
--   pending → approved by the brand's Team Lead → approved by an Operation Lead.
-- OL approval is the top level (an OL-approved creator needs no TL step; a
-- TL-approved one still needs OL). Approvals live in creator_approvals, keyed by
-- (brand, normalised tiktok handle).
--
-- Brand access reuses can_view_brand (OL/PCTL/Boss = all, owner TL = own brands,
-- assigned IPC = assigned brands), so the moment a TL loses a brand they stop
-- seeing its creators — no extra plumbing.
-- ============================================================

-- 1. Editable pointer to the one shared published sheet (Boss/OL manage it; the
--    edge function reads it with the service role).
create table if not exists public.creator_library_config (
  id         int primary key default 1,
  sheet_url  text,
  updated_by uuid references public.profiles(id) on delete set null,
  updated_at timestamptz not null default now(),
  constraint creator_library_config_singleton check (id = 1)
);
insert into public.creator_library_config (id, sheet_url) values
  (1, 'https://docs.google.com/spreadsheets/d/e/2PACX-1vRHS-w6qN9hVUQLk_7PABRZke4b1Uy62vf46OBDheSYus2k0iAJ6Ovnvt6GvNo7JJW5C2y8hi_sz6-R/pub?output=csv')
on conflict (id) do nothing;

alter table public.creator_library_config enable row level security;
drop policy if exists creator_cfg_all on public.creator_library_config;
create policy creator_cfg_all on public.creator_library_config for all
  using (public.is_boss(auth.uid()) or exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'ol' and p.is_active))
  with check (public.is_boss(auth.uid()) or exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'ol' and p.is_active));

-- 2. Per-(brand, handle) approval state. Status is DERIVED, not stored:
--    ol_approved_by → "approved by operation lead"; else tl_approved_by →
--    "approved by team lead"; else pending.
create table if not exists public.creator_approvals (
  id             uuid primary key default gen_random_uuid(),
  brand_id       uuid not null references public.brands(id) on delete cascade,
  tiktok_handle  text not null,              -- normalised: lower-cased, no leading '@'
  tl_approved_by uuid references public.profiles(id) on delete set null,
  tl_approved_at timestamptz,
  ol_approved_by uuid references public.profiles(id) on delete set null,
  ol_approved_at timestamptz,
  updated_at     timestamptz not null default now(),
  unique (brand_id, tiktok_handle)
);
create index if not exists creator_approvals_brand_idx on public.creator_approvals(brand_id);

-- Who can view a brand's creator library (SECURITY DEFINER so it resolves the
-- brand owner without tangling with the brands table's own RLS).
create or replace function public.can_view_creator_lib(p_brand uuid)
returns boolean language sql security definer set search_path = public stable as $$
  select public.can_view_brand((select owner_id from public.brands where id = p_brand), p_brand, auth.uid());
$$;
grant execute on function public.can_view_creator_lib(uuid) to authenticated;

alter table public.creator_approvals enable row level security;
drop policy if exists creator_appr_select on public.creator_approvals;
create policy creator_appr_select on public.creator_approvals for select
  using (public.can_view_creator_lib(creator_approvals.brand_id));
-- All writes go through creator_set_approval() (SECURITY DEFINER) — no direct
-- client insert/update/delete policy on purpose.

-- 3. Approve / un-approve a creator at the TL or OL level.
create or replace function public.creator_set_approval(
  p_brand uuid, p_handle text, p_level text, p_approve boolean
) returns public.creator_approvals
language plpgsql security definer set search_path = public
as $$
declare
  v_me     uuid := auth.uid();
  v_owner  uuid;
  v_handle text := lower(regexp_replace(trim(coalesce(p_handle, '')), '^@+', ''));
  v_is_ol  boolean;
  v_is_tl  boolean;
  v_row    public.creator_approvals;
begin
  if v_handle = '' then raise exception 'handle required'; end if;
  if p_level not in ('tl', 'ol') then raise exception 'bad level'; end if;
  select owner_id into v_owner from public.brands where id = p_brand;
  if not found then raise exception 'brand not found'; end if;
  if not public.can_view_brand(v_owner, p_brand, v_me) then raise exception 'no access to this brand'; end if;

  v_is_ol := public.is_boss(v_me) or exists (
    select 1 from public.profiles p where p.id = v_me and p.role = 'ol' and p.is_active);
  -- The owner TL (or any OL/Boss) may set the TL-level approval.
  v_is_tl := v_is_ol or (v_owner = v_me and exists (
    select 1 from public.profiles p where p.id = v_me and p.role = 'tl' and p.is_active));

  if p_level = 'ol' and not v_is_ol then raise exception 'only OL/Boss can give OL approval'; end if;
  if p_level = 'tl' and not v_is_tl then raise exception 'only the owner TL or OL/Boss can give TL approval'; end if;

  insert into public.creator_approvals (brand_id, tiktok_handle)
  values (p_brand, v_handle)
  on conflict (brand_id, tiktok_handle) do nothing;

  update public.creator_approvals set
    tl_approved_by = case when p_level = 'tl' then (case when p_approve then v_me  else null end) else tl_approved_by end,
    tl_approved_at = case when p_level = 'tl' then (case when p_approve then now() else null end) else tl_approved_at end,
    ol_approved_by = case when p_level = 'ol' then (case when p_approve then v_me  else null end) else ol_approved_by end,
    ol_approved_at = case when p_level = 'ol' then (case when p_approve then now() else null end) else ol_approved_at end,
    updated_at = now()
  where brand_id = p_brand and tiktok_handle = v_handle
  returning * into v_row;

  -- Feedback: tell the brand's assigned IPC(s) their creator moved forward.
  if p_approve then
    perform public.emit_notification(ba.user_id, v_me, 'creator_library', 'creator_library.approved',
      'Creator approved',
      (case when p_level = 'ol' then 'Operation Lead approved' else 'Team Lead approved' end) || ' @' || v_handle,
      'brand', p_brand, '/creator-library?brand=' || p_brand)
    from public.brand_assignments ba
    join public.profiles p on p.id = ba.user_id
    where ba.brand_id = p_brand and p.role = 'ipc' and p.is_active;
  end if;

  return v_row;
end;
$$;
grant execute on function public.creator_set_approval(uuid, text, text, boolean) to authenticated;

-- 4. IPC (or anyone with access) nudges the brand's Team Lead + the Operation
--    Leads to review the creators. PCTL is deliberately NOT notified.
create or replace function public.creator_notify_pending(p_brand uuid, p_message text default null)
returns integer
language plpgsql security definer set search_path = public
as $$
declare
  v_me    uuid := auth.uid();
  v_owner uuid;
  v_brand text;
  v_body  text;
  v_n     integer := 0;
  r       record;
begin
  select owner_id, brand_name into v_owner, v_brand from public.brands where id = p_brand;
  if not found then raise exception 'brand not found'; end if;
  if not public.can_view_brand(v_owner, p_brand, v_me) then raise exception 'no access'; end if;

  v_body := 'Please review the creator library for ' || coalesce(v_brand, 'this brand')
    || coalesce(' — ' || nullif(trim(p_message), ''), '');

  for r in
    select p.id from public.profiles p
    where p.is_active and p.id <> v_me and (p.id = v_owner or p.role = 'ol')
  loop
    perform public.emit_notification(r.id, v_me, 'creator_library', 'creator_library.review',
      'Creators need review', v_body, 'brand', p_brand, '/creator-library?brand=' || p_brand);
    v_n := v_n + 1;
  end loop;
  return v_n;
end;
$$;
grant execute on function public.creator_notify_pending(uuid, text) to authenticated;

-- 5. Realtime so approval badges update live.
do $$ begin
  alter publication supabase_realtime add table public.creator_approvals;
exception when duplicate_object then null; end $$;
