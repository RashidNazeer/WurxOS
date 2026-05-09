-- ============================================================
-- Migration 064 — Block duplicate pending leave per user
--
-- v1 allowed unlimited in-flight requests, which led to mess: a user
-- could spam 5 overlapping WFH requests while waiting on the first.
-- Rule: one in-flight (status = 'pending') request per requester.
-- They must wait until the prior one is approved, rejected, or
-- cancelled before submitting another.
--
-- Enforced two ways so the error is always human-readable:
--   1. Partial unique index — belt: makes the invariant crash-proof.
--   2. BEFORE INSERT trigger — suspenders: raises a clean exception
--      with the prior request's info so the UI can explain.
-- ============================================================

create unique index if not exists leave_one_pending_per_user
  on public.leave_requests (requester_id)
  where status = 'pending';

create or replace function public.leave_block_duplicate_pending()
returns trigger
language plpgsql
as $$
declare
  v_existing public.leave_requests;
begin
  if new.status is distinct from 'pending' then
    return new;   -- only constrain pending inserts
  end if;

  select * into v_existing
    from public.leave_requests
    where requester_id = new.requester_id
      and status = 'pending'
    limit 1;

  if found then
    raise exception
      'You already have a pending leave request (submitted %). Wait for it to be approved, rejected, or cancel it before submitting another.',
      to_char(v_existing.created_at, 'Mon DD, YYYY')
      using errcode = 'unique_violation';
  end if;

  return new;
end;
$$;

drop trigger if exists trg_leave_block_duplicate_pending on public.leave_requests;
create trigger trg_leave_block_duplicate_pending
  before insert on public.leave_requests
  for each row execute function public.leave_block_duplicate_pending();
