# Mac icon migration: the website's icons, no SF Symbols

Owner rule (Oct 2026): the Mac app draws the website's icon set everywhere it
supplies an image. The set is `JunoIcon`, generated from
`src/components/ui/juno-icons` by `scripts/generate-native-icons.mjs` and drawn
through `JunoIconView`, `JunoSymbol` or `Image(JunoIcon.x.assetName)` (menus,
`Label(_:image:)`). A glyph the set lacks is added through the generator, never
hand-drawn and never borrowed from SF Symbols.

Gate: `npm run native:design:symbols` (`scripts/check-native-symbols.mjs`, also
part of `npm run native:design:check`). It ratchets: a file that ships to the Mac
may not gain an `Image(systemName:)`, `systemName:` or `systemImage:` use.

## Counts

Drawn SF Symbol uses in code that ships to the Mac (`native/macOS/JunoDesktop/App`,
`native/Packages/*/Sources`, tests excluded, the translation table and data-only
properties excluded):

| | uses |
|---|---|
| Base of this branch (`49a26fda`) | 14 |
| Round 2, before the owner's icon rule (the first native sidebar added 6) | 20 |
| After merging `polish/native-parity` (it brought 15 more) | 21 |
| Now | 6, all in files another lane owns or on the iPhone branch only |

## Migrated (each use and its web equivalent)

| Where | Was (SF) | Now (web) |
|---|---|---|
| Chat sidebar: New chat | `square.and.pencil` | `JunoIcon.newChat` — the web's `new-chat` drawing (`MessageSquarePlus`), added to the generator as `ph.newchat` |
| Chat sidebar: Search | `magnifyingglass` (field) | `JunoIcon.search` (row, `AppIcons.search`) |
| Chat sidebar: Projects, Library, Customize | `folder`, `books.vertical`, `square.grid.2x2` | `JunoIcon.projects` / `.folderOpen` on hover, `.library`, `.settings` (contract icons) |
| Chat sidebar: Code, Orbit, Routines rows | `chevron.left.forwardslash.chevron.right`, `person.2`, `clock` | removed — not rows on the web (Chat \| Code switch; Customize) |
| Sidebar account row chevron | `chevron.up.chevron.down` | `JunoIcon.chevronsUpDown` |
| Toolbar New chat | `square.and.pencil` | `JunoSymbol(.new)` (shown only while the sidebar is hidden, as on the web) |
| Toolbar private chat toggle | `circle.dashed` + `checkmark` | `JunoSymbol(.privateChat)`, `.fill` cut when on |
| Composer primary disc | `waveform`, `arrow.up`, `stop.fill` | `JunoIconView(.audioLines / .arrowUp / .stop)` |
| Code sidebar rows | `square.and.pencil`, `magnifyingglass`, `arrow.triangle.pull`, `square.stack`, `slider.horizontal.3`, `archivebox` | contract icons: `.new`, `.search`, `.pulls`, `.artifacts`, `.settings`, `.archive` |
| Code landing project menu, preview chrome menus | `checkmark` | `Image(JunoIcon.check.assetName)` |
| Code settings problem line | `exclamationmark.triangle` | `JunoIcon.warning` |
| Pull requests empty state | `arrow.trianglehead.pull` | `JunoIcon.pulls` |
| Research question rows (Mac) | `checkmark.circle`, `circle.lefthalf.filled`, `exclamationmark.circle`, `circle.dotted`, `checkmark`, `circle` | `.circleCheck`, `.circleDot`, `.error`, `.circleDashed`, `.check`, `.circle` |
| Parity merge (profile, username, semantic artifacts, billing extras, project folders): 15 uses | `exclamationmark.triangle`, `lightbulb`, `info.circle`, `photo`, `pencil.line`, `text.bubble`, `person.crop.circle`, `folder.badge.plus`, `folder`, `chevron.right`, `tray`, `checkmark` | `.warning`, `.info`, `.info`, `.image`, `.pencil`, `.message`, `.userCircle`, `.folderPlus`, `.projects`, `.chevronRight`, `.box`, `.check` |
| Scroll to latest, everything else already on `JunoIconView` | — | unchanged |

## Remaining (6), and why

| File | Use | Status |
|---|---|---|
| `JunoDesignSystem/LiveUI/JunoLiveUIParts.swift` (3) | `arrow.up.right`, `checkmark.square.fill`/`square` | Owned by the Live UI lane (`polish/live-ui-default`), told to leave alone; web equivalents `.externalLink`, `.squareCheck`/`.square` |
| `JunoDesignSystem/LiveUI/JunoLiveUIView.swift` (2) | `arrow.counterclockwise`, `arrow.up.right`/`checkmark`/`doc.on.doc` | Same lane; `.rotateCcw`, `.externalLink`, `.check`, `.copy` |
| `JunoChatKit/NativeResearchLiveView.swift` (1) | question-row symbol | iPhone branch only (`#else`); the Mac draws the web glyphs above it |

## System-drawn exceptions (allowed, listed in the gate)

- `JunoCodeIntents.swift` — App Shortcuts' `systemImageName`: Shortcuts and
  Spotlight draw it and accept only SF names.
- `JunoBrand.swift` — the SF-name → `JunoIcon` translation table.
- `JunoRecentActivity.systemImage`, `JunoModelCatalog.systemImage` — string
  properties for the iPhone; nothing on the Mac draws them.
- Glyphs the system draws itself: the traffic lights, the split view's sidebar
  toggle, system menu items (Services, Window, the checkmarks AppKit draws for a
  `Picker`/`Toggle` in a menu), the share sheet, `ContentUnavailableView`'s
  layout, the `NSSearchField` magnifier and cancel button.
