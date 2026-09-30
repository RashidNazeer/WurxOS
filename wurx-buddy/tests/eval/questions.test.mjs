// Offline schema check for the eval set:  node --test tests/eval/questions.test.mjs
// No database, no network. Guards ids, required fields, the Phase 5 retrieval labels
// (expected_index, answer_policy, ...) and the privacy rule (live rows store SQL only).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isLive } from './grade.mjs';

const FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'questions.jsonl');
const lines = fs.readFileSync(FILE, 'utf8').split(/\r?\n/).filter(Boolean);
const rows = lines.map((l) => JSON.parse(l));

const CATEGORIES = new Set(['how_to', 'sop', 'tiktok', 'report_lookup', 'report_narrative', 'aggregation', 'comparison', 'people_data', 'mixed', 'follow_up', 'ambiguous', 'permission', 'out_of_scope']);
const GRADING = new Set(['exact_number', 'facts', 'must_clarify', 'must_refuse', 'citation']);
const ROLES = new Set(['boss', 'apc', 'tl', 'ipc', 'ol']);
const ORIGINS = new Set(['owner_history', 'drafted', 'owner_request']);
const SOURCE_TYPES = new Set(['report', 'ai_doc', 'kb_article', 'tts_article', 'app_guide', 'incentive']);
const INDEXES = new Set(['company', 'reports', 'tiktok', 'incentives', 'mixed']);
const INDEX_OF = { kb_article: 'company', ai_doc: 'company', app_guide: 'company', report: 'reports', tts_article: 'tiktok', incentive: 'incentives' };
const POLICIES = new Set(['company_first', 'tiktok_authoritative', 'both_labelled', 'conflict_flag', 'link_only']);
const UNITS = new Set(['money', 'count', 'pct', 'x', 'days', 'score']);
const CURRENCIES = new Set(['USD', 'GBP', 'PKR', null]);
// The only ai_assistant_docs NOT merged into a KB article (kb_article_id is null on dev, 2026-09-29).
const CURATED_AI_DOCS = new Set(['72981150-e531-48c9-827c-8d92894ab903', '228a6438-42b6-4498-8a31-02cb51b7097c', 'c6416168-e46d-416c-b874-d56c32cf20df', '7f944220-e979-44ee-9db4-83973858ecad', 'caf6233c-421e-43da-b19e-bcf1c6e00618', 'e3e4d0f3-12c0-40b0-8280-820f69f31024']);
const WRITE_SQL = /\b(insert|update|delete|drop|alter|grant|revoke|truncate|create|copy|call|do)\b\s/i;
const srcKey = (s) => `${s.source_type}:${s.source_id}`;

test('every line parses and ids are unique and well-formed', () => {
  assert.equal(rows.length, lines.length);
  const ids = rows.map((r) => r.id);
  const dup = ids.filter((id, i) => ids.indexOf(id) !== i);
  assert.deepEqual(dup, [], `duplicate ids: ${dup}`);
  for (const id of ids) assert.match(id, /^[a-z]{3}-\d{3}$/, id);
});

test('required fields and enums', () => {
  for (const r of rows) {
    const at = r.id;
    assert.ok(CATEGORIES.has(r.category), `${at}: category ${r.category}`);
    assert.ok(GRADING.has(r.grading), `${at}: grading ${r.grading}`);
    assert.ok(ROLES.has(r.role), `${at}: role ${r.role}`);
    assert.ok(ORIGINS.has(r.source_of_question), `${at}: source_of_question ${r.source_of_question}`);
    assert.equal(typeof r.question, 'string', at); assert.ok(r.question.trim().length > 0, at);
    for (const k of ['history', 'expected_numbers', 'expected_facts', 'expected_sources']) assert.ok(Array.isArray(r[k]), `${at}: ${k} not an array`);
    assert.equal(typeof r.must_refuse, 'boolean', at);
    assert.equal(r.draft, true, `${at}: every row stays draft until the Owner signs off`);
    if (r.grading === 'must_refuse' && r.id !== 'prm-010') assert.equal(r.must_refuse, true, at);
    if (r.source_of_question === 'owner_request') assert.ok(r.expected_behaviour, `${at}: owner_request rows need expected_behaviour`);
    if (r.grading === 'exact_number' && !isLive(r)) assert.ok(r.expected_sql, `${at}: exact_number rows need expected_sql`);
  }
});

test('sources: valid types, no duplicates, no merged ai_doc left (Phase 5 remap)', () => {
  for (const r of rows) {
    const all = [...r.expected_sources, ...(r.optional_sources ?? [])];
    for (const s of all) {
      assert.ok(SOURCE_TYPES.has(s.source_type), `${r.id}: source_type ${s.source_type}`);
      assert.ok(typeof s.source_id === 'string' && s.source_id.length > 0, r.id);
      if (s.source_type === 'ai_doc') assert.ok(CURATED_AI_DOCS.has(s.source_id), `${r.id}: ai_doc ${s.source_id} is merged into a KB article; cite the kb_article`);
    }
    const keys = all.map(srcKey);
    assert.equal(new Set(keys).size, keys.length, `${r.id}: a source is listed twice (expected + optional)`);
  }
});

