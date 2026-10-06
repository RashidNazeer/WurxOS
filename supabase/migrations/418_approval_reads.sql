-- ============================================================
-- WurxOS v2 — Migration 414: per-user read state for the Approvals inbox.
--
-- "Mark as read" on /approvals records the items the user has seen, so the
-- sidebar / bottom-tab count drops to zero. The item stays in the inbox until
-- it is decided. item_key is '<kind>:<id>' as built in approvalsApi.js.
-- Keyed per user per item, so an item forwarded to someone else is still
-- unread for them, and read state follows the user across devices.
-- Idempotent.
-- ============================================================

create table if not exists public.approval_reads (
  user_id  uuid not null references public.profiles(id) on delete cascade,
  item_key text not null,
  read_at  timestamptz not null default now(),
  primary key (user_id, item_key)
);

alter table public.approval_reads enable row level security;

drop policy if exists "approval_reads_own" on public.approval_reads;
create policy "approval_reads_own" on public.approval_reads
  for all
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

do $verify$
begin
  if not exists (
    select 1 from pg_policies
     where schemaname = 'public' and tablename = 'approval_reads' and policyname = 'approval_reads_own'
  ) then
    raise exception '414: approval_reads_own policy missing';
  end if;
end
$verify$;
