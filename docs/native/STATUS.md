# Juno Native — Status

Last updated: 2026-07-22 21:15 Europe/Paris

> **Start a new session at `docs/native/NEXT_PROMPT.md`.** It carries the exact
> worktree, branch, head, next task and the live hazards. This file is the
> longer history behind it.

## Session 2026-07-22 (night) — the release is deployed, head `2f07804`

`main` is `2f07804` and that exact commit is **live** at
`https://chat.liams.dev`. `JUNO_CHECK_LIVE_CONTRACT=1 ./scripts/release-gates.sh`
reports **all release gates passed**, which it could not do in any previous
session.

Verified after the deploy by asking production, not by assuming:

| check | result |
|---|---|
| `x-juno-contract-version` | `1.3.0` (was `1.0.1`) |
| homepage | HTTP 200 |
| `/api/v1/auth/session`, `/api/v1/bootstrap`, `/api/v1/entities/index` | HTTP 401 unauthenticated — routes exist, auth enforced |
| `prisma migrate deploy` | `41 migrations found. No pending migrations to apply.` |
| pm2 | `juno-backend`, `juno-voice-relay`, `juno-scheduler` all online |

**The deploy made no schema change.** The release adds no migrations at all,
which is most of why it was safe to ship. The real production delta was three
files — the contract version bump plus small additions to the v1 mutations route
and `sync-mutations` — because `#15` had already shipped the rest.

### The two hazards, both closed

**The bare-`NULL` backfill migration.** This was not a hypothetical. The feature
branches *created* `20260721120000_backfill_entity_revisions` at `48d6969` with
bare `NULL`, and never inherited `origin/main`'s fix from `173be21` (#16), so a
merge into main genuinely would have reintroduced the form that already failed
in production. Both feature branches now carry the file **byte-identical to
origin/main**, all 22 `NULL::timestamp` intact, and `release-gates.sh` asserts
the count mechanically.

**The contract standoff.** Production served `1.0.1` while the build required
`1.3.0`, so the client's own version check refused every native sign-in. Only
deploying could resolve it, and it did.

### The integration, and the trap in it

`origin/main` carried `8e7b898`, the **squash merge** of PR #15, which had landed
an *earlier snapshot* of this same native lineage as brand-new files. A squash
keeps no history, so git saw 35 of 39 conflicts as add/add even though the branch
is a strict continuation — it contains `agent/juno-native` (`31225f7`) and has
274 native files to main's 129.

Every conflict resolved to the branch side, but a squash merge is exactly the
shape that silently reverts shipped work, so the result was checked rather than
trusted: `profile/page.tsx` came out **byte-identical to origin/main**, so main's
`e0d1285` fix survived, and the migration set matches main's exactly.

### The orphaned backend work is no longer at risk

It had been sitting uncommitted on the `main` *checkout*, with its only backup in
a `/private/tmp` scratchpad that does not survive a reboot. It is now committed
verbatim on `agent/juno-code-remote-orphan-recovery` (`2b353f6`, pushed),
verified file-by-file against the live checkout with SHA-256 prefixes matching
the capture manifest. The `main` checkout itself was **not touched**.

It is deliberately **not** in the release: its `/api/code/devices/{deviceId}/**`
routes are not in the published contract, it has no native callers, and its
migration sorts before already-applied history. Two of the manifest's three open
questions are now answered from the SQL — the `CodeTask_userId_idempotencyKey_key`
unique index *is* safe against existing rows (nullable column, and Postgres
treats NULLs as distinct), and the `ALTER TABLE`s are *not* idempotent. Whether
that migration ever ran anywhere still needs a `_prisma_migrations` query.

### What this does not mean

**The product is not verified end to end.** What is proven is that the backend is
live at contract 1.3.0 and the native clients build against it. Chat,
attachments, Deep Research, Canvas and Remote were not exercised against
production from a native client, and phases 6–13 remain unbuilt features.

macOS visual QA is blocked on two owner actions — Screen Recording permission,
and a login-session restart — and the previous session's `killall cfprefsd`
explanation for the second one is **wrong**. See `MACOS_DESIGN_REVIEW.md` §9.

## Session 2026-07-22 (late) — Juno Code developer surfaces, head `d19e924`

The half of the macOS redesign that the previous entry listed as *not done* —
the Code transcript, tool calls, approvals, terminal, diff, tests, Git,
checkpoints, composer and inspector navigation — is now done and committed as
`d19e924`. The full reasoning is in `MACOS_DESIGN_REVIEW.md` §8; the short
version is that `JunoCodeTheme` stopped being a second design system and became
an alias layer over `JunoDesignSystem`, and every non-message transcript event
collapsed into one `ActivityRow` shape.

**A real defect fell out of it.** `JunoMacApp.init()` built the live
configuration unconditionally, so launching the DEBUG preview opened the live
SQLite account store and built the live auth runtime against `chat.liams.dev`,
contradicting the preview's own inertness claim. Preview launches now resolve
`.inert`. This was found by trying to screenshot the preview, not by reading it.

### Verified

- `JunoCode` and `JunoNativeKit`: `swift build -Xswiftc
  -strict-concurrency=complete` clean, suites pass with zero failures.
- JunoMac Debug: `** BUILD SUCCEEDED **`.
- Two window-only captures committed: `docs/native/design/
  after-code-transcript-{light,dark}.png`, both 1180×760.

### Two things that are *not* done, and must not be read as done

