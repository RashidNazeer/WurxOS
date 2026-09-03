-- ============================================================
-- WurxOS v2 — Migration 347: pillar weights are dated. Changing them affects
-- the month they are changed in and every month after — never the past.
--
-- ── WHAT WENT WRONG ────────────────────────────────────────────────────────
-- performance_config is a SINGLE row (id = 1) and get_performance_composite
-- read it with `select * from performance_config where id = 1` — no reference
-- to the month being computed. So the weights were never "the weights from
-- September"; they were the weights, retroactively, for every month that has
-- ever existed.
--
-- On 2026-09-02 the Boss set performance 55 / incentives 20 / attendance 10 /
-- flags 15, intending it to start in September. It immediately re-scored
-- August (26 people moved by -5 to +1) and July, where Muhammad Fahad crossed
-- 67 -> 71 and moved from WARNING to GOOD — a closed month silently re-graded.
--
-- The table already had this idea: tl_perf_since, weekly_apc_ratings_since and
-- apc_report_since all date-scope their features. The weights never got it.
--
-- ── THE FIX ────────────────────────────────────────────────────────────────
-- A history table keyed by effective_month. Any month resolves to the most
-- recent row at or before it, so a past month keeps the weights that were in
-- force when it was lived, and a change lands on the month it is made in.
--
-- The weights are captured by a TRIGGER on performance_config rather than by
-- editing update_performance_config, so every write path is covered — the RPC,
-- a direct table update, a future admin screen — not just today's one function.
--
-- Thresholds are deliberately NOT dated: the Performance page hardcodes
-- 90/70/50 in JS (getLevel / getLevelTokens) and never reads the config
-- columns, so dating them would invent a difference between page and database
-- where none exists today.
--
-- ── THE ONE ASSUMPTION, AND HOW TO CORRECT IT ──────────────────────────────
-- performance_config is not audited and nothing recorded the pre-September
-- weights, so they cannot be recovered from data. The baseline row below uses
-- the schema defaults from mig 038 (40 / 25 / 20 / 15) as the best available
-- reference for "everything up to August".
--
-- IF THOSE WERE NOT THE VALUES IN FORCE, this single row is the only thing to
-- correct, and every historical score follows from it:
--   update public.performance_weight_history
--      set weight_performance = ?, weight_incentives = ?,
--          weight_attendance  = ?, weight_flags = ?
--    where effective_month = '0000-01';
--
-- Idempotent.
-- ============================================================

-- ── 1. The history ──────────────────────────────────────────────────────────
create table if not exists public.performance_weight_history (
  effective_month     text primary key
                        check (effective_month ~ '^[0-9]{4}-[0-9]{2}$'),
  weight_performance  numeric not null,
  weight_incentives   numeric not null,
  weight_attendance   numeric not null,
  weight_flags        numeric not null,
  updated_by          uuid references public.profiles(id) on delete set null,
  updated_at          timestamptz not null default now()
);

alter table public.performance_weight_history enable row level security;

-- Anyone who can see a performance score needs the weights behind it.
drop policy if exists pwh_select_all on public.performance_weight_history;
create policy pwh_select_all on public.performance_weight_history
  for select using (auth.uid() is not null);

-- Writes come from the trigger (security definer), never from a client.
revoke insert, update, delete on public.performance_weight_history from authenticated, anon;

-- ── 2. Seed: the era before September, then September itself ────────────────
-- '0000-01' sorts before any real month, so it is the catch-all baseline for
-- every month predating the first deliberate change.
insert into public.performance_weight_history
  (effective_month, weight_performance, weight_incentives, weight_attendance, weight_flags)
values ('0000-01', 40, 25, 20, 15)
on conflict (effective_month) do nothing;

-- September takes whatever is live in performance_config right now — that IS
-- the Boss's 2026-09-02 change, landing on the month they made it in.
insert into public.performance_weight_history
  (effective_month, weight_performance, weight_incentives, weight_attendance, weight_flags, updated_by, updated_at)
select '2026-09', c.weight_performance, c.weight_incentives, c.weight_attendance, c.weight_flags,
       c.updated_by, c.updated_at
  from public.performance_config c where c.id = 1
on conflict (effective_month) do nothing;

