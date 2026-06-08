---
name: git-workflow
description: "WurxOS-V2 git policy — atomic commits to main by default, feature branches only when a multi-commit change should revert as a unit, plus tags before risky work. Optimized for \"user can ask me to revert and I do it confidently.\""
metadata: 
  node_type: memory
  type: feedback
  originSessionId: bcc0fa68-83c2-4ad6-b487-ce2665be9ba7
---

User doesn't know git deeply and explicitly delegated the workflow decision to me. Optimize for **one thing only**: when they say "revert that," it should be trivial and safe. Avoid unnecessary ceremony.

## The policy

**Default — commit to `main`:**
- One logical change per commit. No bundling unrelated edits.
- Commit message: short subject (under 70 chars), then a body explaining the *why*, not the *what*.
- `git revert <sha>` cleanly undoes any single commit. This is the standard escape hatch.

**Branch off `main` (as `feat/<slug>` or `fix/<slug>`) ONLY when:**
- The change will span **multiple commits** and should revert as a single unit later (e.g. a multi-file refactor, a new module).
- The change is **risky or experimental** and might not land at all (try-and-see work).
- The user wants to **stage/preview** before it goes live.
- Otherwise: don't branch. Branching every tiny fix adds noise without buying safety.

When merging a feature branch back to `main`: `git merge --no-ff feat/<slug>` so the merge commit is the single revert handle for the whole feature. Then `git revert -m 1 <merge-sha>` rolls back the entire feature in one commit.

**Tag known-good states before risky work:**
- Before a large refactor, a logic change to attendance/performance/leave math, or anything touching auth/RLS:
  `git tag stable-<topic>-YYYY-MM-DD`
- Tags are free. They give an instant "roll back here" anchor. Use them proactively when a change feels load-bearing.

## When user says "revert X"

1. **"Revert your last commit"** → `git revert HEAD`
2. **"Revert that fix you made earlier"** → find the sha via `git log --oneline -20`, then `git revert <sha>`
3. **"Revert that whole feature"** → if it was branched + merged, `git revert -m 1 <merge-sha>`; if it was a commit range on main, `git revert <oldest-sha>^..<newest-sha>` (creates one revert per commit, oldest first — safer than `--no-commit` for multi-step changes)
4. **"Roll back to before X started"** → if there's a tag, `git revert <tag>..HEAD`; otherwise identify the cutoff sha and revert from there. Never `git reset --hard` on shared history; revert preserves the audit trail.

## Hard rules

- Never `git reset --hard`, `git push --force`, or amend a commit that already left this machine. A private GitHub remote now exists (`RashidNazeer/WurxOS`) and every commit is pushed there, so all three rewrite *shared* history and are genuinely destructive — undo with `git revert` instead.
- Never `--no-verify` to skip hooks unless the user explicitly says so.
- Never bundle unrelated changes in one commit. If a refactor and a bugfix both happen during one task, commit them separately so each can be reverted independently.
- Never delete a branch without confirming — local branches are free, and the user may want it as a reference point.

## Why this shape

Recent history shows main-commits with atomic, well-described changes (like `c399819 Attendance: clip credits to days elapsed, no future pre-credit`) revert cleanly with one `git revert`. The hire-date misfire (`9d8f261`) was undone in one command (`git revert 9d8f261`) without a branch — because the commit was self-contained. That's the bar to maintain. Branching everything would add friction without making reverts any safer.

Related: [[refresh-state-loss]] for prior context on why uncontrolled rollbacks/reloads are dangerous.
