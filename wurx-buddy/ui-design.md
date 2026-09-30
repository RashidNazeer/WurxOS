# Wurx Buddy: UI design

_Lead, 2026-09-30, from the Owner's brief. Status: approved decisions below; the build follows this doc._

**The Owner's brief.**
- A floating Buddy (the animated mascot) at the **bottom-right** opens a **small quick-chat window**.
- The left-nav **"Assistant" tab becomes "Wurx Buddy"**, a **full chat interface** with **chat history**.
- If a message is sent and the window is minimised, the **reply keeps generating in the background**, and **Buddy's animation shows when it's ready**.
- Practicality first. The chat UI is fully redone.

**Owner decisions (2026-09-30):**
- bottom-right;
- **every employee** gets Buddy;
- the UI is built on a separate branch copy of the app;
- Buddy's backend is deployed to **dev** (production untouched).

**Owner scope cut (2026-09-30):**
- **no Ctrl+/ shortcut** and **no reduced-motion stills**;
- **no push notification** for replies (too costly for the value: the badge, happy clip and tab title cover it);
- all other suggestions are kept. The text below still mentions the cut items; this list overrides it.

---

## 1. One Buddy, two windows, same conversations
| Surface | Purpose | Size |
|---|---|---|
| **Floating Buddy** (bottom-right, every page except the Buddy tab) | quick questions without leaving the page | 56 px button → a 400×600 panel (full-screen sheet on phones) |
| **Wurx Buddy tab** (left nav, replaces "Assistant", route `/buddy`) | long work: history, search, sources, admin | the full page |

**They share the same conversations** (one store, `ai_conversations` / `ai_messages`).
A quick chat can be continued in the full tab with **"Open in Buddy ↗"**, and any
conversation from history can be reopened in the quick panel. `/assistant` redirects to `/buddy`.

## 2. The floating Buddy (FAB)
- **Look:** the transparent mascot (`assets/buddy/web/`) at 56 px, a soft shadow, and a subtle ring in the brand accent colour.
- **Mood states** (these drive which clip plays):

