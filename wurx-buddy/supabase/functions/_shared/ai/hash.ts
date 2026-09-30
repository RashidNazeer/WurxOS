// Web Crypto is global in both Deno and Node ≥ 20.
import type { ExtractedDoc } from './types.ts';

export async function sha256Hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  let out = '';
  for (const b of new Uint8Array(buf)) out += b.toString(16).padStart(2, '0');
  return out;
}

// JSON with sorted object keys, so equal values always hash equally.
export function stableStringify(v: unknown): string {
  if (v === undefined) return 'null';
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o).filter((k) => o[k] !== undefined).sort()
    .map((k) => `${JSON.stringify(k)}:${stableStringify(o[k])}`).join(',')}}`;
}

// Document fingerprint (A§9.5): the whole extracted document (text, header,
// ACL, filters, metadata) + the pipeline salt (version + chunking/embedding
// rules, config.pipelineSalt) + the embedding model. Equal to the stored one →
// the worker skips the document: no chunking, no API call, no write.
// sourceUpdatedAt is excluded so a no-op save stays a no-op.
export function docHash(doc: ExtractedDoc, pipelineSalt: string, model: string): Promise<string> {
  return sha256Hex(`${stableStringify({ ...doc, sourceUpdatedAt: undefined })}|${pipelineSalt}|${model}`);
}
