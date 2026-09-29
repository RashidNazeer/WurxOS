// Knowledge Base extractor (S1, A§5.3). 148 of 150 KB rows are link-only.
//
// One document per SOP (decision 5): when imported SOP docs are linked to the
// article (ai_assistant_docs.kb_article_id), their full text becomes this
// document's body, under the article's ACL and URL. Those docs produce no
// document of their own (aiDoc.ts). An article with no linked SOP keeps the
// single pointer chunk ("the full SOP is at <url>").

import { cleanValue, htmlToText, humanize } from '../text.ts';
import type { DocSection, ExtractedDoc, Extractor } from '../types.ts';
import { docText, slugify } from './aiDoc.ts';
import type { AiDocRow } from './aiDoc.ts';

export type KbRow = {
  id: string;
  title: string;
  body?: string | null;
  url?: string | null;
  category?: string | null;
  tags?: string[] | null;
  visibility?: string | null;          // office | role | users | private
  visible_to_roles?: string[] | null;
  visible_to_users?: string[] | null;
  created_by?: string | null;
  submitted_by?: string | null;
  approval_status?: string | null;
  sop_group_id?: string | null;
  version?: number | null;
  version_label?: string | null;
  requires_ack?: boolean | null;
  updated_at?: string | null;
};

// The loader resolves "latest version in its sop_group" (version desc, first
// per group, as ai-chat does); older versions are removed from the index.
// linkedDocs: ai_assistant_docs rows whose kb_article_id is this article.
export type KbCtx = { isLatestVersion: boolean; linkedDocs?: AiDocRow[] };

const CATEGORY: Record<string, string> = {
  operational_sops: 'Operational SOPs', training_sops: 'Training SOPs', policies: 'Policies',
  delivery_roadmap: 'Delivery roadmap', bootcamp: 'Bootcamp',
};
export const kbCategoryLabel = (c?: string | null) => (c ? CATEGORY[c] ?? humanize(c) : 'General');

// Mirrors kb_select (mig 134), evaluated live by ai_can_read_document; the
// visibility and submitted_by it needs travel in metadata (see toDocument).
export function kbAcl(row: KbRow): ExtractedDoc['acl'] {
  return {
    mode: 'kb',
    roles: [...(row.visible_to_roles ?? [])],
    users: [...(row.visible_to_users ?? [])],
    authorId: row.created_by ?? null,
  };
}

const byTitle = (a: AiDocRow, b: AiDocRow) =>
  String(a.title).localeCompare(String(b.title), 'en', { numeric: true }) || a.id.localeCompare(b.id);

// "BootCamp Master Doc — SECTION 3: TOOLS" → "SECTION 3: TOOLS"; "X (part 2)" → "Part 2".
function partTitle(docTitle: string): string {
  const t = cleanValue(docTitle);
  const parts = t.split(/\s+[—–]\s+/);
  if (parts.length > 1) return parts.slice(1).join(' — ');
  const p = /\(part\s*(\d+)\)\s*$/i.exec(t);
  return p ? `Part ${p[1]}` : t || 'SOP';
}

export const linkedSops = (row: KbRow, ctx?: KbCtx) =>
  (ctx?.linkedDocs ?? []).filter((d) => d.is_active && d.kb_article_id === row.id).sort(byTitle);

export const kbExtractor: Extractor<KbRow, KbCtx> = {
  sourceType: 'kb_article',

  skipReason: (row, ctx) =>
    row.approval_status !== 'approved' ? `not approved (${row.approval_status ?? 'null'})`
      : !ctx.isLatestVersion ? 'superseded version' : null,
  indexable: (row, ctx) => row.approval_status === 'approved' && ctx.isLatestVersion,

  toDocument(row, ctx) {
    const title = cleanValue(row.title) || 'Untitled SOP';
    const url = cleanValue(row.url);
    const body = htmlToText(row.body);
    const tags = (row.tags ?? []).map(cleanValue).filter(Boolean);
    const tagLine = tags.length ? `\nTags: ${tags.join(', ')}` : '';
    const docs = linkedSops(row, ctx);

    const sections: DocSection[] = [];
    if (cleanValue(body)) sections.push({ key: 'body', title: 'SOP', kind: 'prose', text: body });
    const seen = new Map<string, number>();
    for (const d of docs) {
      const text = docText(d);
      if (!text) continue;
      const name = docs.length === 1 ? 'SOP' : partTitle(d.title);
      const base = docs.length === 1 ? 'sop' : `sop:${slugify(name)}`;
      const n = (seen.get(base) ?? 0) + 1;
      seen.set(base, n);
      sections.push({ key: n > 1 ? `${base}-${n}` : base, title: name, kind: 'prose', text });
    }
    if (sections.length) {
      const last = sections[sections.length - 1];
      last.text += `${url ? `\n\nFull guide: ${url}` : ''}${tagLine}`;
    } else if (url) {
      sections.push({ key: 'pointer', title: 'Where to find it', kind: 'prose', text: `${title}: the full SOP is at ${url}${tagLine}` });
    }

    const updated = [row.updated_at, ...docs.map((d) => d.updated_at)].filter((s): s is string => !!s)
      .sort((a, b) => Date.parse(b) - Date.parse(a))[0];

    return {
      title,
      url: url || '/kb',
      acl: kbAcl(row),
      metadata: {
        category: row.category ?? null,
        tags,
        version: row.version ?? null,
        version_label: row.version_label ?? null,
        sop_group_id: row.sop_group_id ?? null,
        // ai_can_read_document fails closed on a missing/unknown visibility.
        visibility: row.visibility ?? null,
        submitted_by: row.submitted_by ?? null,
        url: url || null,
        requires_ack: row.requires_ack ?? false,
        sop_doc_ids: docs.map((d) => d.id),
      },
      header: `[Knowledge Base · ${kbCategoryLabel(row.category)} · ${title}]`,
      sections,
      sourceUpdatedAt: updated,
    };
  },
};
