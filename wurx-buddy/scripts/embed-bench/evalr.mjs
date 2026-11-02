import fs from 'node:fs';
const D = process.argv[2]; const provs = process.argv[3].split(',');
const corpus = JSON.parse(fs.readFileSync(`${D}/corpus.json`)); const queries = JSON.parse(fs.readFileSync(`${D}/queries.json`));
const N = corpus.length, Q = queries.length;
const load = (p, k, n) => { const b = fs.readFileSync(`${D}/run.${p}.${k}.bin`); return new Float32Array(b.buffer, b.byteOffset, n*1536); };
const STOP = new Set('a an and are as at be by can do does for from has have how i if in is it its me my of on or our should so that the their there this to was we what when where which who why will with you your not no into than then'.split(' '));
const tok = s => (s.toLowerCase().match(/[a-z0-9]+/g)||[]).filter(w=>!STOP.has(w)).map(w=>w.replace(/(ing|ed|es|s)$/,''));
// BM25 keyword arm
const docsT = corpus.map(c=>tok(c.et)); const df = new Map(); docsT.forEach(t=>new Set(t).forEach(w=>df.set(w,(df.get(w)||0)+1)));
const avg = docsT.reduce((a,t)=>a+t.length,0)/N; const tfs = docsT.map(t=>{const m=new Map();t.forEach(w=>m.set(w,(m.get(w)||0)+1));return m;});
function bm25(q) { const qt=[...new Set(tok(q))]; const s=new Float64Array(N);
  for (let i=0;i<N;i++){ let sc=0; for (const w of qt){ const f=tfs[i].get(w); if(!f) continue; const idf=Math.log(1+(N-df.get(w)+.5)/(df.get(w)+.5)); sc+=idf*f*2.2/(f+1.2*(0.25+0.75*docsT[i].length/avg)); } s[i]=sc; } return s; }
const rankOf = (scores) => { const idx=[...scores.keys()].sort((a,b)=>scores[b]-scores[a]); return idx; };
const kwRank = queries.map(q=>{ const s=bm25(q.q); return rankOf(s).filter(i=>s[i]>0).slice(0,60); });
function dense(p) { const qv=load(p,'q',Q), dv=load(p,'d',N); return queries.map((_,qi)=>{ const s=new Float64Array(N); for(let i=0;i<N;i++){ let a=0; for(let k=0;k<1536;k++) a+=qv[qi*1536+k]*dv[i*1536+k]; s[i]=a; } return rankOf(s).slice(0,60); }); }
const rrfW = (ws, ...lists) => lists[0].map((_,qi)=>{ const m=new Map(); lists.forEach((L,li)=>L[qi].forEach((id,r)=>m.set(id,(m.get(id)||0)+ws[li]/(60+r+1)))); return [...m.entries()].sort((a,b)=>b[1]-a[1]).map(x=>x[0]); });
const rrf = (...lists) => rrfW(lists.map(()=>1), ...lists);
function metrics(ranks, filter, level) { let n=0,r5=0,r10=0,mrr=0;
  queries.forEach((q,qi)=>{ if(!filter(q)) return; if(level==='chunk' && !q.gold_chunk) return; n++;
    const list=ranks[qi]; let pos=-1;
    for (let r=0;r<list.length;r++){ const c=corpus[list[r]]; if (level==='chunk' ? c.id===q.gold_chunk : q.gold_docs.includes(c.doc)) { pos=r; break; } }
    if (pos>=0 && pos<5) r5++; if (pos>=0 && pos<10) r10++; if (pos>=0) mrr+=1/(pos+1); });
  return { n, r5:+(r5/n).toFixed(3), r10:+(r10/n).toFixed(3), mrr:+(mrr/n).toFixed(3) }; }
const sys = { keyword_only: kwRank };
for (const p of provs) { sys[p+'_dense'] = dense(p); sys[p+'_hybrid(1:1)'] = rrf(sys[p+'_dense'], kwRank); for (const w of [2,3,5]) sys[p+'_hybrid('+w+':1)'] = rrfW([w,1], sys[p+'_dense'], kwRank); }
if (provs.length>1) sys['ALL_dense+kw'] = rrf(...provs.map(p=>sys[p+'_dense']), kwRank);
const groups = { all:()=>true, app_guide:q=>q.st==='app_guide', kb_ai:q=>q.st==='kb_article'||q.st==='ai_doc', tts:q=>q.st==='tts_article' };
for (const level of ['chunk','doc']) { console.log(`\n== ${level}-level gold ==`);
  for (const [name, ranks] of Object.entries(sys)) { const row = {}; for (const [g,f] of Object.entries(groups)) { const m=metrics(ranks,f,level); row[g]=`${m.r5}/${m.r10}/${m.mrr} (n${m.n})`; } console.log(name.padEnd(18), JSON.stringify(row)); } }
const real = queries.map((q,i)=>[q,i]).filter(([q])=>q.kind==='real');
console.log('\nreal questions (rank of first gold doc, hybrid):');
for (const [q,i] of real) { const out={}; for (const [name,ranks] of Object.entries(sys)) { const pos=ranks[i].findIndex(id=>q.gold_docs.includes(corpus[id].doc)); out[name]=pos<0?'-':pos+1; } console.log(q.q.slice(0,45).padEnd(46), JSON.stringify(out)); }
