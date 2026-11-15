# Web design audit, measured (15 Nov 2026)

Read-only audit of a production build (seeded QA account) against **universal
design rules** — Apple HIG and Material 3 targets (44 pt / 48 dp touch, 24 px
WCAG 2.5.8 minimum), WCAG 2.2 AA contrast (4.5:1 text, 3:1 UI parts and
boundaries), a modular type scale with 45–75 characters per line, a 4/8 px
spacing grid, Gestalt similarity and alignment, concentric radii (inner =
outer − inset), one icon size and stroke per context, one primary action per
area. `docs/design/direction-2026-11/DIRECTION.md` was used only for intended
token values. Measured with Playwright (`getComputedStyle`,
`getBoundingClientRect`) at 1440×900 light and dark and 390×844.

## Diagnosis

1. **`src/components/ui/signature.css` overrides the token system** with
   triple-specificity selectors: menus radius 18, rows 36 tall / radius 12 /
   gap 11; sidebar rows 34 / radius 10 / gap 11; the user bubble on the
   composer radius. Its own comments state other numbers.
2. **Controls exist in 4–8 versions**: no single primary, page title, search
   field, segmented control or close button (114 distinct interactive
   signatures across 30 routes).
3. **Icons render at 6 sizes and 8 stroke weights**: `icons.tsx:92` derives
   the stroke from the size class, then CSS resizes the glyph
   (`app-sidebar.tsx:2495` `[&_svg]:size-[18px]`, `signature.css:262-266`).
4. **Spacing and type sprawl**: 36.7% of 7,166 rendered padding/gap values
   are off the 4 px grid (11 px ×355); 96 font combinations; 15 radii; the
   CSS holds 45 font-size and 26 radius literals (TSX has one arbitrary
   radius).
5. **Reading measure**: 95 characters per line at 16/27.2 (line-height 1.7).

## Top 25, by visual impact

1. Eight page-title styles (Inter 44/600 ×2 trackings, Inter 60/400 on
   Memory, Newsreader 48/50/68/31.7, Settings 17/600) —
   `app-page-header.tsx:155`, `memory/memory.css:24`, `upgrade-view.tsx:168`.
2. No single primary: indigo 32 and 36 px buttons, indigo and black send
   discs, black 48 px on public pages, primary-looking outlines; "on"
   switches are black though the accent setting says it colours switches —
   `ui/button.tsx:49`, `signature.css:24,105-111`, `code-v2.css:355`.
3. Icons 16/18/14/12/20/15 px, strokes 1.22–1.667 — see diagnosis 3; menus
   differ (`+` 18/1.22, row 16/1.4, account 18/1.58).
4. Composer row mixes three systems: glyphs 20/16/12 px, three chip styles,
   32 and 36 px controls, `+` glyph 4 px left of the text start, insets 11/13
   — `composer-shell.tsx:141,285,528,702`, `model-selector.tsx:568`.
5. Thread header: three button styles and two heights (Outputs 42×36
   outlined, Share 85×32 pill, 36 px bare icons) — `chat-view.tsx` Share,
   `session-outputs.tsx:274-281`, `continue-on-menu.tsx:30`.
6. `/code` send disc overflows its composer by ~14 px —
   `signature.css:828-836`, `code-v2.css:355`.
7. Transcript lines run to 95 characters; reading line-height 1.7 —
   `tailwind.config.ts:526`.
8. User bubble uses the 28 px composer radius on a two-line block with 10/16
   padding (reads as a pill); `rounded-bubble` (12) is unused —
   `chat/user-bubble.ts:17`.
9. Sidebar left edges at 16, 17, 20, 20.7, 47, 50 px —
   `app-sidebar.tsx:1455`, `product-switch.tsx:231`, `signature.css:583-585`.
10. Sidebar selection drawn as a raised white card with a shadow; nav rows
    34/radius 10/gap 11 vs Recent rows 32 — `globals.css:1669`,
    `signature.css:582-608`.
11. Five search-field styles — `search-field.tsx:46`, `settings-rail.tsx:97`.
12. Six segmented-control implementations (Activity segments 22 px, under
    24) — `segmented-control.tsx:82-91`, `product-switch.tsx:231,275`.
13. Menus override their spec (radius 18 vs 16, rows 36 vs 34, gap 11);
    Delete is the same ink as Rename until hover — `signature.css:208,250-258,296-299`.
