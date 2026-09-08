-- ============================================================
-- WurxOS v2 — Migration 358: tell the relay which brand a channel is about.
--
-- A question asked in #pure-daily-care is a question about Pure Daily Care.
-- The person asking knows that and does not say it, so "how are we doing?"
-- arrived at the assistant with no subject at all and got a general answer
-- across every brand.
--
-- This maps each watched channel to a brand name. The relay prefixes the
-- question with that context, so the assistant resolves "we" and "our" to the
-- right brand — while a question that names a DIFFERENT brand still wins,
-- because the context is stated as a default rather than a constraint.
--
-- The brand name here must match public.brands.brand_name. The verify block
-- below refuses any mapping that does not, so a typo fails at migration time
-- instead of quietly producing brand-less answers for weeks.
-- ============================================================

alter table public.slack_config
  add column if not exists channel_brands jsonb not null default '{}'::jsonb;

comment on column public.slack_config.channel_brands is
  'Slack channel id -> brands.brand_name. Questions from that channel are treated as being about that brand unless they name another one.';

update public.slack_config
   set channel_brands = jsonb_build_object('C0C162ZK2GY', 'Pure Daily Care'),
       updated_at = now()
 where id = 1;

do $verify$
declare
  cfg record;
  k text;
  v text;
  n int;
begin
  select * into cfg from public.slack_config where id = 1;

  -- Every mapped brand must actually exist, or the context we inject is a lie.
  for k, v in select * from jsonb_each_text(cfg.channel_brands) loop
    select count(*) into n from public.brands where lower(brand_name) = lower(v);
    if n = 0 then
      raise exception '358: channel % maps to brand "%" which does not exist', k, v;
    end if;
    -- And it must be a channel the relay actually watches, or the mapping is dead.
    if not (k = any (cfg.source_channel_ids)) then
      raise exception '358: channel % has a brand mapping but is not a source channel', k;
    end if;
  end loop;

  raise notice '358: % channel(s) mapped to a brand',
    coalesce((select count(*) from jsonb_each_text(cfg.channel_brands)), 0);
end;
$verify$;
