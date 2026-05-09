-- ============================================================
-- WurxOS v2 — Migration 036: Knowledge base
--
-- Articles (title + markdown-ish body) grouped by category.
-- Visibility: office (all), role (role list), private (author).
-- Boss / OL / Developer full CRUD; everyone read (per visibility);
-- authors can edit/delete their own.
-- ============================================================

create table if not exists public.kb_articles (
  id          uuid primary key default gen_random_uuid(),
  title       text not null,
  body        text not null default '',
  category    text not null default 'General',
  visibility  text not null default 'office'
                check (visibility in ('private','office','role')),
  visible_to_roles text[] not null default '{}',
  tags        text[] not null default '{}',
  created_by  uuid not null references public.profiles(id) on delete cascade,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index if not exists kb_category_idx on public.kb_articles(category);
create index if not exists kb_tags_idx     on public.kb_articles using gin(tags);

drop trigger if exists kb_touch on public.kb_articles;
create trigger kb_touch before update on public.kb_articles
  for each row execute function public.touch_updated_at();

alter table public.kb_articles enable row level security;

drop policy if exists "kb_select" on public.kb_articles;
create policy "kb_select" on public.kb_articles for select
  using (
    created_by = auth.uid()
    or public.is_boss(auth.uid())
    or exists (select 1 from public.profiles p where p.id = auth.uid() and p.role in ('ol','developer') and p.is_active = true)
    or visibility = 'office'
    or (visibility = 'role' and exists (
        select 1 from public.profiles p
        where p.id = auth.uid() and p.role = any (visible_to_roles)
    ))
  );

drop policy if exists "kb_insert" on public.kb_articles;
create policy "kb_insert" on public.kb_articles for insert
  with check (created_by = auth.uid());

drop policy if exists "kb_update" on public.kb_articles;
create policy "kb_update" on public.kb_articles for update
  using (
    created_by = auth.uid()
    or public.is_boss(auth.uid())
    or exists (select 1 from public.profiles p where p.id = auth.uid() and p.role in ('ol','developer') and p.is_active = true)
  );

drop policy if exists "kb_delete" on public.kb_articles;
create policy "kb_delete" on public.kb_articles for delete
  using (
    created_by = auth.uid()
    or public.is_boss(auth.uid())
    or exists (select 1 from public.profiles p where p.id = auth.uid() and p.role in ('ol','developer') and p.is_active = true)
  );
