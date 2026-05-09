-- ============================================================
-- 115 — Inactive brand write blocks
--
-- When a brand is marked inactive:
--   * tasks against it can't be created
--   * campaigns against it can't be created
--   * product_campaigns against it can't be created
--   * brand_products on it can't be created
--   * reports against it can't be created
--
-- Existing rows remain editable so people can finish closing them
-- out (mark old tasks done, finalize a draft report). A fresh
-- INSERT is what's blocked.
--
-- The check runs at INSERT time. Boss / OL / Developer (admins) are
-- still allowed to insert — handy if they need to backfill records
-- on an inactive brand for any reason.
-- ============================================================

create or replace function public._brand_write_block_check()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_status text;
begin
  if new.brand_id is null then return new; end if;

  select status into v_status from public.brands where id = new.brand_id;
  if v_status is null then return new; end if;
  if v_status = 'active' then return new; end if;

  -- Boss / OL / Developer can still insert if they need to.
  if exists (
    select 1 from public.profiles p
    where p.id = auth.uid() and p.is_active = true
      and p.role in ('boss','ol','developer')
  ) then return new; end if;

  raise exception 'Brand is inactive — new % records cannot be created on this brand. Reactivate the brand first.',
    tg_table_name
    using errcode = 'P0008';
end;
$$;

-- Tasks
drop trigger if exists tasks_block_inactive_brand on public.tasks;
create trigger tasks_block_inactive_brand
  before insert on public.tasks
  for each row execute function public._brand_write_block_check();

-- Campaigns (paid-collab)
drop trigger if exists campaigns_block_inactive_brand on public.campaigns;
create trigger campaigns_block_inactive_brand
  before insert on public.campaigns
  for each row execute function public._brand_write_block_check();

-- Product campaigns
drop trigger if exists product_campaigns_block_inactive_brand on public.product_campaigns;
create trigger product_campaigns_block_inactive_brand
  before insert on public.product_campaigns
  for each row execute function public._brand_write_block_check();

-- Brand products
drop trigger if exists brand_products_block_inactive_brand on public.brand_products;
create trigger brand_products_block_inactive_brand
  before insert on public.brand_products
  for each row execute function public._brand_write_block_check();

-- Reports
drop trigger if exists reports_block_inactive_brand on public.reports;
create trigger reports_block_inactive_brand
  before insert on public.reports
  for each row execute function public._brand_write_block_check();
