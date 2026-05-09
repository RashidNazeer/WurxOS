-- ============================================================
-- WurxOS v2 — Migration 032: Performance
--
-- Adds:
--   * performance_ratings (user_id × month) with 6 metrics
--   * performance_flags (green/red achievements/issues)
--   * performance_warnings (formal warnings; 3 → termination risk)
-- ============================================================

create table if not exists public.performance_ratings (
  id                uuid primary key default gen_random_uuid(),
  user_id           uuid not null references public.profiles(id) on delete cascade,
  month             text not null,       -- "YYYY-MM"
  metrics           jsonb not null default '{}'::jsonb,
  overall_score     numeric generated always as (
    (
      coalesce((metrics ->> 'dailyTasksQuality')::numeric, 0) +
      coalesce((metrics ->> 'reporting')::numeric, 0) +
      coalesce((metrics ->> 'punctuality')::numeric, 0) +
      coalesce((metrics ->> 'overallWorkflow')::numeric, 0) +
      coalesce((metrics ->> 'responseTime')::numeric, 0) +
      coalesce((metrics ->> 'tasksProcessing')::numeric, 0)
    ) / 6.0
  ) stored,
  evaluated_by      uuid references public.profiles(id) on delete set null,
  updated_at        timestamptz not null default now(),
  unique (user_id, month)
);

create index if not exists perf_ratings_user_month_idx on public.performance_ratings(user_id, month desc);

create table if not exists public.performance_flags (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references public.profiles(id) on delete cascade,
  type       text not null check (type in ('green','red')),
  severity   text not null default 'low' check (severity in ('low','medium','high','critical')),
  reason     text not null,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now()
);

create index if not exists perf_flags_user_idx on public.performance_flags(user_id, created_at desc);

create table if not exists public.performance_warnings (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references public.profiles(id) on delete cascade,
  reason     text not null,
  severity   text not null default 'medium' check (severity in ('low','medium','high','critical')),
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now()
);

create index if not exists perf_warnings_user_idx on public.performance_warnings(user_id, created_at desc);

-- RLS: self-read; Boss/OL/Developer full access; TL/PCTL read+write for direct reports.
alter table public.performance_ratings  enable row level security;
alter table public.performance_flags    enable row level security;
alter table public.performance_warnings enable row level security;

create or replace function public.can_eval_perf(p_target uuid, p_actor uuid)
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select
    public.is_boss(p_actor)
    or exists (select 1 from public.profiles p where p.id = p_actor and p.role in ('ol','developer') and p.is_active = true)
    or exists (select 1 from public.profiles p where p.id = p_target and p.reports_to = p_actor);
$$;
grant execute on function public.can_eval_perf(uuid, uuid) to authenticated;

-- SELECT (each table): self, Boss/OL/dev, or manager-of-target
do $$
declare t text;
begin
  foreach t in array array['performance_ratings','performance_flags','performance_warnings'] loop
    execute format('drop policy if exists "%s_select" on public.%I', t, t);
    execute format($p$create policy "%s_select" on public.%I for select using (
      auth.uid() = user_id
      or public.is_boss(auth.uid())
      or exists (select 1 from public.profiles p where p.id = auth.uid() and p.role in ('ol','developer') and p.is_active = true)
      or public.can_eval_perf(user_id, auth.uid())
    )$p$, t, t);
  end loop;
end;
$$;

-- INSERT/UPDATE/DELETE: can_eval_perf(target, actor)
do $$
declare t text;
begin
  foreach t in array array['performance_ratings','performance_flags','performance_warnings'] loop
    execute format('drop policy if exists "%s_write" on public.%I', t, t);
    execute format($p$create policy "%s_write" on public.%I for all using (public.can_eval_perf(user_id, auth.uid())) with check (public.can_eval_perf(user_id, auth.uid()))$p$, t, t);
  end loop;
end;
$$;
