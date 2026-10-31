# Alevr icon audit: every glyph, the grid, usage, motion

Read-only audit of `/home/user/juno` (no source modified), 2026-10-31.

## Verdict

The renderer is unusually careful: per-size, per-DPR stem hinting; equal gaps kept equal; dot fitting; and ancestor-translate cancellation. The drawings themselves are no longer one family. In 2026-10, two changes landed without propagating:

- **The Lucide redraw of the Navigation glyphs.** Thirteen glyphs were redrawn on Lucide geometry. Their siblings (`bell-off`, `mic-off`, `folder-plus`, `panel-right`, the other bubbles) still wear the house drawings.
- **The "bold" line pass.** The line went to 1.5 px at 16 px and 2 px from 18 px. Six documents still describe the old line, and the native symbols were never moved to it.

Beyond those two splits:

- Optical mass varies by more than 2× between glyphs that sit side by side.
- Glyphs sit about 0.75 px below the label's cap centre in every row recipe.
- Two glyphs that were retired for legibility, the Design nib and the slashed composites, are back at 14–16 px.
- The 2026-10 icon-button hover rule quietly broke the documented motion contract: the composer now moves.

## Method and artifacts

All artifacts are in `docs/handoff/2026-10-31/design/`.

- **`icons-sheet.png`**: the contact sheet. It shows all 237 drawn glyphs at 16, 20 and 24 px, plus the on-state at 20 px, in light and dark, at dpr 2.
- **`icons-sheet.html`**: the standalone page behind the sheet. It is built by `build-sheet.mjs`, which imports `juno-icons/catalog.ts` and renders through the production `Icon` (index.tsx) with `react-dom/server`, so paths are the exact fitted output for dpr 2. Both themes come from one render call (two calls repeat `useId`, which makes the knockout masks collide; see S12).
- **`zoom-light-1..4.png` and `zoom-dark-1..4.png`**: 3× crops for review.
- **`px2-zoom.png`**: dense glyphs at true 16 px on a 2× screen, upscaled with nearest neighbour.
- **`align-zoom.png`**: glyphs beside Inter "Settings", with Inter's cap-height centre drawn as a red hairline.
- **`metrics.json`, `ink.json`, `geo.json`**: rasterised ink measurements per glyph. These cover coverage, ink box, centroid, share of solid pixels, and lattice adherence of straight stems. They are produced by `shoot-sheet.mjs` and `analyze.mjs`.
- **`size_audit.py`**: tallies icon size classes per app area.
- **`alias-check.mjs`**: checks for alias shadowing and unused drawings.
- **Native**: `npx tsx scripts/generate-native-icons.mjs --check` (read-only) reports *up to date: 415 symbols (395 family, 20 marks) in 2 catalogs*.

## 1. Coverage: every exported glyph

The catalogue has 237 drawings: 154 in `drawings.ts` (the family) and 83 in `extra.ts` (production additions, marked * below). It also has 85 aliases (67 + 18). On top of that:

- **`icons.tsx`**: 240 `glyph()` exports plus 2 re-exports, mapping onto 204 distinct drawing names.
- **`app-icons.ts`**: 8 registries: AppIcons, CodeIcons, ComposerIcons, DesignIcons, StatusIcons, ActionIcons, SettingsIcons and ToolIcons.
- **Native**: the `JunoIcon` enum has 208 cases.

The drawings, by their own `group`:

