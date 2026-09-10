# Claude Code Prompt — WurxOS Halo V2 Measurement Upgrade

Copy everything below the line into Claude Code (in the Halo V2 / WurxOS repo). Do not invent brand metrics. Prefer editing existing Halo V2 code paths over rewriting the app.

---

## Role

You are a senior full-stack engineer + measurement product designer working on **WurxOS Halo V2** (Amazon / off-platform halo from TikTok Shop activity).

You are implementing a product upgrade so the tool matches the Commercial Systems Course **Book 4 Module 15** halo ladder:

1. Descriptive  
2. Correlations (signed; never force positive)  
3. Regression (with controls when available)  
4. Distributed lag (cumulative + per-lag; do not over-read single lags)  
5. Counterfactual contribution (actual vs reference TikTok level)  
6. Validation via geo / holdout / incrementality — **OUT OF SCOPE for this pass** (do not build geo assignment UI)

Core product rule from Book 4 Module 7: always separate **observed relationship**, **adjusted / modelled estimate**, and **planning assumption**. Never blend them into one “ROAS” that looks like proof.

Also separate **attributed / influenced / incremental** in copy. Halo V2 outputs are at best **modelled / influenced association**. Never label them incremental without Stage 6.

## Goals (in priority order)

1. **Never look broken when data is thin.** Empty correlations / blocked models must feel like a guided measurement journey with a clear next action — not a broken app.  
2. Implement the measurement fixes below (stages 1–5).  
3. **Investment Planning scenarios (Conservative / Base / Upside) must be derived from the adjusted model when eligible**, not hardcoded 50% / 100% / 150% random planning inputs. Manual overrides remain possible but must be clearly labelled as overrides.  
4. Preserve what already works: signed correlations, n gates, Newey–West / HAC when present, influence-point diagnostics, Moderate Confidence rationale, “strongest lag ≠ measured delay” copy, Halo Finder keeping negatives, planning disclaimer when assumptions-only.

## Current product behavior to respect / fix (from live audit)

Portal example: Apothecary Halo V2 read-only explorer.

### What works
- Stage 1 charts (over time + scatter) render even when models fail.  
- Stage 2 signed lags; negatives preserved; unstable-lag warnings; small-n warnings.  
- Stage 3–4 daily distributed-lag model with cumulative coefficient, CI, adj R², VIF, SE method, influence diagnostic.  
- Confidence rationale lists sample size, CI sign, lag agreement, missing controls.  
- Halo Finder ranks TikTok metrics; keeps negative rows.  
- Planning section can optionally “use adjusted model estimate as Base” but defaults are still 50/100/150.

### Pain points observed
- **Weekly is labelled “recommended”** but short windows (~5 weeks) show blank correlation cards (`—`, 4/3/2/1 pts) and Adjusted blocked (“needs about 20”). Feels broken.  
- Daily often unlocks a working model (e.g. cumulative ~$1.67 per $1 GMV→Amazon Revenue, CI ~$1.46–$1.88, n≈32, adj R²≈0.89) while Weekly fails — users never discover Daily.  
- **Same-period coefficient dominates** cumulative (e.g. ~+1.13 of ~+1.67). Same-day co-movement is easy to misread as “halo delay.” Correlation copy already warns; the **hero modelled number does not split same-period vs lagged-only**.  
- Controls: Trend available; Promotions / Stock-outs “data unavailable”; Seasonality needs ~52 weeks. Helper copy sometimes overclaims “adjusted for trend and seasonality.”  
- Stage 5: reference Median vs Period average can flip contribution from large positive to negative; no clear **actual vs counterfactual series** chart.  
- Error string sometimes **duplicates**: “Not enough history…” twice.  
- Monthly exploratory with near-zero usable periods.  
- Easy to screenshot `$1.67 per $1` into a client deck as causal proof.

## Non-goals
- Do not build geo lift / holdout runners (Stage 6).  
- Do not invent promotion/stock/Amazon Ads data. Support columns if present; degrade gracefully if absent.  
- Do not remove signed/negative correlations.  
- Do not force positive halo.  
- Do not let planning silently present assumptions as measured results.  
- Do not change unrelated WurxOS modules.

