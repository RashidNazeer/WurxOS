-- ============================================================
-- Migration 100 — KB → Discord notifications
--
-- Posts to a single Discord channel webhook whenever a knowledge-base
-- article is published. The webhook URL lives in
-- public.app_config['discord_wurxos_webhook'] (text). If the key is
-- missing or empty, the trigger silently no-ops so dev environments
-- without a webhook still work.
--
-- Two events fire a post:
--   1. INSERT — new article (always).
--   2. UPDATE — when version_label OR sop_group_id changes (i.e. a
--      "new version published" of an existing SOP). Edit-in-place
--      typo fixes do NOT post.
--
-- Silent posts only (no @here / @everyone). Channel becomes a passive
-- log; users who want push alerts enable Discord channel notifications
-- on their own.
--
-- Failure is swallowed — if Discord is down or returns 4xx, the
-- KB save still succeeds. We just log a warning.
-- ============================================================

create or replace function public.kb_discord_notify()
returns trigger
language plpgsql
security definer
set search_path = public, net
as $$
declare
  v_url       text;
  v_kind      text;
  v_title     text;
  v_label     text;
  v_category  text;
  v_visibility text;
  v_author    text;
  v_link      text;
  v_color     int;
  v_payload   jsonb;
begin
  begin
    select value into v_url from public.app_config where key = 'discord_wurxos_webhook';
    if v_url is null or v_url = '' then return new; end if;

    -- Decide whether this UPDATE is meaningful (new version) or skip.
    if tg_op = 'UPDATE' then
      if coalesce(old.version_label, '') is not distinct from coalesce(new.version_label, '')
         and coalesce(old.sop_group_id::text, '') is not distinct from coalesce(new.sop_group_id::text, '')
         and coalesce(old.version, 0) is not distinct from coalesce(new.version, 0)
      then
        return new;
      end if;
      v_kind := 'Updated';
    else
      v_kind := 'New';
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

    v_link  := 'https://wurxos.vercel.app/knowledge';
    -- Discord embed color: green for new, blue for update.
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

drop trigger if exists kb_discord_notify_ai on public.kb_articles;
create trigger kb_discord_notify_ai
  after insert on public.kb_articles
  for each row execute function public.kb_discord_notify();

drop trigger if exists kb_discord_notify_au on public.kb_articles;
create trigger kb_discord_notify_au
  after update of title, category, version, version_label, sop_group_id, visibility
  on public.kb_articles
  for each row execute function public.kb_discord_notify();
