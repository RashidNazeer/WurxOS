-- ============================================================
-- Migration 063 — Knowledge Base: v1 parity
--
-- Adds approval workflow, versioning (sop_group_id), acknowledgements,
-- comments with Boss replies, and specific-user visibility on top of
-- the minimal 036 table. v2's body+tags are retained.
--
-- Columns added to kb_articles:
--   url, approval_status, submitted_by/at, approved_by/at,
--   rejection_reason, sop_group_id, version, requires_ack,
--   visible_to_users, author_role
--
-- New tables:
--   kb_comments         — threaded comments + optional Boss reply
--   kb_acknowledgments  — per-user read tracking
--
-- New RPCs:
--   kb_propose / kb_approve / kb_reject
--   kb_new_version
--   kb_set_ack(article, read)        — toggle read state for me
--   kb_ack_dashboard(article)        — who-has-read (Boss/OL/dev)
--   kb_comment_add(article, text)    — user comment
--   kb_comment_reply(comment, text)  — Boss-only reply
--
-- All state-changing RPCs emit matching notifications.
-- ============================================================

alter table public.kb_articles
  add column if not exists url               text,
  add column if not exists approval_status   text not null default 'approved'
                             check (approval_status in ('pending','approved','rejected')),
  add column if not exists submitted_by      uuid references public.profiles(id) on delete set null,
  add column if not exists submitted_at      timestamptz,
  add column if not exists approved_by       uuid references public.profiles(id) on delete set null,
  add column if not exists approved_at       timestamptz,
  add column if not exists rejection_reason  text,
  add column if not exists sop_group_id      uuid,
  add column if not exists version           int  not null default 1,
  add column if not exists requires_ack      boolean not null default false,
  add column if not exists visible_to_users  uuid[] not null default '{}',
  add column if not exists author_role       text;

-- Widen visibility check to include 'users' (specific user list) if not already.
do $$
begin
  if not exists (
    select 1 from pg_constraint c
    join pg_class t on t.oid = c.conrelid
    where t.relname = 'kb_articles' and c.conname = 'kb_articles_visibility_check'
  ) then null;
  end if;
  -- Drop & recreate to be safe
  begin
    alter table public.kb_articles drop constraint if exists kb_articles_visibility_check;
  exception when undefined_object then null;
  end;
  alter table public.kb_articles
    add constraint kb_articles_visibility_check
    check (visibility in ('private','office','role','users'));
end $$;

-- Category is one of v1's 5 tabs, but free text is still allowed for
-- backwards compatibility with existing rows. No constraint added.
create index if not exists kb_sop_group_idx      on public.kb_articles(sop_group_id);
create index if not exists kb_approval_idx       on public.kb_articles(approval_status);
create index if not exists kb_visible_users_idx  on public.kb_articles using gin(visible_to_users);

-- Every existing row becomes its own sop group (one-version). Safe to
-- run repeatedly — only fills in nulls.
update public.kb_articles
   set sop_group_id = id
 where sop_group_id is null;

-- --------------------------------------------------------------
-- RLS — replace the old SELECT policy with an approval + user-visibility aware one
-- --------------------------------------------------------------
drop policy if exists "kb_select" on public.kb_articles;
create policy "kb_select" on public.kb_articles for select
  using (
    -- Author always sees their own (even pending/rejected)
    created_by = auth.uid()
    or submitted_by = auth.uid()
    -- Boss / OL / Developer see everything
    or public.is_boss(auth.uid())
    or exists (
      select 1 from public.profiles p
      where p.id = auth.uid() and p.role in ('ol','developer') and p.is_active = true
    )
    -- Everyone else: only approved, matching visibility
    or (
      approval_status = 'approved'
      and (
        visibility = 'office'
        or (visibility = 'role' and exists (
            select 1 from public.profiles p
            where p.id = auth.uid() and p.role = any (visible_to_roles)
        ))
        or (visibility = 'users' and auth.uid() = any (visible_to_users))
      )
    )
  );

-- Only admins can flip approval_status / approved_by via UPDATE; authors can edit
-- their own content while it's pending.
drop policy if exists "kb_update" on public.kb_articles;
create policy "kb_update" on public.kb_articles for update
  using (
    created_by = auth.uid()
    or submitted_by = auth.uid()
    or public.is_boss(auth.uid())
    or exists (select 1 from public.profiles p where p.id = auth.uid() and p.role in ('ol','developer') and p.is_active = true)
  );

