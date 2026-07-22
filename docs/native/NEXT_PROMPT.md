# Next session — start here

Read this file first, then `STATUS.md` for the longer history. Everything below
was verified on 2026-07-22, not remembered.

## Exact starting point

```
worktree  /Users/liammagnier/Desktop/workspace/.worktrees/juno-native-claude
branch    agent/juno-native-claude-continuation   (PR #18 → agent/juno-native)
head      d19e924  — Juno Code developer surfaces on the shared design system
tree      clean, no merge/rebase/cherry-pick in progress
```

`main` was not touched. `origin/main` is `173be21`. Production is live and
unchanged at `https://chat.liams.dev`.

## First command

```bash
cd /Users/liammagnier/Desktop/workspace/.worktrees/juno-native-claude && \
git status --short && git log --oneline -3
```

## What just landed

`JunoMac` is one three-region native product that opens on Chat (verified in the
running app). Sidebar carries the destinations *and* the recency-grouped
conversation history; the canvas renders real Markdown; there is a native
inspector and a floating glass composer. Plus a shared model-name humanizer, a
Keychain error that names its OSStatus, and four real defects fixed. See
`dist/DELIVERY_REPORT.md` for the full account.

Artifacts exist in `dist/` (macOS `.app` + `.dmg`, development `.ipa`, signed
simulator `.app.zip`) with checksums. The binaries are gitignored; the docs are
tracked.

## Design work still open (owner rejected the previous visuals once)

`docs/native/MACOS_DESIGN_REVIEW.md` is the source of truth: diagnosis,
before/after screenshots in `docs/native/design/`, and an explicit limitations
section per pass. §8 covers the Code surfaces, done in `d19e924`.

