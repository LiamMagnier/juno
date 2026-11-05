# Map: the macOS app (Alevr for Mac) vs the web, for the redesign

Read-only survey, 2026-10-31. Repo `/home/user/juno` @ `e532983ea`. All paths are relative to the repo root.
Abbreviations: **MAC** = `native/macOS/JunoDesktop/App/`, **DS** = `native/Packages/JunoNativeKit/Sources/JunoDesignSystem/`,
**STUDIO** = `native/Packages/JunoCode/Sources/JunoCodeUI/Studio/`.

---

## 0. TL;DR

- **The transcript is not the problem.** Message rows, the bubble, prose, code blocks, run lines, sources pill and the reply action bar are close ports of the web, carry web values, and are read from generated tokens. That column already looks like the website.
- **The shell is inverted.** On the web, the sidebar is a flat `--sidebar` column and the **content** is an inset floating card (8px margin, radius 14, ring `foreground/7%`; `src/app/globals.css:4605-4611`). On the Mac, the **sidebar** floats (the system Tahoe glass sidebar from `NavigationSplitView`) and the content is full bleed (`MAC/DesktopSidebarChrome.swift:322-344`, an owner decision on 2026-10-08). This one inversion is most of why "it doesn't look like the website".
- **The controls are glass capsules everywhere.** An owner rule from round 3 (2026-10-09, `DS/JunoGlassControls.swift:3-22`) makes every page button, menu trigger, segmented control and search field a Liquid Glass capsule: 97 × `.junoGlass`, 64 × `.junoProminent` (black glass), and 60 × `JunoSegmented` (glass track) in the Mac app alone. The web uses compact 8px-radius rectangles (`rounded-control`, `h-8`/`h-9`, outline or ghost). The result is glass on the content layer, glass inside sheets (glass on glass), oversized pills, and too many "primary" black capsules.
- **The page typography is wrong.** Page titles are SF Pro Medium at 32–44pt (`DS/JunoTypography.swift:168`), where the web uses **Newsreader serif, regular** (`src/components/app/app-page-header.tsx:163`). Section headers on the web are serif as well, and the Mac uses bold sans. Content on pages is laid out as fat cards with pill buttons, where the web uses dense two-column rows.
- **Custom-drawn chrome replaces native controls.** The Chat/Code switch is a hand-drawn dot-orbit in serif in the toolbar's centre (`DS/Brand/JunoProductOrbit.swift`, used at `MAC/ChatToolbar.swift:54`). The web puts a plain segmented control in the sidebar under the logo, and the Mac's own redesign spec says to use a native segmented or `.tabs` picker (`docs/native/MACOS_LIQUID_GLASS_REDESIGN.md` §1.4). The native helper `junoProductPickerStyle()` exists but nothing calls it (`MAC/DesktopProductMode.swift:115`).
- **The review loop is blind to real glass.** Most PNGs in `docs/` were rendered offscreen with `junoSnapshotOpaqueGlass = true` (`MAC/../Tests/Snapshots/RealWindowRenderer.swift:32`), which swaps every glass control for an opaque stand-in. They are also older than the 2026-10-29 graphite palette switch: they show warm paper and coral. What the owner sees on a real Mac has never been reviewed in images.
- **There is a way to get real captures in CI.** The DEBUG build has `--juno-ui-preview --juno-preview-snapshot <png>`, which grabs the window-server composite of the app's own window, real glass included, with no Screen Recording permission needed (`MAC/DesktopPreviewSnapshot.swift:1-120`). Nothing in CI runs it yet (§1.4).

---

## 1. Build, targets, deployment, CI, images

### 1.1 Targets and configs
| Item | Value | Where |
|---|---|---|
| Only live Mac app | `JunoDesktop` (product name "Alevr", bundle `com.liammagnier.JunoDesktop`) | `native/macOS/JunoDesktop/project.yml` (XcodeGen 2.46), `native/Config/JunoDesktop-{Debug,Stable,Next}.xcconfig` |
| Deployment target | **macOS 26.0** everywhere: project.yml `deploymentTarget`, xcconfig `MACOSX_DEPLOYMENT_TARGET = 26.0`, and the package `platforms: [.macOS("26.0"), .iOS("26.0")]` | `native/Packages/JunoNativeKit/Package.swift:27-33` (the comment calls it "the Liquid Glass floor") |
| Availability guards | Effectively none are needed. There is 1 `#available(macOS 27, *)`, for `.pickerStyle(.tabs)`, under `#if compiler(>=6.4)`, in `MAC/DesktopProductMode.swift:115-126`, and 5 `@available(macOS 26.0, *)` in DS (the package is also built for iOS). The glass APIs (`glassEffect`, `GlassEffectContainer`, `.buttonStyle(.glass/.glassProminent)`, `ConcentricRectangle`, `scrollEdgeEffectStyle`, `safeAreaBar`) are called unguarded. | — |
| Orphaned configs | `JunoMac-*.xcconfig` (macOS **15.0**, "Juno", `com.liammagnier.JunoMac`) and `JunoCode-*.xcconfig` (26.0). No project.yml references them, and `scripts/check-code-runtime-wiring.mjs:28` calls JunoMac "the retired standalone JunoMac shell". These are stale. | `native/Config/` |
| Packages linked | JunoNativeKit (JunoCore, JunoAPI, JunoAuth, JunoStorage, JunoSync, JunoSearch, **JunoDesignSystem**, JunoDesignKit, JunoAgentProtocol, **JunoChatKit**, JunoCodeKit, **JunoWorkKit**, JunoVoiceKit, JunoPreviewSupport), JunoCode (JunoCodeUI/Bridge/Runtime/Local/Simulator), JunoWork, JunoScreenControl | project.yml `dependencies` |
| Size | App: 159 Swift files, 82,177 lines. Tests and UITests: 24,977 lines. JunoNativeKit: 612 files, about 205k lines. JunoCode: about 134k lines. | — |
| Fonts | Bundled from the iOS target: Newsreader (24pt optical, Regular/Medium/SemiBold plus Italic variable). There is **no Inter and no JetBrains Mono**: SF Pro and SF Mono stand in (`DS/JunoTypography.swift:18-19,61-65`). | project.yml `../../iOS/JunoMobile/Resources/Fonts` |
| Icons | 395 custom Phosphor-derived `ph.*` symbol sets plus `juno.*` marks in `Resources/Icons.xcassets`. There are **0** `Image(systemName:)` calls in the app: everything goes through `JunoIconView` (319 sites) or `JunoSymbol` (10). | — |

### 1.2 CI (`.github/workflows/native.yml`)
- Linux jobs run on every push. Among them: `npm run design:tokens:check` (generated Swift tokens must match globals.css and tailwind), `native:icons:check`, `shell:contract:check` (the sidebar IA is generated from the web), and **`native:design:check`**: nine ratcheting source-scan gates (type, motion, glass, targets, prominent, menus, sficons, symbols, spacing), run by `scripts/check-native-design.mjs` against the baseline in `scripts/check-native-design-baseline.json`.
- The `macos-app` job (runs-on `macos-26`, Xcode ≥ 26, XcodeGen): `xcodebuild build` Debug with `SWIFT_TREAT_WARNINGS_AS_ERRORS=YES`, then `xcodebuild test -only-testing:JunoDesktopTests`. The `macos-app-stable` job builds Stable. **No UITests run, nothing sets `JUNO_SNAPSHOT_DIR`, and no images are uploaded.** It runs only when `changes.outputs.native == 'true'`.