-- --------------------------------------------------------------
-- Comments
-- --------------------------------------------------------------
create table if not exists public.kb_comments (
  id            uuid primary key default gen_random_uuid(),
  article_id    uuid not null references public.kb_articles(id) on delete cascade,
  author_id     uuid not null references public.profiles(id) on delete cascade,
  body          text not null,
  boss_reply    text,
  boss_reply_by uuid references public.profiles(id) on delete set null,
  boss_reply_at timestamptz,
  created_at    timestamptz not null default now()
);
create index if not exists kb_comments_article_idx on public.kb_comments(article_id, created_at desc);

alter table public.kb_comments enable row level security;

drop policy if exists "kbc_select" on public.kb_comments;
create policy "kbc_select" on public.kb_comments for select
  using (
    -- Same visibility as the article
    exists (
      select 1 from public.kb_articles a
      where a.id = kb_comments.article_id
    )
  );

drop policy if exists "kbc_insert" on public.kb_comments;
create policy "kbc_insert" on public.kb_comments for insert
  with check (author_id = auth.uid());

drop policy if exists "kbc_update" on public.kb_comments;
create policy "kbc_update" on public.kb_comments for update
  using (
    public.is_boss(auth.uid())
    or exists (select 1 from public.profiles p where p.id = auth.uid() and p.role in ('ol','developer') and p.is_active = true)
    or author_id = auth.uid()
  );

drop policy if exists "kbc_delete" on public.kb_comments;
create policy "kbc_delete" on public.kb_comments for delete
  using (
    public.is_boss(auth.uid())
    or author_id = auth.uid()
  );

-- --------------------------------------------------------------
-- Acknowledgements (per-user "mark as read" when requires_ack = true)
-- --------------------------------------------------------------
create table if not exists public.kb_acknowledgments (
  id          uuid primary key default gen_random_uuid(),
  article_id  uuid not null references public.kb_articles(id) on delete cascade,
  user_id     uuid not null references public.profiles(id) on delete cascade,
  read_at     timestamptz not null default now(),
  unique (article_id, user_id)
);
create index if not exists kb_ack_article_idx on public.kb_acknowledgments(article_id);
create index if not exists kb_ack_user_idx    on public.kb_acknowledgments(user_id);

alter table public.kb_acknowledgments enable row level security;

-- Everyone sees their own ack; admins see all (for dashboard)
drop policy if exists "kba_select" on public.kb_acknowledgments;
create policy "kba_select" on public.kb_acknowledgments for select
  using (
    user_id = auth.uid()
    or public.is_boss(auth.uid())
    or exists (select 1 from public.profiles p where p.id = auth.uid() and p.role in ('ol','developer') and p.is_active = true)
  );

drop policy if exists "kba_write" on public.kb_acknowledgments;
create policy "kba_write" on public.kb_acknowledgments for all
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

-- --------------------------------------------------------------
-- RPCs
-- --------------------------------------------------------------

