// QA T0: the only real OpenAI call of the Phase 2B plan. 3 synthetic strings,
// < 100 tokens (≈ $0.000002). Nothing is written anywhere; the key is read
// from ../.env.dev and never printed.
//   node --experimental-strip-types tests/ingest/t0-embed.test.mjs
import { readEnv } from '../../scripts/dev-env.mjs';
import { embedTexts } from '../../supabase/functions/_shared/ai/embedder.ts';

const key = readEnv().OPEN_AI_API_KEY;
if (!key) { console.error('OPEN_AI_API_KEY missing in ../.env.dev'); process.exit(1); }
const r = await embedTexts(['qa one', 'qa two', 'qa three'], { apiKey: key });
const ok = r.vectors.length === 3 && r.vectors.every((v) => v.length === 1536) && r.batches === 1 && r.requests >= 1 && r.usage.totalTokens > 0 && r.usage.totalTokens < 100;
const norm = r.vectors.map((v) => Math.sqrt(v.reduce((a, x) => a + x * x, 0)).toFixed(3));
console.log(`${ok ? 'ok  ' : 'FAIL'} T0 real embedder: ${r.vectors.length} vectors × ${r.vectors[0]?.length} dims, ${r.batches} batch, ${r.requests} request(s), ${r.usage.totalTokens} tokens, norms ${norm.join('/')}`);
process.exitCode = ok ? 0 : 1;
