-- ============================================================
-- WurxOS v2 — Migration 278: whole-system review fixes for the perf overhaul.
--
-- The integrated (cross-feature) review found:
--  H1 wpr_fill_from_meeting folded reporting via the AUTH-GATED apc_return_chunks.
--     The fold re-runs (mig 275 apc_ded_refold) under the ACTOR's identity — incl.
--     a cascade-delete of a docked checkpoint by a co-assigned teammate who can't
--     see the APC — so the gate returns zero rows, v_bonus is NULL→0, and the
--     +10 "no docks" bonus is silently destroyed → composite drops. Fix: compute
--     the chunk bonus INLINE (identity-independent) in the trigger.
--  H2 apc_report_deduct authorised only the APC's TEAM manager (reports_to), but
--     the report/checkpoint RETURN that fires the dock is done by the BRAND-OWNER
--     TL (brands.owner_id). After team_move_apc_to_tl (moves reports_to, not
--     owner_id) they differ, so a legit cross-team return raises → swallowed →
--     no dock recorded → reporting inflated. Fix: also authorise the source's
--     brand owner.
--  M2 tl_reporting_score (the blend) is SECURITY DEFINER, ungated, and still
--     granted to authenticated (mig 277 only revoked the two leaf helpers) → any
--     logged-in user can read any TL's salary-feeding score. LIVE at deploy,
--     switch-independent. Fix: revoke authenticated.
--  L3 listTlDeductions filtered the stored (advisory) month column while the
--     SCORED total uses the report's verified_at window (mig 273) → the modal's
--     line-items diverged from its total after a cross-month re-verify. Fix: a
--     gated RPC that lists deductions on the same verified_at window.
--
-- Safe to re-run.
-- ============================================================

-- ── H1: identity-independent reporting fold ──────────────────────────
create or replace function public.wpr_fill_from_meeting()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_ws date; v_md date; v_bonus numeric; v_rd numeric; v_cd numeric; v_start timestamptz; v_end timestamptz;
begin
  select week_start, meeting_date into v_ws, v_md from public.agenda_meetings where id = new.meeting_id;
  new.week_start := v_ws;
  new.month := to_char(coalesce(v_md, v_ws, current_date), 'YYYY-MM');
  new.updated_at := now();

  if new.metrics ? 'reportingOl' then
    -- Compute the two return chunks INLINE from apc_reporting_deductions — NOT via
    -- the auth-gated apc_return_chunks. This trigger re-runs under whoever's action
    -- touched the row (incl. a cascade delete by a co-assigned teammate who can't
    -- see this APC); a gated call returning zero rows would zero the +10 bonus.
    v_start := (coalesce(v_md, current_date) - 6)::timestamp at time zone 'Asia/Karachi';
    v_end   := (coalesce(v_md, current_date) + 1)::timestamp at time zone 'Asia/Karachi';
    select coalesce(sum(amount) filter (where kind = 'report'), 0),
           coalesce(sum(amount) filter (where kind = 'checkpoint'), 0)
      into v_rd, v_cd
      from public.apc_reporting_deductions
     where apc_id = new.apc_id and created_at >= v_start and created_at < v_end;
    v_bonus := greatest(0, 5 - v_rd) + greatest(0, 5 - v_cd);
    new.metrics := jsonb_set(new.metrics, '{reporting}',
      to_jsonb( least(100, greatest(0, round(coalesce((new.metrics ->> 'reportingOl')::numeric, 0) + v_bonus, 2))) ));
  end if;
  return new;
end;
$$;

-- ── H2: authorise the source's brand-owner TL to dock ────────────────
create or replace function public.apc_report_deduct(p_kind text, p_source_id uuid, p_amount numeric default 1)
returns void language plpgsql security definer set search_path = public as $$
declare v_apc uuid; v_brand uuid;
begin
  if coalesce(p_amount, 0) <= 0 or p_kind not in ('report', 'checkpoint') then return; end if;

  if p_kind = 'report' then
    select author_id, brand_id into v_apc, v_brand from public.reports where id = p_source_id;
  else
    select author_id, brand_id into v_apc, v_brand from public.weekly_checkpoints where id = p_source_id;
  end if;
  if v_apc is null then return; end if;

  -- Boss / active OL-dev / the APC's TEAM manager (reports_to) / the source's
  -- BRAND OWNER (the TL who legitimately returns it — brands.owner_id, which the
  -- return flow gates on and which can differ from reports_to after a team move).
  if not (public.is_boss(auth.uid())
          or exists (select 1 from public.profiles p where p.id = auth.uid() and p.role in ('ol','developer') and p.is_active = true)
          or exists (select 1 from public.profiles t where t.id = v_apc and t.reports_to = auth.uid())
          or exists (select 1 from public.brands b where b.id = v_brand and b.owner_id = auth.uid())) then
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

-- ── M2: revoke the leaky TL reporting-score blend ────────────────────
revoke execute on function public.tl_reporting_score(uuid, text) from authenticated, public, anon;
grant  execute on function public.tl_reporting_score(uuid, text) to service_role;

-- ── L3: deduction line-items on the scored verified_at window ────────
create or replace function public.list_tl_deductions(p_tl uuid, p_month text)
returns table (id uuid, report_id uuid, amount numeric, note text, created_at timestamptz,
               decided_by_name text, brand_name text, period_label text)
language plpgsql security definer set search_path = public stable as $$
declare
  v_uid   uuid := auth.uid();
  v_svc   boolean := coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role', '') = 'service_role'
                     or session_user in ('postgres', 'supabase_admin');
  v_start timestamptz := (p_month || '-01')::timestamp at time zone 'Asia/Karachi';
  v_end   timestamptz := ((p_month || '-01')::date + interval '1 month')::timestamp at time zone 'Asia/Karachi';
begin
  if not (v_svc or public.is_boss(v_uid) or v_uid = p_tl
          or exists (select 1 from public.profiles p where p.id = v_uid and p.role in ('ol','developer') and p.is_active = true)
          or exists (select 1 from public.profiles t where t.id = p_tl and t.reports_to = v_uid)) then
    return;
  end if;
  return query
  select d.id, d.report_id, d.amount, d.note, d.created_at,
         dec.display_name, b.brand_name, r.period_label
    from public.tl_reporting_deductions d
    join public.reports r on r.id = d.report_id
    join public.brands b on b.id = r.brand_id
    left join public.profiles dec on dec.id = d.decided_by
   where b.owner_id = p_tl and r.verified_at >= v_start and r.verified_at < v_end
   order by d.created_at desc;
end;
$$;
revoke execute on function public.list_tl_deductions(uuid, text) from public, anon;
grant  execute on function public.list_tl_deductions(uuid, text) to authenticated, service_role;
