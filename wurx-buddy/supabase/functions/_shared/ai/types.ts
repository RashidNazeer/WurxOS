// Contracts between extractors, chunker and (part B) the ingest writer. A§5.

export type AclMode = 'all' | 'roles' | 'report' | 'brand' | 'kb' | 'boss' | 'incentive';
export type SectionKind = 'prose' | 'table' | 'metrics';

export type DocSection = {
  key: string;          // stored as ai_chunks.section, e.g. 'insights:overall'
  title: string;        // printed as "§ <title>" in every chunk of the section
  text: string;         // prose: plain text (may hold "## " headings); table: one row per line
  kind: SectionKind;
};

export type ExtractedDoc = {
  title: string;
  url?: string;
  brandId?: string;
  periodStart?: string;
  periodEnd?: string;
  acl: { mode: AclMode; roles?: string[]; users?: string[]; authorId?: string | null };
  metadata: Record<string, unknown>;
  // Context header prepended to every chunk (A§6.3). Only stable, searchable
  // facts: volatile ones (a report's status, an incentive's verified/paid
  // state) go in metadata, so flipping them rewrites one document row and no
  // chunk, and costs no embedding call.
  header: string;
  sections: DocSection[];
  sourceUpdatedAt?: string;
};

// Pure halves; the DB loaders live in ingest/loaders.ts (+ SQL ai_ingest_source).
export interface Extractor<Row, Ctx = undefined> {
  sourceType: string;
  indexable(row: Row, ctx: Ctx): boolean;
  // Why a row is not indexable (for logs and the preview); null when it is.
  skipReason?(row: Row, ctx: Ctx): string | null;
  toDocument(row: Row, ctx: Ctx): ExtractedDoc;
}

export type Chunk = {
  chunk_index: number;
  section: string;
  content: string;      // header + "§ title" + body: what the model reads
  embed_text: string;   // content, whitespace-collapsed and capped: what is embedded
  token_count: number;  // estimateTokens(embed_text)
  content_hash: string; // sha256(embed_text + '|' + model)
};
