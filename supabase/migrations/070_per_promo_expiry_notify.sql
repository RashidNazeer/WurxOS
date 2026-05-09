-- ============================================================
-- Migration 070 — Per-promotion expiry notifications
--
-- 067/069 only looked at `latest_end_date` (max end across all
-- promotions on a campaign). That silently misses earlier
-- promotions: a campaign with three promos ending Apr 10, 20, 30
-- would only warn about Apr 30. Users want to hear about EVERY
-- expiring promotion — individual, cart-level, and coupon —
-- including when a SKU override is tied to it.
--
-- Fix: iterate the jsonb promotions[] per row, fire a notification
-- exactly 2 days before each promo's end_date, and keep a set of
-- already-notified promo ids on the campaign so we don't re-fire.
-- ============================================================

alter table public.product_campaigns
  add column if not exists notified_promo_ids text[] not null default '{}';

create or replace function public.notify_expiring_campaigns()
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_cmp         public.product_campaigns;
  v_pname       text;
  v_brand       text;
  v_owner       uuid;
  v_uid         uuid;
  v_count       int := 0;

  v_promo       jsonb;
  v_promo_id    text;
  v_promo_end   date;
  v_promo_type  text;
  v_promo_name  text;
  v_promo_disc  numeric;
  v_has_sku_ovr bool;
  v_title       text;
  v_body        text;
  v_already     bool;
begin
  -- Walk every campaign and each of its promotions independently.
  for v_cmp in
    select * from public.product_campaigns
    where coalesce(jsonb_array_length(promotions), 0) > 0
  loop
    select p.product_name, b.brand_name, b.owner_id
      into v_pname, v_brand, v_owner
      from public.brand_products p
      join public.brands b on b.id = p.brand_id
      where p.id = v_cmp.product_id;

    for v_promo in
      select * from jsonb_array_elements(v_cmp.promotions)
    loop
      v_promo_id   := v_promo->>'id';
      if v_promo_id is null or v_promo_id = '' then continue; end if;

      v_promo_end  := nullif(v_promo->>'end_date', '')::date;
      if v_promo_end is null or v_promo_end <> (current_date + interval '2 days')::date then
        continue;
      end if;

      -- Already notified for this specific promo? Skip.
      v_already := v_promo_id = any (coalesce(v_cmp.notified_promo_ids, '{}'));
      if v_already then continue; end if;

      v_promo_type := coalesce(v_promo->>'type', 'individual');
      v_promo_name := trim(coalesce(v_promo->>'name', ''));
      v_promo_disc := coalesce((v_promo->>'discount')::numeric, 0);

      -- Does this promo have any SKU-level overrides? We surface that in the body.
      v_has_sku_ovr := (
        select exists (
          select 1 from jsonb_each(coalesce(v_cmp.sku_overrides, '{}'::jsonb)) as s(sku, ovr)
          where (ovr ? v_promo_id)
        )
      );

      v_title := 'Promotion ending in 2 days';
      v_body  := coalesce(v_pname, 'A product') || ' on ' || coalesce(v_brand, 'this brand')
              || ' — ' || label_for_promo(v_promo_type)
              || case when v_promo_name <> '' then ' "' || v_promo_name || '"' else '' end
              || ' (−$' || to_char(v_promo_disc, 'FM999990.00') || ')'
              || ' ends ' || to_char(v_promo_end, 'Mon DD') || '.'
              || case when v_has_sku_ovr then ' Includes SKU-specific discounts.' else '' end;

      -- Notify the current brand owner
      if v_owner is not null then
        perform public.emit_notification(
          v_owner, null, 'product_campaign', 'campaign_expiring_soon',
          v_title, v_body, 'product_campaign', v_cmp.id, '/product-campaigns'
        );
        v_count := v_count + 1;
      end if;

      -- Notify current brand assignees (APCs / IPCs)
      for v_uid in
        select user_id from public.brand_assignments
        where brand_id = v_cmp.brand_id
          and user_id <> coalesce(v_owner, '00000000-0000-0000-0000-000000000000'::uuid)
      loop
        perform public.emit_notification(
          v_uid, null, 'product_campaign', 'campaign_expiring_soon',
          v_title, v_body, 'product_campaign', v_cmp.id, '/product-campaigns'
        );
        v_count := v_count + 1;
      end loop;

      -- Mark this promo id as notified on the campaign row
      update public.product_campaigns
         set notified_promo_ids = array_append(coalesce(notified_promo_ids, '{}'), v_promo_id)
       where id = v_cmp.id;
    end loop;
  end loop;

  return v_count;
end;
$$;

-- Helper: human label for a promo type
create or replace function public.label_for_promo(p_type text)
returns text
language sql immutable as $$
  select case p_type
    when 'individual' then 'Individual promo'
    when 'cart'       then 'Cart-level promo'
    when 'coupon'     then 'Coupon'
    else coalesce(p_type, 'Promo')
  end;
$$;

-- Touch trigger: if the edited promotions array drops a previously-
-- notified promo id OR changes its end_date, prune that id from
-- notified_promo_ids so future re-notification is possible.
create or replace function public.product_campaigns_touch()
returns trigger language plpgsql as $$
declare
  v_max date;
  v_current_ids text[];
begin
  select max((p->>'end_date')::date)
    into v_max
    from jsonb_array_elements(coalesce(new.promotions, '[]'::jsonb)) as p
    where coalesce(p->>'end_date','') <> '';

  new.latest_end_date := v_max;
  new.updated_at := now();

  -- Active promo ids on the new row
  select coalesce(array_agg(p->>'id'), '{}')
    into v_current_ids
    from jsonb_array_elements(coalesce(new.promotions, '[]'::jsonb)) as p
    where coalesce(p->>'id','') <> '';

  if tg_op = 'UPDATE' then
    -- Drop notified ids for promos that no longer exist (or whose
    -- end_date changed — simplest rule: keep notified only for promos
    -- still present AND still ending on the same date).
    new.notified_promo_ids := (
      select coalesce(array_agg(id), '{}')
        from unnest(coalesce(old.notified_promo_ids, '{}')) as id
        where id = any (v_current_ids)
          and exists (
            select 1 from jsonb_array_elements(old.promotions) ao
            where ao->>'id' = id
              and (ao->>'end_date') = (
                select p->>'end_date' from jsonb_array_elements(new.promotions) p
                where p->>'id' = id limit 1
              )
          )
    );
  end if;

  -- Keep brand_id synced with the referenced product's brand
  if tg_op = 'INSERT' or new.product_id <> old.product_id then
    select brand_id into new.brand_id from public.brand_products where id = new.product_id;
  end if;

  return new;
end;
$$;
