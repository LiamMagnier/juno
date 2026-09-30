# Audit: native macOS + iOS/iPadOS architecture and parity

Phase 0, read-only. Worktree `juno-refoundation` @ `1feb392c` (main, "Release Juno for Mac 1.9.3 (build 94)"), 2026-09-30.
The commands run were greps, reads, `--check` modes of the Node sync gates, `codesign`/`spctl` against the installed app, `gh run`/`gh release` and `curl` against the public update feed. No Swift, Xcode or tsc builds were run. Anything not observed directly is marked **UNVERIFIED**.

---

## 0. Decision-relevant facts (read this first)

1. **CI has not run since about 2026-09-22.** Every `native.yml` run on main since then shows "failure" with zero steps executed. The job annotation reads: "The job was not started because recent account payments have failed or your spending limit needs to be increased" (the run for `1feb392c` on 2026-09-30). The last successful `native.yml` run was 2026-09-22T16:30Z. As a result, none of the parity, contract, design, Swift package or app-build gates described below are enforced right now.
2. **Two sync gates fail on main today**, run locally with `node scripts/check-native-sync.mjs`:
   - `native:parity:check` fails with 8 errors: `/api/agents/[id]/starter`, `/api/agents/hire-draft`, four `/api/mcp/servers*` routes and `/api/skills/import/file` are unclassified, and `/api/agents/[id]/duplicate` is marked "planned" although the Swift calls it.
   - `design:tokens:check` fails too, but the only drift is the digest. Regenerating into scratch changes one line, `tokens-digest: 8a2d68420d2a1942 → 94a5454b2bf5ac4d`, and no token values move. The cause is that the digest hashes the whole `globals.css` (`scripts/generate-design-tokens.ts:349-354`), so any non-token CSS edit trips the gate. The agents CSS and the voice-button CSS were such edits.
3. **The Mac release gate is thin.** `native/Scripts/release-macos.sh:269` runs only `JunoVoiceKitTests` from the packages, then `JunoDesktopTests` (`:277`) and `scripts/release-gates.sh`. `deploy/deploy-from-mac.sh:150` runs only `capabilities:check` from the native contract family. With CI down, nothing blocks a release when parity, tokens, icons, the wire contract, JunoCode or JunoWork tests, or the iOS build regress.
4. **Signing reality has changed since the brief and since memory.** The Mac now has **1 valid identity**, "Apple Development: liam.magnier25@icloud.com (8RSCGS63QP)". Memory from 2026-09-22 said 0. `/Applications/Juno.app` is **1.9.2 (93)**, signed Apple Development with team `58PVP763WX` and hardened runtime. `spctl -a` → **rejected**, and there is no stapled ticket. It is not ad-hoc signed, and there is no Developer ID and no notarization.
5. **The feeds are behind main.** The public feed serves stable = **1.6.0** (`notarized: false`) and next = **1.9.2**. Main carries a bump to **1.9.3/94** (`native/Config/Base.xcconfig:8-9`) with the Agents native redesign (`73406344`), but tag `v1.9.3` and its GitHub release do not exist. The iOS row says "On the App Store soon", and iOS has never shipped: `release-ios.yml` has no runs.
6. **The product shells disagree.** Web and Mac have two products, Chat and Code (`contracts/product/juno-shell-v1.json` `products`; `DesktopProductMode.swift:12-13`). The iPhone tab bar has **Chat, Code, Work and Search** (`JunoMobileRootView.swift:561-591`), and iPad ⌘3 still means "Work" (`JunoMobileIPad.swift:79`). The shell contract is projected only to the Mac (`scripts/generate-shell-contract.mjs:35`), so nothing checks the iOS shell.

---

## 1. Map

### 1.1 Targets and packages (Swift lines, approximate, `wc -l`)

| Unit | Path | Size | Platforms | Role |
|---|---|---|---|---|
| JunoDesktop (Mac app) | `native/macOS/JunoDesktop/App` (134 files) | ~69k | macOS 26 | App shell, Chat/Code workspaces, pages, Settings scene, menu bar extra, Quick Entry, updater |
| JunoMobile (iPhone/iPad app) | `native/iOS/JunoMobile/App` (87 files incl. tests) | ~36k | iOS 26 (xcconfig) | Tab shell (phone), split shell (iPad), own composer/transcript/Work/Code-remote |
| JunoMobileWidgets | `native/iOS/JunoMobile/Widgets` | small | iOS | Widgets + Live Activities |
| JunoNativeKit | `native/Packages/JunoNativeKit` | ~118k | macOS 26, iOS 26 (`Package.swift:30-32`) | Core, API, Auth, Storage, Sync, Search, **DesignSystem (27.7k)**, **ChatKit (37.9k)**, CodeKit, VoiceKit, DesignKit, **WorkKit (18.6k)**, PreviewSupport |
| JunoCode | `native/Packages/JunoCode` | ~61k | **macOS 26 only** | Local coding agent: Core, Runtime, Local, Bridge, Simulator, **JunoCodeUI (25.4k, "Studio")** |
| JunoWork | `native/Packages/JunoWork` | ~12k | macOS 14 / iOS 17 (inconsistent floor) | Local Work host: Core, Runtime, Automation, Local (Mac only consumer) |
| desktop-electron | `native/desktop-electron` (225 tracked files) | — | — | A parallel Electron "Chat · Work · Code" desktop app. Its README calls it "early"; last touched 2026-09-23. Not shipped (**dead weight**) |

### 1.2 macOS app shell

