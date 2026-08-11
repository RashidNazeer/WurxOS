-- ============================================================
-- WurxOS v2 — Migration 309: OL can attach a justification NOTE to the TL
-- reporting star.
--
-- When the OL rates a Team Lead's report (report_rate_tl, mig 303/306), they can
-- now also leave an OPTIONAL comment explaining the rating (why it's low/high).
-- The note is stored on reports.tl_stars_note and is visible to the OL (who wrote
-- it) and to the brand-owner Team Lead who received the rating — surfaced on the
-- report's ReportRatingBar. Text only; it has NO effect on any score (the TL
-- reporting score reads tl_stars, not the note).
--
-- report_rate_tl gains an optional p_note. The old 2-arg
-- report_rate_tl(uuid, numeric) is dropped so the defaulted 3-arg is unambiguous;
-- the pre-deploy frontend's 2-arg call still resolves (p_note = null). The
-- star-write GUARD trigger is extended to also protect tl_stars_note, so the note
-- (like the star) can only be set via this SECURITY DEFINER RPC — a brand-owner
-- TL can't forge an OL "note" on their own report via a direct PATCH.
--
-- Safe to re-run.
-- ============================================================

alter table public.reports
  add column if not exists tl_stars_note text;

-- ── report_rate_tl now also writes the optional note ─────────────────
drop function if exists public.report_rate_tl(uuid, numeric);
create or replace function public.report_rate_tl(p_report_id uuid, p_stars numeric, p_note text default null)
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
     set tl_stars      = least(5, greatest(0, p_stars)),
         tl_stars_note = nullif(btrim(coalesce(p_note, '')), ''),
         tl_stars_by   = auth.uid()
   where id = p_report_id;
end;
$$;
revoke execute on function public.report_rate_tl(uuid, numeric, text) from public, anon;
grant  execute on function public.report_rate_tl(uuid, numeric, text) to authenticated;

-- ── GUARD: also protect tl_stars_note (only the rate RPC / service_role may
--    write it, same as the star columns — see mig 303 §4). SECURITY INVOKER so
--    current_user is the REAL caller (postgres inside the definer RPC; the JWT
--    role on a direct PATCH). ─
create or replace function public.reports_guard_stars()
returns trigger language plpgsql set search_path = public as $$
begin
  if (new.apc_stars     is distinct from old.apc_stars
   or new.apc_stars_by  is distinct from old.apc_stars_by
   or new.tl_stars      is distinct from old.tl_stars
   or new.tl_stars_by   is distinct from old.tl_stars_by
   or new.tl_stars_note is distinct from old.tl_stars_note)
   and current_user in ('authenticated', 'anon') then
    raise exception 'report reporting stars can only be set via report_rate_apc / report_rate_tl';
  end if;
  return new;
end;
$$;
