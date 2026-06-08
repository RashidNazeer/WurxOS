---
name: salary-management
description: "Salary Management feature scope rules for WurxOS-V2 — who has a salary, who doesn't, and how the feature treats each role."
metadata: 
  node_type: memory
  type: project
  originSessionId: bcc0fa68-83c2-4ad6-b487-ce2665be9ba7
---

**Boss role has no salary.** The Boss runs the agency — he doesn't draw a payroll salary. Any Salary Management surface (backfill scripts, Active Salaries list, Pending Reviews tab, anniversary detection) must exclude Boss-role profiles entirely. Don't ask the Boss to enter their own salary; don't show their row in the management lists.

**Why:** Confirmed by user on 2026-05-31 during Phase 1 of the Salary Management feature build — the dry-run script listed Boss (Usman Qamar) in the "Boss must enter manually" group, and the user clarified Boss is an owner/proprietor, not a payroll employee.

**How to apply:**
- `migration/seed_salary_from_incentives.mjs` and any future backfill: skip profiles where `role = 'boss'`.
- Boss UI `/boss/salaries` list (Active Salaries tab): filter out `role = 'boss'` rows.
- Pending Reviews / anniversary detection: exclude Boss from both the "needs salary" prompt and from anniversary celebrations on the Boss's own profile (still notify the Boss about *other people's* anniversaries — that's their role).
- Employee Compensation card on profile pages: render nothing (or a friendly placeholder) when the viewer is Boss.

Related: [[git-workflow]] — feature lives on the `feat/salary-management` branch.
