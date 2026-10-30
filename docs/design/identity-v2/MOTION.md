# Identity v2 · MOTION

Appendix to `docs/design/IDENTITY_V2.md` §7. Character: **things rise from where they were caused, come to
rest without bounce, and a lifted object's shadow lands a beat after it**; that lag, not overshoot, is where
the weight is felt. Frequent and keyboard-initiated things do not move; nothing glows, shimmers or blurs.

Revision 3 (review): the overshoot of every spring here is under a tenth of a pixel on the travels used
(measured below), so "weight" is no longer claimed for the springs. It is defined as choreography (§3.1)
and proved with frame strips (§7).

## 1. Rules (each one is checked by lint, a test or a gate; see §8)

1. **One choreography per layer type** (§5). A menu moves like every other menu, wherever it opens.
2. **Springs for space, tweens for effects.** Transform, size and layout use the four springs (§3);
   opacity, colour and the shadow layer use the duration ladder (§2).
3. **Bounce ≤ 0.10 everywhere.** Only `settle` and `lift` carry any (0.10 each). The owner judge's
   0.12–0.15 and the platform judge's ≤ 0.10 were weighed (BEST_OF conflicts table): 0.12 would add
   0.015 px of overshoot on a 10 px lift (0.03 px instead of 0.015 px), which nobody can see, so the
   lower value wins and weight comes from §3.1.
4. **Keyboard-opened menus, submenus, selects and the palette appear instantly** (0 ms, no fade, no
   travel). Focus moves at t = 0.
5. **The scrim never outlives its panel**: on exit, scrim and panel start together and the scrim's
   duration is ≤ the panel's.
6. **Exits are shorter than entrances** and never exceed 160 ms.
7. **Nothing frequent animates**: hover fills (in 0 ms, out 80 ms), **selection in navigation** (sidebar
   rows, tabs and their underline, list rows, the palette highlight), route changes, typing, composer
   growth. A control's own thumb (switch, segmented control) does move on `snap`, because that movement
   is the value changing, not a selection highlight travelling.
8. **Streaming text settles per block at most**: a new block (paragraph, list, table, code block) fades in
   once over 120 ms when it is created; text arriving inside an existing block appears without animation;
   nothing ever animates text the reader is already reading. No per-token or per-word animation.
9. **The needs-you entrance completes in under 400 ms**: the body reaches 95 % at 246 ms and rests at
   335 ms; its shadow lands at 320 ms (§3.1).
10. **Reduced motion = fade only** (§6): every translate, scale **and size or layout change** is removed;
    never a global 0.01 ms override.
11. **No blur in any transition, either platform**; no animated `box-shadow` (the shadow is a pre-blurred
    layer animated in `opacity` and `transform` only).
12. **Interruptible**: every spring retargets from its current value (framer `animate`, WAAPI with
    `commitStyles`, SwiftUI springs), so a closing menu reopened mid-exit does not jump.
13. **No endless loops** (WCAG 2.2.2, PRINCIPLES §8.5): a live loop runs for the first 5 s after each step
    starts, then rests still while the word and the counting timer carry the state; every loop also stops
    off-screen, in hidden tabs and under reduced motion.

## 2. Duration ladder (effects)

The token names stay (so 443 `duration-fast` and 182 `duration-base` call sites keep compiling); the values
change. `eslint-rules/wave2.mjs` `RUNGS_MS` becomes `[80, 120, 160, 200, 240, 400]`.

| Token | Today | v2 | Use |
|---|---|---|---|
| `--dur-press` | 70 | **80** | press fill, hover-out, icon swaps (send ↔ stop), tooltip exit |
| `--dur-fast` | 120 | **120** | menu/popover opacity in, submenu in, menu exit, dialog exit, new-block fade, reduced-motion cross-fades |
| `--dur-exit` | 160 | **160** | sheet and toast exits; the ceiling for every exit |
| `--dur-base` | 220 | **200** | scrim in, toast opacity, cross-fades (stamp line, AI-renamed titles), shadow settle |
| `--dur-slow` | 360 | **240** | phone sheet scrim in, live rule fade-out, the lift's shadow layer (§3.1) |
| `--dur-emphasis` | 560 | **400** | first-open greeting fade; nothing else |
| `--delay-submenu` | — | 100 | pointer intent before a submenu opens |
| `--delay-shadow` | — | 70 | the lift's shadow layer starts 70 ms after its body (§3.1) |
| `--delay-tooltip` / `--delay-tooltip-skip` | 500 / 300 (provider says 200) | **600 / 300** | one value, in `providers.tsx` too |
| `--grace-submenu` | (Radix default) | 300 | the safe polygon's lifetime |
| `--live-loop-cap` | — | 5,000 | how long a live loop runs after each step starts (rule 13) |

