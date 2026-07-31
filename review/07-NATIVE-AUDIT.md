# Juno native (Swift) — engineering audit

Scope: `native/` at working-tree state of 2026-07-31 (uncommitted changes present; audit is read-only and static, plus one out-of-tree runtime probe noted in §2.4).
Method: full-tree structural pass (`find`/`wc`/`grep`), then full reads of the highest-blast-radius files (auth, sync, transport, command execution, updater, artifact sandbox). Every claim carries a `file:line`. Anything not verified is marked `UNVERIFIED` with what would settle it.

Counts: **7 High, 26 Medium, 33 Low/nit, 0 Critical**. No finding was withheld for brevity. The full index is §9.

---

## 1. Structure map

### 1.1 Targets and packages

| Unit | Path | Platform | Kind |
|---|---|---|---|
| `JunoNativeKit` | `native/Packages/JunoNativeKit` | macOS 14+ / iOS 17+ | SPM, 11 library products |
| `JunoCode` | `native/Packages/JunoCode` | **macOS 26 only** | SPM, 5 library products |
| `JunoDesktop` | `native/macOS/JunoDesktop` | macOS 26 | app (XcodeGen) |
| `JunoDesktopTests` / `JunoDesktopUITests` | same | macOS 26 | unit / XCUI |
| `JunoMobile` | `native/iOS/JunoMobile` | iOS 18 | app (XcodeGen) |
| `JunoMobileTests` / `JunoMobileUITests` | same | iOS 18 | unit / XCUI |

`JunoNativeKit/Package.swift:1` and `JunoCode/Package.swift:1` both declare `swift-tools-version: 6.0` with `swiftLanguageModes: [.v6]` (`JunoNativeKit/Package.swift:106`, `JunoCode/Package.swift:66`). `native/Config/Base.xcconfig:2-3` sets `SWIFT_VERSION = 6.0` and `SWIFT_STRICT_CONCURRENCY = complete` for both apps. So the entire native surface is Swift 6 language mode with complete concurrency checking — not a partial migration.

### 1.2 Dependency graph

```
JunoCore ──┬─ JunoAPI ─ JunoAuth ─┐
           │                      ├─ JunoSync ─┐
JunoStorage ──────────────────────┘            │
                                               ├─ JunoChatKit ─┐
JunoSearch (JunoCore, JunoStorage) ────────────┤               │
JunoDesignSystem (JunoCore) ───────────────────┼─ JunoCodeKit ─┤
                                               └─ JunoVoiceKit ┤
                                                               └─ JunoPreviewSupport (DEBUG-only)

JunoCodeCore ──┬─ JunoCodeLocal ─┐
               ├─ JunoCodeRuntime┼─ JunoCodeUI  (+ JunoDesignSystem)
               └─────────────────┴─ JunoCodeBridge (+ JunoCodeKit/Core/API/Auth/Sync/ChatKit)
```

Source: `JunoNativeKit/Package.swift:26-59`, `JunoCode/Package.swift:20-47`.

The layering is clean and acyclic. `JunoCodeCore` has zero dependencies (`JunoCode/Package.swift:23`) — the classifier, permission model and path types are testable in isolation, which is the right place for the security-relevant code to sit.

**Shared vs platform-specific.** `JunoNativeKit` is shared by both apps (`macOS/JunoDesktop/project.yml:33-53`, `iOS/JunoMobile/project.yml:29-51`). `JunoCode` is macOS-only (`JunoCode/Package.swift:10-12`, and only `macOS/JunoDesktop/project.yml:54-57` links it). The iOS app has 40 files under `iOS/JunoMobile/App`; the Mac app has 28 under `macOS/JunoDesktop/App` — both hand-written per platform with no shared view layer beyond `JunoDesignSystem`. 427 Swift files, 122,894 lines total (22,216 of that is tests).

The macOS target also reaches into the iOS tree for one thing: `macOS/JunoDesktop/project.yml:31-32` adds `../../iOS/JunoMobile/Resources/Fonts` as a resource path. It does **not** pick up `Localizable.xcstrings` from the same folder — see §7.

### 1.3 Build configuration

`native/Config/` holds a three-level xcconfig chain: `Base.xcconfig` → {`Debug`,`Stable`,`Next`}`.xcconfig` → `Juno{Desktop,Mobile}-{Debug,Stable,Next}.xcconfig`.

- Deployment targets: macOS **26.0** (`Config/JunoDesktop-Stable.xcconfig:5`), iOS **18.0** (`Config/JunoMobile-Stable.xcconfig:5`). Note the SPM manifests declare lower floors (`.macOS(.v14)`, `.iOS(.v17)` at `JunoNativeKit/Package.swift:6-8`) — the packages are compiled at the app's floor when linked, so the manifest floors only matter for `swift test` in CI.
- **Xcode beta requirement:** `.github/workflows/native.yml:41` pins `REQUIRED_XCODE_MAJOR: "26"` and the macOS job hard-fails below it (`native.yml:120-124`). CI runs on `macos-26` for all three Mac/iOS jobs, with the reason documented at `native.yml:68-73` (SDK/OS mismatch broke `.tag()` lowering).
- Hardened Runtime: **off** for Debug (`Config/JunoDesktop-Debug.xcconfig:14`, XCUI injection), **on** for Stable and Next (`Config/JunoDesktop-Stable.xcconfig:15`, `-Next.xcconfig:15`).
- Signing identity lives in `Config/Base.xcconfig:16-17` (`DEVELOPMENT_TEAM = 58PVP763WX`, automatic) rather than the Xcode UI, because XcodeGen regenerates the pbxproj.
- Build identity: `JUNO_GIT_SHA`/`JUNO_CONTRACT_VERSION` come from `Config/Generated-Build.xcconfig` via an optional include (`Config/Base.xcconfig:26`), written by `native/Scripts/write-build-metadata.sh` and gitignored (`.gitignore:58`).

### 1.4 CI

`.github/workflows/native.yml` gates: OpenAPI→Swift contract drift (`:49-60`), `swift test` for both packages with `-Xswiftc -warnings-as-errors` (`:93-98`), macOS app Debug + Stable builds and `JunoDesktopTests` (`:140-174`), iOS app Debug simulator build (`:207-232`). See §5.4 for what it does not run.

---

## 2. Security

### 2.1 Backend, auth and tokens

**Backend URL.** One constant: `JunoCore/JunoBackend.swift:14` — `"https://chat.liams.dev"`. Both composition roots derive from it (`macOS/JunoDesktop/App/JunoDesktopConfiguration.swift:57`, `iOS/JunoMobile/App/JunoMobileApp.swift:144`). `scripts/release-gates.sh:101-113` greps app sources for localhost/temporary hosts and asserts the constant. **No dev/prod config leakage found; no secrets, API keys or tokens in any Swift source** (grep for `sk-`, `api_key =`, `Bearer <literal>` returns only `SecretRedactor.swift:41` patterns and test fixtures).

**Transport.** `JunoAPI/HTTPTransport.swift:184-191` and `:98-105` build `URLSessionConfiguration.ephemeral` with `httpCookieStorage = nil`, `httpShouldSetCookies = false`, `urlCredentialStorage = nil`, no-cache policy. Redirects are refused outright (`HTTPTransport.swift:261-273`). Response bodies are byte-capped (`:228-235`) and the streaming transport caps at 20 MB (`:90`, `:141-145`) with the relay cancelled on stream termination (`:154`). This is materially better than the default.

**Auth flow.** PKCE S256 with `state` + `nonce` (`JunoAuth/NativeBrowserAuthorization.swift:85-98`), redirect URI pinned and structurally validated at planner construction (`:65-73`), callback validated on scheme/host/path/port/user/password/fragment plus single-occurrence query items and a base64url charset check on the code (`:114-140`). Both apps use `ASWebAuthenticationSession` (`macOS/.../JunoDesktopWebAuthenticationClient.swift:42`, `iOS/.../JunoMobileWebAuthenticationClient.swift:41`) with a one-shot resume latch for the documented double-resume crash (`JunoAuth/WebAuthenticationResumeLatch.swift:14-27`). Refresh is coalesced per account with a generation counter that fails closed across revocation races (`JunoAuth/AuthTokenCoordinator.swift:120-208`). **This is the strongest part of the codebase.**

There is no `onOpenURL`/`application(_:open:)` handler anywhere in `native/` — the URL scheme in `Info.plist:29-41` exists only so `ASWebAuthenticationSession` can claim the callback. That is the correct design (no unvalidated deep-link entry point), but see finding L-14.

---

#### **H-1 — macOS Keychain items are written to the legacy keychain, so `kSecAttrAccessible` is silently ignored**
`native/Packages/JunoNativeKit/Sources/JunoAuth/KeychainAuthTokenStore.swift:159-169` (and `:102-106`)

`newItemAttributes` sets `kSecAttrAccessible = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly` and `kSecAttrSynchronizable = false`, but never sets `kSecUseDataProtectionKeychain: true`. On macOS, `SecItemAdd`/`SecItemCopyMatching` default to the **legacy file-based keychain** unless that key is present; the legacy keychain has no data-protection classes, so `kSecAttrAccessible` has no effect there. The refresh token, access token and account ID (`KeychainAuthTokenStore.swift:407-427`) therefore land in `login.keychain-db` with default ACLs rather than under `AfterFirstUnlockThisDeviceOnly`.

Why it matters: the stated protection class is what the design leans on (the type doc at `:205-209` calls it "device-local"), and a legacy-keychain item is readable whenever the login keychain is unlocked, with different (weaker, ACL-based) access control than the code claims. It also makes the macOS and iOS behaviour silently different from the same source.

Fix: add `kSecUseDataProtectionKeychain as String: true` to `baseQuery` (`:146-157`) and `newItemAttributes` (`:159-169`). This is a storage-location change — ship a one-time migration that reads from the legacy keychain, writes to the data-protection keychain, and deletes the old item, or accept a forced re-sign-in on first launch after the change. `KeychainSessionCacheStore.swift` and `KeychainInstallationIDStore` (`NativeBrowserAuthorization.swift:171-217`) share `SystemSecurityKeychainClient` and need the same fix.

---

#### **H-2 — The auto-updater re-verifies nothing between staging and the swap, and the swap script is itself user-writable**
`native/macOS/JunoDesktop/App/DesktopUpdater.swift:311-360`

`extractAndVerifyApp` verifies the downloaded bundle properly — code requirement with `anchor apple generic` + identifier + team OU (`:462-466`), all architectures and nested code (`:496`), Gatekeeper assessment (`:262`), version ordering (`:263-269`). The verified bundle is then left at `~/Library/Application Support/<bundleid>/Updates/<Juno>.app` (`:253`, `:279-288`).

At quit, `launchInstaller` writes `install.sh` into that same directory (`:338-339`) and runs `/bin/sh <script> <target> <staged> <backup>` (`:340-346`). The script `ditto`s `$2` (the staged bundle) over `$1` (the installed app) and then strips `com.apple.quarantine` recursively (`:322-327`). **Nothing re-checks the signature between staging and the copy**, and both the staged bundle and `install.sh` sit in a directory writable by any process running as the user — including, on this machine, the coding agent's own child processes and anything they `npm install`.

Why it matters: it converts "arbitrary code as the user" into "arbitrary code as *Juno*" — inheriting the app's TCC grants (microphone, Apple Events, Documents/Desktop/Downloads per `Resources/Info.plist:50-71`), its position in `/Applications`, and its launch-on-open familiarity — and the quarantine strip removes the one prompt that would have surfaced it. The window is the whole interval between "update staged" and "app quits", which the design deliberately makes long (`:19-21`).

Fix: (a) re-run `CodeSignature.verify(staged, matches: bundleURL)` synchronously in `launchInstaller` immediately before `process.run()`, and abort on failure; (b) do not write and execute a script from a user-writable directory — embed the swap logic as `/bin/sh -c <literal>` with the paths as `$1..$4` positional arguments, which removes the script file entirely; (c) stage into a directory created with `withIntermediateDirectories` **and** POSIX mode `0700` (`stagingDirectory()` at `:279-288` currently uses default permissions).

---

#### **H-3 — `full access` mode runs interpreter one-liners with no approval, so the documented "no mode steps outside the workspace silently" invariant does not hold**
`native/Packages/JunoCode/Sources/JunoCodeCore/PermissionModel.swift:112-113` with `native/Packages/JunoCode/Sources/JunoCodeCore/CommandClassifier.swift:187-193`

`PermissionModel.swift:29-34` defines `critical` as "reaches the network or runs arbitrary code, **but lands inside the granted folder**", and `:96-100` states the top rule: `destructive` always asks, "so no setting anywhere in the app can grant silent permission to step outside the granted workspace". `PermissionPolicy.ruling` then maps `(.fullAccess, .critical) → .allow` (`:112-113`).

`CommandClassifier.swift:187-193` classifies every entry in `interpreterPrograms` (`:535-542`: `sh bash zsh python python3 node npx deno bun ruby perl php java uv` …) as `.critical`. The classification is a *label*, not a boundary — `python3 -c 'import os,shutil; shutil.rmtree(os.path.expanduser("~/Documents"))'` is a single quoted word to the tokenizer, so `escapingPathReason` (`:468-499`) sees no `/`, no `..`, no `~` prefix and no `$HOME`, and the verdict is `.critical` → **allowed without a prompt in full access**. The same holds for `node -e`, `perl -e`, `ruby -e`, `bash -c`.

Why it matters: the entitlements file justifies removing the App Sandbox on the grounds that "Every command the agent runs is classified and approval-gated in `JunoCodeCore/CommandClassifier.swift`" (`macOS/JunoDesktop/Resources/JunoDesktop.entitlements:31-33`). With Hardened Runtime on and no sandbox, an unapproved interpreter one-liner has the app's full file access. A prompt-injected model reading a hostile repo is the realistic trigger.

Fix: three options, in preference order. (1) Classify interpreters that carry an inline-program flag (`-c`, `-e`, `-E`, `--eval`, `--exec`, `-`) as `.destructive`, leaving `python3 script.py` at `.critical`. (2) Give `.fullAccess` a distinct rung so interpreters stay approval-gated there. (3) If neither, correct `PermissionModel.swift:29-34` and the entitlements rationale to say what is actually true. Option 1 is a ~10-line change in `classifySegment` and preserves the ergonomics the mode was created for (`npm install`, `git push`, `./scripts/test.sh` all stay `.critical`).

---