- **Entry.** `JunoDesktopApp.swift:268-455`. The scenes are the main `WindowGroup` (`juno.main`, `.windowToolbarStyle(.unified)`, `.containerBackground(Color.junoCanvas, for: .window)`), `CodePreviewScene`, a `Settings` scene (`DesktopSettingsWindow`), "Juno Code Settings", "Keyboard Shortcuts", a Research Report `WindowGroup`, About, Software Update and a `MenuBarExtra`. The AppKit delegate owns the updater, the ⌥Space Quick Entry hotkey, notification routing and APNs registration (`:117-266`).
- **Composition root.** `JunoDesktopConfiguration.live()` (`JunoDesktopConfiguration.swift:155`) builds `NativeAuthRuntime` and then feeds `NativeSyncCoordinator`/`NativeSyncModel` on encrypted SQLite (`SQLiteAccountRepository`) plus `PersistentMutationOutbox`/`NativeMutationDrainer`. From there come `NativeConversationModel(chatClient: NativeChatAPIClient)`, projects, memory, library, artifacts, agents, Work host/relay (`DesktopWorkHostModel`, `NativeWorkClient`) and Code (`WorkbenchModel`, `NativeCodeModel`, remote).
- **Root.** `JunoDesktopRootView.swift:153-190` switches on the auth phase: signed in → `JunoDesktopWorkspaceView`, restoring → loading, otherwise → `JunoDesktopSignInView`. The window always opens on Chat (`:25-43`).
- **Products.** `JunoDesktopWorkspaceView.swift` shows exactly one of `DesktopChatWorkspace` and `DesktopCodeWorkspace` at a time. The comment explains why: two live `NavigationSplitView`s crashed AppKit (`docs/native/MACOS_CRASH_ROOT_CAUSE.md`).
- **Chat window.** `DesktopChatWorkspace.swift:305` is a real `NavigationSplitView` whose sidebar is `DesktopChatSidebar` with `.junoSidebarColumn()`, so the system draws the sidebar glass. Destinations come from `DesktopDestination` (`DesktopChatSidebar.swift:1194-1233`): chat, projects, library, artifacts, agents, connections, memory, assistants, skills, automations and permissions, plus the stored-only values search and design. Page routes are `DesktopPageRoute.swift:15-23` (project, artifact, document, skill, automation, host, agent). The ⌘K panel is `DesktopSearchPanel`.
- **Code window.** `DesktopCodeWorkspace.swift` (session column, thread, inspector side panel) hosts `JunoCodeUI` Studio. `DesktopCodeHost.swift` claims the server's `/api/code/tasks` device queue.
- **Commands and shortcuts.** `JunoShortcutRegistry.swift` has 46 entries. The menu bar (`DesktopCommands.swift`) and the Shortcuts window are both built from it. Examples: ⌘K command menu (`:72`), ⇧⌘F Search, ⌘N/⇧⌘N, ⌘1/⌘2 products (`:145,149`). Sheets also carry ordinary view-level `.keyboardShortcut` calls (default and cancel actions).
- **Settings.** The ⌘, `Settings` scene with panes `DesktopSettings*Pane.swift` (Account, Connectors, Data, Devices, General, Memory, Models, Personalization, Plan, Voice). The rail is checked against the web by the shell contract.

### 1.3 iOS/iPadOS shell

- `JunoMobileSection.swift:5-17` has 11 sections: chat, search, code, work, agents, tasks, projects, library, artifacts, connections, settings.
- **iPhone.** `phoneShell` (`JunoMobileRootView.swift:560-592`) is a system `TabView` with Chat, Code, Work and Search (role `.search`), plus `.tabBarMinimizeBehavior(.onScrollDown)` and a live-run bottom accessory. Everything else sits behind the history drawer (`JunoMobileDrawer.swift`, 1,014 lines) and is pushed on the Chat stack.
- **iPad.** `padShell` (`:604-627`) is one `NavigationSplitView` with a history-list sidebar. The sidebar is painted with **opaque `Color.junoSidebar`** (`:611`), which suppresses the system sidebar glass. Commands live in `JunoMobileCommands` (`JunoMobileIPad.swift:47-85`): ⌘N, ⇧⌘N, ⌘, , ⌘K = Search, and ⌘1/2/3 = Chat/Code/Work.
- The iOS app **does not link JunoCode or JunoWork**. Its Code tab is supervision of cloud and remote sessions (`JunoMobileCodeRemote.swift`, `JunoMobileCodeView.swift`).

### 1.4 Design system and how web tokens reach Swift

| Pipeline | Source | Output | Real? |
|---|---|---|---|
| `scripts/generate-design-tokens.ts` (`design:tokens`) | `src/app/globals.css` + `tailwind.config.ts` | `JunoDesignSystem/Generated/JunoGeneratedTokens.swift` (57 colours, 6 accents, 6 durations, 9 easings, 15 radii, 13 type rungs, 15 spacing) + `src/lib/design/tokens.generated.ts` | **Real.** `JunoColors.swift` reads `JunoGeneratedColors` 57 times. Hard-coded colours appear only in fixtures and a few one-offs (`InlineArtifactCard.swift`, `JunoMobileIncognito.swift`). |
| `scripts/generate-native-icons.mjs` | web icon registries (`app-icons.ts`, `icons.tsx`) | 411 symbol sets (391 Phosphor, 20 Juno) in both apps' `Icons.xcassets` | Real, and passes. |
| `scripts/generate-shell-contract.mjs` | `contracts/product/juno-shell-v1.json` (the web shell) | `native/macOS/JunoDesktop/App/Generated/JunoShellContract.swift` | Real, **Mac only**. |
| `scripts/generate-design-contract.ts` | Design document zod schemas | `contracts/design/design-document.v1.schema.json` | Real (for the web design editor/JunoDesignKit). |
| `scripts/generate-capability-contract.mjs` | `contracts/capabilities/juno-capabilities-v1.json` | `JunoCore/Generated/JunoCapabilityContract.swift` (reasoning levels, capability flags, 9 degradation kinds) | Real, and deploy runs it. |
| `work:contract` | `contracts/work/juno-work-v1.json` | `JunoCore/Generated/JunoWorkContract.swift` (25 vocabularies) | Real. |
| `scripts/generate-native-swift-contract.mjs` | `contracts/openapi/juno-native-v1.yaml` (5,472 lines, 121 paths) | `JunoAPI/Generated/JunoNativeContract.swift` (2.5 KB) | **Nominal.** The "generated" Swift is a template literal in the script (`:23-33` onward) with ~9 auth/bootstrap/changes DTOs. It checks for required fragments and pins a digest. About 342 other `Codable` DTOs across native are hand-written, so the OpenAPI does not generate the models the apps actually decode. |
| chat wire (`generate-chat-wire-contract.ts`) | `contracts/chat/juno-chat-wire-v1.schema.json` + status | classification ledger | A ledger rather than generated code: 159 native, 65 planned, 32 web-only fields. "Native" means "some Swift literal encodes or decodes it". Mac and iOS are not distinguished. |