1. **The capture matrix is incomplete.** 900×650, 1440×900, full screen and the
   inspector-open/closed pairs were not captured. Window creation for newly
   launched apps broke in that login session — the capture harness ran
   `killall cfprefsd`, which takes down the login session's preferences daemon,
   and afterwards nothing newly launched gets a window. The harness now carries
   a comment forbidding it. Re-run from a fresh login session to finish.
2. **The Code sidebar has a confirmed layout defect.** The session list collapses
   to the bottom edge — "Workspaces" collides with the "New session" footer and
   the wordmark, and no session rows show. Visible in both committed captures.
   `SidebarView.swift` was untouched this pass, so it is pre-existing, not a
   regression. Left unfixed on purpose: with no way to launch the app, a fix
   would be a guess dressed up as a repair.

## Session 2026-07-22 (evening) — Mac Chat workspace, head `043051b`

The Mac app opened on a list of destinations, with Chat buried behind a *second*
`NavigationSplitView` nested inside the detail column. History was two clicks
deep and Juno Code — one section — read as the whole product. That is fixed.

`JunoMac` is now one three-region native workspace that opens on Chat, verified
in the running app rather than in the source: a single sidebar carrying the
destinations *and* the recency-grouped conversation history, a borderless
Markdown transcript, a native resizable inspector (⌥⌘I), and a floating Liquid
Glass composer with per-conversation drafts. Glass is confined to the composer
and the scroll-to-latest control; the reading surface stays opaque.

### Corrections to earlier entries in this file

Three claims recorded below were wrong, and are corrected here rather than
edited out:

- **"JunoMacTests 2/2"** — `JunoMacNavigationTests` asserted
  `identifiers.count == 9` against a seven-case enum and had been failing. It
  now asserts the destinations by name, that Chat is first, that each belongs to
  exactly one sidebar group, and that the shortcuts are unique. 5/5.
- **"GitHub CLI: the stored token is invalid"** — it is valid, with `repo` and
  `workflow` scopes. Pushing works.
- **Every "passing command" using `CODE_SIGNING_ALLOWED=NO`** — those verify
  that the apps *compile*, not that they *run*. An unsigned build has no
  `application-identifier`, which iOS uses as the default Keychain access group,
  so every Keychain call fails with `errSecMissingEntitlement` (-34018), no
  token can be stored, and the sign-in gate goes `.unavailable` with its button
  hidden. Rebuilt with signing enabled, the same configuration reaches a working
  sign-in gate. See `TESTING.md`.

A fourth item in the mission brief — "the hanging JunoAuthTests" — **does not
reproduce**. The suite finishes in ~18 ms, all passing, at `69cf7df` and since.

### Defects found by reading the live accessibility tree

`screencapture` returns an all-black image (Screen Recording not granted) and
the macOS XCUITest runner cannot load its bundle here, so macOS visual QA was
done by walking the running app's accessibility tree. It surfaced three real
defects that a screenshot would not have:

1. `.accessibilityIdentifier` on the workspace container propagated to every
   descendant and **overrode** the composer's and Send button's own, leaving
   them unaddressable by any UI test. It now marks the transcript alone.
2. Icon-only buttons built from a bare `Image` reached VoiceOver **unnamed**,
   and SwiftUI fell back to the SF Symbol id (`doc.on.doc`) as the accessibility
   identifier. Now `Label` + `.labelStyle(.iconOnly)`.
3. The window subtitle rendered the raw `anthropic:claude-sonnet-4-6`. Mobile
   already had a humanizer as a private free function inside a view file; it is
   now `junoDisplayModelName` in `JunoChatKit` with 9 tests, used by both apps,
   and the mobile copy is deleted rather than duplicated.

### Artifacts

Built and verified in `dist/` (binaries gitignored, docs tracked):

- `Juno-0.1.0-macOS.dmg` and `.app` — universal, hardened runtime, **Apple
  Development** signed. Gatekeeper rejects it: no Developer ID certificate, no
  notarization.
- `Juno-0.1.0-iOS-development.ipa` — development signed, **one registered
  device**, profile expires **2026-07-29**.
- `Juno-0.1.0-iOS-Simulator.app.zip` — signed on purpose; an unsigned simulator
  build cannot sign in.
- `SHA256SUMS.txt`, `INSTALL.md`, `RELEASE_NOTES.md`, `DELIVERY_REPORT.md`.

Release builds contain **no preview code**: zero preview launch-flag literals
and zero `JunoPreviewSupport`/`JunoPreviewContainer`/`CodePreviewScenario` code
symbols in the Stable binary.

### Not done this session

Phases 5–16 and 18 of the delivery mission: backend reconciliation, the full
test matrix (no JS/backend suite was run), release integration, production
deployment, and authenticated end-to-end smoke tests. `main` was not touched and
`origin/main` is still `173be21`. Attachments, Deep Research, Canvas and all of
Remote/Cloud remain unimplemented — GAP-021/022/023 stand.

Tests: package **220/220** (was 169 at session start), `JunoMacTests` 5/5,
JunoMac Debug/Stable/archive, JunoMobile Debug/Stable/archive/export.

---

## Earlier history

Last updated: 2026-07-22 17:35 Europe/Paris

## Concurrent-session recovery (head `37db1af`)

A second agent session was editing this worktree in parallel and was stopped. The
in-flight work was inspected and recovered rather than discarded:

- **Kept** — `WorkbenchModel.swift` + `JunoMacApp.swift`: the `--juno-code-ui-preview`
  harness, committed as `d48f41f` after two corrections. Session IDs were derived from
  `hashValue`, which is seeded per process and handed out different IDs on every launch;
  they are now slugged from the title. `context(for:)` fell through to the workspace
  reopen path under preview and surfaced a reopen error the user cannot act on; it now
  returns nil.