-- ── 3. Resolver ─────────────────────────────────────────────────────────────
create or replace function public.perf_weights_for_month(p_month text)
returns table (
  weight_performance numeric,
  weight_incentives  numeric,
  weight_attendance  numeric,
  weight_flags       numeric,
  effective_month    text
)
language sql
stable
security definer
set search_path = public
as $$
  select h.weight_performance, h.weight_incentives, h.weight_attendance,
         h.weight_flags, h.effective_month
    from public.performance_weight_history h
   where h.effective_month <= p_month
   order by h.effective_month desc
   limit 1;
$$;
revoke all on function public.perf_weights_for_month(text) from public, anon;
grant execute on function public.perf_weights_for_month(text) to authenticated, service_role;

-- ── 4. Capture every future change, whatever writes it ──────────────────────
-- Keyed on the CURRENT Karachi month, so a change made on any day of September
-- becomes September's weights and leaves August untouched.
create or replace function public.pwh_capture()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_month text := to_char((now() at time zone 'Asia/Karachi')::date, 'YYYY-MM');
begin
  if tg_op = 'UPDATE'
     and new.weight_performance is not distinct from old.weight_performance
     and new.weight_incentives  is not distinct from old.weight_incentives
     and new.weight_attendance  is not distinct from old.weight_attendance
     and new.weight_flags       is not distinct from old.weight_flags then
    return new;   -- another column moved; the weights did not
  end if;

  insert into public.performance_weight_history
    (effective_month, weight_performance, weight_incentives, weight_attendance, weight_flags, updated_by, updated_at)
  values (v_month, new.weight_performance, new.weight_incentives,
          new.weight_attendance, new.weight_flags, new.updated_by, now())
  on conflict (effective_month) do update
    set weight_performance = excluded.weight_performance,
        weight_incentives  = excluded.weight_incentives,
        weight_attendance  = excluded.weight_attendance,
        weight_flags       = excluded.weight_flags,
        updated_by         = excluded.updated_by,
        updated_at         = excluded.updated_at;
  return new;
end;
$$;

drop trigger if exists pwh_capture_trg on public.performance_config;
create trigger pwh_capture_trg
  after insert or update on public.performance_config
  for each row execute function public.pwh_capture();

-- ── 5. Make the composite use the dated weights ─────────────────────────────
-- Edited in place (pg_get_functiondef + replace) rather than reproduced: the
-- body is ~110 lines carrying the TL blend, the APC blend and mig 304's
-- switch-off safety, and retyping all of that to change four references would
-- risk far more than it fixes. Each anchor below is unique.
do $patch$
declare
  v_fn constant text := 'public.get_performance_composite(uuid, text)';
  v_old text;
  v_new text;

  v_decl_from constant text := $q$  v_cfg       public.performance_config%rowtype;$q$;
  v_decl_to   constant text := $q$  v_cfg       public.performance_config%rowtype;
  v_w_perf    numeric;
  v_w_inc     numeric;
  v_w_att     numeric;
  v_w_flg     numeric;$q$;

  v_load_from constant text := $q$  select * into v_cfg from public.performance_config where id = 1;$q$;
  v_load_to   constant text := $q$  select * into v_cfg from public.performance_config where id = 1;
  -- Weights are DATED (mig 347): a month is scored with the weights in force
  -- when it was lived, not with today's. The *_since flags stay on the live row
  -- because they already date-scope themselves.
  select w.weight_performance, w.weight_incentives, w.weight_attendance, w.weight_flags
    into v_w_perf, v_w_inc, v_w_att, v_w_flg
    from public.perf_weights_for_month(p_month) w;
  v_w_perf := coalesce(v_w_perf, v_cfg.weight_performance);
  v_w_inc  := coalesce(v_w_inc,  v_cfg.weight_incentives);
  v_w_att  := coalesce(v_w_att,  v_cfg.weight_attendance);
  v_w_flg  := coalesce(v_w_flg,  v_cfg.weight_flags);$q$;

  v_math_from constant text := $q$    v_num := v_perf * v_cfg.weight_performance; v_den := v_cfg.weight_performance;
    if v_inc is not null then v_num := v_num + v_inc * v_cfg.weight_incentives; v_den := v_den + v_cfg.weight_incentives; end if;
    v_num := v_num + v_att * v_cfg.weight_attendance; v_den := v_den + v_cfg.weight_attendance;
    v_num := v_num + v_flg * v_cfg.weight_flags;      v_den := v_den + v_cfg.weight_flags;$q$;
  v_math_to constant text := $q$    v_num := v_perf * v_w_perf; v_den := v_w_perf;
    if v_inc is not null then v_num := v_num + v_inc * v_w_inc; v_den := v_den + v_w_inc; end if;
    v_num := v_num + v_att * v_w_att; v_den := v_den + v_w_att;
    v_num := v_num + v_flg * v_w_flg; v_den := v_den + v_w_flg;$q$;
