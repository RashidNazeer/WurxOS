-- ============================================================
-- WurxOS v2 — Migration 230: link the Bentgo brand to Euka.
--
-- Bentgo (managed by Romail Hafeez) is a SEPARATE individual Euka account with
-- its own OpenAPI key (secret EUKA_API_KEY_BENTGO) — the same "own key" pattern
-- as Solid Gold / Inno Supps. Its Euka store was confirmed live against the
-- Bentgo key's /stores:
--   store_id daf16999-c7aa-47c7-b8cc-8a4fc1186d5c  name "Bentgo"  region US.
--
-- Adds the store to the euka_stores reference list (so the Add/Edit Brand form
-- offers it in the dropdown) and backfills the existing "Bentgo" brand row with
-- euka_store_id + euka_slug so the brand-aware edge fns (euka-report-autofill,
-- video-review-targets) can resolve its store + key. Idempotent.
-- ============================================================

insert into public.euka_stores (store_id, slug, label, key_kind) values
  ('daf16999-c7aa-47c7-b8cc-8a4fc1186d5c', 'bentgo', 'Bentgo', 'own')
on conflict (store_id) do update
  set slug = excluded.slug, label = excluded.label, key_kind = excluded.key_kind, is_active = true;

update public.brands b
set euka_store_id = 'daf16999-c7aa-47c7-b8cc-8a4fc1186d5c', euka_slug = 'bentgo'
where lower(btrim(b.brand_name)) = 'bentgo';
