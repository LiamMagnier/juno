# Continuum geometry: construction and evidence

2026-10-02 · brand lane `rf/brand-assets`, revision 2 (after the brand critique) · landed on the refoundation trunk; not pushed, deployed or released.

This records how the owner-selected Continuum raster became production vector geometry, the rules the geometry obeys, the measured evidence, and every asset exported from it. The data lives in code; this document explains it.

| Deliverable | Where |
|---|---|
| Master and optical geometry (pure data, Node-readable) | `src/components/brand/continuum-geometry.ts` |
| Wordmark outlines | `src/components/brand/alevr-wordmark-geometry.ts` |
| Lockup layout | `src/components/brand/alevr-lockup-geometry.ts` |
| Orbit and Code glyphs | `src/components/brand/brand-glyphs.ts` |
| Components | `continuum-mark.tsx`, `alevr-wordmark.tsx`, `alevr-lockup.tsx`, `orbit-glyph.tsx`, `code-glyph.tsx`, `thinking-mark.tsx` (+ `.css`, timing in `thinking-schedule.ts`) |
| Exporter | `scripts/brand/export-brand-assets.ts` (`npx tsx scripts/brand/export-brand-assets.ts`) |
| Gallery | `/dev/brand` (`src/app/dev/brand/`) |
| Tests | `tests/thinking-mark-schedule.test.ts` (timing), `tests/brand-icon-registry.test.ts` (Orbit and Code in the icon registry) |
| Favicon-only drawings | `scripts/brand/favicon-frames.json` (the hand-drawn 16 px frame, the 26 px master) |
| Icon Composer document | `native/Brand/Alevr.icon` (not yet referenced by either Xcode project) |

## 1. What the source actually contains

`assets/alevr-continuum-symbol.png` is 1254 × 1254. Thresholded at 50% luminance it has **four** separate filled shapes, not three:

| Blade | Shape | Area (raster px) | Raster bounds |
|---|---|---|---|
| `blade-1` | upper sweep: hairline tail at the left, round head at the upper right, inner hook pointing down | 101,216 | 115–844 × 285–671 |
| `blade-2` | right fin: pointed top, round outer lobe, pointed lower-left tip | 95,791 | 624–1090 × 399–819 |
| `blade-3` | lower sweep: hairline tail at the right, round head at the lower left, inner hook pointing up | 80,085 | 422–1197 × 731–1020 |
| `blade-4` | left fin: pointed upper-right tip, round outer lobe, pointed bottom tip | 71,606 | 164–559 × 563–950 |

The brief for this lane said "three folded blades". Merging any two shapes would close one of the open channels the identity requires, so the reconstruction keeps all four. They are numbered clockwise from the upper sweep, which is the order the thinking handoff walks. The two sweeps and the two fins are near, not exact, 180° rotational pairs: the upper sweep is taller, the lower sweep longer and flatter, the right fin larger than the left. That asymmetry is the selected silhouette and is preserved.

## 2. The space

- **Unit.** One unit is 4.5 px of the source raster.
- **Origin.** The centre of the aperture, defined as the largest circle that fits between the blades. Measured on the raster: centre (618, 656) px, radius 107.8 px = 23.96 units. The construction uses **r = 24**.
- **Bounds.** x −112 … 128.5, y −82.5 … 81.5 (240.5 × 164 units, aspect 1.466). Every bound is an on-curve node (section 3), so the box is read straight off the data.
- **Path width.** The blades' largest inscribed circles are 53.9, 61.1, 35.0 and 50.7 units across. The broad path width is set to **48 units, one aperture diameter**.
- **Clear space** is one path width (48) on every side. **Wordmark gap** is 1.5 path widths (72), measured as described in section 6.
- **Visual centre.** The area centroid is (7.0, 4.1); the box centre is (8.25, −0.5). Square boxes lift the mark 2 units so the mass, which sits low, reads centred (`CONTINUUM_SQUARE_VIEWBOX = "-112 -118.75 240.5 240.5"`).

## 3. Construction rules

The outline of each blade is a closed chain of cubic Béziers that obeys four rules.