#### **H-4 — Shell brace expansion and globs walk past the `rm` forbidden tier and past the escaping-path check**
`native/Packages/JunoCode/Sources/JunoCodeCore/CommandClassifier.swift:253-276` and `:468-499`

`classifyRemove` rejects targets equal to `/`, `~`, `$HOME`, `.`, `..`, anything with an absolute or `~` prefix, and anything starting `../`. `escapingPathReason` splits candidates on `/` and looks for an exact `..` component. Neither expands braces or globs, but the command is handed to `/bin/zsh -c` (`JunoCodeLocal/CommandExecutionService.swift:31-32`), which does.

Concretely, `rm -rf ./{..,.}/*`: `classifyRemove` sees the single target `./{..,.}/*` — not `/`, not `~`, not `..`, no `../` prefix — and returns `.permitted(risk: .critical, reason: "File deletion.")` (`:275`). `escapingPathReason` splits it into `[".", "{..,.}", "*"]`, finds no exact `..`, and returns nil. zsh expands it to `./../*` and `././*`. In `full access` the command runs unprompted (H-3); in every other mode the user is asked to approve something whose stated reason is "File deletion" with no indication that it leaves the workspace.

Same class of gap: `rm -rf $X` after `X=/` in a *separate* segment is caught (the assignment segment trips `escapingPathReason` via the `=` candidate at `:478-480`), but `rm -rf "$(printf /)"` is caught only by the substitution rule at `:37-47`, which downgrades to `.critical` rather than `.destructive`.

Fix: before classifying, reject or `.destructive`-classify any word containing an unquoted `{`…`,`…`}` or a `*`/`?`/`[` that is not the entire final component; and in `escapingPathReason`, treat any component that *contains* `..` between separators, or any brace group, as escaping. A cheaper belt: run `rm`/`mv`/`cp` targets through `WorkspaceAccess.resolveForMutation` semantics rather than string rules — the container check at `WorkspaceAccess.swift:199-203` is the real boundary and it is already correct.

---

#### **M-1 — `DevServerService` consults only the *forbidden* tier, bypassing `PermissionPolicy` entirely**
`native/Packages/JunoCode/Sources/JunoCodeLocal/DevServerService.swift:132-141`

The dev-server path classifies the command and refuses only `.forbidden`; a `.destructive` or `.critical` verdict starts the process anyway. It also classifies the *wrapper* (`npm run dev`, from `DevServerCommandDiscovery`), not the script body — so the body is never seen by the classifier at all.

Mitigating: the user presses Start explicitly (`JunoCodeUI/Views/Preview/CodePreviewWindow.swift:463`, `:579`), and the script body is displayed (`DevServerCommandDiscovery.swift:11-13`). But the invariant "destructive always asks" (`PermissionModel.swift:96-100`) is stated as absolute and is not honoured here.

Fix: route through `PermissionPolicy.ruling(mode:risk:)` like the tool path does, and classify `command.script` in addition to `command.commandLine`.

---

#### **M-2 — Artifact CSP can be neutralised by an `<html` token inside a comment**
`native/Packages/JunoNativeKit/Sources/JunoChatKit/NativeArtifactPreview.swift:193-197` and `:230-250`

`htmlDocument` decides "this is a full document" with a regex for `<html[\s>]` and then `injecting` inserts the security head after the first `<head…>` or, failing that, after the first `<html…>`. Both regexes match inside HTML comments and inside text content. An artifact whose body begins `<!-- <html> -->` gets `<head>…CSP…</head>` inserted *inside the comment* — the CSP never applies — while `allowsContentJavaScript` is `true` for `.document` policy (`:69`, `:325`).

What still holds: the compiled `WKContentRuleList` blocks every scheme with `://` (`:93-100`, `:337-345`), `websiteDataStore = .nonPersistent()` (`:324`), and http/https navigations are cancelled (`:277-287`). So exfiltration over the network is still blocked. What is lost is the CSP layer the comment at `:90-92` calls "the first boundary" — including `object-src`, `frame-src`, `worker-src` and `form-action`.

Fix: stop deciding on regex. Always wrap: emit `<!doctype html><html><head>SECURITY</head><body>` + content, and let WebKit's parser reconcile a nested `<html>` (it will hoist the artifact's head content into the existing head, and the earlier meta CSP wins because policies only intersect). If the wrapping must stay conditional, strip comments before matching.

---

#### **M-3 — `Shell.capture` never drains stderr and has no timeout, so the updater can hang forever**
`native/macOS/JunoDesktop/App/DesktopUpdater.swift:596-619`

`standardError = Pipe()` (`:604`) is created and never read. `standardOutput` is read only in `terminationHandler` via `readToEnd()` (`:606`) — i.e. *after* the process exits. Any child that writes more than the pipe buffer (64 KB) to either stream blocks on write, never exits, `terminationHandler` never fires, and the `withCheckedThrowingContinuation` at `:598` never resumes. There is no timeout anywhere in this helper. `spctl --assess` writes its verdict to stderr; `hdiutil attach -plist` writes an unbounded plist to stdout.

In practice the volumes are small, so this is a latent hang rather than an observed one — but the failure mode is a permanently suspended `await` on the main actor's update path (`:206`, `:243`), with no user-visible error.

Fix: drain both pipes concurrently with `readabilityHandler` (or `FileHandle.readToEnd` on a background queue started *before* `waitUntilExit`), and wrap the call in a `Task` with a deadline that terminates the process.

---

#### **M-4 — `Task.detached` fire-and-forget in a `defer` leaves the DMG mounted on any failure path**
`native/macOS/JunoDesktop/App/DesktopUpdater.swift:244`

`defer { Task.detached { await DiskImage.detach(mountPoint) } }`. The detach is unstructured, untracked, un-awaited and `try?`-swallowed (`:579`). If it fails, or if the process exits before it runs, the read-only DMG stays mounted under `/tmp` with no user-visible trace and no retry. Repeated failed updates accumulate mounts.

Fix: `await DiskImage.detach(mountPoint)` at each exit point (the function is already `async`), or keep the `defer` but make it a structured `await` via a `do { … } catch { }` wrapper rather than a detached task.

---

#### **M-5 — `kill(-pid, …)` after an `isRunning` check is a pid-reuse race**
`native/Packages/JunoCode/Sources/JunoCodeLocal/CommandExecutionService.swift:169-180`

`terminateProcessGroup` checks `process.isRunning`, then signals `-pid`; the delayed `SIGKILL` at `:175-179` re-checks and signals again two seconds later. Between check and signal the child can exit and the pid can be recycled by another process on the machine, in which case `SIGTERM`/`SIGKILL` goes to an unrelated process group.

I **verified empirically** (out-of-tree Swift probe, not in the repo) that Foundation's `Process` on this macOS does place the child in its own process group — child pid 73734 reported pgid 73734 while the parent's pgid was 73723 — so the negative-pid signalling itself is correct and the comment at `:171-173` is accurate. Only the TOCTOU remains.

Fix: capture the pid once and guard the delayed kill on the same `Process` object still reporting `isRunning` **and** a `terminationHandler`-set flag, or hold a `DispatchSourceProcess` so the kill is cancelled when the child exits.

---

#### **M-6 — `unauthorizedFlights` entries are never cleared on success**
`native/Packages/JunoNativeKit/Sources/JunoAuth/AuthTokenCoordinator.swift:110-118`

The failure path removes the flight (`:113-115`); the success path does not. The completed `Task<AccessToken, any Error>` and its `rejectedAccessToken` stay in the dictionary until `install` (`:49`) or `revokeLocally` (`:212`). Functionally harmless — a later 401 carries a different rejected token so a new flight is made (`:93-95`) — but it is an unbounded-per-account retention of a finished task and it makes the actor's state harder to reason about.

Fix: remove the entry in both branches of the `do`/`catch`.

---

#### **M-7 — `refreshWaiterCount` is incremented but never decremented**
`native/Packages/JunoNativeKit/Sources/JunoAuth/AuthTokenCoordinator.swift:127` and `:228-230`

`waiterCount += 1` on every joiner; nothing ever decrements. The value is only read by the internal test hook at `:228`, so no production behaviour depends on it — but a test asserting "two waiters, then one left" would pass incorrectly. Either decrement on exit from `refresh`, or delete the field and the hook.

---

#### **M-8 — Persistence failures in the agent loop are systematically swallowed**
`native/Packages/JunoCode/Sources/JunoCodeRuntime/AgentOrchestrator.swift:399, 420, 441, 462, 534, 756`

`try? await store.saveConversation(sessionID:messages:)` appears six times. `try? await store.setStatus(…)` at `:175` and `:755` likewise. A full disk, a corrupt store or a permissions change loses the model conversation with no error, no event and no UI signal — and the next `resume` replays whatever stale conversation *did* persist, so the agent silently continues from a divergent history.

The 25 other `try?`s in the same file are `store.appendEvent` calls for transcript rows, where best-effort is defensible. The six `saveConversation` calls are not: that is the resumable state.

Fix: let `saveConversation` failures propagate (or set a `persistenceDegraded` flag on the session that the UI surfaces once), and stop the run rather than continuing on a history that was not written.

---

#### **M-9 — `CursorPageApplier` accepts any UTF-8 stored cursor while `NativeSyncCoordinator` requires a canonical integer**
`native/Packages/JunoNativeKit/Sources/JunoSync/CursorPageApplier.swift:190-196` vs `native/Packages/JunoNativeKit/Sources/JunoSync/NativeSyncCoordinator.swift:314-320`

The coordinator's `decodeCursor` throws `corruptStoredCursor` unless the value is `"0"` or a leading-zero-free decimal string. The applier's `decodeCursor` only checks UTF-8 validity. Both read the same `sync.changeCursor` metadata key (`CursorPageApplier.swift:90`). A corrupted-but-valid-UTF-8 cursor therefore fails one path and silently passes the other, where it is compared for equality against `page.previousCursor` and can produce a spurious `cursorGap` (`:123-128`) instead of the honest `corruptStoredCursor`.

Fix: hoist the validation into one place — a `SyncCursor` value type with a validating initialiser — and use it on both sides.

---

#### Verified-correct (recorded so these are not re-flagged)

These looked like bugs on a first pass and are not:

- `NativeSyncCoordinator.swift:225` pairs `zip(batch, hydrated)` positionally to check revisions. That is sound because `NativeSyncAPIClient.entities` throws `missingEntity` for any absent id (`NativeSyncAPIClient.swift:233-235`) and re-orders the result to the request order (`:236-237`).
- `NativeSyncCoordinator.swift:246` — `newest[key]?.revision ?? 0 < change.revision` parses as `(… ?? 0) < …` because `NilCoalescingPrecedence` binds tighter than `ComparisonPrecedence`. Correct.
- `synchronize`'s `while true` (`:140-183`) cannot spin: `changes()` enforces `!hasMore || !changes.isEmpty` (`NativeSyncAPIClient.swift:264`) and strict cursor ordering (`:272-273`), so a page with `hasMore` always advances the cursor.
- Every index arithmetic hit found by grep is bounds-guarded: `JunoMarkdown.swift:160-161`, `PreviewShell.swift:80-82`, `DiffEngine.swift:329-330`, `CodePreviewFixtures.swift:41-45`, `CommandClassifier.swift:660/672/682/696`, `GlobPattern.swift:42`, `DiffLineViews.swift:220-221`.

---

### 2.2 Entitlements and sandbox

`macOS/JunoDesktop/Resources/JunoDesktop.entitlements` declares exactly two keys: `com.apple.security.device.audio-input` (`:38`) and `com.apple.security.automation.apple-events` (`:47`). The App Sandbox is **deliberately absent**, with a 30-line rationale at `:3-33` covering child-process inheritance, sibling worktrees, ScreenCaptureKit and the Developer-ID-DMG distribution channel. That reasoning is sound and the trade-off is stated honestly — with the one exception noted in H-3, where the claimed compensating control does not fully hold.

`iOS/JunoMobile/Resources/JunoMobile.entitlements:4` is an empty dict. Correct: the app needs no capability entitlement, and no keychain access group is used (`KeychainAuthTokenStore.init` takes `accessGroup: String? = nil` at `:220-227` and both apps pass nothing).

**No ATS exception anywhere.** Grep for `NSAppTransportSecurity` / `NSAllowsArbitraryLoads` across the entire repo returns nothing. Both `Info.plist` files declare `ITSAppUsesNonExemptEncryption = false` (`macOS/.../Info.plist:72`, `iOS/.../Info.plist:52`) and every usage-description string is present and specific.

### 2.3 WebViews, pasteboard, logging

- Two `WKWebView` sites: `NativeArtifactPreview.swift` (audited above) and `JunoCodeUI/Views/Preview/CodePreviewWindow.swift:936-939` (the dev-server preview, which points at `http://localhost:<port>` by design — `DevServerURLDetector.swift:33`). iOS uses `SFSafariViewController` for web flows with a documented rationale (`iOS/JunoMobile/App/JunoMobileWebFlow.swift:13-17`).
- Pasteboard: 19 sites, all `clearContents()` + `setString(_:forType: .string)` writes of user-visible content; one read, `JunoCodeUI/Views/Composer.swift:776-777`, restricted to `.png`/`.tiff` image types. No credential or token ever reaches the pasteboard.
- **Zero `print`, `NSLog`, `os_log` or `Logger` calls in any production Swift file.** There is therefore no PII or token logging surface at all. Command output that *does* reach transcripts is passed through `SecretRedactor` first (`CommandExecutionService.swift:166`, `DevServerService.swift:152`), with nine patterns covering Authorization headers, `*TOKEN/SECRET/PASSWORD/API_KEY*` assignments, GitHub/Slack/Stripe/AWS/OpenAI prefixes, PEM blocks and URL userinfo (`JunoCodeCore/SecretRedactor.swift:26-49`).
- Child processes get a freshly constructed environment, never the parent's (`CommandExecutionService.swift:135-152`), so no app token can leak into a spawned command.

### 2.4 Local record encryption

`JunoStorage/AccountDataCipher.swift:37-66` is AES-GCM with the account ID, record key, revision and timestamp as additional authenticated data (`:36-38` context struct) — so a ciphertext cannot be replayed under a different record or revision. Key length is enforced at `:41-43`. The doc at `:34-36` correctly requires the key to live outside the database.

---

## 3. Code quality and correctness

### 3.1 Concurrency

