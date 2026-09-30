// Per-source loaders: ai_ingest_source() (mig 373) returns each source row
// with the context its extractor needs, read in ONE SQL statement (one
// snapshot, so the row and its fingerprint always agree). These turn that
// payload into the (row, ctx) pair the extractor takes.
//
//   report       row + brand {brand_name, client_name, currency}
//   kb_article   row (incl. submitted_by) + is_latest + linked_docs (kb_article_id index)
//   ai_doc       row                (kind 'doc')
//   app_guide    row                (kind 'app_guide')
//   tts_article  row
//   incentive    row (derived item fields already stripped in SQL) + person + live brand names

import type { AiDocRow } from '../extractors/aiDoc.ts';
import type { IncentiveCtx, IncentiveRow } from '../extractors/incentive.ts';
import type { KbCtx, KbRow } from '../extractors/kb.ts';
import type { ReportCtx, ReportRow } from '../extractors/report.ts';
import type { TtsRow } from '../extractors/tts.ts';
import type { SourceType } from '../extractors/index.ts';

export type Loaded = { row: any; ctx: any };

const withUpdated = <T extends object>(row: T, p: any): T => ({ ...row, updated_at: p?.updated_at ?? null });

export const loaders: Record<SourceType, (p: any) => Loaded> = {
  report: (p) => ({
    row: withUpdated(p.row as ReportRow, p),
    ctx: { brand: p.brand ?? null } satisfies ReportCtx,
  }),
  kb_article: (p) => ({
    row: withUpdated(p.row as KbRow, p),
    ctx: { isLatestVersion: !!p.is_latest, linkedDocs: (p.linked_docs ?? []) as AiDocRow[] } satisfies KbCtx,
  }),
  ai_doc: (p) => ({ row: withUpdated(p.row as AiDocRow, p), ctx: undefined }),
  app_guide: (p) => ({ row: withUpdated(p.row as AiDocRow, p), ctx: undefined }),
  tts_article: (p) => ({ row: withUpdated(p.row as TtsRow, p), ctx: undefined }),
  incentive: (p) => ({
    row: withUpdated(p.row as IncentiveRow, p),
    ctx: { person: p.person ?? null, brandNames: p.brands ?? {} } satisfies IncentiveCtx,
  }),
};
