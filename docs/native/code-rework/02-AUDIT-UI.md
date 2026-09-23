# Juno Code (macOS) — UI/UX & Design Audit

Date: 2026-09-22 · Read-only audit of `main` @ c9cae856 · Scope: the Code product of `JunoDesktop` + `JunoCodeUI` + the shared `JunoDesignSystem`.

Method: every Code view file was read (≈24,000 lines across 47 files in `native/macOS/JunoDesktop/App/DesktopCode*.swift`, `DesktopSimulatorDock.swift`, `DesktopProductMode.swift`, `native/Packages/JunoCode/Sources/JunoCodeUI/{Views,Components}/**`), plus the design-system tokens, the design docs, and the checked-in screenshots (`artifacts/juno-code-competitive-audit-2026-08-27/*.jpeg`, `docs/native/design/after-code-transcript-dark.png`, `docs/native/design/rework/mac-code.png`). Numbers come from greps over that file set. The app was **not** run. The screenshots are from August builds, so layouts differ in places from current code, but every pattern cited below is in current code.

---

## 0. The verdict in one paragraph

The owner is right, and the cause is structural, not cosmetic. Juno Code is **an engineering inventory rendered as UI**. Every runtime capability (4 transports, 12 run states, 6 inspector panes, hooks/MCP/skills, worktrees, checkpoints, computer use, simulator, preview server, steer-vs-queue, goal lifecycle, context-window %, approval expiry) has a visible control, often several. There is no product hierarchy that decides what matters. The design system is careful: tokens are generated from the web, motion is laddered, and Reduce Motion is tiered. The views, though, use it to draw far too much stuff at 10 pt. The result is dense, over-labelled, multi-pane, status-chip-heavy chrome with **four composers, six approval cards, three transcript renderers, two diff renderers and two starter-prompt systems**. That duplication is the clearest evidence that the surface was grown by accretion rather than designed.

---

## 1. Information architecture map

### 1.1 How Code is entered
- `DesktopProductMode` has **three** products (Chat / Code / Work) (`DesktopProductMode.swift:4-12`). The `docs/design/TWO_PRODUCTS.md` decision says Work merged into Chat, so the Mac switcher contradicts the product decision.
- The switch is a `.segmented` Picker at `.large` size pinned at the top of every sidebar (`DesktopProductMode.swift:56-69`), plus ⌘1/⌘2/⌘3 and a "Product" menu (`DesktopCommands.swift` `CommandMenu("Product")`).
- Switching product **rebuilds the entire workspace** via `.id(product)` (`JunoDesktopWorkspaceView.swift:65`) and replays a 6 pt "arrival" rise. All Code view state (scroll position, open popovers, composer focus) is destroyed on every Chat↔Code hop.

### 1.2 Window structure (current code)
```
┌ Toolbar: [New task] | [Review][Commands] | [Task actions ▾ (8 items)]      (+ system sidebar toggle)
├ Sidebar (List .sidebar)                 ├ Thread header 44pt ────────────────────────┤ Inspector (300pt)
│ [Chat|Code|Work] segmented              │ Goal bar 48pt (if goal)                     │ "Environment" + ⋯ + ▶
│ Juno▾  🔍  🔔  ⧉(collapse)              │ ┌ Transcript ───────┐ ┃ ┌ Review pane ──┐       │ 6 panes behind ⋯
│ [Search threads]                        │ │                   │ ┃ │ (split, 420+) │       │
│ New task / Pull requests / Scheduled /  │ │                   │ ┃ │               │       │
│ Plugins / Security / Explore            │ └───────────────────┘ ┃ └───────────────┘       │
│ [All|Run|Needs|Done] + ●2 running ●1…   │ Console drawer (Output/Terminal/Tests)       │
│ Projects ▸ folder ⋯ / threads           │ Approval card + queue rows                    │
│ Open folder…                            │ Composer (glass)                              │
│ Recents / Other computers [picker]      │ + Preview dock / Simulator dock (right overlay)│
│ Design · quota bar · account · sync dot │                                                │
```

### 1.3 Detail-column destinations (`DesktopCodeSidebarItem`, `DesktopCodeStudio.swift:33-58`; routing `DesktopCodeWorkspace.swift:518-614`)
| # | Item | Renders | Note |
|---|---|---|---|
|1| `.draft` / `.repository(id)` / `nil` | `DesktopCodeNewTaskScreen` (1,340-line struct) | 3 enum cases, 1 screen |
|2| `.session` | `CodeSessionCanvas` (local) | |
|3| `.task` | `DesktopCodeTaskCanvas` → `CodeRemoteTaskDetailView` | Second transcript renderer, own header duplicates the thread header |
|4| `.remote` | `DesktopCodeRemoteCanvas` | Third transcript renderer, third composer |
|5| `.allProjects` **and** `.explore` | `DesktopCodeAllProjects` | Two enum cases for one page |
|6| `.pulls` | `NativePullsView` | |
|7| `.scheduled` | `DesktopTasksScreen` (a Chat feature; "open" switches to Chat, `DesktopCodeWorkspace.swift:630`) | Cross-product bleed |
|8| `.plugins` | `CodeSettingsView(scope: .plugins)` | Settings rendered as a destination |
|9| `.security` | `CodeSettingsView(scope: .security)` | Settings rendered as a destination |
|10| `.design` | `DesktopDesignScreen` (Juno Design, reached from brand menu **and** footer row) | Cross-product bleed |

That is **10 distinct canvases** reachable from a coding sidebar. Codex and Claude Code have about 2: task list and task thread.

### 1.4 In-session surfaces (local session)
Thread header · goal bar + goal popover · transcript (with work logs, tool rows, file rows, inline diffs, reasoning streams, turn-contract captions, timestamps, completion card) · approval card + queue rows · console drawer (3 segments) · composer · slash menu · @-file menu · review pane (split, resizable) · inspector (6 panes: Overview, Changes, Subagents, Environment, Repository, Preview) · preview dock + separate preview window · simulator dock · dictation overlay · voice dock · computer-use floating indicator · command palette overlay.

