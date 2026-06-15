-- ============================================================
-- WurxOS v2 — Migration 203: report return history (visible to the
-- person receiving a returned report, across the whole approval chain).
--
-- Problem: when a report is returned (TL→APC, OL→TL, Boss→…), the note
-- was kept only in reports.rejection_note (latest, overwritten + cleared
-- on resubmit) and the UI banner only showed at status='draft' in the
-- edit form. So a report returned to 'submitted'/'verified' showed
-- nothing, the read-only views showed nothing, and there was no who/when
-- and no history.
--
-- This migration adds an append-only report_returns log + a trigger that
-- records EVERY return automatically whenever a report's status moves
-- DOWN the chain (the same transition the notification trigger uses).
-- Each row: who returned it, when, from→to status, and the note. The UI
-- reads this to show a prominent "Report Returned" notice (to whoever now
-- holds the report) plus full return history — generic at every level.
--
-- Idempotent.
-- ============================================================

create table if not exists public.report_returns (
  id          uuid primary key default gen_random_uuid(),
  report_id   uuid not null references public.reports(id) on delete cascade,
  returned_by uuid references public.profiles(id) on delete set null,
  returned_at timestamptz not null default now(),
  from_status text,
  to_status   text,
  note        text,
  created_at  timestamptz not null default now()
);

create index if not exists report_returns_report_idx
  on public.report_returns(report_id, returned_at desc);

alter table public.report_returns enable row level security;

-- SELECT: anyone who can see the parent report — author, brand owner (TL),
-- an APC/IPC assigned to the brand, or Boss/OL/Developer.
drop policy if exists "report_returns_select" on public.report_returns;
create policy "report_returns_select"
  on public.report_returns for select
  using (
    public.is_boss(auth.uid())
    or exists (select 1 from public.profiles p
               where p.id = auth.uid() and p.role in ('ol','developer') and p.is_active = true)
    or exists (
      select 1 from public.reports r
      where r.id = report_returns.report_id
        and (
          r.author_id = auth.uid()
          or exists (select 1 from public.brands b where b.id = r.brand_id and b.owner_id = auth.uid())
          or exists (select 1 from public.brand_assignments ba where ba.brand_id = r.brand_id and ba.user_id = auth.uid())
        )
    )
  );

-- No client writes — rows are inserted only by the SECURITY DEFINER trigger.
drop policy if exists "report_returns_no_insert" on public.report_returns;
create policy "report_returns_no_insert" on public.report_returns for insert with check (false);
drop policy if exists "report_returns_no_update" on public.report_returns;
create policy "report_returns_no_update" on public.report_returns for update using (false);

-- ── Trigger: log a return whenever status moves DOWN the chain ──
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

drop trigger if exists trg_log_report_return on public.reports;
create trigger trg_log_report_return
  after update of status on public.reports
  for each row execute function public.log_report_return();

-- One-shot backfill: in-flight reports that are CURRENTLY returned (have a
-- live rejection_note and sit at a pre-approval stage) get a history row so
-- their recipient keeps seeing the reason after this ships. Skips rows that
-- already have history (idempotent). The trigger fires on UPDATE only, so
-- this INSERT does not re-trigger it.
insert into public.report_returns (report_id, returned_by, returned_at, from_status, to_status, note)
select r.id, r.rejected_by, coalesce(r.rejected_at, r.updated_at, now()), null, r.status, r.rejection_note
  from public.reports r
 where r.rejection_note is not null and r.rejection_note <> ''
   and r.status in ('draft', 'submitted', 'verified')
   and not exists (select 1 from public.report_returns rr where rr.report_id = r.id);

do $$ begin
  alter publication supabase_realtime add table public.report_returns;
exception when duplicate_object then null;
end $$;
