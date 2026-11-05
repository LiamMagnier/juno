# Alevr redesign: the constraints (components, menus, composer, icons, motion)

Read-only map of `/home/user/juno` at `parity-base`, 31 Oct 2026. "Alevr" is the product name and "Juno" is the repo codename (`brand/no-codename` is a lint error in prose).

## 0. Which source wins (the docs disagree)

The order below runs from highest to lowest authority. Where two sources conflict, trust the live token, not the prose.

1. **Live tokens.** `src/app/globals.css` (colour, motion, shell and gesture values, composed surfaces) and `tailwind.config.ts` (radius, type, spacing).
2. **`docs/audit-2026-10-29/DESIGN.md`**, then **`docs/design/UI_UX_MOTION_SPEC_2026-10.md`** (wave 2, "Editorial Calm"). Most of its tokens have shipped.
3. **`FLAT_UI.md`** (the material law), **`ICONS_AND_MOTION.md`** and **`PREMIUM_AUDIT.md` §3** (the composition rules).
4. **Out of date.** `docs/JUNO.md` §3 still describes the old system:
   - warm paper and coral;
   - Archivo;
   - radius 10/12/14/16/20;
   - a 12px-blur glass menu.

   `SOFT_UI.md` and `REVIEW_2026-09-02.md` are historical records only.

**Drift to know about:**
- **Composer radius.** It ships as **26**, with action 16 and control 14 (`2dabe67b1`). The spec, the native doc comments and the parity budget (`e2e/support/budgets.ts`: composer 22, disc 12) still say 22. That gate is report-only, so nothing fails.
- **Tooltip delay.** It ships as 200 ms intent and a 400 ms skip window. `ICONS_AND_MOTION.md` says 300/400 and the spec says 500/300.
- **`.overlay-glass`.** It is now opaque, despite its name.
- **Native icon script header.** `scripts/generate-native-icons.mjs` still says Phosphor, but icons are outlined from the web's own `juno-icons` family.
- **Swift `JunoRadius` comments** still give the old px numbers. The values themselves come from the generated file.

---

## 1. Hard constraints (MUST respect)

### 1.1 Product and brand
- **One visual identity and one motion vocabulary** across web, Mac and iPhone. Canonical web tokens generate the native palette and motion. Each platform keeps its native navigation, touch targets and accessibility behaviour (`PRODUCT.md`).
- **Direction:** quiet, premium, sleek and modern, with restrained blur and glass.
  - Grok Bot, ChatGPT and Meta Muse are references for principles only.
  - No vendor artwork, copy or invented capabilities.
- **Behaviour the redesign must preserve:**
  - model choice;
  - task execution, approvals, costs, cancellation, ownership and durable history;
  - composer send integrity: synchronous send ownership, the draft session across landing→dock, no double submit.

### 1.2 Token pipeline (one source → TS + Swift)
- **Where values live.**
  - Colour, motion, shell and gesture values are authored only in `globals.css`.
  - Radius, type and spacing are authored only in `tailwind.config.ts`.
  - No raw hex in components. `wave2/no-raw-presence-hex` catches presence hex; JUNO.md forbids the rest.
- **What `scripts/generate-design-tokens.ts` accepts.** Any other shape is a hard error.
  - Colours: HSL triplets or `var()` aliases (optionally `/ alpha`).
  - Radii: px. A `calc` value is skipped.
  - `fontSize`: rem or `clamp(rem, rem + cqi|vw, rem)`.
  - Spacing: rem, from the fixed `SPACE_STEPS` list.
  - Springs: `--spring-<name>-params: <visualDuration> <bounce>`. The generator writes the CSS `linear()` twin back between the `@generated-springs` markers.
  - Shell and gesture tokens: the named list must exist.
- **Four appearances:** light, `.dark`, and high contrast (`@media (prefers-contrast: more)`) in light and dark, plus the `html[data-contrast]` in-app toggle.
- **`design:tokens:check`** runs in `native.yml` and `native-parity.yml` and compares the digest. Every token change ships its regenerated `tokens.generated.ts` and `JunoGeneratedTokens.swift` in the same commit.