### 1.5 Sheets, alerts, popovers, menus (session scope)
Sheets: Open Quickly, Create Pull Request (**presented from two hosts**: `DesktopCodeWorkspace.swift:273` and `CodeSessionSurface.swift:164`; only one gets `.junoSheetSurface`).
Alerts/dialogs: rename session, rename project, delete project, voice unavailable, commit (TextField in an `.alert`), new branch (**duplicated** in `EnvironmentTab.swift:132` and `RepositoryTab.swift:67`), isolate worktree, push/publish confirm (**duplicated** Env/Repo), trust hooks, revert all, revert file, restore anyway ×3 variants, restore version, git error, MCP approval.
Popovers: model selector (×2 hosts), thinking panel (×2 hosts), goal details, account menu.
Menus: brand, bell, project ⋯, thread ⋯ (7 items), Task actions (8 items), permission/mode/agent, environment, branch, inspector pane menu, steer/queue, voice, + (add).

### 1.6 Control counts
- **Sidebar, before any session row:** 3-segment product switch, brand menu (6 items), search glyph, bell menu, collapse button, search field, 6 destination rows, 4-segment filter, 3 legend buttons, per-project row + ⋯ menu (4 items) + context menu, Open folder, Other-computers device picker, Design row, quota meter button, account popover, sync dot. That is about **30 interactive affordances**.
- **Running local session, visible without opening menus:** about 45 controls (toolbar 4, header 6, goal 1, approval 3, composer 8, inspector 10+, transcript disclosure rows N), plus about 40 menu items one click away.
- The composer row while running has **8 controls**: `+`, permission chip, model, effort, decorative chevron, Steer/Queue chip, mic, **Stop and Send side by side** (`Composer.swift:318-373`). FLAT_UI.md §4 allows three objects and "one verb: send ⇄ stop".

### 1.7 Redundancy (same action, many places)
| Action | Entry points | Evidence |
|---|---|---|
| Open Review | **8**: toolbar "Review" (`DesktopCodeWorkspace.swift:1023`), header rail toggle (`:469`), Session menu ⌥⌘R, palette, inspector "Changes" row (`EnvironmentTab.swift:181`), Changes pane "Show in Review", completion-card diff pill (`TranscriptRow.swift:375`), `/review` | Toolbar and header toggles sit about 50 pt apart |
| Toggle inspector | 4, under **3 names**: "Environment rail" (header, `:481`), "context rail" (toolbar menu/palette/menu bar `:1067`, `DesktopCommands` "Toggle Context Rail"), "Inspector" (code) | |
| New task | **10**: sidebar row, toolbar, ⌘N, click project row, project ⋯ "New Task Here", thread ⋯ "New Task in This Project", session context menu, palette, All Projects "New Task", Environment row "Start the next task in" | |
| Stop | header Stop (`CodeThreadHeader.swift:212`) **and** composer Stop (`Composer.swift:342`) at once, both bound to ⌘.; palette; sidebar context menu | Two ⌘. bindings on screen |
| Preview | Task actions menu, palette, ⌥⌘P, inspector ▶ button, inspector "Preview" pane (a pane whose only content is a button, `PreviewTab.swift`), agent notification | |
| Create PR | toolbar menu, Session menu, palette, completion card, Environment "Compare branch", Repository pane | |
| Needs-you filter | segmented "Needs", legend "● 1 needs you", bell menu | `DesktopCodeStudio.swift:393-401, 579-617` |
| Search | brand-row search glyph (focuses the field directly below it, `:542`), the field, ⌘K palette, ⇧⌘F | |
| Code settings | Settings ▸ Code, sidebar Plugins, sidebar Security, Repository pane hooks/MCP/skills, brand menu Settings…, palette "Code settings… ⌘," (⌘, opens General, not Code) | |
| Sidebar collapse | brand-row button (`:558`) + NavigationSplitView's own toggle (not removed; only Settings removes it) | |
| Explore / All projects | sidebar row, brand menu, palette; two enum cases | |
| Design | brand menu + footer row | |
| Screen-control stop | floating indicator (`DesktopCodeWorkspace.swift:718`), toolbar menu, Overview pane stop bar | |

---

## 2. Visual audit

### 2.1 Typography — the single biggest visual defect
The Code UI is set almost entirely in macOS **caption (10 pt)**. The shared roles map to macOS text styles: `junoCaption()` = `.caption`, `junoCodeSmall()` = `.caption` mono, `junoCode()` = `.footnote` mono. All three render at **10 pt on macOS**. `junoRowLabel()` = `.callout` = 12 pt (`JunoTypography.swift:99-137`).

Census over the 47 Code files (≈440 text-style sites):
| Size (macOS) | Sources | Sites |
|---|---|---|
| **10 pt** | `junoCaption` ×188, `junoCodeSmall` ×54, `junoCode` ×20, `.caption/.caption2/.footnote` variants ×45+, `junoSidebarSection` ×9 | **≈317 (≈72%)** |
| 9 pt | `junoFont(size: 9)` (SlashCommandMenu "workspace" pill, `SlashCommandMenu.swift` row), AIcss chevrons | 2+ |
| 11 pt | `.subheadline`, `junoFont(11)` | 3 |
| 12 / **12.5** pt | `junoRowLabel` ×40, `.callout` ×27, `junoFont(12.5)` ×7 (fractional, off any scale) | ≈74 |
| 13 pt | `.body`, `.headline`, `junoFont(13)` ×13 | ≈34 |
| 15–24 pt | `.title3`, `.title2`, `junoFont(18)`, `junoFont(24)` | 12 |

- **10 distinct sizes** (9, 10, 11, 12, 12.5, 13, 15, 17, 18, 24) and **3 designs** (default, monospaced, `.rounded` for keycaps/shortcut hints, `CodeCommandPaletteView.swift` `esc` + shortcuts, `DesktopKeycap`).
- **Monospace as a UI label font** is still pervasive, even though REWORK_VISUAL_AUDIT.md called it "the single most consistent tell". Examples: tool-row subtitles show raw tool ids in 10 pt mono (`TranscriptRow.swift:827-829`); durations "0.0s" (`:837-855`); timestamps above every user turn (`:1351-1361`); settings tile eyebrows (`JunoSettingsPrimitives.swift` `.junoCodeSmall()` on every tile title); "Built in" tags; hunk headers; approval tool name (`ApprovalCard.swift:102`); completion duration (`TranscriptRow.swift:334`).
- **Two diff renderers at different sizes:** inline transcript diff is 12.5 pt mono (`JunoAIcssCode.swift:156`). The review pane diff is 10 pt mono (`DiffLineViews.swift:115,167`).
- The New Task heading (24 pt semibold) against 10 pt metadata everywhere gives a 2.4× jump with little in between.

