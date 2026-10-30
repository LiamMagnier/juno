# Identity v2 · ICONS (family v4)

Appendix to `docs/design/IDENTITY_V2.md` §8. The owner, 30 Oct 2026: "The icons are too bold and they don't
look good, please rework ALL the icons." Today's renderer (`iconStrokePx` in
`src/components/ui/juno-icons/index.tsx`) draws 1.25 px below 14, 1.5 px from 14 and **2 px from 18**,
so most glyphs out-weigh the 13.5 px labels beside them. v4 redraws the whole family lighter, in one
construction that belongs to the Sculpted identity. Every glyph is drawn from numbers in
`src/components/ui/juno-icons/` (no tracing; no shape taken from Lucide, Phosphor, SF Symbols, Material,
ChatGPT or Claude; conventions everyone shares, such as a magnifier for search, are concepts, not drawings).

## 1. Construction rules

| Rule | Value | Source |
|---|---|---|
| Grid | 24 units; live area 3–21; key stems on a 0.25-unit lattice | d3 |
| Keylines | circle Ø 18, square 16.8 × 16.8, portrait 13.5 × 18, landscape 18 × 15 (d3's keylines enlarged about 6 %, d1's "slightly larger keyline that keeps presence at a lighter weight", J-ux graft); circles about 1 unit larger than squares; arrows and chevrons reach the live-area edge | d1, d3 |
| Line at DPR ≥ 2 | **12–15 px: 1 px · 16–23 px: 1.25 px · 24–31 px: 1.5 px · 32 px and up: 1.75 px** | d3 table, d1 12–14 rule |
| Line at DPR < 2 (1x screens) | **12–23 px: 1 px, pixel-snapped to full-coverage device pixels** (a 1.25 px line only blurs at 1x); 24 px and up unchanged. If the W2 check on a real 1x display finds the snapped 1 px line faint in dark, dark at DPR < 2 uses 1.25 px (the UX judge's fallback for d2). This is the one stated exemption from the stem ratio rule (§1.1) | d1 (`devicePixelRatio`, already read by the renderer's `subscribeDpr`) |
| Dark mode | −0.1 px at every rung on the web (irradiation), never below 1 px; native unchanged | d3; web-only (J-platform) |
| Terminals | **flat-cut (butt caps)** | d1 (owned trait, J-owner, J-ux); they echo the arch's flat feet |
| Joins | round | all |
| Points | filled circles r 1.15–1.5 (more, bullets, the gauge hub, eyes) | d3 |
| Containers | continuous-corner squircles (corner starts 1.32 r from the vertex, handles 0.3 r; radius 22–25 % of the shorter side, 3.4–3.6 units on 14.5–16-unit containers) | d3; the same curvature family as the UI's corners |
| The house gap | where a part passes in front of another, the back part stops 1.5 units plus its stroke short (copy's back sheet, the pencil's cap, the faders' knobs); implemented as an open path or one mask knockout, never by overlapping strokes | d3, d1's 2-unit clearance at the Black master |
| On = filled | the "on" drawing is the filled silhouette with detail knocked out in the surface colour; never a thicker line, never a colour change. Used for the selected sidebar destination and for toggles that are on (pinned, notifications on) | d3, d1 |
| Small cut | below 18 px a drawing may swap layers for its `small` cut (fewer gear teeth, shorter pen); the silhouette never changes | V3 mechanism, kept |
| Hover articulation | **removed** (`hover`, `hoverSwap`, the `jp` classes, `data-jicon-articulate`, `IconMotion`): controls move, drawings do not. The press dip stays on the send disc only | d2, d3 |
| Colour | rest `--ink-2` (6.48–8.10:1 light, 8.47–12.30:1 dark on the grounds; TOKENS §1.3); `--ink` with its row on hover, focus and selection; status glyphs take their status ink; bronze and signal only through the live and needs-you primitives | all |

### 1.1 The stem ratio rule (d2's method, written as the rule)

The icon line divided by the stem of the text it sits beside must stay between **0.85 and 1.05** at every
pairing **at DPR ≥ 2**. At DPR < 2 the 1 px snapped line beside 13.5 px Inter (stem ≈ 1.27 px) gives
1 / 1.27 = **0.79**, accepted because a crisp 1 px line reads heavier than its width on a 1x panel; the W2
real-1x check (§4 step 3) records whether 0.79 looks light beside the label, and the 1.25 px dark fallback
above is the remedy if it does. Inter's stem (the `l`) is 0.088 em at `wght` 400, `opsz` 14 (measured by d2 from the shipped
variable font); at 450 it is about 0.094 em (interpolated, unverified to the hundredth).

