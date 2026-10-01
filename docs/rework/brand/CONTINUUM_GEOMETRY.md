# Continuum geometry: construction and evidence

2026-10-02 · brand lane `rf/brand-assets` · not landed, not deployed, not released.

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
| Tests | `tests/thinking-mark-schedule.test.ts` |

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

At 16 px the master's channels are 0.5 px and the blades fuse. Each optical master:

1. scales the master into an N × N box at full width;
2. moves every outline point inward along its normal by `softplus((w − d) / 2)`, where `d` is the distance to the nearest other blade and `w` the target channel. Each channel opens to at least `w` and nothing away from a channel moves; the displacement is smoothed along the outline so curvature stays continuous;
3. cuts a tip where the retreating edge meets its partner;
4. refits the outline on its own extrema (the ramps where a channel opens create real inflections, so a few smooth nodes appear at 16 and 20);
5. places the box vertically so the outer extrema land on, or within 0.05 px of, whole pixels, slightly above centre for the low visual mass (top at 2.045, 3, 3.634 and 5 px).

| Size | Target channel | Measured minimum (px) |
|---|---|---|
| 16 | 1.3 | 1.25 – 1.29 |
| 20 | 1.15 | 1.07 – 1.15 |
| 24 | 1.0 | 0.94 – 1.26 |
| 32 | 1.0 | 1.05 – 1.67 |

The 16 px master is the allowed simplification: wider channels, slightly thinner blades. Trimming the hairline tails was also tried (morphological opening, then refit) and rejected: the blades read as blobs. `ContinuumMark` picks the master by rendered size (≤17 → 16, ≤21 → 20, ≤27 → 24, ≤40 → 32, else the master). Comparison at 8x: `optical-masters-8x.png` and the `/dev/brand` optical bench.

## 7. Wordmark

- **Face.** Newsreader, upright, wght 600, opsz 36: the display optical size keeps thin strokes sturdy down to the 72 px minimum width; opsz 72 was too fine there, opsz 16 too heavy at display sizes.
- **Provenance.** `google/fonts`, `ofl/newsreader/Newsreader[opsz,wght].ttf`, last changed in commit `991ce1de6075188e6b8977a5aa9fcd3610a4e946` (2020-12-09), sha256 `8a08d13f8a6c0d51be379a60af84f945f65369a67e509ee3c3bdcc421254d7c1`. Copyright 2020 The Newsreader Project Authors (github.com/productiontype/Newsreader). **SIL Open Font License 1.1**, which permits using outlines in artwork; the outlines are not distributed as a font. Instanced and outlined with fontkit 2 in the temporary tools directory.
- **Kerning.** The font's own kern feature, then optical adjustments in font units: A|l +70 (the foot serifs touch without it), l|e −10, e|v −20, v|r −30 (display tightening).
- **Never** italic, never "AleVR", never renamed Continuum.

## 8. Lockup

Mark height 1.18 cap heights (an open, pointed silhouette reads smaller than serif capitals at equal height); the mark's visual centre (y = 1.75 units) on the middle of the cap height; gap 1.5 path widths measured from the right fin's extremum, where the mark's mass ends. The lower sweep's hairline tail reaches one path width further toward the word, which is the optical adjustment: 1.5 path widths of mass, with the tail leading into the A. Clear space one path width.

## 9. Orbit and Code glyphs

Both follow the V3 icon grammar (1.25 px stroke at 16, 1.5 px from 18, round caps and joins, 24-unit grid, live area 3–21, continuous corners). Each size is drawn for its own pixel grid.

