-- ============================================================
-- 401 — Wurx Buddy: free Groq / Gemini keys, "never down" failover, and
-- Buddy's settings for developers (Owner, 2026-10-01).
--
-- Numbered 401: dev already has 399 (fix_snooze_refire) and 400
-- (planner_default_row) from the app side.
--
--   ai_key_slots       the model keys: primary / fallback (OpenAI, Responses API),
--                      groq / gemini (free tiers, OpenAI-compatible Chat
--                      Completions). Labels for the settings screen.
--   ai_model_catalog   + key slots groq and gemini; + reason: why a listed model
--                      cannot be used ("not a chat model", "no quota on this
--                      key", ...). Every model a key lists is stored.
--   ai_assistant_config
--     auto_failover    after the Boss's chain, try every other usable model
--     fallback_models  default chain: Gemini flash, Groq gpt-oss-120b, Groq
--                      qwen, gpt-6-luna; at most 6. Dev's row takes it only if
--                      it still has the old one-entry default.
--     allowed_roles    always keeps boss and developer (trigger); default
--                      {boss,developer}; dev's row backfilled.
--   ai_can_view_settings(uid)  Boss or an active developer: read access to
--                      everything the Buddy settings screen reads (catalog,
--                      usage summary, ingest stats / queue / runs, exclusions,
--                      crawl state, key slots). Writes stay Boss-only.
-- Idempotent.
-- ============================================================

-- ── who may see Buddy's settings ─────────────────────────────────────────
create or replace function public.ai_can_view_settings(uid uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select public.is_boss(uid)
      or exists (select 1 from public.profiles p
                  where p.id = uid and p.role = 'developer' and p.is_active and p.deleted_at is null);
$$;
revoke execute on function public.ai_can_view_settings(uuid) from public, anon;
grant  execute on function public.ai_can_view_settings(uuid) to authenticated, service_role;

-- ── key slots ────────────────────────────────────────────────────────────
create table if not exists public.ai_key_slots (
  slot        text primary key,
  provider    text not null,
  api         text not null check (api in ('openai-responses', 'openai-chat')),
  label       text not null,
  secret_name text not null,             -- the function secret that holds the key (never the key)
  free        boolean not null default false,
  sort        int not null default 0
);
insert into public.ai_key_slots (slot, provider, api, label, secret_name, free, sort) values
  ('primary',  'OpenAI', 'openai-responses', 'OpenAI',                'OPEN_AI_API_KEY',          false, 1),
  ('fallback', 'OpenAI', 'openai-responses', 'OpenAI (fallback key)', 'OPEN_AI_API_KEY_FALLBACK', false, 2),
  ('gemini',   'Google', 'openai-chat',      'Gemini (free)',         'GEMINI_API_KEY',           true,  3),
  ('groq',     'Groq',   'openai-chat',      'Groq (free)',           'GROQ_API_KEY',             true,  4)
on conflict (slot) do update set provider = excluded.provider, api = excluded.api, label = excluded.label,
  secret_name = excluded.secret_name, free = excluded.free, sort = excluded.sort;
alter table public.ai_key_slots enable row level security;
drop policy if exists "ai_key_slots_read" on public.ai_key_slots;
create policy "ai_key_slots_read" on public.ai_key_slots for select using (public.ai_can_view_settings(auth.uid()));
revoke all on public.ai_key_slots from anon;
revoke insert, update, delete, truncate, references, trigger on public.ai_key_slots from authenticated;
grant select on public.ai_key_slots to authenticated;

-- ── catalog: four key slots, a reason per unusable model ─────────────────
alter table public.ai_model_catalog drop constraint if exists ai_model_catalog_key_slot_check;
alter table public.ai_model_catalog add constraint ai_model_catalog_key_slot_check
  check (key_slot in ('primary', 'fallback', 'groq', 'gemini'));
alter table public.ai_model_catalog add column if not exists reason text;
drop policy if exists "ai_model_catalog_read" on public.ai_model_catalog;
create policy "ai_model_catalog_read" on public.ai_model_catalog for select
  using (public.ai_can_view_settings(auth.uid()));

-- ── config: the chain, failover, who may use Buddy ───────────────────────
alter table public.ai_assistant_config add column if not exists auto_failover boolean not null default true;
alter table public.ai_assistant_config alter column fallback_models set default
  '[{"key_slot": "gemini", "model": "gemini-3.5-flash"}, {"key_slot": "groq", "model": "openai/gpt-oss-120b"}, {"key_slot": "groq", "model": "qwen/qwen3.8-27b"}, {"key_slot": "fallback", "model": "gpt-6-luna"}]'::jsonb;
alter table public.ai_assistant_config alter column allowed_roles set default '{boss,developer}';

create or replace function public.ai_trg_config_model_check() returns trigger
language plpgsql set search_path = public as $$
declare e jsonb;
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
      if jsonb_typeof(e) <> 'object' or coalesce(e->>'key_slot', '') not in ('primary', 'fallback', 'groq', 'gemini') or coalesce(e->>'model', '') = '' then
        raise exception 'each fallback must be {"key_slot": "primary"|"fallback"|"groq"|"gemini", "model": "<name>"}';
      end if;
    end loop;
  end if;
  return new;
end;
$$;
revoke execute on function public.ai_trg_config_model_check() from public, anon, authenticated;

-- Buddy is ALWAYS available to the Boss and to developers: whatever is saved,
-- the list keeps them (first), then the other roles in their saved order.
create or replace function public.ai_trg_config_roles() returns trigger
language plpgsql set search_path = public as $$
begin
  new.allowed_roles := array['boss', 'developer']
    || coalesce(array(select r from unnest(coalesce(new.allowed_roles, '{}')) with ordinality u(r, i)
                       where r not in ('boss', 'developer') order by i), '{}');
  return new;
end;
$$;
revoke execute on function public.ai_trg_config_roles() from public, anon, authenticated;
drop trigger if exists ai_assistant_config_roles on public.ai_assistant_config;
create trigger ai_assistant_config_roles
  before insert or update of allowed_roles on public.ai_assistant_config
  for each row execute function public.ai_trg_config_roles();

update public.ai_assistant_config set allowed_roles = allowed_roles
 where not (allowed_roles @> '{boss,developer}');
update public.ai_assistant_config
   set fallback_models = '[{"key_slot": "gemini", "model": "gemini-3.5-flash"}, {"key_slot": "groq", "model": "openai/gpt-oss-120b"}, {"key_slot": "groq", "model": "qwen/qwen3.8-27b"}, {"key_slot": "fallback", "model": "gpt-6-luna"}]'::jsonb
 where fallback_models = '[{"key_slot": "fallback", "model": "gpt-6-luna"}]'::jsonb;

-- ── settings: read for the Boss and active developers ────────────────────
-- Extra SELECT policies (permissive: OR-ed with the Boss-only ones already
-- there). Nothing here grants a write.
do $$
declare t text;
begin
  foreach t in array array['ai_ingest_queue', 'ai_ingest_runs', 'ai_crawl_state', 'ai_excluded_documents', 'tts_articles'] loop
    execute format('drop policy if exists %I on public.%I', t || '_settings_read', t);
    execute format('create policy %I on public.%I for select using (public.ai_can_view_settings((select auth.uid())))', t || '_settings_read', t);
  end loop;
end $$;

-- ── the usage summary: the Boss and developers. Otherwise as mig 397. ────
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
  if not public.ai_can_view_settings(auth.uid()) then raise exception 'not allowed: usage is for the Boss and developers'; end if;
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

-- ── ingest stats: + developers (read). Otherwise as mig 379. ─────────────
create or replace function public.ai_ingest_stats()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_last timestamptz;
begin
  if not (public.ai_is_service_or_admin() or public.ai_can_view_settings(auth.uid())) then raise exception 'not allowed'; end if;
  v_last := public.ai_last_sweep_at();
  return jsonb_build_object(
    'pipeline_version', public.ai_pipeline_version(),
    'embed_model', public.ai_embed_model(),
    'ingest_sources', to_jsonb(public.ai_source_types()),
    'ignored_sources', to_jsonb(public.ai_ignored_sources()),
    'last_sweep_at', v_last,
    'next_sweep_due_at', coalesce(v_last + interval '12 hours', now()),
    'queue', coalesce((select jsonb_object_agg(status, n) from (
                select status, count(*) as n from public.ai_ingest_queue group by status) x), '{}'::jsonb),
    'pending_by_priority', coalesce((select jsonb_object_agg(priority::text, n) from (
                select priority, count(*) as n from public.ai_ingest_queue where status = 'pending' group by priority) x), '{}'::jsonb),
    'oldest_pending_seconds', (select extract(epoch from now() - min(enqueued_at))::int
                                 from public.ai_ingest_queue where status = 'pending'),
    'stuck_processing', (select count(*) from public.ai_ingest_queue
                          where status = 'processing' and locked_at < now() - interval '10 minutes'),
    'failed', coalesce((select jsonb_agg(to_jsonb(f)) from (
                select id, source_type, source_id, op, attempts, last_error, enqueued_at
                  from public.ai_ingest_queue where status = 'failed' order by enqueued_at desc limit 50) f), '[]'::jsonb),
    'documents', coalesce((select jsonb_object_agg(source_type, jsonb_build_object(
                    'active', active, 'soft_deleted', deleted, 'chunks', chunks, 'other_pipeline', other)) from (
                select d.source_type, count(*) filter (where d.status = 'active') as active,
                       count(*) filter (where d.status = 'deleted') as deleted,
                       sum(d.chunk_count) filter (where d.status = 'active') as chunks,
                       count(*) filter (where d.pipeline_version is distinct from public.ai_pipeline_version()
                                           or d.embed_model is distinct from public.ai_embed_model()) as other
                  from public.ai_documents d group by d.source_type) x), '{}'::jsonb),
    'freshness_p95_seconds_24h', (select percentile_cont(0.95) within group (order by extract(epoch from done_at - enqueued_at))
                                    from public.ai_ingest_queue
                                   where status = 'done' and done_at > now() - interval '24 hours'),
    'runs', coalesce((select jsonb_agg(to_jsonb(r) order by r.started_at desc) from (
                select id, kind, started_at, finished_at, claimed, succeeded, failed, skipped_unchanged,
                       embedded_chunks, embed_tokens, error, stats->>'trigger' as trigger
                  from public.ai_ingest_runs order by started_at desc limit 10) r), '[]'::jsonb));
end;
$function$;
revoke execute on function public.ai_ingest_stats() from public, anon;
grant  execute on function public.ai_ingest_stats() to authenticated, service_role;