- **Reverted** — `JunoMobile.xcodeproj/project.pbxproj`: Xcode serialization churn
  (`lastKnownFileType` → `explicitFileType`, key reordering) **plus a leaked local
  `DEVELOPMENT_TEAM` signing identity**, which must never be committed.
- **Reverted** — `JunoMobile/Resources/Localizable.xcstrings`: an Xcode String Catalog
  rewrite that reformatted all 518 lines, marked 24 real translated keys
  `extractionState: "stale"`, and injected 242 auto-extracted keys with **no French
  values**. Committing it would have damaged the EN/FR catalog that Phase 7 must validate.

Both reverted diffs are preserved outside the repository in the session scratchpad.
Xcode is open against this worktree and will re-dirty `project.pbxproj`; stage by explicit
path and re-check `git status` before every commit.

### Preview harness — what it does and does not cover

`--juno-code-ui-preview` (macOS, DEBUG only; `--juno-preview-dark` for dark mode;
`--juno-code-preview-scenario <name>` to choose the initially selected session) is inert
**by construction**, not by flag checks.

`SessionController` holds every capability-bearing dependency — `WorkspaceContext`,
`CodeSessionStore`, `PermissionCoordinator`, `AgentOrchestrator` — in a single optional
`Live` bundle. `SessionController.init(previewFixture:)` builds without it, so
`CommandExecutionService`, `GitService`, `CheckpointStore`, `WorkspaceIndexService`,
`ToolRegistry` and the model transport are **absent from the object graph** rather than
present and merely uncalled. No production security check is relaxed, and no call site can
forget to check a flag. Storage still points at a throwaway temp path that is never
created, and fixture workspaces carry no security-scoped bookmark.

Closing that boundary required the views to stop reaching through `controller.context`
into the runtime. They now use `workspaceDisplayName`, `workspacePathDisplay`,
`isGitRepository` and `findFiles(nameContains:limit:)`.

Ten scenarios — `transcript`, `streaming`, `approval`, `terminal`, `diffs`, `tests`,
`longText`, `error`, `disconnected`, `empty` — cover every renderable state: all seven
session statuses, every tool-call outcome (succeeded/failed/denied/cancelled), created/
modified/deleted changes, stdout/stderr/log, pending/approved/denied requests, passing and
failing test runs, clean and conflicted Git, recoverable and fatal errors, checkpoint-
labelled changes, and deliberately oversized prompts, answers, paths and terminal output.
Each scenario owns a sidebar session, so **all of them are reachable in one launch**; the
launch argument only preselects one.

Identifiers derive from scenario names, never `UUID()` or `hashValue` (both seeded per
process). Timestamps are offsets from one process-wide anchor, because the sidebar groups
by recency — structure and identity are byte-identical between launches; only the absolute
wall clock moves.

Seventeen tests in `CodePreviewHarnessTests` assert the runtime is unreachable, the storage
root is never created, `send`/`runTest`/`commit`/`rejectChange` cannot execute anything,
the fixtures cover the full render matrix, and no tool call is left unrenderable.

**Not covered.** There is no first-class *disconnected* state in the local Code UI — the
`disconnected` scenario models it as a `.stopping` session with a recoverable transport
error and a reconnect banner, which is all the current UI can express. A real
connection-state model belongs to Remote/Cloud sessions and is blocked on GAP-021.

### Visual sweep — defects found and fixed

Launching all ten scenarios (light and dark, 1000×640 / 1280×800 / 1600×1000, inspector
tabs Changes/Diff/Terminal/Tests/Git/Files/Context) surfaced five real defects, fixed in
`37db1af`:

1. **Inspector centred itself vertically** — picker included — whenever the selected tab's
   body did not expand, which is every `ContentUnavailableView` empty state. Tab content
   now fills the pane and the stack is pinned top.
2. **Terminal output soft-wrapped**, destroying column alignment and doubling every line's
   height. It now scrolls horizontally. Same defect and fix in the expanded tool-call row.
3. **Whole-path middle truncation ate the filename** (`native/Packages/…figuration.swift`).
   Paths now split into filename + directory, the directory truncating from the head.
4. **"1 files"** in the Changes summary and the run-finished row.
5. **Sidebar workspace paths truncated at the tail**, discarding the identifying folders.

The fixtures hid a sixth: they hard-coded `/Users/preview/…`, and
`abbreviatingWithTildeInPath` only rewrites the *real* user's home, so the sidebar and
Context tab silently skipped abbreviation and would have shown a raw home path in
production. Two fixture workspaces now sit under the real home so the `~` path is
exercised, one stays outside it, and a test asserts both.

**Checked, not a defect:** the last sidebar row looks clipped by the pinned "New Code
Session" button at the initial scroll position. Scrolling to the bottom shows the final row
fully clear of the button — `SidebarView` already applies `.safeAreaInset(edge: .bottom)`
and it reserves the space correctly. Verified at 1180×760 in both light and dark. Recorded
so it is not "fixed" twice.

## Backend worktree — created 2026-07-22

`agent/juno-code-remote-backend` had no worktree. Verified it was checked out nowhere
(`git worktree list`, `git branch -vv`) and that local matched remote (`cedc264`), then:

```bash
git worktree add /Users/liammagnier/Desktop/workspace/.worktrees/juno-code-remote-backend \
  agent/juno-code-remote-backend
```

The worktree is clean at `cedc264`, equal to `origin/agent/juno-code-remote-backend`. Note
that `.git` for every worktree lives at `/Users/liammagnier/Desktop/workspace/juno/.git`,
and the fetch refspec is **`+refs/heads/main:refs/remotes/origin/main` only** — so
`origin/<feature-branch>` remote-tracking refs do not exist. Compare against a feature
branch with `git ls-remote origin refs/heads/<branch>`, not `git rev-parse origin/<branch>`,
which fails with "unknown revision".

