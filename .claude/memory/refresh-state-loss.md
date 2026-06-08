---
name: refresh-state-loss
description: "Root cause + fix for the recurring \"app refreshes and loses unsaved work\" bug; never add an unconditional window.location.reload()"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: bcc0fa68-83c2-4ad6-b487-ce2665be9ba7
---

The user repeatedly reported WurxOS "suddenly refreshing" and losing unsaved
work (notably APCs editing reports). Root cause: after every redeploy,
Vite's content-hashed chunk filenames change and the old ones 404. A tab
open since before the deploy that loads a not-yet-cached chunk hits "Failed
to fetch dynamically imported module" — and the recovery paths responded
with an immediate silent `window.location.reload()`, destroying every
unsaved form.

Fixed 2026-05-18 via `src/lib/appUpdate.js` — a reload coordinator.
`requestAppReload()` is the single chokepoint: it reloads ONLY when the user
has nothing to lose (no typing this session, no dirty form registered);
otherwise it shows a non-blocking "update available" banner. A 3-min poll
detects deploys early. `useUnsavedGuard(isDirty)` (in `src/hooks/`) arms a
beforeunload prompt + reload suppression — wired into the 3 report forms.

**Why:** deferring a reload is always safe; an unconditional reload is never safe.

**How to apply:** NEVER add a bare `window.location.reload()` for stale-deploy
or error recovery — route it through `requestAppReload()`. Drop
`useUnsavedGuard(dirty)` into any new long form. The auth layer, React Query
config (`refetchOnWindowFocus/Mount: false`) and routing are sound — not
refresh causes.
