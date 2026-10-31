# Map: the native iOS app (JunoMobile) for the redesign

Read-only survey, 2026-10-31, of `main` @ `e532983ea`. Nothing in the repo was changed.

Path shorthands used below:

| Short | Full path |
|---|---|
| `App/` | `native/iOS/JunoMobile/App/` (102 files, ~47k lines) |
| `W/` | `native/iOS/JunoMobile/Widgets/` |
| `DS/` | `native/Packages/JunoNativeKit/Sources/JunoDesignSystem/` |
| `CK/` | `native/Packages/JunoNativeKit/Sources/JunoChatKit/` |
| `GEN` | `DS/Generated/JunoGeneratedTokens.swift` (generated, 1164 lines) |

**About the screenshots.** The screenshots in the repo are older than the code. `docs/design/premium-pass/ios/after/*` (Sep 26) still shows a 4-tab bar and a "runs in progress" pill. `docs/release/evidence/phase2-final/iphone-*` (mid-Oct) shows an older drawer with a "Needs attention" card and a coral "Chat" button. Neither matches the current push drawer or top bar, so everything below comes from reading the code. The brand palette is now graphite (light canvas `#FCFCFD`, dark `#18191B`, primary ink `#1A1C1F`/`#E6E8EA`) with ultramarine `presence` for live state (`docs/audit-2026-10-29/DESIGN.md`). Many iOS comments still describe "coral", "warm cream" and "umber", and that drift is part of the problem.

---

## 0. TL;DR

1. **The shell copies ChatGPT and Codex, not the web layout.** The comments cite "redesigned against the ChatGPT iOS app" (`App/JunoMobilePhoneShell.swift:4`), "after Codex's remote" (`App/JunoMobileCodeHome.swift:1`), the Claude app, Calendar, and Notes/Photos. The web layout is cited mainly for metrics.
2. **Glass is used everywhere.** There are about 114 call sites of custom glass or glass button styles in `App/`. The Mac's rule "glass in exactly five places" (`scripts/check-native-glass.mjs` check 3) explicitly exempts the phone. The result is glass buttons and capsules on content, glass inside glass, ink-tinted glass, and blur materials (`.thinMaterial`) mixed with Liquid Glass.
3. **There are five composers.** Chat, Incognito, Code voice, the Code-remote link composer and the terminal input each use a different radius (26/24/24/22/16). None of them uses the shared `DS/JunoComposerShell.swift`, which the Mac does use.
4. **Icons are rasterised and do not scale with Dynamic Type.** Every glyph is a web Lucide/Phosphor shape (416 custom `.symbolset`s) drawn to a bitmap at a fixed point size (`DS/JunoBrand.swift:980-1040`). There are 274 `JunoIconView` call sites at 13 different sizes (9–44pt) and zero SF Symbols.
5. **Many values are ad hoc.** Type uses 11 `junoFont(size:)` sizes plus about 300 system text-style calls. There are about 35 different `Color.x.opacity(n)` fills, 7 custom `ButtonStyle`s, 3 hand-rolled segmented controls, 2 hand-rolled search fields, and hard-coded radii of 6/8/10/12/16/18/20/22/24. All of this sits on top of a generated token ladder that the app mostly ignores.
6. **The deployment floor is iOS 26.0 everywhere,** so no availability guards are needed. Snapshot tests exist and render in CI on `macos-26`, but CI keeps no PNGs (§11).

---

## 1. Platform, deployment target, availability

| Item | Value | Where |
|---|---|---|
| iOS deployment target | **26.0** | `native/iOS/JunoMobile/project.yml:8-9`; `native/Config/JunoMobile-{Debug,Stable,Next}.xcconfig:6` |
| Package floor | `.iOS("26.0")`, `.macOS("26.0")`. The comment says every `if #available` glass fallback was deleted. | `native/Packages/JunoNativeKit/Package.swift:26-33` |
| Availability guards in `App/` | none for glass. The only one is `@available(iOS, deprecated: 26.0)` in `App/JunoMobileWebAuthenticationClient.swift:94`. | — |
| Guards in DS | one, `#available(macOS 26.4, iOS 26.4, *)` | `DS/JunoDesignTokens.swift:847` |
| Drift check | `npm run native:entitlements:check` (`scripts/check-native-app-config.mjs`) fails if the floors drift | `.github/workflows/native.yml:220-231` |

**Implications for the redesign.** All iOS 26 APIs can be used directly: `glassEffect`, `GlassEffectContainer`, `.buttonStyle(.glass/.glassProminent)`, `glassEffectID`, `ToolbarSpacer`, `.sharedBackgroundVisibility`, `tabBarMinimizeBehavior`, `tabViewBottomAccessory`, `safeAreaBar`, `scrollEdgeEffectStyle`, `ConcentricRectangle`.

Several of these are unused today:
- `ToolbarSpacer`, `sharedBackgroundVisibility`, `ToolbarItemGroup` (2 uses), `tabBarMinimizeBehavior`, `tabViewBottomAccessory`.
- `safeAreaBar`, which was rejected because the `+` panel overflows the bar (`App/JunoMobileConversationsView.swift:2821-2829`).

---

## 2. Where web tokens are projected into Swift

| Pipeline | Source → output | Notes |
|---|---|---|
| Colour, motion, shell, gesture, radius, type, spacing | `src/app/globals.css` + `tailwind.config.ts` → `scripts/generate-design-tokens.ts` (`npm run design:tokens`, `:check` in CI) → **`GEN`** | Digest `91e861b0073c3c49`. 4 appearances per colour: light, dark, and high-contrast light/dark (`GEN:19-45`). |
| Radius ladder | `GEN:1054-1072` `JunoGeneratedRadius`: micro 2, sm 4, xs 6, md/control/bubbleTuck 8, field 10, card/popover/surface/bubble 12, menu/composerControl 14, panel/composerAction 16, **composer 26**, stage 28 | Aliased by role in `DS/JunoSurfaces.swift:375-425` (`JunoRadius.row`=8, `well`=10, `card`/`message`/`floating`=12, `composer`=26). |
| Spacing | `GEN:1130-1163` (2…48) → `JunoSpace` (`DS/JunoSurfaces.swift:238-300`) | micro 2, hairline 4, tight 6, snug 8, close 10, cozy 12, comfy 14, regular 16, ample 18, roomy 20, section 24, wide 28, region 32, expanse 40, vast 48. |
| Type ladder | `GEN:1095-1126` (hero…kbd, e.g. body 15/1.6, reading 16/1.7, nav 14, ui 13, label/caption 12) | iOS rarely reads it. Only `JunoType.*` in the thought-process panel (`App/JunoMobileThoughtProcess.swift:308-358`) and `JunoProseMetrics.bodySize = reading 16` (`DS/JunoProse.swift:30`). |
| Shell | `GEN:1012-1036`: drawerWidthFraction 0.8, drawerWidthMax 380, drawerParallax 0.22, drawerDimLight 0.12, drawerDimDark 0.3, transcript widths 640/768/992 | |
| Layout atoms (hand-written over the generated steps) | `DS/JunoLayout.swift:19-200`: touchTarget 44, Bar.button 44, Bar.glyph 20, Control.height 44, Control.glyph 18, Row.height 44, Row.fillRadius 10, Transcript.actionGlyph 16 | |
| Composer metrics | `DS/JunoComposerShell.swift:14-41`: cornerRadius 26, fieldInsets 14/16/6/16, controlsInsets 2/10/10/10, controlHeight 32 | Used by the Mac. iOS only reads `cornerRadius`. |
| Colours as SwiftUI | `DS/JunoColors.swift` (`junoCanvas` :252, `junoSecondary` :259, `junoSelectedFill` :379, `junoSurface`=`junoCard` :413, `junoMuted` :420, `junoHairline` :428), accent `DS/JunoAccent.swift` | `AccentColor.colorset` is graphite (matches). |
| Icons | `src/lib/app-icons.ts` → `scripts/generate-native-icons.mjs` → `Resources/Assets.xcassets/Icons/*.symbolset` (416) → `JunoIcon` / `JunoIconView` | Rasterised per size (`DS/JunoBrand.swift:1003-1040`). |
| Strings | shared table, `Resources/Shell.xcstrings`, `Localizable.xcstrings` (en, fr) | |