### 1.3 Snapshot and screenshot tooling that exists
| Tool | What it renders | Real glass? | Trigger |
|---|---|---|---|
| `Tests/Snapshots/*` (37 files, about 89 `@Test`s): Transcript, Page, Overlay, Settings, ModelPicker, ComposerTray, Premium, Final and others | Offscreen `cacheDisplay` and `RealWindowRenderer` (an off-screen titled window with a unified toolbar) | **No.** 18 of the files set `.environment(\.junoSnapshotOpaqueGlass, true)`, and the renderer forces it (`RealWindowRenderer.swift:32`). Glass controls draw `JunoGlassStandInShape` (`DS/JunoGlassControls.swift:151-164`) and the composer draws a card plus hairline (`DS/JunoComposerShell.swift:300-310`). | `TEST_RUNNER_JUNO_SNAPSHOT_DIR=… xcodebuild test -only-testing:JunoDesktopTests/<Suite>` (`scripts/native-snapshots.sh`) |
| `UITests/JunoDesktopCodeScreenshotUITests.swift` | `XCUIScreen.main.screenshot()` of a `--juno-ui-preview` launch (Code tab only) | Yes | `TEST_RUNNER_JUNO_CODE_SHOT_DIR`. The fallback path is a dev laptop's /private/tmp. Not in CI. |
| **`MAC/DesktopPreviewSnapshot.swift`** (DEBUG) | `--juno-ui-preview --juno-preview-snapshot out.png [--juno-preview-tab chat|projects|settings|code…] [--juno-preview-appearance dark] [--juno-preview-size 1440x900] [--juno-preview-overlay sheet|alert|confirm|popover|add-menu] [--juno-preview-press <a11y id>] [--juno-preview-snapshot-window Settings]`. It uses `CGWindowListCreateImage` (looked up with dlsym) for the app's own window, menus and popovers, then quits. | **Yes.** It is the window-server composite, and needs no Screen Recording permission. | Manual; `native/Scripts/capture-desktop.sh` drives it |

### 1.4 Recommended CI path to get images (none exists today)
Add a `workflow_dispatch` job on `macos-26` that does the following:
1. Run `generate-projects.sh` and build Debug with `CODE_SIGNING_ALLOWED=NO` (the harness uses a throwaway DB and a no-network transport).
2. Loop `Alevr.app/Contents/MacOS/Alevr --juno-ui-preview --juno-preview-tab <tab> --juno-preview-appearance <light|dark> --juno-preview-size 1440x900 --juno-preview-snapshot $RUNNER_TEMP/shots/<tab>-<mode>.png` over chat, projects, library, artifacts, agents, customize/connections, settings and code, plus the overlays.
3. Run the offscreen suites with `TEST_RUNNER_JUNO_SNAPSHOT_DIR` for the detailed component stills.
4. Upload everything with `actions/upload-artifact@v4`.

Caveat: an unsigned build may hit the Keychain prompt described in `capture-desktop.sh:20-23` and `docs/native/TESTING.md`. The preview harness should avoid it because it uses a throwaway store, but this has not been verified on a runner.

---

## 2. Web tokens → Swift

- **Generator:** `scripts/generate-design-tokens.ts` reads `src/app/globals.css` (colour, motion, shell, gesture) and `tailwind.config.ts` (radius, type, spacing) and writes **`DS/Generated/JunoGeneratedTokens.swift`** (1,164 lines, `tokens-digest: 91e861b0073c3c49`). Every colour carries 4 appearances (light, dark, and high contrast of each). CI fails on drift.
- **Generated enums:**
  - `JunoGeneratedColors` (every `:root` custom property)
  - `JunoGeneratedDuration`, `JunoGeneratedEasing`, `JunoGeneratedTiming`, `JunoGeneratedSprings`
  - `JunoGeneratedShell`: sidebar 224/260/352, header 48, transcript widths 640/768/992
  - `JunoGeneratedRadius`: micro 2, sm 4, xs 6, md 8, control 8, field 10, card 12, popover 12, bubble 12, menu 14, composerControl 14, panel 16, composerAction 16, **composer 26**, stage 28
  - `JunoGeneratedType`: hero, display 32–48, pageTitle 32–44, homeTitle 34–50, title 22/600, heading 18/600, bodyLg 17, reading 16/1.7, body 15/1.6, nav 14, ui 13, label 12/500, caption 12, micro 12, kbd 11
  - `JunoGeneratedSpace`: 2…48
- **Hand-written wrappers over the generated values:**
  - Colours: `DS/JunoColors.swift` (`Color.junoCanvas`, `junoCard`, `junoSecondary`, `junoHover`, `junoBorder`, `junoForeground`, `junoSecondaryInk`, `junoTertiaryInk`, `junoSidebarInk`, `junoGlassHover`/`junoGlassFill` = foreground at 6/8% and 8/12%, `junoSelectedFill` = `--sidebar-selected`).
  - Accent: `DS/JunoDesignTokens.swift:47` (`JunoColorToken.coral = primary.light`, which is now **graphite**).
  - Space and radius: `DS/JunoSurfaces.swift:238-451` (`JunoSpace` micro…vast; `JunoRadius`, including the old role names `well` = field 10, `message`/`floating` = popover 12, `composer` = 26).
  - Layout: `DS/JunoLayout.swift` (Row 32 high, compact fill radius 8, glyph 16 in a 20 slot).
  - Type: `DS/JunoTypography.swift` (`JunoType` ladder plus older `junoCaption()`, `junoBody()` and `junoFont(size:)`).
  - Motion: `JunoMotion` in DS/JunoDesignTokens.swift:218+.
- **Palette state:** the web moved to **graphite on near-white and near-black, with ultramarine for "live"** on 2026-10-29 (`docs/audit-2026-10-29/DESIGN.md`, commit `2d31cb32c`). The generated values follow it: `--background` light is #FCFCFD and `--sidebar` is #F3F4F5. **The Swift prose has not followed.** For example, `DS/JunoColors.swift:10-14,65,76` and `DS/JunoDesktopChrome.swift` still say "warm paper / coral / #EEECE5", and `JunoAccent.coral` now resolves to graphite. Every Mac PNG in docs predates the switch.
- **Second design system:** `STUDIO/StudioTheme.swift` (JunoCode, the Code product):
  - System text styles (`.system(.body)`, `.title3`, …) instead of the ladder.
  - Its own radii: composer **22** (Chat uses 26), bubble **18** (12), measure **720** (768).
  - A hand-typed coral `Signal.edge` HSL(14,64%,46%) (`:85-87`) and hand-typed syntax and diff colours (`:92-104`). None of these come from the generated tokens.

---

## 3. Window structure (Chat), and how it compares with the web