Other design-system facts:
- **Fonts.** Newsreader (24pt Regular/Medium/SemiBold plus the variable Italic) is shipped from `native/iOS/JunoMobile/Resources/Fonts` and shared into the Mac bundle through `project.yml`. SF Pro stands in for Inter and SF Mono for JetBrains Mono (`JunoTypography.swift:19,61-65`).
- **Glass primitives.** `JunoMaterials.swift` (`junoFloatingGlass`, `JunoGlassBackground`, `junoProminentAction` → `.buttonStyle(.glassProminent)`) and `JunoDesktopChrome.swift:290-400` (`junoGlass` = `.glassEffect(.regular.tint().interactive())`, `junoFloatingChrome`, `junoGlassID`, `junoGlassButton` = `.buttonStyle(.glass)`). iOS keeps a **duplicate** set in `JunoMobileChrome.swift:326-392`.
- **Signature effects.**
  - `JunoVoiceGlow` (Mac composer, iOS voice view), plus `JunoVoiceAura` and `JunoVoiceOrb` (iOS full-screen voice only, `JunoMobileVoiceFullScreen.swift:36,180`).
  - `JunoBorderBeam` (Mac `ChatComposer.swift:1553`, `StudioComposer.swift:126`).
  - `JunoAgentFace`/`JunoAgentPresence`: the agent face rig with a breathing radial halo (`JunoAgentPresence.swift:14-37,64`).
  - `JunoShimmerText`, 15 uses.
  - The `JunoAIcss*` family, ported from aicss.dev (`JunoAIcssShine.swift:4-18`).

### 1.5 Liquid Glass usage (counts of direct calls; most sites go through the wrappers)

| | Mac app | iOS app | NativeKit | JunoCode |
|---|---|---|---|---|
| `.glassEffect(` | 2 | 2 | 5 | 0 |
| `GlassEffectContainer` | 3 | 4 | 5 | 0 |
| `.buttonStyle(.glass` / `.glassProminent` | 1 / 0 | 5 / 1 | 3 / 2 | 0 |
| `junoGlass(` wrapper | 15 total | | | |
| Legacy `Material` fills (`.thinMaterial`, `.ultraThinMaterial`, `.bar`) | 2 (`DesktopLibraryPicker.swift:90,147`) | 6 (`JunoMobileAttachmentChips.swift:65`, `JunoMobileVoiceCamera.swift:292,330`, `JunoMobileRootView.swift:1614`, `JunoMobileSettingsView.swift:955,974`) | 0 | 0 |
| `NSVisualEffectView` | 0 | 0 | 0 | 0 |

The ratchet `scripts/check-native-glass.mjs` enforces the Mac's "five glass sites" rule (composer cluster, ⌘K panel, find bar, toast host, Quick Entry). It reports **19 violations today against a baseline of 24**; the baseline has not been lowered. The sites are:
- iOS content cards: `JunoMobileWorkView.swift:1123,1203,1393`.
- Loose glass with no container: `JunoMobileCodeView.swift:666,1873`, `JunoMobileDictation.swift:168,231`.
- Mac glass outside the five sites: `DesktopCodeWorkspace.swift:1475,1482`, `DesktopDictation.swift:157,217`, `DesktopVoice.swift:860`, `CodePreviewWindow.swift:1637,2094`.
- A glass button inside a content card: `NativeChatApprovalView.swift:92`.

The other ratchets are type 0, motion 0, targets **197**, prominent 9 and menus 3 (`node scripts/check-native-design.mjs`).

### 1.6 Every WKWebView

