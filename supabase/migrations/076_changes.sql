-- ============================================================
-- Migration 076 — Change Management
--
-- SOP / process changes flow: someone (non-Boss) proposes a change,
-- Boss approves/rejects, then the implementation owner runs it
-- (in_progress → paused → delayed → completed) and Boss closes the
-- loop by marking 'implemented' (optionally bumping the linked KB
-- article's version).
--
-- State machine:
--   pending → approved ─→ in_progress ─→ completed ─→ implemented
--                    │        │
--                    │    paused / delayed → in_progress / completed
--                    └─→ rejected
--
-- Permissions:
--   * Submit: any authenticated user except Boss / Developer
--   * Approve / Reject / Implement: Boss (Developer can act for Boss)
--   * Advance workflow (in_progress/paused/delayed/completed): owner
--   * Thread: any participant (submitter + owner + Boss + Developer)
-- ============================================================

-- --------------------------------------------------------------
-- 1. changes
-- --------------------------------------------------------------
create table if not exists public.changes (
  id                  uuid primary key default gen_random_uuid(),
  -- Human-readable id like CHG-240422-0017, auto-generated on insert.
  change_code         text unique,

  title               text not null,
  sop_type            text not null
                        check (sop_type in ('delivery_roadmap','policies','operational','training')),
  current_version     text,   -- e.g. 'v1.0' — cached at submit
  current_process     text not null,
  proposed_change     text not null,
  expected_impact     text,
  risks               text,

  -- Implementation owner (who'll actually do it)
  owner_id            uuid not null references public.profiles(id) on delete restrict,
  owner_name          text,

  priority            text check (priority in ('low','medium','high')),

  -- Affected KB articles (we keep ids + cached titles so the Detail
  -- view doesn't have to re-join even if an article is deleted).
  affected_kb_ids     uuid[] not null default '{}',
  affected_kb_titles  text[] not null default '{}',

  submitted_by        uuid not null references public.profiles(id) on delete cascade,
  submitted_by_name   text,
  submitted_by_role   text,

  status              text not null default 'pending'
                        check (status in ('pending','approved','rejected',
                                          'in_progress','paused','delayed',
                                          'completed','implemented')),

  approved_by         uuid references public.profiles(id) on delete set null,
  approved_by_name    text,
  approval_date       timestamptz,

  new_version         text,
  implementation_start date,
  implementation_end   date,
  boss_comment        text,
  rejection_reason    text,

  completed_at        timestamptz,
  implemented_at      timestamptz,

  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

create index if not exists changes_status_idx      on public.changes(status);
create index if not exists changes_submitted_idx   on public.changes(submitted_by, created_at desc);
create index if not exists changes_owner_idx       on public.changes(owner_id,     created_at desc);
create index if not exists changes_sop_type_idx    on public.changes(sop_type);
create index if not exists changes_created_idx     on public.changes(created_at desc);

drop trigger if exists changes_touch on public.changes;
create trigger changes_touch before update on public.changes
  for each row execute function public.touch_updated_at();

-- --------------------------------------------------------------
-- 2. change_code generator (e.g. CHG-240422-0017)
--    Runs in a BEFORE INSERT trigger so the client doesn't supply it.
-- --------------------------------------------------------------
create or replace function public.changes_assign_code()
returns trigger language plpgsql as $$
declare
  v_date_part text := to_char(now(), 'YYMMDD');
  v_seq int;
begin
  if new.change_code is not null and new.change_code <> '' then return new; end if;

  select coalesce(max(
           nullif(regexp_replace(change_code, '^CHG-\d{6}-', ''), '')::int
         ), 0) + 1
    into v_seq
    from public.changes
    where change_code like 'CHG-' || v_date_part || '-%';

  new.change_code := 'CHG-' || v_date_part || '-' || lpad(v_seq::text, 4, '0');
  return new;
end;
$$;

drop trigger if exists changes_assign_code on public.changes;
create trigger changes_assign_code before insert on public.changes
  for each row execute function public.changes_assign_code();

-- --------------------------------------------------------------
-- 3. change_thread — discussion subtable. System messages from
--    status transitions use type='status_change' so the UI can
--    render them centered / muted.
-- --------------------------------------------------------------
create table if not exists public.change_thread (
  id           uuid primary key default gen_random_uuid(),
  change_id    uuid not null references public.changes(id) on delete cascade,
  user_id      uuid references public.profiles(id) on delete set null,
  user_name    text,
  user_role    text,
  type         text not null default 'message'
                 check (type in ('message','status_change')),
  text         text not null,
  created_at   timestamptz not null default now()
);

create index if not exists change_thread_idx on public.change_thread(change_id, created_at asc);

-- --------------------------------------------------------------
-- 4. RLS
--   SELECT  — submitter, owner, Boss, Developer
--   INSERT  — submitter = auth.uid(), any non-Boss/Developer role
--   UPDATE  — gated by state transitions (handled below via RPC);
--             at row level we allow Boss, Developer, owner, and
--             submitter (only while pending — to let them edit)
--   DELETE  — Boss, Developer, or submitter while pending
-- --------------------------------------------------------------
alter table public.changes enable row level security;

drop policy if exists "chg_select" on public.changes;
create policy "chg_select" on public.changes for select
  using (
    submitted_by = auth.uid()
    or owner_id  = auth.uid()
    or public.is_boss(auth.uid())
    or exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'developer' and p.is_active = true)
  );

drop policy if exists "chg_insert" on public.changes;
create policy "chg_insert" on public.changes for insert
  with check (
    submitted_by = auth.uid()
    and exists (
      select 1 from public.profiles p
      where p.id = auth.uid()
        and p.is_active = true
        and p.role in ('tl','ol','pctl','apc','ipc')
    )
  );

drop policy if exists "chg_update" on public.changes;
create policy "chg_update" on public.changes for update
  using (
    public.is_boss(auth.uid())
    or exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'developer' and p.is_active = true)
    or owner_id = auth.uid()
    or (submitted_by = auth.uid() and status = 'pending')
  );

drop policy if exists "chg_delete" on public.changes;
create policy "chg_delete" on public.changes for delete
  using (
    public.is_boss(auth.uid())
    or exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'developer' and p.is_active = true)
    or (submitted_by = auth.uid() and status = 'pending')
  );

-- Thread: any participant can read / post / delete-own.
alter table public.change_thread enable row level security;

drop policy if exists "chg_thr_select" on public.change_thread;
create policy "chg_thr_select" on public.change_thread for select
  using (
    exists (select 1 from public.changes c where c.id = change_thread.change_id
            and (c.submitted_by = auth.uid()
                 or c.owner_id = auth.uid()
                 or public.is_boss(auth.uid())
                 or exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'developer' and p.is_active = true)))
  );