```
WindowGroup(main) ── .containerBackground(junoCanvas, for: .window)  JunoDesktopApp.swift:498-521
  .defaultSize(1240×800) .windowToolbarStyle(.unified) .windowBackgroundDragBehavior(.enabled)  :523-553
  JunoDesktopRootView (sign-in | loading | workspace)                  JunoDesktopRootView.swift:63-215
    JunoDesktopWorkspaceView → DesktopChatWorkspace / DesktopCodeWorkspace (one live split view)
      NavigationSplitView(columnVisibility:)                            DesktopChatWorkspace.swift:317
        sidebar: DesktopChatSidebar  .junoSidebarColumn() (220/260/360)  :318-342, DS/JunoDesktopChrome.swift:46-51
        detail:  ChatDetail → .desktopContentPanel() (= .background(junoCanvas), full bleed)
                 .navigationTitle / .navigationSubtitle / .toolbarTitleMenu / .toolbar{ChatToolbar}  ChatDetail.swift:66-96
                 destination: chat column (TrailingDock(panel){ chatColumn }) or a JunoPage
Settings { DesktopSettingsWindow }  (own NavigationSplitView)          JunoDesktopApp.swift:575-596
Window "Keyboard Shortcuts" 640×720 · WindowGroup "Research Report" 880×720 · Window "About Alevr" (.hiddenTitleBar)
· Window "Software Update" · CodePreviewScene · MenuBarExtra
```

| Shell element | Web (`src/components/app/app-shell.tsx`, `app-sidebar.tsx`, `globals.css`) | Mac |
|---|---|---|
| Frame | `.juno-frame` = `--sidebar` grey ground; `<main>` is an **inset card**: `margin 8px 8px 8px 0; radius 14; box-shadow 0 0 0 1px fg/7%` (`globals.css:4605-4611`) | Sidebar = **system floating Liquid Glass pane** (Tahoe). Detail = full-bleed `junoCanvas` with no inset, corner or ring (`DesktopSidebarChrome.swift:322-344`, owner 2026-10-08) |
| Sidebar header | Alevr lockup (14px) · bell (ghost `size-8`) · collapse toggle (`app-sidebar.tsx:1455-1560`) | Traffic lights and the system sidebar toggle. No wordmark (a declared difference, spec §0.8.3). The bell is a **list row** that appears only when there is unread (`DesktopChatSidebar.swift:269-277`) |
| Product switch | In the sidebar under the lockup: a 2-column segmented control, `rounded-field bg-sidebar-accent/80 p-0.5`, with icon, label and ⌘ kbd (`product-switch.tsx:230-306`). The web moved it **out** of the centre header (`chat-view.tsx` comment near 2628). | **Centre of the toolbar** (`.principal`): a custom dot-orbit (84×48 dots) with "Chat"/"Code" in Newsreader 15.5, `.plain` buttons, height 32 (`ChatToolbar.swift:54`, `DesktopProductMode.swift:74-107`, `DS/Brand/JunoProductOrbit.swift`) |
| Collapse | Collapses to a 52px icon rail; floats over the content at md–lg | Hides fully (`.detailOnly`). No rail (a declared difference) |
| Chat header | In the content card: `h-14` band; `shell-title` h1 (with a "Project / " crumb); right cluster: SessionOutputs · Share (icon `size-5`) · Continue-on · More (export) · Incognito (`chat-view.tsx:2509-2700`) | Unified toolbar: leading title plus subtitle (project) with a title menu; principal orbit; trailing Outputs · Share · Private chat as system toolbar glass buttons; "New chat" appears in `.navigation` only when the sidebar is collapsed (`ChatToolbar.swift:54-89`). There is no Continue-on or Export menu in the toolbar. |
| Pages | Header inside the card: serif page title and lede; outline and ghost rect actions | Title shown **twice**: toolbar `navigationTitle("Library")` plus a 32–44pt SF Medium page header (`ChatDetail.swift:30-34` comment: kept "until the page template lands") |
| Right panel | Same card, `@container/split`: canvas, activity or thought panel | Chat: custom `TrailingDock` overlay with a drag handle (`DesktopArtifactCanvas.swift:453-560`). Code: system `.inspector` (`DesktopCodeWorkspace.swift:407-437`). Two mechanisms. |
| Settings | A modal (`SettingsModalLazy`, `(app)/layout.tsx`) | A separate `Settings` scene with its own split view (a declared difference) |

---

## 4. Surface-by-surface table

The "Glass" column covers custom `glassEffect`, `GlassEffectContainer` and `.glass*` button styles. System chrome glass (sidebar, toolbar, menus, popovers, sheets) is implicit everywhere.

