# Juno for Mac: Liquid Glass redesign (Chat)

**Status:** proposal, 2026-09-22 · **Basis:** code at `c9cae856`, read only · **Scope:** Chat, with Work merged into it. Code is out of scope, but the shell keeps a place for it. · **Target:** macOS 26.0 deployment target, macOS 27 SDK, Xcode 27 (27A266a). Any API newer than 26.0 is wrapped in `#available`.

**Path shorthand used below**
- `App/` = `native/macOS/JunoDesktop/App/`
- `DS/` = `native/Packages/JunoNativeKit/Sources/JunoDesignSystem/`
- `ChatKit/` = `…/JunoChatKit/`
- `WorkKit/` = `…/JunoWorkKit/`
- `SI` / `SC` = the SwiftUI / SwiftUICore `.swiftinterface` files in `MacOSX27.0.sdk`
- Web paths start at the repo root (`src/…`).

---

## Executive summary

1. The Mac app looks wrong because the code drifted from the web, not because of a taste problem:
   - The canvas colour is typed in by hand at 4% lightness; the web uses a warm charcoal at 11.5%.
   - There are three products, and the switcher shows a "Juno product" label.
   - There are two sidebar toggles.
   - Icons are Lucide.
   - The greeting uses time-of-day copy with an orange name.
   - The composer has glass controls nested inside a glass bar.
2. The web merged Work into Chat in September 2026. The Mac still ships Work as a third product, and it cannot attach a task to a chat: `WorkSessionSummary` has no `conversationID`.
3. 25 recent web feature commits touched no native files. Every sync check still passes, because the checks only compare generated files with their sources. Nothing checks that the Mac uses the generated values.
4. The redesign keeps the web's identity and draws it with native macOS 26 components. That identity is: the information architecture, sidebar order, greeting, composer layout, copy, Phosphor icons plus Juno's own glyphs, the warm palette, and a single coral action.
5. Glass is used for chrome only. The system draws the sidebar, toolbar, menus, popovers and sheets. Juno adds glass in exactly five places: the composer cluster, the ⌘K panel, the find bar, the toast, and Quick Entry. Everything you read sits opaque on the warm canvas.
6. Coral is used only for the send/stop disc, switches, links, the live status dot, and one prominent button per surface. It is never used for selection, the user's name, or glows.
7. The signature detail is a single glass composer centred under "How can I help, *Liam*?". On first send, the same view slides down to its dock.
8. There are six phases:
   1. shell, sidebar, toolbar, empty state and composer
   2. transcript
   3. popovers, menus, sheets and Settings
   4. secondary pages
   5. Work merged into Chat
   6. sync tooling, so that future drift fails CI
9. Phase 1 alone fixes every problem visible in the current screenshot.
10. This document starts from the "hig-native" spec, which scored 33/40. It adds the icon, prose and page-header work from "web-parity" and the single-identity handoff and removal ledger from "minimal-premium". Scoring is in Appendix A.

---

# Part A: Audit

## A1. Why the current Mac app looks wrong