| Pairing | Glyph | Line (2x) | Text | Text stem | Ratio |
|---|---|---|---|---|---|
| Menu rows, sidebar rows, list rows, buttons | 16 | 1.25 px | `ui` 13.5 px at 450 | ≈ 1.27 px | 0.98 |
| Token, inline meta | 12 | 1 px | `caption` 12 px at 450 | ≈ 1.13 px | 0.89 |
| Phone rows, empty-state tiles | 20 | 1.25 px | 16–17 px at 400 | 1.41–1.50 px | 0.83–0.89 (accepted: 20 px glyphs sit beside larger text on touch) |
| Phone bars, native toolbars | 24 | 1.5 px | 17 px at 400 | 1.50 px | 1.00 |

Glyph-to-label gap: 10 in rows, 8 in buttons, 6 in tokens. Glyph sizes in use: 12, 16, 20, 24 (+ 32/40
tiles); the 14 px glyph class (`size-3.5`, 309 uses) and 18 px (22 uses) are retired by lint
(`design-system/glyph-size`, allowed 12, 16, 20, 24, 32, 40).

## 2. Metaphor fixes (decided)

| Glyph | Today (V3) | d3 | v4 | Why |
|---|---|---|---|---|
| Projects (`app-icons.ts` `projects`, today `Folder`) | folder | a tray under a lid ("reads as a drawer", J-owner) | **a portfolio**: a case with a handle and a gapped seam (d2's idea, v4 construction); new drawing id `projects`, new export `JunoProjects` | distinct from Folder (files) and Library (books); "a body of work" |
| Code | `</>` | `< >` (reads as expand/collapse, J-owner) | **`</>` kept**, redrawn: two flat-cut chevrons and a slash leaning 15° | the slash is what says "code"; `›_` stays the Terminal glyph |
| Orbit | two open arcs of one ellipse | a squircle face with two eyes | **d3's face** (the agents' own body language; the on form fills the face and knocks out the eyes) | ties the destination to the flat face rig |
| Auto (model) | dial | gauge (open arc, needle, hub) | **d3's gauge** | never a ring: a ring reads as the brand, a radio button or a loader (J-ux, J-platform) |
| New chat | pen on a page | open squircle page with a pen line leaving the corner | d3 | no plus, no pencil cliché |
| Library | spines | two spines and a leaning third | d3 | |
| Stop | filled square | filled squircle | d3, **filled** in the send disc (J-ux) | |
| Research (`app-icons.ts:183` `research`, today `Telescope`) | telescope | (not drawn) | **a telescope, redrawn in v4**: a tube on a short tripod, flat-cut ends; drawing id `research`, used by the sidebar destination, the Research page header and Deep research everywhere (the `+` menu, the token) | Search is a magnifier four rows above it in the sidebar (`shots/margin-1440-light.png`); two magnifiers there would be indistinguishable at 16 px |
| Talk (voice conversation) | waveform in a disc | — | **five flat-cut bars of the voice level, no container** (`wave`), beside the word "Talk" | the word carries the action; the glyph never sits alone on a filled disc (COMPONENTS §10) |

## 3. Native projection (`scripts/generate-native-icons.mjs`)

- **Variable symbol templates** with three masters at the Small scale: **Ultralight-S, Regular-S,
  Black-S** (the system derives Medium and Large and every weight between; d2, J-platform). Masters are the
  24-unit drawing stroked at 0.6×, 1× and 2.2× of the 24 px line, outlined.
