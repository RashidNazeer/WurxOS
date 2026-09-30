-- ============================================================
-- WurxOS v2 — Migration 398: give the Developers roster a lead — Rashid
-- Nazeer as Team Lead, Umar Ilyas as Junior Developer reporting to him.
--
-- Originally written as 397; renumbered because feat/wurx-buddy landed
-- 397_ai_model_catalog.sql on main while this branch was in review (same
-- story as commit 6a34a67: "Renumber the GMV-Max goal sync to 366 (365 was
-- already taken)"). 398 is free on both main and wurxosdev.
--
-- The `developer` role has always been flat (ROLE_EXTRAS.developer in
-- src/lib/roles.js sets reportsToRole: null) because there was only ever one
-- developer. Now that there are two, the Boss wants a real lead/junior
-- structure on the Developers page:
--   • Rashid Nazeer keeps reporting to the Boss and is labelled Team Lead.
--   • Umar Ilyas now reports to Rashid (instead of nobody) and is labelled
--     Junior Developer.
--
-- NO SCHEMA CHANGE AND NO FRONTEND CHANGE NEEDED. Two features already do
-- exactly this job for every role, developer included:
--   • `responsibilities` (mig 023, text[]) is a free-text tag array rendered
--     as pills under the name on every UserListPage row.
--   • `reports_to` is already joined (adminApi.listProfilesByRole →
--     `parent:reports_to(...)`) and rendered as "Reports to <name>".
-- This is a pure data fix using functionality that already ships.
--
-- Matched by role + name, not a hardcoded id (ids differ per environment).
-- With exactly two developers, Umar is resolved as "the OTHER one" once
-- Rashid is found, so a spelling variant of his name ("Ilyas"/"Illyas")
-- can't cause a silent no-op. Idempotent: safe to re-run, never duplicates
-- a responsibility tag.
-- ============================================================

do $mig$
declare
  v_rashid uuid;
  v_umar   uuid;
  v_dev_count int;
begin
  select count(*) into v_dev_count
    from public.profiles
   where role = 'developer' and deleted_at is null;
  if v_dev_count < 2 then
    raise exception '398: expected at least 2 active developers, found %', v_dev_count;
  end if;

  select id into v_rashid
    from public.profiles
   where role = 'developer' and deleted_at is null
     and display_name ilike '%rashid%nazeer%'
   limit 1;
  if v_rashid is null then
    raise exception '398: no active developer profile matching "Rashid Nazeer" found';
  end if;

  -- The other active developer, whichever exact spelling their name uses.
  select id into v_umar
    from public.profiles
   where role = 'developer' and deleted_at is null and id <> v_rashid
   order by created_at
   limit 1;
  if v_umar is null then
    raise exception '398: no second active developer found to make Junior Developer';
  end if;

  -- Rashid: Team Lead. reports_to is untouched — he still reports to the Boss.
  update public.profiles
     set responsibilities = responsibilities || array['Team Lead']
   where id = v_rashid
     and not ('Team Lead' = any(coalesce(responsibilities, '{}')));

  -- Umar: Junior Developer, now reporting to Rashid instead of nobody.
  update public.profiles
     set responsibilities = responsibilities || array['Junior Developer'],
         reports_to = v_rashid
   where id = v_umar
     and not ('Junior Developer' = any(coalesce(responsibilities, '{}')));

  -- Umar's reports_to can drift from the tag-guard above (e.g. a re-run after
  -- someone already added the tag by hand) — set it unconditionally so the
  -- org-chart edge is never left stale.
  update public.profiles set reports_to = v_rashid where id = v_umar;

  raise notice '398: developer % is Team Lead; developer % is Junior Developer reporting to them', v_rashid, v_umar;
end;
$mig$;

do $verify$
declare
  r_resp text[];
  u_resp text[];
  u_manager uuid;
begin
  select p.responsibilities into r_resp
    from public.profiles p
   where p.role = 'developer' and p.deleted_at is null and p.display_name ilike '%rashid%nazeer%'
   limit 1;
  if not ('Team Lead' = any(coalesce(r_resp, '{}'))) then
    raise exception '398: Rashid Nazeer is missing the Team Lead tag';
  end if;

  select p.responsibilities, p.reports_to into u_resp, u_manager
    from public.profiles p
   where p.role = 'developer' and p.deleted_at is null
     and p.id <> (select id from public.profiles where role = 'developer' and deleted_at is null and display_name ilike '%rashid%nazeer%' limit 1)
   order by created_at
   limit 1;
  if not ('Junior Developer' = any(coalesce(u_resp, '{}'))) then
    raise exception '398: the junior developer is missing the Junior Developer tag';
  end if;
  if u_manager is null then
    raise exception '398: the junior developer has no reports_to set';
  end if;

  raise notice '398: verified — developer team lead/junior structure is in place';
end;
$verify$;