- **Navigation (23):** chat, orbit, code, new-chat, search, folder, folder-open, library, customize, crew, bell, sidebar, panel-right, settings, account, help, menu, more, more-vertical, instructions, sign-out, keyboard, bell-off
- **Composer (22):** plus, attach, image, screenshot, at, mic, voice, send, stop, globe, memory, research, auto, camera, mic-off, dictation, slash, end-call\*, video\*, image-plus\*, image-off\*, crop\*
- **Apps (17):** skill, app, connect, disconnect, key, shield, mail, apps, megaphone\*, learn\*, target\*, coins\*, sigma\*, calculator\*, fingerprint\*, shield-alert\*, shield-off\*
- **Message (15):** copy, check, thumbs-up, thumbs-down, retry, edit, share, read-aloud, fork, rename, refresh, chat-question\*, chats\*, thought\*, eraser\*
- **States (15):** hand, alert, info, success, warning, lock, unlock, offline, progress, circle, loader\*, circle-dashed\*, error-circle\*, verified\*, ban\*
- **Files (33):** document, sheet, deck, pdf, file-image, file-code, zip, link, design, file-audio, file-video, file-upload\*, file-plus\*, film\*, music\*, link-off\*, square\*, frame\*, component\*, group\*, selection\*, select-area\*, type\*, line\*, bolt\*, align-left/right/center/top/bottom/middle\*, distribute-horizontal/vertical\*
- **Agents and time (17):** add-member, routine, clock, calendar, pause, play, history, profile, appearance, pause-circle\*, stop-circle\*, skip-back\*, broadcast\*, agent\*, people\*, timer\*, profile-edit\*
- **Code (29):** terminal, diff, branch, pull-request, run, test, file-tree, eye, eye-off, computer, pointer, browser, repo, laptop, cloud, external, phone, commit, review, preview, screen-share\*, screen-off\*, crosshair\*, database\*, cube\*, tablet\*, braces\*, wrench\*, workflow\*
- **Library (28):** grid, list, filter, sort, download, upload, trash, archive, pin, star, folder-plus, folder-move, unpin, grip, bookmark, unarchive\*, cloud-upload\*, save\*, printer\*, inbox\*, layers\*, folder-code\*, folder-lock\*, list-plus\*, list-minus\*, layout\*, columns\*, map\*
- **Arrows (23):** arrow-right/left/up/down, chevron-right/left/up/down, chevrons-up-down, close, minus, expand, collapse, undo, redo, enter, arrow-up-right\*, arrow-up-line\*, arrow-down-line\*, corner-down-right\*, repeat\*, unfold\*, fold\*
- **Theme (3):** sun, moon, contrast
- **Work and evidence (9):** plan, activity, receipt, versions, ask-first, blocked, sources, citation, deep-field
- **System (3):** billing, accessibility, upgrade\*

Other sources:

- **`juno-glyph-paths.ts`**: six legacy marks on Phosphor's 256 grid (chat, code, design, library, agents, send) and the private-chat ghost.
  - Only `junoGhostDrawing` is still read, by the native generator.
  - `JUNO_GLYPHS`, `junoGlyphDrawing` and the spark/shelf/face helpers are dead.
- **`juno-call-glyphs.tsx`**: five call glyphs on the 256 grid. Nothing imports it, so it is dead code. Its header still points at the retired `juno-glyphs.tsx`.
- **Brand glyphs** (`src/components/brand/orbit-glyph.tsx`, `code-glyph.tsx`): per-size masters at 1.25 and 1.5 px. They are used only under `src/app/dev`. The `icons.tsx` comment saying the product switch uses them is stale.
- **Unused drawings**: 26 drawings have no literal web call site. Five of those are used only by native (account, more-vertical, repo, bell-off, folder-plus). The others include `filter`, `apps`, `contrast`, `add-member`, `review`, `preview`, `versions`, `dictation` and `accessibility`.
- **Alias collision**: `video` is an alias for `file-video` in `drawings.ts`, but `extra.ts` draws a camera named `video`. The drawn name wins in `resolveCatalogIcon`, so the inventory row "Video → video" shows a camcorder, not a video file.

## 2. Grid consistency: systemic issues

**S1. Two drawing languages in one family.**

- **The split.** `drawings.ts` lines 761–770 say these were "Redrawn 2026-10-02 on Lucide's geometry (ISC)": `chat`, `orbit`, `code`, `new-chat`, `search`, `folder`, `folder-open`, `library`, `customize`, `bell`, `sidebar`, `mic` and `voice`.
- **Lattice.** These glyphs sit on Lucide's ninth-unit lattice (4.444, 3.111, 9.333…). Only 8–39% of their straight-stem coordinates land on the house ⅛-unit lattice. House glyphs drawn horizontally and vertically score 50–100%.
- **Construction.** They use plain circular corners. They break house trait 1, the 1.5-unit gap: `search`'s handle starts on the lens. They break trait 4, "New is the house plus in the corner": `new-chat` is Lucide's square-pen.
- **Siblings never followed**, so pairs now visibly differ:
  - `bell` (20.5×22) vs `bell-off` (the old cast bell, 19.5×19.5, separate rim and clapper bar)
  - `mic` vs `mic-off` vs `dictation`: three different capsules
  - `folder` (22×19, Lucide tab) vs `folder-plus`, `folder-move`, `folder-code` and `folder-lock` (21×17, house S-tab)
  - `sidebar` (a 20×20 square, r≈2) vs `panel-right` (a 22×19 frame, r 3)
  - `chat` vs `chat-question` vs `chats` vs `thought`: four bubble constructions
