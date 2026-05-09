-- ============================================================
-- 102 — Allow requester to withdraw a rejected leave request
--
-- Background: v1 added a "Withdraw" button so users can clear out
-- their own rejected requests from history. v2's leave_update RLS
-- only allowed requester self-edits when status='pending', so this
-- migration extends the requester branch to also permit transitioning
-- rejected → cancelled.
--
-- Quota math is unaffected: consumed_leaves only sums status='approved'
-- rows, so neither rejected nor cancelled rows have ever counted.
-- ============================================================

drop policy if exists "leave_update" on public.leave_requests;
create policy "leave_update"
  on public.leave_requests for update
  using (
    -- Requester can edit their own row while it is still actionable
    -- (pending) or after it has been rejected (to withdraw it).
    (auth.uid() = requester_id and status in ('pending', 'rejected'))
    or auth.uid() = public.leave_current_approver(id)
    or public.is_boss(auth.uid())
    or exists (
      select 1 from public.profiles p
      where p.id = auth.uid() and p.role in ('developer') and p.is_active = true
    )
  )
  with check (
    -- Requester writes are still tightly bounded — they can only
    -- transition into pending (initial submit) or cancelled (withdraw).
    -- They cannot mark themselves approved or change a decision.
    (auth.uid() = requester_id and status in ('pending', 'cancelled'))
    or auth.uid() = public.leave_current_approver(id)
    or public.is_boss(auth.uid())
    or exists (
      select 1 from public.profiles p
      where p.id = auth.uid() and p.role in ('developer') and p.is_active = true
    )
  );
