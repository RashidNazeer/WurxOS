-- ============================================================
-- 404 — Wurx Buddy: a model per role, and a budget saver (Owner, 2026-10-01:
-- important members keep better models when limits are low).
--
--   ai_assistant_config.role_models  {"<role>": {"model", "key_slot",
--       "fallback_models": [{key_slot, model}] (≤ 6), "economy": {"model", "key_slot"}}}
--     Roles: boss, ol, tl, pctl, apc, ipc, developer, ads_manager. A missing role
--     or field inherits the global model / model_key_slot / fallback_models.
--   ai_assistant_config.budget_saver_pct  (1-100, null = off): once month-to-date
--     spend reaches this % of monthly_budget_usd, roles with an `economy` model use it.
--   ai_month_spend_usd()  month-to-date spend (PKT), for the server (service role).
--   The model trigger checks role_models with the same rules as the global choice.
-- Writes: ai_config_write (mig 403, Boss or an active developer). Idempotent.
-- ============================================================

alter table public.ai_assistant_config
  add column if not exists role_models      jsonb not null default '{}'::jsonb,
  add column if not exists budget_saver_pct int check (budget_saver_pct between 1 and 100);

-- One {key_slot, model} entry: a valid slot and a model name.
create or replace function public.ai_model_entry_ok(e jsonb) returns boolean
language sql immutable as $$
  select jsonb_typeof(e) = 'object'
     and coalesce(e->>'key_slot', 'primary') in ('primary', 'fallback', 'groq', 'gemini')
     and coalesce(e->>'model', '') <> '';
$$;

create or replace function public.ai_trg_config_model_check() returns trigger
language plpgsql set search_path = public as $$
declare e jsonb; r text; v jsonb;
begin
  if new.model_key_slot not in ('primary', 'fallback', 'groq', 'gemini') then
    raise exception 'model_key_slot must be primary, fallback, groq or gemini';
  end if;
  if (tg_op = 'INSERT' or new.model is distinct from old.model or new.model_key_slot is distinct from old.model_key_slot)
     and not public.ai_model_usable(new.model_key_slot, new.model) then
    raise exception 'model % is not usable on the % key (refresh the model list, or pick one that supports tools and streaming)', new.model, new.model_key_slot;
  end if;
  if tg_op = 'INSERT' or new.fallback_models is distinct from old.fallback_models then
    if jsonb_typeof(new.fallback_models) <> 'array' or jsonb_array_length(new.fallback_models) > 6 then
      raise exception 'fallback_models must be an array of at most 6 {key_slot, model}';
    end if;
    for e in select * from jsonb_array_elements(new.fallback_models) loop
      if not public.ai_model_entry_ok(e) or e->>'key_slot' is null then
        raise exception 'each fallback must be {"key_slot": "primary"|"fallback"|"groq"|"gemini", "model": "<name>"}';
      end if;
    end loop;
  end if;
  -- Per-role models (mig 404): the same rules, role by role.
  if tg_op = 'INSERT' or new.role_models is distinct from old.role_models then
    if jsonb_typeof(new.role_models) <> 'object' then raise exception 'role_models must be an object keyed by role'; end if;
    for r, v in select * from jsonb_each(new.role_models) loop
      if r not in ('boss', 'ol', 'tl', 'pctl', 'apc', 'ipc', 'developer', 'ads_manager') then
        raise exception 'role_models: unknown role %', r;
      end if;
      if jsonb_typeof(v) <> 'object' then raise exception 'role_models.%: must be an object', r; end if;
      if v ? 'model' then
        if not public.ai_model_entry_ok(v) or not public.ai_model_usable(coalesce(v->>'key_slot', 'primary'), v->>'model') then
          raise exception 'role_models.%: model % is not usable on the % key', r, v->>'model', coalesce(v->>'key_slot', 'primary');
        end if;
      end if;
      if v ? 'economy' then
        if not public.ai_model_entry_ok(v->'economy')
           or not public.ai_model_usable(coalesce(v->'economy'->>'key_slot', 'primary'), v->'economy'->>'model') then
          raise exception 'role_models.%.economy: model % is not usable on the % key', r, v->'economy'->>'model', coalesce(v->'economy'->>'key_slot', 'primary');
        end if;
      end if;
      if v ? 'fallback_models' then
        if jsonb_typeof(v->'fallback_models') <> 'array' or jsonb_array_length(v->'fallback_models') > 6 then
          raise exception 'role_models.%.fallback_models must be an array of at most 6 {key_slot, model}', r;
        end if;
        for e in select * from jsonb_array_elements(v->'fallback_models') loop
          if not public.ai_model_entry_ok(e) or e->>'key_slot' is null then
            raise exception 'role_models.%.fallback_models: each must be {"key_slot": "primary"|"fallback"|"groq"|"gemini", "model": "<name>"}', r;
          end if;
        end loop;
      end if;
    end loop;
  end if;
  return new;
end;
$$;
revoke execute on function public.ai_trg_config_model_check() from public, anon, authenticated;
drop trigger if exists ai_assistant_config_model_check on public.ai_assistant_config;
create trigger ai_assistant_config_model_check
  before insert or update of model, model_key_slot, fallback_models, role_models on public.ai_assistant_config
  for each row execute function public.ai_trg_config_model_check();

-- Month-to-date spend, as ai_usage_summary's month_to_date (PKT month).
create or replace function public.ai_month_spend_usd() returns numeric
language sql stable security definer set search_path = public as $$
  with m as (select date_trunc('month', (now() at time zone 'Asia/Karachi'))::date as start),
       p as (select c.prices from public.ai_assistant_config c where c.id = 1)
  select coalesce(sum(x), 0) from (
    select l.est_cost_usd::numeric x from public.ai_request_log l, m where (l.created_at at time zone 'Asia/Karachi')::date >= m.start
    union all
    select u.est_cost_usd::numeric from public.ai_usage_log u, m where (u.created_at at time zone 'Asia/Karachi')::date >= m.start
    union all
    select r.embed_tokens * coalesce((p.prices->public.ai_embed_model()->>'in')::numeric, 0) / 1e6
      from public.ai_ingest_runs r, m, p
     where coalesce(r.embed_tokens, 0) > 0 and (r.started_at at time zone 'Asia/Karachi')::date >= m.start
  ) t;
$$;
revoke execute on function public.ai_month_spend_usd() from public, anon, authenticated;
grant  execute on function public.ai_month_spend_usd() to service_role;
