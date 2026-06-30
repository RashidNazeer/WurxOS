-- ============================================================
-- WurxOS v2 — Migration 214: backfill OL→TL return notes that were
-- logged empty due to the updateReportStatus ordering bug.
--
-- BUG (fixed in the same release, client-side in reportsApi.js
-- updateReportStatus): when an OL returned a report to the TL the
-- status moved verified → 'submitted' via submitReport(), which
-- hard-codes rejection_note = null. The report_returns trigger
-- (mig 203) fired on that transition and captured a NULL note, so the
-- TL saw "No reason was provided." even though the OL gave a reason.
-- The reason often survived on reports.rejection_note (written back by
-- the caller's audit patch after submitReport ran), so the latest
-- empty-note return per report is recoverable from there.
--
-- This is the same shape of repair as mig 209 (which fixed an earlier
-- batch). The client fix stops NEW empty notes; this repairs the
-- in-flight ones that accumulated since.
--
-- Only fills the MOST RECENT empty-note return per report (the one the
-- ReportReturnNotice banner currently shows) and only when the report
-- still carries a non-empty rejection_note. Older empty entries whose
-- note was overwritten by a later resubmit are unrecoverable and left
-- as-is (they correctly read "No reason was provided.").
--
-- Idempotent: re-running matches nothing once notes are filled.
-- ============================================================

with latest_empty as (
  select distinct on (rr.report_id) rr.id, rr.report_id
  from public.report_returns rr
  where rr.note is null or rr.note = ''
  order by rr.report_id, rr.returned_at desc
)
update public.report_returns rr
set note = r.rejection_note
from latest_empty le
join public.reports r on r.id = le.report_id
where rr.id = le.id
  and r.rejection_note is not null
  and r.rejection_note <> '';
