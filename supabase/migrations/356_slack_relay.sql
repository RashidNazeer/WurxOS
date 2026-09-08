-- ============================================================
-- WurxOS v2 — Migration 356: Slack relay.
--
-- Someone tags a watched person in a Slack channel with a question. The
-- question is answered by the WurxOS assistant using real data, and the answer
-- is posted into ONE internal channel where the OLs and the Boss can read it
-- and forward it on.
--
-- ── WHY THE ANSWER GOES TO A FIXED DESTINATION ─────────────────────────────
-- The assistant can reach salary, performance, incentives and attendance. In
-- the app those are role-gated by the caller's login; Slack has no such login,
-- so the safety here comes from WHERE the answer lands rather than who asked.
-- Every reply goes to one internal channel whose members already have full
-- access in WurxOS. Nothing is ever posted back into the channel the question
-- came from — that would put an answer in front of whoever happens to be there.
--
-- ── CONFIG LIVES IN A TABLE, NOT IN SECRETS ────────────────────────────────
-- Channels and watched people change; tokens do not. Keeping the routing here
-- means the Boss can add a channel without a redeploy, and the audit log shows
-- what the routing was at the time.
-- ============================================================

create table if not exists public.slack_config (
  id                 int primary key default 1,
  enabled            boolean not null default false,   -- OFF until deliberately switched on
  source_channel_ids text[]  not null default '{}',    -- only these are acted on
  dest_channel_id    text,                             -- every answer goes here
  watch_user_ids     text[]  not null default '{}',    -- a mention of one of these triggers it
  answer_as_user_id  uuid references public.profiles(id) on delete set null,
  updated_by         uuid references public.profiles(id) on delete set null,
  updated_at         timestamptz not null default now(),
  constraint slack_config_singleton check (id = 1)
);
insert into public.slack_config (id) values (1) on conflict (id) do nothing;

comment on column public.slack_config.answer_as_user_id is
  'The WurxOS profile the assistant answers AS. Must be a boss — the relay refuses otherwise. Slack users have no WurxOS identity, so the answer is generated at this person''s access level and delivered only to dest_channel_id.';

-- ── Log every relayed question ─────────────────────────────────────────────
-- Written before the answer is attempted. If the assistant fails, or an answer
-- ends up somewhere unexpected, the record of what came in and where it was
-- sent still exists. A log that only records successes cannot answer the
-- question you ask after something goes wrong.
create table if not exists public.slack_relay_log (
  id              uuid primary key default gen_random_uuid(),
  slack_event_id  text unique,          -- Slack retries; this makes replays a no-op
  source_channel  text,
  source_user     text,
  mentioned_user  text,
  question        text,
  answer          text,
  dest_channel    text,
  posted          boolean not null default false,
  error           text,
  created_at      timestamptz not null default now(),
  finished_at     timestamptz
);

create index if not exists slack_relay_log_created_idx on public.slack_relay_log (created_at desc);

alter table public.slack_config    enable row level security;
alter table public.slack_relay_log enable row level security;

drop policy if exists slack_config_select on public.slack_config;
create policy slack_config_select on public.slack_config for select
  using (public.is_boss(auth.uid()));

drop policy if exists slack_config_write on public.slack_config;
create policy slack_config_write on public.slack_config for all
  using (public.is_boss(auth.uid())) with check (public.is_boss(auth.uid()));

drop policy if exists slack_relay_log_select on public.slack_relay_log;
create policy slack_relay_log_select on public.slack_relay_log for select
  using (public.is_boss(auth.uid()));
-- No write policies on the log: the edge function writes it with the service
-- role. An audit trail its subject can edit is decoration.

do $verify$
declare v int;
begin
  select count(*) into v from public.slack_config where id = 1;
  if v <> 1 then raise exception '356: slack_config singleton missing'; end if;

  select count(*) into v from pg_policies
   where schemaname = 'public' and tablename = 'slack_relay_log' and cmd <> 'SELECT';
  if v <> 0 then raise exception '356: slack_relay_log has % write policies', v; end if;

  select count(*) into v from public.slack_config where id = 1 and enabled;
  if v <> 0 then raise exception '356: the relay must ship DISABLED'; end if;

  raise notice '356: Slack relay ready — disabled until configured and switched on';
end;
$verify$;