| # | File | What it shows | Justified? |
|---|---|---|---|
| 1 | `JunoCode/.../Views/Preview/CodePreviewWindow.swift:430-965` | The user's local dev server in a preview window, with scripted browser actions | **Yes.** It is a browser preview by definition. |
| 2 | `JunoChatKit/ArtifactCanvasView.swift:1198` | Full artifact canvas (HTML/React) | **Yes.** It runs user or model HTML and JS, is non-persistent, and has network closed (`NativeArtifactRuntimeWebView.swift:418` `isOpen = false`). |
| 3 | `JunoChatKit/NativeArtifactPreview.swift:483` | Inline artifact preview in the transcript | Yes, same reason. It costs one web view per inline preview. |
| 4 | `JunoChatKit/NativeArtifactRuntimeWebView.swift:32-113,500` | React 18/Babel/Tailwind Play runtime over `juno-runtime://` from `Resources/ArtifactRuntime` (7.3 MB) | Yes on the Mac. **On iOS the bundle is not shipped**: `iOS/JunoMobile/project.yml` resources have no `ArtifactRuntime`, so the root is `nil` (runtime result **UNVERIFIED**). |
| 5 | `JunoDesignSystem/MermaidDiagramView.swift:410` | One WKWebView per ```` ```mermaid ```` fence | Acceptable, but the engine is registered **only on the Mac** (`JunoDesktopApp.swift:289`). iOS never calls `JunoMermaidEngine.register`, so the iPhone shows diagram source. |
| 6 | `JunoWorkKit/Agents/Views/NativeAgentComputerView.swift:384-430` | The agent's cloud computer (Watch or Take control) through a one-time `/computer-view?c=…` handoff | Justified for now: a native VNC/stream client would be a project of its own. It is non-persistent and pinned to the app's origin. |
| 7, 8 | `macOS/.../DesktopDesignEditorHost.swift:86-103`, `iOS/.../JunoMobileDesignEditorHost.swift:78-95` | The web's Design editor, bundled (`Resources/DesignEditor`, 1.6 MB, built by `npm run design:editor`) | Pragmatic but **not native**: a whole web editor inside the app. The ledger lists `/api/design/[artifactId]/edit` and `/transactions` as planned, so the native host lacks Ask Juno and transactional commits. |
| — | `JunoMathMarkup.swift` | LaTeX converted to Unicode in Swift, deliberately without WebKit | Not a web view, but it is a **parity gap**: the web typesets KaTeX while native does flat Unicode (`∫₀^∞`). |
| — | `JunoMobileWebFlow.swift` | `SFSafariViewController`, not a WKWebView (it shares Safari cookies) | Fine. |

### 1.7 Parity contract: how it works and what it enforces

| Gate | Checks | Fails when | Runs where |
|---|---|---|---|
| `native:parity:check` (`scripts/parity-ledger.mjs`) | Every `src/app/api/**/route.ts` and `src/app/(app)/**/page.tsx` has a status in `contracts/parity/features.json`, and `docs/native/PARITY_MATRIX.md` equals the rendered ledger | A route or page is unclassified or gone; a "native" route has no Swift string literal; the Swift names a non-native route; the matrix is stale (`:152-182, 402-419`) | CI `parity` job (dead: billing) and `native:sync:check` (manual). **Failing on main now.** |
| `native:wire:check` | Chat request/stream fields classified; "native" fields are encoded or decoded by some Swift | A field is unclassified or a claim is false | CI (dead), manual |
| `native:register:check` | `WEB_TO_NATIVE_DESIGN.md` register #1–#184 is whole and its citations resolve | Numbering gaps or dangling citations | CI (dead), manual |
| `shell:contract:test` + `shell:contract:check` + `DesktopShellContractTests` | The web shell (products, sidebar rows, + menu, Settings rail) matches the contract, and the Mac's generated enums match | Web sidebar/menu drift, or a stale Mac projection | CI (dead), manual, Mac unit tests |
| `native:parity:label` (`native-parity.yml`) | A PR touching mirrored web files carries "native: done/n/a" | The label is missing | **`on: pull_request` only** (`native-parity.yml:25`). Only 4 of 669 commits since 2026-09-01 are PR merges, so it effectively never runs. |
| `capabilities:check` | The Swift capability enum equals the manifest | Manifest drift | deploy-from-mac (**the only native gate that runs today**) |
| `native:design:check` | glass/type/motion/targets/prominent/menus ratchets | A count rises above its baseline | CI `design` (dead), manual |

**Gaps.**
- (a) **Per-platform blindness.** Route status is "a Swift literal exists anywhere" (`parity-ledger.mjs` scans all of `native/`), so a route only the Mac calls counts as native for iOS. Page status does have `mac` and `ios` columns, but they are hand-asserted and the `screen` field is free text nobody verifies.
- (b) **No iPad column.** iPad is folded into "ios".
- (c) **No check on native routes.** Nothing verifies that `DesktopDestination`/`DesktopPageRoute`/`JunoMobileSection` map to live web pages, or that iOS sections match the shell contract.
- (d) **Only one doc is drift-checked**, `PARITY_MATRIX.md`. `docs/native/README.md`, `TESTING.md`, `RELEASE.md` and `MACOS_ARCHITECTURE.md` are not (see §3.4).
- (e) **No enforcing runner.** CI is billing-locked and local release/deploy do not run these gates.
- (f) **The web-capability gate means something narrow.** Web "capabilities" in the sense of a new web feature are caught only if the feature adds a route or page. A client-only web feature, such as a new composer control or an interaction, is caught only through the PR label, which never runs.

Current matrix summary (`PARITY_MATRIX.md`): 262 routes (169 native, 31 planned, 49 web-only, 13 internal). 44 pages: **Mac 33 native, 2 partial, 2 planned, 7 web-only**; **iOS 17 native, 6 partial, 14 planned, 7 web-only**.

### 1.8 Snapshot and visual-QA infrastructure

All suites below are **render-only**: they write PNGs and assert only that the offscreen window drew something (`TranscriptSnapshotRenderer.swift:37`, a "% of pixels differ from the canvas" check). They are **not golden-image regressions**, and they skip unless their env var is set. **There is no offscreen snapshot suite for iOS.** iOS visual QA uses the simulator: `--juno-ui-preview` plus `xcrun simctl io booted screenshot`, and XCUITests such as `JunoMobileIPadCaptureUITests`.

| Suite (target `JunoDesktopTests` unless noted) | File | Env var |
|---|---|---|
| FoundationSnapshotTests | `Tests/Snapshots/FoundationSnapshotTests.swift` | `JUNO_SNAPSHOT_DIR` |
| TranscriptSnapshotTests (2) | `…/TranscriptSnapshotTests.swift` | `JUNO_SNAPSHOT_DIR` (`npm run native:snapshots:transcript`) |
| IntegrationSnapshotTests (4) | `…/IntegrationSnapshotTests.swift` | `JUNO_SNAPSHOT_DIR` |
| PageSnapshotTests, StageBPageSnapshotTests, **PageSnapshotTestsC + AgentsStudioSnapshotTests** (Agents redesign) | `PageSnapshotTests*.swift` | `JUNO_SNAPSHOT_DIR` / `JUNO_FINAL_SNAPSHOT_DIR` |
| OverlaySnapshotTests, SignalsSnapshotTests (+Window), WorkCardSnapshotTests (+Window), WorkStageBSnapshotTests (+Window) | … | `JUNO_SNAPSHOT_DIR` and/or `JUNO_FINAL_SNAPSHOT_DIR` |
| WorkStageDSnapshotTests, ResearchStageBSnapshotTests, SettingsSnapshotTests, ShellContractSnapshotTests, ShortcutsSnapshotTests | … | `JUNO_SNAPSHOT_DIR` |
| FinalSnapshotTests | `FinalSnapshotTests.swift` | `JUNO_FINAL_SNAPSHOT_DIR` |
| PremiumSnapshotTests, PremiumVoiceSnapshotTests, SettingsWindowsSnapshotTests | … | `JUNO_PREMIUM_SNAPSHOT_DIR` |
| DesktopWorkStartPathSnapshots | `Tests/DesktopWorkStartPathSnapshots.swift` | `JUNO_WORK_SNAPSHOT_DIR` |
| **StudioSnapshotTests (11)**, package `JunoCode` | `native/Packages/JunoCode/Tests/JunoCodeUITests/StudioSnapshotTests.swift` | `JUNO_SNAPSHOT_DIR` |

How to run them offscreen. The test host runs as an accessory (`JunoTestHost`, `JunoDesktopApp.swift:21-23`), so nothing appears on screen.

```bash
# Mac app suites (xcodebuild strips TEST_RUNNER_ before the test sees the var)
TEST_RUNNER_JUNO_SNAPSHOT_DIR=/tmp/shots \
TEST_RUNNER_JUNO_FINAL_SNAPSHOT_DIR=/tmp/shots-final \
TEST_RUNNER_JUNO_PREMIUM_SNAPSHOT_DIR=/tmp/shots-premium \
xcodebuild test -project native/macOS/JunoDesktop/JunoDesktop.xcodeproj -scheme JunoDesktop \
  -destination 'platform=macOS' -derivedDataPath "$TMPDIR/juno-snapshots-derived" \
  -only-testing:JunoDesktopTests/PageSnapshotTestsC \
  CODE_SIGN_IDENTITY=- CODE_SIGN_STYLE=Manual DEVELOPMENT_TEAM=
# Studio (package): icons render blank here (asset catalog lives in the app bundle)
JUNO_SNAPSHOT_DIR=/tmp/studio swift test --package-path native/Packages/JunoCode \
  --scratch-path "$TMPDIR/juno-swift-code" --filter StudioSnapshotTests
