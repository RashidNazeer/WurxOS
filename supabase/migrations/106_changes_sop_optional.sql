-- ============================================================
-- 106 — Make sop_type optional on change requests
--
-- v1 parity (commit 3abf23f): a Yes/No toggle replaces the always-
-- required SOP picker. "No" means the change is general — no SOP
-- impact. v2's check constraint required sop_type to be one of the
-- four values; we relax it to also accept NULL.
-- ============================================================

-- Drop NOT NULL constraint and replace the check constraint to permit
-- null. The valid set of non-null values is unchanged.
alter table public.changes
  alter column sop_type drop not null;

alter table public.changes
  drop constraint if exists changes_sop_type_check;

alter table public.changes
  add constraint changes_sop_type_check
  check (sop_type is null or sop_type in ('delivery_roadmap','policies','operational','training'));
