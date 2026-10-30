# Identity v2 · BRAND

Appendix to `docs/design/IDENTITY_V2.md` §2. The final files are in `docs/design/identity-v2/brand/`,
generated from numbers by `docs/design/identity-v2/tools/brand3.py` (d3's `brand2.py` geometry, vendored
in `tools/vendor/`, with the revisions below; colours regenerated for the granite palette on 30 Oct 2026); nothing is traced, filtered or embedded. Verification renders:
`shots/brand-check-{light,dark}.png` and `shots/favicon-zoom.png`.

## 1. The idea

**Alevr lifts the work.** The ground stays still; only what you are acting on rises to meet you, shaped
like a well-made object. *Élever* is "to raise"; a lever moves more than your own strength allows. Three
decisions carry it everywhere: **the Arch** (a stone held clear of the ground by shape alone), **one depth
rule** (lift is earned) and **one motion character** (lift and settle with weight).

## 2. The symbol: the Arch

A round-shouldered arch with flat feet, and inside it one stone, lifted clear of the ground. Shoulders are
superellipse halves (n 2.8 outside, 2.6 inside, so the crown is slightly thinner than the legs). The gap
under the stone is the brand: the stone never touches the ground.

### 2.1 Optical masters (drawn, not scaled; chosen by rendered size)

| Master | Box | Arch x0–x1, top–base | Leg / crown | Stone (cx, cy, r) | Opening | Stone clearance each side | Lift | Use |
|---|---|---|---|---|---|---|---|---|
| 16 | 16 | 2–14, 1–14 | 3.0 / 3.0 | 8, 11, 2.0 | 6.0 | 1.0 | 1.0 | favicon, 16 px in product. **Pixel-fitted at 1x**: every edge on a whole pixel, the stone a 4 × 4 px disc |
| 20 | 20 | 3–17, 1.5–18 | 3.5 / 3.5 | 10, 14.5, 2.5 | 7.0 | 1.0 | 1.0 | sidebar top-left; fitted to 0.5 units (whole device pixels at 2x) |
| 24 | 24 | 4–20, 2–21.5 | 4.0 / 4.0 | 12, 17.5, 3.0 | 8.0 | 1.0 | 1.0 | toolbars, phone drawer (rendered at 22), About; fitted to 0.5 units |
| large | 100 | 16–84, 9–90 | 18.5 / 16.8 | 50, 76, 10 | 31.0 | 5.5 | 4.0 | 32 px and up, app icon, print (d3, unchanged) |

What changed from d3 and why: d3's 16 master put a 3.5 px stone 0.85 px above the base inside a 5 px
opening, so at 1x the stone smeared into the legs and the mark read as an "n", a magnet or a door
(J-owner, J-ux). The v2 16 master widens the opening to 6 px, makes the stone a 4 px disc, and puts one
whole pixel between the stone and each leg and the ground. Rendered in Chromium at DPR 1 and 2 on
simulated light and dark tab strips (`shots/favicon-zoom.png`, re-rendered in the granite palette: top row
1x, bottom row 2x; columns d3 light, v2 light, d3 dark, v2 dark): **the v2 stone is now visible as a
separate mark at 16 px at both densities.** That is all this render shows. Whether the 16 px silhouette
(12 × 13 px, round crown, flat feet) still reads as a lowercase "n" was **not checked**: W1 runs a
recognition check (MIGRATION W1: silhouette overlap with Inter's and Geologica's "n" below 0.80, and an
unlabelled five-person test), and if it fails the 16 and 20 masters widen toward an aspect of 1.0 or more so
they read as a portal, not a letter. **A real browser tab in Safari, Chrome and Firefox, light and dark, is
unverified** (W1 owner-device deliverable).

Contrast of the favicon on browser tab grounds (WCAG 2.x, computed with `tools/palette.py`): light stone
`#a7722e` on a white tab 4.13:1, on an inactive light tab `#dfe1e5` 3.15:1; dark stone `#d7aa67` on
`#35363a` 5.65:1, on `#202124` 7.54:1; the arch is ≥ 10.01:1 everywhere.

### 2.2 Colour versions

