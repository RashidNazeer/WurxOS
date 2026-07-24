-- ============================================================
-- WurxOS v2 — Migration 275: APC reporting-split review fixes.
--
-- Focused review of mig 274 confirmed 4 defects:
--  #1 (HIGH, live now): apc_report_deduct gated on ROLE only — any active
--     tl/pctl could dock ANY APC (not just one they manage). The dock path is
--     NOT switch-gated, so this is live on deploy. Add a per-APC scope check
--     (mirror apc_return_chunks): boss / active ol|dev / the APC's manager.
--  #2: apc_return_chunks window was [D-7, D+1) = 8 days, so adjacent weekly
--     meetings (D and D+7) shared day D and a meeting-day dock counted for BOTH
--     weeks. Use [D-6, D+1) = 7 non-overlapping days.
--  #3: the fold runs only when a rating row is inserted/updated. A dock created
--     AFTER the OL's same-day save (window reaches D+1) never folded until a
--     manual re-save. Add an AFTER trigger on apc_reporting_deductions that
--     touches the affected rating row(s) so the fold + rollup re-run.
--  #4 (JS, WeeklyRatingFields): legacy rows without reportingOl — handled in the
--     client reload (derive the 0-90 part = reporting − chunks) so a re-save is
--     idempotent instead of inflating by +10.
--
-- Safe to re-run.
-- ============================================================

-- #1: per-APC authorization scope
create or replace function public.apc_report_deduct(p_kind text, p_source_id uuid, p_amount numeric default 1)
returns void language plpgsql security definer set search_path = public as $$
declare v_apc uuid;
begin
  if coalesce(p_amount, 0) <= 0 or p_kind not in ('report', 'checkpoint') then return; end if;

  if p_kind = 'report' then
    select author_id into v_apc from public.reports where id = p_source_id;
  else
    select author_id into v_apc from public.weekly_checkpoints where id = p_source_id;
  end if;
  if v_apc is null then return; end if;

  -- Only the Boss, an active OL/dev, or the APC's own manager may dock them.
  if not (public.is_boss(auth.uid())
          or exists (select 1 from public.profiles p where p.id = auth.uid() and p.role in ('ol','developer') and p.is_active = true)
          or exists (select 1 from public.profiles t where t.id = v_apc and t.reports_to = auth.uid())) then
    raise exception 'you are not authorised to deduct this APC''s reporting';
  end if;

  if p_kind = 'report' then
    insert into public.apc_reporting_deductions (apc_id, kind, report_id, amount, decided_by)
    values (v_apc, 'report', p_source_id, p_amount, auth.uid());
  else
    insert into public.apc_reporting_deductions (apc_id, kind, checkpoint_id, amount, decided_by)
    values (v_apc, 'checkpoint', p_source_id, p_amount, auth.uid());
  end if;
end;
$$;
revoke execute on function public.apc_report_deduct(text, uuid, numeric) from public, anon;
grant  execute on function public.apc_report_deduct(text, uuid, numeric) to authenticated;

-- #2: non-overlapping 7-day window [D-6, D+1) Karachi
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
  v_start := (v_md - 6)::timestamp at time zone 'Asia/Karachi';
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

-- #3: re-fold ratings when a dock is added / edited / removed. Touches every
-- weekly rating whose meeting window [D-6, D+1) contains the dock's day, i.e.
-- meeting_date D in [dock_day, dock_day+6]; the touch re-runs the BEFORE-fold
-- (wpr_fill_from_meeting) + the rollup. Does not write apc_reporting_deductions
-- → no recursion.
create or replace function public.apc_ded_refold()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_apc uuid; v_cd date;
begin
  if tg_op = 'DELETE' then
    v_apc := old.apc_id; v_cd := (old.created_at at time zone 'Asia/Karachi')::date;
  else
    v_apc := new.apc_id; v_cd := (new.created_at at time zone 'Asia/Karachi')::date;
  end if;

  update public.weekly_performance_ratings w
     set updated_at = now()
    from public.agenda_meetings m
   where w.meeting_id = m.id
     and w.apc_id = v_apc
     and m.meeting_date between v_cd and v_cd + 6;

  return coalesce(new, old);
end;
$$;
drop trigger if exists apc_ded_refold_trg on public.apc_reporting_deductions;
create trigger apc_ded_refold_trg
  after insert or update or delete on public.apc_reporting_deductions
  for each row execute function public.apc_ded_refold();
