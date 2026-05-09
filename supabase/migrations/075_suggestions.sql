-- ============================================================
-- Migration 075 — Suggestions
--
-- Ideas / feature requests / improvements from any team member.
-- Developers triage (status + internal notes); everyone can upvote
-- once per suggestion. Separate from bug_reports because the
-- lifecycle is different (bugs get fixed; suggestions are
-- planned or rejected, often aggregated by popularity).
--
-- State machine:
--   new → in_review → planned → implemented
--              └──→ rejected
-- ============================================================

create table if not exists public.suggestions (
  id               uuid primary key default gen_random_uuid(),
  category         text not null
                     check (category in ('feature','improvement','bug_fix','ui_ux','other')),
  title            text not null,
  description      text not null,
  status           text not null default 'new'
                     check (status in ('new','in_review','planned','implemented','rejected')),
  submitted_by     uuid not null references public.profiles(id) on delete cascade,
  submitted_by_name text,
  submitted_by_role text,
  dev_notes        text,
  reviewed_by      uuid references public.profiles(id) on delete set null,
  reviewed_by_name text,
  -- Denormalized upvote count, kept in sync by a trigger on
  -- suggestion_upvotes. Cheaper than counting on every list render.
  upvote_count     int not null default 0,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

create index if not exists suggestions_status_idx      on public.suggestions(status);
create index if not exists suggestions_submitted_idx   on public.suggestions(submitted_by, created_at desc);
create index if not exists suggestions_created_idx     on public.suggestions(created_at desc);

drop trigger if exists suggestions_touch on public.suggestions;
create trigger suggestions_touch before update on public.suggestions
  for each row execute function public.touch_updated_at();

-- --------------------------------------------------------------
-- suggestion_upvotes — one row per (user, suggestion). PK enforces
-- the "one upvote per user" rule that v1 managed via an array.
-- --------------------------------------------------------------
create table if not exists public.suggestion_upvotes (
  suggestion_id uuid not null references public.suggestions(id) on delete cascade,
  user_id       uuid not null references public.profiles(id)    on delete cascade,
  created_at    timestamptz not null default now(),
  primary key (suggestion_id, user_id)
);

create or replace function public.suggestion_upvote_touch()
returns trigger language plpgsql as $$
begin
  if tg_op = 'INSERT' then
    update public.suggestions set upvote_count = upvote_count + 1 where id = new.suggestion_id;
  elsif tg_op = 'DELETE' then
    update public.suggestions set upvote_count = greatest(0, upvote_count - 1) where id = old.suggestion_id;
  end if;
  return coalesce(new, old);
end;
$$;

drop trigger if exists suggestion_upvote_touch_ins on public.suggestion_upvotes;
create trigger suggestion_upvote_touch_ins after insert on public.suggestion_upvotes
  for each row execute function public.suggestion_upvote_touch();

drop trigger if exists suggestion_upvote_touch_del on public.suggestion_upvotes;
create trigger suggestion_upvote_touch_del after delete on public.suggestion_upvotes
  for each row execute function public.suggestion_upvote_touch();

-- --------------------------------------------------------------
-- RLS
--   SELECT  — everyone authenticated (it's a public idea board)
--   INSERT  — anyone; submitted_by must be auth.uid()
--   UPDATE  — author (if still 'new'), Developer (anything), Boss (anything)
--   DELETE  — author or Developer or Boss
-- --------------------------------------------------------------
alter table public.suggestions enable row level security;

drop policy if exists "sug_select" on public.suggestions;
create policy "sug_select" on public.suggestions for select
  using (auth.uid() is not null);

drop policy if exists "sug_insert" on public.suggestions;
create policy "sug_insert" on public.suggestions for insert
  with check (submitted_by = auth.uid());

drop policy if exists "sug_update" on public.suggestions;
create policy "sug_update" on public.suggestions for update
  using (
    (submitted_by = auth.uid() and status = 'new')
    or public.is_boss(auth.uid())
    or exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'developer' and p.is_active = true)
  );

drop policy if exists "sug_delete" on public.suggestions;
create policy "sug_delete" on public.suggestions for delete
  using (
    submitted_by = auth.uid()
    or public.is_boss(auth.uid())
    or exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'developer' and p.is_active = true)
  );

-- Upvotes: only the acting user can add/remove their own row.
alter table public.suggestion_upvotes enable row level security;

drop policy if exists "sug_vote_select" on public.suggestion_upvotes;
create policy "sug_vote_select" on public.suggestion_upvotes for select
  using (auth.uid() is not null);

drop policy if exists "sug_vote_insert" on public.suggestion_upvotes;
create policy "sug_vote_insert" on public.suggestion_upvotes for insert
  with check (user_id = auth.uid());

drop policy if exists "sug_vote_delete" on public.suggestion_upvotes;
create policy "sug_vote_delete" on public.suggestion_upvotes for delete
  using (user_id = auth.uid());

-- --------------------------------------------------------------
-- Notification trigger: status change notifies the submitter.
-- --------------------------------------------------------------
create or replace function public.suggestions_notify_status()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_label text := case new.status
    when 'new'         then 'New'
    when 'in_review'   then 'In Review'
    when 'planned'     then 'Planned'
    when 'implemented' then 'Implemented'
    when 'rejected'    then 'Rejected'
    else new.status
  end;
  v_actor uuid := coalesce(new.reviewed_by, auth.uid());
  v_tail text := '';
begin
  if new.status = old.status then return new; end if;
  if coalesce(new.dev_notes,'') <> '' then
    v_tail := ' · ' || left(new.dev_notes, 80);
  end if;
  perform public.emit_notification(
    new.submitted_by, v_actor, 'suggestion', 'suggestion.status_changed',
    'Your suggestion: ' || v_label,
    '"' || new.title || '" — ' || v_label || v_tail,
    'suggestion', new.id, '/suggestions'
  );
  return new;
end;
$$;

drop trigger if exists suggestions_notify_status on public.suggestions;
create trigger suggestions_notify_status
  after update of status on public.suggestions
  for each row execute function public.suggestions_notify_status();