```

Visual QA should know that the snapshot harness substitutes stills for web views: `junoMermaidStill` (`MermaidDiagramView.swift:10-31`) and `SnapshotArtifactStills.swift`. Artifacts and diagrams are therefore never truly rendered in snapshots.

### 1.9 Build and test commands (current reality)

| Purpose | Command | Notes |
|---|---|---|
| Swift packages | `npm run native:test [JunoNativeKit\|JunoWork\|JunoCode]`, with `JUNO_SWIFT_FILTER=<regex>` | `scripts/native-test.sh`: scratch in `$TMPDIR`, warnings as errors. Known: **2 failures in `JunoTokenConsumptionTests`** on main (per the `73406344` message; not re-run here). |
| Mac build | `xcodebuild -project native/macOS/JunoDesktop/JunoDesktop.xcodeproj -scheme JunoDesktop -configuration Debug\|Stable -destination 'platform=macOS' SWIFT_TREAT_WARNINGS_AS_ERRORS=YES CODE_SIGNING_ALLOWED=NO build` | Stable is required; it catches dead-branch errors. |
| Mac unit tests | `… -only-testing:JunoDesktopTests test` (435 tests per `73406344`) | Do not run `JunoDesktopUITests`: it drives the screen, and the owner declined screen control. |
| iOS unit tests | `xcodebuild -project native/iOS/JunoMobile/JunoMobile.xcodeproj -scheme JunoMobile -configuration Debug -destination 'platform=iOS Simulator,name=Juno Premium iPhone' -only-testing:JunoMobileTests test` | Personal-team signing via the git-ignored `JunoMobile-Local.xcconfig` |
| Regenerate projects | `native/Scripts/generate-projects.sh` (xcodegen) | Commit the regenerated `project.pbxproj`, because the owner opens it directly |
| Web→native gates (Linux-safe) | `npm run native:sync:check` and `npm run native:design:check` | Fast, Node only |
| Preview harness | Mac: launch the Debug `Juno.app` binary with `--juno-ui-preview --juno-preview-tab … --juno-preview-scenario …`; iOS: `xcrun simctl launch booted com.liammagnier.JunoMobile.debug --juno-ui-preview …` | `docs/native/TESTING.md:93` cites a stale path, `./native/macOS/JunoDesktop/.build/debug/Juno`, which does not exist because JunoDesktop is an Xcode project |

### 1.10 Signing and release: RELEASE.md vs reality

| RELEASE.md says | Reality 2026-09-30 |
|---|---|
| "No macOS release has ever been notarized … `v0.15.15` to `v1.5.4`" (`:10-12`) | Still true, but the range is stale. Every release through **v1.9.2** is an unnotarized `--publish-dev` GitHub prerelease. |
| "This machine has an Apple Development identity, but no Developer ID" (`:37`) | True today (1 Apple Development identity). Memory said 0 on 2026-09-22, and the task brief says "ad-hoc". Both are now outdated. |
| The protected `release-macos.yml`/`release-ios.yml` path | Never completed. The Production secrets are absent, and Actions is billing-locked. |
| Update feed | Stable 1.6.0 (`notarized:false`), next 1.9.2. The installed app is 1.9.2/93 and `spctl` rejects it. A fresh download hits Gatekeeper, while installed copies update in place because `DesktopUpdater` strips quarantine. |
| iOS/TestFlight procedure | Nothing has ever been uploaded. The feed shows "On the App Store soon". |

---

## 2. What is real vs placeholder, fake, dead or gated

**Real and working (evidence):**
- Mac shell on native `NavigationSplitView` + `Settings` scene + `MenuBarExtra` + unified toolbar (`JunoDesktopApp.swift:320-449`, `DesktopChatWorkspace.swift:305`).
- A one-table shortcut registry that drives both the menus and the Shortcuts window (`JunoShortcutRegistry.swift`).
- Token projection from `globals.css`. Only the digest drifts.
- The icon pipeline (411 symbols).
- Shell contract projection to the Mac.
- Offscreen snapshot harness (Mac and Studio).
- Offline, CSP-locked artifact runtime on the Mac (`NativeArtifactRuntimeWebView.swift:418`).
- Encrypted store, outbox and sync.
- Agents redesign on Mac and iPhone (`73406344`), unreleased.
- iPhone system `TabView` with `.tabBarMinimizeBehavior` and a Live Activity accessory.

**Nominal or fake:**
- The **OpenAPI → Swift "generation"** (`scripts/generate-native-swift-contract.mjs:23+`) is a hand-written template, so the name overstates what is guaranteed.
- The **design-token gate** fails on any CSS change because of the whole-file digest, which trains people to regenerate blindly.
- **Snapshot "tests" are not regression tests.** They have no reference images.

**Dead code** (no reference outside its own file among the apps and packages, via a grep of type names; some may be used inside their own file or by tests):
- Design system: `JunoStatusDot` (`JunoStatusDot.swift`, a status-dot component the owner rules forbid), `JunoAIcssShine`, `JunoAIcssDiff`/`JunoAIcssDiffRow`, `JunoAIcssTodoList`, `JunoCostMetricsBadge`, `JunoRecentActivityRow`, `JunoRenameSheet`, `JunoLogo`, `JunoProminentButtonStyle`, `JunoGradeBars`, `JunoModelTag`, `JunoStreamingCursor`.
- iOS: `JunoMobileAuraLayer`/`JunoMobileAuraLight` (`JunoMobileGreeting.swift:52,150`), which is never instantiated. Its doc claims to mirror web `.composer-aura`, which no longer exists in `globals.css`. The provider-glow bloom `JunoComposerAura`/`JunoProviderGlow` is reachable only through it.
- JunoCodeUI: `Theme/JunoCodeTheme.swift`, with 6 references in 1 file against 529 uses of `Studio.*`.
- Config: `native/Config/JunoMac-{Debug,Next,Stable}.xcconfig` and `JunoCode-*.xcconfig` are referenced by no `project.yml`.
- Repo: `native/desktop-electron/` (Electron app, 225 files) and the tracked `native/macOS/JunoDesktop/build_log.txt` / `build_pid.txt`.

**Gated or partial:**
- iOS has no Mermaid engine and no bundled artifact runtime (§1.6).
- iOS has no Skills, Assistants, Automations or Permissions pages, and no Upgrade page (ledger).
- Cloud Code on native lacks task detail, steer, pull request, checks, rollback, environments and branches: 13 planned routes (`PARITY_MATRIX.md` "Juno Code").
- The design editor lacks Ask Juno and transactions.
- The computer view is a web sheet, and picture-in-picture was not ported (`73406344`).

---

## 3. Problems

### 3.1 Product and UX coherence
1. **Three product models across four surfaces.** Web and Mac treat Chat and Code as products, with tasks living inside chats (Phase 5). The iPhone keeps a Work tab and a Tasks list (`features.json` "tasks" notes: "The phone keeps its older Work tab"). iPad ⌘3 = Work. The iPhone has no Agents entry in the tab bar, so Agents are reachable only from the drawer.
2. **Chords disagree.** On the Mac ⌘K is the command menu and ⇧⌘F is Search. On iPad ⌘K is Search. The web uses ⌘⇧1/⌘⇧2 for products (shell contract `webChord`), while the Mac and iPad use ⌘1/⌘2. The Mac calls it "Private chat" (⇧⌘N) and the iPad "New Incognito Chat".
3. **Voice differs per platform.** The Mac puts voice in the composer as a glow. The iPhone has both the in-composer glow and a full-screen **aura + orb** (`JunoMobileVoiceFullScreen.swift:36,180`), which the premium pass moved away from.
4. **The iPhone and Mac UIs are largely separate implementations.** Of the public Views in ChatKit, WorkKit and DesignSystem, 24 are used by both apps, 21 by the Mac only and 11 by iOS only. Composer, transcript, Work, settings and code views exist twice: `ChatComposer.swift` is 2,735 lines and `JunoMobileComposer.swift` 1,458. Parity is therefore maintained by hand, and the ledger cannot see drift (§1.7).

### 3.2 Visual: AI-slop, owner-rule violations, Claude resemblance
1. **Owner rule "no status pills".**
   - `JunoCapsuleTag("Recommended")` (`JunoModelSelector.swift:681`) and `JunoCapsuleTag("Smart")` (`:287`) in the model selector, used by the Mac composer chip and Settings › Models. "Recommended" is on the owner's explicit banned list.
   - `JunoMobileVoiceCamera.swift:282-294` is an accent **dot + "Juno can see" in an `.ultraThinMaterial` capsule**. It is a privacy disclosure, so its content is legitimate, but its form is the banned pill-with-dot.
2. **Owner rule "native glass, never faked materials".**
   - Legacy `Material` fills on 8 call sites (§1.5).
   - The iPad sidebar is painted opaque (`JunoMobileRootView.swift:611`), which defeats the system glass the Mac keeps.
   - 19 glass-rule violations remain, including glass on content cards in iOS Work.
3. **Decorative motion and glow.**
   - `JunoBorderBeam` "breathes around an empty new chat's composer until the first keystroke" (`ChatComposer.swift:1548-1563`): a pulsing glow on an idle surface, ported from libraries.dev.
   - The agent halo breathes 0.7→1 opacity every 2.7 s while working (`JunoAgentPresence.swift:28-33`). The owner approved this for the Agents redesign, but it is functionally a pulsing status light.
   - The shimmering "live sentence", `JunoShimmerText` (15 uses), and the `JunoAIcss*` ports.
   - Each is individually justified in comments. Together they are the "sparkles and glow" vocabulary the refoundation rules ban, so they should get one deliberate decision rather than piecemeal survival.
4. **The visual identity reads as a Claude imitation.**
   - The default accent "coral" is `hsl(15 54% 46%)` (`globals.css:82`) ≈ `#B55636`. The widely published Claude "Crail" `#C15F3C` is about `hsl(16 52% 50%)` (Mobbin brand page and others, surfaced by search on 2026-09-30; not an official Anthropic source, so **UNVERIFIED as official**). A second source cites Claude's terra cotta as `#DA7756` (beginswithai.com, published 2024-04-03).
   - The warm-paper background (`hsl(48 24% 97%)` vs the reported "Pampas" `#F4F3EE`) and a serif display face (Newsreader) for a **time-of-day greeting** ("Good evening", "Night owl mode", `JunoGreeting.swift:23-42`) also match. Claude.ai greets with "Good evening, {name}" and "Hello, night owl" in a serif face; see the scraped list at https://gist.github.com/Posandu/e97d3cd20a671749ce7162a2a4f51fee (date not shown, **UNVERIFIED** currency) and https://x.com/dwlz/status/1965495158025114097 (≈ Sept 2025).
   - The sign-in tagline is "Chat and code, in one calm place." (`JunoDesktopRootView.swift:864`).
   - In Code, Studio is intentionally Claude Code-compatible: it reads `.claude/settings.json` hooks, `CLAUDE.md` and `.claude/skills`, and offers "the three choices Claude Code made familiar" (`SessionRewind.swift:5`). Compatibility is fine, but copy that names Claude Code in the UI should be reviewed.
   - Web owns the palette. Native faithfully projects it, so any change must start in `globals.css` and flow through `design:tokens`.
