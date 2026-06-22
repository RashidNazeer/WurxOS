-- ============================================================
-- WurxOS v2 — Migration 209: backfill empty report_returns notes.
--
-- Bug: TL→APC returns went through updateReportStatus(id,'draft',…), which
-- changed status FIRST (firing the report_returns trigger while rejection_note
-- was still empty) and patched the note in a SECOND update. So the return log
-- captured an empty note and the APC saw "No reason was provided." even though
-- the reviewer banner (reports.rejection_note) showed the real reason.
--
-- The app fix writes status + note in one update going forward. This backfills
-- the in-flight reports already in that state: for each report currently
-- sitting at the status its LATEST return put it at, copy the live
-- rejection_note into that latest return row when the row's note is empty.
-- Idempotent (only fills blank notes).
-- ============================================================

update public.report_returns rr
set note = r.rejection_note
from public.reports r
where rr.report_id = r.id
  and (rr.note is null or rr.note = '')
  and r.rejection_note is not null
  and r.rejection_note <> ''
  and rr.to_status = r.status
  and rr.returned_at = (
    select max(x.returned_at) from public.report_returns x
    where x.report_id = rr.report_id
  );