Relative to `origin/main` the branch is 281 files / +46 975 lines, and its backend
contribution is the **contract** (`contracts/openapi/juno-native-v1.yaml`,
`CODE_REMOTE_AUDIT.md`) plus the stacked native UI commits — it adds no
`src/app/api/code/**` route. The orphaned uncommitted work on `main` is a candidate
*implementation* of that contract; the two are complementary, and the implementation must
be checked against the published contract rather than assumed to match it.

### Migration hazard — confirmed, see D-015

`prisma/migrations/20260721120000_backfill_entity_revisions/migration.sql` differs between
this branch and `origin/main`, and the difference is invisible to a line-count check:

| | lines | `NULL::timestamp` | bare `NULL` |
|---|---|---|---|
| `agent/juno-code-remote-backend` | 44 | **0** | **22** |
| `origin/main` (deployed) | 44 | **22** | **0** |

Identical statements, identical length — only the NULL typing differs. The bare-`NULL`
form is the one that already failed, because an untyped NULL in the `INSERT ... SELECT`
gives Postgres no column type to infer. **Take this file verbatim from `origin/main` at
integration; never resolve a conflict on it by keeping the branch copy.** The file was not
modified in either worktree.

A second, separate hazard still stands: `20260719120000_remote_code_sessions` (untracked on
`main`, captured in the scratchpad backup) sorts *before* the already-applied
`20260721120000_…`. Do not rename, apply or deploy it until it is established whether it
ever ran anywhere, whether its `ALTER TABLE`s are safe against the current schema, and
whether its unique indexes can be built against existing rows.

## Mobile UI refresh — session log (head `b5dbc98`)