Fixed and verified across the two passes: the all-coral navigation and the
invisible dark-mode sidebar icons (one root cause — an unstated icon colour
inheriting AppKit's implicit sidebar accent tint); the whole Code transcript,
approvals, terminal, diff, tests, Git, composer and inspector navigation.

What is still **not** done, and must not be read as done:

- **the capture matrix.** Only 1180×760 light and dark exist. 900×650,
  1440×900, full screen and the inspector-open/closed pairs were never taken,
  because window creation for newly launched apps broke in that login session —
  the capture harness had run `killall cfprefsd`, which kills the login
  session's preferences daemon and stops newly launched apps getting windows at
  all. **Never run it.** Re-run `scratchpad/shoot.sh` from a fresh login session
  to finish the matrix.
- **the Code sidebar layout defect.** At 1180×760 in both appearances the
  session list collapses to the bottom edge: "Workspaces" collides with the
  "New session" footer and the wordmark, and no session rows are visible. It is
  in both committed captures. `SidebarView.swift` was not touched in the pass
  that found it, so it is pre-existing. Fix it from a session that can launch
  the app and confirm the repair, not by guessing.
- the extended Chat/Code preview scenario matrix from the brief.

Known and accepted: in Code the switcher sits below the system search field,
because `.searchable(placement: .sidebar)` owns that slot.

## Release gates — run before any release build

```bash
JUNO_CHECK_LIVE_CONTRACT=1 ./scripts/release-gates.sh [path/to/JunoMac.app]
```

Two gates currently **fail**, both release-blocking:

1. this branch carries the bare-`NULL` backfill migration (0 typed
   `NULL::timestamp`, expected 22);
2. production serves contract **1.0.1** while the build requires **1.2.0**, so
   every native sign-in is refused by the client's own version check with
   "This version of Juno is not compatible with the server".

`docs/native/RELEASE_LAYOUT.md` holds the owner's final source-layout,
same-commit and end-to-end requirements, why none of the filesystem work has
been done yet (all of it is gated on a deployment that has not happened, and the
`main` checkout still holds the only copy of the uncommitted backend work), and
the exact order to execute it in once the release is live.

## Next task — Phase 5, backend reconciliation

This is the blocker for everything downstream (release integration, deploy).
Nothing about it has been started.

1. **Triage the uncommitted backend work in the `main` checkout.** It is still
   sitting there, untouched and unstaged, in
   `/Users/liammagnier/Desktop/workspace/juno`:

   ```
   M  prisma/schema.prisma
   M  src/app/api/code/devices/route.ts
   M  src/app/api/code/tasks/route.ts
   M  src/lib/code-remote.ts
   ?? prisma/migrations/20260719120000_remote_code_sessions/
   ?? src/app/api/code/devices/[deviceId]/
   ?? src/lib/code-remote-sessions.ts
   ?? src/lib/code-session-command-route.ts
   ?? tests/code-remote-sessions.test.ts
   ```

   A backup exists outside the repository (`tracked.patch` + `untracked.tgz` in
   the session scratchpad), but **do not rely on it** — re-back-up first, then
   work from the checkout. Do not apply the patch wholesale. Classify each file
   against `origin/main`, the published contract in
   `contracts/openapi/juno-native-v1.yaml`, and `CODE_REMOTE_AUDIT.md`, then
   port what is useful through reviewed atomic commits.

2. **Update PR #19 onto PR #18.** `agent/juno-code-remote-backend` is at
   `cedc264` with a worktree at
   `/Users/liammagnier/Desktop/workspace/.worktrees/juno-code-remote-backend`.
   It is based on an obsolete native checkpoint. Inspect its unique commits and
   preserve the contract/audit work. No unreviewed force-push.

Note the fetch refspec is `+refs/heads/main:refs/remotes/origin/main` **only**,
so `origin/<feature-branch>` remote-tracking refs do not exist. Compare with
`git ls-remote origin refs/heads/<branch>`, not `git rev-parse origin/<branch>`.

## Two hazards that are still live

1. **The backfill migration.**
   `prisma/migrations/20260721120000_backfill_entity_revisions/migration.sql`
   differs between the feature branches and `origin/main` in a way no
   line-count check catches — same 44 lines, same statements:

   | | typed `NULL::timestamp` | bare `NULL` |
   |---|---|---|
   | `origin/main` (deployed) | **22** | 0 |
   | feature branches | 0 | **22** |

   Re-verified 2026-07-22. The bare-`NULL` form already failed in production.
   **Take this file verbatim from `origin/main` at every integration.** Never
   resolve a conflict on it by keeping the branch copy. Add a release assertion
   that counts the 22 occurrences.

2. **`20260719120000_remote_code_sessions`** (untracked on `main`) sorts
   *before* the already-applied `20260721120000_…`. Do not apply, rename or
   commit it until you establish whether it ever ran anywhere, whether its
   `ALTER TABLE`s are safe against the current schema, and whether its unique
   indexes can be built against existing rows. A new forward-only migration is
   probably the correct answer.

## Environment facts worth not rediscovering

- **Signed builds are required to test anything behind auth.** An unsigned build
  has no `application-identifier`, so iOS refuses Keychain access with -34018
  and the sign-in gate goes unavailable. `CODE_SIGNING_ALLOWED=NO` is a compile
  gate only. See `TESTING.md`.
- **macOS screenshots DO work** — an earlier note here said they returned black,
  which was a transient, not a permission failure. Capture **by window id** so
  the app is never fronted (this runs on the owner's active machine):
  `CGWindowListCopyWindowInfo` → the window whose owner is `Juno` and height
  > 200 → `screencapture -x -o -l<id>`. Launch with `open -n -g -a` (without
  `-n`, a second launch re-activates the existing instance and no new window
  appears), and allow ~10s with a retry loop before the window exists. Clear
  `~/Library/Saved Application State/<bundle>.savedState` first or AppKit
  restores the previous sidebar/split geometry and the shots are not comparable.
- **macOS XCUITest still cannot run here** — the runner fails to load its bundle
  under both unsigned and ad-hoc signing. Use the live accessibility tree for
  structure: launch, set `AXEnhancedUserInterface` via System Events, walk
  `UI elements`. That found three real defects a screenshot would not have.
- **iOS simulator screenshots do work** (`xcrun simctl io … screenshot`) and are
  the best visual QA available here.
- **`timeout` does not exist** on this macOS host.
- **Xcode:** always prefix with
  `DEVELOPER_DIR=/Applications/Xcode-beta.app/Contents/Developer`.
- **Copying a signed `.app` into this worktree breaks its signature** — the
  Desktop/iCloud file provider attaches Finder metadata. `xattr -cr` afterwards.
- **`gh` auth is valid** (scopes `repo`, `workflow`), contrary to the older note
  in STATUS.md. Pushing works.

## Signing credentials — what exists and what does not

Available: exactly one identity, `Apple Development: liam.magnier25@icloud.com`,
team `58PVP763WX`.

Missing, each needing a one-time action in the Apple Developer account:

1. **Developer ID Application certificate** — for a Gatekeeper-accepted macOS
   build.
2. **App Store Connect API key** (Issuer ID + Key ID + `.p8`) — for `notarytool`
   and TestFlight.
3. **Apple Distribution certificate** + App Store/Ad Hoc profile for
   `com.liammagnier.JunoMobile` — for a distributable `.ipa`.

## Still unimplemented

Phases 6–13 in full: attachments (camera/photos/files), Deep Research, Canvas,
the Juno Code Remote control plane, the Mac Remote host, mobile Remote, Cloud
isolation, and the security threat model. GAP-021/022/023 stand. Do not treat
any of these as a finishing pass — each is a feature.
