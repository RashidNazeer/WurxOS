-- ============================================================================
-- Give the TLs and APCs access to their brands.  PRODUCTION SQL Editor.
-- Status as of 2026-10-13: NOT CONFIRMED APPLIED. See HANDOVER.md, "Open items".
--
-- WHY THIS IS A DATA FIX, NOT AN APP FIX. Both brand pickers read live data:
--     TL   -> brands where owner_id = me and status = 'active'
--     APC  -> brand_assignments where user_id = me, then active brands only
-- and report visibility is the same two facts again:
--     reports_select -> can_view_report -> can_view_brand
--                     -> b_owner = me                        (the TL)
--                     -> or a brand_assignments row for me   (the APC)
-- The brand_assignments branch has been in can_view_brand since mig 316, which
-- production has. So nothing in the code blocks this. If a TL or APC cannot
-- see a brand, owner_id / brand_assignments still hold old values.
--
-- Brands only: no roles, no retirements, no OL sets. Safe to run repeatedly.
-- Run as-is first (v_dry_run = true) to see current -> intended, then set
-- v_dry_run := false. The SELECT at the end prints the final state either way.
-- ============================================================================

do $fix$
declare
  v_dry_run boolean := true;     -- set false to apply
  r         record;
  v_brand   uuid;
  v_tl      uuid;
  v_apc     uuid;
  v_bname   text;
  n         int;
  v_bad     text := '';
  v_plan    text := '';
begin
  create temporary table _want (label text primary key, tl_name text, apc_name text) on commit drop;
  insert into _want (label, tl_name, apc_name) values
    ('Swisse',           'Haider Ali',    'Raeed Ahmed'),
    ('Aurelia US',       'Haider Ali',    'Raeed Ahmed'),
    ('apothecary',       'Haider Ali',    'Azan Khan'),
    ('Inno Supps',       'Haider Ali',    'Abrahim'),
    ('Klassy Network',   'Haider Ali',    'Mian Hassan'),
    ('BiosTime',         'Haider Ali',    'Azan Khan'),
    ('Penetrex',         'Muhammad Azam', 'Haseeb'),
    ('Dr Tobias',        'Muhammad Azam', 'Haseeb'),
    ('Dr Harvey''s',     'Muhammad Azam', 'Haseeb'),
    ('AquaSonic',        'Muhammad Azam', 'Umair Tariq'),
    ('Honeysticks',      'Muhammad Azam', 'Umair Tariq'),
    ('Mineral ice',      'Muhammad Azam', 'Umair Tariq'),
    ('irwin Natural',    'Muhammad Azam', 'Haseeb'),
    ('Cutler Nutrition', 'Ali Hamza',     'Hamza Babar'),
    ('Joy mode',         'Ali Hamza',     'Hamza Babar'),
    ('Bentgo',           'Ali Hamza',     'Romail'),
    ('Yesday',           'Ali Hamza',     'Romail'),
    ('Kenashii',         'Ali Hamza',     'Romail'),
    ('Pure Daily Care',  'Ali Hamza',     'Hamza Babar');

  for r in select * from _want loop
    select b.id, b.brand_name into v_brand, v_bname from public.brands b
     where lower(regexp_replace(b.brand_name,'[^a-zA-Z0-9]','','g'))
         = lower(regexp_replace(r.label,'[^a-zA-Z0-9]','','g'));
    if v_brand is null then
      select count(*) into n from public.brands b
       where lower(regexp_replace(b.brand_name,'[^a-zA-Z0-9]','','g')) like lower(regexp_replace(r.label,'[^a-zA-Z0-9]','','g')) || '%'
          or lower(regexp_replace(r.label,'[^a-zA-Z0-9]','','g')) like lower(regexp_replace(b.brand_name,'[^a-zA-Z0-9]','','g')) || '%';
      if n = 1 then
        select b.id, b.brand_name into v_brand, v_bname from public.brands b
         where lower(regexp_replace(b.brand_name,'[^a-zA-Z0-9]','','g')) like lower(regexp_replace(r.label,'[^a-zA-Z0-9]','','g')) || '%'
            or lower(regexp_replace(r.label,'[^a-zA-Z0-9]','','g')) like lower(regexp_replace(b.brand_name,'[^a-zA-Z0-9]','','g')) || '%';
      else
        v_bad := v_bad || '  brand "' || r.label || '" matched ' || n || ' rows' || e'\n'; continue;
      end if;
    end if;

    select p.id into v_tl  from public.profiles p
     where p.deleted_at is null and lower(btrim(p.display_name)) = lower(btrim(r.tl_name));
    select p.id into v_apc from public.profiles p
     where p.deleted_at is null and lower(btrim(p.display_name)) = lower(btrim(r.apc_name));
    if v_tl is null  then v_bad := v_bad || '  no such TL: '  || r.tl_name  || e'\n'; continue; end if;
    if v_apc is null then v_bad := v_bad || '  no such APC: ' || r.apc_name || e'\n'; continue; end if;

    v_plan := v_plan || '  ' || rpad(v_bname, 22)
      || 'owner: ' || rpad(coalesce((select display_name from public.profiles where id = (select owner_id from public.brands where id = v_brand)), '?'), 16)
      || ' -> ' || rpad(r.tl_name, 16)
      || ' | apc: ' || rpad(coalesce((select string_agg(p.display_name, '+') from public.brand_assignments ba join public.profiles p on p.id = ba.user_id where ba.brand_id = v_brand), '-'), 16)
      || ' -> ' || r.apc_name || e'\n';

    if not v_dry_run then
      -- mig 025's owner guard blocks owner_id changes outside the switch flow;
      -- this is the same bypass admin_reassign_orphaned_brands uses.
      perform set_config('wurxos.bypass_owner_guard', 'on', true);
      update public.brands set owner_id = v_tl where id = v_brand;
      delete from public.brand_assignments where brand_id = v_brand;
      insert into public.brand_assignments (brand_id, user_id) values (v_brand, v_apc)
      on conflict do nothing;
      perform set_config('wurxos.bypass_owner_guard', 'off', true);
    end if;
    v_brand := null; v_tl := null; v_apc := null;
  end loop;

  if v_bad <> '' then
    raise exception e'Nothing was changed.\n\n=== COULD NOT RESOLVE ===\n%', v_bad;
  end if;
  if v_dry_run then
    raise exception e'DRY RUN - NOTHING CHANGED.\n\n=== current -> intended ===\n%\nSet v_dry_run := false and run again to apply.', v_plan;
  end if;
  raise notice 'Applied.';
end
$fix$;

-- The result: every active brand with its owner TL and assigned APC.
select b.brand_name,
       tl.display_name  as owner_tl,
       coalesce(string_agg(apc.display_name, ', '), '- none -') as assigned_apc
from public.brands b
join public.profiles tl               on tl.id = b.owner_id
left join public.brand_assignments ba on ba.brand_id = b.id
left join public.profiles apc         on apc.id = ba.user_id
where b.status = 'active'
group by b.id, b.brand_name, tl.display_name
order by tl.display_name, b.brand_name;
