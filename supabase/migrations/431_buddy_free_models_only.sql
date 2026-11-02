-- 431: Buddy answers with FREE models only (Owner, 2026-11-02).
--
-- The paid OpenAI key (slot 'primary', gpt-5.4-nano) had no credits: every
-- question tried it first, failed with HTTP 429 and only then reached a free
-- model. The chat side no longer has a paid key.
--
--   key slots     'primary' is gone. 'fallback' stays and is relabelled
--                 "OpenAI (free tier)": it may only ever be asked for models the
--                 catalog marks free (today: gpt-6-luna), so nothing can bill.
--   catalog       primary rows deleted; fallback keeps only gpt-6-luna (free).
--   config        model / key slot / fallbacks / role models move to the free
--                 chain below, but ONLY while the row still points at the old
--                 paid path (a Boss's later free-only choices are never touched).
--   triggers      the model check rejects the removed slot, a slot-less
--                 role entry (it used to mean 'primary'), and paid models on the
--                 free-tier key.
--
-- The chain (wurx-buddy/model-benchmark.md; real calls through Buddy's own prompt
-- and tools, 2026-11-02): the fastest Gemini first, a second Gemini (its own quota
-- bucket), then other providers so one provider's outage or rate limit never takes
-- Buddy down. gemini-3.6-flash is careful but capped at 20 requests a DAY on the
-- free tier, so it comes last. NVIDIA keys are for testing only per NVIDIA's
-- terms: they are not in the chain, only the last step of the automatic safety
-- net, and never see people / pay data.
--
-- role_models is cleared: ol -> Groq gpt-oss-120b cannot carry a whole role (its
-- free tier is 8,000 tokens a minute) and tl -> gemini-3.5-flash-lite is the
-- global main model anyway.
--
-- Idempotent. Apply with `supabase db push --include-all`.

-- ── key slots ─────────────────────────────────────────────────────────────
delete from public.ai_key_slots where slot = 'primary';
update public.ai_key_slots set label = 'OpenAI (free tier)', free = true where slot = 'fallback';

-- ── catalog ───────────────────────────────────────────────────────────────
delete from public.ai_model_catalog where key_slot = 'primary';
delete from public.ai_model_catalog where key_slot = 'fallback' and model <> 'gpt-6-luna';
update public.ai_model_catalog set free = true where key_slot = 'fallback' and model = 'gpt-6-luna';
alter table public.ai_model_catalog drop constraint if exists ai_model_catalog_key_slot_check;
alter table public.ai_model_catalog add constraint ai_model_catalog_key_slot_check
  check (key_slot in ('fallback', 'groq', 'gemini', 'nvidia', 'nvidia2'));

-- ── checks ────────────────────────────────────────────────────────────────
-- An entry needs an explicit, existing slot (no more silent 'primary').
create or replace function public.ai_model_entry_ok(e jsonb) returns boolean
language sql immutable as $$
  select jsonb_typeof(e) = 'object'
     and coalesce(e->>'key_slot', '') in ('fallback', 'groq', 'gemini', 'nvidia', 'nvidia2')
     and coalesce(e->>'model', '') <> ''
     and (e->>'key_slot' <> 'fallback' or e->>'model' = 'gpt-6-luna');
$$;

-- Mirrors agent/models.ts modelUsable: the free-tier OpenAI key allows the free
-- model alone; a catalogued slot must list the model with tools + streaming; a
-- slot the refresh has not listed yet is tried anyway.
create or replace function public.ai_model_usable(p_slot text, p_model text) returns boolean
language sql stable security definer set search_path = public as $$
  select case
    when p_slot not in ('fallback', 'groq', 'gemini', 'nvidia', 'nvidia2') then false
    when p_slot = 'fallback' and p_model <> 'gpt-6-luna' then false
    when exists (select 1 from public.ai_model_catalog c where c.key_slot = p_slot)
      then exists (select 1 from public.ai_model_catalog c
                    where c.key_slot = p_slot and c.model = p_model
                      and c.available and c.supports_tools and c.supports_stream
                      and (p_slot <> 'fallback' or c.free))
    else true
  end;
$$;
revoke execute on function public.ai_model_usable(text, text) from public, anon;
grant  execute on function public.ai_model_usable(text, text) to authenticated, service_role;

create or replace function public.ai_trg_config_model_check() returns trigger
language plpgsql set search_path = public as $$
declare e jsonb; r text; v jsonb;
begin
  if new.model_key_slot not in ('fallback', 'groq', 'gemini', 'nvidia', 'nvidia2') then
    raise exception 'model_key_slot must be gemini, groq, fallback (OpenAI free tier), nvidia or nvidia2: Buddy uses free models only';
  end if;
  if (tg_op = 'INSERT' or new.model is distinct from old.model or new.model_key_slot is distinct from old.model_key_slot)
     and not public.ai_model_usable(new.model_key_slot, new.model) then
    raise exception 'model % is not usable on the % key (refresh the model list, or pick one that supports tools and streaming; the OpenAI key is free-tier only)', new.model, new.model_key_slot;
  end if;
  if tg_op = 'INSERT' or new.fallback_models is distinct from old.fallback_models then
    if jsonb_typeof(new.fallback_models) <> 'array' or jsonb_array_length(new.fallback_models) > 6 then
      raise exception 'fallback_models must be an array of at most 6 {key_slot, model}';
    end if;
    for e in select * from jsonb_array_elements(new.fallback_models) loop
      if not public.ai_model_entry_ok(e) then
        raise exception 'each fallback must be {"key_slot": "gemini"|"groq"|"fallback"|"nvidia"|"nvidia2", "model": "<name>"}; the "fallback" key allows gpt-6-luna only';
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
        if not public.ai_model_entry_ok(v) or not public.ai_model_usable(v->>'key_slot', v->>'model') then
          raise exception 'role_models.%: model % is not usable on the % key', r, v->>'model', v->>'key_slot';
        end if;
      end if;
      if v ? 'fallback_models' then
        if jsonb_typeof(v->'fallback_models') <> 'array' or jsonb_array_length(v->'fallback_models') > 6 then
          raise exception 'role_models.%.fallback_models must be an array of at most 6 {key_slot, model}', r;
        end if;
        for e in select * from jsonb_array_elements(v->'fallback_models') loop
          if not public.ai_model_entry_ok(e) then
            raise exception 'role_models.%.fallback_models: each must be {"key_slot": "gemini"|"groq"|"fallback"|"nvidia"|"nvidia2", "model": "<name>"}', r;
          end if;
        end loop;
      end if;
    end loop;
  end if;
  return new;
end;
$$;
revoke execute on function public.ai_trg_config_model_check() from public, anon, authenticated;

-- ── the config row ────────────────────────────────────────────────────────
-- The trigger is switched off for this one update: it is the rewrite that makes
-- the row valid, and a dev database may not have a catalog yet.
alter table public.ai_assistant_config disable trigger ai_assistant_config_model_check;

update public.ai_assistant_config set
  provider        = 'free',
  model           = 'gemini-3.5-flash-lite',
  model_key_slot  = 'gemini',
  fallback_models = '[{"key_slot": "gemini", "model": "gemini-3-flash-preview"},
                      {"key_slot": "groq", "model": "openai/gpt-oss-120b"},
                      {"key_slot": "fallback", "model": "gpt-6-luna"},
                      {"key_slot": "gemini", "model": "gemini-flash-lite-latest"},
                      {"key_slot": "gemini", "model": "gemini-3.6-flash"}]'::jsonb,
  fallback_enabled = true,
  auto_failover    = true,
  role_models      = '{}'::jsonb,
  prices           = coalesce(prices, '{}'::jsonb) - 'gpt-5.5' - 'gpt-5.4-mini' - 'gpt-5.4-nano',
  budget_saver_pct = null
