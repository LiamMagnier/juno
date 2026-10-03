# Refinement brief (2026-10-03)

The owner, verbatim: "Rework Project, project setting, library, search panel, app, skills, routines, instruction, sub-menu ('+' menu, account menu …), orbit page design in terms of UI / UX and motion design… The new design should follow the brand identity but since it's useful features that don't need a lot of text and images … it should be premium but clean / sleek / minimal something a billion dollar company would have build … Rework icognito chat design, rework agent design … Keep them as simple as they are right now but upgrade the overall design to make them feel more in the brand identity."

They REJECTED a previous pass that recomposed pages (big editorial heroes with three figures, decorative charts, fanned preview stacks, margin-column sections, numbered labels). Do not do any of that. Keep every page's current structure, content and simplicity; upgrade the craft.

## Read first
- docs/rework/brand/BRAND_IDENTITY.md (the brand spec)
- The current page in its dev gallery (screenshots below), and its source.

## The language
- Graphite primary, quiet tonal surfaces (`surface-raised`: muted fill + 6% hairline). No new colours. Presence blue only for something live.
- Type: the page title stays the serif (as Projects / Library already do via AppPageHeader); everything else Inter on the type scale (text-body 15, text-ui 13, text-caption 11, text-label 12, text-heading 18, text-title 22). eslint rejects text-[Npx].
- Page header: one pattern everywhere, the existing `AppPageHeader` (serif title, one-line muted lede, actions on the right). No hero figures, no hero visuals, no `PageHero` (src/components/app/editorial.tsx) on these pages.
- Radius tokens only: rounded-control 8 (rows, menu items, small buttons), rounded-field 10 (inputs), rounded-card 12 (cards, tiles), rounded-menu 14 (menus, segmented shells), rounded-panel 16 (dialogs, sheets), rounded-composer 22. Strict concentric rule: inner radius = outer radius − padding (menu 14 with p-1.5 holds 8px items; card 12 with p-1 holds 8). Equal insets: a box's left padding equals its top padding.
- Controls: one height per row (h-9 desktop, coarse:h-11), hairline borders `border-border/60`, hover = tonal fill, active = `surface-key` or graphite. Segmented controls: rounded-menu shell p-1, rounded-control thumb that slides (framer-motion layoutId).
- Cards/tiles: `surface-raised rounded-card`, hover: border to foreground/12 + translateY(-1px), 160ms ease-out-soft; press scale .99.
- Menus/popovers: `surface-float rounded-menu p-1.5`, items h-9 px-2.5 gap-2.5 rounded-control, 16px muted icons that brighten on hover, shortcuts as mono text-caption on the right, separators as inset hairlines (mx-2.5), section labels text-caption muted. Entrance: scale .97 → 1 + fade from the trigger side (transform-origin), ~180ms, reduced-motion = fade only.
- Motion: purposeful and quiet. Page content rises 6px on mount (`motion-safe:animate-rise-in`), list items stagger 25-35ms capped at ~8 items, state changes cross-fade. Springs: stiffness 420-520, damping 36-40. Everything reduced-motion safe.
- Copy: keep existing copy; if you must write any, no em dashes, no filler.
- No status pills or decorative dots. No numbered labels ("01 · Teach"). No div-based fake previews.

## Rules for helpers
- Keep ALL behaviour, data flow, props, keyboard handling, aria labels and tests. Restyle; don't remove features.
- Edit only your own files. editorial.tsx/.css, globals.css, tailwind.config.ts and src/components/ui/* are shared: don't edit them (if you truly need a shared change, describe it in your report instead).
- Never start, stop or restart the dev server (it runs on :3100); never open /dev/run. Screenshot with: `node .claude/local-tools/shot.mjs "<url>" <out.png> 1440 900 "" dark` (and light, and 390 wide).
- Verify: `npx tsc --noEmit -p tsconfig.json` (your files), `npx eslint <your files>`, and the tests in tests/ that mention your files (`npx tsx --test <files>`). Fix what you break, including tests that only pinned old markup.
- Do NOT git commit or push. Report: files changed, what changed, checks, and before/after screenshot paths (dark 1440 at least).

## Addendum: the homepage is the bar (owner, 2026-10-03)
The owner, verbatim, about the public homepage (src/components/home/*, "Go further." hero with the hairline orbit construction): "the homepage with this design look so good i want the same attention to detail and beautiful design on all thoses pages".
Study src/components/home/alv-base.css, hero.tsx and product-window.tsx for the craft, then bring that finish to your pages WITHOUT recomposing them:
- Type: tight, confident tracking on the serif title (letter-spacing about -0.03em, optical sizing on), calm muted ledes, generous air above and below headers.
- Buttons: the homepage pair, a solid light primary (in dark mode: near-white fill, dark ink) and a hairline secondary, same height, 8px radius, crisp press (scale .97), arrow nudges on hover where an arrow exists.
- Hairlines: 1px lines at foreground 7-12% for structure instead of heavy fills or borders; surfaces stay quiet.
- Precision: everything on the spacing grid, aligned edges, consistent heights, nothing a pixel off; the same ease (cubic-bezier(.16,1,.3,1)) for entrances.
- Product windows on the homepage (product-window.tsx) show exactly how app surfaces should look at their best: match that finish.
Still: no hero figures, no charts, no new features or copy.

## Addendum 2: the space-and-mathematics backdrop (owner, 2026-10-03)
The owner, verbatim: "what i like about the homepage is that background that mix space & mathematics". It now exists as ONE shared piece: `AppPageHeader` takes `backdrop` (src/components/app/page-backdrop.tsx draws the homepage's orbit construction faintly behind the header, confined to the header band and faded out before the toolbar). Every page in this pass uses `<AppPageHeader backdrop ... />`. Do not draw your own orbits or copy the construction; do not edit page-backdrop.tsx (ask me if it collides with something on your page). Pages without an AppPageHeader (Apps, overlays, menus) don't need it.

## Addendum 3: layout and placement (owner, 2026-10-03)
The owner, verbatim: "keep improving , improve the layout , the placement and everything". You may now improve layout and placement too, as long as each page stays simple and keeps its content: where controls sit (toolbars aligned to the title column, actions on the title line, filters and search grouped logically), column widths and max widths that read well at 1440 and 390, consistent vertical rhythm between header, toolbar and content (e.g. 32/24/16), alignment of every edge to one grid, empty states centred in the content area, and sensible responsive collapse. Still no heroes, figures, charts or new features.
