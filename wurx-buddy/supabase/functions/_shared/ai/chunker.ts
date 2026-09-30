// Structure-aware recursive chunker (A§6.1). Pure and deterministic: the same
// document and parameters always give the same chunks and hashes, which is
// what lets the worker skip re-embedding unchanged chunks.
//
//   metrics → one chunk (falls back to prose splitting only if it exceeds MAX)
//   table   → one row per line, balanced groups of ≤ TABLE_ROWS_PER_CHUNK rows
//   prose   → ≤ MAX as one chunk; else headings → paragraphs → lines →
//             sentences → hard cut, packed greedily to TARGET with an OVERLAP
//             tail carried forward; chunks < MIN merge into a neighbour of the
//             same section
//   cap     → MAX_CHUNKS_PER_DOC (sections come in priority order, so the tail goes)
//
// Sizes are budgets for the WHOLE chunk: the header + "§ title" line is
// reserved first, so token_count never exceeds MAX.

import { DEFAULT_CONFIG } from './config.ts';
import type { ChunkParams } from './config.ts';
import { sha256Hex } from './hash.ts';
import { estimateTokens, normalizeText, toEmbedText } from './text.ts';
import type { Chunk, DocSection, ExtractedDoc } from './types.ts';

export type ChunkOptions = {
  model?: string;
  tableRowsPerChunk?: number;
  maxChunksPerDoc?: number;
  embedMaxTokens?: number;
};
export type ChunkResult = { chunks: Chunk[]; capped: boolean; totalBeforeCap: number };

type Piece = { text: string; sep: string; heading?: string };
type Draft = { heading?: string; overlap: string; body: string };

const HEADING_MAX_CHARS = 80;
const tok = estimateTokens;

// Levels below headings: blank-line paragraphs, lines, sentences. The line
// level matters for SOPs and TikTok articles, which use single newlines only.
const LEVELS: { re: RegExp; sep: string }[] = [
  { re: /\n\s*\n/, sep: '\n\n' },
  { re: /\n/, sep: '\n' },
  { re: /(?<=[.!?])\s+/, sep: ' ' },
];

function hardCut(text: string, maxTok: number, leadSep: string): Piece[] {
  const maxChars = Math.max(1, maxTok * 4);
  const out: Piece[] = [];
  let rest = text.trim();
  while (rest.length > maxChars) {
    let cut = rest.lastIndexOf(' ', maxChars);
    if (cut < maxChars * 0.6) cut = maxChars;
    out.push({ text: rest.slice(0, cut).trim(), sep: out.length ? ' ' : leadSep });
    rest = rest.slice(cut).trim();
  }
  if (rest) out.push({ text: rest, sep: out.length ? ' ' : leadSep });
  return out;
}

function splitRec(text: string, level: number, maxTok: number, leadSep: string): Piece[] {
  if (tok(text) <= maxTok) return [{ text, sep: leadSep }];
  if (level >= LEVELS.length) return hardCut(text, maxTok, leadSep);
  const parts = text.split(LEVELS[level].re).map((p) => p.trim()).filter(Boolean);
  if (parts.length <= 1) return splitRec(text, level + 1, maxTok, leadSep);
  return parts.flatMap((p, i) => splitRec(p, level + 1, maxTok, i === 0 ? leadSep : LEVELS[level].sep));
}

function splitByHeadings(text: string): { heading?: string; text: string }[] {
  const blocks: { heading?: string; lines: string[] }[] = [{ lines: [] }];
  for (const line of text.split('\n')) {
    const m = /^#{1,6}\s+(.+)$/.exec(line);
    if (m) blocks.push({ heading: m[1].trim(), lines: [line] });
    else blocks[blocks.length - 1].lines.push(line);
  }
  return blocks.map((b) => ({ heading: b.heading, text: b.lines.join('\n').trim() })).filter((b) => b.text);
}

function proseToPieces(text: string, pieceMax: number): Piece[] {
  return splitByHeadings(text).flatMap((b) =>
    splitRec(b.text, 0, pieceMax, '\n\n').map((p) => ({ ...p, heading: b.heading })));
}

// Trailing text of `text`, at most `maxTok` tokens and half the text, starting
// at a sentence/line boundary when there is one.
function tail(text: string, maxTok: number): string {
  const maxChars = Math.min(maxTok * 4, Math.floor(text.length / 2));
  if (maxChars <= 0) return '';
  const s = text.slice(text.length - maxChars);
  const b = /[.!?]\s+|\n/.exec(s) ?? /\s/.exec(s);
  const out = (b ? s.slice(b.index + b[0].length) : s).trim();
  return out || s.trim();
}

const draftText = (d: Draft) => (d.overlap ? `${d.overlap}\n${d.body}` : d.body);