---

## Product requirements

### A. Smart grain + “not broken” empty states (highest UX priority)

1. **On load / brand change / date change**, compute usable periods for Daily / Weekly / Monthly for the current metric pair and max lag.  
2. **Auto grain recommendation engine** (do not only label Weekly recommended forever):
   - Prefer Weekly when `usable_weeks >= threshold` (use existing ~20 for full 3-lag+controls model; document exact formula in code comments).  
   - Else prefer Daily when `usable_days` supports at least same-period or 1-lag model.  
   - Else Monthly only if it has usable n; otherwise keep best available grain but enter **Guided mode**.  
3. If the user’s current grain cannot compute correlations or adjusted model, **do not show a wall of em dashes**. Show a single **Status panel**:
   - Title: `Not enough history for {Weekly} yet` (or correlations / adjusted model specifically).  
   - What we can still show: descriptive charts (always if series exist).  
   - What is blocked and why (exact n vs required n, parameters in model).  
   - Primary CTA: `Switch to Daily (works with this date range)` or `Widen date range to at least {date}` or `Add {N} more weeks of data`.  
   - Secondary: `Keep Weekly and explore charts only`.  
4. Correlation cards when n is insufficient: collapse into one compact row: `Correlations unlock at ≥ N overlapping periods` — not four empty cards.  
5. Adjusted model blocked: progress meter `Usable periods: 5 / ~20` (or 23/24) with “Almost there” when within 10% of threshold. Fix duplicated error strings.  
6. Charts that still render must keep legends + **explicit axis titles** (metric names + grain). Empty model sections should not look like chart failure.

### B. Epistemic labelling (everywhere modelled numbers appear)

Every modelled output (hero multiple, contribution $, planning derived scenarios, exports) must show a persistent badge:

`MODELLED · NOT INCREMENTAL`

Tooltip/copy:
> Association after included controls. Not proof of causal lift. Incremental requires geo/holdout validation (Stage 6 — not in this tool yet).

Exports / share images must include: n, CI, controls included/missing, grain, date range, same-period share of cumulative, and the badge.

### C. Stage 1 — Descriptive

- Keep over-time + scatter.  
- Add optional **normalize** toggle (index to 100 at period start, or z-score) for visual co-movement when scales differ. Default off.  
- Axis titles + units always visible.  
- When model blocked, still show descriptive section as “Stage 1 complete.”

### D. Stage 2 — Correlations

- Keep signed correlations, lag cards, unstable-lag warnings, small-n warnings, Halo Finder negatives.  
- When locked by n: guided empty state (section A), not `—`.  
- Keep copy: strongest observed relationship is not a measured halo delay.

### E. Stage 3 — Regression + controls honesty

1. Only claim controls that are actually in the regression.  
2. Fix Seasonality copy conflict: if seasonality cannot be estimated, UI must say `Seasonality: not controlled (needs ~52 weeks)` — never “adjusted for seasonality” in that state.  
3. Controls panel always lists:
   - Included: e.g. Trend ✓  
   - Missing: Promotions ✗, Stock-outs ✗, Amazon Ads ✗ (or other configured control columns), Seasonality ✗ with reason  
4. **Confidence ceiling**:
   - If promotions OR stock OR other major media controls missing → confidence cannot exceed `Moderate`.  
   - If only trend and short history → prefer `Low` / `Moderate` with explicit missing-control bullets (already partly present — enforce as rules).  
5. If sheet later gains `promotions`, `stock_outs`, `amazon_ads_spend` (or existing column name map), auto-include when present. Document column name mapping in one config file.

### F. Stage 4 — Distributed lag + same-period vs lagged-only (critical measurement fix)

Hero modelled relationship must show **two** numbers when lag window > same-period:

1. **Full cumulative** (current behavior): sum of same-period + lag coeffs.  
2. **Lagged-only cumulative**: sum of lag≥1 coeffs only (exclude same-period).  

