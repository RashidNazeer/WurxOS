// TikTok Shop Academy (US) page parsing, ported from scripts/tts-crawl.mjs.
// Pure and runtime-neutral: the tts-crawl edge function and the Node tests share it.
//
// Discovery: the Academy's own sitemap API. Content: the JSON each page embeds
// (window._ROUTER_DATA), never HTML scraping.
//   essay  → one record per page (knowledge_plain_content)
//   course → ONE fetch returns every lesson (course_contents)
// A JS-only shell (no router data) is TRANSIENT and retried; only 404 or the
// "content does not exist" page is dead.

import type { CrawlRecord } from '../ingest/ttsImport.ts';

export const TTS_BASE = 'https://seller-us.tiktok.com';
export const TTS_SITEMAP = `${TTS_BASE}/api/v1/seller/learning_center/sitemap/urls/get?version=1&region=US`;
export const TTS_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36';

export type CrawlItem = { key: string; kind: 'essay' | 'course'; item_id: string; url: string; discovered?: boolean };

const toIso = (t: unknown) => {
  const n = Number(t);
  if (!n) return null;
  return new Date(n > 1e12 ? n : n * 1000).toISOString();   // essays use seconds, courses ms
};

const decode = (s: string) => s
  .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&#x27;|&#39;|&apos;/g, "'").replace(/&quot;/g, '"')
  .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n));
export const clean = (s: unknown) => decode(String(s || ''))
  .replace(/​|‌|‍|﻿/g, '')
  .replace(/[ \t]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n{3,}/g, '\n\n').trim();
export const htmlToText = (html: unknown) => clean(String(html || '')
  .replace(/<style[\s\S]*?<\/style>/gi, '').replace(/<script[\s\S]*?<\/script>/gi, '')
  .replace(/<li[^>]*>/gi, '\n• ').replace(/<br\s*\/?>/gi, '\n')
  .replace(/<\/(p|div|h[1-6]|tr|li|section|article|table)>/gi, '\n')
  .replace(/<[^>]+>/g, ''));
// Quill-style delta JSON ({"deltas":{"0":{"ops":[{"insert":"..."}]}}}) → text
export const deltaToText = (raw: unknown) => {
  try {
    const j = typeof raw === 'string' ? JSON.parse(raw) : raw;
    const parts: string[] = [];
    for (const d of Object.values((j as any)?.deltas || {})) for (const op of (d as any)?.ops || []) if (typeof op.insert === 'string') parts.push(op.insert);
    return clean(parts.join(''));
  } catch { return ''; }
};

export const essayUrl = (id: string) => `${TTS_BASE}/university/essay?knowledge_id=${id}&lang=en`;

// Sitemap JSON → essays, then courses (one entry per course).
export function sitemapItems(json: unknown): CrawlItem[] {
  const essays = new Map<string, CrawlItem>();
  const courses = new Map<string, CrawlItem>();
  for (const e of ((json as any)?.data ?? []) as { loc?: string }[]) {
    let u: URL;
    try { u = new URL(String(e?.loc)); } catch { continue; }
    if (u.pathname.endsWith('/essay')) {
      const id = u.searchParams.get('knowledge_id');
      if (id) essays.set(id, { key: `essay:${id}`, kind: 'essay', item_id: id, url: essayUrl(id) });
    } else if (u.pathname.endsWith('/course')) {
      const lid = u.searchParams.get('learning_id');
      if (lid && !courses.has(lid)) {
        courses.set(lid, { key: `course:${lid}`, kind: 'course', item_id: lid,
          url: `${TTS_BASE}/university/course?learning_id=${lid}&content_id=${u.searchParams.get('content_id')}&lang=en` });
      }
    }
  }
  return [...essays.values(), ...courses.values()];
}

export const routerData = (html: string) => {
  const m = html.match(/window\._ROUTER_DATA\s*=\s*([\s\S]*?)<\/script>/);
  if (!m) return null;
  try { return JSON.parse(m[1].trim().replace(/;\s*$/, '')); } catch { return null; }
};
export const isDead = (html: string) => /The content (you are looking for )?does not exist/i.test(html);

export type PageResult = { kind: 'ok'; data: any } | { kind: 'dead' } | { kind: 'retry'; reason: string };