| # | Surface | File:line | SwiftUI components / styles | Current values | Glass | Divergence from the web |
|---|---|---|---|---|---|---|
| 1 | Main window | `MAC/JunoDesktopApp.swift:498-553` | `WindowGroup`, `.containerBackground(.window)`, `.unified` toolbar | 1240×800 default; min 820×560 (preview) | system | Flat canvas ground versus the web's grey frame plus an inset content card |
| 2 | Split view and sidebar column | `MAC/DesktopChatWorkspace.swift:317-342`; `DS/JunoDesktopChrome.swift:46-66` | `NavigationSplitView`, `navigationSplitViewColumnWidth` | 220 / **260** / 360 (web shell token 224/260/352; spec said 224/304/336) | system sidebar pane | The floating glass sidebar is inverted relative to the web's flat sidebar and floating content |
| 3 | Sidebar list | `MAC/DesktopChatSidebar.swift:147-212` | `List(selection:)` `.listStyle(.sidebar)`, `defaultMinListRowHeight 0`, `.junoSidebarSelectionTint()`, `safeAreaBar(.bottom)` footer, `.junoSidebarScrollEdge()` (soft) | Sections: nav → Needs you → Agents (Orbit) → Pinned projects → Recent | system | IA matches (generated `JunoShellChatSidebar`). Header, product switch and bell are missing. |
| 4 | Sidebar rows | `MAC/DesktopSidebarChrome.swift:12-56, 77-206` | Custom `DesktopSidebarNavRow` (Button `.plain` or a tagged row), `.onHover`, `.listRowBackground(RoundedRectangle)` painted **over** the system selection, `.junoIconHover` gesture | Row 32; glyph 16 in a 20 slot at x=26 (16 + a **10pt "leadingShift"**, owner Oct 11); label 14 at x=56; fill inset 8, radius 8; hover `--sidebar-hover`; selected `--sidebar-selected` | none | The web is 16px edge, 32 row, 14 nav, `rounded-control` (close). The Mac adds a 40pt "prominent" New chat row with an 18 glyph and 15 label (owner "make it bigger"), where the web's New chat is a normal row. Rows fight the List insets with `listOrigin` subtraction and a negative trailing pad (`DesktopChatSidebar.swift:839`). |
| 5 | Section headings | `MAC/DesktopSidebarChrome.swift:210-268` | Custom row, `onTapGesture` folds | **SF Mono 11**, tracking 0.22, secondary ink, height 28, gap 8 above | none | Matches the web's `.shell-annot` mono (parity) |
| 6 | Conversation row | `MAC/DesktopChatSidebar.swift:791-895` | `HStack`, `JunoInlineRenameField`, hover-only kebab `Menu` (`.menuStyle(.button)` + `.plain` + `.menuIndicator(.hidden)`), `.contextMenu` | Title 14; trailing slot 20; status dot 9×9 | none | Same as the web, apart from the magic paddings |
| 7 | Account footer | `MAC/DesktopAccountFooter.swift:28-225, 551-700` | `Menu`-driven popover, gear `.borderless` 40×40 | Height 48 (`accountHeight`); name 14 medium; plan 11; the popover's height is hard-coded per row set (`:507-530`); width 288 | none | The web shows avatar, name, plan line and a chevron-updown with no gear; the Upgrade row sits above it |
| 8 | Toolbar (Chat) | `MAC/ChatToolbar.swift:39-89`; `MAC/ChatDetail.swift:66-96` | `ToolbarItem(.principal/.navigation/.primaryAction)` with `.hidden()`; `JunoSymbol` labels; `.toolbarTitleMenu` | Unified (standard metric); title plus subtitle | system toolbar glass | The web has no toolbar: its title band lives inside the content card. The centre orbit is bespoke. |
| 9 | Product switch | `MAC/DesktopProductMode.swift:74-107`; `DS/Brand/JunoProductOrbit.swift` | Custom: `HStack` of 2 `.plain` buttons + `JunoDotRings` (drawn dots, animated trail) | Serif 15.5, tracking −0.155; 44×28 hit areas; orbit 84×48 with −6/−8 negative padding | none | Web: a sidebar segmented control. Spec §1.4: native `Picker` `.segmented`/`.tabs` in the sidebar strip. |
| 10 | Transcript column | `MAC/ChatTranscript.swift:28-45, 238-440` | `ScrollView` + `LazyVStack(spacing: 24)`, `.defaultScrollAnchor(.bottom)`, `.scrollEdgeEffectStyle(.soft, [.top,.bottom])`, pinned-turn frame | Measure 768; gutter 16/24/32 by width | none (correct) | **Parity** |
| 11 | User bubble | `MAC/MessageRow.swift:270-315` | `UnevenRoundedRectangle` (12, tuck 8), fill `junoSecondary` | `.junoType(.reading)` 16/1.7; padding 16×10; max 85% of the measure | none | **Parity** (`USER_BUBBLE_CLASS`) |
| 12 | Assistant turn | `MAC/MessageRow.swift:585-680` | `DesktopRunBlock`, approvals, answer body (`JunoMarkdownView`), research chip, `DesktopTurnNote`, `DesktopMessageSources`, reply actions | Gap 12; actions +6 | none | **Parity** in structure |
| 13 | Thinking / tool run line | `MAC/ActivityRow.swift:26-200, 225+` | Button with custom `DesktopRunLineButtonStyle` (opacity 0.7 on press, **no hover fill**), `TimelineView`, peek, timeline expand, "open in panel" `JunoProseIconButtonStyle` | Line height 36; text inset = signature + 10 | none | Close to the web's `run-line.tsx` |
| 14 | Markdown, code, tables, citations | `DS/JunoMarkdownView.swift`, `DS/JunoProse.swift:30-56`, `DS/JunoProseBlocks.swift`, `DS/JunoSyntaxHighlighter.swift` | Custom renderer | Body 16/1.7, block gap 0.85em, list indent 1.4em, inline code ×0.875, citation ×0.72; code block card radius 12 with a language header and copy | none | **Parity** (the screenshot `docs/design/premium-pass/mac/after/window-transcript-light.png` reads like the web) |
| 15 | Sources pill | `MAC/SourcesPill.swift:183-260` | Capsule, hover | Height 32; label 12 medium plus 12 mono count; card fill → hover | none | Web parity |
| 16 | Approval card | `MAC/ApprovalCard.swift:21+` | Card, buttons | Title 15 semibold; 11 mono meta; 13 body | none | OK |
| 17 | Inline artifact card | `MAC/InlineArtifactCard.swift:140-160, 200-245` | Card with a 1pt border at opacity 0.6, rising to 1 on hover | radius 12 / 10 / 8 nested | none | Border alpha 0.6/0.7 is ad hoc |
| 18 | Composer dock | `MAC/ChatComposer.swift:539-595`; `MAC/DesktopChatWorkspace.swift:2252-2310` | `safeAreaBar(.bottom)` hosting `ChatComposerDock`; the greeting hangs above the composer through an overlay | Group width `ChatComposerLift.groupWidth`; gutter by width | — | Web: a landing composer centred under the greeting, then the docked composer |
| 19 | Composer shell | `DS/JunoComposerShell.swift:3-15, 127-330` | `GlassEffectContainer(8)` → VStack; field insets 14/16/6/16; controls row 32 high with insets 2/10/10/10; `ContainerRelativeShape` | **Radius 26**; `.glassEffect(.regular, in: shape)` **with no edge or shadow** (`:316`) | **Yes** | Web `.composer-surface`: **opaque `--card`, 1px fg/10% edge, two-layer shadow, a focus step-up** (`globals.css:1885-2005`). Over a flat canvas the Mac glass has nothing to refract and reads as a vague grey slab with no edge. (Declared difference, spec §0.8.9.) |
| 20 | Composer controls | `MAC/ChatComposer.swift:609-730, 2096-2175` | `+` `Menu` (`.menuStyle(.button)` + custom `ComposerControlStyle`); mic `Button`; `ComposerPrimaryDisc` (`Circle` fill) | All 32×32. Hover is a `junoGlassHover` capsule; press scale 0.97. Send/voice/stop disc fills `junoForeground` with a canvas glyph 16 bold (stop 12). Disabled: `junoGlassFill` with send 14 at 0.5. | in shell | Web: ghost `size-8` round leading/trailing buttons, primary `size-9` (**36**) disc (`composer-shell.tsx:241, 307-350`) |
| 21 | Model chip and picker | `MAC/ComposerModelChip.swift:17-120`; `DS/JunoModelPicker.swift:101-230`; `DS/JunoEffortPanel.swift`; `DS/JunoModelSelector.swift` | `Button(.plain)` + `.popover(item:)` in two stages (effort, then catalogue) with a fixed frame per stage | Chip height 32, max width 256, capsule. Tone: open = `white 0.09`/`fg 0.085`; hover = `fg 0.045` (`:184-189`). Name `.ui` 13, chevron 14. Effort panel width 296 with a computed fixed height. | none (system popover) | Web chip: `h-8 rounded-control px-2.5 text-label` (8px rect, `composer-shell.tsx:121`). Ad hoc alphas. |
| 22 | Composer tray | `MAC/ChatComposer.swift:1690-1760` → JunoChatKit `NativeComposerTray` | Project · Apps · Skills shelf under the card | — | none | Parity with `composer-tray.tsx` |
| 23 | Empty chat greeting | `MAC/DesktopEmptyChat.swift:128-240` | `Text` + pose animation | **"What can I help with?"** in Newsreader `display(size: 30)` (`:208-209`); measure 672; private header 17 semibold / 14 | none | Web: **"What's next, {Name}?"**, Newsreader **50/56**, −0.032em, opsz 60 (`composer.css:443-448`), over a faint dot-orbit field, with **starter chips** under the composer (`home-starters.tsx`). The Mac has neither the field, the starters nor the name. The doc comment at `:62-77` still describes "How can I help, *Liam*?" |
| 24 | Follow-up chips | `MAC/FollowUpChips.swift:56` | `JunoChipStyle` capsule | — | inside the composer glass container | OK |
| 25 | Scroll-to-latest | `MAC/ScrollToLatestButton.swift:20-41` | `GlassEffectContainer` + `.buttonStyle(.glass)` | circle | **Yes** (allow-listed) | OK |
| 26 | Find bar | `MAC/DesktopFindBar.swift:36, 123` | Capsule glass, custom `DesktopFindBarControlStyle` | — | **Yes** (allow-listed) | Web: `conversation-find.tsx` (opaque) |
| 27 | ⌘K / Search panel | `MAC/DesktopSearchPanel.swift:18-40, 525-575` | Overlay panel; `GlassEffectContainer` + `.glassEffect(.regular)`; result list | Width 640; top 72; field height 56; filters 44; rows 36/52; radius 16; max height 480 | **Yes** (allow-listed) | Web: two opaque palettes (declared difference) |
| 28 | Toasts | `DS/JunoToastHost.swift:391, 587` | Glass capsule | — | **Yes** (allow-listed) | OK |
| 29 | Artifact canvas (trailing dock) | `MAC/DesktopArtifactCanvas.swift:453-560` (dock), `:638-1080` (canvas) | Header: title 13 semibold; `ShareLink` / `Menu` / close as **`.plain` 28×28 glyphs with no hover**; a hand-drawn 1×20 hairline separator; header bg `junoSurface.opacity(0.5)` (`:837`). View bar: `JunoSegmented` (glass) + `.borderless` buttons + `.junoProminent` Save + error text 11. | Panel ideal width, drag handle 8 | glass track and buttons | Web canvas header: compact ghost icon buttons with hover. Here one bar mixes four button idioms. |
| 30 | File preview, research report panels | `MAC/DesktopFilePreviewPanel.swift:36`, `MAC/ResearchReportWindow.swift:140`, `MAC/DesktopLibraryPicker.swift:90,147` | Header `.background(.bar)` (material) | — | material | Inconsistent with the canvas header (`junoSurface 0.5`) |
| 31 | Activity panel | `MAC/ActivityPanel.swift` | Tabs and timeline in the dock | — | none | Web `chat/panel/*` |
| 32 | Pages (Library, Projects, Artifacts, Connections, Skills, Automations, Memory, Assistants, Permissions, Host, Skill and Automation pages) | `DS/JunoPage.swift:60-345` (13 files use `JunoPage`) | `Color.clear.overlay{ScrollView}`; `JunoPageHeader` (`ViewThatFits`); action row in a **`GlassEffectContainer`** (`:269`); `JunoPageControls` (flow row) | Measure 768 or 1024; gutter 16/24/32; top 28/20, bottom 48/40. **Title SF Pro Medium 32–44** (`DS/JunoTypography.swift:168-178`); lede 15; header bottom 20; controls gap 20 | glass actions, segmented controls and menu pickers | Web: **serif page title** (`app-page-header.tsx:163`), serif section headings, compact rect controls, dense **row lists** (Connections, Library rows). See `artifacts/continuation-2026-10-15/*-1440.png` against `docs/native/mac-round3/shots/after/*.png`. |
| 33 | Library grid | `MAC/DesktopLibraryScreen.swift:100, 200-250, 470-720` | `LazyVGrid(.flexible, spacing 16)`; card `RoundedRectangle(12)` fill `junoCard`; square thumbnail `aspectRatio(1)` with an inner radius of 4 | Columns by width | buttons | Web: 4-column dense cards with real previews. The Mac shows big square grey placeholders with a double border (card plus thumbnail). |
| 34 | Connections | `MAC/DesktopConnectionsScreen.swift:160+` | Cards with full-width **glass capsule** Details / Disconnect / Connect; a capsule segmented control on top (Apps · Skills · Routines · Memory · Instructions) | — | yes | Web: a 2-column row list, with a `›` chevron or `+` per row |
| 35 | Segmented controls | `DS/JunoSegmented.swift:31-60, 100-350` | Custom: `JunoEqualWidthRow`, `matchedGeometryEffect` thumb, glass track `JunoGlassSegmentTrack` (`DS/JunoGlassControls.swift:266-280`) | Track 32 (compact 28), radius 14 (glass is a capsule), inset 3, gap 2; thumb `fg 0.045`/`0.085` | **Yes** | Web: `rounded-field` (10) track at `bg-sidebar-accent`, `p-0.5`, small rect thumb |
| 36 | Buttons (pages and sheets) | `DS/JunoGlassControls.swift:24-97` (`.junoGlass`), `DS/JunoButtonStyles.swift:28` and `DS/JunoMaterials.swift:93` (`.junoProminent`) | `.buttonStyle(.glass)` / `.glassProminent` `.buttonBorderShape(.capsule)` tinted `junoAccent` (graphite) | Heights 20/24/30/36 by `controlSize`; padding 10/14/16 | **Yes** | Web `Button`: **8px radius rect**, `h-9 px-4` (sm `h-8 px-3`), default = `control-primary`, outline, ghost, `secondary` = `control-neu` (`src/components/ui/button.tsx`) |
| 37 | Menus and pickers | 32 × `.menuStyle(.button)`, 27 × `.menuIndicator(.hidden)`; `junoGlassMenu` (`DS/JunoGlassControls.swift:179-230`); `junoGlassMenuPicker` (`:289-310`, 9 Mac uses) | Native NSMenu content; a custom glass capsule label with a `chevronsUpDown` 12 | — | label glass | Native `Picker(.menu)` (pop-up button) is used only 4 times. The picker look is custom. |
| 38 | Context menus | 23 × `.contextMenu` (rows, projects, messages) | Native | — | system | OK |
| 39 | Popovers | `.popover` × 7: share (`MAC/DesktopSharePopover.swift`, with 4 glass buttons **inside**), outputs, notifications, account, model, retry (`ComposerModelChip.swift:96-115`, a `.junoGlass` button inside) | System popover glass; **fixed frames** (crash rule 2) | Account 288 wide with a hard-coded height; effort 296 | glass **inside** glass | Glass buttons inside system popovers |
| 40 | Sheets | 43 × `.sheet`. Onboarding 480×440 (`MAC/DesktopOnboardingSheet.swift:95`); Upgrade 720×h (`MAC/DesktopUpgradeSheet.swift:345`); 560×520 in four places (Skill, Settings-General, ArtifactLifecycle, Announcement); Assistants 880×640; ArtifactPage 760×560 | `presentationSizing(.form/.page)` (11) | Fixed sizes | **~48 glass controls inside sheets and popovers**: CustomConnector 9, Upgrade 8, Memory 7, Skill 5, AutomationEditor 5, Share 4, … | Glass on glass. The web's dialogs are opaque. |
| 41 | Alerts and confirmations | `.alert` × 6, `.confirmationDialog` × 12, `junoConfirmation` × 18 (`DS/JunoListActions.swift:54-75` wraps the native confirmationDialog) | Native | Title Case buttons | system | OK (native is right) |
| 42 | Settings window | `MAC/DesktopSettingsWindow.swift:224-470`; `MAC/DesktopSettingsScreen.swift`; panes `DesktopSettings*Pane.swift`; `MAC/DesktopSettingsRows.swift`; `DS/JunoSettingsPrimitives.swift` | `NavigationSplitView`; sidebar `List(.sidebar)` reusing `DesktopSidebarNavRow`; a **hand-rolled search field** (`HStack` + `TextField(.plain)` on `fg.opacity(0.05)`, `cornerRadius: 9`; mis-indented, `:411-418`); group titles 12 with **ad hoc top padding 4/14**; Forms `.formStyle(.grouped)` (6) | Section tile: a 36pt **black disc** with a canvas glyph (`:472-488`) | — | Web: a modal with a section rail. The native search should be `.searchable(placement: .sidebar)` or `NSSearchField`; a 9 radius is off the ladder. |
| 43 | Agents (roster, thread header, profile, computer) | `native/Packages/JunoNativeKit/Sources/JunoWorkKit/Agents/Views/*` (4,374 lines); `MAC/DesktopAgentThread.swift`, `MAC/DesktopAgentRoutes.swift`; `DS/JunoAgentFace.swift` | Agent face, pages; computer view with 16:10 poster, radius 8 | `NativeAgentComputerView.swift:105-240`: **several `.junoProminent` black capsules in one view** (Wake, Take control, Hand back, Enable) next to `.junoGlass` | yes | Web Orbit: one action per state, rect buttons |
| 44 | Code product | `MAC/DesktopCodeWorkspace.swift:368-440, 790-860`; STUDIO | Second split view; `.inspector`; toolbar: principal orbit, New session, Terminal / Panel `ToolbarItemGroup`, an overflow `Menu` with 10+ items | Studio radii 22/18; system fonts | composer glass | A second design vocabulary (§2) |
| 45 | Sign-in | `MAC/JunoDesktopRootView.swift:600-812, 885-945` | `HStack`: 46%-width **painted landscape JPG** (`SignInPlateDawn/Dusk`, `:895`) with a gradient and white text; right: a **card** (`junoCard(12)`, `:761`); `TextField` `.roundedBorder` (`:771, 781`, the small system bezel); Sign in `.junoProminent` `.large` (`:727`); Continue in browser `.junoGlass` (`:740`); `.font(.callout)` | Title Newsreader `display(30)` | glass buttons | Web: a dark **galaxy dot-orbit** plate with the Alevr lockup and "Go further." (serif); **no card**; 48px fields at 8px radius; a black **rect** "Sign in" button; legal footer (`artifacts/brand-pass-2026-10-14/web-sign-in-*.png`) |
| 46 | Onboarding and first run | `MAC/DesktopOnboardingSheet.swift` (480×440, title `.title`, choice tiles radius 10, `.junoPress`, `.junoProminent`); `MAC/DesktopFirstRunPresenter.swift`; `MAC/DesktopAnnouncementSheet.swift` | Sheets | — | buttons | The web's `onboarding.tsx` is a modal flow |
| 47 | Menu bar extra and Quick Entry | `MAC/DesktopMenuBarExtra.swift`, `MAC/DesktopQuickEntry.swift` | `MenuBarExtra`; Quick Entry is an AppKit panel with composer glass | — | yes (allow-listed) | Mac-only |

