-- ============================================================
-- WurxOS v2 — Migration 226: build the tts_knowledge ANN index with enough
-- maintenance memory.
--
-- Mig 225 deferred the ivfflat build ("memory required is 61 MB,
-- maintenance_work_mem is 32 MB"). Raise maintenance_work_mem for THIS
-- transaction and build the index. Idempotent.
-- ============================================================

set local maintenance_work_mem = '128MB';

drop index if exists public.tts_knowledge_embedding_idx;

do $$
begin
  begin
    execute 'create index tts_knowledge_embedding_idx on public.tts_knowledge '
          || 'using ivfflat (embedding extensions.vector_cosine_ops) with (lists = 50)';
  exception when others then
    -- Still deferred → the query planner falls back to an exact scan, which is
    -- fine at this corpus size (a few thousand vectors). Non-fatal.
    raise notice 'tts_knowledge embedding index still deferred: %', sqlerrm;
  end;
end $$;

analyze public.tts_knowledge;