- **Identical point structure across masters**: one closed contour per stroke primitive, fixed start point
  and direction, fixed number of on-curve points; no boolean union of strokes (unions change topology
  between weights); the house gap must still clear at the Black line width (2 units at Black). The
  builder fails if any master differs in contour count or point count.
- **Outlining in Node** (no Mac needed), with **a purpose-built offsetter, not a general stroke library**:
  general expanders (Skia's `Path.stroke`, `paperjs-offset`) subdivide curves adaptively by stroke width,
  so the 0.6×, 1× and 2.2× masters would not reliably share point counts, which variable SF Symbols
  require. `scripts/lib/stroke-outline.mjs` (W2, no new dependency) offsets each stroke primitive with a
  **fixed number of segments that depends on the drawing, never on the width**: each line segment → two
  offset lines; each cubic → 8 offset cubics per side (split at fixed t = k/8, offset by the normal at each
  split, refit); butt caps (flat-cut terminals) → one line each; round joins → a fixed 4-segment arc; one
  closed contour per primitive with a fixed start point and direction. `tests/stroke-outline.test.ts`
  proves identical contour and point counts for every drawing at the three widths (205 drawings × 3). If a
  library is ever used instead, `package.json` and `package-lock.json` become a † contracted edit in W2.
  The Swift outliner (`--outline-juno`, `scripts/outline-glyph-strokes.swift`, which needs a Mac,
  `generate-native-icons.mjs:507`) is retired. Each output keeps the hash of its source drawing, so
  `npm run native:icons:check` (CI, Linux) fails when a drawing changes without regenerating.
- **Optical size natively**: the symbol's stroke scales with point size, so 24 pt bar glyphs use
  `.fontWeight(.light)` to match the web's 1.5 px; rows at 16–17 pt use `.regular`. Bold Text then works
  (the static Regular-M master today cannot).
- **RTL**: directional glyphs (the RTL column in §5) are flagged in the template's localisation so they
  mirror.
- **On forms** become `.fill` variants (`alevr.pin.fill`); names `alevr.<drawing-id>`.
- **Use**: `Image("alevr.search")` and `Label("Search", image: "alevr.search")` everywhere Alevr draws;
  `JunoSymbol`'s `.imageScale(.medium)` pin and `JunoGlyphBox`'s per-size bitmap cache go (kept only for
  the brand mark and faces).
- **SF Symbols stay only inside system-drawn chrome** (menu checkmarks and submenu chevrons, the search
  field magnifier, share sheet, window controls, `Toggle`/`Picker` indicators). `check-native-sficons.mjs`
  keeps its zero for Alevr-drawn views with an allow-list for those system contexts.
- **Validation**: templates opened in the SF Symbols app on a Mac before commit (manual, unverified until
  done); W2 records the result in its wave notes.

## 4. Verification method (each batch of glyphs)

1. Render "before" with the product's own renderer (`src/components/ui/juno-icons`, bundled with esbuild
   and React's server renderer; the entry is committed at `tools/vendor/icons-v3-entry.tsx` with its build
   command), "after" with the new drawings, at 12, 16, 20 and
   24 px, at DPR 1 and 2, light and dark: `before-after-{light,dark}@{1x,2x}.png`.
2. Render in context at real size: sidebar rows, the `+` menu with a submenu, a row menu, the composer, the
   message action row and a toolbar (`context-{light,dark}@{1x,2x}.png`).
3. Check on a real 1x display in both themes (unverified until done; J-platform asked for a 1x Windows
   display) and record the result.
4. Gate: `tests/icons-v4.test.ts` asserts every export in `icons.tsx` resolves to a v4 drawing (no V3
   drawing left after W2), `iconStrokePx(size, dpr, theme)` returns the table in §1, and every RTL-flagged
   drawing has `directional: true`.

## 5. All export names (stable) and their status

Generated on 30 Oct 2026 from `src/components/ui/icons.tsx` (every `export const X = glyph("id")` and the
two aliases). **Names never change**; each export points at a drawing. Status: **re-cut from d3** = d3 drew
this drawing at 16/20/24 (committed at `tools/vendor/d3-icons/`, light variants at 16, 20 and 24; dark is the same geometry), W2 re-cuts its terminals flat and fits it to v4;
**to draw** = new v4 drawing needed. "On form" marks drawings that need a filled variant. Additional
drawings not referenced by an export but used by name elsewhere (d3 drew them): `auto`, `skill`, `apps`,
`filter`, and the new `projects` (export `JunoProjects`).

