-- ============================================================
-- WurxOS v2 — Migration 160: client_access.client column + backfill
--
-- Background: client_access.client_name was being used as a per-link
-- DISPLAY label ("Kelsey - Bentgo", "Kelsey - FlyWell"), not the
-- umbrella client. Filtering on it produced a dropdown with every
-- link variant instead of grouping them by client.
--
-- Fix: add a separate `client` column that holds the umbrella client.
-- Auto-fill it from the linked brand's client_name where the link
-- targets exactly one client. If multiple brands have different
-- clients, leave it null (the UI will handle that case).
--
-- The original client_name column stays as-is (display label). The
-- UI filter switches to the new `client` column.
--
-- Idempotent.
-- ============================================================

alter table public.client_access
  add column if not exists client text default '';

create index if not exists client_access_client_idx
  on public.client_access(client)
  where coalesce(client, '') <> '';

-- Auto-fill trigger: whenever a link is inserted or its brand_ids
-- change, recompute `client` from the linked brand's client_name.
-- If all linked brands share one non-empty client_name, use it.
-- Otherwise leave the previously-set value alone (Boss can edit by
-- hand later if needed — UI does that via the Edit modal).
create or replace function public.client_access_set_client()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_clients text[];
begin
  if new.brand_ids is null or array_length(new.brand_ids, 1) is null then
    return new;
  end if;

  select array_agg(distinct nullif(trim(b.client_name), ''))
    into v_clients
    from public.brands b
   where b.id = any(new.brand_ids);

  -- array_agg with distinct + nullif can return {NULL}. Filter that out.
  v_clients := array_remove(v_clients, null);

  if array_length(v_clients, 1) = 1 then
    new.client := v_clients[1];
  end if;
  -- Multiple distinct clients or zero → don't override. If client is
  -- still empty, it stays empty; the UI's filter just won't include
  -- this link.
  return new;
end;
$$;

drop trigger if exists client_access_set_client_bi on public.client_access;
create trigger client_access_set_client_bi
  before insert or update of brand_ids on public.client_access
  for each row execute function public.client_access_set_client();

-- Backfill existing rows by running the same logic.
do $$
declare
  r record;
  v_clients text[];
  v_filled  int := 0;
  v_ambig   int := 0;
begin
  for r in select id, brand_ids, client from public.client_access loop
    if r.brand_ids is null or array_length(r.brand_ids, 1) is null then
      continue;
    end if;
    select array_remove(array_agg(distinct nullif(trim(b.client_name), '')), null)
      into v_clients
      from public.brands b
     where b.id = any(r.brand_ids);
    if v_clients is null or array_length(v_clients, 1) is null then
      continue;
    end if;
    if array_length(v_clients, 1) = 1 then
      if r.client is distinct from v_clients[1] then
        update public.client_access set client = v_clients[1] where id = r.id;
        v_filled := v_filled + 1;
      end if;
    else
      v_ambig := v_ambig + 1;
    end if;
  end loop;
  raise notice '[mig 160] backfilled client on % links; % links span multiple clients (left null)',
    v_filled, v_ambig;
end;
$$;
