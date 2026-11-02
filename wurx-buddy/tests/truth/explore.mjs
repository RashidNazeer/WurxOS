import { loadSnapshot, bossCtx } from './load.mjs';
import { runDataTool } from '../../../supabase/functions/_shared/ai/tools/index.ts';
const s = loadSnapshot();
const [name, argjson] = process.argv.slice(2);
const r = await runDataTool(s.db, bossCtx(), name, JSON.parse(argjson || '{}'));
console.log(r.text);
