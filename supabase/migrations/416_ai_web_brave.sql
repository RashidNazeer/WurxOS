-- Brave Search as a third web provider for Wurx Buddy (Owner, 2026-10-06:
-- "add the machinery, I will add the api later").
--
-- Only the allow-list needs widening. Brave has no configuration of its own:
-- its key is a function secret (BRAVE_API_KEY), and a provider with no key is
-- skipped by usableProviders(), so listing it here cannot break a turn before
-- the key exists.
--
-- The default order becomes searxng, brave, tavily — cheapest and most private
-- first. SearXNG is the company's own instance (free, leaks nothing), Brave has
-- its own independent index and a free tier, and Tavily bills credits per call,
-- so it goes last.

-- web_providers may now contain 'brave'. Dropped and re-added rather than
-- edited, because a check constraint cannot be altered in place.
alter table public.ai_assistant_config drop constraint if exists ai_assistant_config_web_providers_check;
alter table public.ai_assistant_config add constraint ai_assistant_config_web_providers_check
  check (case when jsonb_typeof(web_providers) = 'array'
              then web_providers <@ '["searxng","tavily","brave"]'::jsonb
              else false end);

-- The column default, for rows created from here on.
alter table public.ai_assistant_config
  alter column web_providers set default '["searxng","brave","tavily"]'::jsonb;

-- Existing row: add 'brave' to the order if it is not already listed, keeping
-- whatever order the Boss has chosen and inserting Brave before Tavily (so a
-- free provider is tried before a paid one). Only touched when the stored value
-- is still an array, and never when Brave is already there.
update public.ai_assistant_config c
   set web_providers = (
     select jsonb_agg(p order by ord)
       from (
         select value as p,
                case when value = '"searxng"'::jsonb then 1
                     when value = '"brave"'::jsonb   then 2
                     else 3 end as ord
           from jsonb_array_elements(c.web_providers)
         union all
         select '"brave"'::jsonb, 2
       ) s
   )
 where jsonb_typeof(c.web_providers) = 'array'
   and not (c.web_providers @> '["brave"]'::jsonb);
