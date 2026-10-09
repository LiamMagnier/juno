# Mac round 3 — status

Branch `polish/mac-round3` (from origin/main 19b20f459). Not pushed, not deployed, no release.

The owner's request, verbatim: "subfolder doesn't look good in project and when you click on it , it doesn't open please fix that too … rework all the pages like the customize only have connector but doesn't have skills , memory ... The setting pop-up page is horrible in terms of UI / UX rework it and rework the buttons and selectors components on all the app instead of thoses rectangle white thing use native liquid glass components". Follow-up: "make the buttons components rounded like on the iphone calendar app".

## Tasks

### 1. Project subfolders: look, and open on click — DONE (the fix still needs a signed-in check)
- **Look.** Folders now sit above the chats, as on the web. They are a grid of compact tiles (1, 2 or 3 columns by width). Each tile has the project's cover image, or else a seeded dot-matrix orbit drawing (a port of the web's `ProjectCover`, with one spoke per folder). Below it are the serif name and one mono line ("0 chats · 1 folder · 1y ago"). A pinned folder shows its pin. Right-click offers Open, Pin, Rename…, Move To… and Delete Folder…. With no folders, the section shows an invitation with New folder beside it. The breadcrumbs use a chevron instead of "/".
- **Open.**
  - Every way into a folder (tile, breadcrumb, "From …" inherited source) is now `NavigationLink(value: DesktopPageRoute.project(id))`. It no longer depends on an environment push reaching a page that was itself pushed.
  - The likely cause of the bug was removed. The project page's `onDisappear` cleared `requestedProjectID`, and that also fires when a folder is *pushed over* the page. The sidebar selection then moved mid-push, and the window's selection binding could write the Projects destination back.
  - The Projects stack's `pathChanged` now owns that decision (`DesktopDestinationView.projectsPathChanged`).
- **Not proven.** I could not click in the signed-in app (no screen control). The owner should click a folder on a pinned project and on a project opened from the Projects index.
- Files: `App/DesktopProjectFolders.swift`, `App/DesktopProjectPage.swift`, `App/DesktopAccountScreens.swift`.

### 2. Pages to the web's information architecture — DONE for Customize, PARTIAL for the rest
- **Customize** (`App/DesktopCustomizeScreen.swift`, new):
  - It holds Apps · Skills · Routines · Memory · Instructions, as on the web, on a centred glass tab row. The tabs hide while a detail page is pushed.
  - The group shares one view identity, so the selection slides between tabs.
  - The sidebar's Customize row stays lit on every tab. The window ignores the list re-sending that same row, so being on Skills cannot bounce you back to Apps.
  - **Instructions** is new: a `.instructions` destination showing the Personalization rows as a page.
  - Apps and Routines use the web's titles and ledes.
  - Apps no longer has the duplicate "Add MCP Server" button. The directory's Add tile adds a custom server, as on the web.
- **Owner rule (no status pills).** Routines' "Paused" pill and Permissions' "Work off" pill are now plain words.
- **Not done:** page-by-page structural parity beyond Customize (Library, Artifacts, Orbit, Assistants). They already follow the contract's sidebar (Projects, Library, Customize; Orbit as a section). No further gaps were found, but a full feature-by-feature audit of each page against the web was not done.