---

## 5. Component and style inventory (Mac app only unless stated)

- **Buttons:**
  - Styles: `.junoGlass` 97, `.junoProminent` 59 (64 incl. other forms), `.plain` 117, `.borderless` 51, `.junoPress` 4, `.bordered` 1, `.link` 1.
  - **32 custom `ButtonStyle` types** across the Mac app, DS and Code:
    - Mac (12): ComposerControlStyle, ComposerDiscStyle, DesktopFindBarControlStyle, DesktopRunLineButtonStyle, DesktopUnderlineLinkStyle, DesktopVoiceCallButtonStyle, InlineArtifactOpenStyle, MediaOverlayButtonStyle, MediaPillButtonStyle, MessageActionButtonStyle, MessageGhostButtonStyle, TranscriptTileButtonStyle.
    - DS (12): JunoToastButtonStyle, JunoChipStyle, JunoProminentButtonStyle, JunoProseIconButtonStyle, JunoPressButtonStyle, JunoAgentFaceButtonStyle, JunoSegmentPressStyle, JunoCatalogTileStyle, JunoCatalogRowStyle, JunoEffortIconButton, JunoGlassButtonStyle, JunoGlassStandInStyle.
  - The web has one `Button` with 6 variants plus `Pressable`.
- **Hover:** 70 hand-written `.onHover { hovered = $0 }` state machines. `.hoverEffect` 0, `pointerStyle` 0.
- **Menus and pickers:**
  - `Menu {` 70, `.contextMenu` 23, `Picker(` 32.
  - Picker styles: `.menu` 4, `.segmented` 2, `.inline` 2, `.tabs` 1. Most pickers are rendered through `JunoSegmented` (60) or `junoGlassMenuPicker` (9).