1. **Nodes only where the shape says so.** On-curve nodes sit at the two pointed tips of each blade and at the outline's horizontal and vertical extrema, nowhere else. Every extremum node has an axis-aligned handle (horizontal at a y-extremum, vertical at an x-extremum). Result: **18 spans** for the whole mark; 8 tips, 5 x-extrema, 5 y-extrema.
2. **Curvature continuity (G2).** At every smooth node the curvature arriving equals the curvature leaving, so highlights never kink where two spans meet. Residual radii (units, arriving | leaving):

   | Blade | Node | R in | R out |
   |---|---|---|---|
   | upper sweep | top (26.5, −82.5) | 44.6 | 43.9 |
   | upper sweep | right (50.5, −58.5) | 43.0 | 43.7 |
   | upper sweep | inner (−10.5, −36) | 77.2 | 79.3 |
   | right fin | right (105, 9) | 19.3 | 19.9 |
   | right fin | bottom (48, 36.5) | 98.7 | 98.8 |
   | lower sweep | bottom (−4, 81.5) | 75.2 | 75.1 |
   | lower sweep | left (−43.5, 47.5) | 50.4 | 50.5 |
   | lower sweep | inner (26, 50) | 344.7 | 344.8 |
   | left fin | left (−101, 19.5) | 17.8 | 17.6 |
   | left fin | inner (−54.5, 49) | 41.6 | 41.6 |

   The largest mismatch is 3.1% (right fin, right extremum); the fitted raster's own joins differed by up to 43%.
3. **Handle hygiene.** No span has an inflection, and no handle reaches past the point where its span's two end tangents meet.
4. **Lattice and pinned tips.** Nodes sit on the half-unit lattice; handles are kept to 0.01. Tips are pinned to the raster's measured tip points (rounded to the lattice), because silhouette overlap is blind to hairline tips and an optimiser would otherwise trade their length away for area.

Node list (units; t = tip, x/y = extremum), each blade clockwise from its outer trailing tip:

| Blade | Nodes |
|---|---|
| upper sweep | t (−112, 3.5) · y (26.5, −82.5) · x (50.5, −58.5) · t (25, −1.5) · y (−10.5, −36) |
| right fin | t (59, −57) · x (105, 9) · y (48, 36.5) · t (1.5, 29) |
| lower sweep | t (128.5, 37.5) · y (−4, 81.5) · x (−43.5, 47.5) · t (−35, 16.5) · y (26, 50) |
| left fin | t (−50.5, 65.5) · x (−101, 19.5) · t (−13, −20.5) · x (−54.5, 49) |

Control points for every span are in `CONTINUUM_MASTER`.

## 4. Method