Curves: `--ease-out` `cubic-bezier(0.2, 0.8, 0.2, 1)` for entrances; `--ease-in`
`cubic-bezier(0.4, 0, 1, 1)` for exits; `--ease-inout` `cubic-bezier(0.45, 0, 0.2, 1)` for the live loop
and determinate progress. `out-back`, `reward`, `breathe`, `out-expo` and the framer `interactive`
stiffness/damping spring (`src/lib/motion.ts`) are retired.

## 3. The four springs

Defined once in `globals.css` as `--spring-<name>-params: <visualDuration> <bounce>`; the generator already
emits the CSS `linear()` twin and its settle time (`--spring-<name>`, `--spring-<name>-dur`), framer's
`{ visualDuration, bounce }` and SwiftUI's `.spring(duration:bounce:)`. Values below were computed with the
generator's own model (`springPosition`/`springTwin` in `scripts/generate-design-tokens.ts`:
ω₀ = 2π / (1.2 · visualDuration), ζ = 1 − bounce, rest when within 0.005), reimplemented in
`tools/springs.py`, whose run list now includes every case quoted here (`python3 springs.py`).

| Spring | visualDuration / bounce | Settle (CSS duration) | Overshoot (on a 10 px travel) | Reaches 95 % | Replaces today's | Use |
|---|---|---|---|---|---|---|
| `snap` | 0.24 s / 0 | 341 ms | 0 | 218 ms | `snap` (0.18/0), `standard` (0.22/0.05) | menus, submenus, popovers, selects, tooltips' 2 px travel, segmented thumb, switch thumb |
| `glide` | 0.32 s / 0 | 455 ms | 0 | 290 ms | `layout` (0.36/0) | sidebar collapse, list reorder (FLIP), drawer and sheet settle (with gesture velocity), margin note relayout |
| `settle` | 0.36 s / 0.10 | 377 ms | 0.152 % (0.015 px) | 277 ms | `emphasized` (0.36/0.1) | dialogs, phone sheets, the palette |
| `lift` | 0.32 s / 0.10 | 335 ms | 0.152 % (0.015 px) | 246 ms | `reward` (0.36/0.18) | **four signature moments only**: a toast arriving, the needs-you card arriving, the sent message becoming the user turn, the stone rising into the arch on first open |

For the record (same model): lift at 0.32 s / 0.12 settles in 313 ms with 0.297 % (0.030 px on 10 px);
0.32 s / 0.15 in 414 ms with 0.629 % (0.063 px), which breaks the 400 ms needs-you budget; d3's 0.50 s / 0.18
in 682 ms with 1.110 % (0.111 px). **Today's names stay as aliases until W9**: `--spring-standard` →
`--spring-snap`, `--spring-layout` → `--spring-glide`, `--spring-emphasized` → `--spring-settle`,
`--spring-reward` → `--spring-lift`, `--spring-articulate` → `--spring-snap` (deleted with the hover articulation,
ICONS §1); framer `spring.standard/layout/emphasized` likewise; Swift `JunoMotion.standard` (104 uses),
`.emphasized` (17), `.layout` (6) stay as deprecated aliases of the new members.

### 3.1 Where the weight is (the lift choreography)

