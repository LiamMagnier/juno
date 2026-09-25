# Phase 4 implementation brief: the secondary pages (juno-glass-pages, branch mac/liquid-glass-pages)

**Status:** brief, 2026-09-25. Nothing in `native/` is changed by this document.

**Where.** All paths are under `/Users/liammagnier/Developer/project/juno-glass-pages/`. Shorthand as in the spec: `App/` = `native/macOS/JunoDesktop/App/`, `DS/` = `native/Packages/JunoNativeKit/Sources/JunoDesignSystem/`, `ChatKit/` = `…/JunoChatKit/`, `WorkKit/` = `…/JunoWorkKit/`. Line numbers are from the tree at `22436463` (the foundations commit this branch starts from).

**The web is `origin/main`.** Fetched 2026-09-25 at `fe0a501d`. First light (`a6168f38`) and M11 type immutability (`db3766ab`, merged through the release train) are both on it: `resolveArtifactTag` is in `src/lib/chat-client-state.ts:103-122`, the poster route is `src/app/api/artifacts/[id]/poster/route.ts`, and the poster URL helper is `src/lib/design/poster-url.ts`. Read the web with `git show origin/main:<path>`, or extract it once with `git archive origin/main src | tar -x -C <scratch>`. Do not read the branch's own `src/`, which is older.

**Read order.** Spec Part B, then its "Fact-check errata", "Phase 2 errata" and "Foundations errata" (later wins), then this brief. §0 below overrides spec §9 wherever the two disagree, because §0 is today's web. When you find another disagreement, follow the web and add a register entry (§6).

**Design skills.** Every stage agent invokes `swiftui-design-skill` and `design-taste-frontend` before designing, and applies §2.10. On any conflict the spec's web-parity copy and native Liquid Glass rules win.

---

## 0. What the tree looks like now, and corrections to the inputs

### 0.1 This branch at `22436463`

**What the foundations give every page** (spec "Foundations errata"):
- `JunoPage(measure: .reading | .wide | .full, scrolling: .page | .content) { header } controls: { … } content: { … }`, `JunoPageHeader(title, lede:) { actions }`, `JunoPageControls { leading } trailing: { … }`, `JunoPageSearchField`, `JunoPageMenu`, `.junoPageColumn()` (`DS/JunoPage.swift`, macOS only).
- `JunoSegmented(options:selection:accessibilityLabel:fills:)` with `Option(value, label, count:, icon:)` (`DS/JunoSegmented.swift`).
- `JunoEmptyState(title:message:icon:actionLabel:action:size: .page | .panel, tone:)` (`DS/JunoEmptyState.swift`, macOS only).
- `JunoConfirmation` + `.junoConfirmation($value)`, `JunoInlineRenameField` (`DS/JunoListActions.swift`).
- The toast host: `@Environment(\.junoToast)`, `.junoToastStatus(id:_:toast:)`, `.junoToastSelection(_:id:)` (`DS/JunoToastHost.swift`).
- `.buttonStyle(.junoProminent)` (`DS/JunoButtonStyles.swift`).
- Every page destination sits in its own `NavigationStack` (`DesktopDestinationView.routed`, `App/DesktopAccountScreens.swift:49-60`), below `ChatDetail`'s one toolbar.

**Already on the template:** Library, Connections and Search.

