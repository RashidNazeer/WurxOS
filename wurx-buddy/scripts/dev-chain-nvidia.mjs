// DEV ONLY: paid OpenAI gpt-5.4-mini as the main model, the two NVIDIA models first in the
// backup order, followed by whatever backups dev already had (deduped, max 6). Owner, 2026-10-01:
// "add them as default models with paid Open AI keys". Production keeps its own settings.
//   node scripts/dev-chain-nvidia.mjs
import pg from 'pg';
import { devDbUrl, SSL } from './dev-env.mjs';

const HEAD = [{ key_slot: 'nvidia', model: 'nvidia/nemotron-3-ultra-550b-a55b' }, { key_slot: 'nvidia', model: 'openai/gpt-oss-20b' }];
const db = new pg.Client({ connectionString: devDbUrl(), ssl: SSL });   // refuses anything but the dev project
await db.connect();
const { rows: [cfg] } = await db.query('select fallback_models from public.ai_assistant_config where id = 1');
const seen = new Set();
const chain = [...HEAD, ...(cfg?.fallback_models || [])]
  .filter((e) => { const k = `${e.key_slot}:${e.model}`; if (seen.has(k)) return false; seen.add(k); return true; })
  .slice(0, 6);
await db.query(`update public.ai_assistant_config set model = 'gpt-5.4-mini', model_key_slot = 'primary', fallback_models = $1::jsonb where id = 1`, [JSON.stringify(chain)]);
console.log('dev main model: primary:gpt-5.4-mini');
console.log('dev backup order:', chain.map((e) => `${e.key_slot}:${e.model}`).join(' -> '));
await db.end();
