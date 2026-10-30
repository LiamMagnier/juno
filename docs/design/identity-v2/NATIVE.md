# Identity v2 · NATIVE (macOS 26 and iOS 26)

Appendix to `docs/design/IDENTITY_V2.md` §13. Source: the native audit
(`/tmp/claude-0/-home-user-juno/fa198b77-5ed6-5d1e-9041-b11ebba8d703/scratchpad/identity-v2/native-audit/AUDIT.md`,
cited `NA §n`), d3 NATIVE, the platform judge's grafts and must-fix list, and the consensus plan all three
directions shared. Nothing here was compiled or rendered (no Swift toolchain in this environment); every
item that depends on what the OS draws is marked **verify on device**. Revision 3 applies the review:
what carries the identity natively, keyboard-only focus, accessibility text sizes, the face port split,
iPhone-only alternate icon.

## 0. Rules (these replace most of the 184-entry `docs/native/WEB_TO_NATIVE_DESIGN.md` register)

1. **Same anatomy, platform expression.** Sidebar order, composer slots, menu contents and order, the 12
   settings sections, the depth rule and the colour budget are identical on web, Mac and iPhone. How each is
   drawn is the platform's.
2. **The system draws the chrome; Alevr draws the work.** Toolbars, the Mac sidebar container, menus,
   context menus, popovers, sheets, alerts, search fields and navigation bars are system components and take
   Liquid Glass automatically. The stage, transcript, composer, cards, the needs-you card, faces and pages
   are Alevr's: opaque, tier 0, or lifted with a generated shadow (tier 1).
3. **No Alevr glass.** No `.glassEffect` on content, no glass page buttons, no glass composer. The custom
   glass allow-list starts empty.
4. **Tokens are generated, never typed.** Colours (four-way), radii, type rungs with platform data,
   springs and elevation come from `JunoGeneratedTokens.swift`; `AccentColor` and (iOS) `LaunchBackground`
   come from the same generator. No literal colour, radius or duration in product code.
5. **Same motion character.** The four springs map 1:1; `platformFactor 0.75` is removed.
6. **Focus rings are keyboard-only on every platform** (owner rule 1; §2.1).

### 0.1 What carries Sculpted natively

The web's composition (the granite base with an inset paper stage, and a two-lane answer) is only partly
available to native apps, because the system owns the window chrome: on macOS 26 the sidebar is a glass
column that floats over the detail column, and on the iPhone there is no room for a margin. The judge's
note ("the identity-through-composition does not cross platforms") is accepted, and answered by naming what
does cross:

