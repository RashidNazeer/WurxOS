-- ============================================================
-- 397 — Wurx Buddy: any model the Boss picks, and free fallbacks.
--
--   ai_model_catalog   what each OpenAI key ('primary' = OPEN_AI_API_KEY,
--                      'fallback' = OPEN_AI_API_KEY_FALLBACK) can actually use,
--                      filled by the function's {refresh_models} action (a tiny
--                      probe per model). params = learned request quirks, e.g.
--                      {"omit": ["reasoning"]} for a model that rejects them.
--                      RLS: the Boss reads; only the service role writes.
--   ai_assistant_config
--     model_key_slot   which key runs `model` ('primary' default)
--     fallback_models  ordered [{key_slot, model}], tried when a call fails for
--                      an account reason (no credits, key refused)
--     fallback_enabled
--     A change of model / slot / chain is checked by a trigger: the model must
--     be in the catalog for that key, available, with tools and streaming; with
--     an empty catalog only the three built-in primary models are accepted.
--   ai_request_log.key_slot, ai_usage_log.key_slot / unpriced
--   prices           + gpt-6-luna at 0 (it answers free on the fallback key)
--   ai_usage_summary + 'unpriced' (calls with no known price, costed at 0)
--                    + 'by_key_slot'
-- ai_search already takes a NULL embedding (keyword arm only). Idempotent.
-- ============================================================

create table if not exists public.ai_model_catalog (
  key_slot        text not null check (key_slot in ('primary', 'fallback')),
  model           text not null,
  available       boolean not null default false,
  supports_tools  boolean not null default false,
  supports_stream boolean not null default false,
  free            boolean not null default false,
  params          jsonb not null default '{}'::jsonb,
  last_error      text,
  checked_at      timestamptz not null default now(),
  primary key (key_slot, model)
);
alter table public.ai_model_catalog enable row level security;
drop policy if exists "ai_model_catalog_read" on public.ai_model_catalog;
create policy "ai_model_catalog_read" on public.ai_model_catalog for select
  using (public.is_boss(auth.uid()));
revoke all on public.ai_model_catalog from anon;
revoke insert, update, delete, truncate, references, trigger on public.ai_model_catalog from authenticated;
grant select on public.ai_model_catalog to authenticated;

alter table public.ai_assistant_config
  add column if not exists model_key_slot   text  not null default 'primary',
  add column if not exists fallback_models  jsonb not null default '[{"key_slot": "fallback", "model": "gpt-6-luna"}]'::jsonb,
  add column if not exists fallback_enabled boolean not null default true;

alter table public.ai_request_log add column if not exists key_slot text;
alter table public.ai_usage_log
  add column if not exists key_slot text,
  add column if not exists unpriced boolean not null default false;

update public.ai_assistant_config
   set prices = jsonb_build_object('gpt-6-luna', jsonb_build_object('in', 0, 'cached', 0, 'out', 0)) || prices
 where not (prices ? 'gpt-6-luna');

-- ── the model check ──────────────────────────────────────────────────────
create or replace function public.ai_model_usable(p_slot text, p_model text) returns boolean
language sql stable security definer set search_path = public as $$
  select case
    -- A built-in model that failed its probe only for lack of credits stays
    -- choosable: it works again the moment the account is topped up.
    when exists (select 1 from public.ai_model_catalog c where c.key_slot = p_slot)
      then exists (select 1 from public.ai_model_catalog c where c.key_slot = p_slot and c.model = p_model
                     and ((c.available and c.supports_tools and c.supports_stream)
                          or (p_slot = 'primary' and p_model in ('gpt-5.4-mini', 'gpt-5.5', 'gpt-5.4-nano')
                              and c.last_error ~* '(quota|credit)')))
    else p_slot = 'primary' and p_model in ('gpt-5.4-mini', 'gpt-5.5', 'gpt-5.4-nano')
  end;
$$;
revoke execute on function public.ai_model_usable(text, text) from public, anon;
grant  execute on function public.ai_model_usable(text, text) to authenticated, service_role;

create or replace function public.ai_trg_config_model_check() returns trigger
language plpgsql set search_path = public as $$
declare e jsonb;
begin
  if new.model_key_slot not in ('primary', 'fallback') then
    raise exception 'model_key_slot must be primary or fallback';
  end if;
  if (tg_op = 'INSERT' or new.model is distinct from old.model or new.model_key_slot is distinct from old.model_key_slot)
     and not public.ai_model_usable(new.model_key_slot, new.model) then
    raise exception 'model % is not usable on the % key (refresh the model list, or pick one that supports tools and streaming)', new.model, new.model_key_slot;
  end if;
  if tg_op = 'INSERT' or new.fallback_models is distinct from old.fallback_models then
    if jsonb_typeof(new.fallback_models) <> 'array' or jsonb_array_length(new.fallback_models) > 5 then
      raise exception 'fallback_models must be an array of at most 5 {key_slot, model}';
    end if;
    for e in select * from jsonb_array_elements(new.fallback_models) loop
      if jsonb_typeof(e) <> 'object' or coalesce(e->>'key_slot', '') not in ('primary', 'fallback') or coalesce(e->>'model', '') = '' then
        raise exception 'each fallback must be {"key_slot": "primary"|"fallback", "model": "<name>"}';
      end if;
    end loop;
  end if;
  return new;