**Generated but not used by iOS:**
- `JunoGeneratedColors.userBubble` / `userBubbleHover` (`GEN:772-786`). The bubble uses `junoMuted` instead.
- `JunoGeneratedRadius.bubbleTuck` (8). The web bubble's tucked corner is dropped.
- `drawerDimLight` (0.12). It is replaced by a literal `0.04` (`App/JunoMobilePhoneShell.swift:130`).
- The type ladder, which is mostly bypassed.

---

## 3. App structure

```
JunoMobileApp → JunoMobileRootView (App/JunoMobileRootView.swift:20)
  ├─ signed-out → JunoMobileSignInView (App/JunoMobileOnboarding.swift:16)
  ├─ compact width (iPhone) → phoneShell (:676)
  │    JunoMobilePushDrawer (App/JunoMobilePhoneShell.swift:31)  ← ChatGPT-style push drawer, NOT a sheet
  │      sidebar:  JunoMobileSidebarDrawer(layout: .drawer) (App/JunoMobileDrawer.swift:25)
  │      content:  NavigationStack(path: chatPath) (:1116)
  │                 root = Chat (draft | conversation | incognito) or Code  (:1130)
  │                 toolbar: [sidebar glyph] [Chat|Code orbit OR title Menu] [ghost | compose]  (:1146-1182)
  │                 every drawer destination pushes on this one stack (:1121)
  │                 composer = .safeAreaInset(edge: .bottom) (App/JunoMobileConversationsView.swift:2828)
  └─ regular width (iPad) → padShell (:710)
       NavigationSplitView(sidebar: drawer(layout: .sidebar) .background(.regularMaterial) :716,
                           detail: NavigationStack{destinationRoot}.id(selection))
       artifacts/reports dock in .inspector (App/JunoMobileConversationsView.swift:1462)
Sheets on root: Settings (:1065, NavigationStack + ✕ leading, .junoSheetSurface(.page)), share, pairing, plans paywall.
No TabView on iPhone (the earlier 4-tab bar was removed; the comment is at App/JunoMobilePhoneShell.swift:11).
```

Toolbar contents, phone (`App/JunoMobileRootView.swift:1146-1182`):
- `topBarLeading`: sidebar glyph (web `PanelLeft`, 20pt, `Color.primary`).
- `principal`: either `JunoMobileProductSwitch` when on a home (a Chat ⟷ Code dot-orbit in the serif, wrapped in its own `.glassEffect(.regular.interactive(), in: Capsule())` at `App/JunoMobilePhoneShell.swift:270`), or the conversation title as a `Menu` (`App/JunoMobileConversationsView.swift:1178-1193`; `.headline` plus a chevron).
- `topBarTrailing`: either the private-chat ghost (24pt frame, 20pt glyph) or the compose glyph (only in a conversation).
- No search button in the bar. Search sits in the drawer header.

Drawer (`App/JunoMobileDrawer.swift`):
- **Header** (:513-610): Alevr mark 26pt on the left. On the right, a 44pt glass circle for search (`.glassEffect(.regular.interactive(), in: Circle())` :578). Searching swaps in a glass-capsule `TextField` (:543) and a "Cancel" text button.
- **List** (:431-480): a plain `List`. Six destinations: Activity, Library, Projects, Orbit (agents), Routines, Apps (`App/JunoMobileSection.swift:116-127`). Rows are 44pt high, with 16pt labels and 20pt glyphs on hand-tuned 26/56pt edges (`DrawerMetrics` :1142-1180). Then a hand-drawn 1pt hairline `Rectangle`, then a "Recent" section label (13pt), then conversation rows.
- **Footer** (:714-772), in a `GlassEffectContainer`:
  - An **ink-tinted glass capsule** "Chat" for new chat (`.glassEffect(.regular.tint(Color.primary).interactive(), in: Capsule())` :737; label in `junoCanvas`, 17pt semibold, 52pt tall).
  - A bell in a 52pt glass circle (:748).
  - The avatar (46pt) inside a 52pt glass circle that opens Settings (:763).
- **Motion:** rows stagger in, 20ms apart with a 14pt slide (:1188-1211). The card pushes with parallax 0.22, takes the display's corner radius from a hard-coded table of screen widths (`App/JunoMobilePhoneShell.swift:56-63`), dims, and throws a shadow of black at 0.14 (light) / 0.6 (dark), radius 26 (:150-153).

---

## 4. Surface-by-surface table

Entries in the **Glass** column are custom glass. "System" means glass drawn by the OS: toolbar items, menus, partial-detent sheets, alerts.

