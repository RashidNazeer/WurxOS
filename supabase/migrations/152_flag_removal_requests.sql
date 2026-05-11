-- ============================================================
-- WurxOS v2 — Migration 152: flag-removal request flow
--
-- Adds a Boss-approved workflow for removing performance flags:
--   1. OL who CREATED a flag may submit a removal request with a
--      short reason.
--   2. The request goes to the Boss queue.
--   3. Boss approves → the flag is hard-deleted, and the OL +
--      flagged user are notified. The score for the flag's month
--      recalculates automatically because calcFlagsScore sums over
--      existing rows only.
--   4. Boss rejects → request stays decided (rejected); flag remains.
--   5. Boss can also delete flags directly without going through the
--      request flow (handled in flag_remove_direct()).
--
-- Permission rules:
--   * Only the flag's `created_by` (when role = 'ol') may submit a
--     removal request via flag_removal_request().
--   * Only Boss may decide via flag_removal_decide() OR delete
--     directly via flag_remove_direct().
--   * RLS: requests are visible to the requesting OL, to Boss, and
--     to the flagged user (so they see the pending state on their
--     own flag).
-- ============================================================

-- --------------------------------------------------------------
-- 1. flag_removal_requests table
-- --------------------------------------------------------------
create table if not exists public.flag_removal_requests (
  id            uuid primary key default gen_random_uuid(),
  flag_id       uuid not null references public.performance_flags(id) on delete cascade,
  user_id       uuid not null references public.profiles(id) on delete cascade, -- the flagged user
  requested_by  uuid not null references public.profiles(id) on delete restrict,
  reason        text not null,
  status        text not null default 'pending'
                check (status in ('pending','approved','rejected')),
  decided_by    uuid references public.profiles(id) on delete set null,
  decided_at    timestamptz,
  decision_note text,
  created_at    timestamptz not null default now()
);

create index if not exists flag_removal_flag_idx       on public.flag_removal_requests(flag_id);
create index if not exists flag_removal_status_idx     on public.flag_removal_requests(status);
create index if not exists flag_removal_requester_idx  on public.flag_removal_requests(requested_by, created_at desc);
create index if not exists flag_removal_user_idx       on public.flag_removal_requests(user_id, created_at desc);

-- Only one pending request per flag at a time. Partial unique index
-- so historical decided rows don't block new requests if Boss ever
-- rejects and the OL wants to retry.
create unique index if not exists flag_removal_one_pending_per_flag
  on public.flag_removal_requests(flag_id)
  where status = 'pending';

-- --------------------------------------------------------------
-- 2. RLS
-- --------------------------------------------------------------
alter table public.flag_removal_requests enable row level security;

drop policy if exists "flag_removal_select" on public.flag_removal_requests;
create policy "flag_removal_select"
  on public.flag_removal_requests for select
  using (
    auth.uid() = requested_by
    or auth.uid() = user_id
    or public.is_boss(auth.uid())
  );

-- No direct INSERT / UPDATE / DELETE from clients — everything routes
-- through the security-definer RPCs below.
drop policy if exists "flag_removal_no_direct_write" on public.flag_removal_requests;
create policy "flag_removal_no_direct_write"
  on public.flag_removal_requests for all
  using (false)
  with check (false);

-- --------------------------------------------------------------
-- 3. RPC: flag_removal_request — OL submits a removal request
-- --------------------------------------------------------------
create or replace function public.flag_removal_request(
  p_flag_id uuid,
  p_reason  text
)
returns public.flag_removal_requests
language plpgsql
security definer
set search_path = public
as $$
declare
  v_me         uuid := auth.uid();
  v_my_role    text;
  v_flag       public.performance_flags;
  v_req        public.flag_removal_requests;
begin
  if v_me is null then raise exception 'not authenticated'; end if;

  if p_reason is null or length(trim(p_reason)) < 3 then
    raise exception 'reason is required (min 3 characters)';
  end if;

  select role into v_my_role from public.profiles
   where id = v_me and is_active = true;
  if v_my_role is null then raise exception 'profile not found or inactive'; end if;

  select * into v_flag from public.performance_flags where id = p_flag_id;
  if not found then raise exception 'flag not found'; end if;

  -- Only the OL who created the flag may submit a removal request.
  -- Boss does NOT use this RPC — they delete directly.
  if v_my_role <> 'ol' then
    raise exception 'only OLs may request flag removal (use direct delete if you are Boss)';
  end if;
  if v_flag.created_by is null or v_flag.created_by <> v_me then
    raise exception 'only the OL who created the flag may request its removal';
  end if;

  -- Block duplicate pending requests early (the partial unique index is
  -- the authoritative gate, but this gives a friendlier error).
  if exists (
    select 1 from public.flag_removal_requests
     where flag_id = p_flag_id and status = 'pending'
  ) then
    raise exception 'a removal request for this flag is already pending';
  end if;

  insert into public.flag_removal_requests (flag_id, user_id, requested_by, reason)
  values (p_flag_id, v_flag.user_id, v_me, trim(p_reason))
  returning * into v_req;

  -- Notify Boss(es).
  perform public.emit_notification(
    b.id, v_me, 'flag_removal', 'flag_removal.requested',
    'Flag removal request',
    coalesce(public.profile_display_name(v_me), 'An OL')
      || ' requested removal of a flag on '
      || coalesce(public.profile_display_name(v_flag.user_id), 'a teammate'),
    'flag_removal_request', v_req.id, '/performance'
  )
    from public.profiles b
   where b.role = 'boss' and b.is_active = true;

  return v_req;
