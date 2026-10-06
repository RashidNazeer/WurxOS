# SOP corrections: our SOPs vs TikTok Shop Academy

_Prepared by the Lead, 2026-09-29, for whoever maintains these Google Docs. The
Owner approved updating them. Found by QA (`qa/2026-09-29-phase5-evalprep.md`, M3)._

After editing a Google Doc, re-import the SOP text into WurxOS the usual way.
The next ingestion (a 12-hourly sweep, or `ai_run_ingestion()`) re-embeds only
the changed SOP. Until then, Buddy shows both versions and flags the difference.

---

## 1. "Audit Performance of an existing GMV Max Campaign": promotion-day ROI
**SOP (Google Doc):** https://docs.google.com/document/d/1MZ2C_p_mP_Q49Jh4Khr-LhNRYKIjbcTfQNvJ3PXftfQ/edit

| | Says |
|---|---|
| Our SOP (§3 Budget & ROI Optimization) | "During Promotion Days, target ROI automatically drops **10–15%**." |
| TikTok Shop Academy: *About Promotion days for GMV Max* (GMV Max course, lesson 10) | Promotion Days adjust ROI goals **by preset levels (10%, 20% or 30%)**. The promotional ROI goal is based on **the lower of your recent 7-day non-promotional average ROI or your entered ROI**. |

**Suggested replacement text:**
> During Promotion Days (when enabled), GMV Max automatically lowers the target
> ROI by the level chosen in the campaign (**10%, 20% or 30%**), starting from the
> **lower of** the recent 7-day non-promotional average ROI and the entered ROI
> target. Check the level set on the campaign before judging ROI on promotion days.
> Source: TikTok Shop Academy, "About Promotion days for GMV Max".

## 2. "Category Approval": where to apply, and how long it takes
**SOP (Google Doc):** https://docs.google.com/document/d/1lxgQO3GFtDEYrliVW5tPUqoVfrgdx8D4x74Z3kHVYaw/edit

| | Says |
|---|---|
| Our SOP | Apply via **Products → Category Approval**; approval "typically takes **1–3 business days**"; track under Products → Category Approval → Application Status. |
| TikTok Shop Academy: *Applying for Category Permission* and the category requirement pages | Apply **during product listing** (Add Product → **Apply now** under the category field) or before; documents go through the **Qualification Center**; application status is shown in **Qualification Center**. Review takes about **6 days** (per QA's reading of the Academy page; please verify against the article when editing). |

**Suggested replacement text (steps 1, 5 and tracking):**
> Step 1: In Seller Center, go to **Products → Manage Products** (or **Add Product**).
> For a restricted category, click **Apply now** under the category field. You can
> apply before or after submitting the listing.
> Step 3: Required documents are submitted through the **Qualification Center**.
> Step 5: Review typically takes **about 6 days**. Track the status in the **Qualification Center**.
> Categories already approved don't need reapplying.
> Source: TikTok Shop Academy, "Applying for Category Permission".

---

## Also recommended (from QA)
- **SOPs whose steps are only screenshots:** add the steps as text so Buddy can
  read them. For example "How to adjust Target ROI or Budget", "How to set up Max
  delivery", "Audit Performance of an existing GMV Max Campaign" and "Setting Up
  A Live GMV Max Campaign" (whose "Step 1 / Step 2" headings have no text).
- **Delete the junk KB article "testing doc"** in the WurxOS Knowledge Base
  (it's already excluded from Buddy).