| Version | Arch | Stone | Where |
|---|---|---|---|
| Light | ink `#15171b` | bronze-fill `#a7722e` | public surfaces on light, favicon (light scheme) |
| Dark | `#e8eaec` | `#d7aa67` | public surfaces on dark, favicon (dark scheme) |
| Mono | `currentColor` | `currentColor` (same ink, the gap keeps it separate) | product chrome at rest, system tints, the macOS menu bar extra (template), single-ink print, embossing |

**The mark is the window's live light.** In the product the sidebar symbol (20 px) is drawn mono; while
anything is live in that window (an answer streaming, an agent working) its stone takes `--bronze-fill`,
statically, with no loop. That is the one place the brand and the live state meet, inside the bronze
budget (TOKENS §1.4).

### 2.3 Clear space, minimum size, misuse

- Clear space: the stone's diameter on every side of the symbol (20 units at the large master); for the
  lockup, measured from the symbol and the wordmark's cap height.
- Minimum: symbol 16 px (use the 16 master); wordmark small cut from 12 px cap height (≈ 17 px rendered
  height); lockup 16 px symbol height.
- **Never**: draw the arch without the stone; animate the stone except the three moments in §6; recolour
  the stone outside bronze and mono; put the symbol on a busy photograph; add glows, gradients, bevels,
  reflections or 3D; rotate or skew; outline the arch; use the symbol as a button, spinner, avatar for
  Alevr's answers, bullet, watermark or page backdrop; place the symbol inside the transcript or in every
  page header.

## 3. The wordmark

