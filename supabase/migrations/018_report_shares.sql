-- ============================================================
-- WurxOS v2 — Migration 018: Report share links (M8 Client Portal)
--
-- Adds:
--   * report_shares table — one row per shareable link
--   * get_shared_report(token) RPC — public (anon-invokable),
--     returns the snapshot only for non-expired non-revoked
--     tokens that point at an *approved* report.
--
-- Safe to re-run.
-- ============================================================

-- --------------------------------------------------------------
-- 1. report_shares
-- --------------------------------------------------------------
create table if not exists public.report_shares (
  token        text primary key,
  report_id    uuid not null references public.reports(id) on delete cascade,
  created_by   uuid not null references public.profiles(id) on delete set null,
  expires_at   timestamptz,                 -- null = never
  revoked_at   timestamptz,                 -- null = active
  view_count   int not null default 0,
  created_at   timestamptz not null default now()
);

create index if not exists report_shares_report_idx on public.report_shares(report_id);
create index if not exists report_shares_creator_idx on public.report_shares(created_by);

-- --------------------------------------------------------------
-- 2. RLS — only the report's author / editors see share rows
-- --------------------------------------------------------------
alter table public.report_shares enable row level security;

drop policy if exists "report_shares_select" on public.report_shares;
create policy "report_shares_select"
  on public.report_shares for select
  using (
    public.is_boss(auth.uid())
    or exists (
      select 1 from public.reports r
      where r.id = report_shares.report_id
        and public.can_edit_report(r.brand_id, r.author_id, auth.uid())
    )
  );

drop policy if exists "report_shares_insert" on public.report_shares;
create policy "report_shares_insert"
  on public.report_shares for insert
  with check (
    auth.uid() = created_by
    and exists (
      select 1 from public.reports r
      where r.id = report_shares.report_id
        and r.status = 'approved'
        and public.can_edit_report(r.brand_id, r.author_id, auth.uid())
    )
  );

-- Delete / revoke handled via UPDATE revoked_at (no hard delete policy)
drop policy if exists "report_shares_update" on public.report_shares;
create policy "report_shares_update"
  on public.report_shares for update
  using (
    public.is_boss(auth.uid())
    or exists (
      select 1 from public.reports r
      where r.id = report_shares.report_id
        and public.can_edit_report(r.brand_id, r.author_id, auth.uid())
    )
  )
  with check (
    public.is_boss(auth.uid())
    or exists (
      select 1 from public.reports r
      where r.id = report_shares.report_id
        and public.can_edit_report(r.brand_id, r.author_id, auth.uid())
    )
  );

-- --------------------------------------------------------------
-- 3. Public RPC — resolve a token to a read-only report snapshot.
--    SECURITY DEFINER so it can bypass RLS; we enforce the
--    approved + not-revoked + not-expired checks inside.
-- --------------------------------------------------------------
create or replace function public.get_shared_report(p_token text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_share   public.report_shares%rowtype;
  v_report  jsonb;
  v_brand   jsonb;
  v_author  jsonb;
begin
  select * into v_share from public.report_shares where token = p_token;
  if not found                          then raise exception 'share_not_found'   using errcode = 'P0002'; end if;
  if v_share.revoked_at is not null     then raise exception 'share_revoked'     using errcode = 'P0003'; end if;
  if v_share.expires_at is not null and v_share.expires_at < now()
                                         then raise exception 'share_expired'     using errcode = 'P0004'; end if;

  select to_jsonb(r) - 'sections' || jsonb_build_object('sections', r.sections)
    into v_report
  from public.reports r
  where r.id = v_share.report_id;
  if v_report is null                   then raise exception 'report_not_found'  using errcode = 'P0002'; end if;
  if (v_report->>'status') <> 'approved' then raise exception 'report_not_approved' using errcode = 'P0005'; end if;

  select jsonb_build_object('id', b.id, 'brand_name', b.brand_name, 'logo_url', b.logo_url)
    into v_brand
  from public.brands b where b.id = (v_report->>'brand_id')::uuid;

  select jsonb_build_object('id', p.id, 'display_name', p.display_name)
    into v_author
  from public.profiles p where p.id = (v_report->>'author_id')::uuid;

  -- Bump the view counter (best-effort; don't fail the request)
  begin
    update public.report_shares
       set view_count = view_count + 1
     where token = p_token;
  exception when others then
    null;
  end;

  return jsonb_build_object(
    'report',     v_report,
    'brand',      v_brand,
    'author',     v_author,
    'shared_at',  v_share.created_at,
    'expires_at', v_share.expires_at
  );
end;
$$;

-- Anyone (including anonymous clients) can call the RPC. The function
-- itself enforces every access rule.
grant execute on function public.get_shared_report(text) to anon, authenticated;
