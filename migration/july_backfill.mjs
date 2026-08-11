// Additively link July (2026-07) brand items: ADD brandId/brandName only; preserve
// every other field (achieved/completed/targets/amounts). Drops nothing. Historical
// link — Ahmad Raza's July "(Biostime)" items link to Biostime (his July brand).
import { sb } from "./lib/supabase.js";
const APPLY = process.argv.includes("--apply");
const norm = s => (s||"").toLowerCase().replace(/[^a-z0-9]/g,"");
const { data: profs } = await sb.from("profiles").select("id, display_name, role");
const nm = Object.fromEntries(profs.map(p=>[p.id,p.display_name]));
const roleById = Object.fromEntries(profs.map(p=>[p.id,p.role]));
const { data: brands } = await sb.from("brands").select("id, brand_name, owner_id, status").eq("status","active");
const bByNorm = {}; for(const b of brands) bByNorm[norm(b.brand_name)]=b;
const { data: assigns } = await sb.from("brand_assignments").select("user_id, brand_id");
const bById = Object.fromEntries(brands.map(b=>[b.id,b]));
const bn = n => bByNorm[norm(n)];
const TL = {"Ali Hamza":[["klassy","Klassy Network"],["obaji","Obagi Skin Care"],["cutler","Cutler Nutritions"],["louisville","Louisville Jerky"],["yesday","YesDay"]],"Haider Ali":[["swisse","Swisse"],["aurelia","Aurelia"],["innosupps","Inno Supps"]],"Muhammad Azam":[["biostime","Biostime Shop US"],["vidge","VidgePets USA"],["drharvey","Dr. Harvey's"],["longevity","Longevity Box"],["penetrex","Penetrex"],["aquasonic","Aqua Sonic"]],"Mustafa Jan":[["bentgo","Bentgo"],["flywell","FlyWell"],["joymode","JoyMode"],["pdc","Pure Daily Care"]]};
const APC = {"Ahmad Raza":[["biostime","Biostime Shop US"],["harvey","Dr. Harvey's"]],"Umar Ilyas":[["yesday","YesDay"],["dangle","Dangle"]]};
const brandsFor = uid => roleById[uid]==="tl" ? brands.filter(b=>b.owner_id===uid) : assigns.filter(a=>a.user_id===uid).map(a=>bById[a.brand_id]).filter(Boolean);
function resolveJuly(uid, it){
  if(["attendance","ol_brands"].includes(it.source||"")) return null;
  const name=nm[uid], role=roleById[uid], t=norm(it.text);
  if(APC[name]){ for(const[s,b]of APC[name]) if(t.includes(s)) return bn(b); return null; }
  if(role==="tl" && TL[name]){ for(const[s,b]of TL[name]) if(t.includes(s)) return bn(b); return null; }
  const ub=brandsFor(uid);
  if(ub.length===1) return ub[0];
  const hit=ub.find(b=>{const x=norm(b.brand_name);return x.length>=3&&t.includes(x);}); return hit||null;
}
const { data: july } = await sb.from("incentives").select("id, user_id, incentives, bonuses").eq("month","2026-07");
let rowsToUpdate=[], totLinked=0, totRows=0;
for(const r of july){
  let changed=false;
  const link = arr => (arr||[]).map(it=>{ const b=resolveJuly(r.user_id,it); if(b && it.brandId!==b.id){ changed=true; totLinked++; return {...it, brandId:b.id, brandName:b.brand_name}; } return it; });
  const inc=link(r.incentives), bon=link(r.bonuses);
  if(changed){ rowsToUpdate.push({id:r.id, user_id:r.user_id, incentives:inc, bonuses:bon}); totRows++; }
}
console.log(`JULY BACKFILL (${APPLY?"APPLYING":"preview"}): ${totLinked} items linked across ${totRows} rows. Nothing dropped, progress preserved.`);
// spot: Ahmad Raza + Azam
for(const nmx of ["Ahmad Raza","Muhammad Azam"]){
  const u=profs.find(p=>p.display_name===nmx); const row=rowsToUpdate.find(x=>x.user_id===u.id); if(!row)continue;
  console.log(`\n${nmx}:`); for(const c of["incentives","bonuses"])for(const it of row[c]) console.log(`  [${c[0]}] "${(it.text||"").slice(0,36)}" ${it.brandId?"-> "+it.brandName:"(Other)"} | done=${it.completed} ach=${it.achievedValue}`);
}
if(APPLY){
  let ok=0; for(const r of rowsToUpdate){ const {error}=await sb.from("incentives").update({incentives:r.incentives, bonuses:r.bonuses}).eq("id",r.id); if(error){console.log("ERR",r.id,error.message);}else ok++; }
  console.log(`\nApplied to ${ok}/${rowsToUpdate.length} July rows.`);
}