### 1.3 Colour means state
- **Primary control:** graphite `--primary` (light ink in dark mode).
- **Status colours:**
  - **Presence** (ultramarine) means live only.
  - **Signal** (ember) means "needs you". It is a glyph and badge colour; its text form `--signal-ink` sits only on background, card or popover.
  - **Destructive** means blocked or failed, always with a circle-x.
  - **`--attention`** is for budget, limit and offline warnings only.
  - **Success** is for diffs and "Saved" only, never a status.
- **Accents** (7 presets plus custom hex) fill only the user's own controls and never paint status.
- **Status mapping.** Every status consumer reads the `--status-*` role tokens, and every status carries a glyph and a word.
- **State ladder:** rest → hover `--accent` → on, selected or held `--selected`, each one rung deeper. Sidebar rows use `--sidebar-hover` and `--sidebar-selected` as fills only, with no edge. `--secondary` is a fill, never a state.
- **Text on fills.** Text on a hover or selected fill uses `--muted-foreground-on-fill` or foreground (`wave2/no-muted-on-fill`). `--ink-tertiary` is never used for text.
- **Text-colour tokens never carry opacity** (`wave2/no-text-token-opacity`).
- **Boundaries.** `--border` and `--hairline` are decorative. `--input` and `--ring` identify controls and must reach at least 3:1.
- **Contrast matrix** (`scripts/check-contrast-matrix.ts`, enforced in CI) measures every pair in all four appearances:

  | Pair | Floor |
  |---|---|
  | Text | 4.5:1 |
  | High-contrast muted and body text, on every ground | 7:1 |
  | Glyph inks (presence, signal, destructive, success), on every ground | 3:1 |
  | Control boundaries | 3:1 |
  | Signal vs destructive under simulated deuteranopia | 2.0 apart |

  The recorded failing pair, muted on `--selected` (4.32), must *stay* recorded as failing. Do not "fix" it by moving the ground.

### 1.4 Material and elevation (FLAT_UI)
- **Flat in-flow content.** An in-flow surface is its fill plus a 1px hairline, with at most a 1px contact shadow. Only out-of-flow layers (menus, popovers, dialogs, toasts, sheets) carry `--shadow-float`.
- **The transcript stays flat:** no depth, gloss or glass.
- **Composed classes are the only way to draw depth:** `.surface-{raised,raised-lg,inset,float,key}`, `.control-{neu,primary}` and `.composer-surface`.
  - A raw `shadow-[…]`, `bg-*`, `border-*` or `backdrop-blur-*` on a floating layer silently beats the material, so it counts as a fork.
  - Shadows are cut from `--shadow-ink`, never from `--foreground`, which produces a white halo in dark mode.
- **No `backdrop-filter` in product chrome** (spec D15, lint).
- **No blur in any entrance** (lint, plus a Playwright check).
- **Native glass** sits on the control layer only: five Mac places (composer cluster, ⌘K panel, find bar, toast host, Quick Entry). Content stays opaque, and Reduce Transparency switches to an opaque fill. `native:design:check`'s glass gate ratchets this.

### 1.5 Geometry
- **Radius ladder.** Live values:

  | Rung | px |
  |---|---|
  | micro | 2 |
  | sm | 4 |
  | xs | 6 |
  | control (= md) | 8 |
  | field | 10 |
  | card (= lg, popover, surface, bubble) | 12 |
  | menu | 14 |
  | panel | 16 |
  | composer-control | 14 |
  | composer-action | 16 |
  | composer | 26 |
  | stage (marketing only) | 28 |
  | bubble tuck | 8 |
  | full | — |
  | logo | 24% |

  - `design-system/no-arbitrary-radius` is an error and autofixes. Bare `rounded` is banned.
  - **`design-system/concentric-radius`** is an error: a child's radius is the parent's radius minus the parent's padding. Use `nest-<rung>` + `nest-p-<n>` + `rounded-inner`.
