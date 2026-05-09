-- ============================================================
-- Migration 074 — Bug Reports
--
-- Port of v1's bugReports collection. Any authenticated user can
-- file a bug; the developer role is the triage/fix owner; the boss
-- gets a read-only overview. Each bug has a thread (chat-style)
-- where the reporter, developer, and boss can discuss progress.
--
-- State machine:
--   open → in_progress → fixed → closed
--   open → wont_fix
--   any → temp_closed  (soft-park; can reopen)
--
-- Notifications:
--   * submit       → all active developers
--   * status change → the reporter
--   * new thread message → the other participants (reporter ↔ devs + boss)
-- ============================================================

-- --------------------------------------------------------------
-- 1. bug_reports
-- --------------------------------------------------------------
create table if not exists public.bug_reports (
  id             uuid primary key default gen_random_uuid(),
  bug_type       text not null
                   check (bug_type in ('ui','functional','performance','data','auth','other')),
  priority       text not null default 'medium'
                   check (priority in ('low','medium','high','critical')),
  title          text not null,
  description    text not null,
  status         text not null default 'open'
                   check (status in ('open','in_progress','fixed','closed','temp_closed','wont_fix')),
  reporter_id    uuid not null references public.profiles(id) on delete cascade,
  -- Cached reporter metadata at submit time (v1 pattern; keeps the
  -- list page fast and immune to downstream profile edits).
  reporter_name  text,
  reporter_role  text,
  dev_notes      text,
  -- Last actor on the dev side (who last flipped the status / edited notes).
  last_actor_id  uuid references public.profiles(id) on delete set null,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

create index if not exists bug_reports_reporter_idx on public.bug_reports(reporter_id);
create index if not exists bug_reports_status_idx   on public.bug_reports(status);
create index if not exists bug_reports_created_idx  on public.bug_reports(created_at desc);

drop trigger if exists bug_reports_touch on public.bug_reports;
create trigger bug_reports_touch before update on public.bug_reports
  for each row execute function public.touch_updated_at();

-- --------------------------------------------------------------
-- 2. bug_report_messages — thread subcollection in v1, a separate
--    table in v2 so RLS can key off the bug's reporter/role.
-- --------------------------------------------------------------
create table if not exists public.bug_report_messages (
  id          uuid primary key default gen_random_uuid(),
  bug_id      uuid not null references public.bug_reports(id) on delete cascade,
  sender_id   uuid not null references public.profiles(id) on delete cascade,
  sender_name text,
  sender_role text,
  text        text not null,
  created_at  timestamptz not null default now()
);

create index if not exists bug_msg_bug_idx on public.bug_report_messages(bug_id, created_at asc);

-- --------------------------------------------------------------
-- 3. RLS
-- --------------------------------------------------------------
-- SELECT:
--   * Boss / Developer → all rows
--   * Reporter        → their own bugs only
-- INSERT:
--   * Any authenticated user can file, reporter_id must be auth.uid()
-- UPDATE:
--   * Developer → any bug (status + dev_notes)
--   * Reporter  → their own bug only before it's moved past 'open'
--                 (safety: don't let a reporter rewrite a bug that
--                 a dev has already touched)
-- DELETE:
--   * Developer or Boss
alter table public.bug_reports enable row level security;

drop policy if exists "bug_select" on public.bug_reports;
create policy "bug_select" on public.bug_reports for select
  using (
    reporter_id = auth.uid()
    or public.is_boss(auth.uid())
    or exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'developer' and p.is_active = true)
  );

drop policy if exists "bug_insert" on public.bug_reports;
create policy "bug_insert" on public.bug_reports for insert
  with check (reporter_id = auth.uid());

drop policy if exists "bug_update" on public.bug_reports;
create policy "bug_update" on public.bug_reports for update
  using (
    exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'developer' and p.is_active = true)
    or (reporter_id = auth.uid() and status = 'open')
    or public.is_boss(auth.uid())
  );

drop policy if exists "bug_delete" on public.bug_reports;
create policy "bug_delete" on public.bug_reports for delete
  using (
    public.is_boss(auth.uid())
    or exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'developer' and p.is_active = true)
  );

-- Thread messages: participants of the bug's audience can read,
-- anyone who can see the bug can post (as themselves).
alter table public.bug_report_messages enable row level security;