-- Helper: notify all users that would see the article (role/users/office)
create or replace function public._kb_notify_visible(p_article uuid, p_event text, p_title text, p_body text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_art public.kb_articles;
  v_uid uuid;
begin
  select * into v_art from public.kb_articles where id = p_article;
  if not found or v_art.approval_status <> 'approved' then return; end if;

  for v_uid in
    select p.id from public.profiles p
    where p.is_active = true
      and p.id <> coalesce(auth.uid(), '00000000-0000-0000-0000-000000000000'::uuid)
      and (
        v_art.visibility = 'office'
        or (v_art.visibility = 'role'  and p.role = any (v_art.visible_to_roles))
        or (v_art.visibility = 'users' and p.id  = any (v_art.visible_to_users))
      )
  loop
    perform public.emit_notification(
      v_uid, auth.uid(), 'knowledge_base', p_event,
      p_title, p_body, 'kb', p_article, '/kb'
    );
  end loop;
end;
$$;

-- Propose a new article (any user). Boss-authored articles can pass
-- p_auto_approve = true to skip the queue.
create or replace function public.kb_propose(
  p_title        text,
  p_body         text,
  p_url          text,
  p_description  text,
  p_category     text,
  p_tags         text[],
  p_visibility   text,
  p_visible_to_roles text[],
  p_visible_to_users uuid[],
  p_requires_ack boolean,
  p_sop_group_id uuid default null,
  p_auto_approve boolean default false
)
returns public.kb_articles
language plpgsql
security definer
set search_path = public
as $$
declare
  v_me       uuid := auth.uid();
  v_role     text;
  v_is_admin boolean;
  v_status   text;
  v_row      public.kb_articles;
  v_version  int  := 1;
  v_group    uuid := p_sop_group_id;
  v_name     text;
begin
  if v_me is null then raise exception 'not authenticated'; end if;
  if coalesce(trim(p_title), '') = '' then raise exception 'title required'; end if;
  if p_visibility not in ('private','office','role','users') then
    raise exception 'bad visibility';
  end if;

  select role into v_role from public.profiles where id = v_me;
  v_is_admin := public.is_boss(v_me)
                or v_role in ('ol','developer');
  v_status   := case when (v_is_admin and p_auto_approve) then 'approved' else 'pending' end;

  if v_group is not null then
    select coalesce(max(version),0) + 1 into v_version
      from public.kb_articles where sop_group_id = v_group;
  end if;

  insert into public.kb_articles (
    title, body, url, category, tags,
    visibility, visible_to_roles, visible_to_users, requires_ack,
    created_by, submitted_by, submitted_at, author_role,
    approval_status, approved_by, approved_at,
    sop_group_id, version
  ) values (
    trim(p_title),
    coalesce(p_description, '') || case when coalesce(p_body,'') <> ''
                                       then E'\n\n' || p_body else '' end,
    nullif(trim(coalesce(p_url, '')), ''),
    coalesce(nullif(trim(p_category),''), 'General'),
    coalesce(p_tags, '{}'),
    p_visibility,
    coalesce(p_visible_to_roles, '{}'),
    coalesce(p_visible_to_users, '{}'),
    coalesce(p_requires_ack, false),
    v_me, v_me, now(), v_role,
    v_status,
    case when v_status = 'approved' then v_me end,
    case when v_status = 'approved' then now() end,
    coalesce(v_group, gen_random_uuid()),
    v_version
  )
  returning * into v_row;

  -- Set sop_group_id = id for first-version rows
  if p_sop_group_id is null then
    update public.kb_articles set sop_group_id = v_row.id where id = v_row.id;
    v_row.sop_group_id := v_row.id;
  end if;

  v_name := coalesce(public.profile_display_name(v_me), 'Someone');

  if v_status = 'pending' then
    -- Notify every Boss
    perform public.emit_notification(
      p.id, v_me, 'knowledge_base', 'kb_submission',
      'New KB submission',
      v_name || ' proposed "' || v_row.title || '" for review.',
      'kb', v_row.id, '/kb'
    )
    from public.profiles p
    where p.role = 'boss' and p.is_active = true;
  else
    -- Auto-approved (Boss creation): notify visible users
    perform public._kb_notify_visible(
      v_row.id,
      case when v_version > 1 then 'sop_updated' else 'sop_added' end,
      case when v_version > 1 then 'SOP updated' else 'New KB article' end,
      v_row.title || case when v_version > 1 then ' (v' || v_version || ')' else '' end
    );
  end if;

  return v_row;
end;
$$;
grant execute on function public.kb_propose(
  text, text, text, text, text, text[], text, text[], uuid[], boolean, uuid, boolean
) to authenticated;

-- Approve a pending article (Boss-only)
create or replace function public.kb_approve(p_id uuid)
returns public.kb_articles
language plpgsql
security definer
set search_path = public
as $$
declare
  v_me   uuid := auth.uid();
  v_row  public.kb_articles;
begin
  if not public.is_boss(v_me) then raise exception 'boss only'; end if;
  update public.kb_articles
     set approval_status = 'approved',
         approved_by     = v_me,
         approved_at     = now(),
         rejection_reason = null
   where id = p_id and approval_status = 'pending'
   returning * into v_row;
  if not found then raise exception 'not pending or not found'; end if;

  -- Notify submitter
  if v_row.submitted_by is not null and v_row.submitted_by <> v_me then
    perform public.emit_notification(
      v_row.submitted_by, v_me, 'knowledge_base', 'kb_approved',
      'KB submission approved',
      '"' || v_row.title || '" is now live.',
      'kb', v_row.id, '/kb'
    );
  end if;

  -- Notify all users who now see it
  perform public._kb_notify_visible(
    v_row.id,
    case when v_row.version > 1 then 'sop_updated' else 'sop_added' end,
    case when v_row.version > 1 then 'SOP updated' else 'New KB article' end,
    v_row.title || case when v_row.version > 1 then ' (v' || v_row.version || ')' else '' end
  );
  return v_row;
end;
$$;
grant execute on function public.kb_approve(uuid) to authenticated;

-- Reject a pending article (Boss-only) with optional reason
create or replace function public.kb_reject(p_id uuid, p_reason text default null)
returns public.kb_articles
language plpgsql
security definer
set search_path = public
as $$
declare
  v_me   uuid := auth.uid();
  v_row  public.kb_articles;
begin
  if not public.is_boss(v_me) then raise exception 'boss only'; end if;
  update public.kb_articles
     set approval_status  = 'rejected',
         rejection_reason = p_reason
   where id = p_id and approval_status = 'pending'
   returning * into v_row;
  if not found then raise exception 'not pending or not found'; end if;

  if v_row.submitted_by is not null and v_row.submitted_by <> v_me then
    perform public.emit_notification(
      v_row.submitted_by, v_me, 'knowledge_base', 'kb_rejected',
      'KB submission declined',
      coalesce('"' || v_row.title || '" was declined: ' || p_reason,
               '"' || v_row.title || '" was declined.'),
      'kb', v_row.id, '/kb'
    );
  end if;
  return v_row;
end;
$$;
grant execute on function public.kb_reject(uuid, text) to authenticated;

-- Mark / unmark the current user as having read an article
create or replace function public.kb_set_ack(p_id uuid, p_read boolean)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_me uuid := auth.uid();
begin
  if v_me is null then raise exception 'not authenticated'; end if;
  if p_read then
    insert into public.kb_acknowledgments (article_id, user_id)
    values (p_id, v_me)
    on conflict (article_id, user_id) do update set read_at = now();
  else
    delete from public.kb_acknowledgments where article_id = p_id and user_id = v_me;
  end if;
  return true;
end;
$$;
grant execute on function public.kb_set_ack(uuid, boolean) to authenticated;

-- Dashboard: who should read this vs who has. Boss/OL/Developer only.
create or replace function public.kb_ack_dashboard(p_id uuid)
returns table (
  user_id       uuid,
  display_name  text,
  role          text,
  read_at       timestamptz
)
language plpgsql
security definer
set search_path = public
stable
as $$
declare
  v_me  uuid := auth.uid();
  v_art public.kb_articles;
begin
  if not (public.is_boss(v_me)
          or exists (select 1 from public.profiles p where p.id = v_me and p.role in ('ol','developer') and p.is_active = true)) then
    raise exception 'not authorized';
  end if;

  select * into v_art from public.kb_articles where id = p_id;
  if not found then raise exception 'article not found'; end if;

  return query
  select p.id,
         p.display_name,
         p.role,
         a.read_at
    from public.profiles p
    left join public.kb_acknowledgments a
      on a.article_id = v_art.id and a.user_id = p.id
   where p.is_active = true
     and (
       v_art.visibility = 'office'
       or (v_art.visibility = 'role'  and p.role = any (v_art.visible_to_roles))
       or (v_art.visibility = 'users' and p.id  = any (v_art.visible_to_users))
     )
   order by (a.read_at is null) desc, p.display_name;
end;
$$;
grant execute on function public.kb_ack_dashboard(uuid) to authenticated;

-- Comments
create or replace function public.kb_comment_add(p_article uuid, p_body text)
returns public.kb_comments
language plpgsql
security definer
set search_path = public
as $$
declare
  v_me   uuid := auth.uid();
  v_row  public.kb_comments;
  v_art  public.kb_articles;
  v_name text;
begin
  if v_me is null then raise exception 'not authenticated'; end if;
  if coalesce(trim(p_body), '') = '' then raise exception 'comment empty'; end if;

  select * into v_art from public.kb_articles where id = p_article;
  if not found then raise exception 'article not found'; end if;

  insert into public.kb_comments (article_id, author_id, body)
  values (p_article, v_me, trim(p_body))
  returning * into v_row;

  v_name := coalesce(public.profile_display_name(v_me), 'Someone');
  perform public.emit_notification(
    p.id, v_me, 'knowledge_base', 'comment',
    'New KB comment',
    v_name || ' commented on "' || v_art.title || '".',
    'kb', v_art.id, '/kb'
  )
  from public.profiles p
  where p.role = 'boss' and p.is_active = true and p.id <> v_me;

  return v_row;
end;
$$;
grant execute on function public.kb_comment_add(uuid, text) to authenticated;

create or replace function public.kb_comment_reply(p_comment uuid, p_body text)
returns public.kb_comments
language plpgsql
security definer
set search_path = public
as $$
declare
  v_me  uuid := auth.uid();
  v_row public.kb_comments;
begin
  if not public.is_boss(v_me) then raise exception 'boss only'; end if;
  if coalesce(trim(p_body), '') = '' then raise exception 'reply empty'; end if;

  update public.kb_comments
     set boss_reply    = trim(p_body),
         boss_reply_by = v_me,
         boss_reply_at = now()
   where id = p_comment
   returning * into v_row;
  if not found then raise exception 'comment not found'; end if;

  if v_row.author_id <> v_me then
    perform public.emit_notification(
      v_row.author_id, v_me, 'knowledge_base', 'comment_reply',
      'Boss replied to your comment',
      trim(p_body),
      'kb', v_row.article_id, '/kb'
    );
  end if;
  return v_row;
end;
$$;
grant execute on function public.kb_comment_reply(uuid, text) to authenticated;