- **Stacking:** named z-rungs only (`no-ad-hoc-stacking` is an error): `z-popper` 55 > `z-modal` 50, `z-toolbar` 60, `z-toast` 70.
- **Spacing and gutters:**
  - 4px base;
  - 16px panel gutters;
  - page gutters 16 / 24 / 32 at <640 / 640–1023 / ≥1024px;
  - size by the container, not the viewport.
- **Targets:**

  | Context | Minimum |
  |---|---|
  | Anywhere | 24×24 |
  | Web, fine pointer | 32 |
  | Web, coarse pointer (`coarse:`, `hit-44`) | 44 |
  | Mac | 28 |
  | iOS | 44 |

  Menu rows are 32 (44 on coarse pointers). Fields are `h-9` (`coarse:h-11`).

### 1.6 Type
- **Faces have fixed jobs:**
  - **Inter** for every control and all reading text.
  - **Newsreader** only for greetings, page h1s, empty-state titles, sign-in and onboarding titles. Brand decision D-027 restored it.
  - **JetBrains Mono** for numbers, times, receipts, paths, keycaps and `text-label` metadata.
- **Case:** no all-caps; sentence case.
- **Floor:** 12px on the web. 11px `text-kbd` is allowed only in Kbd and Badge.
- **Transcript and composer chrome law:** exactly three sizes, `reading` 16, `ui` 13 and `label` 12 (`wave2/transcript-chrome-type`).
- **Scaling:** rem everywhere for the text-size setting (radii, borders and icons stay px).
- **Native:** text goes through `junoFont` only (type gate).

### 1.7 Focus
- **One ring:** a 2px `--ring` outline at a 2px offset (3px in high contrast), **keyboard-only**, via `html[data-modality]`. This is also an owner rule.
- **Fields:** the edge darkens on pointer focus; the ring appears only on keyboard focus (`kbd-focus:`).
- Never remove an outline without a replacement. Under forced colours, use the system Highlight. `tests/focus-keyboard-only.test.ts` checks this.

### 1.8 Icons
- **One module.** `src/components/ui/icons.tsx` is the only import (`no-restricted-imports` is an error; Phosphor and lucide are banned).
- **Export names are stable.** About 242 exist, and native consumes them as `ph.*` and `juno.*` symbol assets (the `JunoIcon` enum appears in about 162 Swift files).
- **No hand-drawn interface SVG and no emoji.** Brand and provider logos, data visualisation, the dot signature and the live marks are exempt.
- **Sizes:**

  | Size | px | Use |
  |---|---|---|
  | `size-3` | 12 | dense metadata |
  | `size-3.5` | 14 | inline with caption |
  | `size-4` | 16 | default |
  | `size-4.5` | 18 | sidebar destinations |
  | `size-5` | 20 | large touch, headers |

- **Fill** means on or selected, never decoration.
- **Ink:** chrome glyphs are muted at rest and take foreground with their row (`menuGlyphInkClass`).
- **Hover articulation** plays on destinations only, under a fine pointer, never with reduced motion.
- **iOS and Mac draw the web's icons, never SF Symbols.** The iOS gate is a hard zero; the Mac gate ratchets.
- **The galaxy is the one working mark.** Spinners appear only inside the button just pressed.

### 1.9 Motion
- **Durations are a closed ladder:** **70 / 120 / 160 / 220 / 360 / 560 ms** (`wave2/off-ladder-duration`, `RUNGS_MS`).
  - Waits and holds are named families (`--delay-*`, `--hold-*`, `--loop-*`, `--settle-*`, `--stream-*`, `--stagger-*`).
  - Curves are the named `--ease-*` set.
  - Springs are defined once (snap, standard, layout, emphasized, reward, articulate). `src/lib/motion.ts` consumes the generated values.
