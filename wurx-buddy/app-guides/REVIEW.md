# App guides: review of the "⚠ unverified" marks

_Engineer 2. Review 2026-09-30; Owner decisions implemented 2026-10-01._

How it was checked:
- The app code (`src/`), the edge functions and the **newest** migration defining each policy, function or trigger, all read-only.
- Write policies confirmed live on dev.
- Each passage cites its source in an HTML comment `<!-- source: … -->`. The sync script strips these comments before syncing.

_Nothing was ingested or synced; app-guide ingestion stays with the Lead._

## Status
| | Marks |
|---|---|
| Found | 38 (in 29 files) |
| Resolved in the review (passage rewritten to the real behaviour) | 31 |
| Resolved by the Owner's decisions below | 7 |
| **Left** | **0**: no `⚠` remains in any guide |

## Owner decisions (2026-10-01)
| # | Question | Decision | Implemented |
|---|---|---|---|
| Q1 | Should an Ads Manager's leave go straight to the Boss? | **Yes** | Mig 390: `leave_current_approver` and `leave_approver` return the Boss for an `ads_manager` requester, whoever they report to. `leaveApi.mapStatusToV1` labels it Pending Boss. Guide: leave.md |
| Q2 | Should OLs manage PCTL incentive plans? | **No**, stays as today | No app change. incentives.md states it as final: PCTL plans are the Boss's. |
| Q3 | Should PCTL/IPC authors edit their own draft or returned reports? | **Yes** | UI only; the server already allowed authors. Weekly, Bi-Weekly (same flow, kept consistent) and Monthly report pages. Guides: weekly-reports.md, monthly-reports.md |
| Q4 | Rename the checkpoint's "Submit for verification" / "Pending TL"? | **Yes** | Now **Submit** / **Submitted** (AgendaCheckpointPage, CheckpointReturnNotice). Guide: agenda-checkpoint.md |
| Q5 | Should broadcasts and polls be for recipients only? | **Yes** | Mig 391 (+ 393): new `broadcast_recipients`, recorded at send time and backfilled. A broadcast is visible to its recipients, its sender and the Boss. Only recipients answer polls; results are for the sender and the Boss. Guide: broadcasts.md |
| Q6 | Resource Planner Boss-only? | **Yes** | The route guard is `boss` only (the menu already was). Mig 392 makes the config policies, `get_planner_config` and `save_planner_config` Boss-only. Guide: resource-planner.md |

## Possible app bugs: declined
The Owner **declined** the 25 "possible app bugs" from the review: they are intentional.
- They are not changed.
- The guides don't describe them. Passages that did were rewritten to state the rule neutrally, including two older passages in campaigns.md and product-campaigns.md.
- The list stays in this file's history (git) for reference only.

## Method notes
- Dev has none of the app's cron jobs (only the `ai-*` ones), so the attendance auto-close was confirmed from the migration chain:
  - scheduled in mig 154;
  - its function replaced in mig 202;
  - no later unschedule.
- `/resources` is served by `src/components/resources/AllResourcesPage.jsx`. `src/pages/resources/ResourcesPage.jsx`, `src/pages/incentives/IncentivePlanEditorPage.jsx` and `src/pages/incentives/IncentivesPage.jsx` are dead code, so no guide fact is taken from them.
