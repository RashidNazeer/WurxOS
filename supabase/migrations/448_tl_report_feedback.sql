-- ============================================================
-- WurxOS v2 — Migration 448: the TL rates AND leaves feedback while reading / verifying a report.
--
-- Until now the TL's 0-5 star on an APC's report (report_rate_apc, mig 303) could only be given
-- AFTER the report was verified, and carried no comment. So ratings were routinely missed (about
-- 7 APCs a month had verified reports with no star), while the OL already rates a TL's report with
-- a justification note (mig 309/310). Now, mirroring the OL:
--   * the brand-owner TL (or OL/Boss) can rate from the moment the report is SUBMITTED, i.e. while
--     reading it and deciding to verify - not only afterwards;
--   * the rating takes an optional FEEDBACK note, kept in a scoped table (never on the report
--     payload), readable only by the TL who owns the brand, OL/Boss and the report's own author,
--     so the APC sees the feedback on their report and nobody else does;
--   * a null star with a note is a note-only save (never fabricates a 0), as for report_rate_tl.
-- The stars still only reach the APC score once the report is verified (the score windows on
-- verified_at), so rating early cannot move a score by itself.
-- Idempotent.
-- ============================================================

create table if not exists public.report_apc_stars_notes (
  report_id  uuid primary key references public.reports(id) on delete cascade,
  note       text not null,
  updated_by uuid references public.profiles(id) on delete set null,
  updated_at timestamptz not null default now()
);
alter table public.report_apc_stars_notes enable row level security;

drop policy if exists "rasn_select" on public.report_apc_stars_notes;
create policy "rasn_select" on public.report_apc_stars_notes for select using (
  public.is_boss(auth.uid())
  or exists (select 1 from public.profiles p where p.id = auth.uid() and p.role in ('ol','developer') and p.is_active = true)
  or exists (
    select 1 from public.reports r
      join public.brands b on b.id = r.brand_id
     where r.id = report_apc_stars_notes.report_id
       and (b.owner_id = auth.uid() or r.author_id = auth.uid()))
);
-- No insert/update/delete policy: notes are written only by report_rate_apc below.

drop function if exists public.report_rate_apc(uuid, numeric);
create or replace function public.report_rate_apc(p_report_id uuid, p_stars numeric, p_note text default null)
returns void language plpgsql security definer set search_path = public as $$
declare v_brand uuid; v_status text; v_note text;
begin
  select brand_id, status into v_brand, v_status from public.reports where id = p_report_id;
  if v_brand is null then return; end if;
  if not (public.is_boss(auth.uid())
          or exists (select 1 from public.profiles p where p.id = auth.uid() and p.role in ('ol','developer') and p.is_active = true)
          or exists (select 1 from public.brands b where b.id = v_brand and b.owner_id = auth.uid())) then
    raise exception 'only the brand owner (TL) or OL/Boss can rate this report';
  end if;
  if v_status not in ('submitted', 'verified', 'approved') then
    raise exception 'a report can be rated once it is submitted';
  end if;

  update public.reports
     set apc_stars    = case when p_stars is null then apc_stars    else least(5, greatest(0, p_stars)) end,
         apc_stars_by = case when p_stars is null then apc_stars_by else auth.uid() end
   where id = p_report_id;

  v_note := nullif(btrim(coalesce(p_note, '')), '');
  if v_note is null then
    delete from public.report_apc_stars_notes where report_id = p_report_id;
  else
    insert into public.report_apc_stars_notes (report_id, note, updated_by, updated_at)
    values (p_report_id, v_note, auth.uid(), now())
    on conflict (report_id) do update
      set note = excluded.note, updated_by = excluded.updated_by, updated_at = now();
  end if;
end;
$$;
revoke execute on function public.report_rate_apc(uuid, numeric, text) from public, anon;
grant  execute on function public.report_rate_apc(uuid, numeric, text) to authenticated;
