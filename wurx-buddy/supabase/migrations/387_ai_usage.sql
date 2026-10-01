-- ============================================================
-- 387 — Wurx Buddy: API usage and spend for the Boss.
--
-- Where OpenAI spend is recorded:
--   chat model calls     ai_request_log (tokens in / cached / out, est_cost_usd), one row per question
--   rerank calls         ai_usage_log kind 'rerank'       one row per question that reranked
--   query embeddings     ai_usage_log kind 'embed_query'  one row per question that embedded
--   ingestion embeddings ai_ingest_runs.embed_tokens (the ai-ingest worker and scripts/ingest.mjs
--                        both record there; the TikTok crawl embeds nothing itself)
--   rate-limited asks    ai_usage_log kind 'rate_limited' (no tokens; counted only)
--
--   ai_assistant_config.prices   USD per 1M tokens per model: {model: {in, cached, out}}.
--                        The one place prices live: the function reads it for
--                        est_cost_usd, this summary for ingestion tokens.
--                        ASSUMED values (verify against OpenAI's list); the Boss can edit them.
--   ai_request_log.surface   quick | full | slack
--   ai_usage_summary(from, to)  Boss-only jsonb (PKT dates), incl. month to date,
--                        a naive month-end projection and % of monthly_budget_usd
--                        (report only: nothing is ever blocked on it).
-- Idempotent.
-- ============================================================

alter table public.ai_request_log add column if not exists surface text;

alter table public.ai_assistant_config
  add column if not exists prices jsonb not null default '{
    "gpt-5.4-mini":           {"in": 0.75, "cached": 0.075, "out": 4.5},
    "gpt-5.5":                {"in": 5,    "cached": 0.5,   "out": 30},
    "text-embedding-3-small": {"in": 0.02, "cached": 0.02,  "out": 0}
  }'::jsonb;

create table if not exists public.ai_usage_log (
  id            bigserial primary key,
  created_at    timestamptz not null default now(),
  kind          text not null check (kind in ('rerank', 'embed_query', 'rate_limited')),
  model         text,
  user_id       uuid references public.profiles(id) on delete set null,
  request_id    uuid,
  calls         int not null default 1,
  tokens_in     int not null default 0,
  tokens_cached int not null default 0,
  tokens_out    int not null default 0,
  est_cost_usd  numeric(12,6) not null default 0
);
create index if not exists ai_usage_log_created_idx on public.ai_usage_log (created_at desc);
alter table public.ai_usage_log enable row level security;
-- No policies: written by the function (service role), read through ai_usage_summary.
revoke all on public.ai_usage_log from anon, authenticated;

-- ai_turn_begin (mig 386) + a 'rate_limited' row, so refusals can be counted.
create or replace function public.ai_turn_begin(p_request_id uuid, p_user_id uuid, p_question text,
                                                p_model text, p_limit int default 30)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare n int;
begin
  perform pg_advisory_xact_lock(hashtext('ai_turn_begin'), hashtext(p_user_id::text));
  if p_limit is not null then
    select count(*) into n from public.ai_request_log
     where user_id = p_user_id and created_at > now() - interval '1 hour';
    if n >= p_limit then
      insert into public.ai_usage_log (kind, user_id, request_id, calls) values ('rate_limited', p_user_id, p_request_id, 1);
      return 'rate_limited';
    end if;
  end if;
  insert into public.ai_request_log (id, user_id, engine, provider, model, question)
  values (p_request_id, p_user_id, 'v2', 'openai', p_model, left(p_question, 4000));
  return 'ok';
end;
$$;
revoke execute on function public.ai_turn_begin(uuid, uuid, text, text, int) from public, anon, authenticated;
grant  execute on function public.ai_turn_begin(uuid, uuid, text, text, int) to service_role;

-- ── the summary ─────────────────────────────────────────────────────────
-- Dates are PKT calendar days, both ends included.
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

  -- Month to date (PKT), whatever the range asked for, and a straight-line projection.
  select coalesce(sum(x), 0) into v_mtd from (
    select est_cost_usd::numeric x from public.ai_request_log where (created_at at time zone 'Asia/Karachi')::date >= v_mstart
    union all
    select est_cost_usd::numeric from public.ai_usage_log where (created_at at time zone 'Asia/Karachi')::date >= v_mstart
    union all
    select embed_tokens * coalesce((v_prices->v_embed->>'in')::numeric, 0) / 1e6 from public.ai_ingest_runs
     where coalesce(embed_tokens, 0) > 0 and (started_at at time zone 'Asia/Karachi')::date >= v_mstart
  ) t;

  return v_out || jsonb_build_object('month_to_date', jsonb_build_object(
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
