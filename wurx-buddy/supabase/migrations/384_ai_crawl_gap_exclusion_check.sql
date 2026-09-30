-- ============================================================
-- 384 — Assistant v2: two small fixes from QA's auto-ingestion pre-deploy
-- review (qa/2026-09-29-autoingest-predeploy.md).
--
--   L3  The crawl's politeness gap (2.5 s + jitter) also holds ACROSS calls:
--       ai_crawl_put stamps ai_crawl_state.last_fetch_at, and ai_crawl_lease
--       returns since_last_fetch_ms, so the next call's first request waits
--       out the rest of the gap (runner.ts). Measured on the database clock,
--       so the edge clock's skew does not matter. Signatures unchanged.
--       Order: apply 384 before redeploying tts-crawl (an old function simply
--       ignores the new field; the new function with the old database waits
--       as before, i.e. not at all on its first fetch).
--   L4  ai_excluded_documents.source_type must be one of the six known types:
--       'kb_articles' was accepted and silently excluded nothing.
--
-- Needs 379 (ai_source_canon) and 380. Idempotent.
-- ============================================================

-- ── L4 ─────────────────────────────────────────────────────────────────
alter table public.ai_excluded_documents drop constraint if exists ai_excluded_documents_source_type_known;
alter table public.ai_excluded_documents add constraint ai_excluded_documents_source_type_known
  check (source_type = any(public.ai_source_canon()));

-- ── L3 ─────────────────────────────────────────────────────────────────
alter table public.ai_crawl_state add column if not exists last_fetch_at timestamptz;

-- As mig 380, plus since_last_fetch_ms.
create or replace function public.ai_crawl_lease(p_worker text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v jsonb;
begin
  update public.ai_crawl_state
     set lease_owner = p_worker, lease_until = now() + interval '3 minutes', updated_at = now()
   where id = 1 and status <> 'idle' and (lease_until is null or lease_until < now())
  returning jsonb_build_object('status', status, 'crawl_no', crawl_no, 'finalize_after', finalize_after,
                               'since_last_fetch_ms', (extract(epoch from now() - last_fetch_at) * 1000)::bigint) into v;
  return v;
end $$;
revoke execute on function public.ai_crawl_lease(text) from public, anon, authenticated;

-- As mig 380, plus the last_fetch_at stamp (every fetch outcome goes through here).
create or replace function public.ai_crawl_put(p_worker text, p_key text, p_outcome text,
                                               p_records jsonb default null, p_error text default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_id bigint; v_att int; v_status text;
begin
  if not public.ai_crawl_holds(p_worker) then return jsonb_build_object('ok', false, 'reason', 'lost_lease'); end if;
  update public.ai_crawl_state set last_fetch_at = now() where id = 1;
  select id, attempts + 1 into v_id, v_att from public.ai_crawl_items where key = p_key and status = 'pending' for update;
  if v_id is null then return jsonb_build_object('ok', false, 'reason', 'not_pending'); end if;
  if p_outcome = 'done' then
    delete from public.ai_crawl_records where item_id = v_id;
    insert into public.ai_crawl_records (item_id, ord, record_id, record)
    select v_id, o, x->>'id', x
      from jsonb_array_elements(coalesce(p_records, '[]'::jsonb)) with ordinality t(x, o)
     where coalesce(x->>'id', '') <> '';
    v_status := 'done';
  elsif p_outcome = 'dead' then
    v_status := 'dead';
  elsif p_outcome = 'retry' then
    v_status := case when v_att >= 6 then 'failed' else 'pending' end;
  else
    raise exception 'ai_crawl_put: outcome must be done, dead or retry, not %', p_outcome;
  end if;
  update public.ai_crawl_items
     set status = v_status, attempts = v_att, last_error = left(p_error, 500),
         not_before = case when v_status = 'pending'
                           then now() + make_interval(secs => (array[5, 15, 30, 60, 120])[least(v_att, 5)]) else not_before end,
         done_at = case when v_status = 'pending' then null else now() end
   where id = v_id;
  return jsonb_build_object('ok', true, 'status', v_status, 'attempts', v_att);
end $$;
revoke execute on function public.ai_crawl_put(text, text, text, jsonb, text) from public, anon, authenticated;