5. **The sign-in plate fallback** is an accent `RadialGradient` "first light" glow (`JunoDesktopRootView.swift:843-858`). The shipped assets (`SignInPlateDawn`/`Dusk`) make it unreachable, but it remains as code.

### 3.3 Correctness and build hygiene
1. **Parity check red on main.** There are 8 errors (§0.2). Custom MCP (`NativeConnectorStore.swift:249-290`) and SKILL.md import (`NativeSkillsClient.swift:152`) shipped natively without ledger classification.
2. **iOS floors are inconsistent.** `project.yml` says iOS 18.0 (`native/iOS/JunoMobile/project.yml:5`), while the xcconfigs force 26.0 (`JunoMobile-Stable.xcconfig:6`) and JunoNativeKit requires iOS 26. JunoWork declares macOS 14/iOS 17. It works through override precedence, but the source of truth is ambiguous.
3. **iOS artifact runtime missing.** React/TSX/Tailwind artifacts cannot load their `juno-runtime://` scripts on iOS, because `Bundle.main.url(forResource: "ArtifactRuntime")` is nil. The runtime result is **UNVERIFIED** and should be tested in the simulator.
4. **Version drift.** Main says 1.9.3/94 with no release, so the repo claims a version users do not have. The Agents native redesign is unshipped.
5. **Known failing tests.** 2 `JunoTokenConsumptionTests` failures on main, acknowledged in the `73406344` message and left in place.
6. **Ratchets with large baselines.** Targets sits at 197 violations. The ratchets prevent regressions but do not converge.

