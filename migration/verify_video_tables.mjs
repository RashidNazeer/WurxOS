import { sb } from './lib/supabase.js';
import { createClient } from '@supabase/supabase-js';
import { config as loadEnv } from 'dotenv';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
loadEnv({ path: resolve(__dirname, '..', '.env.local') });

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  OK  ', m); } else { fail++; console.log('  FAIL', m); } };

// A real brand to satisfy the FK (we clean up after).
const { data: brand } = await sb.from('brands').select('id, brand_name').limit(1).single();
console.log('Using brand:', brand.brand_name, brand.id, '\n');
const B = brand.id;

// --- baseline round-trip ---
await sb.from('video_review_settings').delete().eq('brand_id', B);
let r = await sb.from('video_review_settings').upsert({ brand_id: B, start_date: '2026-07-13' }, { onConflict: 'brand_id' });
ok(!r.error, 'insert baseline ' + (r.error?.message || ''));
r = await sb.from('video_review_settings').select('start_date').eq('brand_id', B).single();
ok(r.data?.start_date === '2026-07-13', 'read baseline back = 2026-07-13');

// --- progress upsert + read ---
await sb.from('video_review_progress').delete().eq('brand_id', B);
r = await sb.from('video_review_progress').upsert([
  { brand_id: B, creator: 'zz_test_creator_a', sent_count: 1, last_sent_date: '2026-07-13' },
  { brand_id: B, creator: 'zz_test_creator_b', sent_count: 3, last_sent_date: '2026-07-12' },
], { onConflict: 'brand_id,creator' });
ok(!r.error, 'upsert 2 progress rows ' + (r.error?.message || ''));
r = await sb.from('video_review_progress').select('creator, sent_count, last_sent_date').eq('brand_id', B).order('creator');
ok(r.data?.length === 2, 'read back 2 rows');
ok(r.data?.[0]?.sent_count === 1, 'row A sent_count = 1');

// --- upsert advances (simulate mark-sent next day) ---
r = await sb.from('video_review_progress').upsert(
  [{ brand_id: B, creator: 'zz_test_creator_a', sent_count: 2, last_sent_date: '2026-07-14' }],
  { onConflict: 'brand_id,creator' });
ok(!r.error, 'advance row A to sent_count 2');
r = await sb.from('video_review_progress').select('sent_count').eq('brand_id', B).eq('creator', 'zz_test_creator_a').single();
ok(r.data?.sent_count === 2, 'row A advanced to 2 (no duplicate)');

// --- check constraint rejects sent_count = 4 ---
r = await sb.from('video_review_progress').upsert(
  [{ brand_id: B, creator: 'zz_test_creator_c', sent_count: 4 }], { onConflict: 'brand_id,creator' });
ok(!!r.error, 'sent_count = 4 rejected by CHECK (' + (r.error ? 'blocked' : 'LEAKED') + ')');

// --- RLS: anon key must see nothing ---
const anonKey = process.env.VITE_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY;
if (anonKey) {
  const anon = createClient(process.env.VITE_SUPABASE_URL, anonKey, { auth: { persistSession: false } });
  const a1 = await anon.from('video_review_progress').select('creator').limit(5);
  ok((a1.data?.length || 0) === 0, 'anon reads 0 progress rows (RLS on): got ' + (a1.data?.length ?? 'err ' + a1.error?.code));
  const a2 = await anon.from('video_review_settings').select('brand_id').limit(5);
  ok((a2.data?.length || 0) === 0, 'anon reads 0 settings rows (RLS on): got ' + (a2.data?.length ?? 'err ' + a2.error?.code));
  const a3 = await anon.from('video_review_progress').insert({ brand_id: B, creator: 'hacker', sent_count: 1 });
  ok(!!a3.error, 'anon insert blocked by RLS (' + (a3.error ? a3.error.code : 'LEAKED') + ')');
} else {
  console.log('  (no anon key in .env.local — skipped RLS anon checks)');
}

// --- cleanup ---
await sb.from('video_review_progress').delete().eq('brand_id', B);
await sb.from('video_review_settings').delete().eq('brand_id', B);
const c1 = await sb.from('video_review_progress').select('creator').eq('brand_id', B);
ok((c1.data?.length || 0) === 0, 'cleanup: progress rows removed');

console.log(`\n${fail === 0 ? 'ALL GOOD' : 'HAS FAILURES'} — pass ${pass}, fail ${fail}`);
