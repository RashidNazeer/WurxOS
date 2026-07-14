-- ============================================================
-- WurxOS v2 — Migration 248: record WHO last edited a KB article
--
-- Both KB pages render "· Updated by {name} on {date}" — and it has NEVER
-- appeared, because kbApi read `row.updated_by_name` and kb_articles has no such
-- column. Worse, bossUpdateArticle WROTE to `updated_by_name` too, so any edit
-- that carried that field would have been rejected outright by PostgREST.
--
-- There was no way to shim this: the information simply was not stored. The row
-- has `updated_at` but no record of who did it.
--
-- So store it. A BEFORE UPDATE trigger stamps auth.uid(), which means every write
-- path is covered — the kb_* RPCs, the Boss's direct patch, anything added later
-- — with no caller needing to remember. Existing rows are backfilled to their
-- creator: the best available answer, and truer than a blank.
--
-- Idempotent.
-- ============================================================

alter table public.kb_articles
  add column if not exists updated_by uuid references public.profiles(id) on delete set null;

-- Backfill: the only person we can honestly attribute an existing edit to.
update public.kb_articles
   set updated_by = created_by
 where updated_by is null;

create or replace function public.kb_set_updated_by()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  -- auth.uid() is null for service-role / migration writes; keep whatever was
  -- there rather than blanking the attribution.
  if auth.uid() is not null then
    new.updated_by := auth.uid();
  end if;
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists kb_articles_set_updated_by on public.kb_articles;
create trigger kb_articles_set_updated_by
  before update on public.kb_articles
  for each row execute function public.kb_set_updated_by();
