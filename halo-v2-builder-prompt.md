# Builder prompt — Amazon Halo V2 client UX rewrite

Copy everything below the line into the builder agent / engineer.

---

## Mission

You are shipping a **client-facing UX rewrite** of Amazon Halo V2 at `https://wurxosdev.vercel.app/halo-v2` (repo: WurxOS / Halo V2).

**Primary user:** a brand CMO / brand manager who is **not** a data scientist. They need a clear answer in ~30 seconds: what moved, how confident we are, and what they must **not** claim.

**Secondary user:** Wurx ops / analysts who still need technical details — but those details must live behind disclosure, not in the first viewport.

**Product truth to protect (do not water down):**
- Correlation ≠ causation
- Modelled association ≠ incremental lift
- Uncertainty and missing controls must stay visible
- Keep the scientific honesty that makes Halo trustworthy

**Usman’s critique (must address):** UI and language are too confusing / all over the place. A non–data scientist can’t understand it. Rebuild from that perspective.

Reference review: `/workspace/training/halo-v2-review-2026-09-10.md` and screenshots under `/workspace/training/halo-v2-*.png|webp`.

---

## Non-goals

- Do not change the core statistical model math unless required to fix incorrect copy/calculations (e.g. “about a year of history”).
- Do not remove epistemic guardrails.
- Do not auto-create client share links during testing.
- Do not break `/halo` (original Halo). V2 changes stay on `/halo-v2`.

---

## Target information architecture (rewrite to this story)

Reorder and relabel the page into these sections, top → bottom:

### 1) Key takeaway (sticky / first viewport)
Plain-English headline answering “What happened?”
- Example pattern: “**GMV and Amazon Revenue moved together +91% on the same day.**”
- Next to it: confidence badge + observation count (e.g. “Moderate confidence · 32 days”).
- Hard caveats always visible here:
  - “This is **correlation**, not proof TikTok caused Amazon sales.”
  - Badge: **`MODELED · NOT INCREMENTAL`** (large, not a tiny label).
- One-line “so what”: e.g. “Treat this as supporting evidence for planning — not a guarantee of lift.”

### 2) Scope (simple controls)
Keep only what clients need up front:
- Brand
- Date range
- View: Daily / Weekly / Monthly
- “What are we comparing?” (metric pair) in plain English

Move to **Advanced** (collapsed by default):
- Lag choices / distributed-lag controls
- Baseline / custom baseline
- Index to 100
- Seasonality toggles (if present)
- Any other analyst knobs

### 3) Evidence — “What the data shows”
- One primary chart + short coverage note (usable periods, completeness)
- Soft warnings for data limits in plain English

### 4) Estimate — “What the model suggests”
- Show only when eligible (see gates below)
- Prominent modelled estimate + interval + confidence
- Coefficients, Newey-West (HAC), Adjusted R², VIF, standard errors → **Technical details** disclosure only

### 5) Scenarios — “What if we invest more?”
- Only when gates pass
- Every input labelled **assumption, not forecast**
- Plain labels for Conservative / Base / Upside, Off-platform, Total influenced, Blended multiple (one-line help under each)

### 6) Share / export
- Client link modal must say **Amazon Halo V2** everywhere
- Add export: at minimum **CSV** of series + summary; preferably a **one-page client summary** (PDF or PNG)

### 7) Glossary
Inline `?` tooltips + a Glossary panel for: GMV, NTB, Halo, incremental, attributed, lag, counterfactual, confidence, 95% interval, modelled.

---

## Hard product gates (P0 — trust/safety)

Implement as **hard disables**, not just warnings:

1. **Investment Planning** enabled only if:
   - Both metrics are **money** (e.g. GMV ↔ Amazon Revenue). Disable for Items sold ↔ NTB and any non-money pair.
   - Minimum history threshold met (reuse existing weekly/monthly rules; enforce for Daily short windows too).
   - Confidence is not “Low” / “Very limited data” (define using existing confidence labels).
2. When disabled, show plain English: “Planning is locked because [reason]. Switch to a money×money pair or widen the date range.”
3. Short / limited data windows may still show charts + observed relationship, but must **foreground “Insufficient evidence”** and must not present persuasive planning outputs.
4. Version identity: every user-facing string must say **Amazon Halo V2** (H1, document title if any, Client links modal title/body, “Share …” copy, explorer subtitle). Sidebar already says V2 — match it.

