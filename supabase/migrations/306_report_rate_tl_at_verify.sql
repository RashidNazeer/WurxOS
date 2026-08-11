-- ============================================================
-- WurxOS v2 — Migration 306: OL can rate the TL's report from the VERIFIED stage.
--
-- The OL rates the Team Lead's report at approval — but the report is 'verified'
-- (on the OL's desk, awaiting approval) at that moment, not yet 'approved'. mig 303
-- gated report_rate_tl to status='approved' only, so the "TL reporting" star could
-- not be set until AFTER approving (and the UI therefore hid it on verified
-- reports). Allow it from 'verified' through 'approved' so the OL can rate while
-- reviewing/approving. Scoring is unaffected: tl_report_stars_score/accountability
-- already key on verified_at, and a verified report has verified_at set.
--
-- Safe to re-run.
-- ============================================================

create or replace function public.report_rate_tl(p_report_id uuid, p_stars numeric)
returns void language plpgsql security definer set search_path = public as $$
declare v_status text;
begin
  select status into v_status from public.reports where id = p_report_id;
  if v_status is null then return; end if;
  if not (public.is_boss(auth.uid())
          or exists (select 1 from public.profiles p where p.id = auth.uid() and p.role in ('ol','developer') and p.is_active = true)) then
    raise exception 'only OL/Boss can rate a Team Lead''s report';
  end if;
  if v_status not in ('verified', 'approved') then
    raise exception 'a Team Lead report can only be rated once it is verified';
  end if;
  update public.reports
     set tl_stars = least(5, greatest(0, p_stars)), tl_stars_by = auth.uid()
   where id = p_report_id;
end;
$$;
revoke execute on function public.report_rate_tl(uuid, numeric) from public, anon;
grant  execute on function public.report_rate_tl(uuid, numeric) to authenticated;