- **Gallery copy.** The design lane's copy, `src/app/dev/design/juno/icons/drawings.ts`, still holds the house originals. `extra.ts` says "a later port of drawings.ts overwrites nothing". A port "as a whole" would silently revert the owner's Lucide decision.
- **Attribution.** `NOTICE` has no Lucide (ISC) notice. Meanwhile `icons.tsx` claims "EVERY GLYPH IS ALEVR'S OWN… No third-party glyph library".

**S2. The line ladder is undocumented, non-monotonic, partly never crisp, and not shared with native.**

`iconStrokePx` (index.tsx:99) produces:

| size | line | % of box | device px at 2× |
|---|---|---|---|
| 12 (`size-3`, 174 call sites) | 1.25 | 10.4% | 2.5 dp: never crisp |
| 14 (`size-3.5`, 529) | 1.5 | 10.7% | 3 dp |
| 16 (`size-4`, 631) | 1.5 | **9.4%** | 3 dp |
| 18 (`size-[18px]`/`4.5`, about 20) | 2 | **11.1%** | 4 dp |
| 20 (`size-5`, 36) | 2 | 10% | 4 dp |
| 24 | 2 | 8.3% | 4 dp |

- **Weight curve.** The default rung, 16 px, is the lightest relative to its box, between 14 and 18. The 16→18 step adds 33% weight for 12.5% more size. You can see it in the composer: Send and Dictate at 18 px sit beside 14 and 16 px chips.
- **1× screens.** At dpr 1, a 1.5 px line can never land on whole pixels.
- **Stale docs.** Six places still describe a retired line:
  - `drawings.ts` (header, and the KEYLINE comment), `extra.ts` and `icons.tsx` all say "1.25 px at 16, 1.5 from 18".
  - `docs/design/ICONS_AND_MOTION.md` §1.2 says "1px at 16, 1.25 at 20, bold cut at 12 and under". There is no bold cut.
  - The `app-sidebar.tsx` NavRow comment says "size-4.5… 1.1px". The code is `[&_svg]:size-4`.
  - The `generate-native-icons.mjs` and `app-icons.ts` headers still say "Phosphor… bold cut at 13px".
- **Native weight.** `alevrCut` outlines at `d.line` = 1.5 units (regular) and 2.1 units (bold). The web draws 2.25 units at 16 px and 2.4 at 20 px. So native symbols are about 0.67× the web's weight, and native *bold* is still lighter than web *regular*.

**S3. Points don't follow the line.**

- Dot radii run 0.825, 0.9, 1, 1.125, 1.275, 1.3, 1.5, 1.875 and 2.625.
- Since the bold pass, small points render thinner than the 2 px line beside them: the browser window dots (r 0.9, about 1.7 px at 20) and the `chat-question` and `thought` dots.
- At 16 px, the `deep-field` far point (r 0.825) is about a 1 px speck.

**S4. Optical mass is not balanced.**

Ink coverage at 24 px, rest state: median 0.235, p10 0.122, p90 0.315.

- **Heavy outliers:**
  - `contrast` 0.417, a filled half disc and twice the median
  - `sheet` .386, `image` .379, `save` .366, `globe` .366, `library` .363, `film` .363, `preview` .356
- **Light non-arrow outliers:**
  - `diff` .098, `filter` .122, `commit` .124, `deep-field` .137, `code` .152, `play` .157, `key` .167
  - `end-call` .179, which is only 10 units tall