| Surface | File:line | Components / styles | Current values | Glass | Diverges from web | Cheap / slop |
|---|---|---|---|---|---|---|
| **Shell (phone)** | `App/JunoMobileRootView.swift:676-698`, `App/JunoMobilePhoneShell.swift:31-219` | Custom `GeometryReader` push drawer, `DragGesture`, `.ignoresSafeArea(.container)`, safe-area insets measured and re-applied by hand (:178-185) | width min(0.8·W, 380); edge-swipe strip 22pt wide starting 64pt below the safe area (:160-170); card radius from a width→radius table (:56-63) | none on the shell; system bar glass | Web phone uses an **overlay** Radix sheet, `w-[280px] max-w-[85vw]` (`src/components/app/app-shell.tsx:632-657`), not a push | Hard-coded hardware radius table; light dim `0.04` literal vs token 0.12 (:130); black shadows |
| **Top bar** | `App/JunoMobileRootView.swift:1146-1182` | `.toolbar` with `ToolbarItem` leading / principal / trailing | glyph 20pt, buttons 44 | `ProductSwitch` adds its own `.glassEffect` inside `.principal` (`App/JunoMobilePhoneShell.swift:270`); the checker flags it as loose glass | Web phone bar: ☰ · left-aligned title (15/medium, animated) · Search · New chat, all 44px ghost icons in muted ink (`app-shell.tsx:683-718`). No Chat/Code switch in the bar (it lives in the sidebar header). | Centre "orbit" glyph in serif; no Search in bar; title centred as a Menu (Notes grammar) |
| **Drawer / sidebar** | `App/JunoMobileDrawer.swift:25-1211` | `List(.plain)`, `.swipeActions`, `.contextMenu`, `.alert` rename, `.confirmationDialog` delete | rows 44pt / label 16 (iPad 15) / glyph 20; selected fill `Color.primary.opacity(0.07)` (:1060, :1118), iPad `junoSelectedFill`; press `junoForeground.opacity(0.06)` (`App/JunoMobileChrome.swift:152`) | header search circle and field, 3 footer controls (one ink-tinted) | Web: header (collapse · wordmark · Chat·Code) → **New chat row, Search row** → destinations (Activity · Projects · Library · Customize · More) → folds (Pinned projects, Agents, Recent with pins leading and run-status dots) → two-line account row (`src/components/app/app-sidebar.tsx:100-140, 1294-1345`). iOS: no New chat/Search rows at top; new chat is a 52pt ink capsule at the bottom; no Pinned-projects/Agents folds; avatar circle instead of account row; different destination set | Owner-tuned edges 26/56 vs web 16; 52pt footer controls next to 44pt bar buttons; `phoneStatus` merges Code+Work into the `.code` row, but `.code` is not in the phone list (:483-492 vs `App/JunoMobileSection.swift:125-130`), so "N waiting" never shows on iPhone |
| **Chat home (phone)** | `App/JunoMobileConversationsView.swift:264-522` (`column` :336-395) | `VStack` + `Spacer`; `JunoMobileResumeRow` (:2947-2975) | resume row: 16pt glyph, `.subheadline` secondary, 44pt; bottom pad 6 (:380) | composer only | Web phone home: centred serif greeting "What's next, Name?" at 34/40 (`src/components/chat/empty-state.tsx:14-24`, `composer.css:532-559`) + starter chips (`home-starters.tsx`) above the docked composer + faint dot-matrix field. iOS shows an **empty page** (comment: "ChatGPT's home is an empty page" :365) | iPad uses yet another copy, "What can I help with?" (:2979), centred |
| **Conversation thread** | `App/JunoMobileConversationsView.swift:526-1866` (`transcript` :992, `scrollArea` :1298) | `ScrollView{VStack}` (**not lazy**, :1014), `scrollPosition`, `defaultScrollAnchor(.bottom)`, `.scrollEdgeEffectStyle(.soft)` top and bottom (:2810-2816), jump-to-latest glass circle 44 (:1398-1436) | turn gap 24, h-pad 16, top 24, max width 768 (:1161-1167) | jump button (allowed site) | Matches web `max-w-3xl space-y-6 px-4 py-6`. Web also has an Activity timeline with tool receipts; **iOS renders no tool calls** (only thinking, sources, images, research, approvals) | Eager VStack for long threads |
| **User bubble** | `:2092-2121`, `bubbleBody` :2232-2280, shape :2325 | `Text` with `textSelection`, `contextMenu`, collapse with fade | 15pt (`.body`-relative) line +5, pad 16×12, fill `junoMuted`, uniform r12, max **80%** (:2116) | "Show more" is a glass capsule on content (:2313) | Web: `rounded-card rounded-br-md` (12 + 8 tuck), `bg-secondary`/`--user-bubble`, `px-4 py-2.5`, **max 85%** (`message-item.tsx:533, 1008`; `tailwind.config.ts:244-248`) | Doc comment says "the tail corner is the load-bearing detail" and the next comment says "one radius all round" (:2078-2083 vs :2321-2324); edit field stroked in accent (:2161) |
| **Assistant answer** | `:2363-2512` | `JunoPacedStream` → `JunoLessonText` (markdown, `DS/JunoMarkdownView.swift`); `.contextMenu` on the whole stack | prose 16pt reading rung, line spacing 7, block gap 13; footer model line moved to overflow | none | Web action row is hover-revealed (shown on touch) | Context menu covers the whole answer, including the action row |
| **Action row** | `:2605-2671`, overflow :2675-2717 | 6 plain `Button`s + `Menu`; `.junoQuietPress` | glyph 16 in 44×44; `junoSecondaryInk`; row pulled −14pt (:2668) | none | ok (copy · 👍 · 👎 · read · share · retry · ⋯) | Duplicates the long-press menu; dead `footer` (:2566) and `actionButton` (:2741, 34pt) still in the file |
| **Thinking / thought process** | `App/JunoMobileThoughtProcess.swift:26-215`; pending line `App/JunoMobileConversationsView.swift:2993-3018` | Live: galaxy mark 18 in a 36pt gutter + `JunoAIcssThinkingLabel` 16pt + timer; rest: "Thought for 6s ›" in `.subheadline` button → `.sheet([.medium,.large])` | live row min 40; rest row 44 | none | Web: one-line ThoughtProcess + panel | Pending line has **no** 36pt gutter, so text shifts 36pt sideways when the pending line becomes the live strip; 16pt live vs 15pt resting; panel close is **trailing** 15pt (:286-295) while every other sheet's close is leading (`App/JunoMobileChrome.swift:412-427`) |
| **Code blocks / markdown** | `DS/JunoAIcssCode.swift:15-130`, `DS/JunoMarkdownView.swift:530, 590-640` | header with Copy (+ Run), gutter line numbers, `junoSurface` card, hairline | mono 12.5pt, radius **12 literal** (:122-125), copy button **22×22** (:84) | none | Matches the web code-run style | Hit target 22pt on a phone |
| **Citations / sources** | `App/JunoMobileConversationsView.swift:2529-2541` → `JunoAIcssWebSearch` | stacked rows, title + host | — | none | Web: sources pill/section | ok |
| **Artifact inline card** | `:2840-2918` | `Button(.plain)` → HStack glyph 17 · title 15 medium · subtitle 12 · chevron 13 | pad 16×12, r12 `junoSurface` + hairline | none | Matches web `artifact-inline-card.tsx` | Icon map gives SVG→artifacts, Mermaid→branch, deck→squareStack (ok) |
| **Tool calls** | — | **not rendered** (models exist in `CK/NativeRunTimeline.swift`, `CK/NativeToolRunViews.swift`, but no iOS view uses them) | — | — | Web: `activity-timeline.tsx`, `tool-receipt.tsx` | The biggest gap in the transcript |
| **Approvals in chat** | `:1101-1113` → `NativeChatApprovalCard` (CK) | card | — | — | ok | — |
| **Composer (chat)** | `App/JunoMobileComposer.swift:381-768` | `JunoGlass(spacing: 8)` → `VStack{chips, slash, armed tokens, TextField(axis:.vertical), controlRow}` + `.junoGlass(in: RoundedRectangle(26))` (:444, :589-591) | field 17pt (:506), pad L16/T14/B6; row pad h6/b6 (:542-543); outer h16 / v6 (:671-672); max width 768 | the whole card, plus panels, chips and the "Edit"/"Attach as file" capsules **inside** it (:1024, :1113) | See §6 | §6 |
| **`+` panel** | `App/JunoMobileAttachmentMenu.swift:43-560`, `App/JunoMobileComposerPanels.swift:33-130` | **Hand-built** glass panel (264pt wide, r28 = `JunoSpace.wide`), custom rows, custom blur+scale "bloom", `Color.clear` 4000×4000 tap-catcher (`App/JunoMobileComposer.swift:655-667`); nested system `Menu`s for Apps/More | rows 44, glyph 20, label 17, h-pad 18 | panel glass inside its own `GlassEffectContainer`, sitting on the card's glass; system menus on top: **3 layers** | Web `+`: `.surface-float` dropdown, 36px rows, r14 shell, p-1.5, three hairline groups, Radix submenus (`composer-plus-menu.tsx:29-56`) | File header says "A real `Menu`, not a card ... every pixel of its chrome is Apple's" (:28-41), but the body is a custom card; "Create a canvas" and "Canvas" both use the `.copy` glyph (:353, :358) |
| **Thinking dial / model** | `App/JunoMobileThinkingDial.swift:15-60`; panel `App/JunoMobileComposerPanels.swift:132-340`; picker sheet `App/JunoMobileComposer.swift:744-757` | gauge glyph 19pt (custom `JunoDialGlyph`); long-press opens the catalogue | 44 target | panel glass | Web: **model chip with a label** on the row, thinking inside its popover (`composer.tsx:3498-3523`). iOS shows **no model name** on the row | Hidden gesture (long-press) for the primary model choice |
| **Send / Stop / Voice** | `App/JunoMobileThinkingDial.swift:67-126` | opaque graphite disc 36 in 44 (`Color.junoForeground`; disabled `junoSecondary`) | glyph 18 bold / stop 14 fill | none (opaque) | Web: 36px disc | Dictation "Done" is ink-**tinted glass** (`App/JunoMobileDictation.swift:282`); voice End is an opaque red disc (`App/JunoMobileVoiceView.swift:615-616`); Code-voice End is red-tinted glass (`App/JunoMobileCodeVoice.swift:326`). Four treatments in one slot |
| **Tray (Project · Apps · Skills)** | `App/JunoMobileComposer.swift:793-812` → `CK/NativeComposerTray.swift:29-120` | opaque shelf tucked under the card (`junoCanvas` + ink 3.5%/4.5%) | pill 34, target 44, font 14, radius = 17+6 | none | Web has the same shelf, but under an **opaque** card | Opaque shelf behind a glass card mixes two materials at one edge |
| **Dictation** | `App/JunoMobileDictation.swift:240-300` | waveform row replaces the controls | "Open Settings" glass capsule 36 (:262); Done disc 36 | 2 glass, inside the card | ok | Glass in glass |
| **Keyboard / safe area** | `.safeAreaInset(.bottom)` composer (`App/JunoMobileConversationsView.swift:2828`), `scrollDismissesKeyboard(.interactively)`, `junoScreenCanvas()` paints the keyboard band (`App/JunoMobileChrome.swift:97-99`), hardware Return/Shift-Return (`App/JunoMobileComposer.swift:519-528`) | — | home composer bottom pad 6 vs web `12px + safe-area` (`composer.css:556-559`) | — | — | Drawer ignores the container safe area and re-pads from measured insets (`App/JunoMobilePhoneShell.swift:107-120, 178-185`), which is fragile |
| **Long prompt editor** | `App/JunoMobilePromptEditor.swift`; `.fullScreenCover` (`App/JunoMobileComposer.swift:693`) | full-screen editor | — | — | ok | — |
| **Menus** | 51 `Menu{}`, 16 `.contextMenu` (`App/JunoMobileMessageMenu.swift:27-75`) | system | — | system | ok | Mixed icon sources in one menu: `Label(image:)` assets and `JunoIconView` bitmaps at 15pt |
| **Sheets** | 48 `.sheet`, 3 `fullScreenCover`, 0 popovers | `presentationDetents` uses listed below | settings/report/artifacts `.junoSheetSurface(.page)` = opaque `junoCanvas` (`DS/JunoOverlays.swift:134-160`) | partial-detent sheets get system glass | — | **Grabber on single `.large` detent** in 5 places, against the DS's own rule (`DS/JunoOverlays.swift:115-118`): `App/JunoMobileComposer.swift:755-756`, `App/JunoMobileIncognito.swift:285-286`, `App/JunoMobileLinkComposer.swift:143-144`, `App/JunoMobileLinkThread.swift:223-224`, `App/JunoMobilePlans.swift:494` (no detent at all). `junoUtilitySheet` has 0 uses. |
| **Alerts / dialogs** | 21 `.alert`, 22 `.confirmationDialog` (e.g. `App/JunoMobileDrawer.swift:166-237`, `App/JunoMobileRootView.swift:686-698`) | system | — | system | ok | Fine. Keep. |
| **Toasts / banners** | No toast host on iOS (`DS/JunoToastHost.swift` unused). Banners: offline (`App/JunoMobileRootView.swift:1871-1891`), recovery/safe mode (`App/JunoMobileCrashRecovery.swift:203-262`), inline error (`App/JunoMobileChrome.swift:239-277`) | `.thinMaterial` full-width strips; `JunoInlineError` caution at 10% | footnote, pad 16×8 | pre-Liquid-Glass blur | Web has a toast system | Blur strips next to Liquid Glass; copy confirmations are ad hoc per control |
| **Settings** | `App/JunoMobileSettingsView.swift:208-275` (+ pages `App/JunoMobileSettingsPages.swift`) | `List(.insetGrouped)` + `NavigationLink(value:)`, `Form`, `Picker`, `Toggle`, `LabeledContent` | icons 20pt `.secondary`; profile header avatar 64 | system | Web settings: 12 sections in a page layout | **Opts back into system grouped greys** (`junoGroupedPage()` :1366-1370), so it is the only screen not on brand neutrals; destructive uses `Color.red` (:841-844, :506, :703) instead of `junoDanger` |
| **Model selector** | `App/JunoMobileModelSelector.swift:43-867` | `NavigationStack` + `.searchable` + `LazyVGrid` lab tiles + fake grouped cards (`Color.primary.opacity(0.05)` r24) + custom modality chips | tile h96 r20; card r24 (`JunoSpace.section` used as a radius :401-402); chips on = solid ink | sheet `.large` = opaque | Web `model-catalogue.tsx` | "Drawn on the sheet's own glass" (:561-563), but a `.large` sheet is opaque; fake grouped list instead of `List(.insetGrouped)`; radii taken from spacing tokens |
| **Voice** | `App/JunoMobileVoiceView.swift` (in-composer call), `JunoVoiceGlow` on the card edge (`App/JunoMobileComposer.swift:600-618`); widget Live Activity `W/JunoMobileWidgets.swift:216-242` | controls 36 discs in 44; pressed = solid ink disc (:586-587) | — | glow overlay on glass | Matches the web's in-composer call (`voiceCallParts`) | ok structurally |
| **Canvas / artifacts** | phone: `.sheet` → `JunoMobileArtifactDetail`, `.junoSheetSurface(.page)` (`App/JunoMobileConversationsView.swift:1655-1664`); iPad: `.inspector` 360/460/640 (:1462-1466); inline `App/JunoMobileInlineArtifact.swift`; runtime `CK/ArtifactCanvasView.swift` | — | — | — | Web: right-side panel on desktop, sheet on phone | ok. Comment at :1445-1455 still says `.inspector` "traps" while body uses it |
| **Agents (Orbit)** | `App/JunoMobileRootView.swift:1486-1508` → shared `native/Packages/JunoNativeKit/Sources/JunoWorkKit/Agents/Views/NativeAgentsHome.swift`, thread header `NativeAgentThreadHeader` (`App/JunoMobileConversationsView.swift:1791-1804`, `.safeAreaInset(.top)`) | shared with Mac | — | — | Web Orbit crew tiles | Out of scope for the shell, but the header rides a top inset under the bar |
| **Library / Projects / Artifacts / Tasks / Apps / Activity / Search** | `App/JunoMobileLibraryView.swift`, `App/JunoMobileWorkspaceViews.swift`, `App/JunoMobileTasksView.swift`, `App/JunoMobileConnectionsView.swift`, `App/JunoMobileActivityView.swift`, `App/JunoMobileSearchView.swift` | `JunoMobileSerifHeading` 34pt serif + inline bar title revealed on scroll (`App/JunoMobileCapsuleControls.swift:179-253`); `.searchable` (10 screens); **glass capsule buttons in content** (`junoMobileCapsulePrimary/Action/CircleAction`, :108-135); `JunoMobileCapsuleSegmented` glass (:20-98) | section header 19 semibold; empty state serif 24/20 | many, on content | Web `app-page-header.tsx` (page-title rung 32–44) | Glass buttons scattered through scroll content; a custom segmented control where `Picker(.segmented)` (already glass on 26) fits |
| **Code (home / remote / runs)** | `App/JunoMobileCodeHome.swift` (scope chips with `glassEffectID` :148-160; custom glass search field :395-417), `App/JunoMobileCodeView.swift`, `App/JunoMobileCodeRemote.swift`, `App/JunoMobileLinkComposer.swift`, `App/JunoMobileLinkThread.swift`, `App/JunoMobileLinkSurfaces.swift` | "after Codex's remote" | radii 6/8/10/20/22 literals | many | Web Code is the same sidebar shell + `/code` | Hit targets of 14–20pt flagged by the checker (CodeRemote:694, LinkComposer:300, LinkThread:522/570/624) |
| **Work** | `App/JunoMobileWorkView.swift` (2539 lines) | approval/question/thread cards use `.junoProminentAction()` = glassProminent (checker: :1130, :1206, :1396) | — | glass on cards | — | Glass on content |
| **Onboarding / sign-in** | `App/JunoMobileOnboarding.swift:16-420`, `App/JunoMobilePremium.swift:153-215, 215-440` | `TabView` pager with custom dots (:181-215, dots :212); painted plates `PlateDawn`/`PlateDusk`, procedural fallback with warm hex palette (`App/JunoMobilePremium.swift:366-400`) + film grain; credentials group `junoMobileRaised(r18)` with umber shadow; front-door buttons `.glassProminent` tinted ink / `.glass`, `.controlSize(.extraLarge)` | title serif 38; rows 54; raw 64/−36/50pt gaps (checker) | glass buttons over art (ok) | Web `(auth)` pages | Warm terracotta landscape and umber shadow (`App/JunoMobilePremium.swift:167-177`) on a graphite brand |
| **iPad** | `App/JunoMobileRootView.swift:710-743`, `App/JunoMobileIPad.swift` | `NavigationSplitView(.balanced)`, sidebar 260/300/360 | sidebar `.background(.regularMaterial)` (:716), commented as "opaque" | material on top of the system sidebar glass | Mirrors the Mac | Material fighting the system glass |
| **Widgets / Live Activities** | `W/JunoMobileWidgets.swift:8-537`, `App/JunoMobileLiveActivities.swift` | Quick actions (small, medium, accessoryCircular/Rectangular); Live Activities: Voice, Code approval, Agent run (Dynamic Island) | system text styles; serif 22 "New chat" | n/a | n/a | Fine |