- **Exits** take the rung below their entrance, on `ease-in`.
- **What may animate:** only transform, opacity, clip-path and grid-rows.
  - Width or height may animate in four named cases only, with no overshoot: the sidebar width fold, dock and inspector resize settle, composer height, and the Quick Entry panel height.
  - Never use `transition-all`.
- **Interaction feedback:**
  - Hover is a tonal cross-fade.
  - Press is scale 0.97 over 70 ms on small controls only; large surfaces press tonally.
  - Floating layers pop in from their trigger (`origin-popper`).
  - Tooltips use their own quieter pair.
  - Stagger at most 4 items, and never for something opened from the keyboard.
- **Loops are for live state only.**
  - At most 3 galaxies animate, and they pause off screen.
  - The agent face's rest life (blinks and gaze) is the only idle exception.
- **Reduced motion has three tiers.** Tier A keeps opacity and colour, Tier B collapses travel via `--motion-shift` and `--motion-scale-from`, and Tier C stops loops.
  - Every keyframe needs a row in the tier table (`tests/wave2-p1-tier-table.test.ts`).
  - Per-element overrides sit behind `motion-safe:`.
  - Read the preference only through `@/lib/motion-preference` (`no-raw-reduced-motion` is an error). The in-app Motion setting offers System, Reduced and Full.
- **Native:** every animation names a `JunoMotion` token (the motion gate is at 0 violations). Haptics follow spec §4.8.

### 1.10 Shared recipes and components (use them, don't fork)
- **`menu-recipe.ts`.** One shell (`surface-float overlay-glass z-popper origin-popper nest-menu`, `nest-p-1.5`, pop-in/out) and one row:
  - 32 px tall (44 on coarse pointers), `text-ui`, 16px glyph, `rounded-inner`;
  - press 0.985;
  - an open submenu keeps its fill;
  - the glyph lights with its row;
  - width ladder `w-56` / `w-72` only.

  The command palette is the deliberate exception. `.cmenu` (composer) and `.cv2-pop` (Code) are known forks.
- **`field-recipe.ts`.** Six `--field-*` roles (rest, hover, focus, keyboard ring, invalid, disabled), projected to Swift `JunoFieldSurface`.
- **`control-recipe.ts`.** `pressable` timing, keeping colour and opacity under reduced motion.
- **Existing primitives to reuse:**
  - `IconSwap` and `IconSwapSet`, the only glyph cross-fade;
  - `Collapse`, which unfolds through `grid-rows`;
  - `Button loading`, which keeps its width and is `aria-busy` but not dimmed.
- **Composition rules (PREMIUM_AUDIT §3):**
  - one question per surface;
  - at most two panes;
  - list rows are bare text until hover;
  - one trailing signal per row;
  - no meters in chrome;
  - "nothing in chrome moves except a fill";
  - a page opens with its name.

### 1.11 Composer
- **One shell.** Every composer (Chat, Code, Work, Compare) draws through `ComposerShell` and `.composer-surface`.
- **Controls row:** `+`, the model chip and the send circle, plus quiet dictate and voice buttons.
  - Tools, project and connectors live inside `+`.
  - An armed mode is a pill beside `+`, never a count badge.
- **Send circle.** It has one verb, send ⇄ stop. When disabled it is a neutral `--secondary` disc. The field stays live while a reply streams, and Enter queues the next message.
- **Exception:** the composer field's height tween is the documented one.
- **The shell contract** (`contracts/product/juno-shell-v1.json`) fixes the `+` menu rows (ids, labels, kinds, icons) and the primary-action faces (send, stop, voice, busy).
  - `shell:contract:test` holds `composer.tsx` and `composer-plus-menu.tsx` to it.
  - `shell:contract:check` regenerates the Swift enums and `Shell.xcstrings`.
- **Native.** The Mac `ChatComposer` and iOS `JunoMobileComposer` read the generated composer radius and use `JunoPressButtonStyle`.