- **Orbit.** Two separated open arcs of one ellipse: a = 9 grid units, **b = a / φ** (e = 0.786, the board's construction), major axis tilted 20° up to the right. The two gaps sit 180° apart in the ellipse's parameter (160° and 340°), so the arcs are in point symmetry, the same pairing the Continuum's blades have. The gap is the clear chord between round caps: 2 units, held at 1.5 px at 16. Static.
- **Code.** Opposed square brackets (continuous corners) with an inset cursor about half their height. The axis sits half a pixel left of the box centre at every size so the cursor's stroke covers whole pixels; stems put one stroke edge on a whole pixel.

## 10. Thinking mark

`ThinkingMark({ phase, eventKey, size, label })` implements MOTION_AND_THINKING.md:

- The silhouette never moves. A **pass** hands presence ink along the blades in order: each blade rises toward presence over 220 ms (`out-soft`) and returns over 220 ms (`in-out`), the next starting 70 ms later (650 ms per pass). The peak is presence mixed 85% with the ink, a shift rather than a swap.
- One pass when work starts. A new `eventKey` asks for another; passes coalesce to **at most one per 1.6 s**, a request inside the window waits for it, and further requests add nothing.
- No events: a quiet, stable pose. **Finished** settles once (560 ms, a unison breath to 40% presence and back). **Waiting** and **error** are static; any pass stops.
- Pending states keep the loader contract: nothing for **200 ms**, then at least **400 ms** on screen before a status replaces it. Work that ends inside the delay never shows the mark; waiting or an error still shows it.
- Off-screen (IntersectionObserver) or in a hidden tab (visibilitychange) nothing starts and nothing missed is replayed.
- **Reduced motion:** the static mark; the 120 ms visibility fade is the only movement.
- Hidden from assistive technology unless `label` is given; the adjacent words carry the state.

The timing is a pure state machine (`thinking-schedule.ts`) with 18 unit tests. Evidence (main checkout, `alevr-web/brand/`): `thinking-filmstrip-pass-light.png`, `thinking-filmstrip-pass-dark.png`, `thinking-filmstrip-settle-light.png` (animations paused and seeked every 35 or 40 ms), and recorded clips `thinking-light.webp`, `thinking-dark.webp`, `thinking-reduced-motion.webp` (Chrome screencast; the bench's own log shows passes at 0.29, 2.82, 4.42 and 6.05 s during a 20 Hz event burst, and none under reduced motion).

## 11. Exports

`npx tsx scripts/brand/export-brand-assets.ts` regenerates everything from the geometry modules, rendering rasters with Chrome through Playwright.

| File | Composition |
|---|---|
| `public/brand/symbol-{light,dark,mono}.svg` | Master in tight bounds; #191b1e, #e8e9eb, #000; blade ids kept |
| `public/brand/wordmark-{light,dark}.svg`, `lockup-{light,dark}.svg` | Outlined, tight bounds |
| `public/brand/orbit-{16,20,24}.svg`, `code-{16,20,24}.svg` | Per-size masters, `currentColor` stroke |
| `src/app/favicon.ico` | PNG frames 16, 32, 48: charcoal tile (19% corner), pale mark at 14/26/38 px using the 16 and 24 optical masters and the master |
| `src/app/icon.png`, `public/brand/icon-{192,512}.png`, `public/brand/app-icon-mac.png` | Rounded tile (22% corner, the existing catalog's), transparent corners |
| `src/app/apple-icon.png` (180), `public/brand/icon-maskable-512.png` | Full-bleed opaque square without alpha; the mark's box stays inside the 80% safe circle |
| macOS `AppIcon.appiconset` (16, 32, 64, 128, 256, 512, 1024) | Rounded full-bleed tile, as the existing catalog draws it; file names kept |
| iOS `AppIcon.appiconset/AppIcon.png` (1024) | Opaque square, no alpha, no pre-rounded corners |

The tile is V3 dark ground #18191b with the mark in V3 dark ink #e8e9eb at 64% of the width, more of the width below 128 px (66% at 64, 69% at 32, 75% at 16), always drawn with a master whose channels stay near a pixel or wider. `src/app/manifest.ts` now names the app Alevr and lists the any and maskable icons.

## 12. Open items

- The product still draws the old mark through `src/components/brand/logo.tsx` (`JunoMark`, `public/juno-mark.png`) in the sidebar, auth, share and other surfaces. Swapping those call sites to `ContinuumMark` and `AlevrLockup`, and the thinking row to `ThinkingMark`, belongs to the web lanes that own those files.
- Native visible names, the in-app Mac and iOS marks, and native projection of the geometry belong to the native lanes; the data modules are Node-readable for that.
- The lower-right channel width (section 5) is an owner decision.
- Installed-icon appearance on macOS and iOS, and the favicon in real browser chrome, still need checking on devices.
- Name availability remains unresolved (NAMING_SCREEN.md).