UI treatment:
- Primary headline for “halo delay / off-platform spillover”: **Lagged-only** (with CI if estimable).  
- Secondary: Full cumulative including same-period, labelled `Includes same-{day|week|month} co-movement (not delay)`.  
- Show **same-period share** = |β0| / |Σβ| (or signed share with clear definition).  
- If lagged-only CI includes 0 (or cannot be estimated), say so plainly; do not promote full cumulative as “halo.”  
- Max-lag control: keep sensitivity; when n is marginal, auto-reduce max lag (and show “Reduced to 1 lag because n={n}”) rather than hard-failing Weekly at the knife-edge (e.g. 23 vs 24). Prefer graceful degradation over binary broken.

### G. Stage 5 — Counterfactual contribution (complete this)

Replace ambiguous “contribution vs median/average” alone with an explicit Stage 5 block:

1. **Reference level** (user selectable, with recommended default):
   - Recommended default: **Pre-period / low-activity baseline** when enough history exists (e.g. median of lowest quartile of TikTok activity, or median of first 20–30% of the window — pick one rule, document it, stick to it).  
   - Also allow: Median activity in window; Period average; Custom value.  
   - Warn when Median vs Average flip sign/magnitude: `Contribution is sensitive to reference choice`.  

2. **Actual vs counterfactual chart**:
   - Series A: predicted Amazon outcome under **actual** TikTok activity (and included controls).  
   - Series B: predicted Amazon under **reference** TikTok activity (controls held as in A).  
   - Contribution = sum or mean of (A − B) over the evaluation window, with CI band if available.  

3. Keep what-if (+5/+10/+20/+50% or absolute) as a **scenario** subsection under Stage 5, clearly labelled forward-looking, not historical contribution.  

4. Influence-point “Run without it” stays.

### H. Investment Planning — model-driven scenarios (user-aligned requirement)

**Hard requirement:** Conservative / Base / Upside must **not** default to arbitrary 50/100/150 when an eligible adjusted model exists.

#### Eligibility to apply model to planning
All must pass:
- Adjusted model estimated successfully.  
- Lagged-only cumulative is the planning basis when lag window includes lags (see F). If only same-period model is available, planning may use full cumulative but badge `SAME-PERIOD ASSOCIATION · WEAK HALO CLAIM`.  
- Lagged-only (or chosen basis) 95% CI does not include 0 **or** product explicitly allows planning on wide CI with `Low confidence planning` warning. Prefer: CI excludes 0 for auto-apply.  
- Confidence is not below the product floor you set (recommend: at least Moderate for auto-apply; Low → assumptions-only defaults).  
- n and controls gates as in E.

#### When eligible — derive the three scenarios from the model
Use the modelled multiple (prefer **lagged-only $ per $1** of selected TikTok metric, else documented fallback):

- Let `m` = point estimate (e.g. 0.54 lagged-only, or full if only same-period allowed).  
- Let `lo`, `hi` = 95% CI bounds on that same basis.  

Set:
- **Base** = `m` (as %)  
- **Conservative** = `max(lo, 0)` or `lo` if you allow negative planning (prefer floor at 0 for investment planning unless product wants downside negative)  
- **Upside** = `hi`  

Display each as `%` and `$ per $1`, and show source: `From adjusted model · lagged-only · Daily · {date range}`.

Also compute Off-platform / Total influenced / Blended multiple from user TikTok Shop Revenue + Marketing Spend using these % — same formulas as today, but fed by model-derived %.

#### When NOT eligible
- Do **not** silently use 50/100/150 as if they were model outputs.  
- Show **Assumptions mode**:
  - Copy: `Planning assumptions — model not eligible to drive scenarios yet.`  
  - Explain why (n, grain, CI includes 0, missing controls, weekly blocked, etc.).  
  - Provide **suggested placeholder bands** only as editable assumptions (you may keep 50/100/150 as *placeholders*), each tagged `ASSUMED`.  
  - CTA to fix eligibility (switch grain / widen dates / add controls).  

#### Manual override
- User can edit Conservative/Base/Upside anytime.  
- On edit: switch chip to `Manual override` and lose `From adjusted model` until they click `Reset from model`.  
- Never mix override and model without labelling.

