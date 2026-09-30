# Proposal: ai-chat `get_performance` gives different answers to the same question

**Target:** app repo, `supabase/functions/ai-chat/index.ts`, `runTool` → `get_performance`.
**Status:** proposal only (WP-B, Lead decision 5). v2 already does this
(`Assistant/supabase/functions/_shared/ai/tools/people.ts`).

## Problem

For "everyone" (no `person_name`), v1 calls `get_performance_composite` once per
rated person, **all at once** (`Promise.all`, about 20 calls on dev). When one
call fails:

- the `catch` swallows it (and a returned `{ error }` is never checked at all);
- that person silently falls back to the manager-metrics average, which is a
  **different number** from the Performance page's composite, and can cross the
  Good/Warning boundary (contract C3);
- the ranking changes, because the fallback score is sorted with the composites.

Evidence: during the WP-B parity runs, v1 gave three different outputs for the
same `get_performance {}` call within minutes (lengths 2,939 / 3,106 / 3,431 /
3,849 characters). v1 run twice in a row was not always equal to itself. On dev,
bursts of about 40 parallel RPCs produced `TypeError: fetch failed`.

## Fix

1. At most 4 composite calls at a time.
2. One retry per person. A returned `{ error }` counts as a failure too.
3. If it still fails, **say so** on that person's line, list them last, and add
   one footer line. Never show the metrics average in the composite's place
   without saying so.

Answers are unchanged whenever every lookup succeeds; that is what the v2
parity script checks.

## Diff

```diff
@@ get_performance: composite headline (contract C3)
       const compUserIds = userIds || [...new Set((ratings || []).map((r: any) => r.user_id))].filter(Boolean);
       const compMap = new Map<string, any>();
-      await Promise.all(compUserIds.map(async (uid: string) => {
-        try {
-          const { data: c } = await admin.rpc('get_performance_composite', { p_user: uid, p_month: month });
-          if (Array.isArray(c) && c.length) compMap.set(uid, c[0]);
-        } catch { /* fall back to metrics avg headline */ }
-      }));
+      // At most 4 at a time, one retry each; a failure is said, never hidden
+      // (all-at-once calls made the same question give different headlines).
+      const compFailed = new Set<string>();
+      const loadComp = async (uid: string) => {
+        for (let attempt = 0; attempt < 2; attempt++) {
+          try {
+            const { data: c, error } = await admin.rpc('get_performance_composite', { p_user: uid, p_month: month });
+            if (error) throw error;
+            if (Array.isArray(c) && c.length) compMap.set(uid, c[0]);
+            return;
+          } catch { /* retry once, then report */ }
+        }
+        compFailed.add(uid);
+      };
+      for (let i = 0; i < compUserIds.length; i += 4) {
+        await Promise.all(compUserIds.slice(i, i + 4).map(loadComp));
+      }
       const LEVEL_LABEL: Record<string, string> = { promotion: 'Promotion', good: 'Good', warning: 'Warning', termination: 'Termination' };
       const headlineOf = (uid: string): string | null => {
+        if (compFailed.has(uid)) return 'composite could not be loaded (lookup failed), so this is NOT the Performance page figure';
         const c = compMap.get(uid);
         if (!c) return null;
@@ ranking
       if (ratings && ratings.length) {
-        // Rank by the composite (the page's headline), not the metrics-avg pillar.
-        const sorted = ratings.slice().sort((a: any, b: any) => compScoreOf(b) - compScoreOf(a));
+        // Rank by the composite (the page's headline); a failed lookup ranks last.
+        const score = (r: any) => (compFailed.has(r.user_id) ? -2 : compScoreOf(r));
+        const sorted = ratings.slice().sort((a: any, b: any) => score(b) - score(a));
         out += `Performance for ${month} (${ratings.length}; headline = composite score / level, same as the Performance page):\n` + sorted.map((r: any) => `- ${fmtRating(r)}`).join('\n');
+        if (compFailed.size) out += `\n(The composite could not be loaded for ${compFailed.size} of ${compUserIds.length}; they are listed last and are not ranked by composite. Ask again to retry.)`;
       } else {
```

## Cost and risk

- Latency: 20 calls in batches of 4 means about 5 sequential round trips
  instead of 1 (roughly +1 s on dev). It only affects the "everyone" question.
- There is no behaviour change when every lookup succeeds.
- A failed lookup now shows up in the answer instead of as a wrong number,
  which is the point.

## Test

- Unit (v2): `tools.test.ts` covers peak concurrency ≤ 4, one retry, a
  recovered retry, and the failure line and footer.
- After deploy: ask the v1 assistant "rank everyone's performance for last
  month" three times. The answers must be identical.
