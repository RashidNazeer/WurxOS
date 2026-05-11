-- ============================================================
-- WurxOS v2 — Migration 157: hot-path indexes
--
-- Audit flagged that several common filter columns aren't indexed,
-- so the planner falls back to sequential scans on tables that get
-- read on every page load.
--
-- All `create index if not exists` so re-running is safe. Concurrent
-- creation is preferred but the Supabase migration runner is
-- transactional — non-concurrent is fine for v2's table sizes.
-- ============================================================

-- Tasks: list views filter by assignee + status constantly.
create index if not exists idx_tasks_assignee_status
  on public.tasks(assignee_id, status);

-- Notifications: the bell unread count is `where recipient_id=? and read_at is null`.
create index if not exists idx_notifications_recipient_read
  on public.notifications(recipient_id, read_at);

-- Audit log: the entity-filtered timeline is the slow page.
create index if not exists idx_audit_log_entity_created
  on public.audit_log(entity_type, created_at desc);

-- Attendance: lookups by (user_id, date) drive every roster + my-shift
-- query. The table already has a unique(user_id, date) constraint
-- which implies an index, but adding an explicit btree on (user_id,
-- date desc) helps "latest first" reads.
create index if not exists idx_attendance_user_date_desc
  on public.attendance(user_id, date desc);

-- app_events: filtered by (user_id, created_at desc) for the
-- forensic queries we run after a sign-out report.
create index if not exists idx_app_events_user_created
  on public.app_events(user_id, created_at desc);

-- Leave requests: pending queues filter by status.
create index if not exists idx_leave_requests_status_level
  on public.leave_requests(status, current_level);

-- Reports: brand-scoped + period-sorted views.
create index if not exists idx_reports_brand_type_period
  on public.reports(brand_id, type, period_start desc);
