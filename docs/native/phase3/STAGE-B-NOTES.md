# Phase 3 Stage B notes: ⌘K and Search, Share, Outputs, the account popover, Archived Chats, dialogs and sheet fills

Branch `mac/lg-p3b` in `juno-glass-p3b`, from `250b5b13`. The brief is `docs/native/MACOS_PHASE3_OVERLAYS_BRIEF.md` (copied unchanged from `mac/lg-p3` `1150f081`). The integration step (§6 of the brief) folds these notes into the spec's "Phase 3 errata", the register, `MACOS_REDESIGN_HANDOFF.md` and `WEB_TO_NATIVE_DESIGN.md`, then deletes this folder.

## What was built

### B0. Clients and the contract

- `JunoChatKit/NativeUnifiedSearchClient.swift` (new, iOS-safe, not wired on iOS):
  - `search(query:types:projectID:window:for:)` → `GET /api/search`, decoding `UnifiedSearchResult` exactly: groups, hits (`id`, `type`, `title`, `titleMarks`, `snippet{text, marks}`, `locator`, `projectId`, `updatedAt`, `href`, `score`), `coverage[]`, `partial`, `total` and the echoed `query`.
  - `recents(limit:for:)` → `GET /api/recents?limit=`.
  - The web's vocabulary as Swift: `NativeUnifiedSearchType` (`SEARCH_TYPES` order, `SEARCH_TYPE_LABELS`), `NativeSearchWindow` (`SEARCH_WINDOW_LABELS`, `windowSince`).
  - Marks are **UTF-16 offsets** (JavaScript string indices); `NativeSearchMark.ranges(_:in:)` walks the UTF-16 view and drops a mark that splits a character or runs past the text.
  - An unknown type (a newer server's group or coverage row) is dropped, never fatal; one unreadable hit does not cost its group.
  - `answers(_:)` is the echo guard; `shortfalls` is the coverage the palette mentions.
- `NativeShareClient`: `share(artifactID:for:)`; `403 {code: "share_taken_down", error}` decodes to `NativeShareError.blocked(reason)` (new case). The chat call is unchanged for iOS.
- `contracts/openapi/juno-native-v1.yaml`: `/recents` (GET), `/search` (GET), `/share` (GET, POST), `/share/{shareId}` (DELETE), inline schemas, placed before the Juno Work block (after `/notifications/{notificationId}`). `GET /conversations?archived=` was not added: Archived Chats reads the local store (see B5). The Swift contract is regenerated; `info.version` is unchanged.
- Tests: `JunoChatKitTests/NativeUnifiedSearchClientTests` (recorded JSON: marks, partial coverage, the echo guard, an unknown type ignored, UTF-16 marks, the request's query items, recents, a failing route, the blocked share, the artifact share body).

### B1. The ⌘K / Search panel

- `App/DesktopSearchPanelModel.swift` — one `@Observable` per window: mode, query, filters, the two halves' states, the Recent list, the cursor (by row identity, so the server's groups slotting in never move it), `present(_:)`/`dismiss()`, the merge (`resultRows`), notices, status words, and the hit routing table (`DesktopSearchRoute`).
- `App/DesktopCommandCatalog.swift` — the web's command list with its keywords verbatim, the ported `atWordStart` matcher, `DesktopPanelAction` (a value, so routing is testable) and the hooks (`openNotifications`, `openUpgrade`, `openPage(DesktopPanelPage)`, `openTaskRecord`).
- `App/DesktopSearchPanel.swift` — the view and the host overlay (`.desktopSearchPanel(…)` on the split view): glass shell in one `GlassEffectContainer` at radius 20, the field band (18pt magnifier, 17pt field, "esc" cap or the ✕), the filter row, the notices band, the list with its floor, rows, headers, keycaps and states.
- Wiring in `DesktopChatWorkspace.swift`: `openSearch()` now calls `presentSearchPanel(.search)` (the sidebar's Search and ⇧⌘F), which closes Share and Outputs first (crash rule 4). `presentSearchPanel(.commands)` is what seam 1 calls. `performPanelAction` maps each action onto an action the window already had. `ChatDetail` reports the detail column's frame and toolbar depth (`panelAnchorChanged`) so the panel centres on the column, 72pt below the toolbar, `min(640, detail − 32)` wide, height `56 + filters 44 + notices + list` with a 208pt floor and a `min(480, window − 144)` cap.
- Search engine (decision 7): chats, messages, projects, files and artifacts from `NativeSearchStore` over `configuration.localStore`; knowledge, memory and tasks from `/api/search?types=knowledge,memory,work`. Both debounce 180ms and cancel the previous run (a generation counter); the local results draw first. The store's own memory rows are not listed, so a fact never appears twice. Each local group is capped at six rows (the web's `DEFAULT_LIMIT_PER_TYPE`). Local marks are literal, case- and diacritic-insensitive matches of each word of two or more characters.
- Recent: `recents(limit: 8)` online; offline (or on failure) this Mac's chats, Code sessions and projects by recency. The last list stays up while a fresh one loads; a skeleton shows only before the first.
- `DesktopSearchScreen.swift` is no longer routed to (nothing sets `.search`); it and the `.search` branch are the integration's to delete (§6.3).

### B2. Share

- `App/DesktopSharePopover.swift`: `DesktopShareTarget` (`.chat`, `.artifact`), `DesktopShareService` (live over `NativeShareClient`, stubbable), `DesktopShareState` (moved here from `ChatToolbar.swift`, rewritten as the web's five states: loading, error, blocked, ready, revoked; Copy → "Copied" for 1.5s; Revoke Link → "Revoking…", toasts in the window's host) and `DesktopSharePopover` (360 × 232 in every state).
- Opening makes the link; nothing reaches the pasteboard until Copy (the web's behaviour; the interim Mac popover copied on open). Every Share entry point (toolbar, title menu, row menu, reply's Share Chat…) goes through `shareSelectedConversation()` → `share.start(.chat(id), …)`.
- `DesktopShareResultPopover` and its interim copy ("Creating a link…", "Link copied…", "The conversation couldn’t be published…") are deleted.

### B3. Outputs

- `App/DesktopOutputsPopover.swift`: `ChatSessionOutputs.read(artifacts:messages:modelName:)`, a line-for-line port of `readSession()`; the toolbar chip (`ph.filetext` + a rolling count, "Outputs — {n} in this chat" / "What this chat used", help "Outputs"); the 336-wide popover with a height computed from its rows (cap 400, scroller inside); tiles as the web's `ArtifactPreview` draws them (first twenty lines of source in the micro rung, clipped and faded; SVG and a design's poster drawn as pictures by AppKit, no web view; generated media as itself); the used rows with openable uploads.
- The chip is a new first `ToolbarItem` in the Share/Private capsule, declared unconditionally, hidden with `.hidden(!isChatRoute || nothing to show)`.
- `DesktopChatOutputRequests` carries "open this artifact's canvas" and "Quick Look this file" from the toolbar (and from ⌘K's artifact hits) down to the conversation column, which owns both; the column consumes a request a turn after its conversation is on screen (`.desktopOutputRequests(…)` in `DesktopConversationView`).

### B4. The account popover

- Rewritten in `DesktopAccountFooter.swift` (the footer row is unchanged): identity with an SF plan pill on `junoGlassFill`; the usage block (`DesktopAccountUsage`); Settings… (⌘,), Upgrade Plan (only while `openUpgrade` is wired: nil on this base), Admin Panel ↗ (owners); Keyboard Shortcuts (⌘/, opens the Shortcuts window); Sign Out. No Profile…, no Get the apps (P3-15).
- Heights are constants per row set (`DesktopAccountPopoverRows`): base 246, +10 when the usage block carries a sentence, +28 for each of Upgrade and Admin.

### B5. Archived Chats

- `App/DesktopArchivedChatsSheet.swift`: a fitted system sheet, 480 × 520, no custom ground; the web's title and description; 48pt rows (title over "Archived {date}", Restore `ph.boxarrowup`, Delete `ph.trash`); four skeleton rows; `JunoEmptyState(.panel)` "Nothing archived." and the error tone "Couldn’t load archived chats."; Done (`.bordered`, `.tint(nil)`, `.cancelAction`).
- Restore and Delete hide the row at once; a failure brings it back with the reason under it for six seconds ("Couldn’t restore the chat." / "Delete failed."), never a toast.
- **Data source: the local store**, not `GET /api/conversations?archived=only`. The sync projection carries every conversation with its `archivedAt` and no archive filter (`src/lib/sync-entities.ts`, `conversation`), so chats archived before this Mac first synced are in the store too; `NativeConversationModel.conversations` keeps archived rows (only the sidebar filters them). Restore and delete are the store's own mutations (`setArchived`, `deleteConversation`); success is read back from the store.
- Presented from the workspace (`showingArchivedChats`); nothing on this base opens it until seam 8.

### B6. Dialogs, rename and sheet fills

- Delete conversation moved to `.junoConfirmation` with `DesktopChatDeletion` (the web's title and message, "Delete Chat"). A delete the store could not take leaves the row where it was and posts "Delete failed.".
- Rename… from the title menu reveals a hidden sidebar first (`DesktopChatRename.columns(forRenameFrom:)`, tested) — the behaviour was already there; it is now a tested rule.
- `.alert` audit on chat surfaces:

  | Site | Kind | Result |
  |---|---|---|
  | Delete this conversation? (`DesktopChatWorkspace`) | choice | moved to `.junoConfirmation`, "Delete Chat" |
  | Leave this private chat? (`DesktopChatWorkspace`) | choice | already a confirmation dialog; left as specified |
  | Regenerate this answer? (`MessageRow`) | choice | already a confirmation dialog; left as specified |
  | Delete this project? (`DesktopChatSidebar`) | choice | already a confirmation dialog; Phase 4's file |
  | Screenshot unavailable | error | stays `.alert` |
  | Voice is unavailable | error | stays `.alert` |
  | Couldn’t open the file | error | stays `.alert` |

- `junoSheetSurface` removed at the image-edit sheet (`DesktopChatWorkspace`) and the Library picker (`DesktopLibraryPicker`); each keeps its explicit frame and takes `.presentationSizing(.fitted)`.

## Errata: where today's web was followed

- The Command menu's Chats group lists every non-Code conversation (`kind !== "code"`), as the web does; the sidebar's own filter is `kind == "chat"`. Title matches in Chats, Code sessions and Projects are substring matches (the web's `includes`), not word starts; only the fixed rows use `atWordStart`.
- A Tasks hit whose task has no conversation carries `href: "/chat"` (`chatPathForSession`); the Mac reads its session id from the hit's `work:` id for seam 6, and leaves `work-event:` hits without a conversation out (no session id to open).
- The web's Share opens by creating the link and copies nothing until Copy; the Mac now does the same.
- "Chat restored." (the web's toast) is not posted: a sheet hosts no toasts, and the row leaving is the acknowledgement (P3-18).

## Register entries (provisional; renumbered at integration)

Used from the brief: P3-10 (semibold marks), P3-11 (date and project as menus), P3-12 (local and server halves), P3-13 (rows left out), P3-14 (New private chat), P3-15 (no Get the apps), P3-16 (Share popover with More…), P3-17 (Quick Look from Outputs), P3-18 (failures under the row in Archived Chats; no "Chat restored." toast).

New:

- **P3-25.** When only the server half of Search fails while this Mac is online, the panel lists what this Mac found and says "{Type}: couldn’t be searched right now." for each server type in scope; the web, with one half, shows its error tile. The error tile is kept for a search where both halves failed.
- **P3-26.** The panel's keycaps are the Mac's chords: New chat ⌘N, Toggle sidebar ⌃⌘S, Settings ⌘,, Switch to Dark/Light Mode ⇧⌘L, Keyboard shortcuts ⌘/ (the web prints ⌘⇧O and ⌘⇧S, and no Settings hint). Seam 2 replaces the literals with registry lookups.
- **P3-27.** Recent's Code rows switch the window to Code (the web's Code sessions are not this Mac's local ones); offline, Recent lists this Mac's own workbench sessions, which open directly.
- **P3-28.** The filter chips at rest have no fill (the brief's recipe inside glass); the web's rest chip sits on `--secondary`.
- **P3-29.** The panel's field shows an "esc" keycap at rest; the web has none.
- **P3-30.** The account popover's usage block reads "This week · {n}% used" until the plan route carries `quota` (seam 9); the web reads "Messages {used} / {limit}".
- **P3-31.** Share's More… sits at the foot of the popover in the ready state, so the fixed 232pt frame reads as a footer rather than a gap under the caption.

## New Mac-only copy (copy audit)

Every other visible string is the web's, byte for byte (curly apostrophes and quotes kept; the web's own em dash in "Outputs — {n} in this chat" kept as web copy).

- Panel: "New private chat"; "{Type}: not searched while offline." (Knowledge, Memory, Tasks — Appendix A); "{Type}: couldn’t be searched right now." (P3-25); the "esc" keycap; menu rows "Any Time", "Past Week", "Past Month", "Past Year", "All Projects" (Title Case of the web's words); "Untitled Project" (Title Case in the menu only).
- Share: "More…", "Try Again", "Create a New Link", "Revoke Link" (Title Case of the web's words); help "Share the link another way".
- Account: "Settings…", "Upgrade Plan", "Admin Panel", "Keyboard Shortcuts", "Sign Out" (Title Case); "This week", "{n}% used", "Browse only", "Unavailable" (kept from the Mac's footer until seam 9).
- Archived Chats: "Done"; the accessibility hint "Opens the chat"; the skeleton's label "Loading archived chats".
- Outputs: help "Open {file}" on tiles and upload rows.

## Seams left for the integration (§2.3)

| # | Seam | State on this branch |
|---|---|---|
| 1 | ⌘K → `presentSearchPanel(.commands)` | `DesktopChatWorkspace.presentSearchPanel(_:)` exists; nothing on this base presses ⌘K (Stage A's menu). ⌘K inside the open panel closes it; ⇧⌘F in Commands switches to Search. |
| 2 | Keycap hints | literal (`DesktopCommandCatalog`, `DesktopAccountPopover`) |
| 3 | `Hooks.openNotifications` | nil → "Open notifications" absent |
| 4 | `Hooks.openUpgrade`, the account popover's `openUpgrade` | nil → "Plans & upgrade" and "Upgrade Plan" absent (`DesktopAccountPopoverRows.canUpgrade(planID:)` is ready for the gate) |
| 5 | `Hooks.openPage(DesktopPanelPage)` | nil → Skills, Automations, New automation, Assistants, New assistant, Permissions absent; Designs and New design fall back to `.design`, New agent to the Agents page |
| 6 | `Hooks.openTaskRecord(sessionID)` | nil → Tasks hits without a conversation absent |
| 7 | `DesktopSharePopover` for `.artifact(id)` | built and tested; no artifact surface presents it yet |
| 8 | `showingArchivedChats` | state in the workspace; nothing opens it yet |
| 9 | `DesktopAccountUsage.init(plan:)` | reads today's fields |
| 13 | The theme toggle | B's ⌘K row writes `theme` through `NativeMemorySettingsStore.updateSettings` (`toggleAccountTheme()`); fold with A's ⇧⌘L |

Also for the integration: the shared `Keyboard` icon edit is byte-identical to Stage A's; `MapTrifold` is B's, appended at the end of the generator map and of `JunoIcon`.

## Deferred (explicit)

- Opening a message hit at its message (`?m=`): the conversation opens; scrolling to the message is not built.
- The panel's Tab into the filter row walks the type chips with ← →; the date and project menus are reached with the pointer (or Full Keyboard Access).
- Seams 1–9 and 13 above.
- Deleting `DesktopSearchScreen.swift` and the `.search` branch (integration, §6.3).
- `junoSheetSurface` survivors on the Mac that are not B's: `DesktopSettingsScreen` ×2 (C), the page files (Phase 4), Code's (the Code session).

## Runtime checks left for a person at the screen

⌘K (once wired) and ⇧⌘F / the sidebar's Search: focus in the field, Esc, clicking outside, focus returning to the composer; the panel's glass over a live transcript; a live `/api/search` answer landing under local results without moving the cursor; the filter menus; a real share create, Copy, Revoke and Create a New Link; More…'s share sheet; Outputs' tiles opening the canvas and Quick Look; the account popover's Keyboard Shortcuts opening the window; a restore and a delete in Archived Chats against the server (once seam 8 opens it); the delete confirmation's "Delete failed." path.

## 5-Dimension review (Philosophy · Hierarchy · Craft · Functionality · Originality), from the snapshots

| Surface | Light | Dark | Notes |
|---|---|---|---|
| Panel, Commands | 8 · 8 · 8 · 8 · 7 | 8 · 8 · 8 · 8 · 7 | Floor holds the shape; keycaps as separate caps; one fill for the active row |
| Panel, Search | 8 · 8 · 8 · 8 · 8 | 8 · 8 · 8 · 8 · 8 | Semibold matched words carry the "why"; notices band plain, not rounded |
| Share | 8 · 8 · 8 · 8 · 7 | 8 · 8 · 8 · 8 · 7 | Copy → Copied is the one moving part; one prominent button per state |
| Outputs | 8 · 8 · 7 · 8 · 8 | 8 · 8 · 7 · 8 · 8 | A single output fills the width; excerpts clip like `<pre>` |
| Account popover | 8 · 8 · 8 · 8 · 7 | 8 · 8 · 8 · 8 · 7 | The 18-dot bar is the signature; neutral plan pill |
| Archived Chats | 8 · 8 · 8 · 8 · 7 | 8 · 8 · 8 · 8 · 7 | No prominent button; failures stay with their row |

Fixed before committing (from the first render): matched words drew bold rather than semibold; the notices band took the panel's container shape and rounded its corners; notices repeated the error tile's message; the Share Copy button was shorter than the field; the image tile ignored its 4:3 ratio; code excerpts wrapped and then centred instead of clipping; the account popover's fixed heights left a 30–40pt gap; the archived dates ignored the view's locale.
