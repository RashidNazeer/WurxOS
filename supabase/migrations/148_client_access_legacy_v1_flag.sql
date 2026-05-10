-- ============================================================
-- 148 — `legacy_v1` flag on client_access rows
--
-- Marks the 32 client links we synced from v1's `clientAccess`
-- Firestore collection so v2's UI can render them with the original
-- v1 URL (wurxos.web.app/client/<token>) instead of v2's native URL.
-- The token itself is identical in both worlds, and v1's hosting
-- now redirects /client/<token> → wurxos.vercel.app/portal/access/
-- <token>, so both URLs resolve to the same v2 portal page.
--
-- New rows created in v2 going forward will have legacy_v1=false
-- (the column default) and v2's UI will render the v2 URL for them.
-- ============================================================

alter table public.client_access
  add column if not exists legacy_v1 boolean not null default false;

-- Flag the 32 historical rows. Identified by the token shape: v1's
-- Firestore doc IDs are 20 chars, v2-native tokens are 32 chars and
-- come from clientAccessApi.js's randomToken() generator. Using the
-- length distinction is exact for the current dataset and safe for
-- a one-off backfill.
update public.client_access
   set legacy_v1 = true
 where length(token) = 20
   and legacy_v1 = false;
