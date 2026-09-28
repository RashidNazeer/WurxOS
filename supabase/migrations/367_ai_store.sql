-- ============================================================
-- 367 — Assistant v2: knowledge store (documents + chunks).
--
-- One store for everything the assistant retrieves: SOPs, KB pointers,
-- app guides, TikTok Shop Academy, report narratives. Numbers (GMV, pay,
-- attendance) are NOT stored here — they come from live SQL tools.
--
--   ai_documents  one row per source item: ACL keys, filters, doc hash
--   ai_chunks     retrievable passages: text, embedding, full-text vector
--
-- No client can read either table directly. Every read goes through
-- public.ai_search() (mig 368), which applies the caller's permissions —
-- one enforcement point instead of a policy per table.
--
-- Written only by the ingestion worker (service role).
-- Design: Assistant/architecture.md §3–§4, §8.  Idempotent.
-- ============================================================

create table if not exists public.ai_documents (
  id                 uuid primary key default gen_random_uuid(),
  source_type        text not null,   -- kb_article | ai_doc | app_guide | tts_article | report | brand_profile | …
  source_id          text not null,   -- PK of the source row, or an external id (TikTok knowledge_id)
  title              text not null,
  url                text,            -- in-app path or external URL, for citations
  brand_id           uuid references public.brands(id) on delete cascade,
  period_start       date,
  period_end         date,
  -- Access control, evaluated live by ai_can_read_document() (mig 368).
  acl_mode           text not null
                       check (acl_mode in ('all','roles','report','brand','kb','boss')),
  acl_roles          text[] not null default '{}',
  acl_users          uuid[] not null default '{}',
  author_id          uuid,
  metadata           jsonb not null default '{}'::jsonb,
  doc_hash           text not null,
  chunk_count        int  not null default 0,
  status             text not null default 'active' check (status in ('active','deleted')),
  source_updated_at  timestamptz,
  indexed_at         timestamptz not null default now(),
  unique (source_type, source_id)
);
create index if not exists ai_documents_type_status_idx on public.ai_documents (source_type, status);
create index if not exists ai_documents_brand_idx  on public.ai_documents (brand_id) where brand_id is not null;
create index if not exists ai_documents_period_idx on public.ai_documents (period_start desc) where period_start is not null;

create table if not exists public.ai_chunks (
  id               uuid primary key default gen_random_uuid(),
  document_id      uuid not null references public.ai_documents(id) on delete cascade,
  chunk_index      int  not null,
  section          text,
  content          text not null,     -- what the model reads (includes the context header)
  embed_text       text not null,     -- exactly what was embedded
  token_count      int  not null,
  content_hash     text not null,     -- sha256(embed_text | embedding_model): unchanged → never re-embedded
  embedding        extensions.vector(1536),
  embedding_model  text not null,
  fts              tsvector generated always as (
                     setweight(to_tsvector('english'::regconfig, coalesce(section, '')), 'B') ||
                     setweight(to_tsvector('english'::regconfig, content), 'A')) stored,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (document_id, chunk_index)
);
-- HNSW builds on an empty table (the ivfflat index in mig 223 could not).
create index if not exists ai_chunks_embedding_hnsw on public.ai_chunks
  using hnsw (embedding extensions.vector_cosine_ops) with (m = 16, ef_construction = 64);
create index if not exists ai_chunks_fts_gin on public.ai_chunks using gin (fts);
create index if not exists ai_chunks_document_idx on public.ai_chunks (document_id);

alter table public.ai_documents enable row level security;
alter table public.ai_chunks    enable row level security;
-- Deliberately no policies: clients read only through ai_search().
revoke all on public.ai_documents from anon, authenticated;
revoke all on public.ai_chunks    from anon, authenticated;