- **Structure:**
  - `Toggle` 45 (`.switch` 17, `.checkbox` 6). `Form` 10 (`.grouped` 6). `List(` 33. `Table` 0. `LazyVGrid` 13. `GroupBox` 0. `.inspector` 1.
  - `ToolbarItem` 13, `ToolbarItemGroup` 2, `ToolbarSpacer` 1, `.searchable` 2.
  - Presentations: `.sheet` 43, `.popover` 7, `.alert` 6, `.confirmationDialog` 12.
- **Glass call sites:**
  - Mac: `glassEffect` 2 (SearchPanel, FindBar), `GlassEffectContainer` 3, `.buttonStyle(.glass)` 1 (ScrollToLatest), `.bar` material 4.
  - DS: `glassEffect` 7, `GlassEffectContainer` 9, `.glass` 6, `.glassProminent` 4 (Composer, Toast, Page action row, Chrome, Materials, GlassControls, CodeRun).
  - The real footprint is the ~230 control call sites that route through `JunoGlassControls`.
  - `glassEffectID`, `glassEffectUnion` and `backgroundExtensionEffect`: **0** (no morphing and no extension under the sidebar).
- **Typography:** three APIs in parallel.
  - `junoType(...)` ladder: about 560 sites.
  - `junoFont(size:)` raw sizes: about 271 sites. Sizes: 10.5 ×3, **11 ×55**, 12 ×97, 13 ×96, 14 ×6, 15 ×8, 17, 18, 22, 30. Note that 10.5 and 11 sit below the web's 12px floor; only `kbd` is 11 on the web.
  - Legacy `junoCaption()` 53 and `junoRowLabel()` 13; `.font(.callout/.caption/...)` 15.