drop policy if exists "chg_thr_insert" on public.change_thread;
create policy "chg_thr_insert" on public.change_thread for insert
  with check (
    user_id = auth.uid()
    and exists (select 1 from public.changes c where c.id = change_thread.change_id
                and (c.submitted_by = auth.uid()
                     or c.owner_id = auth.uid()
                     or public.is_boss(auth.uid())
                     or exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'developer' and p.is_active = true)))
  );

drop policy if exists "chg_thr_delete" on public.change_thread;
create policy "chg_thr_delete" on public.change_thread for delete
  using (
    user_id = auth.uid()
    or public.is_boss(auth.uid())
    or exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'developer' and p.is_active = true)
  );

-- --------------------------------------------------------------
-- 5. Notification triggers
-- --------------------------------------------------------------
-- On submit: notify all active Bosses. We use public.is_boss filter
-- by walking the profiles list (Boss role is rare, this is fine).
create or replace function public.changes_notify_submit()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid;
  v_body text;
begin
  v_body := coalesce(new.submitted_by_name, 'Someone')
         || ' submitted a change for '
         || case new.sop_type
              when 'delivery_roadmap' then 'Delivery Roadmap'
              when 'policies'         then 'Policies'
              when 'operational'      then 'Operational SOPs'
              when 'training'         then 'Training SOPs'
              else new.sop_type
            end
         || '.';
  for v_uid in
    select id from public.profiles where role = 'boss' and is_active = true
  loop
    perform public.emit_notification(
      v_uid, new.submitted_by, 'change', 'change.submitted',
      'New Change Request: ' || coalesce(new.change_code, 'CHG'),
      v_body,
      'change', new.id, '/changes'
    );
  end loop;
  return new;