| # | Export name (stable) | Drawing id | Status | RTL mirror | On form | Note |
|---|---|---|---|---|---|---|
| | **Alevr's places** | | | | | |
| 1 | `JunoChat` | `chat` | to draw |  |  |  |
| 2 | `JunoCode` | `code` | re-cut from d3 |  |  | redraw: keep the slash between the brackets (d3 "< >" read as expand) |
| 3 | `JunoDesign` | `design` | to draw |  |  |  |
| 4 | `JunoLibrary` | `library` | re-cut from d3 |  |  |  |
| 5 | `JunoAgents` | `crew` | to draw |  |  |  |
| 6 | `JunoOrbit` | `orbit` | re-cut from d3 |  | yes | from d3 (face squircle, two eyes) |
| 7 | `CallMic` | `mic` | re-cut from d3 |  | yes |  |
| 8 | `CallMicOff` | `mic-off` | to draw |  |  |  |
| 9 | `CallSettings` | `customize` | re-cut from d3 |  |  |  |
| 10 | `CallStop` | `stop` | re-cut from d3 |  |  |  |
| 11 | `CallEnd` | `end-call` | to draw |  |  |  |
| | **Direction and navigation** | | | | | |
| 12 | `ChevronDown` | `chevron-down` | re-cut from d3 |  |  |  |
| 13 | `ChevronUp` | `chevron-up` | to draw |  |  |  |
| 14 | `ChevronLeft` | `chevron-left` | re-cut from d3 | yes |  |  |
| 15 | `ChevronRight` | `chevron-right` | re-cut from d3 | yes |  |  |
| 16 | `ChevronsUpDown` | `chevrons-up-down` | re-cut from d3 |  |  |  |
| 17 | `ArrowLeft` | `arrow-left` | to draw | yes |  |  |
| 18 | `ArrowRight` | `arrow-right` | to draw | yes |  |  |
| 19 | `ArrowUp` | `arrow-up` | re-cut from d3 |  |  |  |
| 20 | `ArrowDown` | `arrow-down` | to draw |  |  |  |
| 21 | `AtSign` | `at` | to draw |  |  |  |
| 22 | `CornerDownLeft` | `enter` | to draw | yes |  |  |
| 23 | `ArrowUpRight` | `arrow-up-right` | to draw | yes |  |  |
| 24 | `ArrowUpToLine` | `arrow-up-line` | to draw |  |  |  |
| 25 | `ArrowDownToLine` | `arrow-down-line` | to draw |  |  |  |
| 26 | `CornerDownRight` | `corner-down-right` | to draw | yes |  |  |
| 27 | `ExternalLink` | `external` | re-cut from d3 | yes |  |  |
| 28 | `LogOut` | `sign-out` | to draw | yes |  |  |
| 29 | `Undo2` | `undo` | to draw | yes |  |  |
| 30 | `Redo2` | `redo` | to draw | yes |  |  |
| 31 | `RefreshCw` | `refresh` | to draw | yes |  |  |
| 32 | `RotateCcw` | `retry` | re-cut from d3 | yes |  |  |
| 33 | `Repeat` | `repeat` | to draw |  |  |  |
| 34 | `History` | `history` | to draw | yes |  |  |
| 35 | `Maximize2` | `expand` | to draw |  |  |  |
| 36 | `Minimize2` | `collapse` | to draw |  |  |  |
| 37 | `UnfoldVertical` | `unfold` | to draw |  |  |  |
| 38 | `FoldVertical` | `fold` | to draw |  |  |  |
| 39 | `WrapText` | `enter` | to draw | yes |  |  |
| 40 | `Menu` | `menu` | re-cut from d3 |  |  |  |
| 41 | `MoreHorizontal` | `more` | re-cut from d3 |  |  |  |
| 42 | `GripVertical` | `grip` | to draw |  |  |  |
| 43 | `PanelLeft` | `sidebar` | re-cut from d3 | yes | yes |  |
| 44 | `PanelLeftOpen` | `sidebar` | re-cut from d3 | yes | yes |  |
| 45 | `PanelLeftClose` | `sidebar` | re-cut from d3 | yes | yes |  |
| 46 | `SidebarOpen` | `sidebar` | re-cut from d3 | yes | yes |  |
| 47 | `SidebarClose` | `sidebar` | re-cut from d3 | yes | yes |  |
| 48 | `PanelRightOpen` | `panel-right` | to draw | yes |  |  |
| 49 | `PanelRightClose` | `panel-right` | to draw | yes |  |  |
| 50 | `PanelRight` | `(alias of PanelRightOpen)` | follows target |  |  |  |
| | **Actions** | | | | | |
| 51 | `Plus` | `plus` | re-cut from d3 |  |  |  |
| 52 | `Minus` | `minus` | to draw |  |  |  |
| 53 | `X` | `close` | re-cut from d3 |  |  |  |
| 54 | `Check` | `check` | re-cut from d3 |  |  |  |
| 55 | `Copy` | `copy` | re-cut from d3 |  |  |  |
| 56 | `Trash2` | `trash` | re-cut from d3 |  |  |  |
| 57 | `Archive` | `archive` | re-cut from d3 |  |  |  |
| 58 | `ArchiveRestore` | `unarchive` | to draw |  |  |  |
| 59 | `Download` | `download` | to draw |  |  |  |
| 60 | `Upload` | `upload` | to draw |  |  |  |
| 61 | `UploadCloud` | `cloud-upload` | to draw |  |  |  |
| 62 | `FileUp` | `file-upload` | to draw |  |  |  |
| 63 | `Save` | `save` | to draw |  |  |  |
| 64 | `Send` | `send` | to draw |  |  |  |
| 65 | `Share2` | `share` | re-cut from d3 |  |  |  |
| 66 | `Printer` | `printer` | to draw |  |  |  |
| 67 | `Search` | `search` | re-cut from d3 |  |  |  |
| 68 | `SearchX` | `search` | re-cut from d3 |  |  |  |
| 69 | `TextSearch` | `text-search` | to draw |  |  | a magnifier over text lines (search inside a document); not the Research glyph |
| 70 | `FileSearch` | `file-search` | to draw |  |  | a magnifier over a page; not the Research glyph |
| 71 | `Pencil` | `edit` | re-cut from d3 |  |  |  |
| 72 | `Edit3` | `edit` | re-cut from d3 |  |  |  |
| 73 | `SquarePen` | `edit` | re-cut from d3 |  |  |  |
| 74 | `NotebookPen` | `memory` | to draw |  |  |  |
| 75 | `PenTool` | `design` | to draw |  |  |  |
| 76 | `Eraser` | `eraser` | to draw |  |  |  |
| 77 | `Pin` | `pin` | re-cut from d3 |  | yes |  |
| 78 | `PinOff` | `unpin` | to draw |  |  |  |
| 79 | `Star` | `star` | to draw |  | yes |  |
| 80 | `BookmarkPlus` | `bookmark` | to draw |  | yes |  |
| 81 | `ThumbsUp` | `thumbs-up` | to draw |  | yes |  |
| 82 | `ThumbsDown` | `thumbs-down` | to draw |  | yes |  |
| 83 | `Link2` | `link` | re-cut from d3 |  |  |  |
| 84 | `Link2Off` | `link-off` | to draw |  |  |  |
| 85 | `Crop` | `crop` | to draw |  |  |  |
| 86 | `Scan` | `screenshot` | to draw |  |  |  |
| 87 | `ListPlus` | `list-plus` | to draw | yes |  |  |
| 88 | `ListMinus` | `list-minus` | to draw | yes |  |  |
| 89 | `ArrowUpCircle` | `upgrade` | to draw |  |  |  |
| | **Media and voice** | | | | | |
| 90 | `Play` | `play` | to draw |  |  |  |
| 91 | `PlayCircle` | `run` | to draw |  |  |  |
| 92 | `Pause` | `pause` | to draw |  |  |  |
| 93 | `PauseCircle` | `pause-circle` | to draw |  |  |  |
| 94 | `StopCircle` | `stop-circle` | to draw |  |  |  |
| 95 | `Square` | `square` | to draw |  | yes |  |
| 96 | `SkipBack` | `skip-back` | to draw |  |  |  |
| 97 | `Mic` | `mic` | re-cut from d3 |  | yes |  |
| 98 | `MicOff` | `mic-off` | to draw |  |  |  |
| 99 | `AudioLines` | `voice` | re-cut from d3 |  |  |  |
| 100 | `Volume2` | `read-aloud` | to draw |  |  |  |
| 101 | `PhoneOff` | `end-call` | to draw |  |  |  |
| 102 | `Radio` | `broadcast` | to draw |  |  |  |
| 103 | `Video` | `video` | to draw |  |  |  |
| 104 | `Film` | `film` | to draw |  |  |  |
| 105 | `Camera` | `camera` | to draw |  |  |  |
| 106 | `Music2` | `music` | to draw |  |  |  |
| 107 | `Image` | `image` | re-cut from d3 |  |  |  |
| 108 | `ImageIcon` | `(alias of Image)` | follows target |  |  |  |
| 109 | `ImagePlus` | `image-plus` | to draw |  |  |  |
| 110 | `ImageOff` | `image-off` | to draw |  |  |  |
| 111 | `MonitorUp` | `screen-share` | to draw |  |  |  |
| 112 | `MonitorX` | `screen-off` | to draw |  |  |  |
| | **Objects and places** | | | | | |
| 113 | `MessageCircle` | `chat` | to draw |  |  |  |
| 114 | `MessageCircleQuestion` | `chat-question` | to draw |  |  |  |
| 115 | `MessageSquare` | `chat` | to draw |  |  |  |
| 116 | `MessageSquareText` | `chat` | to draw |  |  |  |
| 117 | `MessageSquarePlus` | `new-chat` | re-cut from d3 |  |  |  |
| 118 | `MessagesSquare` | `chats` | to draw |  |  |  |
| 119 | `TextQuote` | `citation` | to draw | yes |  |  |
| 120 | `Folder` | `folder` | re-cut from d3 |  | yes |  |
| 121 | `FolderClosed` | `folder` | re-cut from d3 |  | yes |  |
| 122 | `FolderOpen` | `folder-open` | to draw |  |  |  |
| 123 | `FolderCode` | `folder-code` | to draw |  |  |  |
| 124 | `FolderInput` | `folder-move` | to draw | yes |  |  |
| 125 | `FolderLock` | `folder-lock` | to draw |  |  |  |
| 126 | `FolderKanban` | `grid` | re-cut from d3 |  |  |  |
| 127 | `FileText` | `document` | re-cut from d3 |  |  |  |
| 128 | `FilePlus` | `file-plus` | to draw |  |  |  |
| 129 | `Calculator` | `calculator` | to draw |  |  |  |
| 130 | `FileCode` | `file-code` | to draw |  |  |  |
| 131 | `FileCode2` | `file-code` | to draw |  |  |  |
| 132 | `FileSpreadsheet` | `sheet` | to draw |  |  |  |
| 133 | `Paperclip` | `attach` | re-cut from d3 |  |  |  |
| 134 | `Inbox` | `inbox` | to draw |  |  |  |
| 135 | `Bell` | `bell` | re-cut from d3 |  | yes |  |
| 136 | `Mail` | `mail` | to draw |  |  |  |
| 137 | `MailWarning` | `mail` | to draw |  |  |  |
| 138 | `BookOpen` | `sources` | to draw |  |  |  |
| 139 | `ScrollText` | `instructions` | to draw |  |  |  |
| 140 | `ReceiptText` | `receipt` | to draw |  |  |  |
| 141 | `Layers` | `layers` | to draw |  |  |  |
| 142 | `Layers3` | `layers` | to draw |  |  |  |
| 143 | `Boxes` | `zip` | to draw |  |  |  |
| 144 | `Component` | `component` | to draw |  |  |  |
| 145 | `Shapes` | `appearance` | to draw |  |  |  |
| 146 | `Frame` | `frame` | to draw |  |  |  |
| 147 | `Group` | `group` | to draw |  |  |  |
| 148 | `SquareDashed` | `selection` | to draw |  |  |  |
| 149 | `SquareDashedMousePointer` | `select-area` | to draw |  |  |  |
| 150 | `MousePointer2` | `pointer` | to draw |  |  |  |
| 151 | `Crosshair` | `crosshair` | to draw |  |  |  |
| 152 | `Hand` | `hand` | to draw |  |  |  |
| 153 | `Type` | `type` | to draw |  |  |  |
| 154 | `LayoutGrid` | `grid` | re-cut from d3 |  |  |  |
| 155 | `LayoutTemplate` | `layout` | to draw |  |  |  |
| 156 | `Columns2` | `columns` | to draw |  |  |  |
| 157 | `List` | `list` | re-cut from d3 |  |  |  |
| 158 | `ListChecks` | `plan` | to draw |  |  |  |
| 159 | `ListTodo` | `plan` | to draw |  |  |  |
| 160 | `Table` | `sheet` | to draw |  |  |  |
| 161 | `Table2` | `sheet` | to draw |  |  |  |
| 162 | `Presentation` | `deck` | to draw |  |  |  |
| 163 | `Map` | `map` | to draw |  |  |  |
| 164 | `Globe` | `globe` | re-cut from d3 |  |  |  |
| 165 | `Cloud` | `cloud` | to draw |  |  |  |
| 166 | `Database` | `database` | to draw |  |  |  |
| 167 | `Cpu` | `computer` | to draw |  |  |  |
| 168 | `Cube` | `cube` | to draw |  |  |  |
| 169 | `Monitor` | `computer` | to draw |  |  |  |
| 170 | `Laptop` | `laptop` | to draw |  |  |  |
| 171 | `Smartphone` | `phone` | to draw |  |  |  |
| 172 | `Tablet` | `tablet` | to draw |  |  |  |
| 173 | `Keyboard` | `keyboard` | to draw |  |  |  |
| 174 | `Terminal` | `terminal` | to draw |  |  |  |
| 175 | `Code2` | `code` | re-cut from d3 |  |  | redraw: keep the slash between the brackets (d3 "< >" read as expand) |
| 176 | `Braces` | `braces` | to draw |  |  |  |
| 177 | `GitBranch` | `branch` | to draw |  |  |  |
| 178 | `GitFork` | `fork` | to draw |  |  |  |
| 179 | `GitCompare` | `diff` | to draw |  |  |  |
| 180 | `GitPullRequest` | `pull-request` | to draw |  |  |  |
| 181 | `GitPullRequestDraft` | `pull-request` | to draw |  |  |  |
| 182 | `Plug` | `app` | to draw |  |  |  |
| 183 | `Wrench` | `wrench` | to draw |  |  |  |
| 184 | `Settings` | `settings` | re-cut from d3 |  |  |  |
| 185 | `Settings2` | `customize` | re-cut from d3 |  |  |  |
| 186 | `SlidersHorizontal` | `customize` | re-cut from d3 |  |  |  |
| 187 | `Workflow` | `workflow` | to draw |  |  |  |
| 188 | `Bot` | `agent` | to draw |  |  |  |
| 189 | `Brain` | `thought` | to draw |  |  |  |
| 190 | `Telescope` | `research` | to draw |  |  | the Research glyph (§2); `app-icons.ts` `research` and Deep research point here |
| 191 | `Sparkles` | `star` | to draw |  | yes |  |
| 192 | `Zap` | `bolt` | to draw |  |  |  |
| 193 | `Flame` | `bolt` | to draw |  |  |  |
| 194 | `PartyPopper` | `success` | to draw |  |  |  |
| 195 | `Megaphone` | `megaphone` | to draw |  |  |  |
| 196 | `GraduationCap` | `learn` | to draw |  |  |  |
| 197 | `BriefcaseBusiness` | `folder` | re-cut from d3 |  | yes |  |
| 198 | `Target` | `target` | to draw |  |  |  |
| 199 | `Coins` | `coins` | to draw |  |  |  |
| 200 | `CreditCard` | `billing` | to draw |  |  |  |
| 201 | `Sigma` | `sigma` | to draw |  |  |  |
| 202 | `Slash` | `line` | to draw |  |  |  |
| 203 | `Activity` | `activity` | to draw |  |  |  |
| 204 | `Timer` | `timer` | to draw |  |  |  |
| 205 | `Clock` | `clock` | re-cut from d3 |  |  |  |
| 206 | `CalendarClock` | `calendar` | to draw |  |  |  |
| | **People, access and appearance** | | | | | |
| 207 | `User` | `profile` | to draw |  |  |  |
| 208 | `Users` | `people` | to draw |  |  |  |
| 209 | `UserPen` | `profile-edit` | to draw |  |  |  |
| 210 | `KeyRound` | `key` | to draw |  |  |  |
| 211 | `Fingerprint` | `fingerprint` | to draw |  |  |  |
| 212 | `Lock` | `lock` | to draw |  | yes |  |
| 213 | `LockOpen` | `unlock` | to draw |  |  |  |
| 214 | `ShieldCheck` | `shield` | to draw |  |  |  |
| 215 | `ShieldAlert` | `shield-alert` | to draw |  |  |  |
| 216 | `ShieldOff` | `shield-off` | to draw |  |  |  |
| 217 | `Eye` | `eye` | to draw |  | yes |  |
| 218 | `EyeOff` | `eye-off` | to draw |  |  |  |
| 219 | `Sun` | `sun` | to draw |  |  |  |
| 220 | `Moon` | `moon` | to draw |  |  |  |
| | **Status: a status mark reports, it does not act** | | | | | |
| 221 | `Loader2` | `loader` | to draw |  |  |  |
| 222 | `Circle` | `circle` | to draw |  | yes |  |
| 223 | `CircleDashed` | `circle-dashed` | to draw |  |  |  |
| 224 | `CheckCircle2` | `success` | to draw |  |  |  |
| 225 | `XCircle` | `error-circle` | to draw |  |  |  |
| 226 | `AlertCircle` | `alert` | to draw |  |  |  |
| 227 | `AlertTriangle` | `warning` | to draw |  |  |  |
| 228 | `TriangleAlert` | `warning` | to draw |  |  |  |
| 229 | `Info` | `info` | to draw |  |  |  |
| 230 | `HelpCircle` | `help` | to draw |  |  |  |
| 231 | `BadgeCheck` | `verified` | to draw |  |  |  |
| 232 | `Ban` | `ban` | to draw |  |  |  |
| 233 | `CircleSlash` | `ban` | to draw |  |  |  |
| 234 | `WifiOff` | `offline` | to draw |  |  |  |
| | **Design editor alignment** | | | | | |
| 235 | `AlignStartHorizontal` | `align-top` | to draw |  |  |  |
| 236 | `AlignCenterHorizontal` | `align-middle` | to draw |  |  |  |
| 237 | `AlignEndHorizontal` | `align-bottom` | to draw |  |  |  |
| 238 | `AlignStartVertical` | `align-left` | to draw |  |  |  |
| 239 | `AlignCenterVertical` | `align-center` | to draw |  |  |  |
| 240 | `AlignEndVertical` | `align-right` | to draw |  |  |  |
| 241 | `AlignHorizontalDistributeCenter` | `distribute-horizontal` | to draw |  |  |  |
| 242 | `AlignVerticalDistributeCenter` | `distribute-vertical` | to draw |  |  |  |

Totals: 242 export names today, **243 after W2 adds `JunoProjects`** (the gate reads the count from `icons.tsx`, never a typed number). **205 distinct drawings**: the 204 of the first count plus one, because `TextSearch` and `FileSearch` now get their own drawings (`text-search`, `file-search`) and the telescope takes the `research` id (it was `deep-field`). Distinct drawings to draw: **166**; re-cut from d3: 39.