- **The product-switch trio:** chat .206, **orbit .314** and **code .152**. Orbit carries twice Code's ink.
- **Filled vs outline.** Filled on-states (chat, folder, bookmark, star, crew, memory, hand, thumbs) are, as expected, about 2× their outlines. `citation`'s filled heads (r 2.625) and `contrast` are filled at rest, so they read bolder than their row.

**S5. Live-area overflow.**

The keyline live area plus the stroke should end 0.875 px inside a 24 px box. These glyphs reach to within 0.5 px of the edge or past it:

- crew (0.25→23.5), connect (→23.5), add-member, chats, link-off, select-area, profile-edit (→23.75)
- versions, share, pull-request, dictation (top at 0.5)
- code (0.75→23.25 horizontally)

The SVG is `overflow: visible`, so this shows as ink outside the box. It also makes these glyphs read larger.

**S6. Vertical optical centring against text.**

I measured with the shipped Inter woff2, in each recipe's flex `items-center` row:

- **The offset.** The SVG centre sits 0.5–0.9 px below Inter's cap-height centre in every recipe:
  - menu row 0.75, sidebar row 0.5, button 0.75, caption 0.89, chip 0.75 (px)
  - This is effectively the x-height centre, so beside title-case labels the glyphs read low (see `align-zoom.png`).
- **Bottom-heavy glyphs** sit 1.3–1.7 px low at 16 px. Their ink centroid at 24 px:
  - `crew` +2.08, `add-member` +2.28, `agent` +1.68, `lock` +1.75, `cloud` +1.81, `cloud-upload` +2.02, `eraser` +2.15
- **Top-heavy glyphs** sit high:
  - `auto` (centroid −1.74, box −1.0), `diff` (box −1.13), `chat-question` (−1.38), `thought` (−1.08)

**S7. Corner radii.**

- **Two radii for same-size containers.** r 2.25 on `computer`, `laptop`, `deck`, `billing`, `mail`, `keyboard`, `rename` and `screen`. r 3 on FRAME (`terminal`, `browser`, `image`), `sheet`, `calendar`, `square`, `layout` and `inbox`.
- **Devices.** `phone` (10.5 wide) has r 3, while the larger `tablet` has r 2.25.
- **Library.** The Lucide `library` uses r 0.89.
- **Apps.** `apps` tiles are 6.375 with r 2.25, so `rr`'s 1.18r ramp makes them almost circles. At 16 px the "three squares and one circle" reads as "88".
- **Trait 2.** House trait 2 (continuous `rr` corners on every container) is not held even by house drawings. `PAGE` (every file mark), `share`, `external`, the `download`/`upload` trays, `archive`, `sign-out`, `trash`, `save`, `printer`, `bubbleAt` (`chats`) and `BUBBLE` all use plain arcs. That costs little visually but contradicts the documented grammar.

**S8. Small cuts are missing where 16 px fails.**

- Only 4 glyphs have a `small` cut: `deck`, `layers`, `chat-question` and `group`.
- In the true-pixel render at 16 px on a 2× screen (`px2-zoom.png`), these turn to mud or read as letters:
  - `design`: the nib's dot fuses with the outline
  - `library` reads as "lll\"
  - `orbit`: its satellites
  - `accessibility`, `review`
  - `rename` reads as "E[]" and `dictation` as "ψI"
  - `pull-request`, `file-tree`, `versions`, `memory`, `zip`, `pdf`
  - every slashed composite (`unpin`, `mic-off`, `bell-off`, `disconnect`, `eye-off`, `shield-off`, `image-off`, `offline`): the 1.5-unit knockout splits each into 3–4 fragments
- The 174 `size-3` call sites draw these at 12 px on a 2.5 dp line.

**S9. The on-state machinery is mostly unreachable.**

- `icons.tsx` turns `weight="fill"` or `fill-*` into `state="active"` only for `on.kind === "fill"`.
- No production call site passes `state="active"` to `Icon` directly.
- So these designed states never ship:
  - plus → close (turn)
  - copy → check (draw)
  - send → stop, mic → voice, sun ↔ moon (swap)
  - chevron open, bell "holds the swing as it rings"
