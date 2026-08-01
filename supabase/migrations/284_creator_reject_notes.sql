-- ============================================================
-- 284 — Creator Library: reject (not just approve) + a decision note.
--
-- TL/OL can now REJECT a creator, and attach an optional note to any
-- approve/reject. Each level (tl / ol) records its own decision independently:
--   approved  → *_approved_by / *_approved_at set, *_rejected_* cleared
--   rejected  → *_rejected_by / *_rejected_at set, *_approved_* cleared
--   clear     → both cleared (back to pending for that level)
-- Derived status (client): ol_approved → ol; ol_rejected → rejected;
-- tl_approved → tl (awaiting OL); tl_rejected → rejected; else pending.
-- (OL is the top level, so its decision wins over the TL's.)
-- ============================================================

alter table public.creator_approvals
  add column if not exists tl_rejected_by uuid references public.profiles(id) on delete set null,
  add column if not exists tl_rejected_at timestamptz,
  add column if not exists ol_rejected_by uuid references public.profiles(id) on delete set null,
  add column if not exists ol_rejected_at timestamptz,
  add column if not exists tl_note text,
  add column if not exists ol_note text;

-- Replace the approve-only toggle with a 3-way decision (+ optional note).
drop function if exists public.creator_set_approval(uuid, text, text, boolean);
create or replace function public.creator_set_approval(
  p_brand uuid, p_handle text, p_level text, p_decision text, p_note text default null
) returns public.creator_approvals
language plpgsql security definer set search_path = public
as $$
declare
  v_me     uuid := auth.uid();
  v_owner  uuid;
  v_handle text := lower(regexp_replace(trim(coalesce(p_handle, '')), '^@+', ''));
  v_note   text := nullif(trim(coalesce(p_note, '')), '');
  v_is_ol  boolean;
  v_is_tl  boolean;
  v_row    public.creator_approvals;
begin
  if v_handle = '' then raise exception 'handle required'; end if;
  if p_level not in ('tl', 'ol') then raise exception 'bad level'; end if;
  if p_decision not in ('approve', 'reject', 'clear') then raise exception 'bad decision'; end if;
  select owner_id into v_owner from public.brands where id = p_brand;
  if not found then raise exception 'brand not found'; end if;
  if not public.can_view_brand(v_owner, p_brand, v_me) then raise exception 'no access to this brand'; end if;

  v_is_ol := public.is_boss(v_me) or exists (
    select 1 from public.profiles p where p.id = v_me and p.role = 'ol' and p.is_active);
  -- The owner TL (or any OL/Boss) may set the TL-level decision.
  v_is_tl := v_is_ol or (v_owner = v_me and exists (
    select 1 from public.profiles p where p.id = v_me and p.role = 'tl' and p.is_active));

  if p_level = 'ol' and not v_is_ol then raise exception 'only OL/Boss can set OL approval'; end if;
  if p_level = 'tl' and not v_is_tl then raise exception 'only the owner TL or OL/Boss can set TL approval'; end if;

  insert into public.creator_approvals (brand_id, tiktok_handle)
  values (p_brand, v_handle)
  on conflict (brand_id, tiktok_handle) do nothing;

  update public.creator_approvals set
    tl_approved_by = case when p_level='tl' then (case when p_decision='approve' then v_me  else null end) else tl_approved_by end,
    tl_approved_at = case when p_level='tl' then (case when p_decision='approve' then now() else null end) else tl_approved_at end,
    tl_rejected_by = case when p_level='tl' then (case when p_decision='reject'  then v_me  else null end) else tl_rejected_by end,
    tl_rejected_at = case when p_level='tl' then (case when p_decision='reject'  then now() else null end) else tl_rejected_at end,
    tl_note        = case when p_level='tl' then v_note else tl_note end,
    ol_approved_by = case when p_level='ol' then (case when p_decision='approve' then v_me  else null end) else ol_approved_by end,
    ol_approved_at = case when p_level='ol' then (case when p_decision='approve' then now() else null end) else ol_approved_at end,
    ol_rejected_by = case when p_level='ol' then (case when p_decision='reject'  then v_me  else null end) else ol_rejected_by end,
    ol_rejected_at = case when p_level='ol' then (case when p_decision='reject'  then now() else null end) else ol_rejected_at end,
    ol_note        = case when p_level='ol' then v_note else ol_note end,
    updated_at = now()
  where brand_id = p_brand and tiktok_handle = v_handle
  returning * into v_row;

  -- Feedback to the brand's assigned IPC(s) on a decision (approve OR reject).
  if p_decision in ('approve', 'reject') then
    perform public.emit_notification(ba.user_id, v_me, 'creator_library',
      case when p_decision = 'approve' then 'creator_library.approved' else 'creator_library.rejected' end,
      case when p_decision = 'approve' then 'Creator approved' else 'Creator rejected' end,
      (case when p_level = 'ol' then 'Operation Lead' else 'Team Lead' end)
        || (case when p_decision = 'approve' then ' approved @' else ' rejected @' end) || v_handle
        || coalesce(' — ' || v_note, ''),
      'brand', p_brand, '/creator-library?brand=' || p_brand)
    from public.brand_assignments ba
    join public.profiles p on p.id = ba.user_id
    where ba.brand_id = p_brand and p.role = 'ipc' and p.is_active;
  end if;

  return v_row;
end;
$$;
grant execute on function public.creator_set_approval(uuid, text, text, text, text) to authenticated;