### 2.2 Spacing
Spacing is mostly tokenized (`JunoSpace` 4/6/8/12/16/20/24/32). Off-grid and raw values:
- `spacing: 1` ×26, `spacing: 2` ×8, `spacing: 3` ×2, `.padding(.vertical, 3)` (StatusChip, remote status pill), `padding(… 5)` / `vertical, 1` (slash "workspace" pill), `.padding(2)` console segmented track, `.offset(x: 12, y: -12)` / `(5,-5)` attachment close buttons.
- `ComposerSurface` uses raw `VStack(spacing: 10)`, `HStack(spacing: 6)`, `.padding(.horizontal, 8)`, `.padding(.top, 4)` (`Composer.swift:871-878, 1041-1042`). This is the one surface that matters most.
- Magic icon-column arithmetic `JunoSpace.cozy + 18 + JunoSpace.snug` is repeated 5× (`TranscriptRow.swift:343,354,686,875,1294`).
- `CodeSessionLayout.inset = 24` (`CodeSessionSurface.swift:14`) against `JunoSpace.region` 32 for remote/cloud canvases. Different gutters on sibling canvases break PREMIUM_AUDIT rule 12.
- **44 pt minimum hit targets forced everywhere on a Mac:** `minHeight: 44` ×53, `minWidth: 44` ×37. This iOS rule inflates every row: tool rows, file rows, source rows, env rows, sidebar brand row, header controls. It is why the transcript in `04-juno-after.jpeg` has about 51 px between one-line tool rows. macOS controls are 20–28 pt.

### 2.3 Corner radii
Radii are tokenized (`JunoRadius`), but **6 rungs** are in use in one window: chip 6 ×14, row 8 ×24, well 12 ×16, card 16 ×12, floating 16 ×2, composer 20 ×3. Also `Capsule` ×4 and `Circle` ×21. Hardcoded `12` appears in the AIcss diff card (`JunoAIcssCode.swift`).
- **The token docs lie about the values.** `JunoRadius.well` says "10" but aliases `field` = 12. `card` says "14" but is 16. `message`/`floating` say "14" but are 16. `composer` says "26" but is 20 (`JunoSurfaces.swift:251-283` vs `Generated/JunoGeneratedTokens.swift:417-431`).
- **Name collisions survive in the Code bridge.** `JunoCodeTheme.Spacing.tight = 4` while `JunoSpace.tight = 6`. `JunoCodeTheme.Radius.card = 8` while `JunoRadius.card = 16` (`JunoCodeTheme.swift:74-89`). The deprecated `JunoSpacing` and `JunoCornerRadius` enums still ship.

### 2.4 Color
- Hardcoded color is near zero: all `Color.juno*`, and `Color.black.opacity(0.18)` for the palette scrim (`DesktopCodeWorkspace.swift:831`). Good.
- **Status colour overload:** `junoDanger` ×55, `junoAccent` ×52, `junoCaution` ×41, `junoSuccess` ×32 in Code views. There are 9 separate status→colour mappers: `CodeRunState.tint`, `lifecycleTint`, `worktreeLifecycleTint`, `permissionTint`, `stateTint`, `checkColor`, `channelStyle`, `SubagentFormatting.tint`, `EnvironmentTab.dotTint`, plus `DesktopRemoteEventPresentation` and `NativeCodeTaskStatus.color`.
- **"Running" has three colours.** The sidebar legend dot is coral (`DesktopCodeStudio.swift:1089`). The run glyph is muted grey (`CodeRunStatus.swift` tint). `DesktopCodeRunningDot` is a breathing green (`DesktopCodeAccountFooter.swift:475-518`).
- **Accent used as furniture** (FLAT_UI §2.4 forbids it): starter-card icon tints in 4 colours (`DesktopCodeStudio.swift:1625-1640`); workspace name glyph in PreRunSuggestions (`TranscriptView.swift:474`); remote session header icon-in-tinted-circle (`DesktopCodeWorkspace.swift:1764-1766`); remote event rows (`:1546,1578,1615`); review note icon (`ReviewFileSection.swift:548`); simulator pane (`SimulatorPane.swift:65,94`).
- Ad-hoc opacities of tint colours: 0.035, 0.08, 0.09, 0.10, 0.12, 0.13, 0.14, 0.18, 0.3, 0.35, 0.45, 0.5, 0.55, 0.7 (14 distinct alphas).

### 2.5 Materials / Liquid Glass
- Glass is used on the right layer (composer, slash/@ menus, jump-to-latest, remote composer, computer-use pill). Reading surfaces are opaque. That is correct.
- **Mixed material inside glass.** Composer buttons (`+`, mic, send, stop) are opaque `junoRaisedCircle`s **with drop shadows** inside the glass bar (`JunoDesktopChrome.swift:423-456`, used at `Composer.swift:551,791`). This opposes FLAT_UI "No variant casts a shadow" and flattens the glass read.
- Four composer shells: `ComposerSurface` (JunoDesktopGlass + junoFloatingChrome), `CodeComposerShell` (GlassEffectContainer + junoGlass with tint), relay composer (`DesktopCodeRemoteCanvas.composer`), and cloud follow-up (`TextField.roundedBorder` in a raised card, `CodeRemoteTaskDetailView.swift:222`).
- **Liquid Glass morphing is unused.** There are no `glassEffectID`, no `.materialize`, and no `matchedGeometryEffect` anywhere in Code. The helpers exist (`junoGlassMaterialize`) but are not used. The command palette is a hand-rolled opaque card + custom shadow + scrim (`CodeCommandPaletteView.swift`) instead of a native panel.
- Settings tiles on macOS are raised **cards with shadow at radius 20** (`JunoSettingsPrimitives.swift` macOS branch). That is a card-per-section dashboard, not a native `Form`.