- Call sites rebuild them with `ui/icon-swap.tsx`, which is a second swap system with different curves.
- Silent fallbacks:
  - `weight="fill"` on drawings with no fill renders as outline: `Play` and `Pause` on the audio player's solid disc, `EyeOff` (Incognito header), and `CheckCircle2` in `aicss/todo-list.tsx`, whose comment says "the filled check is a STATE".
  - There are 5 `weight="bold"` and 68 `motion=` props that do nothing.

## 3. Glyph-by-glyph: what is inconsistent and the fix

| glyph | problem | fix |
|---|---|---|
| `chat` | Lucide bubble with plain arcs and a 0.58-unit tail join; the tail barely registers at 16 px. Unlike `chat-question`, `chats` and `thought` (S1). | One `BUBBLE` constant for all four bubbles. |
| `orbit` | Lucide's "orbit" (two arcs and three ring satellites). Satellites are about 1.3 px rings at 16 px and blur to dots. The motif reads as a loading/orbit mark, against its own "never a spinner" note and the inventory's "open elliptical path". Mass .314 is 2× `code`. | Drop to a single satellite dot or restore the elliptical construction; match chat and code mass. |
| `code` | `</>` is the lightest destination (.152), wider than the live area (0.75→23.25), and the least crisp at 16 px. | Add `optical: 1.08` and pull the brackets inside the live area, or shorten the slash. |
| `new-chat` | Square-pen breaks the house "New = corner plus" that add-member, connect, folder-plus and file-plus follow. Box off-centre (+0.75, −0.75); no gap between pen and frame. | Either adopt pen-on-sheet as the convention family-wide, or restore bubble + cut plus. |
| `search` | No house gap at the handle. | Gap the handle, or record that Lucide's join is the rule. |
| `folder` vs `folder-plus`/`-move`/`-code`/`-lock` | Two silhouettes and two tab shapes. | Rebuild the variants on `FOLDER_SHUT`. |
| `library` | The spine line inside a 7-unit volume closes at 16 px ("lll"); heavy (.363). `app-icons.ts` describes a different drawing. | Drop the spine below 18 px, or widen the upright. |
| `customize` | 9 strokes, dense at 16 px. Also drawn for five concepts: Customize, Filter, Parameters, Settings → General, call settings. | Small cut with 2 faders. Give Filter the `filter` drawing. |
| `bell` / `bell-off` | Different bells (S1). The on-state turn (14°) would rotate an unfitted glyph. | Build `bell-off` from `BELL_BODY`. Draw the "ringing" pose as fitted data, or drop it. |
| `sidebar` / `panel-right` | Square r≈2 vs 18×15 frame r 3. | `panel-right = flipX(sidebar)`. |
| `mic` / `mic-off` / `dictation` | Three capsules. `dictation` reads "ψI" at 16 px. | One capsule. For dictation, a small cut without the I-beam serifs. |
| `voice` | Bars run to the box edges (x 1→23) and are centred on 11.556, not 12 (Lucide); 6 bars are dense at 16 px. | 5 bars inside 3–21, centred (the gallery version). |
| `design` (pen nib) | Now the **Design destination** (`AppIcons.design`, sidebar, command palette, artifacts at `size-3.5`). `app-icons.ts` explains the nib was retired from that role because its inner dot closes at 14–18 px, and it does at 16 px. Also identical to `DesignIcons.path`. | Restore a square-and-circle destination mark; keep the nib for the path layer only. |
| `crew` | Widest glyph (beyond the live area); centroid +2.08, so it sits about 1.5 px low beside labels. Native `juno.agents` ships **orbit**, not crew. | Scale into the keyline, raise 1 unit, and fix the native mapping. |
| `agent`, `add-member` | Bottom-heavy (+1.68 / +2.28). | Raise 0.75–1 unit. |
| `cloud`, `offline`, `cloud-upload` | Base at 18.75 and nothing above 6.4, so they sit low (+1.8; cloud-upload +2.0, with the arrow below the base). | Move the cloud up 1.5 units; keep the arrow inside the cloud's base band. |
| `lock` / `unlock` | Body-heavy, 1.6 px low beside text. | Raise 0.75. |
| `auto` | Gauge sits high (box −1, centroid −1.74). | Move the dial centre down 1 unit. |
| `diff` | Lightest non-arrow glyph (.098), 10.5 units wide, floats 1.1 px high. | Widen to 13.5, centre it, or seat it in a frame. |
| `contrast` | Heaviest glyph (.417), a filled half at rest; centroid +1.57 right. | Inset the half disc by the house gap, or switch to outline plus a half fill at reduced weight. |
| `citation` | Filled heads (r 2.625) out-weigh their row; box sits 0.6 up-left. | Heads r 2.1; centre the box. |
| `deep-field` | .137 coverage; the far point is a speck. A branded feature that reads as dust beside `globe` in the + menu. | Points r ≥ 1.125; heavier corners. |
| `apps` vs `grid` | Apps' tiles read as circles at 16 px, so its idea vanishes. Unused on the web. | Tile r 1.5 like `grid`, or retire it. |
| `pdf` | The overhanging label breaks the page into a hook (reads as a link on a page); box −1.25 px. | Inset the label inside the page; small cut. |
| `review`, `rename`, `accessibility`, `pull-request`, `file-tree`, `versions`, `memory`, `zip` | Mud at 16 px (S8). | Small cuts that drop the inner detail. |
| `unpin`, `mic-off`, `bell-off`, `disconnect`, `eye-off`, `shield-off`, `image-off`, `offline` | The slash's 1.5-unit knockout fragments the glyph at 16 px. | Small cut with a 0.75-unit gap, or slash through the outline only. |
| `collapse` vs `expand` | Collapse's diagonals run to 19.875/4.125, outside the corner and off-lattice; expand's stay inside. Not a mirror pair. | Collapse diagonal 14.25,9.75 → 19.5,4.5. |
| `play` / `pause` | Toggling jumps width (15.25 → 9) and weight (.157 → .115). `audio-attachment.tsx` adds `translate-x-px` on top of play's built-in centroid centring (box already +2.13), so it is over-shifted. | Remove the nudge; give pause `optical: 1.15`. |
| `end-call` | 10 units tall; reads small beside the call bar's mic and stop. | `optical: 1.15`. |
| `video` | The `extra.ts` camera shadows the `video → file-video` alias (S9 / §1). | Rename the drawing `video-camera`. |
| `at` | The counter closes at 16 px (heavy, .29). | Inner r 3.375 → 3.75, or a small cut. |
| `phone` / `tablet` | Radius inverted (S7). | Both r 2.25, or both 3. |
| `chat-question`, `chats`, `thought` | The third and fourth bubble constructions. `thought` sits 1 px high. | Share `BUBBLE`. |
| `link-off` | The break mark is weak; it reads as `link` at 16 px. | Slash across the gap, or wider separation. |
| `image-plus` | Opens the frame for the plus instead of the house knockout used by every other "New". | Use `ko(plusAt)` like `connect`. |