#### Remove / redesign
- Replace one-click “Use adjusted model estimate as Base (167%)” that only sets Base with **Apply model to Conservative / Base / Upside** (sets all three from CI/point as above).  
- If full cumulative is 167% but lagged-only is much lower, **never** push 167% into Base by default.

### I. Halo Finder
- Keep metric ranking + negatives.  
- When weekly n=0 observations: show guided empty state + CTA to Daily, not a table of zeros.  
- Optionally show which metric would unlock strongest **lagged** relationship (lag≥1), not only same-period.

### J. Stage progress UI (experience)
Add a compact stepper at top:

`1 Descriptive ✓ · 2 Correlations ✓/○ · 3 Regression ✓/○ · 4 Distributed lag ✓/○ · 5 Counterfactual ✓/○ · 6 Validation (coming later)`

Each stage shows Done / In progress / Needs data — so thin data feels like progress, not failure.

---

## Copy / content rules
- Prefer plain commercial language.  
- Never say “proves,” “causes,” or “incremental” for model outputs.  
- Allowed: “associated with,” “modelled contribution,” “observed relationship,” “planning scenario.”  
- Keep existing good warnings; fix contradictory seasonality sentences.  
- Deduplicate repeated error strings.

## Engineering expectations
1. Find the Halo V2 portal / model code in this repo; summarize files you will touch before editing.  
2. Keep pure model math testable (unit tests for: lagged-only sum, CI→scenario mapping, eligibility gates, grain recommendation, reference contribution A−B).  
3. Do not break read-only explorer share links.  
4. Preserve performance on ~30–90 day series.  
5. If schema for controls is missing, add optional columns + documented names; UI already explains unavailable.  
6. After implementation, provide a short QA checklist matching the scenarios below.

## Acceptance tests / QA checklist (must pass)

### Thin data (Apothecary-like, ~5 weeks, Weekly)
- [ ] Page does **not** look broken (no wall of `—`).  
- [ ] Status panel explains n vs required.  
- [ ] One-click switch to Daily (or auto-recommend).  
- [ ] Descriptive charts still useful.  
- [ ] Stage stepper shows Stages 2–5 as needs data, Stage 1 done.  
- [ ] Planning is Assumptions mode, not fake model %.  

### Adequate Daily data
- [ ] Correlations populate with signs.  
- [ ] Adjusted model shows full cumulative **and** lagged-only.  
- [ ] Same-period share visible.  
- [ ] Controls honesty matches actual regression.  
- [ ] Seasonality copy accurate.  
- [ ] Stage 5 shows actual vs counterfactual series + contribution.  
- [ ] Reference sensitivity warning if median vs average diverge materially.  
- [ ] `MODELLED · NOT INCREMENTAL` on hero + planning.  
- [ ] **Apply model** sets Conservative/Base/Upside from CI/point on lagged-only basis.  
- [ ] Manual edit marks override.  

### Edge Weekly (e.g. 23 usable vs ~24 needed)
- [ ] Progress “almost there” OR auto-reduce lag/params with note — not opaque hard fail only.  

### Negatives
- [ ] Negative correlations still shown.  
- [ ] Halo Finder keeps negative rows.  

### Planning safety
- [ ] Ineligible model cannot one-click inject full same-period-heavy multiple as Base.  
- [ ] Eligible model drives all three scenarios from model CI/point.  

### Stage 6
- [ ] No geo/holdout builder added; optional “Validation later” stub is fine.

## Deliverables
1. Code changes in the Halo V2 paths.  
2. Brief summary of model math changes (lagged-only, scenario mapping, reference default).  
3. Screenshots or notes for thin-data UX vs healthy Daily UX.  
4. Updated inline methodology copy where contradictions existed.

## Implementation order (suggested)
1. Status panel + grain recommendation + empty-state redesign.  
2. Stage stepper.  
3. Lagged-only + same-period share in hero.  
4. Controls/seasonality copy honesty + confidence ceiling.  
5. Stage 5 actual vs counterfactual.  
6. Planning eligibility + CI-derived Conservative/Base/Upside.  
7. Export/share watermark + QA pass.

When unsure, choose the option that **reduces false certainty** and **makes insufficient data feel guided**.

---

End of prompt.
