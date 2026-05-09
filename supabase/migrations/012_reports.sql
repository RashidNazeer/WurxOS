-- ============================================================
-- WurxOS v2 — Migration 012: Weekly + Bi-weekly Reports
--
-- Matches v1 feature-for-feature (see PROGRESS.md / spec):
--   * One `reports` table discriminated by `type` (weekly|biweekly)
--   * Per-brand `bi_weekly_anchors` (anchor date for biweekly periods)
--   * Per-user `user_report_custom_fields` template table
--   * Status: draft → submitted → verified → approved (+ rejection)
--   * Full audit trail per stage (submitted_at/by/by_name, etc.)
--   * RLS: APC own brands, TL own brands, OL/Boss all
--   * Notification triggers on status transitions via emit_notification()
--
-- Safe to re-run.
-- ============================================================

-- --------------------------------------------------------------
-- 1. reports table (unified weekly + biweekly)
-- --------------------------------------------------------------
create table if not exists public.reports (
  id             uuid primary key default gen_random_uuid(),
  brand_id       uuid not null references public.brands(id) on delete cascade,
  author_id      uuid not null references public.profiles(id) on delete restrict,

  type           text not null check (type in ('weekly','biweekly')),
  period_number  int,                          -- 1-based index within the year / brand
  period_start   date not null,
  period_end     date not null,
  period_year    int,
  period_month   int,                          -- 0-11 (matches v1)
  period_label   text,

  status         text not null default 'draft'
                   check (status in ('draft','submitted','verified','approved')),

  -- Content — free-form JSON matching v1's shape; see reportsApi.js for sections.
  data           jsonb not null default '{}'::jsonb,

  -- Audit: who/when for each stage
  submitted_at   timestamptz, submitted_by uuid references public.profiles(id) on delete set null,
  verified_at    timestamptz, verified_by  uuid references public.profiles(id) on delete set null,
  approved_at    timestamptz, approved_by  uuid references public.profiles(id) on delete set null,
  rejection_note text,
  rejected_at    timestamptz, rejected_by  uuid references public.profiles(id) on delete set null,
  reopened_at    timestamptz, reopened_by  uuid references public.profiles(id) on delete set null,

  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),

  -- One report per (brand, type, period_start)
  unique (brand_id, type, period_start)
);

create index if not exists reports_brand_type_idx    on public.reports(brand_id, type, period_start desc);
create index if not exists reports_author_idx        on public.reports(author_id, created_at desc);
create index if not exists reports_status_idx        on public.reports(status);
create index if not exists reports_period_month_idx  on public.reports(period_year, period_month);

drop trigger if exists reports_touch_updated_at on public.reports;
create trigger reports_touch_updated_at
  before update on public.reports
  for each row execute function public.touch_updated_at();

-- --------------------------------------------------------------
-- 2. bi_weekly_anchors — per-brand anchor for biweekly periods
-- --------------------------------------------------------------
create table if not exists public.bi_weekly_anchors (
  brand_id     uuid primary key references public.brands(id) on delete cascade,
  anchor_start date not null,
  set_by       uuid references public.profiles(id) on delete set null,
  set_at       timestamptz not null default now()
);

-- --------------------------------------------------------------
-- 3. user_report_custom_fields — per-user reusable template
--    Each field name is carried onto every report they author via
--    the form (value stored inline in reports.data.customFields).
-- --------------------------------------------------------------
create table if not exists public.user_report_custom_fields (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references public.profiles(id) on delete cascade,
  field_name text not null,
  sort_order int  not null default 0,
  created_at timestamptz not null default now()
);

create index if not exists user_report_custom_fields_user_idx on public.user_report_custom_fields(user_id, sort_order);