A lifted object is drawn as two layers: the body, and a **pre-blurred shadow layer** (a pseudo-element the
size of the body carrying the tier's throws as a static `box-shadow`, or natively a separate shadow view).
The body travels on `lift`; the shadow starts as a contact shadow and lands **after** the body, so the
object reads as having left the ground under its own weight.

| Layer | From | To | Timing | Ends at |
|---|---|---|---|---|
| Body (needs-you card) | `translateY(10px) scale(.985)`, opacity 0 → 1 over 120 | rest | `lift` from t = 0 | 95 % at 246 ms, rest at 335 ms |
| Shadow layer | opacity 0.35, `translateY(-4px) scale(.94)` (tight, close to the card: a contact shadow) | opacity 1, `translateY(0) scale(1)` (the tier-1 throw) | 240 ms `ease-out`, starting at t = 70 ms (`--delay-shadow`) | 310 ms: 64 ms after the body reaches 95 % |
| Ring (1 px `--line-strong`) | present from t = 0 | — | — | — |
| Toast (tier 2) | same two layers, 12 px travel | | body on `lift`; shadow 240 ms from t = 70 | 310 ms |
| Sent message, the stone's first rise | body only (both are tier 0, no shadow) | | `lift` | deceleration only; no weight is claimed |

Proof is a frame strip (§7): the shadow's offset and opacity must still be changing in the frames after the
body's 95 % point. Under reduced motion both layers appear together with a 120 ms opacity fade.

## 4. Native

| Token | SwiftUI |
|---|---|
| snap | `.spring(duration: 0.24, bounce: 0)` |
| glide | `.spring(duration: 0.32, bounce: 0)` |
| settle | `.spring(duration: 0.36, bounce: 0.10)` |
| lift | `.spring(duration: 0.32, bounce: 0.10)`; the shadow view animates `.easeOut(duration: 0.24).delay(0.07)` |
| effects | `.easeOut(duration: 0.12 / 0.20)`, exits `.easeIn(duration: 0.12 / 0.16)` |

`JunoMotion.platformFactor = 0.75` (Mac) is removed: the Mac feels fast because keyboard and frequent
actions do not animate, not because springs run faster. `interactive`, `drawerSettle` and the loop
periods become generated values. System transitions (menu morph, sheet presentation, navigation push) are
left to the OS.

## 5. Choreography (one per layer type)

Directions are logical: "inline start" is the left in left-to-right languages and the right in RTL.

| Layer | Enter (pointer) | Enter (keyboard) | Exit | Notes |
|---|---|---|---|---|
| Menu, select, popover | opacity 0 → 1 over 120 `ease-out`; `translateY(4px) scale(.98)` → none on `snap`; origin = the trigger's anchored corner | instant | opacity 120 `ease-in` + scale .985; the whole tree together | composer menus open upward; the highlight never glides between rows |
| Submenu | after 100 ms hover intent: opacity 120 + 4 px from the parent's side on `snap`, no scale | instant (ArrowRight in LTR, ArrowLeft in RTL, or Enter) | with its parent, or 80 opacity alone | switching sibling submenus: the old one closes instantly, the new one appears without travel |
| Context menu | as menu, origin at the pointer offset 4 px toward the inline end and 4 px down | instant (Shift+F10) | as menu | |
| Tooltip | 600 ms delay; opacity 120 + 2 px toward the anchor on `snap` | 600 ms delay, opacity only | opacity 80 | 300 ms skip window: neighbours show at once |
| Dialog | scrim opacity 200 `ease-out`; panel opacity 160 + `translateY(8px) scale(.97)` → none on `settle` | panel opacity only | **panel opacity 120 + scale .98; scrim 120; both start together** | focus moves at t = 0 |
| Palette (⌘K) | as dialog, from 8 px above its rest | instant (it is a keyboard surface) | 120 | typing is never blocked |
| Phone sheet (menus, dialogs < 640 px) | `translateY(100%)` → 0 on `settle`; scrim 240 | — | follows the finger; release projects velocity to the nearest detent on `glide`; programmatic exit 160 `ease-in` | drill-in: the next level slides 16 px from the inline end + opacity 120 on `snap`; the sheet height animates on `glide`; back reverses |
| Drawer (phone) | opens from the **inline-start edge** (the leading edge: left in LTR, right in RTL), `translateX(calc(-100% * var(--dir)))` → 0 with `--dir: 1` in LTR and `-1` in RTL, on `glide` with gesture velocity; `--drawer-dim` 200 | — | follows the finger; 160 | the stage behind is pushed, not covered (IDENTITY_V2 §11.6) |
| Toast | body on `lift` (`translateY(12px) scale(.98)` → none, opacity 120) + shadow layer per §3.1 | same, no travel | opacity 160 + 4 px down | max 3; older toasts scale .96 and rise 8 px on `glide` |
| Page change | instant swap; the selected sidebar row changes instantly (rule 7) | instant | — | no page-wide fade, no stagger from the keyboard |
| Tabs | the selected tab's ink and underline change instantly | instant | — | rule 7 |
| List insert / remove / reorder | insert: opacity 160; remove: opacity 120 then height collapse on `glide`; reorder: FLIP on `glide` | same, opacity only | — | first load of a list: at most the first 4 rows stagger 24 ms, pointer navigation only |
| Sidebar collapse (⌘\) | width 0 ↔ 264 on `glide` | same | same | the stage grows with it; no icon rail |
| Margin lane toggle | the column re-centres on `glide` | same | same | rare, user-initiated |
| Sending | the composer's text lifts into the transcript as the user turn on `lift` (shared element via View Transitions where supported, else opacity 160); on the home, the composer moves to the bottom on `glide` | opacity 160 only | — | the send disc swaps arrow → stop in 80 |
| Streaming | new block fades 0 → 1 over 120 once; the writing point (2 × 16 px bronze bar) sits after the last character and moves with it, never blinks | — | at the end the writing point fades 200, the stamp line fades in 200 | no shimmer, no skeleton bars in the transcript |
| Tool working | the live dot: the stone shifts 1.5 px up and settles, 1.6 s `ease-inout` loop, **for the first 5 s after each step starts**, then still; one loop per screen region; paused off-screen and in hidden tabs | — | stops at rest when the tool returns | the live rule in the margin steps its width on `ease-inout` 200 per source read; when the count is unknown a 24 px segment travels it once per 1.6 s, within the same 5 s cap |
| Needs you (card) | §3.1; iPhone `.warning` haptic | same, no travel | when answered: the shadow layer fades 200, the ring goes to `--line`, the card collapses to its one-line receipt on `glide` | the sidebar count changes without motion |
| Composer lift | tier-1 shadow pseudo-element opacity 160 when content starts passing under it | — | 160 | static shadow, no animation during scroll |
| Voice (the composer becomes the voice bar) | the bar's height changes on `glide`; the Arch fades in 120 | same | 160 | the stone tracks the input level: `translateY(-level × 6px)`, level smoothed with a 60 ms attack and a 200 ms release, sampled per frame only while the bar is on screen; ink while listening, `--bronze-fill` while Alevr speaks (colour change 120) |
| First open (once per launch) | the sidebar mark's stone rises 4 px → 0 on `lift`; the greeting and dateline fade in over 400 | — | — | never on navigation; the composer is usable at t = 0 |

## 6. Reduced motion (reduce, don't delete)

With `prefers-reduced-motion: reduce` (web, through `src/lib/motion-preference.ts` and the generated
`postcss/motion-preference.cjs` twins) or Reduce Motion (native, `JunoMotion.reduced(_:when:tier:)`):

- every translate and scale is removed; the same layer fades at its rung (menus 120, dialogs 120 out and
  160 in, sheets and drawer 200, toasts 160); springs become `ease-out` tweens of their rung;
- **every size or position change is instant, with at most a 120 ms opacity cross-fade of the changed
  content**: the sidebar's width (collapse and peek), list insert and remove (the row appears or goes; the
  rows below jump), the needs-you card's collapse to its receipt, the phone sheet's height on drill-in,
  margin note relayout, the margin lane toggle, the voice bar's height, and the home composer's move to the
  bottom on the first send (the View Transition is skipped);
