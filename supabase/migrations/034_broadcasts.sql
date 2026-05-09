-- ============================================================
-- WurxOS v2 — Migration 034: Broadcasts
--
-- Boss / OL / Developer compose announcements that fan out to
-- every matching user via emit_notification. Optional scheduling
-- via scheduled_for + pg_cron minute-level dispatcher.
-- ============================================================

create table if not exists public.broadcasts (
  id             uuid primary key default gen_random_uuid(),
  author_id      uuid references public.profiles(id) on delete set null,
  title          text not null,
  body           text not null default '',
  target         text not null default 'all'
                   check (target in ('all','role','brand')),
  target_roles   text[] not null default '{}',
  target_brand_id uuid references public.brands(id) on delete set null,
  scheduled_for  timestamptz,
  sent_at        timestamptz,
  sent_count     int,
  created_at     timestamptz not null default now()
);

create index if not exists broadcasts_scheduled_idx
  on public.broadcasts(scheduled_for)
  where sent_at is null and scheduled_for is not null;

alter table public.broadcasts enable row level security;

drop policy if exists "bc_select" on public.broadcasts;
create policy "bc_select"
  on public.broadcasts for select
  using (
    public.is_boss(auth.uid())
    or exists (select 1 from public.profiles p where p.id = auth.uid() and p.role in ('ol','developer') and p.is_active = true)
    or author_id = auth.uid()
  );

drop policy if exists "bc_insert" on public.broadcasts;
create policy "bc_insert"
  on public.broadcasts for insert
  with check (
    author_id = auth.uid()
    and (
      public.is_boss(auth.uid())
      or exists (select 1 from public.profiles p where p.id = auth.uid() and p.role in ('ol','developer') and p.is_active = true)
    )
  );

-- Fan-out helper — called by trigger on insert (immediate) or cron (scheduled)
create or replace function public.dispatch_broadcast(p_id uuid)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.broadcasts;
  v_uid uuid;
  v_count int := 0;
begin
  select * into v_row from public.broadcasts where id = p_id;
  if not found or v_row.sent_at is not null then return 0; end if;

  for v_uid in
    select p.id from public.profiles p
    where p.is_active = true
      and (
        v_row.target = 'all'
        or (v_row.target = 'role'  and p.role = any (v_row.target_roles))
        or (v_row.target = 'brand' and (
              p.id = (select owner_id from public.brands where id = v_row.target_brand_id)
              or exists (select 1 from public.brand_assignments ba where ba.brand_id = v_row.target_brand_id and ba.user_id = p.id)
            ))
      )
      and p.id <> coalesce(v_row.author_id, '00000000-0000-0000-0000-000000000000')
  loop
    perform public.emit_notification(
      v_uid, v_row.author_id, 'system', 'broadcast',
      v_row.title, v_row.body, 'broadcast', v_row.id, '/broadcasts'
    );
    v_count := v_count + 1;
  end loop;

  update public.broadcasts set sent_at = now(), sent_count = v_count where id = p_id;
  return v_count;
end;
$$;

create or replace function public.broadcasts_dispatch_trigger()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.scheduled_for is null or new.scheduled_for <= now() then
    perform public.dispatch_broadcast(new.id);
  end if;
  return new;
end;
$$;

drop trigger if exists broadcasts_dispatch_ai on public.broadcasts;
create trigger broadcasts_dispatch_ai
  after insert on public.broadcasts
  for each row execute function public.broadcasts_dispatch_trigger();

-- Cron: pick up any scheduled broadcasts whose time has come
create or replace function public.dispatch_scheduled_broadcasts()
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
  v_total int := 0;
begin
  for v_id in
    select id from public.broadcasts
    where sent_at is null
      and scheduled_for is not null
      and scheduled_for <= now()
  loop
    v_total := v_total + public.dispatch_broadcast(v_id);
  end loop;
  return v_total;
end;
$$;

do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    begin
      perform cron.unschedule('dispatch-scheduled-broadcasts');
    exception when others then null;
    end;
  end if;
end;
$$;
do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.schedule('dispatch-scheduled-broadcasts', '* * * * *',
      $cron$select public.dispatch_scheduled_broadcasts();$cron$);
  end if;
end;
$$;