### 2.6 Borders, dividers, shadows
- Double borders. `ApprovalCard` = `junoCard` (0.5 pt `junoBorder` + shadow) **plus** a 1 pt tint stroke overlay (`ApprovalCard.swift:112-116`). `StarterPromptList` = `junoPanel` + stroke (`TranscriptView.swift:572-576`). `DesktopCodeRelayApproval` = panel + full-strength caution stroke (`DesktopCodeWorkspace.swift:2059-2063`).
- Hairline variants in one window: `Divider().overlay(junoSeparator)`, `Rectangle().fill(junoHairline).frame(height:1)`, `Rectangle().fill(junoSeparator)`, `junoBorder` 0.5 pt, `junoHairline` 1 pt, `junoBorder.opacity(0.5)`.
- Shadows: `junoCard` (starter cards, All Projects cards, approval card), `junoRaisedCircle` (every composer button), palette `radius: 24, y: 12`. FLAT_UI says nothing in the reading column casts a shadow.

### 2.7 Icons
- There are no emoji and no gradients in Code views, which is good. SF Symbols leak in twice (`ComputerUsePane.swift:347`, `CodeConsoleDrawer.swift:541` "checkmark.seal.fill") amid Lucide `JunoIcon`s.
- **Semantic overloading** (violates ICONS_AND_MOTION "one concept, one drawing"):
  - `.lock` is used for **both Read-only and Full access** (`Composer.swift:47,50`), even though `.lockOpen` exists.
  - `.refresh` is used for: running/queued/planning status (`CodeRunStatus.swift:286-287`), "checkpointed/revertible" (`TranscriptRow.swift:1248`), compaction (`:655`), review "not reviewed" **and** "reverted" (both identical, `ReviewFileSection.swift:600-614`), "update ready" (footer), remote "status changed".
  - `.check` is used for Ready **and** Completed (`CodeRunStatus.swift:283`), so a fresh idle session looks finished.
  - `.permission` (exclamation-shield) is used for the default "Ask before changes" mode, every approval, needs-approval status, screen control and the bell list. The default safe mode wears an alarm glyph.
  - `.external` (↗) is used for "moved file", starter prompts that only fill the composer (`TranscriptView.swift:566`), "Compare branch", and Reveal in Finder.
  - `.sliders` is used for Plan mode, Steer, the inspector toggle, "Plan a change", and Code settings.
  - Paused goal uses `.stop` (`GoalBar.swift:264`).
- The status glyph doc claims "Every mark is a circle" (`CodeRunStatus.swift:18`), but the implementation draws check / stop / device / refresh / error glyphs (`:280-290`). The spec and the code disagree.

### 2.8 Density & AI-slop pattern inventory (file:line)
| Pattern | Where |
|---|---|
| Ornamental hero mark ("the page's one piece of ornament") | 56 pt outlined terminal icon in a bordered rounded square, `DesktopCodeStudio.swift:1527-1536` |
| Rainbow-tinted icon cards | 4 starter cards, source/accent/success/caution tints, `:1620-1643` |
| Hover lift (scale 1.015 + y −2) | starter cards `:1685-1686` |
| Icon-in-tinted-circle | remote header `DesktopCodeWorkspace.swift:1764-1766`; every remote event row `:1921-1926`; `JunoEmptyState` 72 pt circle |
| Pill / chip overload | `StatusChip` (risk), `DiffStatPill` (`TranscriptRow.swift:614-637`), `CodeContextChip` ×3 in the composer context strip, status capsules in cloud & remote headers, "workspace" 9 pt pill, inspector approval-count capsule (`InspectorView.swift:170-183`), keycaps |
| Cards inside cards | DiffStatPill inside the completion card; AIcss diff card (own header + border) inside a file row inside a work log; approval queue rows (bordered panels) under an approval card; settings tiles holding bordered controls |
| Left-border accent | AIcss diff rows 3 pt accent bar (`JunoAIcssCode.swift` `accent(row.kind).frame(width: 3)`); sub-agent & raw-step indents with a 1 pt left rule (`TranscriptRow.swift:1035`, `ActivityNarrativeView.swift:163`) |
| Too many status signals | sidebar glyph + legend + bell; header status + elapsed + context ring %; goal bar progress bar + "3/5 steps · 1 verification"; inspector approval badge; approval countdown + risk chip; per-tool running tint + elapsed; sub-agent dot strip (`EnvironmentTab.swift:385-391`); quota bar; sync dot |
| Meters in chrome (PREMIUM_AUDIT rule 7) | context ring (`CodeThreadHeader.swift:325-370`), goal `ProgressView` (`GoalBar.swift:55`), quota bar (`DesktopCodeAccountFooter.swift:318-327`), dot-fill bar |
| Ticking clocks | 10 `TimelineView(.periodic(by: 1))` sites: header elapsed, every running tool row, work log, "Juno is working…", approval countdown, every sub-agent, activity tab, console, preview. Several tick at once |
| Over-labelled rows | tool row = status glyph + summary + raw tool id + duration + chevron (`TranscriptRow.swift:818-861`); file row = glyph + filename + directory + checkpoint icon + diffstat + chevron |
| Engineering telemetry in product | raw tool ids (`update_goal`, `preview_browser` in `04-juno-after.jpeg`); "0.0s" durations; turn-contract caption "Code · Claude Sonnet 5 · Ask before changes · high reasoning" above turns (`TranscriptRow.swift:453-496`); display bounds in pt (`ComputerUsePane.swift:222-225`); "Restorable versions" metric (`ActivityTab.swift:142`); `@@ -12,7 +12,9 @@` hunk headers as the hunk label; 12 run states incl. "Degraded", "Waiting for model", "Computer offline" |
| Filler content | Environment "Sources" falls back to listing arbitrary root files as "Workspace file" (`EnvironmentTab.swift:63-67`, visible in `04-juno-after.jpeg`); Preview pane that is only a description + button (`PreviewTab.swift`) |
| Hardcoded fake data | **`Text("Owner · Pro")`** shown for every account (`DesktopCodeAccountFooter.swift:101`) |
| Dead tint | `DesktopSidebarQuotaMeter.tint` computed but never applied, so the bar never turns caution (`:326` vs `:357`) |

