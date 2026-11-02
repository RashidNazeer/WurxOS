import { prodQuery } from './lib.mjs';
import fs from 'node:fs';
const sel = `select c.id, d.id doc, d.source_type st, d.title, c.section, c.embed_text et, c.token_count tc from ai_chunks c join ai_documents d on d.id=c.document_id and d.status='active'`;
const a = await prodQuery(`${sel} where d.source_type in ('app_guide','kb_article','ai_doc')`);
const t = await prodQuery(`${sel} where d.source_type='tts_article' order by md5(c.id::text) limit 1800`);
const all = [...a, ...t];
fs.writeFileSync(process.argv[2], JSON.stringify(all));
console.log(a.length, t.length, all.reduce((s,x)=>s+x.tc,0), 'tokens(content)', Math.max(...all.map(x=>x.et.length)));
