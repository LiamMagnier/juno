# Phase 3 Stage A: the menu bar, the shortcut registry, the Shortcuts window and the menu recipe

Branch `mac/lg-p3`, built from `1150f081` (the brief) on `250b5b13`. The integration step folds this file into the spec's "Phase 3 errata", the register and the handoff (brief §6), then deletes it.

## What was built

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

## Decisions and corrections (for the "Phase 3 errata")

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

## Register entries (provisional)

- **P3-19.** Chords are shown in the menu bar and the Shortcuts window only, not inside in-window menus: the `+` menu lost ⌘U and ⇧⌘U, and the stop face lost ⌘.
- **P3-20.** Keyboard Shortcuts is a window with a Code group and the Mac's own keys (⌘1 and ⌘2, ⌃⌘S, ⌥Space, ⇧⌘N, ⇧⌘F, ⌘., ⌘R, ⌘G and ⇧⌘G, ⇧⌘U); the web's is a dialog.
- **P3-21.** The Chat menu adds ⌘R Regenerate and ⌘. Stop Generating; the web stops with Esc and has no regenerate chord.
- **P3-22.** The Shortcuts window's group headings are SF 13 medium, not the web's mono label.
- **P3-25.** The Session menu replaces the Chat menu while Code is showing; the web has no menu bar.
- **P3-26.** The Shortcuts window's escape keycap reads "esc" and every key is its own cap; the web writes "Esc" in a single cap.
- **P3-27.** Code's shortcut rows are one key per row, in shorter words (decision 10).

## Seams left for the integration step

- **Seam 1:** `DesktopWorkspaceActions.openCommandMenu` is the Chat workspace's `openSearch` today. Wire it to B's `DesktopSearchPanelModel.present(.commands)`.
- **Seam 2:** B's panel hints and the account popover's ⌘/ and ⌘, should read `JunoShortcutRegistry.entry(_:).keys`. The sidebar's Search button keycap (`DesktopChatSidebar.swift`, `DesktopSidebarSearchButton`, outside A's region) still says "⇧⌘F" and should read the registry too, and become ⌘K if the panel takes that row.
- **Seam 13:** the theme toggle is written twice: A's `DesktopShellActions.ThemeToggle` in `JunoDesktopWorkspaceView`, and B's ⌘K row.
- **Chat › Share…** reaches `DesktopConversationActions.share`, which B's `DesktopShareState` replaces.

## Chords outside the menu bar that remain (owned by other lanes)

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

## Gates

The targets gate fell from 291 to 284 because the conversation menu's rows now sit inside its `Section`. It was **not** re-baselined; integration re-locks it. The menus baseline is new at 21. Type 0, motion 0, glass 28 and prominent 9 held.

## 5-Dimension Review (from the snapshots, light and dark)

| Surface | Philosophy | Hierarchy | Craft | Functionality | Originality |
|---|---|---|---|---|---|
| Keyboard Shortcuts window | 8 | 7 | 8 | 8 | 7 |
| Chat menu and row menu (as drawn rows) | 8 | 7 | 8 | 8 | 7 |

The window's three levels are the titlebar name, the group headings (13 medium, secondary ink) and the row labels (13 regular, foreground), with the caps (10.5 mono) as a fourth. The signature detail is the separate, equal-square keycaps.

## Runtime checks left for a person at the screen

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
