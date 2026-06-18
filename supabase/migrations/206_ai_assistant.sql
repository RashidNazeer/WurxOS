-- ============================================================
-- WurxOS v2 — Migration 206: AI Support Assistant.
--
-- A support chatbot all employees can use ("How do I apply for leave?").
-- Answers are grounded (RAG) in Boss-curated app knowledge + a Boss-set
-- persona, with persistent per-user conversation memory. The model is
-- called server-side via the `ai-chat` edge function (holds GPT_TOKEN);
-- clients never insert assistant messages directly.
--
-- Tables:
--   ai_assistant_config  — singleton: persona/system prompt, model, greeting
--   ai_assistant_docs    — Boss-curated knowledge the bot answers from
--   ai_conversations     — one per chat thread, owned by a user
--   ai_messages          — the turns (user/assistant)
--
-- Idempotent.
-- ============================================================

-- helper: is the caller boss/developer (the "trainer" roles)
create or replace function public.is_ai_admin(uid uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select public.is_boss(uid)
    or exists (select 1 from public.profiles p where p.id = uid and p.role = 'developer' and p.is_active = true);
$$;
grant execute on function public.is_ai_admin(uuid) to authenticated;

-- 1. Config (singleton) -----------------------------------------------------
create table if not exists public.ai_assistant_config (
  id         int primary key default 1,
  persona    text not null default
    'You are the WurxOS Assistant, a friendly internal support bot for employees of Wurx Media (a TikTok Shop affiliate agency) using the WurxOS app. Help staff with how to use WurxOS — leave requests, attendance, reporting, tasks, agenda meetings, brands, etc. Answer ONLY from the knowledge provided to you; if it is not covered, say you do not have that information yet and suggest they ask their Team Lead or the Boss. Stay strictly on WurxOS and work topics — politely decline anything unrelated. Be concise, practical and warm. Use the user''s name and tailor guidance to their role when relevant.',
  model      text not null default 'openai/gpt-4o-mini',
  greeting   text not null default 'Hi! I''m your WurxOS assistant. Ask me anything about using the app — leave, attendance, reporting, and more.',
  enabled    boolean not null default true,
  updated_by uuid references public.profiles(id) on delete set null,
  updated_at timestamptz not null default now(),
  constraint ai_assistant_config_singleton check (id = 1)
);
insert into public.ai_assistant_config (id) values (1) on conflict (id) do nothing;

alter table public.ai_assistant_config enable row level security;
drop policy if exists "ai_config_select" on public.ai_assistant_config;
create policy "ai_config_select" on public.ai_assistant_config for select using (auth.uid() is not null);
drop policy if exists "ai_config_write" on public.ai_assistant_config;
create policy "ai_config_write" on public.ai_assistant_config for all
  using (public.is_ai_admin(auth.uid())) with check (public.is_ai_admin(auth.uid()));

-- 2. Knowledge docs ---------------------------------------------------------
create table if not exists public.ai_assistant_docs (
  id         uuid primary key default gen_random_uuid(),
  title      text not null,
  content    text not null,
  is_active  boolean not null default true,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists ai_docs_active_idx on public.ai_assistant_docs(is_active, updated_at desc);

alter table public.ai_assistant_docs enable row level security;
drop policy if exists "ai_docs_select" on public.ai_assistant_docs;
create policy "ai_docs_select" on public.ai_assistant_docs for select using (auth.uid() is not null);
drop policy if exists "ai_docs_write" on public.ai_assistant_docs;
create policy "ai_docs_write" on public.ai_assistant_docs for all
  using (public.is_ai_admin(auth.uid())) with check (public.is_ai_admin(auth.uid()));

-- 3. Conversations ----------------------------------------------------------
create table if not exists public.ai_conversations (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references public.profiles(id) on delete cascade,
  title      text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists ai_conv_user_idx on public.ai_conversations(user_id, updated_at desc);

alter table public.ai_conversations enable row level security;
-- A user sees & manages their own threads; Boss/Dev can read all (review/gaps).
drop policy if exists "ai_conv_select" on public.ai_conversations;
create policy "ai_conv_select" on public.ai_conversations for select
  using (user_id = auth.uid() or public.is_ai_admin(auth.uid()));
drop policy if exists "ai_conv_modify" on public.ai_conversations;
create policy "ai_conv_modify" on public.ai_conversations for all
  using (user_id = auth.uid()) with check (user_id = auth.uid());

-- 4. Messages ---------------------------------------------------------------
create table if not exists public.ai_messages (
  id              uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.ai_conversations(id) on delete cascade,
  role            text not null check (role in ('user', 'assistant')),
  content         text not null,
  created_at      timestamptz not null default now()
);
create index if not exists ai_msg_conv_idx on public.ai_messages(conversation_id, created_at);

alter table public.ai_messages enable row level security;
-- Read messages of your own threads (Boss/Dev read all). No client writes —
-- the ai-chat edge function (service role) is the only writer, so assistant
-- replies can never be forged.
drop policy if exists "ai_msg_select" on public.ai_messages;
create policy "ai_msg_select" on public.ai_messages for select using (
  public.is_ai_admin(auth.uid())
  or exists (select 1 from public.ai_conversations c where c.id = conversation_id and c.user_id = auth.uid())
);
drop policy if exists "ai_msg_no_insert" on public.ai_messages;
create policy "ai_msg_no_insert" on public.ai_messages for insert with check (false);
