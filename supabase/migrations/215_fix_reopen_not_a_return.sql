-- ============================================================
-- WurxOS v2 — Migration 215: a self-edit "reopen" is NOT a return.
--
-- BUG: the report_returns trigger (mig 203) logs a return on ANY downward
-- status move, including `approved → verified`. But the OL "Reopen to
-- edit" flow (reopenReport target='verified') is exactly that transition —
-- the OL is reopening their OWN approved report to tweak it, NOT returning
-- it to anyone. The result: after reopening to edit, the OL saw a
-- "Report Returned · Returned to you" notice, which is wrong (nobody
-- returned it; they reopened it themselves).
--
-- Distinguishing signal: a genuine return always carries a rejection note
-- and lands at the recipient's stage ('submitted' = TL, 'draft' = APC).
-- The self-edit reopen lands at 'verified' with NO note (reopenReport sets
-- rejection_note=null only for target='verified'). So: do NOT log a return
-- for `approved → verified` when there is no note — that's a self-edit.
--
-- Recreated trigger fn verbatim from mig 203, adding only that guard.
-- Then deletes the spurious self-edit rows already logged.
--
-- Idempotent.
-- ============================================================

create or replace function public.log_report_return()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if (
       (old.status = 'approved'  and new.status in ('verified','submitted','draft'))
    or (old.status = 'verified'  and new.status in ('submitted','draft'))
    or (old.status = 'submitted' and new.status = 'draft')
  )
  -- ...but NOT an OL self-edit reopen: approved → verified with no note is
  -- the report's own owner reopening to edit, not a return to anyone.
  and not (
       old.status = 'approved'
   and new.status = 'verified'
   and coalesce(new.rejection_note, '') = ''
  ) then
    insert into public.report_returns (report_id, returned_by, returned_at, from_status, to_status, note)
    values (
      new.id,
      coalesce(new.rejected_by, new.reopened_by, auth.uid()),
      coalesce(new.rejected_at, new.reopened_at, now()),
      old.status,
      new.status,
      new.rejection_note
    );
  end if;
  return new;
end;
$$;

-- Clean up the spurious self-edit "returns" already logged (approved →
-- verified with no note). These were never real returns.
delete from public.report_returns
 where from_status = 'approved'
   and to_status = 'verified'
   and coalesce(note, '') = '';
