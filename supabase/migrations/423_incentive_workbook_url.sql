-- ============================================================
-- WurxOS v2 — Migration 423: remember where the brand workbook lives.
--
-- The OL maintains one Google Sheet of brand targets. Until now the incentive
-- picker made them find and upload that file every time they built a plan. The
-- sheet is published to the web, so the app can fetch it instead — but only if
-- it knows the address. This stores it once.
--
-- ── WHY NOT JUST WIDEN app_config ──────────────────────────────────────────
-- app_config is Boss-only (mig 016: select and update, and no insert policy at
-- all) and it holds things like leave_quota_default. Opening the whole table to
-- OLs to share one string would hand them the lot. These policies name the ONE
-- key instead, so an OL gains exactly this row and nothing else. Policies OR
-- together, so the Boss's existing access is untouched.
--
-- Developers are included for the same reason they are everywhere else here:
-- they maintain this screen and cannot test it otherwise.
--
-- The URL is not a secret — the sheet is published to the web by definition,
-- and anyone who can open the incentive editor can already see every target in
-- it. It is stored as config, not as a credential.
--
-- Idempotent.
-- ============================================================

create or replace function public.can_manage_incentive_workbook()
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select public.is_boss(auth.uid())
      or exists (
        select 1 from public.profiles p
         where p.id = auth.uid()
           and p.role in ('ol', 'developer')
           and p.is_active = true
           and p.deleted_at is null
      );
$$;
grant execute on function public.can_manage_incentive_workbook() to authenticated;

drop policy if exists "app_config_workbook_url_select" on public.app_config;
create policy "app_config_workbook_url_select"
  on public.app_config for select
  using (key = 'incentive_workbook_url' and public.can_manage_incentive_workbook());

drop policy if exists "app_config_workbook_url_insert" on public.app_config;
create policy "app_config_workbook_url_insert"
  on public.app_config for insert
  with check (key = 'incentive_workbook_url' and public.can_manage_incentive_workbook());

drop policy if exists "app_config_workbook_url_update" on public.app_config;
create policy "app_config_workbook_url_update"
  on public.app_config for update
  using (key = 'incentive_workbook_url' and public.can_manage_incentive_workbook())
  with check (key = 'incentive_workbook_url' and public.can_manage_incentive_workbook());

-- Seed the sheet the OL is using today, so the picker works the moment this
-- ships. Changing it later is a normal edit from the picker; `do nothing` means
-- re-running this never overwrites a newer address.
--
-- app_config is (key text, value text) — there is no jsonb column and no
-- updated_at. Rows that need structure serialise JSON into that text column;
-- leave_quota_default already does exactly this. So the value is a JSON STRING,
-- not a jsonb expression, which would not assign to a text column at all.
insert into public.app_config (key, value)
values (
  'incentive_workbook_url',
  '{"url":"https://docs.google.com/spreadsheets/d/e/2PACX-1vTcMypy4hfxxLuepCJSzcjQ-8mQc5iV--YLyMu_j-FvogxNyxsjTzQ7OK4MoQ5ZxuU4dm8Ylg4jdd-P/pub?output=xlsx","label":"Brand targets (published Google Sheet)"}'
)
on conflict (key) do nothing;

-- ---- verification ----------------------------------------------------------
do $verify$
declare n int;
begin
  select count(*) into n from public.app_config where key = 'incentive_workbook_url';
  if n <> 1 then raise exception 'expected the workbook url row to exist, found %', n; end if;

  -- The value must be readable JSON carrying a url, or the picker gets nothing.
  perform (select (value::jsonb) ->> 'url' from public.app_config where key = 'incentive_workbook_url');
  if (select nullif((value::jsonb) ->> 'url', '') from public.app_config where key = 'incentive_workbook_url') is null then
    raise exception 'the workbook url row does not hold a readable url';
  end if;

  select count(*) into n from pg_policies
   where schemaname = 'public' and tablename = 'app_config'
     and policyname like 'app_config_workbook_url_%';
  if n <> 3 then raise exception 'expected 3 workbook-url policies, found %', n; end if;

  raise notice '423 verified: workbook url stored, and scoped to that one key.';
end $verify$;
