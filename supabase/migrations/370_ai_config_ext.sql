-- ============================================================
-- 370 — Assistant v2: config / docs / messages extensions + request log.
--
-- Additive only: the v1 assistant (ai-chat) ignores every new column.
--
--   ai_assistant_docs   kind (doc | app_guide), slug, meta, kb_article_id.
--                       kb_article_id links an imported SOP to its KB article
--                       so it INHERITS that article's visibility — 25 KB
--                       articles are role-restricted, and their imported text
--                       must not become visible to everyone (inventory §3).
--   ai_assistant_config engine (v1 | v2) switch, provider, retrieval
--                       overrides, monthly budget.
--   ai_messages         meta: sources cited, tools called, request id.
--   ai_request_log      one row per question (telemetry, cost, feedback).
--
-- Design: Assistant/architecture.md §3.5, §13, §15.  Idempotent.
-- ============================================================

alter table public.ai_assistant_docs
  add column if not exists kind          text not null default 'doc',
  add column if not exists slug          text,
  add column if not exists meta          jsonb not null default '{}'::jsonb,
  add column if not exists kb_article_id uuid references public.kb_articles(id) on delete set null;
do $$ begin
  alter table public.ai_assistant_docs add constraint ai_assistant_docs_kind_check check (kind in ('doc','app_guide'));
exception when duplicate_object then null; end $$;
create unique index if not exists ai_assistant_docs_slug_uk on public.ai_assistant_docs (slug) where slug is not null;

alter table public.ai_assistant_config
  add column if not exists engine             text not null default 'v1',
  add column if not exists provider           text not null default 'openai',
  add column if not exists retrieval          jsonb not null default '{}'::jsonb,
  add column if not exists monthly_budget_usd numeric;
do $$ begin
  alter table public.ai_assistant_config add constraint ai_assistant_config_engine_check check (engine in ('v1','v2'));
exception when duplicate_object then null; end $$;

alter table public.ai_messages
  add column if not exists meta jsonb not null default '{}'::jsonb;

create table if not exists public.ai_request_log (
  id               uuid primary key default gen_random_uuid(),
  created_at       timestamptz not null default now(),
  user_id          uuid references public.profiles(id) on delete set null,
  conversation_id  uuid references public.ai_conversations(id) on delete set null,
  engine           text not null,
  provider         text,
  model            text,
  question         text,
  rounds           int not null default 0,
  tools            jsonb not null default '[]'::jsonb,   -- [{name,args,ms,result_chars}]
  retrieved        jsonb not null default '[]'::jsonb,   -- [{chunk_id,document_id,score,cited}]
  tokens_in        int not null default 0,
  tokens_cached    int not null default 0,
  tokens_out       int not null default 0,
  est_cost_usd     numeric(10,5) not null default 0,
  latency_ms       int,
  first_token_ms   int,
  error            text,
  rating           smallint check (rating in (-1, 1)),
  rating_note      text
);
create index if not exists ai_request_log_created_idx on public.ai_request_log (created_at desc);
create index if not exists ai_request_log_user_idx    on public.ai_request_log (user_id, created_at desc);

alter table public.ai_request_log enable row level security;
drop policy if exists "ai_request_log_read" on public.ai_request_log;
create policy "ai_request_log_read" on public.ai_request_log for select
  using (user_id = (select auth.uid()) or public.is_ai_admin((select auth.uid())));
-- No client writes; the assistant function logs with the service role.

-- 👍 / 👎 on an answer — only the person who asked may rate it.
create or replace function public.ai_feedback(p_request_id uuid, p_rating smallint, p_note text default null)
returns void
language plpgsql security definer
set search_path = public
as $$
begin
  if p_rating not in (-1, 1) then raise exception 'rating must be -1 or 1'; end if;
  update public.ai_request_log
     set rating = p_rating, rating_note = left(p_note, 2000)
   where id = p_request_id and user_id = auth.uid();
end;
$$;
revoke execute on function public.ai_feedback(uuid, smallint, text) from public, anon;
grant  execute on function public.ai_feedback(uuid, smallint, text) to authenticated;