Swift 6 language mode with `SWIFT_STRICT_CONCURRENCY = complete` (`Config/Base.xcconfig:3`) and `-warnings-as-errors` in CI (`native.yml:98`, `:148`, `:230`). The compiler is doing most of this audit's work already.

**`nonisolated(unsafe)`: 15 occurrences, all in test files** (`JunoCodeLocalTests`, `JunoCodeBridgeTests`, `JunoCodeRuntimeTests`), used to capture mutable locals across `await` in assertions. Zero in production code.

**`@unchecked Sendable`: 9 in production code**, each with a stated reason and a real lock or immutability argument:

| Site | Basis | Assessment |
|---|---|---|
| `JunoAPI/HTTPTransport.swift:81, 165, 262` | `URLSession` + a stateless delegate | Sound |
| `JunoStorage/SQLiteDatabase.swift:4` | serialised handle | Sound (not re-read in depth — `UNVERIFIED` beyond the declaration) |
| `JunoCodeLocal/CommandExecutionService.swift:185` | `NSLock` around every field (`:200-242`) | Sound |
| `JunoCodeLocal/DevServerService.swift:76, 362` | `NSLock` (`:154-156`) | Sound |
| `JunoCodeLocal/WorkspaceAccess.swift:10` | immutable after init except `bookmarkNeedsRefresh` (`:28`) | **Nit L-1**: `bookmarkNeedsRefresh` is a mutable `var` set at `:86`, after `self.init`, and read from arbitrary contexts. Racy in principle; set-once in practice. Make it `let` by folding it into the designated initialiser. |
| `JunoCodeCore/SecretRedactor.swift:16`, `GitignoreMatcher.swift:8` | `NSRegularExpression` is thread-safe | Sound |
| `JunoVoiceKit/JunoSpeechService.swift:362`, `JunoRealtimeVoiceController.swift:90, 220` | AVAudioEngine tap boxes; rationale at `JunoRealtimeVoiceController.swift:209-219` | Sound |
| `iOS/.../JunoMobileCameraService.swift:87, 271` | rationale at `:78-86` | Sound |

**Task lifecycle.** Every long-lived `Task` in an `@Observable` model is stored in a property and cancelled: `NativeConversationStore.swift:524/623/1085`, `NativeCodeModel.swift:95-96/193-194/420`, `JunoRealtimeVoiceController.swift:319-344/515-537`, `JunoSpeechService.swift:101-102/281-321`, `NativeComposerAttachmentModel.swift:83/98/205/214/228`, `NativeConnectorStore.swift:324-325/343-344/432/447`, `NativeSearchStore.swift:251/274/292`, `CodeRemoteHost.swift:47/86`, `NativeAvatarModel.swift:33/52/63`, `NativePrivateChatModel.swift:69/89/129`, `NativeImageEditSession.swift:33/58`. Both `AsyncThrowingStream` relays set `continuation.onTermination { relay.cancel() }` (`NativeChatAPIClient.swift:912`, `NativeCodeTaskStore.swift:473`, `HTTPTransport.swift:154`). Actor observers are token-based and removed (`AgentOrchestrator.swift:113-116`, `WorkbenchModel.swift:244/467`, `SessionController.swift:724/747`).

**`Task.detached`: 5 occurrences.** Four are correct off-main compute hops that are immediately awaited (`DesktopArtifactsScreen.swift:225`, `JunoMobileWorkspaceViews.swift:971`, `JunoMobileCameraService.swift:407`, `JunoMobileAttachmentThumbnail.swift:19`). The fifth is M-4.

**NotificationCenter: one observer**, added at `CodePreviewWindow.swift:112` and removed at `:203`. Balanced.

I found **no actor-isolation violation, no data race and no missing `[weak self]` that produces a cycle** in the files read. The `[weak self]` discipline is consistent (`DesktopUpdater.swift:98/146/186`, `WorkbenchModel.swift:244`, `SessionController.swift:724`, `NativeArtifactPreview.swift:398`).

**L-2** — `DesktopUpdater.swift:98-103`: the poller loop is `while !Task.isCancelled { await self?.check(); try? await Task.sleep(...) }`. If `self` were deallocated the loop would spin forever on the sleep. It cannot happen (`static let shared` at `:49`), but the guard belongs in the loop: `guard let self else { return }`.

### 3.2 Crash surface

- **`try!`: zero** in production or test code.
- **`fatalError`: zero** anywhere in `native/`.
- **`as!`: one**, `iOS/JunoMobile/App/JunoMobileCameraPreview.swift:38` — `layer as! AVCaptureVideoPreviewLayer`, guaranteed by an overridden `layerClass`. Idiomatic and safe.
- **`preconditionFailure`: 6.** Three are DEBUG-only preview fixtures (`CodePreviewFixtures.swift:121, 243, 318`). Three are in `JunoStorage/SQLiteAccountRepository.swift:274, 326, 474` on an unexpected `sqlite3_step` result — **L-3**: these are reachable on a corrupted local database, i.e. on disk state rather than developer error, and they crash the app rather than surfacing "your local cache is damaged, sign in again". Convert to a thrown `AccountStorageError` and let the store rebuild from a bootstrap.
- **Force unwraps on data that could come from the network or a model: essentially none.** The full list of `!` in production code is 15 sites, all provably safe or build-time constants:
  - `JunoCore/JunoBackend.swift:19` — constant literal, covered by `JunoBackendTests`.
  - `macOS/.../DesktopCommands.swift:116, 120` — interpolation of that same constant. **L-4**, cosmetic.
  - `JunoDesignSystem/JunoAIcssSearch.swift:192-194` — three literal URLs in a gallery fixture. **L-5**.
  - `JunoSync/NativeSyncCoordinator.swift:218` — `grouped[type]!` immediately after iterating `grouped.keys`. Safe.
  - `JunoSync/NativeSyncCoordinator.swift:142, 168, 170` — `cursor!` inside `while true`, non-nil since `:132-135`. Safe but brittle; **L-6**: rebind to a non-optional local at the top of the loop.
  - `JunoCodeCore/JSONValue.swift:133` — `fields[key]!` while iterating `fields`' own keys. Safe.
  - `JunoCodeRuntime/Tools/UpdateGoalTool.swift:155-189` — eight force unwraps of **model-generated tool input**. They are guarded: `execute` runs `precheck(input:)` first and rethrows (`:142-144`), and `precheck` (`:85-139`) validates exactly the fields each branch then unwraps. **L-7** all the same: the safety is a non-local invariant between two functions 60 lines apart, in the one file where the input is adversarial. Restructure `precheck` to return a validated `Action` payload enum so `execute` destructures instead of unwrapping.

### 3.3 Error handling