### 3. Settings window — DONE
- Each pane opens with a header: the section's tile at 40pt, its name in the title size, and one sentence on what the section holds.
- The rail has titled groups (Alevr · Intelligence · Account · Developer).
- Section tiles are circles. The selected one fills with the accent and shows its glyph in the on-accent ink (System Settings' cue).
- Rows keep a 720pt readable measure, centred. The window opens at 900 × 660 (minimum 720 × 520).
- Theme is the glass segmented control. Every menu picker is a glass capsule menu. Every button is a glass capsule.
- Files: `App/DesktopSettingsWindow.swift`, `App/DesktopSettingsScreen.swift`, panes.

### 4. Native Liquid Glass buttons and selectors, rounded like iOS Calendar — DONE
- **Design system** (`JunoDesignSystem/JunoGlassControls.swift`, new):
  - `.junoGlass`: the system `.glass`, capsule.
  - `.junoProminent` on the Mac: `.glassProminent` in the accent, capsule.
  - `.junoGlassMenu(.capsule | .circle, prominent:)`, `.junoGlassMenuPicker(current:)`, `.junoGlassIconButton()`, `.junoGlassCapsule()`.
  - `JunoSegmented` on the Mac is a capsule glass track with a capsule lens.
  - `JunoPageMenu` (sort) is a glass capsule menu.
  - `JunoPageSearchField` sits on a glass capsule.
  - Page header actions share one `GlassEffectContainer`.
- **Offscreen and Reduce Transparency.** Each control draws an opaque capsule stand-in at the same metrics. The snapshot renderers set `junoSnapshotOpaqueGlass`, because the window server composites glass and `cacheDisplay` cannot capture it.
- **Sweep:**
  - every `.bordered` became `.junoGlass` and every `.borderedProminent` became `.junoProminent`, across the Mac app, JunoNativeKit and JunoCode;
  - content `Picker(.segmented)` became `JunoSegmented`: artifact canvas, spreadsheet sheets, simulator Build/Logs, bring-back, Live UI;
  - `Picker(.menu)` became glass menus: Settings, Assistants, Apps' category, Code plan level, image edit;
  - Skills' Add became a prominent glass menu, and its search a glass capsule;
  - project Pin and More are glass circles;
  - quiet icon buttons, ghost buttons and composer controls hover as circles or capsules.
- **Left as they are:** Forms' native toggles and text fields. Code's own Settings window keeps its grouped-form segmented pickers, which are a native Form control.
- **iOS** is unchanged: the styles fall back to `.bordered` / `.borderedProminent` there.

## Snapshots
Curated light-mode pairs are committed in `docs/native/mac-round3/shots/before/` and `docs/native/mac-round3/shots/after/`. Full runs, light and dark, are in the session scratchpad (`…/scratchpad/before`, `…/scratchpad/after3`).

| Page | Before | After |
|---|---|---|
| Library | shots/before/library-list-light.png | shots/after/library-list-light.png |
| Library grid / deleted | shots/before/library-grid-light.png, library-deleted-light.png | shots/after/library-grid-light.png, library-deleted-light.png |
| Project overview (folders) | shots/before/project-overview-light.png | shots/after/project-overview-light.png |
| Project overview narrow | shots/before/project-overview-narrow-light.png | shots/after/project-overview-narrow-light.png |
| Folder page (breadcrumbs, inherited) | — | shots/after/project-folder-light.png |
| Projects grid | shots/before/projects-grid-light.png | shots/after/projects-grid-light.png |
| Customize › Apps | shots/before/connections-light.png | shots/after/connections-light.png |
| Customize › Skills | shots/before/skills-list-light.png | shots/after/skills-list-light.png |
| Customize › Instructions | — | shots/after/customize-instructions-light.png |
| Memory | shots/before/memory-off-light.png | shots/after/memory-off-light.png |
| Routines | shots/before/automations-list-light.png | shots/after/automations-list-light.png |
| Artifacts | shots/before/artifacts-list-light.png | shots/after/artifacts-list-light.png |
| Orbit | shots/before/agents-roster-light.png | shots/after/agents-roster-light.png |
| Settings › General (window) | shots/before/settings-general-light.png | shots/after/settings-general-light.png |
| Settings › Account / Plan | shots/before/settings-account-light.png, settings-plan-pro-light.png | shots/after/… same names |
| Settings panes (Personalization, Models, Apps) | shots/before/settings-*-light.png | shots/after/settings-*-light.png |

## Tests
`xcodebuild … -only-testing:JunoDesktopTests test` was run with all three snapshot env vars set: 450 tests in 71 suites.

**Every non-snapshot test passes.** `DesktopStageCPagesTests` and `DesktopShellContractTests` were updated for the Customize behaviour and the new `.instructions` page.

**14 snapshot issues remain. They are environmental and present before this branch.**
- The baseline run on untouched origin/main had 13 issues of the same kind: work cards and approval cards render blank ("0.000% of pixels differ"), streaming transcript fixtures render under the 0.5% floor, and the off-screen web view never loads.
- After my changes the same 13 recur.
- `mermaid-streaming` is the 14th. It is the same streaming/web-view class, and it passed in one of the three after runs.
- `task-record-sheet-error` went under the floor with a white stand-in. The stand-in now uses the secondary fill and the fixture passes.

**Design gates** (`node scripts/check-native-*.mjs`):
- **prominent, menus, symbols, type, motion, targets:** each holds or went down.
- **glass:** fails at 21 against a recorded baseline of 20. The extra violation is in `LiveUI/JunoLiveUIParts.swift:408`, which this branch did not touch; the same violation is on origin/main.
- `JunoGlassControls.swift` is exempt as a glass primitive, by the owner's instruction (noted in the script).

## Next steps
- Owner signed-in check: click a subfolder (pinned project and Projects index); switch Customize tabs; look at the glass controls live. Snapshots show only the opaque stand-ins.
- A deeper feature-by-feature parity audit of Library, Artifacts, Orbit and Assistants against the web.
- Re-record the glass baseline once the LiveUI glass from main is resolved.
