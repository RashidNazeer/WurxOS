// ai_assistant_docs extractor: curated docs (S2, kind='doc') and app guides
// (S3, kind='app_guide').
//
// SECURITY: 133 docs are SOP text imported from KB articles, and 25 of those
// articles are role-restricted. An imported SOP is therefore never indexed on
// its own:
//   linked (kb_article_id)  → merged into that KB article's document (kb.ts),
//                             which carries the article's ACL (decision 5);
//   not linked              → not indexed at all: its ACL is unknown (decision 3).
// Only curated docs without the import sentinel index here, with acl 'all'.

import { cleanValue, htmlToText, normalizeText, SOP_SENTINEL, stripSentinel } from '../text.ts';
import type { DocSection, ExtractedDoc, Extractor } from '../types.ts';

export type AiDocRow = {
  id: string;
  title: string;
  content: string | null;
  is_active: boolean;
  kind?: string | null;                  // 'doc' | 'app_guide'
  slug?: string | null;
  meta?: Record<string, unknown> | null; // app guides: roles, route, feature, last_reviewed
  kb_article_id?: string | null;
  created_by?: string | null;
  updated_at?: string | null;
};

export const isImportedSop = (row: Pick<AiDocRow, 'content'>) => String(row.content ?? '').includes(SOP_SENTINEL);

const toText = (s: string) => (/<\/?[a-zA-Z][^>]*>/.test(s) ? htmlToText(s) : normalizeText(s));

// The doc's readable text: sentinel and YAML front matter removed. Also used
// by kb.ts for the SOP text it merges in.
export const docText = (row: Pick<AiDocRow, 'content'>) =>
  toText(stripSentinel(String(row.content ?? '')).replace(/^---\n[\s\S]*?\n---\n/, ''));

export function aiDocSkipReason(row: AiDocRow): string | null {
  if (!row.is_active) return 'inactive';
  if (row.kb_article_id) return `merged into kb_article ${row.kb_article_id}`;
  if (isImportedSop(row)) return 'imported SOP not linked to a KB article: ACL unknown, not indexed (fail closed)';
  return null;
}

export const slugify = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'section';

// App guides: a section per "## " heading (A§5.5); text before the first one is the intro.
function guideSections(text: string): DocSection[] {
  const out: DocSection[] = [];
  const seen = new Map<string, number>();
  let cur: { title: string; lines: string[] } = { title: 'Overview', lines: [] };
  const flush = () => {
    const body = cur.lines.join('\n').trim();
    if (!body) return;
    const base = cur.title === 'Overview' && !out.length ? 'intro' : slugify(cur.title);
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    out.push({ key: `guide:${n > 1 ? `${base}-${n}` : base}`, title: cur.title, kind: 'prose', text: body });
  };
  for (const line of text.split('\n')) {
    const m = /^##\s+(.+)$/.exec(line);
    if (m) { flush(); cur = { title: m[1].trim(), lines: [] }; } else cur.lines.push(line);
  }
  flush();
  return out;
}

function toDocument(row: AiDocRow): ExtractedDoc {
  // Checked whatever is_active says (QA L7): a caller that skips indexable()
  // must still never get an acl-'all' document of a linked or imported SOP.
  if (row.kb_article_id || isImportedSop(row)) {
    throw new Error(`ai_doc ${row.id}: ${aiDocSkipReason({ ...row, is_active: true })}; refusing to index`);
  }
  const text = docText(row);
  const title = cleanValue(row.title) || 'Untitled';
  const meta = row.meta ?? {};
  const isGuide = row.kind === 'app_guide';
  const route = typeof meta.route === 'string' ? meta.route : '';
  const roles = Array.isArray(meta.roles) ? meta.roles.filter((r): r is string => typeof r === 'string' && !!r) : [];

  return {
    title,
    url: (isGuide ? route : '') || undefined,
    acl: isGuide && roles.length ? { mode: 'roles', roles } : { mode: 'all' },
    metadata: {
      doc_id: row.id,
      kind: row.kind ?? 'doc',
      slug: row.slug ?? null,
      ...(isGuide ? { route: route || null, roles, feature: meta.feature ?? null, last_reviewed: meta.last_reviewed ?? null } : {}),
    },
    header: isGuide ? `[WurxOS app guide · ${title}${route ? ` · page ${route}` : ''}]` : `[WurxOS guide · ${title}]`,
    sections: isGuide ? guideSections(text) : text ? [{ key: 'body', title: 'Guide', kind: 'prose', text }] : [],
    sourceUpdatedAt: row.updated_at ?? undefined,
  };
}

const kindReason = (row: AiDocRow, want: 'doc' | 'app_guide') =>
  (row.kind ?? 'doc') === want ? aiDocSkipReason(row) : `kind ${row.kind ?? 'doc'} is not ${want}`;

export const aiDocExtractor: Extractor<AiDocRow, undefined> = {
  sourceType: 'ai_doc',
  skipReason: (row) => kindReason(row, 'doc'),
  indexable: (row) => kindReason(row, 'doc') === null,
  toDocument,
};

export const appGuideExtractor: Extractor<AiDocRow, undefined> = {
  sourceType: 'app_guide',
  skipReason: (row) => kindReason(row, 'app_guide'),
  indexable: (row) => kindReason(row, 'app_guide') === null,
  toDocument,
};
