-- ============================================================
-- 415 — Wurx Buddy: internet search / browse settings (SearXNG + Tavily).
--
--   ai_assistant_config
--     web_search_enabled  master switch. Default OFF: nothing reaches the internet
--                         until the Boss or a developer turns it on.
--     web_providers       ordered list, any of 'searxng', 'tavily'.
--     web_merge           false = the first provider that answers wins (the rest
--                         are fallbacks); true = ask all and merge the results.
--     searxng_url         NO default, on purpose: pointing Buddy at somebody else's
--                         public SearXNG instance would leak every question the
--                         company asks into a stranger's logs. Only the company's
--                         own instance goes here (null = SearXNG unavailable).
--     searxng_allow_http  allow a plain-http URL, for an instance on the LAN only.
--     web_max_results     results per search, 1-20.
--     web_allowed_roles   roles that may search the web; null = every role that
--                         may already use Buddy (allowed_roles).
--   ai_usage_log.kind     + 'web_search', 'web_extract' (Tavily bills per call),
--                         next to rerank / embed_query / rate_limited (mig 387).
--
-- Writes: no column allow-list exists. ai_config_write (mig 403: Boss or an
-- active developer) is a row policy over every column, so the new columns are
-- writable by the same people with no further change here. Idempotent.
-- ============================================================

alter table public.ai_assistant_config
  add column if not exists web_search_enabled boolean not null default false,
  add column if not exists web_providers      jsonb   not null default '["searxng","tavily"]'::jsonb,
  add column if not exists web_merge          boolean not null default false,
  add column if not exists searxng_url        text,
  add column if not exists searxng_allow_http boolean not null default false,
  add column if not exists web_max_results    int     not null default 6,
  add column if not exists web_allowed_roles  text[];

alter table public.ai_assistant_config drop constraint if exists ai_assistant_config_web_max_results_check;
alter table public.ai_assistant_config add constraint ai_assistant_config_web_max_results_check
  check (web_max_results between 1 and 20);

-- An array holding only known providers. The jsonb_typeof guard comes first so a
-- non-array never reaches jsonb_array_elements_text; case short-circuits.
alter table public.ai_assistant_config drop constraint if exists ai_assistant_config_web_providers_check;
alter table public.ai_assistant_config add constraint ai_assistant_config_web_providers_check
  check (case when jsonb_typeof(web_providers) = 'array'
              then web_providers <@ '["searxng","tavily"]'::jsonb
              else false end);

-- Usage log: keep the three kinds of mig 387 ('rerank', 'embed_query',
-- 'rate_limited' — 387 is the only migration that ever constrained this
-- column), and add the two web ones.
--
-- The old check was declared INLINE in 387, so its name was chosen by
-- Postgres. "ai_usage_log_kind_check" is the name it picks, but if that name
-- was already taken it would have appended a digit, and a plain
-- `drop constraint if exists <assumed name>` would then silently do nothing —
-- leaving the old constraint in force to reject 'web_search' forever while
-- this migration still reported success. So every check constraint on the
-- table that mentions the old kinds is found by introspection and dropped.
do $$
declare c record;
begin
  for c in
    select con.conname
      from pg_constraint con
      join pg_class rel on rel.oid = con.conrelid
      join pg_namespace ns on ns.oid = rel.relnamespace
     where ns.nspname = 'public' and rel.relname = 'ai_usage_log' and con.contype = 'c'
       and pg_get_constraintdef(con.oid) like '%embed_query%'
  loop
    execute format('alter table public.ai_usage_log drop constraint %I', c.conname);
    raise notice '415: dropped old kind constraint %', c.conname;
  end loop;
end $$;

alter table public.ai_usage_log drop constraint if exists ai_usage_log_kind_check;
alter table public.ai_usage_log add constraint ai_usage_log_kind_check
  check (kind in ('rerank', 'embed_query', 'rate_limited', 'web_search', 'web_extract'));