---

## 5. Liquid Glass inventory

**System glass, which should be kept and leaned on:** nav bar items, `Menu`/`contextMenu`, alerts, confirmation dialogs, the `.searchable` bar, partial-detent sheets.

**Custom glass in `App/` (raw counts):**

| Call | Count |
|---|---|
| `glassEffect(` | 18 |
| `junoGlass(in:` | 14 |
| `JunoGlassCapsule()` | 5 |
| `JunoGlassCircle()` | 2 |
| `buttonStyle(.glass)` | 17 |
| `JunoMobileWorkspaceActionStyle` (= `.glass` capsule) | 18 |
| `junoMobileCapsuleAction` | 17 |
| `junoMobileCapsulePrimary` | 8 |
| `junoMobileCircleAction` | 2 |
| `junoProminentAction` | 10 |
| `buttonStyle(.glassProminent)` | 5 |
| **Total** | **~114** |

There are also 8 `bordered`/`borderedProminent` and 5 blur materials (`.thinMaterial` ×3, `.regularMaterial`, `.ultraThinMaterial`).

**Glass on content.** These are the rows, cards and controls inside a scroll view:
- "Show more" capsule on the user bubble (`App/JunoMobileConversationsView.swift:2313`).
- Metadata chip (`App/JunoMobileWorkspaceChrome.swift:135`).
- Library/Projects segmented control and capsule buttons (`App/JunoMobileCapsuleControls.swift:46-53, 108-135`).
- Work approval and question cards (`App/JunoMobileWorkView.swift:1130, 1206, 1396`).
- Retry and offline actions (`JunoMobileWorkspaceActionStyle`, `App/JunoMobileWorkspaceChrome.swift:307-311`).
- Remote pairing rect (`App/JunoMobileRemotePairing.swift:185`).