end;
$$;

grant execute on function public.flag_removal_request(uuid, text) to authenticated;

-- --------------------------------------------------------------
-- 4. RPC: flag_removal_decide — Boss approves or rejects
-- --------------------------------------------------------------
create or replace function public.flag_removal_decide(
  p_request_id uuid,
  p_action     text,
  p_note       text default null
)
returns public.flag_removal_requests
language plpgsql
security definer
set search_path = public
as $$
declare
  v_me   uuid := auth.uid();
  v_req  public.flag_removal_requests;
  v_flag public.performance_flags;
begin
  if v_me is null              then raise exception 'not authenticated'; end if;
  if not public.is_boss(v_me)  then raise exception 'only Boss may decide flag-removal requests'; end if;
  if p_action not in ('approve','reject') then raise exception 'invalid action: %', p_action; end if;

  select * into v_req from public.flag_removal_requests
   where id = p_request_id for update;
  if not found                     then raise exception 'request not found'; end if;
  if v_req.status <> 'pending'     then raise exception 'request already decided (status=%)', v_req.status; end if;

  -- Look up the flag BEFORE we delete it so we can populate the
  -- notification with its month.
  select * into v_flag from public.performance_flags where id = v_req.flag_id;

  update public.flag_removal_requests
     set status        = case p_action when 'approve' then 'approved' else 'rejected' end,
         decided_by    = v_me,
         decided_at    = now(),
         decision_note = p_note
   where id = p_request_id
   returning * into v_req;

  if p_action = 'approve' then
    -- Hard-delete the flag. calcFlagsScore filters by month from the
    -- existing rows, so the affected month's score auto-recovers.
    delete from public.performance_flags where id = v_req.flag_id;

    -- Notify OL (requester) and the flagged user.
    perform public.emit_notification(
      v_req.requested_by, v_me, 'flag_removal', 'flag_removal.approved',
      'Flag removal approved',
      'Boss approved your request to remove the flag on '
        || coalesce(public.profile_display_name(v_req.user_id), 'a teammate'),
      'flag_removal_request', v_req.id, '/performance'
    );
    perform public.emit_notification(
      v_req.user_id, v_me, 'flag_removal', 'flag_removal.applied',
      'A flag was removed',
      'A flag on your performance was removed by Boss approval.',
      'flag_removal_request', v_req.id, '/performance'
    );
  else
    -- Rejected — notify OL only.
    perform public.emit_notification(
      v_req.requested_by, v_me, 'flag_removal', 'flag_removal.rejected',
      'Flag removal rejected',
      'Boss rejected your request to remove the flag on '
        || coalesce(public.profile_display_name(v_req.user_id), 'a teammate')
        || coalesce('. Reason: ' || p_note, ''),
      'flag_removal_request', v_req.id, '/performance'
    );
  end if;

  return v_req;
end;
$$;

grant execute on function public.flag_removal_decide(uuid, text, text) to authenticated;

-- --------------------------------------------------------------
-- 5. RPC: flag_remove_direct — Boss removes without the request flow
-- --------------------------------------------------------------
create or replace function public.flag_remove_direct(p_flag_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_me   uuid := auth.uid();
  v_flag public.performance_flags;
begin
  if v_me is null             then raise exception 'not authenticated'; end if;
  if not public.is_boss(v_me) then raise exception 'only Boss may delete flags directly'; end if;

  select * into v_flag from public.performance_flags where id = p_flag_id;
  if not found then raise exception 'flag not found'; end if;

  delete from public.performance_flags where id = p_flag_id;

  -- Notify the flagged user.
  perform public.emit_notification(
    v_flag.user_id, v_me, 'flag_removal', 'flag_removal.applied',
    'A flag was removed',
    'A flag on your performance was removed by Boss.',
    'flag', p_flag_id, '/performance'
  );
end;
$$;

grant execute on function public.flag_remove_direct(uuid) to authenticated;
