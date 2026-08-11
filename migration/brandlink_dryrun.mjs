// Dry-run: compute the brandId each existing incentive/bonus item WOULD get under
// the new brand-linked model. Writes NOTHING. Emits a spot-check report + a plan
// file (brandlink_plan.json) that the apply step will consume.
import { sb } from "./lib/supabase.js";
import fs from "fs";
const norm = (s) => (s||"").toLowerCase().replace(/[^a-z0-9]/g,"");

const { data: profs } = await sb.from("profiles").select("id, display_name, role").eq("is_active",true).in("role",["tl","apc","ipc","ol"]);
const { data: brands } = await sb.from("brands").select("id, brand_name, owner_id, status").eq("status","active");
const { data: assigns } = await sb.from("brand_assignments").select("user_id, brand_id");
const { data: rows } = await sb.from("incentives").select("id, user_id, month, incentives, bonuses, payout_cleared").order("month",{ascending:false});
const nameById = Object.fromEntries((profs||[]).map(p=>[p.id,p.display_name]));
const roleById = Object.fromEntries((profs||[]).map(p=>[p.id,p.role]));
const brandById = Object.fromEntries((brands||[]).map(b=>[b.id,b]));
const brandByNorm = {}; for (const b of brands||[]) brandByNorm[norm(b.brand_name)] = b;

function brandsFor(uid){
  const role = roleById[uid];
  if (role==="tl") return (brands||[]).filter(b=>b.owner_id===uid);
  return (assigns||[]).filter(a=>a.user_id===uid).map(a=>brandById[a.brand_id]).filter(Boolean);
}
const bn = (name) => brandByNorm[norm(name)];  // resolve a canonical brand-name string -> brand row

// Explicit overrides for the tricky TL GMV items (confirmed from the mapping table).
// keyed by TL name -> [ [substring-in-normalized-text, canonical brand name] ]
const TL_OVERRIDES = {
  "Ali Hamza":     [["klassy","Klassy Network"],["obaji","Obagi Skin Care"],["cutler","Cutler Nutritions"],["louisville","Louisville Jerky"],["yesday","YesDay"]],
  "Haider Ali":    [["swisse","Swisse"],["aurelia","Aurelia"],["innosupps","Inno Supps"]],
  "Muhammad Azam": [["biostime","Biostime Shop US"],["vidge","VidgePets USA"],["drharvey","Dr. Harvey's"],["longevity","Longevity Box"],["penetrex","Penetrex"],["aquasonic","Aqua Sonic"]],
  "Mustafa Jan":   [["bentgo","Bentgo"],["flywell","FlyWell"],["joymode","JoyMode"],["pdc","Pure Daily Care"]],
};
// Multi-brand APC disambiguation (confirmed): substring -> brand, or DROP.
const APC_OVERRIDES = {
  "Ahmad Raza": [["biostime","__DROP__"],["harvey","Dr. Harvey's"]],
  "Umar Ilyas": [["yesday","YesDay"],["dangle","Dangle"]],
};

function resolve(uid, item){
  if (!item) return {kind:"skip"};
  if (item.source==="attendance" || item.source==="ol_brands") return {kind:"other"}; // stays Other
  const name = nameById[uid], role = roleById[uid], nt = norm(item.text);
  const ub = brandsFor(uid);
  // multi-brand APC / explicit APC override
  if (APC_OVERRIDES[name]) {
    for (const [sub, target] of APC_OVERRIDES[name]) if (nt.includes(sub)) {
      if (target==="__DROP__") return {kind:"drop"};
      const b = bn(target); return b ? {kind:"brand", brand:b} : {kind:"unresolved", why:`override brand '${target}' not found`};
    }
    return {kind:"unresolved", why:"multi-brand APC, no override matched"};
  }
  // TL explicit override
  if (role==="tl" && TL_OVERRIDES[name]) {
    for (const [sub, target] of TL_OVERRIDES[name]) if (nt.includes(sub)) {
      const b = bn(target); return b ? {kind:"brand", brand:b} : {kind:"unresolved", why:`override brand '${target}' not found`};
    }
    return {kind:"unresolved", why:"TL item matched no override"};
  }
  // single-brand user: every non-attendance item -> that one brand
  if (ub.length===1) return {kind:"brand", brand:ub[0]};
  if (ub.length===0) return {kind:"other"}; // no brand assigned -> treat as Other/pending
  // multi-brand with no override: try substring match
  const hit = ub.find(b=>{ const nb=norm(b.brand_name); return nb.length>=3 && (nt.includes(nb)||nb.includes(nt)); });
  return hit ? {kind:"brand", brand:hit} : {kind:"unresolved", why:`multi-brand (${ub.length}), no clean match`};
}

const latestByUser = {}; for (const r of rows||[]) if (!latestByUser[r.user_id]) latestByUser[r.user_id]=r;
const plan = [];   // {rowId, cat, itemId, action, brandId, brandName}
let report = "";
const counts = {brand:0, other:0, drop:0, unresolved:0};
for (const role of ["tl","apc"]) {
  report += `\n\n############## ${role.toUpperCase()}s ##############\n`;
  for (const p of (profs||[]).filter(x=>x.role===role).sort((a,b)=>(a.display_name||"").localeCompare(b.display_name||""))) {
    const rec = latestByUser[p.id]; if (!rec) continue;
    let lines = "";
    for (const cat of ["incentives","bonuses"]) for (const it of (rec[cat]||[])) {
      const r = resolve(p.id, it);
      if (r.kind==="skip") continue;
      let tag;
      if (r.kind==="brand"){ tag=`→ ${r.brand.brand_name}`; counts.brand++; plan.push({rowId:rec.id, cat, itemId:it.id, action:"link", brandId:r.brand.id, brandName:r.brand.brand_name}); }
      else if (r.kind==="other"){ tag=`· Other`; counts.other++; plan.push({rowId:rec.id, cat, itemId:it.id, action:"other"}); }
      else if (r.kind==="drop"){ tag=`✗ DROP (stale)`; counts.drop++; plan.push({rowId:rec.id, cat, itemId:it.id, action:"drop"}); }
      else { tag=`⚠️ UNRESOLVED (${r.why})`; counts.unresolved++; plan.push({rowId:rec.id, cat, itemId:it.id, action:"unresolved", why:r.why}); }
      lines += `     [${cat[0]}] "${(it.text||"").slice(0,44)}"  ${tag}\n`;
    }
    if (lines) report += `\n  ${p.display_name} (${role}):\n${lines}`;
  }
}
report += `\n\n=== TOTALS: link ${counts.brand} · other ${counts.other} · drop ${counts.drop} · UNRESOLVED ${counts.unresolved} ===\n`;
fs.writeFileSync("brandlink_plan.json", JSON.stringify(plan,null,1));
fs.writeFileSync("brandlink_report.txt", report);
console.log(report);