**Stacked glass:**
- "Edit" and "Attach as file" capsules inside the glass card (`App/JunoMobileComposer.swift:1024, 1104-1114`).
- Dictation glass capsule and glass Done inside the card (`App/JunoMobileDictation.swift:262, 282`).
- The `+` panel's own `GlassEffectContainer` on the card, with system menus above it (`App/JunoMobileComposer.swift:628-640`; nested menus `App/JunoMobileAttachmentMenu.swift:199-203, 290-317`).
- `.thinMaterial` attachment chips inside the glass card (`App/JunoMobileAttachmentChips.swift:65`).
- iPad sidebar material over the system sidebar glass (`App/JunoMobileRootView.swift:716`).

**Heavy tints:**
- Drawer "Chat" capsule tinted `Color.primary`, which is solid ink (`App/JunoMobileDrawer.swift:737`).
- Dictation Done tinted `Color.primary` (`App/JunoMobileDictation.swift:282`).
- Code-voice End tinted `junoDanger` (`App/JunoMobileCodeVoice.swift:326`).
- Front-door prominent tinted ink (`App/JunoMobilePremium.swift:193-195`).

**Loose glass with no container:** `App/JunoMobilePhoneShell.swift:270` (checker), `App/JunoMobileWorkView.swift:230`.

**`glassEffectID` morphs:** only Code scope chips (`App/JunoMobileCodeHome.swift:157`) are live. The composer's `"composer.action"` id sits in dead code (`App/JunoMobileComposer.swift:1572-1590`), and the `+` passes `namespace: nil` (`App/JunoMobileAttachmentMenu.swift:540`). So the "+ morphs into panel" that the comments describe is a custom scale+blur transition (`App/JunoMobileComposerPanels.swift:33-62`), not system glass morphing.

**Duplicate glass helpers that all do `.buttonStyle(.glass).buttonBorderShape(.capsule)`:**
- `JunoGlassButtonStyle` (`App/JunoMobileChrome.swift:395`, dead)
- `JunoMobileWorkspaceActionStyle` (`App/JunoMobileWorkspaceChrome.swift:307`)
- `junoMobileCapsuleAction` (`App/JunoMobileCapsuleControls.swift:110`)