**Empty `catch {}` blocks: one** — `macOS/.../DesktopUpdater.swift:617-618`, `do { try process.run() } catch { continuation.resume(throwing: error) }`, which is not empty (the brace-only line the grep caught is the closure's). No genuinely empty catch exists.

**`try?`: 361 in production code.** The distribution matters more than the count:

| File | Count | Verdict |
|---|---|---|
| `AgentOrchestrator.swift` | 32 | 26 are best-effort transcript appends (fine); 6 are M-8 |
| `SessionController.swift` | 19 | UI-refresh reads with `?? []` fallbacks (`:1609`, `:1613`, `:1652`) — fine |
| `NativeCodeTaskStore.swift` | 15 | not read in depth — `UNVERIFIED` |
| `CodeSessionStore.swift` | 12 | not read in depth — `UNVERIFIED` |
| everything else | ≤11 each | spot-checked; decoding/optional-conversion idiom |

**Errors that do reach the user are well-shaped.** Nearly every error enum implements `LocalizedError` with a sentence rather than a code: `SecurityKeychainClientError.errorDescription` even decodes the `OSStatus` into plain language (`KeychainAuthTokenStore.swift:26-56`), `MutationOutboxError` (`MutationOutbox.swift:160-183`), `CursorPageError` (`CursorPageApplier.swift:61-82`), `NativeSyncAPIError` (`NativeSyncAPIClient.swift:121-132`), `UpdateError.message` (`DesktopUpdater.swift:377-398`). This is unusually good. The catch is §7: none of it is localizable.

### 3.4 God files

Nine files exceed 1,500 lines. All nine are view/controller layers; no model, store or protocol file is oversized.

| Lines | File | What it is |
|---|---|---|
| 2845 | `macOS/JunoDesktop/App/DesktopChatWorkspace.swift` | 20 types: sidebar, destinations, sync indicator, conversation view, transcript, message row, inline artifact card/view, speech playback, sources, research activity, error, composer, voice glyph, library picker, attachment chip |
| 2342 | `Packages/JunoCode/Sources/JunoCodeUI/Models/SessionController.swift` | the Code session god-object: turn contract, workspace surface, agent actions, changes review, review notes, per-file history, inspector data, sub-agents, event application, DEBUG harness |
| 2250 | `macOS/JunoDesktop/App/DesktopCodeStudio.swift` | Code sidebar + run vocabulary + status + draft detail + all-projects |
| 2079 | `macOS/JunoDesktop/App/DesktopArtifactsScreen.swift` | library, index column, reading canvas, version history, document commands, an entire diff engine (`:1620-1862`), export, detached window |
| 1785 | `macOS/JunoDesktop/App/DesktopSettingsScreen.swift` | five panes + shared furniture + a usage model + wire types |
| 1640 | `Packages/JunoNativeKit/Sources/JunoChatKit/NativeConversationStore.swift` | wire types + `NativeConversationStore` actor + `NativeConversationModel` |
| 1595 | `macOS/JunoDesktop/App/DesktopProjectsScreen.swift` | workspace, detail, card, inspector, file import, two sheets |
| 1562 | `iOS/JunoMobile/App/JunoMobileConversationsView.swift` | detail screen, draft, greeting, conversation, title, message row, artifact card, cost |
| 1521 | `macOS/JunoDesktop/App/DesktopCodeWorkspace.swift` | selection, detail column, session surface, floating controls, title, toolbar, menu bar, actions, lifecycle, cloud/relay canvases |

**M-10 — decomposition plan.** Ordered by risk-adjusted value; each step is mechanical (move `private struct X` to its own file in the same target — no access-level change needed, `private` at file scope becomes `fileprivate`-equivalent within the type's new file, so most need `private` → nothing at all if the type is only used by name from one other file, otherwise `internal`).

*Phase 1 — near-zero risk, pure file moves of already-private leaf views (do these first, they cut ~4,000 lines with no semantic change):*

1. `DesktopArtifactsScreen.swift:1620-1862` → `DesktopArtifactDiff.swift` (`DesktopArtifactDiffRequest`, `DesktopArtifactDiffLine`, `DesktopArtifactDiff`). This is a diff algorithm living inside a screen; it is also the only part of the file that deserves unit tests and currently has none. **Risk: very low.**
2. `DesktopArtifactsScreen.swift:1863-1960` → `DesktopArtifactExport.swift` (`DesktopArtifactFile`, `DesktopArtifactDocument`, `DesktopArtifactWindows`, `DesktopArtifactWindowContent`). **Risk: very low.**
3. `DesktopChatWorkspace.swift:1357-1533` → `DesktopInlineArtifact.swift`; `:1534-1562` → `DesktopSpeechPlayback.swift`; `:1563-1733` → `DesktopMessageSources.swift`; `:2615-2830` → `DesktopComposerAccessories.swift`. **Risk: very low.**
4. `DesktopSettingsScreen.swift:1653-1785` → `DesktopUsageModel.swift` (`DesktopUsageError`, `DesktopUsageSnapshot`, `DesktopUsageWire`) — note `macOS/JunoDesktop/Tests/DesktopUsageModelTests.swift` already tests these, so they are being tested through a 1,785-line file. **Risk: very low.**
5. `DesktopProjectsScreen.swift:1401-1595` → `DesktopProjectSheets.swift`. **Risk: very low.**

*Phase 2 — one type per file, small mechanical risk from `private` → `internal`:*

6. `DesktopSettingsScreen.swift` → one file per pane: `DesktopSettingsGeneralPane.swift` (`:521-788`), `…AppearancePane.swift` (`:791-871`), `…MemoryPane.swift` (`:874-1240`), `…AccountPane.swift` (`:1243-1502`), `…UsagePane.swift` (`:1505-1652`), leaving `DesktopSettingsScreen.swift` as the `Pane` enum plus the shared furniture at `:324-468`. Target: ~330 lines. **Risk: low.**
7. `DesktopChatWorkspace.swift` → `DesktopChatSidebar.swift` (`:332-536`), `DesktopTranscript.swift` (`:817-1021`), `DesktopMessageRow.swift` (`:1022-1356`), `DesktopComposer.swift` (`:1734-2614`). Target for the remainder: ~450 lines. **Risk: low**, except `DesktopComposer` — it is 880 lines with a "Long drafts" section (`:1794`) that is shared logic with `NativePromptLimits`; move the view, leave the logic. **Risk: medium** for that one.
8. `DesktopCodeStudio.swift` → `DesktopCodeSidebar.swift` (`:402-1101`), `DesktopCodeRunBuilder.swift` (`:1102-1163`), `DesktopCodeDraftDetail.swift` (`:1264-2120`), `DesktopCodeAllProjects.swift` (`:2121-2250`). **Risk: low.**
9. `DesktopCodeWorkspace.swift` → `DesktopCodeTaskCanvas.swift` (`:1132-1278`), `DesktopCodeRemoteCanvas.swift` (`:1279-1459`), `DesktopCodeRelayApproval.swift` (`:1460-1521`). **Risk: low.**
10. `JunoMobileConversationsView.swift` → `JunoMobileDraftChat.swift` (`:139-268`), `JunoMobileGreeting.swift` (`:269-330`), `JunoMobileMessageRow.swift` (`:1011-1469`), `JunoMobileArtifactInlineCard.swift` (`:1470-1553`), `JunoMobileCost.swift` (`:1554-1562`). **Risk: low.**
11. `DesktopProjectsScreen.swift` → `DesktopProjectCard.swift` (`:692-853`), `DesktopProjectInspector.swift` (`:854-1400`). **Risk: low.**

*Phase 3 — genuine refactors, do last and behind tests:*

12. `NativeConversationStore.swift` → split the file at the type boundary: `NativeConversationStore.swift` keeps the model types (`:7-192`) and the actor (`:194-420`); `NativeConversationModel.swift` takes `:422-1612`; `NativeConversationWire.swift` takes `:1613-1640`. **Risk: low** (mechanical), but then the 1,190-line `NativeConversationModel` itself wants extracting: `RetryContext` + retry logic, the streaming-event application, and the auto-titling ladder (`:506-518`) are three separable responsibilities. **Risk: medium**, needs the existing `NativeChatAPIClientTests` and a new streaming-application test first.
13. `SessionController.swift` — the hardest and the most valuable. Its MARKs are already a decomposition proposal: `TurnContract` (`:263-402`) → `CodeTurnContract.swift`; `WorkspaceSurface` (`:403-451`, `:662-715`) → `CodeWorkspaceSurface.swift`; changes review + review notes + per-file history (`:1208-1597`) → `CodeReviewController.swift`; inspector data (`:1598-2037`) → `CodeInspectorModel.swift`; sub-agents (`:2038-2051`) → `CodeSubagentController.swift`; event application (`:2052-2257`) → `CodeSessionEventApplier.swift`; the DEBUG harness (`:2258-2342`) → its own `#if DEBUG` file. `SessionController` then retains lifecycle + agent actions, ~750 lines. **Risk: medium-high** — this type is the single point of coordination for the Code UI and `Packages/JunoCode/Tests/JunoCodeUITests/WorkbenchModelTests.swift` (924 lines) is the only safety net; write characterisation tests for the event applier before moving it.

---

## 4. Sync layer

`native/Packages/JunoNativeKit/Sources/JunoSync/` — 13 files. This is the most rigorously specified subsystem in the tree and I found **one** substantive issue (M-9, above). Recording what is correct, because it is load-bearing:

- **Idempotency.** `MutationDraft` carries an explicit `idempotencyKey` (`MutationOutbox.swift:31`); enqueue matches on (account, key) and returns the existing mutation with `inserted: false` when the payload is byte-identical, or throws `idempotencyCollision` when the same key carries different content (`MutationOutbox.swift:250-258`, `semanticallyMatches` at `:503-509`). Replaying the most recently committed sync page is a no-op by cursor comparison (`CursorPageApplier.swift:114-121`).
- **Tombstones.** `NativeHydratedEntity.storedRecord` sets `isTombstone: data == nil` (`NativeSyncAPIClient.swift:73`) and the wire validator enforces the `deletedAt`/`data` exclusivity (`:222-224`). Deletions travel as first-class hydrated entities, not as an absence.
- **Mutation queue.** Full lease/ack/retry/conflict/discard state machine with owner+token+expiry checks on every transition (`MutationOutbox.swift:458-477`), expired leases re-lease automatically (`:290-291`), ordering is `(createdAt, id)` (`:511-516`).
- **Conflict resolution.** Explicit: `ConflictResolution.retry`/`.discard(reason:)` (`MutationOutbox.swift:143-146`), only legal from `.conflicted` (`:434-436`). On the sync side, a page revision lower than stored is ignored, equal-but-different throws `conflictingStoredRevision` rather than picking a winner (`CursorPageApplier.swift:135-148`) — fail-loud rather than last-write-wins.
- **Atomicity.** Records, metadata and the cursor commit in a single `StorageTransaction` guarded by an optimistic store version, with bounded retry (`CursorPageApplier.swift:159-184`).
- **Offline.** `NativeSyncCoordinator.synchronizeWithRetry` (`:186-209`) with exponential backoff + jitter (`:41-48`), retryable classification that treats `URLError` and transport-shape errors as retryable and size/config errors as fatal (`:322-332`). `NativeConversationModel.reload` maps `syncModel.phase == .offline` to a distinct `.offline` UI phase (`NativeConversationStore.swift:676`).
- **Wire hardening.** Every server payload is validated before it can touch storage: entity-type allowlist (`NativeSyncAPIClient.swift:141-147`), strict `(type, id)` ordering and duplicate detection on the index (`:172-186`), cursor canonicalisation (`:327-331`), strict monotonicity of change cursors (`:272-273`), and — notably — attachment `url` fields are stripped before persistence so short-lived signed URLs cannot make identical revisions differ (`:78-88`).

**L-8** — `NativeSyncAPIClient.parseDate` (`:339-347`) and `preferredTimestamp` (`:350-363`) allocate two `ISO8601DateFormatter`s per call, inside a loop over every change in every page. Hoist them to `static let`.

**M-11 (UNVERIFIED)** — `PersistentMutationOutbox.swift`, `NativeMutationAPIClient.swift`, `NativeBootstrapBaselineInstaller.swift`, `NativeChangeWakeupStream.swift` and `NativeOutboxDiagnostics.swift` were not read. `InMemoryMutationOutbox` documents itself as test-only (`MutationOutbox.swift:237-241`) and requires production roots to inject a durable adapter; I confirmed `PersistentMutationOutbox.swift` exists but did not verify that the composition roots actually inject it, nor that it implements the same transition rules. To settle: read `PersistentMutationOutbox.swift` and grep `InMemoryMutationOutbox` in `JunoDesktopConfiguration.swift` / `JunoMobileApp.swift`.

---

## 5. Code-agent layer (`native/Packages/JunoCode`)

### 5.1 Reach

The agent, running unsandboxed under Hardened Runtime, can:

- **Filesystem:** read/write/delete anywhere the user can. Path-based tools go through `WorkspaceAccess`, which canonicalises with `resolvingSymlinksInPath()` and enforces prefix containment at resolution time for both reads (`WorkspaceAccess.swift:136-143`) and mutations, including the deepest-existing-ancestor walk for new files (`:145-178`). That containment is **correct and well-tested**. Shell commands, however, bypass it entirely — `CommandExecutionService` only sets `currentDirectoryURL` (`:33`); nothing constrains where the child writes.
- **Process:** `/bin/zsh -c <arbitrary string>` (`CommandExecutionService.swift:31-32`) and `/bin/zsh -c <package.json script>` (`DevServerService.swift:138-139`).
- **Network:** whatever a spawned command does. `curl`/`wget`/`ftp` are `.critical` (`CommandClassifier.swift:525-527`); `ssh`/`scp`/`rsync`/`nc` are `.destructive` (`:531-533`).
- **Screen:** ScreenCaptureKit via `ComputerUseCoordinator` (`JunoCodeLocal/ComputerUseCoordinator.swift`, 533 lines — not read in depth, `UNVERIFIED`).
- **Other apps:** `osascript` is `.destructive` (`CommandClassifier.swift:198-200`) and the entitlement exists (`JunoDesktop.entitlements:47`).

### 5.2 Can a model-generated command escape?

Yes, in two ways, both documented above: **H-3** (interpreter one-liners auto-run under `full access`) and **H-4** (brace/glob expansion past the `rm` forbidden tier). Neither requires an exotic payload.

Everything else in the gate holds up well. The classifier tokenizes with POSIX quoting rules and refuses anything it cannot parse (`CommandClassifier.swift:34-36`); unbalanced quotes and trailing escapes return nil (`ShellTokenizer.tokenize` at `:643`, `:667`, `:670`). Command substitution is detected in bare, double-quoted and process-substitution positions and forced to `.critical` (`:37-47`, `:659-662`, `:689-700`, `:715-716`). `PATH`/`DYLD_*`/`LD_*`/`GIT_SSH*` overrides are `.destructive` (`:106-116`, `:567-581`). `env VAR=x cmd` wrappers are unwrapped before classification (`:97-105`). Path-qualified programs do not inherit a familiar binary's lower tier — `./git` is not `git` (`:242-244`). Unknown executables default to `.critical` rather than `.execute` (`:211-219`), and unknown `git` subcommands likewise (`:362-367`), which closes the `git-<alias>` bypass. The forbidden list covers privilege escalation, power state, filesystem creation, SIP/NVRAM/launchd and account management (`:514-520`). The approval object binds a SHA-256 digest of the exact action plus a 15-minute expiry, re-checked after the user answers (`PermissionModel.swift:155-157`, `PermissionCoordinator.swift:122-124`), and lowering the permission mode bumps an authority revision that revokes every suspended approval (`PermissionCoordinator.swift:43-56`, re-checked at `:116-118`). Approvals fail closed on cancel, expiry and app termination (`:151-172`).

**L-9** — `classifyGit` (`CommandClassifier.swift:292-295`) advances `index += 2` for `-C`/`--git-dir`/`--work-tree`. If one of those is the final argument, `index` runs past `arguments.count`, the loop exits, and `subcommand` is nil → `.execute` "Git invocation." Harmless (the command would fail anyway) but the fall-through tier is wrong; return `.critical` for a malformed git invocation.

**L-10** — `classifyRemove` (`:254`) filters targets with `!$0.hasPrefix("-")`, so `rm -- -rf /` (where `--` ends options) is analysed with `--` as a target. Not exploitable, but the option/operand split is not POSIX.

### 5.3 Command execution hygiene

Good: scrubbed environment (`CommandExecutionService.swift:135-152`), `/dev/null` stdin (`:42`), byte-capped output with a first-crossing truncation signal (`ExecutionState.accept` at `:200-215`), wall-clock timeout (`:72-79`), both pipes drained to EOF before the completion event is emitted (`:51-70`, `:86-103`), process-group termination (`:169-180`, empirically verified — see M-5), secret redaction on every chunk (`:166`), and a defence-in-depth re-classification at the execution boundary (`:23-28`).

### 5.4 Tests

1,062 test functions across 22,216 lines. Coverage of the critical paths is genuinely good:

| Path | Test file |
|---|---|
| Command classification | `Tests/JunoCodeCoreTests/CommandClassifierTests.swift` (258 lines) |
| Permission gate | `Tests/JunoCodeRuntimeTests/PermissionCoordinatorTests.swift` (329) |
| Agent loop | `Tests/JunoCodeRuntimeTests/AgentOrchestratorTests.swift` (805) |
| Workspace bookmarks / containment | `Tests/JunoCodeLocalTests/WorkspaceBookmarkTests.swift` (171), `FileOperationServiceTests.swift` (230) |
| Token store, refresh coalescing | `Tests/JunoAuthTests/KeychainAuthTokenStoreTests.swift` (337), `AuthTokenCoordinatorTests.swift` (345), `NativeAuthRuntimeTests.swift` (756) |
| Sync | `Tests/JunoSyncTests/` — 9 files incl. `NativeOfflineReconnectProofTests.swift` (171), `MutationOutboxTests.swift` (204) |
| Secret redaction | `Tests/JunoCodeCoreTests/SecretRedactorTests.swift` |
| End-to-end bridge | `Tests/JunoCodeBridgeTests/EndToEndIntegrationTests.swift` (340) |

**M-12 — CI never runs the iOS unit tests or any UI test.** `native.yml:207-232` builds `JunoMobile` and stops; there is no `-only-testing:JunoMobileTests test` step, so `iOS/JunoMobile/Tests/` (`JunoMobileAttachmentTests.swift`, `JunoMobileComposerToolsTests.swift`, and siblings) never executes in CI. The macOS job runs `-only-testing:JunoDesktopTests` (`native.yml:172`) but never `JunoDesktopUITests`, and `iOS/JunoMobile/UITests/` (including the 513-line `JunoMobileComposerUITests.swift`) never runs anywhere automated. Fix: add an iOS test step against a booted simulator destination; run the UI suites at least nightly.

**M-13 — timing-based tests are a flake source.** `Tests/JunoCodeUITests/WorkbenchModelTests.swift` sleeps at `:251, 318, 338, 393, 436, 516, 578, 643, 714, 792, 856`; `Tests/JunoCodeRuntimeTests/AgentOrchestratorTests.swift:265` and `:418` sleep 200 ms / 300 ms; `Tests/JunoCodeLocalTests/CommandExecutionServiceTests.swift:99, 102` sleep 700 ms / 1.5 s. On a loaded CI runner these are the tests that will go red for no reason. `PermissionCoordinatorTests.swift:82-85` shows the better pattern the project already knows (deterministic handoff rather than sleeping). The two `CommandExecutionServiceTests` sleeps are defensible — they are testing a wall-clock timeout — but the `WorkbenchModelTests` ones should be replaced with continuation-based synchronisation.

**Skipped tests: two**, both legitimate environment guards — `iOS/JunoMobile/UITests/JunoMobileComposerUITests.swift:352` (no software keyboard) and `JunoMobileDictationUITests.swift:38` (speech unavailable). `JunoMobileDictationUITests.swift:68` and `:77` use `Thread.sleep`, including a flat 4-second wait — **L-11**.

**L-12** — the diff engine at `DesktopArtifactsScreen.swift:1652-1862` has no tests, unlike `JunoCodeCore/DiffEngine.swift` which has `DiffEngineTests.swift` (166 lines). It is duplicated logic (see §6) *and* untested.

---

## 6. Duplication between Swift and TypeScript

### 6.0 What is actually gated

Exactly **one** codegen/verification pipeline exists: `contracts/openapi/juno-native-v1.yaml` → `scripts/generate-native-swift-contract.mjs` → `Packages/JunoNativeKit/Sources/JunoAPI/Generated/JunoNativeContract.swift`, verified byte-for-byte by `scripts/check-native-swift-contract.mjs` (`npm run native:contract:check`, `package.json:26`) and run in CI on any `native/**` or `contracts/**` change (`.github/workflows/native.yml:48-63`). The digest is real: `shasum -a 256` of the YAML equals `JunoNativeContract.swift:6`.

**It covers 8 of the 61 schemas in the contract.** `generate-native-swift-contract.mjs:26-94` hardcodes 8 Swift structs as a template literal — it does not parse `components.schemas`. Everything below is hand-maintained on both sides with **no automated parity check anywhere**: grepping `scripts/`, `package.json`, `.github/` and `native/Scripts/` for `prompt-limits`, `NativePromptLimits`, `JunoAccent`, `globals.css`, `JunoColors`, `message-content` and `learning-blocks` returns zero hits.

---

#### **H-7 — The Thinking control's "Off" position is inert for several model families in Juno Code**
`native/Packages/JunoCode/Sources/JunoCodeBridge/CodeThinkingWire.swift:134-140` and `:195`

This is the only cross-language divergence that produces a **wrong answer** rather than a cosmetic mismatch, and it is user-visible: the user turns thinking off, the model reasons anyway, and they are billed for it.

**Anthropic path** (`CodeThinkingWire.swift:134-140`): when `effort == nil`, Swift returns `thinking: nil, outputConfig: nil` — it sends no `thinking` object at all. The web does two extra things at `src/lib/anthropic-thinking.ts:130-138`:
- `adaptiveDefaultOn` (`anthropic-thinking.ts:68-70`) — for `claude-sonnet-5`, adaptive is Anthropic's **default when the field is omitted**, so Instant requires an explicit `thinking: { type: "disabled" }`. The TS comment at `:134-135` names this exact failure. Swift never sends it, so **Off is a no-op on Claude Sonnet 5**.
- `adaptiveAlwaysOn` (`anthropic-thinking.ts:59-62`) — Fable and Mythos always send `{type:"adaptive"}` even with no effort. Swift sends nothing and also skips the headroom, so those two models get a different budget in Code than in the browser.

**OpenAI-compatible path** (`CodeThinkingWire.swift:195`): `guard let effort else { return [:] }`. The web emits three distinct off-signals that Swift never sends — `reasoning_effort: "none"` for openai/google/mistral (`src/lib/openai-compat.ts:289`, gated by `canDisableViaNoneEffort` at `:113-150`), `thinking: {type:"disabled"}` for Zhipu/GLM (`openai-compat.ts:305-309`) and for moonshot/mimo/longcat/minimax (`:310-317`), and `enable_thinking: false` for Qwen (`:298`). I confirmed by grep that `"none"`, `"disabled"` and `enable_thinking: false` are never written on the Swift side (`CodeThinkingWire.swift:205` only ever writes `enable_thinking: true`; `:219-221` and `:223-225` only ever write the on-state). GPT-5.5/5.6 default to `medium` (`openai-compat.ts:106-108`), so **Off is a no-op there too**, as it is for all GLM models and Qwen hybrids.

Nuance worth preserving: the Swift comment at `:190-195` explains that returning `[:]` was a deliberate fix — Mistral, the non-reasoning OpenAI snapshots and non-thinking Qwen models **reject** `reasoning_effort` with a 400. That reasoning is correct; the web solves the same problem with the `canDisableViaNoneEffort` allowlist rather than by sending nothing to everyone.

Fix: port `canDisableViaNoneEffort`, `adaptiveAlwaysOn` and `adaptiveDefaultOn` into `CodeThinkingWire`. Better: move the whole mapping server-side behind `/api/agent/*` so there is one implementation — the proxy already sees `providerID`, `providerModelID` and the effort.

The rest of the file is a careful, verified port: the Anthropic thinking-kind list (`:51-63` ↔ `anthropic-thinking.ts:35-57`), `needsSummarizedDisplay` (`:68-73` ↔ `:76-85`), the `minimal → low` mapping (`:76-78` ↔ `:87-91`), the adaptive headroom table (`:82-91` ↔ `:94-101`), the manual budget table (`:94-103` ↔ `:104-111`), the output caps (`:106-112` ↔ `:125-129`), the budget clamp (`:158-161` ↔ `:161`), the Qwen budget map (`:279-288` ↔ `openai-compat.ts:300-302`), the `usesReasoningEffort` provider set (`:238-252` ↔ `:240-258`), the Mistral collapse (`:212-214` ↔ `:283`), `reasoning_split` (`:227-231` ↔ `:319-321`), MiniMax M3 adaptive (`:263-265` ↔ `:315`) and the Responses `-pro` floor (`:305-311`). Only the off-state is missing.

---

#### **M-14 — The generated contract covers auth and bootstrap only; the high-churn vocabularies are outside it**

Outside the gate, each a silent-divergence hazard whose failure mode is a runtime decode error on a user's device rather than a red build:

- **Sync entity types** — `JunoSync/NativeSyncAPIClient.swift:141-149` vs `src/lib/sync-entities.ts:30` (exported as `SYNC_ENTITY_TYPES` at `:439`). Verified exact, 22 each. The contract types this as a bare `string` (`juno-native-v1.yaml:751`), so nothing checks it.
- **SSE chunk union** — `NativeChatAPIClient.swift:942-1037` handles all 10 variants of `src/types/chat.ts:191-235`. **IN SYNC but brittle**: `NativeChatAPIClient.swift:1035` is `default: throw NativeChatAPIError.malformedResponse`, so adding an 11th chunk type server-side breaks every shipped client mid-answer. The contract's `ChatSSEEvent` oneOf (`juno-native-v1.yaml:862-940`) lists only 8 — it omits `progress` and `title`, which both implementations handle. Swift also ignores `artifacts`, `memoryUpdated` and `quota` from the `done` frame (`types/chat.ts:212-214`).
- **Mutation operations** — `sync-mutations.ts:10-52` and `juno-native-v1.yaml:784` define 15; Swift implements **12**.
- **API route paths** — 60+ hand-written string literals across `JunoAuth`, `JunoSync`, `JunoChatKit`, `JunoCodeKit` and `JunoCodeBridge`. All resolve to real routes today, but only 28 appear in the contract at all (`juno-native-v1.yaml:21-554`), and the generator emits no path constants.

Fix: extend the generator to parse `components.schemas` and emit the entity-type set, the SSE event-type set, the mutation-operation set and the path constants. That converts four classes of runtime failure into build failures.

---

#### **M-19 — `CONTRACT_VERSION` on the server is the one contract leg CI does not check**
`src/lib/api-v1.ts:6` vs `native/Packages/JunoNativeKit/Sources/JunoAPI/Generated/JunoNativeContract.swift:5`

Currently in sync at `1.3.0` (also `contracts/openapi/juno-native-v1.yaml:4` and `native/Config/Base.xcconfig:25`). But `api-v1.ts:6` is **not** derived from the YAML and is **not** in the `contract` CI job — only `scripts/release-gates.sh:52-62` compares them, and that is a manually invoked script. A YAML bump regenerates the Swift constant and passes CI while `api-v1.ts` lags. `NativeAuthAPIClient.swift:294` requires exact equality (`decoded.contractVersion == JunoNativeContract.version`), so the consequence is **every native client failing to establish a session** until someone runs the release gates.

Fix: generate `api-v1.ts`'s `CONTRACT_VERSION` from the YAML too, and add it to `check-native-swift-contract.mjs`.

---

#### **M-20 — Native cannot create, rename or delete a folder**
`src/lib/sync-mutations.ts:29-31` and `src/app/api/v1/mutations/route.ts:137-153` vs `native/Packages/JunoNativeKit/Sources/JunoChatKit/NativeConversationStore.swift:330-377`

`folder.create`, `folder.rename` and `folder.delete` exist in the schema, the contract enum and the server executor; grepping every `"<entity>.<op>"` literal in `Packages/JunoNativeKit/Sources` finds 12 of the 15 operations, with the three folder ones absent. Native **does** sync the `folder` entity type (`NativeSyncAPIClient.swift:141`), so folders created on the web appear in the app and cannot be managed there. A feature gap rather than a defect, but it is invisible from the Swift side.

---

#### **M-21 — Responses-API routing is inferred from a model-id substring instead of read from the manifest**
`native/Packages/JunoCode/Sources/JunoCodeBridge/BackendCodeModelClient.swift:102-104`

Swift guesses: `providerID == "openai" && (id.contains("-codex") || id.hasSuffix("-pro"))`. The truth is a per-model field, `api?: "chat" | "responses"` at `src/lib/models.ts:48` (set at `:173,181,182,184,186,188,190`), which the native manifest does **not** publish (`src/lib/native-model-manifest.ts:64-130` has no `api` key). The guess agrees with every current entry, so this is latent: the first Responses-only model whose id lacks `-codex`/`-pro` gets routed to `chat/completions` and 404s.

Fix: add `api` to `native-model-manifest.ts` and read it. One field removes a whole class of future breakage.

The agent-proxy path allowlist beside it **is** in sync — `BackendCodeModelClient.swift:88-109` matches `src/app/api/agent/[...path]/route.ts:18-22` including the openai-only Responses restriction.

---

#### **M-22 — The two agent implementations share tool *names* but not schemas**
`native/Packages/JunoCode/Sources/JunoCodeRuntime/Tools/` vs `runner/agent-core/src/tools/`

The cloud runner registers 6 tools (`runner/agent-core/src/tools/registry.ts:5-7`); the local Mac agent implements 20. Where the names overlap, the schemas do not:

| Tool | TS | Swift | Divergence |
|---|---|---|---|
| `read_file` | `tools/fs.ts:18-29` `{path, offset, limit}` | `Tools/FileTools.swift:22-31` `{path}` | native cannot page a large file |
| `write_file` | `fs.ts:53-60` `{path, content}` | `FileTools.swift:97-108` `{path, content, base_sha256}` | optimistic concurrency is native-only |
| `glob` | `fs.ts:118-127` `{pattern}` | `Tools/SearchTools.swift:53-63` `{pattern, limit}` | — |
| `grep` | `fs.ts:144-158` `{pattern, glob}` | `SearchTools.swift:93-106` `{pattern, is_regex, case_sensitive, include, limit}` | **the file filter is named `glob` in TS and `include` in Swift** |
| bash/shell | `tools/bash.ts:8-21` `bash{command, timeout_ms}` | `Tools/CommandAndTestTools.swift:15-25` `run_command{command, timeout_seconds}` | **different name *and* different time unit** |

`edit_file` (`fs.ts:81`) is TS-only. `list_directory`, `find_files`, `run_tests`, `git_*`, `delegate_task`, `update_goal` and the five `computer_*` tools are Swift-only.

Why it matters: the same model, given the same task, gets a different tool surface depending on whether the session ran locally or in the cloud — and a prompt or eval tuned against one silently underperforms on the other. `timeout_ms` vs `timeout_seconds` is the sharpest edge: a model that has seen the cloud schema will pass `30000` meaning 30 seconds and get an 8-hour timeout locally.

Fix: at minimum, rename to agree (`grep.include`, `run_command`/`bash`, one time unit) and add the missing `read_file` paging. Ideally, generate both tool schema sets from one JSON source.

---

#### **M-23 — `MESSAGE_DISPLAY_COLLAPSE_CHARS` has no native counterpart**
`src/lib/prompt-limits.ts:18` (used at `src/components/chat/message-item.tsx:529,532,536`)

The web truncates the rendered copy of a user bubble over 12,000 characters and appends `… (N characters — expand to show all)`. Grepping `12_000`/`12000` across `native/` returns nothing, so both apps render the entire string into a single `Text`. On a 200 KB paste this is a layout stall on the phone.

The rest of `NativePromptLimits.swift` **is** in sync, value for value: the 700-char / 14-line long-message thresholds (`:19-20` ↔ `message-item.tsx:531`), the 240 px collapsed height (`:25` ↔ `message-item.tsx:601`'s `max-h-60`), the 8,000-char composer soft cap (`:31` ↔ `prompt-limits.ts:25`), the 1,500-char / 30-line long-text thresholds (`:36-37` ↔ `prompt-limits.ts:28` and `composer.tsx:563`), and the `prompt.txt`/`text/plain` attachment naming (`:42-43` ↔ `composer.tsx:570`).

**L-20** — `sampleLineCount`'s 4,000 sample size matches numerically (`NativePromptLimits.swift:51` ↔ `prompt-limits.ts:49`) but Swift samples over `text.utf8` bytes (`:55-58`) while TS samples UTF-16 code units (`prompt-limits.ts:52-55`). For CJK or emoji drafts the Swift sample covers roughly a third as many characters, so the two disagree on whether a draft is "long".

**L-21** — Several web thresholds are bare literals in components rather than in `prompt-limits.ts` (`message-item.tsx:531`, `composer.tsx:563`), which is why the Swift/TS pairing had to be found by grep rather than by reading one file.

---

### 6.1 In sync, verified — recorded so these are not re-derived

**Plan gating is not duplicated at all, and is the model the rest should follow.** `src/lib/plans.ts:27-142` (`PLANS`, `planRank`, `effectiveMinPlan`, `canUseModel`) has no Swift counterpart; grepping `case (free|pro|max|owner)` across `native/` yields one hit, `NativeModelPresentation.swift:39-43`, which merely capitalises whatever plan string the server sent. Gating is resolved server-side and published as `availability`/`requiredPlan` (`native-model-manifest.ts:59-63,86`) and rendered at `NativeModelPresentation.swift:46-55`. `src/lib/pricing.ts` likewise has no port — native reads `costUsd` off the wire (`NativeChatAPIClient.swift:240`).

**Model identity is server-driven.** IDs, names, descriptions, pricing and context windows come from `/api/v1/models` (`native-model-manifest.ts:50-134` ← `src/lib/models.ts:148-360`), decoded by `ModelCatalogWire` (`NativeChatAPIClient.swift:1141-1190`). Grepping `anthropic:claude-*` in `native/Packages/*/Sources` finds only preview and test fixtures.

Verified equal: the 6-tier reasoning ladder in four places (`model-metrics.ts:447`, `JunoProviderGlow.swift:153`, `NativeChatAPIClient.swift:7-18`, `SessionModels.swift:167-174`) · the glow ramp (`model-metrics.ts:462-466` ↔ `JunoProviderGlow.swift:158-163`) · the availability, lifecycle, imageEdit and pricing-class wire enums (`NativeChatAPIClient.swift:133-134, 666, 670, 118, 697`; `NativeModelPresentation.swift:19-24`) · the 14-provider colour table (`provider-colors.ts:3-17,34-38` ↔ `JunoProviderGlow.swift:27-45`) · the `asAmbientLight`/`hexToHsl` transform including the `min(s*0.56, 0.5)` and `l + (0.52-l)*0.68` constants (`provider-colors.ts:41-90` ↔ `JunoProviderGlow.swift:64-136`) · `ActivityKind`'s 10 values (`types/chat.ts:110` ↔ `NativeChatAPIClient.swift:287-292`) · `ChatFinishReason`'s 9 (`types/chat.ts:18-27` ↔ `NativeChatAPIClient.swift:221-229`) · `stripTrailingSourcesSection` including the fence regex and the `{1,3}` citation bound (`message-item.tsx:269-281` ↔ `NativeMessageContent.swift:145-206`) · the 6 learning-block kinds and labels (`learning-blocks.ts:32-136` ↔ `JunoLearningBlocks.swift:31-47`) · the 7 Step Lab visual types and 2 densities (`step-lab.ts:1-45` ↔ `JunoStepLab.swift:18-31`) · the entire 30-phrase, 7-bucket greeting table verbatim (`empty-state.tsx:10-22` ↔ `JunoGreeting.swift:19-48`) · the 12-entry response-language list and 20-entry UI-locale list in three copies each (`settings/page.tsx:41`, `i18n.ts:95-107`, `DesktopSettingsScreen.swift:535-542`, `JunoMobileSettingsView.swift:647-654`) · `MAX_CHAT_CONNECTORS = 5` (`connector-intent.ts:7` ↔ `JunoMobileComposerTools.swift:30`) · the thinking-matrix animation, every number (`thinking-dots.tsx:7,31` + `tailwind.config.ts:191-196,333` ↔ `JunoThinkingMatrix.swift:30-93`) · and the **entire base colour palette**, which I recomputed from HSL: `--primary`, `--background`, `--card`, `--popover`, `--muted`, `--muted-foreground`, `--sidebar` and `--source` all match `globals.css` to four decimal places (`JunoDesignTokens.swift:41-63`, `JunoColors.swift:18-70`).

### 6.2 Diverged — lower severity

**M-24 — the web's own accent constant disagrees with the CSS it claims to mirror.** `src/lib/accents.ts:6` declares coral as `hsl(15 63% 60%)`; `src/app/globals.css:215` and `JunoAccent.swift:41` both say `15 54% 51%`. I verified all three by hand. `accents.ts:1-3` calls itself "single source of truth … Keep in sync with the `[data-accent=…]` rules in globals.css" and feeds the settings swatch and the settings API validator, so the web shows a lighter, more saturated coral chip than the colour anything actually paints with. **The Swift port is the correct one.** The other four accents and all five `--primary-foreground` values match across all three.

**M-25 — Swift's `<juno:*>` content parser is a reimplementation with three behavioural gaps.** `JunoChatKit/NativeMessageContent.swift` (460 lines) vs `src/lib/message-content.ts` (213). The tag literals match. But: artifact `type` normalisation is missing — TS coerces unknown types to `"CODE"` (`message-content.ts:47-53`), Swift keeps a raw untyped `String` (`NativeMessageContent.swift:35`); the content-hash fallback id is missing — TS synthesises `art-<djb2 of first 500 chars>` when `identifier=` is absent (`message-content.ts:37-40`), Swift falls back to `"\(title)-\(kind)"` (`NativeMessageContent.swift:49`), so **the same reply yields different artifact ids on the two clients**; and `spoken(of:)` (`NativeMessageContent.swift:123-133`) does far less than `cleanForSpeech` (`message-content.ts:196-212`) — it strips learning blocks and substitutes the artifact title, but performs none of the markdown-punctuation stripping (code fences, inline backticks, `*_#>~|`, `...`→`,`, `—`→`,`), so read-aloud pronounces markup.

**L-22 — the native markdown renderer has no maths.** `src/components/chat/markdown.tsx:278-281` uses `remark-gfm`, `remark-math`, `rehype-highlight` and `rehype-katex`, and normalises `$…$`/`$$…$$`/`\[…\]` at `:6,55,76-77`. `JunoDesignSystem/JunoMarkdown.swift` (335 lines, hand-rolled) has no maths handling at all — grep for `katex|latex|math` returns nothing — so a maths-heavy reply renders as raw `$\frac{a}{b}$` on both Apple platforms. Syntax highlighting is likewise absent. Swift additionally carries a 378-line YAML-subset parser (`JunoYAMLSubset.swift`) duplicating `step-lab.ts`, with no shared fixtures.

**L-23 — `formatContext` capitalises differently, and the doc comment asserts otherwise.** `JunoModelCatalog.swift:323-332` returns `"200K"`; `src/lib/model-metrics.ts:728-734` returns `"200k"`. The `M` branch matches. The Swift comment at `:321-322` claims the model "reads identically in the app and in the browser" — it does not. Aliased at `NativeModelPresentation.swift:12-14`.

**L-24 — effort labels differ three ways.** `NativeThinkingScale.swift:51-59` and `CodeModelCatalog.swift:20-24` say `Extra high`; `src/components/chat/model-params-panel.tsx:26-33` says `Extra-high effort`; `src/components/chat/reasoning-slider.tsx:11` says `Extra high`. The web is inconsistent with itself, so pick the Swift form and fix the params panel.

**L-25 — `panel` corner radius is the same token name with a different value and a different meaning.** `tailwind.config.ts:99-104` `panel: "28px"`; `JunoDesignTokens.swift:103-124` `panel = 16`. Swift's `composer = 24` correctly matches `--radius: 24px` (`globals.css:116`) and `compactControl = 8` matches Tailwind's `md`. Rename one of them.

**L-26 — motion tiers share names and share no numbers.** `globals.css:124-127` `120/220/360 ms`; `JunoDesignTokens.swift:132-138` `180/260/320 ms`. Swift claims no parity here, but they are the same three design concepts.

**L-27 — `customInstructions` is capped at 200,000 characters natively and unbounded on the server.** `NativeMemorySettingsStore.swift:381,509,1093` vs `src/lib/sync-mutations.ts:46` (`z.string().optional()`). Native refuses what the server accepts. The other field caps agree — conversation title 200 (`NativeConversationStore.swift:693,877` ↔ `sync-mutations.ts:21`), project name 160, memory content 20,000, favourite-model id 200 — though Swift measures UTF-8 bytes where zod measures UTF-16 units.

**L-28 — the connector-mark table carries three ids the product does not have.** `JunoDesignSystem/JunoConnectorMarks.swift:146-151` maps `apple-reminders`, `apple-notes` and `apple-contacts`, none of which exist in `src/lib/connectors.ts:85-201` (6 connectors). Dead branches, not a break.

**L-29 — iOS shows personality names with no explanations.** `DesktopSettingsScreen.swift:483-513` copies all 6 ids, labels *and* descriptions verbatim from `src/lib/personalities.ts:20-62`; `JunoMobileSettingsView.swift:644-646` carries **ids only**. A phone user sees "Socratic" with no indication of what it does, where the Mac and the web both explain it.

**L-30 — the contract describes two routes native never calls.** `getNativeChatReceipt` (`juno-native-v1.yaml:315`, `/api/chat/receipt`) and `/code/workspaces` (`:529`) have no Swift call site. The generator *requires* the former's operationId to exist (`generate-native-swift-contract.mjs:10`), so it cannot be removed from the contract without touching the generator.

**L-31 — the model-sync workflow points at a file that does not exist.** `.github/workflows/sync-models.yml:123` emits the manual checklist item "Mirror changes into JunoApp's ModelCatalog.swift if needed". No `ModelCatalog.swift` exists anywhere under `native/`. Either the checklist is stale (model identity is server-driven now, §6.1) or it refers to a repo that is not this one.

---

---

## 7. Localization

One catalog exists in the entire native tree: `iOS/JunoMobile/Resources/Localizable.xcstrings` (141 KB). Parsed: **398 keys**, `sourceLanguage: en`, languages `en` (322 keys: 318 translated, 4 `new`) and `fr` (318, all translated). **76 keys have no `localizations` block at all**; 4 more have `en`-only. Net French coverage **318/398 = 79.9 %**. `extractionState`: 187 `stale`, 82 `manual`, 129 absent.

Target membership: iOS **yes** — `iOS/JunoMobile/project.yml:24-28` includes `Resources` as a resource phase, confirmed in the generated project at `iOS/JunoMobile/JunoMobile.xcodeproj/project.pbxproj:72` and `:477`.

---

#### **H-5 — The macOS app declares French support and ships no catalog at all**
`native/macOS/JunoDesktop/project.yml:7-9` vs `native/macOS/JunoDesktop/Resources/`

`knownRegions: [en, fr]` is declared for JunoDesktop, but there is no `Localizable.xcstrings` anywhere under `macOS/JunoDesktop/Resources/`, and `project.yml:31-32` reaches into the iOS Resources folder for **Fonts only**. `macOS/JunoDesktop/App` contains **zero** `String(localized:)` calls and 540 `LocalizedStringKey` literals, all of which fall back to their English key. The Mac app is 0 % localized while advertising a French locale.

---

#### **H-6 — Package `String(localized:)` calls resolve against `Bundle.main`, so the Mac app renders raw dot-notation keys on screen**
`native/Packages/JunoNativeKit/Sources/JunoChatKit/NativeScheduledTaskStore.swift:18-21` (representative)

Neither `JunoNativeKit/Package.swift` nor `JunoCode/Package.swift` declares `defaultLocalization` or any `resources:` entry, and there is no `Bundle.module` reference anywhere in `native/Packages`. I verified all **44** `String(localized:)` calls in package sources: **none passes a `bundle:` argument**, so every one resolves against `Bundle.main`. On iOS that happens to be the app bundle carrying the catalog. On macOS the app bundle has no catalog, so Foundation returns the key verbatim.

Concretely, a Mac user sees the literal strings `tasks.cadence.daily`, `tasks.cadence.weekdays`, `tasks.cadence.weekly`, `tasks.cadence.monthly` (`NativeScheduledTaskStore.swift:18-21`), `tasks.error.malformed` (`:168`), `code.error.malformed` (`JunoCodeKit/NativeCodeTaskStore.swift:169`), `code.session.untitled` (`:552`), `connections.error.malformed` and `connections.error.composio-off` (`JunoChatKit/NativeConnectorStore.swift:114-115`), and the `diagnostics.phase.*` family (`JunoChatKit/NativeDiagnosticsView.swift:124-131`).

Fix: add `defaultLocalization: "en"` to both `Package.swift` manifests, add a per-target `Localizable.xcstrings` under `Sources/<Target>/Resources/` with `.process`, and change all 44 call sites to `String(localized: …, bundle: .module)`. Then add the same catalog to the macOS app target for the app-level strings (H-5).

---

#### **M-15 — Format-specifier drift silently defeats 14 catalog keys**
`native/iOS/JunoMobile/App/JunoMobileWorkspaceViews.swift:1101` (representative)

The source writes `Text("Version \(candidate.version)")`, which the compiler lowers to key `Version %lld`, while the catalog holds `Version %@`. The key misses at runtime and falls back to English. The same `%@` → `%lld` drift affects `JunoMobileUsageView.swift:285` (`Busiest %@ · %@`), `JunoMobileSearchView.swift:121` (`Nothing synced to this device matches “%@”.`), `JunoMobileSettingsView.swift:171` (`Type %@ to confirm.`), `JunoMobileModelSelector.swift:301` (`Older models (%@)`), and the `^[…](inflect: true)` pair at `JunoMobileWorkspaceViews.swift:205`, plus `'%@ %@'`, `'%@, %@'`, `'%@×'`, `'· %@'`, `'%@ characters · sent in full'`, `'No requests in the %@…'`, `'Resets %@'`, `'^[%@ memory](inflect: true)'`.

This is the worst kind of localization bug: the string is translated, the build is green, and the French user sees English.

---

#### **M-16 — 31 orphaned catalog keys, 5 missing keys, ~1,030 view literals never extracted**

Orphans (in the catalog, referenced nowhere in Swift), 16 of them also `stale`: `attachments.camera.detail`, `attachments.files.detail`, `attachments.full`, `attachments.photos.detail`, `attachments.section`, `attachments.wait`, `auth.restoring`, `chat.empty.description`, `chat.empty.title`, `library.subtitle`, `research.subtitle`, `research.title`, `settings.about`, `settings.account`, `sync.offline`, `sync.synced`, plus `voice.title` and the 14 format-string keys above.

Missing (called via `String(localized:)`, absent from the catalog — these render their key): `"Show less"` at `iOS/JunoMobile/App/JunoMobileConversationsView.swift:1154`, and `"Today"`/`"Yesterday"`/`"This week"`/`"Earlier"` at `Packages/JunoCode/Sources/JunoCodeUI/Models/WorkbenchModel.swift:561-564`.

Never extracted: of 386 `LocalizedStringKey` literals in `iOS/JunoMobile/App`, **189** have no catalog entry (e.g. `JunoMobileComposer.swift:277` "Send this message as a file", `:608` "Stop generation", `:629` "Send message"; `JunoMobileConversationsView.swift:816` "Rename conversation", `:824` "Delete this conversation?"). Of 348 in `Packages/*`, **335** are missing. Of 540 in `macOS/JunoDesktop/App`, all 540 (H-5).

**M-17 — the key-naming scheme is split** between 260 dot-notation keys (`tasks.status.failed`) and 138 natural-language keys (`Delete account`). A missing dot key renders as machine text on screen; a missing natural-language key degrades invisibly to English. Pick one — natural-language keys, which is what SwiftUI's implicit `LocalizedStringKey` produces anyway — and migrate the dot keys.

**M-18 — no build-time or CI localization gate exists.** `native/Scripts/` contains no localization tooling and `.github/workflows/native.yml` has no localization step, which is why 31 keys went orphaned and ~1,030 literals never reached the catalog. Add a script that (a) fails when a `String(localized:)` literal has no catalog entry, (b) fails on `%@`/`%lld` specifier mismatches, (c) reports orphans, and run it in the `native` workflow.

---

### 7.1 User-facing English outside any localization mechanism

Totals: 437 `Text("…")` literals (macOS/App 191, iOS/App 139, JunoCode 66, JunoNativeKit 43); `String(localized:)` totals macOS/App **0**, iOS/App 57, JunoNativeKit 40, JunoCode 4; `NSLocalizedString` **0**. Aggregate English sentence literals sitting outside any localization API across the four source areas: **~1,119**.

`Text("literal")` is implicitly a `LocalizedStringKey` and so is at least *localizable*. These are not:

**`Text(verbatim:)` — 4, all glyphs, low risk:** `JunoDesignSystem/JunoMarkdownView.swift:172`, `JunoStepLabView.swift:201`, `JunoLearningBlockViews.swift:121` and `:518`.

**`Text(stringVariable)` — resolves to the `StringProtocol` overload, never localized:** `macOS/.../DesktopVoice.swift:106` and `:109`; `DesktopSettingsScreen.swift:419-420`; `DesktopUsageScreen.swift:102` and `:105`; `DesktopSearchScreen.swift:224`; `DesktopIncognito.swift:180`; `DesktopProjectsScreen.swift:536`; `DesktopLibraryScreen.swift:573`; `DesktopTasksScreen.swift:603`; `JunoChatKit/NativeSharedLinksView.swift:43` (whose value is set at `:130` to the English literal "Couldn't revoke that link. It is still live.").

**English `String` built in a model, then displayed:** `DesktopSettingsScreen.swift:198, 203, 209, 212`; `JunoChatKit/NativeUsageBreakdown.swift:302-303` (hand-rolled English pluralization — `"\(requests) request\(requests == 1 ? "" : "s")"` — fed to `.accessibilityLabel` at `DesktopUsageScreen.swift:372` and `JunoMobileUsageView.swift:267`); `JunoCodeUI/Views/Composer.swift:46, 48, 50, 57` (the four permission-mode explanations); `JunoMobileDictation.swift:197`; `JunoMobileConversationsView.swift:386`; `DesktopChatWorkspace.swift:301, 303, 2608`; `DesktopUpdater.swift:357`; `JunoMobileThoughtProcess.swift:256, 259, 261, 262`; `JunoMobileThinkingControl.swift:87`; `JunoMobileMemoryView.swift:373`; `JunoMobileUsageView.swift:109`; `CodePreviewWindow.swift:153, 156, 257`; `CommandClassifier.swift:32, 35, 45, 86` (refusal reasons shown in approval prompts); `SQLiteAccountRepository.swift:22-32`; `NativeConversationStore.swift:686` (`title: String = "New chat"`).

**`.accessibilityLabel(stringVariable)` — `StringProtocol` overload, not localized:** `DesktopSettingsScreen.swift:427` (and `.accessibilityHint(explanation)` at `:428`); `DesktopUsageScreen.swift:372`; `DesktopCodeStudio.swift:389`; `DesktopChatWorkspace.swift:545` and `:1353`; `DesktopConnectionsScreen.swift:785`; `DesktopDictation.swift:50` and `:143`; `JunoMobileChrome.swift:194`; `JunoMobileConversationsView.swift:299` and `:985`; `JunoMobileSearchView.swift:298`; `JunoMobileCodeView.swift:323`.

**Error enums whose English `errorDescription` is shown to users** — these leak into *both* apps when they live in a package: `JunoVoiceKit/JunoRealtimeVoiceController.swift:42-68` (eight sentences including platform-forked System Settings paths); `JunoChatKit/NativeConversationStore.swift:172-189` (seven); and the same pattern at `NativeLibraryStore.swift:41`, `NativeMessageActionsClient.swift:138`, `NativeProjectAPIClient.swift:40`, `NativeAccountDataClient.swift:12`, `NativeArtifactStore.swift:70`, `NativeMemorySettingsStore.swift:213` and `:611`, `NativeArtifactAPIClient.swift:114`, `NativeAttachmentAPIClient.swift:32`, `NativeChatAPIClient.swift:538`, `NativeImageTranscoder.swift:34`, `NativeVoiceTranscriptClient.swift:134`, `NativeUsageBreakdown.swift:565`, `NativeProjectStore.swift:139`, `JunoAuth/NativeBrowserAuthorization.swift:14`, `NativeAuthRuntime.swift:12`, `NativeAuthAPIClient.swift:13`, `KeychainAuthTokenStore.swift:26`. macOS-only: `DesktopVoice.swift:23-25` and `:77-81`, `JunoDesktopWebAuthenticationClient.swift:11-22`, `JunoDesktopConfiguration.swift:226-233`, `DesktopUpdater.swift:377-397, 554, 584, 624`, `DesktopSettingsScreen.swift:1543`. iOS-only: `JunoMobileReadAloud.swift:144` — the only iOS one not routed through `String(localized:)`, which contrasts with the correct handling at `JunoMobileApp.swift:304` and `JunoMobileVoiceAuthorization.swift:73-78`.

---

## 8. Dead code

Method: 966 top-level type declarations enumerated across `native/Packages/*/Sources` and `native/{macOS,iOS}/*/App`, then whole-repo `fgrep -w` including `src/`, `scripts/`, `tests/`, `docs/`, `.github/`, `contracts/`, `prisma/`, both `project.yml` files and **both generated `project.pbxproj` files**; excluding `node_modules/`, `.next/`, `dist/`, `.git/`, `.worktrees/`, `**/.build/`, `**/.swiftpm/`.

**Total: ~1,000 lines of production Swift, plus ~180 lines of tests that exist only to keep it green.**

### 8.1 Verified dead

#### **M-26 — `JunoSettingsPrimitives.swift` is shadowed in its entirety by an app-local duplicate**
`native/Packages/JunoNativeKit/Sources/JunoDesignSystem/JunoSettingsPrimitives.swift:28` vs `native/iOS/JunoMobile/App/JunoMobileSettingsView.swift:588`

`JunoSettingsTile<Content: View>` is declared **twice** — `public` in the shared design system, and `internal` in the iOS app. Swift resolves the app-local declaration at every iOS call site (`JunoMobileSettingsView.swift:245, 258, 306, 319, 343, 390, 657, 677, 719`), so **the design-system copy is wired into nothing**. The rest of the 267-line file falls with it: `JunoSettingsMetrics` (`:55`) is used only by the shadowed tile at `:50` and the `#Preview` at `:263`; `JunoChoiceCard` (`:80`) and its `EmptyView` extension (`:156`) only at `:249`; `JunoResponseStyle` (`:187`) is superseded by `DesktopResponseStyle` (`macOS/.../DesktopSettingsScreen.swift:478`), which is what the Mac renders (`:633, 636, 645`).

Worse than dead code: this is the exact failure the design system exists to prevent. The two tiles can drift apart and nothing will notice.

#### Whole files, reachable only from their own tests (zero production references)

| File | Lines | Public types | Only consumer |
|---|---|---|---|
| `Packages/JunoNativeKit/Sources/JunoChatKit/ChatStreamReducer.swift` | 210 | `ChatStreamPhase:4`, `ChatToolPhase:21`, `ChatToolState:28`, `ChatStreamEvent:40`, `ChatStreamApplyResult:63`, `ChatStreamReducerError:68`, `ChatStreamState:76` | `Tests/JunoChatKitTests/ChatStreamReducerTests.swift` (43 lines) |
| `Packages/JunoNativeKit/Sources/JunoVoiceKit/VoiceSessionState.swift` | 107 | `VoicePermission:3`, `VoiceSessionPhase:9`, `VoiceSessionEvent:20`, `VoiceSessionTransitionError:32`, `VoiceSessionState:39` | `Tests/JunoVoiceKitTests/VoiceSessionStateTests.swift` (35) |
| `Packages/JunoNativeKit/Sources/JunoAPI/APIErrorEnvelope.swift` | 123 | `APIErrorEnvelopeValidationError:4`, `APIErrorCode:10`, `APIErrorEnvelope:47` | `Tests/JunoAPITests/APIErrorEnvelopeTests.swift` (28) |
| `Packages/JunoCode/Sources/JunoCodeBridge/CodeContractsBridge.swift` | 105 | `CodeContractsBridge:9` | `Tests/JunoCodeBridgeTests/CodeContractsBridgeTests.swift` (76) |
| `Packages/JunoNativeKit/Sources/JunoCodeKit/RemoteEventTimeline.swift` | 88 | `CodeTaskPhase:3`, `CodeRemoteEventPayload:12`, `CodeRemoteEvent`, `CodeRemoteApplyResult:38`, `CodeRemoteTimeline:43`, `CodeRemoteTimelineError` | `Tests/JunoCodeKitTests/CodeContractsTests.swift:30` |

`ChatStreamReducer` is the sharpest of these: it is a complete, tested SSE state machine sitting unused beside the live ad-hoc streaming logic inside `NativeConversationModel`. Either it was superseded and should go, or it is the better design and should be adopted — carrying both is the worst option.

`RemoteEventTimeline` has a naming near-collision worth noting: `CodeRemoteTimeline` (dead) sits beside the live `CodeRemoteBrowserModel`/`CodeRemoteSessionSummary` in `JunoCodeKit/CodeRemoteBrowserModel.swift`, which is what `DesktopCodeRemoteCanvas` actually uses.

#### Single-occurrence symbols (the declaration is the only hit in the repo)

| Symbol | Location |
|---|---|
| `CodeDraftModel` (public `@Observable final class`) | `Packages/JunoCode/Sources/JunoCodeUI/Models/CodeDraftModel.swift:15` |
| `CodeModelResolutionError` | `Packages/JunoCode/Sources/JunoCodeBridge/BackendCodeModelClient.swift:25` |
| `JunoThinkingSlider` | `Packages/JunoNativeKit/Sources/JunoChatKit/JunoModelViews.swift:151` |
| `JunoGlassButtonStyle` | `iOS/JunoMobile/App/JunoMobileChrome.swift:277` |
| `SessionID` typealias (+ `SessionIDTag:65`) | `Packages/JunoNativeKit/Sources/JunoCore/Identifiers.swift:72` |
| `MutationID` typealias (+ `MutationIDTag:68`) | `Packages/JunoNativeKit/Sources/JunoCore/Identifiers.swift:75` |
| `DesktopUsageModelTotals` typealias | `macOS/JunoDesktop/App/DesktopUsageModel.swift:14` |
| `DesktopUsagePace` typealias | `macOS/JunoDesktop/App/DesktopUsageModel.swift:16` |

`CodeDraftModel.swift` (102 lines) is the only file in `native/` where **no** declared symbol — type, top-level function or extension method — is referenced anywhere outside itself. `JunoThinkingSlider` is a near-duplicate of the live `JunoThinkingControl`; `JunoModelViews.swift:143` uses `JunoThinkingPanel` instead. `AccountIDTag`/`DeviceIDTag`/`RequestIDTag`/`InstallationIDTag` are all alive (315/24/5/13 references) — only the `Session`/`Mutation` pair is dead.

Partially dead: `CodeModelProvider` (`BackendCodeModelClient.swift:20`) and `CodeModelProviderResolver.provider(for:)` (`:65`) are exercised only by `BackendCodeModelClientTests.swift:390-392`; the doc comment at `:19` concedes this ("retained as a compact presentation/testing surface").

#### **L-32 — the `NEXT` compilation condition is defined and read by nothing**
`native/Config/Next.xcconfig:4`

`SWIFT_ACTIVE_COMPILATION_CONDITIONS = NEXT` is set for both `-Next` configurations, and there is **not one `#if NEXT`** anywhere in the repo — I confirmed by grepping `NEXT` across all Swift sources and getting zero hits. Both `project.yml` files define a `Next` build config and a `JunoDesktop-Next`/`JunoMobile-Next` scheme (`macOS/JunoDesktop/project.yml:120-131`) that compile with a flag nothing reads. The `Next` channel is still meaningful at runtime (`JUNO_CHANNEL`, `Info.plist:27-28`, and the updater refuses non-`stable` builds at `DesktopUpdater.swift:124-126`), so the configuration should stay — but the compilation condition is inert and reads as a feature that exists.

The complete `#if` inventory for `native/`, for reference: `DEBUG` (67), `os(macOS)` (17), `canImport(UIKit)` (11), `os(iOS)` (9), `canImport(AppKit)` (8), `canImport(AppKit) && !targetEnvironment(macCatalyst)` (2), `targetEnvironment(simulator)` (1, `JunoMobileCameraService.swift:103`), `canImport(Speech) && canImport(AVFoundation)` (1), `canImport(AVFoundation) && canImport(Speech)` (1), `!os(macOS)` (1). Nothing else is custom.

#### **L-33 — one deprecation, with zero call sites**
`Packages/JunoNativeKit/Sources/JunoDesignSystem/JunoDesignTokens.swift:96` — `@available(*, deprecated, renamed: "page") public static let spacious: Double = 32`. `JunoSpace.spacious` has no callers. (The other `spacious` in the tree, `JunoCodeUI/Theme/JunoCodeTheme.swift:81`, is a distinct `JunoCodeSpace.spacious` and is live.) The only other `@available(*, deprecated` match is a string literal inside preview fixture data at `CodePreviewFixtures.swift:1119`.

### 8.2 Verified NOT dead — recorded to prevent false positives

- **Zero orphaned files.** Every `.swift` file under `native/` is in a declared target. Every directory under `Sources/` and `Tests/` maps 1:1 to an SPM target; every app-tree `.swift` file appears in the corresponding generated `.pbxproj`. The only files outside a target are the two `Package.swift` manifests.
- **Zero `V2`/`Legacy`/`Old`/`Deprecated`/`Experimental`/`_backup`/`.bak` files or types.** The `JunoMacV2` / legacy-`JunoMac` split recorded in project memory is **not present in this tree**. The only `Legacy` hits are the live `isLegacy` model-lifecycle flag (`NativeChatAPIClient.swift:96`, `JunoModelCatalog.swift:237`) and its `expandedLegacy` UI state; the only `V2` is a doc citation in a comment at `DesktopCodeWorkspace.swift:223`.
- **Zero `TODO`, `FIXME`, `HACK`, `XXX` or `WORKAROUND` comments** in any `.swift`, `.yml`, `.sh`, `.xcconfig`, `.json` or `.md` file under `native/`. The only textual matches are parser inputs and fixture identifiers (`SlashCommandTests.swift:56`, `NativeMessageContentTests.swift:68,81,82,262,267,268`). There is no backlog buried in comments — genuinely unusual.
- **Asset catalogs are clean.** All 15 `provider-*` and all 6 `connector-*` imagesets map to live IDs. Assets resolve by string interpolation (`"nav-\(rawValue)"` at `JunoBrand.swift:100`, `"provider-\(providerID.lowercased())"` at `JunoModelMarks.swift:43`, `"connector-\(connectorID.lowercased())"` at `JunoConnectorMarks.swift:102`), so the generated `.camelCase` symbols from `ASSETCATALOG_COMPILER_GENERATE_SWIFT_ASSET_SYMBOL_EXTENSIONS` (`Config/Base.xcconfig:27`) are never used — both spellings were checked. The 21 `nav-*` imagesets match `JunoIcon`'s 21 cases exactly.
- **Every persisted feature flag is genuinely two-valued** — none is always-on or always-off: `juno.desktop.library-view` (`DesktopLibraryScreen.swift:79`), `juno.mobile.composer.web-search` (`JunoMobileAttachmentMenu.swift:192`), `juno.mobile.composer.canvas` (`JunoMobileComposerTools.swift:45`), `NativeCodeModel.targetKey`/`.targetlessKey` (`NativeCodeModel.swift:47,71`), `computerUseEnabled` (default `false` at `SessionModels.swift:136`, flipped at `SessionController.swift:1044,1052`), `JunoPreviewEnvironment.isActive` (`--juno-ui-preview`, `#if DEBUG`). `juno.code.deviceId` (`DesktopCodeHost.swift:72`) is an identifier, not a flag.
- **`JunoPreviewSupport`** looks dev-only but is a real dependency of both apps (`macOS/JunoDesktop/project.yml:52-53`, `iOS/JunoMobile/project.yml:50-51`) with every symbol `#if DEBUG` (`JunoNativeKit/Package.swift:20-22`).

### 8.3 Candidates, unverified

1. **`JunoIcon.file` and `JunoIcon.refresh`** (`JunoDesignSystem/JunoBrand.swift:99`) plus their four imagesets (`macOS/.../Navigation.xcassets/nav-{file,refresh}.imageset`, `iOS/.../Assets.xcassets/Navigation/nav-{file,refresh}.imageset`). All 60 `JunoIcon` reference sites and all five icon-mapping switches (`DesktopChatWorkspace.swift:521`, `DesktopCodeStudio.swift:1203`, `DesktopCodeWorkspace.swift:1266`, `JunoMobileSection.swift:41`, `JunoMobileRootView.swift:1140`) were read; neither case is ever constructed. **Not called dead** because `JunoIcon` is `CaseIterable`, `Tests/JunoDesignSystemTests/JunoBrandTests.swift:42` iterates `allCases` asserting each asset exists, and the cases are a deliberate 1:1 mirror of the web's `src/lib/app-icons.ts` regenerated by `scripts/generate-native-icons.mjs`. **To confirm:** check whether `src/lib/app-icons.ts` draws `file`/`refresh` on the web — if it does, keeping them is intentional parity.
2. **`LocalSearchIndexing` + `InMemoryLocalSearchIndex`** (`JunoSearch/LocalSearchIndex.swift:93` and `:104`, ~195 of the file's 299 lines). `SearchDocument:4`, `SearchIndexUpdate:29` and `SearchNormalizer:66` are live (`NativeSearchStore.swift:68,95,98,100,294`); the protocol has zero references outside its file, `InMemoryLocalSearchIndex` is referenced only by its 208-line test, `LocalSearchResult:34` appears only in a *comment* at `DesktopSearchScreen.swift:312`, and `LocalSearchError:59` is test-only. The doc at `:99` says "Production apps must inject a protected account-scoped index" — **no production type conforms to `LocalSearchIndexing`**. **To confirm:** a product-intent call — unfinished scaffolding for a planned encrypted index (keep) or abandoned (delete)?
3. **`InMemoryTransactionalStore`** (`JunoStorage/InMemoryTransactionalStore.swift`) — 17 external references, **all** in `Tests/`. Not dead, but a test double shipping in `Sources/`, so it links into both release binaries. Same question applies to `InMemoryMutationOutbox` (`MutationOutbox.swift:242`), which self-describes as test-only (`:237-241`) — and whose production replacement is M-11. **To confirm:** move both into a test-support target.
4. **The `featureFlags` bootstrap channel.** The contract requires it (`contracts/openapi/juno-native-v1.yaml:739`), the server always returns `{}` (`src/app/api/v1/bootstrap/route.ts:39`), three native test fixtures carry it (`NativeBootstrapClientTests.swift:124`, `NativeSyncModelPhaseTests.swift:170`, `NativeSyncCoordinatorTests.swift:84`) — but `JunoNativeContract.swift` has **no `featureFlags` field** and no native code reads one. An always-empty flag channel with no client. **To confirm:** whether the web consumes it; only the route's hardcoded `{}` was checked.
5. **`NativeSyncCoordinatorError.repeatedIndexCursor` / `.repeatedCompaction` / `.concurrentWriteLimitExceeded`** (`NativeSyncCoordinator.swift:14-21`) and **`MutationOutboxError.leaseExpired` / `.invalidTransition`** (`MutationOutbox.swift:156-157`) — thrown, but possibly never matched by any caller. **To confirm:** grep each case in `catch`/`if case` position rather than by name.
6. **`AuthTokenCoordinator.refreshWaiterCount`** (`AuthTokenCoordinator.swift:228-230`) — internal; if `AuthTokenCoordinatorTests` does not read it, it and the `waiterCount` field (M-7) are both dead.
7. **The orphaned localization keys** from M-16: the 17 plain keys are confidently dead; treat the 14 format-string keys as unverified, since they may be reachable through runtime `String(format:)` composition.

### 8.4 Suggested deletion order

1. `JunoSettingsPrimitives.swift` — 267 lines, 4 public types, shadowed (M-26)
2. `ChatStreamReducer.swift` + test — 210 + 43 *(decide first: adopt or delete)*
3. `APIErrorEnvelope.swift` + test — 123 + 28
4. `VoiceSessionState.swift` + test — 107 + 35
5. `CodeContractsBridge.swift` + test — 105 + 76
6. `CodeDraftModel.swift` — 102
7. `RemoteEventTimeline.swift` + the `CodeContractsTests.swift:30` block — 88
8. The 6 remaining single-occurrence symbols + `SessionIDTag`/`MutationIDTag`
9. `SWIFT_ACTIVE_COMPILATION_CONDITIONS = NEXT` (L-32)
10. `JunoSpace.spacious` (L-33)

### 8.5 Repository hygiene

**L-13** — `macOS/JunoDesktop/JunoDesktop.xcodeproj/project.pbxproj` and its iOS counterpart are committed (`git ls-files` confirms) despite being fully generated by `native/Scripts/generate-projects.sh` from `project.yml`. Either gitignore them (and document that XcodeGen is required to open the project) or drop the generator — carrying both guarantees merge noise and a stale-pbxproj failure mode. The rest of the ignore configuration is correct: `native/Packages/*/.gitignore:1` and root `.gitignore:60-65` exclude `.build/`, `xcuserdata/` and `Generated-Build.xcconfig`, and none of those are tracked.

**L-14** — no `onOpenURL` / `application(_:open:)` handler exists, yet both `Info.plist` files register the `com.liammagnier.juno` URL scheme (`macOS/.../Info.plist:29-41`, `iOS/.../Info.plist:29-41`). That is intentional — `ASWebAuthenticationSession` claims the callback in-process — and is the *safe* configuration. Worth a comment in both plists so a future contributor does not add an unvalidated handler and assume the scheme was already validated somewhere.

---

## 9. Full finding index

**High (7)**
| # | Finding | Location |
|---|---|---|
| H-1 | macOS Keychain items land in the legacy keychain; `kSecAttrAccessible` ignored | `JunoAuth/KeychainAuthTokenStore.swift:159-169` |
| H-2 | Updater does not re-verify the staged bundle before the swap; installer script is user-writable | `macOS/.../DesktopUpdater.swift:311-360` |
| H-3 | `full access` runs interpreter one-liners unprompted; documented workspace invariant is false | `JunoCodeCore/PermissionModel.swift:112-113`, `CommandClassifier.swift:187-193` |
| H-4 | Brace/glob expansion escapes the `rm` forbidden tier and the escaping-path check | `JunoCodeCore/CommandClassifier.swift:253-276`, `:468-499` |
| H-5 | macOS app declares `fr` and ships no catalog; 540 literals unlocalized | `macOS/JunoDesktop/project.yml:7-9` |
| H-6 | Package `String(localized:)` renders raw keys on macOS (44 call sites, no `bundle:`) | `JunoChatKit/NativeScheduledTaskStore.swift:18-21` |
| H-7 | Thinking "Off" is inert for Sonnet 5, GPT-5.5/5.6, GLM and Qwen in Juno Code | `JunoCodeBridge/CodeThinkingWire.swift:134-140`, `:195` |

**Medium (26):** M-1 `DevServerService` bypasses `PermissionPolicy` (`DevServerService.swift:132-141`) · M-2 artifact CSP bypass via commented `<html` (`NativeArtifactPreview.swift:193-197`) · M-3 `Shell.capture` undrained stderr, no timeout (`DesktopUpdater.swift:596-619`) · M-4 detached DMG detach in `defer` (`DesktopUpdater.swift:244`) · M-5 `kill(-pid)` TOCTOU (`CommandExecutionService.swift:169-180`) · M-6 `unauthorizedFlights` never cleared on success (`AuthTokenCoordinator.swift:110-118`) · M-7 `waiterCount` never decremented (`AuthTokenCoordinator.swift:127`) · M-8 six swallowed `saveConversation` failures (`AgentOrchestrator.swift:399,420,441,462,534,756`) · M-9 divergent cursor validation (`CursorPageApplier.swift:190-196`) · M-10 nine god files (§3.4) · M-11 durable outbox wiring unverified · M-12 CI runs no iOS unit tests and no UI tests (`native.yml:207-232`) · M-13 timing-based test flakiness (`WorkbenchModelTests.swift:251+`) · M-14 generated contract covers 8 of 61 schemas (§6.0) · M-15 format-specifier drift defeats 14 keys (`JunoMobileWorkspaceViews.swift:1101`) · M-16 31 orphans, 5 missing, ~1,030 unextracted literals · M-17 split key-naming scheme · M-18 no localization CI gate · M-19 server `CONTRACT_VERSION` outside CI (`src/lib/api-v1.ts:6`) · M-20 `folder.*` mutations unimplemented natively (`NativeConversationStore.swift:330-377`) · M-21 Responses-API routing inferred from a substring (`BackendCodeModelClient.swift:102-104`) · M-22 agent tool schemas diverge between runner and Swift (`Tools/CommandAndTestTools.swift:15-25`) · M-23 `MESSAGE_DISPLAY_COLLAPSE_CHARS` missing natively (`src/lib/prompt-limits.ts:18`) · M-24 `accents.ts:6` coral disagrees with the CSS it claims to mirror · M-25 `<juno:*>` parser gaps: artifact id hash, type normalisation, speech cleanup (`NativeMessageContent.swift:49,35,123-133`) · M-26 `JunoSettingsPrimitives.swift` wholly shadowed by an app-local duplicate (`JunoMobileSettingsView.swift:588`).

**Low / nit (33):** L-1 `WorkspaceAccess.bookmarkNeedsRefresh` mutable under `@unchecked Sendable` (`WorkspaceAccess.swift:28`) · L-2 poller loop lacks `guard let self` (`DesktopUpdater.swift:98-103`) · L-3 `preconditionFailure` on corrupt SQLite (`SQLiteAccountRepository.swift:274,326,474`) · L-4 URL force-unwrap of a constant (`DesktopCommands.swift:116,120`) · L-5 three force-unwrapped fixture URLs (`JunoAIcssSearch.swift:192-194`) · L-6 `cursor!` in a loop (`NativeSyncCoordinator.swift:142,168,170`) · L-7 `UpdateGoalTool` unwraps model input on a non-local invariant (`UpdateGoalTool.swift:155-189`) · L-8 per-call `ISO8601DateFormatter` allocation (`NativeSyncAPIClient.swift:339-363`) · L-9 `git -C` as final argument falls through to `.execute` (`CommandClassifier.swift:292-295`) · L-10 non-POSIX option/operand split in `classifyRemove` (`CommandClassifier.swift:254`) · L-11 `Thread.sleep(4)` in a UI test (`JunoMobileDictationUITests.swift:77`) · L-12 the artifact diff engine has no tests (`DesktopArtifactsScreen.swift:1652-1862`) · L-13 generated `.pbxproj` committed alongside its generator · L-14 URL scheme registered with no handler and no comment saying why · L-15 `Text(verbatim:)` glyphs (4 sites, §7.1) · L-16 hardcoded default title `"New chat"` (`NativeConversationStore.swift:686`) · L-17 SPM platform floors (macOS 14 / iOS 17) sit below the app floors (macOS 26 / iOS 18), so `swift test` exercises a configuration that never ships (`JunoNativeKit/Package.swift:6-8`) · L-18 iOS CI needs `SWIFT_COMPILATION_MODE=wholemodule` as a toolchain-crash workaround (`native.yml:209-229`) · L-19 `ENABLE_USER_SCRIPT_SANDBOXING = YES` is inert — no run-script phases exist (`Config/Base.xcconfig:5`) · L-20 `sampleLineCount` samples UTF-8 bytes vs the web's UTF-16 units (`NativePromptLimits.swift:55-58`) · L-21 web thresholds live as bare literals in components, not in `prompt-limits.ts` · L-22 native markdown has no maths and no syntax highlighting (`JunoMarkdown.swift`) · L-23 `formatContext` returns `200K` vs the web's `200k`, and the doc comment claims parity (`JunoModelCatalog.swift:321-332`) · L-24 effort labels differ three ways (`NativeThinkingScale.swift:51-59`) · L-25 `panel` radius is 16 in Swift, 28 in Tailwind (`JunoDesignTokens.swift:103-124`) · L-26 motion tiers share names, share no numbers (`JunoDesignTokens.swift:132-138`) · L-27 `customInstructions` capped at 200k natively, unbounded server-side (`NativeMemorySettingsStore.swift:381`) · L-28 three connector ids in the mark table do not exist (`JunoConnectorMarks.swift:146-151`) · L-29 iOS shows personality names with no descriptions (`JunoMobileSettingsView.swift:644-646`) · L-30 the contract describes two routes native never calls (`juno-native-v1.yaml:315,529`) · L-31 `sync-models.yml:123` points at a `ModelCatalog.swift` that does not exist · L-32 the `NEXT` compilation condition is read by nothing (`Config/Next.xcconfig:4`) · L-33 one deprecation with zero call sites (`JunoDesignTokens.swift:96`).

---

## 10. What is genuinely good

Worth stating plainly, because the finding list above is longer than the risk it represents.

The auth stack (PKCE, correlation values, single-use callback validation, coalesced refresh with generation fencing, one-shot resume latch) is production-grade and better than most shipped OAuth clients. The sync layer's wire validation — type allowlist, ordering, duplicate detection, cursor canonicalisation, revision monotonicity, attachment-URL stripping — treats the server as untrusted, which almost no first-party client does. The transport is cookie-free, ephemeral, redirect-refusing and byte-capped. There is zero logging, so there is zero log-leak surface. There are no force unwraps on network or model data, no `try!`, no `fatalError`, one safe `as!`. Task lifecycle and cancellation are handled correctly in every one of the ~15 models that own one. The whole tree is Swift 6 strict concurrency with warnings-as-errors in CI. And the comments explain *why* — including several that document a bug that was fixed and the reasoning that fixed it, which is the rarest thing in this list.

The pattern in the findings is consistent and worth naming: **the parts of the system that were designed as boundaries are excellent; the parts that were designed as heuristics standing in for boundaries are where the gaps are.** `WorkspaceAccess` canonicalises and prefix-checks — that is a boundary, and it holds. `CommandClassifier` pattern-matches a shell string — that is a heuristic, and H-3 and H-4 walk past it. The fix in both cases is to move the check to where the boundary already exists rather than to add more patterns.
