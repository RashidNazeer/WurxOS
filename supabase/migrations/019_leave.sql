-- ============================================================
-- WurxOS v2 — Migration 019: Leave system (M-Leave)
--
-- Adds:
--   * leave_requests table (type/dates/status/reason/decision)
--   * leave_approver(uid) → reports_to, or Boss for root roles
--   * consumed_leaves(uid, year)  → { wfh, medical, emergency }
--   * RLS: requester manages own; approver + Boss see/decide
--   * Notification triggers on submit + decision
--
-- Safe to re-run.
-- ============================================================

-- --------------------------------------------------------------
-- 1. leave_requests
-- --------------------------------------------------------------
create table if not exists public.leave_requests (
  id            uuid primary key default gen_random_uuid(),
  requester_id  uuid not null references public.profiles(id) on delete cascade,
  type          text not null check (type in ('wfh', 'medical', 'emergency')),
  start_date    date not null,
  end_date      date not null,
  reason        text not null default '',
  status        text not null default 'pending'
                  check (status in ('pending', 'approved', 'rejected', 'cancelled')),
  decided_by    uuid references public.profiles(id) on delete set null,
  decided_at    timestamptz,
  decision_note text,
  created_at    timestamptz not null default now(),
  check (end_date >= start_date)
);

create index if not exists leave_requests_requester_idx on public.leave_requests(requester_id, created_at desc);
create index if not exists leave_requests_status_idx    on public.leave_requests(status);
create index if not exists leave_requests_year_idx      on public.leave_requests(requester_id, extract(year from start_date));

-- --------------------------------------------------------------
-- 2. Helper: who approves leave for a given user?
--    Their reports_to if set; otherwise the first active Boss.
-- --------------------------------------------------------------
create or replace function public.leave_approver(uid uuid)
returns uuid
language sql
security definer
set search_path = public
stable
as $$
  select coalesce(
    (select reports_to from public.profiles where id = uid and reports_to is not null),
    (select id from public.profiles where role = 'boss' and is_active = true order by created_at asc limit 1)
  );
$$;
grant execute on function public.leave_approver(uuid) to authenticated;

-- --------------------------------------------------------------
-- 3. Consumption summary — days of leave used this year
-- --------------------------------------------------------------
create or replace function public.consumed_leaves(p_user uuid, p_year int)
returns jsonb
language sql
security definer
set search_path = public
stable
as $$
  with days as (
    select
      type,
      sum((end_date - start_date + 1))::int as d
    from public.leave_requests
    where requester_id = p_user
      and status = 'approved'
      and extract(year from start_date) = p_year
    group by type
  )
  select jsonb_build_object(
    'wfh',       coalesce((select d from days where type = 'wfh'), 0),
    'medical',   coalesce((select d from days where type = 'medical'), 0),
    'emergency', coalesce((select d from days where type = 'emergency'), 0)
  );
$$;
grant execute on function public.consumed_leaves(uuid, int) to authenticated;

-- --------------------------------------------------------------
-- 4. RLS
-- --------------------------------------------------------------
alter table public.leave_requests enable row level security;

-- Requester sees own; approver of the requester sees theirs; Boss/OL see all.
drop policy if exists "leave_select" on public.leave_requests;
create policy "leave_select"
  on public.leave_requests for select
  using (
    auth.uid() = requester_id
    or auth.uid() = public.leave_approver(requester_id)
    or public.is_boss(auth.uid())
    or exists (
      select 1 from public.profiles p
      where p.id = auth.uid() and p.role in ('ol', 'developer') and p.is_active = true
    )
  );

-- Requester submits their own pending request.
drop policy if exists "leave_insert" on public.leave_requests;
create policy "leave_insert"
  on public.leave_requests for insert
  with check (
    auth.uid() = requester_id
    and status = 'pending'
  );

-- Requester may cancel own pending; approver / Boss may decide.
drop policy if exists "leave_update" on public.leave_requests;
create policy "leave_update"
  on public.leave_requests for update
  using (
    (auth.uid() = requester_id and status = 'pending')
    or auth.uid() = public.leave_approver(requester_id)
    or public.is_boss(auth.uid())
  )
  with check (
    (auth.uid() = requester_id and status in ('pending', 'cancelled'))
    or auth.uid() = public.leave_approver(requester_id)
    or public.is_boss(auth.uid())
  );

-- --------------------------------------------------------------
-- 5. Notification triggers — submit + decision
-- --------------------------------------------------------------
create or replace function public.leave_notify_on_insert()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_approver uuid;
  v_name     text;
begin
  v_approver := public.leave_approver(new.requester_id);
  if v_approver is null or v_approver = new.requester_id then return new; end if;

  v_name := public.profile_display_name(new.requester_id);
  perform public.emit_notification(
    v_approver, new.requester_id, 'leave', 'leave.requested',
    'New leave request',
    v_name || ' requested ' || new.type || ' leave ('
      || to_char(new.start_date, 'Mon DD')
      || case when new.end_date <> new.start_date then ' – ' || to_char(new.end_date, 'Mon DD') else '' end
      || ')',
    'leave', new.id, '/leave/approvals'
  );
  return new;
end;
$$;

drop trigger if exists leave_notify_ai on public.leave_requests;
create trigger leave_notify_ai
  after insert on public.leave_requests
  for each row execute function public.leave_notify_on_insert();

create or replace function public.leave_notify_on_update()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor uuid := auth.uid();
  v_name  text;
begin
  if old.status is distinct from new.status and new.status in ('approved', 'rejected') then
    v_name := coalesce(public.profile_display_name(v_actor), 'Someone');
    perform public.emit_notification(
      new.requester_id, v_actor, 'leave', 'leave.' || new.status,
      'Leave ' || new.status,
      v_name || ' ' || new.status || ' your '
        || new.type || ' leave on ' || to_char(new.start_date, 'Mon DD'),
      'leave', new.id, '/leave'
    );
  end if;
  return new;
end;
$$;

drop trigger if exists leave_notify_au on public.leave_requests;
create trigger leave_notify_au
  after update of status on public.leave_requests
  for each row execute function public.leave_notify_on_update();
