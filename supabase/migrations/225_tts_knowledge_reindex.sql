-- ============================================================
-- WurxOS v2 — Migration 225: rebuild the tts_knowledge ANN index for the
-- full-corpus load.
--
-- The ivfflat index (mig 223) was built when the table had ~238 rows; after
-- the full academy ingest it holds ~2,300+ chunks. Rebuild with a lists value
-- tuned to the larger corpus (~sqrt(rows) is the rule of thumb → ~48; round to
-- 50) so nearest-neighbour probes stay accurate. Idempotent.
-- ============================================================

drop index if exists public.tts_knowledge_embedding_idx;

do $$
begin
  begin
    execute 'create index tts_knowledge_embedding_idx on public.tts_knowledge '
          || 'using ivfflat (embedding extensions.vector_cosine_ops) with (lists = 50)';
  exception when others then
    raise notice 'tts_knowledge embedding index build deferred: %', sqlerrm;
  end;
end $$;

analyze public.tts_knowledge;
