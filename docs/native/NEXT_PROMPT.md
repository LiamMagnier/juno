# Next session — start here

Read this file first, then `STATUS.md` for the longer history. Everything below
was verified on 2026-07-22, not remembered.

## The headline: the release is deployed and production is healthy

`main` is `2f07804` and that exact commit is live at `https://chat.liams.dev`.
Both release blockers that previous sessions recorded are **closed**.

```
JUNO_CHECK_LIVE_CONTRACT=1 ./scripts/release-gates.sh
→ All release gates passed.
```

Verified after the deploy, by request rather than by assumption:

| check | result |
|---|---|
| `x-juno-contract-version` from production | `1.3.0` (was `1.0.1`) |
| homepage | HTTP 200 |
| `/api/v1/auth/session`, `/api/v1/bootstrap`, `/api/v1/entities/index` | HTTP 401 unauthenticated — routes exist, auth enforced |
| `prisma migrate deploy` | `41 migrations found. No pending migrations to apply.` |
| pm2 | `juno-backend`, `juno-voice-relay`, `juno-scheduler` all online |

The deploy changed **no database schema at all** — the release adds no
migrations, which is a large part of why it was safe to ship.

## Exact starting point

```
worktree  /Users/liammagnier/Desktop/workspace/.worktrees/juno-code-remote-backend
branch    agent/juno-code-remote-backend   (== main == 2f07804)
tree      clean, no merge/rebase/cherry-pick in progress
```

```bash
cd /Users/liammagnier/Desktop/workspace/.worktrees/juno-code-remote-backend && \
git status --short && git log --oneline -3
```

## What this session actually did

1. **Closed the migration hazard for good.** The feature branches *created*
   `20260721120000_backfill_entity_revisions` at 48d6969 with bare `NULL`, and
   never inherited `origin/main`'s fix from 173be21 (#16) — so merging them into
   main really would have reintroduced the form that already failed in
   production. Both feature branches now carry the file **byte-identical to
   origin/main**, all 22 `NULL::timestamp` present, and `release-gates.sh`
   asserts the count mechanically.

2. **Merged PR #18 into PR #19** (`38f2a40`) rather than rebasing, so the four
   PR #19 commits keep their identities and nothing needed a force-push. One
   conflict, `docs/native/handoff.json`; `API_GAPS.md` auto-merged.

