import { sb } from "./lib/supabase.js";
import fs from "fs";
const plans = JSON.parse(fs.readFileSync("august_plans.json","utf8"));

// Safety: refuse if any 2026-08 row already exists for these users (never overwrite).
const uids = plans.map(p=>p.user_id);
const { data: existing } = await sb.from("incentives").select("user_id").eq("month","2026-08").in("user_id", uids);
if (existing && existing.length) { console.log("ABORT: some 2026-08 rows already exist:", existing.map(e=>e.user_id)); process.exit(1); }

// Insert. last_updated_by left null (system bootstrap). verified/payout default false.
const rows = plans.map(p=>({ user_id:p.user_id, month:p.month, basic_salary:p.basic_salary, incentives:p.incentives, bonuses:p.bonuses, updated_at:new Date().toISOString() }));
const { data, error } = await sb.from("incentives").insert(rows).select("id, user_id");
if (error) { console.log("INSERT ERROR:", error.message); process.exit(1); }
console.log("Created", data.length, "August plans.");
fs.writeFileSync("august_created_ids.json", JSON.stringify(data.map(d=>d.id),null,1));
console.log("Revert = delete incentives where id in august_created_ids.json (July untouched).");