- loops stop: the live dot is a still bronze stone beside the word "Working"; the voice stone stays at rest
  and the level is shown as a static 3-step meter (three 4 × 12 px bars in ink or bronze, filled by level
  thirds) beside the state word; timers keep counting, so state is still shown;
- the needs-you card appears with its shadow at once; no haptic change (haptics are not motion);
- streaming text simply appears (no block fade);
- direct manipulation stays: sheets and the drawer still track the finger;
- no blur in either mode.

## 7. Verification each wave must produce

W3 renders frame strips every 40 ms (light and dark) for: menu enter and exit (pointer and keyboard),
submenu enter, dialog enter and exit (with the scrim curve plotted to prove it ends with the panel),
toast enter (body and shadow layer, proving the 70 ms lag), phone sheet drill-in, and the reduced-motion
variant of each; **plus reduced-motion strips for every size change listed in §6** (sidebar collapse, list
remove, sheet drill-in height). W4 adds the home composer's move on first send (normal and reduced). W5 adds
the needs-you lift (body 95 % at 246 ms; the shadow still moving at 280 ms; both at rest by 335 ms), the
receipt collapse, the streaming block fade and the voice stone at three input levels. Tooling: the d3
frame tool, now committed at `docs/design/identity-v2/tools/vendor/frames.js`, ported in W3 to
`scripts/design-audit/motion-frames.mjs` and pointed at the `/dev/controls` and `/dev/transcript` galleries.

## 8. Gates

| Gate | Checks |
|---|---|
| `wave2/off-ladder-duration` | durations in `[0, 70, 80, 100, 120, 160, 200, 240, 400]` (70 and 100 are the two delays) or a named token |
| new unit test `tests/motion-tokens.test.ts` | the four springs exist with these params; every bounce ≤ 0.10; `lift` settle ≤ 400 ms (from `springTwin`); the aliases resolve to the new springs |
| new e2e `e2e/wave2/identity-v2/menu-keyboard.spec.ts` (W3) | a keyboard-opened menu has no running animation at t = 0 (`getAnimations().length === 0`) |
| new e2e `e2e/wave2/identity-v2/scrim.spec.ts` (W3) | on dialog close, the scrim's computed opacity reaches 0 no later than the panel's |
| new e2e `e2e/wave2/identity-v2/reduced-motion.spec.ts` (W3, extended by W4/W5) | with `reducedMotion: 'reduce'`, no running animation changes `width`, `height`, `transform` or a View Transition for the §6 cases |
| new e2e `e2e/wave2/identity-v2/live-loop.spec.ts` (W5) | the live dot's animation is finished 5.2 s after a step starts; none runs in a hidden tab |
| `wave2/no-blur-entrance`, `wave2/no-backdrop-filter` | no product-chrome exemptions left (TOKENS §7) |
| `scripts/check-native-motion.mjs` (extended, W7) | bans `.blur` inside `transition`/`animation`; bans `bounce:` > 0.10; bans `platformFactor` |