- **Icons:** `JunoIconView` with 15 different sizes: 8, 9, 10, 11, **12 ×43**, 13 ×33, **14 ×63**, 15, **16 ×77**, 18, 20, 24, 28, 36, 44. The web's ladder is essentially 16 (`size-4`), 18, 20 (`size-5`) and 14 for kbd-level glyphs.
- **Radii in use:** `JunoRadius.field` (10) ×125 and `JunoRadius.card` (12) ×94 are used interchangeably for card-like containers; control 8 ×38; well 10 ×12; panel 16 ×10. There are 19 literal radii: 14 ×4, 9 ×3, 12 ×3, 6, 24 ×2, 7, 5, 3, 2, 10. Capsules are everywhere (glass).
- **Ad hoc alphas:**
  - `junoBorder.opacity(x)`: 8 values (0.4, 0.5, 0.55, 0.6, 0.7, 0.72, 0.8, 0.9).
  - `junoForeground.opacity(x)`: about 22 values (0, 0.05, 0.06, 0.07, 0.08, 0.085, 0.2, 0.25, 0.3, 0.4, 0.45, 0.5, 0.55, 0.6, 0.62, 0.7, 0.75, 0.8, 0.85, 0.9 …).
  - `lineWidth`: 0.5, 0.7, 1, 1.2, 1.25, 1.4, 1.5, 2, 4, 6.
  - Colours themselves are disciplined: 2 `Color(red:)`, 15 white/black uses (mostly the sign-in plate, avatar overlays and remote pairing).

---

## 6. Web ↔ Mac layout differences (what to fix to "look like the web")

1. **Sidebar/content inversion.** The web has a flat `--sidebar` column and a floating inset content card (8px gutter, radius 14, hairline ring). The Mac has a floating glass sidebar and full-bleed content.
2. **Sidebar header missing.** The web has the Alevr lockup, bell and collapse button at the top of the column, with the **Chat | Code segmented control** directly under them. The Mac has traffic lights and the system toggle; the switch sits in the toolbar centre as a custom orbit, and the bell appears only as a conditional list row.
3. **Chat title band.** The web has a 56px in-card band: left an h1 `shell-title` (with a project crumb), right Outputs · Share · Continue-on · More (export) · Incognito. The Mac uses the window titlebar (title, subtitle and title menu) with a principal orbit; Continue-on and Export are not in the toolbar.
4. **Empty chat.** The web shows "What's next, Name?" in serif 50 over a dot-orbit field, a centred landing composer, a tray and starter chips. The Mac shows "What can I help with?" in serif 30 and the composer with its tray. There is no name, field or starters, and the toolbar still says "New chat".
5. **Composer material.** The web uses an opaque card, 1px edge, soft two-layer shadow and a focus step-up, with a 36 send disc and an 8px-rect model chip. The Mac uses an edgeless `.regular` glass slab with a 32 disc and a capsule chip.
6. **Page headers.** The web uses a serif page title and serif section headings, with compact outline/ghost rect actions on the right. The Mac uses SF Medium 32–44 plus a duplicate toolbar title, with glass capsule actions (black prominent capsule) in a `GlassEffectContainer`.
7. **Page bodies.** The web uses dense two-column row lists (Connections, Skills) and four-column preview cards (Library). The Mac uses fat cards with full-width glass pill buttons, three-column square grey placeholders, and double borders.
8. **Tabs and segmented controls.** The web uses a 10px-radius track at `sidebar-accent` with a small rect thumb, with tabs centred in the card (Customize: Apps · Skills · Routines · Memory · Instructions). The Mac uses a glass capsule track with capsule thumbs, larger (32 track).
9. **Search fields.** The web has full-width 36px rect fields at 8px radius. The Mac uses glass capsule `JunoPageSearchField` on pages and a hand-made 9-radius pill in Settings.
10. **Buttons.** Web: rect at 8px radius, `h-9`/`h-8`. Mac: glass capsules at 30/36 high. Primary on the web is `control-primary` (dark rect); on the Mac it is `glassProminent` (black glass capsule).
11. **Right panel.** The web's canvas, activity and thought panels share the content card. The Mac's chat uses a custom overlay dock while Code uses the system `.inspector`; the two have different headers (plain glyphs vs `.bar` material vs `junoSurface 0.5`).
12. **Sign-in.** The web has a dark galaxy plate with the lockup and "Go further.", and a cardless form with 48px fields and a black rect button. The Mac has a painted valley JPG, a card form, small `.roundedBorder` fields and glass capsule buttons.
13. **Settings.** The web uses a modal; the Mac uses a window (acceptable as native). Its rail search and black disc tiles have no web counterpart.
14. **Collapsed sidebar.** The web collapses to a 52px icon rail; the Mac hides the sidebar fully (declared).
15. **Account footer.** The web shows avatar, name, plan and a chevron-updown, with the Upgrade row above. The Mac shows avatar, name, ^ and a separate gear button.
16. **Typography faces.** The web uses Inter, Newsreader and JetBrains Mono. The Mac uses SF Pro and SF Mono, with Newsreader only for the greeting, the product switch and the sign-in title (not for page or section titles).
17. **Code product** uses its own Studio theme (system text styles, composer 22, coral signal), so Chat and Code don't match each other, let alone the web.

---

## 7. The 25 worst offences (ranked by visual impact)

