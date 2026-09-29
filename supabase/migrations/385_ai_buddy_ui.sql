-- ============================================================
-- 385 — Wurx Buddy UI backend (ui-design.md §6, §7).
--
--   ai_messages.status           generating | done | error. The assistant row
--                                is written up-front as 'generating' and the
--                                function finishes it even if the browser has
--                                gone; the SSE stream is only a view of it.
--   ai_conversations.last_read_at / last_reply_at   unread = last_reply_at > coalesce(last_read_at, '-infinity')
--   ai_conversations.pinned, title_edited
--   ai_assistant_config.allowed_roles  who may use the assistant; widening
--                                it is a config change, not a redeploy.
--
-- RLS (owner only, as mig 207):
--   ai_conversations  select / update / delete own rows; clients no longer
--                     INSERT (the function creates conversations). Clients
--                     may update only title, pinned, last_read_at (column
--                     grants); a title change by a client sets title_edited.
--                     Delete cascades to the messages (FK on delete cascade).
--   ai_messages       select own (unchanged); INSERT stays refused; no
--                     client UPDATE or DELETE policy exists.
-- Realtime: both tables join supabase_realtime; RLS limits delivery to the
-- owner (supabase_realtime_admin needs SELECT to evaluate it, mig 136).
-- Idempotent.
-- ============================================================

alter table public.ai_messages
  add column if not exists status text not null default 'done';
do $$ begin
  alter table public.ai_messages add constraint ai_messages_status_check check (status in ('generating', 'done', 'error'));
exception when duplicate_object then null; end $$;

alter table public.ai_conversations
  add column if not exists last_read_at  timestamptz,
  add column if not exists last_reply_at timestamptz,
  add column if not exists pinned        boolean not null default false,
  add column if not exists title_edited  boolean not null default false;

alter table public.ai_assistant_config
  add column if not exists allowed_roles text[] not null default '{boss}';

-- ── RLS: conversations ──────────────────────────────────────────────────
drop policy if exists "ai_conv_modify" on public.ai_conversations;
drop policy if exists "ai_conv_update" on public.ai_conversations;
create policy "ai_conv_update" on public.ai_conversations for update
  using (user_id = auth.uid()) with check (user_id = auth.uid());
drop policy if exists "ai_conv_delete" on public.ai_conversations;
create policy "ai_conv_delete" on public.ai_conversations for delete
  using (user_id = auth.uid());

-- The platform default granted everything, TRUNCATE included (which RLS does
-- not cover), to anon and authenticated.
revoke all on public.ai_conversations from anon;
revoke insert, update, truncate, references, trigger on public.ai_conversations from authenticated;
grant update (title, pinned, last_read_at) on public.ai_conversations to authenticated;
grant select, delete on public.ai_conversations to authenticated;

-- A rename from the app marks the title as the user's own, so auto-titling
-- never overwrites it. The function (service role) titles freely.
create or replace function public.ai_conv_title_edited() returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.title is distinct from old.title and coalesce(auth.role(), '') <> 'service_role' then
    new.title_edited := true;
  end if;
  return new;
end;
$$;
revoke execute on function public.ai_conv_title_edited() from public, anon, authenticated;
drop trigger if exists ai_conv_title_edited on public.ai_conversations;
create trigger ai_conv_title_edited before update of title on public.ai_conversations
  for each row execute function public.ai_conv_title_edited();

-- ── RLS: messages (the function is the only writer) ─────────────────────
revoke all on public.ai_messages from anon;
revoke insert, update, delete, truncate, references, trigger on public.ai_messages from authenticated;
grant select on public.ai_messages to authenticated;

create index if not exists ai_msg_generating_idx on public.ai_messages (conversation_id) where status = 'generating';

-- ── Realtime ─────────────────────────────────────────────────────────────
do $$
declare t text;
begin
  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then return; end if;
  foreach t in array array['ai_messages', 'ai_conversations'] loop
    if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
    if exists (select 1 from pg_roles where rolname = 'supabase_realtime_admin') then
      execute format('grant select on public.%I to supabase_realtime_admin', t);
    end if;
  end loop;
end;
$$;
