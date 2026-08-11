// Builds the AUGUST (2026-08) plans by carrying each user's JULY plan forward,
// applying the approved brand links + reconciling to their CURRENT brands, and
// resetting progress. Writes NOTHING in preview mode. July is never read-modified.
import { sb } from "./lib/supabase.js";
import fs from "fs";
const APPLY = process.argv.includes("--apply");
const SRC = "2026-07", DST = "2026-08";
const norm = (s) => (s||"").toLowerCase().replace(/[^a-z0-9]/g,"");

const { data: profs } = await sb.from("profiles").select("id, display_name, role").eq("is_active",true).in("role",["tl","apc","ipc","ol"]);
const { data: brands } = await sb.from("brands").select("id, brand_name, owner_id, status").eq("status","active");
const { data: assigns } = await sb.from("brand_assignments").select("user_id, brand_id");
const { data: july } = await sb.from("incentives").select("id, user_id, incentives, bonuses, basic_salary").eq("month", SRC);
const { data: aug } = await sb.from("incentives").select("user_id").eq("month", DST);
const { data: comp } = await sb.from("employee_compensation").select("user_id, basic_salary");
const nameById = Object.fromEntries((profs||[]).map(p=>[p.id,p.display_name]));
const roleById = Object.fromEntries((profs||[]).map(p=>[p.id,p.role]));
const brandById = Object.fromEntries((brands||[]).map(b=>[b.id,b]));
const brandByNorm = {}; for (const b of brands||[]) brandByNorm[norm(b.brand_name)] = b;
const compById = Object.fromEntries((comp||[]).map(c=>[c.user_id, Number(c.basic_salary)]));
const augExists = new Set((aug||[]).map(r=>r.user_id));

function brandsFor(uid){
  const role = roleById[uid];
  if (role==="tl") return (brands||[]).filter(b=>b.owner_id===uid);
  return (assigns||[]).filter(a=>a.user_id===uid).map(a=>brandById[a.brand_id]).filter(Boolean);
}
const bn = (name) => brandByNorm[norm(name)];
const TL_OVERRIDES = {
  "Ali Hamza":[["klassy","Klassy Network"],["obaji","Obagi Skin Care"],["cutler","Cutler Nutritions"],["louisville","Louisville Jerky"],["yesday","YesDay"]],
  "Haider Ali":[["swisse","Swisse"],["aurelia","Aurelia"],["innosupps","Inno Supps"]],
  "Muhammad Azam":[["biostime","Biostime Shop US"],["vidge","VidgePets USA"],["drharvey","Dr. Harvey's"],["longevity","Longevity Box"],["penetrex","Penetrex"],["aquasonic","Aqua Sonic"]],
  "Mustafa Jan":[["bentgo","Bentgo"],["flywell","FlyWell"],["joymode","JoyMode"],["pdc","Pure Daily Care"]],
};
const APC_OVERRIDES = { "Ahmad Raza":[["biostime","__DROP__"],["harvey","Dr. Harvey's"]], "Umar Ilyas":[["yesday","YesDay"],["dangle","Dangle"]] };

function resolve(uid, item){
  if (item.source==="attendance"||item.source==="ol_brands") return {kind:"other"};
  const name=nameById[uid], role=roleById[uid], nt=norm(item.text), ub=brandsFor(uid);
  if (APC_OVERRIDES[name]){ for(const[s,t]of APC_OVERRIDES[name]) if(nt.includes(s)) return t==="__DROP__"?{kind:"drop"}:{kind:"brand",brand:bn(t)}; return {kind:"unresolved"}; }
  if (role==="tl" && TL_OVERRIDES[name]){ for(const[s,t]of TL_OVERRIDES[name]) if(nt.includes(s)) return {kind:"brand",brand:bn(t)}; return {kind:"unresolved"}; }
  if (ub.length===1) return {kind:"brand",brand:ub[0]};
  if (ub.length===0) return {kind:"other"};
  const hit=ub.find(b=>{const nb=norm(b.brand_name);return nb.length>=3&&(nt.includes(nb)||nb.includes(nt));});
  return hit?{kind:"brand",brand:hit}:{kind:"unresolved"};
}
function carry(item, r){
  const base = { ...item, achievedValue: 0, completed: false, completedBy: null };
  delete base.brandId; delete base.brandName;
  if (r.kind==="brand" && r.brand) return { ...base, brandId: r.brand.id, brandName: r.brand.brand_name };
  return base; // other -> unlinked
}

const plans = []; let report = ""; let created=0, skipped=0, totLink=0, totDrop=0;
for (const j of july||[]) {
  const uid=j.user_id, name=nameById[uid]; if(!name) continue;
  if (augExists.has(uid)) { skipped++; continue; }
  const cur = new Set(brandsFor(uid).map(b=>b.id));
  const build = (arr) => (arr||[]).map(it=>({it, r:resolve(uid,it)})).filter(x=>x.r.kind!=="drop")
     .filter(x=>!(x.r.kind==="brand" && x.r.brand && !cur.has(x.r.brand.id)))  // safety: drop links to non-current brands
     .map(x=>carry(x.it, x.r));
  const inc = build(j.incentives), bon = build(j.bonuses);
  const drops = [...(j.incentives||[]),...(j.bonuses||[])].filter(it=>resolve(uid,it).kind==="drop").length;
  totLink += [...inc,...bon].filter(i=>i.brandId).length; totDrop += drops;
  const salary = compById[uid] ?? Number(j.basic_salary) ?? 0;
  plans.push({ user_id: uid, month: DST, basic_salary: salary, incentives: inc, bonuses: bon });
  created++;
  const brandNames = [...new Set([...inc,...bon].filter(i=>i.brandId).map(i=>i.brandName))];
  report += `  ${name} (${roleById[uid]}): ${inc.length} inc + ${bon.length} bon → brands: ${brandNames.join(", ")||"—"}${drops?`  [dropped ${drops}]`:""}\n`;
}
report = `AUGUST BOOTSTRAP PREVIEW (${APPLY?"APPLYING":"dry-run"}) — create ${created}, skip ${skipped} (Aug already exists), links ${totLink}, dropped ${totDrop}\n\n` + report;
fs.writeFileSync("august_plans.json", JSON.stringify(plans,null,1));
console.log(report);
// Detail: Ahmad Raza + one TL
for (const nm of ["Ahmad Raza","Muhammad Azam"]) {
  const p = plans.find(x=>nameById[x.user_id]===nm); if(!p) continue;
  console.log(`\n--- ${nm} August ---`);
  for (const c of ["incentives","bonuses"]) for (const it of p[c]) console.log(`   [${c[0]}] "${(it.text||"").slice(0,40)}"  ${it.brandId?"→ "+it.brandName:"· Other"}`);
}