**Checker scope.** `scripts/check-native-glass.mjs:31-37` exempts the phone from the "five glass sites" rule. That exemption is why the spread went unchecked. `JunoMobileChrome.swift` is fully exempt (:52-57).

---

## 6. Composer: iOS vs web phone composer

| Aspect | Web (`src/components/ui/composer-shell.tsx`, `src/components/chat/composer.tsx`, `composer-plus-menu.tsx`, `globals.css:1885-2006`) | iOS (`App/JunoMobileComposer.swift`) |
|---|---|---|
| Material | Opaque `bg-card` + 1px `foreground/0.10` hairline + 2-layer tinted shadow. Focus darkens the edge; keyboard focus adds a ring. | Liquid Glass card, no edge, no focus state |
| Radius | `rounded-composer` 26 | 26 (chat), **24** incognito (`App/JunoMobileIncognito.swift:342`), **24** Code voice (`App/JunoMobileCodeVoice.swift:194`), **22** terminal input (`App/JunoMobileLinkSurfaces.swift:324`), panel radius 28 for link composer panels |
| Field | 16px text (`text-base`, needed so iOS Safari does not zoom), `leading-relaxed`, pt-4 px-4, min-h 52 on coarse pointers | **17pt** (`.body`-relative), top 14, leading 16, bottom 6, 1…N lines, placeholder `.secondary` |
| Row | `px-2.5 pb-2.5 pt-1.5`. **Leading:** `+`. **Trailing:** task-mode chip, **model chip with label** (h-8/coarse 44, `text-label` muted, accent fill on hover/open), mic 18px. **Action:** 36px disc. | h6 b6. `+` (glyph 21) · Spacer · [phase text] · **thinking gauge (glyph 19, no label)** · mic (19) · disc 36 (glyph 18 bold / stop 14). **Model only through the gauge's panel or a long-press.** |
| Armed tools | in the field, neutral `bg-accent` marks, ✕ always visible on touch | In the field as "tokens" in **accent ink** at 15pt with a 10pt ✕ (`App/JunoMobileThinkingDial.swift:131-157`). The scroll row sits **above** the field, not inline. |
| `+` menu | dropdown, 36px rows, r14 shell, hairline groups, Radix submenus; at compact width it drills in place | custom glass card 264pt wide, 44pt rows, 17pt labels, 8pt air between groups (no hairlines), Apps/More as nested system menus |
| Tray | opaque shelf under an opaque card | opaque shelf under a **glass** card |
| Above-composer | quota notice (bordered strip), clarification, slash/@ palette | retry banner, notices (`.caption2`), research progress, voice notices; all plain text rows |
| Bottom inset | `pb-[calc(1rem+safe-area)]` dock; home composer `margin-bottom 12px + safe-area` | outer v-pad 6 above the safe area |
| Reduce Transparency | n/a (opaque) | **not handled in `App/`.** The DS `JunoComposerShell` does handle it (`DS/JunoComposerShell.swift:99, 269`), but iOS does not use that shell. |

---

## 7. Layout differences between web and iOS

1. **Navigation container.** Web phone: overlay drawer sheet (280px, max 85vw) from a ☰ in a flat page-level bar. iOS: ChatGPT-style **push** drawer (min(80%, 380)) with parallax, card corners and a shadow.
2. **Top bar.** Web: `☰ | title (left-aligned, 15 medium) | Search | New chat`, bare 44px ghost icons in muted ink, no capsules. iOS: `sidebar | centred Chat·Code orbit or centred title Menu | ghost or compose`, in iOS 26 bar glass, with no Search.
3. **Chat ⟷ Code switch.** Web: in the sidebar header. iOS: in the centre of the top bar on homes; the drawer has none. Code is removed from the iPhone drawer (`App/JunoMobileSection.swift:116-131`).
4. **Sidebar order.** Web: New chat → Search → destinations → folds (Pinned projects, Agents, Recent with pins first) → account row. iOS: brand mark + search circle → destinations → hairline → Recent → footer [ink "Chat" capsule · bell · avatar]. New chat is at the **bottom**. There are no Pinned-projects or Agents folds, and no two-line account row.
5. **Destinations differ.** Web Chat: Activity · Projects · Library · Customize (+ More). iOS: Activity · Library · Projects · Orbit · Routines · Apps.
6. **Row grammar.** Web: rows 32px (44 coarse), `nav` 14px text, 16px glyphs, 16px edges, run-status dot per row, selected fill re-based for the drawer ground (`app-shell.tsx:632-650`). iOS: 44pt rows, 16pt text, 20pt glyphs, 26/56pt edges, no run marks, selected fill `primary·0.07`.
7. **Home.** Web phone: centred serif greeting "What's next, Name?" (34/40), starter chips, dot-matrix field, composer and tray at the foot. iOS phone: blank page and a "resume last chat" row. iPad: "What can I help with?" centred above a centred composer.
8. **Composer material and controls.** See §6: glass vs opaque; no model chip; gauge instead; 17 vs 16pt field; custom glass `+` panel vs dropdown.
9. **Transcript.** No tool-call / activity timeline on iOS. The bubble has no tuck corner, is capped at 80% rather than 85%, and uses `junoMuted` rather than `--user-bubble`. Thinking and pending lines differ in indent.
10. **Conversation actions.** Web: rename, share and so on from the sidebar row menu and in-thread. iOS: under the title `Menu` (Share · Find · Rename · Pin · Continue on · Delete).
11. **Search.** Web: one palette (`juno:search`) opened from the bar and sidebar. iOS: a drawer-header field that filters chats in place, plus a Search destination screen and `.searchable` on 10 screens.
12. **Settings.** Web: a page of 12 sections. iOS: an inset-grouped `List` sheet on system grey.
13. **Artifacts.** Web: side panel. iOS phone: a full `.sheet`; iPad: `.inspector`. This is close in spirit.
14. **Page headers.** Web `app-page-header` (page-title rung 32–44, medium). iOS: a 34pt serif heading plus an inline serif bar title on scroll, with glass capsule actions under the heading.
15. **Toasts.** Web has them. iOS has no toast host; it uses per-control check states and `.thinMaterial` banners.

---

## 8. The 25 worst offences, ranked by visual impact

