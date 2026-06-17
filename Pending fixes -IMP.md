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

### ✅ DONE — P4: Universal autosave (shipped 2026-06-02, tightened 2026-06-02, 2026-06-08)
- `useReportAutosave` always-on for new + edit; `editId` in key; **interval now 5s** (was 30s)
- MonthlyReportForm autosave added (was missing entirely)
- **2026-06-08: save-on-change added.** Ali Waseem reported "page came back, no
  reload, no saved draft" — the gap was: mount fires `saveDraft(empty template)`,
  next interval doesn't fire for 5 seconds, so a form that unmounts in <5s only
  has an empty snapshot in localStorage. Fix: every `data` ref change now calls
  `saveDraft` directly (no debounce — a debounce timer cancels on unmount and
  re-creates the same gap). localStorage writes for a 10-50KB report payload
  run in <1ms.

### ✅ DONE — KeyboardShortcuts removed (2026-06-08)
- The global `g`-then-`r`/`d`/etc. chord handler (and `?` help overlay) was
  removed entirely along with the sidebar footer keyboard-icon button. Closed
  the last in-app `navigate()` path that could accidentally yank a user off a
  dirty editor. Will be re-added later as a separate feature with proper
  dirty-form guards if/when navigation shortcuts are wanted again.

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

### ✅ DONE — P5: Reference-equality dirty tracking (shipped 2026-06-08)
- All 3 forms now snapshot the `data` ref once loading completes and flip
  `dirty=true` on any subsequent `data` ref change. Catches PDF Import, AI
  Generate, RichTextEditor onChange, date pickers, section toggles — every
  setData path. No deep-equality cost (ref compare is O(1)).
- Files: [WeeklyReportForm.jsx](src/components/reporting/WeeklyReportForm.jsx),
  [BiWeeklyReportForm.jsx](src/components/reporting/BiWeeklyReportForm.jsx),
  [MonthlyReportForm.jsx](src/components/reporting/MonthlyReportForm.jsx).

### ✅ DONE — Auth/route grace windows for unsaved work (shipped 2026-06-08)
- **Root finding:** Ali Waseem's recurring "page came back, no reload" was
  almost certainly the auth-redirect cascade. A transient Supabase SIGNED_OUT
  event (multi-tab signout, refresh-token flutter, BroadcastChannel sync)
  would null session/profile → ProtectedRoute or RoleGuard Navigate to /login
  → AppShell unmounts → editor lost. Even a 100ms flutter destroyed work.
- **Fix:** All three of the unmount paths now honor a 2-second grace window
  when `hasUnsavedWork()` returns true:
  - [ProtectedRoute.jsx](src/components/auth/ProtectedRoute.jsx) — hold tree
    when session=null and a dirty form is mounted.
  - [RoleGuard.jsx](src/components/auth/RoleGuard.jsx) — hold tree when
    profile=null and a dirty form is mounted.
  - [AuthContext.jsx](src/contexts/AuthContext.jsx) — `onAuthStateChange`
    no longer calls `setProfile(null)` on transient `!newSession` events
    if a dirty form is mounted. The recheckSession 3-strike threshold will
    still catch a real sign-out and surface SessionExpiredModal.
  - [BrandsContext.jsx](src/contexts/BrandsContext.jsx) — defers
    `setBrands([])` by 2s when uid/role briefly null and a dirty form is
    mounted.
- **Trade-off:** During those 2 seconds a genuinely signed-out user sees
  stale UI. Any DB call they trigger fails with 401. Acceptable — the data
  safety win is much larger than the cosmetic cost, and the grace window is
  SCOPED to `hasUnsavedWork()` so non-edit pages still redirect instantly.

### ✅ DONE — In-app navigation guard + save-as-draft modal (shipped 2026-06-17)
- **Symptom:** creating a report, clicking a sidebar menu item or the "Back to
  reports" arrow navigated away instantly. localStorage autosave kept the data
  but users perceived it as lost (no server draft, restore not obvious).
- **Fix:** new `useReportLeaveGuard` (src/components/reporting/) used by all 3
  forms. While `dirty`, it (a) intercepts internal `<a href="/…">` clicks via a
  capture-phase document listener, and (b) registers a global singleton
  (`src/lib/reportLeaveGuard.js`) so PROGRAMMATIC `navigate()` paths route
  through it too — Topbar settings gear, NotificationBell jump, GlobalSearch,
  AppShell SW `wurxos-nav`. A modal then offers **Save & leave** / **Save & stay**;
  BOTH persist a real server draft (`_doSave(reportStatus, …, { stay:true })` —
  upsert-keyed by brand/type/period so no duplicates, status preserved). The
  modal is dismissable ONLY via those two buttons (static backdrop, no Esc).
- **Known limits (BrowserRouter, no useBlocker):** the browser Back/Forward
  button and a hard reload (F5) can't show the custom modal — those still rely
  on the native beforeunload prompt + the localStorage autosave backstop.

### ⏸ STILL PENDING — (none for the report editor as of 2026-06-17)

All known mechanisms that could destroy editor state without a user click
on Save/Cancel are now mitigated. If the symptom recurs, that's a new
mechanism — investigate from scratch.

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
