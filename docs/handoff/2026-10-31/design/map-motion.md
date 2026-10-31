# Motion map: Alevr web (read-only audit)

Repo `/home/user/juno` at `70661166c`, 2026-10-31. No source was modified. Each claim below is backed by a `file:line` reference.
Where a claim comes from the compiled stylesheet, it cites `.next/static/css/app/layout.css`, the last local build.
Where a finding is an inference and not something I observed, it says so.

Method:
- Read the motion layer: tokens, the Tailwind map, `lib/motion*`, the generator and the Swift projection.
- Read the primitives and the surfaces that use them.
- Ran the repo's own ESLint (wave2 rules) over every `src/**/*.css` and `src/**/*.{ts,tsx}` file: 2,684 files, **0 messages**.
- Wrote small read-only scanners (in the scratchpad `scripts/`) for patterns the lint cannot see.

The tree passes its own motion lint. Every problem below is one the lint was not written to catch.

---

## 0. Headline: the ten things that most hurt "attention to detail in every motion step"

| # | Severity | What | Where |
|---|---|---|---|
| 1 | **P0 missing** | The transcript turn entrance does not exist. The user bubble and the assistant turn carry `motion-safe:animate-turn-in`, but `turn-in` was retired from the Tailwind map. The compiled CSS has 0 rules for it, so the class is dead and both cut in. The replacement `animate-rise-user` (C1, "painted within 100ms") has **no call site**. Signature moment 1 (send) has no motion at all. | `src/components/chat/message-item.tsx:985`, `:1183`; `tests/wave2-p1-tier-table.test.ts:102,112` asserts the retirement; keyframe `rise-user` at `src/app/globals.css:3688` |
| 2 | **P0 jank / freeze** | `ROUTE_WAIT_MS = 450`. A sidebar chat click (view transition `thread`) can hold the whole window on a frozen snapshot for up to 450ms. Spec D23/C18 and the globals comment both say 80. | `src/lib/view-transition.ts:29,94`; `src/app/globals.css:4674`; spec `docs/design/UI_UX_MOTION_SPEC_2026-10.md:54,519,1069,1527` |
| 3 | **P1 inconsistent** | Three different menu motion languages ship side by side. **App menus:** `animate-pop-in`, 220ms on `--ease-spring`, scale 0.96, 4px travel, out 120ms; per-row fill fades in and out over 120. **Composer menus:** `.cmenu`, 220ms on a raw expo cubic, 6px travel, contents trail 70ms, a gliding highlight that animates `width`/`height`, out 120ms. **Code v2:** `.cv2-pop`, 160ms on out-strong, 2px travel, out at a computed **104ms**. | `src/components/ui/menu-recipe.ts:70-73,105`; `src/components/chat/composer.css:799-940`; `src/components/code/v2/code-v2.css:67,393-401` |
| 4 | **P1 janky** | Menu, select and list highlights trail the pointer. Rows use `focus:bg-accent` with `transition-[background-color,…] duration-fast` in **both** directions, so for 120ms two rows are lit when moving fast. Spec §4.5 rule 6 says "hover fill appears in 0ms and leaves over 120"; nothing implements it. Only the composer menus have a single gliding highlight. | `src/components/ui/menu-recipe.ts:105`; `src/components/ui/dropdown-menu.tsx:83,137,152,175`; `src/components/ui/select.tsx:104`; `src/components/app/sidebar-section.tsx:44-45` |
| 5 | **P1 inconsistent (a11y)** | Reduced motion is documented as "Tier A colour and opacity are NOT touched", but about 187 colour/opacity-only transitions carry `motion-reduce:transition-none` (352 uses of that class in all). Under Reduced, hover fills, switch tracks, progress fills, the action row, the jump button and segmented labels **snap**. | `src/app/globals.css:1082-1084`; e.g. `src/components/ui/switch.tsx:52,70,74`, `src/components/ui/progress.tsx:29`, `src/components/chat/message-item.tsx:1077`, `src/components/ui/segmented-control.tsx:253,258` |
| 6 | **P1 abrupt** | Skeletons have no show delay, no minimum hold and no cross-fade to content. `--delay-show` (200), `--hold-skeleton` (400) and C21's "160 cross-fade" have no consumer. A fast navigation flashes a skeleton for a few frames, then content cuts in. | tokens `src/app/globals.css:513,521`; `src/components/ui/skeleton.tsx:10-12`; route `loading.tsx` files (e.g. `src/app/(app)/loading.tsx:28-41`) |
| 7 | **P1 inconsistent** | The stagger rule is stated four ways. The token says at most 4 items (`--stagger-max: 4`). `staggerDelay()` caps at 10 (128 call sites). ICONS_AND_MOTION says about 8. Hand-rolled sites use 30/40/60/70ms steps with caps of 5, 7, 8 or none. | `src/app/globals.css:551-554`; `src/lib/motion.ts:241-260`; `docs/design/ICONS_AND_MOTION.md:181-183`; see §4.10 |
| 8 | **P1 inconsistent** | Timing tables disagree. Tooltip delay: CSS 200 vs `interaction.ts` 300 vs docs 300 vs spec 500. Phase hold: 600 vs 1000. Show delay: 200 vs 400. Stream pacing: tokens (20–800 graphemes/s, tail 250) vs pacer (40–4000, drain 0.38s, flush at once). | `src/app/globals.css:513-527,538-544`; `src/lib/interaction.ts:7-26`; `src/lib/motion.ts:301-305`; `src/lib/chat/stream-pacer.ts:28-44` |
| 9 | **P1 layout-shifting** | Several animations move layout properties. Sidebar collapse is a `width` transition with no `contain`, and the `alevr:layout-settled` re-measure from spec §4.5.7 does not exist. Incognito animates `margin` across the whole transcript column for 360ms. The private toggle animates `width`/`padding`, the transcript rail `top`, and the composer-menu glide `width`/`height`. | `src/components/app/app-shell.tsx:583`; `src/components/chat/chat-view.tsx:2788`; `src/components/chat/private-chat-toggle.tsx:66`; `src/components/chat/transcript-rail.tsx:143`; `src/components/chat/composer.css:912-916` |
| 10 | **P2 inconsistent** | The token set has three near-duplicate decelerates and one alias. `--ease-out-soft`, `--ease-spring` and `--ease-out-expo` are all `y1=1` cubics. `--ease-drawer` is byte-identical to `--ease-out-strong`. `--ease-spring` does not spring, and the Tailwind comment claims it has a "~2% overrun". The real springs (`--spring-*`, linear twins) are almost unused in CSS: 1 consumer each for reward and standard, 0 for snap, layout, emphasized and articulate. | `src/app/globals.css:471-497,573-584`; `tailwind.config.ts:936-938`; `src/app/globals.css:4388`; `src/components/code/v2/code-v2.css:227` |

---

## 1. Token inventory

All tokens live on `:root` in `src/app/globals.css`. `scripts/generate-design-tokens.ts` projects them to:
- `src/lib/design/tokens.generated.ts` (`DURATION`, `EASING`, `TIMING_TOKENS`, `SPRING`, `SHELL`, `GESTURE`);
- `native/Packages/JunoNativeKit/Sources/JunoDesignSystem/Generated/JunoGeneratedTokens.swift` (`JunoGeneratedDuration`, `JunoGeneratedEasing`, `JunoGeneratedTiming`, `JunoGeneratedSprings`).

It also writes the CSS spring twins back into globals.css (between `@generated-springs:begin/end`, `globals.css:572-585`).

`tailwind.config.ts:324-377` maps `ease-*` and `duration-*` to `var(--…)` with the literal values as fallbacks.

### 1.1 Durations (`--dur-*`, the "ladder", lint `RUNGS_MS` in `eslint-rules/wave2.mjs:39`)

