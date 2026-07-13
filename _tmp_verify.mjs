const KEY = process.env.CK, STORE = 'd4555fac-379f-4200-8fec-53c96c5f22ce', BASE = 'https://api.euka.ai/v0';
const addDays=(d,n)=>{const x=new Date(d+'T00:00:00Z');x.setUTCDate(x.getUTCDate()+n);return x.toISOString().slice(0,10);};
const dayOf=s=>String(s).slice(0,10); const cmp=(a,b)=>a<b?-1:a>b?1:0;
let CALLS_NEW=0, CALLS_OLD=0;
async function get(p){ const r=await fetch(BASE+p,{headers:{Authorization:`Bearer ${KEY}`,Accept:'application/json'}}); const t=await r.text(); try{return JSON.parse(t);}catch{return {};} }
const chunkReq=(h,end)=>get(`/data-export?type=creator_video_level&store_id=${STORE}&start_date=${addDays(end,-69)}&end_date=${end}&export_type=json&creator_handle=${encodeURIComponent(h)}`);

// Pull all 13 chunks ONCE per creator; replay every algorithm offline against them.
async function chunks(h,target){ const out=[]; let end=target; const seen=new Set();
  for(let i=0;i<13;i++){ const r=await chunkReq(h,end); const rows=Array.isArray(r?.data)?r.data:[];
    const vids=[]; for(const v of rows) if(v?.video_id&&v?.posted_date&&!seen.has(v.video_id)){seen.add(v.video_id); vids.push(dayOf(v.posted_date));}
    out.push({ n: rows.length, vids }); end=addDays(addDays(end,-69),-1); }
  return out; }

function replay(ch, target, candStart, { ruleOut, emptyStop }){
  const days=[]; let empty=0, used=0;
  for(let i=0;i<13;i++){ used++; days.push(...ch[i].vids);
    if(ruleOut){ let before=0; for(const d of days) if(d<candStart) before++; if(before>=3) return {used, skip:true, days:null}; }
    if(ch[i].n===0){ empty++; if(empty>=emptyStop) break; } else empty=0; }
  return {used, skip:false, days: days.filter(d=>d<=target).sort(cmp)};
}
const groupOf=(days,target,missed)=>{ if(!days||!days.length) return null;
  const isMissed=d=>missed.includes(d); const firstRun=d=>{let x=d; while(isMissed(x)) x=addDays(x,1); return x;};
  const [D1,D2,D3]=days; const mx=(a,b)=>a>b?a:b;
  const s1=D1?firstRun(D1):null; const s2=D2?firstRun(mx(D2,addDays(s1,1))):null; const s3=D3?firstRun(mx(D3,addDays(s2,1))):null;
  if(s1===target) return 1; if(s2===target) return 2; if(s3===target) return 3; return null; };

for (const target of ['2026-07-08','2026-07-09','2026-07-10']) {
  const missed=[]; const earliest=[target,...missed].sort(cmp)[0]; const candStart=addDays(earliest,-2);
  const cv=await get(`/data-export?type=creator_videos&store_id=${STORE}&start_date=${candStart}&end_date=${target}&export_type=json`);
  const cands=[...new Set((cv?.data||[]).filter(v=>{const d=dayOf(v?.posted_date||'');return d>=candStart&&d<=target;}).map(v=>v?.creator_handle).filter(Boolean))];
  let i=0; const res=[];
  async function w(){ while(i<cands.length){ const h=cands[i++]; const ch=await chunks(h,target);
    const OLD = replay(ch,target,candStart,{ruleOut:false,emptyStop:2});          // production today
    const NEW = replay(ch,target,candStart,{ruleOut:true, emptyStop:4});          // what I just wrote
    const TRUTH=replay(ch,target,candStart,{ruleOut:false,emptyStop:99});         // no shortcuts at all
    CALLS_OLD+=OLD.used; CALLS_NEW+=NEW.used;
    res.push({h, gOld:groupOf(OLD.days,target,missed), gNew:NEW.skip?null:groupOf(NEW.days,target,missed), gTruth:groupOf(TRUTH.days,target,missed)}); } }
  await Promise.all(Array.from({length:10},()=>w()));
  const mismatchTruth=res.filter(r=>r.gNew!==r.gTruth);
  const diffOld=res.filter(r=>r.gNew!==r.gOld);
  const g=n=>res.filter(r=>r.gTruth===n).length;
  console.log(`target ${target}: candidates ${cands.length} | groups 1/2/3 = ${g(1)}/${g(2)}/${g(3)}`);
  console.log(`   NEW vs GROUND TRUTH mismatches: ${mismatchTruth.length} ${mismatchTruth.length?JSON.stringify(mismatchTruth):'✅'}`);
  console.log(`   NEW vs PRODUCTION-TODAY diffs : ${diffOld.length} ${diffOld.length?JSON.stringify(diffOld):'(identical)'}`);
}
console.log(`\nEuka calls across all 3 dates — production today: ${CALLS_OLD}   new: ${CALLS_NEW}   (${(CALLS_OLD/CALLS_NEW).toFixed(1)}x fewer)`);