function pack(pieces: Piece[], target: number, bodyMax: number, overlapTok: number): Draft[] {
  const out: Draft[] = [];
  let cur: Draft | null = null;
  for (const p of pieces) {
    if (cur) {
      const joined = cur.body + p.sep + p.text;
      if (tok(cur.overlap ? `${cur.overlap}\n${joined}` : joined) <= target) { cur.body = joined; continue; }
      out.push(cur);
      const room = bodyMax - tok(p.text) - 1;
      const ov: string = overlapTok > 0 && room > 0 ? tail(cur.body, Math.min(overlapTok, room)) : '';
      cur = { heading: p.heading, overlap: ov, body: p.text };
    } else {
      cur = { heading: p.heading, overlap: '', body: p.text };
    }
  }
  if (cur) out.push(cur);
  return out;
}

function mergeSmall(drafts: Draft[], minTok: number, bodyMax: number): Draft[] {
  const d = drafts.slice();
  for (let i = 0; i < d.length && d.length > 1; ) {
    if (tok(d[i].body) >= minTok) { i++; continue; }
    const prev = d[i - 1];
    const next = d[i + 1];
    if (prev && tok(`${draftText(prev)}\n${d[i].body}`) <= bodyMax) {
      prev.body = `${prev.body}\n${d[i].body}`;
      d.splice(i, 1);
    } else if (next && tok(`${draftText(d[i])}\n${next.body}`) <= bodyMax) {
      // next.overlap was a tail of d[i].body, which now sits inside next.body.
      next.body = `${d[i].body}\n${next.body}`;
      next.overlap = d[i].overlap;
      next.heading = d[i].heading ?? next.heading;
      d.splice(i, 1);
    } else {
      i++;
    }
  }
  return d;
}

function tableDrafts(text: string, rowsPer: number, bodyMax: number): Draft[] {
  const rows = text.split('\n').map((l) => l.trim()).filter(Boolean);
  const groups = Math.ceil(rows.length / rowsPer);
  const base = Math.floor(rows.length / groups);
  const extra = rows.length % groups;
  const out: Draft[] = [];
  for (let g = 0, at = 0; g < groups; g++) {
    const n = base + (g < extra ? 1 : 0);
    const body = rows.slice(at, at + n).join('\n');
    at += n;
    if (tok(body) <= bodyMax) { out.push({ overlap: '', body }); continue; }
    const pieces = body.split('\n').flatMap((r, i) => splitRec(r, 2, bodyMax, i ? '\n' : ''));
    out.push(...pack(pieces, bodyMax, bodyMax, 0));
  }
  return out;
}

function sectionDrafts(s: DocSection, text: string, p: ChunkParams, reserve: number, rowsPer: number): Draft[] {
  const bodyMax = Math.max(16, p.max - reserve);
  const target = Math.min(p.target, bodyMax);
  if (s.kind === 'table') return tableDrafts(text, rowsPer, bodyMax);
  if (tok(text) <= bodyMax) return [{ overlap: '', body: text }];
  return mergeSmall(pack(proseToPieces(text, target), target, bodyMax, p.overlap), p.min, bodyMax);
}

const sectionLine = (s: DocSection, heading?: string) =>
  `§ ${s.title}${heading ? ` › ${heading.slice(0, HEADING_MAX_CHARS)}` : ''}`;

export async function chunkDocument(doc: ExtractedDoc, params: ChunkParams, opts: ChunkOptions = {}): Promise<ChunkResult> {
  const model = opts.model ?? DEFAULT_CONFIG.EMBED_MODEL;
  const rowsPer = opts.tableRowsPerChunk ?? DEFAULT_CONFIG.TABLE_ROWS_PER_CHUNK;
  const cap = opts.maxChunksPerDoc ?? DEFAULT_CONFIG.MAX_CHUNKS_PER_DOC;
  const embedMax = opts.embedMaxTokens ?? DEFAULT_CONFIG.EMBED_MAX_TOKENS;
  const header = normalizeText(doc.header).replace(/\s+/g, ' ');

  const all: { section: DocSection; draft: Draft }[] = [];
  for (const s of doc.sections) {
    const text = normalizeText(s.text);
    if (!text) continue;
    // Reserve room for the header and the longest possible "§ title › heading" line.
    const reserve = tok(`${header}\n${sectionLine(s, 'x'.repeat(HEADING_MAX_CHARS))}\n`);
    for (const draft of sectionDrafts(s, text, params, reserve, rowsPer)) all.push({ section: s, draft });
  }

  const kept = all.slice(0, cap);
  const chunks: Chunk[] = [];
  for (const [i, { section, draft }] of kept.entries()) {
    const showHeading = draft.heading && !/^#{1,6}\s/.test(draft.body) ? draft.heading : undefined;
    const content = `${header}\n${sectionLine(section, showHeading)}\n${draftText(draft)}`;
    const embed_text = toEmbedText(content, embedMax);
    chunks.push({
      chunk_index: i,
      section: section.key,
      content,
      embed_text,
      token_count: tok(embed_text),
      content_hash: await sha256Hex(`${embed_text}|${model}`),
    });
  }
  return { chunks, capped: all.length > cap, totalBeforeCap: all.length };
}