Screenshot-driven mobile corrections, all on `agent/juno-native-claude-continuation`
(PR #18), each built Debug+Stable, package strict, and visually inspected in the
iOS 27 simulator (light + dark) before commit:

- `feat(mobile): replace tab bar with adaptive sidebar` → reveal-style drawer
  (fixed sidebar layer; the full-size chat plate slides right with the iPhone
  corner radius, no scale, no veil). Custom dense sidebar (no List/Form), Juno
  header + glass Search, Projects/Library/Artifacts, pinned/recents, footer with
  a glass profile button and a translucent accent "Chat" capsule. Fixes the
  Library/Artifacts TabView-switch crashes (regression tests added).
- `feat(mobile): present settings in native modal sheet` → large sheet from the
  profile button, single NavigationStack, glass X (no root Back), Memory pushes
  with one Back.
- `feat(mobile): dock a liquid glass send button and humanize model names` →
  Send inside the composer (coral glass, → Stop on stream); model shown as
  "Claude Sonnet 4.6", never the raw id.
- `fix(mobile): rebuild compact composer actions popover` → small glass popover
  anchored to a "+" (morphs to ×). Only the wired **Add to project** action
  (server-validated `conversation.update` projectId patch; new
  `NativeConversation.projectId` + `setProject`). Camera/Photos/Files and Deep
  Research/Canvas are omitted, documented as **GAP-022 / GAP-023**.
- `feat(mobile): surface reasoning inline and above the answer` → "Thinking about
  your request" status during generation; collapsible coral "Reasoning" control
  above the answer.

### Phase 5 product-screen pass (head `1f9c27d`)

Continued on PR #18, each built Debug+Stable and inspected in the iOS 27
simulator (light + dark):

- `feat(mobile): redesign the projects list and detail` — compact plain list
  (no inset-grouped card), favorite star, human counts, Favorite/Rename/Delete
  context menu; detail gains a dedicated multiline "Edit instructions" editor
  sheet with a saving indicator. Realistic fixture project/file names.
- `feat(mobile): redesign the memory page around the web architecture` —
  "What Juno remembers", Memory summary + refresh, Pause memory toggle,
  collapsible "Manage edits", destructive Reset; single Back; no fabricated
  Work/Personal split (native summary is one string) and no Export (none exists).
- `feat(mobile): redesign library and artifacts lists` — plain lists with a
  searchable filter and coral type glyphs; Library rows show the resolved
  project name, not the raw `proj-…` id.
- **Search** reviewed and left unchanged: already a compliant debounced,
  grouped, accent-insensitive global search with all empty/error/loading states
  and VoiceOver hints.

### Juno Code macOS review + Phase 6 motion (head `cbd19cf`)

- **Juno Code macOS** (`JunoCodeUI` `WorkbenchView` + `SidebarView`,
  `AgentCanvasView`, `InspectorView`) was fully code-reviewed and found already
  compliant and high-quality: native resizable three-pane split, every run state
  (idle/running/waiting/failed/completed/cancelled), approvals with keyboard
  shortcuts, gutter diffs, stderr-coloured terminal, test detection/re-run,
  Git/Files/Context/Computer tabs, tilde-abbreviated paths (no raw paths/ids),
  no fake actions, full accessibility labels and ⌘N/⌘./⌘⏎/⌘⇧O/⌘⌥I shortcuts.
  **No changes warranted** (churning good code would risk regressions).
  Validated: JunoMac Debug ✓, JunoMac Stable ✓, JunoCode strict compile ✓.
  Populated-session visual QA needs a live workspace/runtime (the preview
  harness ships no Code workspaces), so it was validated by review + builds.
- `feat(native): add a shared JunoMotion token system` — `JunoMotion`
  (fast/standard/emphasized/spring + Reduce-Motion `reduced(_:when:)`) in the
  design system, applied across every mobile interaction (sidebar reveal,
  +→×, Send/Stop, reasoning disclosure, scroll-to-latest).

**Still open on PR #18:** Phase 7 (full a11y/Dynamic Type/keyboard + device
matrix across iPhone sizes, iPad split, macOS windows, FR/EN) and Phase 8 (a
complete visual-QA sweep of every surface × every preview scenario × light/dark).
Substantial per-surface visual QA was already done inline for each unit this
session, but the exhaustive matrix remains. **Phases 9–13** (attachments/parity
resolving GAP-022/023, Deep Research, Canvas, Juno Code Remote Host, Cloud
isolation, security threat model, release integration) are untouched on PR #18;
Remote/Cloud belong on the stacked backend branch (PR #19), not here.

`prisma/` untouched all session; the release MUST take the backfill migration
verbatim from `origin/main` (typed `NULL::timestamp`) — see RELEASE.md.

**Exact next step:** Phase 7/8 exhaustive QA on the mobile surfaces (start by
capturing `empty`, `offline`, `error`, `conflict`, `longText` scenarios for
chat/projects/memory/library/artifacts in light+dark and fixing any truncation/
overlap/contrast found), then move to the backend worktree
`/Users/liammagnier/Desktop/workspace/.worktrees/juno-code-remote-backend`
(branch `agent/juno-code-remote-backend`, PR #19) and rebase it onto
`origin/agent/juno-native-claude-continuation` before resuming Phase 9.

## Repository state

- Branch: `agent/juno-native-claude-continuation` (continuation of `agent/juno-native`; PRs target `agent/juno-native`, never `main`).
- Current completed implementation commit: `778a47d` (`feat(native): add real memory and settings`).
- Native worktree: `/Users/liammagnier/Desktop/workspace/.worktrees/juno-native-claude`.
- Known unstaged Xcode 27 project/scheme and String Catalog rewrites remain
  preserved outside the implementation commits; inspect rather than resetting them.
- Main checkout: `/Users/liammagnier/Desktop/workspace/juno` remains independently on `main` at `e0d1285`, with pre-existing Remote Session changes untouched by this run.
- Remote: `origin https://github.com/LiamMagnier/juno.git`.
- GitHub CLI: installed, but the stored `LiamMagnier` token is invalid.

## Current phase

All functional units are complete: production auth, storage, sync, chat, projects/
files, library/artifacts, memory/settings, offline search, mutation-conflict
resolution, the offline/reconnect proof, and the Juno Code macOS integration.
Cloud/Remote Code stays gated on backend routes (GAP-021, out of scope this run).

Current work is the **native UI/UX refresh** (owner-directed, option 2), designed
for the OS 27 SDK (Liquid Glass gen-27, newest SwiftUI) with iOS 18 / macOS 15
kept as minimum deployment targets via availability checks. Sequential units:

1. Navigation architecture + sidebar — **done** (`65bc78d`): grouped resizable/
   collapsible macOS sidebar with @SceneStorage selection restoration and context
   menus; adaptive iOS `TabView(.sidebarAdaptable)`; dead Tasks/Connections and
   GAP-021 Cloud/Remote sections removed so every destination is real; account/
   sign-out moved to Settings, sync to the Chat toolbar.
2. Chat & composer — **done**: follow-the-stream auto-scroll with a floating
   scroll-to-latest control, Liquid Glass composer capsule on OS 26+, ⌘↩ send on
   macOS, explicit disabled/streaming states, crude free-text model editor
   removed. Attachments left out (no transport payload — recorded, not faked).
3. Design system & Liquid Glass — **done** (`b1ed73c`): coral accent in both
   apps' AccentColor assets (light/dark), adaptive `junoCanvas`/`junoSurface`/
   `junoHairline`/`junoAccent` semantic colors, an SF Pro type hierarchy, and a
   shared `JunoGlassBackground`/`junoFloatingGlass` helper (OS 26+ glass with a
   material fallback) now used by both composers. Six design-system tests.
4. Product screens + real states — in progress. Chat surface done (`214849a`):
   redesigned message rows (assistant spark + `junoSurface` bubble, user accent
   bubble, design-system typography, grouped sources, per-message Copy,
   VoiceOver labels) on a `junoCanvas` transcript. Remaining screens (projects/
   files, library, artifacts, memory, settings, search, Juno Code) already carry
   real loading/empty/error/offline/conflict states from the functional units;
   they still need the same design-system visual pass — best done with a signed
   build so each can be inspected, since the states live behind the auth gate.
5. Responsive, motion, accessibility, visual validation.

**Visual QA is now unblocked** by the debug-only UI Preview mode (`69f0463`):
`--juno-ui-preview` renders the real authenticated screens over an isolated
in-memory store with synthetic fixtures — no auth, network, token, Keychain, or
production data. Launch a specific state headless with
`--juno-preview-scenario <normal|manyItems|empty|loading|offline|error|conflict|mutating|longText|streaming>`
and `--juno-preview-tab <chat|search|projects|library|artifacts|settings>`.
Chat, projects, artifacts and settings inspected on iOS 27 and look native.
Known minor issue: with six iOS sections the tab bar highlights "More" when an
overflow tab (e.g. artifacts) is selected.

### Composer, model selector and Thinking (iOS)

The preview harness serves a synthetic model manifest (`PreviewModelCatalog`)
covering every state the pickers must render — Auto, a full effort ladder, an
always-on model, an on/off model, a non-reasoning model, a plan-gated model, a
coming-soon model and a deliberately long name — so these screens can be
screenshotted without an account. Additional launch arguments:

| Argument | Effect |
| --- | --- |
| `--juno-preview-model-selector` | Opens the model picker on appear |
| `--juno-preview-model-search <text>` | Prefills the picker's search field |
| `--juno-preview-model-provider <id>` | Preselects a provider filter |
| `--juno-preview-model <id>` | Forces the selected model (waits for the catalog) |
| `--juno-preview-thinking` | Opens the Thinking popover on appear |
| `--juno-preview-thinking-level <off\|minimal\|low\|medium\|high\|xhigh\|max>` | Forces the thinking level |
| `--juno-preview-keyboard` | Focuses the composer, raising the keyboard |

Example — the on/off model's two-stop slider, dark, with the keyboard up:

```sh
xcrun simctl launch <device> com.liammagnier.JunoMobile.debug \
  --juno-ui-preview --juno-preview-tab chat \
  --juno-preview-model anthropic:claude-haiku-4-5 \
  --juno-preview-thinking --juno-preview-keyboard
```

Inspected on iPhone 17 Pro (iOS 27) and iPad Pro 13" (M5): composer control row,
picker sheet (search / provider rail / rows / inline detail / plan-gated row /
no results), the iPad three-region picker, the Thinking popover at several
levels, dark mode and keyboard-open. Not yet inspected on a physical iPhone.

**Picker ordering and grouping.** The manifest carries `modality`, `legacy` and
`released`, and both clients render the server's order verbatim. Per lab that
order is: current models before superseded ones, newest release first, then most
capable first within a release — so a lab's newest generation leads and its
siblings sort by power (5.6 Sol · Terra · Luna). Each picker is sectioned by
modality (Chat · Image · Video) and collapses superseded models behind "Older
models (n)", auto-expanded while searching. **Image and Video render empty in
the iOS app**: generation goes through `/api/generate`, for which there is no
native client, and listing models the app cannot call would violate the rule
that the picker never offers an unusable selection.

**A SwiftUI trap that cost two debugging rounds.** `accessibilityIdentifier`
applied to a container is stamped onto every descendant element, silently
overwriting theirs. The conversation screen's identifier was landing on every
composer control, and the Thinking popover's was landing on its slider, which
made both unaddressable from XCUITest (and identical to each other in an
accessibility audit). Container-level identifiers are now scoped to the exact
view that should carry them; `JunoMobileComposerUITests` would catch a
regression.

## Actually completed

- General repository/backend/OpenAPI/toolchain/prototype audit and official research; do not repeat while these documents remain current.
- Persistent native audit/handoff baseline in `1de5cda`.
- Canonical callback/version alignment and deterministic Swift contract generation in `b903159`.
- Acyclic Swift 6 package `JunoNativeKit` with ten products: Core, API, Auth, Storage, Sync, Search, DesignSystem, ChatKit, CodeKit, and VoiceKit.
- Strict-concurrency API validation, PKCE/token coordination, account-scoped storage abstractions, cursor/outbox logic, local-search contract, and chat/code/voice reducers.
- 156 focused JunoNativeKit tests plus 179 JunoCode tests, all passing with
  warnings treated as errors and complete strict-concurrency checking.
- Security.framework-backed token persistence with device-local accessibility,
  disabled Keychain sync, account/device validation, serialized rotation/removal,
  malformed-data failure, and an injectable Security client.
- System-browser PKCE-S256 auth on macOS/iOS, canonical callback/state/nonce checks,
  existing production auth-route transport, refresh-aware restore, logout, local
  account-switch purge, signed-in gates and EN/FR auth UI.
- Same-origin bearer requests with one bounded 401 refresh/retry and a typed
  checkpoint client for the existing `/api/v1/bootstrap` route; no backend route
  or duplicate service was added.
- Versioned SQLite repository with WAL/FULL durability, structural schema
  verification, AES-GCM account/context binding, optimistic atomic transactions,
  tombstones, protected files, per-account cascades and secure wipe.
- Device-local atomic Keychain database key creation, fail-closed missing-key
  recovery, and purge-before-credential-removal across sign-out, revocation,
  terminal refresh and account switching.
- Fully hydrated bootstrap records and their validated cursor/floor/manifest are
  installed in one transaction; the cursor is never advanced before hydration.
- Both app composition roots now open the production encrypted repository.
- Persisted bootstrap and cursor catch-up use the existing entity inventory,
  `/entities`, `/changes` and real `/changes/stream` SSE routes.
- Atomic pages, tombstones, revisions, compaction rebuild, reconnect
  backoff/jitter, account isolation and an encrypted durable mutation outbox are
  composed into both apps in `364f0f2`.
- Real account conversations/messages are projected from encrypted SQLite in
  `0cb44d8`; both apps now provide native list/detail, loading/empty/error/offline
  states and durable create, rename, model, pin and archive actions.
- Real saved-conversation chat in `6e20050`: both apps compose the existing
  bearer-capable model catalog, idempotent message append and production
  `/api/chat` SSE stream with progressive answer/reasoning/sources, stop, retry,
  bounded reconnect reconciliation and duplicate prevention. OpenAPI 1.1.0
  publishes these existing routes; no chat service or route was added.
- Real projects and files in `35fce4a`: encrypted account-scoped projection,
  durable create/edit/favorite/delete, linked conversations, bearer uploads,
  fresh signed-file hydration, rename/delete/preview, global mobile file list,
  and loading/empty/error/offline states. The only server change extends the
  existing native `project.update` mutation with the already-supported
  `starred` field recorded as GAP-020; no route or project service was added.
- Real library and artifacts in `719db31`: synchronized encrypted attachment
  browsing and file actions, account-scoped offline artifact/version history,
  direct bearer refresh, optimistic edit/restore conflicts, rename/delete,
  detected Office export and native HTML/SVG/Markdown/source previews on both
  apps. Existing `/api/library` and `/api/artifacts` routes were published in
  the native OpenAPI contract; no backend route or service was added.
- Real memory and settings in `778a47d`: synchronized encrypted memory-entry
  and settings projection with strict account isolation, offline reads,
  optimistic `memory.create/update/delete` and `settings.update` mutations on
  the durable outbox, revision-conflict detection with keep-mine/use-server
  resolution, summary hydration through the existing `GET /api/memory`,
  explicit-acknowledgement permanent reset via `DELETE /api/memory`, and full
  settings/memory forms with loading/empty/error/offline/confirmation states
  on both apps. The existing `/api/memory` route was published in OpenAPI
  1.2.0 (mirrored in `CONTRACT_VERSION`); no backend route or service was
  added. Unknown stored preference values remain selectable rather than being
  silently rewritten.
- Real offline global search: query-time projection of the encrypted
  synchronized conversations, messages, projects, files, artifacts and
  memories through the JunoSearch normalization/scoring contract in a
  throwaway in-memory index — nothing searchable is persisted in plaintext.
  Both apps compose a real Search section with debounce, cancellation,
  grouped ranked results, diacritic-insensitive matching and navigation into
  chats, projects, library/files, artifacts and settings.
- Mutation-conflict resolution across conversations and projects, matching the
  memory/settings pattern: `resolveConflicts(keepLocalChanges:)` retries every
  conflicted outbox item against the freshly synced revision or discards it in
  favor of the server version, with keep-mine/use-server banners in both apps.
- Durable offline/reconnect proof: a package test shows a mutation enqueued
  while offline survives an app relaunch (new outbox/drainer over the same
  repository), submits exactly once on reconnect with its original idempotency
  key, and that ambiguous response loss replays the same clientMutationId so
  the server receipt makes it a no-op rather than a duplicate.
- Juno Code macOS integration (PR #17 merged in `677d781`): the `JunoCode`
  Swift package (Core/Local/Runtime/UI/Bridge, 179 strict tests), the
  standalone `JunoCode` app, and a Code section composed into `JunoMac` via
  `JunoMacCodeView` driven by the authenticated `NativeChatRequestSending`
  transport. The merge kept both sides' additive wiring
  (`memorySettingsModel`/`searchModel` and `chatTransport`/`accountID`) and
  regenerated `JunoMac.xcodeproj` from the merged `project.yml`. No
  JunoNativeKit, backend, iOS, prisma, or contract file was changed by PR #17.
- Deterministic checked-in Swift contract plus `npm run native:contract:check` drift command.
- Independent `JunoMac.xcodeproj` and `JunoMobile.xcodeproj`, generated from separate XcodeGen specifications.
- Debug, Stable, and Next configuration layers; canonical callback scheme, EN/FR String Catalogs, privacy manifests, empty skeleton entitlements, and app icon catalogs.
- macOS Debug and Stable unsigned builds; Stable is universal `arm64` + `x86_64`.
- iOS Debug and Stable simulator builds for `arm64` + `x86_64`.
- macOS unit tests 2/2 and iOS unit tests 2/2.
- The three active implementation lots were reviewed and committed together as `0fb7cc3`.

The app shells are compile-verified foundations, not feature-complete production
applications and not downloadable releases.

## Remaining

- Interactive live-account browser completion and connected-device management UI.
- Juno Code Remote Host, Cloud Code, and Remote mobile — all gated on backend Code-session routes that do not yet exist (see `API_GAPS.md` GAP-021).
- Complete generated API/chat/upload/account/Code/Remote/voice/notification contracts and native transport integration.
- Functional macOS and iOS/iPadOS chat, search, settings, Cloud Code, Remote, approvals, and accessibility behavior.
- Native CI, UI/E2E/accessibility/performance suites, Release/archive dry runs, dependency/secret scans, and artifact provenance.
- Production artwork: the current 1024 px icon is mechanically upscaled from the repository's 512 px source and must be replaced before release.
- Apple signing/provisioning/notarization/TestFlight/App Store work and GitHub publication.

## Passing commands

- `npm run native:contract:check`
- `DEVELOPER_DIR=/Applications/Xcode-beta.app/Contents/Developer swift build --package-path native/Packages/JunoNativeKit --configuration release --scratch-path "$(mktemp -d)" -Xswiftc -warnings-as-errors -Xswiftc -strict-concurrency=complete`
- `DEVELOPER_DIR=/Applications/Xcode-beta.app/Contents/Developer swift test --package-path native/Packages/JunoNativeKit --scratch-path "$(mktemp -d)" -Xswiftc -warnings-as-errors -Xswiftc -strict-concurrency=complete` — 156/156 tests.
- `DEVELOPER_DIR=/Applications/Xcode-beta.app/Contents/Developer xcodebuild -project native/macOS/JunoMac/JunoMac.xcodeproj -scheme JunoMac -configuration Debug -destination 'platform=macOS' -derivedDataPath /tmp/juno-mac-foundation-derived CODE_SIGNING_ALLOWED=NO build`
- Same macOS project/scheme with `-configuration Stable` and `/tmp/juno-mac-stable-derived`.
- `DEVELOPER_DIR=/Applications/Xcode-beta.app/Contents/Developer swift test --package-path native/Packages/JunoCode --scratch-path "$(mktemp -d)" -Xswiftc -warnings-as-errors -Xswiftc -strict-concurrency=complete` — 179/179 tests.
- `DEVELOPER_DIR=/Applications/Xcode-beta.app/Contents/Developer xcodebuild -project native/macOS/JunoCode/JunoCode.xcodeproj -scheme JunoCode -configuration Debug -destination 'platform=macOS' -derivedDataPath /tmp/juno-code-standalone-debug CODE_SIGNING_ALLOWED=NO build`
- `DEVELOPER_DIR=/Applications/Xcode-beta.app/Contents/Developer xcodebuild -project native/iOS/JunoMobile/JunoMobile.xcodeproj -scheme JunoMobile -configuration Debug -destination 'generic/platform=iOS Simulator' -derivedDataPath /tmp/juno-mobile-foundation-derived CODE_SIGNING_ALLOWED=NO build`
- Same iOS project/scheme with `-configuration Stable` and `/tmp/juno-mobile-stable-derived`.
- `JunoMacTests` 2/2 and `JunoMobileTests` 2/2 through `xcodebuild test`.
- Earlier Web baseline: `npx tsc --noEmit`, `npm run lint` (warnings only), and `npm test`.

## Failed, unrun, and pre-existing

- Sign-in gate UI tests pass on macOS and iOS; live browser completion was not automated because it requires an authenticated interactive account session.
- Next-channel settings were generated and inspected but the Next configurations were not separately compiled.
- A package build using the default `.build` inside the Desktop/File Provider worktree can fail code signing because Finder metadata/resource forks are attached to products. The isolated `--scratch-path /tmp/...` commands above pass; this is an environment issue.
- Unqualified `xcodebuild` fails because `xcode-select` points to Command Line Tools; keep the explicit `DEVELOPER_DIR`.
- The read-only monolithic prototype's iOS target still fails at `AuthSession.swift:73` because it uses macOS-only `Host.current()` and hardcodes `platform: "macOS"`. Do not fix or ship that prototype.
- Three pre-existing Web React Hook lint warnings remain documented in `TESTING.md`.

## Decisions not to reopen without evidence

- Keep two independent app projects over acyclic local packages.
- Preserve the existing backend as source of truth; native clients never access PostgreSQL directly.
- Use canonical `com.liammagnier.juno://auth/callback`; retain the exact legacy callback server-side only during migration.
- Use bearer device sessions and Keychain; never reuse Web cookies or expose provider/BYOK keys in production clients.
- Treat in-memory storage/search implementations as deterministic test/development adapters only.
- Keep the Mac authoritative for local Remote sessions.
- Use native SwiftUI/AppKit navigation and restrained system Liquid Glass.
- Publish only after signed release gates pass; legacy DMG files are not release evidence.

## Real blockers and user actions

- Run `gh auth login -h github.com` before any push, PR, tag, or GitHub Release.
- Provide/confirm Apple Developer Team, reserved bundle identifiers, certificates/profiles, App Store Connect/TestFlight access, Developer ID identity, and notarization credentials.
- Provide production StoreKit mappings and APNs credentials when those phases start.

## Next exact action

Juno Code Remote Host and Cloud/Remote Code are gated on backend Code-session
routes that do not exist yet (GAP-021): create/resume a Code session, ordered
resumable session events, idempotent commands (prompt/approve/deny/stop), and
Remote Host addressing by opaque workspace ID. The local `JunoCodeCore`
`SessionEventPayload` model was shaped for a 1:1 mapping when those routes land.

Because this exceeds the "minimal extension to an existing route/mutation"
constraint and needs a real backend design (routes, migrations, auth,
streaming) plus owner sign-off, do not invent it unilaterally. Either:

1. escalate GAP-021 to the owner for a backend contract decision, then map the
   existing `JunoCodeBridge` payloads onto the new routes; or
2. proceed to the UI/UX refresh (macOS + iPhone) and accessibility work, which
   is unblocked, and return to Cloud/Remote Code once the routes exist.

Open first:

1. `docs/native/JUNO_CODE_HANDOFF.md` ("Not implemented yet" + "Backend needs")
2. `docs/native/API_GAPS.md` GAP-021
3. `native/Packages/JunoCode/Sources/JunoCodeBridge`
4. `contracts/openapi/juno-native-v1.yaml`

Keep the backend unchanged unless route/contract/old-client inspection proves a
real gap and records it in `API_GAPS.md`.

### macOS composer parity

The Mac composer's two system `Picker` menus are replaced by the same controls
the iPhone uses: a model chip opening a three-region picker (provider rail ·
searchable list · detail) and a Thinking chip opening the discrete slider. The
leaf views — provider mark, capability chips, grade bars, detail panel, chip
flow layout, and the slider itself — now live in `JunoChatKit/JunoModelViews`
and are shared by both apps; only the presentation shell differs (detent sheet
on iPhone, anchored popover on Mac).

**Both Mac popovers are fixed-size by construction.** The Thinking popover
contains a `GeometryReader`, and a self-sizing AppKit popover around measuring
content is what shipped as the 3.0.5 crash; `JunoThinkingPopover` therefore
takes its width as a required parameter, and the Mac call site pins width *and*
height. `JunoMacComposerUITests` opens both popovers and drives the slider, so a
regression to self-sizing would be caught rather than shipped.

`JunoMacUITests` needs `DEVELOPMENT_TEAM=58PVP763WX CODE_SIGN_STYLE=Automatic`
on the xcodebuild invocation; without it the runner and the app get different
Team IDs and the test bundle cannot be loaded (this affected the pre-existing
`JunoMacChatShellUITests` too). This machine also intermittently launches the
app with no window at all — the tests detect that and skip rather than report a
false failure.