| Token | Value | globals.css | TS `DURATION` / `lib/motion` | Swift | Reduced motion |
|---|---|---|---|---|---|
| `--dur-press` | 70ms | 498 | `press` 70; `transition.press` = 70 **on `outStrong`** (`src/lib/motion.ts:86`) | `JunoMotion.press` = 70 **on outSoft** (`JunoDesignTokens.swift:236`) | unchanged |
| `--dur-fast` | 120ms | 499 | `fast`; `transition.fast` on outSoft | `.fast` outSoft | unchanged |
| `--dur-exit` | 160ms | 500 | `exit`; `transition.exit` on `in` | `.exit` timingCurve(in) | unchanged |
| `--dur-base` | 220ms | 501 | `base`; `transition.base`; `transition.symmetric` = base on inOut | `.base` | unchanged |
| `--dur-slow` | 360ms | 502 | `slow`; `transition.slow` **on outExpo** (`motion.ts:94`) | `.slow` outExpo | → `--dur-base` (`globals.css:1185`) |
| `--dur-emphasis` | 560ms | 506 | `emphasis` on outExpo | `Duration.emphasis` | **unchanged**. Spec §4.7 caps Tier A at 220; not enforced. |

Off-ladder durations in use today. The lint cannot see any of them: computed values, numeric constants, library CSS and Tailwind defaults.

| Value | Where | Why the lint misses it |
|---|---|---|
| 150ms | Tailwind's default `transitionDuration` (no `DEFAULT` key in `tailwind.config.ts:368-377`); compiled `.transition{transition-duration:150ms}` (`layout.css:13950`, 75 rules). Hits the class strings that carry a `transition*` utility with no `duration-*`: `src/components/agents/agent-computer.tsx:856,870` and `src/app/dev/design/instrument/sidebar.tsx:113`. Also `src/components/chat/private-chat-toggle.tsx:68`, where `motion-reduce:transition-colors` re-sets the duration to 150 under Reduced, after `duration-base` | implicit |
| 150ms on raw `cubic-bezier(0.32,0.72,0,1)` and stock `ease-out` | `FLIP_DURATION_MS` (`src/lib/code-v2/thread-sections.ts:79`) → `src/components/app/code-work-list.tsx:90-91` | identifier, not a literal |
| 640ms on a raw expo literal | `MORPH_MS` (`src/components/chat/generation-frame.ts:85`) → `src/components/chat/generated-media.tsx:113` | identifier |
| 420ms enter / 240ms exit | galaxy mark (`src/components/brand/galaxy-field.ts:43-44`). 420 is on the spec's RETIRED list (§4.2); spec C1 says a 360 spiral. | identifier |
| 104ms and 143ms | `--cv2-exit-mid: calc(var(--dur-mid) * .65)` and `--cv2-exit-wide` (`src/components/code/v2/code-v2.css:67-68`, used at 398, 495, 513, 643, 653, 669, 695) | `calc()` |
| 160 / 220 | `--dur-mid` / `--dur-wide` still declared (`code-v2.css:41-42`). Spec §4.2 says retired. | local tokens |
| 40ms delay | `.run-label__item` `calc(var(--dur-fast) / 3)` (`globals.css:4336`) | `calc()` |
| 420ms | `CHIPS_ENTER_AFTER_MS` (`src/components/chat/home-starters.tsx:54`) | identifier |
| 180ms | memory notice `EXIT_MS` timer (`src/components/chat/memory-updated-notice.tsx:45`) | identifier |
| 300ms `ease`, 200ms `ease`, 400/500ms | sonner internals not overridden: promise-icon fade, loading-wrapper fade, swipe-out, stacked re-deal (`node_modules/sonner/dist/styles.css:163,338,590`) | library |
| 56ms | stream band `BAND_MS` hard-coded instead of `--stream-band`/5 (`src/components/chat/stream-text.tsx:37`) | identifier |

### 1.2 Easings (`--ease-*`, `globals.css:471-497`)

| Token | Value | Reduced | Notes |
|---|---|---|---|
| `--ease-out-soft` | (0.33, 1, 0.68, 1) | itself | House default. Tailwind's bare `ease`/`ease-out` are pointed here (`tailwind.config.ts:338-340`). |
| `--ease-out-strong` | (0.32, 0.72, 0, 1) | → out-soft | |
| `--ease-out-expo` | (0.16, 1, 0.3, 1) | → out-soft | globals itself warns "below ~440ms it front-loads so hard the motion appears instantly and then hangs" (`:454-456`). It is nevertheless used at 220 (palette `command-palette.tsx:279`) and at 360: `transition.slow`, toasts (`globals.css:4020-4023`), the composer handoff (`chat-view.tsx:1873-1876`), canvas VT (`globals.css:4706-4709`). |
| `--ease-in` | (0.4, 0, 1, 1) | itself | exits |
| `--ease-in-out` | (0.65, 0, 0.35, 1) | itself | A-to-B moves |
| `--ease-breathe` | (0.45, 0, 0.55, 1) | itself | loops |
| `--ease-out-back` | (0.34, 1.32, 0.64, 1) | **not flattened** (absent from `globals.css:1175-1186`) | The only overshooting cubic. Used by icon hover poses (`src/components/ui/juno-icons/icons.css:101-102,539-540`), where Swift and the spec say `--spring-articulate`. |
| `--ease-spring` | (0.22, 1, 0.36, 1) | → out-soft | Misnamed: no overshoot. `tailwind.config.ts:936-938` says pop-in has "a ~2% overrun", which is false. `lib/motion.ts:58` says "The Soft UI entrance: scale .96 → 1 on a long, overshoot-free settle", which is correct. |
| `--ease-drawer` | (0.32, 0.72, 0, 1) | → out-soft | **Identical to `--ease-out-strong`.** |

Raw curve literals that bypass the tokens, and so also bypass the reduced-motion flattening. The lint does not check easing.
- `tailwind.config.ts:916-917` (studio-swap, agent-arrive)
- `src/components/agents/agents.css:39`, `agents-home.tsx:64`, `agent-thread-header.tsx:313`
- `src/components/research/research.css:19` (`--rf-ease`, which spec §4.2 lists as RETIRED)
- `src/components/app/editorial.css:10,71-158,216`
- `src/components/app/announcement.css:19-20`
- `src/components/profile/profile.css:11`, `src/components/semantic/semantic.css:14`
- `src/components/code/v2/code-v2.css:65`
- `src/components/chat/composer.css:802,834` (`--cm-ease` and a raw `(0.4,0,1,1)`)
- `src/components/chat/composer.css:481,484` (`--alv-ease`, also RETIRED)
- `src/components/chat/thought-process.css:102` (0.45, 0, 0.25, 1)
- `src/components/brand/thinking-mark.tsx:78-79`, `src/components/chat/generation-frame.ts:87`
- `src/components/app/code-work-list.tsx:90-91`
- the galaxy's `easeOutCubic` (`src/components/brand/galaxy-mark.tsx:136`)

Loops on the wrong curve. globals says "`ease-in-out` the keyword is NOT --ease-in-out the token, and neither is the loop curve" (`tailwind.config.ts:929-931`).
- `editorial.css:98` (keyword)
- `memory.css:102` (keyword)
- `live-ui.css:49,378` (`--ease-in-out`)
- `thought-process.css:129` (keyword)
- `globals.css:4184` stream-progress (`--ease-in-out`)

### 1.3 Springs (`--spring-<name>-params`, `globals.css:566-584`; generator `scripts/generate-design-tokens.ts:251-302`)

| Spring | visualDuration / bounce | CSS twin settle | CSS consumers | framer consumers (`spring.*`) | Swift |
|---|---|---|---|---|---|
| snap | 0.18 / 0 | 256ms | 0 | 0. The palette highlight uses a literal `{stiffness 520, damping 40, mass 0.7}` (`command-palette.tsx:512`), which the spec §4.4 says snap replaces. | `JunoGeneratedSprings.snap`, unused by JunoMotion |
| standard | 0.22 / 0.05 | 272ms | 1: `code-v2.css:227`, run at `--dur-base` 220, so the twin is **compressed ~19%** | 10: tabs, segmented, surface-tabs, product-switch, composer tiles, settings rail | `.standard`, `.chatControl` (duplicate) |
| layout | 0.36 / 0 | **511ms** (longer than `--dur-slow`) | 0 | 5 (sidebar needs-you gap `app-sidebar.tsx:2252`, teach list) | `.layout`, `.chatLayout` (duplicate on `Duration.slow`) |
| emphasized | 0.36 / 0.10 | 377ms | 0 | 4: `teach-page.tsx:364`, `code-run-cards.tsx:75`, `save-status.tsx:43`. The spec reserves it for the home→dock handoff only, and the web handoff does not use it (WAAPI out-expo instead, `chat-view.tsx:1873`). | `.emphasized` |
| reward | 0.36 / 0.18 | 492ms | 1: favicon stack `.run-fav` (`globals.css:4388`). Spec §4.4: copy check, accent tick, attachment chip, thumbs-up. Swift says "exactly two sites product-wide: run completed, approval accepted" (`JunoDesignTokens.swift:296-300`). | 0 | `.reward` |
| articulate | 0.22 / 0.15 | 285ms | 0. Icon poses use `--ease-out-back`. | 0 | `.articulate` |
| interactive | stiffness 320, damping 30, mass 0.8 (ζ≈0.94, response≈0.31s) | n/a | n/a | 0 (`motion.ts:127`) | `interactiveSpring(response 0.32, damping 0.85)` (`JunoDesignTokens.swift:288`): not the same damping |
| sendMorph (Swift only) | 0.36 / 0.12 | n/a | n/a | n/a | `JunoDesignTokens.swift:335`. Spec §4.4 says 0.22 / 0.10. |
| drawerSettle (Swift only) | response 0.38, 0.88 | n/a | | | `JunoDesignTokens.swift:339`, not generated |

