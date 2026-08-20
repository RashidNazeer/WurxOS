-- ============================================================
-- WurxOS v2 — Migration 326: close a real bypass in the share-with-client
-- role guard introduced by mig 322.
--
-- THE HOLE. reports_guard_share_flag only objected when
--     new.status = 'approved' AND old.status = 'approved'
-- The intent was "ignore the automatic unshare caused by a status change".
-- The effect was that ANY update which changed the status in the same
-- statement skipped the role check completely. So:
--
--     PATCH /reports?id=eq.<id>
--     { "status": "approved", "shared_with_client": true }
--
-- on a DRAFT report set both, published it to the client portal, and never ran
-- the Boss/OL check. Verified live against a test-brand draft: it came back
-- status=approved, shared=true.
--
-- Who could actually do it: the reports UPDATE policy (mig 012) is broad —
-- boss, ol, developer, THE AUTHOR, and the brand-owning TL — and there is no
-- server-side guard on report status transitions at all. So an APC could
-- self-approve their own report AND publish it to the client in one request,
-- with no OL involvement. The self-approve half is pre-existing; mig 322 added
-- the publish half, which is the part that reaches a client.
--
-- THE FIX. Decide on the CHANGE ITSELF, not on what the status is doing.
-- Turning the tick ON always requires Boss/OL. The single exception is turning
-- it OFF while the report is not approved, which is the automatic withdrawal
-- and must stay open to whoever is allowed to return a report (authors and TLs
-- included) or returns would start failing for them.
--
-- INSERT is covered too. Nothing creates a report pre-shared today, but the
-- old trigger only examined UPDATE, so an INSERT carrying the flag would have
-- gone straight through.
--
-- Idempotent.
-- ============================================================

create or replace function public.reports_guard_share_flag()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_needs_check boolean := false;
begin
  if tg_op = 'INSERT' then
    -- Creating a row already ticked is a publishing decision.
    v_needs_check := new.shared_with_client;

  elsif new.shared_with_client is distinct from old.shared_with_client then
    -- The flag is genuinely moving. Everything requires Boss/OL EXCEPT the
    -- automatic withdrawal that accompanies a report leaving 'approved'.
    v_needs_check := not (
      new.shared_with_client = false
      and new.status is distinct from 'approved'
    );
  end if;

  if v_needs_check then
    -- auth.uid() is null for the service role and for migrations, which must
    -- stay able to run backfills.
    if v_uid is not null
       and not public.is_boss(v_uid)
       and not exists (
         select 1 from public.profiles p
         where p.id = v_uid and p.role in ('ol', 'developer') and p.is_active = true
       ) then
      raise exception
        'Only an Operations Lead or the Boss can change whether a report is shared with the client.'
        using errcode = 'insufficient_privilege';
    end if;
  end if;

  return new;
end;
$$;

drop trigger if exists reports_guard_share_flag_trg on public.reports;
create trigger reports_guard_share_flag_trg
  before insert or update on public.reports
  for each row execute function public.reports_guard_share_flag();
