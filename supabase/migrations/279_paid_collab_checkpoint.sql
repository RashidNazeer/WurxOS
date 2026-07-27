-- ============================================================
-- WurxOS v2 — Migration 279: Paid-Collab weekly checkpoint (§09)
--
-- The §09 "Paid Collab" section of the weekly Agenda Checkpoint is now owned by
-- the PAID COLLAB TEAM (roles pctl + ipc), not the APC. It lives in its OWN
-- per-(brand, week) store so the team can fill it independently of whether the
-- APC has started their checkpoint, and the APC's own autosave (which rewrites
-- the whole checkpoint data blob) can never clobber it.
--
--   • paid_collab_brands  — the SHARED team list: which brands the paid collab
--     team fills §09 for. Any pctl/ipc (or Boss/OL) curates it in settings.
--   • paid_collab_entries — the §09 values per (brand, week), written by the team.
--   • remind_paid_collab() — APC/TL/OL "nudge the paid collab team" notification.
--
-- Safe to re-run.
-- ============================================================

-- ── helpers ───────────────────────────────────────────────────────────
-- Is this user on the paid collab team (active pctl or ipc)?
create or replace function public.is_paid_collab_member(uid uuid)
returns boolean language sql security definer set search_path = public stable as $$
  select exists (
    select 1 from public.profiles p
    where p.id = uid and p.role in ('pctl', 'ipc') and p.is_active = true and p.deleted_at is null
  );
$$;
grant execute on function public.is_paid_collab_member(uuid) to authenticated;

-- ── shared team brand list ────────────────────────────────────────────
create table if not exists public.paid_collab_brands (
  brand_id   uuid primary key references public.brands(id) on delete cascade,
  added_by   uuid references public.profiles(id),
  created_at timestamptz not null default now()
);

alter table public.paid_collab_brands enable row level security;

-- Anyone signed in can SEE which brands are on the list (the APC checkpoint uses
-- it to decide whether §09 is shown read-only or hidden).
drop policy if exists "paid_collab_brands_select" on public.paid_collab_brands;
create policy "paid_collab_brands_select" on public.paid_collab_brands
  for select using (auth.uid() is not null);

-- The paid collab team (+ Boss/OL/dev) curate the shared list.
drop policy if exists "paid_collab_brands_write" on public.paid_collab_brands;
create policy "paid_collab_brands_write" on public.paid_collab_brands
  for all
  using (
    public.is_paid_collab_member(auth.uid()) or public.is_boss(auth.uid())
    or exists (select 1 from public.profiles p where p.id = auth.uid() and p.role in ('ol', 'developer') and p.is_active = true)
  )
  with check (
    public.is_paid_collab_member(auth.uid()) or public.is_boss(auth.uid())
    or exists (select 1 from public.profiles p where p.id = auth.uid() and p.role in ('ol', 'developer') and p.is_active = true)
  );

-- ── §09 store: one row per (brand, week) ──────────────────────────────
create table if not exists public.paid_collab_entries (
  id         uuid primary key default gen_random_uuid(),
  brand_id   uuid not null references public.brands(id) on delete cascade,
  week_start date not null,
  data       jsonb not null default '{}'::jsonb,   -- the 7 paidCollab keys
  updated_by uuid references public.profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (brand_id, week_start)
);

create index if not exists paid_collab_entries_brand_week_idx
  on public.paid_collab_entries(brand_id, week_start desc);

-- Write gate: the brand must be on the shared list AND the writer is on the paid
-- collab team (or an admin). NOT checkpoint_can_write — that would let the APC write.
create or replace function public.can_write_paid_collab(p_brand uuid)
returns boolean language sql security definer set search_path = public stable as $$
  select
    exists (select 1 from public.paid_collab_brands pcb where pcb.brand_id = p_brand)
    and (
      public.is_paid_collab_member(auth.uid()) or public.is_boss(auth.uid())
      or exists (select 1 from public.profiles p where p.id = auth.uid() and p.role in ('ol', 'developer') and p.is_active = true)
    );
