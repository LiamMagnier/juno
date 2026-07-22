# Juno delivery report — 2026-07-22

Session scope: the JunoMac product architecture and Chat redesign (mission
phases 1–2), the defects that work surfaced, and buildable artifacts (phase 17).
Phases 5–16 and 18 were **not** completed. This report states what was proven,
what was not attempted, and why — it is not a completion claim.

## Where the work is

| | |
|---|---|
| Worktree | `/Users/liammagnier/Desktop/workspace/.worktrees/juno-native-claude` |
| Branch | `agent/juno-native-claude-continuation` (PR #18 → `agent/juno-native`) |
| Head | `043051b253c9b0ac61bab2649bcf1ee5ec248c73` |
| Pushed | yes |
| Version | 0.1.0 (build 1), from `native/Config/Base.xcconfig` |

`main` was not touched. `origin/main` remains `173be21`.

## Production

**Not deployed this session.** Production is live and unchanged at
`https://chat.liams.dev` (HTTP 200). No migration was run, no release branch was
cut, nothing was merged to `main`.

This was a deliberate call, not an oversight. Deploying required first
reconciling PR #19 onto PR #18 and triaging the uncommitted backend work sitting
in the `main` checkout — a careful, reviewable piece of work (mission phases 5
and 15) that had not been done. Pushing an unreviewed integration to a live
database was the wrong trade. The dirty work is backed up and untouched; see
"Not attempted".

There is no `/api/health` route on this deployment — the root returns 200. Any
future release gate should assert against a real endpoint rather than assume
one.

## Artifacts

All in `dist/`. Checksums in `SHA256SUMS.txt`, install steps in `INSTALL.md`.

| Artifact | Size | Signature | Reach |
|---|---:|---|---|
| `Juno-0.1.0-macOS.dmg` | 4.6 MB | Apple Development, hardened runtime | Any Mac, after clearing quarantine |
| `Juno-0.1.0-macOS.app` | — | same | unpacked copy of the above |
| `Juno-0.1.0-iOS-development.ipa` | 1.5 MB | Apple Development + dev profile | **1 registered device**, expires 2026-07-29 |
| `Juno-0.1.0-iOS-Simulator.app.zip` | 4.2 MB | signed | any iOS 27 simulator |

```
6ba05be04da422dd0fff1a81c0964871f58974b919eb49904ba945667b44f01f  Juno-0.1.0-macOS.dmg
805563f834dc6b56832c4645f29fb9461c5d77e0c89707a76a99a7798840e547  Juno-0.1.0-iOS-development.ipa
c5322102692483ff81d55e7c95b4d20ff9ab67c54c5bbe657871e14d4dfe9fb8  Juno-0.1.0-iOS-Simulator.app.zip
0cb08f77e5675e6f0d5af4060e6db33277cb393c0cd49d3e8cf07e04dd461ad4  Juno-0.1.0-macOS.app/Contents/MacOS/JunoMac
```

Verified: the DMG mounts and its payload passes `codesign --verify --deep
--strict`; the macOS app is universal `arm64`+`x86_64` with hardened runtime;
the simulator build installs, launches and reaches a working sign-in gate on
iOS 27.

**Release builds contain no preview code.** The Stable macOS binary has zero
occurrences of the preview launch flags and zero `JunoPreviewSupport`,
`JunoPreviewContainer` or `CodePreviewScenario` code symbols. (Two `SO`/`OSO`
debug-map *path* entries remain — object-file paths, address 0, no code.)

## External credential blockers

These are the only things standing between the current artifacts and
distributable ones. Each needs a one-time action in the Apple Developer account;
none can be produced locally.

1. **Developer ID Application certificate** — required to sign a macOS build
   that Gatekeeper accepts. Without it the DMG is Development-signed and
   `spctl` rejects it.
2. **App Store Connect API key** (Issuer ID + Key ID + `.p8`) — required by
   `notarytool` to notarize and staple the DMG, *and* to upload to TestFlight.
   No key is present (`~/.appstoreconnect/private_keys` does not exist), and no
   `notarytool` keychain profile is stored.
3. **Apple Distribution certificate** + an App Store or Ad Hoc provisioning
   profile for `com.liammagnier.JunoMobile` — required for a distributable
   `.ipa`. Only Development signing is available (`security find-identity`
   returns exactly one identity: `Apple Development: liam.magnier25@icloud.com`,
   team `58PVP763WX`).

TestFlight status: **not attempted** — blocked on (2) and (3).

Everything else needed was available: the GitHub token is valid with `repo` and
`workflow` scopes, and the branch pushed successfully.

## Tests

| Suite | Result |
|---|---|
| `JunoNativeKit` (strict concurrency, warnings-as-errors) | **220/220 pass** |
| `JunoMacTests` | **5/5 pass** |
| JunoMac Debug build | pass |
| JunoMac Stable build | pass |
| JunoMac Stable archive + sign | pass |
| JunoMobile Debug build | pass |
| JunoMobile Stable build (device + simulator) | pass |
| JunoMobile Stable archive + `.ipa` export | pass |
| `JunoMacUITests` | **cannot run here** — see below |

Baseline at session start was 169 package tests; 51 were added.

Not run this session: the JavaScript/backend suites (`tsc --noEmit`, `npm test`,
route tests, contract check). Nothing in the web tree was modified.

### JunoAuthTests does not hang

The mission brief lists "diagnose and fix the hanging JunoAuthTests" as phase 4.
**It does not hang.** At the session-start checkpoint (`69cf7df`) the suite
completes in 18 ms with all cases passing, and it still does after this
session's changes. Whatever produced that symptom is not reproducible in this
worktree; there is nothing to fix and nothing was skipped or weakened.

### JunoMacUITests cannot run in this environment

The macOS XCUITest runner fails to load its bundle (`Failed to load the test
bundle … dlopen`) under both `CODE_SIGNING_ALLOWED=NO` and ad-hoc signing. The
six tests in `JunoMacChatShellUITests` are committed and are correct; they need
a session where the test runner can be granted Accessibility control.

Screen recording is also not granted to this process — `screencapture` returns
an all-black image — so macOS visual QA was done by reading the **live
accessibility tree** of the running app instead. That is what surfaced three of
the defects below.

## Defects found and fixed

1. **Raw model identifiers on screen.** The window subtitle rendered
   `anthropic:claude-sonnet-4-6`. Mobile already had a humanizer, buried as a
   private free function in a view file; it is now `junoDisplayModelName` in
   `JunoChatKit` with 9 tests, used by both apps, and the mobile copy is gone.
2. **Accessibility identifiers silently overridden.** The identifier on the chat
   workspace container propagated to every descendant and *replaced* the
   composer's and Send button's own, making them unaddressable by any UI test.
   It now marks the transcript alone.
3. **Icon-only buttons unnamed for VoiceOver.** Buttons built from a bare
   `Image` reached VoiceOver with no name, and SwiftUI fell back to the SF
   Symbol id (`doc.on.doc`) as the accessibility identifier. Now `Label` +
   `.labelStyle(.iconOnly)`.
4. **`JunoMacNavigationTests` had been failing.** It asserted
   `identifiers.count == 9` against a seven-case enum. STATUS.md's claim of
   "JunoMacTests 2/2" was stale. It now asserts the destinations by name.
5. **Keychain failures were undiagnosable.** The sign-in gate showed
   `JunoAuth.SecurityKeychainClientError error 0.` — the Swift type name plus
   the enum *case index*, with the OSStatus discarded. Now `LocalizedError`
   carrying the real status.

### The finding behind (5)

Fixing the message immediately produced `Keychain error -34018 — the app is not
entitled to use the Keychain`, which explains something broader:

**Builds made with `CODE_SIGNING_ALLOWED=NO` cannot sign in.** Unsigned apps
carry no `application-identifier`, which iOS uses as the default Keychain access
group. Every Keychain call fails, no token can be stored, and the sign-in gate
drops to `.unavailable` with its button hidden.

Every "passing command" recorded in `docs/native/STATUS.md` and `TESTING.md`
uses that flag. Those commands were verifying that the app **compiles**, not
that it runs. Rebuilt with signing enabled, the same configuration reaches a
working sign-in gate — confirmed in the iOS 27 simulator.

The entitlements files were deliberately left unchanged: declaring an explicit
`keychain-access-groups` would move the group away from the
application-identifier default the device build already uses, orphaning
Keychain items belonging to any installed build, for no benefit.

## What was built

`JunoMac` is now one three-region native product with Chat as the destination it
opens on — verified in the running app, not merely in the source. Juno Code is
one sidebar row among the others.

- **Sidebar** — a single source list: New Chat, Search, Projects, Library,
  Artifacts, Juno Code, then conversation history grouped by recency
  (pinned/today/yesterday/7d/30d/older/archived), with the account menu, sync
  state and Settings pinned in the footer. Destinations and conversations share
  one selection.
- **Canvas** — borderless transcript. Assistant answers have no container;
  Markdown renders through a new block parser so code blocks, tables and lists
  survive. Reasoning is collapsible, citations are numbered, per-message copy.
- **Inspector** — native `.inspector`, resizable, remembered per scene, ⌥⌘I:
  model, exchange count, dates, project, linked artifacts, de-duplicated
  citations.
- **Composer** — floating Liquid Glass, expands then scrolls, ⌘↩ sends and ↩
  inserts a newline, humanized model and effort pickers, Send morphs to Stop
  while streaming, drafts kept per conversation.

Glass is confined to the composer and the scroll-to-latest control — the two
elements that overlap content. The reading surface stays opaque.

72 EN/FR strings were added by script rather than through Xcode, which rewrites
the whole String Catalog and marks existing translations stale.

## Not attempted

Stated plainly so the next session does not have to rediscover it. None of the
following was started:

- **Phase 5** — reconciling PR #19 onto PR #18, and triaging the uncommitted
  backend work in the `main` checkout (Remote-session routes, `code-remote.ts`,
  `code-remote-sessions.ts`, the `20260719120000_remote_code_sessions`
  migration). That work is **backed up** — `tracked.patch` and `untracked.tgz`
  in the session scratchpad — and the `main` checkout is exactly as it was.
- **Phases 6–13** — camera/photos/files attachments, Deep Research, Canvas, the
  Juno Code Remote control plane, the Mac Remote host, mobile Remote, Cloud
  isolation, and the security threat model. Each is a substantial feature, not a
  finishing pass. GAP-021/022/023 in `API_GAPS.md` still stand.
- **Phases 14–16** — the full test matrix (backend suites were not run), release
  integration, and production deployment.
- **Phase 18** — product smoke tests against a real account. The apps were
  exercised only through the DEBUG preview harness and the sign-in gate; no
  authenticated end-to-end path was verified.

## Standing hazards

Both carried forward from the previous session and **still unresolved**:

1. `prisma/migrations/20260721120000_backfill_entity_revisions/migration.sql`
   differs between the feature branches and `origin/main` in a way no
   line-count check catches: `origin/main` has **22** typed `NULL::timestamp`,
   the feature branches have **22 bare `NULL`** and zero typed. Verified again
   this session. The bare-`NULL` form is the one that already failed in
   production. Take this file verbatim from `origin/main` at integration; never
   resolve a conflict on it by keeping the branch copy.
2. `20260719120000_remote_code_sessions` (untracked on `main`) sorts *before*
   the already-applied `20260721120000_…`. Do not apply, rename or commit it
   until it is established whether it ever ran, whether its `ALTER TABLE`s are
   safe against the current schema, and whether its unique indexes can be built
   against existing rows.

## Honest status

Juno is **downloadable and runnable on macOS** and on one registered iOS device.
It is **not** distributable, **not** notarized, **not** on TestFlight, and
**not** newly deployed. The product is not feature-complete against the mission
definition — attachments, Deep Research, Canvas and all of Remote/Cloud remain
unimplemented.