### 3.4 Documentation drift (not gated)
- `docs/native/README.md:39-41` says `HANDOFF.md`, `NEXT_PROMPT.md`, `STATUS.md`, `JUNO_CODE_HANDOFF.md` and `handoff.json` were **deleted**, yet all five exist (last touched 2026-08-06/08). The README also describes a "legacy JunoMac surface" and an "AppKit `NSSplitViewController`" V2 architecture that no longer exist.
- `MACOS_ARCHITECTURE.md` and `MACOS_IMPLEMENTATION_STATUS.md` date from 2026-07-31.
- `TESTING.md` has no word on the snapshot suites, and its launch path is stale (`:93`).
- `RELEASE.md` has the stale version range.
- About 13.6k lines of native docs include 5 phase briefs of 490–2,800 lines each, which are historical scaffolding.

### 3.5 Parity gaps by surface (from the ledger and the code)

| Area | Web | Mac | iPhone | iPad |
|---|---|---|---|---|
| Products | Chat, Code | Chat, Code | Chat, Code, **Work**, Search tabs | Split; ⌘3 = Work |
| Skills, Assistants, Automations, Permissions | ✓ | ✓ | **missing** | **missing** |
| Plans (`/upgrade`) | ✓ | ✓ | missing (0/1) | missing |
| Mermaid diagrams | ✓ | ✓ (WKWebView) | **source only** | source only |
| React/TSX artifacts | ✓ | ✓ offline | **runtime not bundled** (UNVERIFIED) | same |
| Math | KaTeX | Unicode conversion | Unicode | Unicode |
| Design editor | ✓ + Ask Juno | hosted web editor, no Ask Juno | hosted editor | hosted editor |
| Cloud Code detail/steer/PR/checks | ✓ | planned | planned | planned |
| Custom MCP UI | ✓ | ✓ (main) + uncommitted rework in `../juno-custom-mcp` | UNVERIFIED | UNVERIFIED |
| Glass | n/a | system sidebar + 5 sites | tab bar glass; some faked `Material` | **opaque sidebar** |

---

## 4. Unmerged branches and parallel work touching native

| Branch / worktree | Unmerged vs main | Native content | Recommendation |
|---|---|---|---|
| `agents/redesign-native` / worktree `juno/.claude/worktrees/agent-ac27…` | 0 ahead (merged as `73406344`) | — | Done. **Remove the worktree**; ship 1.9.3 or fold it into the refoundation release. |
| `connectors/custom-mcp` (`75a62e6a`) + worktree `../juno-custom-mcp` with **9 uncommitted native files** (`NativeCustomConnectors.swift`, `DesktopCustomConnectorSheets.swift`, `CustomConnectorSnapshotTests.swift`, `HTTPValidation.swift` edits) | 1 commit, 31 behind | Parallel custom MCP UI | Main already has custom MCP through `81bf66c5` (`NativeConnectorStore.swift:249-290`), so this is **probably superseded**. Diff the two before discarding, harvest `HTTPValidation` hardening if it is novel, then remove the worktree. |
| `design/voice-motion` (`338ef437`) | 1 commit, 31 behind, 7 native files | Voice glow "follows the voice in bands" | Evaluate against the refoundation's glow decision (§3.2.3). Fold only if the voice glow survives. |
| `design/premium-ios2` (`764e0d64`) | 1 WIP commit, 62 behind | iPad follow-ups, keyboard UI tests; "unverified; stopped before review" | Cherry-pick the keyboard UI tests; re-derive the rest. |
| `agents/rework-native` (`596eb881`), `agents/rework`, `agents/runtime`, `agents/features` | 3/2/4 ahead, 15 behind | Superseded Agents UI; `agents/features` has server-side rooms/channels/payments tables | Do not fold the UI. Review `agents/features` server work separately (outside this area). |
| `wip/p4-A-paused`, `wip/p5-B-paused` | 1 commit each, ~139 behind | Snapshots of Phase 4/5 WIP from before the redesign merged | Superseded by the shipped 1.7.0 redesign. **Delete** after a spot check. |
| `rework/review-fixes` | 22 ahead, 308 behind, 42 native files | Code review fixes (e.g. "Run the run monitor for the app's lifetime", which main already does in `JunoDesktopApp.swift:150-157`) | Likely mostly landed by other paths. Verify per commit and delete. |
| `wip/juno-iphone-xcode-regen` | 1 commit, 103 behind | Regenerated pbxproj/plist | Stale. Delete, because main regenerated since (`8a0b05bd`). |
| `code-rework/handoff` | 2 docs commits | Handoff notes, `gh-shim.sh` | Keep only as history, or fold the shim into `.claude/local-tools`. |
| `origin/agent/*` (Aug–Sep 3), e.g. `juno-mobile-code` (1,557 behind) | stale | — | Prune. |

---

## 5. Recommendations, ordered by leverage

1. **Restore a gate that actually runs.** Either fix Actions billing, or make the local paths enforce the Linux gates. Add `npm run native:sync:check` and `npm run native:design:check` to `deploy/deploy-from-mac.sh` (next to `:150`) and to `native/Scripts/release-macos.sh` "Tests" (`:266-277`). Also run the three package suites via `scripts/native-test.sh` in the release script, not just `JunoVoiceKitTests`. Change `native-parity.yml` to also run on `push` to main, diffing `before..after`. Files: `deploy/deploy-from-mac.sh`, `native/Scripts/release-macos.sh`, `.github/workflows/native-parity.yml`, `scripts/check-native-parity-label.mjs`.
2. **Get main green on the sync gates.** Classify the 7 unclassified routes and flip `/api/agents/[id]/duplicate` to native in `contracts/parity/features.json`, then run `npm run native:parity`. Change the token digest to hash only the extracted token values, not the whole CSS file. Files: `scripts/generate-design-tokens.ts:349-354`, `contracts/parity/features.json`, `docs/native/PARITY_MATRIX.md`, `JunoGeneratedTokens.swift`, `tokens.generated.ts`. Fix or delete the 2 failing `JunoTokenConsumptionTests`.
3. **One product model everywhere.** Retire the iPhone Work tab: tasks live in chats, as on web and Mac. Make the tab bar Chat, Code and Search, with Agents and Library in the drawer. Project `juno-shell-v1.json` to iOS as well, with a second output of `generate-shell-contract.mjs` and a `JunoMobileShellContractTests`. Unify the chord map by moving `JunoShortcutRegistry` data into JunoNativeKit and having both `DesktopCommands` and `JunoMobileCommands` read it. Files: `JunoMobileRootView.swift:560-591`, `JunoMobileSection.swift`, `JunoMobileIPad.swift:47-85`, `JunoMobileWorkView.swift` and `JunoMobileTasksView.swift` (retire), `scripts/generate-shell-contract.mjs`, `JunoShortcutRegistry.swift`.
4. **Enforce the owner rules by lint, not by memory.** Extend `scripts/check-native-design.mjs` with:
   - (a) a banned-word scan for `JunoCapsuleTag("Recommended"|"Smart"|"Live"|"Active"…)` and `Circle().fill(...)` smaller than 8pt beside text;
   - (b) a zero-tolerance ban on `.ultraThinMaterial`, `.thinMaterial`, `.regularMaterial` and `.bar` in app code;
   - (c) a ratchet on `repeatForever`/`TimelineView` loops outside an allow-list.

   Then fix the sites. Remove the tags in `JunoModelSelector.swift:287,681`. Replace the camera badge with plain text (`JunoMobileVoiceCamera.swift:282-294`). Remove the iPad opaque sidebar (`JunoMobileRootView.swift:611`). Replace the Material fills (§1.5 list) with system glass, or with opaque `JunoSurfaces` for content. Delete `JunoStatusDot.swift`.