-- --------------------------------------------------------------
-- 4. RLS — reports
--    SELECT:
--      - APC: own authored OR assigned brand (any status)
--      - TL:  own brand  (any status)
--      - OL/Boss/Developer: all
--    INSERT: creator must be author_id and must have the brand in scope
--    UPDATE: author (drafts), brand owner TL (verify/reject), OL/Boss (approve/reopen/anything)
--    DELETE: Boss/OL/Developer only (keep history)
-- --------------------------------------------------------------
create or replace function public.can_view_report(r_brand uuid, r_author uuid, uid uuid)
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select
    public.is_boss(uid)
    or exists (select 1 from public.profiles p where p.id = uid and p.role in ('ol','developer') and p.is_active)
    or r_author = uid
    or exists (
      select 1 from public.brands b
      where b.id = r_brand and public.can_view_brand(b.owner_id, b.id, uid)
    );
$$;
grant execute on function public.can_view_report(uuid, uuid, uuid) to authenticated;

alter table public.reports enable row level security;

drop policy if exists "reports_select" on public.reports;
create policy "reports_select"
  on public.reports for select
  using (public.can_view_report(brand_id, author_id, auth.uid()));

drop policy if exists "reports_insert" on public.reports;
create policy "reports_insert"
  on public.reports for insert
  with check (
    author_id = auth.uid()
    and exists (
      select 1 from public.brands b
      where b.id = brand_id and public.can_view_brand(b.owner_id, b.id, auth.uid())
    )
  );

-- Update policy: broad — actual per-stage checks happen in app + trigger below.
drop policy if exists "reports_update" on public.reports;
create policy "reports_update"
  on public.reports for update
  using (
    public.is_boss(auth.uid())
    or exists (select 1 from public.profiles p where p.id = auth.uid() and p.role in ('ol','developer') and p.is_active)
    or author_id = auth.uid()                                      -- author (draft edits)
    or exists (                                                    -- brand owner TL (verify/reject)
      select 1 from public.brands b
      where b.id = brand_id and b.owner_id = auth.uid()
    )
  )
  with check (
    public.is_boss(auth.uid())
    or exists (select 1 from public.profiles p where p.id = auth.uid() and p.role in ('ol','developer') and p.is_active)
    or author_id = auth.uid()
    or exists (
      select 1 from public.brands b
      where b.id = brand_id and b.owner_id = auth.uid()
    )
  );

drop policy if exists "reports_delete" on public.reports;
create policy "reports_delete"
  on public.reports for delete
  using (
    public.is_boss(auth.uid())
    or exists (select 1 from public.profiles p where p.id = auth.uid() and p.role in ('ol','developer') and p.is_active)
  );

-- --------------------------------------------------------------
-- 5. RLS — bi_weekly_anchors
--    Same visibility as brands.
-- --------------------------------------------------------------
alter table public.bi_weekly_anchors enable row level security;

drop policy if exists "bi_weekly_anchors_select" on public.bi_weekly_anchors;
create policy "bi_weekly_anchors_select"
  on public.bi_weekly_anchors for select
  using (
    exists (
      select 1 from public.brands b
      where b.id = bi_weekly_anchors.brand_id
        and public.can_view_brand(b.owner_id, b.id, auth.uid())
    )
  );

drop policy if exists "bi_weekly_anchors_insert" on public.bi_weekly_anchors;
create policy "bi_weekly_anchors_insert"
  on public.bi_weekly_anchors for insert
  with check (
    exists (
      select 1 from public.brands b
      where b.id = bi_weekly_anchors.brand_id
        and public.can_view_brand(b.owner_id, b.id, auth.uid())
    )
  );

-- Once set, anchors are NOT editable by anyone except Boss/OL (safety rail)
drop policy if exists "bi_weekly_anchors_update" on public.bi_weekly_anchors;
create policy "bi_weekly_anchors_update"
  on public.bi_weekly_anchors for update
  using (
    public.is_boss(auth.uid())
    or exists (select 1 from public.profiles p where p.id = auth.uid() and p.role in ('ol','developer') and p.is_active)
  );

-- --------------------------------------------------------------
-- 6. RLS — user_report_custom_fields (own only)
-- --------------------------------------------------------------
alter table public.user_report_custom_fields enable row level security;

drop policy if exists "urcf_all_own" on public.user_report_custom_fields;
create policy "urcf_all_own"
  on public.user_report_custom_fields for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- --------------------------------------------------------------
