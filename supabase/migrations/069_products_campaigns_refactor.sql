-- ============================================================
-- Migration 069 — Correct the Products / Campaigns model
--
-- Earlier 067 made `product_campaigns` pseudo-products with
-- freeform product_name/product_id text. v1's actual flow:
--
--   Brand   → owns many products (brand_products)
--             products carry name, id, retail price, type, SKUs
--   Product → gets campaigns (product_campaigns)
--             campaigns apply promotions (discount/dates) + SKU-
--             level discount overrides onto an existing product
--
-- Fix: introduce `brand_products` and rebuild `product_campaigns`
-- with a foreign key to it. The 067 table has no real data yet
-- (only test) so we drop and recreate cleanly.
--
-- Brand-switching still tracked live through brands.owner_id +
-- brand_assignments (Option B from the 067 header).
-- ============================================================

-- --------------------------------------------------------------
-- 1. brand_products — products belong to a brand
-- --------------------------------------------------------------
create table if not exists public.brand_products (
  id             uuid primary key default gen_random_uuid(),
  brand_id       uuid not null references public.brands(id) on delete cascade,
  product_name   text not null,
  product_id     text,                -- TikTok Shop external id (optional)
  product_url    text,
  type           text not null default 'focus'
                   check (type in ('focus','non-focus')),
  retail_price   numeric(10,2) not null default 0,
  skus           jsonb not null default '[]'::jsonb,  -- [{id, sku_name, retail_price}]
  created_by     uuid references public.profiles(id) on delete set null,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

create index if not exists bpd_brand_idx on public.brand_products(brand_id);
create index if not exists bpd_name_idx  on public.brand_products(lower(product_name));

create or replace function public.brand_products_touch()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists bpd_touch on public.brand_products;
create trigger bpd_touch before update on public.brand_products
  for each row execute function public.brand_products_touch();

alter table public.brand_products enable row level security;

-- Visibility — Boss/OL/Dev see all; brand owner or brand assignees
-- see the products of their brand.
drop policy if exists "bpd_select" on public.brand_products;
create policy "bpd_select" on public.brand_products for select
  using (
    public.is_boss(auth.uid())
    or exists (select 1 from public.profiles p where p.id = auth.uid() and p.role in ('ol','developer') and p.is_active = true)
    or exists (select 1 from public.brands b where b.id = brand_products.brand_id and b.owner_id = auth.uid())
    or exists (
      select 1 from public.brand_assignments ba
      where ba.brand_id = brand_products.brand_id and ba.user_id = auth.uid()
    )
  );

drop policy if exists "bpd_insert" on public.brand_products;
create policy "bpd_insert" on public.brand_products for insert
  with check (
    created_by = auth.uid()
    and (
      public.is_boss(auth.uid())
      or exists (select 1 from public.profiles p where p.id = auth.uid() and p.role in ('ol','developer') and p.is_active = true)
      or exists (select 1 from public.brands b where b.id = brand_products.brand_id and b.owner_id = auth.uid())
      or exists (
        select 1 from public.brand_assignments ba
        where ba.brand_id = brand_products.brand_id and ba.user_id = auth.uid()
      )
    )
  );

drop policy if exists "bpd_update" on public.brand_products;
create policy "bpd_update" on public.brand_products for update
  using (
    public.is_boss(auth.uid())
    or exists (select 1 from public.profiles p where p.id = auth.uid() and p.role in ('ol','developer') and p.is_active = true)
    or exists (select 1 from public.brands b where b.id = brand_products.brand_id and b.owner_id = auth.uid())
    or exists (
      select 1 from public.brand_assignments ba
      where ba.brand_id = brand_products.brand_id and ba.user_id = auth.uid()
    )
  );

drop policy if exists "bpd_delete" on public.brand_products;
create policy "bpd_delete" on public.brand_products for delete
  using (
    public.is_boss(auth.uid())
    or exists (select 1 from public.profiles p where p.id = auth.uid() and p.role in ('ol','developer') and p.is_active = true)
    or exists (select 1 from public.brands b where b.id = brand_products.brand_id and b.owner_id = auth.uid())
  );

-- --------------------------------------------------------------
-- 2. product_campaigns — drop & recreate with product FK
-- --------------------------------------------------------------
drop table if exists public.product_campaigns cascade;

create table public.product_campaigns (
  id                  uuid primary key default gen_random_uuid(),
  product_id          uuid not null references public.brand_products(id) on delete cascade,
  brand_id            uuid not null references public.brands(id) on delete cascade,

  raw_paste           text,
  promotions          jsonb not null default '[]'::jsonb,
                      -- each: {id, type, name, discount, start_date, end_date, status}
  sku_overrides       jsonb not null default '{}'::jsonb,
                      -- { sku_id: { promo_id: discount } }

  latest_end_date     date,
  expiry_notified_at  timestamptz,

  created_by          uuid references public.profiles(id) on delete set null,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

create index if not exists pcmp_brand_idx   on public.product_campaigns(brand_id);
create index if not exists pcmp_product_idx on public.product_campaigns(product_id);
create index if not exists pcmp_end_idx     on public.product_campaigns(latest_end_date);

-- Keep latest_end_date + updated_at in sync; reset expiry_notified_at
-- when the latest end moves later so the reminder can re-fire.
create or replace function public.product_campaigns_touch()
returns trigger language plpgsql as $$
declare v_max date;
begin
  select max((p->>'end_date')::date)
    into v_max
    from jsonb_array_elements(coalesce(new.promotions, '[]'::jsonb)) as p
    where coalesce(p->>'end_date','') <> '';

  new.latest_end_date := v_max;
  new.updated_at := now();

  if tg_op = 'UPDATE' and old.latest_end_date is distinct from v_max then
    new.expiry_notified_at := null;
  end if;

  -- Keep brand_id synced with the referenced product's brand
  if tg_op = 'INSERT' or new.product_id <> old.product_id then
    select brand_id into new.brand_id from public.brand_products where id = new.product_id;
  end if;

  return new;
end;
$$;

drop trigger if exists pcmp_touch on public.product_campaigns;
create trigger pcmp_touch
  before insert or update on public.product_campaigns
  for each row execute function public.product_campaigns_touch();

alter table public.product_campaigns enable row level security;

drop policy if exists "pcmp_select" on public.product_campaigns;
create policy "pcmp_select" on public.product_campaigns for select
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

drop policy if exists "pcmp_insert" on public.product_campaigns;
create policy "pcmp_insert" on public.product_campaigns for insert
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

drop policy if exists "pcmp_update" on public.product_campaigns;
create policy "pcmp_update" on public.product_campaigns for update
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
create policy "pcmp_delete" on public.product_campaigns for delete
  using (
    created_by = auth.uid()
    or public.is_boss(auth.uid())
    or exists (select 1 from public.profiles p where p.id = auth.uid() and p.role in ('ol','developer') and p.is_active = true)
    or exists (select 1 from public.brands b where b.id = product_campaigns.brand_id and b.owner_id = auth.uid())
  );

-- --------------------------------------------------------------
-- 3. 2-day expiry notifications (same shape as before, adapted
--    to the new schema — joins brand_products for product_name).
-- --------------------------------------------------------------
create or replace function public.notify_expiring_campaigns()
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_cmp   public.product_campaigns;
  v_pname text;
  v_brand text;
  v_owner uuid;
  v_uid   uuid;
  v_count int := 0;
begin
  for v_cmp in
    select * from public.product_campaigns
    where latest_end_date is not null
      and latest_end_date = (current_date + interval '2 days')::date
      and expiry_notified_at is null
  loop
    select p.product_name, b.brand_name, b.owner_id
      into v_pname, v_brand, v_owner
      from public.brand_products p
      join public.brands b on b.id = p.brand_id
      where p.id = v_cmp.product_id;

    if v_owner is not null then
      perform public.emit_notification(
        v_owner, null, 'product_campaign', 'campaign_expiring_soon',
        'Campaign ending soon',
        coalesce(v_pname,'A product') || ' on ' || coalesce(v_brand,'this brand')
          || ' ends ' || to_char(v_cmp.latest_end_date, 'Mon DD') || '.',
        'product_campaign', v_cmp.id, '/product-campaigns'
      );
      v_count := v_count + 1;
    end if;

    for v_uid in
      select user_id from public.brand_assignments where brand_id = v_cmp.brand_id
    loop
      if v_uid <> coalesce(v_owner, '00000000-0000-0000-0000-000000000000'::uuid) then
        perform public.emit_notification(
          v_uid, null, 'product_campaign', 'campaign_expiring_soon',
          'Campaign ending soon',
          coalesce(v_pname,'A product') || ' on ' || coalesce(v_brand,'this brand')
            || ' ends ' || to_char(v_cmp.latest_end_date, 'Mon DD') || '.',
          'product_campaign', v_cmp.id, '/product-campaigns'
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
    begin perform cron.unschedule('notify-expiring-campaigns');
    exception when others then null; end;
    perform cron.schedule(
      'notify-expiring-campaigns',
      '0 9 * * *',
      $cron$select public.notify_expiring_campaigns();$cron$
    );
  end if;
end;
$$;