## 4. Usage across the app

**Imports and routing**

- 320 files import `@/components/ui/icons` and 224 import `@/lib/app-icons`.
- 5 production files import the renderer directly, bypassing the "only module" rule: `code-work-list.tsx`, `code/v2/primitives.tsx`, `code-landing-skills.tsx`, `team-activity.tsx` and `work-run-panel.tsx`. They draw `pull-request`, `branch` and `pin` at 12 px.

**Size tally** on icon elements (production `.tsx`):

- `size-4` 631, `size-3.5` 529, `size-3` 174, parent-sized 151, `size-5` 36, `size-6` 17
- Off-ladder: `size-[18px]` about 20 and `size-[15px]` 1 (the dictation check)
- `size-4.5`: 1
- By area:
  - menus are mostly 16 (`menuRowClass` defaults to 16; submenu chevrons and selection checks are 14)
  - sidebar rows are 16 inside a 20 px box (the docs say 18)
  - settings are mostly 16
  - chat and code mix 14 and 16, often in one row

**Composer**

- One control row uses four sizes: + at 20, Dictate at 18, Send at 18 (`weight="bold"` is ignored, though the comment claims "the bold cut"), Stop and busy at 16, chips at 14 and 16.
- Send → Stop changes 18 → 16 and the line 2 → 1.5.

**Optical alignment.** Every recipe centres the glyph about 0.75 px below the cap-height centre, and bottom-heavy marks about 1.5 px below (S6). There is no baseline-aligned (inline-text) use worth flagging: `.ji` is `vertical-align: middle`, and nearly all uses are flex `items-center`.