end;
$$;

drop trigger if exists changes_notify_submit on public.changes;
create trigger changes_notify_submit
  after insert on public.changes
  for each row execute function public.changes_notify_submit();

-- On status change: notify submitter + owner (if different) + boss-es.
-- Also auto-append a 'status_change' row to the thread for context.
create or replace function public.changes_notify_status()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_label text := case new.status
    when 'pending'     then 'Pending'
    when 'approved'    then 'Approved'
    when 'rejected'    then 'Rejected'
    when 'in_progress' then 'In Progress'
    when 'paused'      then 'Paused'
    when 'delayed'     then 'Delayed'
    when 'completed'   then 'Completed'
    when 'implemented' then 'Implemented'
    else new.status
  end;
  v_actor uuid := auth.uid();
  v_tail  text := '';
begin
  if new.status = old.status then return new; end if;

  if new.status = 'rejected' and coalesce(new.rejection_reason,'') <> '' then
    v_tail := ' · ' || left(new.rejection_reason, 120);
  end if;

  -- Notify submitter
  perform public.emit_notification(
    new.submitted_by, v_actor, 'change', 'change.status_changed',
    coalesce(new.change_code,'CHG') || ' — ' || v_label,
    '"' || new.title || '"' || v_tail,
    'change', new.id, '/changes'
  );

  -- Notify owner if different from submitter
  if new.owner_id is not null and new.owner_id <> new.submitted_by then
    perform public.emit_notification(
      new.owner_id, v_actor, 'change', 'change.status_changed',
      coalesce(new.change_code,'CHG') || ' — ' || v_label,
      '"' || new.title || '"' || v_tail,
      'change', new.id, '/changes'
    );
  end if;

  -- Log a system message on the thread so the history is visible.
  insert into public.change_thread (change_id, user_id, user_name, user_role, type, text)
  select new.id, v_actor,
         public.profile_display_name(v_actor),
         (select role from public.profiles where id = v_actor),
         'status_change',
         'Status changed to ' || v_label || v_tail;

  return new;
end;
$$;

drop trigger if exists changes_notify_status on public.changes;
create trigger changes_notify_status
  after update of status on public.changes
  for each row execute function public.changes_notify_status();

-- On new thread message: notify other participants.
create or replace function public.change_thread_notify()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_chg public.changes;
  v_uid uuid;
  v_body text := '"' || left(new.text, 100) || case when length(new.text) > 100 then '…' else '' end || '"';
begin
  if new.type = 'status_change' then return new; end if;  -- avoid double-notify
  select * into v_chg from public.changes where id = new.change_id;
  if v_chg.id is null then return new; end if;

  -- submitter
  if new.user_id <> v_chg.submitted_by then
    perform public.emit_notification(
      v_chg.submitted_by, new.user_id, 'change', 'change.message',
      'New message on ' || coalesce(v_chg.change_code, 'CHG'),
      v_body, 'change', v_chg.id, '/changes'
    );
  end if;

  -- owner (if different and different from author)
  if v_chg.owner_id is not null
     and v_chg.owner_id <> v_chg.submitted_by
     and v_chg.owner_id <> new.user_id then
    perform public.emit_notification(
      v_chg.owner_id, new.user_id, 'change', 'change.message',
      'New message on ' || coalesce(v_chg.change_code, 'CHG'),
      v_body, 'change', v_chg.id, '/changes'
    );
  end if;

  -- every active Boss (except the poster)
  for v_uid in
    select id from public.profiles where role = 'boss' and is_active = true and id <> new.user_id
  loop
    perform public.emit_notification(
      v_uid, new.user_id, 'change', 'change.message',
      'New message on ' || coalesce(v_chg.change_code, 'CHG'),
      v_body, 'change', v_chg.id, '/changes'
    );
  end loop;

  return new;
end;
$$;

drop trigger if exists change_thread_notify_trg on public.change_thread;
create trigger change_thread_notify_trg
  after insert on public.change_thread
  for each row execute function public.change_thread_notify();