Reduced motion maps every spring twin to out-soft at `--dur-base` (`globals.css:1192-1206`). Framer spring call sites mostly hand-roll `reduceMotion ? { duration: 0 } : spring.x`, which cuts the fade too. See §5.

### 1.4 Timing families (`globals.css:507-556`; TS `TIMING_TOKENS`; Swift `JunoGeneratedTiming`)

| Family | Tokens | Consumers in `src/` (outside the generated file) |
|---|---|---|
| delay | `show` 200, `tooltip` 200, `tooltip-skip` 400, `hairline` 300, `action-row` 180, `greeting` 60, `insert-flush` 300 | **tooltip** and **tooltip-skip** only (`src/components/ui/tooltip.tsx:23-24`); `--delay-show` once (`projects.css:231`); the other four: **0** |
| hold | `phase` 600, `skeleton` 400, `check` 120, `reasoning` 1000, `arm` 500, `needs-you-max` 2000, `insert-max` 10000, `composer-idle` 2000 | **0** in CSS or `TIMING_TOKENS.hold.*` |
| loop | `beat` 1.2s, `loop` 2.4s, `calm` 4.8s, `breathe` 1.8s, `galaxy` 2.4s, `galaxy-calm` 4.8s | used in CSS. The galaxy itself runs on its own periods: `GALAXY_OMEGA0` 5.5s, wind 11s, core breath 2.8s (`galaxy-field.ts:37-42`), none of them a multiple of the 1.2s beat the tokens promise (`globals.css:528`). |
| settle | `min` 140, `max` 300 | 0 in CSS. `settleMs()` defaults to 140/300 as literals (`src/lib/sheet-gesture.ts:124`), and every call overrides with other literals: {160,260}, {120,240}, {160,280} (`src/components/ui/sheet-gesture.ts:159,177,393`). |
| stream | `band` 280, `tail-max` 250, `rate-min` 20, `rate-max` 800, `drain-tick` 50 | **0**. The pacer has its own `PACER` table (`src/lib/chat/stream-pacer.ts:28-44`): minRate 40, maxRate 4000, drain 0.38s, and "the caller flushes to the full text the instant the stream ends" (`:12`). |
| stagger | `row` 30, `tile` 45, `onboarding` 60, `max` 4 | CSS only. TS `STAGGER` re-declares 30/45/60 by hand with cap **10** (`motion.ts:241-260`). |
| shift | `row` 4px, `label` 0.4em, `dock` 24px | run UI only; **not projected** (`TIMING_FAMILIES`, `scripts/generate-design-tokens.ts:319`) |
| shell | `--galaxy-max-animating: 3`, `--drawer-parallax: 0.22`, `--drawer-dim` | **0 consumers**. No cap on concurrent galaxies; no drawer parallax (spec C9). |

The parallel hand-written tables, and where they disagree:

| Quantity | globals.css | `src/lib/interaction.ts` `TIMING` | `src/lib/motion.ts` `RUN_PACING` | Docs / spec |
|---|---|---|---|---|
| Tooltip delay / skip | 200 / 400 (`:514-515`) | 300 / 400 (`:12-13`) | — | ICONS_AND_MOTION §2.3: 300/400 (`:263-264`); spec §4.2: 500/300 (`:334`) |
| Pending show delay | 200 (`:513`) | 200 | `showDelayMs` **400**, `glyphDelayMs` 150 (`:302`) | MOTION_AND_THINKING 200/400 |
| Phase-word hold | 600 (`:520`) | `phaseMinHold` **1000** (`:18`); used by `live-line.tsx:44` and `realtime-voice.tsx:219` | `minVisibleMs` 600 | spec C1 600 |
| Stagger cap | 4 | — | 10 | ICONS_AND_MOTION "~8" (`:183`); spec D17/C6/C20: 4 |

The globals.css comment at `:510-512` says "`src/lib/interaction.ts` TIMING mirrors the delays and holds". It does not.

---

## 2. Projections and drift

- **CSS ↔ TS ↔ Swift: durations, easings and springs are exact.** They are generated, and `design:tokens:check` guards them.
- **Hand copies that drift.**
  - `lib/motion.ts` hand-copies `SHIFT`/`POP_SCALE`/`SWAP_SCALE` (`:145-149`) and `STAGGER` (`:241-260`).
  - `src/lib/interaction.ts` and `RUN_PACING` are independent tables (§1.4).
  - The Electron renderer has its own copy: 4 easings, 5 durations, no `emphasis`, no springs (`native/desktop-electron/src/renderer/lib/motion.ts:35-55`).
  - `src/components/design/host/editor.css:28-36` repeats every easing by value (deliberate, per `globals.css:1187-1191`).
- **framer variants that claim parity with CSS and do not have it.**
  - `variants.pop` exits at 160 (`transition.exit`, `motion.ts:176`); CSS `pop-out` exits at 120 (`tailwind.config.ts:940`).
  - `variants.stage` enters at 360 on outExpo (`motion.ts:179-182`); CSS `stage-in` enters at 220 on out-strong (`tailwind.config.ts:926`).
  - `transition.press` uses outStrong; CSS `.pressable` and Swift press use out-soft (`globals.css:1388`, `JunoDesignTokens.swift:236`).
- **Swift-only motion with no web twin.** `sendMorph`, `drawerSettle`, `chatLayout`, `chatControl` (`JunoDesignTokens.swift:318-341`). `platformFactor` 0.75 on macOS scales springs only (`:357-363`).
- **Generator comment out of date.** It says globals re-declares only three motion tokens under reduced motion (`scripts/generate-design-tokens.ts:71-73`). It now re-declares 4 easings, 1 duration, 6 springs, 6 settle times and parallax.

---

## 3. Engines in use

