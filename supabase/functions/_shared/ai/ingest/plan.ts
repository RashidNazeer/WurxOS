// What to do with one source item, decided from the live row and the store.
// Pure apart from hashing; the worker and the dry run share it, so the dry
// run predicts exactly what the worker would do.
//
//   noop    not indexable and not (actively) in the store: nothing to do
//   delete  source row gone → hard delete (chunks cascade);
//           present but not indexable (draft, unapproved, superseded,
//           inactive) → SOFT delete: status 'deleted', chunks and vectors kept
//           and hidden from ai_search, so re-publishing costs no embedding
//   skip    doc_hash equals the stored one: nothing chunked, embedded or written
//   touch   doc_hash equal, but the SQL source fingerprint moved (a field the
//           document doesn't use changed): record the new fp only
//   write   the document changed (or is new, or was soft-deleted): chunk it,
//           embed ONLY chunks whose content_hash appears nowhere in the stored
//           document, write in one transaction (ai_ingest_write reuses stored
//           vectors by hash, whatever their position)

import { chunkDocument } from '../chunker.ts';
import { chunkParamsFor, pipelineSalt } from '../config.ts';
import { extractors } from '../extractors/index.ts';
import { docHash } from '../hash.ts';
import type { Chunk, ExtractedDoc, Extractor } from '../types.ts';
import type { ExistingDoc, SourceRecord } from './db.ts';
import { loaders } from './loaders.ts';

export type PlanOptions = { pipelineVersion: string; model: string };

// A source the worker can index without a SQL loader: tests use it for pure
// synthetic items. fetch() returns records whose payload is { row, ctx }.
export type CustomSource = {
  extractor: Extractor<any, any>;
  fetch(ids: string[]): Promise<SourceRecord[]>;
};

export type WriteStats = {
  chunks: number;
  toEmbed: number;        // distinct new content hashes
  reusedSameIndex: number;
  reusedMoved: number;    // same text found at another index: vector reused, not re-embedded
  capped: boolean;
};

export type Plan =
  | { action: 'noop'; reason: string }
  | { action: 'delete'; soft: boolean; reason: string }
  | { action: 'skip' }
  | { action: 'touch'; fp: string }
  | { action: 'write'; isNew: boolean; doc: ExtractedDoc; docRow: Record<string, unknown>; chunks: Chunk[]; toEmbed: Chunk[]; stats: WriteStats };

export function documentRow(type: string, sourceId: string, doc: ExtractedDoc, hash: string, fp: string, chunkCount: number, o: PlanOptions) {
  return {
    source_type: type,
    source_id: sourceId,
    title: doc.title,
    url: doc.url ?? null,
    brand_id: doc.brandId ?? null,
    period_start: doc.periodStart ?? null,
    period_end: doc.periodEnd ?? null,
    acl_mode: doc.acl.mode,
    acl_roles: doc.acl.roles ?? [],
    acl_users: doc.acl.users ?? [],
    author_id: doc.acl.authorId ?? null,
    metadata: doc.metadata,
    doc_hash: hash,
    chunk_count: chunkCount,
    source_updated_at: doc.sourceUpdatedAt ?? null,
    pipeline_version: o.pipelineVersion,
    embed_model: o.model,
    source_fp: fp,
  };
}

export async function planDocument(type: string, src: SourceRecord | null, existing: ExistingDoc | null, o: PlanOptions,
                                   custom?: CustomSource): Promise<Plan> {
  if (!src) return existing ? { action: 'delete', soft: false, reason: 'source row not found' } : { action: 'noop', reason: 'source row not found' };
  // The extractor can't see the exclusion list (mig 380); without this the
  // sweep's delete would be re-planned as a write, every 12 hours.
  if (src.excluded) return existing?.status === 'active' ? { action: 'delete', soft: true, reason: 'excluded' } : { action: 'noop', reason: 'excluded' };

  const ex: Extractor<any, any> | undefined = custom?.extractor ?? (extractors as Record<string, Extractor<any, any>>)[type];
  if (!ex) throw new Error(`unknown source_type ${type}`);
  const { row, ctx } = custom ? { row: src.payload?.row, ctx: src.payload?.ctx } : (loaders as Record<string, (p: any) => any>)[type](src.payload);

  if (!ex.indexable(row, ctx)) {
    const reason = ex.skipReason?.(row, ctx) ?? 'not indexable';
    return existing?.status === 'active' ? { action: 'delete', soft: true, reason } : { action: 'noop', reason };
  }

  const doc: ExtractedDoc = ex.toDocument(row, ctx);
  const hash = await docHash(doc, pipelineSalt(type, o.pipelineVersion), o.model);
  if (existing && existing.status === 'active' && existing.doc_hash === hash) {
    return existing.source_fp === src.fp ? { action: 'skip' } : { action: 'touch', fp: src.fp };
  }

  const { chunks, capped } = await chunkDocument(doc, chunkParamsFor(type), { model: o.model });
  const stored = existing?.chunk_hashes ?? [];
  const known = new Set(stored);
  const toEmbed: Chunk[] = [];
  const queued = new Set<string>();
  let reusedSameIndex = 0, reusedMoved = 0;
  for (const c of chunks) {
    if (stored[c.chunk_index] === c.content_hash) reusedSameIndex++;
    else if (known.has(c.content_hash)) reusedMoved++;
    else if (!queued.has(c.content_hash)) { queued.add(c.content_hash); toEmbed.push(c); }
  }
  return {
    action: 'write',
    isNew: !existing,
    doc,
    docRow: documentRow(type, src.source_id, doc, hash, src.fp, chunks.length, o),
    chunks,
    toEmbed,
    stats: { chunks: chunks.length, toEmbed: toEmbed.length, reusedSameIndex, reusedMoved, capped },
  };
}
