-- ============================================================
-- WurxOS v2 — Migration 435: audit log for the Claude connector (edge function `mcp`).
--
-- One row per tool call made through the connector: who, which tool, with what arguments, ok or not.
-- Written only by the function (service role). Only the Boss can read it. It also backs the
-- 30-calls-a-minute limit. Idempotent.
-- ============================================================

create table if not exists public.mcp_call_log (
  id         bigint generated always as identity primary key,
  user_id    uuid not null references public.profiles(id) on delete cascade,
  role       text not null,
  tool       text not null,
  args       text,
  ok         boolean not null default true,
  ms         integer,
  created_at timestamptz not null default now()
);

create index if not exists mcp_call_log_user_time_idx on public.mcp_call_log (user_id, created_at desc);

alter table public.mcp_call_log enable row level security;

drop policy if exists mcp_call_log_boss_select on public.mcp_call_log;
create policy mcp_call_log_boss_select on public.mcp_call_log
  for select to authenticated using (public.is_boss(auth.uid()));
-- No insert/update/delete policy: clients cannot write; the function uses the service role.

do $verify$
begin
  if not exists (select 1 from pg_policies where tablename = 'mcp_call_log' and policyname = 'mcp_call_log_boss_select') then
    raise exception 'mig 435: boss read policy missing';
  end if;
  if not (select relrowsecurity from pg_class where oid = 'public.mcp_call_log'::regclass) then
    raise exception 'mig 435: RLS is off on mcp_call_log';
  end if;
end;
$verify$;
