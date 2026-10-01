// DEV ONLY: move nemotron-3-ultra behind the other backups (it wrote tool calls as text).
import pg from 'pg';
import { devDbUrl, SSL } from './dev-env.mjs';
const db = new pg.Client({ connectionString: devDbUrl(), ssl: SSL });
await db.connect();
const { rows: [c] } = await db.query('select fallback_models from public.ai_assistant_config where id = 1');
const chain = c.fallback_models || [];
const isNem = (e) => /nemotron/i.test(e.model);
const next = [...chain.filter((e) => !isNem(e)), ...chain.filter(isNem)];
await db.query('update public.ai_assistant_config set fallback_models = $1::jsonb where id = 1', [JSON.stringify(next)]);
console.log('dev backup order:', next.map((e) => `${e.key_slot}:${e.model}`).join(' -> '));
await db.end();

