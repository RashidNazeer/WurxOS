-- ============================================================
-- Migration 067 — Product campaigns
--
-- TikTok Shop product promotions. One campaign = one product on a
-- brand, with multiple promotions (individual discount / cart-level
-- / coupon) and optional SKU-specific discount overrides.
--
-- Brand-switching behaviour (v1 parity + improvement):
--   Visibility always tracks `brands.owner_id` and `brand_assignments`
--   live. When a brand is reassigned, the new owner + APCs
--   immediately see its campaigns; the old ones lose visibility.
--   This is what the user meant by "apc/tl should get the data of
--   the switched brand if it was switched".
--
-- 2-day expiry notifications: daily cron finds campaigns whose
-- latest promotion end date is exactly 2 days out and emits a
-- notification to the current brand owner + APCs, marking
-- expiry_notified_at so it doesn't re-fire.
-- ============================================================

create table if not exists public.product_campaigns (
  id                  uuid primary key default gen_random_uuid(),
  brand_id            uuid not null references public.brands(id) on delete cascade,
  product_name        text not null,
  product_id          text,                     -- TikTok Shop product id
  product_url         text,
  type                text not null default 'focus'
                        check (type in ('focus','non-focus')),
  retail_price        numeric(10,2) not null default 0,

  raw_paste           text,
  promotions          jsonb not null default '[]'::jsonb,
  skus                jsonb not null default '[]'::jsonb,

  latest_end_date     date,
  expiry_notified_at  timestamptz,

  created_by          uuid references public.profiles(id) on delete set null,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

create index if not exists pcmp_brand_idx      on public.product_campaigns(brand_id);
create index if not exists pcmp_latest_end_idx on public.product_campaigns(latest_end_date);

-- --------------------------------------------------------------
-- Recompute latest_end_date from promotions[] on every write.
-- --------------------------------------------------------------
create or replace function public.product_campaigns_touch()
returns trigger
language plpgsql
as $$
declare
  v_max date;
begin
  select max((p->>'end_date')::date)
    into v_max
    from jsonb_array_elements(coalesce(new.promotions, '[]'::jsonb)) as p
    where coalesce(p->>'end_date','') <> '';

  new.latest_end_date := v_max;
  new.updated_at := now();

  -- Reset the 2-day-warning marker if the end date moved later than
  -- previously notified so the reminder can fire again.
  if tg_op = 'UPDATE' and old.latest_end_date is distinct from v_max then
    new.expiry_notified_at := null;
  end if;

  return new;
end;
$$;

drop trigger if exists pcmp_touch on public.product_campaigns;
create trigger pcmp_touch
  before insert or update on public.product_campaigns
  for each row execute function public.product_campaigns_touch();

-- --------------------------------------------------------------
-- RLS
-- --------------------------------------------------------------
alter table public.product_campaigns enable row level security;

-- See a campaign if:
--   * Boss / OL / Developer, OR
--   * author, OR
--   * currently own the brand (brands.owner_id = me), OR
--   * currently assigned to the brand (brand_assignments.user_id = me)
drop policy if exists "pcmp_select" on public.product_campaigns;
create policy "pcmp_select"
  on public.product_campaigns for select
  using (
    public.is_boss(auth.uid())
    or exists (select 1 from public.profiles p where p.id = auth.uid() and p.role in ('ol','developer') and p.is_active = true)
    or created_by = auth.uid()
    or exists (select 1 from public.brands b where b.id = product_campaigns.brand_id and b.owner_id = auth.uid())
    or exists (
      select 1 from public.brand_assignments ba
      where ba.brand_id = product_campaigns.brand_id and ba.user_id = auth.uid()
    )
  );

-- Insert allowed for the brand owner, any APC/IPC assigned to it, or admins.
drop policy if exists "pcmp_insert" on public.product_campaigns;
create policy "pcmp_insert"
  on public.product_campaigns for insert
  with check (
    created_by = auth.uid()
    and (
      public.is_boss(auth.uid())
      or exists (select 1 from public.profiles p where p.id = auth.uid() and p.role in ('ol','developer') and p.is_active = true)
      or exists (select 1 from public.brands b where b.id = product_campaigns.brand_id and b.owner_id = auth.uid())
      or exists (
        select 1 from public.brand_assignments ba
        where ba.brand_id = product_campaigns.brand_id and ba.user_id = auth.uid()
      )
    )
  );

-- Update/delete by current owner / assignees / admins / author.
drop policy if exists "pcmp_update" on public.product_campaigns;
create policy "pcmp_update"
  on public.product_campaigns for update
  using (
    created_by = auth.uid()
    or public.is_boss(auth.uid())
    or exists (select 1 from public.profiles p where p.id = auth.uid() and p.role in ('ol','developer') and p.is_active = true)
    or exists (select 1 from public.brands b where b.id = product_campaigns.brand_id and b.owner_id = auth.uid())
    or exists (
      select 1 from public.brand_assignments ba
      where ba.brand_id = product_campaigns.brand_id and ba.user_id = auth.uid()
    )
  );

drop policy if exists "pcmp_delete" on public.product_campaigns;
create policy "pcmp_delete"
  on public.product_campaigns for delete
  using (
    created_by = auth.uid()
    or public.is_boss(auth.uid())
    or exists (select 1 from public.profiles p where p.id = auth.uid() and p.role in ('ol','developer') and p.is_active = true)
    or exists (select 1 from public.brands b where b.id = product_campaigns.brand_id and b.owner_id = auth.uid())
  );

-- --------------------------------------------------------------
-- 2-day expiry notifications
-- --------------------------------------------------------------
-- Fires daily. For each campaign whose latest_end_date is exactly
-- (today + 2 days) and hasn't yet been notified, emit a notification
-- to the current brand owner + brand assignees, then mark it done.
create or replace function public.notify_expiring_campaigns()
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_cmp public.product_campaigns;
  v_brand_name text;
  v_owner uuid;
  v_uid uuid;
  v_count int := 0;
  v_title text;
  v_body  text;
begin
  for v_cmp in
    select * from public.product_campaigns
    where latest_end_date is not null
      and latest_end_date = (current_date + interval '2 days')::date
      and expiry_notified_at is null
  loop
    select brand_name, owner_id into v_brand_name, v_owner
      from public.brands where id = v_cmp.brand_id;

    v_title := 'Campaign ending soon';
    v_body  := v_cmp.product_name || ' on ' || coalesce(v_brand_name,'this brand')
            || ' ends ' || to_char(v_cmp.latest_end_date, 'Mon DD') || '.';

    -- Owner
    if v_owner is not null then
      perform public.emit_notification(
        v_owner, null, 'product_campaign', 'campaign_expiring_soon',
        v_title, v_body, 'product_campaign', v_cmp.id, '/product-campaigns'
      );
      v_count := v_count + 1;
    end if;

    -- Assignees
    for v_uid in
      select user_id from public.brand_assignments where brand_id = v_cmp.brand_id
    loop
      if v_uid <> coalesce(v_owner, '00000000-0000-0000-0000-000000000000'::uuid) then
        perform public.emit_notification(
          v_uid, null, 'product_campaign', 'campaign_expiring_soon',
          v_title, v_body, 'product_campaign', v_cmp.id, '/product-campaigns'
        );
        v_count := v_count + 1;
      end if;
    end loop;

    update public.product_campaigns
       set expiry_notified_at = now()
     where id = v_cmp.id;
  end loop;

  return v_count;
end;
$$;

do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    begin
      perform cron.unschedule('notify-expiring-campaigns');
    exception when others then null;
    end;
    perform cron.schedule(
      'notify-expiring-campaigns',
      '0 9 * * *',  -- daily at 09:00 UTC
      $cron$select public.notify_expiring_campaigns();$cron$
    );
  end if;
end;
$$;