**Semantic drift in `app-icons.ts` / `icons.tsx`**

- `AppIcons.design` draws the nib (§3).
- `AppIcons.skills` = `ScrollText` = the `instructions` drawing.
  - Skills and Instructions share a glyph, while the inventory says Skills → `skill`.
- `ActionIcons.filter`, `ActionIcons.parameters`, `SettingsIcons.general` and `CallSettings` all draw `customize`.
  - The `filter` drawing is never rendered.
- `ComposerIcons.canvas` (`SquarePen`) and `ActionIcons.edit` (`Pencil`) both draw `edit`.
  - The comment that distinguishes them is now false.
  - The sidebar's New chat is the square-pen.
- `ActionIcons.restore` = `RotateCcw` = `retry`, while the alias `restore` → `undo`.
- `ToolIcons.calculator` = `Sigma`, though `calculator` now exists. The comment says it does not.
- Remaps that lose meaning:
  - `BookmarkPlus` → bookmark (no plus), `MailWarning` → mail, `SearchX` → search, `Flame` → bolt
  - `Sparkles` → star, which is also "favourite"
  - `PartyPopper` → success, `BriefcaseBusiness` → folder, `Cpu` → computer (whose hover shows a pointer)
- Stale descriptions in `app-icons.ts`:
  - "open ring with ball terminal" (home)
  - "spark between two chevrons" (code)
  - "binoculars" (research)
  - "face with rounded-square eyes" (agents)
  - "one head band each" (library)
  - "person with a gear" (personalization)
- The inventory's brand directions ("open conversation contour; open elliptical path; bracket pair with inset cursor") no longer match the drawings.

**Third-party code and emoji**

- **Imports**: no `lucide-react` or `@phosphor-icons` imports in `src`, and ESLint blocks them.
- **Dependencies**: both packages are still in `package.json` `dependencies`. The sandbox inlines its own Lucide shapes for user artifacts, so neither package appears to be needed.
- **Electron**: the Electron renderer (`native/desktop-electron/.../components/icons.tsx`) ships its own Lucide set.
- **Navigation geometry**: the Navigation glyphs are Lucide-derived with no NOTICE entry (S1).
- **Emoji**: none rendered; they appear in comments only.
- **Text glyphs standing in for drawn controls**:
  - `composer-dictation.tsx` copy says "press ✓ to try again, or ✕". These are font glyphs naming drawn controls that look different.
  - The settings rail renders `↵` as text beside a family `enter` glyph.
  - `semantic-chart.tsx` uses `■` legend swatches.
- **Platform mismatch**: Incognito is `EyeOff` on the web but `juno.ghost` on native.

## 5. Motion (opt-in articulation)

**What works**

- `data-jicon-articulate` is set by the sidebar `NavRow` (New chat and every destination row with `moves`), by the product-switch tabs, and by `EmptyState` actions (`="within"`).
- It requires fine pointer and hover, never fires on focus, and skips disabled controls.
- Reduced motion keeps every state as an opacity cross-fade, and live meters update at 4 Hz.
- Tokens are the product's `--dur-*` and `--ease-*`.
- `orbit` is static by design.

**Issues**

1. **The contract is broken by the 2026-10 "Icon buttons" block** (`icons.css` lines 525–573).
   - It articulates, and scales by 1.08 on hover, every `button[aria-label] > svg.ji:only-child` and every solo `.jicon-trigger`.
   - That reaches the composer: Dictate's mic lifts, and + scales. This happens even though `index.tsx`, `icons.tsx`, the G46 section of the same CSS, `menu-recipe.ts` and `sidebar-motion-icon.tsx` all say "never the composer".
   - `composerIconButtonClass` carries no `.jicon-quiet`.
2. **Two press depths.**
   - The `.jicon-trigger` solo rule gives 0.97 (INTERACTION_SPEC; specificity 0,5,0).
   - `button[aria-label]… > svg.ji:only-child` gives **0.9** (0,5,2). When both match, 0.9 wins.
