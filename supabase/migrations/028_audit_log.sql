-- ============================================================
-- WurxOS v2 — Migration 028: Audit log
--
-- Generic log of row-level changes on key tables. Each row records:
--   actor, entity_type, entity_id, action (insert/update/delete),
--   before jsonb, after jsonb, created_at.
--
-- Tracked tables: brands, tasks, reports, leave_requests,
--                 brand_switch_requests.
--
-- RLS: Boss / OL / Developer read all; no client writes (trigger
-- inserts via SECURITY DEFINER).
-- ============================================================

create table if not exists public.audit_log (
  id           uuid primary key default gen_random_uuid(),
  actor_id     uuid references public.profiles(id) on delete set null,
  entity_type  text not null,
  entity_id    uuid,
  action       text not null check (action in ('insert','update','delete')),
  before       jsonb,
  after        jsonb,
  created_at   timestamptz not null default now()
);

create index if not exists audit_entity_idx  on public.audit_log(entity_type, entity_id, created_at desc);
create index if not exists audit_actor_idx   on public.audit_log(actor_id, created_at desc);
create index if not exists audit_created_idx on public.audit_log(created_at desc);

alter table public.audit_log enable row level security;

drop policy if exists "audit_select" on public.audit_log;
create policy "audit_select"
  on public.audit_log for select
  using (
    public.is_boss(auth.uid())
    or exists (
      select 1 from public.profiles p
      where p.id = auth.uid() and p.role in ('ol','developer') and p.is_active = true
    )
  );

drop policy if exists "audit_insert_block" on public.audit_log;
create policy "audit_insert_block"
  on public.audit_log for insert with check (false);

-- --------------------------------------------------------------
-- Generic row-change capture trigger
-- --------------------------------------------------------------
create or replace function public.audit_record()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_entity text := TG_TABLE_NAME;
  v_id uuid;
begin
  if TG_OP = 'DELETE' then
    v_id := (to_jsonb(old) ->> 'id')::uuid;
    insert into public.audit_log(actor_id, entity_type, entity_id, action, before, after)
    values (auth.uid(), v_entity, v_id, 'delete', to_jsonb(old), null);
    return old;
  elsif TG_OP = 'UPDATE' then
    v_id := (to_jsonb(new) ->> 'id')::uuid;
    insert into public.audit_log(actor_id, entity_type, entity_id, action, before, after)
    values (auth.uid(), v_entity, v_id, 'update', to_jsonb(old), to_jsonb(new));
    return new;
  else
    v_id := (to_jsonb(new) ->> 'id')::uuid;
    insert into public.audit_log(actor_id, entity_type, entity_id, action, before, after)
    values (auth.uid(), v_entity, v_id, 'insert', null, to_jsonb(new));
    return new;
  end if;
end;
$$;

-- Attach to key tables
do $$
declare
  t text;
begin
  foreach t in array array['brands','tasks','reports','leave_requests','brand_switch_requests'] loop
    execute format('drop trigger if exists %I_audit on public.%I', t, t);
    execute format(
      'create trigger %I_audit after insert or update or delete on public.%I
         for each row execute function public.audit_record()',
      t, t
    );
  end loop;
end;
$$;