| Engine | Scale | Notes |
|---|---|---|
| Tailwind `animate-*` (`tailwind.config.ts:615-968`) | `rise-in` 165 sites, `fade-in` 145, `pop-in` 23, `fade-in-up` 16, `stage-in` 8, `pop-out` 7, `check-morph` 4, `cite-flash` 3, `modal-*` 2, `title-out` 2, `icon-breathe` 2, `tooltip-*` 1, `sheet-*` 1, `overlay-*` 1, `animate-settle-part`/`animate-rise-user` 0 (the keyframes are used only by plain CSS rules) | Dead config: keyframes and animations with **no product call site** are `accordion-down/up`, `shimmer`, `dot-wave`, `gen-drift-a/b`, `gen-grid-pulse`, `ultra-pan/spark/pop`, `title-in`, `pulse-ring`/`-once`, `blink`, `stroke-draw`. Comments at `:889-895` and `:963-967` describe animation entries (accordion, ultra) that are no longer in the map. |
| tailwindcss-animate (`animate-in/out`, `slide-*`, `zoom-*`) | chat-view side panels, code-session-view, computer-timeline, agent-computer | Hard-coded translates that ignore `--motion-shift`. The exits are **not** `motion-safe` (`chat-view.tsx:3084,3138`, `code-session-view.tsx:138`), so under Reduced the side panel still slides 16px out. `zoom-in-150` (`computer-timeline.tsx:179`) starts at 150% scale. |
| globals.css keyframes (29) plus the tier table (`globals.css:1113-1173`) | | `tests/wave2-p1-tier-table.test.ts` covers only globals.css and the Tailwind map. **127 more `@keyframes` in 30 other files are outside the tier system**: code-v2 19, juno-icons 15, generation 9, composer 7, image-edit 6, live-blueprint 6, … |
| Kill lists (unlayered) | `globals.css:4462-4509,4628-4638` | `[class*="animate-gen-"]` and `[class*="animate-ultra-"]` match nothing (those utilities are never used). |
| framer-motion 12.42 | ~55 product files (82 with dev galleries); 17 `layoutId`, 39 `AnimatePresence`, ~118 `layout` props | Root `<MotionConfig reducedMotion={framerReducedMotion(pref)}>` at `src/components/app/app-shell.tsx:502`. Public and landing use `"user"` (OS-only, ignores the in-app setting): `src/components/public/public-motion.tsx:26,42`, `src/components/landing/reveal.tsx`. |
| WAAPI `el.animate` | 6 sites: PageTransition (`page-transition.tsx:88-91`), composer handoff (`chat-view.tsx:1873`), code-work-list FLIP, generated-media morph, … | Easing strings read from tokens at runtime in two of the six. |
| View Transitions | `thread` (sidebar and project chat rows), `canvas` (docked ⇄ full screen) | `src/lib/view-transition.ts`; CSS at `globals.css:4686-4735`. `data-vt-dir="close"` is **never set by any script**, so the close timings at `globals.css:4710-4718` are dead and canvas closing replays the opening (360 out-expo). |
| `@starting-style` + `allow-discrete` | 6 sites (run UI, right shell) | `globals.css:4339,4365,4391,4402-4417` |
| CSS Custom Highlights | stream fade bands | `globals.css:3648-3656`; `stream-text.tsx` |
| rAF canvases | galaxy, agent face, thinking mark, dot field | All pause off-screen or hidden (`galaxy-mark.tsx:240-250`, `thinking-mark.tsx:267-275`). |

---

## 4. Surface by surface: in, out, hover, press

"Spec" is `docs/design/UI_UX_MOTION_SPEC_2026-10.md` §4.6.

### 4.1 Menus and submenus (dropdown, select, the composer's menus)
- **Shell (app menus).**
  - In: `animate-pop-in`, 220 `--ease-spring`, opacity 0→1, translateY(`--pop-shift` ±4px) and scale 0.96→1 from `--radix-popper-transform-origin` (`menu-recipe.ts:70-73`; `tailwind.config.ts:775-790,939`; `globals.css:3586-3590`).
  - Out: `animate-pop-out`, 120 `--ease-in`, same transform reversed.
  - Spec C7 classes menus as **frequent**: in 120 out-soft from 0.97, out 70 ease-in. The shipped menu is the "infrequent" timing at scale 0.96 (spec §4.5.3 says 0.97).
- **Submenus.** The same shell (`dropdown-menu.tsx:98-111`), but `.origin-popper[data-side=left|right]` sets `--pop-shift: 0px` (`globals.css:3589-3590`). A flyout therefore only fades and scales, with no lateral cue toward its row. The composer menus do slide 6px sideways (`composer.css:827-828`). There is no `alignOffset` to cancel the 6px shell inset (visual, not motion).
- **Rows.**
  - Hover/highlight: `focus:bg-accent` cross-fades 120ms both ways (`menu-recipe.ts:105`). On a fast pointer or a held arrow key the highlight smears across 2–3 rows. See headline #4.
  - Glyph ink cross-fade 120 (`:154`).
  - Press: `active:scale-[0.985]` at 120ms. A row's press dip runs on `duration-fast` and not on `--dur-press` 70 like every other press.
  - Check/radio indicator: 120 fade plus scale from 0.6 (`dropdown-menu.tsx:53-56`).
- **Composer menus (`.cmenu`, `composer.css:799-940,1054-1067`).**
  - In: 220 on a raw expo cubic, 6px travel plus 0.96; contents fade 220 after a 70ms delay.
  - Out: 120 to scale 0.97, no travel.
  - Single gliding highlight: `transform`/`width`/`height` 220 expo (layout properties).
  - The file comment says "240ms … 130ms" (`composer-menu.tsx:16-18`), which is stale.
  - These keyframes do not read `--motion-shift`. They are replaced wholesale under Reduced (`:1054-1066`); fine, but a separate mechanism.
- **Code v2 menus (`.cv2-pop`, `code-v2.css:393-401`).** In 160 out-strong with 2px travel; out at **104ms** (`--cv2-exit-mid`).
- **Plus-menu panels.** `animate-stage-in` ±12px, 220 out-strong (`composer-plus-menu.tsx:409,421`). Good.

### 4.2 Popovers
- `popover.tsx:36`: the same pop-in/pop-out as menus.
- Spec C7: popovers with content are "infrequent", in 220 on `spring.standard` from 0.97, out 160 ease-in to 0.98. Shipped: `--ease-spring` cubic at 0.96, out 120.
- `max-h` scroll plus pop-in: fine.

### 4.3 Tooltips
- In `tooltip-in` 120 out-soft, 2px drift and 0.97. Out `tooltip-out` 120 ease-in (`tooltip.tsx:58`; `tailwind.config.ts:806-821,948-949`). Delay 200 / skip 400 from tokens.
- `data-state="instant-open"` (a peer within the skip window) has **no entrance** by design (`tooltip.tsx:42-45`). The previous label fades out over 120 while the new one is already at full opacity, so for 120ms two labels show. Abrupt but deliberate.
- No delay-tooltip parity with docs (§1.4).

### 4.4 Dialogs
- **Panel.** In `animate-modal-in`, pop-in 220 `--ease-spring` from 0.96 with a 4px rise. Out `modal-out` 160 ease-in (`dialog.tsx:107`). Centering lives on the `translate` property so the keyframe owns `transform` (good).
- **Scrim.** `overlay-in` 120, `overlay-out` 220 (`dialog.tsx:55`; `tailwind.config.ts:961-962`): it leads on open and trails on close. Good.
- **Phone (<640px).** It becomes a bottom sheet: rise 360 `--ease-drawer`, sink 220 ease-in, swipe to dismiss. `bottom` transitions with the keyboard over 220 (`sheet.css:122-153`). Animating a layout property against the iOS keyboard's own curve will lead or lag it (inference).
- **Content changes inside dialogs.** Steps, keyed panes and settings sections are not height-animated, so the dialog jumps size. `settings-pane.tsx:164` uses `AnimatePresence mode="wait"` (out 120, then in 220): 340ms before new content is readable, and the height changes in one frame between them.

### 4.5 Sheets and drawers
- **Side sheet / mobile drawer** (`sheet.tsx:76`): `sheet-in` 220 drawer from ±100% **with opacity 0→1** (the drawer is translucent while it slides), `sheet-out` 160 ease-in. Spec C8/C9: open 360 on the drawer curve, parallax 0.22, dim 0.12/0.30. Parallax is not implemented (`--drawer-parallax` has no consumer).
- **Edge pull** follows the finger; the settle uses `--sheet-pull-ms` fallback 220 (`sheet.css:32-41`).
- **Two bottom-sheet implementations disagree.**
  - `sheet.css` (`ui-sheet-rise/sink`): no fade while motion is on, sink 220, gesture settle `settleMs` {160–260}.
  - `bottom-sheet.tsx:26-38`: fades during the rise, sink **160**, settle is a fixed 220 out-strong, dismiss threshold "a third" (vs `--gesture-dismiss-fraction` 0.3).
  - Used by `activity-timeline.tsx` and `message-feedback.tsx`.
- **Right column shell** (`globals.css:4400-4417`): in 360 drawer with 24px travel, out 160 ease-in. Spec C12 says 220. Tabs inside cross-fade per §C12 (not verified in depth).

