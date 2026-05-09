-- ============================================================
-- WurxOS v2 — Migration 035: Reminders
--
-- User-set reminders. pg_cron every minute picks up due rows and
-- fires an emit_notification to the owner, marking sent_at.
-- ============================================================

create table if not exists public.reminders (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references public.profiles(id) on delete cascade,
  title       text not null,
  body        text not null default '',
  remind_at   timestamptz not null,
  link        text not null default '/notifications',
  sent_at     timestamptz,
  created_at  timestamptz not null default now()
);

create index if not exists reminders_user_idx on public.reminders(user_id, remind_at desc);
create index if not exists reminders_due_idx  on public.reminders(remind_at) where sent_at is null;

alter table public.reminders enable row level security;

drop policy if exists "rem_select" on public.reminders;
create policy "rem_select" on public.reminders for select
  using (auth.uid() = user_id);

drop policy if exists "rem_insert" on public.reminders;
create policy "rem_insert" on public.reminders for insert
  with check (auth.uid() = user_id);

drop policy if exists "rem_update" on public.reminders;
create policy "rem_update" on public.reminders for update
  using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "rem_delete" on public.reminders;
create policy "rem_delete" on public.reminders for delete
  using (auth.uid() = user_id);

create or replace function public.fire_due_reminders()
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.reminders;
  v_count int := 0;
begin
  for v_row in
    select * from public.reminders
    where sent_at is null and remind_at <= now()
    order by remind_at asc
    limit 500
  loop
    perform public.emit_notification(
      v_row.user_id, v_row.user_id, 'system', 'reminder',
      v_row.title, v_row.body, 'reminder', v_row.id, v_row.link
    );
    update public.reminders set sent_at = now() where id = v_row.id;
    v_count := v_count + 1;
  end loop;
  return v_count;
end;
$$;

-- NOTE: emit_notification skips when recipient = actor. Override for
-- reminders by inserting directly (bypasses the self-skip).
create or replace function public.fire_due_reminders()
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.reminders;
  v_count int := 0;
begin
  for v_row in
    select * from public.reminders
    where sent_at is null and remind_at <= now()
    order by remind_at asc
    limit 500
  loop
    insert into public.notifications (
      recipient_id, actor_id, category, action, title, body,
      entity_type, entity_id, link
    ) values (
      v_row.user_id, null, 'system', 'reminder', v_row.title, v_row.body,
      'reminder', v_row.id, v_row.link
    );
    update public.reminders set sent_at = now() where id = v_row.id;
    v_count := v_count + 1;
  end loop;
  return v_count;
end;
$$;

do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    begin
      perform cron.unschedule('fire-due-reminders');
    exception when others then null;
    end;
  end if;
end;
$$;
do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.schedule('fire-due-reminders', '* * * * *',
      $cron$select public.fire_due_reminders();$cron$);
  end if;
end;
$$;