test('expected_index: present exactly on rows with sources, consistent with their types', () => {
  for (const r of rows) {
    if (!r.expected_sources.length) {
      if (r.expected_index != null) assert.ok(INDEXES.has(r.expected_index), r.id);   // allowed: a search is still expected (e.g. unapproved-report rows)
      continue;
    }
    assert.ok(INDEXES.has(r.expected_index), `${r.id}: expected_index ${r.expected_index}`);
    const idx = new Set(r.expected_sources.map((s) => INDEX_OF[s.source_type]));
    if (idx.size > 1) assert.equal(r.expected_index, 'mixed', `${r.id}: sources span ${[...idx]}`);
    else if (r.expected_index !== 'mixed') assert.equal(r.expected_index, [...idx][0], r.id);
  }
});

test('overlap rows: answer policy, labels and retrieval match', () => {
  const ovl = rows.filter((r) => r.subset === 'phase5-overlap');
  assert.ok(ovl.length >= 20, `only ${ovl.length} overlap rows`);
  for (const r of ovl) {
    assert.ok(POLICIES.has(r.answer_policy), `${r.id}: answer_policy ${r.answer_policy}`);
    assert.ok(['sop', 'mixed'].includes(r.category), r.id);
    const both = ['both_labelled', 'conflict_flag'].includes(r.answer_policy);
    assert.equal(r.retrieval_match, both ? 'all' : 'any', r.id);
    if (both) {
      assert.deepEqual(r.must_label, ['Our SOP', 'TikTok Shop Academy'], r.id);
      assert.equal(r.expected_index, 'mixed', r.id);
    }
    if (r.answer_policy === 'company_first' || r.answer_policy === 'link_only') assert.equal(r.expected_index, 'company', r.id);
    if (r.answer_policy === 'tiktok_authoritative') assert.equal(r.expected_index, 'tiktok', r.id);
  }
  for (const p of POLICIES) assert.ok(ovl.some((r) => r.answer_policy === p), `no overlap row with policy ${p}`);
});

test('cross-brand report rows name no brand and number rows carry SQL', () => {
  const x = rows.filter((r) => r.subset === 'phase5-crossbrand');
  assert.ok(x.length >= 12, `only ${x.length} cross-brand rows`);
  const brands = /pure daily care|klassy|cutler|bentgo|aqua sonic|obagi|joymode|longevity|aurelia|swisse|kenashii|apothecary|yesday|dr\.? (tobias|harvey)|penetrex|inno supps/i;
  for (const r of x) {
    assert.doesNotMatch(r.question, brands, `${r.id} names a brand`);
    if (r.grading === 'exact_number') {
      assert.match(r.expected_sql, /status = 'approved'/, `${r.id}: approved-only`);
      assert.match(r.notes, /coverage|approved/i, `${r.id}: coverage note`);
    }
  }
});

test('answer rules are well-formed: must_not_contain untrimmed-safe, regexes compile, mentions grouped', () => {
  for (const r of rows) {
    // findLeaks trims needles, so " he " would become "he" and hit "the": use must_not_match instead.
    for (const s of r.must_not_contain ?? []) assert.equal(s, s.trim(), `${r.id}: must_not_contain "${s}" has edge whitespace`);
    for (const p of r.must_not_match ?? []) assert.doesNotThrow(() => new RegExp(p, 'i'), `${r.id}: bad regex ${p}`);
    for (const g of r.must_mention ?? []) assert.ok(Array.isArray(g) && g.length && g.every((x) => typeof x === 'string' && x.trim()), `${r.id}: must_mention group`);
    for (const s of r.forbidden_sources ?? []) {
      assert.ok(SOURCE_TYPES.has(s.source_type), r.id);
      assert.ok(!r.expected_sources.some((e) => srcKey(e) === srcKey(s)), `${r.id}: a source is both expected and forbidden`);
    }
  }
});

test('rule 6a: weekly-derived monthly figures carry the disclosure', () => {
  for (const r of rows.filter((x) => (x.expected_numbers ?? []).some((n) => /monthly reports do not record/i.test(n.label ?? '')))) {
    assert.ok((r.must_mention ?? []).length >= 2, `${r.id}: needs the must_mention disclosure groups`);
    assert.ok(r.must_mention.some((g) => g.includes('weekly')), r.id);
  }
});

test('stored numbers are well-formed; SQL is read-only', () => {
  for (const r of rows) {
    for (const n of r.expected_numbers) {
      assert.ok(n.value === null || Number.isFinite(n.value), r.id);
      assert.ok(UNITS.has(n.unit), `${r.id}: unit ${n.unit}`);
      assert.ok(CURRENCIES.has(n.currency ?? null), `${r.id}: currency ${n.currency}`);
      if (n.unit === 'money') assert.ok(n.currency, `${r.id}: money without currency`);
    }
    for (const k of ['expected_sql', 'person_sql', 'forbidden_sql', 'precondition_sql']) {
      if (r[k]) assert.doesNotMatch(r[k].replace(/'(?:[^']|'')*'/g, "''"), WRITE_SQL, `${r.id}.${k} is not read-only`);   // literals stripped: labels may say "do not record"
    }
  }
});

test('privacy: live rows store SQL only, never values or staff names', () => {
  for (const r of rows.filter(isLive)) {
    assert.deepEqual(r.expected_numbers, [], `${r.id}: live row has stored numbers`);
    assert.equal(r.expected_refreshed_at, undefined, `${r.id}: live row was refreshed`);
    if (r.person_ref || r.person_sql) assert.match(r.question, /\{person\}/, `${r.id}: person rows use the {person} placeholder`);
  }
  // Staff names never appear anywhere: the person placeholder is the only way to name one.
  for (const r of rows) assert.doesNotMatch(JSON.stringify(r), /"display_name":|"basic_salary":\s*\d/, r.id);
});