---

## 3. Motion audit
Inventory: 45 `withAnimation` / `.animation` / `.transition` sites, 10 `TimelineView` tickers, 1 `symbolEffect`, 0 `matchedGeometryEffect`, 0 `phaseAnimator` / `keyframeAnimator`, 5 `contentTransition(.numericText())`, 1 `repeatForever`.

**What's good:** nearly every call uses `JunoMotion` rungs (`fast` 0.12, `standard` spring 0.22×0.75, `canvasEnter`, `exit`, `reward`, `emphasized`). There are no raw `.easeOut(duration:)` in Code. `JunoMotion.reduced(_:when:tier:)` is a thoughtful tiered policy (`JunoDesignTokens.swift:374-425`).

**Problems:**
1. **Unguarded Reduce Motion (about 20 sites)**:
   - dictation show/hide `JunoMotion.fast` (`DesktopCodeWorkspace.swift:689,702,706,710`; `DesktopCodeStudio.swift:1811,1816,1821,2395`)
   - console reveal is travel but raw `JunoMotion.fast` (`CodeSessionSurface.swift:163`)
   - composer drop/attachment (`Composer.swift:900-901`)
   - slash menu scroll (`SlashCommandMenu.swift:48`), file menu (`FileContextMenu.swift:60`), remote auto-scroll (`DesktopCodeWorkspace.swift:1706`)
   - console segment switch (`CodeConsoleDrawer.swift:144`), remote task detail (`CodeRemoteTaskDetailView.swift:79`)
   - sub-agent focus (`SubagentInspector.swift:55`), context ring (`CodeThreadHeader.swift:351`), footer hover/dots (`DesktopCodeAccountFooter.swift:276,416`), plan load (`DesktopCodeWorkspace.swift:1464`)
   - **`.symbolEffect(.pulse)`**, an ambient loop, is unguarded (`ComputerUsePane.swift:528`)
2. **Raw transitions bypass the `junoOverlay` / `junoInline` tokens:** `.move(edge:).combined(with: .opacity)` ×5 (`CodeSessionSurface.swift:180,218,362,386`; `DesktopCodeWorkspace.swift:715`). Also `.scale(0.96)` (`:1745`) and bare `.opacity` ×4. Because of this, exits don't use the `exit` curve.
3. **`reward` misused.** The token doc says "exactly two sites product-wide: a run reaching Completed, and an approval being accepted". Code applies it to the relay approval card **appearing** (keyed on `pendingApproval?.id`, `DesktopCodeWorkspace.swift:1749`) and to **any** status label change (`:1789`), e.g. Running→Needs approval bounces. The local `ApprovalCard` and local completion get no reward. The only bouncy moments are on the least-used transport.
4. Hover lift on starter cards (`DesktopCodeStudio.swift:1685-1691`) is decorative motion in content.
5. **Five different disclosure-chevron implementations:**
   - chevronRight rotated 90° (tool / file / compaction / sub-agent rows)
   - chevronDown rotated −90° (work log, `ActivityNarrativeView.swift:69-71`)
   - chevronUp rotated 180° (reasoning, `JunoAIcssReasoning.swift`)
   - glyph swap chevronDown↔chevronRight ("Show every step", `ActivityNarrativeView.swift:148`)
   - a static decorative chevronDown on the model chip that isn't a control (`Composer.swift:1340`)
6. Ambient loops in chrome: breathing running dot (`DesktopCodeAccountFooter.swift:493-518`) and 10 per-second clocks. PREMIUM_AUDIT rule 10 says "Nothing in chrome moves except a fill."
7. Hack: `.animation(…, value: running + needsYou * 1_000 + done * 1_000_000)` (`DesktopCodeStudio.swift:1095`).
8. Product switch replays a whole-window rise and destroys state (`JunoDesktopWorkspaceView.swift:65, 199-213`).
9. No spatial continuity. The review pane, inspector, preview dock and simulator dock each slide in from the trailing edge independently. None morph from the control that opened them.

---

## 4. UX flows

