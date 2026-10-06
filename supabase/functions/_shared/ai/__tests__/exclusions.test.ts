import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planDocument } from '../ingest/plan.ts';
import type { ExistingDoc, SourceRecord } from '../ingest/db.ts';

// Mig 380: ai_ingest_source marks a document on the Boss's exclusion list
// {indexable:false, excluded:true}. The TS extractor cannot see that list, so
// the planner must honour the flag, or the sweep's delete becomes a write.
const o = { pipelineVersion: 'p', model: 'm' };
const src = (over: Partial<SourceRecord> = {}): SourceRecord => ({
  source_id: 'k1', indexable: true, fp: 'fp',
  payload: { row: { knowledge_id: 'k1', kind: 'essay', url: 'https://x', title: 'T', body: 'Body text.', is_active: true } },
  ...over,
});
const stored = (status: string): ExistingDoc => ({ source_id: 'k1', doc_hash: 'h', source_fp: 'fp', pipeline_version: 'p', embed_model: 'm', status, chunk_hashes: [] });

test('an excluded document in the store is soft-deleted, even though the extractor would index it', async () => {
  assert.equal((await planDocument('tts_article', src(), stored('active'), o)).action, 'write', 'control: not excluded → write');
  assert.deepEqual(await planDocument('tts_article', src({ indexable: false, excluded: true }), stored('active'), o),
    { action: 'delete', soft: true, reason: 'excluded' });
});

test('an excluded document not (actively) in the store is left alone', async () => {
  for (const ex of [null, stored('deleted')]) {
    assert.deepEqual(await planDocument('tts_article', src({ indexable: false, excluded: true }), ex, o), { action: 'noop', reason: 'excluded' });
  }
});