3. **`--ji-amp: 1.35` undoes the renderer's work.**
   - `snapMove` rounds held translations to whole device pixels; ×1.35 makes them fractional again. For example, 0.75 units at 16 px on 2× becomes 1.35 dp, so held hover poses are soft.
   - It also breaks designed angles: `sun` 22.5° ("half a step") becomes 30.4°; `settings` 30° (half a tooth of 60°) becomes 40.5°; `retry` 40° becomes 54°.
4. **Scale transforms on the SVG resample the fitted drawing.** The 1.08 hover, 0.9 or 0.97 press, and 0.8 swap in/out leave the glyph blurred for the whole hover.
5. **Dead and divergent on-states** (S9). The bell's "ringing" on-state is unreachable, and if used would rotate an unfitted glyph at exactly the moment people look at it.
6. **Minor mismatches.**
   - `mic`'s hover lifts the whole mic, stand included, though it is described as "the capsule".
   - `sidebar-motion-icon.tsx` still says only "four low-frequency destinations" move via `.jicon-hover`. In fact every NavRow destination moves via `data-jicon-articulate`.

## 6. Systemic fixes, in order

**P0**

1. **Pick one Navigation language.**
   - Either redraw the 13 Lucide glyphs on the house lattice with the house traits, or accept Lucide and rebase their siblings: `bell-off`, `mic-off`, `dictation`, the `folder-*` variants, `panel-right` and the bubbles.
   - Add Lucide's ISC notice to `NOTICE` either way.
   - Sync or freeze `src/app/dev/design/juno/icons/drawings.ts` so a port can't revert the decision.
2. **Give the Design destination back a non-nib mark**, and keep the nib for `DesignIcons.path`.
3. **Re-establish the motion contract.**
   - Add `.jicon-quiet` to `composerIconButtonClass` (and the message action row), or rewrite the docs.
   - Use one press depth (0.97).
   - Move the 1.08 hover lift to the button, not the SVG.
   - Apply `--ji-amp` before `snapMove`, not after.
   - Exempt angle poses whose value is a symmetry step.

**P1**

4. **Make the line ladder crisp and coherent.**
   - 12 px: 1.25 → 1.5 px (3 dp, crisp).
   - Move the 2 px threshold from 18 to 20, or move the roughly 20 `size-[18px]` call sites to 20.
   - Consider whole-pixel lines at dpr 1.
   - Then fix the six stale docs (S2).
5. **Native.** Outline at the web's weight: about 2.25 units regular and 3 bold. Remap `juno.agents` to `crew`. Settle the Incognito mark.
6. **Tie points to the line**: r ≥ 0.6 × line.
7. **Add small cuts** for the about 20 glyphs in S8, including a gap-light slash variant.
8. **Optical centring.**
   - Per-glyph vertical nudges in the data: crew, agent, add-member, cloud, cloud-upload, lock (up); auto, diff (down). Done in the data, the fit still lands them on the grid.
   - Row-level: `text-box: trim-both cap alphabetic` on labels in icon rows (Chrome 133+, Safari 18.2+), so `items-center` centres on caps. Alternatively, bake a 0.5 px raise into the fit offset.
9. **Mass balance.** Use `optical` multipliers for code, diff, deep-field, end-call, key and commit. Lighten contrast, library, sheet and citation.

**P2**

10. **Registry hygiene.**
    - `ActionIcons.filter → filter`, `AppIcons.skills → skill`; give `canvas` its own drawing; `ToolIcons.calculator → calculator`.
    - Fix `restore`, the lossy remaps and the `video` collision.
    - Warn in development when `weight="fill"` targets a drawing with no fill.
    - Delete the `weight="bold"` and `motion` props.
    - Route the 5 direct `Icon` users through `icons.tsx`.
11. **Remove dead code and dependencies.** Delete `juno-call-glyphs.tsx` and `JUNO_GLYPHS` (keep `GHOST`). Drop the `lucide-react` and `@phosphor-icons/react` dependencies after confirming the sandbox doesn't need them.
12. **Radii and robustness.**
    - Radius rule: r 3 for containers of 15 units or more, 2.25 below, applied to devices too. Build `PAGE` with `rr`.
    - Prefix knockout mask ids beyond `useId` (or use `identifierPrefix`), so two React roots on one page can't collide. Rendering two roots into one document reproduced the collision: masks resolved to the other root's ids.
