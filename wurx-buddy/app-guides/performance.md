---
slug: performance
title: Performance
route: /performance
roles: [boss, ol, tl, pctl, apc, ipc]
feature: hr
last_reviewed: null
---
## What this page is for
This is the monthly **Performance Review**. Each person gets a composite score out of 100, built from four pillars:
- **Performance Tracking**
- **Bonus & Incentives**
- **Attendance**
- **Monthly Flags**

Managers rate their people and add flags here. Open it from the sidebar with **Performance**, and use the month picker to change month.

## Who can use it
- **APC and IPC**: **My Performance** only.
- **TL**: **Team Performance** (APCs) and **My Performance**.
- **PCTL**: **Team Performance** (IPCs) and **My Performance**.
- **OL**: **Team Performance** (sub-tabs **Team Leads** and **APCs**) and **My Performance**.
- **Boss**: **Team Performance** only (sub-tabs **Operation Leads**, **Team Leads** and **APCs**). Boss also gets the settings buttons described below.

## How to read your score
1. Open **My Performance**. The big circle is your composite score, and its level is shown underneath:
   - **Promotion**: 90 and above
   - **Good**: 70 and above
   - **Warning**: 50 and above
   - **Termination**: below 50
2. Instead of a score you may see one of these:
   - **Not Rated Yet**: you haven't been rated for the month yet.
   - **Not Yet Verified by OL**: your incentive plan has to be verified first.
   - **Score Unavailable**: attendance data failed to load. Use **Retry**.
3. Under **Score Breakdown**, click any pillar to see how it was calculated.
4. Your flags and warnings (out of 3) are listed below the breakdown.
5. Click **Simulate my performance** to try what-if scenarios.

## How to rate someone (managers)
1. Open **Team Performance** and the right sub-tab. Search by name, or filter by level (**Not Rated** is one of the options).
2. Each card shows the person's composite and pillar bars. The button you use depends on who they are:
   - **APC:** click **Weekly**. APCs are rated each week after their agenda meeting. Only the Boss and OLs can enter or correct weekly ratings. Boss and OL also see a "weekly APC ratings pending" list above the cards.
   - **TL:** click **Preview** (or **Performance** once the TL method is live). While in Trial, **Rate** is also available.
   - **Others:** click **Rate**, move the five sliders (0–100), then click **Save**.

## How to add or remove flags
1. On a card, click **Flags**, then **Green Flag** or **Red Flag**.
2. Pick a severity and describe what happened, then click **Add Flag**.
   - Severity is for triage only. It doesn't change the score.
   - Scoring: flags start at 80. Each green flag adds 10 and each red flag takes off 20.
3. To remove a flag:
   - An OL can click **Request removal** on a flag they added. The Boss then approves or rejects it in **Pending flag-removal requests**.
   - The Boss can click **Remove flag** directly.

## Boss-only controls
- **Weekly APC ratings: Trial/Live** and **TL performance: Trial/Live**: these switch the new rating methods on or off. Both ask for confirmation before going Live.
- The gear icon opens **Configure Performance**, where you set the pillar weights. They must total 100%.
- A warning button appears on rated people scoring below 50. It opens **Issue Warning**. Three warnings may lead to termination.

## Who can rate whom
- The Boss can rate everyone.
- An OL can rate TLs, APCs, PCTLs and IPCs.
- A TL can rate APCs.
- A PCTL can rate IPCs, and APCs who report to them.

## Rules & gotchas
- A flag only affects the score of the month it was created in.
- The default weights are Performance 40, Incentives 25, Attendance 20 and Flags 15. Changing the weights doesn't re-score months that are already closed.
- Attendance is calculated automatically. Fix attendance on Attendance → Roster, not here.

- For the Boss and OLs, PCTLs are listed under the **Team Leads** sub-tab and IPCs under the **APCs** sub-tab, alongside TLs and APCs and marked with their own role. There is no separate PCTL/IPC tab. For a PCTL, that tab is labelled **IPCs**.
  <!-- source: src/lib/performanceApi.js:604-632 listEvaluableUsers (_tab: tl|pctl → 'tls', else 'apcs'); src/components/performance/PerformancePage.jsx:1413-1420 -->

## Related pages
- Performance Simulator (`/performance/simulator`): private what-if tool for your own score.
- Attendance (`/attendance`): the source of the Attendance pillar.
- Incentives (`/incentives`): the source of the Bonus & Incentives pillar.
- Achievements (`/achievements`): monthly awards, suggested from these scores.