end;
$$;
revoke execute on function public.ai_trg_config_model_check() from public, anon, authenticated;
drop trigger if exists ai_assistant_config_model_check on public.ai_assistant_config;
create trigger ai_assistant_config_model_check
  before insert or update of model, model_key_slot, fallback_models on public.ai_assistant_config
  for each row execute function public.ai_trg_config_model_check();

-- ── the summary: + unpriced, + by_key_slot. Otherwise as mig 387. ────────
create or replace function public.ai_usage_summary(p_from date default null, p_to date default null)
returns jsonb
language plpgsql stable
security definer
set search_path = public
as $$
declare
  v_today  date := (now() at time zone 'Asia/Karachi')::date;
  v_to     date := coalesce(p_to, v_today);
  v_from   date := coalesce(p_from, v_to - 29);
  v_prices jsonb;
  v_budget numeric;
  v_embed  text := public.ai_embed_model();
  v_mstart date := date_trunc('month', v_today)::date;
  v_mdays  int  := extract(day from (date_trunc('month', v_today) + interval '1 month - 1 day'))::int;
  v_mtd    numeric;
  v_out    jsonb;
  v_unpriced jsonb;
  v_slots  jsonb;
begin
  if not public.is_boss(auth.uid()) then raise exception 'not allowed: usage is Boss-only'; end if;
  if v_from > v_to then raise exception 'p_from is after p_to'; end if;
  if v_to - v_from > 400 then raise exception 'range too long (max 400 days)'; end if;
  select c.prices, c.monthly_budget_usd into v_prices, v_budget from public.ai_assistant_config c where c.id = 1;

  with
  chat as (
    select (l.created_at at time zone 'Asia/Karachi')::date as day, l.user_id, coalesce(l.model, 'unknown') as model,
           coalesce(l.surface, 'unknown') as surface, l.tokens_in, l.tokens_cached, l.tokens_out, l.est_cost_usd::numeric as cost,
           l.latency_ms, l.error, coalesce((l.flags->>'cancelled')::boolean, false) as cancelled,
           coalesce((l.flags->>'deadline_hit')::boolean, false) as deadline_hit
      from public.ai_request_log l
     where (l.created_at at time zone 'Asia/Karachi')::date between v_from and v_to
  ),
  other as (
    select (u.created_at at time zone 'Asia/Karachi')::date as day, u.kind, u.user_id, coalesce(u.model, 'unknown') as model,
           u.calls, u.tokens_in, u.tokens_cached, u.tokens_out, u.est_cost_usd::numeric as cost
      from public.ai_usage_log u
     where (u.created_at at time zone 'Asia/Karachi')::date between v_from and v_to
  ),
  ingest as (
    select (r.started_at at time zone 'Asia/Karachi')::date as day, r.embed_tokens as tokens_in,
           r.embed_tokens * coalesce((v_prices->v_embed->>'in')::numeric, 0) / 1e6 as cost
      from public.ai_ingest_runs r
     where coalesce(r.embed_tokens, 0) > 0
       and (r.started_at at time zone 'Asia/Karachi')::date between v_from and v_to
  ),
  -- every priced line, one shape: kind, day, model, user, calls, tokens, cost
  lines as (
    select 'chat'::text as kind, day, model, user_id, 1 as calls, tokens_in, tokens_cached, tokens_out, cost from chat
    union all
    select case kind when 'embed_query' then 'embeddings_query' else kind end, day, model, user_id, calls, tokens_in, tokens_cached, tokens_out, cost
      from other where kind <> 'rate_limited'
    union all
    select 'embeddings_ingest', day, v_embed, null, 1, tokens_in, 0, 0, cost from ingest
  )
  select jsonb_build_object(
    'from', v_from, 'to', v_to, 'timezone', 'Asia/Karachi', 'currency', 'USD',
    'prices_per_1m', v_prices,
    'totals', (select jsonb_build_object(
        'questions', (select count(*) from chat),
        'tokens_in', coalesce(sum(tokens_in), 0), 'tokens_cached', coalesce(sum(tokens_cached), 0), 'tokens_out', coalesce(sum(tokens_out), 0),
        'est_cost_usd', round(coalesce(sum(cost), 0), 6)) from lines),
    'outcomes', (select jsonb_build_object(
        'errors', count(*) filter (where error is not null and not cancelled),
        'cancelled', count(*) filter (where cancelled),
        'deadline_hit', count(*) filter (where deadline_hit),
        'rate_limited', (select coalesce(sum(calls), 0) from other where kind = 'rate_limited'),
        'avg_latency_ms', round(avg(latency_ms)),
        'p95_latency_ms', percentile_disc(0.95) within group (order by latency_ms)) from chat),
    'by_kind', coalesce((select jsonb_object_agg(kind, x) from (
        select kind, jsonb_build_object('calls', sum(calls), 'tokens_in', sum(tokens_in), 'tokens_cached', sum(tokens_cached),
               'tokens_out', sum(tokens_out), 'est_cost_usd', round(sum(cost), 6)) x
          from lines group by kind) k), '{}'::jsonb),
    'by_day', (select jsonb_agg(jsonb_build_object('date', d,
               'questions', (select count(*) from chat c where c.day = d),
               'tokens_in', (select coalesce(sum(tokens_in), 0) from lines l where l.day = d),
               'tokens_out', (select coalesce(sum(tokens_out), 0) from lines l where l.day = d),
               'est_cost_usd', (select round(coalesce(sum(cost), 0), 6) from lines l where l.day = d)) order by d)
          from (select g::date as d from generate_series(v_from::timestamp, v_to::timestamp, interval '1 day') g) days),
    'by_model', coalesce((select jsonb_agg(x order by (x->>'est_cost_usd')::numeric desc) from (
        select jsonb_build_object('model', model, 'calls', sum(calls), 'tokens_in', sum(tokens_in), 'tokens_cached', sum(tokens_cached),
               'tokens_out', sum(tokens_out), 'est_cost_usd', round(sum(cost), 6)) x
          from lines group by model) m), '[]'::jsonb),
    'by_surface', coalesce((select jsonb_object_agg(surface, x) from (
        select surface, jsonb_build_object('questions', count(*), 'est_cost_usd', round(sum(cost), 6)) x
          from chat group by surface) s), '{}'::jsonb),
    'by_user', coalesce((select jsonb_agg(x order by (x->>'est_cost_usd')::numeric desc) from (
        select jsonb_build_object('user_id', l.user_id, 'name', p.display_name, 'role', p.role,
               'questions', count(*) filter (where l.kind = 'chat'), 'est_cost_usd', round(sum(l.cost), 6)) x
          from lines l left join public.profiles p on p.id = l.user_id
         where l.user_id is not null
         group by l.user_id, p.display_name, p.role) u), '[]'::jsonb)
  ) into v_out;

  -- Calls with no known price (costed at 0), and which key answered (mig 397).
  select jsonb_build_object('calls', count(*), 'tokens_in', coalesce(sum(tokens_in), 0), 'tokens_out', coalesce(sum(tokens_out), 0),
         'models', coalesce(jsonb_agg(distinct model) filter (where model is not null), '[]'::jsonb))
    into v_unpriced
    from (select l.model, l.tokens_in, l.tokens_out from public.ai_request_log l
           where coalesce((l.flags->>'unpriced')::boolean, false)
             and (l.created_at at time zone 'Asia/Karachi')::date between v_from and v_to
          union all
          select u.model, u.tokens_in, u.tokens_out from public.ai_usage_log u
           where u.unpriced and (u.created_at at time zone 'Asia/Karachi')::date between v_from and v_to) t;
  select coalesce(jsonb_object_agg(slot, x), '{}'::jsonb) into v_slots from (
    select coalesce(l.key_slot, 'primary') as slot,
           jsonb_build_object('questions', count(*), 'fallback_used', count(*) filter (where l.flags ? 'fallback_used'),
                              'est_cost_usd', round(sum(l.est_cost_usd), 6)) x
      from public.ai_request_log l
     where (l.created_at at time zone 'Asia/Karachi')::date between v_from and v_to
     group by 1) s;

  -- Month to date (PKT), whatever the range asked for, and a straight-line projection.
  select coalesce(sum(x), 0) into v_mtd from (
    select est_cost_usd::numeric x from public.ai_request_log where (created_at at time zone 'Asia/Karachi')::date >= v_mstart
    union all
    select est_cost_usd::numeric from public.ai_usage_log where (created_at at time zone 'Asia/Karachi')::date >= v_mstart
    union all
    select embed_tokens * coalesce((v_prices->v_embed->>'in')::numeric, 0) / 1e6 from public.ai_ingest_runs
     where coalesce(embed_tokens, 0) > 0 and (started_at at time zone 'Asia/Karachi')::date >= v_mstart
  ) t;

  return v_out || jsonb_build_object('unpriced', v_unpriced, 'by_key_slot', v_slots) || jsonb_build_object('month_to_date', jsonb_build_object(
    'month', to_char(v_mstart, 'YYYY-MM'),
    'days_elapsed', extract(day from v_today)::int,
    'days_in_month', v_mdays,
    'est_cost_usd', round(v_mtd, 6),
    'projected_month_usd', round(v_mtd / extract(day from v_today) * v_mdays, 6),
    'budget_usd', v_budget,
    'budget_used_pct', case when v_budget > 0 then round(v_mtd / v_budget * 100, 1) end,
    'projected_budget_pct', case when v_budget > 0 then round(v_mtd / extract(day from v_today) * v_mdays / v_budget * 100, 1) end));
end;
$$;
revoke execute on function public.ai_usage_summary(date, date) from public, anon;
grant  execute on function public.ai_usage_summary(date, date) to authenticated;
