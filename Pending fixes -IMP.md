# Pending Fixes — IMPORTANT

> Long-running reference of bugs we identified but **deliberately did not fix yet**.
> When something resembling these symptoms is reported again, open this file first —
> the analysis is already done.

---

## Report editor: residual cause (P5 — P2 now done)

**Symptom (historical):** APC editing a Weekly / Bi-Weekly / Monthly report is
unexpectedly sent back to the reports list / dashboard, unsaved work appears
lost.

**Investigation date:** 2026-06-01 (5-agent parallel code audit)
**Round 1 fix:** 2026-06-02 — branch `fix/report-editor-state-loss`, commit `e3bb93c`
**Round 2 fix (P2):** 2026-06-03 — branch `fix/apc-tl-cascade-complete`, commit `04bb1ea`

Three of the four originally-identified mechanisms are now fixed.
**Only P5 (programmatic-mutation dirty tracking) remains.**

---

### ✅ DONE — P1: Brands realtime form-wipe (shipped 2026-06-02)
- `WeeklyReportForm.jsx` / `BiWeeklyReportForm.jsx` / `MonthlyReportForm.jsx` load-effects
- Removed `brands` from dep list; wrapped `getReport` in try/catch; cleanup-flag added

### ✅ DONE — P4: Universal autosave (shipped 2026-06-02, tightened 2026-06-02)
- `useReportAutosave` always-on for new + edit; `editId` in key; **interval now 5s** (was 30s)
- MonthlyReportForm autosave added (was missing entirely)

### ✅ DONE — P3 minimal: SW nav guard (shipped 2026-06-02)
- AppShell `wurxos-nav` handler now calls `hasUnsavedWork()` and confirms before navigating

### ✅ DONE — P2: Auth-null kick to `/login` on transient profile errors (shipped 2026-06-03)
- Was reported again as the Haider "Topbar shows '—'" / 3-reloads bug
- `AuthContext.loadProfile()` now takes `{ isRefresh }` opt
- On a refresh path: preserves existing profile when the SELECT fails transiently
- Initial-load path: retries once after 1s before nulling
- Realtime UPDATE/DELETE listener still handles real deletions via `setSessionInvalid`
- Commit: `04bb1ea`

---

### ⏸ STILL PENDING — P5: Deep-equality dirty tracking

**Where:** [src/components/reporting/WeeklyReportForm.jsx](src/components/reporting/WeeklyReportForm.jsx)
(and equivalents in BiWeekly/Monthly forms).

**What happens:**
```jsx
<div onInput={() => setDirty(true)}>
```
`setDirty(true)` fires on native browser `input` events. It does **NOT** fire for:
- Programmatic `setData(...)` (e.g. PDF Import, AI Generate-All)
- `RichTextEditor` `onChange` callbacks (rich-text libs often use
  `beforeinput`/`compositionend` instead of bubbling `input`)
- Date pickers / `<select>` (they fire `change`, not `input`)
- Section toggle switches

**Impact:** A user who opens the form and immediately hits "Import from PDF"
has a fully-populated form whose `dirty` flag is still `false`. The
`useUnsavedGuard` doesn't register it as dirty, so the appUpdate coordinator
would happily reload them away if a stale deploy is detected.

**Mitigation already in place:** Autosave runs every 5s regardless of the
dirty flag, so even programmatic mutations get persisted to localStorage
within seconds. A reload would still destroy the editor view, but the user's
draft would be restored on remount via the autosave restore path. So this is
no longer catastrophic — it's UX polish (the unsaved-changes confirm dialog
won't show when it should).

**Why we still haven't shipped:** Deep-equality on a large nested `data`
object every render is expensive — especially on the Monthly report which is
the largest. We deferred until we either see the bug recur with data loss
(which would mean autosave isn't catching it) or have a clean approach
(per-section dirty flags instead of per-form deep-equality).

**The proposed fix when we revisit:**
- Capture the initial `data` snapshot when the editor mounts
- Compute `dirty = !structuredEqual(data, initialSnapshot)` via a stable
  deep-compare, debounced to once per second
- Or: derive `dirty` from per-section flags maintained at the section level —
  each section sets its own dirty on any state change

**Confirmation tells:** if a user reports the autosave catching their work but
the unsaved-changes confirm dialog NOT firing when they try to leave, that's
P5. If autosave isn't catching the work either, that's a different bug.

---

## How to use this file

1. **When a report-editor bug is reported again:** start here, not from scratch.
2. **If autosave restored the draft on the user's next visit:** the symptom is
   real but the data is safe — investigate P5 next (or a brand-new mechanism).
3. **If autosave did NOT restore the draft:** that means something destroyed
   the editor before 5s of editing OR the autosave path itself has a bug —
   investigate the autosave `enabled` flag and storage key first.
4. **Don't re-investigate from scratch.** The agent-driven investigation
   already mapped every navigation source, every realtime channel, every
   error boundary, every chunk-load path, and every git commit. Read the
   findings before spawning a new investigation.

---

## Related branches and tags

- `feat/salary-management` — parent of the report-editor fix branch
- `fix/report-editor-state-loss` — branched off salary, shipped P1/P4/P3-minimal
- `fix/apc-tl-cascade-complete` — current deploy branch, includes the P2 fix
- Tag `stable-pre-report-editor-fix` — instant revert point for the report
  editor work
- Tag `stable-pre-salary-feature` — older revert point on main
