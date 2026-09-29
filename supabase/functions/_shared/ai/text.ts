// Text normalisation shared by every extractor and the chunker (A§6.4).

export const SOP_SENTINEL = '<!--wurx-sop-import-->';

const NAMED: Record<string, string> = {
  nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'",
  lsquo: "'", rsquo: "'", ldquo: '"', rdquo: '"', sbquo: "'", bdquo: '"',
  ndash: '–', mdash: '—', hellip: '…', bull: '•', middot: '·',
  rarr: '→', larr: '←', uarr: '↑', darr: '↓', times: '×', divide: '÷',
  copy: '©', reg: '®', trade: '™', deg: '°', euro: '€', pound: '£', yen: '¥', cent: '¢',
  laquo: '«', raquo: '»', shy: '', zwj: '', zwnj: '', ensp: ' ', emsp: ' ', thinsp: ' ',
};

// Single pass, so "&amp;lt;" becomes "&lt;" (not "<").
export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const cp = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(cp) && cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : m;
    }
    const v = NAMED[e.toLowerCase()];
    return v === undefined ? m : v;
  });
}

const ZERO_WIDTH = /[​-‍⁠﻿­]/g;
const SENTINEL_RE = /\s*<!--wurx-sop-import-->\s*/g;

export const stripSentinel = (s: string) => s.replace(SENTINEL_RE, '\n').trim();

// Keeps line structure: trims line ends, collapses runs of spaces, at most one
// blank line in a row.
export function normalizeText(s: unknown): string {
  return String(s ?? '')
    .replace(SENTINEL_RE, '\n')
    .replace(/\r\n?/g, '\n')
    .replace(ZERO_WIDTH, '')
    .replace(/[   ]/g, ' ')
    .replace(/[ \t\f\v]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

const TAG_RE = /<\/?[a-zA-Z][^>]*>/;

// Rich-text (HTML) → plain text. Same rules as htmlToText in ai-chat, plus
// <li> bullets and headings on their own lines. Plain text passes through
// untouched apart from entity decoding, so "ROI < 2 and > 1" survives.
export function htmlToText(s: unknown): string {
  let t = String(s ?? '');
  if (TAG_RE.test(t) || t.includes('<!--')) {
    t = t
      .replace(/<!--[\s\S]*?-->/g, '\n')
      .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '')
      .replace(/<h[1-6]\b[^>]*>/gi, '\n\n')
      .replace(/<\/h[1-6]\s*>/gi, '\n')
      .replace(/<li\b[^>]*>/gi, '\n• ')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(p|div|tr|ul|ol|blockquote|pre|table)\s*>/gi, '\n')
      .replace(/<\/t[dh]\s*>/gi, ' ')
      .replace(/<\/?[a-zA-Z][^>]*>/g, '');
  }
  return normalizeText(decodeEntities(t));
}

// What gets embedded: one line, whitespace collapsed, capped (A§6.4).
export function toEmbedText(s: string, maxTokens: number): string {
  const flat = normalizeText(s).replace(/\s+/g, ' ');
  return flat.length > maxTokens * 4 ? flat.slice(0, maxTokens * 4) : flat;
}

export const estimateTokens = (s: string) => Math.ceil(s.length / 4);

// Report values that mean "nothing here" (inventory §2).
const PLACEHOLDERS = new Set(['', 'n/a', 'na', 'null', 'undefined', 'not_available_yet', 'not available yet', '-', '—', '–']);
export const isPlaceholder = (v: unknown) =>
  v == null || (typeof v === 'string' && PLACEHOLDERS.has(normalizeText(v).toLowerCase()));

const ACRONYMS: Record<string, string> = {
  gmv: 'GMV', roi: 'ROI', cpo: 'CPO', ctr: 'CTR', ctor: 'CTOR', sku: 'SKU', mtd: 'MTD', crm: 'CRM',
  id: 'ID', url: 'URL', kpi: 'KPI', kpis: 'KPIs', live: 'LIVE', sop: 'SOP', sops: 'SOPs',
};
// camelCase / snake_case key → "Sentence case" label.
export function humanize(key: string): string {
  const words = key.replace(/([a-z])([A-Z0-9])/g, '$1 $2').replace(/([0-9])([A-Za-z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ').trim().split(/\s+/);
  return words.map((w, i) => {
    const l = w.toLowerCase();
    if (ACRONYMS[l]) return ACRONYMS[l];
    return i === 0 ? l.charAt(0).toUpperCase() + l.slice(1) : l;
  }).join(' ');
}

// A single-line value (table cell, metric): HTML stripped, whitespace collapsed.
export function cleanValue(v: unknown): string {
  if (v == null || typeof v === 'object') return '';
  const t = htmlToText(String(v)).replace(/\s+/g, ' ').trim();
  return isPlaceholder(t) ? '' : t;
}