### 1.12 Owner rules (recorded as "fixed" in the held identity-v2 spec, 30 Oct; treat as binding until the owner says otherwise)
1. Focus rings are keyboard-only, on every platform.
2. Orbit lists only busy agents and appears once in the sidebar.
3. No prompt suggestions or chips above the composer. Today's `home-starters.tsx` renders *below* the home composer. Identity-v2 wanted none above or below; check with the owner.
4. Pinned chats lead Recent.
5. Settings has exactly 12 sections. The shell contract lists 10 today; verify.
6. Agent faces stay flat. Shapes stay; colours may be retuned.
7. The name Alevr stays.
8. Copy principles, never pixels.
9. No invented citations; samples use neutral placeholders.

---

## 2. What can change, and at what cost

| Change | Web work | Native consequence | Gates that bite |
|---|---|---|---|
| **Value of an existing colour token** | Edit the light, dark and HC blocks in `globals.css`, then `npm run design:tokens` | Automatic: `JunoGeneratedColors` regenerates, no Swift edit | Contrast matrix in 4 appearances plus CVD; `design:tokens:check`; `tests/presence-token.test.ts` (hand hex twins such as `.voice-glow` must match presence) |
| **New colour token** | Add to `:root` and `.dark` (HC optional) and to the Tailwind colour map | A new generated Swift member appears for free | Add it to `GROUNDS`/`FILLS` in the contrast matrix if text sits on it |
| **Rename or remove a colour token** | Keep it as an alias | **Breaks Swift**. About 12 files read e.g. `foreground`, `mutedForeground`, `shadowInk`, `selected`, `fieldSurface`, `cmpWell`, `sidebarSelected`, `input`. `--sidebar-selected-border` survives only because native reads it | Swift build (macOS CI) |
| **Accent presets** | `src/lib/accents.ts` plus a `[data-accent]` block in light and dark | `JunoAccent.swift` cases in the same order, or the generator errors. Retiring accents means about 350 `junoAccent` references in 143 files | `design:tokens:check` |
| **Radius values** | `tailwind.config.ts` px; **update `RADIUS_TOKENS`, `SCALE_HELP` and the concentric table in `eslint-rules/design-system.mjs` in the same change**; fix the literal `26px` in `.composer-surface::after` | Flows through `JunoGeneratedRadius` → `JunoRadius`. Renaming or removing a rung breaks Swift | Radius/concentric lint (error); parity budget (report-only; already stale) |
| **Type rungs** | rem or clamp only; keep the 12px floor and the three-rung chrome law | Regenerated `JunoGeneratedType`; native type gate | Lint (`no-arbitrary-text` and `no-raw-text-size` are warnings); text-size scaling |
| **Spacing** | Tailwind spacing (rem); `SPACE_STEPS` is fixed | `JunoGeneratedSpace`; the native spacing gate ratchets | `design:tokens:check` |
| **Spring params, curves, timing tokens** | Edit params, then regenerate (twins are written into `globals.css`) | `JunoGeneratedSprings`, `Easing`, `Timing` update automatically | Tier B under reduced motion; design editor bundle |
| **New duration rung** (e.g. 80, 200, 240, 400) | `RUNGS_MS` in `eslint-rules/wave2.mjs`, `--dur-*`, Tailwind `transitionDuration`, `tests/tailwind-motion-tokens.test.ts`, the spec | Regenerated `JunoGeneratedDuration`; `JunoMotion` mappings | Lint everywhere: a **high**-cost change, because it reopens the closed ladder |
| **Shadows, elevation, composed surface classes** (`.surface-*`, `.control-*`, `.composer-surface`) | CSS only; cheap on the web | **Not projected.** Native `JunoElevation` and `JunoSurfaces.swift` are hand-written, so this is a manual port and no gate catches drift | `design:editor:check` (the Mac offline Design-editor bundle hashes `globals.css`, the recipes, `motion.ts` and `tailwind.config.ts`; rebuild with `npm run design:editor`) |
| **Recipes** (`menu-recipe`, `field-recipe`, `control-recipe`, `icon-swap`) | Edit once; every host follows | Native equivalents (`JunoFieldSurface`, `JunoPressButtonStyle`, menu style) are hand-ported; the native menus gate ratchets | `design:editor:check`; composer and menu unit tests |
| **Icon drawings** | `src/components/ui/juno-icons/{drawings,extra,catalog}.ts`; keep export names | `npm run native:icons` re-outlines the symbol sets | `native:icons:check`; sficons (hard zero) and symbols gates; `icon-articulation.test.ts` |
| **New icon export or concept** | `icons.tsx`, the catalog, `src/lib/app-icons.ts` | A new `JunoIcon` case and symbol set | `native:icons:check` |
| **Composer `+` menu contents, send faces, IA** | Edit `contracts/product/juno-shell-v1.json` and its strings (EN and FR) | `shell:contract:check` regenerates the Swift enums and `Shell.xcstrings`; the native composers must implement the new faces | `shell:contract:test`/`check`; the native-parity label check on web files the apps mirror |
| **New keyframe** | Read `--motion-shift`/`--motion-scale-from`; no blur; add a tier row | The native counterpart must use `JunoMotion` | Tier-table test; `pipeline.spec.ts` (no entrance blur, Tier B) |
| **Anatomy and layout inside the recipes**: row content, which tokens a surface uses, menu grouping, composer arrangement within the contract, a new component built on the recipes, the model picker layout | Free, within the rules above | Mirror by hand natively (behaviour parity is expected) | Visual review; report-only e2e gates (axe, parity, CVD) in `design-gates.yml` |