| Flow | Clicks / keys | What's confusing | Missing |
|---|---|---|---|
| **Open a folder** | ⌘O or "Open folder…" (6 places) → file dialog "Open Project" | "project", "folder", "workspace" and "repository" are used interchangeably. Re-grant errors appear as small text in the sidebar footer area (`DesktopCodeStudio.swift:979-1007`) | Recent folders; clone from GitHub |
| **Start a session** | New task → type → ⏎ (2) | The heading's dotted-underlined project name is a menu (`:1539-1607`). The same project is repeated as a non-interactive chip in the composer (`:1736-1742`). Starter cards **silently change the mode** (e.g. "Explore and understand code" sets `.survey`, `:1623-1626`), and the change shows only inside the permission chip. Placeholder is "Do anything". Environment Cloud/Device swaps in small native pickers inside the glass strip | One-line "where it runs · what it can touch" summary; branch picker |
| **Send a prompt** | ⏎ / ⌘⏎ | Two composers (new-task vs session) with different `+` menus and shells | — |
| **Watch the agent** | passive; 1–3 clicks to see steps | Four levels: work log "Worked for…" → kind rows → "Show every step" raw rows → tool output. Internal tools (`update_goal`) shown as failures in red (`04-juno-after.jpeg`). Turn-contract captions and timestamps interleave. The header shows status, elapsed, context %, Stop, Share and 2 toggles. The goal bar adds a progress bar | A calm "what it's doing now" line; hiding internal/bookkeeping tools |
| **Approve a command** | ⇧⏎ / click | Card stack: exclamation-shield, "Approval required", ticking "Expires in 4:59", "Execute risk" chip, summary, 1–2 sentences of policy prose, raw tool id, Deny / "Always allow edits here" / Approve (`ApprovalCard.swift:89-193`). A "Critical risk" chip is drawn in caution (not danger) with the text "Full access does not ask for this." With the composer focused, ⏎ sends a message instead of approving. There are 6 separate approval implementations (ApprovalCard, ApprovalQueueRow, ActivityTab inline, SubagentApprovalCard, CodeRemoteTaskDetailView inline, DesktopCodeRelayApproval) with different layouts and shortcuts | Showing the actual command/diff inline as the primary content |
| **Review diffs** | 1 (toolbar / pill) | Opens as a split pane, so sidebar + thread + review + inspector means 4 columns (PREMIUM_AUDIT rule 2 says 2 max). The pane header shows the diffstat and the controls strip repeats it (`CodeSessionSurface.swift:263-298`, `ReviewCanvasView.swift:82-99`). The unreviewed and reverted file glyphs are identical. Hunk actions are 10 pt borderless text. The hunk label is a raw `@@` header. There is a second, different diff inside the transcript | File tree/list with jump; per-file collapse; syntax highlight |
| **Accept / revert** | per hunk, per file, all | "Keep" only marks as reviewed (no disk effect), which users will read as "apply". Revert paths have 5 confirmation-dialog variants ("Restore Anyway" ×3) | Undo of a revert |
| **Commit / PR** | Env rail "Commit or push" → `.alert` with a TextField (default "Apply changes from Juno") → commit all (`EnvironmentTab.swift:124-131`); again → push confirmation; "Compare branch" (↗ icon) opens a PR sheet | Commit is buried in an inspector row and is all-or-nothing, with no file list. The PR entry is labelled "Compare branch". Branch and push UIs are duplicated in Repository | Generated commit message; staged-file review; PR from Review pane |
| **Switch sessions** | sidebar / ⇧⌘[ ] / ⌘K | Clicking a project **name** opens New Task rather than its threads (`:680-721`). Done threads show no mark while running/failed ones do. Filter labels read "Run" / "Needs" (`:108-115`). Recents empty state says "No chats" in Code (`:431`). Every session switch tears down preview and simulator | Date grouping per TWO_PRODUCTS; pinned |
| **Stop / interrupt** | ⌘. | Two Stop buttons visible at once, styled differently (red text in header; coral circle in composer) | — |
| **Queue follow-up** | type while running | A hidden Steer vs Queue concept via a chip menu (`Composer.swift:475-501`). **Slash commands and @-mentions are disabled while running** (`Composer.swift:190, 204`), even though the composer accepts steer/queue text | Visible queued-message list with edit/cancel |
| **Attach files/images** | `+` → one-item menu "Attach image…" (`Composer.swift:580-619`); drag; ⌘V | The `+` **disappears entirely** if the model lacks vision. In a session, files are added only via @. The new-task `+` has "Add file context / Add picture / Open folder…" (`DesktopCodeStudio.swift:2231-2264`). File references show both as `@path` text and as chips | Consistent `+` |
| **Model / effort / permission** | 1 click each | The model·effort chip is two buttons with a decorative chevron. The permission chip menu mixes Permissions + Mode (Ask/Survey/Plan/Code) + Agent, and permission rows are disabled unless the mode is Code. The label becomes "Plan · read-only". Labels drift: "Ask before changes" (menu), "ask to edit" (`shortText`), "Ask before edits" (screenshot) | Separate, legible mode switch (Codex-style Ask / Code) |
| **Slash commands** | "/" | 11 built-ins including `/boost` and `/teamwork-preview` (`SlashCommands.swift:297,310`). Most fill the composer but `/compact` and `/review` execute immediately, so behaviour is inconsistent. A "workspace" 9 pt pill marks repo commands | Descriptions of side effects |
| **@-mentions** | "@" + 140 ms debounce | Fine when idle. Unavailable while running | Symbols, not just files |

---

## 5. Copy audit (verbose, odd, or engineer-speak)
- Placeholders: "Do anything" (×2), "Queue a follow-up for after this execution…", "Steer Juno at the next safe point…".
- Nouns for the same object: **task** (32), **run** (58), **session** (29), **thread** (11), **conversation** (9), **chat** (the "No chats" empty state). Pick one.
- The inspector is called "Environment rail", "context rail" and "Inspector"; the pane menu says "More task tools".
- Filter "All / Run / Needs / Done" vs legend "running / needs you / done" vs menu "Needs your attention".
- "Other computers" section showing "No matching sessions on this computer" (`DesktopCodeStudio.swift:891`).
- "Answers only — no files, no commands" (no-project detail); "Unavailable in preview"; "Git actions are unavailable in the preview fixture" (`EnvironmentTab.swift:522,539`). Debug-fixture copy ships.
- Approval prose: "Uses the network, or runs code from this folder. Changes it makes are not checkpointed and cannot be undone from the transcript. Full access does not ask for this."
- "Recoverable — the agent can continue." · "Every edit is checkpointed, and this session is set to ask to edit." (`TranscriptView.swift:446`) · "Restorable versions" · "Isolate…" / "Isolate worktree" · "Trust & enable hooks" · "configuration issue(s)" · "Kernel containment is unavailable on this Mac; the preview still uses a scrubbed environment" · "Waiting for model inference response or failover." · "Running with fallback model or clamped capabilities." · "Finished on its own terms." · "Ended because someone ended it."
- Settings MCP footnote (55 words): "Turning this on explicitly permits this exact server to start or make its discovery request in this project…".
- "Choose the folder Juno Code may read and write in — or make a new one." · "Owner · Pro" (hardcoded).
- Tool rows titled with runtime sentences plus ids: "Set goal lifecycle to completed / update_goal".
- Title-case drift: "New Task Here", "New Task in This Project", "Open Folder…" vs "Open folder…", "Create Pull Request…" vs "Create pull request…", "Delete Thread" vs "Delete".
- Keyboard hints that don't match bindings: the palette says Open file is "⇧⌘O" (`DesktopCodeWorkspace.swift:863`), but ⇧⌘O is **New Chat** and Open File is ⇧⌥⌘O (`DesktopCommands.swift`). The palette says "Code settings… ⌘,", but ⌘, opens General.

---