1. **Glass sprawl.** About 114 custom glass call sites. Glass sits on content: bubble "Show more" `App/JunoMobileConversationsView.swift:2313`, metadata chip `App/JunoMobileWorkspaceChrome.swift:135`, Work cards `App/JunoMobileWorkView.swift:1130/1206/1396`, Library segmented control and buttons `App/JunoMobileCapsuleControls.swift:46-135`. The phone is exempt from the five-sites rule (`scripts/check-native-glass.mjs:31-37`).
2. **Glass on glass inside the composer.** Capsules inside the card (`App/JunoMobileComposer.swift:1024, 1113`), dictation glass (`App/JunoMobileDictation.swift:262, 282`), `.thinMaterial` attachment chips (`App/JunoMobileAttachmentChips.swift:65`), and the `+` panel container on the card glass with system menus on top (`App/JunoMobileComposer.swift:628-640`).
3. **The `+` panel is a hand-built imitation of a menu.** 264pt custom glass card, custom rows, scale+blur bloom, a 4000×4000 invisible tap-catcher (`App/JunoMobileComposer.swift:655-667`). Its own header claims it is a system `Menu` (`App/JunoMobileAttachmentMenu.swift:28-41`).
4. **The shell layout is not the web's.** Push drawer + centred orbit switch + Search hidden in the drawer + new chat at the bottom (`App/JunoMobilePhoneShell.swift`, `App/JunoMobileDrawer.swift:714-772`), against the web's ☰/title/Search/New-chat bar and its top-down sidebar.
5. **The model is invisible on the composer.** A 19pt gauge glyph replaces the web's labelled model chip, and choosing a model needs a long-press or a second panel (`App/JunoMobileThinkingDial.swift:15-39`).
6. **Five composers with five radii and two layouts.** Chat 26, Incognito 24, Code voice 24, terminal 22, link panels 28 (`App/JunoMobileIncognito.swift:342`, `App/JunoMobileCodeVoice.swift:194`, `App/JunoMobileLinkSurfaces.swift:324`). None uses `DS/JunoComposerShell`, which the Mac uses.
7. **Icons are bitmaps that do not scale.** `JunoIconView` rasterises at a fixed point size (`DS/JunoBrand.swift:1024-1040`), so 274 icons ignore Dynamic Type. There are 13 glyph sizes: 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22. The composer row alone mixes 21/19/19/18. There are zero SF Symbols in an app told to be "Apple-native".
8. **The drawer footer.** A 52pt **ink-tinted** glass "Chat" capsule next to two 52pt glass circles (bell, avatar-in-glass-ring), all larger than the 44pt bar buttons above (`App/JunoMobileDrawer.swift:737-763`, `DrawerMetrics` :1166-1175).
9. **Four treatments for the one primary slot.** Opaque ink disc for send (`App/JunoMobileThinkingDial.swift:99-100`), ink-tinted glass for dictation Done (`App/JunoMobileDictation.swift:282`), opaque red for voice End (`App/JunoMobileVoiceView.swift:615-616`), red-tinted glass for Code-voice End (`App/JunoMobileCodeVoice.swift:326`).
10. **Hand-rolled controls where native ones fit.**
    - Three segmented controls: `JunoMobileSegmented` with a black-shadowed thumb (`App/JunoMobileWorkspaceChrome.swift:20-91`), `JunoMobileCapsuleSegmented` in glass (`App/JunoMobileCapsuleControls.swift:20-98`), and the modality chip bar (`App/JunoMobileModelSelector.swift:816-867`).
    - Two custom search fields (`App/JunoMobileDrawer.swift:519-545`, `App/JunoMobileCodeHome.swift:395-417`).
    - A fake grouped list (`App/JunoMobileModelSelector.swift:561-574`).
    - Custom pager dots (`App/JunoMobileOnboarding.swift:204-215`).
11. **Tool calls are not shown in the transcript.** The web's activity timeline and tool receipts have no iOS renderer (`CK/NativeRunTimeline.swift` and `CK/NativeToolRunViews.swift` exist but are unused). Answers look thinner than on the web.
12. **Ad-hoc state fills.** About 35 distinct `Color.x.opacity(n)` values: `primary` at .05/.06/.07/.35/.72/.82/.9, `junoMuted` at .4/.5/.55/.6/.7/.9, `junoForeground` at .06/.09/.18, `junoBorder` at .6/.8. Selected rows use `primary·0.07` (`App/JunoMobileDrawer.swift:1118`) on the phone and `junoSelectedFill` on the iPad. Generated `userBubble` and selected/hover tokens go unused.
13. **Radii off the ladder.** Literals 6/8/10/12/16/18/20/22/24 (`App/JunoMobileMessageImages.swift:98` 18; `App/JunoMobileOnboarding.swift:405` 18; `App/JunoMobilePlans.swift:228, 271` 22; `App/JunoMobileLinkThread.swift:765, 855` 22; `App/JunoMobileCodeRemote.swift:413` 20). Spacing tokens are used as radii (`App/JunoMobileModelSelector.swift:401-402`; `App/JunoMobileComposerPanels.swift:346` panel r = `JunoSpace.wide`). The code block uses a literal 12 (`DS/JunoAIcssCode.swift:122`).
14. **Hit targets under 44pt.**
    - Code-block Copy 22×22 (`DS/JunoAIcssCode.swift:84`).
    - Attachment-chip ✕ and retry: bare 12–13pt glyphs with no frame (`App/JunoMobileAttachmentChips.swift:43-60`).
    - Find steppers 32×44 (`App/JunoMobileFind.swift:50, 59`).
    - Checker flags: `App/JunoMobileCodeRemote.swift:694` (14), `App/JunoMobileLinkComposer.swift:300` (20), `App/JunoMobileLinkThread.swift:522/570/624` (16).
    - The baseline allows 150 target exceptions (`scripts/check-native-design-baseline.json`, `targets.total`).
15. **Dark mode and light mode.**
    - Light drawer dim is a literal 0.04 vs token 0.12 (`App/JunoMobilePhoneShell.swift:130`).
    - Pure-black shadows at 0.6 in dark (:151).
    - Warm "umber" `JunoMobilePalette.shadow` and a terracotta dawn/dusk landscape on a graphite brand (`App/JunoMobilePremium.swift:167-177, 366-400`).
    - Settings drops to system grouped greys (`App/JunoMobileSettingsView.swift:1366-1370`).
    - `Color.red` instead of `junoDanger` (`App/JunoMobileSettingsView.swift:506, 703, 841-844`; `App/JunoMobileMemoryView.swift:44`; `App/JunoMobileConnectionsView.swift:371`).
16. **Blur materials beside Liquid Glass.** `.thinMaterial` banners (`App/JunoMobileRootView.swift:1888`, `App/JunoMobileCrashRecovery.swift:258`), chips (`App/JunoMobileAttachmentChips.swift:65`), `.regularMaterial` iPad sidebar (`App/JunoMobileRootView.swift:716`), `.ultraThinMaterial` (`App/JunoMobileVoiceCamera.swift:323`).
17. **Grabber on fixed sheets** in 5 places (§4 Sheets row). This breaks the DS rule; `junoUtilitySheet` is never used.
18. **Inconsistent type sizes on one screen.**
    - Composer field 17, user bubble 15, answer prose 16, drawer rows 16, `+` rows 17, armed tokens 15, tray 14.
    - "Thinking" live 16 vs "Thought for" 15.
    - 11 `junoFont` sizes (10–22), plus 96 `.subheadline` / 74 `.footnote` / 58 `.caption` / 42 `.body` mixed in.
    - Fixed-height text containers clip at accessibility sizes: `frame(height: 28)` at `App/JunoMobileWorkspaceChrome.swift:66, 131` and `App/JunoMobileComposer.swift:1112`; `minimumScaleFactor(0.85)` at `App/JunoMobileWorkspaceChrome.swift:63`.
