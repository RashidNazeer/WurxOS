/**
 * Report notification helpers — v1 sent client-side notifications from
 * the form/listing pages. v2 emits the same notifications server-side
 * via the `reports_notify_on_status` trigger (migration 012). So these
 * are no-op shims kept for verbatim-port compatibility: any v1 component
 * that imports them keeps compiling and running, but the actual
 * notification fan-out happens in Postgres.
 *
 * If you ever need to add notifications NOT covered by the trigger,
 * add another emit_notification() call in a migration rather than
 * implementing it here — keeps the source of truth in one place.
 */

export async function notifyReportSubmitted() { /* handled by DB trigger */ }
export async function notifyReportVerified()  { /* handled by DB trigger */ }
export async function notifyReportApproved()  { /* handled by DB trigger */ }
export async function notifyReportRejected()  { /* handled by DB trigger */ }