## 6. Settings — what exists and where
1. **Settings window ▸ Code** (`DesktopSettingsWindow.swift:25,63,369-389` → `CodeSettingsView(scope: .all)`):
   - New task defaults: Permissions, Model, Reasoning
   - Environment: Local/Worktree segmented + read-only "Worktree location"
   - Project picker
   - MCP servers (consent toggles)
   - Hooks (toggles)
   - Skills (toggles)
   - Agents (read-only list)
   - Juno Code Remote hosting toggle
   - Juno Work hosting tile
2. **Code sidebar ▸ Plugins** = the same view scoped to MCP / hooks / skills / agents (`DesktopCodeWorkspace.swift:575-580`).
3. **Code sidebar ▸ Security** = the same view scoped to defaults + environment + remote hosting (`:582-589`).
4. **Inspector ▸ Repository** duplicates hooks trust ("Trust & enable hooks"), MCP disable, skills count and config diagnostics (`RepositoryTab.swift:128, 533-610`).
5. The same Settings shell is also presented as a **modal sheet** (`DesktopSettingsModal.swift`), so there are two presentations.

Visual: each section is a raised shadowed card (radius 20) with a 10 pt monospace eyebrow. It is not a native `Form`, so it misses native grouping, separators and Liquid Glass. There is no appearance/density/font-size setting for Code, no keybinding settings, no default-project or default-branch setting, and no notification settings for "needs you".

---

## 7. Code quality of views
- **Giant files / god views:**
  - `DesktopCodeStudio.swift` 2,850 lines: `DesktopCodeNewTaskScreen` alone is **1,340 lines, 20 `@State`** (`:1359-2695`); `DesktopCodeSidebar` is 740 lines.
  - `DesktopCodeWorkspace.swift` 2,067 lines, **~27 `@State`/`@SceneStorage` on one view**; `body` is a 156-line modifier chain (`:201-357`).
  - `CodePreviewWindow.swift` 2,315 lines contains **two full preview chromes** (window `CodePreviewWindowView` :1251 and dock `CodePreviewDock` :1816) with duplicated address bar, server log and start/stop.
  - `SessionController.swift` 3,108 lines, `TranscriptRow.swift` 1,362, `Composer.swift` 1,348, `SubagentInspector.swift` 1,174.
- **Duplicated components:**
  - composer ×4
  - approval UI ×6
  - transcript/event renderer ×3
  - diff renderer ×2 (plus 3 diffstat variants: `DiffStat`, `DiffStatPill`, EnvironmentTab inline)
  - starter prompts ×2 (new-task cards, `PreRunSuggestions` list)
  - thread header duplicated by the cloud detail's own header
  - status→colour mapper ×9
  - new-branch alert ×2, push confirmation ×2, CreatePR sheet host ×2
  - permission chip ×2 (near-identical `Composer.swift:397-453` / `DesktopCodeStudio.swift:1854-1926`)
  - model·effort chip ×2 (`Composer.swift:1221-1347` / `DesktopCodeStudio.swift:1948-2028`)
  - attachment + drop + dictation handling ×2
  - three resize-handle implementations with cursor push/pop (review, preview dock, console, simulator)
  - hand-rolled segmented control in the console (`CodeConsoleDrawer.swift:147-181`) while other places use native `.segmented`
- **Dead code:**
  - `CodePageHeader`, `CodeSessionRow` (+Skeleton), `CodeModelSelector`, `CodeThinkingControl`, `CodeStatusLegend` (still cited by a comment as "the discoverable version"), `CodeContextSeparator`, `DesktopKeycap`, `DesktopCodeSidebar.accountButton`
  - `PermissionModeLabel.glyph` / `AgentBehaviorLabel.glyph`, `CodeRunState.symbol`, `CodeInspectorPane.symbol` (SF-symbol tables)
  - deprecated `JunoSpacing` / `JunoCornerRadius`, `JunoCodeTheme.Spacing/Radius` bridges
- **Comment archaeology:** 18–30% of lines in core views are comments narrating past bugs and audits (`CodeSessionSurface.swift` 30%; `JunoSurfaces.swift` 65%). The intent lives in prose rather than in components, and several comments contradict the code (circle-family status marks; "Scaled against the callout title" on fixed-size icons, `DesktopCodeWorkspace.swift:1761`; radius values).
- **Hardcoded values:**
  - review/preview/simulator metrics (420/640/1200/440/380/980/0.62/0.44)
  - `CodeSessionLayout.inset = 24`
  - palette width 560 / maxHeight 440 / top 96
  - `CodeComposerShell` default `maxWidth: 680` vs `JunoReadingMeasure.reading` 768
  - `frame(maxWidth: 120/132/150/170/210/220/260/320)`
  - duration column 46, slash row height 42
- **Hacks:**
  - `Task.yield()` before every menu selection to dodge an NSPopover crash (`Composer.swift:458-470`, `DesktopCodeStudio.swift:2062-2083`)
  - `Color.clear.overlay{}` to stop split-view inflation (`CodeSessionSurface.swift:132`)
  - an `accessibilityRepresentation` re-exposing hidden toolbar actions (`DesktopCodeWorkspace.swift:1125-1148`)
  These are signs the layout is fighting AppKit rather than using standard containers.
- **Accessibility ids and 44 pt frames** are wrapped around nearly every element, which inflates layout.

---