19. **Hand-tuned magic numbers.** Owner-dated constants: drawer edges 26/56 ("Oct 11: way too on the left", `App/JunoMobileDrawer.swift:1136-1160`), footer 52, brand mark 26, edge strip 22 at +64pt, a corner-radius table by screen width (`App/JunoMobilePhoneShell.swift:56-63`), onboarding raw 64/−36/50/120pt gaps (checker).
20. **Seven custom `ButtonStyle`s** for press feedback: `JunoSidebarPressStyle`, `JunoMobileQuietPressStyle`, `JunoMobilePressStyle`, `JunoMobileChipPressStyle` (dead), `JunoMobileModelRowPress`, `JunoMobileThoughtRowStyle`, `JunoShutterPressStyle`. There are also 88 `.buttonStyle(.plain)`.
21. **The bubble drifted from the web.** No 8pt tuck (`bubbleTuck` generated but unused), 80% instead of 85% (`App/JunoMobileConversationsView.swift:2116`), `junoMuted` instead of `userBubble`. The edit field is stroked in the accent (:2161).
22. **The phone home is empty.** No greeting and no starters (`App/JunoMobileConversationsView.swift:357-380`), against the web's composed home. The iPad uses yet another copy.
23. **Dead code and contradicting comments.**
    - Dead views: `JunoMobileGreeting` / `AuraLayer` / `ChipPressStyle` (`App/JunoMobileGreeting.swift`), `JunoPageTitle`, `JunoGlassButtonStyle` (`App/JunoMobileChrome.swift:181, 395`), `JunoComposerGlassCircle`, `JunoMobileVoiceWave` (`App/JunoMobileComposer.swift:1883, 1962`), `JunoMobileSidebarTile` / `JunoMobileSidebarRow` (`App/JunoMobileDrawer.swift:956, 989`), `JunoMobilePageHeader` (`App/JunoMobilePremium.swift:98`), `JunoMobileUsageBar`, `JunoMobileEmptyLine`, `JunoMobileMessageShareSheet`.
    - Dead functions: `footer` / `actionButton` (`App/JunoMobileConversationsView.swift:2566, 2741`), `actionLabel` (`App/JunoMobileComposer.swift:1572`), `toolsMenu` / `toolsRows` / `connectorMenu` (`App/JunoMobileAttachmentMenu.swift:372-470`).
    - Stale comments describe coral, warm cream, tails and `.inspector` traps.
24. **Drawer status bug.** "N waiting / running" can never render on iPhone, because statuses are keyed to `.code` and `.work`, and neither is in the phone list (`App/JunoMobileDrawer.swift:483-492`).
25. **Hidden or non-standard gestures.** Long-press on the gauge opens the model catalogue (`App/JunoMobileThinkingDial.swift:34`). There is a 22pt custom edge-swipe strip (`App/JunoMobilePhoneShell.swift:160-170`). `.contextMenu` wraps the whole answer, including the action row (`App/JunoMobileConversationsView.swift:2509`), so a long press on a button opens a menu.

---

## 9. Supporting inventories

**Duplicate components that should collapse into one:**
- Composers ×5 (§6).
- Segmented controls ×3 (plus `DS/JunoSegmented.swift` for the Mac).
- Glass-capsule button helpers ×3 (§5).
- Search fields: 2 custom + `.searchable` on 10 screens.
- Sheet-close conventions:
  - Leading ✕ through `JunoMobileSheetClose` (13 call sites).
  - Trailing ✕ in the thought panel (`App/JunoMobileThoughtProcess.swift:286-295`).
  - "Done" text buttons (`App/JunoMobileAccountSecurityView.swift:248, 485`).
- Snapshot `shoot` helpers, copy-pasted per test file.

**What is good and should be kept:**
- System `Menu` / `contextMenu` / `alert` / `confirmationDialog`.
- `.searchable` on most pages.
- Settings as `List(.insetGrouped)` + `NavigationLink(value:)`.
- `scrollEdgeEffectStyle(.soft)`.
- The docked composer via `safeAreaInset`, plus `junoScreenCanvas()` covering the keyboard band.
- Hardware-keyboard Return handling.
- The find bar (a legitimate floating-glass site).
- The generated token, spring and gesture pipeline.
- The 26.0 floor.
- The in-composer voice call (matches the web).

---

## 10. Snapshot tests and how to see renders from Linux

- **iOS snapshot tests exist** (unit-test target, hosted app; `UIWindow` + `UIHostingController` + `drawHierarchy(afterScreenUpdates:)`, so Liquid Glass does render, in light and dark at 402×874):

  | File | Cases |
  |---|---|
  | `native/iOS/JunoMobile/Tests/JunoMobileOwnerSnapshotTests.swift` | model selector, library, sidebar drawer (:21-48) |
  | `JunoMobileVoiceSnapshotTests.swift` | 6 composer/voice states |
  | `JunoMobilePairingSnapshotTests.swift` | 6 |
  | `JunoMobileLinkSnapshotTests.swift` | about 20 Code-remote states, including "composer row at every width" (:94) |

  They write PNGs only when `JUNO_SNAPSHOT_DIR` is set (`TEST_RUNNER_JUNO_SNAPSHOT_DIR` via xcodebuild). Otherwise they assert only that the image is larger than 2 KB. They do **no reference-image comparison**.
- **CI runs them.** `.github/workflows/native.yml:595-621` runs `-only-testing:JunoMobileTests` on a `macos-26` simulator. It does **not** set `TEST_RUNNER_JUNO_SNAPSHOT_DIR` and uploads no artifact, so CI produces no images. Adding that env var and an `actions/upload-artifact` step would be the cheapest way to get iOS renders back to this Linux box. UI tests (`UITests/`, 14 files) are not run in CI.
- **DEBUG preview harness.** `JunoPreviewSupport` (`--juno-ui-preview`) plus launch flags like `JUNO_START_TAB`, `JUNO_START_OVERLAY`, `--juno-preview-plus`, `--juno-preview-drawer-progress` and `--juno-preview-sidebar-search` (`App/JunoMobileRootView.swift:272-297`, `App/JunoMobilePhoneShell.swift:65-78`, `App/JunoMobileComposer.swift:1129-1196`) drive exact states for simulator screenshots on a Mac.
- **Linux-runnable static gates.** `npm run native:design:check`, with sub-checks glass, motion, type, targets, prominent, menus, sficons, symbols and spacing (`scripts/check-native-*.mjs`). It runs in CI on ubuntu (`.github/workflows/native.yml:189-203`); `--list` prints findings. The current baseline counts are glass 14, targets 150, spacing 16, type 3. A redesign could tighten the glass rule for the phone by removing the exemption at `check-native-glass.mjs:31-37`.
- The Mac has its own offscreen snapshot tests (`native/macOS/JunoDesktop/Tests/Snapshots/`, e.g. `ComposerTraySnapshotTests.swift`).

---

## 11. Prior iOS design docs (context, partly stale)

- `docs/design/premium-pass/BRIEF.md` (rules, including "one shell grammar on every platform", "depth has three rungs") and `docs/design/premium-pass/ios/AUDIT.md`. The owner directives recorded there include "no status pills/dots" and "native Liquid Glass only for chrome".
- `docs/audit-2026-10-29/DESIGN.md`: the current graphite identity, plus the note that iOS neutrals now resolve from the generated palette.
- `docs/native/MOBILE_DESIGN_REVIEW.md`, `docs/native/ios-rework/STATUS.md`, `docs/native/spacing-pass/AUDIT.md`, `docs/native/WEB_TO_NATIVE_DESIGN.md`, `docs/native/MACOS_LIQUID_GLASS_REDESIGN.md`. The last one is the Mac's "glass in five places" law, which the phone never adopted.
