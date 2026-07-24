-- ============================================================
-- WurxOS v2 — Migration 268: weekly checkpoint approval workflow.
--
-- Gives the Weekly Checkpoint the same submit → verify → approve chain the
-- reports have, with a reliable return path that carries a visible note:
--
--   APC submits  (draft → submitted)   → notify brand owner (TL)
--   TL verifies  (submitted → verified) → notify OLs
--   OL approves  (verified → approved)  → notify author + TL
--   return (down the chain, WITH a note): OL→TL (verified→submitted),
--          TL→APC (submitted→draft) → notify whoever now holds it
--   OL reopen (approved→verified, no note) = self-edit, NOT a return
--
-- Return notes use the SAME log-based design that reports converged on after
-- migs 203/209/214/215: an append-only checkpoint_returns log written by a
-- SECURITY DEFINER trigger the instant status moves down. The client MUST write
-- status + return_note in ONE update so the trigger snapshots the note (writing
-- the note in a later update logs an empty note — the original "no reason was
-- provided" bug). The UI reads this log in both the edit and read-only views so
-- the note is never hidden.
--
-- Safe to re-run.
-- ============================================================

-- ── 1. status enum: draft → submitted → verified → approved ───────────
alter table public.weekly_checkpoints
  drop constraint if exists weekly_checkpoints_status_check;

-- legacy 'final' (APC "mark done", pre-workflow) becomes the terminal 'approved'
update public.weekly_checkpoints set status = 'approved' where status = 'final';

alter table public.weekly_checkpoints
  add constraint weekly_checkpoints_status_check
  check (status in ('draft', 'submitted', 'verified', 'approved'));

-- ── 2. audit + return columns ─────────────────────────────────────────
alter table public.weekly_checkpoints
  add column if not exists submitted_at timestamptz,
  add column if not exists submitted_by uuid references public.profiles(id),
  add column if not exists verified_at  timestamptz,
  add column if not exists verified_by  uuid references public.profiles(id),
  add column if not exists approved_at  timestamptz,
  add column if not exists approved_by  uuid references public.profiles(id),
  add column if not exists return_note  text,
  add column if not exists returned_at  timestamptz,
  add column if not exists returned_by  uuid references public.profiles(id);

-- ── 3. append-only return log (mirrors report_returns / mig 203) ──────
create table if not exists public.checkpoint_returns (
  id            uuid primary key default gen_random_uuid(),
  checkpoint_id uuid not null references public.weekly_checkpoints(id) on delete cascade,
  returned_by   uuid references public.profiles(id) on delete set null,
  returned_at   timestamptz not null default now(),
  from_status   text,
  to_status     text,
  note          text,
  created_at    timestamptz not null default now()
);

create index if not exists checkpoint_returns_cp_idx
  on public.checkpoint_returns(checkpoint_id, returned_at desc);

alter table public.checkpoint_returns enable row level security;

-- SELECT: anyone who can view the parent checkpoint's brand.
drop policy if exists "checkpoint_returns_select" on public.checkpoint_returns;
create policy "checkpoint_returns_select"
  on public.checkpoint_returns for select
  using (exists (
    select 1 from public.weekly_checkpoints wc
    where wc.id = checkpoint_returns.checkpoint_id
      and public.checkpoint_can_view(wc.brand_id)
  ));

-- No client writes — rows come only from the SECURITY DEFINER trigger.
drop policy if exists "checkpoint_returns_no_insert" on public.checkpoint_returns;
create policy "checkpoint_returns_no_insert" on public.checkpoint_returns for insert with check (false);
drop policy if exists "checkpoint_returns_no_update" on public.checkpoint_returns;
create policy "checkpoint_returns_no_update" on public.checkpoint_returns for update using (false);

-- ── 4. trigger: log a return whenever status moves DOWN the chain ─────
create or replace function public.log_checkpoint_return()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if (
       (old.status = 'approved'  and new.status in ('verified','submitted','draft'))
    or (old.status = 'verified'  and new.status in ('submitted','draft'))
    or (old.status = 'submitted' and new.status = 'draft')
  )
  -- ...but NOT an OL self-edit reopen: approved → verified with no note is the
  -- owner reopening to edit, not a return to anyone (see reports mig 215).
  and not (
       old.status = 'approved'
   and new.status = 'verified'
   and coalesce(new.return_note, '') = ''
  ) then
    insert into public.checkpoint_returns (checkpoint_id, returned_by, returned_at, from_status, to_status, note)
    values (
      new.id,
      coalesce(new.returned_by, auth.uid()),
      coalesce(new.returned_at, now()),
      old.status,
      new.status,
      new.return_note
    );
  end if;
  return new;
end;
$$;

drop trigger if exists trg_log_checkpoint_return on public.weekly_checkpoints;
create trigger trg_log_checkpoint_return
  after update of status on public.weekly_checkpoints
  for each row execute function public.log_checkpoint_return();

-- ── 5. trigger: notifications on every status transition ──────────────
create or replace function public.checkpoint_notify_on_status()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor      uuid := auth.uid();
  v_actor_name text;
  v_brand_name text;
  v_owner      uuid;
  v_wk         text;
  v_link       text;
begin
  if old.status is not distinct from new.status then
    return new;
  end if;

  select brand_name, owner_id into v_brand_name, v_owner
  from public.brands where id = new.brand_id;

  v_actor_name := coalesce(public.profile_display_name(v_actor), 'Someone');
  v_wk   := coalesce(new.week_label, to_char(new.week_start, 'YYYY-MM-DD'));
  v_link := '/agenda/checkpoint?brand=' || new.brand_id || '&week=' || to_char(new.week_start, 'YYYY-MM-DD');

  -- APC submits (draft → submitted) → notify brand owner (TL)
  if old.status = 'draft' and new.status = 'submitted' and v_owner is not null then
    perform public.emit_notification(
      v_owner, v_actor, 'agenda', 'checkpoint.submitted',
      'Checkpoint submitted for verification',
      v_actor_name || ' submitted the weekly checkpoint for ' || v_brand_name || ' (' || v_wk || ')',
      'checkpoint', new.id, v_link);
  end if;

  -- TL verifies (submitted → verified) → notify all active OLs
  if old.status = 'submitted' and new.status = 'verified' then
    perform public.emit_notification(p.id, v_actor, 'agenda', 'checkpoint.verified',
      'Checkpoint ready for approval',
      v_actor_name || ' verified the weekly checkpoint for ' || v_brand_name || ' (' || v_wk || ')',
      'checkpoint', new.id, v_link)
    from public.profiles p
    where p.role = 'ol' and p.is_active = true;
  end if;

  -- OL approves (verified → approved) → notify author + brand owner (TL)
  if old.status = 'verified' and new.status = 'approved' then
    if new.author_id is not null then
      perform public.emit_notification(new.author_id, v_actor, 'agenda', 'checkpoint.approved',
        'Checkpoint approved',
        v_actor_name || ' approved your weekly checkpoint for ' || v_brand_name || ' (' || v_wk || ')',
        'checkpoint', new.id, v_link);
    end if;
    if v_owner is not null and v_owner is distinct from new.author_id then
      perform public.emit_notification(v_owner, v_actor, 'agenda', 'checkpoint.approved',
        'Checkpoint approved',
        v_actor_name || ' approved the weekly checkpoint for ' || v_brand_name || ' (' || v_wk || ')',
        'checkpoint', new.id, v_link);
    end if;
  end if;

  -- Return / sent back: status went DOWN (but skip the OL self-edit reopen).
  if (
       (old.status = 'approved'  and new.status in ('verified','submitted','draft'))
    or (old.status = 'verified'  and new.status in ('submitted','draft'))
    or (old.status = 'submitted' and new.status = 'draft')
  )
  and not (
       old.status = 'approved' and new.status = 'verified'
   and coalesce(new.return_note, '') = ''
  ) then
    if new.status = 'draft' and new.author_id is not null then
      perform public.emit_notification(new.author_id, v_actor, 'agenda', 'checkpoint.returned',
        'Checkpoint returned for revision',
        v_actor_name || ' sent back the weekly checkpoint for ' || v_brand_name
          || case when coalesce(new.return_note,'') <> '' then ' — note: ' || new.return_note else '' end,
        'checkpoint', new.id, v_link);
    elsif new.status = 'submitted' and v_owner is not null then
      perform public.emit_notification(v_owner, v_actor, 'agenda', 'checkpoint.returned',
        'Checkpoint needs your review again',
        v_actor_name || ' sent back the weekly checkpoint for ' || v_brand_name
          || case when coalesce(new.return_note,'') <> '' then ' — note: ' || new.return_note else '' end,
        'checkpoint', new.id, v_link);
    end if;
  end if;

  return new;
end;
$$;

drop trigger if exists checkpoint_notify_au on public.weekly_checkpoints;
create trigger checkpoint_notify_au
  after update of status on public.weekly_checkpoints
  for each row execute function public.checkpoint_notify_on_status();

-- ── 6. realtime (so the return notice / cards refresh live) ───────────
do $$ begin
  alter publication supabase_realtime add table public.checkpoint_returns;
exception when duplicate_object then null;
end $$;
