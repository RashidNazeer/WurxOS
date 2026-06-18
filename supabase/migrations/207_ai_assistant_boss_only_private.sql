-- ============================================================
-- WurxOS v2 — Migration 207: AI assistant — Boss-only training +
-- strictly private per-user conversations.
--
-- (a) Training (persona/config + knowledge docs) was writable by boss OR
--     developer via is_ai_admin(). Restrict it to BOSS ONLY.
-- (b) Conversations/messages were readable by "ai admins" (boss/dev) — so a
--     developer could see the Boss's chats, and deleting someone else's chat
--     silently failed (RLS blocked the delete) and it reappeared on refresh.
--     Make conversations & messages STRICTLY PRIVATE to the owning user, so
--     every employee has their own assistant.
--
-- Idempotent.
-- ============================================================

-- (a) Training is Boss-only -------------------------------------------------
create or replace function public.is_ai_admin(uid uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select public.is_boss(uid);
$$;
-- (ai_config_write / ai_docs_write already gate on is_ai_admin, so this alone
--  makes both Boss-only.)

-- (b) Conversations & messages are private to their owner ------------------
drop policy if exists "ai_conv_select" on public.ai_conversations;
create policy "ai_conv_select" on public.ai_conversations for select
  using (user_id = auth.uid());

drop policy if exists "ai_msg_select" on public.ai_messages;
create policy "ai_msg_select" on public.ai_messages for select using (
  exists (select 1 from public.ai_conversations c
          where c.id = conversation_id and c.user_id = auth.uid())
);
