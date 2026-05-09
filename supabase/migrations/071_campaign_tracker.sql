-- ============================================================
-- Migration 071 — Campaign tracker
--
-- Brand-level shop-wide promotions (coupons, bundles, flash sales)
-- separate from the product-level promotions in product_campaigns.
-- Port of v1's campaigns collection + CampaignTrackerPage.
--
-- Effective status is derived client-side from start/end times.
-- Only 'Deactivated' is user-set (a manual toggle); all other states
-- (Ongoing / Upcoming / Ended) are computed at render.
--
-- 2-day expiry reminder: daily cron at 09:05 UTC emits a notification
-- to the brand owner + brand_assignments for each campaign whose
-- end_time falls in [now+36h, now+60h]. `reminders jsonb` tracks
-- which reminders have already been sent so we don't re-fire.
-- ============================================================

create table if not exists public.campaigns (
  id               uuid primary key default gen_random_uuid(),
  brand_id         uuid not null references public.brands(id) on delete cascade,
  promotion_name   text not null,
  status           text not null default 'Ongoing'
                     check (status in ('Ongoing','Deactivated')),
  start_time       timestamptz,
  end_time         timestamptz,
  type             text,
  notes            text,
  reminders        jsonb not null default '{}'::jsonb,
  owner_id         uuid references public.profiles(id) on delete set null,
  added_by         uuid references public.profiles(id) on delete set null,
  added_by_role    text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

create index if not exists cmp_brand_idx    on public.campaigns(brand_id);
create index if not exists cmp_end_time_idx on public.campaigns(end_time) where end_time is not null;
create index if not exists cmp_owner_idx    on public.campaigns(owner_id);

create or replace function public.campaigns_touch()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists cmp_touch on public.campaigns;
create trigger cmp_touch before update on public.campaigns
  for each row execute function public.campaigns_touch();

-- --------------------------------------------------------------
-- RLS
--   SELECT:
--     Boss / OL / Developer  → all rows
--     TL                     → own (owner_id = me OR added_by = me)
--     APC / IPC              → brands they currently own OR are
--                              assigned to (live brand-switching)
--   INSERT: author must set added_by = auth.uid() and have an
--           active role that's allowed to create (boss/ol/dev/tl/
--           pctl/apc/ipc — everyone except admins without a brand
--           relationship)
--   UPDATE / DELETE: boss/ol/dev OR added_by = me OR current brand
--                    owner (owner of the referenced brand)
-- --------------------------------------------------------------
alter table public.campaigns enable row level security;

drop policy if exists "cmp_select" on public.campaigns;
create policy "cmp_select" on public.campaigns for select
  using (
    public.is_boss(auth.uid())
    or exists (select 1 from public.profiles p where p.id = auth.uid() and p.role in ('ol','developer') and p.is_active = true)
    or exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'tl'
               and (campaigns.owner_id = auth.uid() or campaigns.added_by = auth.uid()))
    or exists (
      select 1 from public.profiles p
      where p.id = auth.uid() and p.role in ('apc','ipc','pctl')
        and (
          exists (select 1 from public.brands b where b.id = campaigns.brand_id and b.owner_id = auth.uid())
          or exists (select 1 from public.brand_assignments ba where ba.brand_id = campaigns.brand_id and ba.user_id = auth.uid())
        )
    )
  );

drop policy if exists "cmp_insert" on public.campaigns;
create policy "cmp_insert" on public.campaigns for insert
  with check (
    added_by = auth.uid()
    and exists (
      select 1 from public.profiles p
      where p.id = auth.uid() and p.is_active = true
        and p.role in ('boss','ol','developer','tl','pctl','apc','ipc')
    )
  );

drop policy if exists "cmp_update" on public.campaigns;
create policy "cmp_update" on public.campaigns for update
  using (
    added_by = auth.uid()
    or public.is_boss(auth.uid())
    or exists (select 1 from public.profiles p where p.id = auth.uid() and p.role in ('ol','developer') and p.is_active = true)
    or exists (select 1 from public.brands b where b.id = campaigns.brand_id and b.owner_id = auth.uid())
  );

drop policy if exists "cmp_delete" on public.campaigns;
create policy "cmp_delete" on public.campaigns for delete
  using (
    added_by = auth.uid()
    or public.is_boss(auth.uid())
    or exists (select 1 from public.profiles p where p.id = auth.uid() and p.role in ('ol','developer') and p.is_active = true)
    or exists (select 1 from public.brands b where b.id = campaigns.brand_id and b.owner_id = auth.uid())
  );

-- --------------------------------------------------------------
-- 2-day expiry reminder cron
-- --------------------------------------------------------------
create or replace function public.notify_expiring_tracker_campaigns()
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_cmp     public.campaigns;
  v_brand   text;
  v_owner   uuid;
  v_uid     uuid;
  v_count   int := 0;
  v_window_start timestamptz := now() + interval '36 hours';
  v_window_end   timestamptz := now() + interval '60 hours';
  v_title   text;
  v_body    text;
begin
  for v_cmp in
    select * from public.campaigns
    where status = 'Ongoing'
      and end_time is not null
      and end_time between v_window_start and v_window_end
      and not (reminders ? 'expiry_2d_at')
  loop
    select brand_name, owner_id into v_brand, v_owner
      from public.brands where id = v_cmp.brand_id;

    v_title := 'Campaign ending soon';
    v_body  := coalesce(v_cmp.promotion_name, 'A campaign')
            || ' on ' || coalesce(v_brand, 'this brand')
            || ' ends ' || to_char(v_cmp.end_time, 'Mon DD, HH24:MI')
            || '.';

    if v_owner is not null then
      perform public.emit_notification(
        v_owner, null, 'campaign', 'campaign_expiring_soon',
        v_title, v_body, 'campaign', v_cmp.id, '/campaigns'
      );
      v_count := v_count + 1;
    end if;

    for v_uid in
      select user_id from public.brand_assignments
      where brand_id = v_cmp.brand_id
        and user_id <> coalesce(v_owner, '00000000-0000-0000-0000-000000000000'::uuid)
    loop
      perform public.emit_notification(
        v_uid, null, 'campaign', 'campaign_expiring_soon',
        v_title, v_body, 'campaign', v_cmp.id, '/campaigns'
      );
      v_count := v_count + 1;
    end loop;

    update public.campaigns
       set reminders = reminders || jsonb_build_object('expiry_2d_at', now())
     where id = v_cmp.id;
  end loop;

  return v_count;
end;
$$;

do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    begin perform cron.unschedule('notify-expiring-tracker-campaigns');
    exception when others then null; end;
    perform cron.schedule(
      'notify-expiring-tracker-campaigns',
      '5 9 * * *',     -- daily at 09:05 UTC
      $cron$select public.notify_expiring_tracker_campaigns();$cron$
    );
  end if;
end;
$$;
