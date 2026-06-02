# Pending Fixes — IMPORTANT

> Long-running reference of bugs we identified but **deliberately did not fix yet**.
> When something resembling these symptoms is reported again, open this file first —
> the analysis is already done.

---

## Report editor: residual causes (P2 and P5)

**Symptom:** APC editing a Weekly / Bi-Weekly / Monthly report is unexpectedly
sent back to the reports list / dashboard, unsaved work appears lost.

**Investigation date:** 2026-06-01 (5-agent parallel code audit)
**First-round fix date:** 2026-06-02 — branch `fix/report-editor-state-loss`, commit `e3bb93c`

The 2026-06-02 fix shipped Priority 1 (Brands-dep wipe) + Priority 4 (universal
autosave) + Priority 3 minimal (SW nav guard). Two distinct mechanisms remain
unaddressed because they touch sensitive code and we agreed to wait and see
whether the shipped fixes alone settle the reports.

### Pending P2 — Auth-null kick to `/login` on transient profile errors

**Where:** [src/contexts/AuthContext.jsx](src/contexts/AuthContext.jsx) lines 73, 80, 87, 353 + [src/components/auth/RoleGuard.jsx](src/components/auth/RoleGuard.jsx) line 14.

**What happens:**
1. APC alt-tabs to Discord/WhatsApp for a moment, then back to WurxOS
2. `visibilitychange` event fires → `refreshProfileIfStale()` runs (60s throttle)
3. `loadProfile(uid)` does a SELECT on `profiles`
4. Any error — Pakistan-ISP network blip, 15s timeout, transient RLS hiccup — sets `setProfile(null)`
5. `RoleGuard.jsx:14`: `if (!role) return <Navigate to="/login" replace />`
6. WeeklyReportsRouter unmounts synchronously; the editor is destroyed
7. PublicOnly bounces from `/login` to `/dashboard` because the session is still valid
8. User is now on `/dashboard`, opens `/weekly-reports` — fresh mount, `view='overview'` = "kicked back to the list"

**Why we didn't fix yet:** AuthContext is highly load-bearing. A wrong tweak could
cause real auth failures to be silently swallowed (security hole) or session
flickering across the app. We wanted P1+P4 in the wild first to see whether the
reports stop.

**The proposed fix when we revisit:**
- In `loadProfile`, never `setProfile(null)` on **transient** errors. Keep the
  previous profile object and surface a non-destructive "couldn't refresh
  profile, retrying" toast.
- Only null the profile if the error is *explicit*: session truly gone, row
  really deleted, 403, or token revoked.
- Distinguish errors via `error.status` and `error.code`. Transient = network /
  timeout / 5xx. Permanent = 401, 403, "row not found".

**Confirmation tells:** if a user reports the bug again AND the autosave restored
their draft when they came back, P2 is the culprit. If autosave didn't restore
(meaning the data was wiped before 30s of editing), it's something else.

---

### Pending P5 — Deep-equality dirty tracking

**Where:** [src/components/reporting/WeeklyReportForm.jsx:1136](src/components/reporting/WeeklyReportForm.jsx#L1136) (and equivalents in BiWeekly/Monthly forms).

**What happens:**
```jsx
<div onInput={() => setDirty(true)}>
```
`setDirty(true)` fires on native browser `input` events. It does **NOT** fire for:
- Programmatic `setData(...)` (e.g. PDF Import, AI Generate-All)
- `RichTextEditor` `onChange` callbacks (rich-text libs often use `beforeinput`/`compositionend` instead of bubbling `input`)
- Date pickers / `<select>` (they fire `change`, not `input`)
- Section toggle switches

**Impact:** A user who opens the form and immediately hits "Import from PDF" has
a fully-populated form whose `dirty` flag is still `false`. The
`useUnsavedGuard` doesn't register it as dirty, so the appUpdate coordinator
would happily reload them away if a stale deploy is detected.

**Mitigation already in place (2026-06-02 fix):** Autosave now runs every 30s
regardless of the dirty flag, so even programmatic mutations get persisted to
localStorage. A reload would still destroy the editor view, but the user's
draft would be restored on remount.

**Why we didn't fix yet:** Deep-equality on a large nested `data` object every
render is expensive and could introduce performance issues, especially on the
Monthly report which is the largest. We deferred until we either see the bug
recur or have a clean way to do it (e.g. tracking dirty per-section instead of
per-form).

**The proposed fix when we revisit:**
- Capture the initial `data` snapshot when the editor mounts.
- Compute `dirty = !structuredEqual(data, initialSnapshot)` via a stable deep-
  compare, debounced to once per second.
- Or: derive `dirty` from per-section flags maintained at the section level —
  each section sets its own dirty on any state change.

---

## What we shipped on 2026-06-02 (for reference)

| Fix | Where | What |
|---|---|---|
| P1 — Brands-dep wipe | All 3 form load-effects | Removed `brands` from deps; added try/catch around `getReport` |
| P4 — Universal autosave | `reportDraftAutosave.js`, all 3 forms | Always-on autosave including edit mode; `editId` in storage key; MonthlyReportForm autosave added (was missing entirely) |
| P3 minimal — SW nav guard | `AppShell.jsx` `wurxos-nav` handler | `hasUnsavedWork()` confirm dialog before navigating away on push-notification clicks |

---

## How to use this file

1. **When a report-editor bug is reported again:** start here, not from scratch.
2. **If autosave restored the draft on the user's next visit:** the symptom is real but
   the data is safe — investigate P2 / P5 next.
3. **If autosave did NOT restore the draft:** that means something destroyed the editor
   before 30s of editing OR the autosave path itself has a bug — investigate the autosave
   `enabled` flag and storage key first.
4. **Don't re-investigate from scratch.** The agent-driven investigation in this
   thread already mapped every navigation source, every realtime channel, every
   error boundary, every chunk-load path, and every git commit. Read the
   findings before spawning a new investigation.

---

## Related branches and tags

- `feat/salary-management` — parent of the report-editor fix branch
- `fix/report-editor-state-loss` — current deploy branch
- Tag `stable-pre-report-editor-fix` on parent — instant revert point if anything goes wrong