**How much is enforced today.**
- **Errors everywhere:**
  - radius;
  - concentric;
  - stacking;
  - the raw reduced-motion query;
  - icon imports;
  - the codename in prose.
- **Warnings only, except in the `eslint-rules/enforce/*.json` globs:** the wave 2 rules (duration ladder, text opacity, chrome type, blur, backdrop-filter, motion guards, presence hex, muted-on-fill).
  - Only `p1.json` exists. It covers `globals.css`, `src/lib/strings/**`, `accents.ts`, `brand/names.ts` and `tokens.generated.ts`, plus the native Generated folders.
  - So new CSS in `globals.css` must already be clean.
  - A redesign package should add its own `enforce/<pkg>.json` to ratchet its files to errors.
- **Enforced CI gates:**
  - `design:tokens:check`;
  - the contrast matrix;
  - `native:design:check` (9 ratchets: type, motion, glass, targets, prominent, menus, sficons, symbols, spacing);
  - `native:icons:check`;
  - `design:editor:check`;
  - `shell:contract:check`;
  - `design.lint` and `design.contrast-matrix` (from `e2e/wave2/p1-pipeline/gates.ts`).
- **Report-only:** the other `design-gates.yml` web gates (P0 enforces none).

---

## 3. Identity-v2 ideas worth considering (optional; held back, not to ship as-is)

Source: `git show c90bc4337:docs/design/IDENTITY_V2.md` (1,263 lines, 30 Oct, "d3 Sculpted"). There is a copy in this folder, `IDENTITY_V2.held.md`. Its appendices live under `docs/design/identity-v2/` in the same commit. It was held back in `b58795b23`.