---

## Confirmed bugs to fix (with acceptance criteria)

### Bug A — Monthly empty-state copy (P1)
- **Repro:** Brand with limited monthly history → View = Monthly → warning body says “Weekly does not have enough history…”
- **Fix:** Body must say **Monthly** (and stay consistent with the selected view).
- **AC:** No stale “Weekly” string when Monthly is selected; Weekly empty state still says Weekly.

### Bug B — Chart tooltip raw floats (P1)
- **Repro:** Hover “Over time” chart; values like `733.3333333333333`.
- **Fix:** Round sensibly (e.g. 1 decimal for indexed/ratios, currency format for money, integers for counts) + units.
- **AC:** No tooltip shows >2 decimal places unless scientifically required; money uses `$` formatting.

### Bug C — “About a year of history” / usable-period template (P1)
- **Repro:** Model details on short windows claim “52 usable periods — about a year of history” while selected window is much shorter / different grain.
- **Fix:** Compute copy from **actual usable periods + selected grain** (days/weeks/months). No generic year template.
- **AC:** Copy matches the selected range and view; spot-check Apothecary default and a short Dr. Harvey’s window.

### Bug D — Version/title mismatch (P0)
- **Repro:** `/halo-v2` H1 = “Amazon Halo”; share modal = “Share Amazon Halo”.
- **Fix:** H1 + modal = Amazon Halo V2.
- **AC:** Grep UI strings on Halo V2 route; no client-facing “Amazon Halo” without “V2” except the link back to the original tool.

---

## Copy / language rewrite guidelines

Replace analyst-first blurbs with decision-first language.

**Bad (current energy):** “A neutral measurement model: signed relationships, an adjusted estimate with its uncertainty…”

**Good:** “Here’s how TikTok Shop activity moved with Amazon outcomes in this period — and how sure we are.”

Required visible phrases (keep or improve, don’t delete the meaning):
- Correlation is not causation
- Modelled, not incremental
- Estimate of association, not proof of cause
- Planning is a decision informed by the model, never a measurement of it

Translate on first use:
- GMV → “TikTok Shop sales (GMV)”
- NTB → “Amazon new-to-brand orders/sales (NTB)” (use the metric’s real definition in product)
- Counterfactual → “What the model estimates would have happened without the TikTok-linked movement”
- Distributed lag → “Effects that may show up over several days” (Advanced)

Reduce above-the-fold chrome: Measurement stages can stay, but don’t dominate the first screen — make them secondary/progress, not the story.

---

## UX polish (P2 — include if time)

- Sticky Key takeaway while scrolling
- Clear **Reset to defaults**
- Chart details keyboard accessible (not hover-only)
- Validation “Coming later” must not imply validation is complete
- Empty states: keep the good Weekly pattern (“Not enough history… switch to Daily or charts-only”) and fix Monthly consistency

---

## Testing checklist (you must run before calling done)

1. Apothecary default Daily — key takeaway readable in first viewport without scrolling on 1280×800.
2. Switch brand to Dr. Harvey’s; dates/metrics reload correctly.
3. Daily → Weekly → Monthly: stages/empty states correct; Monthly copy never says Weekly.
4. Money×money pair: planning available only when confidence/history gates pass.
5. Items sold → NTB: planning **disabled** with clear reason.
6. Short date window: “Insufficient evidence” dominant; planning locked.
7. Hover tooltips: rounded values + units.
8. Model details: history copy matches window.
9. Client links modal: all strings say Halo V2; don’t create a link unless testing explicitly.
10. Copy methodology still works.
11. Original `/halo` unchanged.
12. No NaN, blank charts, or dead controls on smoke paths.

---

## Deliverables

1. PR / commit implementing the IA rewrite, gates, bug fixes, glossary, and export (or explicit “export coming” only if blocked — prefer shipping CSV).
2. Short before/after note for Usman: screenshots of first viewport + planning disabled state.
3. List any model-threshold constants you chose for gates (min days/weeks, confidence rule) in the PR description.

## Success definition

A brand client can open Halo V2 and correctly answer in under a minute:
1) What moved together?
2) How confident are we?
3) What must we not claim?
4) Are we allowed to use this for spend scenarios right now?

If they still need a data scientist to interpret the first screen, the job is not done.