where id = 1
  and (model_key_slot = 'primary'
       or model ~* '^gpt-5'
       or provider = 'openai'
       or exists (select 1 from jsonb_array_elements(coalesce(fallback_models, '[]'::jsonb)) f
                   where f->>'key_slot' = 'primary' or (f->>'key_slot' = 'fallback' and f->>'model' <> 'gpt-6-luna')));

-- A Boss's own free-only config is kept, but any leftover paid entry in it goes (order kept).
update public.ai_assistant_config set
  fallback_models = coalesce((select jsonb_agg(f.v order by f.n) from jsonb_array_elements(fallback_models) with ordinality as f(v, n)
                               where f.v->>'key_slot' in ('gemini', 'groq', 'nvidia', 'nvidia2')
                                  or (f.v->>'key_slot' = 'fallback' and f.v->>'model' = 'gpt-6-luna')), '[]'::jsonb)
where id = 1 and exists (select 1 from jsonb_array_elements(coalesce(fallback_models, '[]'::jsonb)) f
                          where coalesce(f->>'key_slot', 'primary') = 'primary' or (f->>'key_slot' = 'fallback' and f->>'model' <> 'gpt-6-luna'));

update public.ai_assistant_config set role_models = '{}'::jsonb
where id = 1 and exists (select 1 from jsonb_each(coalesce(role_models, '{}'::jsonb)) r
                          where r.value ? 'model' and coalesce(r.value->>'key_slot', 'primary') in ('primary')
                             or (r.value->>'key_slot' = 'fallback' and r.value->>'model' <> 'gpt-6-luna'));

alter table public.ai_assistant_config enable trigger ai_assistant_config_model_check;