**Not yet on the template:**
- **Projects.** The detail swaps in place instead of pushing. Sort is a system `Picker` (`App/DesktopProjectsScreen.swift:339`). The tabs are Overview / Workspace / Assistant (`:997-1005`).
- **Artifacts.**
  - The view switch is a system `Picker` (`App/DesktopArtifactsScreen.swift:1325`).
  - The read-only badge is this file's one glass site (glass baseline: 1).
  - Designs wear `.penTool` (`:2037`) instead of `juno.design`.
  - The library page edits the latest version in place (the file header's items 4 and 5).
- **Design.** It has its own page and sidebar row (`App/DesktopDesignScreen.swift`, `DesktopDestination.sidebarCases` at `App/DesktopChatSidebar.swift:884`).
- **Memory.** It lives in `DesktopMemoryScreen` (`App/DesktopAccountScreens.swift:254`): "What Juno remembers", a `Table`, and a privacy strip. Settings embeds the same view (`App/DesktopSettingsScreen.swift:69`).
- **Agents.** These are shared JunoWorkKit views (`WorkKit/Agents/Views/`):
  - New agent is `.bordered` and inherits the column's coral (`NativeAgentsScreen.swift:172-174`).
  - The agent page's tabs are a system `Picker(.segmented)` (`NativeAgentPage.swift:143-148`).
  - Hire has a "Preview a state" segmented picker (`NativeAgentHire.swift:396-401`).

**Gaps and loose ends:**
- **The Library client** decodes only name, type, size and date (`ChatKit/NativeLibraryStore.swift:62-95`). But rename (`PATCH /api/attachments/{id}`), remove (`DELETE /api/library/{id}`), upload (`POST /api/upload`) and file access already exist on `NativeProjectAPIClient` (`ChatKit/NativeProjectAPIClient.swift:84-240`).
- **Automations** exist only inside the legacy Work window: `DesktopWorkAutomationsView` (`App/DesktopWorkAutomations.swift`, used at `App/DesktopWorkWorkspace.swift:351`), over `NativeWorkAutomationModel`.
- **The host tile.** `DesktopWorkHostTile` (`App/DesktopWorkSettings.swift:32`) is drawn in Settings › Code (`App/DesktopSettingsWindow.swift:392-396`, `DesktopCodeSettingsScreen`) and in the legacy Work window (`App/DesktopWorkWorkspace.swift:370`).
- **Skills and Assistants** have no client and no page. The Work window's `DesktopWorkSkillsPage` links to the web.
- **`App/DesktopTasksScreen.swift` is dead:** none of its four types is referenced anywhere. The web's `/tasks` redirects to `/automations`.
- **The hosted design editor bundle is stale.** `npm run design:editor:check` prints "bundle is stale (expected 1.0.0+abf81c88e728)".
- **Gate baselines:** glass 28, targets 291, prominent 9 (Juno Code's own sites), type 0, motion 0.

### 0.2 What `origin/main` changed since this branch forked (Stage A0 merges it)

`origin/main` is four commits past the merge base `e5501f65`: `0c8ac51b`, `6e017696`, `19e40bae` and `fe0a501d` (push notifications, the inbox, native push and approvals, the reflection sweep, the agent voice). They touch the files this phase rewrites.

**Package changes:**
- `JunoCore/Notifications/JunoNotificationRoute.swift` (new): routes `/agents/{id}`, `/chat/{id}` and `/work/{id}`.
- `JunoWorkKit`:
  - `NativeAgentGates.swift` and `Views/NativeWorkGateCards.swift` (new)
  - `NativeWorkClient.snapshot(sessionID:)`
  - `NativeAgentsScreen`, `NativeAgentPage`, `NativeAgentsShared` and `NativeAgentThreadHeader`
- `JunoSync/Push/*`.

**Mac app changes:**
- **An Agents section in the sidebar** (`DesktopChatSidebar.swift`). Its header is `Text("Agents").junoCodeSmall().junoMetaInk()`, which is mono and breaks §10.2 rule 6. The branch's other section headers are `Text("…").textCase(nil)`.
- **`selectedAgentID` threaded through** `DesktopNavigationState` (`.agent(id)`), `DesktopAccountScreens` (`openAgent`) and `NativeAgentsScreen(selectedAgentID:localApprovals:decideLocally:)`.
- **Settings notification rows.** `DesktopSettingsScreen.swift` belongs to Track A; take main's side.
- **Push registration** in `JunoDesktopApp.swift` and `JunoDesktopRootView.swift`.

**Expected conflicts:**
- `DesktopAccountScreens.swift`: the foundations' `routed` `NavigationStack` against main's `openAgent`/agent plumbing.
- `NativeAgentsScreen.swift`: both sides changed how an agent's page is pushed.
- `DesktopChatSidebar.swift`
- `DesktopNavigationState.swift` and its tests
- the generated tokens and contract, which are regenerated rather than hand-merged

### 0.3 Corrections to spec §9 (today's web wins)

| # | Topic | Spec §9 says | Web today (`origin/main`) | Mac does |
|---|---|---|---|---|
| 1 | Sidebar destinations | Library · Projects · Artifacts · Design · Agents (branch) | No Design row. The comment at `app-sidebar.tsx:1216-1224` explains: a design is an artifact of type DESIGN, `/design` redirects to `/artifacts?type=DESIGN`, and `/design/{id}` redirects to `/a/{id}`. | Library · Projects · Artifacts · Agents. `.design` stays decodable and routes to Artifacts › Designs (Stage A). |
| 2 | More menu | Connections, Memory (branch) | Assistants · Skills · Automations, a separator, then "Archived chats" (`app-sidebar.tsx:2090-2101, 2193-2197`). Connections, Permissions and Memory left More for Settings (Connectors, Devices, Memory) and ⌘K. | Web order (Stage C). Connections stays reachable from the composer `+` (`App/DesktopChatWorkspace.swift:1801`) and Memory from Settings › Memory. |
| 3 | Library | Filters "All / Images / Files / On this Mac"; grid is the default | Header: the storage caption "{used} of {quota} used", "Recently deleted" (secondary) and "Upload" (primary). Controls: "Search files", All / Images / Files with counts, the sort (Newest first / Oldest first / Name / Largest first) and **List** / Grid, with List the default. The List has columns Name · Type · Size · Added. The Grid is square tiles, 2 / 3 / 4 columns at 640 / 1024 of page width. Recently deleted is a view with its own title, lede and "Back to files". Deleting a file shows a toast with Undo. | Web shape. There is no "On this Mac" filter; the local document index stays as the page's second half (register #51). |
| 4 | Projects list | "Last Updated, Name, Most Chats", a pin on hover | The same filters plus a trailing "{n} of {m}" count. The header's "New project" is withheld while the page is loading or empty, because the empty state carries it. The tile has a 36pt inset tile (cover or folder), the name at 13 medium, a 2-line instructions preview ("No instructions yet."), and a footer hairline over the chat and file counts and "Updated {ago}". Pin and More appear on hover; the pin stays visible while pinned. | Web shape. The pin is neutral (register #56). |
| 5 | Project detail | Tabs Overview · Tasks · Sources · Settings, a mono lede | Eyebrow "Project"; the name; lede "{n} chats · {n} sources[ · {n} tasks][ · {n} code sessions] · Updated {ago}". Actions: Instructions (outline), a pin toggle, and More (Rename, Add project image / Change image, Remove image, Delete project). Tabs are Overview · Tasks (only when there are any) · Code (only when there are any) · Sources · Settings, with counts. Overview has an inline composer ("Ask anything about {name}…") above "Chats in this project", and a 304pt rail (Instructions, Sources, Memory). Settings has System instructions, "Identity and model", Tools and "Task defaults". | Web shape, pushed onto the stack. Task defaults stay in Phase 5 (§7). |
| 6 | Artifacts: opening | "Opening one routes to its chat and slides in the canvas dock" | A row opens **the artifact's own page** (`/a/{id}`): a design at its latest version is the design editor; everything else, and a design's older versions, is a read-only window with a version pager and "Open in chat". "Open in conversation" (menu) is the chat with the canvas open on the artifact (`/chat/{id}?artifact={identifier}`). | Both, as on the web: Open pushes the artifact page; "Open in Conversation" routes to the chat and slides in `TrailingDock`'s canvas on that row. Editing moves to the canvas (register #53). |
| 7 | Artifacts: New | "New design" (`.bordered`) | The header has "New ▾" (primary), hidden on a first-run empty page. Its menu has a "Design" section with Phone 375 × 812, Tablet 834 × 1194, Desktop 1440 × 900 and Square 1080 × 1080, a separator, and "Ask Juno in a new chat". Choosing a size creates the design and opens it. With the Designs filter on, the four presets are pinned as buttons above the list. `?new=design` opens the menu. | Web shape. Presets come from `DesktopDesignPreset`, whose values `DesktopDesignLauncherTests` pins. |
| 8 | Artifacts: filters | A type segmented control only when there is more than one type | Chips in `HOME_TYPE_ORDER` (Designs, Sites, Components, Code, Documents, Graphics, Diagrams). **Designs always shows**; the others show when they have items. The control shows when there is more than one chip or a filter is on. A filter whose chip has gone reads as All but is remembered (`src/lib/artifacts-home.ts:25-97`). | Web rule, ported and unit-tested. |
| 9 | Memory | "What Juno remembers"; two stat tiles; a Topics / All facts `Table` / Recap switch; a privacy strip | Title "Memory". Header: an On/Off switch and a More menu. Notices, a scope bar (only when a project has its own memory), the one raised surface (the summary, with a prompt dock that drafts natural-language changes), the list by topic or date, and a footer. Your edits and Recap sit in an Activity sheet (`src/components/memory/memory-manager.tsx:34-55`). | Web shape (Stage B). The `Table` goes. |
| 10 | Connections | A "Use in chats" `Toggle` on connected tiles | The switch writes `localStorage["juno:mcp:enabled"]` (`connections/page.tsx:33`), and **nothing in `src/` reads it**. | Omitted: it would be a silent control (§10.2 rule 13). Register #59; owner question §8.2. |
| 11 | Skills | `/slug` in mono, a trust badge, a Trust segmented control in a Form | Reading measure. "Skills" with the lede "Instructions Juno follows for a specific job. Type / in chat to use one." Add ▾ (Import from GitHub…, Write a skill, Create with Juno); a search field with a `/` keycap; sections "Your skills" and "Installed" (sources that expand, with a source switch). The detail has "Use this skill": "Automatically when relevant" / "Only when I call it", Instructions, History, and consent and blocked states. "New skill" is a page. | Web shape (Stage B). |
| 12 | Automations | The editor is a `.page` sheet | "New automation" is a **page** (eyebrow "Automations", back to the list). The detail is the editor, then the fire card, then "Recent runs"; its header actions are "Run now" (outline) and "Delete" (destructive outline). | Pushed pages (Stage C). |
| 13 | Permissions | A grouped Form | A wide page: "Your Macs", "Juno always asks first" (tiles in the warning tone) and "How much it asks otherwise" (three cards, one marked "Default"). The host page is reading-measure with sections headed "What this Mac may do", "What it has offered", "Folders it can reach" and "Apps and sites". Settings › Devices lists the Macs and links to `/permissions`. | Web shape (Stage C). The Settings side is Track A's. |
| 14 | Assistants | A card starts a chat with its `assistantId` | Eyebrow "Assistants", title "Specialists you can reuse". The card pushes `/chat?assistantId=…`, and **nothing reads `assistantId`**: the only hits are this page and the studio. | The card opens the editor. There is no "Start chat" (register #60; owner question §8.1). |
| 15 | Agents | (not in §9) | Roster, agent page and hire are pages: `agents-roster.tsx`, `agent-page.tsx`, `agent-hire.tsx`. | Restyled onto the template (Stage C); iOS keeps its layout. |
| 16 | Document inspector | "`/knowledge/documents/[id]` becomes a Library detail" | It is an orphan: no link anywhere in `src/` reaches it. `/api/library` items carry `knowledge` {state, error, blockCount, pageCount} but **no document id**, and `/api/knowledge/documents` carries no `attachmentId`. | Built as a pushed Library detail that appears only when an item carries a document id (Stage A7). Owner question §8.4. |
| 17 | Pin marks | (none) | Pinned projects and assistants wear `text-primary`, which is coral. | A neutral fill glyph. Fill means on; coral is outside the accent budget (register #56). |
| 18 | Eyebrows | (none) | `AppPageHeader`'s eyebrow is `font-mono text-label`: "Project", "Automations", "Permissions", "Assistants", "Document inspector". There is a back row above the heading. | An SF 13 medium caption in the secondary ink above the title; the back control is the system's (register #57). |

### 0.4 Coordination with Track A (`mac/liquid-glass-chat`, overlays)

Track B owns pages; Track A owns ⌘K, the share popover, menus, sheets, Settings, Quick Entry and the composer. Neither edits the other's files. Track B exposes the following, and the handoff lists what Track A must wire.

| Track B exposes | Where | Track A wires |
|---|---|---|
| `DesktopPageRouter` (`@Observable`, one per app on `JunoDesktopConfiguration`): `open(_ destination:, route: DesktopPageRoute?, artifactsType:)` and `openArtifactInConversation(_:)` | `App/DesktopPageRoute.swift` (new) | ⌘K rows (Design, Skills, Automations, Assistants, Memory, Connections, Permissions); Settings › Devices rows → `.host(id)`; Settings › Connectors "Browse apps" → `.connections`; Settings › Memory "Manage" |
| `NativeSkillLibraryModel.chooseable: [NativeSkillChoice]` (slug, name, description, enabled) and `refresh()` | `WorkKit/Skills/` (new) | the composer's "Use a Skill" and `skillSlug` on `/api/chat` (`src/lib/chat/request.ts:147`) |
| `DesktopWorkHostRow(host:)`, the web's `WorkHostRow` | `App/DesktopPermissionsScreen.swift` | Settings › Devices, then deleting the "Juno Work" section from `DesktopCodeSettingsScreen` (`DesktopSettingsWindow.swift:392-396`) |
| a `shareArtifact: ((NativeArtifact) -> Void)?` hook on the Artifacts page (the menu item is hidden while it is nil) | `App/DesktopAccountScreens.swift` | `DesktopSharePopover(kind: .artifact)` |
| an `openArchivedChats: (() -> Void)?` hook on the sidebar's More (the item is hidden while it is nil) | `App/DesktopChatSidebar.swift` | `DesktopArchivedChatsSheet` |

Track A's Settings keeps calling `DesktopMemoryScreen(model:back:)`, so keep that initializer. If Stage B changes its parameters, change the one call site mechanically and say so in the commit.

---

## 1. Stage plan

| Stage | Contents |
|---|---|
| **A** | A0: merge `origin/main`. A1: `ChatArtifactResolver` follows `resolveArtifactTag` (required). A2: the Design row goes and `.design` routes to Artifacts › Designs. A3: server posters with an SVG-export fallback. A4: Library. A5: Projects (list, the pushed detail with its tabs, the New project sheet). A6: Artifacts (list and grid, filters, New ▾ and presets, the artifact page, the design editor page, Open in Conversation into the canvas dock, menus) plus the design editor bundle rebuild. A7: the document inspector (conditional). |
| **B** | Memory (the web's one calm column, the prompt dock, Activity, Import, Reset). Connections parity. Skills (list, detail, new, import, update sources; a public API for the composer). Assistants (grid and editor). |
| **C** | Automations (ported from `DesktopWorkAutomations.swift`, which is then deleted). Permissions and host pages. Agents (roster, page, hire) on the template. The More menu in the web's order. Deleting `DesktopTasksScreen.swift`. |

**Every stage:**
1. **Builds and tests clean:**
   - the Mac build, with no Swift warnings in files you touched
   - `JunoDesktopTests` (never the UITests target)
   - the iOS build
   - `npm run native:test JunoNativeKit`, plus JunoWorkKit through that package; `JunoAuthTests` alone if the full run hangs
2. **Keeps the gates green:** design tokens, icons, contract, `native:design:check` (which includes prominent), type, motion, glass and targets, plus `capabilities:check` and `work:contract:check`.
   - Glass may only go **down**. When it does, re-record the baseline with `npm run native:design:baseline` and say so.
   - No page file is ever glass-allow-listed.
3. **Renders its page snapshots** into `/tmp/juno-glass-snapshots/phase4-<a|b|c>/`. **Look at every PNG** and fix what is wrong before committing (§2.11).
4. **Scores every screen it built** on the 5-Dimension Review (§2.10). Anything under 7 is fixed before the commit.
5. **Appends to the spec.** Add a "Phase 4 errata" section at the end of `docs/native/MACOS_LIQUID_GLASS_REDESIGN.md` (stage by stage, as Phase 2 did), plus the register entries from §6 that the stage built, with any new ones numbered on from the last.
6. **Updates the handoff.** Add a stage entry to `docs/native/MACOS_REDESIGN_HANDOFF.md`.
7. **Commits on `mac/liquid-glass-pages` only,** with the attribution line. Never push, never deploy. Commit at safe checkpoints (for example after A1–A3, and after A4) as long as the tree is green.

**New or removed app files:** run `native/Scripts/generate-projects.sh`.

**Endpoints the Mac starts calling:** document them in `contracts/openapi/juno-native-v1.yaml` in the file's existing style. They are additive, so `info.version` does not change. Regenerate with `node scripts/generate-native-swift-contract.mjs --output=native/Packages/JunoNativeKit/Sources/JunoAPI/Generated/JunoNativeContract.swift`, and keep `native:contract:check` green.

---

## 2. Rules for every page

### 2.1 Anatomy

**One `JunoPage` per page, measured as the web measures it:**

| Measure | Pages |
|---|---|
| `.wide` | Library, Projects, a project, Artifacts, Connections, Permissions, Assistants, Agents, an agent, hire |
| `.reading` | Memory, Skills, a skill, New skill, an automation, New automation, a host, the document inspector |
| `.full` | the artifact page and the design editor |

The Automations list is `.wide`.

**Header:**
- `JunoPageHeader`: the page's own name, the web's lede, then trailing actions.
  - At most one `.junoProminent`: the web's `Button` with no variant.
  - `.bordered` with `.tint(nil)` for the web's outline and secondary.
  - Destructive outline is `.bordered` with `role: .destructive` and `.tint(Color.junoDestructive)`, the recipe of the selection bar's Delete.
  - Icon-only header buttons are 28pt with a `.help` and an accessibility label.
- **An additive `caption:` parameter** (a new optional argument; call sites are unchanged) draws the web's eyebrow as SF 13 medium in `junoSecondaryInk`, sentence case, above the title (register #57). Detail pages get their back control from the system, never a row of their own.

**The controls row only exists once there is something to filter.** The web withholds it while loading, on an empty page and after a failed load; a no-results state keeps it, because the reader needs the field to clear the search.

**States, in the web's own words, per page:**

| State | How it looks |
|---|---|
| Loading | Skeletons shaped like the final layout (rows, tiles, cards), breathing on `JunoMotion`. No spinners on a page. |
| Empty | `JunoEmptyState(size: .page)` with the page's first action. |
| No results | `size: .panel` with a ghost "Clear filters" or "Clear search". |
| Error | `tone: .error` with "Try again" (neutral bordered) and the web's sentence. |
| Offline | Artifacts' "You’re offline", where the web has it. |

`JunoEmptyState` gains an additive initializer that takes an `@ViewBuilder actions`, for the web's two-action states (Library: Upload files and Go to chat; Artifacts: Start building and New design ▾). It also lets a page-size state carry the page's one `.junoProminent` while the header's copy of it is withheld, as the web does on Projects and Artifacts.

### 2.2 Content and radii

**Content is opaque on the warm canvas. No glass on any page, sheet or popover.**

**Radii:** control 10, field 12, menu 14, card 16, panel 20.
- Tiles and cards: `junoCard`, card radius 16, a 1pt `--border` hairline, and a tonal fill under the pointer. Nothing lifts.
- Inset tiles (the web's `surface-inset`): 36pt, field radius 12, `--secondary` fill, a 16pt glyph in the secondary ink that steps to the foreground on row hover.
- A picture inside a padded card takes the concentric radius (card 16 minus padding).
- Row lists sit in one card with rows divided by `--border` at 70%, not a hairline under every row of a free list.

**Type ladder, at least three rungs per page:**
- `pageTitle` (fluid 26 to 32, `.isHeader`)
- section headings on the `heading` rung (semibold, `.isHeader`)
- 13 medium names
- 13 or 15 body
- 11 secondary meta

**Meta lines** ("Sites · v3 · 2h ago", "2 chats · 3 sources · Updated 1d ago") are SF with tabular digits, not mono (registers #40 and #58). Mono is only for code, ids, bare counts in a segment, costs and durations.

**Motion:**
- Rows and tiles are dealt once on first load: the rise-in on `JunoMotion`, a 45ms stagger capped at 10 items.
- Switching views does not replay the deal.
- Thumbnails and posters cross-fade in on the fast duration.
- Under Reduce Motion, everything appears in place.
- Nothing loops except real live state (a creating preset's mark, an uploading row's progress).

### 2.3 Menus and actions

**One definition per row of what you can do to it**, used by both the hover `ph.dotsthree` button and the row's `.contextMenu`, as the web's `renderActions`.
- The hover button is a 28pt borderless icon with `.menuStyle(.button)`, revealed on hover or focus, and kept showing while its menu is open.
- Menus are Title Case with the web's words: "Open in Conversation", "Download Source…", "Rename…", "Delete…". An ellipsis marks an item that asks for more.
- Destructive items sit last, after a divider, with `role: .destructive`.

**Destructive actions** go through `.junoConfirmation` with the web's title and sentence. The one exception is Library delete, which is optimistic with an Undo toast, as the web does.

**Rename** is a small sheet with the web's dialog copy, shared through a new `DS/JunoRenameSheet.swift`:
- title, one sentence, the field, "Cancel" on `.cancelAction`, and the confirm as `.junoProminent` on `.defaultAction`
- the confirm is disabled while the trimmed name is empty or unchanged
- used for projects, artifacts, library files and skills

The sidebar keeps `JunoInlineRenameField`.

### 2.4 Sheets

- The system presents sheets. There is no custom background, no glass and no `junoSheetSurface`.
- Content is a grouped `Form` or plain stacks, with an explicit `.frame` (crash rule 2).
- Buttons are Title Case ("Create Project", "Save Changes").
- There is one `.junoProminent` per sheet; Cancel is `.cancelAction`.

### 2.5 Routing

Add `App/DesktopPageRoute.swift`:

```swift
enum DesktopPageRoute: Hashable, Codable {
    case project(String)
    case artifact(String, version: Int?)
    case document(String)                 // Library › document inspector (A7)
    case skill(String), newSkill
    case automation(String), newAutomation
    case host(String)
    case agent(String), newAgent(template: String?)
}
```

**The stack:**
- `DesktopDestinationView.routed` becomes `NavigationStack(path: $path)` with **one** `.navigationDestination(for: DesktopPageRoute.self)` at the stack root, never inside a lazy container.
- `path` is `@State` in `DesktopDestinationView`. The existing `.id(destination)` already gives each destination a fresh stack.

**How pages push:** through an environment action, `@Entry var desktopPush: (DesktopPageRoute) -> Void`, or a `NavigationLink(value:)`.

**`DesktopPageRouter`** carries requests from outside the window (the sidebar's pinned projects and agent rows, notification routes, Settings, ⌘K):
- as `pending: DesktopPageRequest?`, applied by the Chat window and then cleared
- together with an Artifacts type filter where one is asked for

**Specific routes:**
- **The pinned-project sidebar rows** (`requestedProjectID`) push `.project(id)` instead of swapping the page.
- **Main's `selectedAgentID`** (the sidebar agent rows, `JunoNotificationRoute.agent`) becomes `path = [.agent(id)]` on `.agents`.

**Crash rules (spec §0.5) hold throughout:**
- one `NavigationSplitView`
- explicit popover frames
- no toolbar items or `.searchable` from any page
- no `.inspector`

### 2.6 Copy

- **Content is the web's copy verbatim:** curly quotes, the ellipsis character `…`, and the web's own sentences in toasts and errors.
- **Native menus and sheet buttons** change only capitalisation.
- **No uppercase anywhere.**
- **New Mac-only strings** use no em dashes, no cute phrasing, and are listed in the stage's report with a self-audit line each.

### 2.7 Accessibility

- `.isHeader` on page titles and section headings.
- Every icon-only control has a label and a `.help`.
- Status is paired with a word, never colour alone (Differentiate Without Color).
- Keyboard:
  - Return opens the focused row.
  - Space opens Quick Look in the Library.
  - Esc clears a page search.
  - `/` focuses the Skills search.
  - No ⌘⌫ on Delete (fact-check errata).
- `junoTertiaryInk` only on non-essential text of 13pt or more.
- Button and form text at WCAG AA or better in both appearances.

### 2.8 Errors and toasts

- Post to the window's host through `@Environment(\.junoToast)`, with the web's sentences ("Couldn’t delete the artifact.", "Project deleted.").
- Never draw a per-page toast or failure box.
- Standing conditions (a failed refresh, a pending sync) use `.junoToastStatus`.

### 2.9 Icons

Use `JunoIcon` cases only. Add any missing Phosphor glyph with `scripts/generate-native-icons.mjs` from the web's registries (`src/lib/app-icons.ts` and the page's own imports), then run `npm run native:icons` and `native:icons:check`.

Likely additions:
- Stage A: `ph.devicemobile`, `ph.devicetablet` (for the design presets) and `ph.squaresfour`, if absent.
- Stage B: `ph.githublogo` (for "Import from GitHub"), if the web's `GitHubMark` has no Phosphor source. If it is a hand-drawn brand mark, carry it as a `juno.` glyph from its web path, as `juno.agents` was.
- Stage C: nothing expected.

Existing mappings to reuse:

| Case | Symbol |
|---|---|
| `.assistants` | `ph.robot` |
| `.skills` | `ph.scroll` |
| `.automations` | `ph.treestructure` |
| `.permissions` | `ph.shieldcheck` |
| `.list` / `.grid` | `ph.listbullets` / `ph.squaresfour` |
| `.monitor` | `ph.monitor` |

Check each against the web's `AppIcons`.

### 2.10 Design review, taste checks and the signature detail

**The 5-Dimension Review (`swiftui-design-skill`).** For every screen and state the stage built, score these from the light and dark PNGs:
1. Philosophy
2. Hierarchy
3. Craft
4. Functionality
5. Originality

Put the table in the stage's final answer:

| Screen | Phil. | Hier. | Craft | Func. | Orig. | Signature | Fixed before commit |
|---|---|---|---|---|---|---|---|

Anything under 7 is fixed, re-rendered and re-scored.

**What the checks mean here:**
- **Philosophy** is warm minimal: the web's calm pages, with one raised surface where the web has one.
- **Hierarchy:**
  - the title is the largest text
  - there is one primary action
  - the eye reads title, then controls, then content
- **Craft:**
  - spacing on 4/8 (the web's 20/24/32 page rhythm)
  - one radius system
  - concentric insets
  - no orphans in titles
- **Functionality:**
  - loading, empty, error and no-results states all exist
  - pointer targets are 28pt
  - back goes back
- **Originality:** the signature detail below, and none of the anti-slop patterns.

**Taste checks** (`design-taste-frontend`, the parts that fit a native app):
- **One accent, locked.** Coral appears only on:
  - the send/stop disc
  - switches
  - links and accent text
  - the live dot
  - one prominent button per surface

  Never on a pin, a hover glyph, a chip or a selection.
- **One radius system:** control 10 / field 12 / menu 14 / card 16 / panel 20.
- **Full loading, empty and error states on every page.**
- **Contrast:** buttons, fields, placeholders, helper and error text all at WCAG AA or better.
- **Dots only for real state.** No decorative status dots. A dot is allowed only for real live state (a Mac awake, an agent waiting), and paired with a word.
- **No labels posing as design:** no eyebrows beyond the web's own captions (drawn as SF captions), no section numbers, no uppercase or mono micro-labels.
- **No fake-precise numbers.** Fixture data in the preview world is plausible and labelled preview data. Numbers shown in UI come from the server.
- **A copy self-audit of every visible Mac-only string.**

The landing-page rules (hero, bento, marquee, GSAP, Tailwind) do not apply.

**One signature detail per screen**, at 120% effort:

| Screen | Signature |
|---|---|
| Library | The drop veil: dragging files anywhere over the page shows an opaque veil saying "Drop to upload". Rows appear in place with their progress, and a finished upload settles into the list without a reload. |
| Projects | A pinned project keeps its fill pin visible while every other tile's actions wait for the pointer. A cover picture replaces the folder glyph in the tile's inset. |
| A project | The Overview rail's top edge sits level with the inline field. Instructions, Sources and Memory are the first things beside what you type. |
| Artifacts | Designs show as their posters, in the grid and in the list's 36pt inset. With the Designs filter on, the four preset buttons each draw their own aspect rectangle, and the plus hands over to the `juno.design` mark while that design is being made. |
| The artifact page | The version pager ‹ v2 of 3 › with "Back to latest" when you are behind. |
| Memory | The summary and its prompt dock: "Tell Juno what to remember, change or forget" drafts a change that appears as a small diff right under the field, with Apply and Discard. |
| Connections | "Finishing connection…" settles into Connected when the browser hand-off comes back. |
| Skills | The `/` keycap in the search field, which fades while you type; `/` focuses the field from anywhere on the page. |
| Assistants | The editor's live preview, where the name and starters appear as you type them. |
| Automations | The fire card's plain sentence about the next run, between the form and the history. |
| Permissions | "Juno always asks first" as calm tiles, each with the shield in the warning tone. |
| Agents | Main's agent faces, unchanged, as the page's one piece of character. |

### 2.11 Snapshots

**The suite:** `Tests/Snapshots/PageSnapshotTests.swift` (suite `PageSnapshotTests`, fixtures `PageFixtures`), following `FoundationSnapshotTests`.
- It writes `$JUNO_SNAPSHOT_DIR/pages/<name>-<light|dark>.png` through `TranscriptSnapshotRenderer`.
- It uses `FoundationFixtures.page(…)` for window compositions beside the sidebar.

**The data:**
- Page data comes from the preview world. Canned responses for every new endpoint go in `JunoPreviewSupport/PreviewSender.swift`, with the JSON bodies in `PreviewFixtures`.
- Designs use the existing `art-design` SVG fixture as the poster body.

**The render command:**
- Run with `TEST_RUNNER_JUNO_SNAPSHOT_DIR=/tmp/juno-glass-snapshots/phase4-<stage> … -only-testing:JunoDesktopTests/PageSnapshotTests test`.
- Also re-render the final set with `TEST_RUNNER_JUNO_FINAL_SNAPSHOT_DIR=/tmp/juno-glass-snapshots/phase4-<stage>/final`.

**Widths:**
- Window compositions at 1240 × 800.
- Page-only renders at 936, plus 560 for the "narrow" fixtures.
- Every fixture in light and dark.

Menus and glass cannot be drawn offscreen, so say what stands in for them. Open every PNG with the Read tool.

### 2.12 Tests

The unit tests each stage owes are in its section. A stage that adds a client adds three kinds of test:
- **Decoding:** tolerant of unknown fields, and of a server a step ahead.
- **Encoding:** paths, query and body.
- **Failure:** 401 goes through the auth coordinator; 4xx returns the server's sentence; 5xx returns the generic sentence.

Put them in the package's test target, matching existing client tests (for example `NativeWorkConversationTests`).

---

## 3. Stage A: Library, Projects, Artifacts and Design

### A0. Merge `origin/main`

1. `git fetch origin`, then `git merge origin/main` (at least `fe0a501d`) on `mac/liquid-glass-pages`.
2. **Regenerate, don't hand-merge:**
   - `npm run design:tokens`
   - `npm run native:icons`
   - the Swift contract (§1)
   - `native/Scripts/generate-projects.sh`
3. **Resolve the conflicts** listed in §0.2:
   - Keep the foundations' page stack. Wire main's `selectedAgentID` through `DesktopPageRoute.agent` (§2.5) only in Stage C. For now, take main's `NativeAgentsScreen(selectedAgentID:…)` as it is and keep it compiling inside the page's `NavigationStack`.
   - Change main's sidebar Agents header to `Text("Agents").textCase(nil)`.
4. Build and test everything, then commit the merge alone with a body that lists the resolutions.

Do not merge `mac/liquid-glass-chat`.

### A1. `ChatArtifactResolver` follows `resolveArtifactTag` (required)

**The web's rule** (`src/lib/chat-client-state.ts:103-122`) runs in this order:
1. **Build the candidates:** the row whose identifier is exactly the tag's identifier, plus every row whose identifier starts with `"{identifier}~"`. These are the rows M11 retired to `{identifier}~{last 6 of id}` (`src/lib/artifacts-store.ts:69-71`).
2. **With no retired rows,** use the exact row, or nil.
3. **With exactly one candidate,** use it.
4. **Otherwise prefer the message's own:** the candidate whose `messageId` equals the tag's message id.
5. **Otherwise take the newest candidate with `createdAt` ≤ the message's `createdAt`,** or the oldest candidate when none qualifies.
6. **Open the row by its own identifier** (`message-item.tsx:1365-1379`: `onOpenArtifact(artifact.identifier)`).

**In `ChatKit/ChatArtifactResolver.swift`:**
- Key rows by their own identifier. Retired rows are naturally separate keys. Drop the "one further along wins" merge only for rows that genuinely share an identifier: a streamed row beside its synced self, same id.
- Change the public API to `artifact(for reference:, messageID:, messageCreatedAt:) -> NativeArtifact?` and `card(for:message:messageIsPending:)`, taking `NativeChatMessage` or `(id, createdAt)`. The prefix test is `hasPrefix(identifier + "~")`, never a bare prefix.
- **Ties:** two candidates can be the message's own (one message emitted both types). Take the oldest by `createdAt`, then by `id`, and pin that in a test. Sort by `(createdAt, id)` for determinism.
- **The streaming placeholder** uses its local `createdAt`.

**Call sites:**
- `App/MessageRow.swift:705` passes the message.
- `App/DesktopChatWorkspace.swift`: `DesktopChatArtifact` carries the resolved row's `id`, and `open(artifact:)` (`:1601-1609`) stores it.
- `dockPanel` (`:1308-1313`) reads the row back **by id** from the artifact store, not by re-resolving the tag's identifier. Otherwise a type change would swap the open canvas to the new row. It falls back to tag resolution, with the message context kept on `DesktopChatArtifact`, only when no row existed at open time.
- `ChatArtifactCard.isUpdated` stays `stored.messageID != messageID`. A tag resolved to a row its own message created is not "Updated".

**Tests.** Add `ChatArtifactResolverTests`, extending the existing class in `ChatKitTests/NativeArtifactRuntimeTests.swift:317`:
1. No retired rows: the exact row, and nil when absent.
2. One retired candidate with no current row: that candidate.
3. The message's own candidate beats a newer one.
4. No own candidate: the newest with `createdAt` ≤ the message's.
5. None qualify: the oldest.
6. Rows from another conversation are ignored.
7. `"chart"` does not match `"chart-2~abc123"`, and does match `"chart~abc123"`.
8. The card's `stored.identifier` is the retired handle when that row wins, and opening uses it.
9. `isUpdated` is false for a row the message created.
10. The two-own-candidates tie-break.

Plus one App test (`DesktopChatDesignSourceTests` or a new file): the dock follows the row id after the tag's identifier moves to a new row.

iOS is left alone. `JunoMobileConversationsView.storedArtifact(for:)` (`:631-648`) matches by identifier across every conversation; it is a follow-up in §7.

### A2. The Design row goes; `.design` routes to Artifacts › Designs

**The enum:**
- `DesktopDestination.sidebarCases` becomes `[.library, .projects, .artifacts, .agents]`, the web's order.
- `.design` stays a case with raw value `"design"`: stored window state, `DesktopWorkWorkspace.swift:335` (`leaveForChat(.design)`) and any caller keep working.

**Normalising.** Add `DesktopNavigationState.normalized(_:)` and apply it in `destination(fromStored:)` and wherever a destination is set. It maps `.design` to `.artifacts` with the Designs filter:
- **The filter** is carried by `DesktopPageRouter`, or a `@SceneStorage("artifacts.type")` the Artifacts page reads, set to `DESIGN`.
- **The sidebar** shows Artifacts selected.
- **The New menu** opens when the request asks for it (the web's `?new=design`).

**The Design screen goes.** Delete `App/DesktopDesignScreen.swift` after moving the parts that stay:
- `DesktopDesignPreset` and `DesktopDesignStartClient` move, with the same names, to `App/ArtifactDesignStart.swift`.
- The editor document and its command bar become the design case of the artifact page (A6).
- The preset tile becomes A6's pinned preset button.

**Tests** in `DesktopNavigationStateTests`:
- stored `"design"` resolves to Artifacts with Designs
- the sidebar cases hold no `.design`
- `.design`'s raw value round-trips

`DesktopDesignLauncherTests` keeps passing unchanged.

### A3. Designs as server posters

**The request.** `NativeDesignPreviewLoader` (`ChatKit/NativeDesignPreviewLoader.swift`) asks for the poster first: `GET /api/artifacts/{id}/poster?v={version}&r=1`, with `accept: image/svg+xml`, as the owner.
- `r` is the web's `POSTER_RENDERER` (`src/lib/design/poster-url.ts:46`).
- Keep `r=1` as `static let posterRenderer = 1`, with a comment to bump it with the web's.

**The cache.** A poster is cached like today's SVG, at `…/DesignPreviews/<account>/<id>-v<n>-r1.svg`.
- **A sealed version** (`v` below the row's `currentVersion`) is immutable: read it from the cache forever.
- **The current version** revalidates. The server folds edits into it (`poster/route.ts` "CACHING"), so store the `ETag` beside the file. On the first load of that version per loader lifetime, send `If-None-Match`; a 304 keeps the cached file.
- `loadDesignPreview` gains `isCurrent: Bool` (default false), passed from the stored row.

**Falling back to the SVG export** (`GET /api/design/{id}/export?format=svg`, today's path, cached under its old file name):
- **A 404 with a JSON body** means the route answered "not a readable design of yours". Try the export once, as the owner asked, and remember the outcome.
- **A 404 that is not JSON** (an older server with no route) sets `posterRouteMissing` for the loader's lifetime, and every later design goes straight to the export.
- **401 and 429** go to `.failed` and are retried on the next appearance, as today.
- **Other 4xx and 5xx, or an answer over `maximumBytes`**, go to `.unavailable`.

**The same loader draws all three places:** the transcript card (`App/InlineDesignPreview.swift`), the canvas dock's older-version picture, and every Artifacts tile or inset (A6). Sign-out purges it as today.

**Tests** (`NativeDesignPreviewLoaderTests`):
- the poster path, query and accept header
- sealed versions are never re-requested
- the current version sends `If-None-Match`, and 304 keeps the cache
- JSON 404 falls back to export
- HTML 404 falls back to export and sets the memo, so the next design skips the poster
- the export's 422 gives `.unavailable`
- 401 and 429 give `.failed`
- the cache file names

### A4. Library

**The client** (`ChatKit/NativeLibraryStore.swift`, `NativeLibraryClient` / `NativeLibraryModel`):
- **The request:** `GET /api/library?q=&kind=IMAGE|FILE&sort=newest|oldest|name|size&includeDeleted=true&cursor=`, as `src/components/library/use-library.ts:40-48` builds it.
- **Decode tolerantly** `items[]`:
  - id, kind, fileName, mimeType, size, url, createdAt
  - conversationId, version, versionCount, origin, parserState, deletedAt
  - inUse / keptIn (`chat` / `project`)
  - knowledge {state, error, blockCount, pageCount}, plus an optional `documentId` (A7)
- **Also decode** `nextCursor`, and on the first page `counts` {all, IMAGE, FILE}, `total` and `storage` {usedBytes, quotaBytes, remainingBytes}.
- **Actions:**
  - rename: `PATCH /api/attachments/{id}` {fileName}, reusing `NativeProjectAPIClient.renameFile`
  - remove: `DELETE /api/library/{id}` → {mode, keptIn}
  - restore: `POST /api/attachments/{id}/restore`, where 404 means "already restored" and is not a failure
  - versions: `GET /api/attachments/{id}/versions` and `POST /api/attachments/{id}/versions/{v}/restore`
  - upload: `POST /api/upload`, the existing client, with per-file progress
  - download and Quick Look: the Phase 2 media loader and caches
- **The model** holds the query, the debounced search (200ms), the pages ("Load more" plus a near-end auto-load) and optimistic removal with Undo.

**The page** (`App/DesktopLibraryScreen.swift`, rewritten on the template):

*Header:*
- "Library" with the lede "Everything you upload or share in chats."
- Trailing:
  - the storage caption "{used} of {quota} used" in SF 13 tabular secondary, hidden below 640pt
  - "Recently deleted" (`.bordered`, `ph.trash`)
  - "Upload" (`.junoProminent`, `ph.uploadsimple`)
  - a 28pt `ph.dotsthree` More holding the Mac extras: "Add Document…" (the local index, ⇧⌘I) and "Refresh" (⌘R)
- **The Recently deleted view** swaps the header to "Recently deleted", the lede "Files you remove land here and can be restored. Chats and projects keep the ones they use.", and "Back to files" (`.bordered`, `ph.arrowleft`).

*Controls:* the search field ("Search files", a spinner while a query is in flight), All / Images / Files with counts, the sort menu (Newest first / Oldest first / Name / Largest first), and List / Grid (remembered, **List by default**). In Grid, add "Select all" / "Clear selection".

*Views:*

| View | Layout |
|---|---|
| List | A `Table` inside a radius-16 card. Columns: Name (the name at 13 medium, then one caption line: "Still in chat" or "Still in project" when kept, else the index status "Indexing for search…", "This file could not be indexed." or "Only part of this file could be indexed.", else "Open source chat"), Type (the web's `typeLabel`, from 768), Size, Added, and the row's More. Multi-select with ⌘ and ⇧. |
| Grid | Square tiles, 2 / 3 / 4 columns at 640 / 1024. Images show the picture; files show their first page (the Phase 2 page picture), with the name and meta under it. |

*Row actions*, one definition for the More button and the context menu:
- Rename… (Restore in the deleted view)
- Versions… (when `versionCount` > 0)
- Download…
- Open Source Chat
- Mac extras: Quick Look, and Edit Image… for images, as today
- a divider, then Delete (hidden in the deleted view)

*Other behaviour:*
- **Opening:** double-click or Space opens Quick Look. Files still drag out.
- **Selection** raises the selection bar (`.junoToastSelection`): "N selected", then Rename (when there is one and it is not deleted), Restore or Delete (destructive outline), and clear. Keep the Mac extra "Copy Names".
- **Delete** is optimistic. The toast carries the web's `removalNotice` title and description (`REMOVAL_COPY` in `src/components/library/library-types.ts`) and Undo for the web's `UNDO_MS`. A failure posts "Couldn’t delete that file." or "Couldn’t delete some of those files."; a failed Undo posts "Couldn’t undo. The files are in Recently deleted."
- **Upload** comes from the header button (an `NSOpenPanel`, multiple, with the web's `ACCEPT_ATTRIBUTE` types from `src/lib/uploads.ts`) or a drop anywhere on the page (the signature veil; not in the deleted view).
  - Uploading rows show progress, Retry and Dismiss.
  - A finished upload hidden by the filters posts "Uploaded. Your filters are hiding it." with Show.

*Versions* is a sheet ("Versions"):
- a list with "Current" marked and Restore on the others
- the footnote "Restoring an earlier version keeps the current one."
- the empty state "No earlier versions" / "When this file is replaced, the earlier version is kept here."
- the toast "Version restored" or "Couldn’t restore that version."

*States:*
- **Error:** "Couldn’t load your files" / "Check your connection and try again." with Try again.
- **Empty:** "No files yet" / "Upload files here, or drop them anywhere on this page. Files you share in chats are kept here too.", with Upload files (prominent) and Go to chat (ghost).
- **Empty deleted view:** "Nothing in Recently deleted" with Back to files.
- **No results:** "No matching files" / "Try another name, or clear the filter." with Clear filters.

**The local index half** (Add Document…, passages) stays below the list as it is, restyled to the page's rhythm.

**Tests:** query encoding, tolerant decoding (with and without `counts`/`storage`, unknown `kind`), paging, optimistic delete and Undo ordering (Undo waits for the delete to land, as the web's does), restore-404 is not a failure, and version restore.

### A5. Projects

**The list** (`App/DesktopProjectsScreen.swift`, split into `DesktopProjectsScreen.swift` for the list and `DesktopProjectPage.swift` for the detail):

*Header:* "Projects" with the lede "A topic’s chats, instructions, and files, kept together." and "New project" (`.junoProminent`, `ph.plus`), withheld while loading or empty.

*Controls:* "Search projects…", All / Pinned with counts, the sort menu (Last updated / Name / Most chats), and a trailing "{n} of {m}" in SF tabular.

*The grid:* 1 / 2 / 3 columns at 640 / 1024 of page width, 16pt gaps, each tile per §0.3 #4:
- cover picture or `ph.folder` in the 36pt inset
- name
- 2 lines of instructions
- a footer: `ph.chats` count, `ph.filetext` count, "Updated {ago}"
- a neutral pin toggle, visible while pinned
- More: Pin/Unpin, Rename…, a divider, Delete…

The whole tile opens the project.

*The cover* is the project's file named `__cover__` (`src/app/api/projects/route.ts:18`), read through `NativeProjectAPIClient.accessFile`. It is never listed as a source, and the file count excludes it.

*States:*
- **Empty:** "No projects yet" / "Create one to keep a topic’s chats, instructions, and files together." with "New project" as the page's one prominent.
- **No results:** "No matching projects", with "Pin a project to see it here." or "Try another search term.", and Clear filters.
- **Error:** "Couldn’t load your projects" / "Check your connection and try once more."

*Toasts:* "Project deleted.", "Couldn’t update project pin.", "Couldn’t rename project.", "Couldn’t delete project."

**The New project sheet** (the existing `DesktopNewProjectSheet`, restyled per §2.4):
- title "New project" and the sentence "Name it, or leave it blank and Juno will name it from your first chat."
- the field label "Project name (optional)" with the placeholder "Leave blank to auto-name it"
- "Cancel" and "Create Project"

Rename uses `JunoRenameSheet` ("Rename project" / "Change the name of this project." / "Project name" / "Rename Project"). Delete confirms "Delete this project?" / "Its chats are kept (just unlinked), but the project’s instructions and files are removed. This can’t be undone." with "Delete Project".

**The detail page** (`.project(id)`, pushed, `.wide`):

*Header:*
- caption "Project", the name (truncating), and the lede "{n} chats · {n} sources[ · {n} tasks][ · {n} code sessions] · Updated {ago}" in SF 13 tabular secondary
- actions: "Instructions" (`.bordered`, `ph.notepencil`, which opens the instructions sheet), the pin toggle (28pt; help "Pin project" or "Unpin project"), and More (Rename…, Add Project Image… or Change Image…, Remove Image, a divider, Delete Project…)

*Tabs:* `JunoSegmented`, not filling: Overview, Tasks n (only when sessions exist), Code n (only when code conversations exist), Sources n, Settings.
- Tasks read `NativeWorkModel` / `NativeWorkClient.sessions(projectID:)` from the Phase 5 slice.
- Code conversations are told apart by the conversation's `kind` from `NativeConversationModel`. If the project snapshot cannot tell, leave Code out and note it (§7).
- The chosen tab is remembered per project.

*Overview:* two columns from 896pt of page width, a stacked column below it.
- **Left:**
  - An **opaque composer-shaped field** (`junoCard`, the panel radius 20, a hairline, not glass) with the placeholder "Ask anything about {name}…" ("Ask anything about this project…" past 32 characters) and a send disc. Return starts a new chat in the project: `draftProjectID`, `.chat`, and a `ChatComposerRequest.Kind.send` with the text, the follow-up chips' path, so it sends at once as the web does. If the draft's composer cannot take a send request before it appears, prefill it, focus it and note that (register #69).
  - Then the section "Chats in this project" (a heading, not an eyebrow): a "Search chats…" field, and Pinned and Recent rows. Each row has a title, a relative time, and a pin and More on hover (Pin Chat/Unpin Chat, Move to Project ▸, a divider, Delete…).
  - Empty: "No chats in this project yet" / "Start one above. Juno reads the project’s instructions and files first."
  - Toasts: "Chat starred." / "Chat unstarred." / "Chat moved to {name}." / "Chat deleted."
- **Right (a 304pt rail):**
  - the cover, when there is one
  - Instructions: the first lines, with an "Edit instructions" icon button; empty: "A prompt Juno follows in every chat, task and code session filed here."
  - Sources: up to five files, with "Add a file" and the view-all link; empty: "PDFs, documents and data Juno reads before answering here."
  - Memory: "Manage memory" opens the Memory page with this project's scope in Stage B, and Memory as it is before then; empty: "What Juno learns in this project’s chats stays here. Your other chats never see it."

*Tasks:*
- rows for the project's work sessions, each opening its conversation (the session's `conversationID`)
- search "Search work…"
- empty "No delegated work yet" / "Delegate long-running goals and automations; they run with this project’s context."

*Sources:*
- "Search files and artifacts…" with All / Files / Artifacts
- a drop well: "Drop files here, or click to browse" / "Upload files" / "Drop to add to this project"
- file rows with Download and Remove, and artifact rows opening `.artifact(id)`
- empties: "No files yet" / "Add PDFs, documents, code or data to ground every answer in this project.", and "No artifacts yet" / "Artifacts Juno builds in this project’s chats will collect here."
- The web's index labels (Indexed, Partly indexed…) only if the project file entity carries `parserState`; otherwise §7.

*Settings* is cards, each with its own Save (`.junoProminent`, disabled until dirty; one per card, spec §0.4):
- **"System instructions":** "Prepended to every chat, work run, and code session in this project." A mono `TextEditor` (the instructions are the user's own text), "{n} chars" in SF tabular with the warning line near the limit, "Updated {ago}", "Full editor" (`.bordered`) and Save. The toasts are "Project instructions saved." and "Couldn’t save. Your text is still here, so check your connection and try again."
- **"Identity and model":** "What Juno is called here, and which model answers by default." Persona name (placeholder: the project's name) and Preferred model ("Account default" plus chat models), over the existing `ProjectWorkspaceModel`.
- **"Tools":** "Narrow what Juno may reach for while answering here." A switch ("Restrict assistant tools") that unfolds the tool switches (`WORKSPACE_TOOLS` and their labels from `src/lib/projects/workspace-config.ts`), and "Restrictions narrow what is available while Juno generates in this project. They do not disconnect anything."
- The web's card headings are mono eyebrows; here they are the `heading` rung.
- Task defaults are Phase 5 (§7).

*The instructions sheet* is the existing `DesktopProjectInstructionsSheet`. Restyle it, and give it the web's discard confirmation: "Discard your changes?"

*Remove:* the Overview / Workspace / Assistant tabs, `DesktopProjectPlaceholder` if it becomes unused, and the in-place detail swap.

**Tests:** list filtering and sorting (Last updated, Name, Most chats), the cover file excluded from counts and sources, tab visibility rules, and "{n} of {m}".

### A6. Artifacts and Design

**The list** (`App/DesktopArtifactsScreen.swift`, rewritten; `App/ArtifactPage.swift` new):

*Header:* "Artifacts" with the lede "Designs, sites, documents, diagrams and code made with Juno."
- Trailing: "{n} artifacts" (SF 13 tabular secondary, hidden while loading, empty or errored) and "New ▾" (`.junoProminent` `Menu`, `ph.plus`, hidden on a first-run empty page).
- **The New menu:** a `Section("Design")` holding Phone / Tablet / Desktop / Square with `ph.devicemobile` / `ph.devicetablet` / `ph.monitor` / `ph.square`, each with its size as the item's subtitle (register #63). Then a divider and "Ask Juno in a New Chat" (`ph.chats`).
- **While a design is being made,** the button shows its spinner and every preset is disabled. On success, push `.artifact(newID)`. On failure, toast the route's words or "Couldn’t start a design."

*Controls* (only when there are items):
- "Search artifacts…", matching title, conversation title and runtime label, as the web does
- the type control (§0.3 #8, labels from `TYPE_LABELS`, with counts)
- List / Grid on the trailing side (remembered as `artifacts.view`, List by default)

**With the Designs filter on,** the four presets are pinned above the list as buttons: 2 across, 4 from 640.
- Each button has a leading plus that swaps to `juno.design` while that preset is being made (a state swap; that mark breathes, the one allowed loop).
- The label is at 13 medium, the size in SF 11 tabular, and the preset's aspect rectangle is drawn.
- The glyph stays neutral on hover (register #64).

*List rows* (inside one card, rows on 70% dividers):
- the 36pt inset: the **poster** for a design (A3, fitted with 4pt of padding, falling back to `juno.design`), else the kind glyph from the web's `ICONS` map
- the title (13 medium, "Untitled artifact" when empty)
- 'in “{conversation title}”' at 11 secondary
- trailing meta "{runtime} · v{n} (from 2) · {ago}", hidden below 640
- the More button on hover

*Grid tiles:* `minmax(240, 1fr)` with 12pt gaps; a card with 8pt padding; a 4:3 preview at radius 8 (concentric), holding the poster for a design and the existing live thumbnail (`.thumbnail` policy) otherwise; then the title and the same meta, led by the kind glyph at 12pt.

*Opening:* a click on the name, a double-click on the row, or Return pushes `.artifact(id)`.

*Actions:*
- Open
- Open in Conversation
- a divider
- Rename… ("Rename artifact" / "The new name shows everywhere this artifact appears." / "Rename")
- Download Source… (the save panel, named `{identifier}.{ext}` per the web's `DOWNLOAD_EXTENSIONS` / `extensionForLanguage`)
- Share… (only while the Track A hook exists)
- a divider, then Delete…
- a Mac extras group: Open in New Window, Copy Source

*Delete* confirms "Delete “{title}”?" / "Every version is removed and any public share link stops working. The conversation it came from is untouched." with "Delete". The toasts are "Artifact deleted.", "Couldn’t delete the artifact.", "Couldn’t rename the artifact." and "Couldn’t download the source."

*States:*
- **Error:** "Couldn’t load your artifacts" / "Something went wrong on the way here.", or offline "You’re offline" / "Your artifacts will load again the moment the connection returns.", with Try again.
- **Designs empty:** "No designs yet" / "Pick a size above to start one, or ask Juno in any chat to design a screen." (panel size).
- **First-run empty:** "Nothing here yet" / "Ask Juno to build a page, component, document or diagram, or start a design from a blank frame. Each one collects here.", with "Start building" (prominent) and "New design ▾" (bordered menu).
- **No results:** "No matching artifacts" / "Nothing fits “{q}”." (or "these filters") with Clear filters.

*Remove:* the system view `Picker`, the glass read-only badge (glass 28 → 27, then re-record the baseline), and `.penTool` for designs (use `juno.design`).

**Open in Conversation** calls `DesktopPageRouter.openArtifactInConversation(row)`: it selects the row's conversation, sets `.chat`, and opens `TrailingDock`'s canvas on **that row by id**, the A1 plumbing.

**The artifact page** (`.artifact(id, version:)`, `.full`):

*A design at its latest version* is the design editor. Move `DesktopDesignScreen`'s document view and command bar here (Discard, Save, "Delete design"), hosted by `DesktopDesignEditorHost`.

*Everything else, and a design's older versions,* is the read-only window:
- **The top row**, in content, not in the toolbar:
  - the title (help "{noun} · {title}")
  - the version pager ‹ v{n} of {m} › (24pt arrows, the count in mono)
  - "Back to latest" (link style) when behind
  - "Open in Chat" (`.bordered`; help "Open in the conversation it was made in")
  - a More: Download Source…, Copy Source, Open in New Window, Compare Versions… (the existing diff, as a sheet)
- **The body:**
  - HTML, React and the rest draw through the `.inline` runtime (closed sandbox, register #21)
  - Markdown draws in the reading prose style
  - an older design draws its poster; when the poster cannot draw: "This version can’t be drawn here. Its document is unchanged."
- **Editing is not offered here.** The web's window is read-only and "the chat is where it is changed", so the page's "Open in Chat" is the way to edit (register #53). Delete the in-page editor, draft state and read-only badge from the old screen.

**Rebuild the hosted design editor:**
1. `npm run design:editor`, then `npm run design:editor:check`, after A0 so it is built from main's editor.
2. Note X-02's rail breakpoints (640 / 896 of editor width). At the default window width the inspector may be hidden (X-18); record what the snapshot or the code shows.
3. No network: if the build tries to fetch anything, stop and report.

**Tests:**
- `DesktopArtifactsFilterTests`, a port of `homeTypeChips` / `effectiveHomeFilter` / `homeTypeFromParam` with the web's cases
- the search matching
- the download file name
- `DesktopDesignLauncherTests` unchanged
- the router opening the dock on the row id

### A7. The document inspector (conditional)

**Build it:**
- `App/DesktopDocumentInspector.swift`: `.document(id)`, pushed from the Library, `.reading`.
- Caption "Document inspector", the file name, and the lede "v{n} · {n} passages · {n} chunks[ · {n} pages]".
- The state as a plain word, not a coloured pill.
- A card with the parser, "checksum {…}" (the checksum in mono), "This version is superseded." and "Download original".
- "Find in this document" and "Page" fields with "Inspect".
- Passages as cards.
- Empty: "No citable text here" / "Nothing in this document matches the current filter."
- Error: "This document could not be read." / "The extractor could not open it, or the request did not come back."
- The data comes from `GET /api/knowledge/documents/{id}?q=&page=&limit=`.

**The entry point:** "Inspect Document…" in a Library row's menu, **only when the item carries `knowledge.documentId`**. Today's server does not send it, so the item stays hidden (§0.3 #16). Decode the field optionally so the Mac lights up when the server adds it.

If the stage runs short, defer A7 whole and say so. It has no reachable entry today.

### A8. Stage A acceptance and snapshots

**Acceptance:**
- the §1 gates, with glass at 27
- the resolver's tests
- the poster tests
- the sidebar shows four rows
- a stored `design` opens Artifacts › Designs
- the design editor bundle check passes
- no page declares a toolbar item or `.searchable`

**Snapshots** (`phase4-a/pages/`):

| Group | Fixtures |
|---|---|
| Library | `library-list`, `library-grid`, `library-deleted`, `library-empty`, `library-error`, `library-selection`, `library-uploading`, `library-narrow`, `library-versions` (the sheet body) |
| Projects | `projects-grid`, `projects-empty`, `projects-new-sheet`, `project-overview`, `project-overview-narrow`, `project-sources`, `project-settings` |
| Artifacts | `artifacts-list`, `artifacts-grid`, `artifacts-designs` (presets and posters), `artifacts-empty`, `artifacts-no-results`, `artifact-page-html`, `artifact-page-design-older` |
| Windows and cards | `window-projects`, `window-artifacts` (sidebar with no Design row), `inline-design-poster` (the transcript card drawing a poster) |
| Optional | `document-inspector`, if A7 is built |

---

## 4. Stage B: Memory, Connections, Skills and Assistants

### B1. Memory

**The client:** a new `ChatKit/NativeMemoryClient.swift`, beside `NativeMemorySettingsModel`, which keeps its settings role.

| Endpoint | Returns or takes |
|---|---|
| `GET /api/memory` | memories, summary {content, updatedAt, entryCount}, projectSummaries[] |
| `POST /api/memory` | add |
| `PATCH` and `DELETE /api/memory/{id}` | edit, move scope, forget or delete |
| `DELETE /api/memory` | reset |
| `POST /api/memory/edit`, then `POST /api/memory/edit/apply` | the prompt dock's draft, then apply |
| `GET /api/memory/edits` and `/edits/{id}` | Your edits, Undo |
| `GET /api/memory/recap?days=7\|30\|90` | Recap |
| `GET` and `POST /api/memory/backfill` | "Learn from past chats" |
| `POST /api/memory/import/preview`, then `/import` | Import |
| `POST /api/memory/consolidate` | Rebuild the summary; check the web's `summary-panel.tsx` for the exact route |

Match field names to `src/components/memory/use-memory.ts` and `memory-model.ts`.

**The page:** `App/DesktopMemoryScreen.swift`, split out of `DesktopAccountScreens.swift`, `.reading`. Keep `DesktopMemoryScreen(model:back:)` for Settings (§0.4).

*Header:* "Memory" with the lede "What Juno carries from one chat to the next. You can change or remove any of it."
- Trailing: "On" or "Off" in the secondary ink, a `Toggle(.switch)` labelled "Memory", and a 28pt More.
- **The More menu** has the web's items in Title Case:
  - "Learn from Past Chats", with the count in the secondary ink; it reads "Reading Past Chats…" while running and "Read Past Chats Now" otherwise
  - "Import from Another Assistant…" and "Export…"
  - "Activity"
  - a divider, then "Memory Settings…", which opens Settings › Memory
  - a divider, then "Reset Memory…" (destructive)

*Notices*, as opaque notes (the `DesktopTurnNote` recipe: radius 12, a 70% hairline, `--muted`):
- "Memory is off." / "Juno isn’t using or saving memories. What’s here is kept.", with Turn On
- the policy notice
- "Reading your past chats." and "Past chats read" / "Juno can learn from them now."

*The scope bar,* only when a project has its own memory:
- the "Show memory from" menu
- when a project is chosen: "Only chats in this project use these memories, and they use nothing else Juno remembers."

*The summary panel,* the page's one raised card (radius 16):
- the heading "About you" or "About this project"
- the reading-style prose, clamped, with "Read the whole summary" / "Show less"
- "Updated {ago}"
- Rebuild (help "Rewrite it from everything Juno remembers") or "Write summary"
- the Activity link, with the help "Your edits and a recap of what changed"
- **The prompt dock** at its foot: a field with the placeholder "Tell Juno what to remember, change or forget".
  - Return, or "Draft this change", shows "Drafting the change…" and then the proposed change as a small diff (the `operation-diff.tsx` shapes: added, changed and removed lines on neutral fills with a leading glyph; no coral) with Apply (`.junoProminent`, the card's one prominent) and Discard.
  - The panel shows "Applied" once applied.
  - While memory is off, the field reads "Memory is off. Turn it on to make changes."

*The list:*
- "Search memories" and the "Group memories" menu (By topic / Newest first)
- sections by topic, with "Uncategorised" and "No longer used" (retired)
- rows on dividers inside one card: the fact, then a caption naming where it came from ("You told Juno", "From your chats", "Imported from another assistant", "From an edit you made", "You added this") and its scope ("Every chat can use it." or the project's name)
- a More per row: Edit (inline; "Enter to save, Esc to cancel"), Move to Project ▸, Forget ("Juno won’t learn this again") or Delete
- "Show all" / "Show fewer"
- "New memory" as an add row with the placeholder "Something Juno should know, like “I prefer metric units”", or "Something true of this project, like “We cite in APA”" in a project scope
- Empty: "No memories yet" / "Juno fills this in as you chat. You can also add something yourself."
- No results: "Nothing matches that" / "Try a shorter word, or search by topic or project name."

*The footer:*
- `ph.shieldcheck` with "Incognito chats are never remembered. Sensitive subjects like health or religion are only learned if you allow them."
- the link buttons "Memory settings · Import · Export · Reset memory…", in the foreground ink and underlined on hover

**The sheets** (§2.4):
- **Activity** (register #65): a `JunoSegmented` Your edits / Recap. Edits have Undo. Recap has 7 days / 30 days / 90 days and the web's sections: "What changed", "What Juno learned", "What Juno let go of", "What Juno leaned on", "What you talked about".
- **Import:** the web's three steps, "Copy the prompt" (Copy Prompt / "Copied"), "Paste the answer" ("I’ve got the answer") and "Choose what to keep" (Select every fact; "Already remembered"; "Looks like a password or key, so it’s never imported"), then "Import Memory". The web's error sentences apply.
- **Reset:** a confirmation with "Reset memory?" / "This permanently deletes everything Juno remembers, the summary and every project’s memory, and its edit history. It can’t be undone. Your chats stay as they are.", and the buttons "Export First", "Cancel" and "Reset" (destructive).

**The error state:** "Couldn’t load your memory" / "Check your connection and try again. Nothing has been changed."

**Remove:** the `Table`, the stat tiles, the privacy strip and "What Juno remembers".

**Tests:** client encoding and decoding, including `projectSummaries`; the draft, apply and discard flow in the model; and scope filtering.

### B2. Connections parity

The page is already on the template. Bring it to `connections/page.tsx` and `connector-directory.tsx`:
- **Header:** the lede "Link an app so Juno can work with your repositories, designs, docs, and workspace tools." and **no count in the header**; the web removed it. Refresh (⌘R) stays as a Mac extra in a 28pt icon button.
- **Controls:** All apps / Connected, "Search Gmail, Slack, GitHub…" and the category chips.
- **Sections:**
  - "Connected" / "Linked and available to your chats."
  - "Available" / "Connect an app to let Juno work inside it."
- **Tile states:** Connected, Connecting, "Finishing connection…" (the settle after the browser returns, about 1.4s), "Setup needed" (with the web's help lines) and Unavailable, each named in words.
- **Buttons:** Connect or "Set up in Composio…" (the browser hand-off is kept); Disconnect confirms with "Disconnect {label}?" / "Juno will lose access to your {label} account. You can reconnect anytime."
- **The footer caption:** "Connected tools are available to the model when you enable them in a chat. Each provider shows the exact permissions during its consent flow."
- **No "Use in chats" switch** (§0.3 #10).
- **Toasts:** "{Label} is connected and ready to use.", "Disconnected {label}." and "Couldn’t disconnect. Please try again."
- **Empties:** "No connected apps yet" / "Connect one from All apps and it will show up here."; "The app directory couldn’t be loaded"; and "The catalog came back empty."

### B3. Skills

**The client:** `WorkKit/Skills/NativeSkillsClient.swift` (new).

| Endpoint | Purpose |
|---|---|
| `GET /api/skills` | the library: yours, sources and their skills, total, truncated |
| `PATCH` and `DELETE /api/skills/sources/{id}` | switch or remove a source |
| `POST /api/skills/sources/{id}/check`, then `/update` | check for updates, then apply |
| `POST /api/skills/import/github` | preview, then install with commit, paths and renames |
| `GET`, `PATCH` and `DELETE /api/work/skills/{id}` | one skill |
| `GET /api/work/skills/{id}/versions` | its history |
| `POST /api/work/skills/{id}/versions/{v}/consent` | consent |
| `POST /api/work/skills` | create |

Decode as tolerantly as `src/components/skills/skills-transport.ts` does, and keep its `WorkResult` split: a refusal the server explained (409/429, with its sentence) against a failure the reader can only retry.

**The model:** `NativeSkillLibraryModel` (`@Observable`, `@MainActor`) with the public `chooseable` for the composer (§0.4). Put it on `JunoDesktopConfiguration.skillLibraryModel`. It is shared, so keep iOS compiling.

**The pages:** `App/DesktopSkillsScreen.swift` (list), `App/DesktopSkillPage.swift` (`.skill(id)` and `.newSkill`), and the sheets in `App/DesktopSkillSheets.swift`.

*The list* (`.reading`):
- "Skills" with the lede "Instructions Juno follows for a specific job. Type / in chat to use one."
- "Add ▾" (`.junoProminent` `Menu`): "Import from GitHub…", "Write a Skill" (pushes `.newSkill`) and "Create with Juno", which starts a new draft chat with the web's `CREATE_SKILL_PROMPT` prefilled (`add-skill-menu.tsx`), not sent.
- **The search field:** "Search skills", 40pt at the field radius (the web's larger field), with a `/` keycap that fades while you type. `/` focuses it; Esc clears.
- **"Your skills" {n}:** skill rows inside one card:
  - a 28pt tile
  - the name at 13 medium, and the description at 11 secondary
  - the state in words: "Needs your approval before it can run" or "Blocked by Juno’s safety check"
  - an enable `Toggle(.switch)`
  - the row pushes `.skill(id)`
- **"Installed" {n}:** source groups that expand (a disclosure, open while searching):
  - the source's avatar tile (a letter tile when the owner's picture is not loaded) and `owner/repo`
  - the source switch, "Off" when off, and "A skill in this source needs attention"
  - More: Check for Updates…, Remove…
  - its skills as rows
- "Showing {n} of {m} skills, the first by name." when truncated.
- **Empty:** "No skills yet" / "Install a set from GitHub, or write your own.", with "Import from GitHub" and "Write one" (both bordered; the header's Add is the one prominent), then "Popular" and the web's `POPULAR_SKILL_SOURCES` as chips that open Import on that repository.
- **No results:** 'No skills match “{q}”', with Import from GitHub.
- **Error:** the web's `WorkLoadError` sentence.

*The detail* (`.reading`):
- the name as the title, with the description as the lede
- "Use this skill": "Automatically when relevant" / "Only when I call it", a radio group with the web's help lines
- Instructions: the reading prose, with "No instructions yet."
- History: versions marked "Current", with Restore
- the consent and blocked notes, with the web's sentences ("It won’t run until you approve what it asks for.", "This version asks for more than the last one", "Juno’s safety check flagged something", …)
- files that are missing from the library: "One file this version names is no longer in your library."
- More: Edit, Move to Project…, a divider, Delete…
- missing: "Skill not found" / "This skill no longer exists. It may have been deleted on another device."

*New skill* (`.reading`):
- caption "Skills", title "New skill", lede "Instructions Juno follows when you call it by name."
- Name (placeholder "File the invoices"; "Use at least one letter or number.")
- Description (placeholder "Sorts incoming invoices into the right folder and renames them."; help "One line. Juno matches requests against it.")
- Instructions (a mono editor; "Markdown works."; the web's sentence)
- Files
- "Create skill" (`.junoProminent`) and Cancel
- the failure toast "Couldn’t save this skill. Nothing was created."

*The Import from GitHub sheet* (`import-skills-dialog.tsx`):
- the repository field ("owner/repo or a GitHub link")
- the Popular chips
- a filterable list of the repository's skills, with Asks for, License, Path, Works with, Other files and Show/Hide details
- rename validation: "Use lowercase letters, numbers and dashes.", "That name is taken. Choose another."
- Install
- the error sentences verbatim

*The update-source sheet* follows `update-source-dialog.tsx`: Changed, "New in this repository", "Kept here", Update and Install.

**Not in this stage:** the composer's "Use a Skill" and `skillSlug` are Track A's (§0.4).

**Tests:** client decoding (library, sources, truncated), refused versus failed, and `chooseable` excluding disabled or blocked skills.

### B4. Assistants

**The client:** `ChatKit/NativeAssistantsClient.swift`: `GET` and `POST /api/assistants`, `PATCH` and `DELETE /api/assistants/{id}` (pin, edit), with fields per `src/lib/assistants.ts` (`JunoAssistantConfig`).

**The page:** `App/DesktopAssistantsScreen.swift`, `.wide`.

*Header:* caption "Assistants", title "Specialists you can reuse", lede "Focused Juno personalities with their own instructions, starter prompts and model preference.", and "New assistant" (`.junoProminent`, `ph.plus`).

*Controls:* "Search assistants" (at most 320pt) and a trailing "{n} assistants".

*The grid:* 1 / 2 / 3 columns at 640 / 1024; cards at least 160pt tall, each with:
- a 36pt inset `ph.robot`
- the name and, when pinned, a neutral fill pin
- the description in two lines ("Custom Juno assistant" when empty)
- hover actions: Pin/Unpin, Edit, Delete (28pt, with help)

**A card opens the editor** (register #60).

*The editor sheet* (register #66; at least 880 × 640, two columns):
- **The left Form:**
  - Name (placeholder "Python data analyst")
  - Preferred model
  - Description (placeholder "What is this assistant for?"; help "Keep this short enough to scan in the gallery.")
  - Instructions (the web's placeholder)
  - Conversation starters: an editable list with "Remove starter", placeholder "Analyze this dataset and explain the important patterns."
- **The right Preview** (the signature): the name ("Untitled assistant"), the starters as chips ("Add a starter to see it here.") and the instructions ("The system prompt appears here as you write it.").
- **Buttons:** "Cancel", then "Create Assistant" or "Save Changes".
- **Validation:** "Add a name and instructions before saving this assistant."
- **Failure:** "Juno could not save this assistant."

*Delete* confirms "Delete assistant?" / "This assistant will be removed from your library." with "Delete Assistant".

*States:*
- **Error:** "Assistants are unavailable" / "Juno could not read your assistant library. Nothing was deleted; retry the request."
- **Empty:** "No assistants yet" / "Create a reusable specialist for a workflow, domain, class, project or writing style." with "Create assistant".
- **No results:** "No matching assistants" / "Try a different name or description." with Clear search.

*Toasts:* "Couldn’t update the pin." and "Couldn’t delete the assistant. Nothing was removed."

**Reaching the pages:** add `.skills` and `.assistants` to `DesktopDestination`, with their labels and icons, and append them to More now so they can be reached. Stage C sets the final order.

### B5. Stage B acceptance and snapshots

**Acceptance:** the §1 gates and the client and model tests.

**Snapshots** (`phase4-b/pages/`):

| Group | Fixtures |
|---|---|
| Memory | `memory`, `memory-welcome`, `memory-off`, `memory-draft` (the dock with a proposed change), `memory-project-scope`, `memory-activity`, `memory-import`, `memory-error` |
| Connections | `connections`, `connections-empty-connected` |
| Skills | `skills-list`, `skills-empty`, `skills-no-results`, `skill-detail`, `skill-detail-blocked`, `skill-new`, `skills-import` |
| Assistants | `assistants-grid`, `assistants-empty`, `assistant-editor` |
| Windows | `window-memory`, `window-skills` |

---

## 5. Stage C: Automations, Permissions, Agents and More

### C1. Automations

**Port, then delete.** Build the new files from `DesktopWorkAutomationsView` / `DesktopWorkAutomationEditor` / `DesktopWorkTriggerEditor`, over the same `NativeWorkAutomationModel` and `NativeWorkScheduleDraft`:
- `App/DesktopAutomationsScreen.swift` (list)
- `App/DesktopAutomationPage.swift` (`.automation(id)` and `.newAutomation`)
- `App/DesktopAutomationEditor.swift`

Then:
- Replace the legacy Work window's use (`DesktopWorkWorkspace.swift:351`) with the new list inside its own `NavigationStack`. It is a mechanical change that keeps the Work window working until Phase 5 deletes it.
- Delete `App/DesktopWorkAutomations.swift`.

*The list* (`.wide`):
- "Automations" with the lede "Let a task start itself — at a time you choose or when something changes — with every run attached to the same task so context compounds." This is the web's copy, dashes included (§2.6).
- "New automation" (`.junoProminent`) pushes `.newAutomation`.
- Sections "Active" and "Paused". Their headings show only when both exist, on the `heading` rung, with rows inside one card.
- **Each row:**
  - the name
  - the schedule sentence ("Nothing on the clock. This one waits for an event.", "Paused. Nothing on the clock either way.", the next run, or "Next run unknown.")
  - the notify caption ("No email unless a run gets stuck", "Emails when it needs you", "Emails on every run", "Emails on everything")
  - "Paused" in words when paused
  - More: Run Now, Pause or Resume, Its Task (only when the schedule's session has a conversation), a divider, Delete…
  - the row pushes `.automation(id)`
- **Empty:** "No automations yet" with the web's sentence ("Run a task every weekday at eight, …") and New automation.
- **Error:** "Couldn’t load your automations. Existing automations keep their server-side state; this page is empty because the read failed, not because they were removed."

*The detail* (`.reading`):
- caption "Automations", the name as the title, and the lede "Paused. Nothing new will start until you resume it." when paused
- actions: "Run now" (`.bordered`, `ph.play`, which swaps to the spinner while busy) and "Delete" (destructive outline)
- the editor, with "Save changes"
- the fire card
- "Recent runs": a `heading` with Refresh (a ghost button with the refresh glyph), then rows with a status pill and time, each opening its conversation
- Empty runs: "No runs yet" / "It has not run yet. Skipped fires (a Mac that was away, a budget that was spent) appear here too, so an empty list means nothing has fired at all."
- Unreadable history: "Couldn’t read the history" / "This automation’s history couldn’t be read just now, which says nothing about whether it has run."
- **Delete** confirms "Delete “{name}”?" with the web's sentence.
- **Toasts:**
  - "Started. This run is extra, and the automation still fires when it was going to."
  - "Couldn’t start this. Nothing was queued, so trying again is safe."
  - "Paused. Nothing new will start." / "Resumed."
  - "Couldn’t change this schedule. It is exactly as it was."

*New* (`.reading`):
- caption "Automations", title "New automation", lede "Say what should happen, when it should start, and what Juno may do about it while you are not there."
- the editor with "Create schedule" (`.junoProminent`) and "Cancel" (`.bordered`, which pops)
- on save, replace the route with `.automation(newID)`

*The editor,* a grouped `Form` in the web's order (`src/components/work/work-schedule-editor.tsx`; check it for option values):
1. **What it runs:** "A task" / "Code" (register #67). "Code" is offered only when the Mac can edit it; today it cannot. An existing Code automation opens with its fields read-only and a link, "Edit this automation on the web".
2. **Name:** placeholder "Monday morning inbox sweep".
3. **What it should do:** the web's help sentence.
4. **When it runs:** triggers as editable rows under "On a clock" (Once, Hourly, Daily, Weekdays, Weekly, Monthly, Yearly, Cron with the placeholder "0 9 * * 1-5") and "On something happening" (An email arrives, A meeting is coming up, A topic is mentioned, A connected app sends an event, A folder changes, Only when you press Run, Something calls it), with the web's field placeholders. The JSON editor is dropped; a trigger kind the Mac cannot edit shows "This trigger is edited on the web".
5. **Timezone:** placeholder "Europe/Paris".
6. **Where it runs:** "Wherever it fits" / "Cloud" / "One of my Macs", plus Mac ("Choose a Mac…" / "Any of my Macs").
7. **What each run uses:** the model.
8. **What each run may spend:** "Cost, in US dollars", "Tokens" and "Minutes of work", each with the placeholder "No limit".
9. **Runs at once.**
10. **When nobody is watching:** "Something it cannot undo", "The Mac is not there" and "Fires that were missed".
11. **Tell me.**

Every choice is a radio row with the web's label and the web's sentence under it. For example, "Stop and wait for me" / "The run parks and asks. Nothing irreversible happens until you answer."; "Catch up once" / "One run covers everything that was missed."; "Only when it needs me" / …

This replaces the Mac's own labels ("Stop and ask me", "Catch up every fire", …). Save errors: "Couldn’t save this schedule. Nothing was changed." and "Couldn’t reach Juno to save this. Nothing was changed."

**Tests:** each policy's label maps to its wire value, and a draft round-trips through the editor.

### C2. Permissions and host pages

**The client.** Add to `WorkKit/NativeWorkClient.swift` (they are additive):
- `host(id:)`: `GET /api/work/hosts/{id}`, returning the host plus grants
- `updateHost(id:…)`: `PATCH` with the master switch, capabilities, policy ceiling and apps and sites
- `revokeHost(id:)`

Take the web's `fetchWorkHost` / `revokeWorkHost` and its update in `src/components/work/work-transport.tsx` as the reference for methods and bodies.
- Poll every `WORK_POLL_MS` while the page is visible, and refresh when the window comes forward.
- The web's floor list, verbs and descriptions live in `src/lib/work/domain.ts` (`ALWAYS_CONFIRM_ACTIONS`, `describeFloorAction`, `WORK_APPROVAL_MODE_LABEL` / `SUMMARY`, `DEFAULT_WORK_PERMISSION_POLICY`). Reuse the Swift copies in `WorkKit/JunoWorkApprovalRules.swift` / `JunoWorkVocabulary.swift` where they exist; otherwise port them there, not into the App.

**The page:** `App/DesktopPermissionsScreen.swift` (`.wide`, destination `.permissions`, which is **not** in More).
- "Permissions" with the lede "What Juno may do on your behalf, what it always stops to ask about first, and which of your Macs it can reach."
- **"Your Macs":**
  - `DesktopWorkHostRow` rows inside one card, this Mac first: the name, the state in words (awake Macs get the live dot beside the word), and the web's `hostWorkloadSentence`
  - each row pushes `.host(id)`
  - Empty: "No Macs yet" with the web's sentence
  - A failed refresh keeps the rows under the note "These are the last answers Juno got. The latest check failed, so a Mac may have woken or gone away since."
- **"Juno always asks first":**
  - the sentence "These stop and wait for you every time, under every setting on this page and every setting on a task. There is nothing anywhere that turns them off."
  - a two-column grid of opaque tiles (radius 16), each with `ph.shieldcheck` in the warning ink, the verb at 13 medium and the description in the secondary ink
- **"How much it asks otherwise":**
  - the web's sentence
  - three cards (the mode's label, "Default" as a neutral badge on the default, the summary)
  - the closing paragraph in the web's words; "Needs you" is plain text until Phase 5's fold can be linked

**The host page:** `App/DesktopHostPage.swift` (`.host(id)`, `.reading`).
- caption "Permissions", the Mac's name, and its workload sentence as the lede ("Nothing running on it right now.")
- "Revoke" (destructive outline; the confirmation carries the web's sentences)
- The toasts are the web's: "Revoked. This Mac can no longer claim anything.", "Couldn’t revoke this Mac. Its access is unchanged, so it is safe to try again.", "Couldn’t change that. This Mac is exactly as it was — nothing was half-applied."
- A revoked Mac is listed, named, and says when it was revoked.

The sections follow `src/components/work/work-host-settings.tsx`. The web sets its headings as mono labels; here they are the `heading` rung (register #71).
1. **"What this Mac may do":**
   - the master switch "Juno Work on this Mac" with "The master switch. With it off, this Mac claims nothing at all — the five below stop applying, and a task that needs a real machine looks for another one."
   - the five capability switches ("Files in the folders you have shared", "Your signed-in browser", "Screen control", "Shell commands", "Keep working while you are away") with their sentences, and the "no longer offering" and "has not offered" notes
2. **"How often Juno asks before acting on this Mac."**
3. **"What it has offered":** empty "Nothing listed yet" with its sentence.
4. **"Folders it can reach":** grants with "Read only" / "Read and change, nothing removed" / "Read, change and remove"; empty "No folders shared"; unreadable "Couldn’t read the folders".
5. **"Apps and sites":** "Apps it may drive", "Apps it may never touch" and "Sites the browser may visit", each with its empty sentence.

**For this Mac only,** the page opens with an "On this Mac" group (register #68) above the server switches:
- `DesktopWorkHostTile`'s local content: what this Mac offers, the macOS permissions (Accessibility, Screen Recording, with their System Settings links) and the folder picker (`DesktopWorkGrants`)
- this is where the web says "a folder is chosen in Juno on the Mac"

Keep `DesktopWorkHostTile` as the source of that content (extract its sections so both places can use them).
- **Do not edit** `DesktopSettingsWindow.swift`. Settings › Code's tile stays until Track A's Settings › Devices lands (§0.4, §7).
- The legacy Work window's tile stays until Phase 5.

**Tests:** host detail decoding (grants, revoked), the update bodies, revoke, and this Mac sorting first.

### C3. Agents

**Scope.** Restyle main's shared views onto the template behind `#if os(macOS)`; the iPhone keeps its layout. Build and run iOS.

**Routing:** `.agent(id)` and `.newAgent(template:)` through `DesktopPageRoute`, with main's `selectedAgentID` mapped to the path (§2.5).

**The roster** (`NativeAgentsScreen`, `.wide`):
- "Agents" with the lede "Teammates that take on work, keep going when you leave, and come back only when they need you."
- "New agent" (**`.junoProminent`**; it was `.bordered`, drawing a coral outline label), shown only when agents exist; it pushes `.newAgent(nil)`
- the grid: 1 / 2 / 3 columns at 576 / 896 of page width; cards with the 48pt face, the name, the role and the state sentence
- **Loading:** skeleton cards.
- **Error:** "Couldn’t load your agents" with Try again.
- **Empty, "Hire your first agent":**
  - four template faces overlapping
  - the title rung, then "Start from a job. Everything is editable before you hire, and nothing it does that sends, pays or deletes happens without you."
  - template tiles (the face, the label, the promise), which push `.newAgent(templateID)`
  - "Or start from scratch." with "start from scratch" as a link, which pushes `.newAgent("custom")`

**The agent page** (`NativeAgentPage`, `.wide`):
- the header: the face (lg, xl while arriving), the name in the `pageTitle` rung, the role, and the state label (SF, not the web's mono caption) · the state sentence
- actions: "Message" (`.junoProminent`), "Pause" or "Resume" (`.bordered` neutral), and More ("Think It Over Now", "Edit Profile", a divider, "Retire…" destructive)
- the tabs: `JunoSegmented` with Now · Goals · Routines · Activity · Profile, replacing the system segmented `Picker`
- the welcome card, in the web's words
- missing agent: "This agent is no longer here" / "It may have been retired. Its thread and tasks are still in your chats." with "All agents"
- every `.bordered` in these views takes `.tint(nil)`

**Hire** (`NativeAgentHire`, a pushed page, `.wide`):
- caption "Agents", title "New agent", and the lede "A teammate with its own brief, goals and memory. It works in the cloud and asks before anything it cannot take back."
- the web's sections: "What should it take on?", "Name and face", "How it works" ("How it talks", "Its brief", "Autonomy", "Connected apps it may use") and "A first goal", with "Optional"
- the submit as `.junoProminent`, and Cancel
- the "Preview a state" segmented picker is not on the web: remove it, or gate it `#if DEBUG` if the previews use it

**The sidebar:** the Agents section header is SF (A0). Its rows and faces are main's.

### C4. The More menu and the sidebar

- **`DesktopDestination.moreCases`** becomes `[.assistants, .skills, .automations]`.
- **After them** come a `Divider` and "Archived Chats" (`ph.archive`), shown only while the `openArchivedChats` hook is set (§0.4).
- **`.connections` and `.memory`** leave More. They stay destinations, reachable from:
  - the composer `+`
  - Settings › Memory's embedded page
  - `DesktopPageRouter` (for Track A's ⌘K and Settings)
- **`.permissions`** is a destination reached only through the router and the Devices rows.
- **The More trigger** shows the selected fill while one of its pages is showing, as the web does (`app-sidebar.tsx:2104-2113`).
- **Tests:** the order of `sidebarCases` and `moreCases`; `.connections`, `.memory` and `.permissions` round-trip through stored state.

### C5. Deletions

- `App/DesktopWorkAutomations.swift` (after C1)
- `App/DesktopTasksScreen.swift` (dead; §0.1)
- `App/DesktopDesignScreen.swift`, if Stage A did not already delete it

Then run `generate-projects.sh`.

### C6. Stage C acceptance and snapshots

**Acceptance:** the §1 gates, the policy mapping tests, the host client tests and the More order tests.

**Snapshots** (`phase4-c/pages/`):

| Group | Fixtures |
|---|---|
| Automations | `automations-list`, `automations-empty`, `automations-error`, `automation-detail`, `automation-detail-paused`, `automation-new` |
| Permissions | `permissions`, `permissions-empty`, `host-this-mac`, `host-other-mac`, `host-revoked` |
| Agents | `agents-roster`, `agents-first-hire`, `agent-page`, `agent-hire` |
| Windows | `window-automations`, and `window-agents` re-rendered in `final/` |

---

## 6. Register additions, proposed (§0.8, numbered on from #52)

Each stage appends the entries it built. Renumber if Track A has taken numbers in the meantime.

53. **Artifacts opening.** A row opens the artifact's own page, pushed on the Artifacts stack, as the web's `/a/{id}` does. "Open in Conversation" is the canvas dock. The Artifacts page no longer edits: the web's window is read-only, and editing happens in the chat's canvas.
54. **Design is a type.** The Design row is gone, and `.design` resolves to Artifacts › Designs, as the web does.
55. **Poster fallback.** Designs draw from the server's poster and fall back to the SVG export when the poster cannot be had. The web falls back to the type glyph.
56. **Pins.** A pinned project or assistant wears a neutral fill pin. The web draws it coral.
57. **Eyebrows and back.** Page eyebrows ("Project", "Automations", "Permissions", "Assistants", "Skills", "Agents", "Document inspector") are SF 13 medium captions, not mono labels. Detail pages use the system back button instead of the web's back row.
58. **Meta lines.** Header ledes with counts and the meta lines of rows and tiles are SF with tabular digits; the web sets them in the mono caption. This extends #40.
59. **Connections.** There is no "Use in chats" switch. The web's is stored in the browser and read by nothing.
60. **Assistants.** There is no "Start chat", and a card opens its editor. The web's `/chat?assistantId=` is read by nothing.
61. **Library.** List is the default, as on the web, and the Grid is square tiles. Kept as Mac extras: Add Document…, Copy Names, Quick Look on Space, drag-out, and Edit Image….
62. **Document inspector.** It is reached from a Library row only when the server names the document. On the web the page has no link at all.
63. **Design sizes.** In the New menu, a design size shows as the item's subtitle. The web right-aligns it in mono.
64. **Preset hover.** The preset buttons' plus stays neutral on hover. The web turns it coral.
65. **Memory Activity** is a sheet. The web uses a side sheet.
66. **Pages instead of sheets.** New automation, New skill and New agent are pushed pages, as on the web, not the spec's `.page` sheets. The assistant editor stays a sheet, as on the web.
67. **Code automations** are listed and runnable on the Mac, but edited on the web.
68. **This Mac's host page** adds an "On this Mac" group (local offers, macOS permissions, the folder picker) above the web's switches.
69. **Project composer.** A project's Overview has an opaque, composer-shaped field that sends into a new chat in the project. The web embeds a second full composer. Glass stays on the one real composer.
70. **Project tab counts** use `JunoSegmented`'s counts. The web adds a count badge to its tab labels.
71. **Headings.** Section headings on Permissions and host pages, and card headings on a project's Settings, are the `heading` rung, not the web's mono labels.
72. **Sheet buttons** are Title Case ("Create Project", "Rename Project", "Save Changes"), per §0.7.
73. **"Download Source…"** keeps the web's words and adds an ellipsis, because it opens a save panel.

---

## 7. Deferred or out of scope (explicit)

1. **Runtime checks at the screen** (screen control is off):
   - pushes and pops with the system back button, and the §0.5 repro with a popover open during a push
   - ⌘R, ⇧⌘I and `/` from their pages
   - dropping files onto the Library, an upload's progress, Undo after delete
   - Quick Look from Space
   - a design created from New ▾ opening in the editor
   - "Open in Conversation" sliding in the dock
   - posters loading and revalidating against the live server
   - the Memory prompt dock applying a change
   - the Connections browser round trip
   - importing skills from GitHub
   - Run now on an automation
   - host switches and Revoke
   - hiring an agent
2. **Track A** (§0.4):
   - the share popover for artifacts
   - the Archived Chats sheet
   - ⌘K entries
   - Settings › Devices, Connectors and Memory links
   - deleting Settings › Code's "Juno Work" tile
   - the composer's "Use a Skill" and `skillSlug`
   - the menu bar's Go/View commands for pages
3. **Phase 5:**
   - project Task defaults
   - the Needs-you link on Permissions
   - deleting the legacy Work window and its host tile
4. **Owner or server questions** (§8):
   - Assistants "Start chat"
   - Connections "Use in chats"
   - the document inspector's entry point
5. **Data gaps:**
   - a project's Code tab, if conversation `kind` is not reachable for project chats
   - the Sources tab's index labels, if the project file entity has no `parserState`
   - project covers, if the `__cover__` file is not in the synced files
6. **Code-target automations** are edited on the web (register #67).
7. **iOS** adopting the resolver rule. `JunoMobileConversationsView.storedArtifact(for:)` matches by identifier across all conversations and ignores M11's retired rows. The follow-up is to use `ChatArtifactResolver` there.
8. **Not Phase 4:** Research (`/research`), Compare, Roadmap, Upgrade (Track A), Admin, and Code's pages (`/code/*`, the Code session's).
9. **New copy in `Localizable.xcstrings`** (carried forward).
10. **Previews that need runtimes.** React, TypeScript and Python artifact previews still need bundled runtimes (unchanged; the owner's permission is needed to download them).

## 8. Questions for the owner

1. **Assistants.** The web's "Start chat" opens a plain chat: nothing reads `assistantId`. Should the server apply the assistant (then the Mac adds "Start chat"), or should the web drop the button?
2. **Connections.** "Use in chats" is stored in the browser and read by nothing. Wire it, or remove it on the web?
3. **Artifacts.** Is it acceptable that the Artifacts page stops editing in place, so edits happen only in the chat's canvas, as the web's `/a/{id}` window implies?
4. **Document inspector.** Add `knowledge.documentId` to `/api/library` items, so the inspector has a way in on both the web and the Mac?

## 9. Docs to update as the stages land

- `docs/native/MACOS_LIQUID_GLASS_REDESIGN.md`: a "Phase 4 errata" section per stage, and the register entries (§6).
- `docs/native/MACOS_REDESIGN_HANDOFF.md`: a stage entry per commit, the Track A wiring list (§0.4), and the snapshot paths.
- `docs/native/API_GAPS.md`: skills, assistants, memory v2, library v2, posters, host detail and update, and the two dead web controls.
- `docs/native/PARITY_MATRIX.md`: rows 139–162 as they become true (spec "Docs to correct").
- Code comments: the `DesktopDestination.design` and `DesktopSidebarDesignRow` comments (spec "Docs to correct"), and `DesktopDestination.memory`'s "temporary More item" note.
