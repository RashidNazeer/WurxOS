-- ============================================================
-- Migration 132 — Sync bypass for the incentives guard trigger
--
-- Migration 059 added BEFORE UPDATE trigger `incentives_guard` that
-- blocks non-admins from flipping verified / payout_cleared /
-- basic_salary. The Firestore→Supabase sync upserts incentives rows
-- as service_role with no auth.uid(), so the guard treats it as a
-- non-admin and rejects any change to those fields.
--
-- Same fix as mig 131: let service_role through. service_role is
-- only used by the sync (and other server-only admin paths); never
-- by client requests, so the human-facing guard is unchanged.
-- ============================================================

create or replace function public.incentives_guard()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_is_admin bool := public.is_boss(auth.uid()) or exists (
    select 1 from public.profiles p
    where p.id = auth.uid() and p.role in ('ol','developer') and p.is_active = true
  );
begin
  -- service_role is the v1→v2 sync (or other admin tooling). Always
  -- allowed; the import legitimately re-stamps verified / payout
  -- state captured from v1.
  if pg_has_role(current_user, 'service_role', 'member') then
    return new;
  end if;

  if not v_is_admin then
    if new.verified         is distinct from old.verified         then raise exception 'only admin can verify'; end if;
    if new.payout_cleared   is distinct from old.payout_cleared   then raise exception 'only admin can clear payout'; end if;
    if new.basic_salary     is distinct from old.basic_salary     then raise exception 'only admin can edit salary'; end if;
  end if;

  -- Cannot flip payout_cleared unless the row is also verified.
  if new.payout_cleared is true and new.verified is false then
    raise exception 'cannot clear payout before verification';
  end if;

  -- Stamp verified_by / cleared_by on the transition
  if old.verified is distinct from new.verified and new.verified then
    new.verified_by := auth.uid();
    new.verified_at := now();
  end if;
  if old.payout_cleared is distinct from new.payout_cleared and new.payout_cleared then
    new.payout_cleared_by := auth.uid();
    new.payout_cleared_at := now();
  end if;

  return new;
end;
$$;
