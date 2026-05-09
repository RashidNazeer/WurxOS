-- ============================================================
-- Migration 101 — KB Discord post: fire only when an article is
-- actually published (approval_status transitions to 'approved').
--
-- Migration 100 fired on every INSERT and on UPDATE of several
-- columns. That caused two problems for the user:
--   1. Articles posted to Discord at propose time, before the
--      Boss reviewed them.
--   2. Each approve generated a second card (insert -> "New",
--      then approve -> "Updated").
--
-- New rule: post once, when approval_status becomes 'approved'.
-- That covers:
--   * admin auto-approve flow (fresh INSERT with status='approved')
--   * Boss-review flow (INSERT pending, later UPDATE to approved)
--   * new-version flow (a fresh row in same sop_group_id that
--     ends up approved)
--
-- Title also distinguishes "New" vs "Updated" by checking whether
-- this is the first approved row in the sop_group_id (or a one-off
-- with no group at all).
--
-- Also: link points at /kb (the actual route) instead of /knowledge,
-- which was 404-ing for the user.
-- ============================================================

create or replace function public.kb_discord_notify()
returns trigger
language plpgsql
security definer
set search_path = public, net
as $$
declare
  v_url        text;
  v_should     boolean := false;
  v_kind       text;
  v_title      text;
  v_label      text;
  v_category   text;
  v_visibility text;
  v_author     text;
  v_link       text;
  v_color      int;
  v_payload    jsonb;
  v_prior_approved int;
begin
  -- Decide whether this row's transition warrants a post.
  -- Only fire when approval_status ends as 'approved' AND either
  -- the row is brand-new approved (INSERT) or just transitioned
  -- from pending/rejected to approved (UPDATE).
  if tg_op = 'INSERT' then
    v_should := (new.approval_status = 'approved');
  elsif tg_op = 'UPDATE' then
    v_should := (new.approval_status = 'approved'
                 and coalesce(old.approval_status, '') is distinct from 'approved');
  end if;

  if not v_should then return new; end if;

  begin
    select value into v_url from public.app_config where key = 'discord_wurxos_webhook';
    if v_url is null or v_url = '' then return new; end if;

    -- Was anything else in this sop_group_id approved before now?
    -- If yes -> this is a new VERSION; if no -> brand-new SOP.
    -- For non-grouped articles (sop_group_id null) we always treat
    -- as "New" because there's no version concept.
    if new.sop_group_id is null then
      v_kind := 'New';
    else
      select count(*) into v_prior_approved
        from public.kb_articles
       where sop_group_id = new.sop_group_id
         and approval_status = 'approved'
         and id <> new.id;
      v_kind := case when v_prior_approved > 0 then 'Updated' else 'New' end;
    end if;

    v_title    := coalesce(new.title, '(untitled)');
    v_category := coalesce(new.category, 'General');
    v_visibility := coalesce(new.visibility, 'office');
    v_label    := coalesce(new.version_label,
                           case when new.version is not null and new.version > 1
                                then 'v' || new.version::text
                                else null end);

    select coalesce(display_name, split_part(email,'@',1), 'Someone')
      into v_author from public.profiles where id = new.created_by;
    v_author := coalesce(v_author, 'Someone');

    v_link  := 'https://wurxos.vercel.app/kb';
    v_color := case when v_kind = 'New' then 5763719 else 3447003 end;

    v_payload := jsonb_build_object(
      'embeds', jsonb_build_array(
        jsonb_build_object(
          'title',       '📘 ' || v_kind || ': ' || v_title,
          'url',         v_link,
          'color',       v_color,
          'description', 'Category: **' || v_category || '**'
                         || case when v_label is not null then ' · ' || v_label else '' end
                         || ' · by ' || v_author
                         || case when v_visibility = 'role' then E'\nRole-restricted article.' else '' end,
          'footer',      jsonb_build_object('text', 'WurxOS · ' || to_char(now() at time zone 'Asia/Karachi', 'Mon DD, YYYY HH24:MI') || ' PKT')
        )
      )
    );

    perform net.http_post(
      url     := v_url,
      headers := jsonb_build_object('Content-Type', 'application/json'),
      body    := v_payload
    );
  exception when others then
    raise warning 'kb_discord_notify failed: %', sqlerrm;
  end;
  return new;
end;
$$;

-- Drop the old wide triggers from 100 and replace with a tighter pair.
drop trigger if exists kb_discord_notify_ai on public.kb_articles;
drop trigger if exists kb_discord_notify_au on public.kb_articles;

-- Fire on INSERT only when the row lands already approved (admin
-- auto-approve path), so we don't post at propose time.
create trigger kb_discord_notify_ai
  after insert on public.kb_articles
  for each row
  when (new.approval_status = 'approved')
  execute function public.kb_discord_notify();

-- Fire on UPDATE only when approval_status flips into 'approved'.
-- The function still re-checks the transition for safety.
create trigger kb_discord_notify_au
  after update of approval_status on public.kb_articles
  for each row
  when (new.approval_status = 'approved'
        and coalesce(old.approval_status, '') is distinct from 'approved')
  execute function public.kb_discord_notify();