drop policy if exists "bug_msg_select" on public.bug_report_messages;
create policy "bug_msg_select" on public.bug_report_messages for select
  using (
    exists (select 1 from public.bug_reports b where b.id = bug_report_messages.bug_id
            and (b.reporter_id = auth.uid()
                 or public.is_boss(auth.uid())
                 or exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'developer' and p.is_active = true)))
  );

drop policy if exists "bug_msg_insert" on public.bug_report_messages;
create policy "bug_msg_insert" on public.bug_report_messages for insert
  with check (
    sender_id = auth.uid()
    and exists (select 1 from public.bug_reports b where b.id = bug_report_messages.bug_id
                and (b.reporter_id = auth.uid()
                     or public.is_boss(auth.uid())
                     or exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'developer' and p.is_active = true)))
  );

-- Authors can delete their own messages; Boss/Developer can clean up.
drop policy if exists "bug_msg_delete" on public.bug_report_messages;
create policy "bug_msg_delete" on public.bug_report_messages for delete
  using (
    sender_id = auth.uid()
    or public.is_boss(auth.uid())
    or exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'developer' and p.is_active = true)
  );

-- --------------------------------------------------------------
-- 4. Notification triggers
-- --------------------------------------------------------------
-- On submit: notify every active developer.
create or replace function public.bug_reports_notify_submit()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_dev uuid;
  v_name text := coalesce(new.reporter_name, public.profile_display_name(new.reporter_id), 'Someone');
  v_body text := v_name
               || ' reported a ' || new.priority || '-priority '
               || new.bug_type   || ' bug.';
begin
  for v_dev in
    select id from public.profiles where role = 'developer' and is_active = true
  loop
    perform public.emit_notification(
      v_dev, new.reporter_id, 'bug', 'bug.reported',
      'New bug: "' || new.title || '"',
      v_body,
      'bug_report', new.id, '/bugs'
    );
  end loop;
  return new;
end;
$$;

drop trigger if exists bug_reports_notify_submit on public.bug_reports;
create trigger bug_reports_notify_submit
  after insert on public.bug_reports
  for each row execute function public.bug_reports_notify_submit();

-- On status change: notify the reporter.
create or replace function public.bug_reports_notify_status()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor uuid := coalesce(new.last_actor_id, auth.uid());
  v_label text := case new.status
    when 'open'         then 'Open'
    when 'in_progress'  then 'In Progress'
    when 'fixed'        then 'Fixed'
    when 'closed'       then 'Closed'
    when 'temp_closed'  then 'Temporarily Closed'
    when 'wont_fix'     then 'Won''t Fix'
    else new.status
  end;
begin
  if new.status = old.status then return new; end if;
  perform public.emit_notification(
    new.reporter_id, v_actor, 'bug', 'bug.status_changed',
    'Bug updated: "' || new.title || '"',
    'Your bug report has been marked as "' || v_label || '".',
    'bug_report', new.id, '/bugs'
  );
  return new;
end;
$$;

drop trigger if exists bug_reports_notify_status on public.bug_reports;
create trigger bug_reports_notify_status
  after update of status on public.bug_reports
  for each row execute function public.bug_reports_notify_status();

-- On new thread message: notify the reporter if a dev/boss posted,
-- or notify all active developers if the reporter posted.
create or replace function public.bug_msg_notify()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_bug public.bug_reports;
  v_from_reporter bool;
  v_uid uuid;
  v_body text := '"' || left(new.text, 100) || case when length(new.text) > 100 then '…' else '' end || '"';
begin
  select * into v_bug from public.bug_reports where id = new.bug_id;
  if v_bug.id is null then return new; end if;

  v_from_reporter := new.sender_id = v_bug.reporter_id;

  if v_from_reporter then
    -- Notify every active developer
    for v_uid in select id from public.profiles where role = 'developer' and is_active = true loop
      perform public.emit_notification(
        v_uid, new.sender_id, 'bug', 'bug.message',
        'New reply on "' || v_bug.title || '"',
        v_body, 'bug_report', v_bug.id, '/bugs'
      );
    end loop;
  else
    -- Notify the reporter (the dev/boss posted)
    perform public.emit_notification(
      v_bug.reporter_id, new.sender_id, 'bug', 'bug.message',
      'New reply on "' || v_bug.title || '"',
      v_body, 'bug_report', v_bug.id, '/bugs'
    );
  end if;
  return new;
end;
$$;

drop trigger if exists bug_msg_notify_trg on public.bug_report_messages;
create trigger bug_msg_notify_trg
  after insert on public.bug_report_messages
  for each row execute function public.bug_msg_notify();
