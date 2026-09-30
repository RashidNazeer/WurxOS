// Refresh stored expected numbers in tests/eval/questions.jsonl from each row's
// expected_sql, against the DEV database (read-only transaction, always rolled back).
//
//   node tests/eval/refresh-expected.mjs            rewrite stored values
//   node tests/eval/refresh-expected.mjs --dry      print what would change, write nothing
//   node tests/eval/refresh-expected.mjs --check    only prove every SQL runs (row counts, no values)
//
// "Live" rows (people_data, anything touching pay / attendance / leave / performance /
// profiles, or needing :as_user_id) are NEVER written to the file: the grader runs
// their SQL at eval time. --check prints only their row count, never a value.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
// The shared host guard (QA L11): parses the URL and checks the host / pooler
// user, instead of a substring test a crafted URL could pass.
import { devDbUrl, SSL } from '../../scripts/dev-env.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FILE = path.join(HERE, 'questions.jsonl');
const url = devDbUrl();

const dry = process.argv.includes('--dry');
const check = process.argv.includes('--check');
const SENSITIVE = /employee_compensation|salary_history|\bincentives\b|performance_ratings|get_performance_composite|attendance|leave_requests|\bprofiles\b/i;
const isLive = (r, sql) => r.category === 'people_data' || !!r.person_ref || sql.includes(':as_user_id') || SENSITIVE.test(sql);

const rows = fs.readFileSync(FILE, 'utf8').split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l));
const client = new pg.Client({ connectionString: url, ssl: SSL });
await client.connect();
let changed = 0, failed = 0, live = 0, stored = 0;
try {
  await client.query('begin read only');
  for (const r of rows) {
    for (const key of ['expected_sql', 'person_sql', 'forbidden_sql', 'precondition_sql']) {
      const sql = r[key];
      if (!sql) continue;
      const runnable = sql.replaceAll(':as_user_id', "'00000000-0000-0000-0000-000000000000'::uuid");
      let res;
      try {
        await client.query('savepoint s');
        res = await client.query(runnable);
        await client.query('release savepoint s');
      } catch (e) {
        await client.query('rollback to savepoint s');
        failed++; console.log(`✗ ${r.id} ${key}: ${e.message}`); continue;
      }
      if (key !== 'expected_sql' || isLive(r, sql)) {
        if (key === 'expected_sql') live++;
        if (check) console.log(`· ${r.id} ${key}: ${res.rowCount} row(s) [live, values not shown]`);
        continue;
      }
      if (check) { console.log(`· ${r.id} ${key}: ${res.rowCount} row(s)`); continue; }
      stored++;
      const nums = res.rows.map((x) => ({
        value: x.value == null ? null : Number(x.value),
        currency: x.currency ?? null,
        unit: x.unit ?? null,
        label: x.label ?? null,
        ...(r.tolerance_abs != null ? { tolerance_abs: r.tolerance_abs } : { tolerance: r.tolerance ?? 0.005 }),
      }));
      const repSources = [...new Set(res.rows.map((x) => x.source_id).filter(Boolean))].map((id) => ({ source_type: 'report', source_id: id }));
      const sources = repSources.length
        ? [...(r.expected_sources || []).filter((s) => s.source_type !== 'report'), ...repSources]
        : r.expected_sources;
      if (JSON.stringify(nums) !== JSON.stringify(r.expected_numbers) || JSON.stringify(sources) !== JSON.stringify(r.expected_sources)) {
        changed++;
        if (dry) console.log(`~ ${r.id}: ${nums.map((n) => `${n.label}: ${n.value} ${n.currency || n.unit || ''}`).join(' | ')}`);
        r.expected_numbers = nums; r.expected_sources = sources;
        r.expected_refreshed_at = new Date().toISOString().slice(0, 10);
      }
    }
  }
} finally {
  await client.query('rollback');
  await client.end();
}
if (!dry && !check) fs.writeFileSync(FILE, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
console.log(`${rows.length} rows · stored ${stored} · live ${live} · changed ${changed} · failed ${failed}${dry || check ? ' (nothing written)' : ''}`);
process.exitCode = failed ? 1 : 0;
