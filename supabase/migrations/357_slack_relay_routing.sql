-- ============================================================
-- WurxOS v2 — Migration 357: seed the Slack relay routing.
--
-- The IDs come from the Slack workspace "Wurx-Internal - Testing" and were
-- each resolved against Slack's API before being written here, so none of them
-- is a guess:
--
--   C0C162ZK2GY  #pure-daily-care   source — questions come from here
--   C0C0FBHGTHA  #top-management    destination — every answer goes here
--
--   U0C0BLS2T4J  Haider Ali          \
--   U0C05E2PY11  mrrashid3255         | tagging any of these four
--   U0C05E583T5  mrkhan32558009       | triggers a relayed answer
--   U0C09MWH64W  Mr Rashid           /
--
-- answer_as_user_id is resolved to the Boss rather than hardcoded — a pasted
-- uuid would rot the first time the account changed, and the relay refuses to
-- answer as anyone who is not a boss anyway.
--
-- LEFT DISABLED. Configuring the routing and switching the thing on are
-- separate decisions, and the second one belongs to a person.
-- ============================================================

update public.slack_config set
  source_channel_ids = array['C0C162ZK2GY'],
  dest_channel_id    = 'C0C0FBHGTHA',
  watch_user_ids     = array['U0C0BLS2T4J', 'U0C05E2PY11', 'U0C05E583T5', 'U0C09MWH64W'],
  answer_as_user_id  = (
    select id from public.profiles
     where lower(role) = 'boss' and is_active
     order by created_at
     limit 1
  ),
  updated_at = now()
where id = 1;

do $verify$
declare c record;
begin
  select * into c from public.slack_config where id = 1;

  if c.answer_as_user_id is null then
    raise exception '357: no active boss profile found — the relay has nobody to answer as';
  end if;
  if c.dest_channel_id is null then
    raise exception '357: destination channel not set';
  end if;
  -- The destination must never also be a source: the relay would answer its own
  -- answers, and each reply would arrive tagged, forever.
  if c.dest_channel_id = any (c.source_channel_ids) then
    raise exception '357: the destination channel is also a source — that is a feedback loop';
  end if;
  if array_length(c.watch_user_ids, 1) is null then
    raise exception '357: no watched users — nothing would ever trigger';
  end if;
  if c.enabled then
    raise exception '357: routing is configured but the relay must stay OFF until switched on deliberately';
  end if;

  raise notice '357: routing set — % source channel(s), % watched user(s), destination %; still disabled',
    coalesce(array_length(c.source_channel_ids, 1), 0),
    coalesce(array_length(c.watch_user_ids, 1), 0),
    c.dest_channel_id;
end;
$verify$;