| State | When | Clip |
|---|---|---|
| idle | nothing happening | `buddy-idle` (plays every ~8 s, otherwise the still, so it isn't distracting) |
| thinking | a reply is generating (panel open **or minimised**) | `buddy-thinking` (loops) |
| **reply ready** | a reply finished while the panel was minimised or closed | `buddy-happy` + a **badge** (unread count) + a gentle bounce **once** |
| calm | reduced-motion setting on | `buddy-calm` still |

- **Interactions:**
  - click → opens or closes the panel;
  - **Ctrl + /** opens it from anywhere;
  - **Esc** minimises;
  - a hover tooltip "Ask Buddy · Ctrl+/".
- **Never blocks work:**
  - it sits above the page with a safe offset;
  - it hides while a modal or dialog is open, and on the Buddy tab itself;
  - on phones it moves above the bottom browser bar.

## 3. The quick-chat panel
```
┌────────────────────────────────────────┐
│ (Buddy) Wurx Buddy      [+] [↗] [—] [×]│  new chat · open in Buddy tab · minimise · close
├────────────────────────────────────────┤
│  Buddy: Hi Umar! How can I help? 🐾    │
│  [How do I use this page?] [Summarise  │  ← page-aware suggestion chips
│   this brand's latest report]          │
│                                        │
│  You: …                                │
│  Buddy: … answer with ¹ ² citations    │
│  ┌ Sources: [SOP · How to approve…]    │  ← chips: in-app ones open the page
│  └          [Report · PDC Aug 2026]    │
│  👍 👎  Copy                            │
│                                        │
│ (thinking Buddy) Sniffing through the  │  ← live status from the backend while generating
│  SOPs…                                 │
├────────────────────────────────────────┤
│ [ Ask Buddy anything…        ] [Send ▸]│  Enter sends · Shift+Enter new line · [■ Stop] while generating
└────────────────────────────────────────┘
```
- **Minimise [—] or close [×]:** generation **continues** (§6). The FAB turns to *thinking*, then *reply ready*.
- **Page-aware chips.** Buddy knows which page you're on:
  - on a brand page → "Summarise this brand's latest report" / "How is <brand> doing this month?";
  - on the Leave page → "How do I apply for leave?".

  The page context (route + brand/report id) is sent with the question; see §7.
- **Short answers by default** in the quick panel (the prompt knows the surface), with "Open in Buddy ↗" for the long version.

## 4. The Wurx Buddy tab (full interface)
```
┌───────────────┬──────────────────────────────────────────┬──────────────┐
│ [+ New chat]  │ (Buddy) Pure Daily Care — August  [⋯]    │ Sources  [×] │
│ 🔍 Search     │                                          │ 1 Report ·   │
│ ─ Pinned ─    │   You: How did PDC do in August?         │   PDC Aug    │
│ ★ Weekly ops  │   Buddy: August was strong for PDC …     │   (approved) │
│ ─ Today ─     │     GMV $191,707.10 ¹ … the APC credits  │ 2 Report ·   │
│ PDC August    │     … ² Want me to compare with July?    │   Week 34    │
│ Cutler top…   │     👍 👎 Copy  ↻ Regenerate              │ 3 SOP · …    │
│ ─ Yesterday ─ │                                          │              │
│ Leave policy  │                                          │              │
│ ─ Last 7 days │ [ Ask Buddy anything…          ] [Send ▸]│              │
│ …             │  Buddy can make mistakes — check sources │              │
├───────────────┴──────────────────────────────────────────┴──────────────┤
│ (Boss / Developer only) ⚙ Buddy settings                                  │
└───────────────────────────────────────────────────────────────────────────┘
```
- **History (left):**
  - New chat;
  - **search** by title and message text;
  - groups: Pinned / Today / Yesterday / Last 7 days / Older;
  - per chat: **rename, pin, delete**;
  - unread dot;
  - auto-titles (the first question, trimmed).
- **Chat (centre):**
  - a readable column (max ~760 px);
  - streaming with the live status line;
  - **citation markers** ¹ ² link to the **Sources** panel (right), which is collapsible;
  - in-app sources (reports, KB, app pages) open inside WurxOS; TikTok Academy opens in a new tab;
  - per answer: 👍/👎 (with an optional note), Copy, **Regenerate**;
  - **Stop** while generating.
- **Empty state:**
  - the full Buddy animation;
  - "Hi <first name>! I'm Wurx Buddy: here to help, explore and grow.";
  - **role-aware starter cards**, e.g.:
    - APC: "How do I submit my weekly report?";
    - TL: "Which of my team's reports are pending?";
    - Boss: "Top brands by GMV this month".
- **Buddy settings** (a sub-page or modal):

| Setting | Who |
|---|---|
| **Run ingestion now** (with the last run, next due, and queue/failed counts) | **Boss + Developer** |
| **Sources on/off** (incentives, TikTok, …) | **Boss only** |
| **Excluded documents** (list + add/remove) | Boss |
| **Persona / greeting**, curated **knowledge docs** (the current "Train" tab, moved here) | Boss |

- **Phones:** history becomes a slide-in drawer; Sources becomes a bottom sheet.

## 5. Nav change
- The left nav item **"Assistant" → "Wurx Buddy"**, with the Buddy icon (still), for **every role**.
- Route `/buddy`; the old `/assistant` redirects there.

## 6. Background generation (the Owner's key requirement)
A reply must finish even if the panel is minimised, the user navigates away, the
tab reloads, or a flaky connection drops (most users are on Pakistan ISPs).

**Backend:**
- The server finishes generating **independently of the browser connection**: the edge function keeps running with `EdgeRuntime.waitUntil`.
- The assistant message row is created up-front with `status='generating'` and updated to `done` or `error` with the full text.
- The stream is only a live *view* of that work.

**Frontend:**
- One app-level `BuddyProvider` (mounted in the main layout) owns the conversations and in-flight requests. The panel and the tab are just views of it, so minimising or navigating never cancels a reply.
- If the stream drops, the provider switches to listening on **Supabase Realtime** (the user's own `ai_messages`) or polling, and picks up the finished answer.

**Unread:**
- `ai_conversations.last_read_at` vs `last_reply_at`.
- Unread replies show as the FAB badge + the *happy* Buddy, and in the browser tab title "(1) Buddy replied".
- **Optional:** a push notification when the app isn't visible (the app's existing push system, a new category).

## 7. Backend additions this UI needs
- `ai_messages.status` (`generating | done | error`), `ai_conversations.last_read_at`, `last_reply_at`, `pinned`, `title_edited`, and the RLS for the user's own rows.
- Realtime publication for the user's own `ai_messages` / `ai_conversations`.
- Request fields `surface` (`quick` | `full`) and `page_context` (`{route, brand_id?, report_id?, kb_id?}`) → a hint in the dynamic prompt tail. **Never trusted for permissions**; ACL is still per caller.
- Conversation APIs via plain RLS'd table access: list/search, rename, pin, delete, mark read.
- **Every employee:** `ALLOWED_ROLES` = all staff roles, **after the role safeguards (§8) pass QA**.

## 8. Role safeguards (required before opening Buddy to every employee)
- People and pay data are answered **only as the app would show them to that user**. Preferred approach: data tools query with the **caller's own JWT**, so the database RLS decides, with the service role only for the Boss/internal paths. Otherwise, role checks that mirror each table's RLS exactly.
- **Salary:** each employee can ask about **their own** (as "My Compensation" shows). Others' salaries stay Boss-only.
- **Incentives:** self, boss, active OL, `reports_to` manager (the `inc_select` rule). **Performance / attendance / leave:** mirror their RLS.
- **Reports:** `can_view_report`, including the "author sees own report" rule. `brand_overview` mirrors the `brand_monthly_metrics` RLS.
- **Persona role angles** for all 8 roles, including `ads_manager`.
- **QA gate:** the eval's **permission** category run **as each role** must be 100 %, with 0 leaks.

## 9. Accessibility, performance, resilience
- Keyboard: Ctrl+/ open, Esc minimise, focus trap in the panel, visible focus.
- `aria-live="polite"` for the streaming answer.
- `prefers-reduced-motion` → stills only.
- Clips load lazily (WebM, with a WebP fallback for Safari, and a PNG still first).
- The panel code is lazy-loaded.
- Friendly errors: the rate limit ("Buddy needs a short break, try again in a minute 🐾"), offline banner, retry button.
- Theme: the existing tokens (`src/styles/tokens.css`), light and dark; no hardcoded hex.

## 10. Build plan
| Track | Who | What |
|---|---|---|
| UI | UI engineer (new) in the app branch copy `C:\Users\Umar Ilyas\WurxOS-buddy-ui` (branch `feat/wurx-buddy` from `origin/main`) | BuddyProvider, FAB, quick panel, Buddy tab, settings, nav/route, assets wiring |
| Backend for UI | Engineer 1 | §6/§7: background completion, message status, Realtime, surface/page context, unread fields. Then the Lead deploys `assistant` to **dev** |
| Role safeguards | Engineer 2 | §8 |
| QA | QA | per-role permission eval; UI flows (minimise-while-generating, reload recovery, unread badge); the full 158-question eval |

**Order:**
1. the backend additions + a Boss-only dev deploy, so the UI has a real backend;
2. the UI build;
3. role safeguards + QA per role;
4. open to every employee on dev;
5. the Owner reviews it in the running app.

**Production is untouched throughout.**