14. Spacing off the 4 px grid (see diagnosis 4).
15. Type scale sprawl: sizes 8.5–68 px, weights 400/450/500/600, mono as a
    third UI voice; label token is 12/16.8.
16. Radius sprawl and non-concentric nesting (settings well 12 in a 16 card
    with 12–16 inset; agents tile 10 in 12 with 14 inset; favicon 6 in 12
    with 10 inset).
17. Contrast failures: "Not set up on this server" 2.91:1
    (`connector-directory.tsx:263`), Sources count 2.76:1
    (`sources-pill.tsx:275`), Regenerate chevron 2.43:1, permission chevron
    2.91:1, placeholders 4.30 / 4.46:1.
18. Boundaries too faint (WCAG 1.4.11): composer border 1.22:1, settings
    search fill 1.09:1, outlined buttons ~1.3:1.
19. Phone targets under 44: message actions 40, permission chip 32,
    segments 30–34, `/code` Add/More/Dictate 24 wide, footer links 32.
20. Desktop targets under 24: minimap ticks 28×14, Memory footer links,
    Share "Report", "Forgot your password?" (16.8 tall).
21. Duplicate controls: the tray under the empty composer repeats the `+`
    menu's Project / Apps / Skills; a "Mac app" pill adds a fourth chip style
    — `composer-tray.tsx:133`.
22. Close buttons in three styles; Share dialog's primary left-aligned in
    the body — `settings/page.tsx:117`, `share-dialog.tsx:411`.
23. 26 distinct box-shadows; four floating-panel recipes; shadows on in-flow
    parts (selected sidebar row, product-switch thumb, project tile).
24. Phone truncates the wrong things (account name "E2E T…", "Set up…").
25. Details: straight apostrophe in "You're on Pro"; titles cut mid-word
    without an ellipsis; mono used for labels and times.

## Keep

Focus outlines are consistent (44 of 45 Tab stops); menu nesting is
concentric; nav glyphs and labels share a centre within 0.5 px; message
actions are one 32 px family; dark-mode contrast holds; TSX is disciplined
(the sprawl lives in CSS); sign-in and the share page are the calmest
screens; empty states have an icon, a sentence and actions.

## Not covered

Tables and code blocks in the transcript (none seeded); hover and pressed
states; dark and phone captures cover 19 and 16 routes, not all.

## Status after the fixes (15 Nov 2026, evening)

Re-measured on the dev build (Chromium, 1440×900 light and dark, iPhone 13).

Fixed:

- **1, 3, 4, 5, 7, 8, 10, 11, 13, 21**: one page-title style (serif 28–32/400);
  one interface line (1.5px, non-scaling); one composer row (36px controls,
  one chip, the tray gone); one header button; a 42rem reading column at 1.6;
  the user bubble on `rounded-panel`; sidebar selection a flat tone; search
  fields one pill; menus at 16/36/12 with Delete red at rest.
- **2**: the accent is the one primary, everywhere: Chat's send disc, Code's
  disc, switches, the effort fill, the focus ring.
- **6**: Code's composer row fits at every width (the disc sat 14px outside the
  640 column); its disc wears Chat's faces.
- **12**: one segmented recipe, now also Library's filters and view toggle,
  which an override had left as an outlined box.
- **17**: the five contrast failures (Sources count, regenerate caret, chip
  caret, source index, unavailable connector).
- **19**: phone targets measured with their `hit-44` pads: Code's composer,
  the task-mode chip and Library's Recently deleted were under 44; all 44 now.
- **20**: `hit-24` for text links under 24px (sign-in, Memory footer, Report).
  The minimap's ticks stay: they stack edge to edge and scrolling reaches
  every turn.
- **22**: Settings' close is the shared CloseButton; the Share dialog's primary
  sits in its footer.
- **23**: one floating material (`--shadow-float`, `--float-edge`) for menus,
  popovers and dialogs; it was three recipes and a doubled dialog edge.

Also fixed beyond the list: the Settings rail on the sidebar's type (14px,
36px rows); Customize's tabs and Activity's filters fade at the edge that has
more instead of cutting a word in half; a phone's composer shows the model's
whole name before the context meter (from 25% of the window).

Open: **9** (sidebar left edges, not re-measured), **14** (spacing off the 4px grid), **15** (type sprawl beyond the rail),
**16** (radius sprawl), **18** (outlined buttons ~1.3:1), **24** (phone
truncation), **25** (titles cut mid-word, mono labels), and the placeholders
at 4.30 / 4.46:1.
