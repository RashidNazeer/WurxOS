-- ============================================================
-- WurxOS v2 — Migration 020: Task comments
--
-- Adds:
--   * task_comments table (+ RLS: view follows can_view_task,
--     insert by anyone who can view, delete by author or Boss)
--   * Notification trigger: new comment → creator + assignee
--   * Adds task_comments to the supabase_realtime publication
--
-- Safe to re-run.
-- ============================================================

create table if not exists public.task_comments (
  id          uuid primary key default gen_random_uuid(),
  task_id     uuid not null references public.tasks(id)   on delete cascade,
  author_id   uuid not null references public.profiles(id) on delete cascade,
  body        text not null check (length(trim(body)) > 0),
  created_at  timestamptz not null default now()
);

create index if not exists task_comments_task_idx    on public.task_comments(task_id, created_at desc);
create index if not exists task_comments_author_idx  on public.task_comments(author_id);

alter table public.task_comments enable row level security;

drop policy if exists "task_comments_select" on public.task_comments;
create policy "task_comments_select"
  on public.task_comments for select
  using (
    exists (
      select 1 from public.tasks t
      where t.id = task_comments.task_id
        and public.can_view_task(t.brand_id, t.assignee_id, t.created_by, auth.uid())
    )
  );

drop policy if exists "task_comments_insert" on public.task_comments;
create policy "task_comments_insert"
  on public.task_comments for insert
  with check (
    author_id = auth.uid()
    and exists (
      select 1 from public.tasks t
      where t.id = task_comments.task_id
        and public.can_view_task(t.brand_id, t.assignee_id, t.created_by, auth.uid())
    )
  );

drop policy if exists "task_comments_delete" on public.task_comments;
create policy "task_comments_delete"
  on public.task_comments for delete
  using (author_id = auth.uid() or public.is_boss(auth.uid()));

-- --------------------------------------------------------------
-- Notification: ping task creator + assignee (minus the actor)
-- --------------------------------------------------------------
create or replace function public.task_comments_notify()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_task   public.tasks%rowtype;
  v_actor  text;
  v_body   text;
begin
  select * into v_task from public.tasks where id = new.task_id;
  if not found then return new; end if;

  v_actor := coalesce(public.profile_display_name(new.author_id), 'Someone');
  v_body  := v_actor || ' commented on "' || v_task.title || '"';

  -- Creator
  if v_task.created_by is not null and v_task.created_by <> new.author_id then
    perform public.emit_notification(
      v_task.created_by, new.author_id, 'task', 'task.commented',
      'New comment on your task', v_body,
      'task', v_task.id, '/tasks'
    );
  end if;

  -- Assignee (if different from creator and not the author)
  if v_task.assignee_id is not null
     and v_task.assignee_id <> new.author_id
     and v_task.assignee_id is distinct from v_task.created_by then
    perform public.emit_notification(
      v_task.assignee_id, new.author_id, 'task', 'task.commented',
      'New comment on your task', v_body,
      'task', v_task.id, '/tasks'
    );
  end if;

  return new;
end;
$$;

drop trigger if exists task_comments_notify_ai on public.task_comments;
create trigger task_comments_notify_ai
  after insert on public.task_comments
  for each row execute function public.task_comments_notify();

-- --------------------------------------------------------------
-- Realtime so comment thread live-updates
-- --------------------------------------------------------------
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    if not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'task_comments'
    ) then
      execute 'alter publication supabase_realtime add table public.task_comments';
    end if;
  end if;
end;
$$;
