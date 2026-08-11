-- ============================================================
-- WurxOS v2 — Migration 310: fix the TL-star note (mig 309) — money bug +
-- confidentiality.
--
-- Review of mig 309 found three real defects:
--   1. (MONEY) report_rate_tl set tl_stars = least(5, greatest(0, p_stars)).
--      Postgres LEAST/GREATEST IGNORE null args, so a null p_stars became 0
--      (not null). A note-only save (OL types a note before picking a star)
--      therefore fabricated a 0-star rating that IS counted by
--      tl_report_stars_score (avg where tl_stars is not null) → dragged the TL's
--      reporting score. Fix: a null p_stars now LEAVES tl_stars unchanged.
--   2. (LEAK) tl_stars_note was a plain column on reports; reports_select is
--      row-level (author + can_view_brand), and every fetch uses `select *`, so
--      the OL's candid note about the TL shipped in the payload to the APC author
--      and co-brand-viewers — beyond the intended OL + brand-owner-TL audience.
--      A column-level REVOKE can't fix this (Supabase grants table-level SELECT,
--      and `select *` would break). Fix: move the note to a SCOPED table
--      (report_tl_stars_notes) whose RLS only lets the OL/Boss + the report's
--      brand-owner TL read it, so it never rides in the reports payload at all.
--   (3. a blur/click star-write race is fixed on the client.)
--
-- No note data exists yet (mig 309's frontend was never deployed), so dropping
-- reports.tl_stars_note here is a clean restructure.
--
-- Safe to re-run.
-- ============================================================

-- ── 1. Revert the star-guard trigger to NOT reference tl_stars_note (the column
--       is about to be dropped; plpgsql resolves columns at runtime). Back to the
--       mig-303 four-column guard. ─
create or replace function public.reports_guard_stars()
returns trigger language plpgsql set search_path = public as $$
begin
  if (new.apc_stars    is distinct from old.apc_stars
   or new.apc_stars_by is distinct from old.apc_stars_by
   or new.tl_stars     is distinct from old.tl_stars
   or new.tl_stars_by  is distinct from old.tl_stars_by)
   and current_user in ('authenticated', 'anon') then
    raise exception 'report reporting stars can only be set via report_rate_apc / report_rate_tl';
  end if;
  return new;
end;
$$;

-- ── 2. Drop the leaky plain column. ─
alter table public.reports drop column if exists tl_stars_note;

-- ── 3. Scoped note store. Readable ONLY by Boss / active OL|dev / the report's
--       brand-owner TL. No write policy → writable only by the SECURITY DEFINER
--       report_rate_tl (which runs as the table owner and bypasses RLS). ─
create table if not exists public.report_tl_stars_notes (
  report_id  uuid primary key references public.reports(id) on delete cascade,
  note       text not null,
  updated_by uuid references public.profiles(id) on delete set null,
  updated_at timestamptz not null default now()
);
alter table public.report_tl_stars_notes enable row level security;

drop policy if exists "rtsn_select" on public.report_tl_stars_notes;
create policy "rtsn_select" on public.report_tl_stars_notes for select using (
  public.is_boss(auth.uid())
  or exists (select 1 from public.profiles p where p.id = auth.uid() and p.role in ('ol','developer') and p.is_active = true)
  or exists (
    select 1 from public.reports r
      join public.brands b on b.id = r.brand_id
     where r.id = report_tl_stars_notes.report_id and b.owner_id = auth.uid())
);

-- ── 4. report_rate_tl: null p_stars leaves the star (and its author) untouched;
--       the optional note is upserted into the scoped table (blank → cleared). ─
create or replace function public.report_rate_tl(p_report_id uuid, p_stars numeric, p_note text default null)
returns void language plpgsql security definer set search_path = public as $$
declare v_status text; v_note text;
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

  -- A null star means "note-only save" — never fabricate a 0 (LEAST/GREATEST
  -- ignore nulls, so the old least(5,greatest(0,null)) wrote 0). Leave it as-is.
  update public.reports
     set tl_stars    = case when p_stars is null then tl_stars    else least(5, greatest(0, p_stars)) end,
         tl_stars_by = case when p_stars is null then tl_stars_by else auth.uid() end
   where id = p_report_id;

  v_note := nullif(btrim(coalesce(p_note, '')), '');
  if v_note is null then
    delete from public.report_tl_stars_notes where report_id = p_report_id;
  else
    insert into public.report_tl_stars_notes (report_id, note, updated_by, updated_at)
    values (p_report_id, v_note, auth.uid(), now())
    on conflict (report_id) do update
      set note = excluded.note, updated_by = excluded.updated_by, updated_at = now();
  end if;
end;
$$;
revoke execute on function public.report_rate_tl(uuid, numeric, text) from public, anon;
grant  execute on function public.report_rate_tl(uuid, numeric, text) to authenticated;