## 8. Top 20 design problems (ranked by severity)
1. **No product hierarchy.** 10 canvases, 6 inspector panes, about 45 visible controls per session. Every runtime capability is surfaced (§1.3–1.6).
2. **Pervasive 10 pt text (≈72% of text sites) and monospace-as-label.** The product reads as a debug console (§2.1).
3. **Duplicated core components:** 4 composers, 6 approval cards, 3 transcript renderers, 2 diff renderers, 2 starter systems. Inconsistency is structural (§7).
4. **Too many panes:** sidebar + thread + review split + inspector + preview/simulator dock. It violates the two-pane rule, and the review is squeezed (§1.2).
5. **Status-signal overload:** 12 run states, 9 colour mappers, three colours for "running", 10 ticking clocks, meters in chrome (§2.4, §2.8).
6. **Transcript shows machine plumbing:** raw tool ids, 0.0 s durations, internal `update_goal` failures in red, turn-contract captions, per-turn timestamps, 4-level disclosure (§4 Watch).
7. **Redundant entry points:** Review ×8, New task ×10, Stop ×2 on screen, inspector toggle ×4 under 3 names (§1.7).
8. **Icon semantics broken:** `.lock` for read-only and full access; `.refresh` for 6 concepts; `.check` for Ready and Completed; alarm shield on the default mode (§2.7).
9. **Approval UX is prose-heavy and inconsistent:** countdown, risk chip, policy sentences and tool id bury the actual command; the shortcut conflicts with composer ⏎ (§4).
10. **Composer violates its own spec:** 8 controls, Stop + Send together, a mode/permission/agent mega-menu, a decorative chevron, a one-item `+` menu that vanishes for non-vision models (§1.6, §4).
11. **Terminology chaos:** task, run, session, thread, conversation and chat for one object; project/folder/workspace/repository; "Keep" meaning "mark reviewed" (§5).
12. **Git flow buried and duplicated:** commit via an alert TextField in an inspector row, PR labelled "Compare branch", branch/push UIs duplicated (§4).
13. **IA bleed from other products:** Scheduled (Chat), Design and a 3-way Chat/Code/Work switch contradict TWO_PRODUCTS.md; the product switch rebuilds state (§1.1, §1.3).
14. **Settings scattered across 4 surfaces**, drawn as shadowed cards with mono eyebrows instead of a native Form (§6).
15. **Material inconsistency:** shadowed opaque circles inside glass, a hand-rolled opaque palette with scrim, no glass morphing or continuity, 6 radius rungs visible at once (§2.5).
16. **Decorative AI-slop patterns:** ornamental hero mark, rainbow icon cards with hover lift, icon-in-tinted-circle rows, pill-in-card, left-accent diff bars, double borders (§2.8).
17. **Mac ergonomics wrong:** 44 pt minimum hit targets everywhere make rows iOS-tall; custom sidebar collapse duplicates the system one; the console has a hand-rolled segmented control (§2.2, §7).
18. **Copy is verbose and engineer-speak**, including shipped fixture/debug strings, a hardcoded "Owner · Pro" and wrong shortcut hints (§5).
19. **Motion inconsistencies:** ~20 sites ignore Reduce Motion, including an ambient pulse; `reward` is misused on the least-used transport; 5 chevron idioms; raw `.move` transitions (§3).
20. **Token system drift:** doc comments disagree with radius values, colliding names in `JunoCodeTheme`, deprecated scales still shipped, `junoFont(size: 12.5)` off-scale escapes, raw 10/6/8/4 spacing in the composer (§2.2–2.3).

---

## 9. Salvageable vs must be rewritten

**Salvage (keep the logic and the token intent; restyle):**
- `JunoDesignTokens` / `JunoGeneratedTokens` (colour pairs, duration ladder, `JunoMotion.reduced` tiers, `JunoReadingMeasure`). Fix radius docs; delete deprecated scales and the `JunoCodeTheme` bridges.
- `JunoModelSelector` + `JunoThinkingPanel` popovers (shared with Chat): re-host behind one chip.
- `ActivityNarrativeView` **concept** (collapsed "Worked for 3m · read 4 files, ran 2 commands"). It is the right idea; make it the only machine-activity surface.
- `ReviewModel` + hunk keep/revert/comment logic + checkpoint restore flows (`ReviewFileSection` behaviour). Rewrite the visuals.
- `TranscriptContext` indexing, `TranscriptView` pin-to-bottom / jump-to-latest behaviour, `TranscriptTail` streaming.
- `CodeRunStatus` as a data type, collapsed to about 4 user-facing states. Keep `DesktopCodeNavigationState` pure navigation rules.
- `DesktopSidebarSearchField` (NSSearchField wrapper), `CodeSlashToken` / `CodeFileContextToken` parsing, slash/file search ranking.
- `SlashCommandMenu` / `FileContextMenu` glass popups (minor restyle).
- `CodeJumpToLatestChrome`, `ReviewLayoutPicker`, `OpenQuicklySheet`, `CreatePullRequestSheet` (after unifying hosts).
- `CodeConsoleDrawer` terminal/test plumbing (replace the hand-rolled segmented control).

**Must be rewritten:**
- `DesktopCodeWorkspace` (window shell, toolbar, palette, relay canvas, relay approval): collapse to one toolbar and one detail router.
- `DesktopCodeSidebar`: task list only, date folds, one status mark per row; remove destinations, legend, bell and filter trio.
- `DesktopCodeNewTaskScreen` (1,340 lines): replace with the shared composer + one greeting line.
- `Composer` / `ComposerSurface` / `CodeComposerShell` / remote & cloud composers → **one** composer.
- `ApprovalCard`, `ApprovalQueueRow`, ActivityTab approval, `SubagentApprovalCard`, relay & cloud approvals → **one** approval component.
- `TranscriptRow` (tool/file/turn-contract/timestamp/completion rows), `DesktopCodeRemoteCanvas`, `CodeRemoteTaskDetailView` → **one** transcript for all transports.
- `CodeThreadHeader`, `GoalBar`, `CodeContextMeter`: a single quiet header.
- `InspectorView` + `EnvironmentTab` + `RepositoryTab` + `ActivityTab` + `PreviewTab` + `ChangesTab` + `SubagentInspector` (≈3,400 lines) → one context panel with at most 3 sections (Changes · Git · Agents).
- `ReviewCanvasView` / `ReviewFileSection` / `DiffLineViews` visuals, and delete the second diff renderer.
- `CodePreviewWindow` (dedupe window/dock chrome), `DesktopCodePreviewDock`, `DesktopSimulatorDock` (one shared side-panel container).
- `CodeSettingsView` + `JunoSettingsTile` (macOS) → native `Form` in Settings only; remove the Plugins/Security destinations.
- `DesktopCodeAccountFooter` (hardcoded plan label, quota bar, sync dot, breathing dot).
- `StatusChip`, `DiffStatPill`, `CodeContextChip`/`CodeContextChipLabel`/`ComposerChipLabel` → one chip primitive (or none).
- Delete the dead code in §7.
