# iPhone/iPad icon migration: SF Symbols → the website's icons

Owner, Oct 2026: *"remove all the SF icons and use website ones."* Every glyph the
iPhone and iPad apps supply is now a `JunoIcon` — the website's own drawings
(`src/components/ui/juno-icons`, Phosphor at the house weight plus Juno's marks),
generated into symbol sets by `scripts/generate-native-icons.mjs`.

## How to draw an icon

| Where | Use |
| --- | --- |
| A fixed box (rows, buttons, composer, message actions) | `JunoIconView(.case, size: 16…20)` — bold cut ≤13pt, `isOn:` for the solid "on" drawing |
| Sized by the surrounding font (toolbar items, menu rows) | `JunoSymbol(.case)` |
| `Label` in a `Menu`, `contextMenu`, `swipeActions`, `ContentUnavailableView` | `Label(title, image: JunoIcon.case.assetName(.regular))` or `JunoIconLabel(title, icon:)` |

A glyph the web has and the native set lacks is added through the generator,
never hand-drawn. `JunoIcon(systemImage:)` stays only as the lookup for data that
arrives as a symbol name (model capability badges, recent-activity kinds).

## Count

`Image(systemName:)` / `systemName:` / call-site `systemImage:` uses in
`native/iOS` + `native/Packages/JunoNativeKit/Sources`:

| Tree | Uses |
| --- | --- |
| Round-2 base (`49a26fda`) | 46 |
| Parity merge (`2da2342e`) | 43 |
| Mid round 2, after the workspace/settings restyles | 96 (+ the settings lane's own) |
| **Now** | **0** (iOS app, widgets, Live Activities and the shared Kit) |

Enforced by `scripts/check-native-sficons.mjs` (`npm run native:design:sficons`,
part of `npm run native:design:check`): a hard zero for `native/iOS`, with an
allowlist (`ALLOW`) that is empty.

## Allowed exceptions (the system draws the glyph itself)

These never appear in our source as `systemName:`; they are the OS's own chrome:

- the share sheet (`ShareLink`, `UIActivityViewController`) and its activity icons;
- the keyboard, text-selection and dictation UI;
- system alerts, confirmation dialogs and permission prompts;
- the navigation bar's back chevron, `NavigationLink` disclosure chevrons, `Toggle`,
  `Picker` and `Menu` checkmarks, the search field's magnifier and clear button;
- swipe-action and context-menu chrome (the images *inside* them are ours).

## Nearest-glyph choices (no exact web drawing yet)

| Concept | Drawn with |
| --- | --- |
| New chat (web `MessageSquarePlus`) | `.compose` (the web catalog's `compose` alias) |
| Sidebar toggle | `.panelLeft` (web `PanelLeft`) |
| Private chat | `.privateChat` (Juno's ghost), solid when on |
| Voice / send / stop | `.audioLines`, `.arrowUp`, `.stop` (solid) |
| Username, Export data, Advanced | `.edit`, `.share`, `.tools` |
| Mark all read, Routine not found, Import from GitHub | `.circleCheck`, `.circleHelp`, `.download` |
| Spreadsheet / deck / zip / video files | `.grid`, `.artifacts`, `.box`, `.video` |
| Windows PC host | `.monitor` |

## Every SF Symbol name that was replaced

| SF Symbol | Uses removed | JunoIcon | Web drawing |
| --- | --- | --- | --- |
| `archivebox` | 3 | `.archive` | `ph.archive` |
| `arrow.counterclockwise` | 1 | `.rotateCcw` | `ph.arrowcounterclockwise` |
| `arrow.down` | 1 | `.arrowDown` | `ph.arrowdown` |
| `arrow.right` | 1 | `.arrowRight` | `ph.arrowright` |
| `arrow.triangle.branch` | 1 | `.branch` | `ph.gitbranch` |
| `arrow.trianglehead.pull` | 1 | `.pulls` | `ph.gitpullrequest` |
| `arrow.up.right` | 3 | `.external` | `ph.arrowupright` |
| `arrow.uturn.backward` | 3 | `.undo` | `ph.arrowuupleft` |
| `bolt` | 1 | `.work` | `ph.treestructure` |
| `captions.bubble` | 1 | `.message` | `ph.chattext` |
| `captions.bubble.fill` | 1 | `.message` | `ph.chattext` |
| `checkmark` | 10 | `.check` | `ph.check` |
| `checkmark.circle.fill` | 1 | `.circleCheck` | `ph.checkcircle` |
| `checkmark.square.fill` | 1 | `.squareCheck` | `ph.checksquare` |
| `chevron.left.forwardslash.chevron.right` | 2 | `.code` | `juno.code` |
| `chevron.right` | 1 | `.chevronRight` | `ph.caretright` |
| `circle` | 1 | `.circle` | `ph.circle` |
| `circle.dashed` | 1 | `.circleDashed` | `ph.circledashed` |
| `doc.on.doc` | 4 | `.copy` | `ph.copy` |
| `doc.richtext` | 1 | `.file` | `ph.filetext` |
| `doc.text` | 2 | `.file` | `ph.filetext` |
| `ellipsis` | 2 | `.ellipsis` | `ph.dotsthree` |
| `exclamationmark.circle.fill` | 3 | `.error` | `ph.warningcircle` |
| `exclamationmark.shield` | 1 | `.permission` | `ph.shieldwarning` |
| `folder.badge.minus` | 1 | `.projects` | `ph.folder` |
| `gearshape` | 1 | `.settings` | `ph.gearsix` |
| `globe` | 1 | `.web` | `ph.globesimple` |
| `hand.tap` | 2 | `.hand` | `ph.hand` |
| `laptopcomputer` | 1 | `.device` | `ph.laptop` |
| `list.bullet` | 1 | `.list` | `ph.listbullets` |
| `magnifyingglass` | 1 | `.search` | `ph.magnifyingglass` |
| `mic` | 1 | `.mic` | `ph.microphone` |
| `pc` | 1 | `.monitor` | `ph.monitor` |
| `pencil` | 2 | `.pencil` | `ph.pencilsimple` |
| `photo.badge.exclamationmark` | 1 | `.imageOff` | `ph.imagebroken` |
| `pin` | 3 | `.pin` | `ph.pushpin` |
| `pin.slash` | 3 | `.pinOff` | `ph.pushpinslash` |
| `plus` | 2 | `.plus` | `ph.plus` |
| `puzzlepiece.extension` | 1 | `.connections` | `ph.plug` |
| `rectangle.on.rectangle` | 1 | `.copy` | `ph.copy` |
| `rectangle.portrait.and.arrow.right` | 1 | `.logOut` | `ph.signout` |
| `selection.pin.in.out` | 2 | `.textCursor` | `ph.cursortext` |
| `sparkle` | 1 | `.sparkles` | `ph.sparkle` |
| `sparkles` | 1 | `.sparkles` | `ph.sparkle` |
| `square` | 1 | `.square` | `ph.square` |
| `square.and.arrow.down` | 1 | `.download` | `ph.downloadsimple` |
| `square.and.arrow.up` | 1 | `.share` | `ph.sharenetwork` |
| `square.and.pencil` | 2 | `.compose` | `ph.notepencil` |
| `square.on.square` | 1 | `.copy` | `ph.copy` |
| `text.alignleft` | 1 | `.writing` | `ph.textalignleft` |
| `text.quote` | 1 | `.quote` | `ph.quotes` |
| `trash` | 6 | `.trash` | `ph.trash` |
| `waveform` | 4 | `.audioLines` | `ph.waveform` |
| `wifi.slash` | 1 | `.wifiOff` | `ph.wifislash` |
| `windows` | 1 | `.appWindow` | `ph.appwindow` |
| `xmark` | 1 | `.close` | `ph.x` |
| `xmark.octagon.fill` | 1 | `.octagonX` | `ph.prohibit` |

Plus every `symbol: String` parameter that carried an SF name (drawer rows, the
"+" menu rows, composer tokens, the primary button's faces, Code hosts, artifact
and file kinds, research question states, onboarding rows) — each is now typed
`JunoIcon`, so a missing mark is a compile error.
