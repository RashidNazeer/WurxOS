-- ============================================================
-- Migration 121 — Track who last edited a report (separate from
-- the original author).
--
-- v1 bug: every save to a report rewrote createdBy/createdByName,
-- so a TL or OL edit silently displaced the APC who originally
-- authored the draft. Reports surfaced under the wrong byline.
--
-- v2 already preserves author_id on update — upsertDraft never
-- patches author_id once the row exists. But there's no record
-- of WHO last touched it, which makes audit trails thin and
-- makes "last edited by …" UX impossible.
--
-- Add last_edited_by + last_edited_at; populate via trigger on
-- every UPDATE so client code can't forget. Triggers fire only
-- when something actually changed (avoids self-touch loops).
-- ============================================================

alter table public.reports
  add column if not exists last_edited_by uuid references public.profiles(id) on delete set null,
  add column if not exists last_edited_at timestamptz;

create or replace function public.reports_stamp_last_editor()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  -- Only stamp if a meaningful field changed (not just the trigger's
  -- own bookkeeping columns), and the editor is identifiable.
  if auth.uid() is null then
    return new;
  end if;
  if (new.data        is distinct from old.data)
     or (new.status      is distinct from old.status)
     or (new.period_start is distinct from old.period_start)
     or (new.period_end   is distinct from old.period_end)
     or (new.period_label is distinct from old.period_label)
  then
    new.last_edited_by := auth.uid();
    new.last_edited_at := now();
  end if;
  return new;
end;
$$;

drop trigger if exists reports_last_editor_trg on public.reports;
create trigger reports_last_editor_trg
  before update on public.reports
  for each row
  execute function public.reports_stamp_last_editor();