All tooling is temporary and lives outside the repository in `.claude/local-tools/refoundation-artifacts/tools/continuum/` of the main checkout (Node with the repo's `sharp`; nothing installed in the repo).

1. **Contours.** Label the four components, grow each into its anti-aliased fringe, then trace each with marching squares at the 50% level for sub-pixel outlines (`extract.mjs`).
2. **Tips.** Resample every 2 px and take the two strongest turning-angle maxima per blade (118–159° each; nothing else exceeds 35°).
3. **Extrema fit.** Split each blade at its tips; on each edge place nodes at the tangent sign changes, then fit one cubic per span by least squares with fixed end tangents (axis-aligned at extrema, measured at tips), Newton reparameterisation, splitting only where error exceeds 5 px (none needed) (`construct.mjs`, `fitlib.mjs`).
4. **Space and lattice.** Move to aperture-centred units, order the blades clockwise, round to the lattice (`master.mjs`).
5. **Refinement.** Coordinate descent on node positions and handle lengths, maximising silhouette IoU against the raster plus penalties for G2 mismatch and handle overshoot, tips pinned; then nodes snapped to the half-unit lattice and handles re-solved (`refine.mjs`, `solver.mjs`).
6. **Emit** `continuum-geometry.ts` from the solved data and a documented template (`gen-geometry.mjs`, `geometry-template.ts`).

## 5. Evidence

Silhouette IoU against the raster thresholded at 50% luminance, at the raster's 1254 px:

| Stage | Spans | IoU |
|---|---|---|
| Free Schneider fit, 1.5 px tolerance (reference only) | 20 | 0.9874 |
| Extrema construction, before refinement, half-unit lattice | 18 | 0.9866 |
| **Final master** (refined, G2, pinned tips), rendered by librsvg | 18 | **0.9917** (347,560 shared px; raster only 1,138; vector only 1,779) |
| **Final master**, rendered and measured by Chrome in `/dev/brand` | 18 | **0.9912** |

The target was ≥ 0.97 while staying cleaner than the raster. The remaining difference sits along hairline tips and the generated raster's tonal edge wobble. Evidence images (main checkout, `.claude/local-tools/refoundation-artifacts/alevr-web/brand/`): `continuum-vector-over-raster.png` (outline over the raster), the in-browser difference map in the `/dev/brand` screenshots.

Channel minimums of the master (units): upper sweep / right fin 8.2, right fin / lower sweep 12.5, lower sweep / left fin 7.6, left fin / upper sweep 8.5. **The lower-right channel is about 1.5 times the others in the selected raster.** It is kept as drawn; equalising it costs about 0.014 IoU and changes the owner-selected drawing, so it is a decision for the owner, not a silent correction.

## 6. Optical masters (16, 20, 24, 32 px)

At 16 px the master's channels are 0.5 px and the blades fuse, so each small size has its own drawing.

**16 and 20 px move whole blades.** Revision 1 opened the channels by pushing outline points inward and refitting; at 16 and 20 that pinched the upper sweep's round head into a stepped waist, put a knee in the lower sweep's head and a wave along the left fin's inner edge. Revision 2 keeps every blade's exact master outline (so its round head, its curvature-continuous joins and its clean edges are the master's by construction) and changes only its placement:

1. per blade, a translation, a turn of at most 4.3° about its own centroid and a uniform scale of at least 0.97;
2. a pattern search keeps the drawing as close to the master as it can (silhouette IoU after both are fitted to the same box) while every channel opens to its target;
3. a second search in pixels nudges each blade (at most half a pixel) and the whole (scale 0.97 to 1) so the outer extrema land on whole pixels without closing a channel;
4. the box sits slightly above centre for the low visual mass.

Tooling: `tools/continuum/rigid.mjs` (outside the repo, beside the revision 1 tools).

**24 and 32 px** need far less and keep revision 1's construction: each outline point moves inward by `softplus((w − d) / 2)` (`d` the distance to the nearest other blade), smoothed along the outline, tips cut where a retreating edge meets its partner, refit on the outline's own extrema. Their outlines were already clean at review.

| Size | Method | Target channel | Measured channels (px) | Blade moves |
|---|---|---|---|---|
| 16 | placement | 1.3 | 1.30 – 1.32 | ≤ 7.9 units, ≤ 4.3°, scale ≥ 0.97 |
| 20 | placement | 1.15 | 1.15 – 1.34 | ≤ 7.6 units, ≤ 1.3°, scale ≥ 0.985 |
| 24 | inset | 1.0 | 0.94 – 1.26 | |
| 32 | inset | 1.0 | 1.05 – 1.67 | |

**Chosen by device pixels.** A 16 px mark on a 2x screen covers 32 device pixels, where the 16 master (tuned for 16) looks thin and pinched and the 32 master keeps both the shape and the channels. `continuumDrawingSet(size)` returns the 1x drawing and the one for 1.5 dppx and up; `ContinuumMark`, `ThinkingMark` and the small lockup render both and `brand.css` shows one with `@media (min-resolution: 1.5dppx)`, so the switch holds before hydration. By width in device pixels: ≤ 17 → 16, ≤ 21 → 20, ≤ 27 → 24, ≤ 40 → 32, else the master. `CONTINUUM_OPTICAL[n].rows` is the band of whole pixel rows the ink occupies, the tight crop a lockup uses.

Evidence: `/dev/brand` optical bench (each size beside what a 2x screen draws, and the 16 and 20 masters drawn large), `alevr-web/brand/r2/` screenshots.

## 7. Wordmark

- **Face.** Newsreader, upright, wght 600, opsz 36: the display optical size keeps thin strokes sturdy down to the 72 px minimum width; opsz 72 was too fine there, opsz 16 too heavy at display sizes.
- **Provenance.** `google/fonts`, `ofl/newsreader/Newsreader[opsz,wght].ttf`, last changed in commit `991ce1de6075188e6b8977a5aa9fcd3610a4e946` (2020-12-09), sha256 `8a08d13f8a6c0d51be379a60af84f945f65369a67e509ee3c3bdcc421254d7c1`. Copyright 2020 The Newsreader Project Authors (github.com/productiontype/Newsreader). **SIL Open Font License 1.1**, which permits using outlines in artwork; the outlines are not distributed as a font. Instanced and outlined with fontkit 2 in the temporary tools directory.
- **Spacing, revision 2: the drawing, not the tracking.** Revision 1 kerned A|l +70 (the foot serifs touched without it, and the pair read open), e|v −20 (the v's serif overhung the e) and v|r −30 (the v and r top serifs fused into a bar at small sizes). Now the A's right foot serif is trimmed 50 units, the l's left foot serif 40 and the v's right top serif 20, so A|l, e|v and v|r all sit at 0; l|e keeps the font's kern plus −10. Tooling: `tools/fonts/wordmark-fix.mjs`.
- **One clean outline per glyph.** The A's crossbar was a separate rectangle over the legs; the e's crossbar overlapped its own bowl; the r's flag overlapped its stem; the A apex and the v vertex had tiny self-crossing loops. Each glyph is now one outline (plus the A's counter and the e's eye as holes), so nonzero and even-odd fill render the same: 0 differing pixels at 2000 px wide in Chrome (revision 1: 17,415), and native outliners get clean contours.
- **Never** italic, never "AleVR", never renamed Continuum.

## 8. Lockup

Mark height **1.10 cap heights** (revision 1 drew 1.18, where the blades were about 1.8 times the word's stems and the mark outweighed the word; 1.05, 1.10 and 1.18 were compared at 120 and 24 px). The mark's visual centre (y = 1.75 units) sits on the middle of the cap height; the gap is 1.5 path widths from the right fin's extremum, where the mark's mass ends, the lower sweep's hairline tail leading into the A. Clear space one path width.

At large sizes (mark wider than 40 px) `AlevrLockup` is one SVG with the master, scalable. At sidebar and header sizes it draws the mark as a `ContinuumMark` at a whole-pixel height (an optical master's tight crop height when one is within 20%: 11, 15, 17 or 22 px), with the device-pixel switch, and places the word beside it. Revision 1 drew the full master there, so at 20 to 28 px tall its channels were 0.5 to 0.8 px and the blades fused.

## 9. Orbit and Code glyphs

Both follow the V3 icon grammar (1.25 px stroke at 16, 1.5 px from 18, round caps and joins, 24-unit grid, live area 3–21, continuous corners). Each size is drawn for its own pixel grid.

- **Orbit.** Two separated open arcs of one ellipse: a = 9.375 grid units at 24, **b = a / φ** (e = 0.786, the board's construction), major axis tilted 24° up to the right. The two gaps sit at the two ends of the major axis, 180° apart in the ellipse's parameter, so the arcs are in point symmetry, the same pairing the Continuum's blades have. The gap is the clear chord between round caps: 2 units, held at 1.5 px at 16. **Optical balance (revision 2):** an open, tilted ellipse reads shorter than a bracket pair, so Orbit is drawn larger below 24 px (a = 10.125 units at 16, 9.6 at 20) until it stands as tall as Code (12 px of ink at 16; revision 1 was 10). Static, with no selected form.
- **Code.** Opposed square brackets (continuous corners, 2.25 at 24) with an inset cursor half their height, after the V3 icon set's Code draft. The axis sits half a pixel left of the box centre at every size so the cursor's stroke covers whole pixels; stems put one stroke edge on a whole pixel; the arms stop short enough to keep the draft's 3-unit clear gap across that shift.
- **One registry.** Both are entered in the shared icon registry (`src/components/ui/juno-icons/drawings.ts`): `orbit` (new; the 24 master exactly, with the 16 px balance as its small cut; no `on` form, no motion) and `code` (redrawn from `</>` to the bracket pair; the brackets open a unit on hover, the cursor holds still). `tests/brand-icon-registry.test.ts` holds the registry and `brand-glyphs.ts` to the same drawing. `AppIcons.orbit` (`JunoOrbit`, house name `orbit`) is the Orbit destination; `AppIcons.agents` stays the mark of an agent itself; the command palette's Open Orbit uses `AppIcons.orbit`. Chat fills when selected; Orbit's selection is tonal, on the row. The Continuum is the brand mark, never an action glyph: the gallery's navigation rows now draw Chat's open conversation contour.

## 10. Thinking mark

`ThinkingMark({ phase, eventKey, size, label })` implements MOTION_AND_THINKING.md. Revision 2 answers the critique (the pass was a sweep that blinked blue, repeated on a 1.6 s beat and cut to rest in one frame):

- **A handoff, not a sweep.** Each blade rises toward presence ink over 120 ms (`fast`, out-soft) and falls over 220 ms (`base`, out-soft); the next starts 120 ms later, as this one peaks (pass 700 ms). Measured in Chrome by seeking the animations every 20 ms: one blade at a time above 75% of the peak, never more than two above 25%, in clockwise order.
- **A gentle peak, tuned per theme.** The presence copy of each blade peaks at opacity 0.5 on light and 0.9 on dark, the same perceived change from the row's muted ink (OKLab distance 0.107 on light, 0.096 on dark, where presence ink sits much closer to the muted ink). Revision 1 mixed 85% presence, so light graphite became nearly full ultramarine.
- **No fixed beat.** A step inside the coalescing window is absorbed, never queued into a trailing pass. While steps keep arriving the window backs off, 1.6 → 3.2 → 6.4 s, and it resets after 1.6 s with no step. `eventKey` means a new real step (a tool call, a new summary section), never a token; in development more than two changes a second logs a warning. Measured on the bench: a 12 s stream at 20 Hz drew passes 1.6, 3.3 and 6.6 s apart (revision 1: a 1.63 s loop).
- **No hard cuts.** Each blade is drawn twice, in ink and above it in presence ink; Web Animations drive the upper copies, and every change of plan starts from the tone a blade shows at that moment. Waiting, error or reduced motion mid-pass fade each blade back over 120 ms from where it was; Finished settles once (560 ms) starting from where the pass left each blade; a tab hidden mid-pass lets the pass finish on its own clock. Measured by freezing a pass at 250 ms (tones 0.035, 0.434, 0.115, 0) and logging the animations that replaced it.
- **Rest colour.** The mark takes the colour of its row (`currentColor`), so at rest it is never darker than its own label.
- Loader contract, visibility and assistive technology are unchanged: nothing for 200 ms, at least 400 ms on screen, nothing starts or replays off-screen or in a hidden tab, hidden from assistive technology unless `label` is given. **Forced colours:** the system ink, no tonal layer. **Reduced motion:** no pass and no settle; the 120 ms visibility fade is the only movement.

Tests: 23 in `tests/thinking-mark-schedule.test.ts` (handoff order and overlap, absorption, backoff, quiet-gap reset, the critique's irregular stream, interruption, hidden tab, reduced motion, the loader contract). Evidence (main checkout, `alevr-web/brand/r2/`): `thinking-filmstrip-pass-light.png`, `thinking-filmstrip-pass-dark.png`, `thinking-report.json` (per-frame tones, interruption logs, stream timings).

## 11. Exports

`npx tsx scripts/brand/export-brand-assets.ts` regenerates everything from the geometry modules, rendering rasters with Chrome through Playwright (`BRAND_ICTOOL_OUT=dir` also renders the Icon Composer document with Apple's `ictool`).

| File | Composition |
|---|---|
| `public/brand/symbol-{light,dark,mono}.svg` | Master in tight bounds; #191b1e, #e8e9eb, #000; blade ids kept |
| `public/brand/wordmark-{light,dark}.svg`, `lockup-{light,dark}.svg` | Outlined, tight bounds, revision 2 outlines and 1.10 lockup |
| `public/brand/orbit-{16,20,24}.svg`, `code-{16,20,24}.svg` | Per-size masters, `currentColor` stroke |
| `src/app/icon.svg` (new; replaces `icon.png`) | The browser-tab icon: the bare mark, graphite on a light tab strip and pale on dark (`prefers-color-scheme`), with the 16 master below 24 px, the 32 master to 47 px and the master above (media queries inside an SVG image see the size it is drawn at). Next declares it `sizes="any"`. Revision 1's 512 px `icon.png` was what Chrome picked for a 2x tab, downscaled: a smaller mark, fused channels, a halo |
| `src/app/favicon.ico` | For browsers without SVG tab icons: a 19% corner charcoal tile. The **16 px frame is drawn by hand on the 16 px grid** (`favicon-frames.json`: started from a 14 px placement master rasterised by Chrome, edge pixels pushed to ink or tile, the head rounded by one soft pixel, the lower tail tapered); 32 uses a 26 px placement master (channels ≥ 1.2 px); 48 the master |
| `public/brand/icon-{192,512}.png` | Manifest "any": rounded full-bleed tile (22%), hairline white rim (9%; 6% at 64 px) |
| `src/app/apple-icon.png` (180), iOS `AppIcon.png` (1024) | Opaque square without alpha (the system masks it), mark 64% |
| `public/brand/icon-maskable-512.png` | Opaque square, mark at **52%** of the width (revision 1: 64%, about 80% of the visible circle) |
| macOS `AppIcon.appiconset` (16 to 1024), `public/brand/app-icon-mac.png` | **Apple's macOS grid**: an 824 continuous-corner squircle (corner 185.4, UIKit's curve) inside 1024 with the standard drop shadow (y 10, blur 10, black 30%), the relief (#1e1f22 to #151618) and the rim; mark 64% of the body. Revision 1 was full bleed with plain 22% corners, about 24% larger than grid icons in a Dock. The shadow is a separate blurred shape: a filter on the gradient body made Chrome paint the gradient in bands |
| `native/Brand/Alevr.icon` (new) | Icon Composer document for macOS and iOS 26: charcoal fill, the four blades as separate glass layers in one group (neutral shadow, translucency 0.4), so the system draws Liquid Glass and the dark, tinted and clear renditions. Rendered by `ictool` for macOS Default and Dark, iOS Default, Dark, TintedDark and ClearLight (`alevr-web/brand/r2/ictool-sheet.png`). Not yet referenced by either Xcode project |

`src/app/manifest.ts` names the app from the registry (`PRODUCT_NAME`) and lists the any and maskable icons.

## 12. Open items

- The product still draws the old mark through `src/components/brand/logo.tsx` (`JunoMark`, `public/juno-mark.png`) in the sidebar, auth, share and other surfaces. Swapping those call sites to `ContinuumMark` and `AlevrLockup`, the live work row to `ThinkingMark` (with `eventKey` per step), and the sidebar's Orbit destination to `AppIcons.orbit` belongs to the web lanes that own those files.
- **One source of truth with the design gallery.** `rf/design-v3h` carries its own `brand.tsx` and `brand-geometry.ts` (a different ContinuumMark and a ThinkingMark whose last blade keeps a presence tone while work is live). The design lane should import the production modules in `src/components/brand/` instead; that worktree belongs to another workflow and was not touched here.
- Native: adopt `native/Brand/Alevr.icon` in both Xcode projects (keep the PNG catalogs for older systems), visible names, the in-app marks, and a native projection of the geometry (the data modules are Node-readable).
- The lower-right channel width (section 5) is an owner decision.
- Installed-icon appearance on macOS and iOS, and the tab icon in real browser chrome (which drawing Chrome rasterises for a 2x tab strip), still need checking on devices.
- Name availability remains unresolved (NAMING_SCREEN.md).
