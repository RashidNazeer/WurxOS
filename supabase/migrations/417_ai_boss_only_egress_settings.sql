-- A few Buddy settings become Boss-only. Security review, 2026-10-06.
--
-- THE PROBLEM. Mig 403 made `ai_assistant_config` writable by the Boss OR any
-- active developer, on every column, on purpose (Owner, 2026-10-01:
-- "developers and Boss both can see All wurx buddy settings", "developers must
-- be able to change as well"). That is fine for models, the fallback chain and
-- the Train docs. It is not fine for the handful of columns that decide WHERE
-- COMPANY DATA GOES, because those turn a settings write into an exfiltration
-- channel:
--
--   * `searxng_url` is the first provider in the default order, so it receives
--     EVERY web query from EVERY role, verbatim. A developer could point it at
--     a host they control and read the Boss's questions.
--   * `searxng_allow_http` additionally permits plain http and private LAN
--     addresses for that host.
--   * `free_provider_sources` (mig 406) is the privacy rule for what may be
--     embedded on the NVIDIA / Gemini free tiers. Adding a source type there
--     sends that corpus to a free endpoint.
--
-- A developer is a trusted colleague, but `ROLE_CAPS` says a developer may not
-- see pay data, and these three columns are a way around that which leaves no
-- trace in the app. So they are narrowed to the Boss, and everything else a
-- developer could already change stays exactly as it was.
--
-- DELIBERATELY NOT NARROWED, so the Owner's instruction keeps as much force as
-- possible: model, model_key_slot, fallback_models, fallback_enabled,
-- auto_failover, role_models, prices, enabled, allowed_roles, retrieval,
-- persona, web_search_enabled, web_providers, web_max_results,
-- web_allowed_roles. A developer can still turn web search on and off, pick
-- providers and roles, and edit the persona.
--
-- `persona` WAS CONSIDERED and left out on purpose. It heads every role's
-- system prompt, so the instinct is to lock it, but it cannot actually reach
-- data: the ACL is enforced in SQL by ai_can_read_document / ai_search, not by
-- the prompt, so no wording can widen what a caller may read. The one thing a
-- hostile persona could previously do was talk Buddy into putting data in a
-- web query, and that is now blocked mechanically rather than by prompt — the
-- people/pay latch, the "only a URL the user gave or a search returned" rule
-- and the query caps in agent/tools.ts. A bad persona can still make Buddy
-- unhelpful or untruthful, which is a trust problem with a colleague, not a
-- data-egress hole, and the Owner asked for developers to have this.
-- If that trade stops looking right, add 'persona' to boss_only_cols below:
-- the trigger is written so it is a one-word change.

-- UPDATE ALONE IS NOT ENOUGH. `ai_config_write` (mig 403) is `for all`, so a
-- guard on UPDATE only would be walked around by deleting the id=1 row and
-- inserting a replacement carrying the attacker's searxng_url. The trigger
-- therefore covers INSERT and UPDATE, and DELETE is refused outright for
-- anyone but the Boss — there is exactly one config row and nobody has a
-- reason to remove it.

create or replace function public.ai_config_guard_boss_only_cols()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  -- The columns that decide where company data is sent.
  boss_only_cols constant text[] := array['searxng_url', 'searxng_allow_http', 'free_provider_sources'];
  col text;
  changed boolean;
  v_old jsonb;
begin
  -- The service role (edge functions) and the Boss may change anything.
  if coalesce(current_setting('request.jwt.claim.role', true), '') = 'service_role'
     or auth.uid() is null
     or public.is_boss(auth.uid()) then
    return case when tg_op = 'DELETE' then old else new end;
  end if;

  if tg_op = 'DELETE' then
    raise exception 'Only the Boss can delete the assistant configuration.' using errcode = '42501';
  end if;

  -- On INSERT there is no previous row to compare against, so the test is
  -- simply "did they set one of these at all". Inserting the inert defaults is
  -- fine; inserting a row that already points somewhere is not.
  if tg_op = 'INSERT' then
    if new.searxng_url is not null
       or coalesce(new.searxng_allow_http, false)
       or coalesce(array_length(new.free_provider_sources, 1), 0) > 0 then
      raise exception 'Only the Boss can set searxng_url, searxng_allow_http or free_provider_sources, because they decide where company data is sent.'
        using errcode = '42501';
    end if;
    return new;
  end if;
  v_old := to_jsonb(old);

  foreach col in array boss_only_cols loop
    -- to_jsonb(row) -> column, so one branch covers text, boolean and arrays.
    execute format('select ($1::jsonb -> %L) is distinct from ($2::jsonb -> %L)', col, col)
      into changed using to_jsonb(new), v_old;
    if changed then
      raise exception 'Only the Boss can change %, because it decides where company data is sent.', col
        using errcode = '42501';
    end if;
  end loop;
  return new;
end $$;

revoke execute on function public.ai_config_guard_boss_only_cols() from public, anon;

drop trigger if exists ai_config_boss_only_cols on public.ai_assistant_config;
create trigger ai_config_boss_only_cols
  before insert or update or delete on public.ai_assistant_config
  for each row execute function public.ai_config_guard_boss_only_cols();