3. **Integrated and shipped the release** (`2f07804`). `origin/main` carried
   `8e7b898`, the **squash merge** of PR #15, which had landed an earlier
   snapshot of this same native lineage as brand-new files — that is why 35 of
   39 conflicts were add/add even though the branch is a strict continuation (it
   contains `agent/juno-native` 31225f7; 274 native files against main's 129).
   Every conflict resolved to the branch side, then checked rather than assumed:
   `profile/page.tsx` came out byte-identical to origin/main, so main's e0d1285
   fix survived, and the migration set is identical to main's.

4. **Rescued the orphaned backend work** onto
   `agent/juno-code-remote-orphan-recovery` (`2b353f6`, pushed). It had been
   sitting uncommitted on the `main` *checkout*, and its only backup was in a
   `/private/tmp` scratchpad that does not survive a reboot. Recovered
   byte-identically — verified file by file against the live checkout, and the
   SHA-256 prefixes match the capture manifest.

The `main` checkout at `/Users/liammagnier/Desktop/workspace/juno` was **not
touched** and still holds that same uncommitted work. It can now be reverted
safely, because the work is committed and pushed — but that is the owner's call.

## Two macOS blockers that need the owner, and a correction

**The previous diagnosis was wrong.** The old `NEXT_PROMPT.md` said window
creation broke because the capture harness ran `killall cfprefsd`. That is not
what is happening: **TextEdit launches and gets a window fine in this same login
session.** Do not spend time on the cfprefsd theory. (Still never run that
command — but it is not the cause.)

What is actually true, both established by experiment:

1. **Screen Recording is not granted**, so there are no pixel captures at all.
   A full-screen `screencapture -x` returns a **pure black image**;
   `screencapture -l<windowid>` and `-R<rect>` are refused outright with "could
   not create image from window/rect"; ScreenCaptureKit from a CLI binary fails
   with `SCStreamErrorDomain -3811`. **Owner action:** grant Screen Recording to
   the controlling app in System Settings ▸ Privacy & Security ▸ Screen Recording.

2. **~~Every Xcode-built Juno target~~ `CODE_SIGNING_ALLOWED=NO` builds create
   zero windows on launch. — SOLVED, no owner action needed.** Unsigned builds
   (JunoMac and standalone JunoCode alike) launch, run a normal AppKit event
   loop and never produce a window, confirmed by `CGWindowListCopyWindowInfo`
   including off-screen windows and by an accessibility window count of 0 after
   60s. But a **properly signed `Stable` build launches fine** and gets a real
   1512×859 window. The cause is that `CODE_SIGNING_ALLOWED=NO` leaves the
   bundle only *linker*-signed with `Info.plist=not bound`; re-signing it
   afterwards with ad-hoc `codesign` does **not** rescue it — the signature must
   be applied by the build.

   ```bash
   DEVELOPER_DIR=/Applications/Xcode-beta.app/Contents/Developer xcodebuild \
     -project native/macOS/JunoMac/JunoMac.xcodeproj \
     -scheme JunoMac -configuration Stable \
     -derivedDataPath /private/tmp/juno-mac-stable \
     -allowProvisioningUpdates DEVELOPMENT_TEAM=58PVP763WX build
   ```

So only **blocker 1 (Screen Recording) is still open**. The app itself runs. The
capture matrix (900×650 / 1180×760 / 1440×900 / full screen × light/dark ×
Chat/Code × inspector open/closed) still cannot be taken because every capture
comes back black, but the Code sidebar defect **can** now be diagnosed live
against a signed build using the accessibility tree, which reports real
positions and sizes.

### The Code sidebar defect is real — and here is a lead the old notes missed

Re-reading the two committed captures confirms the symptom: in
`after-code-transcript-light.png` and `-dark.png` the sidebar shows **no session
rows at all**, and "Workspaces", the "New session" footer and a wordmark are
stacked on top of each other at the bottom-left edge.

The narrowing detail: the healthy `after-code-light.png` is the **JunoMac shell**
(it has the Juno header and the Chat/Code switcher), while the two broken
captures are the `--juno-code-ui-preview` branch, which renders `WorkbenchView`
with `sidebarHeader == EmptyView`. So the defect belongs to the
**no-sidebar-header composition**, not to `SidebarView` in general. Start at
`WorkbenchView.swift:37`, which applies `.safeAreaInset(edge: .top, spacing: 0)`
with an `EmptyView`, above a `List` that also carries
`.searchable(placement: .sidebar)` and a bottom `.safeAreaInset`.

## What is genuinely still unbuilt

Phases 6–13 remain features, not finishing passes: attachments
(camera/photos/files), Deep Research, Canvas, the Juno Code Remote control
plane, the Mac Remote host, mobile Remote, Cloud isolation, and the security
threat model. GAP-021/022/023 stand.

**Do not read the deploy as "the product works end to end."** What is proven is
that the web backend is live at contract 1.3.0 and the native clients build
against it. Chat, attachments, Deep Research, Canvas and Remote have **not** been
exercised against production from a native client in this session.

## The orphaned relay: triaged, deliberately not shipped

`agent/juno-code-remote-orphan-recovery` holds three new Prisma models, seven
route handlers under `/api/code/devices/{deviceId}/**`, and a test file. It is
**not** in the release, for three reasons:

1. Those routes are **not in the published contract**. PR #19 published only the
   *read* surface of the already-existing task-based control plane
   (`/code/devices`, `/code/workspaces`, `/code/tasks`, `/code/tasks/{taskId}`)
   and changed no backend route. Shipping the relay would put un-contracted
   routes into production.
2. It has no native callers, so it would add production schema and attack
   surface for behaviour no client can reach.
3. Its migration `20260719120000_remote_code_sessions` is dated *before*
   `20260721120000_backfill_entity_revisions`, which is already applied in
   production, so it sorts behind applied history.

Two of the three open questions from the manifest can now be answered by reading
the SQL:

- The unique index `CodeTask_userId_idempotencyKey_key` **is safe** against
  existing rows: `idempotencyKey` is added nullable with no default, and
  Postgres treats NULLs as distinct in a unique index.
- The `ALTER TABLE`s are **not idempotent** (plain `ADD COLUMN`, no
  `IF NOT EXISTS`), so they would fail on a second run. That is fine under
  `migrate deploy`, which never reapplies a recorded migration, and a hazard for
  any manual replay.

Still unanswered, and it needs the database: **was this migration ever applied
anywhere?** Query `_prisma_migrations` before doing anything else with it. A new
forward-only migration with a current timestamp is very likely the right answer.

## Signing credentials — still the hard blocker for distributable builds

Available: exactly one identity, `Apple Development: liam.magnier25@icloud.com`,
team `58PVP763WX`. Each of these needs a one-time action in the Apple Developer
account and cannot be worked around:

1. **Developer ID Application certificate** — for a Gatekeeper-accepted macOS build.
2. **App Store Connect API key** (Issuer ID + Key ID + `.p8`) — for `notarytool`.
3. **Apple Distribution certificate** + profile for `com.liammagnier.JunoMobile`
   — for a distributable `.ipa`.

Also: `/Applications/Juno.app` **does not exist**. The older note about a "stale
installed build" to avoid reusing is out of date.

## Environment facts worth not rediscovering

- **Signed builds are required to test anything behind auth.** An unsigned build
  has no `application-identifier`, so iOS refuses Keychain access with -34018.
  `CODE_SIGNING_ALLOWED=NO` is a compile gate only.
- **`xcodebuild ... CODE_SIGNING_ALLOWED=NO` produces a linker-signed app whose
  `Info.plist` is *not bound*** — `codesign -dv` reports `Identifier=JunoCode`
  rather than the bundle id. Re-sign with `codesign -s - --force --deep` before
  testing anything signature-sensitive.
- **iOS simulator screenshots do work** (`xcrun simctl io … screenshot`) and are
  the best visual QA available while macOS capture is blocked.
- **`timeout` does not exist** on this macOS host.
- **Xcode:** always prefix with
  `DEVELOPER_DIR=/Applications/Xcode-beta.app/Contents/Developer`.
- Keep derived data **off** the iCloud Desktop; `/private/tmp/...` works.
- The fetch refspec is `+refs/heads/main:refs/remotes/origin/main` **only**, so
  `origin/<feature-branch>` remote-tracking refs do not exist. Compare with
  `git ls-remote origin refs/heads/<branch>`, not `git rev-parse origin/<branch>`.

## Suggested next task

With production live at 1.3.0, the highest-value work that needs **no** owner
action is Phase 5: exercise Chat end to end from a native client against
production — sign-in, conversation list, send, stream, Stop, retry, and the
Web ↔ Mac ↔ iPhone sync path — using the iOS simulator, which can still be
screenshotted. That is what converts "the backend is deployed" into "the product
works", which is the actual goal.