**High cost or owner-sensitive (don't adopt wholesale):**
- A new palette: an OKLCH source, cool granite neutrals, bronze for "live", and **signal flipped to blue**. That last one changes a shipped meaning.
- Retiring all 7 accents.
- Geologica in place of Newsreader. The owner liked the serif greeting.
- Retiring the galaxy.
- A new brand mark (the Arch).
- A paper-stage-on-base composition and a source "margin" lane.
- An effects ladder of 80/120/160/200/240/400. This breaks the closed 70–560 ladder, its lint and its Swift tables.
- Renamed radius rungs (chip, sheet, composer 24).

**Worth borrowing. Each fits the current tokens or is cheap:**

*Menus and floating layers*
- **A visible keyboard ring in menus**: the fill plus a 2px inset ring. A fill alone measures about 1.07–1.13:1 and fails WCAG 1.4.11.
- **Disabled rows** stay focusable and readable, and show their reason as visible text.
- **One trailing slot per row**: shortcut, chevron, check or value.
- **Glyphs all-or-none per group.** User-made names (skills, projects) get none.
- **Submenus.**
  - Use one level only.
  - The first item sits level with the trigger.
  - Open after 100 ms of hover intent, with a 300 ms grace polygon.
  - **The trigger never runs a command.**
- **Context menus** reuse the kebab's items: right-click, Shift+F10 or long-press. Shift+right-click keeps the browser's menu.
- **Composer menus open upward and never cover the composer.**
- **On phones, menus become bottom sheets** with drill-in, a visible Close and a back row.
- **Keyboard-opened menus, selects and the palette appear instantly.** The current spec says opacity-only over 120 ms, so this is a small change.
- **The scrim never outlives its panel.**

*Controls*
- Never show disabled grey on an empty form; validate on press instead.
- Busy keeps the label (this already holds).
- Segmented thumbs get a 1px strong ring (at least 3:1).
- A switch's whole settings row is its hit area, and its accessible name is the title only.

*Composer*
- **Model token first**, beside the other mode tokens.
- **Persistent modes as removable tokens**, each with a full accessible name ("Web search, remove") and a 44pt remove target on touch.
- **Send has two states only, send and stop, and is never disabled.** On an empty field it focuses the field and announces "Nothing to send yet". This needs a contract change, because today's faces include voice and busy.
- **"Talk" as a named voice control**, and dictation as a mic adornment inside the field.
- **Typed text aligned to the reading column's edge.**
- **Code's device and permission controls** collapse into `+`, never into letter abbreviations.
- **Shadow only while content scrolls beneath.** An IntersectionObserver toggles a static shadow: no animation during scroll, and the composer stays opaque on iPhone.
- **A dashed drop-target edge**; no disclaimer row.
- **One model picker everywhere**, with Effort as a `menuitemradio` group.
- **The voice bar inside the composer** in place of the WebGL voice glow, so the transcript stays readable.

*Icons*
- **A stem-ratio rule:** icon line ÷ the paired text stem stays between 0.85 and 1.05.
- **Fixed metaphors:**
  - Research is a telescope, never a second magnifier beside Search;
  - Auto is a gauge;
  - Projects gets its own mark.
- **Drop hover articulation entirely.** Today it is already destinations-only.
- **Keep every export name** (242 → 243). This matches the current constraint.
- **Variable SF-symbol templates natively.** This costs a new outliner.
- Flat-cut terminals only make sense if the brand mark changes.

*Motion*
- **"The weight is in the shadow, not the bounce."** A lifted body arrives on a near-zero-bounce spring, and its shadow lands 60–80 ms later. This works with today's springs and rungs.
- **Consolidate the springs to bounce ≤ 0.10.** Today reward is 0.18 and articulate 0.15.
- **Instant selection in navigation.** Sidebar rows and tabs change instantly; only a control's own thumb moves.
- **Live loops stop 5 s after each step starts** (WCAG 2.2.2). Today the galaxy only calms after 20 s.
- **No per-token text animation.** A new block fades in once over 120 ms.
- **Reduced motion means fade-only**, and size or position changes become instant.
- **One choreography table per layer type**, with pointer-enter, keyboard-enter and exit columns. This is a good documentation format to adopt.

*Process*
- An owner-rules test.
- `tests/tailwind-class-resolution.test.ts`, which fails any class that resolves to nothing.
- Aliases with a legacy lint and a codemod for every renamed token.
- A per-wave `enforce/*.json` file.
- Before/after screenshots in light and dark, on desktop and phone.

**Where identity-v2 conflicts with what ships:**

| Topic | Identity-v2 | Today |
|---|---|---|
| Press | no scale on press | 0.97 dip |
| Tabs | instant underline | thumbs spring |
| Tooltip delay | 600 ms | 200 ms |
| Focus ring colour | ink | `--ring`, retuned per accent |

Settle each of these deliberately rather than by accident.