-- 7. Notification triggers — fire on status transitions
-- --------------------------------------------------------------
create or replace function public.reports_notify_on_status()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor      uuid := auth.uid();
  v_actor_name text;
  v_brand_name text;
  v_period     text;
  v_type_label text;
  v_link       text;
  v_brand_owner uuid;
begin
  if old.status is not distinct from new.status and
     coalesce(old.reopened_at, 'epoch'::timestamptz) is not distinct from coalesce(new.reopened_at, 'epoch'::timestamptz) then
    return new;
  end if;

  select brand_name, owner_id into v_brand_name, v_brand_owner
  from public.brands where id = new.brand_id;

  v_actor_name := coalesce(public.profile_display_name(v_actor), 'Someone');
  v_type_label := case when new.type = 'biweekly' then 'Bi-Weekly' else 'Weekly' end;
  v_period     := coalesce(new.period_label, to_char(new.period_start, 'YYYY-MM-DD'));
  v_link       := '/reports';

  -- APC submits (draft → submitted) → notify brand owner (TL)
  if old.status = 'draft' and new.status = 'submitted' and v_brand_owner is not null then
    perform public.emit_notification(
      v_brand_owner, v_actor, 'report', 'report.submitted',
      v_type_label || ' report submitted',
      v_actor_name || ' submitted the ' || v_type_label || ' report for ' || v_brand_name || ' (' || v_period || ')',
      'report', new.id, v_link
    );
  end if;

  -- TL verifies (submitted → verified) → notify all active OLs
  if old.status = 'submitted' and new.status = 'verified' then
    perform public.emit_notification(p.id, v_actor, 'report', 'report.verified',
      v_type_label || ' report ready for approval',
      v_actor_name || ' verified the ' || v_type_label || ' report for ' || v_brand_name || ' (' || v_period || ')',
      'report', new.id, v_link)
    from public.profiles p
    where p.role = 'ol' and p.is_active = true;
  end if;

  -- OL approves (verified → approved) → notify author + brand owner (if different)
  if old.status = 'verified' and new.status = 'approved' then
    perform public.emit_notification(new.author_id, v_actor, 'report', 'report.approved',
      v_type_label || ' report approved',
      v_actor_name || ' approved your ' || v_type_label || ' report for ' || v_brand_name,
      'report', new.id, v_link);
    if v_brand_owner is not null and v_brand_owner <> new.author_id then
      perform public.emit_notification(v_brand_owner, v_actor, 'report', 'report.approved',
        v_type_label || ' report approved',
        v_actor_name || ' approved the ' || v_type_label || ' report for ' || v_brand_name,
        'report', new.id, v_link);
    end if;
  end if;

  -- Rejection / sent back: status went DOWN (approved→verified/submitted/draft,
  -- verified→submitted/draft, submitted→draft).
  if (old.status = 'approved' and new.status in ('verified','submitted','draft'))
     or (old.status = 'verified'  and new.status in ('submitted','draft'))
     or (old.status = 'submitted' and new.status = 'draft') then
    -- Notify the person who needs to act next, based on the new status
    if new.status = 'draft' and new.author_id is not null then
      perform public.emit_notification(new.author_id, v_actor, 'report', 'report.returned',
        v_type_label || ' report returned for revision',
        coalesce(v_actor_name, 'Someone') || ' sent back the ' || v_type_label || ' report for ' || v_brand_name
         || case when coalesce(new.rejection_note,'') <> '' then ' — note: ' || new.rejection_note else '' end,
        'report', new.id, v_link);
    elsif new.status = 'submitted' and v_brand_owner is not null then
      perform public.emit_notification(v_brand_owner, v_actor, 'report', 'report.returned',
        v_type_label || ' report needs your review again',
        v_actor_name || ' sent back the ' || v_type_label || ' report for ' || v_brand_name
         || case when coalesce(new.rejection_note,'') <> '' then ' — note: ' || new.rejection_note else '' end,
        'report', new.id, v_link);
    end if;
  end if;

  return new;
end;
$$;

drop trigger if exists reports_notify_au on public.reports;
create trigger reports_notify_au
  after update of status, reopened_at on public.reports
  for each row execute function public.reports_notify_on_status();
