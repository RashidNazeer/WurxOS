import { env } from './lib.mjs';
import fs from 'node:fs';
const k = env('.env.dev').Gemini_Fallback;
const corpus = JSON.parse(fs.readFileSync(process.argv[2]));
// deterministic pick
const h = s => { let x=0; for (const c of s) x=(x*31+c.charCodeAt(0))>>>0; return x; };
const pick = (st, n, minTc) => corpus.filter(c=>c.st===st && c.tc>=minTc).sort((a,b)=>h(a.id)-h(b.id)).slice(0,n);
const sample = [...pick('app_guide',50,70), ...pick('kb_article',25,30), ...pick('ai_doc',6,100), ...pick('tts_article',60,150)];
const out = [];
async function chat(prompt) {
  const r = await fetch('https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:generateContent', { method:'POST', signal:AbortSignal.timeout(40000), headers:{'x-goog-api-key':k,'content-type':'application/json'},
    body: JSON.stringify({ contents:[{parts:[{text:prompt}]}], generationConfig:{temperature:0.4, responseMimeType:'application/json'} }) });
  const j = await r.json(); if (!r.ok) throw new Error(JSON.stringify(j).slice(0,200));
  return j.candidates[0].content.parts[0].text;
}
for (let i=0;i<sample.length;i+=4) {
  const grp = sample.slice(i,i+4);
  const prompt = `You write search questions an employee of a TikTok Shop agency would type into a help assistant. For each numbered passage below, write ONE natural question that this passage answers. Rules: do not copy the passage's wording or section title (paraphrase; use everyday words, as a new colleague would); do not mention "passage" or "document"; one sentence each. Reply with JSON only: {"q":["...","...",...]} in passage order.\n\n` +
    grp.map((c,j)=>`[${j+1}] ${c.et.slice(0,1500)}`).join('\n\n');
  try {
    const txt = await chat(prompt); const m = /\{[\s\S]*\}/.exec(txt); const q = JSON.parse(m[0]).q;
    grp.forEach((c,j)=>{ if (q[j]) out.push({ q:q[j], gold_chunk:c.id, gold_doc:c.doc, st:c.st, kind:'synthetic' }); });
  } catch (e) { console.log('fail', i, String(e).slice(0,100)); }
  await new Promise(r=>setTimeout(r,1500));
}
fs.writeFileSync(process.argv[3], JSON.stringify(out));
console.log(out.length, out.slice(0,6).map(o=>o.st+': '+o.q));