| # | What you see | Cause in code | Fixed in |
|---|---|---|---|
| 1 | The window is near-black and flat | `DS/JunoColors.swift:24-25` points the canvas at the hand-typed `warmBlack` (0.042, about 4% lightness; `DS/JunoDesignTokens.swift:78-82`). The generated `JunoGeneratedColors.background` (#1F1D1C, 11.5%; `DS/Generated/JunoGeneratedTokens.swift:50-53`) is never read. `junoReadingCanvas()` paints that colour opaque over the whole detail column (`App/DesktopChatWorkspace.swift:194`), so the glass has nothing warm to sample. The dark hierarchy is also inverted: the sidebar (8.8%) comes out lighter than the page (4%). | B §1.2, §8.1 |
| 2 | Two sidebar toggles | `App/DesktopChatSidebar.swift:113-130` builds a "Juno" row by hand with its own `.panelLeft` button that calls `toggleSidebar`. The system toggle that `NavigationSplitView` adds is still there. | B §1.4, §2 |
| 3 | "Juno product" wraps onto two lines beside a blue Chat/Code/Work control | `App/DesktopProductMode.swift:55-64` is a segmented `Picker("Juno product")` with no `.labelsHidden()`, at `.controlSize(.large)`, pinned full width in the list inset (`DesktopChatSidebar.swift:70-76`). The selected segment is drawn in the user's system accent: the app's AccentColor asset is graphite, macOS only honours it when the user has chosen Multicolor, and there is no root `.tint`. It still has three cases (`:4-44`). | B §1.4 |
| 4 | "New chat" is highlighted as if it were a place | `App/DesktopNavigationState.swift:14-22` maps an empty draft to `.destination(.chat)`, which is the tag the New chat row carries (`DesktopChatSidebar.swift:52`). | B §2.3 |
| 5 | A monospaced "Recents" label with nothing under it | `Text("Recents").junoCodeSmall()` is a list row, not a section header (`DesktopChatSidebar.swift:59-64`). Pinned and recent chats are concatenated (`:36-46`). There is no empty state. Code sessions also leak into the list, because the store loads both kinds (`NativeConversationStore.swift:268`) and the sidebar never filters by kind. | B §2.1 |
| 6 | A "Design" row at the bottom, "Owner · Pro", and an orange dot | Design is a footer button (`App/DesktopDesignScreen.swift:840-890`). The plan text is the literal `Text("Owner · Pro")` (`App/DesktopCodeAccountFooter.swift:101`). The sync dot shows caution orange whenever sync is running (`:430-466`). Chat passes `plan: nil` (`DesktopChatSidebar.swift:291`). | B §2.7 |
| 7 | Three toolbar capsules and no title | `DesktopChatWorkspace.swift:326-363` declares a New chat + Search group, a fixed spacer, then Share. The title is `.navigationTitle("")` (`:195`). The window uses `.windowStyle(.hiddenTitleBar)` (`App/JunoDesktopApp.swift:138`) together with `.unified` (`:161`). There are nine `junoToolbarMetrics()` calls, and the file's own comment (`JunoDesktopApp.swift:139-160`) says they do nothing. | B §3 |
| 8 | A spinning-arrow glyph, then "Winding down, Liam" with the name in orange italic | `DesktopDraftGreeting` (`App/DesktopChatAura.swift:155-344`) draws the JunoMark (`:199`), picks a random phrase from `JunoGreeting.buckets` (`DS/JunoGreeting.swift:19-42`), colours the name with an accent ink (`:303-326`) and adds halo shadows (`:275-276`). `JunoSerif` returns system sans and ignores its size argument (`DS/JunoSerif.swift:64-100`). The entrance animation never plays because its flags start as `true` (`:176-177`). | B §4 |
| 9 | The composer reads as a dark slab | The whole bar is `junoFloatingChrome` glass (`App/DesktopComposer.swift:431`), and five controls inside it are glass too (`:813, 841, 891, 913, 955`). It is attached with `safeAreaInset` (`DesktopChatWorkspace.swift:629`), so the transcript gets no scroll-edge effect. The canvas under it is opaque. | B §5 |
| 10 | Two microphones side by side | Dictate uses `.mic` (`:908`). The primary button also shows `.mic` when the draft is empty (`:937`), in accent `.glassProminent`. The Lucide set has no waveform glyph. | B §5.3 |
| 11 | "Choose model" | This shows whenever the model catalog hasn't resolved. `modelCatalogErrorDescription` is never read on the Mac. Send and voice are disabled without saying why (`:193, :939`). | B §5.7 |
| 12 | Everything is slightly heavy and slightly off | Icons: 173 Lucide `nav-*` imagesets on a 24pt grid with 2pt strokes (`scripts/generate-native-icons.mjs`), against the web's Phosphor 1px line. Type was never ported: rows are 12pt, captions 10pt, assistant prose 13pt against a 15pt user bubble. The 44pt target gate forces 44×44 frames (`:910, :950`). | B §8 |

## A2. Website features the Mac lacks or diverges on (verified)

Severity: **P0** blocks the redesign or the Work merge · **P1** expected parity · **P2** polish or edge. A2 does not repeat the look-only items from A1.

### A2.1 Shell, navigation, search, shortcuts

| Gap | Web | Mac today | Sev | § |
|---|---|---|---|---|
| Work is still a product | Only Chat and Code (`product-switch.tsx:105-108`). `/work/**` redirects (`src/lib/work-url-migration.ts`). | `.work` with ⌘3 (`DesktopProductMode.swift:4-44`). A Work split view (`JunoDesktopWorkspaceView.swift:144-169`). Quick Entry has a Work segment (`DesktopQuickEntry.swift:141-155, 175`). | P0 | B §1.6, §11 Ph5 |
| "Needs you" fold and run status dots | `app-sidebar.tsx:1199-1208, 1517-1585`. One 6px dot per row (`:2461-2464`). | None. `workModel` is passed in and never read (`DesktopChatSidebar.swift:20`). | P0 | §2.5 |
| Code sessions leak into Chat | Filters by kind (`app-sidebar.tsx:632-635`) | Both kinds are loaded (`NativeConversationStore.swift:268`) | P1 | §2.1 |
| "Pinned projects" section with nested chats | `app-sidebar.tsx:1217-1257, 2558-2741` | Missing. The rename/delete project state (`DesktopChatSidebar.swift:85-110, 242-246`) is never reached. | P1 | §2.3 |
| Row actions: Share, Archive, Add to project, confirm before Delete, Archived chats list | `app-sidebar.tsx:2476-2552, 2744-2880` | Context menu has Pin, Rename (`.alert`), and Delete with no confirmation. Chats archived on the web disappear with no way to restore them. | P1 | §2.4 |
| Contents of the More menu, and More showing as selected | Assistants, Connections, Skills, Automations, Permissions, then Archived chats (`app-sidebar.tsx:1976-1983`) | Connections, Tasks, Memory, Usage (`DesktopChatSidebar.swift:338`). The row is never shown as selected. | P1 | §2.3 |
| Design in the navigation list | Nav row (`app-sidebar.tsx:1087-1100`) | Footer button | P1 | §2.3 |
| Search as an overlay palette | 9 result types, date filter, project filter, recents (`command-palette.tsx:646-989`) | A full page with 5 scopes, no Memory, no filters (`DesktopSearchScreen.swift`) | P1 | §7.4 |
| ⌘K command menu | `command-palette.tsx:997-1307` | Code only (`DesktopCommands.swift:159-164`) | P1 | §7.4 |
| ⌘F find in conversation | `conversation-find.tsx` | Missing | P1 | §6.14 |
| Private chat inline | Header toggle (`private-chat-toggle.tsx`) | A separate window. ⇧⌘N only exists when no workspace window is focused (`DesktopCommands.swift:89-107`). | P1 | §3, §5.8 |
| Share dialog with Copy and Revoke | `share-dialog.tsx` | Copies silently. `shareNotice` is set but never read (`DesktopChatWorkspace.swift:113, 368-386`). | P1 | §7.3 |
| Chat shortcuts | ⌘K, ⌘F, ⇧⌘C, ⇧⌘;, ⇧⎋, ⌘U, stop (`use-global-shortcuts.ts:12-18`) | None of these. ⇧⌘1 (screenshot) collides with the web's ⌘⇧1 (switch to Chat). | P1 | §7.8 |
| System accent shows through Juno controls | Selection is neutral | Blue segments. There is no root `.tint`. | P1 | §0.4, §1.2 |
| Window title | `document-title.tsx` | Hidden title bar, empty title | P2 | §1.3 |
| Offline banner | Covers the content column only | Spans the whole window (`JunoDesktopRootView.swift:116-134`) | P2 | §1.5 |
| AI-set titles cross-fade | `app-sidebar.tsx:2450-2454` | `recentlyRenamedConversationID` is never read | P2 | §2.3 |
| Project indicator on a project's chat | Pill (`chat-view.tsx:2177-2245`) | None | P2 | §1.3 |
| Number of ways to open Settings | One modal | Three: the scene, a sheet, and a destination (`DesktopChatWorkspace.swift:198-218`) | P2 | §7.2 |
| Keyboard Shortcuts window content | 4 groups | Lists Work, "⌘↩ Send" and an unreachable ⇧⌘N (`DesktopShortcutsWindow.swift:38-77`) | P2 | §7.9 |

### A2.2 Composer

| Gap | Web | Mac today | Sev | § |
|---|---|---|---|---|
| "Do this as a task", "How often it asks", run disclosure line, delegation offer | `composer.tsx:3077-3099, 3982-4027` | Missing. Delegation only happens in the Work product, with different labels (`DesktopWorkWorkspace.swift:1765-1771`). | P0 | §5.4, Ph5 |
| Armed tools shown as marks in the field | `composer-shell.tsx:251-431` | Only an accessibility value (`DesktopComposer.swift:682-690, 819`) | P1 | §5.5 |
| `+` menu structure, order and copy | Three groups, no headings (`composer-plus-menu.tsx:218-412`) | Headed sections in a different order. No screenshot, skill, task or memory rows. | P1 | §5.4 |
| The "Canvas & artifacts" toggle does nothing | Removed on the web. The server defaults to on (`route.ts:2070`). | Sends `nil` when off, which the server reads as on (`DesktopComposer.swift:727-729, 1158`) | P1 | §5.4 |
| Skills: "Use a skill", `/slug`, `skillSlug` | `composer.tsx:2976-3039`, `request.ts:147` | Missing from the composer and the wire format | P1 | §5.4, Ph4 |
| Two-stage model popover, thinking panel inside it, Favorites | `model-selector.tsx`, `model-catalogue.tsx` | Opens the full catalog directly. Thinking is a separate chip. Flash and Pro have no UI (`:875-899`). | P1 | §5.7 |
| Image and video models can't be chosen | Text, Image and Video sections | `.filter(\.isChatCapable)` (`NativeConversationStore.swift:1513`) | P1 | §5.7 |
| Attachment thumbnails and file cards | 64px tiles, 224px cards (`composer-shell.tsx:771-937`) | Filename pills (`DesktopComposer.swift:1545-1601`) | P1 | §5.6 |
| Drag-and-drop and paste of files | `composer.tsx:2276-2285, 3342-3386` | Missing | P1 | §5.8 |
| Dictation inside the composer | `dictation-swap.tsx` | A floating capsule with a glow and uppercase text (`DesktopDictation.swift:37-274`) | P1 | §5.8 |
| Preflight clarifying questions | `use-chat.ts:1385-1440` | Never calls `/api/chat/clarify` | P1 | §5.6 |
| Steering and stopping a running research or task | `chat-view.tsx:1916-1977` | Missing. Stop only cancels the stream. | P1 | §5.8, Ph5 |
| `/` and `@` palette | `composer.tsx:327-583` | Missing | P1 | §5.9 |
| Quote chip (Ask/Modify) and `artifactEdit` | `composer.tsx:3404-3467` | Seeds a plain sentence instead (`DesktopArtifactCanvas.swift:764-770`) | P1 | §5.6 |
| One composer implementation | One `ComposerShell` | Five implementations (Chat, Incognito, Work home, Work thread, Quick Entry) | P1 | §5.1 |
| Deep research depth label, Memory row, connector logos and "Manage", "New project", "New chat in {Project}" chip | `composer.tsx:2837-2961, 3100-3114, 3247-3321` | Partial or missing | P2 | §5.4 |
| Keys: Esc, ⌘U, ↑ to edit, queue while streaming | `composer.tsx:1238-1251, 2262-2268, 2538-2550` | Missing. Return is swallowed while a reply streams. | P2 | §5.9 |
| Placeholders that change with context, quota banner, long-paste copy | `composer.tsx:884-895, 3265-3292, 3469-3574` | Fixed placeholder "Message Juno". No quota handling. Copy drifts. | P2 | §5.8 |
| Voice call bar: interrupt button, reasoning setting | `realtime-voice.tsx:179-190, 273, 351` | Missing. Two shadows sit on the glass (`DesktopVoice.swift:456-457`). | P2 | §5.8 |

### A2.3 Transcript

| Gap | Web | Mac today | Sev | § |
|---|---|---|---|---|
| Sent attachments and generated images/videos | `message-item.tsx:197-260, 406-441` | Never rendered. `NativeChatMessage.attachments` is not read. | P0 | §6.2 |
| Work runs shown inside the conversation | `work-run-panel.tsx`, `chat-view.tsx:2384-2390` | Missing | P0 | §6.8, Ph5 |
| Message action row | 5 ghost controls. The newest reply's row is always visible (`message-item.tsx:1277-1445`). | 8 flat glass buttons, shown on hover only (`DesktopChatWorkspace.swift:1617-1672`) | P0 | §6.10 |
| Activity strip and Thought panel; activity stored per message | `activity-timeline.tsx`, `thought-process-panel.tsx` | Transient state for the whole conversation (`NativeConversationStore.swift:953, 1709`). No panel. | P1 | §6.6 |
| Stream status: clock and progressive copy, no shimmer | `message-item.tsx:106-189` | Static "Thinking about your request" with shimmer | P1 | §6.6 |
| Resume a dropped stream | `use-chat.ts:741-778` | Missing | P1 | §6.15 |
| Scroll follows only at the bottom; "Scroll to latest" | `message-list.tsx:150-425` | Jumps to the bottom on every token (`DesktopChatWorkspace.swift:1069-1098`) | P1 | §6.13 |
| Sources pill with favicons; inline `[n]` citations | `sources-pill.tsx`, `markdown.tsx:238-340` | A disclosure inside a card. `[n]` shows as literal text. | P1 | §6.7 |
| Research run card and report reader | `research-run-panel.tsx` | Missing | P1 | §6.8, Ph5 |
| Approval card sits above the answer it blocks, with "Deny" first | `approval-card.tsx` | Placed below the transcript, "Allow" first, full-width glass (`NativeChatApprovalView.swift:83-130`) | P1 | §6.9 |
| Finish notes; errors that aren't boxed | `message-item.tsx:1061-1072, 1143-1161, 1239-1262` | No finish notes. Errors are a `GroupBox` inside a card (`:1954-2007`). | P1 | §6.11 |
| Follow-ups docked above the composer; clicking sends | `follow-up-suggestions.tsx` | In the transcript. Clicking only fills the draft. | P1 | §6.12 |
| Inline artifact card with Preview/Code/Console; canvas features (versions, export, fullscreen, widths, saved edits) | `artifact-inline-card.tsx`, `canvas-panel.tsx` | A tile with "Open". Canvas edits are never saved. | P1 | §6.8, Ph4 |
| Mermaid renders | `markdown.tsx:196-222` | The engine is never registered, and no `mermaid.min.js` ships | P1 | §6.5 |
| Code blocks: highlighting, one selectable text, 520pt cap, gutter at 8+ lines | `markdown.tsx:188-226` | One colour, one `Text` per line, gutter always on (`DS/JunoAIcssCode.swift:15-87`) | P1 | §6.5 |
| Citation audit, `juno-visual` fences, tail fade instead of a caret, user-bubble details, per-reply cost footer | various | Missing or divergent | P2 | §6 |

### A2.4 Work merged into Chat (items not already listed above)

| Gap | Web | Mac today | Sev | § |
|---|---|---|---|---|
| A Work session can be linked to a conversation or project | `src/app/api/work/sessions/route.ts:245-263, 333-339` | No fields in `WorkKit/WorkContracts.swift:168-197`, `NativeWorkClient.swift:341-409`, or OpenAPI (`juno-native-v1.yaml:771-790, 2500-2517`) | P0 | Ph5 |
| Task approval card | Verb button; "Change it"; "Make all N" | Return approves (`DesktopWorkWorkspace.swift:4011-4110`). No verb, no amend, no batch. There is also a shadow and a tint. | P1 | §6.9 |
| Legacy Tasks page and inspector | `/tasks` redirects to `/automations` | Still in More, backed by `/api/tasks` (`DesktopTasksScreen.swift`, `DesktopChatWorkspace.swift:84-95, 218`) | P1 | §1.7 |
| Automations as one page | `src/app/(app)/automations` | Split between Work Automations and Schedules | P1 | §9 |
| Permissions hub | `src/app/(app)/permissions` | Only this Mac's tile, inside Work or Settings › Code | P1 | §9 |
| Skills pages | `src/app/(app)/skills/*` | An empty page that links out (`DesktopWorkWorkspace.swift:1202-1218`) | P1 | §9 |
| Notification when a task needs you | `use-needs-you-count.ts:170-230` | No `UserNotifications` and no dock badge | P1 | §7.11 |
| Project Tasks tab and task defaults; "Save as a skill"; Tasks scope in search; delegation offer | various | Missing | P2 | Ph5 |

### A2.5 Secondary pages and global overlays

| Gap | Web | Mac today | Sev | § |
|---|---|---|---|---|
| One page template (header is the page's own name, lede, rule, controls row) | `app-page-header.tsx`, `app-page.tsx` | Every page builds its own. Headings like "Your files", "Connect your tools", and a mono "MEMORY". | P0 | §9 |
| Chat toolbar appears on pages | Chat only | A disabled Share and other chat items show on every page (`DesktopChatWorkspace.swift:196`) | P1 | §3 |
| Settings rows: text size, greeting name, reasoning/fast/web defaults, voice preview, dictation, import, Juno package export, delete all, 2FA/password/email, editable name and photo, spend ceiling | `src/components/settings/sections/*` | Missing | P1 | §7.2 |
| Plan & billing and Upgrade | `billing.tsx`, `upgrade/page.tsx` | No way to upgrade. The Usage page is embedded in Settings. | P1 | §7.2 |
| Settings panes embed whole pages | Compact forms | Connectors and Billing embed full pages (`DesktopSettingsScreen.swift:139-179`) | P1 | §7.2 |
| Account menu: plan pill, usage block, Profile, Admin | `user-menu.tsx:177-265` | Missing | P1 | §2.7 |
| Library: file actions, Recently deleted, versions, open source chat | `library/page.tsx` | Edit Image, Copy name, Refresh only | P1 | §9 |
| Projects: tabs, Pinned filter, covers | `projects/[id]/page.tsx:780-795` | Overview/Workspace/Assistant tabs | P1 | §9 |
| Artifacts open in the chat's canvas; Share; New design | `artifacts/page.tsx` | Open as a standalone page | P1 | §9 |
| Memory: topics, recap, edits, backfill, import | `memory-manager.tsx` | Only `/api/memory` | P1 | §9 |
| Connections: page name, "Use in chats" | `connections/page.tsx` | "Connect your tools". No toggle. | P1 | §9 |
| Assistants | `assistants/page.tsx` | Missing | P1 | §9 |
| One toast recipe; no glass inside sheets | `sonner.tsx` | Five per-screen glass toasts, one of them inside the Settings sheet (`DesktopSettingsScreen.swift:448-466`). The glass gate misses all of them. | P1 | §7.7, §8.7 |
| Rename and delete presentation; Compare; Roadmap; onboarding; announcements | various | Inconsistent or missing | P2 | §7, §9 |

### Unverified items and corrections to the reader reports

- **Unverified:** Quick Entry and the menu-bar extra call `openWindow(id: mainID)` on a `WindowGroup` (`DesktopQuickEntry.swift:240`, `DesktopMenuBarExtra.swift:46, 64, 83`). This probably opens a new window on each send. The code was read, not run.
- **Unverified, gated in Phase 1:** whether a toolbar-hosted `.segmented` or `.tabs` Picker draws its selected segment neutral when the system accent is Blue.
- **Unverified, gated in Phase 1:** whether `toolbarItemHidden` flips stay clear of the constraint crash (crash rule 3 in `docs/native/MACOS_CRASH_ROOT_CAUSE.md` says to use "always present and `.disabled()`").
- **Unverified, gated in Phase 1:** how `navigationTitle(_: Binding<String>)` (SI:24641, macOS 13) and `toolbarTitleMenu` (SI:25449, macOS 13) behave together on macOS. Both APIs exist; the rename interaction needs a check.
- **Unverified:** what `Glass.interactive()` looks like on macOS 26. AppKit's `effectIsInteractive` only arrived in 27.
- **Corrected:** the task approval button does not show a raw localization key. `App/../project.yml:57` ships the shared `Localizable.xcstrings`, and `work.approval.allow-always` resolves to "Always allow this" (checked in this pass). The real defect is that Return approves.
- **Corrected:** research runs in chat do not stall at the plan. The chat path confirms automatically (`src/lib/research/engine.ts:1550, 1678-1679`). The gap is the missing run panel and steering.
- **Corrected:** the global accent is set (`native/Config/JunoDesktop-*.xcconfig:8`). The asset is graphite, and the blue comes from the user's system accent.
- **Corrected:** web chat rows have no hollow bullet. That was a stale comment; the code draws a trailing dot or pin (`app-sidebar.tsx:2455-2473`).
- **Corrected:** Mermaid is not "implemented". It always falls back to showing the source.

## A3. Web design changes the Mac hasn't picked up

| Area | Web now | Mac now | Action |
|---|---|---|---|
| Neutrals | Generated warm ramp, r ≥ g ≥ b. Dark canvas 11.5%, card 14%, popover 16.5% (`globals.css:57-607`). | Hand-typed canvas; neutral black/white alphas (`DS/JunoSurfaces.swift:26-63`) | Generate everything (§8.1) |
| Accent | Coral by default, switchable. `--primary-ink` for accent text. Never on the focus ring, selection or the greeting. | No root tint. `primaryInk` is generated but has no accessor. Accent is used for decoration (greeting name, dictation glow). | §0.4, §8.1 |
| Sidebar selection | Fill plus a 1px inset edge; the edge is what shows selection (`9d0c6693`, `e21d96ce`). Radius 10. | Fill only, radius 8 (`DS/JunoDesktopChrome.swift:159-165`) | §2.6 |
| Type | Inter, Newsreader for greeting and wordmark only, JetBrains Mono. Ladder in `tailwind.config.ts:280-431`. Sentence case. Label tracking 0.01em. | Mapped to semantic macOS styles; not generated | §8.2 |
| Icons | Phosphor 256 grid, regular weight, bold at ≤13px, fill means "on" (`4256d9ca`). Juno glyphs JunoChat/Code/Design/Send (`5b2187c8`). Part-motion hover and IconSwap (`7ff8af0b`). | Lucide, 2pt stroke | §8.6 |
| Composer | Armed marks inside the field (`893c4514`). Voice face in the send slot (`321b4e2a`). Bold Juno Send. Thinking inside the model popover. | See A2.2 | §5 |
| Menus | One menu recipe (`b3f580c6`) | Mixed. 29 deprecated `.borderlessButton` triggers. | §7.1 |
| Flat UI | Opaque floating layers, no glow, `.composer-aura` removed (`1eeced52`) | Auras and glows remain | §0.1. On Mac the floating layers are system glass, a deliberate difference (§0.8). |
| Motion | One motion ladder (`35a2031f`). press/fast/exit use generated curves. rise-in is 220ms outSoft. | `.easeOut`/`.easeIn`. `riseIn` is outStrong over 360ms (`DS/JunoDesignTokens.swift:215-250, 349`). | §8.5 |
| Layout | Gutter 16/24/32 based on the container. Sidebar 224–336. Transcript measure 768. | Fixed 32 gutter. Sidebar 208/264/380. | §8.3 |
| Empty chat | "How can I help, *Name*?" plus four starter chips | Time-of-day greeting, no chips | §4 |
| Work → Chat (`3e015f98`, `ff3963ec`, `TWO_PRODUCTS.md`) | Tasks are chats. Work pages moved under More. `/tasks` redirects to `/automations`. | Separate product | Phase 5 |
| Radius aliases and concentric rule | control 10 / menu 14 / panel 20, enforced by an eslint rule | Missing aliases | §8.4 |
| Component recipes | Empty state (dashed well), toast, segmented control, skeleton breathe | 72pt circle plate, shimmer skeleton, two segmented idioms | §7, §9 |

## A4. How web and Mac drifted, and how to keep them in sync

**What exists.** Every check passes except `design:editor:check`, which is stale today:
- `design:tokens:check`, `design:contract:check`, `capabilities:check`, `work:contract:check`, `native:contract:check`, `native:design:check`.

**Why none of it caught the drift:**
1. Each check proves that a generated file matches its source. None proves the Mac *reads* the generated values. For example, `warmBlack` overrides the generated background and nothing fails.
2. The icon generator has no `--check` mode and no CI step. It still emits Lucide.
3. The OpenAPI gate hashes the YAML and looks for 23 operation names. Meanwhile:
   - `NativeChatGenerationRequest` allows exactly 6 fields (`additionalProperties: false`), but the Mac sends 12.
   - About 47 of the roughly 90 paths the Mac calls aren't in the contract at all.
4. Nothing represents layout or information architecture. The Work merge and the move of Design into the nav list changed no file the Mac depends on.
5. The Design editor bundle is only checked in `release-ios.yml`. It is stale now: built at `2fa09d35`, source last changed at `7ff8af0b`.

**Web commits since the merge decision that touched no native files:** `b58ff71a 86f773a9 a82038be c0bd4d1d acc32c6d e4410a60 0c5507a3 1b4c0fa2 05f4e82b 353688c7 7b197d09 415f0907 fd449001 2853c43f e0bee7df 232d3bf7 0691f02d 5ae4efe9 da88acb4 321b4e2a 4256d9ca 5b2187c8 7ff8af0b c8100b09 04914a59`.

**How to keep them in sync from now on** (built in Phase 6; the cheap items can land earlier):

1. **Consumption tests.** A Swift test asserts that every `Color.juno*` equals its `JunoGeneratedColors` pair, and that `JunoType` sizes equal the generated ladder. Hand-typed tokens get deleted.
2. **A shell contract.** Add `contracts/product/juno-shell-v1.json`, built like the capabilities and Work contracts. It holds:
   - products;
   - sidebar rows and their order;
   - section labels;
   - More items (with the plan that unlocks each);
   - `+` menu groups and rows;
   - primary action faces;
   - Settings sections;
   - the icon concept for each item.

   It generates the Swift enums (`DesktopDestination`, `DesktopProductMode`, composer tool cases, Settings sections). A TypeScript test asserts that `app-sidebar.tsx`, `composer-plus-menu.tsx` and `settings-sections.ts` match it.
3. **Icons from the web's registries.** `generate-native-icons.mjs` reads `src/lib/app-icons.ts`, `icons.tsx` and `juno-glyphs.tsx`. It gets a `--check` mode, a CI step, and a Swift test that every `JunoIcon` case has an asset and every asset has a case.
4. **A field-level wire schema.** Project `chatBodySchema` (`src/lib/chat/request.ts`) and the stream event union to JSON Schema, the way `z.toJSONSchema` is already used for Design. Each field carries `native | planned | web-only`, and CI fails on unclassified fields such as a new `skillSlug`. Generate the Swift request and response types.
5. **A parity ledger.** `contracts/parity/features.json` classifies every `src/app/api/**/route.ts` and `src/app/(app)/**/page.tsx`. Unclassified entries fail CI. `docs/native/PARITY_MATRIX.md` becomes generated output, and the old tables move to `docs/native/archive/`.
6. **Close the CI gaps.** Add `design:contract:check` and `design:editor:check` to `native.yml`. Add CODEOWNERS entries or a required "native: done / n/a" label for `src/lib/chat/request.ts`, `src/app/api/chat/**`, `app-sidebar.tsx`, `app-icons.ts`, `icons.tsx` and `globals.css`.
7. **Drive lists from the server where possible.** The model catalog already works this way: Opus 5.5 reached the Mac with no Swift change. Extend `/api/v1/bootstrap` to serve the composer tools, the enabled skills and the More items for the account's plan.
8. **Paired screenshots on each relevant PR.** Capture the same states in Playwright (web) and XCUITest (Mac) with the seeded account (`scripts/seed-e2e-user.ts`): empty chat, a conversation, the sidebar, the `+` menu, the model popover. Light and dark, with the Mac's system accent set to Blue. Show them side by side as a review aid, not a pixel diff.
9. **A register of deliberate differences.** Every intentional web/Mac difference is listed in `docs/native/WEB_TO_NATIVE_DESIGN.md` (seeded from §0.8). Any difference not on that list is drift.

## A5. Mac-only features: keep or drop

| Feature | Where | Decision | Where it lives after the redesign |
|---|---|---|---|
| Quick Entry (⌥Space) | `DesktopQuickEntry.swift` | **Keep** | Uses the `JunoComposerShell` and the Chat/Code switch. Brings the existing window forward. |
| Menu-bar extra | `DesktopMenuBarExtra.swift` | **Keep**, Chat first | New Chat, chats that need you, live Code sessions |
| "Update ready" row | Footer | **Keep** | Sidebar footer |
| Offline encrypted local search index | `DesktopSearchScreen.swift` | **Keep** | Offline engine for the ⌘K panel |
| "My documents" local grounding | `DesktopComposer.swift:67-81, 1185-1230` | **Keep** | `+` menu toggle plus an armed mark (replaces the caption line) |
| Running tasks on this Mac (host, run host, executor, grants, `decideLocally`) | `DesktopWork{Host,RunHost,ExecutorAdapter,Grants}.swift` | **Keep**. This is the Mac's reason to exist. | More › Permissions, and local blockers shown in the run card |
| Keyboard Shortcuts window | `DesktopShortcutsWindow.swift` | **Keep**, generated | Help › Keyboard Shortcuts ⌘/ |
| Settings search, Diagnostics, About/updates | Settings | **Keep** | Settings › General |
| Artifact "Open in New Window" | Artifacts | **Keep** | Artifact context menu |
| Artifact version history on a standalone page | `DesktopArtifactsScreen.swift:989-1125` | **Move** | Canvas dock |
| "What Juno noticed" on-device proposals | Settings › Memory | **Merge** | Edits queue on the Memory page |
| Library "Add Document" local index | `DesktopLibraryScreen.swift:44-51, 322-420` | **Keep** | An "On this Mac" filter in Library |
| "Edit Image…" | Library | **Keep** | Library context menu, and hover on a generated image |
| Usage destination | More | **Drop** as a destination | Settings › Account (stats, heatmap) and Plan & billing (meters) |
| Tasks (`/api/tasks`) and its inspector | More | **Drop** | Automations |
| Work Inbox, bucketed sidebar, Schedules, Work home, Work thread tabs, mid-run context editor | `DesktopWorkWorkspace.swift` | **Drop** | The Needs-you fold, status dots, the run card |
| Pause / Resume / Try Again on a task | Work thread | **Keep** | The run card's overflow menu |
| Choosing where a task runs | Work home | **Drop** (runs automatically) | Shown only on the disclosure line, until the web adds a choice back |
| ```` ```chart ```` fences (Swift Charts) | `JunoChartMarkup.swift` | **Keep dormant**. The server never prompts for them. | Decide for both platforms in the shell contract |
| `autoRouteModel` preference | `DesktopComposer.swift:62-66` | **Drop** | The Auto model covers it |
| Aura, provider glow, composer aura | `DesktopChatAura.swift`, `JunoComposerAura`, `JunoProviderGlow` | **Drop on Mac**. Keep the package code, because iOS still uses it (`JunoMobileGreeting.swift`). | — |
| Canvas "Select component → Edit" | `DesktopArtifactCanvas.swift:748-775` | **Replace** | The quote chip (Ask/Modify) |
| Separate Incognito window | `DesktopIncognito.swift` | **Drop** | Private mode inline in the same window |
| Streaming caret | `JunoMarkdownView.swift:166-206` | **Drop** | A fade on the last line |
| Spring `platformFactor` 0.75 | `DS/JunoDesignTokens.swift:252-265` | **Keep** | Record it in `motion.ts` and `ICONS_AND_MOTION.md` |
| Settings › Code section | `DesktopSettingsWindow.swift` | **Keep** until Code's own redesign | The Work host tile moves to Permissions |

---

# Part B: Native redesign spec

## 0. Ground rules

### 0.1 Two layers, and no third

**Chrome is Liquid Glass, and the system draws it:**
- the sidebar pane
- toolbar item groups
- menus and context menus
- popovers
- sheets
- alerts

**Juno adds glass in exactly five places.** Each is allow-listed in the glass gate (§8.7):

1. **The composer cluster.** One `GlassEffectContainer` holding the composer shell, the follow-up chips and "Scroll to latest".
2. **The ⌘K / Search panel.**
3. **The find bar.**
4. **The toast host.** It also serves as Library's multi-select action capsule.
5. **The Quick Entry panel.**

**Content is opaque, on the warm canvas:** the greeting, starter chips, transcript, bubbles, cards, code, tables, message actions, rows, pages, docks and empty states. There is no glass inside a sheet and no glass on top of glass.

### 0.2 Identity comes from the web

- the warm paper and warm charcoal ground
- one coral action per surface
- Newsreader for the greeting only
- Phosphor glyphs plus the Juno marks
- the web's information architecture: sidebar order, More contents, the Needs-you fold, `+` groups, inline run cards
- the web's copy, verbatim

### 0.3 Behaviour comes from macOS

- System sidebar metrics and selection mechanics
- System toolbar grouping
- Native `Menu`, `.popover`, `.sheet` and `.confirmationDialog`
- A `Settings` scene
- A real window title
- Menu-bar commands for every toolbar action
- Pointer-sized controls

### 0.4 Accent budget

Coral (`junoAccent`) is used only for:
- the send, stop and busy disc
- Toggle on-tracks, sliders and progress
- at most one `.borderedProminent` button per sheet, page or card
- links and accent text (`junoAccentInk`)
- the live status dot

It is never used for:
- selection
- the greeting name
- toolbar glyphs
- marks or chips
- glows or any decoration

`.tint(Color.junoAccent)` is applied **below** the view that declares the toolbar (§1.2), so toolbar symbols stay monochrome.

### 0.5 Crash rules (`docs/native/MACOS_CRASH_ROOT_CAUSE.md`), kept in full

1. Only one `NavigationSplitView` exists at a time. Product swaps are instant; only the existing veil animates.
2. Every anchored popover and overlay panel declares an explicit `.frame`.
3. Toolbar items are declared once, unconditionally.
   - **Amendment, subject to a gate:** visibility may change through `toolbarItemHidden(_:)` (macOS 15, SI:3057-3063). This flips a flag on an item whose identity never changes.
   - Phase 1 reruns the documented repro: sidebar toggles, 50 Chat↔Code swaps, and every hidden-flag flip, each with a popover open.
   - If that fails, those items fall back to always-present plus `.disabled()`.
   - Update the crash doc once the gate passes.

### 0.6 Sizes

- **Content** uses the web's pixel values as points: prose, bubble and composer field at 15pt; the greeting at 32–48.
- **Chrome** uses Mac metrics: 13pt UI text (the same as the web's `ui` rung), system sidebar and toolbar metrics, and **28pt pointer controls** with `.contentShape` covering the hit area.
- There are no 44pt frames on the Mac. The skill's 44pt rule is for touch; `check-native-targets.mjs` becomes platform-aware (§8.7).

### 0.7 Copy

- Content copy is the web's copy, verbatim and in sentence case.
- Native menus, the menu bar and sheet buttons use **Title Case**, the macOS convention. Only the capitalisation changes, never the words.
- There is no uppercase anywhere.

### 0.8 Register of deliberate differences (seed for `WEB_TO_NATIVE_DESIGN.md`)

1. Floating layers use system glass. The web makes them opaque on purpose. This applies to the five custom glass sites and to system chrome.
2. The sidebar hides completely with ⌃⌘S. There is no 64pt rail.
3. The chrome shows no wordmark. The traffic lights and the system toggle occupy that strip.
4. Products are ⌘1/⌘2. The web uses ⌘⇧1/2 because browsers reserve ⌘1–8.
5. Menus are Title Case.
6. The window title, subtitle and title menu are the system's, replacing the web's header h1 and floating project pill. The title does not cross-fade in the titlebar.
7. Search and ⌘K are one panel. The web has two palettes.
8. Icons don't articulate on hover. Only state swaps animate.
9. The composer is one glass shell. The web's is an opaque card with a hairline and shadow.
10. Controls are 28pt. The web's are 32px.
11. Springs are multiplied by 0.75.
12. Settings is its own window. The web uses a modal.
13. Mac-only features are listed in A5.

---

## 1. Window and scene structure

### 1.1 Scenes (`App/JunoDesktopApp.swift`)

```swift
WindowGroup(id: JunoDesktopWindow.mainID) {
    JunoDesktopRootView(...)
        .frame(minWidth: 820, minHeight: 560)                // was 900×620 (:127)
}
.defaultSize(width: 1240, height: 800)
.windowResizability(.contentMinSize)
.windowToolbarStyle(.unified)                                // keep (:161)
.windowBackgroundDragBehavior(.enabled)
// DELETE .windowStyle(.hiddenTitleBar)                      (:138)
.commands { JunoDesktopCommands() }                          // §7.8

Settings { DesktopSettingsWindow(...) }                      // the only settings surface (§7.2)
Window("Keyboard Shortcuts", id: JunoDesktopWindow.shortcutsID) { DesktopShortcutsWindow() }
WindowGroup("Report", id: "research-report", for: String.self) { ResearchReportWindow(id: $0) } // Phase 5
CodePreviewScene()                                           // untouched
MenuBarExtra { DesktopMenuBarExtra(...) } label: { ... }     // §7.10
// DELETE Window("Incognito") (:178-184): private chat is inline
```

### 1.2 Root composition and split view (Chat)

```swift
NavigationSplitView(columnVisibility: $columns) {             // the ONLY live split view
    ChatSidebar()                                              // List(.sidebar); system floating glass pane
        .navigationSplitViewColumnWidth(min: 224, ideal: 304, max: 336)   // web SIDEBAR_DEFAULT = 304
} detail: {
    ChatDetail()                                               // declares the stable toolbar (§3) ...
}
.containerBackground(Color.junoCanvas, for: .window)           // the only placement macOS has (SI:16304-16339)
.overlay { JunoOverlayHost() }                                 // ⌘K panel + toast, explicit frames

struct ChatDetail: View {                                      // stable container; switches destinations inside
    var body: some View {
        DestinationContent()                                   // chat column + trailing dock, or a page
            .tint(Color.junoAccent)                            // tint applied BELOW the toolbar owner
            .toolbar { ChatToolbar() }                         // toolbar items inherit no tint (§0.4)
    }
}
```

- **Sidebar metrics.** `JunoSidebarMetrics` (`DS/JunoDesktopChrome.swift:45-49`) changes from 208/264/380 to **224/304/336** (web `SIDEBAR_DEFAULT` is 304, `app-shell.tsx:49`).
  - Nothing paints the sidebar column: no `scrollContentBackground` fill, and no row backgrounds apart from the selection (§2.6).
- **Detail background.** Delete `junoReadingCanvas()` on the detail (`DesktopChatWorkspace.swift:194`). The window paints the canvas once, so the transcript can scroll under the toolbar and the glass has something warm to sample.
- **Detail layout.** `HStack(spacing: 0) { ChatColumn; TrailingDock }`.
  - `TrailingDock` generalises `DesktopArtifactDock` so it holds Canvas **or** Thought process, one at a time.
  - Width: minimum 400, ideal 480, maximum 60% of the detail column. Width is saved per panel (`@AppStorage("dock.canvas.width")`, `"dock.thought.width"`).
  - The chat column keeps at least 480pt.
  - When the detail column is narrower than 800pt, an open dock replaces the chat column (the web's `@container/split` rule).
  - It is not an `.inspector`, per the crash note at `DesktopArtifactCanvas.swift:20-29`.
- **Collapsing.** The sidebar hides fully (`.detailOnly`). Column visibility stays persisted, as at `DesktopChatWorkspace.swift:233-252`.

### 1.3 Window title, subtitle and title menu

```swift
.navigationTitle(titleBinding)                  // SI:24641 (macOS 13); setter = rename
.navigationSubtitle(projectName ?? "")          // project chats; replaces the web's floating project pill
.toolbarTitleMenu { ConversationTitleMenu() }   // SI:25449 (macOS 13); saved chats only
.toolbar(removing: isPage ? .title : nil)       // pages draw their own header (§9); macOS 15
```

- **Title text by state:**
  - Draft: "New chat" (`DesktopNavigationState.windowTitle`, covered by `DesktopNavigationStateTests.swift:184-194`), so the Window menu and Mission Control never show a blank name.
  - Saved chat: the conversation title.
  - Private chat: "Incognito chat" (web copy).
  - Page: the page name. It is used by the Window menu, Mission Control and ⌘\`, but hidden in the toolbar.
- **Title menu items (Title Case):** Rename…, Pin/Unpin, Add to Project ▸, Open Project (only for project chats), Share…, Archive, Divider, Delete….
- **Phase 1 check:** confirm how the binding title renames on macOS. If it doesn't rename inline, "Rename…" starts the inline rename on the sidebar row.
- **Delete:** `DesktopNavigationState.windowTitle` (`DesktopNavigationState.swift:57-63`, unused) becomes the title source, replacing `.navigationTitle("")` at `:195`.

### 1.4 Chat/Code switch

```swift
// Attached to ChatSidebar, so it lands in the sidebar's segment of the unified toolbar.
ToolbarItem(placement: .primaryAction) {
    Picker("Product", selection: $product) {
        Label("Chat", image: product == .chat ? .junoChatFill : .junoChat).tag(DesktopProductMode.chat)
        Label("Code", image: product == .code ? .junoCodeFill : .junoCode).tag(DesktopProductMode.code)
    }
    .labelsHidden()
    .junoProductPickerStyle()   // if #available(macOS 27, *) { .pickerStyle(.tabs) } else { .pickerStyle(.segmented) }
    .help(product == .chat ? "Chat  ⌘1" : "Code  ⌘2")  // one .help per segment in the Label
}
```

- **The sidebar strip holds:** traffic lights · system sidebar toggle · flexible space · the switch. There is no `DefaultToolbarItem` override, no wordmark, and no second toggle.
- **`.tabs` on 27** (SI:16644-16655): VoiceOver announces the segments as tabs, which is the right semantic for a mode switch.
- **Fill glyph** means "on", which is the web's rule.
- **Phase 1 gate:**
  - With System Settings › Appearance › Accent set to **Blue**, the selected segment shows no blue.
  - The switch renders in the sidebar strip, not in the detail toolbar.
  - **Fallback:** two icon-only `Button`s in one `ToolbarItemGroup`. Selection is shown only by the fill cut and primary ink. There is no custom thumb inside the toolbar glass.
- **Shortcuts:** View › Chat ⌘1 and View › Code ⌘2.
- **Swapping:** Code keeps `DesktopCodeWorkspace` until its own redesign, but hosts the same switch component in the same position.

### 1.5 Offline state

- Delete the full-window banner (`App/JunoDesktopRootView.swift:116-134`).
- Offline becomes one 28pt caption row at the top of the chat column, inside the column's `safeAreaBar(edge: .top)`, stacked above the find bar when both show.
  - Text: "Offline · messages send when you're back", 12pt `junoSecondaryInk`, no fill.
- The footer sync mark (§2.7) carries the same state on every destination.

### 1.6 Temporary Work access (Phases 1–4 only)

- Phase 1 removes Work from the switch, ⌘3, Quick Entry and the Shortcuts window.
- So that people with tasks already running can still answer approvals, the old workspace stays reachable from **Window › Tasks (Legacy)**, with no shortcut.
  - It swaps in exactly like a product: instant, and only one split view is live.
  - `DesktopProductMode` keeps a hidden `.legacyWork` case for this.
- Phase 5 deletes the menu item, the case and `DesktopWorkWorkspace.swift`.
- **Done in Phase 5 Stage D (2026-09-25).** The menu item, `.legacyWork`, `DesktopShellActions.openLegacyTasks` and the old workspace are gone; a stored `"work"` restores to Chat. What still runs tasks on this Mac stays (`DesktopWorkHost`, `DesktopWorkRunHost`, `DesktopWorkExecutorAdapter`, `DesktopWorkGrants`, `DesktopWorkVocabulary`, `DesktopWorkSettings.swift` with the host tile, and `DesktopWorkAutomations.swift`, unreferenced until track B ports it). A task with no conversation opens in a sheet from Search › Tasks or a notification (register #63; Stage D notes in the Phase 5 errata).

### 1.7 Removal ledger

| Removed | Where it lives today | Replaced by |
|---|---|---|
| Work as a product: the segment, ⌘3, Product-menu items, Shortcuts rows, Quick Entry segment, errand routing | `DesktopProductMode.swift:4-64`, `JunoDesktopWorkspaceView.swift:81-87, 144-169`, `DesktopCommands.swift:153-157, 214-228, 274-280`, `DesktopShortcutsWindow.swift:40, 72-76`, `DesktopQuickEntry.swift:141-155, 175` | The Chat/Code switch. Errands open an ordinary chat (Phase 5 errata). The legacy menu item and workspace were removed in Phase 5 Stage D; a task with no conversation opens in a sheet (register #63). |
| The hand-built brand row and second toggle | `DesktopChatSidebar.swift:74-76, 113-130` | The system toggle |
| The "Juno product" picker in the list inset | `DesktopProductMode.swift:55-76, 157-165` | §1.4 |
| Three toolbar capsules and `junoToolbarMetrics()` (9 calls) | `DesktopChatWorkspace.swift:326-363` | §3 |
| `.hiddenTitleBar`, the empty title | `JunoDesktopApp.swift:138`, `DesktopChatWorkspace.swift:195` | §1.1, §1.3 |
| The Incognito window and its composer | `DesktopIncognito.swift`, `JunoDesktopApp.swift:178-184` | Inline private mode |
| The Search page and toolbar Search button | `DesktopSearchScreen.swift`, `DesktopChatWorkspace.swift:338-345` | The ⌘K panel (§7.4) |
| Tasks destination and inspector | `DesktopTasksScreen.swift` (deleted in Phase 5 Stage D, unreferenced since Phase 1), `DesktopChatWorkspace.swift:84-95, 218, 258-300` | Automations (§9) |
| Usage destination | `DesktopChatSidebar.swift:338`, `DesktopUsageScreen.swift` | Settings panes |
| Settings sheet and the `.settings` destination | `DesktopChatWorkspace.swift:198-218`, `DesktopSettingsModal.swift`, `DesktopAccountScreens.swift:20-23, 148-181` | The `Settings` scene |
| Design footer row | `DesktopDesignScreen.swift:840-890` | A nav row |
| Greeting, aura layer, time-of-day copy | `DesktopChatAura.swift` (whole file) | §4 |
| Full-window offline banner | `JunoDesktopRootView.swift:116-134` | §1.5 |
| ⇧⌘1 (screenshot) | `DesktopCommands.swift:89-157` | ⇧⌘U. **Keep ⇧⌘O** as a New chat alias: it is the web's New chat shortcut (`command-palette.tsx:1035, 1333`). |

---

## 2. Sidebar (`App/DesktopChatSidebar.swift`, rewritten)

### 2.1 Structure

```swift
List(selection: $selection) {
    Section {                                                   // headerless nav block
        NewChatRow()                                            // Button; never tagged, never selected
        Label("Library",   image: .phBooks).tag(Destination.library)
        Label("Projects",  image: .phFolder).tag(Destination.projects)
        Label("Artifacts", image: .phStack).tag(Destination.artifacts)
        Label("Design",    image: .junoDesign).tag(Destination.design)
        MoreRow()                                               // Menu (§2.3)
    }
    if needsYou.count > 0 {                                     // Phase 5
        Section { ForEach(needsYou) { ConversationRow($0) } } header: { NeedsYouHeader() }
    }
    if !filterToNeedsYou {
        Section(isExpanded: $pinnedProjectsOpen) { ForEach(pinnedProjects) { ProjectRow($0) } }
            header: { SectionHeader("Pinned projects", action: .newProject) }
        Section(isExpanded: $pinnedChatsOpen) { ForEach(pinnedChats) { ConversationRow($0) } }
            header: { Text("Pinned chats") }
        Section(isExpanded: $recentOpen) { ForEach(recent) { ConversationRow($0) }; PageSentinel() }
            header: { Text("Recent") }
    }
}
.listStyle(.sidebar)
.safeAreaBar(edge: .top, spacing: 0)    { SidebarSearchButton().padding(.horizontal, 10).padding(.bottom, 6) }
.safeAreaBar(edge: .bottom, spacing: 0) { SidebarFooter() }     // keep the existing bar (:81)
```

- **Data rules:**
  - Every source filters on `kind == "chat"` and excludes archived chats. This fixes the leak at `NativeConversationStore.swift:268`.
  - Needs-you rows are removed from Pinned and Recent.
  - Recent is one flat list, newest first, loaded 40 rows at a time via `.onAppear` on the last row. There are no date folds.
- **Fold state:** `@AppStorage("juno.sidebar.{projects|pinned|recent}.expanded")`.
- **Section headers:** the system sidebar header style, sentence case, chevron on hover. Delete `Text("Recents").junoCodeSmall()` (`:59-64`).
- **Empty Recent:** one row that can't be selected: "No conversations yet." in 13pt secondary ink, with "Start one above." in 12pt tertiary under it (web copy, `app-sidebar.tsx:1315-1329`).
- **Loading** (only during the first bootstrap after sign-in, when the local store is empty): 6 placeholder rows with `.redacted(reason: .placeholder)` and an opacity breathe (1 → 0.62, 1.8s). The breathe stops under Reduce Motion.

### 2.2 Search button (pinned above the list)

- A `Button` styled as a field: `.buttonStyle(.plain)`, 28pt tall, `RoundedRectangle(cornerRadius: 10)` filled with `junoGlassFill`.
- Content: `ph.magnifyingglass` 14pt secondary, "Search" 13pt secondary, a spacer, then a "⌘K" keycap at 11pt tertiary.
- It opens the panel in **Search** mode (§7.4). It is a button, not a live field, so there is exactly one search surface, as on the web.

### 2.3 Rows

All rows use the system sidebar metrics. Label font, row height and symbol size follow System Settings › Sidebar icon size. Custom symbols scale the same way because they are real symbols.

| Row | Anatomy and behaviour |
|---|---|
| **New chat** | `Label("New chat", image: .phPlus)`. Starts a draft. An empty draft resolves the selection to `nil`, so no row is highlighted (change `DesktopNavigationState.swift:14-22`). `.help("New chat  ⌘N")`. |
| **Destination** | A tagged `Label`. It is selected while its page is open. Glyph ink is `junoSidebarInk` at rest and `junoForeground` when selected. Label weight never changes. |
| **More** | `Menu { … } label: { Label("More", image: .phDotsThree) }` with `.menuStyle(.button)`, `.buttonStyle(.plain)`, `.menuIndicator(.hidden)`. It is untagged; the selection recipe paints it as selected while a More page is open. Items (Title Case): Assistants (`ph.robot`), Connections (`ph.plug`), Skills (`ph.scroll`), Automations (`ph.treestructure`), Permissions (`ph.shieldcheck`), Divider, Archived Chats… (`ph.archive`, opens a sheet). Items appear as their pages land: Phase 1 has Connections and a temporary Memory (removed in Phase 3 when ⌘K ships); Phase 3 adds Archived Chats; Phase 4 adds the rest. Unbuilt items are absent, not disabled. |
| **Project** (Pinned projects) | A `DisclosureGroup(isExpanded:)` labelled `Label(name, image: expanded ? .phFolderOpen : .phFolder)`. Children: the 3 newest chats (with dots), then "View all N" / "Show less" in 12pt secondary, which expands or collapses in place. Context menu: New Chat in Project, Unpin, Rename, Divider, Delete…. The header's trailing `ph.plus` (12pt, borderless, visible on hover, `.help("New project")`) opens the New Project sheet. This reuses the unreached state at `DesktopChatSidebar.swift:85-110, 242-246`. |
| **Conversation** | See below. |

```swift
HStack(spacing: 6) {
    Text(title).lineLimit(1).truncationMode(.tail)
        .contentTransition(.opacity)                       // AI rename, keyed on recentlyRenamedConversationID
    Spacer(minLength: 4)
    TrailingMark()   // at most one, in priority order:
                     // 1. ProgressView().controlSize(.mini)             while a send is pending
                     // 2. hover or selected: 20×20 ph.dotsthree Menu    (.menuIndicator(.hidden), same items as §2.4)
                     // 3. JunoStatusDot(tone) 6pt                       while the chat's newest run is open (Phase 5)
                     // 4. ph.pushpin.fill 10pt, junoTertiaryInk          when pinned (web: app-sidebar.tsx:2455-2473)
}
.help(runSentence.map { "\(title) — \($0)" } ?? title)
.accessibilityValue(runStatusLabel ?? "")
```

- There is no leading glyph and no bullet.
- The AI-rename cross-fade uses `JunoMotion.slow` (360ms outExpo).

**Status dot tones** (`JunoStatusDot`, 6pt `Circle`):

| Tone | Colour | Motion |
|---|---|---|
| neutral | `junoSecondaryInk` | none |
| live | `junoAccent` | opacity 1 → 0.45 over 2.8s on `breathe`. Static under Reduce Motion. |
| attention | `junoWarning` | none |
| good | `junoSuccess` | none |
| bad | `junoDestructive` | none |

### 2.4 Row menus, rename, archive, delete

The context menu and the hover menu carry the same items, in this order:
1. Rename
2. Pin / Unpin
3. Add to Project ▸ (No Project, then the projects with a checkmark on the current one, Divider, New Project…)
4. Share…
5. Archive
6. Divider
7. Delete…

**Rename** swaps a `TextField` into the row under `@FocusState`. Return commits and Esc cancels. Delete the `.alert` at `:85-93`.

**Archive** registers with `UndoManager` and posts the toast "Chat archived" with an **Undo** action.

**Delete…** asks first:

```swift
.confirmationDialog("Delete this conversation?", isPresented: $confirmDelete, titleVisibility: .visible) {
    Button("Delete", role: .destructive) { delete() }
} message: { Text(webDeleteCopy) }            // verbatim from app-sidebar.tsx:2362-2375
```

### 2.5 "Needs you" (Phase 5; the slot exists from Phase 1)

- The header is `Button { filterToNeedsYou.toggle() } label: { Text("Needs you · \(n)") }` with `.buttonStyle(.plain)` in the header font.
- While the filter is on, every other section hides.
- It carries `.accessibilityAddTraits(.isSelected)` while filtering, and `.help("Show only these")` / `.help("Show everything")`.
- The filter clears itself when n reaches 0.
- Every rise in the count posts `AccessibilityNotification.Announcement`.

### 2.6 Selection

- `List(selection:)` keeps ownership of arrow keys, type-select and VoiceOver.
- The existing workaround measured at `DS/JunoDesktopChrome.swift:125-166` (`junoSidebarRowSelection` + `junoSidebarSelectionTint`) paints the web recipe over the system highlight:
  - `RoundedRectangle(cornerRadius: 10)` filled with `junoSelectedFill`, plus a 1pt inset `strokeBorder(junoSelectedEdge)`. The edge is what signals selection.
  - Horizontal inset 6.
  - Label weight and ink unchanged.
- There is no hover fill; Mac sidebars don't hover.
- **Opaque, not alphas (fact-check correction).** On macOS 26 the focused selection is drawn in the *system accent* and ignores tint (`DS/JunoDesktopChrome.swift:142-160`), so the Juno pill must cover it completely. Keep an opaque fill (the generated `sidebarSelected`, `DS/JunoSurfaces.swift:25-26`) plus the 1pt edge. A translucent fill lets system blue show through and fails the Phase 1 "no blue" gate.
- Fix the stale comment at `JunoDesktopChrome.swift:115-117`, which calls the asset coral when it is graphite.

### 2.7 Footer and account popover

The footer lives in a `safeAreaBar(edge: .bottom)`, renamed `App/DesktopAccountFooter.swift` and shared with Code:

```
[UpdateRow]   ph.downloadsimple 13 · "Update ready" 12 secondary · borderless "Restart"     (only when ready)
HStack(spacing: 2) {
  AccountButton   .plain, 36pt tall, hover fill junoGlassHover r10, selected fill while its popover is open
     JunoAvatar(20) · Text(name).font(.junoUI.weight(.medium)).lineLimit(1)
     · Text(" · \(planWord)").foregroundStyle(planTone) · Image(.phCaretUpBold) 10pt junoTertiaryInk
  Spacer(minLength: 0)
  SyncMark        offline: ph.cloudslash 12 tertiary · failed: ph.warningcircle 12 junoWarningInk · .help(reason)
  Button("Settings", image: .phGearSix) { openSettings() }.labelStyle(.iconOnly).buttonStyle(.borderless)  // 28×28
}
.padding(.horizontal, 10).padding(.bottom, 8)
```

- **Plan word.** Comes from real plan data, reusing the `DesktopUsagePlan` load that Code already does (`DesktopCodeWorkspace.swift:76`). Delete the literal at `DesktopCodeAccountFooter.swift:101`.
  - At 80% usage or more: "\(n) left" in `junoWarningInk`.
  - At 100%: "Limit reached" in `junoDestructiveInk`.
- **Accessibility label:** "Liam Magnier, Pro plan, 412 of 500 messages used".
- **Sync mark** shows only when offline or failed. It never shows while syncing, which removes the orange dot.
- **There is no Download button.** This app is the download.

**Account popover.** System glass, no background. `.frame(width: 288, height: isOwner ? 316 : 284)`:
- **Header:** 32pt avatar; name at 13 semibold; a plan capsule (11pt mono medium on `junoGlassFill`); email at 12pt secondary.
- **Usage block:** `junoGlassFill` in a concentric rect of radius 10. "Messages 412 / 500" in 11pt mono, then the 18-dot `DesktopSidebarDotFillBar`, or "No cap".
- Divider.
- **Rows** (28pt, hover `junoGlassHover`, radius 8): Profile… (Settings › Account) · Settings… ⌘, · Admin Panel ↗ (owners only; opens the web).
- Divider.
- **Sign Out**, in `junoDestructiveInk`.
- There is no Upgrade row, matching the web.

---

## 3. Toolbar (detail column)

The toolbar is declared **once**, on `ChatDetail` (§1.2). It is never attached per destination.

```swift
struct ChatToolbar: ToolbarContent {
    var body: some ToolbarContent {
        ToolbarItem(placement: .navigation) {                     // web rail's New chat
            Button("New chat", image: .phPlus, action: newChat)
                .help("New chat  ⌘N")
                .toolbarItemHidden(columns != .detailOnly || !isChatRoute)
        }
        ToolbarItemGroup(placement: .primaryAction) {             // ONE shared glass capsule
            OutputsButton()
                .toolbarItemHidden(!isChatRoute || !session.hasOutputsOrUsed)
            ShareButton()
                .toolbarItemHidden(!isChatRoute || !chat.isSavedWithMessages || chat.isPrivate)
            PrivateChatToggle()
                .toolbarItemHidden(!isChatRoute)
        }
    }
}
```

| Item | Spec |
|---|---|
| Title | The system title, subtitle and title menu (§1.3). Nothing custom. |
| **Outputs** | Label: `HStack(spacing: 4) { Image(.phFileText); Text("\(n)").monospacedDigit().contentTransition(.numericText()) }` (the web draws `CodeIcons.file`, `session-outputs.tsx:254`). The count is omitted when n is 0 but sources were used. Accessibility label: "Outputs — n in this chat" / "What this chat used" (web copy). Opens the Outputs popover (§7.5). |
| **Share** | `ph.sharenetwork`. Opens the Share popover (§7.3). |
| **Private** | `Toggle(isOn: $isPrivate) { Label("Private chat", image: isPrivate ? .junoGhostFill : .junoGhost) }.toggleStyle(.button)`. Help text: "Start private chat" / "Private chat is on. Nothing is saved." (`private-chat-toggle.tsx:50, 102`). The on state is the native pressed look plus the fill glyph, with no coral. On a draft, it switches that draft to private. On a saved chat, it starts a new private chat. Turning it off in a private chat that has messages asks `.confirmationDialog("Leave this private chat?")` with message "It won't be saved." (new copy; add it to the web in the shell contract). |

- **By state:**
  - Draft: only Private shows.
  - Conversation: Outputs (when there is something), Share, Private.
  - Pages: nothing. Only the traffic lights and the sidebar toggle, because the page draws its own header (§9).
- **Never in the toolbar:** a search field, a model picker, New chat while the sidebar is visible, `ToolbarSpacer`, `.controlSize`, `junoToolbarMetrics()`, or any tint.
- **Menu-bar mirrors:** every toolbar command is also in the menu bar (§7.8).

---

## 4. Empty state (new chat): `App/DesktopEmptyChat.swift`, replacing `DesktopChatAura.swift`

### 4.1 Layout: one composer, lifted

The composer always lives in the chat column's `safeAreaBar(edge: .bottom)` (§5.1). In a draft, the bar's content is the greeting, the composer cluster and the starter chips, lifted to the optical centre:

```swift
VStack(spacing: 0) {
    if phase == .draft { Greeting().frame(maxWidth: 672).padding(.bottom, 32).transition(.greetingOut) }
    ComposerCluster()                                        // same view identity in every phase
    if phase == .draft && showChips { StarterChips().padding(.top, 16).transition(.opacity) }
}
.frame(maxWidth: 896)                                        // web max-w-4xl group
.padding(.horizontal, gutter)
.padding(.bottom, lift)   // draft: max(16, (columnHeight − groupHeight) / 2 − 24); conversation: 16
```

- `columnHeight` and `groupHeight` are read with `onGeometryChange`.
- The −24 places the group slightly above the true middle.
- The group is centred as one unit, as on the web.

### 4.2 Greeting

- **Copy:**
  - `Text("How can I help, \(Text(firstName).font(.junoDisplayItalic(size)))?").font(.junoDisplay(size))`. This is `Text` interpolation; do not concatenate with `Text +`.
  - With no name: "How can I help?".
  - The first name is the first word of `user.name`.
- **Face:** Newsreader 24pt **Regular** (`Newsreader24pt-Regular`), with the name in true **Italic** (`Newsreader24pt-Italic`).
  - **Add** `Newsreader24pt-Italic.ttf` to `native/iOS/JunoMobile/Resources/Fonts/`. Today only Regular, Medium, MediumItalic and SemiBold ship (checked in this pass). The Mac bundles that folder through `project.yml:44`.
- **Fix `JunoSerif`** (`DS/JunoSerif.swift:64-100`) to return `Font.custom(face.rawValue, size: size, relativeTo: .largeTitle)` with a New York fallback. Delete its `pageHeading` and `cardTitle` helpers; their 29 call sites pass a size that is ignored today.
- **Size:** `s = min(48, max(32, 5.33 + 0.041667 × w))`, where `w` is the chat column width. This is the web's `clamp(2rem, .3333rem + 4.1667cqi, 3rem)`.
  - `.lineHeight(.multiple(factor: 1.08))` (SC:11518, macOS 26), `.tracking(-0.02 * s)`, regular weight, `junoForeground`, `.multilineTextAlignment(.center)`.
- **Never:** a Juno mark (`:199`), halo shadows (`:275-276`), accent on the name (`:303-326`), time-of-day copy. The Mac stops reading `JunoGreeting`; iOS keeps it.
- **Entrance:** rise-in, 6pt plus opacity, 220ms `outSoft`, once per new draft. The flags start **false** (fixing `:176-177`). Under Reduce Motion, opacity only.
- **Private draft:** "You're incognito" in SF 26 semibold with −0.5 tracking. Under it, 17pt `junoSecondaryInk`: "Chats aren't saved, added to memory, or used to train models." (web copy).

### 4.3 Starter chips

| Chip | Glyph | Seed (verbatim, `starter-chips.tsx:40-60`) |
|---|---|---|
| Research | `ph.binoculars` | "Research and cite sources on " |
| Write | `ph.pencilsimple` | "Help me write " |
| Code | `juno.code` | "Write code that " |
| Plan | `ph.treestructure` | "Plan the steps to " |

- **`JunoChipStyle`** (content layer, **not glass**):
  - 28pt capsule, leading padding 10, trailing padding 12, 16pt glyph, 6pt gap.
  - 13pt label in `junoSecondaryInk`, 1pt `junoBorder` stroke, clear fill.
  - Hover: `junoHover` fill and foreground ink over 120ms. Press: `junoSecondary` fill and scale 0.97 over 70ms.
- **Layout:** centred, wrapping (`JunoFlowLayout`), 8pt gap.
- **Entrance:** 120ms after the greeting, staggered 30ms per chip (opacity plus 4pt).
- **A click seeds** the draft and focuses the field. It **never sends**. Plan does not arm a task.
- **Hidden:** in private mode, during clarification, and after the first send.

---

## 5. Composer: `DS/JunoComposerShell.swift` (new) and `App/ChatComposer.swift` (rewrite of `DesktopComposer.swift`)

### 5.1 The cluster and the shell

One component serves Chat drafts, conversations, private mode, the Project overview and Quick Entry. It replaces five implementations: `DesktopComposer`, `DesktopIncognito:209-275`, `DesktopWorkWorkspace:1428` and `:4125`, and `DesktopQuickEntry:158-225`.

```swift
GlassEffectContainer(spacing: 8) {
    VStack(spacing: 10) {                               // 10 > 8: shapes never merge at rest
        ScrollToLatestButton()                          // conversation only (§6.13)
        FollowUpChips()                                 // conversation only (§6.12)
        OutsideCaption(.above)                          // quota · "New chat in {Project}" — plain, NOT glass
        VStack(alignment: .leading, spacing: 0) {
            AboveSlot()                                 // §5.6
            FieldRow()                                  // armed marks + TextField (§5.2, §5.5)
            DisclosureLine()                            // task run disclosure / delegation offer (Phase 5)
            ControlsRow()                               // §5.3
        }
        .containerShape(.rect(cornerRadius: 20))
        .glassEffect(.regular, in: .rect(cornerRadius: 20))   // the ONE custom shape
        .overlay { PrivateEdge(); DropTargetEdge() }
        OutsideCaption(.below)                          // private footnote
    }
}
.frame(maxWidth: 768)
```

- **Mounting:** `.safeAreaBar(edge: .bottom, spacing: 0) { ComposerDock() }` on the chat column, replacing `safeAreaInset` at `DesktopChatWorkspace.swift:629`. Horizontal padding is the gutter; bottom padding is 16 in a conversation and `lift` in a draft.
- **No glass on any control inside the shell.** This deletes the glass at `DesktopComposer.swift:813, 841, 891, 913, 955`.
- **No custom stroke, no shadow, no tint.** The glass supplies the depth.
- **Focus:** `.focusEffectDisabled()`. The caret is the only focus signal.

### 5.2 Geometry

| Part | Value |
|---|---|
| Shell | Radius 20. Maximum width 768 (the transcript measure). |
| Above slot | 12pt inset. Inner cards and tiles use `.rect(corners: .concentric(minimum: 10))`. |
| Field row | Padding h16, top 14, bottom 6. Minimum height 24. `TextField(placeholder, text: $draft, axis: .vertical)` with `.textFieldStyle(.plain)`, 15pt, `.lineHeight(.multiple(factor: 1.6))`, `.lineLimit(1...8)`, then an internal scroll. Height grows on `JunoMotion.standard`; this is the only height allowed to animate. |
| Controls row | Padding h10, bottom 10, top 2. 28pt tall. Spacing 4. The `+` glyph lines up with the text's left edge (16), and the disc lines up with its right edge. |
| Inner hover fill | `junoGlassHover` in `ConcentricRectangle()`, which resolves to 10. |

### 5.3 Controls row: `[+] · Spacer · [Model chip] [Mic] [Primary]`

1. **`+`:** `Menu { PlusMenu() } label: { Image(.phPlus) }` with `.menuStyle(.button)`, `.buttonStyle(.borderless)`, `.menuIndicator(.hidden)`. 28×28, 16pt glyph in `junoSecondaryInk`. `.help("Add files, tools and more")`. The accessibility value lists whatever is armed.
2. **Model chip:** a borderless `Button`, 28pt tall, h-padding 8.
   - `HStack(spacing: 6) { ProviderMark(16); Text(name).font(.junoUI.weight(.medium)).foregroundStyle(.junoSecondaryInk).lineLimit(1).frame(maxWidth: 160); Image(.phCaretDownBold).font(.system(size: 10)).opacity(0.7) }`.
   - The caret rotates 180° while open, on `JunoMotion.fast`.
   - Auto shows `juno.chat` as its mark.
   - Loading: `.redacted(reason: .placeholder)`.
   - Catalog error: "Models unavailable", wiring the unread `modelCatalogErrorDescription`.
   - The default is **Auto**, so the composer always has a model. "Choose model" is deleted.
3. **Mic (dictate):** `Button("Dictate", image: .phMicrophone)`, `.labelStyle(.iconOnly)`, borderless, 28pt. Disabled during a call. It is **the only microphone** in the composer.
4. **Primary disc:** a 28pt `Circle`, **flat, not glass**. This makes the comment at `DesktopComposer.swift:931-935` true.

| Face | When | Fill | Glyph | Help and accessibility label |
|---|---|---|---|---|
| voice | empty draft | `junoGlassFill` | `ph.waveform` 14pt, `junoSecondaryInk` | "Start a voice chat" |
| send | draft present | `junoAccent` | `juno.send.bold` 14pt, `junoOnAccent` | "Send", or "Start this as a task" / "Add this to the running task" / "Answer the task's question" / "Add to the research" (web copy, `composer.tsx:3930-3975`) |
| stop | streaming or a live run | `junoAccent` | `ph.square.fill` 10pt, `junoOnAccent` | "Stop" / "Stop the task" / "Stop the research" |
| busy | preflight check or upload | `junoAccent` | `ProgressView().controlSize(.small).tint(.junoOnAccent)` | "Waiting for the upload to finish" |
| disabled | nothing can be sent | `junoGlassFill` | glyph at 50% `junoSecondaryInk` | the reason, in `.help` |

- **Face changes:**
  - The glyph uses `.contentTransition(.symbolEffect(.replace))`.
  - The fill cross-fades with scale 0.9 → 1 over 120ms `outSoft`.
  - Press: scale 0.97 and brightness −0.06 over 70ms.
- **The voice face never depends on a resolved model** (fixes `:939`).
- **While streaming,** the whole row except the disc dims to 0.6.

### 5.4 `+` menu

A native `Menu`. Three groups separated by `Divider()`, with no section titles. Rows are `Label`s with `ph.*` symbols; toggles are `Toggle`; choices are `Picker(.inline)` inside a nested `Menu`. Title Case, web wording.

| Group | Row | Glyph | Kind |
|---|---|---|---|
| 1 | Add Files or Photos… | `ph.paperclip` | Button, `.keyboardShortcut("u")` so it shows ⌘U |
| 1 | Take a Screenshot | `ph.scan` | Button, ⇧⌘U (existing `DesktopScreenshotCapture`) |
| 1 | Add from Library… | `juno.library` | Button |
| 2 | Add to Project ▸ | `ph.folder` | No Project, then the projects with a checkmark, Divider, New Project… (draft only) |
| 2 | Connectors ▸ | `ph.plug` | `Toggle` rows labelled with the `JunoConnectorMarks` logo and name; a disabled "Loading…" row; Divider; "Manage Connections… (2 of 5 on)". The cap of 5 is kept. |
| 3 | Use a Skill ▸ *(Phase 4)* | `ph.scroll` | `Picker(.inline)` of skills (name, plus the description on a second line); "Loading…" while loading; Divider; Manage Skills…. Sends `skillSlug`. |
| 3 | Deep Research | `ph.binoculars` | Toggle. Second line shows the depth (Quick / Standard / Deep / Max, via a Swift port of `researchEffortFor`). |
| 3 | Do This as a Task *(Phase 5)* | `ph.treestructure` | Toggle. Mutually exclusive with Deep Research. |
| 3 | How Often It Asks ▸ *(Phase 5)* | `ph.handpalm` | Shown only while Task is on. `Picker(.inline)`: "Ask before every change" / "Ask before risky steps" (default) / "Just do it", each with its web summary on a second line (`src/lib/work/domain.ts:533-543`). Resets after each send. |
| 3 | Web Search | `ph.globesimple` | Toggle |
| 3 | Memory | `ph.notepencil` | Toggle, bound to the synced `memoryEnabled`. Never shows a mark. |
| 3 | My Documents | `ph.filemagnifyingglass` | Toggle (Mac-only local grounding) |

- **Disabled rows** give their reason as a second `Text` line: "Not on this model", "Incognito".
- **In private mode,** research, task, project, connectors and skill are hidden.
- **During a call,** the menu shrinks to Add Files, Add from Library and Deep Research.
- **Deleted:**
  - "Canvas & artifacts" and all the `canvasEnabled` state (`DesktopComposer.swift:727-729, 1158, 1168`)
  - the separate thinking chip (`:875-899`)
  - `autoRouteModel` (`:62-66, 1068-1090`)
  - the aura inputs (`:42-48, 553-568, 1105`)

### 5.5 Armed marks (at the start of the field row)

- **Order:** Task · {mode} → Skill → Deep research · {depth} → Web search → connectors (with logo) → My documents. Memory never gets a mark.
- **Limit:** at most 2 marks, then a "+N" mark.
- **Mark style:**
  - 22pt tall, radius 6, `junoGlassFill`. Neutral, never coral.
  - 12pt glyph (bold cut), 12pt medium `junoForeground` label.
  - A hover-revealed `ph.x.bold` at 9pt that disarms.
- **Clicking a label** reopens `+`.
- **Narrow composer:** `ViewThatFits` drops the labels to icons below 480pt of composer width.
- **The placeholder hides** while any marks are showing.

### 5.6 Above-slot content

Only one kind shows at a time, except that attachments can sit alongside the others.

- **Attachments.** A wrapping `JunoFlowLayout` with 8pt gaps; no horizontal scroll.
  - Images: 64×64 thumbnails from `NativeFilePreviewTile`.
  - Files: 224×64 cards with a 64pt preview, the name at 12pt medium on 2 lines, and a mono 10.5pt line "PDF · 2.4 MB" or "Uploading 42%".
  - An 18pt remove circle (`ph.x.bold` 8pt on `junoForeground.opacity(0.8)`) sits top-trailing and appears on hover.
  - A failed upload shows a destructive hairline and a "Retry" button.
  - Tiles enter with `.transition(.scale(0.9).combined(with: .opacity))` on `JunoMotion.standard`.
  - Replaces `DesktopAttachmentChip` (`:1545-1601`).
- **Quote card** (canvas Ask or Modify; Phase 4). An icon tile, a mono "Modify" or "Ask" label, the title and location, a 2-line excerpt, and `ph.x`. Esc clears it. Sending attaches `artifactEdit`.
- **Clarification** (Phase 2, the preflight call to `/api/chat/clarify`).
  - Heading: "One quick question" or "Question n of m".
  - Answers: `Picker(.radioGroup)` for single choice, checkbox `Toggle`s for multiple choice, `TextField` for text.
  - Buttons: Skip and Back (borderless), then Continue (the only coral button).
  - The field placeholder reads "Or type your own answer…". The disc shows the busy face during the check.
- **Pending steers** (Phase 5). A compact list, with `ph.x` on each item.
- **Long paste** over 8,000 characters. The "Large paste ready to send" card with the character count, a 280-character preview, and Expand to Edit, Attach as File and Clear Paste. Between 1,500 characters (or 30 lines) and 8,000, show the hint "That's a long one — attach it as a file…". Copy is verbatim from `composer.tsx` around lines 3469-3574.

### 5.7 Model popover (system glass, explicit frames)

- **Stage 1.** `.popover(arrowEdge: .top)` with `.frame(width: 384, height: 56 + thinkingHeight)`.
  - `thinkingHeight` is a static constant on `JunoThinkingPopover`, and 0 when the model has fewer than 2 levels or is Auto.
  - Contents:
    - A "Change Model" row: provider mark, name, `ph.caretright.bold`.
    - Divider.
    - `JunoThinkingPopover(scale:effort:width:fastMode:proMode:)` (`ChatKit/JunoModelViews.swift:133-173`), bound to the existing `$fastMode` and `$proMode`. Choosing Pro at Instant raises effort to Medium.
- **Stage 2.** "Change Model" dismisses stage 1 and presents a second popover on the same chip with `.frame(width: 760, height: 480)` holding `JunoModelSelector`.
  - Add a Favorites rail entry and a star in the detail panel, backed by `favoriteModels` (`NativeMemorySettingsStore.swift:82`).
  - Remove `.filter(\.isChatCapable)` at `NativeConversationStore.swift:1513`, and filter only where voice and Compare need it. The Image and Video sections come back, and the placeholder follows the modality.
- **Error.** The chip reads "Models unavailable". Stage 1 shows only "Try Again", which calls `reloadModelCatalog`.

### 5.8 States

| State | What changes |
|---|---|
| Streaming | Stop face. The row dims. ↩ queues exactly one message. |
| Dictating | The field and controls rows cross-fade (`JunoMotion.fast`) into one row, **inside the same shell**: `ph.x` (cancel) · the live transcript (final text in `junoForeground`, partial in secondary) · a 5-bar meter (3pt monochrome capsules, 6–18pt tall, staggered gains) · `ph.check` "Stop and edit" · the send disc "Send what you dictated". No glow, no uppercase, no gradient. Rewrite `DesktopDictation.swift`. |
| Voice call | The shell content becomes the call bar: level meter · "Listening" / "Juno is speaking" · **Stop Speaking** (only while Juno speaks) · mute (`ph.microphoneslash`) · share screen (`ph.monitorarrowup`) · an options `Menu` (Provider, Reasoning) · a 28pt `junoDestructive` disc (`ph.phonedisconnect`). Delete the shadows at `DesktopVoice.swift:456-457, 660`. No aura. |
| Private | A 1pt dashed edge, `strokeBorder(junoSecondaryInk.opacity(0.5), style: .init(lineWidth: 1, dash: [4, 4]))`. Caption 8pt below the shell: "Incognito chats are not saved or added to memory." at 11pt tertiary. Placeholder "How can I help you today?". Same composer. Backed by `NativePrivateChatModel`. |
| Drop target | `.dropDestination(for: URL.self)` on the whole chat column. While targeted: a 1.5pt dashed `junoSecondaryInk` stroke inset 4 (no coral, §0.4), and "Drop to attach" at 13pt medium. |
| Paste | `.onPasteCommand(of: [.image, .fileURL])` attaches. Long text follows §5.6. |
| Quota | Caption row above the shell: "You've reached your monthly limit." with a link-style "Upgrade…" that opens the Upgrade sheet. `+` and send are locked. |
| New chat in a project | Plain capsule above the shell: "New chat in {Project}" with `ph.x`. |
| Steering *(Phase 5)* | The placeholder, send label and stop label come from the active run. Return routes to `NativeWorkModel.answer` / `sendInstruction`, or to the research steer endpoint. Stop cancels the run, then the stream. |

### 5.9 Keys and placeholders

- **Keys:**
  - ↩ sends; ⇧↩ inserts a newline.
  - ↑ in an empty field edits the last message.
  - Esc clears the quote, then cancels dictation, then stops generation.
  - ⌘U attaches; ⇧⌘U takes a screenshot; ⌘. stops.
  - The `/` and `@` palette (Phase 4): when the token before the caret starts with `/` or `@`, show a `.popover` with an explicit frame of 320×280, driven by `.onKeyPress` (↑ ↓ ↩ Tab Esc). Sections match the web (`composer.tsx:327-583`).
- **Placeholder ladder** (web copy, `composer.tsx:884-895`):
  - "Message Juno…"
  - "Describe an image to generate…"
  - "Describe a video…"
  - "Describe the change…"
  - "Ask about this selection…"
  - "Or type your own answer…"
  - "Answer Juno's question…"
  - "Add an instruction to the running task…"
  - "Add a constraint, or paste a source to include…"
  - "How can I help you today?" (private)

---

## 6. Transcript

### 6.1 Column

```swift
ScrollView {
    LazyVStack(alignment: .leading, spacing: 24) { ForEach(items) { TranscriptItemView($0) } }
        .frame(maxWidth: 768).padding(.horizontal, gutter).frame(maxWidth: .infinity)
}
.contentMargins(.top, 24, for: .scrollContent)
.scrollEdgeEffectStyle(.soft, for: [.top, .bottom])
.defaultScrollAnchor(.bottom)
.scrollPosition($position)
.onScrollGeometryChange(for: Bool.self, of: { $0.isAtBottom(tolerance: 24) }) { _, v in atBottom = v }
.safeAreaBar(edge: .top, spacing: 0)    { TopBars() }        // offline row + find bar (§1.5, §6.14)
.safeAreaBar(edge: .bottom, spacing: 0) { ComposerDock() }
```

- **Gutter:** 16 below 640pt of column width, 24 from 640, 32 from 1024. Replaces the fixed 32 at `DesktopChatWorkspace.swift:826`.
- **Nothing sits between the ScrollView and the top of the window.** Text slides under the toolbar.
- **Item types:** user turn, assistant turn, and run cards, placed by `createdAt`.

### 6.2 User turn (trailing)

- **Sent attachments** sit above the bubble, trailing: 160pt thumbnails (radius 12, hairline) and file chips. A click opens `.quickLookPreview`. This is new; today `NativeChatMessage.attachments` is never read.
- **Bubble:**
  - 15pt `junoForeground`, `.lineHeight(.multiple(factor: 1.6))`.
  - Padding h14, v10.
  - `junoSecondary` fill, **no border**.
  - `UnevenRoundedRectangle(topLeadingRadius: 16, bottomLeadingRadius: 16, bottomTrailingRadius: 8, topTrailingRadius: 16)`.
  - Maximum width 85% of the measure.
  - `.textSelection(.enabled)`.
- **Hover actions** below the bubble: Copy, Edit, Fork Privately (recipe from §6.10).
- **Kept:** long-prompt collapse, edit and resend, and the branch pager.
- **A turn that failed to send** shows "Not sent" with a "Retry send" button.

### 6.3 Assistant turn (leading; no avatar, no name, no card), top to bottom

1. Approval card(s), when a reply is blocked (§6.9)
2. Activity row (§6.6)
3. The answer (§6.4–6.5)
4. Inline cards, in the order they happened (§6.8)
5. Sources pill (§6.7)
6. Finish note or error (§6.11)
7. Action row (§6.10)

**Generated media:**
- Images: a square frame of at most 320pt whose pixels fade in after decoding, with a hover "Edit" button that opens `NativeImageEditSheet`.
- Video: AVKit `VideoPlayer`.

### 6.4 Prose (the web's `.prose-juno`)

| Element | Style |
|---|---|
| Body | 15pt, `.lineHeight(.multiple(factor: 1.65))`, 12.75pt between blocks |
| H1 / H2 / H3 | 22.5 / 19.5 / 16.8pt semibold, line height 1.3, 1.3em above and 6pt below |
| Lists | 1.4em indent, 0.2em between items |
| Blockquote | 2pt leading bar in `junoBorder`, text in `junoSecondaryInk` |
| Inline code | SF Mono at 0.875em, `junoSecondary` fill, radius 6, padding 2×5 |
| Links | `junoAccentInk`, underlined, handled with `OpenURLAction` |
| Rule | 1pt `junoBorder` hairline |
| Streaming | **No caret.** Delete `JunoStreamingCursor` (`JunoMarkdownView.swift:166-206`). Once the answer passes 140 characters, the last block gets a bottom `.mask(LinearGradient)` that fades to 30%. |

### 6.5 Code, tables, diagrams

- **Code block.** Opaque: `junoCard` fill, 1pt `junoBorder`, radius 12.
  - **Header row (32pt):** the language in 11pt mono secondary, and a borderless Copy (`ph.copy`) that swaps to `ph.check` via `.contentTransition(.symbolEffect(.replace))`.
  - **Body:** **one** `Text(AttributedString)` per block in SF Mono 13 with `.lineHeight(.exact(points: 20))` and `.textSelection(.enabled)`, so a selection can span lines. Padding 12/14. Lines don't wrap; the block scrolls horizontally.
  - **Height cap:** 520pt, with an internal scroll.
  - **Gutter:** only at 8 lines or more, in 12pt mono tertiary.
  - **Syntax colours:** keywords `junoAccentInk`, strings `junoCodeString`, numbers `junoCodeNumber`, comments `junoSecondaryInk` italic.
  - Rewrite `DS/JunoAIcssCode.swift:15-87`.
- **Table.** A `Grid` inside the same card recipe.
  - Header row on `junoSecondary`, 13pt medium, with a bottom rule at `junoForeground` 28%.
  - Body 13pt with cell padding 10/8 and `junoBorder` rules between rows.
  - Scrolls horizontally when wider than the measure.
- **Mermaid.** Bundle `mermaid.min.js` in `JunoDesktop/Resources` and call `JunoMermaidEngine.register(script:)` in `JunoDesktopApp.init`. It renders in an opaque figure with a Source/Diagram toggle. While streaming it shows "Diagram renders when complete…".
- **Math and `:::` learning blocks:** keep the existing renderers, retuned to these tokens. `juno-visual` fences map onto `JunoLearningBlockViews`.

### 6.6 Thinking and activity, and the Thought panel

- **Live row.**
  - `JunoThinkingMatrix` at 12pt, in **neutral ink** (`junoSecondaryInk` dots, `junoForeground` for the lit cell), matching the web's `ThinkingDots` (`thinking-dots.tsx:23-33`). It is the only animated element. No violet.
  - A 13pt `junoSecondaryInk` sentence.
  - `· ` followed by `Text(timerInterval:)` in 12pt mono tertiary.
  - **Copy ladder:** "Writing the response" / "Checking your request" / "Starting your request". From 120s: "Still thinking — working in the background". From 600s: "Still thinking deeply — safe to leave; the answer will be here when you return". While recovering: "Reconnecting — the answer is still being written".
  - `.accessibilityAddTraits(.updatesFrequently)` goes on the sentence only.
  - No shine: remove `junoAIcssShine` from this path.
- **While tools run.** The row speaks in the present tense: "Searching for …", "Reading x.com". The reasoning preview sits under it at 13pt, line height 1.55, secondary ink, capped at 180pt with a top fade mask.
- **Settled.** One plain `Button`: "Thought process · 4 searches · 9 sources · 8.4s" followed by `ph.caretright.bold` 10pt, in 13pt secondary that turns primary on hover. It opens the Thought panel.
- **Data.** Activity is stored per message on `NativeChatMessage`. This replaces the conversation-wide transient state at `NativeConversationStore.swift:953, 1709`, and surfaces `researchDegradedWarning`.
- **Thought panel** (in the trailing dock; Phase 2). Opaque.
  - A 40pt header row: state word, a Filter `Menu` (Reasoning, Tools, Sources, Searches, Notices; Summary or Full trace), a Copy `Menu`, and Close. All borderless.
  - A "Find in this run" field showing n/m (⌘G).
  - A row of Elapsed / Cost / Sources figures.
  - A step list with tool arguments and results. j/k move between steps.
  - Only one of Canvas and Thought is open at a time.

### 6.7 Sources and citations

- **Pill.**
  - A 32pt capsule `Button` with `junoCard` fill and a 1pt `junoBorder`.
  - Up to 4 stacked favicon circles at 18pt, overlapping by −6, each with a 1.5pt canvas-coloured ring. A letter stands in when no favicon loads.
  - Then "Sources" at 12pt medium, the count in mono 12, and `ph.caretdown.bold` 10pt.
  - It expands in place on `JunoMotion.standard` into 36pt rows: favicon, title (13pt medium, one line), host (12pt secondary), and the number in mono trailing.
  - Delete the disclosure-in-a-card at `DesktopChatWorkspace.swift:1892-1939`.
- **Inline `[n]`.**
  - Rewritten to `juno-cite://n` links and intercepted with `OpenURLAction`.
  - Each renders as an 18pt capsule with a 14pt favicon on `junoSecondary`.
  - Clicking opens a source popover with an explicit frame of 320×140.
  - Parse `cited` from the wire.

### 6.8 Inline run cards (all opaque, one shared recipe)

- **Container:** `junoCard` fill, 1pt `junoBorder` at 80%, radius 20, 8pt inset, `.containerShape(.rect(cornerRadius: 20))`. Inner tiles use concentric radius 12. No shadow, no tint, no glass.
- **Header row (36pt):** a 16pt glyph, the title at 13pt medium, a status pill (20pt capsule, 11pt medium, tone at 12% fill with tone ink), and a trailing `ph.dotsthree` `Menu`.

**Artifact card (Phase 2):**
- Header: icon, title, `v3` in mono, "Updated", status.
- A `JunoSegmented` control: Preview / Code / Console (n).
- A fixed 320pt body: `NativeArtifactPreview`, or the highlighted code view.
- A borderless "Open in Canvas" button (`ph.sidebarsimple`, mirrored).

**Research card (Phase 5):**
- **Live:** the question, a five-step stage indicator, and publisher favicons. Stop goes through the composer disc.
- **Finished:** title at 15pt semibold, a one-line mono provenance, a verdict badge, "Open Report" (`.bordered`, opening the report `WindowGroup` with a table of contents), and a "How it worked" disclosure.

**Work card (Phase 5).** Built from the existing thread subviews (`DesktopWorkWorkspace.swift:2873-3160`). Shows only the newest run per conversation, matching `use-conversation-work.ts:58-69`.
- **Live:**
  - the current action sentence
  - "Plan" with a mono `3/7` tally and a checklist built on `ProgressView(value:total:)`
  - one metrics line
  - the last 3 turns, rendered by the Markdown renderer
  - question cards with one-press options; "Reply below" moves `@FocusState` to the composer
  - the approval queue
  - local blockers (Accessibility, Screen Recording) when the run targets this Mac
- **Finished:** outcome digest, deliverable tiles (Quick Look thumbnails; opening one opens the canvas dock), degradation notes, and "Save as a Skill…" (`.bordered`).
- **Overflow menu:** Pause / Resume / Try Again, then Details (Activity, Files & Cost).

### 6.9 Approval cards (connector and task)

- **Placement:** inside the turn, **above** the answer it blocks. This moves it from `DesktopChatWorkspace.swift:961-976`.
- **Card:**
  - `junoCard` fill, radius 16, 1pt hairline in the risk tone.
  - A risk label at 11pt medium in the tone's ink.
  - Title at 15pt semibold.
  - The preview first, in a `junoSecondary` well (radius 12, `.textSelection`).
  - "Show parameters (n)" as a disclosure.
  - `Text(timerInterval:countsDown:)` in 12pt mono tertiary.
- **Buttons** (`.controlSize(.regular)`, equal widths, wrapping via `ViewThatFits`):
  - **Connector:** "Don't allow" (`.bordered`, `role: .destructive`) · "Allow once" (`.borderedProminent`) · "Allow this action for this connector" (`.bordered`, only for reversible actions).
  - **Task:** "Don't" · "Change it…" (reveals a field and "Send This Instruction") · the action's verb, such as "Send" or "Delete for Good" (`.borderedProminent`) · a More `Menu` containing "\(Verb), and stop asking".
  - **Queue header:** "Make all N changes" (`.bordered`).
- **Nothing is bound to `.defaultAction`**, so Return never approves.
- Local runs still go through `decideLocally`.
- Remove `.junoProminentAction()` from `NativeChatApprovalView.swift:83-130`.

### 6.10 Message actions

- **Buttons:** borderless, 28×28, 16pt glyph in `junoSecondaryInk` that turns primary on hover, a `Circle().fill(junoHover)` hover fill, and `.help()` on each. No glass anywhere in the reading column; this deletes `DesktopChatWorkspace.swift:1662-1672, 1717, 1751`.
- **Reply row,** left to right:
  - The version pager `‹ 2/3 ›` in 12pt mono, when there are versions.
  - Copy (`ph.copy` → `ph.check`).
  - Good response (`ph.thumbsup`, fill cut when on).
  - Bad response (`ph.thumbsdown`).
  - **Regenerate** `Menu` (`ph.arrowclockwise`): Try Again · Switch Model ▸ (one `Section` per provider, with logos and a check on the current model) · More Concise · Add Details. These send `regenerateInstruction`.
  - **More** `Menu` (`ph.dotsthree`): Read Aloud / Stop Reading · Branch ▸ (Into a New Chat / Fork Privately) · Share Chat… · Quote in Composer · Copy Link · Divider · a disabled info section with the model name and a mono "1.2k in · 840 out · $0.012".
- **Visibility:** always visible on the newest settled reply. Older replies fade the row in on hover or focus over 120ms.
- **Deleted:** the per-reply model and cost caption (`:1384-1391, 1611-1616`), and silent Share (`:642-654`). Share now opens the popover.

### 6.11 Finish notes and errors

- **Note.** One row under the answer: `ph.info` or `ph.warningcircle` at 14pt, a 13pt secondary sentence using the web's copy ("The model stopped at its token limit.", "Stopped by user.", …), and a trailing `.bordered` `.controlSize(.small)` "Continue".
- **Error.** The same row in a radius-12 well with a `junoDestructive` fill at 7%, a hairline at 35%, destructive ink, and "Try Again".
- **Delete every `GroupBox` in the transcript** (`:1954-2007`).

### 6.12 Follow-ups

- Up to 3 **opaque** capsule chips (`JunoChipStyle`, as on the web; glass pills read as "AI suggestion bubbles"), truncating at 320pt. They sit above the composer (§5.1), left-aligned to the measure and wrapping. The composer shell stays the only glass shape in the cluster.
- **A click sends immediately.**
- Delete `NativeFollowUpStrip` from the `LazyVStack` (`:1026-1036`).

### 6.13 Scrolling

- The view follows the stream only while `atBottom`. This replaces the per-token `scrollTo` at `:1069-1098`.
- When the reader is not at the bottom, a 32pt `Button("Scroll to latest", image: .phArrowDown)` appears, centred in the cluster, with `.buttonStyle(.glass)` and `.buttonBorderShape(.circle)`.
  - It is removed from the tab order when hidden.
  - It appears with `.glassEffectTransition(.materialize)`.
- On the edge from streaming to done, post `AccessibilityNotification.Announcement("Response complete, \(n) words.")`.

### 6.14 Find in conversation (⌘F)

- A centred glass capsule in the top `safeAreaBar`, at most 480pt wide:
  - `ph.magnifyingglass`
  - `TextField("Find in this conversation")`
  - "3 of 12" in 12pt mono
  - `ph.caretup` and `ph.caretdown` (borderless)
  - "Done"
- Matches get a neutral `junoForeground` 10% background run; the current match gets 22% and is scrolled into view through `ScrollPosition` (the web scrolls the message into view and uses no coral).
- ⌘G / ⇧⌘G step through matches; Esc closes.

### 6.15 Resuming a stream

When a conversation opens, and when reachability returns, call `/api/chat/stream/active` and `/api/chat/stream/{id}?after=seq` and feed the results into the same `ChatStreamReducer`. The status row shows the "Reconnecting…" rung meanwhile.

---

## 7. Popovers, menus, sheets, dialogs, Settings, share, search

### 7.1 Recipes

| Surface | Recipe |
|---|---|
| **Menus and context menus** | Drawn by the system. Triggers use `.menuStyle(.button)` with `.buttonStyle(.borderless)` or `.plain`, plus `.menuIndicator(.hidden)` for icon-only triggers. This replaces the 29 deprecated `.borderlessButton` sites. Rows are `Label`s with 16pt symbols; on/off rows are `Toggle`; choices are `Picker(.inline)`; groups are separated with `Divider`; delete uses `role: .destructive`; shortcuts show via `.keyboardShortcut`. Title Case. No hand-drawn rows. |
| **Popovers** | System glass. No `presentationBackground`. **Every one has an explicit `.frame`.** Content padding 12. Rows 28pt with a `junoGlassHover` hover, radius 8. Sizes: account 288×284/316, share 360×232, model stage 1 384×(56+thinking), model stage 2 760×480, outputs 336×400, citation 320×140, `/@` palette 320×280. |
| **Sheets** | System presentation, so they get glass on macOS 26. Delete the custom `junoSheetSurface` fills on the Mac (7 sites). Sizing: `.presentationSizing(.form)` for New Project, Rename, Onboarding and Announcement; `.page` for Archived Chats, Upgrade, Skill Import, the Automation editor and the Assistant editor. Body is a `Form` with `.formStyle(.grouped)`. Footer: Cancel (`.cancelAction`) and one `.borderedProminent` (`.defaultAction`). **No glass controls and no toasts inside sheets.** |
| **Destructive choices** | `.confirmationDialog(title, isPresented:, titleVisibility: .visible)` with a `role: .destructive` button and the web's copy. `.alert` is for errors only. This moves `DesktopDesignScreen.swift:265`. |
| **Rename** | Inline in list rows. For page objects, a `.form` sheet with a `TextField` and Cancel/Save. |
| **Tooltips** | `.help()` only, with the shortcut in the text ("New chat  ⌘N"). |

### 7.2 Settings window (`Settings {}` scene only)

- **Layout:** `NavigationSplitView` with a sidebar source list and `.searchable(placement: .sidebar, prompt: "Search settings")`, and a `Form(.grouped)` detail.
  - Default size 820×600, minimum 680×480.
  - No custom backgrounds.
  - Rows are `LabeledContent`.
- **Sections, in the web's order** (`src/components/settings/settings-sections.ts:21-29`, checked). Labels and descriptions are generated.

| Section | Glyph | Rows to add or change |
|---|---|---|
| General | `ph.slidershorizontal` | Theme tiles; accent swatches plus a custom `ColorPicker`; text size `Slider`; interface language. Mac-only: About, Check for Updates, Diagnostics. |
| Personalization | `ph.usergear` | Response style tiles; custom instructions; response language; "What Juno calls you" |
| Memory | `ph.notepencil` | Reference saved memories; learn from past chats in the background; background processing; sensitive subjects; "Manage memories…" (opens the Memory page) |
| Models | `ph.cube` | Default model; reasoning effort; Fast mode and Web search as **synced** settings, replacing `@AppStorage` (`DesktopComposer.swift:60`); Favorites |
| Connectors | `ph.plug` | A "Connected apps" `Section` (logo, name, status, "Use in chats" toggle, Disconnect) plus "Browse Connectors…". This replaces the embedded `DesktopConnectionsScreen` (`DesktopSettingsScreen.swift:139-147`). |
| Voice | `ph.microphone` | Voice tiles with preview play/stop; dictation Pickers (Transcription, Voice mode) |
| Data & privacy | `ph.database` | Export JSON / Juno package / CSV; Import history (`.fileImporter`, progress shown in the row); Shared links; Delete all conversations (confirmation dialog) |
| Account | `ph.user` | Editable name and photo (`PhotosPicker`); two-step verification, password and email change sheets; usage stats and activity heatmap moved in from `DesktopUsageScreen`; the "Danger zone" heading becomes "Delete" |
| Plan & billing | `ph.creditcard` | Plan row with Upgrade (`.borderedProminent`) and Manage Billing (`.bordered`, `openURL`); usage meters; spend ceiling; invoices. Replaces the embedded Usage page (`:165-179`). |
| Code *(Mac, until Code's redesign)* | `juno.code` | Unchanged. The Work host tile moves to Permissions. |

- **Entry points:** ⌘,, the footer gear, account popover › Settings… or Profile…, ⌘K, and the Memory page. All go through `DesktopSettingsRouter.open(section)`, then `openSettings()`.
- **Upgrade** is a `.page` sheet:
  - 26pt semibold title
  - a Monthly / Yearly `JunoSegmented`
  - three opaque plan cards (radius 16; Pro recommended)
  - Stripe checkout in the browser for direct builds, or `SubscriptionStoreView` if an App Store build ships

### 7.3 Share popover

- **Where it opens:** the toolbar Share button, Share… in the title menu and row menus, and the artifact menus. `.frame(width: 360, height: 232)`.
- **Contents:**
  - The title "Share this chat" (or "Share this artifact") at 13pt semibold.
  - A read-only link field.
  - **Copy Link** (`.borderedProminent`; reads "Copied" for 1.5s).
  - **Revoke** (`.bordered`, destructive).
  - A caption "Snapshot of Sep 22 · 14 views" at 11pt tertiary.
  - `ShareLink(item: url) { Label("More…", image: .phShareNetwork) }`.
- **States:** loading, error and revoked states follow the web.
- **Deleted:** the silent copy at `DesktopChatWorkspace.swift:368-386, 642-654`.

### 7.4 Command and Search panel (⌘K, ⇧⌘F, the sidebar Search button)

One panel replaces the Mac's Search page, Code's separate palette, and both of the web's palettes.

- **Placement:**
  - A window-level overlay, centred on the detail column, 72pt from the top.
  - `.frame(width: 640)`, with height animated from 56 to at most 480 on `JunoMotion.layout`.
  - **No scrim.** A clear full-window layer dismisses it on click; Esc also dismisses.
- **Shell:** `GlassEffectContainer { … .containerShape(.rect(cornerRadius: 20)).glassEffect(.regular, in: .rect(cornerRadius: 20)) }`.
  - Enters with opacity and scale 0.98 on `JunoMotion.standard`; exits over 160ms on `in`.
- **Field row (56pt):** an 18pt `ph.magnifyingglass`, a 17pt `TextField("Search or start a chat")`, and an "esc" keycap.
- **Search mode** (⇧⌘F or the sidebar button) adds a filter row:
  - type chips (Everything, Chats, Messages, Projects, Files, Knowledge, Artifacts, Memory, Tasks), each a 24pt capsule at 12pt medium; the selected chip gets `junoGlassFill` and primary ink
  - an "Any Time ▾" `Menu`
  - an "All Projects ▾" `Menu`
- **Results:**
  - Section captions at 11pt medium secondary.
  - 36pt rows: a 16pt glyph, a 15pt title with the matched run in semibold, a 12pt secondary subtitle, and a ↩ keycap on the selected row.
  - The selected row uses `junoGlassHover` in `ConcentricRectangle`.
  - Keys via `.onKeyPress`: ↑, ↓, ↩, Tab, Esc.
- **Empty query:**
  - **Actions:** New Chat ⌘N · New Private Chat ⇧⌘N · New Code Session · New Automation · New Assistant · Open Library, Projects, Artifacts, Design, Connections, Skills, Automations, Permissions, Memory · Toggle Sidebar ⌃⌘S · Settings ⌘, · Plans & Upgrade · Keyboard Shortcuts ⌘/.
  - Then 5 recent chats.
- **Engine:** the on-device encrypted index (kept from `DesktopSearchScreen.swift`, so it works offline) merged with `/api/search` for Memory, Knowledge and Tasks. Requests are debounced by 180ms and the previous one is cancelled.

### 7.5 Outputs popover

`.frame(width: 336, height: 400)`. Two sections:
- **"Outputs":** a 2-column grid of 64pt tiles (glyph, title, kind). Clicking one opens the canvas dock.
- **"Used in this session":** rows with favicon, title and host.

### 7.6 Account popover

See §2.7.

### 7.7 Toast (`DS/JunoToastHost.swift`)

- **One window-level host.** A glass capsule (`.glassEffect(.regular, in: .capsule)`), at most 420pt wide.
- **Position:** 12pt above the composer's top edge, or 24pt above the window bottom when there's no composer.
- **Contents:** a status glyph in its status colour (`ph.checkcircle` success ink, `ph.warningcircle` destructive ink, `ph.warning` warning ink, `ph.info` secondary), 13pt text, and an optional borderless action ("Undo").
- **Timing:** auto-dismiss after 4s. Enters with a 4pt rise and fade over 220ms `outSoft`; exits over 160ms `in`.
- **Posting:** pages post through an environment notifier.
- **"Selection" mode** is the Library's multi-select action capsule.
- **Deleted:** the five per-screen toasts (`DesktopLibraryScreen.swift:900-915`, `DesktopProjectsScreen.swift:477-503`, `DesktopArtifactsScreen.swift:634-651`, `DesktopArtifactCanvas.swift:1019`, `DesktopSettingsScreen.swift:448-466`).
- Never shown inside a sheet.

### 7.8 Menu bar (`App/DesktopCommands.swift`, generated from `JunoShortcutRegistry`)

| Menu | Items |
|---|---|
| File | New Chat ⌘N · New Private Chat ⇧⌘N (always present; fixes `:89-107`) |
| Edit | Find in Conversation ⌘F · Find Next ⌘G · Find Previous ⇧⌘G |
| View | Chat ⌘1 · Code ⌘2 · Toggle Sidebar ⌃⌘S (system `SidebarCommands`; ⇧⌘S stays Save As) · Command Menu… ⌘K · Search… ⇧⌘F |
| **Chat** (enabled while Chat is focused) | Attach Files… ⌘U · Attach Screenshot ⇧⌘U · Focus Composer ⇧⎋ · Stop Generating ⌘. · Regenerate ⌘R · Copy Last Response ⇧⌘C · Copy Last Code Block ⇧⌘; · Divider · Rename… · Pin · Add to Project ▸ · Share… · Archive · Delete… (no shortcut: menu shortcuts fire before the focused text field, and ⌘⌫ is delete-to-line-start in the composer) |
| Session | Code only; shown only while Code is focused |
| Window | System items (the Phases 1–4 Tasks (Legacy) item was removed in Phase 5 Stage D, §1.6) |
| Help | Keyboard Shortcuts ⌘/ |

### 7.9 Keyboard Shortcuts window

- Generated from the same `JunoShortcutRegistry` that `DesktopCommands` reads, so the two cannot drift.
- Two columns of grouped rows: Everywhere, Products, Composer, Responses.
- Keycaps sit on `junoSecondary` at radius 6.
- No zebra striping (replaces `.inset(alternatesRowBackgrounds: true)` at `:113`).

### 7.10 Quick Entry and the menu-bar extra

- **Quick Entry (⌥Space).**
  - Keep the non-activating `NSPanel`. Its content is `JunoComposerShell` plus the same product switch (Chat and Code). This is the one custom glass site that isn't inside the main window.
  - Remove its JunoMark.
  - A former "errand" opens a chat with "Do This as a Task" armed.
  - Sending brings the existing main window forward through `DesktopWorkbenchRegistry` and `NSApp.activate`, instead of `openWindow` (`DesktopQuickEntry.swift:240`).
- **MenuBarExtra.**
  - Label: `juno.chat` as a template image, with a count only when something needs you.
  - Contents: New Chat · chats that need you · live Code sessions · Open Juno.
  - Uses the same bring-forward path (replacing `:46, 64, 83`).

### 7.11 Notifications (Phase 5)

- When the Needs-you count rises, post a `UNUserNotificationCenter` notification with thread id `juno-needs-you` that deep-links to the conversation, and set `NSApp.dockTile.badgeLabel` to the count.
- Ask for authorization the first time the user starts a task, not at launch.

### 7.12 Onboarding and announcements (Phase 3)

- **First run:** a `.form` sheet over the empty chat with a name field, three theme tiles and accent swatches. It writes the same settings patch as the web.
- **Announcements:** a `.page` sheet (title, body, dismiss) that writes `announcement_dismissal`.

---

## 8. Design tokens for SwiftUI

Everything is generated by `scripts/generate-design-tokens.ts` into `DS/Generated/JunoGeneratedTokens.swift` (digest `6758dd029dc09830` today). The generator is extended to cover type, spacing, borders and shadows.

**Delete:**
- `warmWhite` / `warmBlack` (`DS/JunoDesignTokens.swift:59-82`)
- the hand-written neutral alphas (`DS/JunoSurfaces.swift:26-63`)

Old accessors become deprecated aliases with fix-its.

### 8.1 Colour

| Swift | Web source | Light | Dark | Use |
|---|---|---|---|---|
| `junoCanvas` | `--background` | #FAF9F6 | #1F1D1C | Window `containerBackground`; the reading plane |
| `junoCard` | `--card` | #FEFDFC | #252422 | Run cards, code, tables, sources pill, attachment cards |
| `junoSecondary` | `--secondary` | #F2F0EB | #302E2C | User bubble, wells, inline code, pressed chips, keycaps |
| `junoHover` | `--accent` (the neutral hover) | #EEECE5 | #383633 | Hover fill on opaque content |
| `junoBorder` | `--border` | #E1DFD8 | #3C3937 | Hairlines at 0.8 (1.0 under Increase Contrast) |
| `junoInput` | `--input` | #CECAC0 | #484541 | Field hairlines on content |
| `junoForeground` | `--foreground` | #1D1D1B | #F4F3F1 | Primary ink |
| `junoSecondaryInk` | `--muted-foreground` | #6A6862 | #AEAAA3 | Secondary text, glyphs at rest, placeholders |
| `junoTertiaryInk` | `--muted-foreground` × 0.7 | — | — | Metadata, keycaps |
| `junoSidebarInk` | `--sidebar-foreground` | #504E49 | #B7B4AE | Sidebar glyphs at rest |
| `junoAccent` | `--primary` (by accent) | #B55636 | #B55636 | The action colour (§0.4) |
| `junoAccentInk` | `--primary-ink` (**new accessor**) | #AD5234 | #DE8D73 | Links, accent text, code keywords |
| `junoOnAccent` | `--primary-foreground` | #FFFFFF | #FFFFFF | Glyph on coral |
| `junoRing` | accent-block `--ring` | #5F5C54 | #D1CFC7 | Focus. Equal to the graphite `AccentColor` asset, which is kept. |
| `junoSuccess` / `Ink` | `--success` / `-ink` | #4F9C68 / #347449 | #60AF7A | Status |
| `junoWarning` / `WarningInk` | `--warning` / `-foreground` | #B48931 / #846424 | #D4A954 / #EAC886 | Status; "N left" |
| `junoDestructive` / `DestructiveInk` | `--destructive` / `-ink` | #B9533C / #A2442F | #BF553E / #C86B56 | Status; delete |
| `junoSource` | `--source` | #21808C | #34B5C5 | Citation accents |
| `junoCodeString` / `Number` | `--code-*` | #22774F / #9C5B11 | #57C793 / #F5B13D | Syntax |
| `junoGlassHover` | derived from `--hairline` | foreground 6% | foreground 8% | Hover inside glass |
| `junoGlassFill` | derived | foreground 8% | foreground 12% | Resting fill inside glass: voice disc, marks, plan pill, search button |
| `junoSelectedFill` / `Edge` | `--sidebar-selected` / derived edge | opaque generated value / foreground 12% | opaque generated value / foreground 14% | Sidebar selection. **Opaque** so the system-accent highlight never shows through. The edge goes to 24% under Increase Contrast. |

- **Not painted on the Mac:** `--sidebar*` (except the step used to derive the selection pair), `--popover` (system glass), `--scrim`.
- **Accent:** the user's Juno accent (coral, juniper, teal, violet, amber, sage) resolves `junoAccent`, `junoAccentInk` and `junoOnAccent` from `JunoGeneratedAccentPalette` via `JunoAccentSelection`. It is applied as in §1.2. Fix the stale comments at `DS/JunoColors.swift:23` and `DS/JunoDesktopChrome.swift:115-117`.
- **Test that must stay true:** canvas (11.5%) < card (14%) < popover (16.5%), in `JunoDesignTokensTests.testDarkCanvasIsDarkerThanEverySurfaceAboveIt`.

### 8.2 Type (`JunoGeneratedType`, from `tailwind.config.ts:280-431`)

| Rung | SwiftUI | Size / line height / tracking / weight | Use |
|---|---|---|---|
| display | `.junoDisplay(size)` / `.junoDisplayItalic(size)` | Newsreader Regular/Italic, 32–48 fluid, ×1.08, −0.02em, 400 | Greeting only |
| pageTitle | `.junoPageTitle` | SF 26 semibold, ×1.15, −0.02em | Page headers, Upgrade, onboarding, "You're incognito" |
| title | `.junoTitle` | SF 22 semibold, ×1.25, −0.012em | Sheet heroes |
| heading | `.junoHeading` | SF 18 semibold, ×1.3, −0.006em | Sheet titles, card titles |
| bodyLarge | `.junoBodyLarge` | SF 17, ×1.5 | Ledes, search field, empty-state titles |
| body | `.junoBody` | SF 15, ×1.6 (prose ×1.65) | Transcript, bubble, composer field |
| ui | `.junoUI` | SF 13, ×1.4 (the Mac's `.body`) | Controls, rows, chips, menus |
| label | `.junoLabel` | SF 12 medium, +0.01em | Metadata, pills |
| caption | `.junoCaption` | SF 11, +0.02em | Footnotes, section captions in panels |
| micro | `.junoMicro` | SF Mono 10.5, +0.02em | Keycaps, machine metadata |
| mono | `.junoMono(12 \| 13)` | SF Mono | Code (13 on a 20pt line), ids, counts, costs |

- Each rung is `Font.system(size:weight:)` or `Font.custom(_:size:relativeTo:)`, plus `.tracking` and `.lineHeight(.multiple(factor:))` (SC:11518).
- SF Pro stands in for Inter, and SF Mono for JetBrains Mono.
- Weights stop at semibold. No uppercase.

### 8.3 Spacing and layout

- **Generated `JunoSpace`:** 2, 4, 6, 8, 10, 12, 14, 16, 18, 20, 24, 28, 32, 40, 48. This is the web's 4pt grid plus its 18 step; it deliberately does not follow the skill's 8pt grid.
- **Gutter:** 16 / 24 / 32 at detail width below 640 / below 1024 / 1024 and up.
- **Measures:** reading 768, wide 1024.
- **Transcript turn gap:** 24. **Page section gap:** 32.

### 8.4 Radii and the concentric rule

| Alias | Value | Use |
|---|---|---|
| micro / sm | 2 / 4 | Rules, tiny chips |
| xs | 6 | Marks, keycaps, inline code |
| md | 8 | Popover rows, bubble tail |
| **control** | 10 | Sidebar pill, inner hover fills, search button |
| **field** | 12 | Code, tables, wells, inner run tiles, attachment tiles |
| **menu** | 14 | Segmented track (system menus draw their own) |
| **card** | 16 | Bubble, approval card, content cards, empty-state well |
| **panel** | 20 | Composer, run cards, command panel |
| full | capsule | Chips, pills, toast, find bar |

- Add `control`, `menu` and `panel` to `JunoRadius` (`DS/JunoSurfaces.swift:251-283`).
- Any container that insets children declares `.containerShape(.rect(cornerRadius: R))`, and the children use `ConcentricRectangle()` or `.rect(corners: .concentric(minimum: 10))` (SC:16934-17016). This is the native form of the web's `design-system/concentric-radius` lint rule.
- Do **not** use `.rect(corner: .containerConcentric)` from the WWDC talk; that spelling is not in the SDK.

### 8.5 Motion (`JunoMotion`, built from `JunoGeneratedEasing`)

| Token | Value | Use |
|---|---|---|
| press | 70ms outSoft (0.33, 1, 0.68, 1) | Scale 0.97 |
| fast | 120ms outSoft | Hover, face swaps, action-row reveal |
| exit | 160ms in (0.4, 0, 1, 1) | Everything leaving |
| base / riseIn | 220ms outSoft, 6pt | Greeting, chips, turns, toasts |
| slow | 360ms outExpo | AI title cross-fade in rows |
| standard | spring 0.22s, bounce 0.05 | Selection, composer growth, tiles, segmented thumb |
| emphasized | spring 0.36s, bounce 0.10 | The handoff (§10) |
| layout | spring 0.36s, bounce 0 | Dock, panel height |
| Loops | matrix 1.8s · status breathe 2.8s · skeleton breathe 1.8s | Live state only |

- Rebuild `press`, `fast` and `exit` from the generated curves instead of `.easeOut`/`.easeIn` (`DS/JunoDesignTokens.swift:215-250`).
- `riseIn` becomes outSoft over 220ms (it is outStrong over 360ms at `:349`).
- Keep the Mac `platformFactor` of 0.75, applied to springs only, and record it.
- **Reduce Motion, in tiers:**
  - opacity and colour keep their timing
  - travel and scale drop to 0, and springs become outSoft
  - loops stop
  - on 26.4 and later (gated), `accessibilityPrefersCrossFadeTransitions` forces cross-fades
- **No hover articulation on icons.** State swaps use `.contentTransition(.symbolEffect(.replace))`.

### 8.6 Icons

**Pipeline.** Rewrite `scripts/generate-native-icons.mjs`:
1. **Phosphor:** read `node_modules/@phosphor-icons/react/dist/defs/<Name>.es.js` for the `regular`, `bold` and `fill` weights. These are already filled outlines on the 256 grid.
2. **Juno marks:** move the path builders from `src/components/ui/juno-glyphs.tsx` into a JSX-free `src/components/ui/juno-glyph-paths.ts` that both sides import.
   - Outline the stroke marks once and commit the outlined sources under `scripts/icon-sources/juno/`, so CI needs no Python.
   - The private ghost comes from `private-chat-toggle.tsx`, with static eyes.
3. **Output:** a **static** `.symbolset` (Regular-M) per cut into `native/macOS/JunoDesktop/Resources/Icons.xcassets` and the iOS catalog.
   - Names: `ph.<name>`, with `.bold` and `.fill` twins. Names are lowercase and hyphen-free.
   - Static masters avoid the point-compatibility problem of interpolated Ultralight/Black masters.
4. **Check mode:** add `--check`. Validate one generated template in the SF Symbols app and keep it as the fixture test.
5. **Cleanup:** delete the 173 Lucide `nav-*` imagesets in `Navigation.xcassets`.
6. **`JunoIcon`:** remap onto the web registries (`AppIcons`, `ComposerIcons`, `ActionIcons`, `StatusIcons`, `SettingsIcons`). `JunoIconView` picks the `.bold` cut at 13pt or smaller, and `.fill` only for on/selected states. Keep `JunoBrandTests` green.

- **Sizes:** 12 (bold) · 14 · **16 (default)** · system sizing in the sidebar and menus · 20 (empty states).
- **The system keeps what it owns:** the sidebar toggle, magnifiers inside system search fields, menu checkmarks, disclosure chevrons, spinners (`ProgressView`), window controls, and the system share sheet's own glyph.

| Concept (web export) | Mac symbol | Where |
|---|---|---|
| JunoChat / JunoCode / JunoDesign / JunoLibrary | `juno.chat(.fill)` / `juno.code(.fill)` / `juno.design` / `juno.library` | Product switch, Auto mark, menu-bar extra; Code chip; Design row; Library |
| Send | `juno.send.bold` | Send face |
| Private ghost | `juno.ghost(.fill)` | Private toggle |
| Plus | `ph.plus` | New chat, `+`, New Project |
| MagnifyingGlass | `ph.magnifyingglass` | Search button, panel, find |
| Folder / FolderOpen / Stack | `ph.folder` / `ph.folderopen` / `ph.stack` | Projects, Artifacts |
| DotsThree | `ph.dotsthree` | More, row/card/message overflow |
| Robot / Plug / Scroll / TreeStructure / ShieldCheck | `ph.robot` / `ph.plug` / `ph.scroll` / `ph.treestructure` / `ph.shieldcheck` | Assistants, Connections, Skills, Automations/Task/Plan, Permissions |
| Archive / BoxArrowUp | `ph.archive` / `ph.boxarrowup` | Archive, Restore |
| GearSix / SignOut | `ph.gearsix` / `ph.signout` | Settings gear, Sign Out |
| ShareNetwork / LinkSimple | `ph.sharenetwork` / `ph.linksimple` | Share, Copy Link |
| PushPin / PushPinSlash | `ph.pushpin(.fill)` / `ph.pushpinslash` | Pin, Unpin |
| Paperclip / Scan / ImageSquare / FileText | `ph.paperclip` / `ph.scan` / `ph.imagesquare` / `ph.filetext` | Attach, Screenshot, photos, file cards, Outputs |
| Binoculars / GlobeSimple / NotePencil / FileMagnifyingGlass | `ph.binoculars` / `ph.globesimple` / `ph.notepencil` / `ph.filemagnifyingglass` | Deep Research, Web Search, Memory, My Documents |
| Microphone / MicrophoneSlash / Waveform / PhoneDisconnect / MonitorArrowUp | `ph.microphone(.slash)` / `ph.waveform` / `ph.phonedisconnect` / `ph.monitorarrowup` | Dictate, mute, voice face, end call, share screen |
| Square | `ph.square.fill` | Stop face |
| Copy / Check / X | `ph.copy` / `ph.check` / `ph.x` | Copy→copied, ticks, dismiss |
| ThumbsUp / ThumbsDown | `ph.thumbsup(.fill)` / `ph.thumbsdown(.fill)` | Feedback |
| ArrowClockwise / PencilSimple / Trash | `ph.arrowclockwise` / `ph.pencilsimple` / `ph.trash` | Regenerate, Edit/Rename/Write chip, Delete |
| GitBranch / SpeakerHigh / Quotes | `ph.gitbranch` / `ph.speakerhigh` / `ph.quotes` | Branch, Read Aloud, Quote |
| CaretDown / Up / Right / ArrowDown / ArrowUpRight | `ph.caret*.bold` / `ph.arrowdown` / `ph.arrowupright` | Chips, pager, Scroll to latest, external links |
| Info / Warning / WarningCircle / CheckCircle / CloudSlash | `ph.info` / `ph.warning` / `ph.warningcircle` / `ph.checkcircle` / `ph.cloudslash` | Notices, toasts, sync mark |
| HandPalm / DownloadSimple / Laptop / EyeSlash | `ph.handpalm` / `ph.downloadsimple` / `ph.laptop` / `ph.eyeslash` | How Often It Asks, update row, This Mac, private in lists |
| SlidersHorizontal / UserGear / Cube / Database / User / CreditCard | `ph.slidershorizontal` / `ph.usergear` / `ph.cube` / `ph.database` / `ph.user` / `ph.creditcard` | Settings rail |
| CircleNotch | — (`ProgressView`) | Busy |

### 8.7 Gates

- **`scripts/check-native-glass.mjs:51-66`:**
  - Add patterns for `junoFloatingChrome(`, `junoGlassButton(`, `junoProminentGlassButton(`, `junoProminentAction(`, `buttonStyle(.glass`, `.glassProminent` and `JunoGlassBackground`.
  - Allow-list only `JunoComposerShell.swift`, `DesktopSearchPanel.swift`, `DesktopFindBar.swift`, `JunoToastHost.swift` and `DesktopQuickEntry.swift`.
  - Flag any glass inside `.sheet` or `.popover` content.
  - Fix its stale header (`:34-35`).
  - Re-baseline.
- **`scripts/check-native-targets.mjs`:** make it platform-aware. macOS uses AppKit control metrics (28pt with `.contentShape`); iOS keeps 44.

---

## 9. Secondary pages

**Template.** Add `JunoPage`, `JunoPageHeader` and `JunoPageControls` to `DS/`. All page content is opaque and sits on the canvas.

- **Header** (in content; the toolbar title is removed per §1.3):
  - the page's own name in `.junoPageTitle` ("Library", not "Your files")
  - a lede in 15pt `junoSecondaryInk`
  - trailing actions: `.bordered`, plus at most one `.borderedProminent`
  - then a 1pt `junoBorder` divider and 24pt of space
- **Controls row:**
  - a search field (plain `TextField` with `ph.magnifyingglass` on a `junoInput` hairline, radius 10, 28pt)
  - a `JunoSegmented` filter with counts
  - a sort `Menu`
  - a Grid/List `JunoSegmented`
- **`JunoSegmented`** replaces `DesktopSegmented.swift` and every system `.segmented` Picker in content (Library ×2, Connections, Artifacts), which currently draw the system accent:
  - Track: `junoCanvas` fill, 1pt `junoBorder` at 0.8, radius 14, padding 4, 32pt tall.
  - Thumb: `junoCard` with a hairline and `0 1px 2px` ink at 4%, radius 10, moving on `JunoMotion.standard`.
  - Labels 13pt medium. Counts in 10.5pt mono at 70%.
- **Empty state** (`JunoEmptyState`, rebuilt; replaces `DS/JunoDesktopChrome.swift:526-590`):
  - a dashed `junoBorder` well at radius 16
  - a 48pt tile (radius 12, `junoCard`, hairline) holding a 24pt secondary glyph
  - a 17pt semibold title
  - a 15pt secondary description at most 384pt wide
  - a `.bordered` action
  - rise-in on entrance
- **Detail pages** (project, automation, skill, host) push onto a `NavigationStack` inside the detail column and use the system back button.
- **Removed from page content:** `.glassProminent` buttons (`DesktopProjectsScreen.swift:268, 1151, 2436, 2533`; `DesktopWorkWorkspace.swift:1213`).

| Page | Measure | Pattern |
|---|---|---|
| **Library** | wide | Filters: All / Images / Files / On this Mac (with counts). Sort: Newest, Oldest, Name, Largest. Views: **Grid** (adaptive `LazyVGrid(minimum: 168)` of opaque tiles, radius 16, 4:3 thumbnail inset at radius 12, name 13pt medium, meta in 11pt mono) or **List** (sortable `Table`: Name, Kind, Size, Modified, Source chat). Double-click opens `.quickLookPreview`; files drag out. Context menu: Open, Quick Look, Rename…, Versions…, Download…, Open Source Chat, Divider, Delete…. The header has a "Recently deleted" toggle. Multi-select raises the toast host in selection mode. Needs `conversationId` and versions added to the library wire format. |
| **Projects** | wide | Header action "New project" (`.borderedProminent`). Filters: All / Pinned (with counts), search, sort (Last Updated, Name, Most Chats). Grid of opaque cards (minimum 240): cover or glyph tile, name at 15pt semibold, a 2-line instruction preview, counts in mono, pin on hover. **Detail:** the caption "Project", the name, a mono lede with counts, and actions Instructions…, pin and `ph.dotsthree`. `JunoSegmented`: Overview · Tasks (Phase 5) · Sources · Settings. Overview is the chat list plus the docked composer ("New chat in {Project}"), with a trailing rail (Instructions, Sources, Memory). Settings holds task defaults (Phase 5). |
| **Artifacts** | wide | Type `JunoSegmented` (only when there is more than one type), search, Grid/List, "New design" (`.bordered`). Opening one routes to its chat and slides in the canvas dock. "Open in New Window" stays as a Mac extra. Context menu: Open in Canvas, Open Conversation, Rename…, Save Source As…, Share…, Delete…. **Canvas dock** (Phase 4): an opaque header row (title, version, save state, Share, More ▸ Export Word/Excel/PowerPoint via the server, Versions popover with a diff, Fullscreen over the chat column, Close); a Preview/Code/Console `JunoSegmented`; editable code saved as new versions; preview widths Fit / 834 / 390; Run Again; Ask/Modify on a selection through a `WKWebView` script bridge into the quote card; React (UMD plus Babel standalone) and Mermaid bundled and registered at launch. |
| **Memory** | reading | Reached from Settings › Memory and ⌘K. Title "What Juno remembers", with a "Memory settings" `.bordered` action. A two-tile stat row with a backfill `ProgressView`; a Summary card with an instruction field; an Edits disclosure (Accept / Undo) that merges in "What Juno noticed"; `JunoSegmented` Topics / All facts (native `Table`) / Recap; a privacy strip (pause toggle, Import `.page` sheet, Export, Reset via a confirmation dialog). No back button. Needs `/api/memory/recap`, `/backfill`, `/edit*` and `/import`. |
| **Connections** | wide | All apps / Connected, search, category chips. "Connected" and "Available" sections of opaque tiles: 32pt logo, name, one-line description, status dot; connected tiles get a "Use in chats" `Toggle(.switch)` and Disconnect (`.bordered`), others get Connect or "Set up ↗". The browser hand-off for credential connectors is kept. |
| **Skills** *(Phase 4)* | reading | Actions: Import… and New skill (`.borderedProminent`). An inset `List`: name, `/slug` in mono, trust badge, availability `Toggle`. **Detail:** a grouped `Form` ("How Juno may use it" toggles, a Trust `JunoSegmented`, instructions in an opaque `TextEditor` well, a Versions list with Restore). GitHub import is a `.page` sheet. |
| **Automations** *(Phase 4)* | reading | Action: New automation. `List` sections Active and Paused: status dot, name, next-run caption, trailing `Menu` (Run Now, Pause/Resume, Its Task). The editor is a `.page` `Form` in the web editor's order (What It Runs, Name, Triggers as editable rows, Timezone, Where It Runs, Budget, Model, Runs at Once, Policies); the JSON editor is dropped. Detail shows Recent Runs, each opening its conversation from Phase 5 on. Replaces `DesktopWorkAutomations.swift`, Work › Schedules and Tasks. |
| **Permissions** *(Phase 4)* | reading | A grouped `Form`. "Your Macs": this Mac first with a live dot, then the others; each pushes a host page built from `DesktopWorkHostTile` content and `DesktopWorkGrants` folders, with Revoke behind a confirmation. "Juno always asks first" as a static list. "How much it asks otherwise": three read-only rows with Default marked. |
| **Assistants** *(Phase 4)* | wide | Action: New assistant. An adaptive grid of opaque cards plus a dashed "New assistant" tile. Context menu: Pin, Edit…, Delete…. The editor is a `.page` sheet with a two-column grouped `Form` (model Picker, starters as an editable list). A card starts a chat with its `assistantId`. |
| **Archived Chats** | sheet `.page` | A `List` with Restore and Delete… on each row |
| **Design** | wide | The existing `DesktopDesignScreen`, moved onto `JunoPage`. Its own redesign is out of scope. |
| Search, Settings, Upgrade | — | §7.4, §7.2 |
| Compare, Roadmap | — | Not in this pass. Roadmap is linked to the web from Help and ⌘K. |

---

## 10. The signature detail, and what not to do

### 10.1 Signature: the composer handoff

In a new chat, one glass shape (radius 20, `.regular`) floats centred under "How can I help, *Liam*?" on warm paper or warm charcoal.
- Everything inside it is quiet: borderless controls in secondary ink.
- The only colour on screen is the disc. It stays a grey waveform until you type, then turns into a coral Juno Send in 120ms.

On first send, a single `withAnimation(JunoMotion.emphasized)` transaction runs:
1. The greeting leaves: opacity to 0, −4pt, scale 0.985, over 160ms on `in`.
2. The chips fade out over 120ms.
3. `lift` animates to 16. The **same** composer view, so the same identity, focus and draft, slides to its dock. Liquid Glass bends the transcript as it settles.
4. The first user bubble rises 6pt into place after a 60ms delay.

Nothing else moves. Under Reduce Motion the whole sequence is a 160ms cross-fade.

**Acceptance (Phase 1):**
- 60fps in a 1240×800 window
- no jump at the `safeAreaBar` boundary
- focus stays in the field

### 10.2 Don't

1. **Glass on content.** Messages, bubbles, message actions, run and approval cards, code, tables, rows, page tiles, dock bodies and empty states are never glass. No glass inside sheets or popovers. No glass inside glass.
2. **Custom backgrounds** behind the sidebar, toolbar, menus, popovers or sheets. **Shadows or custom strokes on glass**, except the private dashed edge and the drop-target edge.
3. **Accent outside §0.4.** No coral name, no coral selection, no tinted toolbar glyphs, no system-blue segments anywhere outside the design canvas.
4. **Decorated greetings.** No Juno mark, spinner or logo beside the greeting, and no time-of-day copy.
5. **AI-demo styling.** No glows, auras, radial gradients, shimmer or shine text, gradient meters, halo shadows, purple-blue gradients, or violet anywhere.
6. **Uppercase or monospaced labels.** No uppercase eyebrows or labels, no monospaced section headers, no "Danger zone". Mono is for code, ids, counts and costs only.
7. **Duplicates.** A second sidebar toggle, New chat in both the toolbar and the visible sidebar, Search in the toolbar, a second microphone, a separate thinking chip, two chords for one command, or three routes to Settings.
8. **Nested boxes.** No `GroupBox` or card inside a card, no disclosure inside a card for sources, no left-border accent callouts, no 72pt circle plates.
9. **"AI magic" iconography.** No `sparkles`, bolts or brain glyphs for AI; no emoji as icons; no Lucide 2pt strokes.
10. **Touch sizing on the Mac.** No 44pt pointer targets, and no `.controlSize` in toolbar items.
11. **Decorative motion.** No hover articulation on icons, no streaming caret, no more than one looping animation per turn, and no animating height (the composer field is the one exception).
12. **Crash patterns.** No conditional `ToolbarItem`s, self-sizing popovers, or cross-fades between split views.
13. **Dead or silent controls.** No silent Share, no Canvas toggle that does nothing, no hard-coded "Owner · Pro", no "Choose model" with no reason given, no disabled Share on pages.
14. **Clutter.** No per-screen toasts, no status line under every reply, no model/cost footer, no avatars or names on turns.

---

## 11. Implementation order

Every phase builds, passes `npm run design:tokens:check`, the extended glass gate, `native:contract:check` and the native test targets, and ends with screenshots in light and dark with the system accent set to Blue.

### Phase 1: Shell, sidebar, toolbar, empty state, composer (fixes every problem in the screenshot)

**1a. Foundations**
- **Tokens:**
  - `junoCanvas` from `JunoGeneratedColors.background`; delete `warmWhite`/`warmBlack` and the alphas in `JunoSurfaces.swift:26-63`.
  - Add `junoAccentInk`, `junoGlass*` and `junoSelected*`.
  - Generate `JunoGeneratedType` and `JunoSpace`.
  - Add the `JunoRadius` aliases.
  - Rebuild the motion easings.
- **Fonts:** fix `JunoSerif`; add `Newsreader24pt-Italic.ttf`.
- **Icons:** the generator rewrite with `--check`, the `ph.*` and `juno.*` symbol sets, the `JunoIcon` remap, and deletion of `Navigation.xcassets/nav-*`. Fix the Lucide doc comments (`DS/JunoBrand.swift:78-82, 409-420`).
- **Gates:** the glass gate extension and a platform-aware targets gate (§8.7). Rebuild the stale Design editor bundle (`design:editor:check` fails today).

**1b. Shell**
- `JunoDesktopApp.swift`: drop `.hiddenTitleBar`, set minimum 820×560, delete the Incognito `Window`.
- `DesktopProductMode.swift`: Chat and Code, plus the hidden `.legacyWork` (§1.6); the product switch (§1.4); ⌘1/⌘2.
- `JunoDesktopWorkspaceView.swift`: remove the `.work` branch from the switch path and the errand routing (`:81-87`); keep swaps instant.
- `DesktopWorkbenchRegistry.requestWorkErrand`: open a new chat instead. It arms the task from Phase 5.
- Rewrite `DesktopChatSidebar.swift` (§2, except Needs-you) and `DesktopNavigationState.swift` (New chat untagged; title source).
- `DesktopCodeAccountFooter.swift` becomes `DesktopAccountFooter.swift` (§2.7).
- `DesktopChatWorkspace.swift`: extract `ChatDetail`/`ChatToolbar` (§3), move to `containerBackground`, add the title, subtitle and title menu, remove `junoReadingCanvas()` and `junoToolbarMetrics()`.
- `JunoDesktopRootView.swift`: remove the offline banner (§1.5).
- Delete `DesktopSettingsModal.swift`, the `.settings` destination, `DesktopTasksScreen.swift` with its inspector and SceneStorage, the Usage destination (Settings › Plan & billing still shows its content until Phase 3), and `DesktopSidebarDesignRow`.
- `DesktopCommands.swift`: the minimum changes, i.e. ⌘1/⌘2, no ⌘3 or ⇧⌘O, ⇧⌘N always present, screenshot on ⇧⌘U, and Window › Tasks (Legacy).

**1c. Empty state:** `DesktopEmptyChat.swift` (§4). Delete `DesktopChatAura.swift`. The Mac stops using `JunoGreeting`, `JunoComposerAura` and `JunoProviderGlow`; iOS keeps them.

**1d. Composer**
- `DS/JunoComposerShell.swift` plus `App/ChatComposer.swift`, `ComposerPlusMenu.swift`, `ComposerModelChip.swift` and `ComposerDictation.swift` (replacing `DesktopComposer.swift` and `DesktopDictation.swift`):
  - the single glass shape and `safeAreaBar`
  - the primary faces
  - the `+` menu without Skill or Task
  - the two-stage model popover
  - armed marks
  - attachment tiles, drop and paste
  - in-shell dictation and the cleaned-up call bar
  - inline private mode (delete `DesktopIncognito.swift`)
  - quota and offline captions, placeholders, keys
- `NativeConversationStore.swift:1513`: keep every modality.
- `DesktopQuickEntry.swift`: the shared shell and switch, and bring the window forward.
- The handoff (§10.1).

**Phase 1 acceptance:**
- One sidebar toggle, and an icon-only switch with no blue when the accent is Blue.
- No Work anywhere except Window › Tasks (Legacy).
- A warm charcoal canvas in dark mode.
- A title in the toolbar; the toolbar capsule shows only Private on a draft.
- "How can I help, *Liam*?" in Newsreader, with no mark.
- One microphone and "Auto" as the model.
- The crash repro passes: 50 Chat↔Code swaps, repeated sidebar toggles, and every `toolbarItemHidden` flip with the model popover open.
- The handoff meets §10.1.

### Phase 2: Transcript

1. Split `DesktopChatWorkspace.swift` into `ChatTranscript.swift`, `MessageRow.swift`, `MessageActions.swift`, `SourcesPill.swift`, `ActivityRow.swift`, `FindBar.swift` and `InlineArtifactCard.swift`.
2. Prose, type and the user turn. Render sent and generated attachments.
3. `JunoAIcssCode.swift`: highlighting, one `Text` per block, gutter at 8+ lines, 520pt cap. Tables. Mermaid bundle and registration. `juno-visual` mapping. `JunoMarkdownView.swift`: remove the caret, add the tail mask.
4. Activity stored per message, the status ladder, and the settled row. Generalise `DesktopArtifactDock` into `TrailingDock` with the Thought panel.
5. Sources pill, `juno-cite://` and `cited` on the wire.
6. Finish notes and errors (remove the `GroupBox`es). Message actions and menus (`regenerateInstruction`). Follow-ups in the cluster.
7. Scroll anchoring, Scroll to latest, the completion announcement, find (⌘F), and stream resume.
8. Restyle and move `NativeChatApprovalView.swift` (§6.9). Add preflight clarification to the composer.

### Phase 3: Popovers, menus, sheets, Settings

1. Move all 29 menu triggers to `.menuStyle(.button)`. Build the full menu bar and `JunoShortcutRegistry`, and generate `DesktopShortcutsWindow`.
2. `DesktopSearchPanel.swift` (§7.4). Delete `DesktopSearchScreen.swift` but keep its local-index query service. Retire Code's duplicate palette shell. Remove Memory from More.
3. `DesktopSharePopover.swift`, the Outputs popover, the account popover, and `JunoToastHost` (deleting the five per-screen toasts).
4. Confirmation dialogs and inline rename everywhere. Delete the sheet `junoSheetSurface` fills on the Mac. Add the Archived Chats sheet.
5. Settings panes filled to parity (§7.2). Move `DesktopUsageScreen.swift` content into Account and Billing, then delete the file. Add the Upgrade sheet, onboarding and announcements.

### Phase 4: Secondary pages

1. `JunoPage`, `JunoPageHeader`, `JunoPageControls` and `JunoSegmented`. Delete `DesktopSegmented.swift` and move its 8 users over. Rebuild `JunoEmptyState`.
2. Library, Projects, Artifacts (with the canvas dock depth from §9), Memory, Connections and Design, all on the template.
3. New screens: `DesktopSkillsScreen.swift` (plus composer "Use a Skill" and `skillSlug` on the wire), `DesktopAutomationsScreen.swift` (ported from `DesktopWorkAutomations.swift`, which is then deleted), `DesktopPermissionsScreen.swift` (hosting `DesktopWorkHostTile`; remove the tile from Settings › Code), and `DesktopAssistantsScreen.swift`.
4. The `/` and `@` palette. The quote card (Ask/Modify) with `artifactEdit`.

### Phase 5: Work merged into Chat

1. **API.**
   - `WorkKit/WorkContracts.swift`: add `conversationID` and `projectID` to `WorkSessionSummary`.
   - `NativeWorkClient.swift`: `createSession(conversationID:projectID:)` and `sessions(conversationID:limit:)`.
   - `NativeWorkModel.startTask(conversationID:)`.
   - `contracts/openapi/juno-native-v1.yaml:771-790, 2500-2517`: the create schema and the list parameter.
2. **Dispatch**, in four steps:
   1. create the conversation if there isn't one
   2. append the user turn through `/api/conversations/{id}/messages` with a stable client id
   3. create the session with `conversationID`
   4. start the run, reusing idempotency keys on retry
3. **Composer.** "Do This as a Task", "How Often It Asks", the disclosure line, the delegation offer (a port of `delegationOffer`), and steering mode with pending steers.
4. **Transcript.** The Work run card (§6.8), extracted from `DesktopWorkWorkspace.swift:2400-4470`, with the approval queue via `decideLocally`. The research run card, the report `WindowGroup`, research steering (`/api/research/[id]/*`) and the citation audit.
5. **Sidebar and signals.** The Needs-you fold, status dots, notifications, dock badge, and the MenuBarExtra Chat-first.
6. **Projects.** The Tasks tab and task defaults. "Save as a Skill…". A Tasks scope in search.
7. **Delete.** `DesktopWorkWorkspace.swift`, `.legacyWork`, and Window › Tasks (Legacy).
   - **Keep:** `DesktopWorkHost`, `DesktopWorkRunHost`, `DesktopWorkExecutorAdapter`, `DesktopWorkGrants`, `DesktopWorkVocabulary`.
   - Legacy tasks that have no conversation appear read-only under Search › Tasks.

### Phase 6: Sync tooling (the mechanism from A4)

1. Consumption tests (tokens, type) and the shell contract (`contracts/product/juno-shell-v1.json`) with generated Swift and a TypeScript parity test.
2. The icon `--check` in `native.yml`, plus the asset↔case Swift test.
3. The chat wire JSON Schema with per-field native status, and generated Swift request/response types.
4. `contracts/parity/features.json` plus a generated `PARITY_MATRIX.md`. Archive the old tables.
5. `design:contract:check` and `design:editor:check` in `native.yml`. CODEOWNERS or the required label.
6. Server-driven composer tools, skills and More items via `/api/v1/bootstrap`.
7. Paired Playwright/XCUITest screenshots on relevant PRs.

### File ledger

- **New:**
  - `DS/`: `JunoComposerShell`, `JunoToastHost`, `JunoPage` (+ Header, Controls), `JunoSegmented`, `JunoChipStyle`, `JunoStatusDot`
  - `App/`: `DesktopEmptyChat`, `ChatDetail`, `ChatToolbar`, `ChatComposer`, `ComposerPlusMenu`, `ComposerModelChip`, `ComposerDictation`, `ChatTranscript`, `MessageRow`, `MessageActions`, `SourcesPill`, `ActivityRow`, `FindBar`, `TrailingDock`, `ThoughtPanel`, `InlineArtifactCard`, `DesktopSearchPanel`, `DesktopSharePopover`, `DesktopAccountFooter`, `DesktopArchivedChatsSheet`, `DesktopUpgradeSheet`, `DesktopSkillsScreen`, `DesktopAutomationsScreen`, `DesktopPermissionsScreen`, `DesktopAssistantsScreen`, `ChatWorkRunCard`, `ResearchRunCard`, `ResearchReportWindow`
  - scripts and sources: `scripts/icon-sources/juno/`, `src/components/ui/juno-glyph-paths.ts`
- **Rewritten in place:** `DesktopChatSidebar`, `DesktopProductMode`, `DesktopNavigationState`, `DesktopCommands`, `DesktopShortcutsWindow`, `DesktopQuickEntry`, `DesktopMenuBarExtra`, `DesktopSettingsWindow`/`DesktopSettingsScreen`, `DesktopLibraryScreen`, `DesktopProjectsScreen`, `DesktopArtifactsScreen`, `DesktopArtifactCanvas`, `DesktopConnectionsScreen`, the Memory screen (out of `DesktopAccountScreens`), `DesktopVoice`, `JunoSerif`, `JunoColors`, `JunoDesignTokens`, `JunoSurfaces`, `JunoBrand`, `JunoDesktopChrome`, `JunoAIcssCode`, `JunoMarkdownView`, `NativeChatApprovalView`, `scripts/generate-native-icons.mjs`, `scripts/generate-design-tokens.ts`, `scripts/check-native-glass.mjs`, `scripts/check-native-targets.mjs`
- **Deleted:** `DesktopChatAura`, `DesktopIncognito`, `DesktopSettingsModal`, `DesktopTasksScreen`, `DesktopSearchScreen` (its index service is kept), `DesktopUsageScreen`, `DesktopSegmented`, `DesktopDictation`, `DesktopComposer`, `DesktopWorkAutomations`, `DesktopWorkWorkspace` (Phase 5), `Navigation.xcassets/nav-*`
- **The Mac stops using these; iOS keeps them:** `JunoGreeting`, `JunoComposerAura`, `JunoProviderGlow`, `JunoVoiceAura`, `JunoShimmerText`

### Docs to correct as the phases land

- `docs/design/TWO_PRODUCTS.md`:
  - §2: the Mac now merges Work as well.
  - §2.1: the create route does now accept `conversationId`.
  - §3: there are no date folds, no pill beside `+` (marks sit inside the field), and a trailing dot rather than a bullet.
- `docs/native/PARITY_MATRIX.md`:
  - `:17` and `:93` are stale.
  - Rows 139, 146-152, 154, 159-162 are marked "Missing" but now exist.
  - The API table rows 175 and 182 are stale.
  - Replace the whole file with generated output in Phase 6.
- `docs/native/API_GAPS.md`: resolve GAP-014, GAP-016 and the second GAP-022 (the ID is duplicated); refresh GAP-003/007/011/012/015/023; add the new gaps (skills, Work `conversationId`, research control, memory v2, stream resume, the Design editor bundle, icon drift).
- `docs/native/WEB_TO_NATIVE_DESIGN.md:22, 46`, and `REWORK_PLAN.md:13, 147, 167`: three products and the serif rule are stale. Add §0.1 and §0.8 here.
- `docs/native/MACOS_CRASH_ROOT_CAUSE.md` rule 3: add the `toolbarItemHidden` amendment once the gate passes.
- `docs/design/ICONS_AND_MOTION.md`: add a native section (symbols, sizes, no hover articulation, `platformFactor` 0.75).
- **Code comments:**
  - `DS/JunoColors.swift:23`
  - the `warmBlack` doc
  - `DS/JunoDesktopChrome.swift:115-117`
  - `DS/JunoBrand.swift:78-82, 409-420`
  - `DS/JunoGreeting.swift:3-4`
  - `App/DesktopChatAura.swift:149-154`
  - `App/DesktopChatWorkspace.swift:600-605`
  - `App/DesktopComposer.swift:389-392, 682, 700-702, 931-935`
  - `NativeConversationStore.swift:1846-1851`
  - `DS/JunoOverlays.swift` (around `:90`): `.containerBackground(…, for: .navigation)` is iOS-only; say so.
  - the `DesktopDestination.design` and `DesktopSidebarDesignRow` comments
  - `DesktopProductMode.swift:33-44` ("Lucide", "bolt")
- **Web side:**
  - the dead `.empty-greeting__name` CSS (`globals.css:1695-1713`)
  - `starter-chips.tsx:29-31` ("under /work")
  - stale comments: `globals.css:479-481, 616-620`; the `--ease-spring` comment
  - `lucide-react` still listed in `package.json:131`
  - `surface-tabs.tsx`, which has no consumers

---

## Appendix A: Spec scoring

Each spec is scored 1–10 on four criteria:
- **(a)** fidelity to the website's identity
- **(b)** native macOS Liquid Glass correctness, using only real APIs
- **(c)** premium and minimal quality, with no AI-slop
- **(d)** how well it can be built in phases in this codebase

| Spec | (a) | (b) | (c) | (d) | Total |
|---|---|---|---|---|---|
| **hig-native** (base) | 7 | 9 | 8 | 9 | **33** |
| web-parity | 9 | 7 | 7 | 8 | 31 |
| minimal-premium | 6 | 7 | 9 | 7 | 29 |

**hig-native**
- **(a) 7.** Keeps the web's IA, greeting, starter chips, More contents, Needs-you filter and inline run cards. But it replaces the web's new Phosphor set with SF Symbols for generic glyphs, uses `square.and.pencil` for New chat instead of the web's Plus, and drops the wordmark.
- **(b) 9.** Every API it names is real. It respects all three crash rules and scopes the tint so toolbar symbols stay monochrome. It uses `.containerBackground(.window)` correctly and catches the `JunoOverlays` misstatement. Two weaknesses: it tries to cross-fade the system title, which can't be controlled, and it uses a `matchedGeometryEffect` across the `safeAreaBar` boundary for the handoff.
- **(c) 8.** A strict accent budget, a concrete anti-slop list, and duplicates removed. It carries slightly more surface area (7 custom glass sites).
- **(d) 9.** Plans at file level, with deletions and rewrites, independently shippable phases, and acceptance checks. Its phase order differs from the brief, and it leaves no route to Work between removing it and merging it.

**web-parity**
- **(a) 9.** Phosphor symbols, verbatim copy, web prose metrics via the real `.lineHeight(.multiple(factor:))` API (verified at SC:11518), in-content page headers, and the pin mark from the web's code.
- **(b) 7.**
  - Replaces the system title with a hand-built toolbar item under `.unified(showsTitle: false)`.
  - Uses sentence case in native menus, against Mac convention.
  - Relies on a selection-binding getter hack to highlight More.
  - Ends up with two search surfaces: a sidebar `.searchable` filter plus the panel.
  - Uses a native `Menu` for the account, which can't show the usage bar.
- **(c) 7.** Clean, but it has more glass sites (canvas header, voice bar, Library bar) and a wordmark that adds chrome.
- **(d) 8.** Its "contradictions" section is excellent, and it gates on the crash repro. Its picosvg icon step adds Python tooling.

**minimal-premium**
- **(a) 6.** Drops the Needs-you filter, the row hover menu, the Thought panel, the project Overview composer and the dashed New-assistant tile. Uses a 704 measure against the web's 768.
- **(b) 7.**
  - Its product switch is a custom `matchedGeometryEffect` thumb inside toolbar glass, which is not a native control.
  - Its ⌘K scrim paragraph contradicts itself.
  - It uses `Text +` with `.italic()` on a custom font.
  - On the positive side, its single-identity handoff is the most native approach of the three.
- **(c) 9.** The best reductive thinking: a removal ledger, one accent per surface, and a tightly argued signature.
- **(d) 7.** A good ledger, and Phase 1 acceptance criteria (50 swaps). Its line citations are thinner, and it also ships Work's removal before the merge.

**What this document takes from each:**
- **From web-parity:**
  - Phosphor and Juno custom symbols, which the user asked for as "new icons" and identity
  - web prose metrics via `.lineHeight`
  - derived alpha selection tokens for a glass sidebar
  - in-content page headers
  - the crash-repro gate for `toolbarItemHidden`
  - the list of corrections
  - the pin mark taken from the web's code
- **From minimal-premium:**
  - the single-identity handoff
  - the removal ledger
  - `.toolbar(removing: .title)` on pages
  - the Phase 1 acceptance list
- **New in this document:**
  - the native title menu (`toolbarTitleMenu` and `navigationTitle(Binding)`, verified at SI:25449 and SI:24641)
  - the temporary Work access
  - the Settings order checked against `settings-sections.ts`
  - the phase structure the brief asked for

## Appendix B: Decisions where the specs disagreed

| Question | Decision | Why |
|---|---|---|
| Icons | Phosphor `ph.*` and `juno.*` as static custom symbols; the system keeps its own glyphs | The user asked for web icon identity. Static masters avoid interpolation failures. |
| Wordmark in chrome | None | The traffic lights and toggle occupy the strip; the serif appears once, in the greeting |
| Product switch | System Picker (`.tabs` on 27, `.segmented` on 26) in the sidebar toolbar, gated on "no blue", with a two-button fallback | A native control first; the gate protects identity |
| Toolbar visibility | `toolbarItemHidden`, gated on the crash repro | Keeps item identity; the fallback is `.disabled()` |
| Chat title | System title, subtitle and `toolbarTitleMenu` | Native; replaces the web's h1 and project pill |
| Page title | In-content header; toolbar title removed | Matches the web's `AppPageHeader`; the Window menu still gets the name |
| Search | One panel, with a field-styled sidebar button and ⌘K/⇧⌘F | One surface, matching the web's sidebar button |
| Scrim for ⌘K | None | Spotlight-like; click-away and Esc dismiss |
| Menu case | Title Case in native menus; web wording | Mac convention for components; copy stays verbatim |
| Handoff | Single view identity with `lift` | Focus and draft survive; no geometry matching across containers |
| Control size | 28pt pointer controls, 16pt glyphs | Mac metric; the web uses 32px |
| Thought process | Trailing dock | Web fidelity (minimal-premium had it inline) |
| Sidebar selection colour | Foreground alphas | The sidebar is glass, not an opaque #F4F3EE |
| Row trailing marks | Pending spinner → hover menu → status dot → pin | Follows the web's code; the Mac keeps pending sends for offline |
| Screenshot shortcut | ⇧⌘U | Sits next to ⌘U Attach; frees ⇧⌘1 |
| Dock breakpoint | 800pt | The web's split rule |
| Work between Phases 1 and 5 | Window › Tasks (Legacy) | Running tasks stay answerable |

## Appendix C: Where the reader reports or docs disagree with the code

1. **"Raw localization key on the task approval button"** is wrong. The catalog ships through `project.yml:57`, and the key resolves to "Always allow this" (checked).
2. **"Research stalls at the plan"** is wrong for chat. The plan is confirmed automatically (`engine.ts:1550, 1678-1679`, checked).
3. **"Global accent is unset"** is wrong. It is set, to graphite (`xcconfig:8`).
4. **"Chat rows lack the hollow bullet"** follows a stale web comment. The code draws no bullet.
5. **"Mermaid implemented"** is wrong in practice. The engine is never registered.
6. **The glass-api example** puts `.glass` buttons inside a `.glassEffect` shape, which contradicts its own no-nesting rule. This spec uses borderless controls and a solid disc.
7. **`toolbarItemHidden` versus crash rule 3** is resolved by the gate in §0.5.
8. **`JunoOverlays.swift` recommends `.containerBackground(…, for: .navigation)`.** That placement is unavailable on macOS; only `.window` exists there.
9. **The WWDC spelling `.rect(corner: .containerConcentric)`** does not exist in the SDK. Use `.rect(corners: .concentric)`.
10. **`TWO_PRODUCTS.md`, `PARITY_MATRIX.md`, `API_GAPS.md`, `WEB_TO_NATIVE_DESIGN.md` and `REWORK_PLAN.md`** are stale as listed in §11, "Docs to correct".

---

## Fact-check errata (apply these over the text above)

An independent pass checked 28 claims against the code and the macOS 27 SDK. Most held. The corrections already folded into the text are: opaque sidebar selection, a neutral thinking matrix, sidebar ideal width 304, "New chat" as the draft's window title, opaque follow-up chips, neutral find and drop highlights, ⇧⌘O kept, and no ⌘⌫ on Delete. The rest are below.

**Execution order.** Work merges into Chat before the overlay and page work, because it is what the user asked for and the server already accepts `conversationId`. Phases run in this order: **1 → 2 → 5 (Work into Chat) → 3 → 4 → 6**.

**Corrections**
1. `JunoSerif.font(size:relativeTo:face:)` has 30 call sites: `JunoLearningBlockViews` ×13, `JunoStepLabView` ×9, iOS `JunoMobileThoughtProcess` ×4 and `JunoMobileMemoryView` ×1, `DesktopProjectsScreen` ×1 and `DesktopWorkWorkspace` ×2. `pageHeading` and `cardTitle` (42 uses, including `junoPageHeading`) take no size. Move those sites to sans **before** `JunoSerif` starts returning Newsreader. Otherwise they all turn serif on both platforms and break the "greeting only" rule.
2. A4 counts 25 native-free commits. The real number is 24 of 25, because `7ff8af0b` regenerated `JunoGeneratedTokens.swift`.
3. A1 #1 gives the sidebar as 8.8%. That is the web's value; the Mac sidebar is system glass and never paints `--sidebar`. Tint the column so it reads as the web's recessed column (web: 8.8% against an 11.5% canvas in dark, 94.6% against 97.2% in light), or record the untinted column in §0.8.
4. The live root's minimum frame is at `JunoDesktopApp.swift:217`. Line 127 is the DEBUG preview root.
5. `App/` has no literal `.glassProminent`. The sites are `.junoProminentGlassButton()` ×4 and `.junoGlassButton()` (`DesktopWorkWorkspace.swift:1213`). `junoSheetSurface` has 10 sites in `App/`: 8 in Chat, 2 in Code.
6. **Do not filter Code conversations in the store.** `sendMessage` refuses conversations it doesn't know, and Code depends on the store keeping them (`NativeConversationStore.swift:262-267`). Filter by kind in the sidebar view.
7. The offline banner (`JunoDesktopRootView.swift:116-124, :380`) is the auth `.unreachable` state: a Keychain-restored session the server hasn't confirmed. It has a Retry button. Keep a Retry affordance and keep it separate from network/sync `.offline`.
8. Type ladder (`tailwind.config.ts:351-435`):
   - `ui` has line height 1.5.
   - `body-lg` has line height 1.6.
   - `pageTitle` is fluid from 26 to 32, `clamp(1.625rem, 1rem + 1.5625cqi, 2rem)`.
9. Radii:
   - The dashed empty-state well uses `field` (12).
   - Web toasts use `card` (16), not a capsule.
10. `toolbar(removing: isPage ? .title : nil)` changes the toolbar's default items per destination, which is the same crash class as rule 3. Put it in the Phase 1 crash-repro check, or keep the title and draw page headers under it. `ToolbarContent.hidden(_:)` (SI:3044-3046, macOS 15) is the item-level API.
11. A1 #7: the code declares two `ToolbarItemGroup`s plus a fixed `ToolbarSpacer`. The system draws the third capsule.
12. `openWindow(id:)` on a `WindowGroup` always opens a new window. The Quick Entry and menu-bar extra calls are a real bug.
13. Two things to verify at runtime:
    - whether a `TextField` honours `.lineHeight(.multiple)`
    - whether a `.toggleStyle(.button)` Private toggle in the toolbar draws its on state in system blue. If it does, show the on state only with the fill glyph.
14. `.inspector` is already used for Tasks (`DesktopChatWorkspace.swift:219`), against the crash note in `DesktopArtifactCanvas.swift:20-29`. It goes away when Tasks is removed in Phase 1.

**Also in scope. The first pass missed these.**
- **Auth and launch.** `JunoDesktopSignInView` (`:412`), `JunoDesktopLoadingView` (`:354`), `.unavailable` and local-store recovery all get the warm canvas, the Newsreader wordmark and one coral action, matching the web's sign-in card.
- **App icon.** Replace the flat PNG `AppIcon.appiconset` with an Icon Composer `.icon` that has light, dark, clear and tinted variants.
- **Window restoration.** Reopen the last chat, not a forced draft. Support several main windows through "Open Chat in New Window".
- **Accessibility:**
  - `junoTertiaryInk` is 2.89:1 on the light canvas, so it may carry only ≥13pt non-essential text. Keycaps and timers use `junoSecondaryInk`.
  - Pin marks at ≥ 3:1.
  - `.isHeader` on the greeting and page titles.
  - Transcript turns as headings for the rotor.
  - Reduce Transparency fallbacks for the 5 glass sites.
  - An Increase Contrast edge on the shell.
  - Status dots paired with a glyph or label under Differentiate Without Color.
  - Keyboard access to the row menus.
- **Text size.** Every rung scales from a single `@Environment` text-size factor that is set from Settings.
- **Light mode and theme override.**
  - Check glass sampling on #FAF9F6 and the visibility of the selection edge.
  - Wire the System/Light/Dark setting to the Settings scene, Quick Entry and the MenuBarExtra.
  - Apply `.tint` in the Settings scene, Quick Entry and the MenuBarExtra too.
- **States:**
  - a conversation whose messages are still syncing
  - a conversation deleted remotely while open
  - 401 mid-use
  - 429
  - page-level load errors and offline states
  - a transcript skeleton
- **Shared packages.** Every Design System change is built against **iOS (JunoMobile) and Code**. Code's `nav-*` glyphs are remapped before any asset is deleted. Removing `isChatCapable` changes `selectableModels`, which Code, voice, Compare and Quick Entry read, so filter at those call sites.
- **Gates.** Re-baseline `native:design:type` and `native:design:motion` when the ladders change. Add new copy and the Title Case variants to the shared `Localizable.xcstrings`.
- **Web.** Settings also exists as a page (`settings/page.tsx`). Map `/profile` to Settings › Account. `/knowledge/documents/[id]` becomes a Library detail. Compare and Roadmap are deferred.
- **Coordination.** A parallel Code rework is in progress (`docs/native/code-rework/`). This redesign owns the shared shell (window, product switch, sidebar chrome, tokens, icons) and Chat. It leaves `DesktopCode*.swift`, `JunoCodeUI` and `DesktopCodeAccountFooter.swift` to that work, apart from mechanical token or icon renames that are needed to keep Code building.

## Phase 2 errata (from `MACOS_PHASE2_TRANSCRIPT_BRIEF.md` §0; apply over §6)

The Phase 2 brief re-read the live web (`juno/src` on main) against §6. Where the two disagree, the brief wins; these are the corrections, recorded as the stages land.

- **§6.2 User turn.** The bubble is the web's `USER_BUBBLE_CLASS`: `text-reading` 16pt at 1.7 (`JunoType.reading`), padding 16 × 10, `junoSecondary` with no stroke, `UnevenRoundedRectangle(16, 16, 8, 16)`, at most 85% of the measure the transcript measured (`junoMeasure`). Long prompts clamp at 240pt (over 700 characters or 14 lines) with a 64pt fade; only the fade animates. "Show more · N lines" is 11pt medium SF, not mono. The hover cluster is Copy · Edit · Fork privately, always hover- or focus-revealed; Edit is hidden, not greyed, while a reply is being written. The editor sends on Return (⇧Return breaks the line, ⌘Return sends, Esc cancels). A question that never reached the server shows "Not sent" and Retry send at rest. Sent attachments (Stage 2) are 144pt-tall image tiles and 144 × 144 file tiles, not 160pt thumbnails or chips.
- **§6.4 Prose.** 16pt at 1.7 with a 0.85em block gap and a 75ch paragraph measure, not 15 at 1.65 (Stage 4).
- **§6.8 Inline artifact card.** Radius 16 with no outer inset; body `min(44vh, 360)` with a 240 minimum; a 32pt icon tile at radius 12; the button reads "Open" with the help text "Open in canvas" (Stage 3).
- **§6.10 Message actions.** Plain 28pt circles (the web's are 32; deliberate difference #10), 16pt Phosphor regular glyphs in `junoSecondaryInk`, a neutral `junoHover` circle under the pointer, no container, glass or tint. Five at rest on the newest reply — Copy · Good response · Bad response · Regenerate ▾ · More ▾ — and nothing on an older reply until hover or focus. The version pager's arrows are **24pt** (the web's 28 less the same 4) and its count is 11pt mono. A rated thumb wears its fill cut in `junoAccentInk` on the `--selected` ground (`Color.junoSelected`), as the web's `text-primary` on `selected`. The model, tokens and cost moved from a caption under every answer into More's info section; Read Aloud, Branch from Here ▸ (Into a New Saved Chat · Fork Privately), Share Chat…, Quote in Composer and Copy Link live in More, with the web's words in Title Case. Continue moved to the finish note. Regenerate's More Concise and Add Details send the web's `regenerateInstruction` strings verbatim.
- **§6.11 Error box.** A 40% `junoDestructive` hairline over a 5% (light) or 14% (dark) fill, not 35% and 7% (Stage 4).
- **§6.2 / §6.3 Media and files (Stage 2, as built).**
  - **Sent attachments** sit above the bubble, trailing, 8pt apart, wrapping (`UserAttachmentStrip`). An IMAGE is a 144pt-tall tile, as wide as its shape up to 288 (floor 72), radius 16, `junoSecondary` under a 70% hairline; hover darkens the hairline to foreground 25%, adds `--shadow-raised` and scales the picture to 1.015. Anything else is the web's 144 × 144 page tile: a 96pt `junoSecondary` well holding the first page (radius-6 top corners, 70% hairline, `--shadow-raised`, rising 2pt on hover), over a 48pt caption band with the stem and "Excel workbook · 88 KB". A turn that is only files has no bubble.
  - **The page** is the first of: the server's rendered first page (`/api/attachments/{id}/thumbnail`); PDFKit's page one (PDFs), ImageIO (pictures stored as files) or QuickLook (Office and iWork) for files up to 25 MB — the web stops at the excerpt; the opening lines in SF Mono 10.5 at 1.55, fading from 45%; or the extension.
  - **Answers** carry produced documents as the same page tiles, then pictures and clips. A picture is a square of at most 320pt, fitted on `junoMuted`, radius 12, 60% hairline going to 100% on hover, no shadow; "Preparing image" until the pixels are decoded (ImageIO, off the main thread, downsampled to 1024px), then the overlay fades on `--dur-base` and the pixels on `--dur-slow`. A clip is a card at most 480pt wide: a 16:9 stage that reads "Preparing video" until AVKit's item is ready, and a 52pt footer with "Video · Preparing/Ready/Preview unavailable" and an Open pill.
  - **Opening** is Quick Look for every tile and picture (click, Space, or Expand), hoisted to `DesktopConversationView`; tiles and pictures also have Quick Look · Open With Default App · Save As… in a context menu, and a picture drags out as its file. Files come through the stable `/api/files/<key>` path, which sync now keeps (a signed URL is still dropped), into `Caches/<bundle>/TranscriptFiles/<account>/<attachment>/`, purged on sign-out; 51 MB is the ceiling.
  - **Edit** on a generated picture opens the region editor as a sheet, and the edit runs as a turn **in this conversation** (`sendImageEdit`, the web's `sendImageEdit`) rather than in a new chat as the Library's does.
  - **Labels on media controls are SF, not mono.** The web sets "Edit", "Open", "Video" and "Preparing image" in JetBrains Mono; §10.2 rule 6 keeps mono for code, ids, counts and costs, so the Mac sets them in SF 11 (the extension badge and a file's excerpt stay mono — an identifier and the file's own characters). A caption's size uses tabular SF digits.
  - **The placeholder** (`NativeMediaGenerationView`, shared with iOS) is clipped to radius 12, its label is 15pt, a second 15pt line — "Still working. Detailed images can take a minute." / "Longer clips can take a couple of minutes." — fades in after 20s (image) or 15s (video), each stage is announced to VoiceOver, and the video mark sits on a 48pt card-filled plate with a hairline.
  - **One question, not two, and no failure at the first frame.** A picture or video model's turn is no longer appended before `/api/generate` runs — the route writes the question itself, as the web relies on — and the pending question takes the id `meta` reports. Before, the question was stored twice. The client also refused `/api/generate`'s `meta` frame for an existing conversation, whose title is `""`, so every picture or clip asked for in an existing chat failed at its first frame; an empty title is now accepted and ignored.

- **§6.5 / §6.8 Artifacts, canvas and designs (Stage 3, as built).** The Artifacts & Design audit's verified Mac findings (`wip/artifacts-design-audit:docs/design/artifacts-design/HANDOFF.md`, `02-AUDIT-MAC.md` at `8d4def72`) and the brief's addendum drawn from them were applied where they touch this surface: X-11, mac-artifacts-1, -7, -9, -11, -12, mac-design-1, -2, and the X-01/X-04 addendum rules (closed sandbox; regenerate confirmation). mac-artifacts-2 (CDN pages broken on the Mac) is deliberately left as it is: the addendum keeps the network closed.
  - **Stored rows.** A card resolves the stored row behind its tag by `(conversation, identifier)` (`ChatArtifactResolver`, JunoChatKit), as the web's `artifactsByIdentifier` does: content, kind, `v{n}` and "Updated" come from the row; the tag is the fallback. While the message is still writing, the card shows the tag — the source arriving — rather than the web's stored previous body. The `done` frame's `artifacts` are merged into the artifact store at once (`didStreamArtifacts` → `NativeArtifactModel.merge(streamed:)`) and laid over the synced projection until sync catches up. A record of a kind this build does not know, or a version over 200,000 characters, is now skipped instead of failing the whole store (it used to blank Artifacts and Design).
  - **Runtime — the web's builders in a closed sandbox** (brief addendum of 2026-09-23, which overrides brief §5.2's network access). `NativeArtifactRuntimeDocument` ports `buildSandboxDoc` builder for builder (HTML fragments with the Tailwind tag, React with Babel, CSS on a sample page, SVG, Mermaid from the bundled `juno-runtime://mermaid.min.js`, the JavaScript/TypeScript/Python consoles), but the Mac does **not** copy the web's network reach: the web's scripted previews are dead in production anyway, because the app CSP is inherited into the `srcdoc` frame (audit X-01). `NativeArtifactRuntimeWebView` runs a page's own scripts with **no network** — a rule list that blocks every hierarchical scheme but `juno-runtime:` (`https:` and `file:` included) and the web's CSP with every `https:` source removed and `connect-src`/`frame-src 'none'` — a non-persistent store, a nil base URL, only the initial document (a clicked link opens in the browser; `window.open` does nothing), alerts as sheets, downloads through the save panel, reload after a WebContent crash. Only two channels come back, main frame only: the status (with its errors) and the console; the web's link bridge and inspector are left out. React, TypeScript and Python fetch their engines from CDNs, so on the Mac they show Code until those runtimes are bundled (`NativeArtifactRuntimeInfo.runsOnThisMac`); opening the network is one switch (`ArtifactRuntimeNetwork.isOpen`) and needs the owner's sign-off. New policy `.inline` carries it; `.document` keeps the phone's and the library Canvas mode's posture, and `.thumbnail` is unchanged (inert). The Mac card, the canvas dock, the library's Preview and a detached window use `.inline`. `ArtifactRuntimeSandboxTests` runs a scripted page in that exact web view and reads back what its scripts wrote, and that an image, a fetch and a CDN script are all refused.
  - **Card.** `DesktopInlineArtifactCard` is §6.8 as corrected: radius 16, a 32pt radius-12 tile (muted even while writing), title 13 medium, a meta line (runtime label · `v{n}` from 2 · Updated · status with a pulsing dot), Preview (Output for console runtimes) / Code / Console `n` on a 32pt track, Open with `ph.sidebarsimple.mirrored`, a divider whose band sweeps while writing (static under Reduce Motion), a body of `min(0.44 × column height, 360)` at least 240, Writing and Source unavailable states. **The meta line, the Console header and the switch are SF 11, not the web's mono** — they are labels; mono stays for code, the console's lines and the count.
  - **Canvas dock.** `TrailingDock` replaces `DesktopArtifactDock`: one panel at a time, each remembering its width (`dock.canvas.width`); 400 minimum, 480 when opened, at most 60% of the detail column, 480 kept for the chat (the panel's floor wins between 800 and 880), and the panel covers the chat below 800. Still plain layout, never `.inspector`. The Thought panel is its second case in Stage 4. The canvas follows the stored row (a revision under the same identifier now opens as the revision), names `v{n}`, and offers Preview / Code / Console in the same runtime. With a row, Code is editable and a design opens editable, with Revert and a Save that writes a new version **on top of the version the edit started from** (`saveArtifact(id:content:baseVersion:)`), so a newer version comes back as a conflict instead of being overwritten. An emptied editor is a real draft. Component candidates are extracted once per settled source.
  - **Designs open only from the stored row** (audit X-11). The tag carries the model's compact authoring form, which the Mac's codec refuses; the card draws a design, and the dock opens one, only from the stored (expanded) document. Without a row the card shows Code and the dock says "This design isn't saved yet".
  - **Regenerate asks first when the reply carries artifacts** (brief addendum; the server's regenerate hard-deletes them, audit X-04): Try Again, More Concise, Add Details and Switch Model open "Regenerate this answer?" — "Its N artifacts will be replaced." — with Regenerate (destructive) and Cancel.
  - **Designs inline.** `InlineDesignPreviewBody` draws the server's SVG export (`GET /api/design/{id}/export?format=svg`, cached per version in memory and under `Caches/<bundle>/DesignPreviews/<account>/`, purged on sign-out) on the inert thumbnail sheet, fitted whole; Loading → Done or Error; a 422/5xx shows the `juno.design` mark, "Preview unavailable" and Open. Before a stored row exists, or while writing, the card shows Code. Swift `DesignNode` now carries `cornerSmoothing`, so a Mac save no longer strips it.
  - **Mermaid.** Mermaid 11.12.3 is bundled in `Resources/ArtifactRuntime` (folder reference, with its MIT licence and provenance) and registered at launch. The figure is the web's: radius 16, a 70% hairline, "Diagram · Mermaid" with Reset and Copy, a skeleton until it draws; its stage starts at 288 and settles to the diagram's own height within 160…520, because the Mac draws at natural size with zoom and pan rather than shrinking to fit. A still-open fence shows its source and "Diagram renders when complete…".
  - **`juno-visual`.** `JunoVisualBlock.swift` (JunoDesignSystem) parses the web's JSON (`parseVisualBlock`) for the fences `juno-visual`, `juno-ui`, `juno-block`, `visual` and `visual-block` and draws the web's own bodies — cards, flow (nodes with arrows, wrapping), comparison (≥ 544pt, scrolls sideways), quiz, callout and timeline — under the radius-16 header; `steps` becomes a Step Lab. **These are ports of `inline-visual-block.tsx`, not the `:::` lesson views** the brief mapped them to: those carry their own rule-bounded shell, kicker and coral selection, and inside the section they doubled the chrome. Selection is neutral (`junoSelected` under a hairline), never coral. A fence still arriving shows "Drawing inline visual...".
  - **Icons.** REACT is `ph.code` (`JunoIcon.codeBrackets`), not the Juno Code mark; DESIGN is `juno.design`, not a pen; DESIGN's label is "Design", not the wire value.

- **§6.4–§6.15 The rest of the transcript (Stage 4, as built).** The Tool calls & research rework (`juno-tools`, `docs/chat-rework/DECISIONS.md` §1 T6 and §2, and the draft `SPEC.md` §2, §7 and §8) decides how the web will show thinking, tool calls and research, and the brief's addendum makes it win over §6.6–§6.7 wherever the two disagree. `SPEC.md` was still a draft (no reviews yet) when the stage ran, so the run UI is the decisions' description built behind one swappable signature view (`JunoRunSignature`), and it reads today's server through the SPEC's legacy adapter.
  - **Prose (§6.4).** A new `JunoProseStyle` (`.reading`, JunoDesignSystem) that the Mac reply opts into; `.standard` — the phone, Juno Code's studio, the library — is untouched. Reading: the `reading` rung (16 on 1.7), a 0.85em (13.6pt) rhythm, paragraphs at 75ch (seventy-five advances of "0", measured), the model's headings at 24 / 20.8 / 17.92pt semibold on 1.3 with 1.3em above (never above the first block), lists at 1.4em with 0.2em between items, quotes on a 3pt `--border` bar with 1em of inset in the secondary ink, a 1pt `--border` rule, links in the accent's ink underlined, and inline code in SF Mono at 0.875em on `--muted` — a background run padded with narrow no-break spaces, because a `Text` run cannot take a radius. No caret: while a reply is written its last 1.35em fades to 30% (`junoStreamingTail`, off under Reduce Motion) once it passes 140 characters. `JunoStreamingCursor` stays for the standard style.
  - **Code (§6.5).** `JunoProseCodeBlock`: `--card` under a 1pt `--border`, radius 12; a 32pt header with the language in 11pt mono and a 28pt Copy that cross-fades to the check for two seconds; **one** `Text` for the whole listing (selection runs across lines) in SF Mono 13 on a 20pt line with 12 × 14 of padding, no wrapping, scrolling sideways under a gutter that stays put; the gutter (12pt mono, secondary, on a full-height rule) only at eight lines or more; past 520pt the body scrolls inside itself. `JunoSyntaxHighlighter` is a scanner, not a parser: keywords in the accent's ink, strings `--code-string`, numbers `--code-number`, comments secondary and italic, per language family, plain for text and logs.
  - **Tables.** `JunoProseTable`: a `Grid` in the code block's card, the header on `--secondary` in 13pt medium over a rule of the foreground at 28%, 13pt cells with 10 × 8 of padding and `--border` between rows. **Columns are laid out as a browser lays out the web's `width: 100%` table**: measured single-line widths fill the measure, a column that cannot fit wraps down toward a 120pt floor, and only when the floors do not fit does the table scroll sideways.
  - **The run (§6.6, per the rework).** `DesktopRunBlock` (`ActivityRow.swift`) sits above each answer from send to done and replaces `JunoAIcssReasoningStream`, the "Thinking about your request" row and the conversation-wide research `GroupBox`. **Live**, one line: the 18pt `JunoRunSignature` — a 3 × 3 grid of 4pt points in one muted ink whose *pattern* is the phase (thinking travels the perimeter, searching sweeps a column, reading a row, a tool orbits, waiting and failed are still with the centre in the accent or the warning tone), only opacity looping, on a 2.4s loop locked to the clock and halved after 20s of work — then the phase in words at 16pt with one compositor-only shimmer (none once calm, settled or under Reduce Motion), and the clock from 3s at the far right ("12s", then "1:04"). Nothing for 150ms, no words for 400ms. The words are the web's own rungs — "Thinking", "Still thinking. This can take a few minutes." (2 min), "Still working. You can leave; the answer will be here." (10 min), "Reconnecting…" while a stream is picked up — or the phase's own: "Searching the web for “…”", "Reading swift.org", "Linear: Search issues", "Waiting for your approval", a provider's own `**headline**`. Under it a two-slot **peek** of the newest steps (tool rows with their own state, or the reasoning's newest sentence). **At the first answer token** the peek goes and the line becomes its summary — "Thought for 12s · 6 sources ›" / "Worked for 12s · used Linear" / "Answered in 3s", with the points gathering into one resting dot; a turn with no reasoning, tools, sources or notices draws nothing. **One click** opens the whole timeline inline in the order it happened; a tool row there, or the panel button beside the chevron, opens the Activity panel.
  - **The Activity panel** (the rework's name for the Thought panel) is `TrailingDock`'s second case (`.activity`, `dock.activity.width`), never beside the canvas: opening either closes the other. Its header is the run's own line; under it **Timeline** (reasoning as reading prose, notices, and calls that open to their arguments and result — or the sentence saying why they are missing), **Sources** (*Cited*, the `[n]` the answer points at in citing order, then *Also read*) and **Details** (model, effort, context, connected tools, memory used), each shown only when it has something. It is keyed by message id and follows the placeholder's id to the server's when the answer lands. The brief's Filter and Copy menus, find field, Elapsed/Cost/Sources figures and j/k are gone with the rework, which removes cost as a headline, the filter and the ledger.
  - **Data.** Activity lives on the reply (`NativeChatMessage.activity`, `reasoningParts`, and the transient `runStartedAt` / `answerStartedAt`), written live, carried by the `done` frame (which the Mac now decodes), and laid back over the synced row by message id — first from the `done` frame, then from the thread (`GET /api/conversations/{id}`, `hydrateThread`, on open and 1.5s after each reply) — because the sync entity carries neither the sources nor the run. `researchActivity` is now the pending reply's. Activity rows decode `createdAt`, the connector call's redacted detail, the memory receipt, the artifact kind and — additively and lossily — the rework's `seq`, `round`, typed `call` record, `segment`, `commentary` and `notice`; `NativeRunView` builds the timeline from them when `seq` is present and through the SPEC's legacy adapter (§7.7) otherwise. `clientFeatures` is not sent: the Mac does not claim the `timeline` profile until the server ships it.
  - **Sources (§6.7).** The pill is a 32pt opaque capsule with up to **three** logos (one per site, the web's `CLUSTER_MAX`), "Sources" in SF 12 medium, the count in mono, and a caret; it opens in place into 36pt rows (logo, title, site, number). Logos come from each source's own `/favicon.ico` on an ephemeral, cookie-less session held in memory — never a proxy — with the site's letter underneath. `cited` is decoded; only then does a `[n]` become a citation, drawn as a small mono chip on `--secondary` that opens a 320 × 140 popover (site, title, the passage, Open Page) at the point it was clicked.
  - **Notes and errors (§6.11).** `DesktopTurnNote`: radius 12, a 70% hairline, `--muted`, 14 × 10, 13pt secondary, the info mark (the failure mark for a partial answer that then failed), the web's sentences verbatim, and Continue where the reply can be carried on. `DesktopTurnError`: the destructive tone at 5% / 14% under a 40% hairline, destructive ink, the failure mark on the first line and Try Again (destructive-tinted, newest turn, idle), **in place of the answer**, above its sources. No `GroupBox` is left in the transcript; the store's error is the reply's own, a failure no reply carries falls back to the same box at the foot of the transcript, and a failed action (a rating, Read Aloud) shows in that box for six seconds until the toast host lands (Phase 3).
  - **Follow-ups (§6.12)** leave the transcript for the composer dock, above the composer: up to three opaque `JunoChipStyle` chips, cut at 320pt, wrapping 8pt apart, and **a click sends** (`ChatComposerRequest.Kind.send`). Only under a settled answer with words and no error, with nothing running and the draft empty (`draftIsEmptyChanged`).
  - **Scrolling (§6.13).** `ScrollViewReader` is gone: `.scrollPosition`, `.defaultScrollAnchor(.bottom, for: .initialOffset)`, `.contentMargins(.top, 24)`, `.scrollEdgeEffectStyle(.soft, for: [.top, .bottom])`. The stream is followed only while the reader is within 24pt of the end — the reader's own scroll (scroll phase) decides that, not the content growing — and a send brings the view back. `ScrollToLatestButton` is a 32pt `.glass` circle with `ph.arrowdown`, 12pt above the composer, `.glassEffectTransition(.materialize)`, out of the hierarchy when not needed; it joins the glass gate's allow-list. "Response complete, N words." is announced at the end of every reply.
  - **Find (§6.14).** Edit › Find in Conversation… ⌘F, Find Next ⌘G, Find Previous ⇧⌘G (disabled, so not claiming the keys, where no conversation is on screen). `DesktopFindBar` is the glass capsule (≤ 480pt) in the column's top `safeAreaBar`: the magnifier, the field, "3 of 12" in mono (or "No matches"), Previous and Next, Done; Return / ⇧Return step, Esc closes. Matches are counted over what is drawn — the bubble's text and each reply's prose runs as the reading style renders them (inline Markdown resolved, citation chips, code blocks; not diagrams, artifacts or the run) — through the same `JunoFindText` functions the prose highlights with, so the count and the highlights agree. Every match gets the foreground at 10%, the current one 22%, and the current match's turn is scrolled to the centre.
  - **Resuming a stream (§6.15).** The SSE parser keeps each frame's `id:` (a `sequence` event), and one handler (`consume`) serves the original stream and a resumed one. A stream that drops is picked up at `GET /api/chat/stream/{generationId}?after={seq}` while "Reconnecting…" shows, retrying at 0.5 → 15s; a 4xx, `resume{refetch:true}` or a log that stopped (`resume{available:false}`) falls back to waiting for the saved answer to sync, as before. When a conversation opens, and when the network comes back, `GET /api/chat/stream/active` finds a generation this Mac is not streaming and follows it from its first frame — only where the transcript ends on a settled question. `ChatStreamReducer` stays unused; the store's handler is the reducer the stream runs through.
  - **Approvals (§6.9).** `DesktopApprovalCard` (the Mac's own; the phone keeps `NativeChatApprovalCard`) sits inside the newest reply, under its run line and **above** its answer — the rework's `ApprovalSlot` place — with the pending receipts and those raised since the question; one recovered with no reply on screen waits at the transcript's foot. `--card`, radius 16, a hairline in the risk tone while answerable, the web's copy verbatim; **Don't allow · Allow once · Allow this action for this connector**, refusal first in the destructive ink, Allow once the surface's one prominent button, nothing on `.defaultAction`, 28pt targets, wrapping with `ViewThatFits`; the countdown's words in SF and its count in mono.

- **Phase 2 review (after stage 4).** A conformance pass over the brief's acceptance lists (§3.6, §4.4, §5.6, §6.11) and §6 / §10.2 of this spec, with these fixes:
  - **No coral on outline buttons.** `.bordered` inherits the detail column's `.junoAccentTint()`, so Continue (finish note), Retry send (unsent question) and "Allow this action for this connector" (approval card) drew coral labels on a coral wash — a second coral control beside Allow once, and coral on action glyphs. They take `.tint(nil)`: the system's neutral bordered button, the web's `variant="outline"`. The error box's Try again keeps its destructive tint.
  - **"Not sent" is SF 11 medium**, not mono (§10.2 rule 6); register #39.
  - **The gutter follows the column (§6.1):** 16 below 640pt, 24 from 640, 32 from 1024 (`DesktopChatMeasure.gutter(forColumnWidth:)`), for the transcript, the find bar, the composer dock and the offline caption. It was a fixed 32, which a column squeezed by the canvas dock paid for in words.
  - **The version pager pages versions (§6.10).** A reply regenerated, or a question edited and resent, keeps its earlier versions on the server; the thread's `versions` count now drives `‹ 2/3 ›` with the live row as the last page, and the first step back reads `GET /api/messages/{id}/versions` (`NativeChatAPIClient.messageVersions`). An earlier page shows its own words, reasoning, model, tokens and sources, and none of the live answer's run, cost, finish note or error (`NativeChatMessage.showing(_:)`, the web's `view`); Copy, Quote in Composer, Read Aloud and Edit act on the page shown. Paging is presentational: a regenerate continues from the live thread. A branch's pager still shows where a turn has no versions. "Couldn’t load that version." goes to the transcript's failure box until the toast host.
  - **Harness.** `CALayer.render(in:)` draws a continuous-corner capsule with a tick at each end (the stroke artifact noted in stage 4); the renderer now draws those layers with circular corners before photographing, so the sources pill, chips and risk label look as they do on screen. The final set adds window compositions over the preview world (`FinalSnapshotTests`, `JUNO_FINAL_SNAPSHOT_DIR`); glass cannot be drawn offscreen, so the composer is shown with its Reduce Transparency recipe (`junoSnapshotOpaqueGlass`, harness-only) and the sidebar's material is absent.
  - **Still open from the acceptance lists:** React, TypeScript and Python previews and Tailwind-styled pages (§5.6) need their runtimes bundled — not on this machine; downloading them needs the owner's permission — or the network opened, which needs sign-off. The runtime-only checks (menus kept open on an older reply, Quick Look, Save As…, drag-out, a live `/api/generate`, stream resume after a network drop, Scroll to latest, ⌘F from the menu) still need a person at the screen.

- **Phase 2 stage 4b — the tools rework's final design** (`juno-tools` `docs/chat-rework/SPEC.md` at `f1badf26`; it wins over the stage-4 run UI and over §6.6–§6.7 wherever they differ):
  - **Wire (SPEC §2, §2.13).** Every `/api/chat` request — saved and private — carries `clientFeatures: ["timeline","resume","research_background","suggest_research","citations"]`, `timeZone` and `locale` (`NativeChatClientFeatures`); `chatBodySchema` is a plain `z.object`, so a server that predates them strips them and answers in profile 1. Both grammars decode: `delta.round/phase`, `reasoning.part/round`, the terminal `handoff` frame, `sources[].origin`, and on activity events `seq`, `round`, the whole `ToolCallRecord` (updated in place by `callId`, the eight statuses, `error.detail`, the approval record, `web` with engine, numbered results, content type and `injection`, `cached`), `segment`, `commentary` (untruncated), `fact` (all seven keys) and `notice` (the five must-act codes as warnings, the rest context). Unknown status → running, unknown error code → generic failure, unknown phase → undeclared.
  - **One stream reducer (`NativeTurnStream`).** The store, the private chat and Compare run every frame through it. Profile 1 appends; the timeline keeps rounds apart (joined with a blank line, as the server's `answer`), sends declared commentary to the commentary, releases a declared answer at once, **holds** undeclared text in a turn that offered tools until a call for that round (commentary), 600ms, 280 characters, a paragraph break or the end (answer), and moves a round the server later marks as commentary out of the answer. Reasoning takes a blank line at a declared part or a new round (the web's `appendReasoningDelta`), so segment offsets index the same string. A `handoff` removes the placeholder and records the run.
  - **Presentation (SPEC §3.8, §7.6).** `NativeToolPresentation` is the Swift copy of the registry: phrases plus argument nodes (`NativeRunPhrase` / `NativeRunPhraseLine`, joined with " · "), the failure phrases by `error.code`, the notice and connector-failure copy, figures from the server only, and the summary grammar — "Thought for" whenever the run reasoned **or** ran a call (never "Worked for"), "Answered in" otherwise, at most two facts. The English `title` is never shown.
  - **The run block (SPEC §7).** `JunoRunSignature` is Concept A exactly: the resting grid at `muted-foreground/0.25`, the lit layer in the foreground on the SPEC's keyframes (`run-lit`, `run-lit-bar`, `run-lit-type`) phase-locked to the clock on 2.4s (tool on the 1.2s beat, 4.8s calm), the static signatures for Reduce Motion and for a signature that does not own the loop, accent centre only while waiting, warning centre when failed, and the 360ms gather. `JunoRunLabel` is the compositor sweep (35–65% window, crossing in the first 75% of the loop). The line is 36pt; words are paced (150ms glyph, 400ms words, 600ms minimum, 700ms apart, newest wins, a new subject after 1.5s — `NativeRunLabelPacer`); reads and searches started together coalesce; the stall caption ("No response for 35s") and the two escalation rungs sit inside the line instead of replacing it. The peek is two fixed 28pt slots with a still running ring (`JunoRunMarker`), never the tool's icon; inline commentary sits above the answer in the muted ink; the timeline shows approval receipts under their call. **The one failure ink is warning** — no destructive red in the run UI.
  - **One loop owner (§7.9.1).** With the Activity panel open on a live reply, its running row's ring (or the live reasoning's signature) owns the loop and the transcript line shows its still frame; a research row loops only when it is the newest live one and no chat run works.
  - **Activity panel (SPEC §8).** `DesktopPanelShell` (the `RightColumnShell`): the stable heading, a static phase word and clock (never a shimmer), close. Timeline (headlines as headings, commentary muted, a call opening to its arguments, result — search results with numbers, a page's final address, character count and the injection note, code output — receipt and error with its detail, "Ask to run again" on a failed connector call, and a pending approval answerable from its row), Sources (Cited by first citation · Also read · Found only when nothing was cited or read, by `origin`), Details (model and provider, effort rung, "Context used … · Window …" from `promptTokens` and the catalog, tools available, connectors ready or failed, memory used with **Forget**). The chosen view is remembered (`activity.tab`).
  - **Research (SPEC §9).** No levels anywhere on the Mac: the + menu row is "Research", the mark is "Research" with no detail ("Research on" / "Turn off Research"), and nothing sends `researchEffort`. A hand-off becomes a **research row** after its question (glyph on the calm loop, the phase line, logos, the read count, the working clock extrapolated between polls, "Open ›"; "Report ready · Open report ›" at rest), followed by polling `GET /api/research/{id}` (2.5s working, 8s waiting). A run waiting at its plan is a compact plan card (approach, questions, "About 12 min · Reads up to ~150 pages", Cancel, Start). The **Research panel** shares the shell: Progress (questions with "In progress"-style chips, the activity stream, your guidance, found so far), Sources (Read, Found), Plan, and — done — Report and Details; Pause/Resume, Finish now and Cancel… (confirmed). Research a profile-1 server answers in the chat (today's production) shows the same row while it works and the same panel, read from its rows. `suggest_research` leaves a "Research this" chip under the answer that sends the question as Research.
  - **Bootstrap and contract.** `chat.clientFeatures` is read into `NativeBootstrapCheckpoint` (and the sync coordinator) — not a gate; `juno-native-v1.yaml` gains the `chat` key, the request's real fields plus the three new ones, `ChatSource.cited/origin`, the missing frame members (`title`, `approval`, `progress`, `resume`, `handoff`) and open `delta`/`reasoning` schemas (version unchanged, INV-25).
  - **The inline artifact card fits its page.** A `juno:size` channel (the height channel the brief's addendum allows) reports the page's content height, the width it was laid out at and its opaque ground; the card's body takes that height on its mat (120pt to the old ceiling, for every view, so a view switch never jumps) and paints the sheet in the page's own ground, so a short page no longer sits over a white band. The artifact card's working mark is the signature's small tool pattern.

**§0.8 register, additions.**

14. Designs are drawn inline on the Mac; the web shows the document's JSON.
15. Images add Download and Expand to the web's Edit, and a click opens Quick Look rather than a new tab.
16. The More menu's info item is greyed by the system; the web keeps it at full ink.
17. Switch Model marks the current model with the system checkmark, not the web's coral check.
18. Tooltips use `.help()`, so they appear on the system's delay rather than the web's.
19. File tiles and pictures open in Quick Look, and Office and iWork tiles show a QuickLook page picture; the web opens its own document viewer beside the chat and shows an Office file's opening lines.
20. A generated clip is downloaded whole (51 MB ceiling) before it plays; the web streams it.
21. The artifact runtime has no network; the web's sandbox lets a preview pull https scripts, styles, fonts and images (and, in production, runs no script at all — audit X-01). The Mac runs a page's own scripts; Tailwind classes, web fonts and remote pictures do not load, and React, TypeScript and Python show Code until their engines are bundled. Mermaid inside an artifact comes from the app bundle, not jsdelivr. Only status and console come back from the page; the web also has a link bridge and an element inspector.
22. The inline artifact card's meta line, the Console header and the view switch are SF 11; the web sets them in JetBrains Mono.
23. While a reply is still writing an artifact, its card shows the tag's source as it arrives; the web shows the stored row's previous body under "Writing".
24. The canvas saves an edit as a new version when the reader presses Save (⌘S), on top of the version the edit began from; the web's design editor commits as it goes. A code artifact without a stored row is read-only in the canvas.
25. The canvas dock is 400–60% wide, opening at 480; the web's canvas opens at 46% of the window.
26. A `juno-visual` flow wraps its nodes with arrows only as wide as an arrow; the web gives each arrow a full grid column.
27. A Mermaid figure settles to its diagram's height (160–520) after a 288 skeleton; the web's stays 288 and scrolls.
28. Regenerating a reply that carries artifacts asks first ("Regenerate this answer?"); the web regenerates, and deletes them, at once.
29. A design that has no stored row yet cannot be opened in the canvas; the web opens the canvas only once the row exists, so it never offers one.
30. The Mac's thinking and tool UI follows the Tool calls & research rework's decisions (inline run block, phase-typed signature, Activity panel) before the web ships them; the live web still shows `ThinkingDots` and the Thought panel.
31. Without the rework's typed timeline the Mac builds the run from today's activity rows (the SPEC's legacy adapter); connector calls with no detail and search rows other than deep research's are not drawn as steps.
32. A citation is a numbered chip without the source's logo: a `Text` run cannot hold an image that loads later. The logo is in the popover, which opens on click where the web shows a hover card.
33. The sources pill's label is SF, not the web's mono (the count stays mono).
34. Tables sit in a card with a filled header row (brief §6.2); the web's table is rules only, with no card or fill.
35. The approval card hairline takes the risk tone (source for a reversible change, warning otherwise); the web washes every answerable card in the warning tone.
36. Find counts and highlights what the reading style draws, message by message; the web scrolls the message into view and highlights through the DOM.
37. Until the toast host lands, a failed action on a reply (a rating that did not save, Read Aloud) shows as the error box at the foot of the transcript for six seconds.
38. The Activity panel has no find field, filters, Copy menu, j/k or cost; the rework removes them from the web too, but the live web still has them.
39. "Not sent" under an unsent question is SF 11 medium; the web sets it in its mono voice.
40. The run line's facts, the research row's count and the Activity panel's counts are SF with tabular numerals; the SPEC sets them in the mono caption. The Mac keeps mono for code, ids, the clock and durations (§10.2 rule 6).
41. The research plan card starts or cancels the plan as it stands; editing questions and "Update plan" are the web's alone for now.
42. Research answered inside the chat by a profile-1 server (today's production) shows the research row and panel on the Mac, read from its activity rows; the web shows its run line.
43. (Merge of main, 2026-09-24.) Agents is a sidebar navigation row after Design, as on the web, and wears `juno.agents`, the web's face mark. The web also folds the roster into the sidebar as its own section; the Mac does not yet (track B).
44. Main's Agents views draw their primary buttons as opaque `.borderedProminent` in `junoAccent`, not in `.glassProminent`: glass is chrome only (§0.1), and two of the three are inside sheets. The web's buttons are opaque too.
45. The Mac keeps the Design row and `/design` routing although the web dropped them in `e5501f65` (Design is now a type in Artifacts). This is the open follow-up "Artifacts and Design merge on the web" in `MACOS_REDESIGN_HANDOFF.md`.

## Foundations errata (shared by Phase 3 and Phase 4; apply over §3, §7.1, §7.7, §9)

Built on `mac/liquid-glass-chat` before the overlay track (A, this worktree) and the pages track (B, `mac/liquid-glass-pages`) split. Everything below is in `JunoDesignSystem` unless it names an `App/` file; the live web on `origin/main` was the parity target, and where it disagrees with the text above it wins.

- **§7.7 Toast host (`JunoToastHost.swift`).** One `JunoToastCenter` per window, handed down as `@Environment(\.junoToast)` (`toast(.success("Chat archived.", action: …))`, `toast.dismiss(id)`); drawn once with `.junoToastHost(center)` — on `ChatDetail`'s content in the Chat window and on the Settings window's detail — and never inside a sheet. Glass (`.regular`, one `GlassEffectContainer`) at the **card radius 16** (errata 9), 300–420 wide and hugging its words; the Reduce Transparency recipe is the web's `.surface-float` (popover fill, a 0.9 hairline, the float throw). Placement: 12pt above the composer, read from `.junoToastAnchor()` on the chat column's dock while a conversation is docked; 24pt above the bottom everywhere else, including a draft (whose composer is lifted to the middle). Contents are the web's `sonner.tsx`: the status glyph on its ink ramp (`ph.checkcircle` success, `ph.warningcircle` destructive, `ph.warning` warning, `ph.info` secondary, the spinner for loading), the title in 13pt medium foreground, an optional detail line in the secondary ink, the web's neutral bordered action (`[data-button]`) and ghost second action (`[data-cancel]`), and the ✕ (24pt drawn, 28 hit). The offers drop under the sentence when the row cannot hold them. 4s auto-dismiss (`JunoToast.defaultDuration`), held while the pointer is over it; `duration: nil` for a decision the reader owes (a sync conflict). A newer post replaces the one showing; re-posting an id replaces it in place and restarts its time. Enters with a 4pt rise and fade on `outSoft` 220ms, leaves on `in` 160ms; the rise is dropped under Reduce Motion. **Selection mode** is `JunoToastSelectionBar` under any toast: "N selected", ghost actions, a destructive outline for Delete, and the clear ✕ (the web's bulk bar), raised with `.junoToastSelection(_:id:)`. Standing conditions post through `.junoToastStatus(id:_:toast:)`, which posts on change and takes the toast down when the condition clears.
- **The five per-screen toasts are gone** (glass gate 37 → 28 with the Projects buttons below): Library's reload failure, Projects' outage and conflict, Artifacts' failure, the design surface's unsaved-edit warning, and Settings' conflict and sync failure now post to their window's host. The transcript's six-second failure box (`DesktopActionFailure`, register #37) is deleted: a failed action on a reply is an error toast, and Branch, Fork Privately and Copy Link confirm with a toast. Archiving a chat posts "Chat archived." with Undo, as `app-sidebar.tsx` does.
- **§9 Page template (`JunoPage.swift`).** `JunoPage(measure:scrolling:header:controls:content:)` — `.reading` 768 / `.wide` 1024 / `.full`; the web's gutter (16 / 24 from 640 / 32 from 1024 of the page's own width) and block padding (20/40, 28/48 from 640); `.page` scrolls everything, `.content` keeps the header still and hands the content its own scroller, which lines up through `.junoPageColumn()`. It is drawn as `Color.clear.overlay { … }` so no page can resize the window. `JunoPageHeader(title, lede:) { actions }` is `AppPageHeader`: the page's own name in the fluid `pageTitle` rung marked as a header, the lede in the 15pt body rung at a prose measure, trailing actions bottom-aligned (`.bordered` with `.tint(nil)`, at most one `.junoProminent`), dropping under the title when they do not fit, then 20pt, a 1pt `--border` rule and 24pt. `JunoPageControls { leading } trailing: { … }` is the web's `flex-wrap` controls row: one line, then the trailing group on its own line, then every control wrapping. `JunoPageSearchField` (magnifier or spinner, a plain field on the canvas under the `--input` hairline, 32pt at the web's field radius 12 — §9 said 10 — the edge darkening under the pointer and taking the neutral ring colour while focused, Esc clears, ✕ to clear) and `JunoPageMenu` (a field-shaped trigger over a system menu with an inline picker: the web's words on the trigger, Title Case in the menu).
- **§3 Pages declare nothing in the toolbar.** Library (its `.searchable`, filter and view `Picker`s, Add Document and Refresh `ToolbarItem`s), Connections (its All apps / Connected `Picker` and Refresh) and Search (its `.searchable` and `.searchScopes`) are on the template with those controls in content; ⌘R and ⇧⌘I stay on the header's buttons. No page declares `.toolbar` or `.searchable` in the Chat window now. The window title is kept on pages (errata 10's second option), so a page's name is in the titlebar and in its header.
- **Detail pages push.** `DesktopDestinationView` puts every page (not the chat route) in a `NavigationStack` of its own, inside `ChatDetail` and below its toolbar and title; the stack root restates the page's title. Agents now pushes an agent's page with `.navigationDestination` on the Mac too and draws no back control of its own. Projects' detail still swaps in place (track B).
- **§9 `JunoSegmented`** replaces `DesktopSegmented.swift` (deleted; every call site moved) and the system `.segmented` pickers in Library ×2 and Connections. The web's control: a `.surface-inset` track (canvas, 1pt `--border` at 0.8, radius 14, 4pt inset, 32pt), a `.surface-raised` thumb (card, hairline, `--shadow-raised`, radius 10) on the standard spring, **equal segments** (the web's `repeat(n, 1fr)`), 13pt medium labels, a faint hover wash, a 0.97 press on the whole segment, counts in mono micro at the segment's own ink, an optional accent badge, disabled segments, and `fills:` for a switch that spans its column. The Artifacts screen's view switch is still a system `Picker` (track B rebuilds that screen); the shared packages' (`JunoChatKit` canvas, Agents, `JunoComposerAura`) and Code's are left to their owners.
- **§9 `JunoEmptyState`** is rebuilt on today's `empty-state.tsx`: `size: .page` is open — a 48pt tile at radius 12 on `--secondary` holding a 24pt secondary glyph, the 18pt heading rung, a 15pt secondary sentence at most 384 wide, a `.bordered` neutral action 24pt below — and `size: .panel` sits in the dashed well (canvas fill, `--border` at 0.8) at the **card radius 16**, with a 36pt tile at radius 10 and a 15pt semibold title. `tone: .error` (or a failure glyph) tints only the tile and makes a panel's edge solid. It rises in on appear. The call sites keep their arguments.
- **§7.1 helpers.** `JunoConfirmation` + `.junoConfirmation($value)`: the system confirmation dialog, title visible, the role button and Cancel, the web's words (the design screen's delete `.alert` moved onto it). `JunoInlineRenameField(current, accessibilityLabel:, commit:, end:)`: the in-row rename — Return and focus loss commit a trimmed, changed name; Esc cancels without committing on the way out — now used by the sidebar's chat and pinned-project rows.
- **§0.4 The prominent button's accent, fixed at the style.** Cause: `.borderedProminent` fills with the environment's `tint` and otherwise with the app accent, which the asset catalogue does not set (`ASSETCATALOG_COMPILER_GLOBAL_ACCENT_COLOR_NAME` is absent, so AppKit uses the reader's system accent — blue), and `.junoAccentTint()` sits only below the toolbar's owner. So every prominent button outside the chat column's content — sheets presented from the split view, the legacy Work window, the approval card drawn in its own snapshot — was blue unless its site remembered a tint. `.buttonStyle(.junoProminent)` is `.borderedProminent` carrying the accent itself; every Mac site outside Juno Code uses it, the Projects page's four `.junoProminentGlassButton()`s became it, and two unstyled `.defaultAction` buttons (Memory's Save, Artifacts' Rename) took it. A new gate, `npm run native:design:prominent` (part of `native:design:check`), ratchets raw `.borderedProminent` in Mac-shipped code; its baseline of 9 is Juno Code's own sites.

**§0.8 register, additions.**

46. `JunoSegmented`'s counts are at the segment's own ink; §9's 70% dimming is gone because the web removed it (2.9:1 in light). Segments are equal widths, as on the web.
47. The empty state follows today's web rather than §9 and errata 9: a page-size state is drawn open (no well), its title is the 18pt heading rung (not 17), and the dashed well is the panel size only, at the card radius 16 (not the field radius 12).
48. Prominent buttons carry the Juno accent in their style (`.junoProminent`) rather than inheriting a tint; the window's accent colour stays the system's, as before.
49. One toast at a time; the web stacks up to three. A draft's toast sits 24pt above the window's bottom, where the web lifts it 8rem on `/chat`. Toasts are glass cards (a floating layer, register #1); the web's are opaque.
50. The page search field is 32pt at the field radius 12 (§9 said 28 at 10): every control in the controls row is 32, the Mac's rung over the web's 36. Its focus edge is the neutral ring, never the accent the web's input takes.
51. The Library header carries Refresh and Add Document… (Mac extras: no Upload or Recently deleted yet, and no rename or delete in the Mac library client), and its selection bar offers Copy Names. Connections' header carries Refresh and the connected count, which the web does not draw.
52. The Search page's lede, "Chats, messages, files and artifacts synced to this Mac.", is new copy: the web has no search page (it becomes the ⌘K panel in Phase 3).

## Phase 5 errata (from `MACOS_PHASE5_WORK_IN_CHAT_BRIEF.md`; apply over §1.7, §2.3–§2.5, §5.4–§5.9, §6.8, §6.9, §7.8, §7.10, §7.11, §11 Phase 5)

The brief re-read the live web at `origin/main` `fe0a501d` (2026-09-24). Where the web and the text above disagree, the web wins; these are the corrections. The brief has the detail and the stages.

- **Tasks are started by the chat model, not by a switch.** The web removed "Do this as a task", "How often it asks", the task mark, the disclosure line and the delegation offer (`19941547`). A saved chat's `POST /api/chat` carries `workHandoff: true`; the server lets the model call `start_task` when its gate allows; a start that needs a person arrives as the `juno_work` / `start_task` approval card; the stream then sends `{type: "work", session}` once. The Mac sends the flag (iOS does not claim it) and decodes the frame. §5.4's Task and "How Often It Asks" rows, §5.5's Task mark, §11 Phase 5 steps 2 and 3 (client dispatch), and the Phase 5 slice's toggle and `dispatchTask` are withdrawn. "How often it asks" is a project default now (Projects › Settings › Task defaults; track B).
- **§1.7 and §7.10 errands** (Quick Entry, the menu-bar extra) open an ordinary chat with the prompt; nothing is armed.
- **§6.8 Work card.** The web's anatomy: "Task", the title at 15pt, the status pill and sentence (re-voiced with an agent's name in its thread), Stop in the header; live: the current step, Plan with a `done/total` tally and a checklist (no progress bar), the Elapsed · Cost · Tokens meter, the newest three turns, questions and the approval queue; finished: terminal detail, degradation notes, the outcome digest, the deliverables, "Save this as a skill", the meter. It sits after the reply that follows the task's turn. The newest task is the live card; earlier ones are one-line rows (register #53). Questions and approvals are answered in the card; the Task panel (register #59) holds Activity, Files and Details.
- **§6.8 Research card.** Stage 4b's row, plan card and panel stand. Added: web-started runs are shown, a recap card for finished runs with no completion message, the clarification gate, stopped-early runs without "Open report", the report window (register #65) and citation marks.
- **§5.6 and §5.8 Steering.** The web's rules: task steering whenever a task is live or asking (standalone), research steering while the chat streams a research turn; placeholders, send and stop labels from the run; text only, no mic; the draft clears only when the server accepts; pending steers above the field with the web's "Queued — …" header and **no** ✕ (a queued steer cannot be withdrawn). Stop: research → cancel the run, then the stream; a live task with nothing streaming → cancel the task; otherwise the stream. A finished run is never steerable (register #54). The follower is a new `NativeConversationWork`, not `NativeWorkModel.openSession`.
- **§5.9** "Answer Juno’s question…" takes the web's curly apostrophe; an agent's thread's placeholder is "Message {name}…".
- **§6.9 Task approvals** use the web's words: "Don’t" · "Change it" (reveals "What should it do instead?" and "Send this instruction") · the verb · More ▾ "{Verb}, and Stop Asking"; the queue's batch button is "{Verb} — all N" or "Allow all N", not "Make all N changes". A handoff to a teammate (`hand_off_to_teammate`) gets the web's handoff card ("Hand this to a teammate?", "Hand off").
- **§2.3–§2.5 Sidebar.** Order: Needs you, Agents (the roster fold: face, name, the needs-you dot; hidden while filtering), Pinned projects, Pinned chats, Recent. A row's help reads "{title}: {sentence}". The fold's announcements are the web's ("{n} runs are waiting on you.", "Nothing is waiting on you."). A **Notifications** row follows New chat and opens the web's inbox as a popover; its one signal is a dot (accent while something unread asks for a decision), never a count.
- **§7.11 Notifications.** A rise posts the web's sentence ("A task needs you", "{n} tasks need you", " — {t} in total") as a toast in front and a replaceable local notification behind, when "When something needs you" is on, skipping chats that are an agent's thread (main's agent banner covers them). Permission is asked at the first task started in this Mac's chat, or at the first agent (main). A notification's `/work/{id}` opens its task's chat.
- **§7.8** Window › Tasks (Legacy) is removed with `.legacyWork` and `DesktopWorkWorkspace.swift` (Stage D). Tasks without a conversation open in a sheet from Search › Tasks (register #63).
- **No agent @-mentions.** The web's `@` rows are tools and apps.

**§0.8 register, additions.**

53. Earlier tasks in a chat stay in the transcript as one-line rows that open the Task panel from a one-shot read; the web draws only the newest task.
54. A finished task never keeps the composer in answer mode; the web keeps "Answer the task’s question" while a question is open on a finished run, and the server refuses the answer.
55. A task's live step is a neutral tile led by the chat's run signature, and finished plan steps are marked in neutral ink; the web tints the step coral with a spinner and fills done steps in coral.
56. The pending-steers header, "Waiting on you · asked …", "Your decision" and "never finished" are SF 11; the web sets them in its mono voice (extends #39 and #40).
57. The task card's overflow menu has Pause, Resume, Try Again and Show Details; the web has no pause, resume or retry in chat (A5).
58. A task's deliverables are Quick Look tiles for every file it made, with Save As…; the web previews the newest inline with Download and points the rest to an "Outputs" list that chat does not have. The outcome digest's actions line ends "They are listed in Details.".
59. The Task panel (Activity · Files · Details) in the trailing dock is Mac-only; the web retired its task page.
60. In a queue of task approvals only the first answerable card's verb is the prominent button; the web draws every card's verb as primary.
61. Tasks that need you also raise the Dock badge, the menu-bar extra's count and, when Juno is not in front, a local notification; the web has a toast and, where the browser already allows it, a browser notification.
62. The Notifications popover has no "Get notified on this browser" row; the Mac's switches are in Settings.
63. Tasks with no conversation (from the old Work window) open in a sheet from Search › Tasks or a notification, still answerable; the web sends them to an empty chat.
64. A chat looks for its task only while its window is visible; the web polls every open chat every four seconds.
65. The research report opens in its own window with Copy, Export Markdown… and Print…; the web opens a dialog.
66. A skill's instructions are edited in SF, not mono.
67. A task approval carries a hairline in its risk tone and no warning wash (extends #35).
68. The task card's run words leave out a question that is still open, which its question card shows; the web prints it in both (Stage A, 2026-09-25).

**Stage A notes (2026-09-25), where today's web was followed over the text above.**

- **Status words.** The chat's card, settled rows and Task panel say the web's `STATUS_META` words verbatim ("Waiting to be picked up. Nothing is running yet.", "Out of budget", "This stopped before it finished.", and the rest). The legacy window's `DesktopWorkStatusStyle` had drifted in five places; it is left as it was until Stage D removes the window.
- **The question card** is the web's `WorkQuestionCard`: "Waiting on you · asked {time}", the question, its why, one-press replies, and "Reply below" (sentence case, the web's button copy); a second open question says "Answer the question above it first; this one is next.".
- **Plan steps** gain the web's derived `unreported` state (a step still open when the run finished, failed or paused), drawn as a dashed ring with "never finished". The legacy window reads the same derivation, so its stranded spinner goes too.
- **The server does not yet let a native turn start a task.** `chatTaskToolEnabled` refuses a `regenerate` turn and needs the persisted user message id, and every native turn is sent as `regenerate: true` after its message is synced (so the route has no `userMessageId`). The Mac sends `workHandoff: true` and draws the frame as specified; a model-started task will reach it once the server's gate keys on "an answer is being replaced" rather than on the `regenerate` flag. Recorded as deferred; the web is unaffected.

**Stage B notes (2026-09-25): the finished card, the Task panel, approvals.**

- **Why a run ended** leads the finished card in the executor's own sentence (`terminalDetail`), as the web's `TerminalRun` does, rather than the Mac's reason phrase. The outcome digest counts what changed with the web's `derivePerformedActions`, now `WorkEventLog.performedActions`, including its "{n} actions ran without saying whether anything was changed…" line.
- **Deliverables** download to `Caches/<bundle>/WorkFiles/<account>/<artifact>/v<version>/`: the version is part of the path, so a revised file is a new page rather than the old one's preview. Purged at sign-out with the transcript cache. A file whose bytes the export validator never opened asks before Save As… with the legacy window's words ("This artifact has not been validated"). The legacy window keeps its own save panel until Stage D deletes it; the chat's is `ChatWorkFileSaving`, so the legacy window's behaviour is unchanged.
- **"Change it" on a run on this Mac.** The Mac's coordinator takes no reason with a refusal, so the correction is refused and then handed to the run as an instruction; a server run gets it as the decision's `reason`, as on the web.
- **The Task panel's Details** is three short groups (how it ran · what it cost · when) split by one hairline each, not a rule under every row. **Files** lists the task's artifacts, then the files it changed on this Mac under "Changed on this Mac" (new copy).
- **Save this as a skill** sends `autoSelect: false` explicitly (the brief); the web omits the field.
- **The task and handoff approval cards'** status lines are `TASK_STATUS_COPY` and `HANDOFF_STATUS_COPY` verbatim, which adds the superseded and blocked lines the slice lacked.
- New Mac-only copy, for the audit: "Changed on this Mac"; "Nothing has happened on this task yet." (Activity with no events); help "More answers" on an approval's More menu; the accessibility label "What it produced" on the deliverables.

**Stage B notes, research (B6), 2026-09-25.**

- **Which runs draw what** (the native mirror's C4, as `NativeResearchRun.presentation`): a live run is its row, plan card or clarify gate; a finished run with a completion message is that message (its row stays, as "Report ready", only where this Mac saw it working); a finished run the in-chat path wrote (`plan_confirmed.by == "auto"` and a `research-report` artifact) draws nothing more, since its answer already carries the report; any other finished run with a report or sources is a **recap**. The web draws a recap for every finished run of the conversation, including the in-chat ones; the Mac leaves those out so the report is not shown twice.
- **Placement.** A run follows the question it answers; a run with no question on screen (listed runs, web-started runs) follows the last turn created at or before it, as the web orders its runs by `createdAt` among the messages.
- **Discovery** lists the conversation's runs when it opens, adopts every live one whether or not the server derives a phase, reads the ten newest finished ones not yet seen once, and lists again every 8s while nothing is live (a run begun on the web appears within that). Runs behind the server's `maxSeq` are read again at once (up to eight quick reads per tick).
- **The recap's ✕** is remembered per run in this Mac's defaults, per account; the web's lasts the page.
- **The clarify gate** takes the web's `ClarifyGate` words and adds its heading "Before Juno starts" (the web's console heading at a gate). A needed question is marked "Needed" (the web defines the word and marks only "Optional").
- **Finish now** is hidden for a run whose server derives no phase, and for the rest of the session once a server answers it with a 400.
- **Stop on an in-chat Research turn** stops the stream, then cancels the newest live run the server lists for the conversation that has no derived phase and was created at or after the turn was sent (less two minutes for clock skew), looking twice three seconds apart. A background-research server's runs are never cancelled this way (they carry a phase).
- **The report window** reads the run's own report (`reportBody`), numbers `[n]` over the sources read in the order the run holds them, and lists them as "Sources read · {n}" (today's server has no cited/uncited split). Its Contents column lists the report's `#`, `##` and `###` headings when there are two or more and follows the reading position. Copy copies the report's Markdown ("Copied" for two seconds); Export Markdown… writes `{slug(title)}.md` with a `## Sources` appendix; Print… (⌘P) prints the report and its sources in the light appearance. Toolbar glyphs: `ph.copy`, `ph.downloadsimple`, and `ph.printer` (added from the web's `Printer`).
- **Citation marks.** Where the report is an answer with a citation check (`assistantMessageId`), a citation's popover gives the verdict in its tone ("Supported", "Partly supported", "Unsupported", "Contradicted", "Not checked"), the passage verbatim and "Open at passage" (a text fragment of its first eight words); otherwise the source and "Open Page". The chip itself is the shared citation chip, untinted: the verdict is in the popover, not on the chip. Today's web background runs have no check, so they show no marks and no error.
- **The report in the transcript's prose** takes no text selection, like a reply (a click on a citation opens it); Copy takes the whole report.
- New Mac-only copy: "Couldn’t open this report" / "Check your connection and try again." (the report window's error), "Loading this report" (accessibility), "Report contents" and "Report sources" (accessibility, the web's labels), "Before Juno starts" (a phase word in the panel header, the web's heading).

**Stage D notes (2026-09-25): the old Work window removed, tasks without a conversation.**

- **Removed:** `App/DesktopWorkWorkspace.swift`, `App/DesktopTasksScreen.swift` (unreferenced since Phase 1), `DesktopProductMode.legacyWork` (a stored `"work"` restores to Chat through the root's fallback), Window › Tasks (Legacy) with `DesktopShellActions.openLegacyTasks` / `isShowingLegacyTasks`, the legacy `newItemTitle` case, the `juno.desktop.work.selection` / `juno.desktop.work.page` scene keys and the root's `openWorkSession`, the preview harness's `--juno-preview-work-overview` and `--juno-preview-work-files` switches (the phone's `--juno-preview-tab work` still opens its fixture task), and the legacy UI test paths.
- **Moved, not changed:** `DesktopWorkBlockerRow` and `DesktopWorkStartPath` into `DesktopWorkSettings.swift` (host setup, beside the tile track B takes into Permissions); `DesktopWorkStatusStyle` into `DesktopWorkVocabulary.swift`; the rest of `DesktopWorkLog` (every visible event as a line, what the run read and wrote, `hasAppliedBatch`, the work between turns) into `JunoWorkKit/WorkEventLog.swift`, with semantic marks the app draws (`WorkEventLog.Entry.Mark`). The window's own artifact reader was not moved: the artifact route is the file catalogue. `JunoMobileWorkView` keeps its own copy.
- **The task sheet** (`DesktopTaskRecordSheet`) is a 640 × 600 opaque sheet over the Chat window: the title at 18pt semibold, the status pill and the web's status sentence, then the lede (said only of a task this Mac has read and found without a chat); the chat's task card in a standalone mode (no header of its own, since the sheet's carries the title, Stop and the More menu); "Done" (`.bordered`, `.cancelAction`). The follower is `NativeConversationWork` keyed on the task (`init(sessionID:session:client:accountID:)`): it follows that task's stream, re-follows when a finished task is live again (Resume, Try Again), and says when the stream cannot be reached before anything was read (the sheet's "Couldn’t load this task", with Try Again). Approvals decide in place (in this process for a run on this Mac), and the current question carries its own field and "Reply" (`.junoProminent` unless an approval that can still be answered holds the prominent button). A live task opens scrolled to what it waits for; a finished one to what it made. Deliverables open, Quick Look and save as they do in a chat, with the same unvalidated-file question. A sheet covers the window's toast host, so an action that did not land is said in the sheet's footer. "Save this as a skill" and Show Details are not offered in the sheet.
- **Search › Tasks** (`DesktopSearchScope.tasks`, offered only where Work is composed) reads `GET /api/work/sessions?limit=100&archived=true` each time the scope is chosen, rather than `NativeWorkModel.sessions` (limit 50, no archived tasks) — the brief's limit and archive rule, without changing the model the phone shares. Rows: the title, "Updated {ago}" (the web's `workTimeAgo`), "· Archived" where it is, and the chat's status pill at the trailing edge; newest activity first; the query filters by every word in the title or goal. Loading is skeleton rows; empty is "No tasks yet" / "Tasks Juno runs for you appear here."; a failed read is "Couldn’t load tasks" / "Check your connection and try again." with Try Again. A task with a chat opens it (syncing first if this Mac has not seen it); one without opens the sheet. The status bar reads "{n} tasks" and "Tasks on your account". The ⌘K panel carries the scope forward in Phase 3.
- **A `/work/{id}` notification** is resolved in the Chat window now: the model's list, then one refresh, then `GET /api/work/sessions/{id}` (an archived task is never in the list); its chat if it has one, otherwise the sheet, by id if it could not be read.
- New Mac-only copy, for the audit (with Appendix A's): "Task" (the sheet's title when the task could not be read), "Couldn’t load tasks", "No task matches “{query}”.", "Reading your tasks…", "Tasks unavailable", "{n} tasks", "Tasks on your account", "Updated {ago}", "Archived", "Open Task" (a row's menu), help and hints "Opens the task" / "Opens its chat", the accessibility label "Your answer" and "Reading your tasks". The reply field's placeholder is the web's "Answer Juno’s question…".


**Stage C notes (2026-09-25), where today's web was followed over the brief's text.**

- **Status dot tones** are `STATUS_META`'s (`work-vocabulary.tsx`): running and preparing live; waiting, interrupted, Mac unreachable, out of budget and timed out attention; done good; failed bad; the rest neutral. The brief pointed at `DesktopWorkBucket.of`, which sorts tasks into buckets and has no tones. The tone lives beside the dot (`JunoStatusTone(_:)`).
- **"New agent"** on the Agents fold's heading is shown at rest, as the web's `SectionAction always` is, not only on hover.
- **The agent thread's header** is the web's `AgentThreadHeader`: the face (a link to the page), the name at 13pt medium, the sentence at 11pt (the thread's own state wins: "Thinking" while a reply streams, "Listening" in a call; otherwise the roster's sentence), and "Agent page" as the web's quiet text button in the secondary ink with a hover fill, not an accent link. It carries no needs-you dot (the web's has none; the sidebar and the card say it).
- **An agent's empty thread** is laid out as a draft: the web's `hasMessages` is false there (no message, call, research run or task), so the composer is centred under the agent's greeting ("Hi, I’m *{name}*." in the greeting's serif, then "{role}. What should I take on?" or the paused line) with the starter chips below, rather than an empty transcript under the header.
- **Hiring from the fold** opens the hire sheet on the first job, as `/agents/new` with no template starts from `AGENT_TEMPLATES[0]`; a new hire's page opens.
- **The fold's live region** speaks the web's sentences when the count rises and when it reaches zero; a fall that leaves chats waiting is the reader answering and says nothing.

**§0.8 register, Stage C additions.** (Numbered after Stage A's; Stage B's lane may also add entries, so integration renumbers if two collide.)

69. The Dock badge, the menu-bar extra's count and the rise sentence count the chats the column can show: every chat whose newest task needs the reader, less those the store knows are archived or Code's (a chat not yet synced still counts). The web's toast counts every conversation id its list returns.
70. The menu-bar extra's number adds the Code sessions waiting on an approval to the chats in Needs You, since the menu lists both; the Dock badge is the fold's count alone.
71. An empty or failed Notifications popover closes up to 272pt under its header; the list and its loading rows take 480pt. The web sizes the popover to its content under a 36rem ceiling.

## Phase 4 errata, Stage A (from `MACOS_PHASE4_PAGES_BRIEF.md`; apply over §9 and the Foundations errata)

Built on `mac/liquid-glass-pages` against `origin/main` at `fe0a501d`. Where the brief and today's web disagreed, the web won and the entry below says so.

- **A0, the merge.** `origin/main` (push notifications, the inbox, native push and approvals, the Agents sidebar fold) is merged. Generated tokens, contract and icons were regenerated, not hand-merged. The Agents fold's header is `Text("Agents").textCase(nil)`, not main's mono caption. `JunoIcon.notifications` wears `ph.bellsimple`, the web's `AppIcons.notifications`. `NativeAgentsScreen` keeps main's `selectedAgentID` binding but pushes the agent page on the page's own stack.
- **A1, `ChatArtifactResolver`** follows `resolveArtifactTag` (`src/lib/chat-client-state.ts`): rows keyed by their own identifier; M11's retired `{identifier}~{tail}` rows are candidates; the message's own row wins, then the newest written before the message, then the oldest; ties by `(createdAt, id)`. The transcript passes each tag's message. The canvas dock remembers the row it opened (`DesktopChatArtifact.storedID`) and reads it back by id, so a type change never swaps the open canvas; the tag is re-resolved, with its message, only when no row existed at open time.
- **A2, Design is a type.** The sidebar's rows are Library, Projects, Artifacts, Agents. `.design` stays decodable; `DesktopNavigationState.normalized(_:)` turns it into Artifacts with the `DESIGN` filter wherever a destination is stored. `DesktopPageRoute` / `DesktopPageRouter` / `DesktopPageStack`: every page destination has one `NavigationStack(path:)` with one `navigationDestination(for:)` at its root and a `desktopPush` environment action; requests from outside the window (pinned-project rows, Open in Conversation, later ⌘K and Settings) go through `DesktopPageRouter.shared`. `DesktopDesignScreen.swift` is deleted; its presets and start client live in `ArtifactDesignStart.swift`.
- **A3, posters.** `NativeDesignPreviewLoader` asks for `GET /api/artifacts/{id}/poster?v=&r=1` first (`posterRenderer = 1`): sealed versions from the cache forever, the current version revalidated once per loader with `If-None-Match`; a JSON 404 falls back to the SVG export for that version, a non-JSON 404 marks the route missing for the loader's life; 401/429 fail and retry; other errors are unavailable. Cache files `<id>-v<n>-r1.svg` (+ `.etag`) and the export's `<id>-v<n>.svg`. Posters on pages are drawn natively (`NSImage` reads SVG), not in a web view.
- **A4, Library** (`DesktopLibraryScreen`, `NativeLibraryPageModel`): the web's page — storage caption, Recently deleted, Upload and a More (Add Document…, Refresh); search, All / Images / Files with the server's counts, the four sorts, List (default) / Grid; the list in one card with Name · Type (from 768) · Size and Added (from 640, folded into one meta line below); square tiles 2 / 3 / 4 across; Recently deleted as its own view; delete optimistic with the web's `removalNotice` and Undo (Undo waits for the delete to land); Rename, Versions (sheet), Download, Quick Look, Open Source Chat, Edit Image…, Copy Names; uploads from the header or dropped anywhere on the page (the drop veil). The local document index stays above the files. The composer's picker keeps `NativeLibraryModel`.
- **A5, Projects** (`DesktopProjectsScreen`, `DesktopProjectPage`): the list on the template (search, All / Pinned, the three sorts, "{n} of {m}", tiles 1 / 2 / 3 across with the cover or folder inset, a neutral pin that stays while pinned); New project withheld while loading or empty. The project is pushed: caption "Project", the counts lede, Instructions / pin / More (Rename…, Add Project Image… / Change Image…, Remove Image, Delete Project…); tabs Overview, Tasks (when any), Sources, Settings; Overview is the opaque ask field and "Chats in this project" beside a 304pt rail (Instructions, Sources, Memory) from 896 of page width. Sources has the drop well and file / artifact rows; Settings has System instructions, Identity and model, and Tools cards, each with its own Save.
- **A6, Artifacts** (`DesktopArtifactsScreen`, `ArtifactPage`): the web's list and grid, the type chips (`HOME_TYPE_ORDER`, Designs always), New ▾ (Design sizes, Ask Juno in a New Chat), the presets pinned with the Designs filter, and one action definition per row (Open, Open in Conversation, Rename…, Download Source…, Share… while Track A's hook exists, Open in New Window, Copy Source, Delete…). A row opens the artifact's own page: a design at its latest version is the design editor (Discard, Save, Delete Design…); everything else, and older design versions, is read-only with the version pager and Open in Chat. The read-only badge (the file's one glass site) is gone: glass 28 → 27. The hosted design editor bundle is rebuilt from main's editor (`1.0.0+2efcc6ad8d3a`); outside its `window` surface it hides the left rail below 640 and the inspector below 896 of editor width, so the artifact page (≈936 wide beside the sidebar) shows both and the chat canvas dock usually shows neither.
- **Review fixes before the commit.** The Library grid's tile draws only the type glyph when it has no picture (`NativeFilePreviewTile(fallback: .glyph)`, additive; the composer and iPhone keep the named card), because the name and size already sit under it. A project's lede counts sources as files plus artifacts, as the web's header and the Sources tab do. Cancel and Done in the Stage A sheets (New project, Rename, Versions, Compare Versions, Instructions) are neutral (`.tint(nil)`): the window's accent tint had drawn them coral beside the sheet's one prominent button.
- **A7, the document inspector,** is not built: no server field names a library item's document yet (`knowledge.documentId` is decoded, and nothing reads it).
- **Gates:** glass 28 → 27, targets 291 → 267 (baselines re-recorded), type 0, motion 0, prominent 9.

**§0.8 register, additions** (the brief proposed #53–#73; Track A has since used #53–#68, so these are numbered on from #69):

69. **Artifacts opening.** A row opens the artifact's own page, pushed on the Artifacts stack, as the web's `/a/{id}` does; "Open in Conversation" is the canvas dock on that row. The page does not edit except a design at its latest version: the web's window is read-only and the chat is where an artifact is changed.
70. **Design is a type.** No Design row; `.design` resolves to Artifacts › Designs, as the web's `/design` redirect does.
71. **Poster fallback.** Designs draw the server's poster and fall back to the SVG export when there is none; the web falls back to the type glyph.
72. **Pins** on project tiles, the project page and project chats are a neutral fill glyph; the web draws them coral.
73. **Eyebrows and back.** "Project" is an SF 13 medium caption above the title, not a mono label; detail pages use the system back button, not the web's back row.
74. **Meta lines** (project ledes and tile footers, artifact rows and tiles, library rows) are SF with tabular digits; the web sets them in the mono caption (extends #40). The version pager's count stays mono.
75. **Library.** List is the default and the grid is square tiles, as on the web. Mac extras: Add Document…, Refresh, Copy Names, Quick Look, Edit Image… and file drag-out.
76. **Design sizes** in the New menu show the size as the item's subtitle; the web right-aligns it in mono.
77. **Preset hover.** The preset buttons' plus stays neutral on hover; the web turns it coral.
78. **Project ask field.** A project's Overview has an opaque, composer-shaped field; Return opens a new chat in the project with the words in its composer (the draft is prefilled and not sent, because the draft composer takes no send request before it appears). The web embeds a second full composer that sends. Glass stays on the one real composer.
79. **Project tab counts** use `JunoSegmented`'s counts; the web adds a badge to the tab label. Code is not a tab yet (a Code session cannot be opened from a page).
80. **Headings.** A project's Settings cards head on the `heading` rung, not the web's mono labels.
81. **Sheet buttons** are Title Case ("Create Project", "Rename Project", "Save Changes").
82. **"Download Source…"** keeps the web's words and adds an ellipsis because it opens a save panel.
83. **One prominent per surface.** The Library header withholds Upload while the empty state shows "Upload files" (the web shows both); the Artifacts New ▾ is withheld on a first-run empty page, as on the web.
84. **Sizes** use the web's `formatBytes` (1024-based, one decimal, "0 B") rather than the system's byte formatter.
85. **Library uploads** go through the native upload route (`/api/v1/attachments`, the existing client) rather than the web's `/api/upload`, and an uploading row shows an indeterminate bar: the native transport reports no byte progress.
86. **New project.** A blank name is created through `POST /api/projects` (the server names it from the first chat), because the sync mutation needs a name; a named project goes through the sync outbox.
87. **`?new=design`** cannot open a native menu from code; a request for it lands on the Designs filter, which pins the same four sizes above the list.

## Phase 4 errata: Stage B (Memory, Connections, Skills, Assistants; apply over §9 and the Phase 4 brief §4)

Built on `mac/lg-p4b` from `1876f3ac` (Stage A1 to A3), in parallel with Stages A and C. The live web on `origin/main` (`fe0a501d`) was the parity target; where it and the brief disagree the web won and the difference is registered below.

- **B1 Memory.** The page is the web's one calm column (`memory-manager.tsx`), `App/DesktopMemoryScreen.swift` (the page), `DesktopMemoryParts.swift` (summary panel, prompt dock, diff, welcome), `DesktopMemoryList.swift` (list, row, add form) and `DesktopMemorySheets.swift` (Activity, Import). Header "Memory" with the web's lede; trailing "On"/"Off", the `Toggle(.switch)` labelled "Memory" (the setting `memoryEnabled`, still written by `NativeMemorySettingsModel`, so Settings and the page never disagree) and a 28pt More: Learn from Past Chats (the unread count as the item's subtitle; Reading Past Chats… while it runs), Import from Another Assistant…, Export…, Activity, Memory Settings…, Reset Memory…. Notices are opaque bands (radius 12, `--muted`, 70% hairline): memory off with Turn on, the background-policy refusal with Background processing, reading past chats with a linear progress in the accent, and the offer to learn from them. The scope chips appear only when a project has memory of its own (a menu past five scopes) with the web's boundary sentence and "Open project". The summary panel is the page's one raised surface at the **panel radius 20** (the web's `rounded-panel`; the brief said 16), sections unfolding in place under a fade, "Updated {ago}", Rebuild / Write summary and Activity. The prompt dock sits at its foot inset 8, so its field radius 12 is concentric; Return drafts, the disc wears the busy face while "Drafting the change…", and a drafted change appears right under the field as a small diff with Discard and **Apply change** (the panel's one prominent). An applied change keeps "Applied" and Undo for 4.5s. The list is "Memories {n}", Search memories, By topic / Newest first, Add; sections by topic in the category order with the web's topic glyphs, "Show all {n}" / "Show fewer" past five rows, and "No longer used" for retired facts. Rows sit on hairlines, not in a card (register #77). A row is the fact, one caption line (status for a retired row, where it came from, when, "Until" for a temporary fact) and the sensitive and project tokens; clicking the sentence edits it in place ("Enter to save, Esc to cancel"); its More has Edit, Move to Project ▸, Open Source Chat, Forget and Delete, each removal optimistic with the web's toast and Undo for 5s (`useDeferredRemoval`). The footer is the shield sentence and the link row. The empty account is the welcome panel ("Juno hasn’t remembered anything yet") with Tell Juno something (the one prominent), Import from ChatGPT or Claude and Learn from past chats; the error is "Couldn’t load your memory" with Try again; loading is the panel and rows as skeletons. Reset is the system confirmation with Reset Memory, Export First and Cancel. The `Table`, the stat tiles, the privacy strip and "What Juno remembers" are gone. `DesktopMemoryScreen(model:back:)` keeps its signature: Settings reads the page model from `\.desktopMemoryContext`, set on the Settings scene.
- **B1 client and model.** `JunoChatKit/NativeMemoryClient.swift` (every `/api/memory/**` route the page uses, tolerant of unknown categories, statuses and operations), `NativeMemoryPresentation.swift` (scopes, grouping, search haystack, summary sections, relative time, the recap builder) and `NativeMemoryPageModel.swift` (the state machine; it answers each write with the web's sentence as a `NativeMemoryNotice` so the view posts to its window's toast host). It reads on the page's first appearance, not at sign-in.
- **B2 Connections.** No count in the header; Refresh (⌘R) is a 28pt icon button. Controls are All apps / Connected, the search, and a trailing "{n} apps". Sections "Connected" / "Linked and available to your chats." and "Available" / "Connect an app to let Juno work inside it." Coming back from the browser re-reads the account; a connector that came back connected holds "Finishing connection…" for 1.4s and settles into Connected with "{Label} is connected and ready to use." (the page's signature). Disconnect confirms with the web's sentence and toasts "Disconnected {label}." or "Couldn’t disconnect. Please try again." Loading is six tile skeletons; the load error, the catalog error and the empties are the web's words. The tile buttons are neutral (they were coral under the column's tint). `NativeConnectorModel.disconnect` now returns whether it succeeded (additive).
- **B3 Skills.** `JunoWorkKit/Skills/` holds `NativeSkillModels.swift`, `NativeSkillsClient.swift` (the web's `WorkResult` split as `NativeSkillResult`: a 409/429 refusal with the server's sentence against a failure the reader can only retry) and `NativeSkillLibraryModel.swift` (switches that answer at once and roll back with the server's sentence, ticketed per row; `NativeSkillRules` for slugs, search, rename problems, usage, update outcomes). Pages: `App/DesktopSkillsScreen.swift` (list), `DesktopSkillPage.swift` (`.skill(id)`, the editor, `.newSkill`) and `DesktopSkillSheets.swift` (Import from GitHub, the update sheet, Move to a project). The list is reading measure: "Skills" with the lede, Add ▾ (the one prominent, drawn by `DesktopProminentMenuLabel` because a `Menu` takes no `PrimitiveButtonStyle`) with Import from GitHub…, Write a Skill and Create with Juno (a new draft chat with `CREATE_SKILL_PROMPT`, not sent); the 40pt search with the `/` keycap that fades while typing (the signature); "Your skills" and "Installed" as rows inside one card each; source groups with the owner tile, `owner/repo`, "{n} skills · {n} on" or "Off", "Update available" in accent ink, the attention mark, More (Check for Updates…, View on GitHub, Remove…), the source switch and a disclosure, open while searching and remembered per source. The detail page has the caption "Skills", the name and description, On/Off, More (Edit, View on GitHub, Move to Project…, Delete…), the source chip or "Yours", "Type /slug · Version n", the notices in the web's sentences, **Usage** (the web's heading; the brief said "Use this skill") as two radio rows with the web's help lines, then Instructions / Files / History as a `JunoSegmented`. New skill is a pushed page per the web: Name, Description, Instructions, Create skill and Cancel; the web's New skill page has no Files, so neither does the Mac's (register #81).
- **B3 composer API (for Track A).** `JunoDesktopConfiguration.skillLibraryModel` (read at sign-in) exposes `chooseable: [NativeSkillChoice]` (slug, name, description, enabled, sourceLabel, sourceOwner; yours first, then each source; switched-off, source-off, blocked and consent-waiting skills excluded; trust not filtered, as the web's `chatSkillsFromLibrary`), `refresh()`, and `invocation(in:)` for a typed leading `/slug …` that names a real choice (`readSkillInvocation`). The composer sends the chosen slug as `skillSlug` on `/api/chat`.
- **B4 Assistants.** `JunoChatKit/NativeAssistantsClient.swift` (client and `NativeAssistantsModel`) and `App/DesktopAssistantsScreen.swift`. Wide page with the caption "Assistants", "Specialists you can reuse", the web's lede and New assistant; controls "Search assistants" and "{n} assistants"; a 1 / 2 / 3 column grid of tiles (36pt inset glyph, name with a neutral fill pin, two lines of description or "Custom Juno assistant", a footer with the preferred model and the version), hover Pin, Edit and Delete, and the dashed New assistant tile. A tile opens the editor (register #60). The editor is an 880 × 640 sheet: the form (Name, Preferred model with "Auto · intelligent routing", Description, Instructions, Conversation starters) beside the live preview of the tile, its starters and its instructions (the signature). Delete confirms with the web's sentence naming the assistant.
- **Destinations.** `DesktopDestination` gains `.skills` and `.assistants` (labels and icons); `DesktopPageRoute.skill(id)` and `.newSkill` push their pages. `moreCases` is unchanged: Stage C sets More to Assistants · Skills · Automations.
- **Design system (additive).** `JunoPageHeader(_:caption:lede:)` draws the web's eyebrow as an SF 13 medium caption in the secondary ink (register #57); `JunoEmptyState(title:message:icon:size:tone:actions:)` takes the web's two-action states. Eight Phosphor glyphs join the catalog: `ph.fingerprint`, `ph.target`, `ph.graduationcap`, `ph.bracketscurly`, `ph.users`, `ph.stacksimple`, `ph.folderlock`, `ph.githublogo`.
- **Contract.** `contracts/openapi/juno-native-v1.yaml` documents every route the Stage B clients call (memory v2, the edit ledger, recap, backfill, import, consolidate, the skills library, sources, GitHub import, one skill and its versions, assistants), and `MemoryResponse` gains `projectSummaries`. Additive, so `info.version` stays 1.3.0.

**§0.8 register, additions (Stage B).**

56. A pinned assistant wears a neutral fill pin (the web's is coral), as a pinned project does.
57. Eyebrows ("Assistants", "Skills") are SF 13 medium captions, not mono labels, and detail pages use the system back button.
58. Counts in ledes and meta lines ("3 skills · 2 on", "{n} assistants", "v4") are SF with tabular digits.
59. Connections has no "Use in chats" switch: the web's is stored in the browser and read by nothing.
60. Assistants has no "Start chat", and a tile opens its editor: the web's `/chat?assistantId=` is read by nothing. The tile's footer shows the preferred model where the web's reads "Start chat".
65. Memory's Activity is a sheet; the web uses a side sheet.
66. New skill is a pushed page, as on the web; the assistant editor stays a sheet, as on the web.
74. A drafted memory change is drawn on neutral fills with a leading + or −, the removed line struck through in the secondary ink; the web tints the lines success and destructive.
75. Import from GitHub wears Phosphor's GitHub mark (`ph.githublogo`); the web draws the brand's filled mark (`GitHubMark`).
76. A skill source's owner tile draws the GitHub mark; the web loads the owner's GitHub picture and falls back to the same mark. No request leaves the app for a decoration.
77. Memory rows sit on hairlines, not inside a card (the brief said a card): the summary is the page's one raised surface, as the web's page says of itself.
78. The memory summary panel is at the panel radius 20, as the web's `rounded-panel`, so the dock inset 8 is concentric with its field radius 12 (the brief said 16).
79. "Learn from Past Chats" carries its unread count as the menu item's subtitle; the web right-aligns the number.
80. A New skill failure is a toast (§2.8); the web draws an inline note under the form.
81. New skill has no Files field, as on the web (the brief listed one). A written skill's Edit keeps the files its version names but cannot add new ones yet (§7).
82. Skill rows set the name at 13 medium and the description at 11 in the secondary ink (the brief's ladder); the web sets them at 15 and 13.
83. Checkboxes (Import memory, Import from GitHub, the update sheet) take the accent on their checked fill, as a switch's on-track does (§0.4 "Toggle on-tracks"); radio choices (a skill's Usage, Move to a project) are drawn in the foreground ink, never the accent.
84. `/` focuses the Skills search while the page holds focus (`onKeyPress`); the web listens on the whole window.
85. Skills' Add ▾ is drawn as the system's prominent button in the accent (`DesktopProminentMenuLabel`), because a `Menu` cannot take `.junoProminent`.

## Phase 4 errata, Stage C (Automations, Permissions, Agents, More; apply over §9 and the Phase 4 brief §5)

Built on `mac/lg-p4c` from `1876f3ac` (Stage A1–A3), in parallel with Stages A4–A7 and B. The live web on `origin/main` (`fe0a501d`) was the parity target; where the brief and the web disagreed the web won, and each case is a register entry below.

- **Automations (C1).** `App/DesktopAutomationsScreen.swift` (the list), `App/DesktopAutomationPage.swift` (`.automation(id)`, `.newAutomation`, the fire card, the history) and `App/DesktopAutomationEditor.swift` (the editor, its draft and the arming card), over the same `NativeWorkAutomationModel`. `DesktopWorkAutomations.swift` is deleted; the legacy Work window shows the new list in a `DesktopPageStack` with a router of its own (so a request meant for the Chat window is never taken there). The list is `.wide`: "Automations", the web's lede, New automation (`.junoProminent`, withheld while loading, failed or empty — the empty state carries it through `JunoEmptyState`'s new `actions:` initializer), Active and Paused with headings only when both exist, rows in one card divided by `--border` at 70%, dealt once on JunoMotion (45ms, capped at 10). A row is the name, "Paused" in words, a Code automation's repository, the triggers in the web's sentences (`describeTrigger`), and a meta line in SF with tabular digits: the next fire (`nextFireSentence`), when it last ran, and what it will email. Run Now, Pause/Resume, Its Task (only when this Mac knows the session's conversation) and Delete… are one definition behind the hover `ph.dotsthree` and the context menu. The page (`.reading`) has the caption "Automations", the paused lede, Run now (`.bordered`, `ph.play` swapping to the spinner) and Delete (destructive outline, the web's confirmation), the editor (re-seeded from the saved row by `updatedAt`), the fire card when the automation has the "Something calls it" trigger, and Recent runs (Work and Code runs interleaved newest first, each opening its conversation when this Mac knows it; "No runs yet" and "Couldn’t read the history" kept apart). New automation (`.reading`) replaces its route with the automation on save (`desktopReplace`, new beside `desktopPush`). The editor is the web's `WorkScheduleEditor` in its order as plain sections on the page — no grouped `Form`, which would scroll inside the page's scroller — with every policy a radio row carrying the web's label and sentence, every trigger kind the web edits editable (the JSON editor is gone), the arming card ("What you are switching on") between the form and Save, and the web's save refusals. A Code automation opens read-only with "Edit this automation on the web".
- **`JunoWorkKit` for automations.** `NativeWorkSchedule` gains `runKind`, `hasFireToken`, `fireTokenIssuedAt`, `codeRepository` (and `isCode`, `isEditableHere`, `withEnabled(_:)`); runs gain `attempt` and `terminalDetail`; `NativeWorkScheduleHistory` / `NativeWorkScheduleCodeRun`, `NativeWorkScheduleChange` (the saved row plus the server's `scheduling` and `runs.explanation` sentences) and `NativeWorkFireToken` are new. `NativeWorkAutomationClient` adds `edit`, `changeEnabled`, `remove` (returning those sentences), `schedule(id:)`, `history(for:)`, `issueFireToken` and `revokeFireToken`; the old methods call through. `NativeWorkAutomationModel` adds the page API (`schedule(id:)`, `loadSchedule`, `loadHistory`/`history`/`historyFailed`, and `…Reporting` mutations returning `NativeWorkAutomationResult` — done with notes, refused with the server's 4xx sentence, or failed). `NativeWorkServerSentence.refusal(_:)` decides which sentences are the server's to show. The web's words live in `NativeWorkScheduleCopy.swift` (triggers, policies, row sentences, status labels, the arming card, ceilings) and `NativeWorkPermissionsCopy`.
- **Permissions (C2).** `App/DesktopPermissionsScreen.swift` (`.permissions`, not in More; `.wide`) in the web's order: "Juno always asks first" (ten opaque tiles in two columns, `ph.shieldcheck` in the warning ink, the verb at 13 medium, the object secondary — the page's signature), "How much it asks otherwise" (three cards, "Default" as a neutral tag, the closing paragraph with "Needs you" as plain text), then "Your Macs" (this Mac first, then the others, then revoked ones; the state in words with the live dot only on an awake Mac; the workload sentence; platform · version · last seen; the web's failed-refresh note over the last answers; Refresh). `DesktopWorkHostRow` is exposed for Track A's Settings › Devices. `App/DesktopHostPage.swift` (`.host(id)`, `.reading`): caption "Permissions", the name, the web's meta line as the lede, Revoke (destructive outline; the web's confirmation with the workload and pending count) or Restore access, the state row and the revoked / unreachable / stale-read notes, then the web's sections — "What this Mac may do" (the master switch and the five capability switches with the not-offered and no-longer-offered sentences), "When Juno stops to ask" (`JunoSegmented`, capped at the Mac's advertised ceiling), "What it has offered" (chips, struck through when switched off), "Folders it can reach", "Apps and sites" (read-only, as the route refuses them). This Mac's page opens with "On this Mac": `DesktopWorkHostTile(layout: .onThisMac)`, the tile's local switches, macOS permission rows, approvals (as neutral radio rows on a page), folder picker and app lists; Settings › Code and the Work window keep the whole tile. Polls every 30s while visible and on becoming active.
- **`JunoWorkKit` for hosts.** `WorkHostSummary` gains the platform, app version, the switches in force, the advertised switches and ceiling (read from the stored manifest `{ toggles, capabilities, approvalPolicy }` as well as the legacy list), the approval ceiling and the three name lists; the new arguments default, so call sites are unchanged. `NativeWorkClient` adds `host(id:)`, `updateHost(id:_:)` (`NativeWorkHostPatch`: switches, ceiling, restore) and `revokeHost(id:)`. `NativeWorkHostsModel` (new, on `JunoDesktopConfiguration.workHostsModel`, stopped on sign-out) keeps the list, a failed refresh over the last answers, details, missing and busy hosts.
- **Agents (C3).** Behind `#if os(macOS)` in the shared views: the roster is a `.wide` `JunoPage` with New agent as `.junoProminent` (shown only when agents exist), cards 1 / 2 / 3 across at 576 / 896 of the page's column (48pt face, name, role, state sentence; equal heights; dealt once), skeleton cards while loading, the error state, and the first-hire state with "start from scratch" as an accent link. `.agent(id)` and `.newAgent(template:)` are the app's routes (`App/DesktopAgentRoutes.swift`: `NativeAgentRoutePage`, `NativeAgentHirePage`), pushed on the Agents stack; the window's `selectedAgentID` follows the stack both ways (`DesktopPageStack.pathChanged`). The agent page has its own header in the template's place (the face, xl while arriving after a hire; the name on the fluid title rung; the role; the state word · the sentence; Message `.junoProminent`, Pause/Resume neutral, More with Think It Over Now, Edit Profile, Retire…), `JunoSegmented` tabs with Now's badge and the Goals and Routines counts, the welcome in the web's words, the missing-agent state with "All agents", and failures and changes as toasts in the web's words. Hire is a pushed `.wide` page: caption "Agents", the web's sections without numbers, SF field labels, page-styled fields, "Hire {name}" `.junoProminent` and Cancel; replacing its route with the new agent's page, welcome on. Every `.bordered` in these views is neutral on the Mac (`nativeAgentNeutralTint()`); the iPhone keeps its layout and tints.
- **More (C4).** `DesktopDestination` gains `.assistants`, `.skills`, `.automations`, `.permissions`; `moreCases` is `[.assistants, .skills, .automations]`, then a divider and "Archived Chats" (`ph.archive`) while the sidebar's `openArchivedChats` hook is set (Track A). Connections, Memory and Permissions left More and stay destinations for the router. Skills and Assistants open a placeholder here until Stage B's pages are merged.
- **Deletions (C5).** `DesktopWorkAutomations.swift` and the dead `DesktopTasksScreen.swift`.
- **Foundations touched.** `JunoPageHeader` gains `caption:` (register #57); `JunoEmptyState` gains `init(title:message:icon:size:tone:actions:)`; `DesktopPageRoute.swift` gains `desktopReplace` and `DesktopPageStack.pathChanged`. All additive; Stages A and B may add the same — keep one copy at integration.

**§0.8 register, additions (Stage C built #57, #66, #67, #68 and #71 as the brief proposed; the new ones are numbered from 74 and are renumbered at integration if Stages A or B took those numbers).**

74. **Permissions order.** The page follows the web: the floor, the modes, then Your Macs (the brief listed Your Macs first). The Mac puts this Mac first in the list, which the web does not.
75. **The host page's lede** is the web's meta line (platform · Juno version · last seen); the workload sentence sits beside the state word under the header, as on the web (the brief made it the lede). The approval section's heading is the web's "When Juno stops to ask" (the brief used the control's accessibility label).
76. **Apps and sites are read-only** on the host page, as on the web: `hostPatchSchema` refuses them, so `updateHost` sends only the switches, the ceiling and restore.
77. **The spend hint** says "your usage limit" where the web names the window ("5-hour" or "weekly") and has a separate sentence for an unmetered account: the Mac reads no spend window yet.
78. **The arming card is the signature.** "What you are switching on" sits in the editor above Save, in plain sentences; the web's "Firing this from elsewhere" card appears only with the API trigger, as on the web.
79. **Unknown trigger kinds** show the web's sentence ("This trigger was set up by a newer version of Juno…") and are saved back untouched; every kind the web edits is editable on the Mac, so nothing says "edited on the web" except a Code automation.
80. **History rows** open their conversation only when this Mac knows the session's conversation; the web resolves `/work/{sessionId}` on the server.
81. **Dots only for live state.** A host carries the dot only while awake; a run's status pill only while running. Every other state is its word in its ink (the web dots every pill).
82. **Hire** drops the web's step numbers, sets field labels in SF, and has no "Preview a state" control on the Mac (the iPhone keeps it).
83. **Retire…** in the agent page's More asks at once, with the web's profile-tab dialog ("Retire {name}?", "Keep It" / "Retire"); the web's menu item switches to the Profile tab.
84. **Automation rows** put Run Now, Pause/Resume and Its Task behind More (and the context menu) instead of the web's hover buttons, and add Delete…, which the web's list does not have.
85. **More's Skills and Assistants** lead to a placeholder page on this branch; Stage B's pages replace it at integration.

---

## Phase 3 errata (the three stage notes, folded at integration 2026-09-25; apply over §5.4, §7 and the Phase 3 brief)

Each stage wrote its decisions, register entries, seams and review into `docs/native/phase3/STAGE-{A,B,C}-NOTES.md`; they are kept here as written, with their headings moved down two levels, and the folder is deleted. Their `P3-n` numbers are provisional: the final numbers are in "Integration register" below. The seams they list are wired (see "Integration, seams wired").

### Phase 3 Stage A: the menu bar, the shortcut registry, the Shortcuts window and the menu recipe

Branch `mac/lg-p3`, built from `1150f081` (the brief) on `250b5b13`. The integration step folds this file into the spec's "Phase 3 errata", the register and the handoff (brief §6), then deletes it.

#### What was built

- **`App/JunoShortcutRegistry.swift`**: one table of every chord the Chat and Code windows answer to. Each `JunoShortcut` has an id, a Title Case `menuTitle`, a sentence-case `listLabel`, a key and modifiers, keycaps, a group, a binding (`.menu(…)`, `.system`, `.field`, `.menuOnly(…)`), a section, a context (`.always`, `.chat`, `.code`) and a glyph. The menu bar and the Keyboard Shortcuts window both read it.
- **`App/DesktopCommands.swift`**: the menu bar is generated from the registry.
  - Every item goes through `DesktopCommandContext`, which resolves its action, title and glyph from the focused values. A nil action disables the item, and a disabled item does not claim its chord.
  - Hand-listed are only the updater's items, the system groups (`SidebarCommands`, `ToolbarCommands`) and Window › Tasks (Legacy), which is verbatim.
  - File: New Chat ⌘N (New Task in Code, New Window with nothing focused) · New Private Chat ⇧⌘N | New Chat ⇧⌘O | Open Folder… ⌘O | Ask Juno… ⌥Space.
  - Edit: the three find items.
  - View: Chat ⌘1 · Code ⌘2 | Command Menu… ⌘K · Search… ⇧⌘F | Switch to Dark/Light Mode ⇧⌘L, then the system's items.
  - Chat: Attach Files… ⌘U · Attach Screenshot… ⇧⌘U | Focus Composer ⇧⎋ · Stop Generating ⌘. · Regenerate ⌘R | Copy Last Response ⇧⌘C · Copy Last Code Block ⇧⌘; | then `DesktopConversationMenu` with "Rename…".
  - Session: Code's items, without the ⌘K row.
  - Help: Juno Help · Keyboard Shortcuts ⌘/ · Roadmap & Feature Requests.
- **`App/ChatCommands.swift`**: the Chat menu's rules, all pure and tested.
  - Copy Last Response: the newest reply with words, through `copyableMarkdown`.
  - Copy Last Code Block: `NativeMessageContent.parts` then `JunoMarkdown.blocks`, skipping a finished Mermaid fence and the web's visual languages, as `markdown.tsx` does.
  - Regenerate's enabling rule, and the artifact count that decides whether it asks first.
  - Stop's precedence.
  - The web's toast words: "Copied the last response." / "No response to copy yet." / "Couldn’t copy.", and "Copied the last code block." / "No code block in this conversation yet." / "Could not copy.". The "nothing" cases are toneless, as the web's `toast.message` is.
  - It also holds the focused-value keys and the `junoChatCommands(_:)` host. The host publishes the actions and shows the reply's own "Regenerate this answer?" dialog when a menu-bar Regenerate would replace artifacts.
- **`App/DesktopShortcutsWindow.swift`**: rewritten to be generated from `JunoShortcutRegistry.groups`.
  - 640 wide, with two columns balanced by the registry (`DesktopShortcutsLayout` picks the split whose taller column is shortest; a group is never split). 24pt margins, 32pt between columns, 32pt rows on `junoBorder` hairlines, and no zebra striping, table chrome or count.
  - Group headings are SF 13 medium in the secondary ink and are marked as headers.
  - Keycaps: one per key, on `junoSecondary` with a hairline, radius 6, 20×20 minimum, `micro` medium in the secondary ink, 4pt apart. Alternatives are joined by "or".
  - VoiceOver reads each row as one element ("Search, Shift Command F").
  - Height comes from the registry. The window opens at full height and scrolls only if a small screen makes it shorter (minimum 320).
- **Wiring (bounded):**
  - `DesktopChatWorkspace`: the `workspaceActions` property, a new `chatCommands` property beside it, and one `.junoChatCommands(chatCommands)` line beside the `.focusedSceneValue` at the top of `body`.
  - `JunoDesktopWorkspaceView`: a `toggleTheme` field on `DesktopShellActions`, a `colorScheme` read, and the `JunoChatKit` import.
  - `ChatComposer`:
    - The stop face's `.keyboardShortcut` is removed.
    - `stopWhatIsRunning()` is the one function behind both the disc and the menu.
    - `.focusedSceneValue(\.junoComposerStop, …)` is published while something can be stopped.
    - `.focus` now also puts the caret at the end.
  - `ComposerPlusMenu`: the ⌘U and ⇧⌘U chords are removed, and New Project… wears `ph.plus`.
  - `DesktopVoice`: the older `DesktopVoiceDock` options menu now follows the recipe. The voice model is an inline `Picker` under "Voice Model", with "Share Screen" / "Stop Sharing Screen" and `.help`.
  - `DesktopConversationMenu`: the rows are data (`rows(pinned:renameTitle:showsOpenProject:)`) with the web's glyphs. It also accepts an optional conversation and actions, for the menu bar's disabled state, so callers are unchanged. Every row is written inside the one `Section`.
- **Icons:**
  - `Keyboard` (`ph.keyboard`) is added at the brief's shared spot, identical to B's edit.
  - `Command` (`ph.command`) is Stage A's own, appended at the end of the generator map and of `JunoIcon`, with comments naming the stage.
- **Gate:** `scripts/check-native-menus.mjs` (rule `menus`) counts `.borderlessButton` and `BorderlessButtonMenuStyle` in Mac-shipped code. It is wired into `native:design:check`, with `native:design:menus` in `package.json`. Its baseline is 21 (22 before A5, less `DesktopVoice`), and every remaining site belongs to another lane (brief §0.11).

#### Decisions and corrections (for the "Phase 3 errata")

1. **Chat or Session, never both.** `CommandsBuilder` supports `if`/`else` from macOS 13, so the Session menu replaces Chat while the focused window shows Code. Chat stands otherwise, including when no window is focused, with its items disabled. The menu bar therefore keeps the same number of menus, and Chat's ⌘. and Code's ⌘. are never both on screen.
2. **Stop Generating stays enabled while the draft has words.** The brief says "enabled only when the face would be Stop". Typing a correction turns the disc to Send, and ⌘. must still stop what is running: the web's Esc stops whatever is in the field, and Code's Session › Stop argued the same. So the item is enabled whenever `ChatCommands.stopTarget` is non-nil: steer mode stops the run, and otherwise the reply stops while one streams. The disc and the menu call the same function.
3. **The composer publishes Stop under its own focused key** (`junoComposerStop`). Only the composer knows what its face would stop, including a task running with nothing streaming. The menu bar merges it into the Chat actions only while the Chat window has published them, so a composer can never answer ⌘. from Code.
4. **Regenerate asks first from the window.** A menu-bar Regenerate of a reply that wrote artifacts shows the reply's own dialog ("Regenerate this answer?", "Regenerate", "Its N artifacts will be replaced."). It is hosted by `junoChatCommands`, because the row that owns the other copy is lazily built and may not exist. The regenerate itself is the row's Try Again: `retryLastMessage(conversationID:modelID: nil, instruction: nil)`.
5. **⌘K opens Search in Chat until B's panel lands** (seam 1: `openCommandMenu = openSearch`). In Code it opens Code's own palette, resolved in `DesktopCommandContext`, so no edit was needed in Code's file.
6. **The Chat menu's conversation items** are the title menu's list without Open Project, as the brief lists them. With no saved chat on screen (a draft, a private chat or a page) the rows stay and are disabled.
7. **AppKit localizes menu chords to the reader's keyboard layout.**
   - On this Mac's French layout the built menu bar draws ⌘1 as ⌘&, ⌘2 as ⌘é, ⌘. as ⌘;, ⌘/ as ⌘: and ⇧⌘; as ⇧⌘). This is `allowsAutomaticKeyEquivalentLocalization`, and it is the physical-key behaviour the web gets from `e.code`.
   - The Shortcuts window lists the US characters, as the web's sheet does.
   - The menu-bar tests prove that no two items share a press in whatever form the layout gives them, rather than pinning US characters.
   - No Spelling and Grammar item exists, so **⇧⌘; stays Copy Last Code Block** and the ⌥⇧⌘C fallback was not needed.
8. **The theme toggle writes an explicit light or dark to the account**, never System, as the web's `toggleTheme` does. The item is named for where it goes ("Switch to Dark Mode" with a moon glyph, "Switch to Light Mode" with a sun). The toggle type is `DesktopShellActions.ThemeToggle`, so it does not take the name `DesktopThemeToggle` that seam 13 reserves for integration.
9. **The Composer group lists both of Stop's keys**: "Stop generating" ⌘. (the Mac's menu item) and the web's own row, "Stop generating · close a menu", with esc (the composer's own Esc, which the Mac has always answered).
10. **Code's rows are one key per row.** Three combined rows would not fit a 280pt column at 13pt: "Previous · next session", "Allow · always allow · decline the focused request" and "Slash commands · /compact folds the context". They became "Previous session", "Next session", "Allow the focused request", "Always allow the focused request", "Decline the focused request" and "Slash commands, like /compact". "Send review comments to Juno" became "Send your review to Juno" for the same reason. Code's ⌘K "Command palette" row went, because ⌘K is Command menu (Everywhere) and in Code it opens that palette.
11. **The escape keycap reads "esc"**, the word on a Mac keyboard. At the 10.5pt `micro` rung the ⎋ glyph reads as a stray circle. The menu bar still draws ⎋ natively.
12. **Glyphs without a web drawing:** Juno Help uses `ph.question` and Roadmap & Feature Requests uses `ph.arrowsquareout`. The web's Roadmap row uses `MapTrifold`, which is Stage B's glyph, so integration may swap it. Command Menu… uses the new `ph.command`, Focus Composer `ph.cursortext`, Stop Generating `ph.stopcircle`, Copy Last Code Block `ph.code`, and Find Next / Find Previous the find bar's `ph.caretdown` / `ph.caretup`.
13. **`MessageActions`**: audited, no change needed. Every action row carries a glyph; the rows without one are information (the model and receipt lines) or the provider list's fallback.

#### Register entries (provisional)

- **P3-19.** Chords are shown in the menu bar and the Shortcuts window only, not inside in-window menus: the `+` menu lost ⌘U and ⇧⌘U, and the stop face lost ⌘.
- **P3-20.** Keyboard Shortcuts is a window with a Code group and the Mac's own keys (⌘1 and ⌘2, ⌃⌘S, ⌥Space, ⇧⌘N, ⇧⌘F, ⌘., ⌘R, ⌘G and ⇧⌘G, ⇧⌘U); the web's is a dialog.
- **P3-21.** The Chat menu adds ⌘R Regenerate and ⌘. Stop Generating; the web stops with Esc and has no regenerate chord.
- **P3-22.** The Shortcuts window's group headings are SF 13 medium, not the web's mono label.
- **P3-25.** The Session menu replaces the Chat menu while Code is showing; the web has no menu bar.
- **P3-26.** The Shortcuts window's escape keycap reads "esc" and every key is its own cap; the web writes "Esc" in a single cap.
- **P3-27.** Code's shortcut rows are one key per row, in shorter words (decision 10).

#### Seams left for the integration step

- **Seam 1:** `DesktopWorkspaceActions.openCommandMenu` is the Chat workspace's `openSearch` today. Wire it to B's `DesktopSearchPanelModel.present(.commands)`.
- **Seam 2:** B's panel hints and the account popover's ⌘/ and ⌘, should read `JunoShortcutRegistry.entry(_:).keys`. The sidebar's Search button keycap (`DesktopChatSidebar.swift`, `DesktopSidebarSearchButton`, outside A's region) still says "⇧⌘F" and should read the registry too, and become ⌘K if the panel takes that row.
- **Seam 13:** the theme toggle is written twice: A's `DesktopShellActions.ThemeToggle` in `JunoDesktopWorkspaceView`, and B's ⌘K row.
- **Chat › Share…** reaches `DesktopConversationActions.share`, which B's `DesktopShareState` replaces.

#### Chords outside the menu bar that remain (owned by other lanes)

`rg -n 'keyboardShortcut\(' native/macOS/JunoDesktop/App` still finds these chords the registry also places. Each is inert while its Chat item is disabled, because every Chat item needs the chat route, so none of them collide.

| Chord | Where | Owner |
|---|---|---|
| ⌘R | `DesktopLibraryScreen:152`, `DesktopConnectionsScreen:113` (Refresh) | Phase 4 |
| ⌘R | `DesktopWorkWorkspace:496` | Phase 5 D (deleted there) |
| ⌘R, ⇧⌘N | `DesktopTasksScreen:529, 498` | dead file |
| ⇧⌘C | `DesktopArtifactsScreen:1193` | Phase 4 |
| ⌘, | `DesktopCodeAccountFooter:177` | Code (Settings is system-drawn) |
| ⇧⎋ | `DesktopCodeWorkspace:1621` | Code (the Chat menu is not in the menu bar while Code shows) |
| ⌘N | `DesktopMenuBarExtra:40` | Phase 5 (the extra's own menu, not the menu bar) |

#### Gates

The targets gate fell from 291 to 284 because the conversation menu's rows now sit inside its `Section`. It was **not** re-baselined; integration re-locks it. The menus baseline is new at 21. Type 0, motion 0, glass 28 and prominent 9 held.

#### 5-Dimension Review (from the snapshots, light and dark)

| Surface | Philosophy | Hierarchy | Craft | Functionality | Originality |
|---|---|---|---|---|---|
| Keyboard Shortcuts window | 8 | 7 | 8 | 8 | 7 |
| Chat menu and row menu (as drawn rows) | 8 | 7 | 8 | 8 | 7 |

The window's three levels are the titlebar name, the group headings (13 medium, secondary ink) and the row labels (13 regular, foreground), with the caps (10.5 mono) as a fourth. The signature detail is the separate, equal-square keycaps.

#### Runtime checks left for a person at the screen

- Every menu item from the keyboard, in Chat and in Code.
- ⌘. in each product: Chat stops the reply or the steered run; Code stops the run.
- ⌘R on a reply with artifacts shows the confirmation.
- ⇧⌘L writes the theme, and every window follows.
- ⌘K in Code opens Code's palette; in Chat it opens Search until B lands.
- ⇧⎋ puts the caret at the end of the draft.
- ⇧⌘C and ⇧⌘; show their toasts.
- The Session and Chat menus swap when switching product.
- The Keyboard Shortcuts window opens at its full height.
- Chat › Archive's Undo (⌘Z) through the key window's undo manager.

### Phase 3 Stage B notes: ⌘K and Search, Share, Outputs, the account popover, Archived Chats, dialogs and sheet fills

Branch `mac/lg-p3b` in `juno-glass-p3b`, from `250b5b13`. The brief is `docs/native/MACOS_PHASE3_OVERLAYS_BRIEF.md` (copied unchanged from `mac/lg-p3` `1150f081`). The integration step (§6 of the brief) folds these notes into the spec's "Phase 3 errata", the register, `MACOS_REDESIGN_HANDOFF.md` and `WEB_TO_NATIVE_DESIGN.md`, then deletes this folder.

#### What was built

##### B0. Clients and the contract

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

##### B1. The ⌘K / Search panel

- `App/DesktopSearchPanelModel.swift` — one `@Observable` per window: mode, query, filters, the two halves' states, the Recent list, the cursor (by row identity, so the server's groups slotting in never move it), `present(_:)`/`dismiss()`, the merge (`resultRows`), notices, status words, and the hit routing table (`DesktopSearchRoute`).
- `App/DesktopCommandCatalog.swift` — the web's command list with its keywords verbatim, the ported `atWordStart` matcher, `DesktopPanelAction` (a value, so routing is testable) and the hooks (`openNotifications`, `openUpgrade`, `openPage(DesktopPanelPage)`, `openTaskRecord`).
- `App/DesktopSearchPanel.swift` — the view and the host overlay (`.desktopSearchPanel(…)` on the split view): glass shell in one `GlassEffectContainer` at radius 20, the field band (18pt magnifier, 17pt field, "esc" cap or the ✕), the filter row, the notices band, the list with its floor, rows, headers, keycaps and states.
- Wiring in `DesktopChatWorkspace.swift`: `openSearch()` now calls `presentSearchPanel(.search)` (the sidebar's Search and ⇧⌘F), which closes Share and Outputs first (crash rule 4). `presentSearchPanel(.commands)` is what seam 1 calls. `performPanelAction` maps each action onto an action the window already had. `ChatDetail` reports the detail column's frame and toolbar depth (`panelAnchorChanged`) so the panel centres on the column, 72pt below the toolbar, `min(640, detail − 32)` wide, height `56 + filters 44 + notices + list` with a 208pt floor and a `min(480, window − 144)` cap.
- Search engine (decision 7): chats, messages, projects, files and artifacts from `NativeSearchStore` over `configuration.localStore`; knowledge, memory and tasks from `/api/search?types=knowledge,memory,work`. Both debounce 180ms and cancel the previous run (a generation counter); the local results draw first. The store's own memory rows are not listed, so a fact never appears twice. Each local group is capped at six rows (the web's `DEFAULT_LIMIT_PER_TYPE`). Local marks are literal, case- and diacritic-insensitive matches of each word of two or more characters.
- Recent: `recents(limit: 8)` online; offline (or on failure) this Mac's chats, Code sessions and projects by recency. The last list stays up while a fresh one loads; a skeleton shows only before the first.
- `DesktopSearchScreen.swift` is no longer routed to (nothing sets `.search`); it and the `.search` branch are the integration's to delete (§6.3).

##### B2. Share

- `App/DesktopSharePopover.swift`: `DesktopShareTarget` (`.chat`, `.artifact`), `DesktopShareService` (live over `NativeShareClient`, stubbable), `DesktopShareState` (moved here from `ChatToolbar.swift`, rewritten as the web's five states: loading, error, blocked, ready, revoked; Copy → "Copied" for 1.5s; Revoke Link → "Revoking…", toasts in the window's host) and `DesktopSharePopover` (360 × 232 in every state).
- Opening makes the link; nothing reaches the pasteboard until Copy (the web's behaviour; the interim Mac popover copied on open). Every Share entry point (toolbar, title menu, row menu, reply's Share Chat…) goes through `shareSelectedConversation()` → `share.start(.chat(id), …)`.
- `DesktopShareResultPopover` and its interim copy ("Creating a link…", "Link copied…", "The conversation couldn’t be published…") are deleted.

##### B3. Outputs

- `App/DesktopOutputsPopover.swift`: `ChatSessionOutputs.read(artifacts:messages:modelName:)`, a line-for-line port of `readSession()`; the toolbar chip (`ph.filetext` + a rolling count, "Outputs — {n} in this chat" / "What this chat used", help "Outputs"); the 336-wide popover with a height computed from its rows (cap 400, scroller inside); tiles as the web's `ArtifactPreview` draws them (first twenty lines of source in the micro rung, clipped and faded; SVG and a design's poster drawn as pictures by AppKit, no web view; generated media as itself); the used rows with openable uploads.
- The chip is a new first `ToolbarItem` in the Share/Private capsule, declared unconditionally, hidden with `.hidden(!isChatRoute || nothing to show)`.
- `DesktopChatOutputRequests` carries "open this artifact's canvas" and "Quick Look this file" from the toolbar (and from ⌘K's artifact hits) down to the conversation column, which owns both; the column consumes a request a turn after its conversation is on screen (`.desktopOutputRequests(…)` in `DesktopConversationView`).

##### B4. The account popover

- Rewritten in `DesktopAccountFooter.swift` (the footer row is unchanged): identity with an SF plan pill on `junoGlassFill`; the usage block (`DesktopAccountUsage`); Settings… (⌘,), Upgrade Plan (only while `openUpgrade` is wired: nil on this base), Admin Panel ↗ (owners); Keyboard Shortcuts (⌘/, opens the Shortcuts window); Sign Out. No Profile…, no Get the apps (P3-15).
- Heights are constants per row set (`DesktopAccountPopoverRows`): base 246, +10 when the usage block carries a sentence, +28 for each of Upgrade and Admin.

##### B5. Archived Chats

- `App/DesktopArchivedChatsSheet.swift`: a fitted system sheet, 480 × 520, no custom ground; the web's title and description; 48pt rows (title over "Archived {date}", Restore `ph.boxarrowup`, Delete `ph.trash`); four skeleton rows; `JunoEmptyState(.panel)` "Nothing archived." and the error tone "Couldn’t load archived chats."; Done (`.bordered`, `.tint(nil)`, `.cancelAction`).
- Restore and Delete hide the row at once; a failure brings it back with the reason under it for six seconds ("Couldn’t restore the chat." / "Delete failed."), never a toast.
- **Data source: the local store**, not `GET /api/conversations?archived=only`. The sync projection carries every conversation with its `archivedAt` and no archive filter (`src/lib/sync-entities.ts`, `conversation`), so chats archived before this Mac first synced are in the store too; `NativeConversationModel.conversations` keeps archived rows (only the sidebar filters them). Restore and delete are the store's own mutations (`setArchived`, `deleteConversation`); success is read back from the store.
- Presented from the workspace (`showingArchivedChats`); nothing on this base opens it until seam 8.

##### B6. Dialogs, rename and sheet fills

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

#### Errata: where today's web was followed

- The Command menu's Chats group lists every non-Code conversation (`kind !== "code"`), as the web does; the sidebar's own filter is `kind == "chat"`. Title matches in Chats, Code sessions and Projects are substring matches (the web's `includes`), not word starts; only the fixed rows use `atWordStart`.
- A Tasks hit whose task has no conversation carries `href: "/chat"` (`chatPathForSession`); the Mac reads its session id from the hit's `work:` id for seam 6, and leaves `work-event:` hits without a conversation out (no session id to open).
- The web's Share opens by creating the link and copies nothing until Copy; the Mac now does the same.
- "Chat restored." (the web's toast) is not posted: a sheet hosts no toasts, and the row leaving is the acknowledgement (P3-18).

#### Register entries (provisional; renumbered at integration)

Used from the brief: P3-10 (semibold marks), P3-11 (date and project as menus), P3-12 (local and server halves), P3-13 (rows left out), P3-14 (New private chat), P3-15 (no Get the apps), P3-16 (Share popover with More…), P3-17 (Quick Look from Outputs), P3-18 (failures under the row in Archived Chats; no "Chat restored." toast).

New:

- **P3-25.** When only the server half of Search fails while this Mac is online, the panel lists what this Mac found and says "{Type}: couldn’t be searched right now." for each server type in scope; the web, with one half, shows its error tile. The error tile is kept for a search where both halves failed.
- **P3-26.** The panel's keycaps are the Mac's chords: New chat ⌘N, Toggle sidebar ⌃⌘S, Settings ⌘,, Switch to Dark/Light Mode ⇧⌘L, Keyboard shortcuts ⌘/ (the web prints ⌘⇧O and ⌘⇧S, and no Settings hint). Seam 2 replaces the literals with registry lookups.
- **P3-27.** Recent's Code rows switch the window to Code (the web's Code sessions are not this Mac's local ones); offline, Recent lists this Mac's own workbench sessions, which open directly.
- **P3-28.** The filter chips at rest have no fill (the brief's recipe inside glass); the web's rest chip sits on `--secondary`.
- **P3-29.** The panel's field shows an "esc" keycap at rest; the web has none.
- **P3-30.** The account popover's usage block reads "This week · {n}% used" until the plan route carries `quota` (seam 9); the web reads "Messages {used} / {limit}".
- **P3-31.** Share's More… sits at the foot of the popover in the ready state, so the fixed 232pt frame reads as a footer rather than a gap under the caption.

#### New Mac-only copy (copy audit)

Every other visible string is the web's, byte for byte (curly apostrophes and quotes kept; the web's own em dash in "Outputs — {n} in this chat" kept as web copy).

- Panel: "New private chat"; "{Type}: not searched while offline." (Knowledge, Memory, Tasks — Appendix A); "{Type}: couldn’t be searched right now." (P3-25); the "esc" keycap; menu rows "Any Time", "Past Week", "Past Month", "Past Year", "All Projects" (Title Case of the web's words); "Untitled Project" (Title Case in the menu only).
- Share: "More…", "Try Again", "Create a New Link", "Revoke Link" (Title Case of the web's words); help "Share the link another way".
- Account: "Settings…", "Upgrade Plan", "Admin Panel", "Keyboard Shortcuts", "Sign Out" (Title Case); "This week", "{n}% used", "Browse only", "Unavailable" (kept from the Mac's footer until seam 9).
- Archived Chats: "Done"; the accessibility hint "Opens the chat"; the skeleton's label "Loading archived chats".
- Outputs: help "Open {file}" on tiles and upload rows.

#### Seams left for the integration (§2.3)

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

#### Deferred (explicit)

- Opening a message hit at its message (`?m=`): the conversation opens; scrolling to the message is not built.
- The panel's Tab into the filter row walks the type chips with ← →; the date and project menus are reached with the pointer (or Full Keyboard Access).
- Seams 1–9 and 13 above.
- Deleting `DesktopSearchScreen.swift` and the `.search` branch (integration, §6.3).
- `junoSheetSurface` survivors on the Mac that are not B's: `DesktopSettingsScreen` ×2 (C), the page files (Phase 4), Code's (the Code session).

#### Runtime checks left for a person at the screen

⌘K (once wired) and ⇧⌘F / the sidebar's Search: focus in the field, Esc, clicking outside, focus returning to the composer; the panel's glass over a live transcript; a live `/api/search` answer landing under local results without moving the cursor; the filter menus; a real share create, Copy, Revoke and Create a New Link; More…'s share sheet; Outputs' tiles opening the canvas and Quick Look; the account popover's Keyboard Shortcuts opening the window; a restore and a delete in Archived Chats against the server (once seam 8 opens it); the delete confirmation's "Delete failed." path.

#### 5-Dimension review (Philosophy · Hierarchy · Craft · Functionality · Originality), from the snapshots

| Surface | Light | Dark | Notes |
|---|---|---|---|
| Panel, Commands | 8 · 8 · 8 · 8 · 7 | 8 · 8 · 8 · 8 · 7 | Floor holds the shape; keycaps as separate caps; one fill for the active row |
| Panel, Search | 8 · 8 · 8 · 8 · 8 | 8 · 8 · 8 · 8 · 8 | Semibold matched words carry the "why"; notices band plain, not rounded |
| Share | 8 · 8 · 8 · 8 · 7 | 8 · 8 · 8 · 8 · 7 | Copy → Copied is the one moving part; one prominent button per state |
| Outputs | 8 · 8 · 7 · 8 · 8 | 8 · 8 · 7 · 8 · 8 | A single output fills the width; excerpts clip like `<pre>` |
| Account popover | 8 · 8 · 8 · 8 · 7 | 8 · 8 · 8 · 8 · 7 | The 18-dot bar is the signature; neutral plan pill |
| Archived Chats | 8 · 8 · 8 · 8 · 7 | 8 · 8 · 8 · 8 · 7 | No prominent button; failures stay with their row |

Fixed before committing (from the first render): matched words drew bold rather than semibold; the notices band took the panel's container shape and rounded its corners; notices repeated the error tile's message; the Share Copy button was shorter than the field; the image tile ignored its 4:3 ratio; code excerpts wrapped and then centred instead of clipping; the account popover's fixed heights left a 30–40pt gap; the archived dates ignored the view's locale.

### Phase 3 Stage C notes: Settings to web parity, Upgrade, text size, theme and accent, onboarding and announcements

Branch `mac/lg-p3c`, from `250b5b13`. Brief: `docs/native/MACOS_PHASE3_OVERLAYS_BRIEF.md` §5. These notes are folded into the spec's "Phase 3 errata", the register, `MACOS_REDESIGN_HANDOFF.md` and `API_GAPS.md` at integration (§6), then deleted.

#### What was built

- **C0, data (additive, iOS unchanged):**
  - `NativeAccountSettings` and `NativeSettingsPatch` gain `name`, `memoryBackgroundLearning`, `memorySensitiveTopics`, `actionApprovalPolicy`, `lockdownMode`, `blockedConnectors`, `monthlySpendCapEur` (`Int??` in the patch, so `null` can be sent) and the read-only `spendCapDisabled`. The sync record decodes them when present; every older payload still decodes.
  - `NativeMemorySettingsModel.saveSettings(_:)` returns `.saved` / `.queued` / `.failed(reason)` for a row's save status. `updateSettings(_:)` still works and now wraps it.
  - `NativeServerSettingsClient` (`GET` / `PATCH /api/settings`) and `refreshServerSettings()`: the model lays the server's answer over the sync record.
  - `NativeUsagePlan` gains `quota {plan, used, limit}` and `spend {spentMicroUsd, reservedMicroUsd, budgetMicroUsd, eurPerUsd, capSource, capDisabled}`; `NativeUsageDay` gains `costMicroUsd`. Both have public `decode(_:)`.
  - New clients: `NativeBillingClient` (checkout, portal), `NativeAnnouncementsClient` (current, dismiss), `NativeAccountSecurityClient` (status, 2FA start/confirm/disable, password, email, sign out everywhere, reset email, avatar upload), `NativeImportClient` (multipart import, the web's refusals). `NativeAccountDataClient` gains the Juno package export (`format=juno`, `.zip`, or `.json` when the server has no storage) and `deleteAllConversations()`. One shared `NativeWebRouteError` carries the server's sentence and blamed field.
  - Contract: the paths above in one commented block before Agents; Swift contract regenerated.
- **C1, the Settings window:** `DesktopSettingsSection` in the web's order with Devices and "Plan & usage" (raw value `billing` kept, `.usage` / `.connections` kept), the web's aliases through `DesktopSettingsSection.resolve(_:)` and `DesktopSettingsRouter.open(named:)`. `NavigationSplitView` with the source list (web `SettingsIcons`) and `.searchable(placement: .sidebar)`; detail is a grouped `Form` with its background hidden over the window's `containerBackground(Color.junoCanvas, for: .window)`. No subtitles. 820 × 600, minimum 680 × 480. The window applies the account theme, `.junoAccentTint()` and `desktopTextScale()`. Rows (`DesktopSettingsRows.swift`): `DesktopSettingRow`, `DesktopSettingToggleRow`, `DesktopSettingsGroupHeader`, `DesktopSaveStatus` and `DesktopSaveStates` (the web's `useSaveStates`: 1.8s Saved, 5s Not saved, newest write wins, announced once). `junoSheetSurface` is gone from every Settings file: sheets are system sheets with an explicit frame and `.presentationSizing(.form)` (`DesktopSettingsSheet`).
- **C2, the panes**, one file each, the web's rows and words.
- **C3, Plan & usage:** plan block, three meters, the spend ceiling, 30 day history. `DesktopUsageScreen.swift` deleted; `DesktopUsageModelIdentity` (used by its tests) moved into `DesktopUsageModel.swift`.
- **C4, Upgrade:** `DesktopUpgradeSheet` + `DesktopPlanCatalog` (Swift copy of `plans.ts`, pinned by a test) + `DesktopUpgradePresenter.shared.present()`, attached to the Chat window (through `.desktopFirstRunSheets(_:)`) and to Settings.
- **C5:** `DesktopTextSize` (`juno.textSize`, the web's ids, scale = px ÷ 16) on the Chat root, Settings and Quick Entry. `JunoAccentSelection` resolves a `#rrggbb` accent (`JunoCustomAccent`, the web's clamp rule); `Color.junoAccent`/`junoAccentInk`/`junoOnAccent` read the resolved colour (three one-line changes in `JunoColors.swift`). The enum's API is unchanged.
- **C6:** `DesktopFirstRunPresenter` (rules pure and tested), `DesktopOnboardingSheet`, `DesktopAnnouncementSheet` with `DesktopAnnouncementLink` routing.

#### Errata (today's web over the spec or brief)

1. **The sync mutation schema is `.strict()`** (`src/lib/sync-mutations.ts`): `settings.update` accepts only theme, accent, defaultModel, customInstructions, responseLanguage, uiLocale, personality, memoryEnabled, voiceId, favoriteModels and the two emails. Every other field goes through `PATCH /api/settings`. This also fixes the Mac's Background processing picker, which had been sending `backgroundProviderMode` through the outbox, where the server refuses it.
2. **The meters turn to the warning ink at 90%**, not 80% as the brief says: the web's `meterTone` is `share >= 1 ? destructive : share >= 0.9 ? warning : primary`.
3. **`spend.userCapEur` is not in `/api/profile/usage`.** The ceiling field reads `monthlySpendCapEur` from `GET /api/settings`.
4. **The Yearly FAQ entry is filtered** when annual plans are not for sale (the web's `annualOnly`), so the Mac's Upgrade shows four questions, not five.
5. **The web's Settings rail labels the Plan section "Plan & usage"**; the Code section stays last on the Mac.

#### Register (provisional numbers; C continues from P3-25)

- P3-1 … P3-9 as the brief's Appendix C (search field, grouped form, Code last, "on this Mac", no interface language, text size scope, graphite ring, monthly-only Upgrade sheet, onboarding theme to the account and no dot field), and P3-23 (Devices starts with this Mac) and P3-24 (Sign Out asks first).
- **P3-25.** Models › On this device shows Fast mode only. The composer keeps no stored default for thinking effort or web search (both are `@State` in `ChatComposer.swift`), so those two rows would change nothing; they return when the composer reads `juno.desktop.composer.*` defaults.
- **P3-26.** A pinned model's Unpin star is drawn in the foreground ink, not the web's coral (accent budget).
- **P3-27.** Import shows "Uploading" with an indeterminate bar: the authenticated sender returns only when the server answers, so there is no byte count to show.
- **P3-28.** A custom accent's accent text is the clamped colour itself; the web keeps the preset's `--primary-ink`.
- **P3-29.** Devices' empty state on the Mac: "No Macs yet" / "Turn on Juno Work for this Mac and it appears here on its own." (the switch is the group above), not "Get the Mac app".
- **P3-31.** Devices › This Mac is the Work switch and a "What this Mac may do" row whose "Choose…" opens the full Juno Work card (`DesktopWorkHostTile`, unchanged) in a sheet. The brief moved the card itself into the pane; drawn there it filled the window, pushed "Your Macs" off screen and put a card inside the form's group. The web's Devices is a list whose rows open a Mac to choose what it may do, which this follows.
- **P3-32.** Each Upgrade card puts its action under the price, above the features; the web puts it at the card's foot. At the sheet's 640pt the foot is below the fold, and the one coral button is the choice the sheet exists for.
- **P3-33.** Account › Notifications is one group, as on the web: "Notifications on this Mac" (the permission, with the push reach as its description), "When something needs you", "Updates", then the two email rows. The brief's separate "Notifications on this Mac" section would have repeated its own title as its first row.
- **P3-34.** An import's result stays in its row, in the web's sentence, as the web shows it; only "Nothing new to import…" is a toast (the web's own toast). The brief asked for the result as a toast.
- **P3-30.** Plan & usage shows its actions whatever the server's `features.billing` says (native clients cannot read it); a server without Stripe answers checkout and the portal with its own "Billing is not configured." sentence, shown inline or as a toast.

#### New Mac-only copy (Appendix A additions)

"Where each new message starts on this Mac. The composer can change any of them." · "Dictation uses this Mac’s own speech recognition." · "This Mac" · "No Macs yet" / "Turn on Juno Work for this Mac and it appears here on its own." · the About group's rows ("Juno for Mac {version}", "Check for Updates…", "Install and Relaunch", "Diagnostics…", "What this Mac has synced, what is queued, and what failed.") · "Juno couldn’t read that file." (an import file this Mac cannot open) · "Couldn’t load these settings" (Memory's sensitive subjects when `GET /api/settings` fails) · "Done" (Upgrade, Diagnostics) · "Choose a JPEG, PNG, WebP or GIF under 5 MB." (the avatar open panel) · "{n} pt" beside the text-size slider · "Allow Juno Work on this Mac" / "Lets tasks you start from your phone, the web or this window run here. Off, this Mac runs nothing sent to it." · "What this Mac may do" / "Files, your browser, screen control, when Juno asks first, and the folders and apps a task may use." / "Choose…" · "Off in System Settings. Allow notifications for Juno there, then come back." · the host states "Awake", "Awake, running {n}", "Idle", "Not answering", "Asleep or offline", "Work is off on this Mac", "Revoked".

#### Seams left (brief §2.3)

- 4 / 12: `DesktopUpgradePresenter.shared.present()` exists; the account popover's and ⌘K's `openUpgrade` and the composer's `openUpgrade` (`DesktopChatWorkspace.swift:1999`, still Settings › Plan & usage) are wired at integration.
- 9: `NativeUsagePlan.quota` (`used`, `limit`) is available for B's `DesktopAccountUsage.init(plan:)`.
- 10: `DesktopSettingsLinks.shared` (`openMemory`, `openConnections`, `openHost`, `openPermissions`) — all nil; their controls are absent.
- 11: `DesktopSettingsHostRow` stands in for Phase 4 C's `DesktopWorkHostRow`.
- 14: "What Juno noticed" stays in Settings › Memory.
- Contract: B may add `get:` under the same `/conversations` key (the `archived` parameter); merge the two operations under one key.

#### Left for other owners

- `DesktopWorkHostTile` (Phase 4 C / Phase 5 D's file) still draws its own card and a mono "Juno Work" eyebrow; in Devices it sits in a group with the form's row fill cleared, so there is no card inside a card, but the eyebrow is theirs to retire.
- `JunoVoiceAura`, `JunoVoiceOrb` and `JunoProviderGlow` read `JunoAccentSelection.shared.current.hsl(dark:)`, which is coral while a custom accent is in force; switching them to the selection's new `hsl(dark:)` is a one-line change each for whoever owns voice.

#### 5-Dimension review (Philosophy, Hierarchy, Craft, Functionality, Originality; from the snapshots, both appearances)

| Surface | P | H | C | F | O | Signature detail |
|---|---|---|---|---|---|---|
| General | 8 | 8 | 8 | 8 | 7 | the accent swatches and the custom well recolour the window while choosing |
| Personalization | 8 | 8 | 8 | 8 | 7 | the instructions well saves on focus loss, with Saved beside its label |
| Memory | 8 | 7 | 8 | 8 | 7 | one switch per sensitive subject, the web's words |
| Models | 8 | 8 | 8 | 7 | 7 | pinned models with their provider marks and a filled star |
| Connectors | 8 | 8 | 8 | 8 | 7 | an app's switch is its whole permission, reading included |
| Devices | 8 | 8 | 8 | 8 | 7 | the live dot only beside a Mac that is awake |
| Voice | 7 | 8 | 8 | 7 | 7 | the circular preview beside the voice |
| Data & privacy | 8 | 8 | 8 | 8 | 7 | Copy Link turning into the check |
| Account | 8 | 8 | 8 | 8 | 7 | the camera over the photo on hover |
| Plan & usage | 8 | 8 | 8 | 8 | 8 | the busiest of thirty days in the accent |
| Upgrade | 8 | 8 | 8 | 8 | 8 | the recommended card's coral button, above the fold |
| Onboarding | 8 | 8 | 8 | 8 | 8 | a swatch recolours Start Chatting at once |
| Announcement | 8 | 8 | 8 | 8 | 7 | the 16:9 visual |

Fixed before commit (each had scored under 7 on its first render): coral pop-up values (tinted by the window's accent; now neutral), the name field's right-aligned text, a beige instructions well, a red-filled destructive button (now the destructive ink on the neutral outline), the Work card filling Devices (P3-31), Upgrade's actions below the fold (P3-32), the announcement visual overflowing its frame, grey meters (now drawn bars in the web's tones), Plan's price sentence wrapping and "Manage Billing" truncating, and a "Notifications on this Mac" heading repeated as its own first row (P3-33).

#### Snapshot harness notes

- Switches and linear progress views are AppKit controls that draw in their inactive-window colours offscreen (a grey "on" track), so the accent on switches is checked at the screen; Plan & usage's meters are drawn bars, so their tones show in the pictures.
- The Settings source list is drawn as a plain column in the pictures (`DesktopSettingsSnapshotRail`): the platform's sidebar list and its search field need the split view's titled window.

#### Runtime checks left (a person at the screen)

Checkout and the portal in the browser; 2FA set-up with a real authenticator; the avatar upload; a real import upload; the first-run sheet on a fresh account; a live announcement with video; the theme, accent (custom colour panel included) and text size switching live in the Chat window, Settings and Quick Entry; the Upgrade sheet over Settings vs the Chat window (`present()` reads the key window); Delete all conversations against the server.

---

## Integration (2026-09-25): every lane merged into `mac/liquid-glass-chat`

Merged in this order, each merge built (app and test target) and committed on its own: `mac/lg-p5c` (Phase 5 C, `d472d263`), `mac/liquid-glass-pages` (Phase 4 A, `8c0b1e62`), `mac/lg-p4b` (Phase 4 B, `be7c6a07`), `mac/lg-p4c` (Phase 4 C, `9af37e25`), `mac/lg-p3` (Phase 3 A, `0384de2d`), `mac/lg-p3b` (Phase 3 B, `bbcfd129`), `mac/lg-p3c` (Phase 3 C, `cef45688`), `fix/download-feed-cancel` (the web's download feed fix, `e9cf2b2e`), then `origin/main` (already contained at `fe0a501d`). Generated files (the Swift contract, the icon catalogues, both Xcode projects) were regenerated after every merge, never hand-merged; the OpenAPI file took both lanes' new paths.

**Where two lanes wrote the same thing differently** (the chat track and the pages track had each merged `origin/main` at `fe0a501d`, so several files met twice):

- **Kept from the chat track:** Phase 5 D's removal of the old Work window (`DesktopWorkWorkspace.swift` stays deleted; Phase 4 C's edit to it is dropped with it, since Automations live on the Chat window's stack), the sidebar's Needs you, Agents heading, status dots and Notifications row, the chat's task follower, `DesktopNavigationState.selection(…openProjectID:selectedAgentID:)`.
- **Kept from the pages track:** Open in Conversation (`followCanvasRequest`), the resolver's `open(artifact:message:)`, the Bell / BellSimple split.
- **One shape for the shared foundations:** `JunoPageHeader(_:caption:lede:)` (the order Phase 4 B and C share; Phase 4 A's project page moved to it) and one `JunoEmptyState(…actions:)` initializer drawn in a row. `NativeAgentHireView` is public (Phase 5 C) with Phase 4 C's page presentation.
- **Phase 3 A's generated menu bar** was taken whole, less what Phase 5 D had already removed (Window › Tasks (Legacy) and the shell actions behind it). One `DesktopKeycap`: the Shortcuts window's replaces the Skills page's copy.
- **Outputs and ⌘K open a canvas** through a message-less `open(artifact:)` that finds the stored row by its own identifier (`ChatArtifactResolver.artifact(identifier:)`, additive), and closes the Task panel as the transcript's open does.

### Integration, seams wired

Phase 3 brief §2.3, rows 1–14, and the Phase 4 brief's §0.4:

| # | Seam | Wired to |
|---|---|---|
| 1 | ⌘K (`openCommandMenu`) | the panel in Commands (`presentSearchPanel(.commands)`) |
| 2 | Panel keycaps | `JunoShortcutRegistry.entry(_:).keys` (`DesktopCommandCatalog.keys`), with a test that every hint is the registry's chord |
| 3 | Open notifications | the sidebar's Notifications popover, whose state the window now holds; the column is shown first when hidden |
| 4 | Plans & upgrade, Upgrade Plan | `DesktopUpgradePresenter.shared.present(in: .chat)`; the ⌘K row always (as the web's), the popover row for Free, Pro and Max |
| 5 | Pages | `DesktopPageRouter`: Skills, Automations, New automation (`.newAutomation`), Assistants, New assistant (the editor, `openNewAssistant()`), Permissions, Designs and New design (Artifacts › Designs, with the size menu), New agent (`.newAgent`) |
| 6 | A task with no chat | the window's `openWorkSession` (its chat, or the task sheet) |
| 7 | Share an artifact | the Artifacts page's Share… opens the Share popover's content in a sheet (there is no toolbar anchor on a page; the web's is a dialog) |
| 8 | Archived Chats | More › Archived Chats |
| 9 | The popover's usage block | "Messages {used} / {limit}" from `/api/profile/usage` `quota`, warning at 80%, destructive at the cap; the week's share when the server sends no `used` |
| 10 | Settings' page links | `DesktopPageLinks` (installed at launch): the router plus the main window forward; a window showing Code switches to Chat when it becomes active with a request pending |
| 11 | Settings › Devices rows | Phase 4 C's `DesktopWorkHostRow` (with "This Mac"); Stage C's interim row is deleted |
| 12 | The composer's quota link | the Upgrade sheet |
| 13 | Switch to Dark / Light Mode | one `DesktopThemeToggle` for the menu bar's ⇧⌘L and the ⌘K row |
| 14 | "What Juno noticed" | **not moved** (deferred): the Memory page's Edits are the server's drafted changes, not the on-device proposals, so the review stays in Settings › Memory |
| 4-§0.4 | The composer's Use a Skill | `+` › Use a Skill ▸ (the skills by name with the description on a second line, the armed one checked, "Manage Skills…"), a typed `/slug …` (the web's rule: only a slug naming one of the reader's skills; a bare `/slug` only arms it), the skill's mark first among the marks, and `skillSlug` on `/api/chat` (`NativeChatGenerationRequest.skillSlug`, carried through retries). Per send, like Research; not in a private chat or a call. |

**Also at integration.** The Search page is retired: `DesktopSearchScreen.swift` is deleted, a stored `.search` destination reads as Chat, and Phase 5 D's Tasks scope lives on as the panel's Tasks group, which adds the account's tasks this Mac has read (every query word in the title or goal) after the server's hits, never one twice, a task without a chat opening its sheet. The View menu lists the Chat window's pages without chords (Library, Projects, Artifacts, Agents; Assistants, Skills, Automations), generated from the registry like every other item. `junoSheetSurface` cannot be made iOS-only yet; its Mac callers are `ChatSkillCaptureSheet` (Phase 5 B), `DesktopTaskRecordSheet` (Phase 5 D), `NativeAgentHireView` and the agent page's form (Agents, shared with the iPhone), and Code's `DesktopCodeWorkspace` (2) and `JunoCodeUI` Studio (3).

**Gates re-locked** (`native:design:baseline`): type 0, motion 0, glass 24 (was 25), targets 217 (was 257), prominent 9, menus 9 (was 21). Every change is a fall; nothing was raised.

### Integration register (final numbers)

The lanes numbered their entries provisionally and in parallel, so several numbers were taken twice. The final numbers are below; the entries' text stays where each lane wrote it (Phase 5 errata, Phase 4 errata A–C, Phase 3 errata), and a comment in code that cites a lane's provisional number means that lane's entry.

| Final | Lane and provisional number | Entry |
|---|---|---|
| #1–#68 | as written (Phases 1, 2, 5 A/B/D) | unchanged |
| #69–#71 | Phase 5 C #69–#71 | unchanged |
| #72 | Phase 4 A #69 | Artifacts opening |
| #73 | Phase 4 A #70 | Design is a type |
| #74 | Phase 4 A #71 | Poster fallback |
| #75 | Phase 4 A #72 + B #56 | Pins: projects and assistants wear a neutral pin |
| #76 | Phase 4 A #73 + B #57 + C (brief #57) | Eyebrows are SF captions; detail pages use the system back button |
| #77 | Phase 4 A #74 + B #58 | Meta lines and counts in SF with tabular digits |
| #78–#90 | Phase 4 A #75–#87 | Library … `?new=design`, in order |
| #91 | Phase 4 B #59 | Connections has no "Use in chats" |
| #92 | Phase 4 B #60 | Assistants has no "Start chat"; a tile opens its editor |
| #93 | Phase 4 B #65 | Memory's Activity is a sheet |
| #94 | Phase 4 B #66 + C (brief #66) | New automation, New skill and New agent are pushed pages; the assistant editor stays a sheet |
| #95 | Phase 4 C (brief #67) | Code automations are listed and run on the Mac, edited on the web |
| #96 | Phase 4 C (brief #68) | This Mac's host page adds "On this Mac" |
| #97–#108 | Phase 4 B #74–#85 | Memory diffs … Skills' Add ▾, in order |
| #109–#119 | Phase 4 C #74–#84 | Permissions order … automation rows, in order (C #85, "More's Skills and Assistants lead to a placeholder", is retired: Stage B's pages are wired) |
| — | Phase 4 C (brief #71) | folded into #83 (headings on the `heading` rung) |
| #120–#143 | Phase 3 brief Appendix C, P3-1–P3-24 | in order |
| #144–#146 | Phase 3 A's P3-25–P3-27 | Session menu in Chat's place; "esc" keycap; Code's rows one key each |
| #147–#153 | Phase 3 B's P3-25–P3-31 | panel partial-failure notice … Share's More… at the foot (B's P3-30 is retired: seam 9 reads the quota) |
| #154–#163 | Phase 3 C's P3-25–P3-34 | Models' Fast mode only … Plan & usage without `features.billing`, in the order the notes list them |
| #164 | Integration | The View menu lists the Chat window's pages, without chords; the web has no menu bar. |
| #165 | Integration | ⌘K's Tasks group adds the account's tasks this Mac has read to the server's hits; the web lists only the server's. |
| #166 | Integration | Skills are offered from the `+` menu's Use a Skill (§5.4) and a typed `/slug`; the web lists them in its `/` palette, which the Mac composer does not have yet. |
| #167 | Integration | An artifact's Share… is a sheet on the Artifacts page (the Share popover's content); the web's is a dialog, the Mac's chat share a toolbar popover. |

### Integration, deferred (explicit)

- **Runtime checks at the screen** (screen control is off): every lane's list stands (Phase 5 A–D, Phase 4 A–C, Phase 3 A–C), plus the integration's own: ⌘K's page rows landing on their pushed pages, "Open notifications" opening the popover from a hidden column, Settings' links bringing the main window forward on the right page (and from a window showing Code), the View menu's pages, Share… on an artifact, a typed `/slug` and Use a Skill reaching `/api/chat` as `skillSlug`, Archived Chats from More.
- **Seam 14** ("What Juno noticed" into the Memory page), above.
- **The composer's `/` and `@` palette** and the quote card (Ask / Modify): Phase 3 brief §7.1; Use a Skill and `/slug` cover skills until then.
- **`junoSheetSurface` iOS-only**, until the Agents and Code sheets move off it.
- **Hand-written dialogs** that carry more than a confirm and a cancel (Reset Memory's Export First, Regenerate's choices) stay system `confirmationDialog`s rather than the shared helper.
- **Owner questions** still open: interface language on the Mac, the Mac-only usage cards, plans and intervals for native Upgrade, "Get the apps" (Phase 3 brief §8); the Phase 4 brief's four (§8).

---

## Phase 6 B: the shell contract (§A4.2, §11 Phase 6 item 1; lane `mac/lg-p6b`)

**What was built.**

- **`contracts/product/juno-shell-v1.json`**, derived from today's web: the plans (the Prisma `Plan` enum in `planRank` order); the products (`PRODUCTS`: label, route, mark, the web's chord, the plan that unlocks it); every destination a sidebar row or More item leads to (label, route, `SidebarMotionIcon` kind, mark); each product's sidebar — its action rows (New chat / New session, Search, Notifications), its destination rows in order, its More (items with the plan that unlocks each, then the archive row), its section headings in order, and its empty-list lines; the composer's `+` menu (the row kinds of `PlusMenuItem`, every row's words, kind, mark and whether it is left out rather than disabled, and the chat and voice composers' groups); the primary action's faces (fill and glyph) and which face each composer state wears; the Settings rail (sections, marks, default, aliases). Every item names its mark as the web writes it (`AppIcons.library`, or a bare `icons.tsx` export such as `Scan`).
- **`tests/shell-contract.test.ts`** (`npm run shell:contract:test`, and in `npm test`): reads `app-sidebar.tsx`, `composer.tsx`, `composer-plus-menu.tsx`, `composer-shell.tsx` and `sidebar-motion-icon.tsx` as TypeScript syntax trees, and `product-switch.tsx`, `settings-sections.ts`, `app-icons.ts`, `icons.tsx` and `plans.ts` as the running modules, and fails on any difference: a row added, dropped, renamed, reordered, regated, moved between products or given another drawing. A mutation pass (28 single edits to the contract) was caught 28 times.
- **`scripts/generate-shell-contract.mjs`** (`npm run shell:contract:generate`; `shell:contract:check` fails on a stale file): validates the contract (every reference resolves; every mark is a `JunoIcon` case, read from `JunoBrand.swift`) and writes `native/macOS/JunoDesktop/App/Generated/JunoShellContract.swift` — `JunoShellPlan`, `JunoShellProduct`, `JunoShellDestination`, `JunoShellMoreItem`, `JunoShellChatSidebar` / `JunoShellCodeSidebar` (`Action`, `destinations`, `More`, `Heading`, `emptyLines`), `JunoShellPlusRow`, `JunoShellPlusMenu`, `JunoShellPrimaryFace`, `JunoShellSettingsSection`. Each carries the web's words and, where a Mac menu shows it, a Title Case `title` derived by Apple's rule (never hand-typed).
- **CI:** `native.yml`'s contract job runs both, on Linux, on every push.

**Where the Mac reads it now.** `App/DesktopShellContract.swift` maps each generated enum onto the Mac's own with exhaustive switches, so a case added on the web stops the Mac compiling until it is given a place. Then: `DesktopProductMode.switchable`, `label`, `icon`; `DesktopDestination.sidebarCases`, `moreCases`, and `label`/`junoIcon` for every web destination; `DesktopSettingsSection.label`, `icon`, `aliases` and the default `resolve` falls back to; `ChatComposerFace.isAccented`; the Chat column's New chat, Search, Notifications, More, Archived Chats, section headings and empty lines; the `+` menu's row titles and marks (the Mac's ellipses stay the Mac's) and its accessible name. `Tests/DesktopShellContractTests.swift` holds the rest: nothing the contract lists for Chat is dropped on the way in, the Settings order is the contract's then Code, and the Mac's additions are exactly the stored and Settings-reached destinations (`chat`, `search`, `design`, `memory`, `permissions`), Settings › Code and the disabled face.

**Decisions.**

- **Generated contract enums, mapped — not the Mac's enums generated whole** (§A4.2 says the contract "generates `DesktopDestination`, `DesktopProductMode`, composer tool cases, Settings sections"). The Mac's enums carry raw values stored in scene and window state and cases the web has no row for (the retired Search page, Design, Memory and Permissions as pages, Settings › Code); generating them would either drop those or put Mac-only cases into a contract derived from the web. The exhaustive mapping gives the same guarantee — a new web case is a compile error — without either.
- **Labels are the web's copy verbatim; the Title Case `title` is computed**, so the Mac's menus follow a rename on the web with no second edit (register #5 stays true by construction).
- **Marks resolve by name**: a registry key is the `JunoIcon` case of the same name (the icon generator's check already proves that case wears the key's drawing); a bare export is its lowerCamelCase name; `nativeIcon` states the two exceptions (Stop wears `.stop`; Busy is the system spinner, `null`).
- **More's plan gate:** the web gates no More item today, so every item's `minPlan` is `FREE`; the test reads a `minPlan` on a More row the day the web adds one, and `JunoShellMoreItem.isUnlocked(for:)` is ready for the Mac's column.

**Drift the contract surfaced (left as it is; nothing here changes behaviour).**

- **During a call the Mac's attach row is "Add Photos…"**; the web's call offers "Add files or photos", or "Add files" where the provider cannot see images (`voice-files`). The Mac's call takes photos only; widening it is a behaviour change for the owner.
- **The primary action's words**: the Mac says "Start a voice chat" / "Send" / "Stop"; the web's accessible names are "Start voice conversation" / "Send message" / "Stop generating" (the Mac keeps those as identifiers) and its tooltips "Voice conversation" / "Send" / "Stop". The contract does not carry these labels yet.
- **Code's column** (`DesktopCodeWorkspace`, another session's) does not read `JunoShellCodeSidebar` yet.

**Deferred (explicit).** The rest of Phase 6: consumption tests for tokens and type, the icon asset↔case Swift test, the chat wire schema, the parity ledger, `design:contract:check` / `design:editor:check` in CI with CODEOWNERS, server-driven composer tools / skills / More via `/api/v1/bootstrap`, paired screenshots. And the three drift items above.