### 4.6 Toasts (sonner 2.0.7)
- Our overrides: arrival 360 `--ease-out-expo` on sonner's full-height translate; departure 160 ease-in (`globals.css:4000-4027`).
- Spec C15: 8px rise over 220 on `spring.standard`, exit 4px drop over 160.
- Hover-expand and re-stack inherit the 360.
- **Reduced motion.** Sonner's own `@media (prefers-reduced-motion)` sets `transition:none !important; animation:none !important` (`node_modules/sonner/dist/styles.css:703-710`), so toasts **cut in and out with no fade** (a Tier A violation). That library CSS is not processed by `postcss/motion-preference.cjs`, so in-app "Reduced" does nothing and in-app "Full" cannot restore it.
- **Position.** Offset is a fixed 8rem/1.5rem by route (`sonner.tsx:96-101`) and not `calc(var(--composer-h) + 16px)` (C15). `--composer-h` is declared (`globals.css:615`) but never published, so toasts do not follow a growing composer.

### 4.7 The composer
- **Field growth snaps** by design (`composer-shell.tsx:526-560`). `docs/design/ICONS_AND_MOTION.md:198-208` still documents a height spring, which is stale.
- **Send / stop / voice / busy face swap.** `AnimatePresence mode="sync"`, opacity plus **scale 0.5**, 120 out-soft both ways (`composer-shell.tsx:614-626,694-719`).
  - Three numbers describe one swap: 0.5 here, 0.8 in `IconSwap` and `variants.swap` (`motion.ts:149`, rule 7), and the comment ".9→1" (`composer-shell.tsx:630`).
  - The exit runs on out-soft and not ease-in.
- **Disc fill** (accent ↔ secondary) cross-fades 120 via `.pressable`, but `motion-reduce:transition-none` (`:686`) snaps it under Reduced.
- **Attachment tiles.** `layout` plus scale 0.9 on `spring.standard` (`composer-shell.tsx:730-735,949-958`). The row is `empty:hidden` (`:948`), so:
  - the first tile makes the composer jump taller by the row (~14px padding plus tile) in one frame while the tile pops;
  - removing the last tile collapses it in one frame when the exit ends.

  This is layout shift on the composer.
- **Home → thread handoff** (`chat-view.tsx:1795-1883`).
  - The greeting `title-out` runs 160.
  - Then the branches swap and the dock composer WAAPI-travels from the centre, 360 out-expo.
  - **The transcript, and so the user's bubble, appears 160ms after the optimistic append**, plus a fade. Spec C1 says paint within 100ms.
  - Under Reduced the handoff "never arms" (`:1837`), which is a hard swap (C4 asks for a 160 cross-fade).
  - The comment at `:1852` calls the empty composer's rect "this is the composer's final resting place"; it is the start.
- **Home arrival** (`composer.css:478-497`).
  - Title rises 18px over 560 expo after 70ms; tray 10px over 560 after 220ms; starter chips after 420ms (`home-starters.tsx:54`).
  - It plays **on every new chat**. Spec C3 says first visit of the session only, then a 160 fade; `data-first-visit` is not implemented anywhere.

