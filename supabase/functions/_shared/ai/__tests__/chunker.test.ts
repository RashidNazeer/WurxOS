import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chunkDocument } from '../chunker.ts';
import { chunkParamsFor } from '../config.ts';
import { sha256Hex } from '../hash.ts';
import type { DocSection, ExtractedDoc } from '../types.ts';

const HEADER = '[Test doc · Synthetic]';
const doc = (sections: DocSection[]): ExtractedDoc => ({ title: 'T', acl: { mode: 'all' }, metadata: {}, header: HEADER, sections });

// Deterministic filler: numbered sentences, so every chunk's text is unique.
const sentences = (n: number, from = 0) =>
  Array.from({ length: n }, (_, i) => `Sentence number ${from + i} explains one step of the process in plain words.`).join(' ');
const longProse = () => [
  `## Setup\n${sentences(20)}`,
  `${sentences(20, 100)}\n\n${sentences(15, 200)}`,
  `## Running\n${sentences(40, 300)}`,
  `## Wrap-up\n${sentences(3, 900)}`,
].join('\n\n');

const P = chunkParamsFor('report'); // 450 / 700 / 60 / 40
const bodyOf = (content: string) => content.split('\n').slice(2).join('\n');

test('deterministic: same input → identical chunks and hashes', async () => {
  const d = doc([{ key: 'p', title: 'Prose', kind: 'prose', text: longProse() }]);
  assert.deepEqual(await chunkDocument(d, P), await chunkDocument(d, P));
});

test('prose: split into several chunks, none above MAX, header + § on every chunk', async () => {
  const { chunks } = await chunkDocument(doc([{ key: 'p', title: 'Prose', kind: 'prose', text: longProse() }]), P);
  assert.ok(chunks.length >= 4, `got ${chunks.length}`);
  for (const c of chunks) {
    assert.ok(c.token_count <= P.max, `chunk ${c.chunk_index} has ${c.token_count} tokens`);
    assert.ok(c.content.startsWith(`${HEADER}\n§ Prose`));
    assert.ok(c.embed_text.startsWith(`${HEADER} § Prose`));
    assert.equal(c.section, 'p');
  }
  assert.deepEqual(chunks.map((c) => c.chunk_index), chunks.map((_, i) => i));
  assert.ok(chunks.some((c) => c.content.includes('§ Prose › Running')), 'sub-heading carried into the § line');
});

test('prose: consecutive chunks overlap by a tail of ≤ OVERLAP tokens', async () => {
  const { chunks } = await chunkDocument(doc([{ key: 'p', title: 'Prose', kind: 'prose', text: sentences(120) }]), P);
  assert.ok(chunks.length >= 3);
  for (let i = 1; i < chunks.length; i++) {
    const firstLine = bodyOf(chunks[i].content).split('\n')[0];
    assert.ok(firstLine.length > 0 && firstLine.length <= P.overlap * 4, `overlap length ${firstLine.length}`);
    assert.ok(bodyOf(chunks[i - 1].content).endsWith(firstLine), `chunk ${i} does not start with the tail of chunk ${i - 1}`);
  }
});

test('prose under MAX stays one chunk; small trailing pieces merge into their neighbour', async () => {
  const one = await chunkDocument(doc([{ key: 'p', title: 'Short', kind: 'prose', text: sentences(8) }]), P);
  assert.equal(one.chunks.length, 1);
  // 450-token pieces then a tiny tail: the tail must not become its own chunk.
  const { chunks } = await chunkDocument(doc([{ key: 'p', title: 'P', kind: 'prose', text: `${sentences(60)}\n\nTiny end.` }]), P);
  const last = chunks[chunks.length - 1];
  assert.ok(last.content.includes('Tiny end.'));
  assert.ok(bodyOf(last.content).length / 4 >= P.min, 'last chunk is not below MIN');
});

test('hard cut: a wall of text with no separators still respects MAX', async () => {
  const { chunks } = await chunkDocument(doc([{ key: 'w', title: 'Wall', kind: 'prose', text: 'x'.repeat(12000) }]), P);
  assert.ok(chunks.length >= 4);
  for (const c of chunks) assert.ok(c.token_count <= P.max);
});

test('tables: balanced groups of ≤ TABLE_ROWS_PER_CHUNK rows, no overlap', async () => {
  const rows = (n: number) => Array.from({ length: n }, (_, i) => `- Creator: c${i}, GMV: ${i}.00`).join('\n');
  const r30 = await chunkDocument(doc([{ key: 't', title: 'Top creators', kind: 'table', text: rows(30) }]), P);
  assert.deepEqual(r30.chunks.map((c) => bodyOf(c.content).split('\n').length), [10, 10, 10]);
  const r13 = await chunkDocument(doc([{ key: 't', title: 'Top creators', kind: 'table', text: rows(13) }]), P);
  assert.deepEqual(r13.chunks.map((c) => bodyOf(c.content).split('\n').length), [7, 6]);
  const all = r30.chunks.flatMap((c) => bodyOf(c.content).split('\n'));
  assert.equal(new Set(all).size, 30, 'every row exactly once');
});

test('metrics: one chunk, never split', async () => {
  const text = Array.from({ length: 30 }, (_, i) => `Metric ${i}: ${i}`).join('; ');
  const { chunks } = await chunkDocument(doc([{ key: 'summary', title: 'Summary', kind: 'metrics', text }]), P);
  assert.equal(chunks.length, 1);
});

test('empty sections are dropped', async () => {
  const { chunks } = await chunkDocument(doc([
    { key: 'a', title: 'A', kind: 'prose', text: '  \n ' },
    { key: 'b', title: 'B', kind: 'table', text: '' },
    { key: 'c', title: 'C', kind: 'prose', text: 'Real text.' },
  ]), P);
  assert.deepEqual(chunks.map((c) => c.section), ['c']);
});

test('MAX_CHUNKS_PER_DOC cap keeps the first sections and reports it', async () => {
  const sections: DocSection[] = Array.from({ length: 60 }, (_, i) => ({ key: `s${i}`, title: `S${i}`, kind: 'prose', text: `Section ${i} text.` }));
  const r = await chunkDocument(doc(sections), P);
  assert.equal(r.chunks.length, 40);
  assert.equal(r.capped, true);
  assert.equal(r.totalBeforeCap, 60);
  assert.equal(r.chunks[39].section, 's39');
  const small = await chunkDocument(doc(sections), P, { maxChunksPerDoc: 5 });
  assert.equal(small.chunks.length, 5);
});

test('content_hash = sha256(embed_text | model); a model change changes it', async () => {
  const d = doc([{ key: 'c', title: 'C', kind: 'prose', text: 'Hello world.' }]);
  const [a] = (await chunkDocument(d, P)).chunks;
  assert.equal(a.content_hash, await sha256Hex(`${a.embed_text}|text-embedding-3-small`));
  const [b] = (await chunkDocument(d, P, { model: 'other-model' })).chunks;
  assert.notEqual(a.content_hash, b.content_hash);
  assert.equal(a.embed_text, b.embed_text);
});