begin
  -- The stored definition carries CRLF line endings (the migration that created
  -- it had them), so a multi-line anchor joined with LF would never match. Strip
  -- the CRs first; the re-created function simply gets LF endings.
  v_old := replace(pg_get_functiondef(v_fn::regprocedure), chr(13), '');

  if position('perf_weights_for_month' in v_old) > 0 then
    raise notice 'mig 347: get_performance_composite already uses dated weights — skipping';
  else
    if (length(v_old) - length(replace(v_old, v_decl_from, ''))) / length(v_decl_from) <> 1
       or (length(v_old) - length(replace(v_old, v_load_from, ''))) / length(v_load_from) <> 1
       or (length(v_old) - length(replace(v_old, v_math_from, ''))) / length(v_math_from) <> 1 then
      raise exception 'mig 347: expected exactly one of each anchor in % — refusing to guess.', v_fn;
    end if;

    v_new := replace(v_old, v_decl_from, v_decl_to);
    v_new := replace(v_new, v_load_from, v_load_to);
    v_new := replace(v_new, v_math_from, v_math_to);
    execute v_new;

    if position('perf_weights_for_month' in pg_get_functiondef(v_fn::regprocedure)) = 0 then
      raise exception 'mig 347: % was not updated', v_fn;
    end if;
    -- Check the ARITHMETIC, not the mere presence of v_cfg.weight_ — the
    -- replacement deliberately keeps those as the coalesce fallback for the
    -- case where a month somehow resolves to no history row.
    if position('v_num := v_perf * v_cfg.weight_performance' in pg_get_functiondef(v_fn::regprocedure)) > 0 then
      raise exception 'mig 347: % still computes the composite from undated weights', v_fn;
    end if;
    if position('v_num := v_perf * v_w_perf' in pg_get_functiondef(v_fn::regprocedure)) = 0 then
      raise exception 'mig 347: % is not using the dated weights in its arithmetic', v_fn;
    end if;
    if position('tl_reporting_score' in pg_get_functiondef(v_fn::regprocedure)) = 0
       or position('apc_checkpoint_score' in pg_get_functiondef(v_fn::regprocedure)) = 0 then
      raise exception 'mig 347: % lost the TL or APC blend', v_fn;
    end if;
    raise notice 'mig 347: get_performance_composite now scores a month with that month''s weights';
  end if;
end;
$patch$;

-- ── 6. Verification ─────────────────────────────────────────────────────────
do $verify$
declare
  r      record;
  v_aug  numeric;
  v_sep  numeric;
begin
  for r in select effective_month, weight_performance p, weight_incentives i,
                  weight_attendance a, weight_flags f
             from public.performance_weight_history order by effective_month
  loop
    raise notice 'mig 347: from % -> performance %, incentives %, attendance %, flags %',
      case when r.effective_month = '0000-01' then 'the beginning' else r.effective_month end,
      r.p, r.i, r.a, r.f;
  end loop;

  select weight_attendance into v_aug from public.perf_weights_for_month('2026-08');
  select weight_attendance into v_sep from public.perf_weights_for_month('2026-09');
  if v_aug is null or v_sep is null then
    raise exception 'mig 347: a month failed to resolve to any weight row';
  end if;
  if v_aug = v_sep then
    raise notice 'mig 347: NOTE August and September resolve to the same weights — no change had been made yet';
  else
    raise notice 'mig 347: August resolves to attendance %, September to attendance % — the past is frozen', v_aug, v_sep;
  end if;
end;
$verify$;
