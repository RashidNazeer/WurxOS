// TikTok Shop Academy extractor (S4, A§5.4). Reads tts_articles (mig 371),
// already cleaned by the crawler. Public content: acl 'all'.

import { sha256Hex, stableStringify } from '../hash.ts';
import { cleanValue, normalizeText } from '../text.ts';
import type { DocSection, ExtractedDoc, Extractor } from '../types.ts';

export type TtsCourse = { learning_id?: string; name?: string; description?: string; lesson_index?: number; lesson_count?: number };

export const ttsCourses = (row: Pick<TtsRow, 'course'>): TtsCourse[] =>
  (Array.isArray(row.course) ? row.course : row.course ? [row.course] : []).filter((c) => c && typeof c === 'object');

export type TtsRow = {
  knowledge_id: string;
  kind: 'essay' | 'course_lesson' | string;
  url: string;
  title: string;
  breadcrumb?: string | null;
  // One course, or (importer, QA F6) every course the article appears in,
  // sorted by (learning_id, lesson_index); the first is the primary one.
  course?: TtsCourse | TtsCourse[] | null;
  keywords?: string[] | null;
  applies_to?: string | null;
  source?: string | null;
  ai_summary?: string | null;
  toc?: { level?: string; text?: string }[] | null;
  body: string;
  views?: number | null;
  source_modified_at?: string | null;
  is_active?: boolean | null;
  updated_at?: string | null;
};

// The crawler's body is plain text with single newlines; the headings are the
// lines listed in `toc`. Marking them as markdown headings lets the chunker
// split on them and label chunks "§ Article › <heading>". Matched in order,
// once each, so a body sentence that repeats a heading isn't promoted.
export function markHeadings(body: string, toc: TtsRow['toc']): string {
  const heads = (toc ?? []).filter((t) => t?.text && cleanValue(t.text));
  if (!heads.length) return body;
  const lines = body.split('\n');
  let h = 0;
  for (let i = 0; i < lines.length && h < heads.length; i++) {
    for (let j = h; j < heads.length; j++) {
      if (lines[i].trim() === String(heads[j].text).trim()) {
        const level = /^h(\d)$/.exec(String(heads[j].level ?? ''))?.[1] ?? '2';
        lines[i] = `${'#'.repeat(Math.min(6, Math.max(2, Number(level))))} ${lines[i].trim()}`;
        h = j + 1;
        break;
      }
    }
  }
  return lines.join('\n');
}

// tts_articles.content_hash: every field the extractor reads, and nothing
// volatile (views, crawl bookkeeping). The tts_articles trigger enqueues only
// when this changes, so a field that shapes the index but is missing here would
// never be re-indexed. The importer and the crawler port must both use this.
export const TTS_HASHED_FIELDS = [
  'knowledge_id', 'kind', 'url', 'title', 'breadcrumb', 'course', 'keywords', 'applies_to', 'source',
  'ai_summary', 'toc', 'body', 'source_modified_at',
] as const;
export function ttsContentHash(row: Partial<Record<(typeof TTS_HASHED_FIELDS)[number], unknown>>): Promise<string> {
  return sha256Hex(stableStringify(Object.fromEntries(TTS_HASHED_FIELDS.map((k) => [k, row[k] ?? null]))));
}

export function ttsBreadcrumb(row: TtsRow): string {
  const c = ttsCourses(row)[0];
  if (row.kind === 'course_lesson' && cleanValue(c?.name)) return `Courses > ${cleanValue(c?.name)}`;
  return cleanValue(row.breadcrumb);
}

export const ttsExtractor: Extractor<TtsRow, undefined> = {
  sourceType: 'tts_article',

  indexable: (row) => row.is_active !== false,

  toDocument(row) {
    const title = cleanValue(row.title) || 'Untitled article';
    const crumb = ttsBreadcrumb(row);
    const courses = ttsCourses(row);
    const c = courses[0];
    const lesson = row.kind === 'course_lesson' && c
      ? `Lesson ${(c.lesson_index ?? 0) + 1}${c.lesson_count ? ` of ${c.lesson_count}` : ''}`
      : '';
    const sections: DocSection[] = [];
    const summary = normalizeText(row.ai_summary);
    if (summary) sections.push({ key: 'summary', title: 'Summary', kind: 'prose', text: summary });
    const body = normalizeText(markHeadings(normalizeText(row.body), row.toc));
    if (body) sections.push({ key: 'body', title: lesson || 'Article', kind: 'prose', text: body });

    return {
      title,
      url: row.url,
      acl: { mode: 'all' },
      metadata: {
        knowledge_id: row.knowledge_id,
        kind: row.kind,
        category: crumb || null,
        url: row.url,
        keywords: row.keywords ?? [],
        applies_to: row.applies_to ?? null,
        // No `views`: it moves every crawl and would make every article "changed".
        source_modified_at: row.source_modified_at ?? null,
        ...(c ? {
          course_id: c.learning_id ?? null,
          lesson_index: c.lesson_index ?? null,
          courses: courses.map((x) => ({ id: x.learning_id ?? null, name: x.name ?? null, lesson_index: x.lesson_index ?? null })),
        } : {}),
      },
      header: `[TikTok Shop Academy · ${crumb ? `${crumb} · ` : ''}${title}]`,
      sections,
      sourceUpdatedAt: row.source_modified_at ?? row.updated_at ?? undefined,
    };
  },
};