5. **Make one explicit decision on signature effects, then delete the rest.** Keep at most two state-carrying effects, for example the voice glow and the agent face (subject to the refoundation's visual direction). Remove the idle `.pulse` border beam (`ChatComposer.swift:1558-1563`), the `JunoAIcss*` ports that are dead, `JunoComposerAura`/`JunoProviderGlow`/`JunoMobileAuraLayer`, the iOS full-screen `JunoVoiceAura`/`JunoVoiceOrb` (or make the Mac match), and the unused `JunoShimmerText` sites. Files: `JunoDesignSystem/{JunoBorderBeam,JunoComposerAura,JunoProviderGlow,JunoVoiceAura,JunoVoiceOrb,JunoAIcss*,JunoShimmerText}.swift`, `JunoMobileGreeting.swift`, `JunoMobileVoiceFullScreen.swift`.
6. **De-Claude the identity at its source.** Choose a non-terracotta default accent, and consider dropping the serif time-of-day greeting in `src/app/globals.css` and the web greeting. Regenerate tokens so native follows automatically, then update `JunoGreeting.swift` phrases, the sign-in copy (`JunoDesktopRootView.swift:864`) and the plates. This needs web-shell coordination: native only projects the palette.
7. **Close the iOS rendering gaps cheaply.** Add `macOS/JunoDesktop/Resources/ArtifactRuntime` as a folder resource in `native/iOS/JunoMobile/project.yml`, the way `DesignEditor` is shared. Call `JunoMermaidEngine.register(script:)` in `JunoMobileApp.swift`. Then verify in the simulator with the preview harness. Files: `native/iOS/JunoMobile/project.yml`, `JunoMobileApp.swift`, the regenerated `JunoMobile.xcodeproj`.
8. **Make parity per-platform and verify screens.** Give route entries optional `mac` and `ios` statuses, detected by scanning `native/macOS` vs `native/iOS` plus the packages each app links. Add an `ipad` page column. Make `screen` a list of Swift type names that `parity-ledger.mjs` greps for. Do the same split for `contracts/chat/juno-chat-wire-v1.status.json`. Files: `scripts/parity-ledger.mjs`, `contracts/parity/features.json`, `scripts/generate-chat-wire-contract.ts`.
9. **Turn snapshots into regressions.** Collapse the four env vars (`JUNO_SNAPSHOT_DIR`/`FINAL`/`PREMIUM`/`WORK`) into one. Add a golden directory with a perceptual-diff threshold for a curated set (shell, composer, transcript, agents, settings) in light and dark. Add an iOS offscreen suite (`ImageRenderer`/`UIHostingController` in `JunoMobileTests`), since iOS has none. Files: `native/macOS/JunoDesktop/Tests/Snapshots/*`, `TranscriptSnapshotRenderer.swift`, `scripts/native-snapshots.sh`, new `native/iOS/JunoMobile/Tests/Snapshots/`.
10. **Share UI rather than mirror it.** Move the composer shell, transcript row, message actions and model chip into JunoChatKit and JunoDesignSystem as platform-adaptive views, which starts to shrink the 2× composer and transcript. Deduplicate the glass wrappers (`JunoMobileChrome.swift:326-392` vs `JunoDesktopChrome.swift:290-400`). This is long-running, so start with the composer.
11. **Be honest about the contract.** Either generate the Swift DTOs from OpenAPI for the routes the apps use (chat, sync, library, artifacts), or rename the generator to "contract pin" and stop implying generation. Files: `scripts/generate-native-swift-contract.mjs`, `JunoAPI/Generated/`.
12. **Clean-up (small and safe).**
    - Delete `native/desktop-electron/`, `native/Config/JunoMac-*.xcconfig`, `JunoCode-*.xcconfig`, `native/macOS/JunoDesktop/build_{log,pid}.txt`, `JunoCodeUI/Theme/JunoCodeTheme.swift` and the dead JunoDesignSystem types (§2).
    - Align the floors: `project.yml` iOS 26, JunoWork macOS 26/iOS 26.
    - Rewrite `docs/native/README.md`, delete the "Deleted" files for real, move the phase briefs to `archive/`, and update `TESTING.md` (snapshots, launch path) and `RELEASE.md` (version range, the identity now present, feed state).
    - Prune the stale branches and worktrees listed in §4.
13. **Release truth.** Before any public refoundation launch, obtain Developer ID and a notary profile, and run `release-macos.yml`. Until then, publish 1.9.3, or revert the bump, so that main does not claim an unreleased version. Decide whether the iOS feed row ("On the App Store soon") and the Windows row should appear at all. Files: `native/Config/Base.xcconfig`, `docs/native/RELEASE.md`, `src/app/api/downloads/*` (web).

---

### Sources (external)
- Claude brand colours: search results citing Mobbin (https://mobbin.com/colors/brand/claude; the page returned 403 to fetch, so **UNVERIFIED**) and https://beginswithai.com/claude-ai-logo-color-codes-fonts-downloadable-assets/ (published 2024-04-03).
- Claude greetings: https://gist.github.com/Posandu/e97d3cd20a671749ce7162a2a4f51fee (undated) and https://x.com/dwlz/status/1965495158025114097 (≈ Sept 2025).
- Liquid Glass APIs (`glassEffect`, `GlassEffectContainer`, `glassEffectID`): WWDC25 "Build a SwiftUI app with the new design", https://developer.apple.com/videos/play/wwdc2025/323/ (June 2025).