1. **Layout inversion** of a floating glass sidebar against full-bleed content, where the web floats the content card (`MAC/DesktopSidebarChrome.swift:322-344`; `DS/JunoDesktopChrome.swift:46-66`; web `globals.css:4605-4611`).
2. **Glass capsules on the content layer.** Every page and card button is `.glass`/`.glassProminent` (`DS/JunoGlassControls.swift:66-97`, `DS/JunoMaterials.swift:93`; 97 + 64 call sites). Liquid Glass belongs to the navigation layer; on a flat canvas these become featureless grey pills.
3. **Glass on glass.** About 48 glass controls sit inside `.sheet` and `.popover` content (Upgrade 8, CustomConnector 9, Memory 7, Skill 5, AutomationEditor 5, Share popover 4, model-retry popover). The glass lint exempts `JunoGlassControls.swift` (`scripts/check-native-glass.mjs` EXEMPT), so check 4 never fires.
4. **The composer is an edgeless glass slab** (`DS/JunoComposerShell.swift:296-318`). With no hairline and no shadow over a plain canvas it loses the web's crisp card and has no focus state. The source itself admits "glass laid on a freshly-painted fill has nothing to refract" (`DS/JunoDesktopChrome.swift`, `junoReadingCanvas` doc).
5. **A custom dot-orbit product switch in the toolbar centre** (`MAC/ChatToolbar.swift:54`, `DS/Brand/JunoProductOrbit.swift`, also in `DesktopCodeWorkspace.swift:795`). It is a bespoke decorative control in the title bar, contradicts its own spec (§1.4) and the web (sidebar segmented control), and leaves dead code (`junoProductPickerStyle`, `DesktopProductMode.swift:115`).
6. **Page titles in bold-ish SF at 32–44 instead of serif** (`DS/JunoTypography.swift:168-178`, `DS/JunoPage.swift:250`). The web's editorial identity (Newsreader titles and section heads) is lost; this is the "generic SwiftUI app" tell.
7. **Double page title.** The toolbar `navigationTitle` repeats the page header (`MAC/ChatDetail.swift:30-34, 73`; `DesktopNavigationState.swift:131-142`).
8. **Black prominent capsules overused.** Several in one view (agent computer, `NativeAgentComputerView.swift:105-240`); every page has a black "Upload / Add MCP server" pill. The spec's accent budget says "at most one per surface". The web primary is a small dark rect.
9. **Fat card grids with full-width pill buttons** where the web uses dense row lists (Connections, Skills, Library). See `docs/native/mac-round3/shots/after/connections-light.png` against `artifacts/continuation-2026-10-15/connections-dark-1440.png`.
10. **A custom segmented control everywhere** (`DS/JunoSegmented.swift`, 60 Mac uses) with a glass capsule track and ad hoc thumb alphas 0.045 and 0.085 (`:307, :344`), instead of native `Picker(.segmented)` or a quiet web-style track.
11. **The review pipeline renders fake glass.** `junoSnapshotOpaqueGlass` stand-ins (`RealWindowRenderer.swift:32`, `DS/JunoGlassControls.swift:18-22, 151-164`). The approved images don't show what ships, and all of them predate the graphite palette.
12. **The sidebar fights `List`.** A custom `listRowBackground` pill is painted over the system selection to hide the accent blue (`DS/JunoDesktopChrome.swift` `junoSidebarRowSelection`, `MAC/DesktopSidebarChrome.swift:85-104`). Insets are offset arithmetic (`glyphEdge − listOrigin`, `fillInset + 4 − listOrigin` = −4, `.opacity(1)` no-ops at `MAC/DesktopChatSidebar.swift:839-840`), and the "+10 leadingShift" breaks the web's 16px edge (`DesktopSidebarChrome.swift:28-32`).
13. **An oversized "prominent" New chat row** (40pt, 18 glyph, 15 label; `DesktopSidebarChrome.swift:42-47`) breaks the 32pt rhythm. The web's New chat is an ordinary row.
14. **Three typography APIs**: `junoType` ladder, about 271 raw `junoFont(size:)`, and legacy `junoCaption()` / `.font(.callout)`. That includes 58 sites at 10.5 or 11pt (below the web's 12 floor), so metadata reads cramped and inconsistent.
15. **15 icon sizes** (8–44) with no ladder. Glyph-to-text pairing varies: a 12 glyph beside 12 text, a 14 glyph beside 13, a 16 glyph beside 14. The custom Phosphor set also never optically matches SF Pro's weight (`JunoIconView` 319 sites, 0 SF Symbols).
16. **Ad hoc tones**: 8 border alphas, about 22 foreground alphas, and hand alphas in the model chip (`DS/JunoModelPicker.swift:184-189`: `white 0.09`, `fg 0.085`, `fg 0.045`). "Selected", "hover" and "open" therefore differ per component.
17. **The artifact canvas header mixes four button idioms** (`.plain` glyphs with no hover, `.borderless`, a glass segmented control, a glass prominent Save) plus a hand-drawn 1×20 separator and a `junoSurface.opacity(0.5)` ground (`MAC/DesktopArtifactCanvas.swift:761-842, 880-975`).
18. **Panel headers are inconsistent**: `.bar` material (file preview, research report, library picker) against `junoSurface 0.5` (canvas) against none (activity). Chat uses a custom `TrailingDock` and Code uses `.inspector`.
19. **The empty chat diverges in copy and scale**: 30pt "What can I help with?" against the web's 50pt "What's next, Name?"; no starters and no field; a stale doc comment (`MAC/DesktopEmptyChat.swift:62-77, 208-209`).
20. **The settings rail search is hand-rolled**: `fg 0.05` fill, literal radius 9, mis-indented block (`MAC/DesktopSettingsWindow.swift:411-418`). Group headers use 12pt with ad hoc 4/14 top padding (`:421-425`), and section tiles are heavy black discs (`:472-488`).
21. **Sign-in** uses a painted landscape JPG plate and a card form with tiny `.roundedBorder` fields and glass capsule buttons (`MAC/JunoDesktopRootView.swift:727-781, 895`). None of it resembles the web sign-in.
22. **Fixed-size sheets and popovers** (560×520 ×4, 480×440, 880×640, 760×560; a hard-coded account popover height at `DesktopAccountFooter.swift:507-530`; computed effort-panel heights). They clip under the app's own text-size setting and look unbalanced.
23. **32 bespoke ButtonStyles and 70 hand-written hover state machines.** Press and hover feedback is inconsistent: some do opacity 0.7, some scale 0.97, some fill; many `.plain` buttons have no hover at all.
24. **Code has a second design system** (STUDIO): system fonts, composer radius 22, bubble 18, measure 720, and a hand-typed coral `Signal` with hand-typed syntax colours (`StudioTheme.swift:29-141`). Chat and Code read as two apps.
25. **Stale identity prose.** Warm paper, coral and hex values remain in DS doc comments (`JunoColors.swift:10-14, 65, 76, 220-233`; `JunoDesktopChrome.swift` selection docs), and the orphaned `JunoMac` (macOS 15) and `JunoCode` xcconfigs remain. Future agents and humans keep designing against a palette that no longer exists.

---

## 8. Keep (already good and close to the web)
- Generated tokens, colours, radii, type and spacing, with a CI drift check. The generated shell contract drives the sidebar IA and copy.
- Transcript: measure, gutters, bubble, prose metrics, code blocks, tables, citations, run line, sources pill, reply actions and the scroll-edge effect.
- Native menus, context menus, `confirmationDialog`, the `Settings` scene, a real window title, `MenuBarExtra`, and ⌘ commands.
- The five allow-listed custom glass sites: composer cluster, ⌘K, find bar, toasts and Quick Entry. The composer is right to float, but it needs a defined edge.
- The DEBUG preview harness with its window-server snapshot (the basis for a CI image job).

## 9. Key files for the redesign agent
- `DS/JunoDesktopChrome.swift` (column metrics, selection, glass helpers, toolbar metrics)
- `DS/JunoGlassControls.swift`, `DS/JunoButtonStyles.swift`, `DS/JunoMaterials.swift` (button styles)
- `DS/JunoSegmented.swift`, `DS/JunoPage.swift`, `DS/JunoComposerShell.swift`, `DS/JunoTypography.swift`, `DS/JunoSurfaces.swift`, `DS/JunoLayout.swift`, `DS/JunoColors.swift`, `DS/Generated/JunoGeneratedTokens.swift`
- `MAC/DesktopChatWorkspace.swift`, `MAC/ChatDetail.swift`, `MAC/ChatToolbar.swift`, `MAC/DesktopChatSidebar.swift`, `MAC/DesktopSidebarChrome.swift`, `MAC/DesktopAccountFooter.swift`, `MAC/DesktopProductMode.swift`, `MAC/ChatComposer.swift`, `MAC/ComposerModelChip.swift`, `MAC/DesktopEmptyChat.swift`, `MAC/DesktopArtifactCanvas.swift`, `MAC/DesktopSettingsWindow.swift`, `MAC/JunoDesktopRootView.swift`
- Specs: `docs/native/MACOS_LIQUID_GLASS_REDESIGN.md` (§0 rules; §0.8 register of deliberate differences), `docs/native/WEB_TO_NATIVE_DESIGN.md`, `docs/audit-2026-10-29/DESIGN.md` (current palette)
- Lint gates: `scripts/check-native-*.mjs` plus the baseline (the glass gate exempts `JunoGlassControls.swift`)
