-- ============================================================
-- Migration 090 — Knowledge Base: free-form version label
--
-- v1 let users tag SOP versions with their own string ("v1.0",
-- "Q1 2025 update", etc.) rather than a bare integer. v2 already
-- has an int `version` column auto-incremented per sop_group_id;
-- this migration adds a parallel `version_label` text column so
-- the UI can show the integer auto-version AND the user-entered
-- label side-by-side (or fall back to "v{n}" when no label).
--
-- Also widens kb_propose to accept p_version_label.
-- ============================================================

alter table public.kb_articles
  add column if not exists version_label text;

-- Drop old signature first so we can change its parameter list.
drop function if exists public.kb_propose(
  text, text, text, text, text, text[], text, text[], uuid[], boolean, uuid, boolean
);

create or replace function public.kb_propose(
  p_title         text,
  p_body          text,
  p_url           text,
  p_description   text,
  p_category      text,
  p_tags          text[],
  p_visibility    text,
  p_visible_to_roles text[],
  p_visible_to_users uuid[],
  p_requires_ack  boolean,
  p_sop_group_id  uuid    default null,
  p_auto_approve  boolean default false,
  p_version_label text    default null
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
  v_label    text := nullif(trim(coalesce(p_version_label, '')), '');
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
    sop_group_id, version, version_label
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
    v_version,
    v_label
  )
  returning * into v_row;

  if p_sop_group_id is null then
    update public.kb_articles set sop_group_id = v_row.id where id = v_row.id;
    v_row.sop_group_id := v_row.id;
  end if;

  v_name := coalesce(public.profile_display_name(v_me), 'Someone');

  if v_status = 'pending' then
    perform public.emit_notification(
      p.id, v_me, 'knowledge_base', 'kb_submission',
      'New KB submission',
      v_name || ' proposed "' || v_row.title || '" for review.',
      'kb', v_row.id, '/kb'
    )
    from public.profiles p
    where p.role = 'boss' and p.is_active = true;
  else
    perform public._kb_notify_visible(
      v_row.id,
      case when v_version > 1 then 'sop_updated' else 'sop_added' end,
      case when v_version > 1 then 'SOP updated' else 'New KB article' end,
      v_row.title || case when v_version > 1
                          then ' (' || coalesce(v_label, 'v' || v_version) || ')'
                          else '' end
    );
  end if;

  return v_row;
end;
$$;

grant execute on function public.kb_propose(
  text, text, text, text, text, text[], text, text[], uuid[], boolean, uuid, boolean, text
) to authenticated;