### 4.8 Messages streaming in
- **User bubble and assistant turn:** no entrance at all (headline #1; `message-item.tsx:985,1183`).
  - `message-list.tsx:402` computes `animateIn` carefully for nothing.
  - The edit-mode bubble alone fades in (`message-item.tsx:530`, `motion-safe:animate-fade-in`). The `duration-fast` on that element is overridden by the motion-safe shorthand (compiled order `layout.css:10669` vs `:14338`).
- **Parts:** each child of `.turn-body` and each non-`p` markdown block runs `settle-part`, 4px over 220 (`globals.css:3666-3674`).
  - Risk (inference): when react-markdown changes a block's element type mid-stream (paragraph → list/heading/code), the new element re-runs `settle-part` from opacity 0, so text that was already visible blinks. `markdown.tsx` holding back half-formed constructs mitigates but does not remove it.
- **Text:** frame-paced reveal plus 5 Custom Highlight bands at 35/52/68/82/92% ink with a text-shadow halo, about 280ms total (`globals.css:3630-3656`, `stream-text.tsx:37`).
  - At stream end the remaining buffer **flushes in one frame** (`stream-pacer.ts:12`). Spec C2: "drains at up to 4× the rate, capped at 250, never in one block". This is visible as a final slab.
- **Jump to latest** (`message-list.tsx:479-509`).
  - Enters with `animate-rise-in` and also transitions from `translate-y-2 opacity-0`, both 220. Leaves with an 8px drop over 220 out-soft; spec C14 says 4px over 160 ease-in. Hover colour runs at 220, not 120.
  - The scroll itself is **instant** (`use-transcript-window.ts:450-460`). Deliberate for long virtual distances, but a short jump has no motion either (C14 asks for a velocity spring).
  - No "· n new" count.

### 4.9 Sidebar
- **Collapse/expand.** `transition-[width]` 220 in-out on the aside (`app-shell.tsx:583`). Rows ride `layout="position"` on the same 220 in-out (`app-sidebar.tsx:1255,1454-1459`), and labels fade in on 220 (`:1503`).
  - The whole `<main>` reflows every frame, with no `contain: layout`.
  - Iframes, xterm and the windowed transcript re-measure every frame. Spec §4.5.7's `alevr:layout-settled` event does not exist (0 matches).
  - Under Reduced the width and layout snap, which is acceptable as travel.
- **Selection fill.** A shared `layoutId` travels on 220 in-out (`app-sidebar.tsx:1255,1408`). Spec §4.4 says the snap spring.
- **Row hover/press.**
  - `LIST_ROW_TRANSITION` cross-fades 120 both ways with `motion-reduce:transition-none` (`sidebar-section.tsx:44-45`).
  - Six `.pressable` hosts also carry `transition-colors`, whose property list replaces `.pressable`'s, so **their press dip has no transition** (snaps in and out): `agents-home.tsx:472`, `app-sidebar.tsx:2019`, `product-switch.tsx:340`, `reasoning-slider.tsx:481`, `connector-directory.tsx:717`, `hold-button.tsx:156`. The same bug is documented and fixed on the send disc (`composer-shell.tsx:660-667`) but survives here.
- **Needs-you rows.** Fade in 220, exit fade 160, siblings close on `spring.layout` (511ms settle) (`app-sidebar.tsx:2244-2262`). Under Reduced the fades also drop to 0ms.
- **Recents rows.** A new chat inserted at the top has **no entrance**, and the list shifts down in one frame. The C11 "hold rule" (queue inserts while the pointer is over the list, the "n updates" pill, `--delay-insert-flush`, `--hold-insert-max`) is not implemented, so rows move under the pointer.
- **Title resolve.** Cross-fade, `title-fade-out` 160 in / `title-fade-in` 220 out-soft (`globals.css:1787-1799`, `sidebar-column.css:71`). Good.

### 4.10 Lists
- The `rise-in` (6px, 220 out-soft) plus `staggerDelay(i, rung)` pattern is widespread (128 call sites). It caps at 10 (`motion.ts:260`), not 4.
- Hand-rolled steps and caps:
  - 30ms cap 8: `agents-home.tsx:62`, `library-home.tsx:500`, `sources-pill.tsx:153`
  - 30ms cap 7: `connector-directory.tsx:767`
  - 40ms uncapped: `agent-thread-header.tsx:313`, `profile-view.tsx:154`, `live-ui-intelligent.tsx:347,485`
  - 60ms uncapped: `live-ui-intelligent.tsx:401`
  - 70ms uncapped: `research.css:266`, `editorial.css:72,96-97`, `thought-process.css:142`, `memory.css:100,107`
  - 45ms cap 5: `editorial.css:77-81`, `memory.css:126-130`
- "Nothing opened from the keyboard staggers" (`globals.css:549-550`): no code path checks input modality.
- The code-work-list FLIP is 150ms with a stock `ease-out` fade (`code-work-list.tsx:90-91`). Under Reduced, the entering fade is skipped too (`:85`).

### 4.11 Tabs and segmented controls
- **Thumb.** Shared `layoutId` on `spring.standard` (tabs `tabs.tsx:134-137`, segmented `segmented-control.tsx:230-233`, surface-tabs `:105-108`, product-switch `:187,290,345`). Good and consistent.
- **Segment press.** `active:scale-[0.97] active:duration-press` (`segmented-control.tsx:216-217`).
- **Labels.** Colour 120, `motion-reduce:transition-none`.
- **Tab panels.**
  - `data-[state=active]:animate-fade-in` 220 with **no exit**: Radix unmounts the old panel in the same frame (`tabs.tsx:158-163`), so there is a blank-then-fade.
  - Panels of different height jump the page.
  - The first panel also fades on initial mount.
- Thumbs under Reduced: `{ duration: 0 }` (fine).

### 4.12 Switches, checkboxes, radios, sliders, progress
- **Switch** (`switch.tsx:52-76`).
  - Track 220 out-soft; thumb 220 out-strong with a framer squash. No press response on the thumb.
  - Under Reduced, track colour, thumb and thumb colour all `transition-none`, which snaps the Tier A colour.
- **Checkbox tick.** 220 on `--ease-spring` from scale 0.5 and −14° (`checkbox.tsx:48-50`). **Radio dot** from 0.25 (`radio-group.tsx:43-45`). Both are below the spec §4.5.3 floor of 0.9 (glyph exception arguably).
- **Progress / usage meter.** Transform fill 360, `motion-reduce:transition-none` (`progress.tsx:29`, `usage-meter.tsx:30`). Spec Tier A says progress fills are kept.
- **Width-transition progress bars** (layout): `library-items.tsx:613,680`, `documents/viewer-ui.tsx:245`, `settings/sections/general.tsx:465`.

### 4.13 Buttons
- **`.pressable`** (`globals.css:1379-1399`): transform on `--dur-press` 70, colour/bg/border/opacity/shadow/filter on 120, `:active` scale 0.97.
  - **Release also takes 70ms**, so the dip and the return feel identical and clicky.
  - A slower or spring release (e.g. `--spring-snap`) would read more physical (recommendation, not a bug).
- **`.control-neu` / `.control-primary`** restate the same list (`globals.css:1552-1557` and `:1594-1599`).
- **Under Reduced:** `controlMotionClass` keeps the colour transitions (`control-recipe.ts:6-11`), which is correct. The `Toggle` instead kills them (`toggle.tsx:18`).
- **Loading.** The label fades out and the spinner fades in from 0.8, at 120 (`button.tsx:121-136`). Good.
- **Hover on touch.** Tailwind 3 `hover:` is not gated by `(hover: hover)` (no `future.hoverOnlyWhenSupported` in `tailwind.config.ts`), so on phones a tapped control keeps its hover fill after the tap ("sticky hover"). Spec §4.5.6 requires hover only under `(hover: hover)`; only `.control-primary:hover` (`globals.css:1600-1604`) and the icon articulation obey it.

### 4.14 Skeletons and loading
- **`.skeleton`:** breathe 1→0.62 over `--loop-breathe` 1.8s on `--ease-breathe`. Under Reduced it holds at 0.8 (`globals.css:3574-3580,4462-4473`). It matches C21.
- **Show/hold/swap:** not implemented (headline #6).
- **Stagger as phase.** `staggerDelay` on skeleton bars offsets each loop's phase by 30–45ms (`src/app/(app)/loading.tsx:35-36`). The CSS run UI explicitly phase-locks its loops (`globals.css:4373`, `lib/run/loop-phase.ts`), so skeletons are the one loop family that is deliberately out of phase.
- **Spinners.** `Loader2 animate-spin` turns at Tailwind's stock 1s linear. Under Reduced it becomes `reduced-working` (`globals.css:4501-4516`).
- **Galaxy (working mark).** Enters 420 with easeOutCubic, decelerates and dims at an exit of 240. Pauses off-screen and on hidden tabs (good). No 3-galaxy cap.

### 4.15 Success and error
- **Copy → check.** `IconSwap` (0.8, 120) or `.check-morph` (from 0.5 and −14°, 220 `--ease-spring`) (`globals.css:1621-1640`). Two different "copied" motions.
- **Settings "Saved"** (`save-status.tsx:36-44`).
  - The word enters with **`filter: blur(2px)`**, a blur entrance banned by spec C1/§4.5.2. The lint misses it because `initial` is a conditional expression (§6).
  - The check pops from 0.4 and −30° on `spring.emphasized`.
  - `AnimatePresence mode="wait"` serialises saved → failed.
- **Approval card.** The arm hold uses `TIMING.approvalArm` 500 (`approval-card.tsx:621,699`). Matches `--hold-arm`, but that is coincidence: the token is not referenced.
- **Errors.**
  - `LoadError` and failure boxes have no entrance motion (they cut in).
  - `nudge` (3px shake, 220) has exactly one call site (`live-ui-learning.tsx:381`); no form error uses it.
  - A turn's "Stopped" / failed state: no motion verified.
- **Sources jump landing.** `cite-flash`, a colour-only 360 flash (`tailwind.config.ts:836-839,960`). Good, and correctly Tier A.

### 4.16 Route changes and view transitions
- **PageTransition.**
  - WAAPI opacity plus a **6px** rise over `--dur-exit` 160 on out-soft (`page-transition.tsx:83-91`), when the route group changes. No exit.
  - The VT `thread` new page rises **4px** (`globals.css:4699`) and its own comment says 6px (`:4661`). Two route entrances do not agree on travel.
- **VT `thread`.** Old page fades 120 ease-in; new page 160 out-soft with a 4px rise. Root swap instant. Hold up to **450ms** (headline #2).
- **VT `canvas`.** Group morph 360 out-expo. Close timing is dead (no `data-vt-dir`).
- **Research tabs.** `research-arrive` uses the **exit** rung (160) for an entrance (`globals.css:4420-4426`).

### 4.17 Agents (faces) — docs/design/agents-rework/MOTION.md
The face rig (`face-rig.ts`, `agent-face.css`) is the most carefully specified motion in the product. It has its own clock, smoothing holds of 250/400/700/1400/2500ms (`face-rig.ts:1456-1460`), and a full reduced-motion still pose.

Around it the agent surfaces use raw expo cubics and their own stagger:
- `studio-swap` and `agent-arrive` 560 on a literal cubic (`tailwind.config.ts:916-917`);
- the Orbit crew at `var(--dur-slow, 320ms)` (fallback ≠ token) (`agents.css:39`);
- greeting 80 + 40·i ms (`agent-thread-header.tsx:313`).

MOTION.md says "Nothing else on the page loops", while the Orbit card's "slow light along its lower edge" and other loops exist. Not verified per page.

---

## 5. Reduced motion

**What exists (good).**
- **One model with three inputs.**
  - OS, in-app setting and gallery, resolved in `src/lib/motion-preference.ts:41-86`.
  - `postcss/motion-preference.cjs` compiles every `prefers-reduced-motion` block into `data-motion` twins.
  - `eslint-rules/no-raw-reduced-motion.mjs` bans raw `matchMedia` and framer's `useReducedMotion`.
  - `MotionConfig` is fed the in-app choice (`app-shell.tsx:502`).
- **Tier B mechanism.** `--motion-shift: 0`, `--motion-scale-from: 1`; out-strong/expo/spring/drawer flattened to out-soft; `--dur-slow` → base; every spring twin → out-soft at base (`globals.css:1175-1206`).
- **Tier C kill lists** are unlayered, so they win (`globals.css:4440-4516,4628-4638`). Spinners become a slow fade and do not freeze.

**Gaps.**
1. **Tier A is violated widely.** 187 colour/opacity-only `motion-reduce:transition-none`. Framer sites use `reduce ? { duration: 0 }` for opacity as well as layout: sidebar needs-you rows `app-sidebar.tsx:2250-2251`, Collapse rows (correct, rows only), several dialogs. Sonner kills toast fades.
2. **Not flattened:**
   - `--ease-out-back` (overshoot);
   - `--dur-emphasis` 560 (spec caps Tier A at 220);
   - raw-cubic animations (§1.2);
   - tailwindcss-animate slides on exit (`chat-view.tsx:3084,3138`);
   - `gen-blur-in`/`gen-settle` scale (`generation.css:221-225`), whose transforms do not read `--motion-shift` and are not in the media block;
   - `cv2-badge-in` scale 0.6 (`code-v2.css:171`);
   - `live-breathe` scale (killed, fine);
   - `check-morph` is fine.
3. **OS-only islands** that ignore the in-app setting:
   - sonner's own media query (library CSS is outside the PostCSS twin);
   - `MotionConfig reducedMotion="user"` in public and landing (`public-motion.tsx:26,42`);
   - `dialog.tsx:83` uses `window.matchMedia` for the phone-sheet width only (fine).
4. **Reduced is sometimes a cut where the spec asks for a cross-fade.**
   - The home→thread handoff (`chat-view.tsx:1837`; spec C4 asks for 160).
   - Sidebar width.
   - The jump-to-latest fade.
   - The switch track.
5. **The tier table is partial.** 127 component keyframes have no tier entry and no test (§3).

---

## 6. Lint constraints (`eslint-rules/wave2.mjs`) and their blind spots

All four rules **warn** everywhere and **error** only on the `enforce/p1.json` globs. Those are `src/app/globals.css`, strings, accents, names and the generated tokens (`eslint-rules/enforce/p1.json`; `wave2.mjs:574-591`). Current tree: 0 warnings.

| Rule | What it checks (file:line) | What escapes it (found in this tree) |
|---|---|---|
| `off-ladder-duration` | CSS `transition*`/`animation*` time literals outside `var()` (`:260-268`); Tailwind `duration-N`/`delay-N` and arbitrary `[transition:…]` (`:270-281`); style-object `transition*`/`animation*` strings (`:296-298`); numeric `duration`/`delay`/`repeatDelay` literals inside framer transitions or `animate*()` calls (`:300-315`) | Anything computed. `calc(var(--dur-mid)*.65)` = 104/143ms. `calc(var(--dur-fast)/3)`. Template literals: `` `${80 + step*40}ms` ``, `` `${i*40}ms` `` (the literal part is only `ms`). Identifiers: `FLIP_DURATION_MS` 150, `MORPH_MS` 640, `GALAXY_ENTER_MS` 420. Tailwind's implicit `transition` 150ms. `setTimeout` delays. Library CSS (sonner). Local re-declared tokens (`--dur-mid`). **Easings are not checked at all**, so raw cubic-beziers pass. |
| `no-blur-entrance` | CSS `filter: blur(n)` inside `@keyframes` (`:394-401`); framer `filter` blur in an object whose parent key is `initial/hidden/from/enter/exit/start/0%/out`, or in a keyframe array (`:403-414`) | Conditional values (`initial: reduce ? {…} : { filter: "blur(2px)" }`, `save-status.tsx:37`). CSS **transitions** from a blurred resting state: `home.css:85,87`, `alv-base.css:86` (marketing, but the rule says "any entrance"). Tailwind `blur-*` utilities toggled by state. Blurred layers revealed by mask (`generation.css:179-180`, arguably a reveal and not an entrance). |
| `no-backdrop-filter` | CSS `backdrop-filter` outside the allow globs (home, landing, design, `lib/design`, dev) and outside `.media-scrim`; Tailwind `backdrop-*`; style `backdropFilter` (`:420-459`) | Clean in product chrome. `.overlay-glass` is no longer glass (`globals.css:2217-2236`). The compiled CSS still emits a `.backdrop-filter` utility (`layout.css:13942`) for an allowed caller. |
| `guarded-motion-overrides` | CSS `--motion-shift`/`--motion-scale-from` outside a reduced-motion media block; Tailwind `[--motion-*:…]` without `motion-safe:`; style objects (`:463-496`) | Correctly enforces the palette's `motion-safe:[--motion-scale-from:0.97]` (`command-palette.tsx:279`). Does not catch keyframes that **ignore** the vars (the Tier B gap above). That is a different rule that does not exist; the tier-table test covers only two files. |

Related: `eslint-rules/no-raw-reduced-motion.mjs` (raw media queries, framer `useReducedMotion`). `tests/wave2-p1-tier-table.test.ts` (tier table vs keyframes in globals and Tailwind, B transforms read vars, no keyframe blurs).

---

## 7. Motion docs and where they disagree with the code

| Doc | Status vs code |
|---|---|
| `docs/design/UI_UX_MOTION_SPEC_2026-10.md` §4 (the governing spec) | Partly implemented. **Not done:** C1 `rise-user`, C2 tail drain, C3 first-visit only, C6 snap highlight, C7 frequent/infrequent overlay split, C9 parallax, C11 hold rule, C14 spring scroll and count, C15 composer-relative toasts and spring, C18 `ROUTE_WAIT_MS` 80 and `data-vt-dir`, C21 show/hold/cross-fade, §4.5.6 instant-in hover, §4.5.7 `alevr:layout-settled`. Token values also differ: tooltip 500/300 in spec vs 200/400 in code. |
| `docs/design/ICONS_AND_MOTION.md` §2 | Stale: the composer height spring (`:198-208`, now snaps), tooltip delays 300/400 (`:263-264`), stagger cap "~8" (`:183`). Rule 7's 0.8 swap scale is broken by the composer's 0.5. |
| `docs/design/agents-rework/MOTION.md` | Matches the face rig at a high level. Its "nothing else on the page loops" is not audited across Orbit. |
| `docs/rework/brand/MOTION_AND_THINKING.md` | Specifies a Continuum-mark path handoff with a 70ms stagger as the thinking indicator. The product ships the galaxy (`GalaxyMark`) and `ThinkingMark`. Two thinking specs are live. |
| `src/lib/motion.ts` header | "framer-motion … in exactly four files" (`:17-18`); now ~55 product files. It also claims "every number here is derived" while `STAGGER`, `SHIFT`, `POP_SCALE`, `SWAP_SCALE`, `RUN_PACING` and `spring.interactive` are hand-typed. |
| `tailwind.config.ts` comments | pop-in "~2% overrun" (`:936-938`, false). Accordion and ultra comments describe removed entries (`:889-895,963-967`). |
| `src/components/chat/composer-menu.tsx:16-18` | "240ms … 130ms": the CSS runs 220/120. |
| `globals.css:4661` VT comment | "6px rise"; the keyframe is 4px (`:4699`). |
| `scripts/generate-design-tokens.ts:71-73` | Lists only 3 reduced-motion re-declarations; there are about 20. |

Other motion docs exist but were not audited line by line: `docs/chat-rework/audit/{internal-design-system-motion,external-motion-audit}.md`, `docs/rework/INTERACTION_SPEC.md`, `docs/design/{SOFT_UI,FLAT_UI}.md`, `docs/design/artifacts-design/research/*motion*`.

---

## 8. Full findings list (by category)

### Missing
- **M1.** Transcript turn entrance (`message-item.tsx:985,1183`; `animate-turn-in` is dead). Wire `animate-rise-user` on the user bubble; the assistant root stays still per C1.
- **M2.** Skeleton show delay, minimum hold and content cross-fade (C21). Tokens `--delay-show`, `--hold-skeleton` are unused.
- **M3.** Sidebar insert hold rule (C11), so rows shift under the pointer.
- **M4.** Recents row arrival. There is no entrance, and the list pushes down in one frame.
- **M5.** Tab-panel exit and height continuity (`tabs.tsx:158-163`).
- **M6.** Drawer parallax (`--drawer-parallax` 0.22 unused).
- **M7.** `data-vt-dir="close"` is never set, so canvas close timing is dead (`globals.css:4710-4718`).
- **M8.** `alevr:layout-settled` (§4.5.7). Iframes and xterm re-fit every frame during sidebar collapse and dock resize.
- **M9.** Stream tail drain (C2). The end of a reply lands as one slab.
- **M10.** Instant-in, 120-out hover fills (§4.5.6). Every highlight fades in.
- **M11.** `(hover: hover)` gating for Tailwind `hover:`, so hover is sticky on touch.
- **M12.** No 3-galaxy cap (`--galaxy-max-animating` unused).
- **M13.** First-visit gating of the home arrival (C3).

### Janky
- **J1.** Menu, select and list highlight smear (`menu-recipe.ts:105`; `sidebar-section.tsx:44`).
- **J2.** Six `.pressable` hosts whose `transition-colors` drops the transform from the list, so the dip snaps (§4.9).
- **J3.** View-transition freeze up to 450ms (`view-transition.ts:29`).
- **J4.** Toasts arrive on a 360 expo across a full toast height (sonner's translate), and the hover re-deal also runs at 360 (`globals.css:4020-4023`).
- **J5.** Composer-menu glide animates `width`/`height` (`composer.css:912-916`).
- **J6.** Sidebar `width` transition reflows `<main>` and the transcript for 220ms (`app-shell.tsx:583`).
- **J7.** Incognito `margin` transition over 360 reflows the whole transcript (`chat-view.tsx:2788`).
- **J8.** The spring twin is run at the wrong duration: `--spring-standard` (settle 272) at `--dur-base` 220 (`code-v2.css:227`).

### Inconsistent
- **I1.** Three menu systems (§4.1). Plus popovers on the menu timing where the spec says the dialog timing.
- **I2.** Swap and pop scales:
  - composer face 0.5 (`composer-shell.tsx:619`);
  - IconSwap 0.8; IconSwapSet 0.75;
  - check-morph 0.5 + −14°; save-status 0.4 + −30°;
  - menu tick 0.6; run-fav 0.6; checkbox 0.5; radio 0.25;
  - pop 0.96 (spec 0.97); tile 0.9.
- **I3.** Stagger steps and caps (§4.10, §1.4).
- **I4.** Timing tables: tooltip, phase hold, show delay, stream (§1.4).
- **I5.** Route entrances 6px (PageTransition) vs 4px (VT).
- **I6.** Exit rungs vary for comparable layers: menus 120, code menus 104, dialogs 160, sheets 160 (side) / 220 (bottom, `sheet.css`) / 160 (`bottom-sheet.tsx`), right shell 160, toasts 160.
- **I7.** Entrances on exit rungs: VT page-in 160, research-arrive 160, PageTransition 160.
- **I8.** Fold timings:
  - `Collapse` 220/220 (`collapse.tsx:52-71`; spec C10 says close 160 ease-in);
  - `.run-collapse` 220 in-out;
  - aicss folds 360 out-soft / out-strong (`globals.css:2400,2570`);
  - todo 220 out-soft (`:3203`);
  - cv2-fold 160 / 220-spring (`code-v2.css:226-227`).

  Chevrons are mostly 220 in-out (24 sites), against spec C10's 120.
- **I9.** Two bottom-sheet implementations (§4.5).
- **I10.** Springs used outside their reservation:
  - `emphasized` ×4 vs "handoff only";
  - `reward` on favicons vs "copy, tick, chip, thumbs-up" (or Swift's "exactly two sites");
  - `articulate` unused while icon poses use `--ease-out-back`.
- **I11.** Swift vs web:
  - press curve (outSoft vs framer outStrong);
  - interactive spring damping (0.85 vs ≈0.94);
  - `sendMorph` 0.36/0.12 vs spec 0.22/0.10.
- **I12.** Loops on non-breathe curves (§1.2).
- **I13.** Tier table covers 2 files; 127 keyframes are untiered.

### Abrupt
- **A1.** Tooltip `instant-open` swap, with an overlapping fade-out (§4.3).
- **A2.** Jump to latest: instant scroll for every distance (`use-transcript-window.ts:450-460`).
- **A3.** First attachment tile and last tile removal resize the composer in one frame (`composer-shell.tsx:948`).
- **A4.** Reduced-motion cuts: handoff, toasts (sonner), switch, progress, hover fills (§5).
- **A5.** Skeleton → content cut (M2).
- **A6.** `AnimatePresence mode="wait"` adds 340ms with a height jump on settings sections (`settings-pane.tsx:164`).
- **A7.** `code-work-list` entering fade skipped under Reduced (`code-work-list.tsx:85`).

### Layout-shifting
- **L1.** Sidebar width (J6).
- **L2.** Incognito margin (J7).
- **L3.** Private toggle `width`/`padding` 220 expo (`private-chat-toggle.tsx:66`).
- **L4.** Transcript rail `top` 220 `--ease-spring` (`transcript-rail.tsx:143`).
- **L5.** Composer attachment row `empty:hidden` (A3).
- **L6.** Tab panels of different heights (M5).
- **L7.** Recents insert (M4).
- **L8.** Dialog content steps with no height animation (§4.4).
- **L9.** Width progress bars (§4.12).
- **L10.** Phone-dialog `bottom` transition against the keyboard (`sheet.css:139`).

### Token hygiene
- **T1.** `--ease-drawer` ≡ `--ease-out-strong`. `--ease-spring` is not a spring. Three near-identical decelerates.
- **T2.** Unused tokens: all `--hold-*`; `--delay-{hairline,action-row,greeting,insert-flush}`; all `--stream-*`; `--settle-*` (CSS); `--galaxy-max-animating`; `--drawer-parallax`; `--drawer-dim`; `--composer-h` (never published); `--spring-{snap,layout,emphasized,articulate}` twins; framer `spring.{snap,reward,articulate,interactive}`.
- **T3.** Dead Tailwind keyframes and animations (§3) and dead kill-list selectors (`globals.css:4466-4467`).
- **T4.** Retired tokens still declared or used: `--dur-mid`, `--dur-wide`, `--rf-ease`, `--alv-ease`.

---

## 9. What is already right (keep)

- One generated duration, easing and spring source for CSS, TS and Swift, drift-checked (`scripts/generate-design-tokens.ts`).
- The `--motion-shift` / `--motion-scale-from` Tier B mechanism, the unlayered Tier C kill lists, the PostCSS in-app twins and `lib/motion-preference.ts`. This is a genuinely good reduced-motion architecture; the gaps are adoption gaps.
- Overlay origin awareness (`.origin-popper` with `--pop-shift`). Scrims lead on open and trail on close. Dialog centring on `translate` so keyframes own `transform`.
- `IconSwap`/`IconSwapSet` as the one glyph cross-fade. `Collapse` on grid-rows. The Button `loading` cross-fade.
- Shared-`layoutId` thumbs on `spring.standard` across tabs, segmented controls and the product switch.
- Streaming via Custom Highlights (no per-word DOM). The run UI's `@starting-style`, `allow-discrete` and phase-locked loops. Galaxy and face rAF loops pause off-screen and on hidden tabs.
- The agent face rig's state smoothing and reduced still poses.

## 10. Suggested order of fixes (smallest change, biggest felt gain)

1. **Turn entrance.** Replace `motion-safe:animate-turn-in` with `motion-safe:animate-rise-user` on the user branch and drop it from the assistant root (`message-item.tsx:985,1183`). Add a test that every `animate-*` class in `src/` has a compiled rule.
2. **`ROUTE_WAIT_MS` 450 → 80** (`view-transition.ts:29`). Set `data-vt-dir` on canvas close.
3. **One highlight model for every list overlay.** Either instant-in/120-out fills (`[transition-duration:0ms]` on the highlighted state, 120 on the rest) or the composer's glide promoted to `menu-recipe` with transform-only motion.
4. **Split overlay timing into frequent and infrequent** per C7. Menus and tooltips: 120 in from 0.97, 70 out. Popovers and dialogs: `--spring-standard` 220 in, 160 out to 0.98. Retire one of `--ease-spring` / `--ease-drawer`.
5. **Tier A sweep.** Replace colour-only `motion-reduce:transition-none` with nothing (or with `controlMotionClass`'s pattern), and framer `reduce ? {duration: 0}` with `MotionConfig` defaults. Override sonner's reduced-motion block in unlayered CSS with an opacity fade.
6. **One stagger.** `staggerDelay` cap = `TIMING_TOKENS.stagger.max` (4), steps from `TIMING_TOKENS.stagger`. Migrate the 40/60/70ms hand-rolled sites. Ditto `interaction.ts` → `TIMING_TOKENS` for tooltip, phase and show.
7. **Skeleton gate.** `--delay-show` before paint, `--hold-skeleton` minimum, 160 cross-fade to content.
8. **Layout motion.** `contain: layout` plus `alevr:layout-settled` for the sidebar fold. Incognito via `transform`/`clip-path` and not `margin`. Composer attachment row via `Collapse`.
9. **Lint extensions.** Flag raw `cubic-bezier(`; flag identifiers named `*_MS` passed as `duration`; flag `calc()` with a non-rung result where statically computable; walk `ConditionalExpression` in `no-blur-entrance`; add `transitionDuration.DEFAULT: var(--dur-fast)` to Tailwind; extend the tier-table test to all `src/**/*.css`.
10. **Docs.** Reconcile ICONS_AND_MOTION §2 (composer, tooltip, stagger) and the Tailwind comments with the code.
