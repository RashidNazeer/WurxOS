-- ============================================================
-- 311 — APC GMV-on-clock-in gate
--
-- Before an APC clocks in, they must enter each ACTIVE brand's month-to-date
-- GMV (1st -> yesterday, Asia/Karachi). The value OVERWRITES that brand's
-- gmv_achieved in brand_monthly_metrics for the current month, so OL/Boss get a
-- live achieved-vs-target snapshot in Brand Analytics. Gate fires once per PKT
-- day, only for role='apc', only when they have >=1 active brand, and not on the
-- 1st (empty range). APC with no active brand clocks in normally.
--
-- APCs can't write brand_monthly_metrics directly (RLS = boss/active-ol only),
-- so a SECURITY DEFINER RPC validates the APC<->brand assignment then writes.
-- ============================================================

-- 1. Per-day submission log — the once-per-day gate flag + an audit trail.
create table if not exists public.apc_gmv_submissions (
  apc_id      uuid not null references public.profiles(id) on delete cascade,
  entry_date  date not null,                                    -- Asia/Karachi calendar day
  month_key   text not null check (month_key ~ '^\d{4}-\d{2}$'),
  range_start date not null,
  range_end   date not null,
  entries     jsonb not null default '[]'::jsonb,               -- [{ brand_id, gmv }]
  created_at  timestamptz not null default now(),
  primary key (apc_id, entry_date)
);

alter table public.apc_gmv_submissions enable row level security;

drop policy if exists ags_select on public.apc_gmv_submissions;
create policy ags_select on public.apc_gmv_submissions for select
  using (
    apc_id = auth.uid()
    or public.is_boss(auth.uid())
    or exists (select 1 from public.profiles p
                where p.id = auth.uid() and p.role in ('ol','developer') and p.is_active)
  );
-- No INSERT/UPDATE/DELETE policy on purpose: only the SECURITY DEFINER RPC writes.
grant select on public.apc_gmv_submissions to authenticated;

-- 2. Status probe — called at APC clock-in. Server computes today/month in PKT.
create or replace function public.apc_gmv_status()
returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_me        uuid := auth.uid();
  v_role      text;
  v_today     date;
  v_dom       int;
  v_month     text;
  v_brands    jsonb;
  v_submitted boolean;
  v_needs     boolean;
begin
  if v_me is null then return jsonb_build_object('needs_entry', false); end if;
  select role into v_role from public.profiles where id = v_me and is_active = true;
  v_today := (now() at time zone 'Asia/Karachi')::date;
  v_dom   := extract(day from v_today)::int;
  v_month := to_char(v_today, 'YYYY-MM');

  select coalesce(jsonb_agg(
           jsonb_build_object('id', b.id, 'name', b.brand_name, 'currency', b.currency)
           order by b.brand_name), '[]'::jsonb)
    into v_brands
    from public.brand_assignments ba
    join public.brands b on b.id = ba.brand_id and b.status = 'active'
   where ba.user_id = v_me;

  select exists(select 1 from public.apc_gmv_submissions s
                 where s.apc_id = v_me and s.entry_date = v_today)
    into v_submitted;

  v_needs := (v_role = 'apc')
             and (jsonb_array_length(v_brands) > 0)
             and (v_dom > 1)          -- on the 1st, range (1 -> yesterday) is empty -> skip
             and (not v_submitted);

  return jsonb_build_object(
    'needs_entry',     v_needs,
    'role',            v_role,
    'today',           v_today,
    'month_key',       v_month,
    'range_start',     date_trunc('month', v_today)::date,
    'range_end',       (v_today - 1),
    'submitted_today', v_submitted,
    'brands',          v_brands
  );
end;
$$;
revoke all on function public.apc_gmv_status() from public, anon;
grant execute on function public.apc_gmv_status() to authenticated;

-- 3. Submit — overwrite each assigned ACTIVE brand's gmv_achieved for the month,
--    and log the submission (once per PKT day; an idempotent re-submit updates).
create or replace function public.apc_submit_gmv(
  p_month_key   text,
  p_range_start date,
  p_range_end   date,
  p_entries     jsonb
) returns void
language plpgsql security definer set search_path = public
as $$
declare
  v_me    uuid := auth.uid();
  v_role  text;
  v_today date;
  v_entry jsonb;
  v_brand uuid;
  v_gmv   numeric;
begin
  if v_me is null then raise exception 'not authenticated'; end if;
  select role into v_role from public.profiles where id = v_me and is_active = true;
  if v_role is null then raise exception 'inactive user'; end if;
  if v_role <> 'apc' then raise exception 'only APCs submit GMV at clock-in'; end if;
  if p_month_key !~ '^\d{4}-\d{2}$' then raise exception 'bad month_key'; end if;
  if p_entries is null or jsonb_typeof(p_entries) <> 'array' or jsonb_array_length(p_entries) = 0 then
    raise exception 'no GMV entries';
  end if;

  v_today := (now() at time zone 'Asia/Karachi')::date;

  for v_entry in select value from jsonb_array_elements(p_entries)
  loop
    v_brand := (v_entry->>'brand_id')::uuid;
    v_gmv   := (v_entry->>'gmv')::numeric;
    if v_gmv is null or v_gmv < 0 then raise exception 'invalid GMV for brand %', v_brand; end if;

    -- caller must be assigned to this ACTIVE brand
    if not exists (
      select 1 from public.brand_assignments ba
        join public.brands b on b.id = ba.brand_id and b.status = 'active'
       where ba.brand_id = v_brand and ba.user_id = v_me
    ) then
      raise exception 'not assigned to brand %', v_brand;
    end if;

    insert into public.brand_monthly_metrics (brand_id, month_key, gmv_achieved, updated_at, updated_by)
    values (v_brand, p_month_key, v_gmv, now(), v_me)
    on conflict (brand_id, month_key) do update
      set gmv_achieved = excluded.gmv_achieved,
          updated_at   = now(),
          updated_by   = v_me;
  end loop;

  insert into public.apc_gmv_submissions (apc_id, entry_date, month_key, range_start, range_end, entries, created_at)
  values (v_me, v_today, p_month_key, p_range_start, p_range_end, p_entries, now())
  on conflict (apc_id, entry_date) do update
    set month_key   = excluded.month_key,
        range_start = excluded.range_start,
        range_end   = excluded.range_end,
        entries     = excluded.entries,
        created_at  = now();
end;
$$;
revoke all on function public.apc_submit_gmv(text, date, date, jsonb) from public, anon;
grant execute on function public.apc_submit_gmv(text, date, date, jsonb) to authenticated;
