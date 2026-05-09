-- ============================================================
-- Migration 139 — Add campaigns + product_campaigns + brand_products
-- to supabase_realtime publication, set REPLICA IDENTITY FULL,
-- and grant SELECT to supabase_realtime_admin.
--
-- User asked (2026-05-08): make campaigns + tasks realtime so
-- adding/editing reflects immediately without page reload. tasks
-- was already in the publication (mig 015); campaigns weren't.
-- ============================================================

do $$
declare
  t text;
begin
  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    raise notice 'supabase_realtime publication not present — skipping';
    return;
  end if;

  for t in select unnest(array[
    'campaigns',
    'product_campaigns',
    'brand_products'
  ])
  loop
    -- Add to publication if not already there
    if not exists (
      select 1 from pg_publication_tables
       where pubname = 'supabase_realtime'
         and schemaname = 'public'
         and tablename  = t
    ) then
      execute format('alter publication supabase_realtime add table public.%I', t);
      raise notice 'Added % to supabase_realtime', t;
    end if;

    -- REPLICA IDENTITY FULL so UPDATE/DELETE deliver full row
    execute format('alter table public.%I replica identity full', t);

    -- Grant SELECT to supabase_realtime_admin so RLS can be evaluated
    -- against the row payload
    begin
      execute format('grant select on public.%I to supabase_realtime_admin', t);
    exception when undefined_object then
      null; -- role may not exist on this Supabase plan
    end;
  end loop;
end;
$$;