// One fetch attempt's outcome. Anything that is neither content nor "gone" is retried.
export function classifyPage(status: number, html: string, routeKey: string): PageResult {
  if (status === 404 || isDead(html)) return { kind: 'dead' };
  if (status >= 400) return { kind: 'retry', reason: `HTTP ${status}` };
  const d = routerData(html);
  const page = d?.loaderData?.[routeKey];
  if (page) return { kind: 'ok', data: page };
  return { kind: 'retry', reason: d ? `no ${routeKey} data` : 'js-only shell' };
}

function trailOf(tree: any, id: unknown): string[] {
  const target = String(id);
  const walk = (n: any, trail: string[]): string[] | null => {
    if (String(n.content_id) === target) return trail;
    for (const k of n.sub_contents || []) { const r = walk(k, [...trail, n.content_name]); if (r) return r; }
    return null;
  };
  return tree ? (walk(tree, []) || []) : [];
}

// Essay ids linked from a page (prev / next / recommended / sidebar): a safety
// net for anything the sitemap missed.
export function linkedIds(p: any): string[] {
  const ids: string[] = [];
  for (const k of ['prev_knowledge', 'next_knowledge']) if (p[k]?.learning_type === 2 && p[k].learning_id) ids.push(String(p[k].learning_id));
  for (const r of p.rec_content || []) if (r?.learning_type === 2 && r.learning_id) ids.push(String(r.learning_id));
  const walk = (n: any) => { if (n.content_type === 2) ids.push(String(n.content_id)); (n.sub_contents || []).forEach(walk); };
  if (p.sidebar_contents) walk(p.sidebar_contents);
  return [...new Set(ids)];
}

export function parseEssay(p: any, url: string): CrawlRecord {
  const kd = p.knowledge_detail || {};
  const li = p.learning_info || {};
  const text = clean(kd.knowledge_plain_content) || htmlToText(p.knowledge_content);
  const trail = trailOf(p.sidebar_contents, kd.knowledge_id);
  return {
    id: String(kd.knowledge_id || li.learning_id),
    kind: 'essay',
    url: p.canonical_url || url,
    title: clean(kd.knowledge_name || li.name),
    breadcrumb: trail.join(' > '),
    keywords: String(kd.keywords || '').split(',').map((s) => s.trim()).filter(Boolean),
    applies_to: p.country_scope_info?.tag_text || null,
    source: (p.sources || []).map((s: any) => s.source_name).filter(Boolean)[0] || null,
    ai_summary: li.active_ai_summary?.active ? clean(li.active_ai_summary.text) : (li.ai_summary ? clean(li.ai_summary) : null),
    toc: (p.toc_list || []).map((t: any) => ({ level: t.level, text: clean(t.text) })),
    text,
    views: li.views ?? null,
    created_at: toIso(li.create_time),
    modified_at: toIso(li.modify_time),
  };
}

export function parseCourse(p: any, learningId: string): CrawlRecord[] {
  const info = p.course_detail?.info || p.learning_info || {};
  const lessons = p.course_contents || p.course_detail?.course || [];
  return lessons.map((l: any, i: number) => {
    const k = l.knowledge || {};
    const id = String(k.knowledge_id || l.content_id);
    const isCurrent = String(p.current_content_item?.content_id) === id;
    const text = deltaToText(k.knowledge_content) || (isCurrent ? htmlToText(p.knowledge_content) : '');
    return {
      id,
      kind: 'course_lesson',
      url: `${TTS_BASE}/university/course?learning_id=${learningId}&content_id=${id}&lang=en`,
      title: clean(k.knowledge_name || l.content_name),
      breadcrumb: `Courses > ${clean(info.name)}`,
      course: { learning_id: String(learningId), name: clean(info.name), description: clean(info.description), lesson_index: i, lesson_count: lessons.length },
      keywords: String(k.keywords || '').split(',').map((s) => s.trim()).filter(Boolean),
      applies_to: null,
      source: (p.sources || []).map((s: any) => s.source_name).filter(Boolean)[0] || null,
      ai_summary: null,
      toc: [],
      text,
      lesson_type: l.type ?? null,
      views: info.views ?? null,
      created_at: toIso(info.create_time),
      modified_at: toIso(info.modify_time),
    };
  });
}

// A fetched page → its records, plus essay ids it links to (essays only).
export function pageRecords(item: CrawlItem, data: any): { records: CrawlRecord[]; links: string[] } {
  if (item.kind === 'essay') return { records: [parseEssay(data, item.url)], links: linkedIds(data) };
  return { records: parseCourse(data, item.item_id), links: [] };
}
