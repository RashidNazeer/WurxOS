-- ============================================================
-- Migration 098 — Normalize leave_quota across all profiles
--
-- v1's leave model used {wfh:4, casual:2, medical_emergency:2}.
-- v2's model is {wfh:2, medical:1, emergency:1} (monthly).
-- During the v1→v2 import we copied v1's leave_quota verbatim,
-- so 38 profiles still carry the v1-shaped quota.
--
-- Fix: drop legacy keys (casual, medical_emergency, wfh override)
-- and force every profile to {wfh:2, medical:1, emergency:1}.
--
-- Notes on what this does NOT do:
--   * Doesn't touch existing leave_requests rows. Those keep their
--     paid_days/unpaid_days from when they were submitted under v1.
--     For users who've already taken leaves this month, the v2 UI
--     will compute remaining = max(quota - consumed) and may show
--     a negative balance — by design (per Boss decision: requests
--     stay open, paid/unpaid split makes the over-cap usage visible).
--   * Doesn't change the schema. profiles.leave_quota is still jsonb;
--     we just rewrite the contents.
-- ============================================================

update public.profiles
   set leave_quota = jsonb_build_object('wfh', 2, 'medical', 1, 'emergency', 1)
 where leave_quota is null
    or leave_quota <> jsonb_build_object('wfh', 2, 'medical', 1, 'emergency', 1);

-- Also normalize the global default in app_config so any newly-created
-- profile (via the trigger) starts with the right shape.
insert into public.app_config (key, value)
values ('leave_quota_default', '{"wfh":2,"medical":1,"emergency":1}')
on conflict (key) do update set value = excluded.value;
