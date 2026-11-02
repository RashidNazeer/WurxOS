// usage: node embed.mjs <provider: nvidia|g1|g2> corpus.json queries.json outPrefix
import { env } from './lib.mjs';
import fs from 'node:fs';
const [prov, corpusF, qF, out] = process.argv.slice(2);
const e = env('.env.dev');
const corpus = JSON.parse(fs.readFileSync(corpusF));
const queries = JSON.parse(fs.readFileSync(qF));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const norm = v => { const n = Math.sqrt(v.reduce((a,x)=>a+x*x,0)); return n ? v.map(x=>x/n) : v; };
const log = []; const stat = { requests:0, r429:0, items:0, tokens:0, ms:0, msgs:[] };
const cfg = {
  nvidia: { batch: 64, perMin: 1e9 },
  g1: { batch: 50, perMin: 80, model: 'gemini-embedding-001' },
  g2: { batch: 50, perMin: 80, model: 'gemini-embedding-2' },
}[prov];
async function call(texts, kind) {
  for (let attempt = 0; ; attempt++) {
    const t0 = Date.now(); stat.requests++;
    let r, txt;
    try {
      if (prov === 'nvidia') {
        r = await fetch('https://integrate.api.nvidia.com/v1/embeddings', { method:'POST', signal: AbortSignal.timeout(60000), headers:{authorization:`Bearer ${e.NEM_API}`,'content-type':'application/json'},
          body: JSON.stringify({ model:'nvidia/llama-nemotron-embed-vl-1b-v2', input:texts, dimensions:1536, input_type: kind==='q'?'query':'passage', encoding_format:'float' }) });
      } else {
        const reqs = texts.map(t => ({ model:`models/${cfg.model}`, content:{parts:[{text:t}]}, taskType: kind==='q'?'RETRIEVAL_QUERY':'RETRIEVAL_DOCUMENT', outputDimensionality:1536 }));
        r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${cfg.model}:batchEmbedContents`, { method:'POST', signal: AbortSignal.timeout(90000), headers:{'x-goog-api-key':e.Gemini_Fallback,'content-type':'application/json'}, body: JSON.stringify({requests:reqs}) });
      }
      txt = await r.text();
    } catch (err) { console.log('net', String(err).slice(0,80)); await sleep(5000); continue; }
    stat.ms += Date.now()-t0;
    if (r.status === 200) {
      const j = JSON.parse(txt); stat.items += texts.length;
      if (prov === 'nvidia') { stat.tokens += j.usage?.total_tokens ?? 0; return j.data.sort((a,b)=>a.index-b.index).map(d=>d.embedding); }
      return j.embeddings.map(d => norm(d.values));
    }
    if (r.status === 429) {
      stat.r429++;
      const m = txt.replace(/\s+/g,' ');
      if (stat.msgs.length < 6) stat.msgs.push(m.slice(0, 700));
      console.log(new Date().toISOString().slice(11,19), '429', m.slice(0, 300));
      const daily = /PerDay|per day|daily/i.test(m);
      if (daily) { console.log('DAILY QUOTA HIT; stopping'); fs.writeFileSync(`${out}.${prov}.stat.json`, JSON.stringify({ ...stat, stoppedDaily:true })); process.exit(3); }
      await sleep(65000); continue;
    }
    console.log('http', r.status, txt.slice(0, 200)); if (attempt > 3) throw new Error('giving up'); await sleep(8000);
  }
}
let winStart = Date.now(), winN = 0;
async function run(items, kind, name) {
  const vecs = []; const tStart = Date.now(); let sent = 0;
  for (let i = 0; i < items.length; i += cfg.batch) {
    const b = items.slice(i, i + cfg.batch);
    if (cfg.perMin < 1e9 && winN + b.length > cfg.perMin) { const w = 61000 - (Date.now()-winStart); if (w > 0) await sleep(w); winStart = Date.now(); winN = 0; }
    vecs.push(...await call(b, kind)); winN += b.length; sent += b.length;
    if ((i/cfg.batch) % 10 === 0) console.log(name, sent, '/', items.length, Math.round((Date.now()-tStart)/1000)+'s');
    if (prov === 'nvidia') await sleep(1500);
  }
  return vecs;
}
const qv = await run(queries.map(q=>q.q), 'q', 'queries');
const dv = await run(corpus.map(c=>c.et), 'd', 'docs');
const flat = (vs) => { const f = new Float32Array(vs.length*1536); vs.forEach((v,i)=>f.set(v,i*1536)); return Buffer.from(f.buffer); };
fs.writeFileSync(`${out}.${prov}.q.bin`, flat(qv)); fs.writeFileSync(`${out}.${prov}.d.bin`, flat(dv));
fs.writeFileSync(`${out}.${prov}.stat.json`, JSON.stringify(stat));
console.log('done', JSON.stringify({ ...stat, msgs: undefined }));
