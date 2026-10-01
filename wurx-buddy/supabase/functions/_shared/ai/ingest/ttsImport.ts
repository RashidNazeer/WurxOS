// TikTok Shop Academy crawl records → tts_articles rows (Phase 3 first load).
//
// The crawl file repeats ids: an essay can also be a course lesson, and one
// lesson can sit in several courses (1,201 records, 1,094 ids, 97 repeated,
// 88 with different text). One winner per id, by a TOTAL order that does not
// depend on the file's order (QA F6), so the stored content_hash never
// flip-flops between runs:
//   1. records with text beat empty ones (24 records have none: video-only)
//   2. the essay beats course lessons
//   3. lower (course learning_id, lesson_index)
//   4. later modified_at, then longer text, then the record's own JSON
// Every course the id appears in is kept, sorted, in `course` (an array).
// Ids with no text at all are skipped and reported.
//
// importArticles writes only rows that are new, changed (content_hash) or
// inactive, so a second import of the same file writes and enqueues nothing.

import { stableStringify } from '../hash.ts';
import type { TtsCourse } from '../extractors/tts.ts';
import { ttsContentHash } from '../extractors/tts.ts';
import type { Queryable } from './db.ts';

export type CrawlRecord = {
  id: string;
  kind: string;
  url: string;
  title: string;
  breadcrumb?: string | null;
  course?: TtsCourse | null;
  keywords?: string[] | null;
  applies_to?: string | null;
  source?: string | null;
  ai_summary?: string | null;
  toc?: unknown[] | null;
  text?: string | null;
  views?: number | null;
  created_at?: string | null;
  modified_at?: string | null;
  [k: string]: unknown;
};

export type TtsArticleRow = {
  knowledge_id: string;
  kind: string;
  url: string;
  title: string;
  breadcrumb: string | null;
  course: TtsCourse[] | null;
  keywords: string[];
  applies_to: string | null;
  source: string | null;
  ai_summary: string | null;
  toc: unknown[];
  body: string;
  views: number | null;
  source_created_at: string | null;
  source_modified_at: string | null;
  content_hash: string;
};

const iso = (t: unknown) => {
  if (t === null || t === undefined || t === '') return null;
  const d = new Date(String(t));
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
};
const hasText = (r: CrawlRecord) => !!String(r.text ?? '').trim();
const cmpNum = (a: unknown, b: unknown) => String(a ?? '').localeCompare(String(b ?? ''), 'en', { numeric: true });

function courseCmp(a: TtsCourse, b: TtsCourse): number {
  return cmpNum(a.learning_id, b.learning_id) || (Number(a.lesson_index ?? 0) - Number(b.lesson_index ?? 0));
}

// Negative → a wins.
export function recordCmp(a: CrawlRecord, b: CrawlRecord): number {
  const t = Number(hasText(b)) - Number(hasText(a));
  if (t) return t;
  const e = Number(b.kind === 'essay') - Number(a.kind === 'essay');
  if (e) return e;
  if (a.course && b.course) { const c = courseCmp(a.course, b.course); if (c) return c; }
  const m = (Date.parse(String(b.modified_at ?? '')) || 0) - (Date.parse(String(a.modified_at ?? '')) || 0);
  if (m) return m;
  const l = String(b.text ?? '').length - String(a.text ?? '').length;
  if (l) return l;
  return stableStringify(a).localeCompare(stableStringify(b));
}

export type CrawlPlan = {
  rows: TtsArticleRow[];
  records: number;
  uniqueIds: number;
  duplicateIds: number;
  skippedEmpty: string[];   // ids with no text in any record
};

