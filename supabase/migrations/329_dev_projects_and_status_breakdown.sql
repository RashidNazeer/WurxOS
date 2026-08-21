-- ============================================================
-- WurxOS v2 — Migration 329: projects for dev work, and a per-status
-- breakdown on the pipeline card.
--
-- ── A. Projects
-- Development spans several products (WurxOS, WurxMediaHub, Wurx Ads
-- Reporting, ...). The Boss needs to see WHICH product the developer is on
-- without opening every task. A project is that product, not an arbitrary
-- grouping — the third level rejected during design was a grouping invented
-- per task, which is a different and worse idea.
--
-- Nullable on purpose: a task never has to belong to a project, so quick jobs
-- are not blocked on categorising them.
--
-- ── B. Status breakdown
-- The card previously showed only the PARENT's status plus a progress bar, so
-- a pipeline sat at "Pending" while a subtask inside it was in progress. The
-- Boss's actual question is "what is coming, what is moving, what is stuck",
-- which needs the counts per status, so the view now returns them as one jsonb
-- and the card renders a strip from it. Counting client-side would have meant
-- fetching every subtask of every task just to draw the list.
--
-- Idempotent.
-- ============================================================

create table if not exists public.dev_projects (
  id          uuid primary key default gen_random_uuid(),
  name        text not null unique check (length(trim(name)) between 1 and 80),
  description text,
  -- Deliberately a plain token, not a hex value: the UI maps it to a theme
  -- variable so project colours stay correct in dark mode.
  colour      text not null default 'slate'
                check (colour in ('slate','blue','green','amber','violet','rose','teal')),
  is_active   boolean not null default true,
  created_by  uuid references public.profiles(id) on delete set null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

alter table public.dev_tasks
  add column if not exists project_id uuid references public.dev_projects(id) on delete set null;

create index if not exists dev_tasks_project_idx on public.dev_tasks (project_id)
  where project_id is not null;

drop trigger if exists dev_projects_touch on public.dev_projects;
create trigger dev_projects_touch before update on public.dev_projects
  for each row execute function public.dev_touch_updated_at();

alter table public.dev_projects enable row level security;

drop policy if exists dev_projects_select on public.dev_projects;
create policy dev_projects_select on public.dev_projects for select
  using (public.dev_tasks_can_view(auth.uid()));

-- Boss AND developer may add projects, as requested. An OL can see them but
-- does not define what the products are.
drop policy if exists dev_projects_write on public.dev_projects;
create policy dev_projects_write on public.dev_projects for all
  using (public.dev_tasks_can_edit(auth.uid()))
  with check (public.dev_tasks_can_edit(auth.uid()));

revoke all on public.dev_projects from anon;
grant select, insert, update, delete on public.dev_projects to authenticated;

-- ── The view, now carrying the project and the status breakdown ──────
drop view if exists public.dev_tasks_with_progress;
create view public.dev_tasks_with_progress as
select
  t.*,
  p.name   as project_name,
  p.colour as project_colour,
  coalesce(s.total, 0)   as subtask_total,
  coalesce(s.done, 0)    as subtask_done,
  coalesce(s.counted, 0) as subtask_counted,
  case when coalesce(s.counted, 0) = 0 then null
       else round(100.0 * s.done / s.counted)::int end as progress_pct,
  -- {"pending":2,"in_progress":1,...} — only statuses actually present, so the
  -- card can render a strip without drawing six empty chips.
  coalesce(s.status_counts, '{}'::jsonb) as status_counts,
  (t.due_date is not null
     and t.due_date < (now() at time zone 'Asia/Karachi')::date
     and t.status not in ('done','cancelled'))          as is_overdue
from public.dev_tasks t
left join public.dev_projects p on p.id = t.project_id
left join lateral (
  -- NOTE: the inner query is already one row PER STATUS, so these must SUM n.
  -- count(*) here would count distinct statuses, not subtasks, and a task with
  -- three pending subtasks would report a total of 1.
  select coalesce(sum(n), 0)                                    as total,
         coalesce(sum(n) filter (where status = 'done'), 0)     as done,
         coalesce(sum(n) filter (where status <> 'cancelled'), 0) as counted,
         jsonb_object_agg(status, n)                            as status_counts
  from (
    select status, count(*) as n
    from public.dev_subtasks d where d.task_id = t.id
    group by status
  ) g
) s on true;

grant select on public.dev_tasks_with_progress to authenticated;