$$;
grant execute on function public.can_write_paid_collab(uuid) to authenticated;

alter table public.paid_collab_entries enable row level security;

-- Read: anyone who can view the brand (the APC/TL/OL/Boss — for the read-only
-- §09 status), plus ANY paid collab member (an IPC not assigned to the brand
-- still needs to load/fill it).
drop policy if exists "paid_collab_entries_select" on public.paid_collab_entries;
create policy "paid_collab_entries_select" on public.paid_collab_entries
  for select using (
    public.checkpoint_can_view(brand_id) or public.is_paid_collab_member(auth.uid())
  );

drop policy if exists "paid_collab_entries_insert" on public.paid_collab_entries;
create policy "paid_collab_entries_insert" on public.paid_collab_entries
  for insert with check (public.can_write_paid_collab(brand_id));

drop policy if exists "paid_collab_entries_update" on public.paid_collab_entries;
create policy "paid_collab_entries_update" on public.paid_collab_entries
  for update using (public.can_write_paid_collab(brand_id))
  with check (public.can_write_paid_collab(brand_id));

drop policy if exists "paid_collab_entries_delete" on public.paid_collab_entries;
create policy "paid_collab_entries_delete" on public.paid_collab_entries
  for delete using (public.can_write_paid_collab(brand_id));

-- keep updated_at fresh
create or replace function public.paid_collab_entries_touch()
returns trigger language plpgsql as $$
begin new.updated_at := now(); return new; end; $$;
drop trigger if exists paid_collab_entries_touch on public.paid_collab_entries;
create trigger paid_collab_entries_touch
  before update on public.paid_collab_entries
  for each row execute function public.paid_collab_entries_touch();

-- ── reminder: APC/TL/OL nudges the paid collab team ───────────────────
-- Notifies every active pctl/ipc that §09 needs filling for this brand+week.
-- SECURITY DEFINER because client INSERT into notifications is RLS-blocked
-- (emit_notification is the only sanctioned writer). Actor is auto-skipped.
create or replace function public.remind_paid_collab(p_brand uuid, p_week date)
returns integer language plpgsql security definer set search_path = public as $$
declare
  v_actor   uuid := auth.uid();
  v_name    text;
  v_brand   text;
  v_member  uuid;
  v_link    text;
  v_count   integer := 0;
begin
  -- only someone who can see the brand may nudge (the brand's APC/TL/OL/Boss)
  if not public.checkpoint_can_view(p_brand) then
    raise exception 'Not allowed to remind for this brand';
  end if;

  select display_name into v_name  from public.profiles where id = v_actor;
  select brand_name   into v_brand from public.brands   where id = p_brand;
  v_link := '/agenda/checkpoint?brand=' || p_brand::text || '&week=' || to_char(p_week, 'YYYY-MM-DD');

  for v_member in
    select id from public.profiles
    where role in ('pctl', 'ipc') and is_active = true and deleted_at is null and id <> v_actor
  loop
    perform public.emit_notification(
      v_member, v_actor, 'paid_collab', 'paid_collab.reminder',
      'Paid Collab checkpoint needed',
      coalesce(v_name, 'Someone') || ' asked you to fill the Paid Collab section for "'
        || coalesce(v_brand, 'a brand') || '" (week of ' || to_char(p_week, 'Mon DD') || ').',
      'checkpoint', p_brand, v_link
    );
    v_count := v_count + 1;
  end loop;
  return v_count;
end;
$$;
grant execute on function public.remind_paid_collab(uuid, date) to authenticated;

-- ── realtime ──────────────────────────────────────────────────────────
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    if not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'paid_collab_entries'
    ) then
      execute 'alter publication supabase_realtime add table public.paid_collab_entries';
    end if;
    if not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'paid_collab_brands'
    ) then
      execute 'alter publication supabase_realtime add table public.paid_collab_brands';
    end if;
  end if;
end;
$$;
