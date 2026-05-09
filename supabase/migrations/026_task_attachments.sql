-- ============================================================
-- WurxOS v2 — Migration 026: Task attachments
--
-- Adds:
--   * task_attachments table (metadata only; blob in Storage)
--   * Storage bucket 'task-attachments' (private, auth read/write)
--   * RLS mirroring can_view_task for viewers; uploader must be
--     able to view the task. Delete: uploader or Boss.
--
-- Safe to re-run.
-- ============================================================

create table if not exists public.task_attachments (
  id            uuid primary key default gen_random_uuid(),
  task_id       uuid not null references public.tasks(id)   on delete cascade,
  uploader_id   uuid not null references public.profiles(id) on delete cascade,
  file_name     text not null,
  file_path     text not null,   -- Supabase Storage object path
  file_size     int  not null default 0,
  mime_type     text not null default 'application/octet-stream',
  created_at    timestamptz not null default now(),
  unique (file_path)
);

create index if not exists task_attachments_task_idx on public.task_attachments(task_id, created_at desc);

alter table public.task_attachments enable row level security;

drop policy if exists "ta_select" on public.task_attachments;
create policy "ta_select"
  on public.task_attachments for select
  using (
    exists (
      select 1 from public.tasks t
      where t.id = task_attachments.task_id
        and public.can_view_task(t.brand_id, t.assignee_id, t.created_by, auth.uid())
    )
  );

drop policy if exists "ta_insert" on public.task_attachments;
create policy "ta_insert"
  on public.task_attachments for insert
  with check (
    uploader_id = auth.uid()
    and exists (
      select 1 from public.tasks t
      where t.id = task_attachments.task_id
        and public.can_view_task(t.brand_id, t.assignee_id, t.created_by, auth.uid())
    )
  );

drop policy if exists "ta_delete" on public.task_attachments;
create policy "ta_delete"
  on public.task_attachments for delete
  using (uploader_id = auth.uid() or public.is_boss(auth.uid()));

-- --------------------------------------------------------------
-- Storage bucket (private; client uses short-lived signed URLs).
-- --------------------------------------------------------------
insert into storage.buckets (id, name, public)
values ('task-attachments', 'task-attachments', false)
on conflict (id) do nothing;

drop policy if exists "ta_storage_read"   on storage.objects;
create policy "ta_storage_read"
  on storage.objects for select
  using (bucket_id = 'task-attachments' and auth.role() = 'authenticated');

drop policy if exists "ta_storage_write"  on storage.objects;
create policy "ta_storage_write"
  on storage.objects for insert
  with check (bucket_id = 'task-attachments' and auth.role() = 'authenticated');

drop policy if exists "ta_storage_delete" on storage.objects;
create policy "ta_storage_delete"
  on storage.objects for delete
  using (bucket_id = 'task-attachments' and auth.role() = 'authenticated');
