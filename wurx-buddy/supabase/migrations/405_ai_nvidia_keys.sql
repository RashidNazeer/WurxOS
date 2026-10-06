-- ============================================================
-- 405 — Wurx Buddy: NVIDIA's API catalog as two more model keys (Owner,
-- 2026-10-01). 402 is Engineer 2's.
--
--   ai_key_slots     nvidia  (NVIDIA_API_KEY), nvidia2 (NVIDIA_API_KEY_2): OpenAI-compatible
--                    Chat Completions at integrate.api.nvidia.com. NVIDIA's free keys are
--                    for prototyping / testing only: labelled "(dev/test only)".
--                    Order: OpenAI keys, NVIDIA, Gemini, Groq.
--   ai_model_catalog / the config checks: the two new slots allowed.
-- No config row is changed here: dev's chain is set by scripts/dev-chain-nvidia.mjs
-- (production keeps its own). Idempotent.
-- ============================================================

insert into public.ai_key_slots (slot, provider, api, label, secret_name, free, sort) values
  ('nvidia',  'NVIDIA', 'openai-chat', 'NVIDIA (dev/test only)',         'NVIDIA_API_KEY',   true, 3),
  ('nvidia2', 'NVIDIA', 'openai-chat', 'NVIDIA (key 2) (dev/test only)', 'NVIDIA_API_KEY_2', true, 4)
on conflict (slot) do update set provider = excluded.provider, api = excluded.api, label = excluded.label,
  secret_name = excluded.secret_name, free = excluded.free, sort = excluded.sort;
update public.ai_key_slots set sort = 5 where slot = 'gemini';
update public.ai_key_slots set sort = 6 where slot = 'groq';

alter table public.ai_model_catalog drop constraint if exists ai_model_catalog_key_slot_check;
alter table public.ai_model_catalog add constraint ai_model_catalog_key_slot_check
  check (key_slot in ('primary', 'fallback', 'groq', 'gemini', 'nvidia', 'nvidia2'));

-- One {key_slot, model} entry: a valid slot and a model name.
create or replace function public.ai_model_entry_ok(e jsonb) returns boolean
language sql immutable as $$
  select jsonb_typeof(e) = 'object'
     and coalesce(e->>'key_slot', 'primary') in ('primary', 'fallback', 'groq', 'gemini', 'nvidia', 'nvidia2')
     and coalesce(e->>'model', '') <> '';
$$;

create or replace function public.ai_trg_config_model_check() returns trigger
language plpgsql set search_path = public as $$
declare e jsonb; r text; v jsonb;
begin
  if new.model_key_slot not in ('primary', 'fallback', 'groq', 'gemini', 'nvidia', 'nvidia2') then
    raise exception 'model_key_slot must be primary, fallback, groq, gemini, nvidia or nvidia2';
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
        raise exception 'each fallback must be {"key_slot": "primary"|"fallback"|"groq"|"gemini"|"nvidia"|"nvidia2", "model": "<name>"}';
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
            raise exception 'role_models.%.fallback_models: each must be {"key_slot": "primary"|"fallback"|"groq"|"gemini"|"nvidia"|"nvidia2", "model": "<name>"}', r;
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
