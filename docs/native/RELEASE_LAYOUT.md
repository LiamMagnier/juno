# Final source layout, server parity and worktree retirement

Owner requirements recorded 2026-07-22. **None of the filesystem work below has
been performed, and performing it now would be wrong** — every item is gated on
a release integration that has not happened. This file exists so the gates are
not lost between sessions, and so the next session can execute them in order
once the preconditions hold.

Mechanical enforcement lives in `scripts/release-gates.sh`. Run it before any
release build:

```bash
JUNO_CHECK_LIVE_CONTRACT=1 ./scripts/release-gates.sh dist/Juno-<version>-macOS.app
```

## Current gate status

| Gate | Status |
|---|---|
| Backfill migration has 22 typed `NULL::timestamp` | **FAIL** — this branch carries the bare-`NULL` copy |
| Native and backend declare the same contract in-commit | PASS (both 1.2.0) |
| Production serves the contract the build requires | **FAIL** — production serves 1.0.1, build needs 1.2.0 |
| No localhost / temporary host in native app sources | PASS |
| Both apps target `https://chat.liams.dev` | PASS |
| No preview harness in the Stable binary | PASS |
| Worktree clean, no integration in progress | varies |

Two release-blocking failures stand. Neither is a filesystem problem.

## Why the folder work has not been done

The requirements themselves gate it, and the preconditions are unmet:

- *"Do not move source files out of the repository while PR #18 and PR #19 are
  active."* — both are active.
- *"Do this only after release integration, not during active feature
  development."* — no release branch exists; nothing is merged to `main`.
- *"Do not retire worktrees before production and downloadable builds are
  verified."* — nothing has been deployed; `origin/main` is still `173be21`.
- *"Do not delete an unmerged or dirty worktree."* — the `main` checkout at
  `/Users/liammagnier/Desktop/workspace/juno` holds **uncommitted backend work**
  that is not reachable from any branch. Retiring or force-updating it now would
  destroy the only copy in the repository.

Doing any of it early would be destructive, not merely premature.

## Execution order, once the release is deployed

1. **Canonical checkout.** With the release merged and deployed, bring
   `/Users/liammagnier/Desktop/workspace/juno` to the deployed SHA:

   ```bash
   cd /Users/liammagnier/Desktop/workspace/juno
   git status --short          # must be empty FIRST — the dirty backend work
                               # must already be committed or explicitly dropped
   git checkout main && git pull --ff-only
   git rev-parse HEAD && git rev-parse origin/main   # must match
   ```

   Expected end state: on `main`, HEAD == `origin/main` == deployed server SHA,
   clean, no untracked source, no integration in progress.

2. **Visible project links.** Symlinks, not copies — one repository, one Git
   history, shared Swift packages preserved:

   ```bash
   cd /Users/liammagnier/Desktop/workspace
   ln -s juno/native/macOS/JunoMac  Juno-Mac
   ln -s juno/native/iOS/JunoMobile Juno-iPhone
   ln -s juno/dist                  Juno-Releases
   ```

   Then verify each opens the right project:
   `open Juno-Mac/JunoMac.xcodeproj`, `open Juno-iPhone/JunoMobile.xcodeproj`.

3. **Worktree retirement.** For each of the nine worktrees in
   `git worktree list`, in this order and never out of it:
   confirm its head is an ancestor of `origin/main`
   (`git merge-base --is-ancestor <head> origin/main`), confirm it is clean,
   confirm no untracked source, record the branch head in
   `dist/DELIVERY_REPORT.md`, then `git worktree remove` and finally
   `git worktree prune`. Skip any worktree that is unmerged or dirty.

## Same-commit record to fill in at release

Delivery is not complete until all of these agree:

| | value |
|---|---|
| Final `main` SHA | *pending* |
| Deployed server SHA | *pending* |
| JunoMac build SHA | *pending* |
| JunoMobile build SHA | *pending* |
| Native contract version | 1.2.0 |
| Backend contract version (deployed) | 1.0.1 — **mismatch** |

## Real end-to-end verification

Fixtures and a green build are not evidence of server connectivity. The Web ↔
Mac ↔ iPhone matrix in the brief must be run against the real account with
release builds carrying **no** preview arguments, and it cannot be run at all
until the contract mismatch above is resolved — every native sign-in is
currently refused by the client's own version check.
