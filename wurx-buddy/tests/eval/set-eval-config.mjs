// ============================================================
// QA helper for eval runs on DEV: set (and later restore) the two
// ai_assistant_config values an eval run needs. DEV ONLY; committed writes.
//
//   node tests/eval/set-eval-config.mjs show
//   node tests/eval/set-eval-config.mjs set --model gpt-5.5 --exempt <uuid>   saves the old values to --save <file> first
//   node tests/eval/set-eval-config.mjs restore --save <file>
//
// `model` is the Boss's default model; `retrieval.RATE_LIMIT_EXEMPT_USERS`
// exempts the eval user from the hourly cap. Nothing else is touched.
// ============================================================
import fs from 'node:fs';
import pg from 'pg';
import { devDbUrl, SSL } from '../../scripts/dev-env.mjs';

const [cmd, ...a] = process.argv.slice(2);
const opt = (f) => { const i = a.indexOf(f); return i >= 0 ? a[i + 1] : undefined; };
const c = new pg.Client({ connectionString: devDbUrl(), ssl: SSL, connectionTimeoutMillis: 30_000 });
await c.connect();
try {
  const cur = (await c.query(`select model, retrieval from public.ai_assistant_config where id = 1`)).rows[0];
  if (cmd === 'show') {
    console.log(JSON.stringify({ model: cur.model, exempt: cur.retrieval?.RATE_LIMIT_EXEMPT_USERS ?? [] }));
  } else if (cmd === 'set') {
    const save = opt('--save');
    if (!save) throw new Error('--save <file> required');
    if (!fs.existsSync(save)) fs.writeFileSync(save, JSON.stringify({ model: cur.model, retrieval: cur.retrieval }));
    const model = opt('--model') ?? cur.model;
    const exempt = opt('--exempt');
    const retrieval = { ...(cur.retrieval || {}) };
    if (exempt) retrieval.RATE_LIMIT_EXEMPT_USERS = [...new Set([...(retrieval.RATE_LIMIT_EXEMPT_USERS || []), exempt])];
    await c.query(`update public.ai_assistant_config set model = $1, retrieval = $2 where id = 1`, [model, retrieval]);
    console.log(`set: model ${model}, exempt ${JSON.stringify(retrieval.RATE_LIMIT_EXEMPT_USERS ?? [])}`);
  } else if (cmd === 'restore') {
    const s = JSON.parse(fs.readFileSync(opt('--save'), 'utf8'));
    await c.query(`update public.ai_assistant_config set model = $1, retrieval = $2 where id = 1`, [s.model, s.retrieval]);
    console.log(`restored: model ${s.model}, retrieval ${JSON.stringify(s.retrieval)}`);
  } else console.log('usage: show | set --model m --exempt uuid --save f | restore --save f');
} finally { await c.end(); }
