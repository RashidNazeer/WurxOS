-- ============================================================
-- WurxOS v2 — Migration 323: make an invalid share attempt FAIL rather than
-- be silently ignored.
--
-- Mig 322's trigger coerced `shared_with_client` back to false whenever the
-- status was not 'approved'. The invariant held — a draft can never reach a
-- client — but the write SUCCEEDED, so a caller ticking the box on an
-- unapproved report got HTTP 204 and no complaint, and the UI would show a
-- tick that vanished on the next refresh. Verified against a real draft row:
-- the PATCH returned success and the column stayed false.
--
-- Two different situations were being handled by one rule, and they deserve
-- opposite treatment:
--
--   a) Someone TICKS an unapproved report.
--      A mistake. Must fail loudly so the caller knows nothing happened.
--
--   b) An already-shared report LEAVES 'approved' (returned for revision,
--      reopened). Not a mistake, and the person doing it is often an author or
--      TL who has no say over client sharing. Must succeed and withdraw the
--      report silently — erroring here would block returns entirely.
--
-- The two are told apart by whether the report was ALREADY shared: (b) always
-- starts from shared = true, (a) never does.
--
-- Idempotent. Replaces the function body only; the trigger from 322 stands.
-- ============================================================

create or replace function public.reports_unshare_on_unapprove()
returns trigger
language plpgsql
as $$
begin
  if new.shared_with_client and new.status is distinct from 'approved' then
    if tg_op = 'UPDATE' and old.shared_with_client then
      -- (b) it was published and is now going back for revision: withdraw it,
      -- quietly, so the return itself is never blocked.
      new.shared_with_client := false;
    else
      -- (a) an attempt to publish something that is not approved.
      raise exception
        'This report cannot be shared with the client until it is approved (current status: %).', new.status
        using errcode = 'check_violation';
    end if;
  end if;
  return new;
end;
$$;