| Carrier | Mac | iPhone |
|---|---|---|
| The stage on the base | **the detail column draws `--base`, and the stage is an inset sheet**: radius 16 continuous, 8 pt from the window's trailing and bottom edges and from the sidebar column, starting under the toolbar's safe area (verify on device with the glass sidebar and the unified toolbar; fallback if the toolbar or the sidebar's edge reads badly: edge to edge, decided from the W7 screenshot pair) | the drawer is a **push** surface: opening it slides the stage aside and shows the base behind a stage sheet with radius 16 continuous corners and the stage edge (`shots/` W8 set) |
| The margin | the paragraph-level margin at ≥ 900 pt detail width (§1) | a **source line** under each cited paragraph (IDENTITY_V2 §10.1 "none" tier), plus the 44 pt sources control |
| The lift | the needs-you card and the composer lift with the generated tier-1 shadow and the shadow lag (MOTION §3.1) | the same, plus `.warning` haptic when the card arrives |
| The Arch as live light | the sidebar mark's stone turns bronze while anything in the window is live; the menu bar extra (template) stays mono | the drawer header mark does the same; the voice bar's stone tracks the voice level |
| The palette | granite and bronze through the generated four-way roles; AccentColor = ink | the same; the literal ChatGPT-measured palette is deleted |
| The receipt | the stamp line under each answer | the same |

Accepted as platform expression: the Mac's floating glass sidebar inverts the web's "sidebar on the base"
picture, and the iPhone shows one lane. Both are the platform's, and neither is fought.

## 1. Shell mapping

| Web | macOS 26 | iOS 26 (iPhone; iPad follows the Mac layout in regular width) |
|---|---|---|
| Sidebar on the base | `NavigationSplitView` sidebar column, `List(selection:)` `.listStyle(.sidebar)`; **the system draws the selection** (delete `junoSidebarRowSelection` and `DesktopSidebarRowFrame`, NA §3.8); rows `Label(title, image: "alevr.library")`; section headers in sentence case `caption` (no SF Mono, NA §2); the same order as the web (IDENTITY_V2 §11.2); Orbit lists busy agents only (working, thinking, listening, waiting, blocked; fixing `DesktopChatSidebar.swift:159-163`) with the state words of COMPONENTS §7; agent faces at 20 pt | Custom push drawer kept (a reasonable pattern, nobody's property) but rebuilt: corner from `ConcentricRectangle` instead of the device-corner table (`JunoMobilePhoneShell.swift:56-63`), **opens from the leading edge** (`layoutDirection`-aware: the left in LTR, the right in RTL), dim from `JunoGeneratedShell.drawerDim` (ink 12 % light, black 50 % dark; today a literal 0.04), `glide` spring carrying fling velocity; the stage it pushes shows its 16 pt continuous corners against the base (§0.1) |
| Stage | `--base` detail column with the inset stage sheet (§0.1) | `NavigationStack` root on `--stage` |
| Stage header | unified toolbar: `navigationTitle` (chat title) + **`navigationSubtitle` = the project, Incognito or memory state** ("Q3 planning · uses project memory only", "Incognito · memory is off in this chat"; empty for an ordinary chat), the same slot and text as the web (IDENTITY_V2 §10.9, §11.4); the stamp line stays under each answer only; `toolbarTitleMenu` (Rename, Add to Project, Pin, Share, Delete…), one `ToolbarItemGroup` (share, more), monochrome | `.toolbar`: `.topBarLeading` drawer button, `.topBarTrailing` new chat; title inline with a title menu and the same subtitle rule; **no custom glass on the principal item** (glass inside glass, `JunoMobilePhoneShell.swift:270`) |
| Composer | `JunoComposerShell` in `.safeAreaBar(edge: .bottom)`, opaque, radius 24 continuous, tier 1 only while content scrolls beneath (`onScrollGeometryChange`); COMPONENTS §10's anatomy (model token first, Talk, two-state send) | **the existing `JunoComposerShell` is extended to the iPhone** (it already serves `ChatComposer.swift` and `DesktopQuickEntry.swift`; its "the iPhone composer's and ChatGPT's" comments are rewritten in Alevr's terms and its metrics come from `JunoGeneratedShell`); the 1,977-line `JunoMobileComposer.swift` card is retired; 40 pt controls with 44 pt hit areas, `@ScaledMetric`; opaque `--float`/`--stage` + 1 pt `--line` (HC `--line-strong`) |
| The margin | when the detail column is ≥ 900 pt: a column and a rail; notes placed at the citing **paragraph's** top through `anchorPreference` (SwiftUI `Text` exposes no per-run line frames without TextKit), pushed down to avoid overlap. **Reading order**: each paragraph's notes are its `accessibilityChildren` (the paragraph view is `.accessibilityElement(children: .contain)` with the notes after the text), so VoiceOver reads a note after its paragraph, not all notes after the column; below 900 pt the source line (as iPhone) | no rail. **Citation numerals are links inside the text** (`AttributedString` runs with an `alevr-cite://<answer>/<n>` URL handled by `.environment(\.openURL)`), reachable through the VoiceOver links rotor; a run's tap area is its glyphs, so the touch path is the **source line** under the paragraph (a `Button`, min height 32 pt, "Sources 1 and 2: ledger.example.com, field-notes.example.org") and the 44 pt sources control at the answer's end, both opening a `.medium`/`.large` sheet |
| Page header | `JunoPage` header: SF 22 semibold title (`title-1` Mac size), description, primary `.borderedProminent` tinted ink, secondary `.bordered` | system large title in the navigation bar; actions in the toolbar |
| Settings (12 sections) | `Settings` scene with a sidebar of exactly the web's 12 sections in the same 3 groups; Mac-only panes fold into them: Keyboard and Menu bar → General; Remote and local agents → Devices; Code shortcuts → Code (today 23 sections, `DesktopSettingsWindow.swift:14-37`) | a pushed destination from the drawer's gear with the same 12 sections and names (today 15 routes with "Writing", "Usage", "About", "Archived": fold into General, Plan & usage, Account, Data & privacy) |
| Agent thread | header as a `safeAreaBar(edge: .top)` content view: face 34 (AGENTS.md §4.3), name, the status line; no blur | same, compact |
| Needs-you card | opaque `--float` + generated tier 1 while waiting, its shadow view landing 70 ms after the card (MOTION §4); settles on answer; on arrival `AccessibilityNotification.Announcement("Otto needs you: Send this summary to 4 people?").post()` | same + `.sensoryFeedback(.warning, trigger:)` when it arrives, alongside the announcement (a haptic is not an announcement) |
| Voice bar | COMPONENTS §13 inside `JunoComposerShell` | same; bottom with the safe area |

The shell contract (`contracts/product/juno-shell-v1.json`) is compiled into **both** apps (today the
iPhone keeps its own `JunoMobileSection` and settings routes, NA §0.9).

## 2. Colour

- `Color.junoAdaptive(_:)` resolves **four ways** (light, dark, HC light, HC dark) from the generated pair:
  AppKit `NSAppearance.bestMatch(from: [.aqua, .darkAqua, .accessibilityHighContrastAqua,
  .accessibilityHighContrastDarkAqua])`; UIKit `traitCollection.userInterfaceStyle` +
  `accessibilityContrast`. Today the HC halves are generated and never read (NA §1.3).
- The iPhone literal palette is deleted (`JunoColors.swift:60-133`, `JunoSurfaces.swift:33-46`:
  `#FFFFFF`/`#000000` canvas, `#F7F7F8` card, ChatGPT-measured greys). The iPhone uses the generated roles
  like the Mac; dark is granite (`--stage` `#18191b`), not true black, so elevation has room.
- **`AccentColor.colorset` = ink** (`#15171b` / `#e8eaec`), generated, in both apps. Effects: checked
  toggles and default buttons are graphite, consistent with the web's ink checked controls; the Mac
  sidebar selection is the system's (graphite pill when focused, system grey when not). macOS applies an
  app's AccentColor only for users whose system accent is Multicolor; users who chose an accent keep
  theirs, which is the platform's right. **Verify on device** that the graphite pill does not read too
  heavy; if it does, leave the sidebar to the system accent (J-platform's d2 graft) and keep ink elsewhere.
- **`LaunchBackground.colorset` = `--stage`** light and dark, generated, **iOS only** (the Mac has no
  launch screen), so the iPhone launch screen matches the first frame (today `#18191B` vs the phone's
  `#000000`: a flash on every dark launch, NA §0.4). **Verify on device** in both appearances.
- Bronze and signal blue are applied only through `JunoLive.swift` (`LiveDot`, `LiveLabel`, `WritingPoint`),
  `JunoNeedsYou.swift`, `JunoBrand*.swift` (the stone) and the face files (`JunoAgentFace.swift`,
  `Generated/JunoGeneratedFaces.swift`: the working orbit and the needs-you badge); the composer caret is
  the system's (ink via AccentColor).
- The hand-typed status ramp (`JunoStatus.swift:17-35`, 213 call sites) moves to the generated inks and is
  deleted.
- Stale prose rewritten with the values: `JunoColors.swift:9-14` and the "warm paper / coral" comments,
  `JunoRadius` docs, `JunoComposerMetrics` ("ChatGPT's"), `JunoOverlays.swift:170`,
  `docs/native/MACOS_LIQUID_GLASS_REDESIGN.md` §0.2 (NA §1.4).

### 2.1 Focus: keyboard only (owner rule 1)

macOS draws its focus ring on a text field when the field takes focus by a pointer click; the Mac app
already suppresses this in places (`.focusEffectDisabled()` at 23 call sites, e.g.
`DesktopSearchPanel.swift:652`, `MessageActions.swift:334`, `TranscriptAttachments.swift:138`). The rule:

- **Alevr-drawn text entry and custom controls** (the composer field, the sidebar and settings search
  fields, rename fields, settings text fields, custom buttons and rows) use `.focusEffectDisabled()` and
  draw their own 2 pt `--ink` ring **only when focus arrived by keyboard**: a `@FocusState` binding plus a
  shared keyboard-modality signal (`JunoInputModality`: the last input event was a key event, or Full
  Keyboard Access is on), the native twin of `src/lib/input-modality.ts`.
- **System-drawn controls** (`Toggle`, `Picker`, `Button` in system styles, `List` rows) keep the system
  ring, which macOS shows for keyboard navigation; nothing Alevr adds draws a ring on click.
- iPhone: no ring for touch; with a hardware keyboard or Full Keyboard Access the same modality rule.
- Gate: `scripts/check-native-focus.mjs` (new, W7) flags any `TextField`, `TextEditor`, `SecureField` or
  `.focusable()` in product code without `.focusEffectDisabled()` and a `JunoFocusRing` modifier, outside
  an allow-list of system-styled controls. Device check: a click-focus vs Tab-focus screenshot pair of the
  composer and the sidebar search on the Mac (§9).

## 3. Liquid Glass: where, and deliberately where not

| Surface | Glass? | Why |
|---|---|---|
| Mac sidebar column, toolbars, title bar | yes (system) | system navigation layer |
| Menus, context menus, popovers, alerts, confirmation dialogs | yes (system) | system floating layer |
| iPhone navigation bar items, the `Menu` morph from the composer `+`, sheets at the medium detent | yes (system) | system |
| Sheets at the large detent | no (the system makes them opaque) | reading surface |
| Composer and voice bar (Mac and iPhone) | **no** | a text-entry surface must stay legible from clear to tinted glass and under Reduce Transparency (J-ux); glass only after device proof and an owner decision |
| Page buttons, segmented controls, search fields inside pages | **no** | the 121 `.junoGlass`, 86 `.junoProminent` and 28 `JunoSegmented` glass sites (NA §0.5) become `.bordered`, `.borderedProminent` tinted ink and `Picker(.segmented)` |
| Product switch (Chat · Code) | none | Code is a sidebar destination; `JunoProductOrbit` is deleted |
| App icon | yes (Icon Composer) | the stone's own glass group renders the lift |

`check-native-glass.mjs` stops exempting `JunoGlassControls.swift`, counts call sites of `.junoGlass`,
`.junoProminent`, `.glassEffect` and `JunoSegmented` per file, and ratchets to zero outside an empty
allow-list.

## 4. Menus

- **Mac**: system `Menu` / `.contextMenu`; Title Case ("Add Photos and Files…"); shortcuts declared with
  `.keyboardShortcut` so `NSMenu` shows them (New Chat ⌘N lives in the menu bar's File menu); `Section` for
  groups; one nested `Menu` for submenus ("Run a Skill ▸"); `Toggle` rows for Web search and Deep research.
  Icons follow the web's all-or-none rule per section.
- **iPhone**: the composer `+` and the model token become system `Menu`s (they morph from their button in
  glass and handle VoiceOver, keyboard and pointer), replacing the bloom panels and the 4,000 × 4,000 tap
  catcher (`JunoMobileComposer.swift:620-663`, `JunoMobileComposerPanels.swift` with its 6 pt blur
  entrance). Nested `Menu`s present as drill-in, the same rule as the web's phone sheet. Effort is a
  `Picker` with `.pickerStyle(.inline)` inside the model `Menu` (the native equivalent of the web's
  menuitemradio group). Sentence case.
- Context menus on chat, Library and Research rows and messages carry the web's items and order; their top
  items mirror the row's swipe actions (leading Pin; trailing Archive, Delete).
- Menu glyphs come through `Label(_:image:)` with the generated symbols so they follow Dynamic Type (today
  `JunoIconView(size: 15)` bitmaps in `JunoMobileMessageMenu.swift`).

## 5. Icons, type, motion, haptics

- **Icons**: ICONS §3 (variable Ultralight-S / Regular-S / Black-S templates, Node outliner, RTL flags,
  `Label(_:image:)`; SF Symbols only inside system chrome).
- **Type**: SF Pro for all work (Dynamic Type on iPhone; the app text-size scale on Mac). `JunoType`
  carries the generated ladder with `iosTextStyle`, `macPointSize` and `appleWeight` per rung (TOKENS §2.2,
  §2.3); the iPhone moves from 0 to all `junoType` calls; `JunoSerif` is replaced by `JunoDisplay`
  (Geologica) with one allowed use: the home greeting, onboarding and About. **The bundled files are TTF**
  (Apple documents app fonts as TTF/OTF): the instanced variable Latin 69,508 B + Cyrillic 36,876 B
  (`tools/fonts-out/`, measured), registered through `UIAppFonts` / `ATSApplicationFontsPath`, OFL beside
  them; setting the 460 axis value through `kCTFontVariationAttribute` is **unverified on device** (fallback:
  the static 460 TTFs, 41,380 B + 22,756 B). Navigation titles stay system. `check-native-type.mjs`
  ratchets `junoFont(size: <literal>)` and raw `.font(.<style>)` in product files, with a display allow-list
  (`JunoDisplay` only).
- **Motion**: MOTION §4. Reduce Motion through `JunoMotion.reduced(_:when:tier:)` with MOTION §6's rule
  (size and layout changes instant); no blur in any transition (`check-native-motion.mjs` bans it).
- **Haptics (iPhone)**: `.warning` only when an agent needs you; `.selection` on toggles, segmented changes
  and Mute; `.impact(weight: .light)` when the drawer crosses its open threshold. **No haptic on send**
  (frequent) and none on starting or ending voice. Mac: trackpad `.alignment` when the sidebar snaps to its
  minimum.

### 5.1 Accessibility text sizes (iPhone Dynamic Type, Mac text size)

Fixed heights are minimums; at `dynamicTypeSize.isAccessibilitySize` (AX1–AX5) layouts change shape rather
than truncate:

| Element | Default | At accessibility sizes |
|---|---|---|
| Rows and list rows | min 44 / 56 pt | grow with the text (`.frame(minHeight:)`, never `height:`) |
| Agent header status line ("Needs you · Weekly summary · Step 4 of 5 · 6 min 12 s") | one line | wraps: the state word on its own line, the rest below (`ViewThatFits` between `HStack` and `VStack`) |
| Stamp line | one line at the action row's end | moves under the action row, wraps at " · " |
| Orbit row state word | trailing | under the name |
| Step rail timer | trailing | under the label |
| Needs-you actions | side by side | full width, stacked, primary first |
| Segmented controls | `Picker(.segmented)` | a `Menu`-style `Picker` |
| Composer controls | 40 pt, `@ScaledMetric(relativeTo: .body)` | scale up to 56 pt; tokens wrap to a second row before any label truncates |
| Display greeting | Geologica 32 `relativeTo: .largeTitle` | capped at 44 pt (`.dynamicTypeSize(...DynamicTypeSize.accessibility2)` on that view only), wraps to at most three lines |

W8 screenshots at AX3 and AX5: thread, agent thread with the needs-you card, drawer, settings, home.

## 6. Faces

The native face is ported from the web's flat rig, not redrawn, **in two parts**, because the rig is
procedural (`face-rig.ts` 2,001 lines, 79 functions such as `gateAt`, `rebaseSegment`, `holdPose`;
`face-geometry.ts` 1,280 lines with `drawFace` and `pairRoll`) and a generator can only project data:

1. **Generated data** (`scripts/generate-native-faces.mjs` → `Generated/JunoGeneratedFaces.swift`,
   `--check` in CI): the body outlines per body and size class (`face-outlines.ts`), the eye cuts (`CUT`),
   seats, size classes, the orbit (`RING`), `EYE_LEAN`, every state's pose keyframes and timings, the tone
   ids and the paint roles (§1.2 of TOKENS: working orbit `--bronze-fill`, badge `--signal`, blocked ring
   `--ink-2` and ball `--danger`, one eye ink in both themes).
2. **The procedural rig, ported by hand** to Swift in `JunoAgentFace.swift` (1,504 lines today): blink
   scheduling, gaze, orbit physics, state gating and the never-in-lockstep rules, reading only the generated
   data.
3. **Golden frames across platforms**: a Node script samples the web rig at fixed times for every state,
   body and size class (20, 28, 48, 96 px) into `tests/fixtures/face-golden.json` (eye centres, eye sizes,
   orbit ball position, badge state); a Swift test on the macOS runner renders the same moments and
   compares within 0.25 pt.

`JunoAgentFace.swift` draws flat at every size: the radial gradient, ground shadow and eye glints at
≥ 40 pt are deleted (`JunoAgentFace.swift:1220`, `:1357-1386`, `:1454`; NA §0.2). **Sequencing**: the face
files are being edited by the Orbit workstream now (`face-rig.ts`, `face-geometry.ts`, `agent-face.tsx`
modified in the working tree on 30 Oct 2026); W7's face port starts only after that workstream merges, from
the merged files, and the generator's `--check` pins their hash. This closes task #19 with the same rig the
web uses.

## 7. Removal list (decorative debt and the ChatGPT-modelled shell)

| Delete | Where | Replacement |
|---|---|---|
| `JunoComposerAura`, `JunoProviderGlow`, `JunoMobileAuraLayer`, `JunoMobileAuraLight` | package; `JunoMobileGreeting.swift:52`, `:150` | none (mounted nowhere) |
| `JunoBorderBeam` | package | none (no callers) |
| `JunoShimmerText` (17 sites), `JunoAIcssShine` (6) | package | `LiveLabel` + `LiveDot` |
| `JunoProductOrbit` | Mac toolbar, iPhone bar, Code preview | Code is a sidebar destination |
| `JunoDotGrid(interactive:)` pointer chase | onboarding, both apps | none |
| `JunoGalaxyMark` as the live mark (10 files) | live states | `LiveDot` |
| Painted plates' procedural `JunoMobileLandscape` fallback and parallax | iPhone front door | the base with the lockup |
| Follow-up chips | `DesktopChatWorkspace.swift:2319`, `FollowUpChips.swift`, `JunoMobileConversationsView.swift:1124` | none (owner rule) |
| ChatGPT references in comments and copy (45 in `native/iOS/JunoMobile/App`, 9 on the Mac, NA §0.1) | e.g. `JunoMobilePhoneShell.swift:4`, `:83`, `:136`, `:307`; `ChatToolbar.swift:50`; `DesktopEmptyChat.swift:204`; `JunoComposerShell.swift` metrics comments | design rationale written in Alevr's own terms |
| "What can I help with?", "Private chat" and the other retired strings (IDENTITY_V2 §14.2) | `DesktopEmptyChat.swift:209`, `JunoMobileConversationsView.swift:2979`, `ChatToolbar.swift:138`, `JunoMobileIncognito.swift:256`, `:295` | the contract greeting and "Incognito" |
| App-local duplicates: `JunoMobileCapsuleSegmented`, the shadowed `JunoGlassButtonStyle` (`JunoMobileChrome.swift:395`), the app-local `junoGlass(in:)` | iPhone app | package components |
| `junoSheetSurface` custom Mac sheet ground | `JunoOverlays.swift:170` | system platters (verify the edge on the granite stage on device) |
| Brand: `Brand/JunoProductOrbit.swift`, `Brand/JunoDotGrid.swift` | package `Brand/**` | deleted by W1, which owns `Brand/**` |

## 8. Native gates (W7 adds or changes; all run in Node in CI)

| Gate | Checks |
|---|---|
| `check-native-glass.mjs` | wrapper-level counting; empty allow-list |
| `check-native-type.mjs` | `junoFont(size: <literal>)` and raw text styles in product files ratchet to 0; display allow-list |
| `check-native-colour.mjs` (new) | literal colours and `Color.white/black.opacity` (today only an XCTest register runs on macOS); bronze and signal budgets (TOKENS §1.5), including the generated face file |
| `check-native-radius.mjs` (new) | `cornerRadius: <literal>` (75 sites today) outside the generated ladder |
| `check-native-motion.mjs` | no `.blur` in transitions; spring bounce ≤ 0.10; no `platformFactor` |
| `check-native-focus.mjs` (new) | every Alevr-drawn text entry and custom focusable has `.focusEffectDisabled()` and the keyboard-only ring (§2.1) |
| `check-native-copy.mjs` (new) | `JunoShellContract.retired` strings, including the competitor lines of IDENTITY_V2 §14.2, never appear in Swift string literals or `.xcstrings` values |
| `check-ia-parity.mjs` (new, web + native) | sidebar order, the Orbit busy filter, pinned-first Recent, exactly 12 settings sections with the same ids, and the canonical homes of Memory and Apps (IDENTITY_V2 §11.3), compared between the contract, `src/components/settings/settings-sections.ts`, the Mac and the iPhone |
| `check-native-targets.mjs` | 150 violations today (NA §5) ratchet to 0 for touch; 28 pt minimum on Mac |
| `npm run native:icons:check`, brand geometry `--check`, faces `--check` | generated assets match their sources |

## 9. Verify on device (blocking for W7 / W8 sign-off; none of these was rendered here)

1. Glass interplay: system toolbars over the opaque stage and composer, Mac and iPhone, with Reduce
   Transparency on and off, and with the iOS Tinted glass setting.
2. Mac sidebar selection weight with AccentColor = ink (graphite pill), focused and unfocused windows.
3. The iPhone composer opaque over bright and dark transcript content; Dynamic Type at AX3 and AX5 (§5.1).
4. The Icon Composer render of the three-layer icon in default, dark, tinted and clear; the iPhone Light
   alternate icon chosen from Settings › General.
5. LaunchBackground matches the first frame on iPhone in light and dark (no flash).
6. The Mac sheet edge on the granite stage without `junoSheetSurface`.
7. SF Symbols app validation of the variable templates; 24 pt bar glyphs at `.light`.
8. Elevation parity: web vs native tier 1 and tier 2 shadows side by side (TOKENS §6, the spread
   approximation), and the needs-you shadow lag.
9. **The Mac inset stage** with the glass sidebar and the unified toolbar, light and dark, against the
   edge-to-edge fallback (§0.1): screenshot pair for the owner.
10. **Focus**: a click-focus vs Tab-focus screenshot pair of the composer and the sidebar search (no ring on
    click, the ink ring on Tab).
11. Geologica's variable TTF with the 460 axis value set through the font descriptor (§5).
12. The voice bar on both devices, including VoiceOver reading finished caption sentences.