export async function crawlToRows(records: CrawlRecord[]): Promise<CrawlPlan> {
  const byId = new Map<string, CrawlRecord[]>();
  for (const r of records) {
    if (!r || !r.id) continue;
    const id = String(r.id);
    (byId.get(id) ?? byId.set(id, []).get(id)!).push(r);
  }
  const rows: TtsArticleRow[] = [];
  const skippedEmpty: string[] = [];
  let duplicateIds = 0;
  for (const [id, list] of [...byId].sort(([a], [b]) => cmpNum(a, b))) {
    if (list.length > 1) duplicateIds++;
    const sorted = list.slice().sort(recordCmp);
    const w = sorted[0];
    if (!hasText(w)) { skippedEmpty.push(id); continue; }
    const seen = new Set<string>();
    const courses = list.map((r) => r.course).filter((c): c is TtsCourse => !!c && typeof c === 'object')
      .sort(courseCmp)
      .filter((c) => { const k = `${c.learning_id}|${c.lesson_index}`; return seen.has(k) ? false : (seen.add(k), true); });
    const row: Omit<TtsArticleRow, 'content_hash'> = {
      knowledge_id: id,
      kind: w.kind === 'course_lesson' ? 'course_lesson' : 'essay',
      url: String(w.url),
      title: String(w.title ?? ''),
      breadcrumb: w.breadcrumb ?? null,
      course: courses.length ? courses : null,
      keywords: Array.isArray(w.keywords) ? w.keywords.map(String) : [],
      applies_to: w.applies_to ?? null,
      source: w.source ?? null,
      ai_summary: w.ai_summary ?? null,
      toc: Array.isArray(w.toc) ? w.toc : [],
      body: String(w.text),
      views: typeof w.views === 'number' ? w.views : null,
      source_created_at: iso(w.created_at),
      source_modified_at: iso(w.modified_at),
    };
    rows.push({ ...row, content_hash: await ttsContentHash(row) });
  }
  return { rows, records: records.length, uniqueIds: byId.size, duplicateIds, skippedEmpty };
}

export type ImportResult = {
  records: number;
  uniqueIds: number;
  duplicateIds: number;
  skippedEmpty: string[];
  inserted: number;
  updated: number;
  unchanged: number;
  wrote: boolean;
};

const BATCH = 200;

// Diff against tts_articles, then (unless dryRun) upsert only the new/changed
// rows. Runs on whatever transaction the client is in: the caller commits or
// rolls back.
export async function importArticles(client: Queryable, records: CrawlRecord[], opts: { dryRun?: boolean } = {}): Promise<ImportResult> {
  const plan = await crawlToRows(records);
  const ids = plan.rows.map((r) => r.knowledge_id);
  const stored = new Map<string, { h: string; active: boolean }>();
  for (let i = 0; i < ids.length; i += 1000) {
    const { rows } = await client.query(
      'select knowledge_id, content_hash, is_active from public.tts_articles where knowledge_id = any($1::text[])', [ids.slice(i, i + 1000)]);
    for (const r of rows) stored.set(r.knowledge_id, { h: r.content_hash, active: r.is_active });
  }
  const todo = plan.rows.filter((r) => { const s = stored.get(r.knowledge_id); return !s || s.h !== r.content_hash || !s.active; });
  const res: ImportResult = {
    records: plan.records, uniqueIds: plan.uniqueIds, duplicateIds: plan.duplicateIds, skippedEmpty: plan.skippedEmpty,
    inserted: todo.filter((r) => !stored.has(r.knowledge_id)).length,
    updated: todo.filter((r) => stored.has(r.knowledge_id)).length,
    unchanged: plan.rows.length - todo.length,
    wrote: false,
  };
  if (opts.dryRun || !todo.length) return res;

  for (let i = 0; i < todo.length; i += BATCH) {
    await client.query(`
      insert into public.tts_articles as t (knowledge_id, kind, url, title, breadcrumb, course, keywords, applies_to, source,
                                            ai_summary, toc, body, views, source_created_at, source_modified_at, content_hash)
      select r.knowledge_id, r.kind, r.url, r.title, r.breadcrumb, r.course, coalesce(r.keywords, '{}'), r.applies_to, r.source,
             r.ai_summary, coalesce(r.toc, '[]'::jsonb), r.body, r.views, r.source_created_at, r.source_modified_at, r.content_hash
        from jsonb_to_recordset($1::jsonb) as r(knowledge_id text, kind text, url text, title text, breadcrumb text, course jsonb,
             keywords text[], applies_to text, source text, ai_summary text, toc jsonb, body text, views bigint,
             source_created_at timestamptz, source_modified_at timestamptz, content_hash text)
      on conflict (knowledge_id) do update set
        kind = excluded.kind, url = excluded.url, title = excluded.title, breadcrumb = excluded.breadcrumb,
        course = excluded.course, keywords = excluded.keywords, applies_to = excluded.applies_to, source = excluded.source,
        ai_summary = excluded.ai_summary, toc = excluded.toc, body = excluded.body, views = excluded.views,
        source_created_at = excluded.source_created_at, source_modified_at = excluded.source_modified_at,
        content_hash = excluded.content_hash, is_active = true, missed_crawls = 0, last_seen_at = now(), updated_at = now()
      where t.content_hash is distinct from excluded.content_hash or not t.is_active`,
      [JSON.stringify(todo.slice(i, i + BATCH))]);
  }
  res.wrote = true;
  return res;
}
