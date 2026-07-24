-- ============================================================
-- WurxOS v2 — Migration 274: APC reporting metric split (90 + 5 + 5).
--
-- The APC "reporting" metric (one of the 5 the OL rates weekly, [[weekly-apc-
-- performance]]) is split (Boss-confirmed 2026-07-25):
--   reporting (0–100) = OL slider (0–90)
--                     + weekly-report return chunk (0–5)
--                     + weekly-checkpoint return chunk (0–5)
-- Each chunk = max(0, 5 − Σ the TL's docks of that type for the APC in the
-- reviewed week). When the TL sends an APC's weekly report OR checkpoint back to
-- the APC, the TL is asked whether to dock (default 1, 0 = none, can set 1/2/3).
-- The OL sees the two chunk scores while rating (read-only) and sets the 90.
--
-- Fully inside the APC weekly-rating feature → gated by its OFF switch: while the
-- APC method is a trial, nothing rolls up, so this can't move a real score. The
-- fold is done server-side in the wpr BEFORE trigger so metrics.reporting is
-- authoritative; the client just sends the 0–90 slider as `reportingOl`.
--
-- Window = deductions created in [meeting_date − 7d, meeting_date + 1d) Karachi
-- (the reviewed week). Safe to re-run.
-- ============================================================

create table if not exists public.apc_reporting_deductions (
  id            uuid primary key default gen_random_uuid(),
  apc_id        uuid not null references public.profiles(id) on delete cascade,
  kind          text not null check (kind in ('report', 'checkpoint')),
  report_id     uuid references public.reports(id) on delete cascade,
  checkpoint_id uuid references public.weekly_checkpoints(id) on delete cascade,
  amount        numeric not null default 1 check (amount >= 0),
  decided_by    uuid references public.profiles(id) on delete set null,
  created_at    timestamptz not null default now()
);
create index if not exists apc_ded_apc_created_idx on public.apc_reporting_deductions(apc_id, created_at);

alter table public.apc_reporting_deductions enable row level security;
drop policy if exists "apc_ded_select" on public.apc_reporting_deductions;
create policy "apc_ded_select" on public.apc_reporting_deductions for select using (
  public.is_boss(auth.uid())
  or exists (select 1 from public.profiles p where p.id = auth.uid() and p.role in ('ol','developer') and p.is_active = true)
  or apc_id = auth.uid()
  or exists (select 1 from public.profiles t where t.id = apc_reporting_deductions.apc_id and t.reports_to = auth.uid())
);
drop policy if exists "apc_ded_no_write" on public.apc_reporting_deductions;
create policy "apc_ded_no_write" on public.apc_reporting_deductions for all using (false) with check (false);

-- The two return chunks for an APC as reviewed in a given meeting (0–5 each).
create or replace function public.apc_return_chunks(p_apc uuid, p_meeting uuid)
returns table (report_score numeric, report_deducted numeric, checkpoint_score numeric, checkpoint_deducted numeric)
language plpgsql security definer set search_path = public stable as $$
declare
  v_uid   uuid := auth.uid();
  v_svc   boolean := coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role', '') = 'service_role'
                     or session_user in ('postgres', 'supabase_admin');
  v_md    date;
  v_start timestamptz;
  v_end   timestamptz;
  v_rd    numeric;
  v_cd    numeric;
begin
  if not (v_svc or public.is_boss(v_uid) or v_uid = p_apc
          or exists (select 1 from public.profiles p where p.id = v_uid and p.role in ('ol','developer') and p.is_active = true)
          or exists (select 1 from public.profiles t where t.id = p_apc and t.reports_to = v_uid)) then
    return;
  end if;

  select meeting_date into v_md from public.agenda_meetings where id = p_meeting;
  v_md := coalesce(v_md, current_date);
  v_start := (v_md - 7)::timestamp at time zone 'Asia/Karachi';
  v_end   := (v_md + 1)::timestamp at time zone 'Asia/Karachi';

  select coalesce(sum(amount), 0) into v_rd from public.apc_reporting_deductions
   where apc_id = p_apc and kind = 'report'     and created_at >= v_start and created_at < v_end;
  select coalesce(sum(amount), 0) into v_cd from public.apc_reporting_deductions
   where apc_id = p_apc and kind = 'checkpoint' and created_at >= v_start and created_at < v_end;

  return query select greatest(0, 5 - v_rd), v_rd, greatest(0, 5 - v_cd), v_cd;
end;
$$;
revoke execute on function public.apc_return_chunks(uuid, uuid) from public, anon;
grant  execute on function public.apc_return_chunks(uuid, uuid) to authenticated, service_role;

-- The TL (or OL/Boss) records a dock when returning an APC's report/checkpoint.
create or replace function public.apc_report_deduct(p_kind text, p_source_id uuid, p_amount numeric default 1)
returns void language plpgsql security definer set search_path = public as $$
declare v_apc uuid;
begin
  if not (public.is_boss(auth.uid())
          or exists (select 1 from public.profiles p where p.id = auth.uid() and p.role in ('ol','developer','tl','pctl') and p.is_active = true)) then
    raise exception 'only a manager can record a reporting deduction';
  end if;
  if coalesce(p_amount, 0) <= 0 or p_kind not in ('report','checkpoint') then return; end if;

  if p_kind = 'report' then
    select author_id into v_apc from public.reports where id = p_source_id;
    if v_apc is null then return; end if;
    insert into public.apc_reporting_deductions (apc_id, kind, report_id, amount, decided_by)
    values (v_apc, 'report', p_source_id, p_amount, auth.uid());
  else
    select author_id into v_apc from public.weekly_checkpoints where id = p_source_id;
    if v_apc is null then return; end if;
    insert into public.apc_reporting_deductions (apc_id, kind, checkpoint_id, amount, decided_by)
    values (v_apc, 'checkpoint', p_source_id, p_amount, auth.uid());
  end if;
end;
$$;
revoke execute on function public.apc_report_deduct(text, uuid, numeric) from public, anon;
grant  execute on function public.apc_report_deduct(text, uuid, numeric) to authenticated;

-- Fold the reporting split into the stored metric. Recreated from mig 269 (fills
-- week_start + month) PLUS: when the client sends a `reportingOl` (the 0–90
-- slider), set metrics.reporting = reportingOl + the two return chunks. Backward
-- compatible: rows without reportingOl keep metrics.reporting as sent.
create or replace function public.wpr_fill_from_meeting()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_ws date; v_md date; v_bonus numeric;
begin
  select week_start, meeting_date into v_ws, v_md
    from public.agenda_meetings where id = new.meeting_id;
  new.week_start := v_ws;
  new.month := to_char(coalesce(v_md, v_ws, current_date), 'YYYY-MM');
  new.updated_at := now();

  if new.metrics ? 'reportingOl' then
    select (report_score + checkpoint_score) into v_bonus
      from public.apc_return_chunks(new.apc_id, new.meeting_id);
    new.metrics := jsonb_set(
      new.metrics, '{reporting}',
      to_jsonb( least(100, greatest(0, round(coalesce((new.metrics->>'reportingOl')::numeric, 0) + coalesce(v_bonus, 0), 2))) )
    );
  end if;
  return new;
end;
$$;
-- trigger itself is unchanged (mig 269 created it on before insert/update).

do $$ begin
  alter publication supabase_realtime add table public.apc_reporting_deductions;
exception when duplicate_object then null;
end $$;