"Alevr" in **Geologica** (Monokrom, SIL OFL 1.1), CRSV 1 (single-storey soft forms), SHRP 0, slnt 0,
outlined to paths (never re-typed live, so it looks identical on every platform). Two cuts (d2's small-cut
idea in d3's face):

| Cut | Use | Weight | Tracking | Kerning (em) | Files |
|---|---|---|---|---|---|
| **Large** | rendered height above 24 px: landing nav lockup, sign-in, About, print | 450 (d3 was 540) | −1.2 % | A–l +0.020 · e–v −0.004 · v–r −0.008 | `wordmark-large-{light,dark}.svg`, `lockup-{light,dark}.svg` |
| **Small** | 24 px and below: phone drawer header, footers, share images' small lines, the menu bar | 520 | +1.0 % | A–l +0.030 · v–r −0.004 | `wordmark-small-{light,dark}.svg`, `lockup-small-{light,dark}.svg` |

Why: at 540 the mark was "heavy and generic-geometric" next to the arch (J-owner must-fix). 450 lets the
counters breathe at display sizes; the A–l junction is opened (+0.020 em, was +0.012) so the A's right
diagonal and the l's stem stop reading as one mass; the small cut is heavier and looser so it holds at
20 px (`shots/brand-check-light.png` row 3 shows d3 540, large 450 and small 520 side by side).

Lockup: symbol height = 1.16 × cap height (the arch overshoots the caps as round letters do), gap 0.42 ×
cap height, the symbol's baseline on the wordmark's baseline.

Licensing: the SIL OFL allows using the font to make a logo; an outlined wordmark is artwork, not a font
redistribution. `OFL-Geologica.txt` ships beside the display font file.

## 4. App icon (macOS 26, iOS 26)

Flat renders at 1024 (the OS masks): `app-icon-{default,dark,light,tinted}.svg`. Symbol width 56 % of the
canvas, optically raised 1.2 % (an arch's mass sits low).

| Appearance | Ground | Arch | Stone |
|---|---|---|---|
| Default | basalt `#202225` (OKLCH 0.250 0.006 255) | `#eef0f3` | `#c4914a` (5.69:1 on basalt) |
| Dark | `#0e1012` | `#e4e6e9` | `#d6a866` |
| Light alternate (**iPhone only**, the one alternate app icon) | `#eef0f3` | `#202225` | `#a7722e` |
| Tinted / Clear | system | white, luminance 100 % | luminance 74 % |

**Icon Composer** (`native/Brand/Alevr.icon` is rebuilt; the four glass blades are retired):

| Layer | File | Settings |
|---|---|---|
| Background | `app-icon-layer-ground.svg` | fill only, no gradient in the source |
| Group 1 · Arch | `app-icon-layer-arch.svg` | Liquid Glass on, specular on, translucency 0, shadow neutral, blur 0 |
| Group 2 · Stone | `app-icon-layer-stone.svg` | Liquid Glass on, specular on, translucency 0, shadow neutral; in front of the arch |

The stone in its own front group is the point: the system renders its depth and edge light, so the lift
the brand describes is drawn by the OS, never painted. **The Icon Composer render is unverified** (needs a
Mac with Icon Composer; W1 owner-device deliverable). **Alternate icons**: iOS 26 already renders every
icon in Default, Dark, Clear and Tinted, so the only alternate worth shipping is the Light ground, on iPhone
(`UIApplication.setAlternateIconName`, with `ASSETCATALOG_COMPILER_ALTERNATE_APPICON_NAMES` in W1's
contracted `project.yml` edit). macOS has no alternate-icon API for an app (only the running Dock tile can
be swapped), so the Mac gets none (TOKENS §1.7).

## 5. Favicon, share images, web app icons

- `favicon.svg`: the 16 master, colours switched by `prefers-color-scheme` (light `#15171b` / `#a7722e`,
  dark `#e8eaec` / `#d7aa67`). `favicon-mono.svg` for contexts that force one ink.
- W1 replaces `src/app/icon.svg`, `src/app/icon1.ico` (16, 32, 48 from the 16 / 24 / large masters),
  `src/app/apple-icon.png` (180, from the default app icon), `src/app/manifest.ts` icons (192, 512, maskable
  with 20 % safe zone), and `src/app/opengraph-image.tsx` / `twitter-image.tsx` (the granite `--base`
  ground, the lockup large cut, one Geologica line set from the static 460 TTF, because `next/og` cannot
  read WOFF2; today it loads `public/fonts/newsreader-regular.ttf` the same way; no generated imagery).
- `public/brand/*.webp` generated "photographic" art and the public prompt files
  (`public/brand/auth-continuation.prompt.txt`, `public/brand/home-editorial.prompts.txt`) are deleted
  (WA §4.10).

## 6. Where the brand appears, and where it must not

**Appears**: the favicon; the sidebar top-left (20, mono; stone bronze while live); the phone drawer header
(22, the 24 master); the macOS menu bar extra (mono template); About; the landing nav (lockup); sign-in
(lockup, large); the app icon; share images; the voice bar (COMPONENTS §13). **The stone moves three
times**: the first-open rise (the sidebar mark's stone rises 4 px → 0 on `lift`, once per launch); as the
`LiveDot`, the 1.6 s lift loop for the first 5 s of each step; and in the voice bar, where it rises 0–6 px
with the voice level (ink while Alevr listens, bronze while it speaks). Nowhere else.

**Never**: the symbol inside the transcript, on every page header, as an avatar for Alevr's answers, as a
loading indicator, or as wallpaper. No dot-matrix galaxies behind pages, no generated art, no project
cover art (the galaxy is retired; open question in IDENTITY_V2 §20).

## 7. Colour (brand names → token roles)

| Brand name | Value | Token |
|---|---|---|
| Basalt | `#202225` (app icon ground) | — (app icon only) |
| Ink | `#15171b` / `#e8eaec` | `--ink` |
| Granite (the ground; was "Stone" in d3) | `#eceff2` / `#0c0d0f` | `--base` |
| Paper | `#fdfefe` / `#18191b` | `--stage` |
| Bronze (the stone) | text `#775020` / `#dfb97e`; mark `#a7722e` / `#d7aa67` | `--bronze`, `--bronze-fill` |
| Signal blue | `#1c55b2` / `#8dbbff` | `--signal` (needs you only) |

Bronze is the colour of cast metal, not of light: flat, small, never a gradient, wash or glow, and never a
button, link, selection, fill or status. On cool granite it is the palette's only warm note, which is what
makes it read as "live" (the warm-stone alternative is the owner's call, IDENTITY_V2 §20 Q2).

## 8. Trademark clearance (unverified)

No search has been run. Before W1 ships the mark publicly, counsel must run a clearance search in Nice
classes 9 and 42 (and 35 if the landing sells subscriptions) covering: arch and doorway marks, marks with
a dot or circle inside an arch or "n" shape, AI-company marks (the AI sector is crowded with simple
geometric marks), and the word "Alevr" with the mark. Record the result in `docs/design/identity-v2/` before
W1's production deploy. This is a blocking gate for W1, not for W0.
