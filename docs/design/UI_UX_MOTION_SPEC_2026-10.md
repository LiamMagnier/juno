# Alevr UI, UX and motion spec, wave 2 (revision 2): Editorial Calm, Finished

Status: final synthesis, revision 2, 2026-10-16. This replaces revision 1. It resolves every problem, gap and overlap raised in the revision-1 critique; §16 is the item-by-item ledger. Repo codename Juno is never shown to users.

**Base direction.** Editorial Calm, Finished has the best combined judge score: 8.5 + 7.5 + 8.0 = 24.0. Calm Instrument scored 22.5 and Glass Over Paper 17.0. This spec grafts the best ideas from both runners-up and closes every judge must-fix (§13).

**Starting point.** Wave 1 is integrated on `claude/integrate-wave1` at 244366124 (“reconcile wave 1 branches with each other after the merge”). As of this revision that commit has no unmerged paths. Wave 1 provides:
- motion tokens and reduced-motion tiers, including the generated `postcss/motion-preference.cjs` twins
- exits and same-document view transitions (`src/lib/view-transition.ts`)
- the galaxy working indicator and the global `--presence` token
- home starter prompts
- mobile web bottom sheets and the edge-swipe drawer (`src/lib/sheet-gesture.ts`)
- branching, the answer selection bar and inline reasoning
- the Code composer and session rows

This spec builds on that work and keeps wave 1's tested numbers wherever they exist. No wave-2 worktree is cut until P0's base gate passes (§14).

**Evidence.** Values come from code and token reads plus contrast arithmetic run in a throwaway script. Contrast uses WCAG 2.x relative luminance. Colour-vision deficiency is simulated with the Machado 2009 matrices. No screenshots, servers, builds or simulators were used, because the owner is short on RAM. Every value still needs visual QA on production builds (§14).

Notation:
- NEW means a new token or component. RETIRED means deleted.
- [S#] means owner sign-off is needed (§11). [P#] is the owning package.
- Web values are px or rem; native values are pt.
- A rung is one step of the duration ladder.

---

## 1. Decisions

| # | Decision | Why |
|---|---|---|
| D1 | The base is Editorial Calm. From Calm Instrument it takes: TurnStatus (the live line that becomes the receipt), the Now section, quote and attachment travel, the 560ms greeting clip-wipe, the type floor, the 35% first stream band, the phase-word hold, latency marks, keep-alive dock panes (with eviction, D29), the static fade overlay and optimistic rollback. From Glass Over Paper it takes: resource budgets, paper for content and glass for native controls, velocity settle, the approval signal edge, the finished-away wash, finish-check gating and opt-in Quick Entry Autofill. | Highest combined score. TurnStatus supplies the ownable moment the judges asked for. |
| D2 | Transition and animation durations use only 70, 120, 160, 220, 360 and 560ms. Delays, holds, loop periods, spring settle times and stream pacing are separate named token families (§4.2) that lint accepts by name. There is no editorial rung: the first-visit greeting is a 560ms clip-wipe, and the galaxy entrance moves from 420 to 360. | Keeps the ladder closed and the lint buildable. |
| D3 | Needs you is shown by the signal colour, the hand glyph and the word, in every product and on every platform. **Signal** moves from coral (hue 14) to ember (hue 24 in light, 28 in dark). **Destructive** moves from hue 3 to 356. In light they sit 28° apart with 1.71:1 luminance contrast (2.30:1 under deuteranopia simulation, up from 1.61). In dark the contrast is 1.81:1 (2.00:1 simulated, up from 1.17). Presence means live only. `--attention` means budget, limit and offline warnings only. Every status consumer reads role tokens (§3.4). [S1] | One status language. Red-versus-orange confusion is fixed by luminance and shape, not hue alone. |
| D4 | No colour-only dots. The badge is a 10px hand on a 16px signal-wash disc, with a word for assistive tech. | Separation under CVD and normal vision. |
| D5 | Hairline and scrim keep today's warm values. A graphite retune is a candidate behind [S2]. | A judgement call, not a cleanup. |
| D6 | One user bubble everywhere: card radius 12 with an 8 tuck on the bottom-trailing (logical end-end) corner, padding 10/16 (today's `px-4 py-2.5`, unchanged), max 85% of the column, fill `--user-bubble`. Code v2's 18px bubble is RETIRED. Controls drawn on the bubble use NEW `--user-bubble-hover`. It ships as one token set plus one component per platform, behind a six-context parity gate. [S3] | Ends four bubble variants without creating new drift. |
| D7 | Chords come from one registry per platform (§5.7). Native: ⌘1/⌘2. Web on macOS: ⇧⌘1/⇧⌘2, because browsers bind ⌘1–⌘9 to tabs. Web on Windows and Linux: Ctrl+Shift+1/2. No Ctrl+Alt chord is used on Windows or Linux, because that combination is AltGr on many layouts. | One chord everywhere is impossible on the web. |
| D8 | The Mac product switch stays centred in the toolbar. | It can never be hidden by a collapsed sidebar. |
| D9 | Running rows show a 10px galaxy still frame (a static SVG, not a canvas), medium weight and an sr-only “Running”. A canvas mounts only while a galaxy animates, in the live line or a hovered or selected row, and never more than 3 per window. | Fixes the base contradiction and the per-row canvas cost. |
| D10 | Now (Needs you, then Running, then Ready) replaces the Needs-you fold. Orbit and the notifications bell stay until Activity (G70) ships with its Updates tab. | Nothing is removed before its replacement exists. |
| D11 | The transcript follows instantly while streaming, as the windowed transcript does today. The velocity spring is used only after an explicit Jump to latest. No new scroll dependency is added. The pinned user turn stays in wave 2 G18. | The windowed transcript cannot race a smooth scroll. |
| D12 | The bottom fade is a static 32px gradient overlay whose opacity toggles. The scroller's `mask-image` is RETIRED. | The scroller is no longer composited on every streamed frame. |
| D13 | Transcript widths stay 40/48/62rem (640/768/992), with the stored ids narrow, medium and wide. Prose fills the column at narrow and medium. At wide, prose is capped at 75ch while code, tables, artifacts and the bubble use the full 992. The Mac measure stays 768, and JunoReadingMeasure gains narrow 640 and transcriptWide 992. | No silent width change, and wide lines stay readable. |
| D14 | The iOS transcript keeps its eager VStack. It adds a 40-turn render window with “Show earlier” paging, Equatable rows, memoised parts and one environment actions object. It moves to LazyVStack only after an Instruments profile and a regression test for the blank-transcript bug. | Meets the memory budget without the measured LazyVStack regression. |
| D15 | No backdrop-filter in product chrome, and the web header is opaque. Allowed: marketing (`src/components/home`, `src/components/landing`), design-editor content (`src/lib/design`, `src/components/design`, `src/app/dev`) and `.media-scrim` over images. Native Liquid Glass stays on the control layer and follows the system Reduce Transparency setting, so no in-app transparency toggle is needed. | Saves GPU memory and repaint. |
| D16 | The type floor is 12px on web, 11pt on macOS and 12pt on iOS. On web, 11px `text-kbd` is allowed only for keycaps and count badges of up to 3 characters. P1 raises `text-caption` from 11 to 12px and `text-micro` from 10.5 to 12px in one place, which lifts all 1,344 uses at once. Each package then moves its own uses to the semantic rung (label or ui). | Deliverable, and honest about Mac density. |
| D17 | Stagger animates at most 4 items: rows 30ms, tiles 45ms, onboarding rows 60ms. Later items paint with the fourth. Nothing opened from the keyboard staggers. | Speed. |
| D18 | Wave 1's `src/lib/sheet-gesture.ts` is the single source for gestures, and its constants are generated to Swift: **Thresholds:** sheets dismiss at 0.5px/ms or 30% travel; the drawer opens at 0.3px/ms or 40%; intent slop is 8px. **Edges:** the web edge zone is 24px; on iOS a 16pt edge strip yields to the system back gesture. **Rubber band:** (1 − 1/(x·0.55/64 + 1))·64. **Release settle:** clamp(remaining/abs(v), 140, 300)ms on `--ease-drawer` on web; `interpolatingSpring(duration: the same clamp, bounce: 0, initialVelocity: v/remaining)` on iOS. There is no second implementation. | Reconciles with wave 1 instead of replacing it. |
| D19 | NEW `--muted-foreground-on-fill` for text on hover and selected fills, plus a CI contrast matrix with corrected rules (§3.1). | #686B70 on the selected fill is only 4.32:1. |
| D20 | Approvals take focus only when focus is in the thread, or in a composer that is empty or has been idle for 2s; otherwise they announce without stealing. The container is role=group, never alertdialog. ⌘↩ approves only when focus is inside the approval and the arm has finished, and the arm restarts every time focus enters. An approval never replaces a non-empty draft. Esc never denies. | Removes the steal-and-approve hazard for people who send with ⌘↩. |
| D21 | An exit takes the rung below its entrance, or a shorter one, on ease-in: 560 or 360 → 220, 220 → 160, 160 → 120, 120 → 70. | Law 3. |
| D22 | Turn rails use 24×24 targets. When ticks would sit under 24px apart, a Turns menu replaces the rail. Previous/next turn is ⌥⌘↑/↓ on macOS and Alt+Shift+↑/↓ on Windows and Linux. | WCAG 2.5.8, and no AltGr chords. |
| D23 | Wave 1's same-document view transitions stay (`thread` and `canvas`). `ROUTE_WAIT_MS` drops from 450 to 80, the root swaps instantly, and only the named group animates. No `@view-transition` rule is added: it only affects cross-document navigation, which is a no-op in the App Router. Further named shared elements wait for React 19.3 and Next 16. No signature moment depends on them. | Matches the code and keeps route latency inside budget. |
| D24 | Dependencies: G01 (push) for run and approval Live Activities and notification approvals; G68 for native provider sign-in; G70 for Activity and removing the bell; G18 for the pinned turn. | |
| D25 | The receipt at rest shows the route and model (“Auto · Sonnet 4.6”), plus effort when it is not the default. Tokens and cost appear only when Settings › Models & routing › Show usage on answers is set to Tokens or Tokens and cost; the default is Off. Cost uses the account's billing currency via Intl.NumberFormat. | One definition, calmer by default. |
| D26 | The Ultramarine accent preset is byte-identical to presence, so it is retuned to Cobalt, hsl(205 78% 36%) #1468A3 (5.93:1 under a white label), keeping its stored id `ultramarine`. [S7] Custom #rrggbb accents stay. Instead of a hue rule, one invariant applies: accents never paint status, and status never depends on hue alone. | Presence never doubles as decoration. |
| D27 | Only transform, opacity, clip-path and grid-template-rows animate. Width or height may animate in four named cases only, and never with overshoot: the sidebar width fold, dock and inspector resize settle, composer height, and the Quick Entry panel height. | An honest rule that matches the design. |
| D28 | One name per curve: the generator emits a CSS linear() twin for every framer spring. RETIRED: `--spring-pop` (its uses move to `--spring-reward`), framer `spring.interactive` (moves to snap or press) and `--stagger-fav` (moves to `--stagger-row`). `--ease-spring` stays as a cubic curve for pop-in entrances. | Removes the two meanings of “standard”. |
| D29 | Dock panes stay alive, with eviction. At most 3 panes are live. A pane hidden for 10 minutes, or any pane beyond the cap, is evicted. xterm scrollback is serialised and restored. An evicted preview shows “Preview paused · Reload”. | RAM. |
| D30 | Incognito copy claims only what is true today; the training clause waits for [S8]. A confirmation appears only on in-app navigation away from a non-empty incognito chat, and it offers “Don't ask again”. | Legal accuracy, and less friction than revision 1. |
| D31 | Web sign-in is identifier-first, with an identical step 2 for every email. | No account enumeration. |
| D32 | Onboarding is gated on the server, through a Prisma migration with a backfill cutoff. | Existing accounts are never onboarded again. |
| D33 | Merge order is not ship order. Packages merge into `integrate-wave2`, and users get releases in trains (§14), so no inconsistent half-state ships. | Keeps the needs-you colour and the type floor consistent. |
| D34 | Run and approval Live Activities ship dark until G01. The voice Live Activity ships now (foreground, local). | A Live Activity that cannot update is worse than none. |
| D35 | Quick Entry handles a taken hotkey with a visible conflict state and an inline recorder. | ⌥Space is ChatGPT's default. |
| D36 | Code plan gating has a defined locked state at every entry point. | Code requires PRO (minPlan PRO). |
| D37 | The Electron renderer (`native/desktop-electron`) is frozen for wave 2, and its `tokens:check` must keep passing after P1. | Out of scope, but protected. |

---

## 2. Principles: seven laws, each lintable or measurable

1. **Typefaces have fixed jobs.** Serif speaks, sans works, mono annotates.
   - Newsreader is only for greetings, page h1s, empty-state titles, sign-in and onboarding titles, and the canvas document title.
   - Inter (SF Pro natively) is for every control and all reading text.
   - JetBrains Mono (SF Mono natively) is for every number, time, receipt, path and keycap.
2. **Colour means state.** Graphite is the resting state. Presence means Alevr is live here. Signal means needs you. Destructive means blocked or failed. Accents fill only the user's own controls. Every status has a glyph and a word.
3. **Every entrance has an exit**, on the rung below or shorter, with ease-in.
4. **Nothing moves without a cause.** The galaxy is the only working mark, and shimmer is gone. No loop runs without real state behind it. At most 3 galaxies animate per window, and they pause off screen, in hidden tabs and in inactive windows.
5. **Speed is part of the design.** These targets hold:
   - the bubble is painted within 100ms of Enter
   - the live line is readable at about 250ms
   - the sidebar paints in the first frame from SSR
   - utility pages settle in under 300ms
   - the one editorial entrance is 560ms, on the first visit per session
6. **Paper for content, glass for native controls.** Content is opaque. Native Liquid Glass sits only on the floating control layer. The web uses opaque recipes (D15).
7. **Light on the machine.** Memory, launch and repaint budgets are gated in CI (§9).

---

## 3. Tokens

Every token is authored once in `src/app/globals.css` (HSL) and `tailwind.config.ts`. `scripts/generate-design-tokens.ts` generates `src/lib/design/tokens.generated.ts` and `JunoGeneratedTokens.swift` from them. The native-parity drift gate covers every token below. [P1]

### 3.1 Colour roles (light | dark)

| Role | Light | Dark | Notes |
|---|---|---|---|
| background | 240 20% 99% #FCFCFD | 220 5.9% 10% #18191B | canvas |
| card | #FFFFFF | 225 5.6% 14.1% #222326 | |
| popover | #FFFFFF | 225 4.9% 16.1% #27282B | |
| foreground | 216 9.1% 10.8% #191B1E (17.3:1) | 220 7% 91.6% #E8E9EB | primary disc fill, ring |
| muted-foreground | 217.5 3.7% 42.4% #686B70 (5.35 card, 5.22 canvas, 4.86 sidebar, 4.69 bubble) | 222.9 3.4% 59.8% #95979C (6.02 bg, 5.38 card, 5.18 bubble) | quiet text on canvas, card, popover, sidebar, user-bubble and muted only |
| muted-foreground-on-fill NEW | 217.5 4% 38.8% #5F6267 (4.95 selected, 4.77 sidebar-selected, 5.04 sidebar-hover, 4.90 bubble-hover) | 222.9 4.1% 66.5% #A6A8AD (4.92 selected, 5.71 hover) | text and metadata on hover and selected fills |
| ink-tertiary NEW | 220 4% 62% #9A9DA2 (2.72) | 222 3% 42% #686A6E | decorative glyphs and separators only, never text |
| secondary / accent (hover fill) | 210 6.7% 94.1% #EFF0F1 | 225 4.3% 18.4% #2D2E31 | |
| user-bubble | 210 6.7% 94.1% #EFF0F1 | 225 5.1% 15.3% #25262A | the one bubble fill on every product and platform |
| user-bubble-hover NEW | 210 6% 90.2% #E5E6E8 | 225 5% 19.5% #2F3034 | hover and press of controls drawn on the bubble (Show more, editor buttons); text on it uses foreground or muted-on-fill |
| muted | 210 11.1% 96.5% #F5F6F7 | 225 6.1% 12.9% #1F2023 | recess, empty well, skeleton |
| border | 220 4.9% 88% #DFE0E2 (1.32) | 225 3.6% 22% #36373A | decorative separator, exempt from 3:1 |
| input | 214.3 3% 53.9% #86898D (3.51 card, 3.43 canvas) | 220 2.6% 45.1% #707276 (3.65 bg, 3.26 card) | edges that identify a control: fields, checkbox and radio outlines, switch off-track |
| hairline | 48 12% 18% / 0.06 | 45 14% 94% / 0.08 | unchanged [S2] |
| sidebar | 210 9.1% 95.7% #F3F4F5 | 210 5.6% 7.1% #111213 | |
| sidebar-hover | 210 4.5% 91.4% | 210 3.3% 11.8% | |
| sidebar-selected | 220 5.5% 89.2%, border 216 5.6% 82.5% | 220 4.2% 13.9% | |
| selected | 220 6.4% 90.8% #E6E7E9 | 228 4.3% 22.5% #37383C | |
| scrim | 48 12% 8% / 0.26 | 0 0% 0% / 0.55 | unchanged [S2]; partial-detent web sheets use half this opacity (§5.6) |
| presence | 229 63% 48% #2D49C9 (7.22 card, 5.84 selected) | 229 61% 75% #98A7E6 (7.54 bg, 5.02 selected) | live only |
| presence-ink | = presence | = presence | |
| presence-wash NEW | presence / 0.10 | presence / 0.16 | finished-away wash |
| signal (glyph) | 24 80% 46% #D36317 (3.77 card, 3.05 selected) | 28 95% 70% #FBAE6A (9.52 bg, 6.34 selected) | glyph and badge colour, never text |
| signal-ink (text) | 22 78% 40% #B65116 (5.03 card, 4.90 canvas) | 28 95% 72% (about 10:1 on bg) | text only on background, card and popover |
| signal-wash NEW | signal / 0.14 | signal / 0.18 | badge disc |
| destructive | 356 72% 42% #B81E28 (6.45 card) | 356 70% 64% #E3636C (5.25 bg, 4.69 card) | blocked or failed, always with circle-x |
| success | 139.6 63.8% 29.2% | 136.1 41.8% 61.6% | diff additions and “Saved” only, never status |
| attention | 34.2 91.9% 29.2% #8F5406 (6.11) | 35.6 57.9% 61.8% | budget, limit and offline warnings only, always with a warning glyph and a word [S1] |
| `--cmp-ink-2`, `--cmp-well`, `--cmp-well-2`, `--cmp-well-3` | unchanged | unchanged | move from composer.css into globals.css so they generate to Swift |

Rules:
- Text on hover, selected, sidebar-selected or bubble-hover fills uses `--muted-foreground-on-fill` or foreground.
- Text-colour tokens never carry opacity. Lint bans `text-<token>/<NN>` utilities (72 uses in 44 files today). `disabled:opacity-*` stays allowed.

**Contrast matrix (CI) [P1].**
- **Grounds:** background, card, popover, sidebar, sidebar-hover, sidebar-selected, selected, user-bubble, user-bubble-hover and muted, each in light, dark and high contrast.
- **Text:** at least 4.5:1, or 3:1 at 24px regular or 18.66px bold. Under high contrast, muted and body text must reach at least 7:1 on every ground.
- **Pairs checked:**
  - foreground and muted on the base grounds (background, card, popover, sidebar, user-bubble, muted)
  - muted-on-fill and foreground on every fill
  - signal-ink, presence-ink and destructive as text only on background, card and popover
  - glyph inks (presence, signal, destructive, success) at least 3:1 on every ground, selected included
- **Non-text boundaries** that identify a control must reach at least 3:1 against adjacent colours. These are input field edges, checkbox and radio outlines, the switch off-track and the focus ring, and they use `--input` or `--ring`. `--border` and `--hairline` are decorative separators and are exempt. Controls identified by a fill or a text label need no boundary (WCAG 1.4.11).
- **Known bad pair:** the matrix keeps #686B70 on #E6E7E9 = 4.32 as a recorded failing pair, and a lint asserts that no muted text is placed on a fill.

### 3.2 High contrast (NEW)

High contrast applies under `@media (prefers-contrast: more)` unless `html[data-contrast=standard]` is set, under `html[data-contrast=more]` (the in-app toggle), and natively under Increase Contrast. It is generated as a third appearance.

| Token | Light | Dark |
|---|---|---|
| muted-foreground and muted-on-fill | 217 5% 28% #44474B (≥7.27:1 on every ground) | 223 5% 80% #C9CBCF (≥7.21:1 on every ground) |
| border | 220 5% 48% #747881 (4.42 card, 3.58 selected) | 225 4% 52% #808289 (4.58 bg, 4.09 card) |
| hairline | becomes a solid 1px border | same |
| presence | #1F38A8 (9.59 card) | #B4C0F0 (9.83 bg) |
| signal-ink | 20 80% 32% #933C10 (7.26 card) | 26 100% 80% #FFC599 (≥7.6 on every ground) |
| destructive | 356 75% 34% #98161E (8.51 card) | 356 90% 82% #FAA8AD (9.44 bg) |
| focus ring | 3px | 3px |
| tone-step boundaries (bubble, composer, card, chip, selected row) | 1px border at foreground / 0.32 | same |

Under forced-colors, borders use CanvasText; focus, presence and galaxy ink use Highlight; status relies on glyph and word.

### 3.3 Accents

There are seven presets with their existing ids: coral, ultramarine, juniper, teal, violet, amber and sage. JunoAccent already has human labels. Web ACCENTS gains a `label` field, used for its aria-label, with the same labels.
- Ultramarine is retuned to Cobalt per D26: the label becomes “Cobalt” and the id is unchanged.
- Custom #rrggbb accents remain accepted by the settings API.
- Accents fill only switches, slider fill, the selected segmented thumb, the keyboard-focus composer edge and the macOS 27 accent-tinted sidebar glyphs.
- **Invariant:** no status mark, status text or status badge ever uses the accent, and every status has a glyph and a word. This replaces revision 1's “no accent within 20° of hue 14” rule, which custom hex accents made unenforceable.

### 3.4 Status vocabulary and role tokens

NEW role tokens:
- `--status-running: var(--presence)`
- `--status-needs-you: var(--signal)`
- `--status-needs-you-ink: var(--signal-ink)`
- `--status-ready: var(--foreground)`
- `--status-blocked: var(--destructive)`

One web component, StatusMark [P2], and one Swift enum, JunoStatus [P3], read them.

| State | Ink | Glyph | Word | Motion |
|---|---|---|---|---|
| Running | presence | galaxy: 10 in rows (static SVG unless hovered or selected), 12 in lines and plan rows, 14 in the live line | Running | animates only in the live line or a hovered or selected row; at most 3 per window |
| Needs you | signal | hand: 10 in rows, 12 in lines; badge is a 10 hand on a 16 signal-wash disc | Needs you | on arrival the hand cross-fades in over 160, pulses once (1→1.08→1 over 560), then holds |
| Ready | foreground, medium weight | check 12 | Ready | the check draws over 360 on `--ease-spring` after `--hold-check` (120), only if the reader watched a run longer than 10s; otherwise it is static |
| Blocked | destructive | circle-x 12 | Blocked | still |

The same vocabulary drives:
- sidebar Now and Recent rows, and the home In flight strip
- Activity, once G70 ships
- the Mac menu bar extra and Dock badge
- the iPhone drawer and switch badge
- widgets and Live Activities
- PlanStepGlyph

### 3.5 Type ladder

| Rung | Web | macOS | iOS |
|---|---|---|---|
| hero (marketing only) | Newsreader clamp(2.4rem, 1.774rem + 2.783vw, 4rem)/1.1, −0.02em | – | – |
| home-title NEW | Newsreader 400, clamp(2.125rem, 1.5rem + 2.2cqi, 3.125rem)/1.1, −0.02em | Newsreader 30 | Newsreader 34 |
| display | Newsreader 500, clamp(2rem, 0.333rem + 4.167cqi, 3rem)/1.08, −0.02em | Newsreader 30 | Newsreader 34 |
| page-title (every app h1, Settings included) | Newsreader 500, clamp(2rem, 0.75rem + 3.125cqi, 2.75rem)/1.08, −0.03em; fixed 1.75rem below 640 | system navigationTitle | Newsreader 28 |
| title | Inter 600, 1.375rem/1.25, −0.012em (empty-state panel titles in Newsreader at this size) | 22 | 22 (.title2) |
| heading | Inter 600, 1.125rem/1.3 | 15 semibold | 17 (.headline) |
| body-lg | 1.0625rem/1.6 | – | – |
| reading (both speakers) | 1rem/1.7 | 15/1.6 | 17 (.body)/1.45 |
| body | 0.9375rem/1.6 | 13 | 17 |
| nav | 0.875rem/1.25rem | 13 | 16 (.callout) |
| ui (every control label, tooltips, notification bodies) | 0.8125rem/1.5 | 13 | 15 (.subheadline); 17 for the primary control |
| label (all metadata, section headings) | JetBrains Mono 500, 0.75rem/1.4, 0.01em, tabular-nums, sentence case | SF Mono 11 | SF Mono 12 (.caption1) |
| caption (deprecated name) | 0.75rem/1.4 sans, raised from 11px | – | – |
| micro (RETIRED name) | aliased to caption at 0.75rem until its uses migrate | – | – |
| kbd NEW | 0.6875rem (11px) mono, for keycaps and count badges of up to 3 characters only | – | – |

Floors are 12px on web, 11pt on macOS and 12pt on iOS at default Dynamic Type.

**Transcript-chrome law.** Inside `.turn-body` and the composer there are exactly three sizes: reading 16 for content, ui 13 for controls, label 12 for metadata. Lint flags `text-caption`, `text-micro` and arbitrary sizes in `.turn-body`, the composer, tooltips, notifications and the sidebar. It warns everywhere and errors in enforced scopes (§14). `text-kbd` is allowed only inside Kbd and Badge.

**Text size.** One scale with shared ids and no migration: xs 14, small 15, default 16, large 17, xl 18, xxl 20 px.
- **Web:** `src/components/settings/font-size.ts` sets the root font-size. Every type rung, line height and control height is in rem and scales. Radii, borders, hairlines and icon glyphs stay in px.
- **macOS:** `junoTextScale` is px/16 (0.875–1.25) for the same id; DesktopTextSize already shares the ids. JunoScaledFont multiplies it into every `.junoFont` site and into Studio fonts, with a `chrome:` opt-out for the sidebar and toolbar. There are 695 sites in total: 300 in the Mac app, 177 in the kit, 212 on iOS and 6 in Code. On iOS the multiplier is 1 and Dynamic Type applies instead.
- **iOS:** Dynamic Type through `@ScaledMetric(relativeTo:)`, icons included, with a `fixed:` opt-out for glyphs inside glass.

### 3.6 Spacing

- Base unit 4px. Steps: 2, 4, 6, 8, 12, 16, 20, 24, 32, 40, 48, 64.
- Sidebar text edges are exactly 16 (titles and headings) and 46 (nav labels). Section headings carry no glyph; the Orbit heading drops its glyph.
- Page gutter: 16 below 640, 24 at 640–1023, 32 at 1024 and above.
- Turn rhythm: 16 between a bubble and its answer, 32 between turns, 24 between answer parts.
- Transcript content padding-bottom is `--transcript-fade` (32) + 16.

### 3.7 Radius (lint-enforced, concentric)

- **Ladder:** xs 6 (keycaps, inline [n] chips, badges); control 8 (rows, menu items, small buttons, tooltips); field 10 (inputs, product-switch track); card 12 (cards, toasts, tiles, popovers); menu 14; panel 16 (dialogs, sheet top corners); composer 22 on all platforms; composer-action 12 (the disc); composer-control 10; full (chips, pills). NEW `--radius-bubble` 12 with `--radius-bubble-tuck` 8 on the end-end corner.
- **Primary disc:** 36×36 at radius 12, continuous, inset 10 inside the 22 composer on every platform.
- **Native:** `JunoComposerMetrics.cornerRadius` changes from 24 to 22. The constant is kept, not deleted, so DesktopVoice, DesktopDictation, ComposerDictation, DesktopQuickEntry, ComposerTraySnapshotTests and NativeAgentsHome keep compiling. The iOS literal 24s become 22.
- **Nested shapes:** `.containerConcentric` on SwiftUI and `NSViewCornerRadius.containerConcentric(minimumCornerRadius: 8)` on AppKit, each behind `#available` with a fixed-radius fallback.
- **Web progressive enhancement:** `@supports (corner-shape: superellipse(1.5))` on the composer, card and panel radii, tuned by eye in Chrome. Other browsers keep plain radii.

### 3.8 Elevation and materials

- **L0, in flow:** a hairline or 1px border, no shadow.
- **L1, raised:** 0 1px 2px ink/0.04.
- **L2, lift** (menus, popovers, toasts, selection bar, jump pill): 0 1px 2px ink/0.04 and 0 4px 12px −4px ink/0.08.
- **L3, float** (dialogs, palette, sheets, overlay sidebar): 0 0 0 1px ink/0.03, 0 2px 6px ink/0.05 and 0 14px 36px −10px ink/0.16.
- **Dark mode** uses black shadow ink at the existing 0.25/0.35/0.6 recipes.
- **Web backdrop-filter** follows D15. Today's 34 files are fixed by their owners:
  - P5: chat (7 files, including memory-updated-notice and generated media), chat/sketch
  - P4: app (3 files)
  - P2: ui (2 files)
  - P7: library (2), agents (2), projects, canvas, admin
  - P1: globals.css
  - Allowlisted: `src/app/dev/**`, `src/lib/design/**`, landing and home
- **Native:** Liquid Glass `.regular` on the control layer only, with `.interactive()` on controls only. `.clear` only over media, with a 35% black dim. Under Reduce Transparency, an opaque card plus a hairline. Under Increase Contrast, a 1px foreground/0.24 edge. Custom glass follows the macOS and iOS 27 Liquid Glass slider behind `#available`, with a 26 fallback.
- **Approval card:** opaque, with a 2px signal leading edge.

### 3.9 Focus

- One ring everywhere: a 2px solid `--ring` outline at a 2px offset (3px in high contrast). It never changes the element's radius.
- Delete Code v2's radius-changing focus rule and every local `ring-2` recipe.
- The composer edge is foreground/0.24 for pointer focus. Keyboard focus uses the 2px ring on web and junoAccent at 0.86 natively, cross-fading over 120.

### 3.10 Iconography

- The custom 24-unit pixel-hinted family stays, shipped natively as generated SF Symbol templates.
- Sizes: 16 in rows and controls (kebabs move from 14 to 16), 20 in phone bars and native toolbars, 12 inline in metadata.
- Galaxy sizes: 14 in the live line, 12 in Code and plan rows, 10 in sidebar rows. Every non-animating galaxy is a static SVG symbol drawn in currentColor.
- Hover articulation on destinations only: a 1.35× pose on out-back over 220, returning on out-soft over 160. Never on menus, lists, message actions or the composer.
- Press dip to 0.97 over 70, on solo icon buttons only.
- **PlanStepGlyph** NEW (web and Swift): done = check; active = galaxy 12; waiting = hand in signal; failed = circle-x in destructive; skipped = minus; pending = a 1.5px circle in muted ink.
- Spinners appear only inside buttons. A progress arc replaces upload spinners.

### 3.11 Dot-matrix rule

1px dots at a 4px pitch, foreground/0.16 in light and /0.20 in dark. Used only for editorial dividers, the home field and the empty-state mark, never in the transcript. The home field is neutral ink with no presence lamp.

### 3.12 Shell and gesture tokens (NEW, generated to TS and Swift)

| Token | Value |
|---|---|
| `--sidebar-min` / `--sidebar-default` / `--sidebar-max` | 224 / 260 / 352 (web and Mac) |
| `--drawer-width` | min(80vw, 380px) |
| `--drawer-parallax` | 0.22 |
| `--drawer-dim` | 0.12 light / 0.30 dark (raised from 0.04 so tapping outside reads as an affordance) |
| `--edge-zone` | 24px on web (wave 1); `JunoGesture.edgeStrip` 16pt on iOS |
| `--gesture-slop` | 8px |
| `--gesture-dismiss-velocity` / `--gesture-dismiss-fraction` | 0.5px/ms / 0.30 |
| `--gesture-open-velocity` / `--gesture-open-fraction` | 0.3px/ms / 0.40 |
| `--rubber-band-limit` / `--rubber-band-c` | 64px / 0.55 |
| `--settle-min` / `--settle-max` | 140ms / 300ms |
| `--snap-zone` | 16px |
| `--header-h` | 48px |
| `--composer-h` | published on :root by the mounted composer; 0px when there is no composer |
| `--kb-inset` | published on :root from visualViewport on phones |
| `--transcript-max` | 40rem / 48rem / 62rem |
| `--transcript-fade` | 32px |
| `--galaxy-max-animating` | 3 |
| `--stagger-row` / `--stagger-tile` / `--stagger-onboarding` / `--stagger-max` | 30ms / 45ms / 60ms / 4 |
| `--dock-panes-max` / `--dock-pane-evict` | 3 / 10 min |

`sheet-gesture.ts` imports its constants from tokens.generated.ts, with values unchanged.

### 3.13 Localisation and direction (NEW)

- Every new string lives in the shared table (§6.18), in English and French. Parity CI covers web, Mac and iOS.
- New CSS uses logical properties (padding-inline, inset-inline-start, border-end-end-radius). The bubble tuck sits on the end-end corner, so it mirrors in RTL. Direction-aware slides (the sign-in step change, the phone catalogue drill-in) flip under `[dir=rtl]`.
- Fixed controls tolerate 130% string expansion:
  - the model chip truncates at max-inline-size 12rem with an ellipsis and a tooltip
  - each Chat | Code track segment sizes to content, up to 50%
  - buttons never clip; inside sheets they wrap to a second line

---

## 4. Motion

### 4.1 Duration rungs

| Token | ms | Curve | SwiftUI | Used for |
|---|---|---|---|---|
| press | 70 | out-soft, scale 0.97 | interactiveSpring(response: 0.15, dampingFraction: 0.86) | the press dip; exits of 120 overlays |
| fast | 120 | out-soft | JunoMotion.fast | frequent overlays, cross-fades, colour |
| exit | 160 | in | JunoMotion.exit | exits of 220 entrances |
| base | 220 | out-soft | JunoMotion.base | default entrances |
| slow | 360 | out-expo | JunoMotion.slow | regions, sheets, galaxy entrance |
| emphasis | 560 | out-expo | JunoMotion.emphasis | changes the user did not cause, the first-visit greeting, the wash, research travel |

### 4.2 Named timing families

These are not durations, and lint accepts them by token name.

| Family | Tokens |
|---|---|
| Delays | `--delay-show` 200 (TurnStatus, skeleton), `--delay-tooltip` 500, `--delay-tooltip-skip` 300, `--delay-hairline` 300 (palette in flight), `--delay-action-row` 180, `--delay-greeting` 60, `--delay-insert-flush` 300 |
| Holds | `--hold-phase` 600, `--hold-skeleton` 400, `--hold-check` 120, `--hold-reasoning` 1000, `--hold-arm` 500, `--hold-needs-you-max` 2000, `--hold-insert-max` 10000, `--hold-composer-idle` 2000 |
| Loops | `--loop-breathe` 1.8s, `--loop-galaxy` 2.4s, `--loop-galaxy-calm` 4.8s after 20s |
| Physics | `--spring-<name>-dur` (generated settle times, §4.4), `--settle-min` 140, `--settle-max` 300 |
| Stream | `--stream-band` 280 (5 bands), `--stream-tail-max` 250, rate clamp(pending/250ms, 20, 800) graphemes/s, hidden-tab drain timer 50 |

Lint rule: every literal in a CSS transition or animation duration or delay, and every framer `duration` or `delay`, must be a rung or must reference one of these tokens or the matching TIMING constant in `src/lib/interaction.ts`.

RETIRED literals and tokens: 80, 250, 260, 320, 420, 760 and 900ms; `--alv-ease`; `--rf-ease`; Code's `--dur-mid` and `--dur-wide`; Sonner's default timings.

### 4.3 Curves (CSS cubic-bezier = SwiftUI `.timingCurve`, same numbers)

- out-soft (.33, 1, .68, 1): entrances and colour.
- out-strong / drawer (.32, .72, 0, 1): docks, sheets, drawers.
- out-expo (.16, 1, .3, 1): region changes, the palette, any travel of 360 or more.
- in (.4, 0, 1, 1): every exit.
- in-out (.65, 0, .35, 1): folds, width folds, composer height.
- breathe (.45, 0, .55, 1): skeleton and galaxy core.
- out-back (.34, 1.32, .64, 1): transform only, for destination hover poses. Never on width, opacity, colour or exits.
- `--ease-spring` (.22, 1, .36, 1): pop-in entrances and the check draw. It already maps to out-soft under Tier B.

### 4.4 Springs

Each spring is defined once as framer `{visualDuration, bounce}`, which equals SwiftUI `.spring(duration:, bounce:)`, plus a generated CSS linear() twin.

| Spring | Value | CSS twin | Used for |
|---|---|---|---|
| snap | 0.18 / 0 | `--spring-snap` | palette and list highlight, travelling selection, menu thumbs. Replaces the literal 520/40/0.7 and `spring.interactive` |
| standard | 0.22 / 0.05 | `--spring-standard`, regenerated from these parameters to replace today's hand-written 250ms linear(). Expected settle is 250–270ms; generator output is authoritative | selection, product-switch and segmented thumbs (Code too), tiles, infrequent overlays, toasts, live→finished height. Web framer `spring.standard` moves from bounce 0 to 0.05 |
| layout | 0.36 / 0 | `--spring-layout` | gap closing, chat layout, Quick Entry height |
| emphasized | 0.36 / 0.10 | `--spring-emphasized` | the home→dock composer handoff only |
| reward | 0.36 / 0.18 (about 1.1% overshoot) | `--spring-reward` | copy check, accent tick, attachment chip joining, thumbs-up. Replaces `--spring-pop` (2.8% overshoot). Thumbs-down never uses it |
| articulate | 0.22 / 0.15 | `--spring-articulate` | destination icon poses |
| sendMorph | 0.22 / 0.10 | – | the native glassEffectID disc morph only. Glyph faces cross-morph over 120 from scale 0.8 on every platform |
| settle | D18 | – | drawers and sheets |

Banned: `.bouncy`, a bare `.spring()`, stock `.easeInOut`, and any non-interruptible animation of stateful UI.

### 4.5 Choreography rules

1. One emphasis per moment; never stack entrances.
2. No blur in any entrance.
3. Travel is at most 24px × `--motion-shift`, except docks, sheets and drawers. Scale-from is 0.97 for menus and dialogs and 0.98 for the palette and Quick Entry, never below 0.9.
4. Stagger follows D17. Exits run in reverse at a 15ms step.
5. Transitions drive state; keyframes are only for one-shot entrances. Everything is interruptible.
6. Hover fill appears in 0ms and leaves over 120, only under (hover: hover). Focus rings never animate.
7. Animated properties follow D27. During the four width or height cases, the animating parent gets `contain: layout`. Iframes, xterm and the windowed transcript keep their size until transitionend and re-measure once, on the `alevr:layout-settled` event.
8. Loops follow law 4. The 3 animating galaxies are allotted in priority order: the live line, then the focused or hovered row, then the rest. Galaxies pause when an IntersectionObserver reports them out of view, when `document.hidden` is true, when the Mac window is not appearsActive, and when the iOS scenePhase is not active.
9. Exits follow D21.

### 4.6 Choreographies (t = 0 at the trigger)

**C1 Send and TurnStatus (signature moment 1).** TurnStatus is one element per assistant turn. It mounts at t=0 and is never unmounted; tests assert that its DOM node and SwiftUI identity stay the same.
- **t=0.** The composer clears and the disc morphs send→stop over 120. The user bubble rises 6px × shift with opacity 0→1 over 120 out-soft, no blur, and is painted within 100ms. The assistant root does not animate. `turn-in` (420ms with blur) and the 360ms blur on `.turn-body > *` are RETIRED.
- **Working.** If no answer token has arrived by `--delay-show` (200), TurnStatus opens with grid-rows 0fr→1fr plus opacity over 220.
  - It holds a 14px galaxy (entrance: a 360 spiral from 0.6 radius on out-expo, in presence ink) and the phase word in ui 13 muted (“Thinking”, “Searching 6 sites”, “Running code”). From 3s it adds “· 4s” in label 12.
  - Phase words cross-fade over 120, and each is held for at least `--hold-phase` (600).
  - If the first token arrives before 200ms, Working is skipped entirely.
- **Answering.** On the first answer token the line compresses over 220 in-out into a 24px summary row: a 12px galaxy plus “Thought for 4s ›”.
  - Inline reasoning (wave 1) opens under it with grid-rows 0fr→1fr plus opacity over 220 in-out while reasoning streams. It closes once, `--hold-reasoning` (1000) after reasoning ends, unless the reader toggled it. On phones it opens as a glance sheet.
  - With no reasoning and no tools the row collapses to 0fr over 160 ease-in, still mounted but inert.
- **Settled.**
  - The held tail drains within 250.
  - The galaxy decelerates exponentially (tau 350ms) and dims to 60% over 220.
  - The summary cross-fades over 120 to its final wording (table below).
  - If the reader watched a run longer than 10s, the still galaxy cross-fades to a check drawn over 360.
  - The action row fades in over 220 after `--delay-action-row` (180). This is the “done” cue.
  - The receipt sits at the end of the action row (D25).
  - On iOS, `.impact(flexibility: .soft, intensity: 0.4)` fires once, only if the reader watched and the answer took more than 3s.
- **Reduced motion:** every step becomes a 120 cross-fade, and the galaxy draws its still frame.
- **Screen readers:** no live region while streaming. On settle, one polite announcement: “Answer ready”, or the error.

TurnStatus in every state:

| Situation | TurnStatus | Galaxy | Words |
|---|---|---|---|
| Reasoning happened | summary | stop, 60% | “Thought for {n}s ›”; settled: “Thought for {n}s · {k} sources · ran code ›” (parts present only if true, n rounded up) |
| Tools but no reasoning | summary | stop, 60% | “Worked for {n}s · {k} sources ›” |
| Neither | collapsed, inert | – | – |
| Stream drop, retrying for up to 15s | Working | keeps running at the calm period | “Reconnecting…” |
| Reconnect failed after 15s, or a mid-stream failure | settled-failed | still destructive frame, cross-fades to circle-x | summary “Stopped”; failure box “Something went wrong. Try again.” Offline also shows the offline banner |
| Resumed | previous phase | resumes | the tail drains normally |
| A tool needs approval inside the turn | Needs you | stops, hand cross-fades in over 160 and pulses once | “Needs your approval”. The approval card renders directly below, and the turn appears in Now |
| User stopped | settled-stopped | still at 60% | “You stopped this answer · Continue” |
| Auto fell back to another model | summary plus note | – | a quiet label-12 line: “Sonnet 4.6 was unavailable, so Auto used Haiku 4.5.” The same reason appears in the receipt popover |
| Waiting for capacity (HTTP 429) | Working | running | “Waiting for capacity · {s}s” |

**C2 Streaming.**
- Frame-paced reveal at the stream rate (§4.2), sliced with Intl.Segmenter.
- A 5-band CSS Custom Highlight fade of about 280. **The first band starts at 35% ink**, so no gap opens at the end of the line. Code, math, tables and citations never fade.
- At stream end the held tail drains at up to 4× the rate, capped at 250, never in one block.
- A 50ms timer keeps draining while rAF is paused.
- Reduced motion keeps the pacing and drops the fade.
- The band's text-shadow is inside the long-task gate. If the gate fails on coarse or low-end devices, `.stream-lite` drops the text-shadow.

**C3 Home arrival** (first visit of a session only).
- The ui-prefs boot script sets `html[data-first-visit]` before paint from sessionStorage, with every read and write in try/catch.
- The greeting reveals with clip-path inset(0 12% 0 0) → inset(0) plus translateX(8px × shift) → 0, over 560 out-expo after `--delay-greeting` (60).
- The composer and starters fade over 360 out-soft from 120.
- The neutral dot field draws on, dims to 40% once the chips render, and stops when typing starts.
- Every later New chat is a 160 opacity fade. Reduced motion uses a 160 fade.

**C4 Home→thread handoff.**
- Home and dock composers both use `.transcript-column` (width 100%, max-width var(--transcript-max)) inside the same container with padding-inline var(--page-gutter). Their widths therefore match by construction at every breakpoint, and they never overflow.
- The greeting leaves with a −4px lift and scale 0.985 over 160 ease-in.
- The composer travels on y only: 360 out-expo on web, the emphasized spring natively.
- The transcript fades in over 220 starting at 120.
- Reduced motion uses a 160 cross-fade.

**C5 Product switch.**
- The thumb travels on the standard spring.
- Content commits at 160, with a 120 opacity cross-fade of the detail column only. The sidebar and toolbar never fade.
- Each product's scroll position is restored (in memory on web; via @SceneStorage on Mac).

**C6 Palette.**
- The shell enters over 160 out-expo from 0.97 and −6px, with the scale override written as `motion-safe:[--motion-scale-from:0.97]`. Rows paint in the first frame.
- Async search results stagger 30ms, capped at 4. The highlight uses the snap spring.
- Exit is 120 ease-in with opacity and scale 0.98.
- A 2px indeterminate hairline appears under the input after `--delay-hairline` (300) in flight.
- The palette module preloads at first idle after hydration (requestIdleCallback, 2s timeout). Warm opens paint within one frame; a cold open before preload shows the shell immediately and rows within 150ms.
- On phones it becomes a full-height top sheet with the input under the safe area and a 160 opacity-only entrance.

**C7 Overlays.**
- **Frequent** (menus, tooltips, selection bar): enter 120 out-soft from 0.97 at the trigger's transform-origin; exit 70 ease-in.
- **Infrequent** (dialogs, popovers with content): enter 220 on spring.standard (CSS `--spring-standard`) from 0.97; exit 160 ease-in to 0.98.
- **Opened from the keyboard:** opacity only, 120.
- **Tooltips:** ui 13, `--delay-tooltip` before the first show, 0ms for peers within `--delay-tooltip-skip`.

**C8 Sheets** (mobile web, with the same thresholds as iOS).
- Open 360 on the drawer curve.
- A drag starts on the whole 44px header, or in the first 44px of a body scrolled to the top.
- Release: dismiss at 0.5px/ms or 30% travel; otherwise settle back per D18. Beyond the bounds, the rubber band applies.
- Programmatic dismiss: translateY 100% over 220 ease-in, with the scrim fading in step. The sheet stays mounted until the exit ends.
- Nested sheets displace 16px. The grabber is 36×5 at radius 2.5, 6px from the top.
- Scrims follow §5.6.

**C9 Drawer** (phone web and iOS).
- It follows the finger from the edge zone (24px web, 16pt iOS) and opens at 0.3px/ms or 40%, settling per D18.
- Parallax 0.22, dim 0.12 light / 0.30 dark. Tapping outside closes it.
- On pushed iOS screens the leading edge yields to system back.
- In iOS Safari (not standalone), the browser's own back swipe can claim touches at the very edge. The menu button is therefore the primary affordance there.
- Reduced motion: the card stays put and the drawer cross-fades over it in 220.
- iOS fires `.selection` once, from onEnded only.

**C10 Folds.** Open 220 in-out (grid-rows, plus opacity over 120). Close 160 ease-in. The chevron turns over 120. Content stays mounted and inert while closed.

**C11 Row arrival and removal, including Now.**
- Arrival: grid-rows 0fr→1fr plus opacity over 220. Removal: fade over 160 ease-in, then the gap closes on the layout spring.
- **Hold rule** for Running and Ready rows. While the pointer is over the sidebar list rows or focus is inside the list, any insert that would shift rows below is queued, and a 24px “{n} updates” pill shows at the trailing edge of the Now heading. The queue flushes `--delay-insert-flush` (300) after the pointer leaves, on a pill click, or after `--hold-insert-max` (10s). Roving focus stays on the same row id.
- **Needs you is never held for signalling.** The Now count, the phone and switch badges and the announcement fire at once. The row itself inserts at once unless the pointer is over a row below Now; then it inserts within `--hold-needs-you-max` (2s) or on pointer leave, whichever comes first.
- Announcements are polite and rate-limited to one per 5s (“1 chat needs you”), except the approval announcer in C16.

**C12 Docks and right shell** (Code dock, canvas, Activity, Sources).
- Enter: 24px × shift over 220 on the drawer curve. Exit: 160 ease-in, using allow-discrete display and @starting-style.
- Tabs mount on first open and then stay mounted with hidden + inert, under the D29 eviction policy. Only the incoming pane cross-fades, over 120.
- Resize snaps at 50% and 640 when released within 16px, settling on out-soft over 220 with no overshoot (width is one of the D27 cases). The rubber band applies beyond min and max. The Mac gives a trackpad `.alignment` haptic.
- The iframe and xterm keep their size during the settle and re-fit once at transitionend.

**C13 Composer height.** Animates over 220 in-out when an approval or a quota strip changes the composer's height. It uses interpolate-size under motion-safe, otherwise a measured height. Transcript scroll anchoring keeps the last line in place.

**C14 Jump to latest.**
- The label is “Jump to latest · {n} new”, where n counts parts that arrived while the reader was away. A tall spacer never triggers it.
- Enter: 4px rise over 220. Exit: 4px drop over 160 ease-in. It sits 16px above the composer.
- A click scrolls with an in-house velocity spring (damping 0.7, stiffness 0.05, mass 1.25), then instant follow resumes.
- Following uses a 70px near-bottom zone and breaks on scroll-up, wheel-up or text selection. It never scrolls when content shrinks.

**C15 Toasts.**
- Enter: 8px rise over 220 on spring.standard. Exit: 4px drop over 160 ease-in.
- The Toaster (mounted in `src/components/providers.tsx`) offsets bottom by calc(var(--composer-h, 0px) + 16px).
- The composer publishes `--composer-h` on :root on mount and resize, and resets it to 0 on unmount. Pages with no composer therefore get 16px.
- Sonner's own motion is overridden. Sonner is the only web toast system; Code already uses it.

**C16 Approvals** (D20, contract in §10).
- The primary verb is disarmed for `--hold-arm` (500) after each new request and after every focus entry: aria-disabled, opacity 0.6, ⌘↩ and Enter ignored, sr-only “Available in a moment”. It then goes to opacity 1 over 120.
- One ApprovalAnnouncer per window. The first request is announced assertively; further requests within 2s are batched into one polite “{n} approvals waiting”. At most one assertive announcement per 10s.

**C17 Quote and attachment travel.**
- The selection bar's Quote FLIPs a QuoteCard from the selection rect into the composer's above-slot over 360 out-expo, and the composer takes focus.
- On send, QuoteCards and AttachmentChips FLIP into the new bubble over 360 out-expo, at the same size and using the same component.
- Reduced motion uses a 120 cross-fade; iOS uses a 220 cross-fade.

**C18 View transitions** (D23).
- `thread`: the root swaps instantly (`animation: none` on root old and new). The `app-page` group cross-fades: old goes opacity 1→0 over 120 ease-in; new goes opacity 0→1 plus a 4px × shift rise over 160 out-soft. The sidebar and header sit outside the group and never animate.
- `canvas` (docked ↔ full screen): the group animates over 360 out-expo when opening and 220 ease-in when closing.
- Reduced motion: no group geometry, a 160 cross-fade.
- `ROUTE_WAIT_MS` is 80.
- The chat row title → header and Orbit portrait → agent header shared elements arrive after the React 19.3 / Next 16 upgrade (not in these packages). AgentPresence.transitionName stays wired.

**C19 Galaxy states.** As in §3.4. There is no perpetual loop for idle, ready or blocked.

**C20 Editorial pages** (Library, Orbit).
- First page on the first visit: an 8px × shift rise over 560 out-expo, with a 45ms stagger capped at 4.
- Filter, sort and search cross-fade the grid container over 120, keyed on the query. Tiles never remount.
- Later pages rise in over 220 with no per-tile delay.

**C21 Skeletons.** A `--delay-show` (200) show delay and a `--hold-skeleton` (400) minimum. They breathe from 1 to 0.62 over 1.8s and carry aria-busy plus an sr-only “Loading”. They mirror the final layout exactly, and skeleton → content is a 160 cross-fade with no shift.

**C22 Finished-away wash.** A row whose run finished while it was off screen gets presence-wash fading to 0 over 560 out-soft, once, when it next scrolls into view.

**C23 Research travel.** Sources travel inward with translate over 560 out-expo, because they show real progress.

**C24 Small frequent surfaces.** The drop overlay, the selection capsule and the Quick Entry panel all enter over 120 out-soft (Quick Entry from scale 0.98) and exit over 70 ease-in.

### 4.7 Reduced motion (one model for OS and in-app, on every platform)

- **Tier A, kept:** opacity, colour, fills, focus, progress fills and number changes, each at most 220. Streaming pacing stays, without the fade. Haptics stay.
- **Tier B, travel removed:** `--motion-shift: 0` and `--motion-scale-from: 1`, so springs become out-soft 220.
  - View transition geometry becomes a 160 cross-fade, and FLIPs become a 120 cross-fade.
  - Scroll animations become jumps.
  - Sheets, drawers and docks cross-fade over 220.
  - Per-element overrides must sit behind `motion-safe:`. Lint enforces this, and the palette's unguarded 0.97 is fixed.
- **Tier C, loops stopped:** the galaxy shows its still frame with its word; the skeleton holds at 0.8; there is no stream fade; the dot field does not draw on; there is no parallax.
- **In-app Motion setting:** System / Reduced / Full, stored per device (`alevr.motion` natively, ui-prefs `motion` on web). Reduced is exactly A + B + C. Full plays all non-ambient motion even when the OS asks to reduce, but still caps parallax at 8px and zoom at 1.1.
- **Wave 1 already removed** the old `html[data-motion=reduced]` !important kill; the postcss twins replace it.
- **Still to delete:**
  - the composer `transition: none` at globals.css ~1578
  - `.control-primary` ~1216 and `.sidebar-motion-icon__glyph` ~1372, where they remove Tier A fades
  - Code v2's 1ms clamps
- **Tier table:** every keyframe gets a tier in a table in globals.css, checked by a snapshot test.
- **Native:** `JunoMotion.reduced(_:when:tier:)` reads accessibilityReduceMotion and the in-app override. iOS Prefer Cross-Fade Transitions maps to Tier B.

### 4.8 Haptics

**iOS.** SensoryFeedback, with every generator routed through JunoMobileHaptic. Gated by Settings › Appearance › Haptics, default on.
- Touch-down on custom glass controls: `.press(...)`. The API name must be verified; omit it if unavailable.
- Send: `.impact(flexibility: .soft, intensity: 0.7)`.
- Stop: `.impact(flexibility: .rigid, intensity: 0.6)`.
- Answer settled: soft 0.4, once, only if the reader watched and it took more than 3s.
- Needs you arriving in the foreground: `.impact(weight: .medium, intensity: 0.6)`.
- Approve: `.success`. Deny and Not now: `.impact(weight: .medium, intensity: 0.5)`.
- Delete: `.impact(weight: .heavy, intensity: 0.8)`.
- Rate: `.impact(weight: .light, intensity: 0.5)`.
- Drawer, detent and segment changes: `.selection`, fired from onEnded only.
- Voice start: `.impact(weight: .light, intensity: 0.5)`; voice end: soft 0.4.
- Errors: `.error`. `.warning` only for real warnings.
- No streaming haptics.

**macOS trackpad.** `.alignment` when the sidebar, inspector or dock hits min or max or snaps; `.levelChange` on effort-dial steps; nothing else.

**Web.** No vibration API.

---

## 5. Layout

### 5.1 Web at 1024px and wider

**Sidebar.**
- Docked at 260 (min 224, max 352). It is keyboard-resizable, with aria-valuenow and aria-valuemax.
- The width fold takes 220 in-out (a D27 case). During the fold `<main>` gets `contain: layout` and the transcript keeps its width. On transitionend a single `alevr:layout-settled` event triggers one row re-measure.
- Order, top to bottom:
  1. brand row, 44
  2. Chat | Code switch: recessed track at sidebar-accent/0.8, radius 10, 32 tall, raised thumb, 16 glyph plus 13 medium label, tooltip from the registry
  3. New chat, Search (keycap on hover) and Library rows, 32 tall at the 46 edge
  4. Now (only when not empty; a fold “Now · {n}” whose collapse state lives in a cookie)
  5. Orbit
  6. Pinned projects
  7. Pinned
  8. Recent
  9. account
- All sections render at SSR from bootstrap. The `mounted` gate is removed, and section collapse state moves to the cookie `alevr_sidebar_sections`, read in `(app)/layout.tsx`.
- The list is one roving-tabindex group: ↑ and ↓ move, Home and End jump, Shift+F10 opens the row menu. The kebab is a 16 glyph with tabIndex −1 except on the focused row.
- Rows are 32 tall (44 on coarse pointers).

**Header.** 48px constant in Chat and Code, and opaque. A bottom hairline fades in over 120 once scrollTop > 0. The title is nav 14 medium through AnimatedTitle. Exactly one title announces: this header at md and up, the phone bar below md.

**Transcript.** 640 / 768 / 992 per preference, with prose per D13. Code-block headers are sticky at top 0. Follow-ups render inside the transcript under the last answer. A static 32px fade overlay sits above the composer (D12).

**Composer.**
- Radius 22, inset 10. Resting height is 96: 10 + 28 text row + 12 gap + 36 controls + 10. It grows to 12 lines, then scrolls.
- Controls, left to right: + (36), model chip (36, “Auto · {model}”, always visible, max 12rem), effort dial, mic (36), disc (36 at radius 12).
- The above-slot stack, top to bottom: quota strip, queued strip, steering strip, approval (stacked, D20), selection quote, attachments.
- A file dropped anywhere in the chat column shows the full-column overlay.

**Right shell and dock.**
- The right shell (canvas, Activity, Sources) has a minimum of 420 and defaults to 50% of main.
- The Code dock is clamped between min 420 and max min(760, main − 420); the same clamp is used for display and storage. It snaps at 50% and 640. Below 760 it becomes a full-screen sheet that respects safe areas.

**Settings.** An 880×640 modal; full screen on phones.

### 5.2 Web, 640–1023px

The sidebar overlays as an L3 panel, closed by default, with a fading scrim. It keeps its float until transitionend, and content never re-centres.

### 5.3 Web, below 640px

- **Phone bar:** 48px + env(safe-area-inset-top). Left to right: menu button (with the hand badge when something needs you); title button, which opens the conversation menu; New chat. Inside Code, New chat becomes “New session” and goes to /code.
- **Drawer:** `--drawer-width`, with the edge swipe (C9).
- **Dialogs** become bottom sheets with 16 top corners, in the three kinds of §5.6. The palette is exempt (C6).
- **Coarse targets** are 44.
- **Return key:** follows the existing `touchReturn` pref (default newline, optional send).
- **Keyboard:** the root viewport sets `viewportFit: cover` and `interactiveWidget: resizes-content`. Where interactive-widget is unsupported (iOS Safari), a visualViewport listener publishes `--kb-inset`, and the composer pads by it. Every fixed bar pads for env(safe-area-inset-*).
- **Landscape phones:** the composer is capped at 40% of the viewport height and the transcript stays scrollable above it.
- **iPad Safari:** uses the 640–1023 or 1024+ layouts by width, with coarse targets.

### 5.4 macOS

- **Window:** NavigationSplitView with an edge-to-edge sidebar on macOS 27 (behind `#available`; the standard sidebar on 26). Sidebar min 224, ideal 260, max 352. The minimum window is 720×520.
- **Toolbar:** JunoProductSwitch in the principal position, with ToolbarSpacer(.fixed) groups and monochrome glyphs. A soft scroll-edge effect sits under the toolbar.
- **Content:** the reading measure is 768. The glass composer cluster floats 16pt above the bottom at radius 22.
- **Inspector:** 420 / 480 / 760. It sits inline only when the window is at least sidebar + 360 + 420 wide (1004 with the default sidebar). Narrower, it overlays the detail column from the trailing edge as an L3 sheet at min(480, detail − 24), dismissible with Esc.
- **Settings window:** a 200pt rail with an NSSearchField and mono 11pt group headings, the section name as navigationTitle, and the summary as the lede. Minimum 640×560.
- **Quick Entry:** a 640pt NSPanel on the screen under the pointer, with its top edge at 22% of that screen's height, radius 22, glass `.regular`. The field is 56 tall. It grows to 520 with an inline answer, and 5 recent chats sit below the field.

### 5.5 iOS and iPadOS

- **Drawer:** a push drawer at min(80%, 380pt) with 0.22 parallax and corners from `.containerConcentric`. The 16pt edge strip yields to system back.
- **Composer:** docked above the keyboard at radius 22. 44pt starter chips sit above it on an empty home.
- **Top bar:** 44pt. The title button carries the hint “Conversation actions”. `.toolbarMinimizeBehavior(.onScrollDown)` on iOS 27, behind `#available`.
- **iPad, regular width:** a NavigationSplitView sidebar (320) plus `.inspector` (400). Compact width falls back to the iPhone shell. Layouts switch at 600pt, so resizable iPhone windows on iOS 27 work.

### 5.6 Sheet grammar (iOS and mobile web)

- **Glance:** detents [.medium, .large] with a grabber. Used for the model picker (which zooms from the chip), reasoning, sources and notifications.
- **Form:** .large with a leading ×.
- **Page:** .large with no grabber.
- **Scrims match across platforms:**
  - iOS keeps the system's default dimming at every detent.
  - Mobile web uses the full `--scrim` at large and half its opacity at medium: 0.13 light, 0.28 dark.
- Custom presentationBackground is removed.

### 5.7 Keyboard chords

| Action | macOS native | Web on macOS | Web on Windows/Linux | iPad hardware keyboard |
|---|---|---|---|---|
| Switch to Chat / Code | ⌘1 / ⌘2 | ⇧⌘1 / ⇧⌘2 | Ctrl+Shift+1 / 2 | ⌘1 / ⌘2 |
| Commands | ⌘K | ⌘K | Ctrl+K | ⌘K |
| Search | ⇧⌘F | ⇧⌘F | Ctrl+Shift+F | ⇧⌘F |
| New chat | ⇧⌘O | ⇧⌘O | Ctrl+Shift+O | ⇧⌘O |
| Previous / next turn | ⌥⌘↑ / ⌥⌘↓ | ⌥⌘↑ / ⌥⌘↓ | Alt+Shift+↑ / ↓ | ⌥⌘↑ / ⌥⌘↓ |
| Go to approval | ⌥⌘A | ⌥⌘A | Alt+Shift+A | ⌥⌘A |
| Approve (focus inside the approval, after the arm) | ⌘↩ | ⌘↩ | Ctrl+Enter | ⌘↩ |
| Canvas full screen (canvas focused, not editing) | F | F | F | – |
| Quick Entry | ⌥Space, rebindable | – | – | – |

- Kbd renders the platform form (⌘ → Ctrl, ⌥ → Alt, ⇧ → Shift, written as Ctrl+Shift+F) through the modifier-label hook.
- macOS menu items use Apple modifier order ⌃⌥⇧⌘.
- ⌃⌘F is never used, because it is the system window full-screen shortcut.

---

## 6. Surfaces

### 6.1 Home / new chat (all platforms)

- **Greeting:** “What's next, {first name}?”, or “What's next?” without a name, from the shared table. Web uses home-title; macOS uses Newsreader 30 and iOS Newsreader 34, all with the C3 clip-wipe.
- **Placeholders:** “Ask Alevr” on home and “Ask a follow-up” in a thread, everywhere. RETIRED: “How can I help you today?”, “What can I help with?” and the iOS time-of-day two-beat greeting.
- **Starter chips (wave 1):** 4 chips, 36 tall (44 coarse), full radius, ui 13, 16 glyph, hairline border. They fade out over 120 and collapse when typing starts. Follow-ups reuse the same component.
- **In flight strip (NEW):** shown only when Now is not empty, 32px under the chips. A heading in label 12, then up to 3 rows of 40px: status mark, title in nav 14, and a trailing armed verb button for needs-you rows or “Open” otherwise.
- **Dot field:** neutral ink, never presence (C3).
- **Incognito:**
  - Named “Incognito chat”, set in display above a 48px hairline disc with the incognito glyph.
  - The promise today: “This chat won't appear in your history and won't be added to memory.” The clause “, and isn't used to train models” is added only after [S8].
  - Only the background tone cross-fades, to `--muted` over 220.
  - Leaving a non-empty incognito chat by in-app navigation (New chat, a sidebar row, the product switch) asks “End this incognito chat?” with the body “It isn't saved, so leaving ends it.”, the buttons “End chat” and “Keep chatting”, and a “Don't ask again” checkbox stored per device.
  - Tab close and reload show no prompt, because beforeunload cannot carry custom copy.
  - “Private chat” is RETIRED everywhere.

### 6.2 Transcript

- **Both speakers** use reading 16/1.7. The bubble follows D6.
- **User-turn actions** (Copy, Edit, Branch; Fork privately is dropped now that branching has landed):
  - Pointer: shown on hover and on keyboard focus (`:focus-within` on the turn). The buttons stay in the tab order at opacity 0, never visibility hidden.
  - Touch: shown under the newest question; older turns reveal them on tap or long-press.
  - iOS: a long-press menu.
- **TurnStatus** follows C1.
- **Action row:**
  - Order: Copy · Good · Bad · Read aloud · Regenerate (a 32-tall pill, auto width, about 6px padding, with a chevron) · Sources (a cluster of 3 favicons at 16 overlapping by 4, plus the count) · More.
  - Shown at rest on the newest answer, and on hover or focus-within for older ones. On touch: newest only, older on tap or long-press.
  - Buttons are 32 (44 coarse). Mac buttons are 28 with a 44 hover area; iOS buttons are 44.
  - The branch pager is label 12: “‹ 2/3 ›”.
- **Receipt** (D25): at the row end in label 12, in full muted ink (on-fill ink on fills).
  - Default: “Auto · Sonnet 4.6”, plus “ · High” when effort is not the default.
  - With Tokens: adds “ · 1.2k tokens”. With Tokens and cost: also “ · €0.004”, in the billing currency.
  - Shown at rest on the newest answer, and always on coarse pointers and iOS.
  - It opens the “Selected for” popover, which also shows any Auto fallback reason.
- **Sources** open the Activity Sources tab (a glance sheet on phones). The inline list appears only for 5 sources or fewer. Inline [n] chips are 18px at radius 6 in label 12; on touch they open a popover with title, site, snippet and Open.
- **Finish notes and failures:** as in the C1 table. A model the user explicitly chose that is unavailable shows the box “{model} isn't available right now.” with a “Use Auto” button.
- **Thumbs-down** opens a calm reason popover (Inaccurate, Not helpful, Too long, Unsafe, Other, plus a field) entering on spring.standard over 220. Never the reward spring.
- **Selection** raises the Ask / Quote / Explain capsule: 36 tall, 8 above the selection rect, 120 in and 70 out. Quote travels per C17.
- **Code blocks:** a sticky header with Copy. Wrap appears whenever lines overflow, next to any other action.
- **Artifact cards** (240–360 tall):
  - The active card gets the selected fill, a 1px foreground/0.24 edge and aria-current.
  - The accent sweep is RETIRED. A determinate scaleX bar shows only when bytes are known.
  - Open is the single tab stop, with a full-screen action next to it.
- **Drop overlay:** a full-column tonal recess with a 1px foreground/0.24 edge and “Drop files to attach”, 120 in and 70 out. A window-level preventDefault stops a missed drop from navigating away. In incognito the overlay says why files can't be added.
- **Skeleton:** the conversation skeleton uses `transcript-column` and the 48px header.

### 6.3 Composer

- **Queued strip:** “Queued”, the text clamped to 2 lines, then Edit (restores the text and calls cancelQueued) · Remove · Send now. A refused second send says “One message is already waiting”.
- **Uploads:**
  - A progress arc on each tile, plus “Uploading {n} files · {p}%” in label 12 in the controls row.
  - Send is aria-disabled with the tooltip “Waiting for the upload to finish”.
  - A failed tile shows a warning glyph, “Failed” and Retry, announced politely.
- **Quota strip (NEW):** a clock glyph plus “You've reached your {plan} limit. It resets at {time}.” in attention ink, with “Upgrade” where an upgrade exists. Send is aria-disabled with the tooltip “Limit reached · resets at {time}”.
- **One component each, shared by composer and bubble:** AttachmentChip (files 224×56 at radius 12; images 64×64 at radius 10) and QuoteCard (“Selection”, muted fill, 13 sans excerpt clamped to 3 lines).
- **Model chip:** opens the effort panel, which gains:
  - a 44px header row (provider mark, model, “Change ›”)
  - the 2 most recent models as one-tap rows
  - type-to-search into the catalogue
- **Catalogue:** the search field gets visible field styling. On phones the catalogue is a glance sheet: search, a lab chip row, then rows whose second line shows capability glyphs and $–$$$. Order: Auto, recent, labs.
- **Toggles:** Web search and Memory use checkmarks in both the + menu and the / palette.
- **Effort slider:** the global ring and one knob token.

### 6.4 Now (web sidebar, Mac sidebar, iPhone drawer, Mac menu bar, widgets)

- **Groups:** Needs you, then Running, then Ready (finished in the last 24h and not yet seen; medium weight until opened). At most 5 rows, then “+{n} more”, which expands inline until Activity (G70) ships and opens Activity afterwards.
- **Rows:** 32px, with a 10 status mark, the title in nav 14 and a trailing 12 product glyph in ink-tertiary. The heading “Now” is label 12.
- **Deduplication:** rows appear in both Now and Recent; Recent rows carry the same status mark. Now is a capped summary, so Recent positions never shift because a status changed.
- **Data:**
  - Web renders at SSR from `getAppBootstrap` (now items, starred projects and the agent roster), with growth capped at +8KB gzipped and TTFB p95 within 10% of baseline.
  - Mac reads one shared observable store (DesktopSidebarSignals), so every window shows the same Now. The hold queue is per window.
- **Motion:** C11.
- **Optimistic actions:** rename, pin and add-to-project roll back on failure with a specific toast and Retry (“Couldn't rename this chat.”).

### 6.5 Palette and search (one PaletteShell)

- **Modes:** ⌘K opens commands and ⇧⌘F opens search. Tab, or “Search everything”, switches mode in place and keeps the query. The Mac matches this with one panel and ⇧⌘F. iPhone opens full-screen search from the drawer field.
- **At rest:** 3 actions (New chat, New code session, Search everything), 5 recent chats, 3 Code sessions, then Projects. Other actions appear under “Go to” only when the query matches them.
- **With a query:** “Ask Alevr: “q”” is the first row, and Enter starts a chat with q prefilled. Every group matches at word starts.
- **Empty results:** under that first row, “No matches for “q”” (and in search mode “No messages match “q””, plus the coverage note).
- **IME:** the keydown handler returns early on isComposing or keyCode 229.
- **Search mode:** the filter strip is always rendered (inert while empty). Failures show “Try again”. Pluralisation: “{n} more {source was | sources were} searched only in part.”
- **Code on a Free plan:** “New code session” carries a “Pro” chip (§6.6).

### 6.6 Code workspace

- **Global tokens:** cv2 adopts the global ladder, ring, bubble, coarse targets (40/44) and safe areas. env() insets apply to `.cv2-cwrap` (bottom) and the narrow dock (top and trailing). A 390px WebKit capture runs in e2e.
- **Approvals** use ApprovalActions:
  - The title is in signal-ink, with a 2px signal edge.
  - The command is mono, up to 8 lines, then “Show all”.
  - Actions: “Not now” · “Run ▾” (the standing grant sits behind the caret) · “Tell Alevr instead” · Amend, with a visible ⌘↩ hint.
  - Focus policy: announce when focus is in xterm, a dock input or a non-empty composer; otherwise take.
  - The takeover replaces the textarea only when the draft is empty; otherwise it stacks above it. Composer height follows C13.
- **Turn rail:** sticky (a sibling of `.cv2-scroll`), with 24×24 targets and the D22 menu fallback.
- **Diff:**
  - a 14px +/− marker column in success or destructive ink
  - sr-only “added line {n}” and “removed line {n}”
  - each hunk scrolls horizontally with sticky gutters
  - line numbers in full muted ink
  - Wrap by default when the dock is under 560
- **Dock:** keep-alive panes under D29, so the preview iframe and xterm do not remount within the cap.
- **Working mark:** a 12px galaxy plus the live verb. The shine is RETIRED.
- **Below 1024:** the sidebar glyph opens a sessions left drawer. The palette stays on ⌘K.
- **Esc:** one hint, “Press Esc again to stop”, swaps into the context strip with a 120 cross-fade and clears when the arm window ends.
- **Pull requests:** /code/pulls uses router.push and 32px cv2 rows.
- **Empty session:** the repository name is a button that opens the picker.
- **Tooltips:** Tooltip plus Kbd with platform modifiers.
- **Skeletons:** the landing skeleton gains a 16×120 lockup line. /code/[id] shows a ThreadSkeleton (48 header + 96 composer).
- **Thread performance:** memoised turns with a LiveClock leaf, one IntersectionObserver for the current turn, rAF-throttled anchor noting, work-log rows that animate only when they arrive live, and fold content that stays mounted.
- **Touch:** revert and the timestamp are visible under (hover:none) or (pointer:coarse), and tapping a bubble toggles its meta.
- **Plan gating (Free accounts):**
  - The Code segment of the product switch shows a 12px lock glyph in muted ink with the tooltip “Code is on Pro”.
  - Selecting it, its chord, or the palette's “New code session” opens a dialog: “Code is part of Pro” with the body “Run coding agents on your repositories and your Mac.” and the buttons “See plans” and “Not now”. It never switches into a dead workspace.
  - Native behaves the same way.

### 6.7 Work, agents, routines

- **Approval card:** the reference pattern. It adopts ApprovalActions, keeps the arm and gains the 2px signal edge. Work's needs-you moves from amber to signal plus hand (in the web train, D33).
- **PlanStepGlyph** is shared with Code.
- **Task card:** 20px galaxy. The live→finished swap uses popLayout plus a height animation on spring.standard. Finished actions: Retry · Run again · Continue · Make a routine.
- **Routines:**
  - Named “Routines” and “New routine” everywhere (the /automations route stays).
  - “Run now” uses a bolt glyph; Play and Pause control the schedule.
  - Row labels are ui sans.
  - A paused routine shows the word “Paused” and is not dimmed.
  - “Its task” becomes “Open task”.
- **Orbit:** the editorial entrance plays on the first visit only, and filters cross-fade.

### 6.8 Library, artifacts, canvas

- **Header:** a page-title, a one-line description and inline search. On a 390×844 phone: a 1.75rem title, no stat row, sticky search and filter chips, and the first tile at y ≤ 360.
- **Tiles:** 4:3 thumbnails at radius 12 with a hairline, the title in 14 medium, meta in label 12. 4 columns at 1280 and above. Motion follows C20.
- **Empty filter result:** the EmptyState panel “Nothing matches these filters” with “Clear filters”.
- **Canvas:** a 48px header with the document title in Newsreader 1.25rem/1.25 and “Saved · 2s” in label 12 (cross-fade 120). Full screen comes from the header button or F (§5.7); Esc exits. It uses the `canvas` transition.
- **Trash:** TypeGlyph per item. Restore collapses the row (grid-rows 1fr→0fr over 160 ease-in) and shows the toast “Restored to Library · Open”. Loading uses the list skeleton.

### 6.9 Research

- The visible label is “Deep research”, with “Deep Field” as the brand subtitle.
- Points move with translate (C23). The title uses cqi.
- The scope card uses the galaxy, not RunGlyph.
- Raw 160 and 300/320ms values move to exit and slow.
- A “List” toggle exposes keyboard- and VoiceOver-reachable source rows. On phones the map is a glance sheet.
- Cost follows the Show usage on answers setting.

### 6.10 Settings and interface preferences

- **Structure:** the h1 is page-title. The rail uses roving tabs, and search matches rows inside sections. A section switch is a 120 cross-fade, under 300ms in total. Existing section names and deep links keep resolving.
- **Interface rows:**
  - Motion (System / Reduced / Full)
  - Chat font
  - Transcript width (narrow / medium / wide, web and Mac; stored ids unchanged)
  - Text size (the six steps of §3.5; web and Mac)
  - Increase contrast
  - Show usage on answers, under Models & routing: Off / Tokens / Tokens and cost, default Off
  - Haptics (iOS)
  - Quick Entry shortcut recorder (Mac, embedding P8's recorder view)

### 6.11 Onboarding

- **Gating:**
  - Settings gains `onboardingCompletedAt DateTime?` through a Prisma migration ordered after every existing migration.
  - The backfill sets it to the migration time on every existing Settings row.
  - Accounts that have no Settings row and were created before the cutoff constant ONBOARDING_GATE_CUTOFF (the migration timestamp) count as onboarded.
  - On first load, a browser that still has localStorage `juno:onboarded:v1` while the server value is null PATCHes the server value and skips.
  - Any conversation history also counts, as today.
  - No existing account is ever onboarded again, and completing onboarding on one device completes it on all.
- **Page 1, all platforms:**
  - The title “Make Alevr yours” in display.
  - Name, theme and accent, each saved to the account. Theme calls save({theme}) as well as setTheme.
  - Accents carry human labels. A failed save shows an inline Field error.
  - Rows deal in at a 60ms stagger (max 4) with a 6px rise over 220, first time only.
  - Buttons are sentence case on every platform.
- **Page 2 depends on the platform:**
  - Web: import from ChatGPT or Claude, and the ⌘K tip.
  - Mac, “Alevr on your Mac”: Quick Entry (showing the bound shortcut, or “Choose a shortcut” when ⌥Space is taken) with Try it, the menu bar, “Tell me when work finishes”, and Import.
  - iOS: Notifications, Widgets and Control Center, and an optional Pair a Mac. This replaces the three-page carousel.
- **On close**, focus moves to the composer.

### 6.12 Sign-in

- **Web, identifier-first:**
  - **Step 1:** Google and Apple buttons (44 tall, radius 10), a divider, the Email field (44, radius 10) and Continue.
  - **Step 2 is identical for every email.** It shows the email as text with “Change”, a hidden-but-present `autocomplete=username` input carrying the email (sr-only, not display:none, so password managers pair it), the Password field, Continue, “Email me a link instead”, “Forgot your password?” (ui 13, 44 coarse) and the line “Signed up with Google or Apple? Use those buttons above.”
  - MFA appears only after a correct password, as today. The server keeps its single generic error, so nothing reveals whether an account exists or how it signs in.
  - The step change is a 16px direction-aware slide plus a 220 cross-fade (a fade under reduced motion).
  - The title is “Welcome back” in display, with “Sign in to continue to Alevr.”, and “New to Alevr? Create an account” sits below.
- **OAuthAccountNotLinked** reads “This email already has a password. Sign in with it below.” It appears only after the provider has authenticated the email's owner, so it reveals nothing to a third party.
- **Legal links** drop lang=fr, add hrefLang=fr, and say “(in French)”.
- **macOS:**
  - Keeps single-step email and password.
  - Adds “Forgot password?”, “New to Alevr? Create an account” and “Signed up with Google or Apple? Continue in the browser.” (until G68).
  - Fields get brand styling: radius 10, hairline, focus edge.
  - While restoring, it shows JunoMark at 48pt over a still galaxy, cross-fading over 220. ProgressView is RETIRED.
- **iOS:** copy unified through the shared table. Native providers wait on G68.
- All three ship in the auth train (§14) from one string table.

### 6.13 Empty, error, loading, offline and session states

- **Empty state anatomy:** a 48px neutral dot-construction mark (32 in panels), a Newsreader title (page-title for pages, 22 for panels), 15px muted body capped at 44ch, one primary action and an optional quiet one. The panel variant is a tonal recess (muted, radius 16), never dashed. iOS JunoEmptyState replaces ContentUnavailableView everywhere except search results.
- **Sidebar empty:** “No chats yet. Start one with ⇧⌘O.” (Kbd in the platform form) under the “Recent” heading, with no aria-live.
- **Errors:** only the digest and Try again, with a product-aware secondary link (“Back to Code” or “Back to chat”). global-error links to /chat.
- **In-app 404:** renders inside the shell: “This page isn't here”, with “Back to chat” and “Search everything”.
- **Offline:** “Offline · you can read, sending is paused”, minimum height 28, 220 in and 160 out.
- **Session expired:** a dialog, “Your session expired. Sign in again to continue.”, with “Sign in” (returns to the same URL). The composer keeps its draft in sessionStorage per conversation.
- **Sign-out:** goes to /sign-in with the toast “Signed out”. No confirmation.

### 6.14 Voice (NEW; web realtime voice and dictation, Mac DesktopVoice and Dictation, iOS Voice)

- **States and copy:**
  - Ready: “Tap to talk”
  - Listening: 5 level bars in presence ink, following input level at up to 30fps
  - Thinking: galaxy 14 + “Thinking”
  - Speaking: bars follow output level
  - Interrupted, when the user talks over the answer: “Go ahead”
  - Muted: mic-off glyph + “Muted”
  - Permission denied: an EmptyState panel, “Alevr can't hear you”, with “Microphone access is off. Turn it on in {System Settings | Settings | your browser's site settings}.” and “Open settings” on native
  - Disconnected: “Voice disconnected · Try again”
  - Ended
- **Motion:** the voice glow runs only while the audio level is above zero and pauses in hidden tabs and inactive windows. Tier C shows still bars, and the level is exposed as an accessibility value.
- **Stop:** a 44 target.
- **Accessibility:** state changes are announced politely (“Listening”, “Alevr is speaking”).
- **Transcript:** voice turns appear as normal turns.
- **iOS:** voice haptics as in §4.8. The voice Live Activity is local (D34).

### 6.15 Share and export

- The public share page uses UserBubble and the transcript prose components. Its header reads “Shared chat” with a “Continue in Alevr” button. It shows no receipts or costs.
- Export lives in the More menu: Copy as Markdown, Download Markdown, and Print / Save as PDF through a print stylesheet that hides chrome.

### 6.16 Every other route

This covers projects (detail and files), memory, knowledge, skills, assistants, crew, connections, customize, permissions, profile, upgrade, compare, the design editor chrome, tasks, roadmap, admin, dev pages, legal pages and the marketing landing. Each gets:
- AppPageHeader with the page-title rung
- EmptyState for empty and error states
- content-shaped skeletons (C21)
- motion on the ladder
- removal of backdrop-filter in product chrome (marketing and design content are allowlisted)
- caption and micro moved to semantic rungs
- `text-*/NN` removed

The marketing landing uses the hero rung, and its long reveals are capped at 560.

### 6.17 Long content and media

- **User bubble:** taller than 12 lines, it clamps with a fade to `--user-bubble` and a “Show more” button in ui 13 (hover on `--user-bubble-hover`).
- **Tables:** scroll horizontally inside their block, with a sticky first column. Edge gradients show only when the table is scrollable; no mask-image.
- **Generated media lightbox:**
  - a full-screen overlay over a black/0.92 `.media-scrim`, with the image fitted inside 16px gutters
  - a 48px top bar: title, Download, Copy, Close
  - ← and → move between the thread's images; Esc closes; pinch and double-tap zoom on touch
  - enter 220 (opacity plus 0.97→1 from the thumbnail origin), exit 160 ease-in; fade only under reduced motion

### 6.18 Shared string table (contracts/product/juno-shell-v1.json → web, Mac, iOS) [P1]

It contains:
- greeting, placeholders, Incognito name, promise and confirmation, status words, “Now”, “In flight”, “{n} updates”
- “Routines” / “New routine”, “Deep research” / “Deep Field”
- every TurnStatus wording in C1, the finish and failure notes, “Jump to latest · {n} new”, “One message is already waiting”, “Uploading {n} files · {p}%”, the quota strip, the model-unavailable lines
- offline, 404, session-expired and sign-out copy, the empty sidebar line, “Restored to Library · Open”
- the approval verbs (Run, Edit {n} files, Send, Delete for good, Buy), “Not now”, “Tell Alevr instead”, “Keep planning”, “Approve and build”, “Available in a moment”, the announcer lines
- the voice states, the plan-gating dialog, and the sign-in and onboarding copy

RETIRED strings: “How can I help you today?”, “Private chat”, “What can I help with?”, “Automations”, “New automation”. Sentence case everywhere except macOS menu-bar commands, which use Title Case. French values are included, and new keys missing a translation fail parity CI.

---

## 7. Native

### 7.1 Shared

- **Toolchain:** the Xcode 27 SDK with a 26.0 deployment target. Fix the drift between project.yml (iOS 18) and the xcconfigs (26). Every API newer than 26 sits behind `#available` with a designed 26 fallback.
- **Generated tokens:**
  - colours: junoPresence, PresenceInk, PresenceWash, junoSignal, SignalInk, SignalWash, the status role colours, junoUserBubble, UserBubbleHover, junoSelected, junoMutedOnFill, junoInput, junoHairline, the cmp colours, and the high-contrast appearance
  - radii (composer 22, bubble 12/8), type rungs, shell and gesture tokens, durations, curves and springs
  - the Cobalt accent
- **Token-consumption tests** fail on hand-copied values. The presenceLight and presenceDark literals and the iOS-only riseIn exception are RETIRED.
- **JunoGalaxyMark:**
  - SwiftUI TimelineView/Canvas only while animating; otherwise a static shape
  - an eased stop (tau 0.35s) and a 60% finished dim
  - ink driven by tint
  - an optional accessibility label
  - the 3-per-window cap
  - pauses when off screen, when the window is not appearsActive, or when scenePhase is not active
- **JunoShimmerText:** becomes a deprecated shim that renders plain secondary-ink Text. Its 17 call sites (21 references counting its own file) move to galaxy plus words in the surface packages, and the shim is deleted in a post-wave cleanup PR.
- **JunoProductSwitch** replaces JunoProductOrbit everywhere. JunoProductOrbit becomes a deprecated shim forwarding to it, so DesktopProductMode, JunoMobilePhoneShell and CodeV2WindowPreview keep compiling until their packages switch. Its selection lives outside `.id(product)`.
- **Shared components:** one each of JunoEmptyState, JunoStatus, JunoPlanStepGlyph, JunoApprovalActions, JunoUserBubble, JunoAttachmentChip, JunoQuoteCard, JunoTurnStatus (the shared Mac and iOS TurnStatus state machine) and JunoWebViewPool (at most 3 live WKWebViews).
- **WebView pool overflow:** when a fourth view is needed, the least recently visible one is snapshotted with takeSnapshot and released. Its slot shows the snapshot, or a same-size “Tap to load” placeholder if no snapshot exists.
- **Glass audit:** all 93 glass references (25 `.glassEffect` calls) are checked against the control-layer rule, Reduce Transparency and Increase Contrast.

### 7.2 macOS idioms

- **Sidebar:** edge to edge on macOS 27, with accent-tinted icons and a semibold selection. Custom footers dim to 0.5 when the window is not appearsActive. Running rows use a 10pt still galaxy, replacing DesktopSidebarSpinner and the mini ProgressView. Fold headings become Buttons with a chevron (0→90° over 120) and accessibilityValue Expanded or Collapsed. Row overflow shows on hover or selection.
- **Toolbar:** monochrome; items declared once and toggled with `.hidden()`; `.help` text generated from JunoShortcutRegistry in ⌃⌥⇧⌘ order.
- **Product switch:** fades only the detail column (a 120 opacity change, no offset). @SceneStorage keeps each product's sidebar scroll.
- **Launch:** restores the last product and conversation. Approvals wait in Now and the menu bar until the first user event.
- **Composer:** the focus edge as in §3.9. While generating, controls dim to 0.72 on the tint tier.
- **Text size:** reaches every junoFont site and Studio. Snapshot tests run at .xxl, and a minHeight audit covers fixed frames.
- **Transcript:**
  - Instant follow, with Jump to latest · {n} new as a glass capsule using `.materialize`.
  - The cross-message poll backs off from 15s to 60s after 2 minutes idle and stops while the window is occluded.
  - The transcript is windowed at 40 turns, and Mermaid and artifacts use JunoWebViewPool.
- **Selection capsule:** Ask and Quote above the NSTextView selection, plus the same items in the context menu.
- **Menu bar extra:**
  - The first item is “Ask Alevr…  {shortcut}”.
  - Groups: Needs you, Running, Ready, Blocked, at most 5 each, with hand, still galaxy, check and circle-x. Blocked comes last, so it never sits next to Needs you.
  - The count and the Dock badge show needs-you only.
- **Menu bar:** the full menu bar in Title Case. On macOS 27, icons appear only on New Chat, New Code Session, Ask Alevr and Search.
- **Quick Entry:**
  - **Hotkey:** registered with Carbon RegisterEventHotKey (no new dependency). It is rebindable, consumes the keystroke (no leaked NBSP) and needs no Accessibility prompt. Double-tap ⌥ is opt-in and asks for Input Monitoring.
  - **Conflict state:** when registration fails with eventHotKeyExistsErr, the menu bar item shows “Ask Alevr…” with the subtitle “Choose a shortcut”. Opening Quick Entry from the menu shows “⌥Space is used by another app” with an inline recorder, and a rebind that fails reads “That shortcut is in use by another app.”
  - **Panel:** 120 in and 70 out per C24. resignKey and Esc hide it and keep the draft. ↩ sends in the panel and ⌘↩ continues in the main window. The answer streams in the panel.
  - **Autofill:** the opt-in setting “Attach what's in front” (default off) asks for Automation permission and attaches the frontmost Safari URL or Finder selection as an AttachmentChip [S6].
- **Notifications:** one actionable category per approval kind, with the real verb, “Not now” and “Open”, the same across Chat, Work and Code.
- **Intents:** a Conversation @AppEntity conforming to IndexedEntity, plus Ask Alevr, New chat and Open Code session.
- **Trackpad haptics:** as in §4.8.

### 7.3 iOS idioms

- **Drawer:**
  - Settles per D18, with Now pinned at the top.
  - While it is open, content is accessibilityHidden and `.accessibilityAction(.escape)` closes it.
  - AccessibilityFocusState moves focus to the drawer header and back to the sidebar button.
- **Product switch:** the Code end carries the hand badge plus accessibilityValue “1 needs you”, mirrored on the sidebar button. Chat ↔ Code cross-fades over 120. The plan lock follows §6.6.
- **Transcript (D14):**
  - A 40-turn render window, with “Show earlier” paging 40 at a time while keeping the scroll anchor through the ScrollPosition id.
  - Rows are Equatable on (id, content hash, isPending, feedback, branchPosition, isLast), with one environment actions object and memoised parts. Mermaid mounts on appear.
  - One live line through JunoTurnStatus; JunoMobilePendingLine is RETIRED.
  - Follow is not animated. Arrival is opacity plus a 6pt rise over 220.
  - VoiceOver gets an “Answer ready” announcement and a Messages rotor.
  - ViewThatFits wraps the action row onto two lines at accessibility sizes.
- **Private chat:** reuses JunoMobileMessageRow(isPrivate:) and JunoMobileComposer, with the confirmation from §6.1.
- **Model chip:** “Auto · {model}” sits left of the dial and opens a glance sheet through `.navigationTransition(.zoom)` with `.matchedTransitionSource`. The dial gets `.accessibilityAction(named: Choose model)`.
- **Approval card:**
  - Allow uses the ink disc; the heading uses signal-ink.
  - Commands show up to 8 lines with “Show all”.
  - Deny has its own haptic, and a busy spinner shows in the tapped capsule.
  - The deep-link approval requires LocalAuthentication.
  - Disclosures are at least 44pt.
- **Widgets:**
  - Small: New chat.
  - Medium: 4 actions plus the last chat from an App Group snapshot.
  - Lock Screen: accessoryCircular (New chat) and accessoryRectangular (“Needs you · {n}” with the hand).
  - Control Center: ControlWidgetButton for New chat and Voice.
  - ContainerRelativeShape tiles with `.widgetAccentable()` glyphs.
- **Live Activities:**
  - The voice activity ships now.
  - Run and approval activities ship behind a flag that turns on with G01:
    - Lock Screen 84–160pt with 14pt margins
    - compact leading: a still galaxy or a hand; compact trailing: Text(timerInterval:)
    - Button(intent:) with authentication for Allow
    - staleDate 15 min, after which the activity dims to 60% and reads “Stale · open to refresh”; dismissal 20 min after the end
    - honours isDynamicIslandLimitedInWidth and `.supplementalActivityFamilies([.small])`
- **App Intents:** the Conversation entity and Ask Alevr.

### 7.4 Electron

`native/desktop-electron` has its own renderer and token script. It is frozen in wave 2; no new divergent UI work goes into it. P1 keeps `npm run tokens:check` there green. A later wave will adopt the web rules and bind ⌘1/⌘2 through its app menu, which Electron controls.

---

## 8. Signature moments

1. **The live line becomes the receipt.** One element that never unmounts. The bubble lands in under 100ms. At about 250ms a 14px galaxy reads “Thinking”. It compresses into “Thought for 4s ›” with the reasoning inline, and words arrive through an ink fade that starts at 35%. The galaxy slows to a stop and dims, and “Auto · Sonnet 4.6” sits at rest in label 12, opening the true “Selected for” reasons. No competitor turns its working indicator into the explanation of the answer.
2. **One status language everywhere.** Running, Needs you, Ready and Blocked use the same glyphs, words and colours in the sidebar Now, home In flight, the Mac menu bar and Dock, the iPhone drawer and switch badge, and widgets. An approval puts an ember hand on all of them within a second and pulses once. A decision made anywhere clears it everywhere.
3. **Approvals you cannot fat-finger.** A 500ms arm that restarts whenever focus enters, and the real verb. Focus never jumps out of your terminal or a draft you are typing. Esc never denies, “Tell Alevr instead” is always there, and approval is behind Face ID on iPhone.
4. **Ask about this, and watch it travel.** The quote card flies from your selection into the composer, then into your bubble: the same component at the same size.
5. **The home that arrives once.** A 560ms clip-wipe greeting on the first visit of a session, then 160ms fades. The composer docks on y only, because home and dock share one column.
6. **Symmetric motion.** Docks, canvas, palette, sheets, folds, toasts and Jump to latest all leave the way they came, faster, on ease-in. Dock panes never remount within the cap.
7. **Native that wrappers cannot copy.**
   - ⌥Space Quick Entry answers in a 120ms glass panel, attaches what is in front if you opt in, and handles a taken shortcut gracefully.
   - The edge-to-edge sidebar follows the Liquid Glass slider.
   - The trackpad ticks at snap points.
   - The iPhone drawer carries your fling velocity.
8. **Light on the machine.**
   - The Mac idles at 220MB or less.
   - The web sidebar paints from SSR in the first frame.
   - A 1,000-message iPhone thread stays at 300MB or less.
   - No more than 3 galaxies ever animate, and dock panes are evicted when hidden.

---

## 9. Budgets and gates

Harness: P0. Owners enforce their gates by listing them in their own `e2e/wave2/<pkg>/gates.ts`; unlisted gates run report-only.

| Gate | Budget | Measured by | Owner |
|---|---|---|---|
| Enter → bubble painted | ≤ 100ms p95 over 20 runs | marks alevr:enter → alevr:bubble-painted, production build | P5 |
| Enter → TurnStatus visible (first token at 800ms) | ≤ 300ms p95, target 250 | alevr:status-visible | P5 |
| Fast first token (120ms) | TurnStatus never visible | mocked stream | P5 |
| ⌘K warm open → rows painted | ≤ 1 frame (≤ 20ms) | alevr:palette-open → palette-painted, after idle preload | P4 |
| ⌘K cold open | shell in the first frame, rows ≤ 150ms | preload disabled | P4 |
| Route click → shell visible | ≤ 100ms p95 (ROUTE_WAIT_MS 80) | alevr:route-click → shell-visible | P2/P4 |
| INP | < 200ms on a 1,000-message thread | web-vitals | P5 |
| Long tasks while streaming | none > 50ms during a 2,000-token stream at 4× CPU throttle; reports whether the band text-shadow is the cause | trace | P5 |
| Tail drain | ≤ 250ms | marks | P5 |
| Sidebar CLS on hard load | 0 | layout-shift entries | P4 |
| Web JS heap after GC | ≤ baseline + 10% on the 1,000-message thread | CDP | P0 |
| Animating galaxies | ≤ 3 per window | data-animating count; Swift test | P2/P3 |
| Live dock panes | ≤ 3; a hidden pane evicted after 10 min (injected clock) | DOM count | P6 |
| Mac idle RSS | ≤ 220MB, 60s after opening a seeded 200-message conversation | Release, XCTMemoryMetric | P8 |
| Quick Entry | ≤ +30MB RSS; hotkey → key window ≤ 120ms | signpost | P8 |
| WKWebView pool | ≤ 3 live | XCTest | P3/P8 |
| Mac poll | 15s → 60s after 2 min idle; 0 requests while occluded | injected clock | P8 |
| iOS 1,000-message thread | ≤ 300MB on open (40-turn window); paging 40 earlier ≤ 250ms; hitch ratio ≤ 5ms/s over a 10s fling | Release, XCTMemoryMetric, XCTOSSignpostMetric | P9 |
| Contrast matrix | every pair passes per §3.1 | P1 CI | P1 |
| axe-core | 0 serious or critical on shell, chat, Code, Library, Settings, sign-in | Playwright | P0, plus each owner for its routes |
| Colour-vision deficiency | status fixture under deuteranopia and protanopia filters: hand vs circle-x distinguishable by shape mask | P0 | P2 |
| Bubble and composer parity | six contexts share radii 12/12/12/8 and the user-bubble fill; composer 22 and disc 12 on every platform | P0 | P2/P3/P5/P6/P8/P9 |
| Lint | off-ladder durations, unguarded `--motion-*` overrides, `text-<token>/<NN>`, blur in entrance keyframes, backdrop-filter in product chrome, caption or micro in transcript chrome, raw presence hex | P1 | each package's enforce file |

---

## 10. Accessibility contracts

**Approvals (D20).**
- The container is role=group with aria-labelledby (heading) and aria-describedby (summary).
- **Take** moves focus to the container (tabIndex −1). It applies only when focus is in the thread, or in a composer that is empty or has had no keystroke and no selection for `--hold-composer-idle` (2s).
- **Announce** applies otherwise (xterm, dock inputs, a non-empty or active composer). Focus stays put, the ApprovalAnnouncer speaks, and a “Review approval” button is inserted immediately after the active input in tab order. ⌥⌘A (Alt+Shift+A on Windows and Linux) focuses the approval.
- ⌘↩ (Ctrl+Enter) approves only when focus is inside the container and the arm has finished. In the composer, ⌘↩ keeps its send meaning for mod-enter senders.
- The arm state is announced. A visible ⌘↩ hint sits beside the verb. Return on the container does nothing. Esc never denies.

**Other contracts.**
- **Now hold rule:** C11, with needs-you never delayed in signalling and roving focus held on the row id.
- **Announcers:** one title announcer (AnimatedTitle `announce`) and one completion announcer (“Answer ready”). There is no live region while streaming.
- **Targets:** at least 24×24 everywhere (turn rails included), 44 on coarse pointers and iOS, 32 for web pointers, 28 for Mac pointers.
- **Status** is never shown by colour alone. Signal and destructive inks are text only on canvas, card and popover.
- **Older-turn actions** are reachable by keyboard (`:focus-within`).
- **Pinned turn** (when G18 ships): it never moves screen-reader focus, and the spacer never triggers Jump to latest.

---

## 11. Owner sign-offs (needed before the dependent train ships, not before building)

**Owner decisions, 2026-10-16.** The owner approved S1 (signal plus hand means needs you everywhere; signal 14 → 24/28, destructive 3 → 356), S3 (one bubble shape, 12 with an 8 tuck), S4 (home composer width equals the dock, 75ch wide prose cap, the 12px type floor on web, drawer dim 0.12) and S7 (Ultramarine becomes Cobalt). S2 stays at no change, S6 ships opt-in behind the Automation prompt, and S8 waits for a check of every provider's terms. S5 is informational.


- **S1:** signal plus hand means needs you in every product, and the hue moves (signal 14 → 24/28, destructive 3 → 356). Amber becomes warnings only. This overrides the audit's coral-for-Code, presence-for-Chat-and-Work split. Packages build against role tokens, so a rejection changes only the role mapping in globals.css.
- **S2:** a graphite hairline and scrim retune. The default is no change.
- **S3:** the unified bubble shape (12/8 tuck; Code v2's 18 retired).
- **S4:** the remaining visible layout changes:
  - the home composer width equals the dock width
  - the wide-transcript prose cap at 75ch
  - the type floor lift from 11 to 12px on web
  - the drawer dim raised from 0.04 to 0.12
- **S5 (informational):** the per-platform chords of §5.7.
- **S6:** Quick Entry Autofill ships opt-in, behind an Automation permission prompt.
- **S7:** Ultramarine becomes Cobalt, which changes the colour for users who chose it.
- **S8:** the incognito promise gains “isn't used to train models”, only after a check of every provider's terms.

## 12. Risks and dependencies

- **Wave 1 reconciliation:** gesture constants, spring names and the view transition kinds are taken from wave 1 as they are today. P1 and P2 regenerate rather than rename wherever possible.
- **The type floor lift** (1,344 uses) is the largest visual change. P0's before/after visual matrix gates it, and each owner fixes overflow in its own files before the web train ships.
- **Galaxy legibility** at 10, 12 and 14 in light, dark and high contrast must be confirmed (P2 and P3 snapshots) before any shimmer call site is removed.
- **Bootstrap growth** from Now, starred projects and the roster: +8KB gzipped and TTFB within 10%.
- **Unverified APIs**, to check before native builds depend on them:
  - the SensoryFeedback `.press` name
  - the macOS 27 interactive glass and Liquid Glass slider APIs
  - the Increase Contrast show-borders key
  - NSStatusItem expanded sessions
  - the corner-shape superellipse value
  - Live Activity push budgets
- **Dependencies:** G01, G68, G70, G18, and the React 19.3 / Next 16 upgrade. Next 16.3's Turbopack memory eviction is also a dev-RAM win.
- **Density:** the 12px floor in Code gutters and notifications must be checked at 1280×800 and at iPhone accessibility sizes.

## 13. Judge must-fix ledger

| Must-fix | Resolution | Package |
|---|---|---|
| Running sidebar contradiction | D9 | P2, P4, P3, P8 |
| 900ms rung breaks the ladder | D2, C3 | P1, P5, P7 |
| Coral sign-off; amber in the same release | D3, S1, D33 trains, role tokens | P1, P2, P4, P5, P7 |
| Coral vs destructive under CVD; colour-only dot | D3 hue and luminance move, D4, CVD gate | P1, P2, P0 |
| No ownable visual moment | TurnStatus, C1 | P5, P3 |
| Hairline retune is a judgement call | D5, S2 | P1 |
| Bubble unification in one change | D6, parity gate, web train | P1, P2, P3, P5, P6, P8, P9 |
| Sheet physics vs wave 1 | D18 adopts wave 1 | P1, P2, P3 |
| No dependency on named view transitions | D23 | P2 |
| Galaxy legibility before shimmer deletion | snapshots first; shimmer neutered as a shim | P2, P3 |
| Production-build QA; nothing left running | P0 runner, §14 | P0 |
| Muted ink fails AA on fills | D19, §3.1 | P1 |
| Approval focus model | D20, §10 | P2, P6, P7, P10 |
| Now inserts shift layout | C11 | P2, P4 |
| Turn-rail target size | D22 | P5, P6 |
| Prose line length | D13 | P1 |
| Mac switch hidden; one chord | D7, D8 | P3, P8 |
| Header blur fallback | D15: no blur at all | P5 |
| Pinned turn and screen readers | §10; G18 deferred | – |
| Bell replacement | D10 | P4 |
| Settings deep links | §6.10 | P11 |
| iOS LazyVStack regression | D14 | P9 |
| Auto-follow vs windowing | D11 | P5 |
| Static bottom fade | D12 | P5 |
| Band text-shadow cost | C2, `.stream-lite`, gate | P1, P5 |
| Re-measure once after the fold | rule 7, `alevr:layout-settled` | P4, P5 |
| Reduced-motion removal with a tier audit | §4.7 | P1, P6 |
| Sequencing for partial delivery | orders 0–4 plus trains | all |
| Native `#available` gating and glass audit | §7.1 | P3 |
| Snapshot tests for visible changes | S4, P0 matrix | P0 |

## 14. Build rules for every package

**Safety.**
- Builders work only in their own worktree, cut from main after P0's `scripts/qa/check-base.sh` passes. That check requires no unmerged paths and requires the wave-1 integration commit to be an ancestor of HEAD.
- Never touch production, secrets or the production database.
- Every server, e2e run or script goes through `scripts/qa/run-prod-e2e.sh`. The runner:
  - sets DATABASE_URL and DIRECT_URL to `postgresql://postgres@127.0.0.1:55439/alevr_<package>_test`
  - refuses any other host, and any database name that does not end in `_test`
  - refuses when a .env, .env.local, .env.production or .env.production.local file is present
  - refuses a non-localhost E2E_BASE_URL
  - passes an allowlisted environment only
  - forces the smoke model provider
- Use Node 24: `export PATH=/Users/liammagnier/.npm/_npx/387698761821791d/node_modules/node/bin:$PATH`.

**Production builds and RAM.**
- Visual and performance QA runs only on `next build` + `next start` and on Release native builds. No dev servers.
- Every script tears down what it started: the server process group is killed in a trap, the test database is dropped, and any simulator the script booted is shut down. Nothing is left running locally. Heavy native performance runs go to CI.

**Ownership.**
- Files are owned exactly as listed in the packages.
- An existing test belongs to the owner of its subject. New wave-2 tests go in `tests/wave2-<pkg>-*.test.ts`, `e2e/wave2/<pkg>/` (screenshot baselines alongside), or `Tests/Wave2/<Pkg>/` natively.
- No package adds an npm or SwiftPM dependency. package.json changes are P0's scripts only.
- New strings come only from P1's table. A string a package needs beyond the table goes in that package's own constants and is folded into the table after the wave.

**Lint enforcement.**
- P1's rules warn everywhere. Each package lists the web and native globs it has cleaned in its own `eslint-rules/enforce/<pkg>.json`, which turns those globs to error. P1's config and the native design check load every enforce file.
- Gate enforcement works the same way through `e2e/wave2/<pkg>/gates.ts`.

**Merge order and ship order (D33).** Packages merge into `integrate-wave2` in order. Users receive trains:
- **Web train:** P1, P2, P4, P5, P6 and P7, together, after P0's gates pass.
- **Native train:** P3, P8, P9 and P10, in one app release.
- **Auth train:** P11, after both.

Nothing from a train reaches main or the App Store alone, so the needs-you colour, the type floor and the bubble never ship half-converted.

**Screenshot matrix per package.**
- Web: light, dark and high contrast × 1440×900 and 390×844 × reduced motion on and off.
- Native: light, dark, Increase Contrast, Reduce Transparency, macOS .xxl and iOS Dynamic Type AX3.

## 15. Operational note on the request to free RAM

**What this revision ran.** It ran only read-only file reads, git status, `ps`, and three short contrast-arithmetic scripts that exited at once. It started no servers, builds, simulators or watchers, and nothing it started is still running.

**Current top memory users** (2026-10-16), none started by this session:
- a WebKit content process at about 1.78GB (PID 26980, up about 1h29m)
- the Claude desktop renderer at about 1.0GB
- a second WebKit content process at about 0.7GB
- a Virtualization.framework VM at about 0.65GB
- the ChatGPT Codex process at about 0.55GB, plus ChatGPT at about 0.28GB
- Discord at about 0.41GB

The earlier `next dev -p 3463` server and the review tsc runs are gone. Closing the large WebKit tab or window, the VM or the other apps is the user's decision.

**Going forward.** This program's own contribution to the RAM problem is P0's no-dev-server runner, the teardown traps, CI-only native performance runs, and the §9 budgets.

## 16. Critique resolution ledger

**Problems**

| # | Critique item | Resolution |
|---|---|---|
| 1 | Order-1 acceptance has no safe runner; config runs `npm run dev`, reuses :3000 and passes the whole environment | New order-0 P0 owns the runner and playwright.config.ts: next start, reuseExistingServer false, allowlisted env, refuses non-`_test` databases, .env files and remote base URLs; the config throws without the runner (§14) |
| 2 | Take policy steals focus while typing; ⌘↩ senders could approve | D20: take only for thread or idle/empty composer; ⌘↩ scoped to the approval container; the arm restarts on focus entry; drafts never replaced (§10) |
| 3 | alertdialog misuse; unlimited assertive announcements | role=group; one ApprovalAnnouncer with batching and a 10s assertive limit (C16) |
| 4 | View transitions already ship; 450ms freeze; navigation:auto is a no-op; root rule collision | D23, C18: keep `thread` and `canvas`, ROUTE_WAIT_MS 80, instant root, no `@view-transition` rule; ownership split stated (P1 CSS, P2 JS, P5 and P7 call sites) |
| 5 | Off-ladder values everywhere | §4.2 named families (delays, holds, loops, physics, stream) accepted by lint; galaxy entrance moved to 360 |
| 6 | Drop overlay and Quick Entry exits slower than entrances | C24: 120 in, 70 out; D21 restated as “rung below or shorter” |
| 7 | Width and height animations break the property rule; out-back on width | D27 names four cases; dock snap settles on out-soft with no overshoot (C12); containment and a single re-measure |
| 8 | Two meanings of standard; ease-spring, spring.interactive, stagger-fav ignored | D28 and §4.4: generated CSS twins share names; interactive → snap; pop → reward; stagger-fav → stagger-row; ease-spring kept |
| 9 | Three receipt definitions; cost by default | D25: one definition, usage opt-in, billing currency; Research follows the same setting (§6.10) |
| 10 | Border 3:1 fails, HC border 3.33, HC muted below 7 | §3.1: --input for control edges (3.43–3.65), --border decorative; HC border 48%/52% (≥3.58); HC muted 28%/80% (≥7.2 on every ground) |
| 11 | Signal and destructive 11° apart, 1.35:1 | D3: hues 24/28 vs 356, luminance 1.71/1.81, deuteranopia 2.30/2.00 |
| 12 | Ultramarine equals presence; custom hex; amber; labels | D26, §3.3: Cobalt (S7), invariant replaces the hue rule, web labels added |
| 13 | Transcript widths silently narrowed; medium vs default id | D13: widths and ids unchanged; Mac stays 768; JunoReadingMeasure extended, values unchanged |
| 14 | Home width formula wrong and overflowing | C4: both composers use `.transcript-column` in the same gutter container |
| 15 | Text size scale diverged and lacked a web spec | §3.5: six shared ids at 14–20px (×0.875–1.25), no migration, web rem rules stated |
| 16 | 12px floor unowned; contradicts Mac 11pt | D16: P1 lifts the rungs in one place; per-platform floors (macOS 11pt) |
| 17 | Backdrop ban breaks features | D15 scoped to product chrome with an allowlist; owners listed in §3.8 |
| 18 | Opacity-on-text lint unimplementable | Lint bans only `text-<token>/<NN>`; disabled opacity allowed (§3.1) |
| 19 | iOS eager VStack vs budget | D14: 40-turn window with paging; budgets restated (§9) |
| 20 | Keep-alive panes vs RAM | D29 eviction: cap 3, 10 min, xterm serialise, preview paused |
| 21 | Canvas per row; canvas can't read custom properties | D9 static SVG still frames; the galaxy reads computed `color` (already supported) and re-reads on contrast, theme or forced-colors change, so HC and Highlight apply (P2) |
| 22 | Toaster outside .app-main-canvas | C15: `--composer-h` on :root, reset to 0 on unmount |
| 23 | ⌘K cold open fails the 1-frame gate | C6 idle preload; separate warm and cold gates (§9) |
| 24 | Wave-1 sheet physics misdescribed; parallel module; 16px edge clash | D18 adopts sheet-gesture.ts values (0.5/0.3/0.3/0.4/24/64/140–300); no use-drag-settle; web edge stays 24 |
| 25 | Scrims disagree; 0.04 dim too faint | §5.6 parity rule; drawer dim 0.12/0.30 |
| 26 | Bubble fill equals hover fill; padding change unstated | `--user-bubble-hover`; padding stays 10/16 (D6) |
| 27 | ⌃⌘F is system full screen | Canvas full screen is F (focused, not editing) plus the button (§5.7) |
| 28 | Identifier-first leaks account existence and type | D31, §6.12: identical step 2, hidden username field, MFA after password, generic error kept |
| 29 | Server onboarding needs a migration and backfill | §6.11: field, backfill, cutoff for rowless accounts, localStorage upgrade |
| 30 | Unverified training claim; friction; beforeunload | D30, S8: today's promise only; in-app confirmation with “Don't ask again”; no beforeunload |
| 31 | Older-turn actions unreachable by keyboard | `:focus-within`, buttons kept in tab order (§6.2) |
| 32 | Hold rule delays needs-you | C11: needs-you signals immediately; the row waits at most 2s |
| 33 | Stale claims | Corrected: data-motion kill already gone; transition:none at ~1578; Code already uses Sonner; no --dur-editorial exists; 695 junoFont sites; 17 shimmer call sites; chord wording; §15 refreshed |
| 34 | “Wave 1 landed” false (UU files) | Verified clean at 244366124; P0 base gate before any worktree is cut |
| 35 | Packages too big | Split by platform: tokens/strings (P1), web foundations (P2), native foundations (P3), web Code (P6), native Code and Work (P10); web chat merged to end the chat-view split; 12 packages |
| 36 | P3 waits on S1; amber not migratable in one PR | Role tokens make packages S1-agnostic; trains ship needs-you consumers together (D33) |
| 37 | Live Activities without push | D34: runs and approvals behind G01; voice local |
| 38 | ⌥Space collision | D35, §7.2: conflict state, inline recorder, Settings recorder |

**Missing items**

| # | Item | Where |
|---|---|---|
| M1 | Long-tail web routes | §6.16, P7 |
| M2 | iOS Work, Tasks, Routines, Library, Research, Memory, Project and Voice; JunoWorkKit, JunoVoiceKit, JunoDesignKit | P10 (work surfaces, WorkKit, DesignKit), P9 (voice), P3 (VoiceKit) |
| M3 | Voice mode | §6.14 |
| M4 | Electron | D37, §7.4 |
| M5 | Code plan gating | D36, §6.6 |
| M6 | Quota, model unavailable, Auto fallback | §6.3, C1 table |
| M7 | TurnStatus beyond the happy path | C1 table |
| M8 | Mobile keyboard, viewport, landscape, iPad Safari, touchReturn | §5.3 |
| M9 | Fourth WKWebView | §7.1 overflow rule |
| M10 | Mac minimum window with inspector | §5.4 |
| M11 | Windows/Linux Kbd glyphs | §5.7 |
| M12 | Localisation and RTL | §3.13, §6.18 |
| M13 | Now vs Recent dedupe; multi-window | §6.4 |
| M14 | Long content, wide tables, lightbox | §6.17 |
| M15 | Share, export, session expired, sign-out | §6.15, §6.13 |
| M16 | Empty results | §6.5, §6.8 |
| M17 | Receipt preference | D25, §6.10 |
| M18 | Windows chords (Ctrl+Alt) | D7, D22, §5.7 |

**Overlaps**

| # | Overlap | Resolution |
|---|---|---|
| O1 | chat-view owned by P5, needed by P6 | Web chat is one package (P5) |
| O2 | Deleting JunoComposerMetrics breaks 6 files | Constant changed to 22, not deleted (§3.7) |
| O3 | Deleting JunoProductOrbit breaks the build | Deprecated shim; deletion post-wave (§7.1) |
| O4 | P1 codemods edit everyone's files | Per-package enforce files; each owner migrates its own files (§14) |
| O5 | Amber → signal spans many packages | Role tokens plus the web train; decision.tsx and team-activity.tsx owned by P5, semantic.css by P7 |
| O6 | Text size split three ways | Ids and scales unchanged; only JunoScaledFont changes (P3); the Settings UI is P11 |
| O7 | Parallel sheet implementation | P2 owns sheet-gesture.ts, ui/sheet-gesture.ts and sheet.css; no new module |
| O8 | View transitions spread | One decision (D23); P1 owns the CSS, P2 the JS, P5 and P7 the call sites |
| O9 | Toast offset across owners | P2 owns sonner.tsx, providers.tsx and use-composer-height; P5 calls it |
| O10 | Screenshots in P11's directories | P0 owns the harness; each package owns `e2e/wave2/<pkg>/` and its baselines |
| O11 | Sign-in across three packages | Web P11, Mac P8, iOS P9 from one string table; they ship together in the auth train |
| O12 | JunoReadingMeasure consumers | Values unchanged; WorkKit owned by P10 |
| O13 | Haptics grep test fails on CameraPanel | JunoMobileFeedback is in P3; each iOS package greps only its own files (P9 includes CameraPanel) |
| O14 | Directories had unmerged files | Verified clean; P0 base gate |


---

## Appendix: build packages

Each package owns its files, carries exact values from the spec above, and lists how a reviewer accepts it. Order 0 runs first, then the order-1 foundations, then the surfaces.

### P0-qa-harness: Safe production QA runner, gate harness and wave-1 base gate

Order 0. Platforms: web, macOS, iOS.

**Scope.** Makes every later acceptance run safe and light on RAM, and gates the wave-2 base.

(1) Base gate: scripts/qa/check-base.sh fails unless all of these hold:
- `git diff --name-only --diff-filter=U` is empty.
- The wave-1 integration commit 244366124 (or its merge into main) is an ancestor of HEAD.
- Main CI is green.
Every wave-2 worktree is cut from main after it passes, and each package PR prints its base SHA.

(2) Runner, scripts/qa/run-prod-e2e.sh:
- Node: export PATH=/Users/liammagnier/.npm/_npx/387698761821791d/node_modules/node/bin:$PATH.
- assert-safe-env.mjs refuses to run unless DATABASE_URL and DIRECT_URL are both postgresql://postgres@127.0.0.1:55439/<name> with <name> ending in _test.
- It also refuses when .env, .env.local, .env.production or .env.production.local exists in the working directory, and when E2E_BASE_URL has a host other than 127.0.0.1 or localhost.
- ensure-test-db.mjs creates the database and runs prisma migrate deploy with only those two variables.
- serve-prod.mjs runs next build, then next start on a random free port.
- The child environment is an allowlist: PATH, HOME, TMPDIR, CI, NODE_ENV=production, PORT, DATABASE_URL, DIRECT_URL, JUNO_E2E_SMOKE_PROVIDER=1, and the keys in scripts/qa/test.env (test-only values; no real keys). Nothing else from the parent env passes.
- A trap on EXIT, INT and TERM kills the server process group, drops the database, and runs a ps check that fails if any node, next or postgres child from the run survives.

(3) playwright.config.ts:
- webServer.command is `node scripts/qa/serve-prod.mjs`, reuseExistingServer is false, the port comes from E2E_PORT, and env is the allowlist (never ...process.env).
- baseURL comes only from the runner port or a localhost E2E_BASE_URL. The NEXT_PUBLIC_APP_URL fallback is removed.
- The config throws unless ALEVR_QA_RUNNER=1, so plain `npx playwright test` can no longer start npm run dev or reuse whatever is on port 3000.
- Existing projects are kept, with firefox in CI only.
- New projects: chromium-1440 (1440×900), chromium-390 and webkit-390 (390×844), with light, dark and high-contrast (forcedColors and prefers-contrast emulation) and reduced-motion variants via test.use.
- workers is 1 locally and 2 in CI.
- package.json scripts: test:e2e runs the runner; any dev-server e2e script is removed. This is the only package.json change in wave 2, and no package adds dependencies.

(4) e2e/support:
- a perf-mark reader for alevr:* marks with p50/p95 over N runs
- budgets.ts with the spec section 9 numbers
- a screenshot-matrix helper that waits for document.getAnimations() to finish and captures the end state
- CVD SVG filters (deuteranopia, protanopia) with a shape-mask comparator
- an axe wrapper (serious and critical) and a contrast reader
- the gate registry, which globs e2e/wave2/*/gates.ts (each package owns its file and lists the gate ids it enforces) and runs all other gates report-only

(5) Cross-cutting gates owned here, report-only until an owner enforces them:
- sidebar CLS
- JS heap after GC against a recorded baseline
- axe across shell, chat, Code, Library, Settings and sign-in
- bubble and composer geometry parity (radius 12/12/12/8, fill token, composer 22, disc 12), measured on web and read from native snapshot exports
- the visual matrix of routes /chat home, a seeded thread, /code, a /code session, /library, a /research run, /automations, settings, sign-in and the 404, at 1440×900 and 390×844, light, dark and high contrast, with reduced motion on and off

(6) CI: design-gates.yml runs the web gates on a production build against a service Postgres whose database name ends in _test, plus native performance and snapshot suites on Release builds. It publishes JSON reports (p50/p95) and screenshots.

(7) Native test support:
- XCTest helpers: an XCTMemoryMetric wrapper, an os_signpost metric, an injectable clock, an occlusion mock
- snapshot support at macOS text size .xxl, Increase Contrast, Reduce Transparency, and iOS Dynamic Type AX3
- scripts/qa/native-perf.sh refuses to run locally unless ALEVR_ALLOW_LOCAL_NATIVE=1, and its trap runs xcrun simctl shutdown on any simulator it booted

(8) scripts/qa/README.md lists every gate, its owner and its enforce/report state.

**Owns.** `playwright.config.ts`, `package.json`, `scripts/qa/`, `e2e/support/`, `e2e/wave2/p0-harness/`, `tests/wave2-p0-*.test.ts`, `.github/workflows/design-gates.yml`, `native/macOS/JunoDesktop/Tests/Performance/`, `native/macOS/JunoDesktop/Tests/Snapshots/Support/`, `native/iOS/JunoMobile/Tests/Performance/`, `native/iOS/JunoMobile/Tests/Snapshots/Support/`

**Acceptance.** Base gate:
- check-base.sh passes on the wave-1 base.
- It fails on a fixture repo with an unmerged path.

Runner safety (tests/wave2-p0-runner.test.ts, with fake values only). run-prod-e2e.sh exits non-zero for each of these:
- DATABASE_URL=postgresql://user@db.example.com:5432/app
- a database name not ending in _test
- E2E_BASE_URL=https://alevr.app
- a .env file present in the working directory

Config:
- `npx playwright test` without the runner throws before any webServer starts.

Smoke run:
- e2e/wave2/p0-harness/smoke.spec.ts renders /chat on a production build at 1440×900 and 390×844, light and dark.
- After the run, the script's ps check finds no node, next or postgres child process.

Gate registry:
- Listing a fixture gate in a fixture gates.ts flips it to enforce.
- A seeded regression then fails the run, while unlisted gates only warn.

Native:
- The helpers compile in CI, and a sample XCTMemoryMetric test reports a value.
- Local helper runs boot no simulator unless ALEVR_ALLOW_LOCAL_NATIVE=1, and shut down what they boot.

### P1-pipeline: Tokens, strings and generators to TS and Swift, lint framework and contrast matrix

Order 1. Platforms: web, macOS, iOS.

**Scope.** One pipeline for every value and string. This package also owns globals.css behaviours.

(1) Colour, in :root and .dark (values from spec section 3.1):
- NEW: --muted-foreground-on-fill (217.5 4% 38.8% / 222.9 4.1% 66.5%), --ink-tertiary, --user-bubble-hover (210 6% 90.2% / 225 5% 19.5%), --presence-wash, --signal-wash.
- Changed: --signal 24 80% 46% / 28 95% 70%; --signal-ink 22 78% 40% / 28 95% 72%; --destructive 356 72% 42% / 356 70% 64%.
- --input keeps its values, documented as the control-boundary token. --attention keeps its values, documented as warnings only.
- Status role tokens --status-running, --status-needs-you, --status-needs-you-ink, --status-ready, --status-blocked.
- Move --cmp-ink-2 and --cmp-well/-2/-3 into globals.css with the same values; P5 deletes the old copies.
- Keep --hairline and --scrim unchanged [S2]. Delete the wave-1 scoped presence variables.

(2) High contrast (section 3.2):
- Light: muted 217 5% 28%, border 220 5% 48%, presence #1F38A8, signal-ink 20 80% 32%, destructive 356 75% 34%.
- Dark: muted 223 5% 80%, border 225 4% 52%, presence #B4C0F0, signal-ink 26 100% 80%, destructive 356 90% 82%.
- Both: hairline becomes a solid border, ring 3px, tone-step borders at foreground/0.32.
- forced-colors rules.

(3) Accents: ultramarine becomes hsl(205 78% 36%) with label Cobalt [S7]. Add a `label` to each web ACCENT, matching JunoAccent.

(4) Type:
- home-title and page-title rungs (page-title fixed 1.75rem below 640).
- text-caption raised to 0.75rem/1.4; text-micro aliased to it.
- NEW text-kbd 0.6875rem mono.
- label mono 500 0.75rem/1.4, 0.01em, tabular-nums.
- Tooltip and notification body sizes on ui.

(5) Radius ladder, plus --radius-bubble 12 and --radius-bubble-tuck 8. Add the @supports corner-shape enhancement.

(6) Shell and gesture tokens from section 3.12, including the wave-1 gesture constants (0.5 / 0.30 / 0.3 / 0.40 / 24px / slop 8 / rubber band 64 and 0.55 / settle 140–300), --drawer-dim 0.12/0.30, and --transcript-max 40/48/62rem (unchanged).

(7) Motion:
- Rungs 70/120/160/220/360/560.
- Named families: --delay-*, --hold-*, --loop-*, --settle-*, --stream-*.
- Curves, including --ease-spring.
- Generated CSS linear() twins plus -dur for snap, standard, layout, emphasized, reward and articulate, computed from {visualDuration, bounce}. This replaces the hand-written --spring-standard.
- Retire --spring-pop (alias it to --spring-reward until uses move), --stagger-fav (alias it to --stagger-row), --alv-ease if present, and Code's --dur-mid and --dur-wide if declared globally.

(8) Global CSS behaviours in globals.css:
- Delete the turn-in keyframe (420ms, blur) and the .turn-body > * blur entrance. Add rise-user (6px × shift, 120 out-soft) and settle-part (4px × shift, 220, no blur).
- The first stream highlight band starts at 35% ink. Add .stream-lite, which drops text-shadow.
- Delete the reduced-motion `transition: none` on .composer-surface (~1578), and on .control-primary (~1216) and .sidebar-motion-icon__glyph (~1372) where they remove Tier A fades. Add a per-keyframe tier table (A/B/C).
- Prose: .prose-juno max-inline-size none; [data-transcript-width=wide] .prose-juno :is(p,li,blockquote,h1,h2,h3,h4) max-inline-size 75ch.
- .aicss-cb-head becomes sticky at top 0 with the block background.
- Scrollable tables get a sticky first column and edge gradients.
- View transitions:
  - html[data-vt] root old/new: animation none.
  - thread app-page old: opacity out over 120 ease-in; new: opacity plus 4px × shift over 160 out-soft.
  - canvas group: 360 out-expo open, 220 ease-in close (html[data-vt-dir=close]).
  - Reduced-motion variants.
  - No @view-transition rule.
- Global :focus-visible: 2px --ring, offset 2px.
- Remove backdrop-filter from globals.css product rules.

(9) Generators:
- generate-design-tokens.ts emits everything above to tokens.generated.ts and JunoGeneratedTokens.swift, including the high-contrast appearance, the role colours and the gesture constants.
- generate-shell-contract.mjs emits the full section 6.18 table, with en and fr, to src/lib/strings (TS), native/macOS/JunoDesktop/App/Generated/JunoShellContract.swift and native/iOS/JunoMobile/Resources/Shell.xcstrings (table Shell). names.ts supplies Routines and Deep research.
- Keep native/desktop-electron tokens:check green, adjusting its generate-tokens.ts only if needed.

(10) Lint (rules in eslint-rules, loaded by eslint.config.mjs). All rules warn everywhere and error only for globs listed in eslint-rules/enforce/*.json, which the config loads at startup. P1 lists its own files in p1.json. The rules:
- off-ladder duration and delay literals (rungs and named tokens allowed)
- `text-<token>/<NN>`
- text-caption, text-micro and arbitrary sizes in transcript chrome, the composer, tooltips, notifications and the sidebar (text-kbd only in Kbd and Badge)
- blur() in entrance keyframes
- backdrop-filter outside the allowlist (src/components/home, src/components/landing, src/components/design, src/lib/design, src/app/dev, .media-scrim)
- unguarded --motion-scale-from and --motion-shift overrides
- raw #2d49c9 and #97a6e6 outside globals

The native checks (check-native-design*.mjs, check-native-motion.mjs) apply the same per-package enforce globs.

(11) Contrast matrix: check-contrast-matrix.ts parses globals.css and applies the section 3.1 rules (text ≥4.5, HC muted and body ≥7 on every ground, glyphs ≥3, --input and --ring boundaries ≥3, --border and --hairline exempt). It records the known-bad muted-on-selected pair. It is wired into CI and native-parity.yml.

**Owns.** `src/app/globals.css`, `tailwind.config.ts`, `postcss/motion-preference.cjs`, `scripts/generate-design-tokens.ts`, `scripts/generate-shell-contract.mjs`, `scripts/check-contrast-matrix.ts`, `scripts/check-native-design.mjs`, `scripts/check-native-design-lib.mjs`, `scripts/check-native-design-baseline.json`, `scripts/check-native-motion.mjs`, `contracts/product/juno-shell-v1.json`, `src/lib/design/tokens.generated.ts`, `src/lib/strings/`, `src/lib/brand/names.ts`, `src/lib/accents.ts`, `eslint-rules/*.js and eslint-rules/*.mjs (rule files)`, `eslint-rules/enforce/p1.json`, `eslint.config.mjs`, `tests/design-token-parity.test.ts`, `tests/wave2-p1-*.test.ts`, `.github/workflows/native-parity.yml`, `native/Packages/JunoNativeKit/Sources/JunoDesignSystem/Generated/`, `native/macOS/JunoDesktop/App/Generated/`, `native/iOS/JunoMobile/Resources/Shell.xcstrings`, `native/desktop-electron/scripts/generate-tokens.ts`, `e2e/wave2/p1-pipeline/`

**Acceptance.** Generator and drift:
- Running both generators twice yields no diff.
- native-parity CI fails when globals.css or juno-shell-v1.json changes without regenerated TS, Swift and xcstrings.
- native/desktop-electron `npm run tokens:check` passes.

Contrast (tests/wave2-p1-contrast.test.ts) reports at least:
- #5F6267 on #E6E7E9 ≥ 4.9 and #A6A8AD on #37383C ≥ 4.9
- HC muted ≥ 7.2 on every ground in both themes
- HC border ≥ 3.58 on selected (light) and ≥ 4.09 on card (dark)
- signal glyph #D36317 ≥ 3.0 on selected; signal-ink #B65116 ≥ 4.9 on canvas
- destructive #B81E28 ≥ 6.4
- input ≥ 3.26 in both themes
- the muted-on-selected 4.32 pair recorded as a misuse

CVD arithmetic test:
- signal and destructive are ≥ 2.0:1 apart under simulated deuteranopia in both themes.

Spring twins:
- The generated --spring-standard twin matches a spring(0.22, 0.05) sample to within 0.01 at 16 points.
- --spring-reward overshoot is ≤ 1.5%.

Lint:
- Every rule has a failing and a passing fixture.
- A file listed in an enforce file errors, and an unlisted file only warns.
- `npm run lint` exits 0 on the base.

Visual (production build via the P0 runner):
- Before/after screenshots of the visual matrix are published, showing the caption lift, the removed blur entrance and the new status colours.
- Computed style shows no filter blur on turn entrances.
- Under data-motion=reduced, transforms are none while opacity transitions remain.
- At wide transcript width, measured prose width is ≤ 75ch while a pre block spans 992px.
- The view-transition root has no animation, and the app-page group durations are 120 and 160.

### P2-web-foundations: Web motion, gesture and overlay primitives plus shared web components

Order 1. Platforms: web.

**Scope.** (1) motion.ts: presets read the generated springs (snap .18/0, standard .22/.05 instead of today's bounce 0, layout .36/0, emphasized .36/.10, reward .36/.18, articulate .22/.15). Retire spring.interactive by moving its users to snap. settle(remaining, v) returns clamp(remaining/abs(v), 140, 300)ms on --ease-drawer, as wave 1 does.

(2) interaction.ts TIMING mirrors the section 4.2 tokens: show 200, tooltip 500/300, hairline 300, actionRow 180, greeting 60, insertFlush 300, phase 600, skeleton 400, check 120, reasoning 1000, arm 500, needsYouMax 2000, insertMax 10000, composerIdle 2000, finishCheckMinWatched 10000, settledHapticMin 3000.

(3) perf-marks.ts: typed helpers for alevr:enter, bubble-painted, status-visible, palette-open, palette-painted, route-click and shell-visible.

(4) view-transition.ts: ROUTE_WAIT_MS 450 → 80, and the thread and canvas kinds are kept. route-click and shell-visible marks are emitted, and data-vt-dir is set on close. The CSS is in P1.

(5) sheet-gesture.ts imports its constants from tokens.generated.ts with values unchanged. ui/sheet-gesture.ts and sheet.css:
- a drag zone on the whole 44px header, or the first 44px of a body scrolled to the top
- release settles per D18
- programmatic dismiss over 220 ease-in, staying mounted until the end
- nested sheets displace 16px
- partial-detent scrim at half opacity (0.13 light, 0.28 dark)
- glance, form and page kinds
- no second gesture module

(6) Drawer: --drawer-width, 24px edge zone, 0.22 parallax, dim 0.12/0.30, tap outside closes. Under reduced motion it cross-fades over a still card for 220.

(7) Overlays:
- Frequent (dropdown, tooltip, selection-bar primitive): 120 out-soft from 0.97 at the Radix transform-origin, exit 70 ease-in.
- Infrequent (dialog, popover with content): 220 on --spring-standard, exit 160 to 0.98.
- Opened from the keyboard: opacity only, 120.
- Tooltip: ui 13, delays 500/300.

(8) sonner.tsx: 8px rise over 220 on spring.standard, exit 160 with a 4px drop. Offset bottom calc(var(--composer-h, 0px) + 16px). The Toaster stays mounted in providers.tsx.

(9) Hooks:
- use-composer-height publishes --composer-h on documentElement through a ResizeObserver and resets it to 0 on unmount.
- use-keyboard-inset publishes --kb-inset from visualViewport.
- use-first-visit reads the html data-first-visit attribute, which the ui-prefs boot script sets from sessionStorage inside try/catch.
- use-insert-hold(listRef, {kind}) queues inserts while the pointer is over rows or focus is within. It flushes 300ms after leave, on demand, or at max hold (needs-you max 2000, others 10000). It exposes pendingCount, and keeps roving focus by row id.
- use-modifier-key-label maps ⌘⌥⇧ to Ctrl, Alt and Shift on Windows and Linux.

(10) ui-prefs.ts adds motion (system, reduced, full), contrast (standard, more) and showUsage (off, tokens, tokensAndCost; default off) to the prefs and the boot attributes. transcriptWidth ids stay narrow, medium and wide with no migration. touchReturn and sendKey are unchanged.

(11) Components in src/components/ui:
- collapse: open 220 in-out with opacity 120, close 160, chevron 120, mounted and inert.
- icon-swap: 120, scale 0.8→1.
- pressable: 0.97 over 70, solo icon buttons only.
- Kbd and Badge use text-kbd and platform labels.
- segmented-control thumb on spring.standard.
- Remove backdrop-filter from the 2 ui files.

(12) Brand, galaxy-mark.tsx (47 call sites, no call-site change needed):
- A static SVG still frame drawn in currentColor whenever not animating. A canvas mounts only while animating and unmounts after the stop.
- A global registry caps animating instances at 3 per document, by priority: live line, then hovered or focused row, then others.
- Pause on IntersectionObserver out of view and on document.hidden.
- Entrance 360 spiral from 0.6 radius. Running period 2.4s, slowing to 4.8s after 20s. Exponential stop (tau 350ms), then a 60% dim over 220.
- needsYou: hand cross-fade over 160 and one 560 pulse. ready: check over 360 on --ease-spring after 120, only when watchedMs > 10000. blocked: still destructive frame.
- Ink comes from computed `color`, re-read on prefers-contrast, forced-colors and color-scheme changes and on html class or data-contrast mutation. In forced-colors it uses color Highlight. Tier C draws the still frame with its word.

(13) StatusMark: running, needsYou, ready and blocked at 10, 12 and 14, plus a badge variant (10 hand on a 16 signal-wash disc with an sr-only word). It reads only the role tokens.

(14) PlanStepGlyph, EmptyState and EmptyMark (48 and 32), and Skeleton (200 delay, 400 minimum, breathe 1→0.62 over 1.8s, aria-busy plus sr-only Loading, static 0.8 at Tier C).

(15) AttachmentChip and QuoteCard:
- Files 224×56 at radius 12; images 64×64 at radius 10.
- Progress arc, and a failed state with warning glyph, Failed and Retry.
- QuoteCard is labelled Selection.
- Stable layoutId for FLIP.

(16) UserBubble: radius 12 with an 8 border-end-end tuck, fill --user-bubble, padding 10/16, max 85%. It exports the fill, the clamp gradient stop and the bubble-hover class.

(17) Approvals (src/components/approvals):
- ApprovalActions layout: [Not now] [Verb ▾ filled ink; the caret holds Allow for this session] … [Tell Alevr instead], with an optional Amend. Heading in signal-ink, opaque card with a 2px signal leading edge, mono command up to 8 lines then Show all, busy spinner only in the tapped button, visible ⌘↩ hint.
- Arm: 500ms, restarted on each focus entry, using aria-disabled, opacity 0.6, ignored keys and sr-only “Available in a moment”.
- focusPolicy take: role=group, tabIndex −1, focus moved.
- focusPolicy announce: focus stays; a Review approval button is inserted after the active element.
- resolveFocusPolicy(activeElement, composerState) returns take only for the thread, or a composer that is empty or idle for 2000ms.
- ⌘↩ or Ctrl+Enter fires only within the container, after the arm. Esc never denies.
- ApprovalAnnouncer: one per window; the first announcement is assertive, then requests within 2s are batched into a polite count, with at most one assertive announcement per 10s.
- ⌥⌘A or Alt+Shift+A focuses the latest approval.
- verbs.ts holds Run, Edit {n} files, Send, Delete for good and Buy.

(18) page-transition.tsx: a 160 WAAPI opacity fallback (6px rise only when motion-safe) that leaves no transform behind.

(19) eslint-rules/enforce/p2.json lists every file this package owns.

**Owns.** `src/lib/motion.ts`, `src/lib/interaction.ts`, `src/lib/perf-marks.ts`, `src/lib/view-transition.ts`, `src/lib/sheet-gesture.ts`, `src/lib/ui-prefs.ts`, `src/lib/composer-keys.ts`, `src/hooks/use-first-visit.ts`, `src/hooks/use-insert-hold.ts`, `src/hooks/use-composer-height.ts`, `src/hooks/use-keyboard-inset.ts`, `src/hooks/use-modifier-key-label.ts`, `src/components/ui/ (every file except composer-shell.tsx)`, `src/components/brand/`, `src/components/approvals/`, `src/components/app/page-transition.tsx`, `src/components/providers.tsx`, `eslint-rules/enforce/p2.json`, `tests/wave2-p2-*.test.ts`, `e2e/wave2/p2-foundations/`

**Acceptance.** Unit tests (tests/wave2-p2-*):
- settle duration is clamped to 140–300 and shortens as velocity rises.
- sheet-gesture constants equal the wave-1 values.
- use-insert-hold queues while hovered and flushes 300ms after leave; needs-you flushes within 2000ms while still hovered.
- resolveFocusPolicy returns take for an empty composer and announce for a non-empty one, a recently typed one, or xterm.
- Approval: Enter and ⌘↩ inside 500ms do nothing; the arm restarts on refocus; ⌘↩ outside the container never approves.
- The announcer batches 3 requests within 2s into one polite message.
- The galaxy registry leaves exactly 3 of 6 running marks animating, pauses offscreen and hidden-tab marks, and leaves non-animating marks with no canvas element.

Playwright (production build via P0):
- A sheet flicked at 0.6px/ms dismisses; a drag of 20% released slowly settles back without an instant jump in transform samples.
- On programmatic dismiss the sheet stays mounted ≥ 200ms.
- Tooltip shows at ≥ 500ms and a peer shows instantly.
- Toast bottom equals composer height + 16 on /chat and 16 on /library.
- Under OS and in-app reduced motion, overlay entrances have no transform but keep their opacity transition.
- Route-click → shell-visible ≤ 100ms p95.
- Galaxy ink under forced-colors equals the Highlight system colour.

Screenshots:
- Status marks at 10, 12 and 14, light, dark, high contrast and CVD-filtered.
- Empty state, skeleton, attachment chip states, quote card, bubble, approval (armed and disarmed).
- Each at 1440×900 and 390×844, with reduced motion on and off.

axe: 0 serious on a fixture page of all components.

This package's gates.ts enforces the galaxy-cap and CVD gates.

### P3-native-foundations: Native token mappings, motion, haptics, shared SwiftUI components and toolchain

Order 1. Platforms: macOS, iOS.

**Scope.** (1) Toolchain: both apps build on the Xcode 27 SDK with deployment target 26.0, fixing the drift between project.yml (iOS 18) and the xcconfigs (26). Push xcconfigs are untouched (G01).

(2) Token mappings, read from the generated values:
- JunoDesignTokens.swift:
  - JunoMotion durations and curves, springs (snap, standard, layout, emphasized, reward, articulate, sendMorph), and press.
  - settle(remaining:velocity:) = interpolatingSpring(duration: clamp(remaining/abs(v), 0.14, 0.30), bounce: 0, initialVelocity: v/remaining).
  - The iOS-only riseIn exception is deleted.
  - JunoMotion.reduced(_:when:tier:) reads accessibilityReduceMotion plus UserDefaults alevr.motion (system, reduced, full).
  - JunoReadingMeasure keeps reading 768 and wide 1024, and adds narrow 640 and transcriptWide 992.
- JunoColors: generated roles including status, user-bubble-hover, muted-on-fill and input, plus the high-contrast appearance. The presenceLight and presenceDark literals are deleted.
- JunoAccent: .ultramarine is labelled Cobalt, with the generated value.
- JunoTypography: JunoScaledFont multiplies junoTextScale on macOS for every junoFont site, with a chrome: opt-out; iOS uses @ScaledMetric(relativeTo:) with a fixed: opt-out.
- JunoLayout: generated gesture constants, including edgeStrip 16pt.

(3) JunoComposerShell: JunoComposerMetrics.cornerRadius becomes 22, kept as a constant. Its focus edge is a ContainerRelativeShape stroke at foreground/0.24 (white 0.20 in dark) for pointer focus and junoAccent at 0.86 for keyboard focus, cross-fading on fast.

(4) JunoGalaxyMark:
- TimelineView/Canvas only while animating; otherwise a static shape.
- Entrance 360, periods 2.4s and 4.8s, exponential stop (tau 0.35), 60% dim.
- needsYou hand with one pulse; ready check only when watched > 10s; blocked still.
- Tint-driven ink and an optional accessibility label.
- A cap of 3 animating per window through an environment registry, pausing on disappear, when not appearsActive, and when scenePhase is not active.

(5) Shared components:
- JunoStatus enum (ink, glyph, word) and JunoStatusDot as the badge wrapper
- JunoPlanStepGlyph
- JunoEmptyState (tonal recess, Newsreader title)
- JunoSkeleton
- JunoAttachmentChip and JunoQuoteCard
- JunoUserBubble (UnevenRoundedRectangle continuous 12/12/12/8, padding 10/16, 85%)
- JunoApprovalActions: the same layout, verbs and arm as web. .keyboardShortcut(.return, modifiers: .command) is attached only after the arm and only while focused. Esc never denies.
- JunoTurnStatus: the shared Mac and iOS state machine and view, with the same states, timings and copy as C1, the Settled receipt slot and JunoStreamReveal pacing.
- JunoProductSwitch: recessed track at sidebar-accent/0.8, radius 10, 30 tall on Mac and 32 on iOS, 16 glyph plus 13pt medium label, matchedGeometry thumb on standard, a selection binding owned by the caller, an injected help string, an optional hand badge plus accessibilityValue, an optional lock state, capped at .xxxLarge with Large Content Viewer.
- JunoProductOrbit becomes a deprecated shim forwarding to JunoProductSwitch.

(6) JunoShimmerText becomes a deprecated shim rendering secondary-ink Text. JunoRunSignature uses the galaxy.

(7) Overlays and toasts: JunoOverlays transitions are 120/70 for frequent and 220/160 for infrequent. JunoToastHost offsets above the measured composer height.

(8) JunoIconGesture: articulation only on destinations; removed from message actions and heading + buttons.

(9) JunoMarkdownView:
- A selection API (onSelectionChange) and an Ask/Quote/Explain capsule view placed 8 above the selection rect, entering with a 4pt rise over 120 and exiting over 70, plus the matching context-menu items.
- Mermaid and artifacts acquire views from JunoWebViewPool.

(10) JunoWebViewPool: at most 3 live WKWebViews. On overflow, the least recently visible view is snapshotted with takeSnapshot and released; its slot shows the snapshot, or a same-size Tap to load placeholder.

(11) JunoEffortPanel: a 44pt header row (mark, model, Change ›), 2 recent models, and type-to-search. JunoGreeting: the shell-contract string in Newsreader with the clip-wipe (mask from 88% to 100% plus an 8pt x offset, timingCurve(.16,1,.3,1) 0.56s after 0.06s) on first arrival, otherwise a 0.16 fade.

(12) JunoVoiceKit: section 6.14 voice states and visuals (5 level bars at most 30fps, presence ink), still under Tier C, with the level exposed as an accessibility value.

(13) Haptics:
- JunoMobileFeedback holds the JunoMobileHaptic vocabulary from section 4.8, gated by UserDefaults alevr.haptics (default true).
- DesktopTrackpadHaptics: NSHapticFeedbackManager.defaultPerformer, with .alignment at min, max or snap and .levelChange for effort steps.

(14) JunoShortcutRegistry gains every wave-2 entry in ⌃⌥⇧⌘ order: ⌘1/⌘2, ⌘K, ⇧⌘F, ⇧⌘O, ⌥⌘A, ⌥⌘↑/↓, ⌘↩ approve, the Code toolbar entries, and Quick Entry's default ⌥Space display.

(15) Every new API above 26 is behind #available with a 26 fallback. Audit all 93 glass references against the control-layer rule, Reduce Transparency and Increase Contrast. eslint-rules/enforce/p3.json lists this package's Swift globs for the native checks.

**Owns.** `native/Packages/JunoNativeKit/Sources/JunoDesignSystem/ (every file except Generated/)`, `native/Packages/JunoNativeKit/Sources/JunoVoiceKit/`, `native/Packages/JunoNativeKit/Tests/JunoDesignSystemTests/`, `native/Packages/JunoNativeKit/Tests/ (tests whose subject is JunoDesignSystem or JunoVoiceKit)`, `native/iOS/JunoMobile/App/JunoMobileFeedback.swift`, `native/macOS/JunoDesktop/App/DesktopTrackpadHaptics.swift`, `native/macOS/JunoDesktop/App/JunoShortcutRegistry.swift`, `native/iOS/JunoMobile/project.yml`, `native/macOS/JunoDesktop/project.yml`, `native/Config/`, `eslint-rules/enforce/p3.json`

**Acceptance.** Swift tests (JunoDesignSystemTests, including new Wave2 tests):
- Token-consumption tests fail on any hand-copied presence, signal or bubble value.
- settle parameters match D18.
- reduced() honours the in-app override.
- The galaxy cap leaves 3 of 6 animating; inactive windows and scenes pause them; non-animating marks build no Canvas.
- JunoApprovalActions has no default or return shortcut during the arm, and Esc does not deny.
- The JunoWebViewPool live count never exceeds 3, and overflow produces a snapshot or placeholder.
- JunoTurnStatus identity is stable across all states.
- JunoShimmerText renders identically across two frames 500ms apart.
- A grep test finds no UIImpactFeedbackGenerator, UINotificationFeedbackGenerator or UISelectionFeedbackGenerator in files this package owns, outside JunoMobileFeedback.

Snapshots (P0 support):
- JunoStatus and the galaxy at 10, 12 and 14 in light, dark and Increase Contrast.
- JunoProductSwitch in light, dark and .xxl, plus locked and badged variants.
- JunoEmptyState, the bubble, the approval actions and the composer focus edges.
- macOS at .xxl shows captions scaled by 1.25.

Build:
- Both apps and all packages build on the Xcode 27 SDK with deployment target 26.0 in CI (Release); nothing is built locally.
- Deprecated shims keep DesktopProductMode, JunoMobilePhoneShell, CodeV2WindowPreview and the JunoShimmerText call sites compiling.

### P4-web-shell: Web shell, sidebar Now, palette, notifications, pages and errors

Order 2. Platforms: web.

**Scope.** (1) Root layout: viewport viewportFit cover and interactiveWidget resizes-content, and the fonts are unchanged. The ui-prefs and font-size boot scripts are still injected.

(2) Sidebar order: brand 44; product switch 32; New chat, Search and Library rows (32 tall at the 46 edge, keycap on hover); Now; Orbit (heading glyph dropped); Pinned projects; Pinned; Recent; account.
- getAppBootstrap adds now (needsYou, running, and ready ≤ 24h unseen), starredProjects and agentRoster, within +8KB gzipped.
- Remove the mounted gate. Collapse state moves to the cookie alevr_sidebar_sections, read in (app)/layout.tsx.
- One roving-tabindex list: ↑↓, Home/End, Shift+F10. The kebab glyph is 16 with tabIndex −1 except on the focused row. Save is coarse:size-11. Rows are 32/44.

(3) Rows:
- Running rows: StatusMark galaxy (a static still unless hovered or selected), medium weight, sr-only Running. Needs-you rows: a 10 hand. Recent rows carry the same marks.
- Optimistic rename, pin and add-to-project roll back with a specific toast and Retry.
- Finished-away wash: presence-wash fading to 0 over 560 once, on next view.
- Empty sidebar: “No chats yet. Start one with {Kbd}.” under Recent, with no aria-live.

(4) use-now groups Now items from the existing needs-you and run signals.
- The Now fold reads “Now · {n}”, with its heading in label 12.
- At most 5 rows, then +{n} more (expands inline until G70).
- Insert with grid-rows over 220; leave over 160 then the layout spring.
- Hold rule via use-insert-hold, with a “{n} updates” pill. Needs-you signals immediately and its row inserts within 2s.
- Polite announcements at most once per 5s.

(5) in-flight-strip.tsx (NEW, mounted on home by P5): a label-12 heading “In flight” and up to 3 rows of 40px (mark, title, ApprovalActions verb for needs-you rows or Open otherwise). It renders null when Now is empty.

(6) Shell and phone bar:
- Widths 224/260/352 with keyboard resize (aria-valuenow, aria-valuemax).
- The fold takes 220 in-out with main contain:layout and dispatches alevr:layout-settled once.
- 640–1023: an L3 overlay with a fading scrim.
- Below 640:
  - a 48 + safe-area phone bar
  - a menu button with the hand badge
  - New chat becomes New session → /code in Code; search aria-label “Search everything”
  - the P2 drawer
- AnimatedTitle gains announce (default false); only the phone bar sets it here.

(7) Product switch:
- Tooltip and chord from shortcut-groups: ⇧⌘1/⇧⌘2 on web for macOS, Ctrl+Shift+1/2 on Windows and Linux.
- Free plan: lock glyph and tooltip “Code is on Pro”. Selecting it or using the chord opens the dialog “Code is part of Pro” with See plans and Not now.

(8) Palette, one PaletteShell with a mode:
- ⌘K or Ctrl+K opens commands; ⇧⌘F or Ctrl+Shift+F opens search. Tab and Search everything switch mode in place and keep the query.
- At rest: 3 actions, 5 chats, 3 Code sessions, Projects. Go to appears on match.
- “Ask Alevr: “q”” is the first row and starts a chat prefilled. Matching is at word starts. IME guard via composer-keys.
- Rows paint in frame 1. The shell enters over 160 out-expo with motion-safe:[--motion-scale-from:0.97] and exits over 120.
- Async results stagger 30ms, max 4. The highlight uses spring.snap. A 2px hairline appears after 300ms.
- The filter strip is always present. Empty results show “No matches for “q”” under Ask Alevr. Failures show Try again. Pluralisation is fixed. New code session carries a Pro chip on Free.
- Idle preload: requestIdleCallback with a 2s timeout after hydration imports the palette module.
- Below 640: a full-height top sheet with a 160 opacity entrance.
- Marks palette-open and palette-painted.

(9) Notifications (the bell stays until G70): width min(24rem, 100vw − 1rem), a bottom sheet below 640, body in ui 13, groups Needs you then Earlier, ↑↓ roving, weight changes cross-fading over 120, appended rows over 220.

(10) Pages and errors:
- In-app 404 inside the shell: “This page isn't here” with Back to chat and Search everything.
- (app)/error picks Back to Code or Back to chat by product, showing only the digest.
- global-error links to /chat.
- app-page-header renders the page-title rung.
- A session-expired dialog listens for a 401 event: “Your session expired. Sign in again to continue.” with Sign in returning to the same URL.
- Sign-out lands on /sign-in with the toast Signed out.
- Remove backdrop-filter from the 3 app files.

(11) eslint-rules/enforce/p4.json lists this package's files once cleaned, and e2e/wave2/p4-shell/gates.ts enforces palette, CLS and route gates.

**Owns.** `src/components/app/ (every file except page-transition.tsx, code-work-list.tsx, editorial.css, editorial.tsx, onboarding.tsx, onboarding-lazy.tsx)`, `src/components/notifications/`, `src/hooks/use-global-shortcuts.ts`, `src/hooks/use-now.ts`, `src/lib/shortcut-groups.ts`, `src/lib/app-data (bootstrap module)`, `src/app/layout.tsx`, `src/app/(app)/layout.tsx`, `src/app/(app)/not-found.tsx`, `src/app/(app)/error.tsx`, `src/app/(app)/loading.tsx`, `src/app/global-error.tsx`, `src/app/not-found.tsx`, `e2e/keyboard-focus.spec.ts`, `e2e/notifications.spec.ts`, `e2e/wave2/p4-shell/`, `eslint-rules/enforce/p4.json`, `tests/wave2-p4-*.test.ts`

**Acceptance.** Playwright (production build via P0, disposable _test DB):
- With JavaScript disabled, the first paint contains the Recent rows; sidebar CLS is 0.
- Now renders as specified with 0, 2 and 7 items.
- With the pointer over Recent, inserting a Running item leaves the Recent row rects unchanged and shows “1 update”; the item applies 300ms after leave.
- Inserting a needs-you item updates the Now count and badge at once and its row within 2s while still hovering.
- Keyboard: ↑↓, Home/End and Shift+F10 work; Tab skips the kebabs.
- Palette: a warm open paints within 20ms; a cold open shows the shell in the first frame and rows ≤ 150ms; Ask Alevr is first for any query; ⇧⌘F keeps the query; IME Enter is ignored; the hairline appears only after 300ms; empty results show the message.
- The Free-plan fixture opens the Pro dialog from the switch, the chord and the palette.
- New session on the Code phone bar goes to /code. The in-app 404 renders inside the shell. The session-expired dialog appears on a mocked 401.
- Windows emulation renders Kbd as Ctrl+Shift+F.
- axe: 0 serious on the shell.

Screenshots: sidebar, palette, notifications and the 404 at 1440×900, 900 (tablet) and 390×844, light, dark and high contrast, with reduced motion on and off.

CI logs the bootstrap payload delta at ≤ 8KB gzipped.

### P5-web-chat: Web chat: send path, TurnStatus, streaming, transcript, composer, home, incognito, voice and share

Order 2. Platforms: web.

**Scope.** Owns all of chat-view.tsx, so the handoff, home, placeholders and incognito header live in one package.

(1) Send: the user bubble uses P2 UserBubble with rise-user (6px × shift over 120, no blur) and is painted within 100ms, with marks alevr:enter and bubble-painted. The assistant root does not animate; parts use settle-part.

(2) turn-status.tsx (NEW; live-line.tsx re-exports it): one node per turn, never unmounted.
- Working, Answering and Settled behave exactly as C1, with timings from TIMING and mark status-visible.
- Every C1 table state: reconnecting, failed, stopped, needs approval (with the approval card rendered below via P2 ApprovalActions, using the D20 policy), tools without reasoning (“Worked for”), no reasoning and no tools (collapsed), Auto fallback note, and capacity wait.
- Inline reasoning (thought-process-panel) opens with grid-rows over 220 in-out and auto-closes once after 1000; on phones it is a glance sheet.
- The action row appears after 180; a check is drawn only when watched > 10s.
- One “Answer ready” announcement on settle; no live region while streaming.

(3) Streaming (stream-text):
- rate clamp(pending/250ms, 20, 800) graphemes/s via Intl.Segmenter, with a 50ms hidden-tab timer
- the tail drains at up to 4× within 250ms
- .stream-lite only on coarse pointers when the long-task gate flags it

(4) Transcript:
- Header: h-12 (48px) at all times, opaque, with a bottom hairline fading in over 120 when scrollTop > 0; AnimatedTitle announce at md and up.
- Bottom fade: replace SCROLL_FADE_STYLE mask-image with a static 32px gradient overlay above the composer (opacity 0 at the bottom, 1 otherwise, over 120). Content padding-bottom 48.
- Follow: instant while streaming, in a 70px near-bottom zone, breaking on scroll-up, wheel or selection, never on shrink.
- Jump to latest · {n} new: in 220, out 160. A click uses an in-house velocity spring (damping 0.7, stiffness 0.05, mass 1.25). Listens for alevr:layout-settled and re-measures once.
- Follow-ups render inside the transcript, reusing the wave-1 starter chip, and exit over 160 on send.
- chat-drop-overlay.tsx (NEW): a full-column recess with a 1px foreground/0.24 edge and “Drop files to attach”, 120 in and 70 out, with window-level preventDefault for files. In incognito it explains why files can't be added.
- Action row order and sizes as in spec section 6.2, revealed on hover and :focus-within, newest only on touch.
- User-turn actions Copy, Edit and Branch (Fork privately dropped). BubbleEditor and the clamp fade use the bubble fill and stop; controls on the bubble use bubble-hover.
- Bubbles longer than 12 lines clamp with Show more.
- Receipt (auto-receipt, context-receipt): “{route} · {model}”, plus effort when not the default, plus tokens and cost per the showUsage pref and billing currency via Intl.NumberFormat. Full muted ink, always shown on the newest answer and on coarse pointers. The popover shows the Selected for reasons and any fallback.
- Sources open the Activity Sources tab or a glance sheet; the inline list only for ≤ 5 sources. [n] chips are 18px at radius 6, with a popover on touch.
- Thumbs-down: reason popover on spring.standard over 220, never the reward spring.
- Finish and failure copy per C1, plus “{model} isn't available right now.” with Use Auto.
- Artifact card: active state (selected fill, 1px edge, aria-current), the sweep deleted, a determinate bar only when bytes are known, the title at tabIndex −1, Open plus Full screen.
- code-block (aicss): Wrap whenever lines overflow.
- transcript-rail: 24×24 targets, a Turns menu under 24px spacing, ⌥⌘↑/↓ or Alt+Shift+↑/↓.
- Selection bar: Ask, Quote, Explain (36 tall, 8 above, 120 in and 70 out). Quote FLIPs a QuoteCard to the above-slot over 360 out-expo; on send, QuoteCards and AttachmentChips FLIP into the bubble over 360; reduced motion uses a 120 cross-fade.
- Generated media lightbox as in spec section 6.17, using .media-scrim.
- chat/[id]/loading uses transcript-column and a 48 header.

(5) Composer (composer-shell, composer.tsx, composer.css):
- Radius 22, inset 10, rest height 96, growing to 12 lines.
- Controls: + · model chip (max 12rem) · effort dial · mic · disc (36 at radius 12, faces morph over 120).
- Pointer focus edge foreground/0.24; keyboard focus uses the global ring.
- use-composer-height publishes --composer-h; --kb-inset padding on phones; landscape cap at 40vh.
- Above-slot order: quota strip, queued, steering, approval (stacked when the draft is non-empty), quote, attachments.
- Queued strip with Edit, Remove and Send now, plus “One message is already waiting”.
- Uploads: aria-disabled send with tooltip, “Uploading {n} files · {p}%”, AttachmentChip progress and failed Retry.
- Quota strip with clock glyph, attention ink and Upgrade.
- Height changes over 220 in-out.
- Delete the --cmp-* declarations and --alv-ease. Keep the touchReturn behaviour.
- The draft persists to sessionStorage on a session-expired event.

(6) Model picker:
- Effort panel header row, 2 recent models, type-to-search.
- The catalogue search field gets surface-inset and focus-within:border-ring.
- Below 640, a P2 glance sheet with search, lab chips, and rows with capability glyphs and $–$$$ (order Auto, recent, labs).
- Checkmarks in both the + menu and the / palette.
- Effort slider uses the global ring and one knob token.
- Remove the /80 opacity labels.

(7) Home:
- Greeting from the strings table at home-title. The first-visit clip-wipe is inset(0 12% 0 0) → inset(0) plus translateX 8px × shift, over 560 after 60; the composer and starters fade over 360 from 120; later visits are a 160 fade.
- Home and dock composers both use .transcript-column in the same gutter container, so the handoff is translateY only: greeting out over 160, composer 360 out-expo, transcript in over 220 from 120.
- Starters: 36 tall (44 coarse), fade out over 120 on typing.
- Mount InFlightStrip.
- empty-state passes lamp={false} to the field (neutral ink, draw-on only on first visit, 40% once chips render).
- Placeholders: Ask Alevr and Ask a follow-up.

(8) Incognito:
- “Incognito chat” in display over a 48 hairline disc, with today's promise from the strings table (training clause only after S8).
- Only the tone cross-fades, over 220.
- In-app navigation away from a non-empty incognito chat asks “End this incognito chat?” with End chat, Keep chatting and Don't ask again; no beforeunload.

(9) Voice (src/components/voice): the section 6.14 states, copy and announcements. The glow runs only while the audio level is > 0 and pauses when hidden; Tier C shows still bars.

(10) decision.tsx and team-activity.tsx move needs-you to StatusMark and role tokens. Remove backdrop-filter from the 7 chat files and chat/sketch, keeping only .media-scrim.

(11) Share page: UserBubble and prose, header “Shared chat” with Continue in Alevr, no receipts. Export in More: Copy as Markdown, Download Markdown, and Print / Save as PDF with a print stylesheet.

(12) Enforce files and gates: eslint-rules/enforce/p5.json, and e2e/wave2/p5-chat/gates.ts enforcing the send, status, INP, long-task and tail gates.

**Owns.** `src/components/chat/`, `src/components/ui/composer-shell.tsx`, `src/components/aicss/`, `src/components/voice/`, `src/components/share/`, `src/app/(app)/chat/`, `src/app/share/`, `e2e/chat.spec.ts`, `e2e/regenerate.spec.ts`, `e2e/transcript-history.spec.ts`, `e2e/transcript-route.spec.ts`, `e2e/transcript-window.spec.ts`, `e2e/wave2/p5-chat/`, `eslint-rules/enforce/p5.json`, `tests/wave2-p5-*.test.ts`

**Acceptance.** Playwright traces (production build via P0, disposable _test DB, mocked streams):
- Enter → bubble-painted ≤ 100ms p95 over 20 runs.
- Enter → status-visible ≤ 300ms p95 with the first token at 800ms; never visible with the first token at 120ms.
- TurnStatus element identity is the same from send to settle in every C1 state; fixtures cover reconnect, fail, stop, approval, tools-only, fallback and 429.
- Tail drain ≤ 250ms. No long task > 50ms over 2,000 tokens at 4× throttle. INP < 200ms on the 1,000-message fixture.

Approvals:
- An approval arriving while typing in the composer keeps focus and the draft, and announces.
- ⌘↩ in the composer sends the message, never approves.

Layout and style:
- The newest action row has computed opacity 1 at the bottom; the fade overlay has opacity 0 at the bottom; no mask-image on the scroller; the Jump pill shows the right n.
- The header is 48 before and after the title arrives (CLS 0). The receipt is visible under coarse emulation at 1024px.
- Follow-ups do not change the scroller height. Older-turn actions are reachable by Tab.
- The home composer width equals the docked width ±1px at 760, 1024 and 1440 for narrow, medium and wide, and never exceeds the viewport at 390. The handoff animates only translateY.
- A first visit shows the clip-wipe; a second New chat shows only a ≤ 160ms fade.
- The disabled-send tooltip is reachable by hover and focus. Queued Edit, Remove and Send now work. A failed tile Retry re-uploads. The quota strip disables send.
- showUsage off shows route and model only; tokensAndCost shows the currency from a fixture billing currency.
- The incognito confirmation appears on sidebar navigation and not after Don't ask again.
- The voice permission-denied panel renders.
- The share page has no receipt.
- axe: 0 serious.

Screenshots: home (first and later visit), working, answering with reasoning, settled with receipt, all failure states, composer states, incognito, lightbox and voice states, at 1440×900 and 390×844, light, dark and high contrast, with reduced motion on and off.

### P8-macos-app: macOS app: shell, sidebar Now, toolbar switch, conversation, Quick Entry, menus and sign-in card

Order 2. Platforms: macOS.

**Scope.** Two milestones from one worktree, landing as separate PRs: A (shell and conversation), then B (reach).

A1 Shell:
- JunoProductSwitch in the toolbar principal position, with state hoisted above .id(product), ToolbarSpacer(.fixed) groups, help text from JunoShortcutRegistry (⌘1/⌘2), and the lock state on Free. DesktopProductMode drops JunoProductOrbit.
- Switching products fades only the detail column (opacity over 120, no offset). @SceneStorage keeps each product's sidebar scroll.
- Sidebar:
  - Edge to edge on macOS 27 behind #available, the standard sidebar on 26, widths 224/260/352.
  - Accent-tinted glyphs, semibold selection, footers dimmed to 0.5 when not appearsActive.
  - Now at the top from DesktopSidebarSignals (one store for all windows), with the hold rule per window.
  - Running rows use a 10pt still JunoGalaxyMark (no more DesktopSidebarSpinner or mini ProgressView).
  - Fold headings become Buttons with a chevron over 120 and Expanded/Collapsed values, animated with JunoMotion.reduced(.standard).
  - Row overflow on hover or selection.
- Notifications popover height min(480, content). Dock badge shows needs-you only.
- Launch restores the last product and conversation; approvals wait in Now and the menu bar until the first user event.
- Below sidebar + 360 + 420, the inspector overlays the detail column as an L3 sheet at min(480, detail − 24), dismissible with Esc.

A2 Conversation:
- ChatTranscript:
  - instant follow while following (no new glide per height change)
  - Jump to latest · {n} new as a glass capsule with .materialize
  - the poll backs off 15s → 60s after 2 minutes idle and stops while NSWindow.occlusionState is not visible
  - a render window of 40 turns with paging
  - Mermaid and artifacts through JunoWebViewPool
- MessageRow: JunoUserBubble; thumbs-down with celebrates false plus the reason popover; hover articulation removed; JunoTurnStatus with the receipt at rest in mono 11 (showUsage read from the account settings).
- MessageActions: the shared order with Read aloud back in the row and Regenerate as a 28 pill.
- Selection capsule adoption from JunoMarkdownView. InlineArtifactCard: no shimmer, plus an active state.
- Composer (ChatComposer and the JunoComposerShell adoption):
  - focus edges, controls at 0.72 while generating, disc 36 at radius 12
  - placeholder Ask a follow-up when docked, otherwise Ask Alevr
  - quota strip and queued line in the shared wording
  - JunoEffortPanel with the model chip “Auto · {model}”
- DesktopEmptyChat: JunoGreeting (What's next, {first}? at Newsreader 30 with the clip-wipe on the first arrival per session), the starter chip row, the incognito header (48 disc plus today's promise) and the in-app leave confirmation with Don't ask again.
- Voice and dictation (DesktopVoice, DesktopDictation, ComposerDictation) adopt the JunoVoiceKit states and copy.
- Sign-in card in JunoDesktopRootView:
  - adds Forgot password? (/forgot-password), “New to Alevr? Create an account” (/sign-up?callbackUrl=alevr://) and “Signed up with Google or Apple? Continue in the browser.”
  - brand fields with radius 10, hairline and focus edge
  - restoring shows JunoMark 48 over a still galaxy, cross-fading over 220, with no ProgressView
  - ships in the auth train

B Reach:
- Quick Entry:
  - DesktopHotKey (NEW) uses Carbon RegisterEventHotKey, default ⌥Space, rebindable via UserDefaults alevr.quickEntry.shortcut, and consumes the key (no NBSP).
  - On eventHotKeyExistsErr it shows the conflict state (“⌥Space is used by another app” plus an inline DesktopHotKeyRecorder view, which P11's Settings pane embeds). The menu bar item then reads “Ask Alevr…” with the subtitle Choose a shortcut.
  - Double-tap ⌥ is opt-in (Input Monitoring).
  - Panel: 640pt on the screen under the pointer, top at 22%, radius 22, glass .regular, field 56. Opens over 120 out-soft from alpha 0 and scale 0.98; exits over 70 ease-in; fade only under Reduce Motion.
  - resignKey and Esc hide it and keep the draft. ↩ sends in the panel and ⌘↩ continues in the main window. The answer streams in the panel, which grows on the layout spring to at most 520.
  - 5 recent chats; JunoProductSwitch instead of JunoSegmented.
  - Autofill: an opt-in setting, Attach what's in front, asks for Automation permission and attaches the frontmost Safari URL or Finder selection as a JunoAttachmentChip [S6].
- Menu bar extra: first item “Ask Alevr…  {shortcut}”; groups Needs you, Running, Ready and Blocked, max 5 each, with JunoStatus glyphs (Blocked last); labelStyle(.titleAndIcon) on key actions only.
- Full menu bar (DesktopCommands, DesktopCommandCatalog) in Title Case. On 27, icons only on New Chat, New Code Session, Ask Alevr and Search, behind #available. Automations → Routines.
- Notifications: one UNNotificationCategory per approval kind, with the real verb as the action title, Not now and Open, routed through the existing approval call, for Chat, Work and Code alike.
- DesktopIntents (NEW): Conversation @AppEntity conforming to IndexedEntity, plus Ask Alevr, New chat and Open Code session.

eslint-rules/enforce/p8.json lists the cleaned Swift globs for the native design checks.

**Owns.** `native/macOS/JunoDesktop/App/ (every file not claimed by P1 Generated/, P3 DesktopTrackpadHaptics.swift and JunoShortcutRegistry.swift, P10 Desktop{Code,Automation,Work,Agent,Library,Research}*.swift, ChatWork*.swift, Research*.swift and JunoCodeIntents.swift, or P11 DesktopSettings*.swift, DesktopOnboardingSheet.swift, DesktopAccountScreens.swift and DesktopTextSize.swift)`, `native/macOS/JunoDesktop/Resources/`, `native/macOS/JunoDesktop/Tests/ and UITests/ (tests whose subject this package owns; excludes P0 support dirs and P10 and P11 subjects)`, `eslint-rules/enforce/p8.json`

**Acceptance.** Snapshots (P0 support), in light, dark, .xxl and Increase Contrast:
- sidebar with Now and running rows
- toolbar switch, including the locked state
- transcript with every TurnStatus state, bubble and receipt
- composer states, empty chat, incognito header and sign-in card
- menu bar extra and Quick Entry, including the conflict state
- nothing clipped at .xxl

XCTest and UI tests:
- The sidebar scroll offset is retained across ⌘1/⌘2, and the sidebar view is not recreated.
- The poll interval reaches 60s after 2 minutes idle (injected clock), with 0 requests while occluded.
- WebView pool ≤ 3.
- Quick Entry: hotkey to key window ≤ 120ms (signpost); no NBSP with TextEdit frontmost; resignKey hides and keeps the draft; screen selection follows the mouse (mocked screens); Reduce Motion fades without scaling; a simulated eventHotKeyExistsErr shows the conflict state.
- The notification category is registered with the verb title.
- A grep test finds no visible Automations string or JunoShimmerText in owned files.

Performance (Release in CI): idle RSS ≤ 220MB 60s after opening a seeded 200-message conversation; Quick Entry ≤ +30MB. This package's gates enforce them.

No local simulator or app run is left alive.

### P9-ios-app: iOS app: drawer, shell, transcript window, composer, incognito, voice, widgets and Live Activities

Order 2. Platforms: iOS.

**Scope.** (1) Drawer (JunoMobileDrawer and JunoMobileRootView):
- JunoMotion.settle with the fling velocity; a 16pt edge strip that yields to system back on pushed screens.
- While open, content is accessibilityHidden, .accessibilityAction(.escape) closes it, and AccessibilityFocusState moves to the drawer header and back to the sidebar button.
- Now is pinned at the top, with “Needs you · {n}” first.
- Dim 0.12/0.30. .selection fires from onEnded only.

(2) Shell (JunoMobilePhoneShell):
- JunoProductSwitch replaces JunoProductOrbit; the Code end shows the hand badge plus accessibilityValue “1 needs you”, mirrored on the sidebar button, with the lock state on Free.
- Chat ↔ Code cross-fades over 120.
- Amber and accent needs-you marks become role colours plus the hand.
- Title button hint “Conversation actions”; .accessibilityShowsLargeContentViewer() on bars.

(3) Transcript (JunoMobileConversationsView), keeping the eager VStack (D14):
- A 40-turn render window with Show earlier paging 40 at a time, keeping the ScrollPosition anchor.
- JunoMobileMessageRow becomes Equatable on (id, contentHash, isPending, feedback, branchPosition, isLast) with .equatable(), one environment actions object and memoised parts; Mermaid mounts on appear.
- JunoTurnStatus replaces JunoMobilePendingLine, with the receipt footer in .caption1 mono.
- Follow is not animated. Arrival is opacity plus a 6pt rise over 220.
- An “Answer ready” announcement and a Messages rotor; ViewThatFits two-line action row at accessibility sizes.
- The settled haptic only when watched and > 3s.
- The long-press menu (JunoMobileMessageMenu) holds the user-turn actions.

(4) Composer:
- Radius 22 (remove the five literal 24s), GlassEffectContainer(spacing: 8), the disc morphing via glassEffectID on sendMorph .22/.10.
- Model chip “Auto · {model}” opens a glance sheet at .medium via .navigationTransition(.zoom) with .matchedTransitionSource. The dial gets an accessibility action Choose model, and the + and Thinking panels get .accessibilityAction(.escape).
- Quota strip, queued line and upload states in the shared wording; send and stop haptics.
- Starter chips at 44pt above the composer on an empty home.

(5) Greeting: JunoGreeting in Newsreader 34 (What's next, {first}?), replacing the time-of-day two-beat blur and scale. Delete the dead aura code.

(6) Incognito (JunoMobileIncognito): reuses JunoMobileMessageRow(isPrivate:) and JunoMobileComposer, with today's promise and the in-app leave confirmation with Don't ask again.

(7) Voice and camera (JunoMobileVoice*, JunoMobileCamera*): the JunoVoiceKit states and copy, voice haptics, and a 44 stop. Raw feedback generators, CameraPanel included, route through JunoMobileHaptic.

(8) Sign-in in JunoMobileRootView and the web auth client: copy from the strings table (“Welcome back”, “Sign in to continue to Alevr.”). Ships in the auth train.

(9) Widgets: Small New chat; Medium with 4 actions plus the last conversation from an App Group snapshot (add the App Group to the entitlements); Lock Screen accessoryCircular New chat and accessoryRectangular “Needs you · {n}” with the hand; ControlWidgetButton for New chat and Voice; ContainerRelativeShape tiles with .widgetAccentable(); copy “Start an Alevr chat”.

(10) Live Activities:
- The voice activity ships now: Text(timerInterval:) plus 5 level bars.
- Run and approval activities are built behind a flag that is off until G01:
  - Lock Screen 84–160pt with 14 margins
  - compact leading: a still galaxy or a hand; compact trailing: a timer
  - Button(intent:) LiveActivityIntent, with Allow requiring authentication
  - staleDate 15 min, then a 60% dim with “Stale · open to refresh”; dismissal 20 min after the end
  - isDynamicIslandLimitedInWidth and .supplementalActivityFamilies([.small])

(11) App Intents (JunoMobileIntents): the Conversation entity and Ask Alevr.

(12) eslint-rules/enforce/p9.json, plus this package's gates for the iOS memory and hitch budgets.

**Owns.** `native/iOS/JunoMobile/App/ (every file not claimed by P3 JunoMobileFeedback.swift, P10 JunoMobile{Code,Link,Work,Library,Research,Project,Design}*.swift, JunoMobileTasksView.swift, JunoMobileRoutinesView.swift and JunoMobileMemoryView.swift, or P11 JunoMobileSettings*.swift and JunoMobileOnboarding.swift)`, `native/iOS/JunoMobile/Widgets/`, `native/iOS/JunoMobile/Resources/ (every file except Shell.xcstrings)`, `native/iOS/JunoMobile/Tests/ and UITests/ (tests whose subject this package owns; excludes P0 support dirs and P10 and P11 subjects)`, `eslint-rules/enforce/p9.json`

**Acceptance.** Unit tests:
- The Equatable row body is not re-evaluated when an unrelated message streams.
- Paging keeps the anchor id.
- The run Live Activity flag is off without the push capability.
- The Allow intent requires authentication.
- App Group snapshot read/write round-trips.
- A grep test finds no raw feedback generators in owned files, CameraPanel included.

UI tests:
- A high-velocity drawer fling settles in ≤ 0.30s, and VoiceOver focus lands on the drawer header.
- The incognito leave confirmation appears, and does not after Don't ask again.

Snapshots (P0 support), in light, dark and AX3:
- drawer with Now and hand badge, switch locked and badged
- transcript with TurnStatus states and a two-line action row at AX3
- composer states and greeting
- widget families in full colour, accented and vibrant
- voice and stale Live Activity previews

Performance (Release in CI): a 1,000-message thread at ≤ 300MB on open; paging 40 earlier ≤ 250ms; hitch ratio ≤ 5ms/s over a 10s fling.

No simulator is left booted by any local script.

### P10-native-work: Native Code and Work surfaces: JunoCodeUI, Mac Studio, Work, Library, Research and iOS Code and Work views

Order 3. Platforms: macOS, iOS.

**Scope.** (1) Code approvals (CodeV2ComposerParts and the related views):
- JunoApprovalActions with verbs Not now / Run / Tell Alevr instead / Amend.
- .keyboardShortcut(.defaultAction) is removed from Allow. ⌘↩ is attached only after the 500ms arm and only while the approval is focused.
- The policy is announce when focus is in the terminal or a non-empty composer.
- Title in junoSignalInk with a 2px signal edge; command up to 8 lines plus Show all.
- Composer height animates on JunoMotion.base when the approval stacks or replaces (replacing only an empty draft).

(2) Studio and CodeV2:
- StudioThreadView shimmer → plain Text plus a 12pt galaxy.
- Studio.Font maps to JunoType × junoTextScale.
- Studio.Surface.bubble uses JunoUserBubble at 85% of 768.
- Follow only when pinned (no animate-to-end mid-read), with the Jump to latest pill.
- Composer radius 22 via JunoComposerMetrics.
- Toolbar .help from JunoShortcutRegistry, deleting the hard-coded (⌘N) and (⌥⌘C).
- The full-screen bootstrap spinner becomes a skeleton or a still galaxy.
- CodeV2WindowPreview uses JunoProductSwitch.
- Diff views keep their native markers and labels, adopting the role colours.

(3) Mac Work (DesktopWork*, ChatWork*): needs-you uses junoSignal plus the hand; DesktopWorkVocabulary .working uses JunoRunSignature (no shimmer); JunoPlanStepGlyph; the finished actions; the approval card adopts JunoApprovalActions.

(4) Mac Routines (DesktopAutomation*): every visible string Automations → Routines; Run now uses the bolt glyph; paused rows show the word Paused, undimmed.

(5) Mac Library and Research (DesktopLibrary*, DesktopResearch*, Research*): shimmer removed, Deep research label, JunoEmptyState, galaxy in the scope card.

(6) Agents (JunoWorkKit, DesktopAgent*): JunoEmptyState, JunoStatus, NativeAgentsHome composer radius via JunoComposerMetrics, measure from JunoReadingMeasure (unchanged values).

(7) iOS Code (JunoMobileCode*, JunoMobileLink*):
- The 9 shimmer sites become a 14pt galaxy plus words; mini spinners are removed except inside buttons.
- Approval card: Allow uses the ink disc; heading junoSignalInk; up to 8 lines plus Show all; Deny haptic via JunoMobileHaptic; a busy spinner in the tapped capsule.
- The deep-link approval requires LocalAuthentication.
- Verbs Not now / Run / Tell Alevr instead; plan approval Keep planning / Approve and build.
- Disclosures ≥ 44pt. Free plan: the Code is part of Pro empty state.

(8) iOS Work, Tasks, Routines, Library, Research, Memory, Project and Design views:
- JunoEmptyState (replacing ContentUnavailableView except in search results)
- JunoStatus, PlanStepGlyph and role colours for needs-you
- Routines naming
- JunoSkeleton for loading
- type via JunoType with Dynamic Type
- raw feedback generators routed through JunoMobileHaptic

(9) JunoDesignKit: no visual change beyond token adoption and the shimmer removal.

(10) eslint-rules/enforce/p10.json lists the cleaned globs.

**Owns.** `native/Packages/JunoCode/Sources/JunoCodeUI/`, `native/Packages/JunoCode/Tests/JunoCodeUITests/`, `native/Packages/JunoNativeKit/Sources/JunoWorkKit/`, `native/Packages/JunoNativeKit/Sources/JunoDesignKit/`, `native/macOS/JunoDesktop/App/Desktop{Code,Automation,Work,Agent,Library,Research}*.swift`, `native/macOS/JunoDesktop/App/ChatWork*.swift`, `native/macOS/JunoDesktop/App/Research*.swift`, `native/macOS/JunoDesktop/App/JunoCodeIntents.swift`, `native/iOS/JunoMobile/App/JunoMobile{Code,Link,Work,Library,Research,Project,Design}*.swift`, `native/iOS/JunoMobile/App/JunoMobileTasksView.swift`, `native/iOS/JunoMobile/App/JunoMobileRoutinesView.swift`, `native/iOS/JunoMobile/App/JunoMobileMemoryView.swift`, `native/macOS/JunoDesktop/Tests/Snapshots/CodeV2SnapshotTests.swift`, `native Mac and iOS tests whose subject is one of the files above`, `eslint-rules/enforce/p10.json`

**Acceptance.** Unit tests:
- The Allow shortcut is absent during the arm and present after it, and only while focused.
- With a non-empty draft, the approval stacks and does not replace the draft.
- The deep-link approval calls LAContext before approving.
- A grep test finds no JunoShimmerText, no visible Automations string and no raw feedback generators in owned files.

Snapshots (P0 support):
- CodeV2SnapshotTests updated for light, dark and .xxl.
- Mac Work, Routines, Library and Research in light, dark and .xxl.
- iOS Code approval card, Work, Tasks, Library and Memory in light, dark and AX3.
- Galaxy legibility confirmed at 12 and 14 before the shimmer sites change.

Build: everything builds in CI (Release) on the Xcode 27 SDK; no local simulators are left booted.

### P6-web-code: Web Code workspace (cv2), approvals, diff, dock and plan states

Order 3. Platforms: web.

**Scope.** (1) Global tokens and motion:
- Delete --dur-mid and --dur-wide from code-v2.css. 80ms → --dur-fast; the 250ms fold → --dur-base on in-out.
- .cv2 :focus-visible becomes 2px solid hsl(var(--ring)) at offset 2, with no border-radius.
- Delete the 1ms reduced-motion clamps. Every moving keyframe multiplies its travel by var(--motion-shift). Delete the shine.
- Coarse targets: .cv2-iconbtn, .cv2-ctl and .cv2-btn at least 40×40; .cv2-send 40; 20px buttons padded to 32/44 with ::after.
- Safe areas: .cv2-cwrap padding-bottom max(12px, env(safe-area-inset-bottom)) at ≤ 760; the narrow dock gets padding-top env(safe-area-inset-top) and padding-right env(safe-area-inset-right). Toasts stay on Sonner.
- User bubble from P2 UserBubble. PlanStepGlyph and StatusMark. The working mark is a 12px galaxy plus the live verb.

(2) Approvals use P2 ApprovalActions:
- The policy is announce when focus is in xterm, a dock input or a non-empty or recently typed composer, otherwise take.
- The takeover replaces the textarea only when the draft is empty; otherwise it stacks above.
- Title in signal-ink, 2px signal edge, mono command up to 8 lines plus Show all.
- Actions: Not now · Run ▾ (caret: Allow for this session) · Tell Alevr instead · Amend, with a ⌘↩ hint.
- Composer height animates over 220 in-out.

(3) TurnRail: a sibling of .cv2-scroll in .cv2-thread-col, sticky top 24, 24×24 pads, a Turns menu under 24px spacing, ⌥⌘↑/↓ or Alt+Shift+↑/↓.

(4) Diff:
- per-hunk overflow-x:auto, with code at width:max-content and sticky gutters
- a 14px +/− column in success-ink or destructive-ink
- sr-only added line {n} / removed line {n}
- full --muted-foreground gutters
- Wrap by default under 560

(5) Dock:
- Mount-once tabs with hidden and inert, no key={tab}. Only the incoming pane fades, over 120.
- Eviction (D29): at most 3 live panes. A pane hidden for 10 minutes or beyond the cap is evicted. xterm scrollback is serialised on evict and restored on remount. An evicted preview shows “Preview paused · Reload”.
- Right-shell pattern: enter 24px × shift over 220 on the drawer curve, exit 160 with allow-discrete and @starting-style.
- Clamp min 420, max min(760, main − 420), shared by display and storage, with aria-valuenow and aria-valuemax always set.
- Snaps at 50% and 640 within 16px, settling on out-soft 220 with no overshoot. Rubber band beyond the limits. The iframe and xterm keep size and re-fit once at transitionend.
- Below 760: a full-screen sheet with safe areas.

(6) Thread:
- React.memo TurnView; now reaches only live turns via a LiveClock leaf.
- One IntersectionObserver on [data-turn]. noteAnchor throttled to one rAF, only while history.hasOlder.
- Follow only while pinned, instant, with the Jump to latest · {n} new pill.
- Work-log rows animate only when they arrive live.
- Steps stay mounted and inert, so the fold closes over 160 ease-in.
- Touch: under (hover:none) or (pointer:coarse), .cv2-you-meta and .cv2-wl .chev are visible, and tapping a bubble toggles data-on.

(7) Navigation and overlays:
- Below 1024, the sidebar glyph opens CodeWorkList in a P2 left drawer; the palette stays on ⌘K.
- Connections, Keyboard and the cv2 palette are rebuilt on the shared Dialog and Sheet: focus trap, aria-controls plus aria-activedescendant, scrollIntoView({block: nearest}), scrim hsl(var(--scrim)/0.4).
- The segmented thumb uses spring.standard.
- One Esc hint swaps into the context strip over 120 and clears when the arm ends.
- /code/pulls uses router.push and 32px cv2 rows.
- The empty-session repository name is a picker button.
- Tooltips use Tooltip plus Kbd with platform modifiers in ⌃⌥⇧⌘ order; placeholder(mac) for the steer hint.

(8) Loading: the landing skeleton gains a 16×120 lockup with mb-3. A new (app)/code/[id]/loading.tsx and the dynamic-import loading state show a ThreadSkeleton (48 header plus a 96 composer).

(9) Free plan: the /code route shows the Code is part of Pro EmptyState with See plans instead of a dead workspace.

(10) eslint-rules/enforce/p6.json, and e2e/wave2/p6-code/gates.ts enforcing the dock-pane gate.

**Owns.** `src/components/code/`, `src/app/(app)/code/`, `src/components/app/code-work-list.tsx`, `e2e/wave2/p6-code/`, `eslint-rules/enforce/p6.json`, `tests/wave2-p6-*.test.ts`

**Acceptance.** Playwright (production build via P0, disposable _test DB):
- Approval with an empty composer: focus moves to the container; Enter and ⌘↩ inside 500ms do nothing; ⌘↩ after the arm runs; Esc does not deny.
- Approval while typing in the composer or focused in xterm: focus and draft stay, an assertive announcement and the Review approval button exist, and ⌥⌘A focuses the approval.
- Diff: a 300-character line scrolls horizontally with a sticky gutter; markers and sr-only text are present.
- Dock: switching between 3 tabs keeps the iframe contentWindow (no load event) and the xterm instance. A 4th pane evicts the least recent. After 10 minutes on an injected clock a hidden preview shows Preview paused, and xterm scrollback is restored after evict and remount.
- Reduced motion: the dock appears with an opacity transition and no transform.
- The turn rail stays visible after scrolling 5 viewports, with targets ≥ 24×24.
- WebKit at 390×844: the composer bottom is ≥ the safe-area inset and the dock tabs sit below the status bar.
- React Profiler shows settled TurnViews do not re-render on clock ticks. A trace shows no forced layout from onScroll.
- The Free-plan /code renders the Pro empty state.
- axe: 0 serious.

Screenshots: cv2 home, a thread, an approval (armed and disarmed), a diff and an evicted preview, at 1440×900 and 390×844, light, dark and high contrast, with reduced motion on and off.

### P7-web-pages: Work, agents, routines, library, canvas, research and every other web route

Order 3. Platforms: web.

**Scope.** (1) Work:
- The approval cards (work/approvals and any chat-embedded Work card in these dirs) adopt P2 ApprovalActions and keep the arm, adding the 2px signal edge and Tell Alevr instead. action-verbs re-exports approvals/verbs.
- Needs-you moves from --attention to role tokens plus hand everywhere in Work, agents and research.
- PlanStepGlyph. Task card galaxy 20.
- The live→finished swap uses AnimatePresence popLayout with height on spring.standard.
- Finished actions: Retry · Run again · Continue · Make a routine.

(2) Routines:
- Titles Routines and New routine (route /automations kept).
- Run now uses a bolt glyph; Play and Pause for the schedule only.
- Row labels in ui sans.
- Paused rows drop opacity-75, show the word Paused and keep the name at full ink.
- Its task → Open task.

(3) Orbit: the editorial entrance only on the first page of the first visit; filters cross-fade the grid over 120. AgentPresence.transitionName stays wired, with no dependency on it.

(4) Library:
- Header: page-title, description, inline search. Below 640: a 1.75rem title, no stat row, sticky search and chips, so the first tile is at y ≤ 360 on 390×844.
- Tiles: 4:3 thumbnails at radius 12, title 14 medium, meta label 12, 4 columns at ≥ 1280.
- One entrance rule: .ed-arrive only on the first page of the first visit (use-first-visit), an 8px × shift rise over 560 out-expo with a 45ms stagger, max 4. Remove the per-li animate-rise-in and the inline delays.
- Filter, sort and search cross-fade the container over 120, keyed on the query, without remounting tiles. Later pages rise in over 220 with no per-tile delay.
- Empty filter: EmptyState “Nothing matches these filters” with Clear filters.

(5) Trash: TypeGlyph per item. Restore collapses the row (grid-rows 1fr→0fr over 160 ease-in) and toasts “Restored to Library · Open”. List skeleton; editorial row recipe.

(6) Canvas and artifacts:
- 48px header, title in Newsreader 1.25rem/1.25, “Saved · 2s” in label 12 with a 120 cross-fade.
- Full screen via the header button or F when the canvas is focused and not editing; Esc exits.
- Call sites use the canvas view transition (360/220) from P2.

(7) Research:
- Label Deep research with the subtitle Deep Field.
- Points at left 0 and top 0 with translate var(--x) var(--y), transitioning translate over 560 out-expo.
- .research-title in cqi. --rf-ease → var(--ease-out-expo). Raw 160 → exit, 300 and 320 → slow.
- The scope card uses the galaxy.
- A List toggle gives reachable source rows. Below 640 the map is a P2 glance sheet.
- Cost follows the showUsage pref.

(8) Every other route (projects, memory, knowledge, skills, assistants, crew, connections, customize, permissions, profile, upgrade, compare, design editor chrome, tasks, roadmap, admin, dev, legal):
- AppPageHeader page-title, EmptyState for empty and error, content-shaped skeletons, motion on the ladder
- caption and micro moved to label or ui
- text-*/NN removed
- backdrop-filter removed from product chrome in library (2), agents (2), projects, canvas and admin; src/lib/design, src/components/design and src/app/dev stay allowlisted as content

(9) Marketing landing (src/app/page.tsx, components/home, components/landing): the hero rung, reveals capped at 560, the stagger cap of 4 and reduced-motion tiers. dot-engine keeps its lamp prop, which chat passes as false.

(10) semantic.css: needs-you via the role token.

(11) eslint-rules/enforce/p7.json lists the cleaned globs, and e2e/wave2/p7-pages/gates.ts enforces the Library and Research gates.

**Owns.** `src/components/app/editorial.css`, `src/components/app/editorial.tsx`, `src/components/* directories not claimed by P2, P4, P5, P6 or P11 (work, agents, library, research, canvas, artifacts, home, landing, semantic, projects, memory, skills, assistants, connections, customize, permissions, profile, billing, compare, compare-public, design, documents, admin, roadmap, referral, public, download, engineering, legal, ambient, effects, signature, i18n)`, `src/app routes not claimed by P4, P5, P6 or P11 (src/app/page.tsx; (app)/work, agents, artifacts, assistants, automations, compare, connections, crew, customize, design, knowledge, library, memory, permissions, profile, projects, research, roadmap, skills, tasks, upgrade, admin, dev; (legal); (engineering); vs; download; offline; suspended; pair; r; sandbox; computer-view; aura-preview)`, `src/lib/design/ (every file except tokens.generated.ts)`, `e2e/agents.spec.ts`, `e2e/projects-and-artifacts.spec.ts`, `e2e/wave2/p7-pages/`, `eslint-rules/enforce/p7.json`, `tests/wave2-p7-*.test.ts`

**Acceptance.** Playwright (production build via P0, disposable _test DB):
- Library at 390×844: the first tile's top is ≤ 360.
- A filter change keeps the same tile element references and no animation exceeds 120ms.
- The first visit plays the entrance; a revisit in the same session does not; an empty filter shows Clear filters.
- Research: no Layout events attributable to point travel; the List toggle and rows are reachable by Tab with accessible names.
- Routines: a paused row's annotation contrast is ≥ 4.5:1 and the word Paused is present.
- The Work approval arm test passes. Computed colours show no element painting needs-you with --attention.
- Trash restore collapses the row and toasts.
- Canvas F toggles full screen only when not editing.
- Every long-tail route renders its page-title h1 and passes axe with 0 serious.
- Lint is at error for the globs in p7.json with 0 errors.

Screenshots: Library, Trash, Canvas, Research, Orbit, Routines, a Work task card, the landing and 4 long-tail routes, at 1440×900 and 390×844, light, dark and high contrast, with reduced motion on and off.

### P11-settings-auth-onboarding: Settings and interface preferences, server-gated onboarding and identifier-first web sign-in

Order 4. Platforms: web, macOS, iOS.

**Scope.** Sequenced last because it changes auth and settings flows. Every e2e run uses postgresql://postgres@127.0.0.1:55439/alevr_p11_test through the P0 runner, never production.

(1) Web settings:
- The h1 uses the page-title rung. The rail uses roving tabs, and search matches rows inside sections.
- A section switch is a 120 cross-fade, ≤ 300ms in total. Old section names and deep links keep resolving through redirects.
- Interface rows:
  - Motion: System, Reduced or Full, written to the ui-prefs motion field.
  - Chat font.
  - Transcript width: narrow, medium or wide (ids unchanged).
  - Text size: the six steps of font-size.ts, unchanged.
  - Increase contrast: data-contrast.
  - Models & routing › Show usage on answers: Off, Tokens or Tokens and cost, default Off, saved to the account so native follows.

(2) Mac Settings window:
- navigationTitle(section), the summary as the lede, an NSSearchField filtering rows, mono 11 group headings.
- Rows: Motion (alevr.motion), Chat font, Transcript width (640/768/992), Text size (DesktopTextSize ids and scales unchanged, px/16), Show usage, and the Quick Entry shortcut, embedding P8's DesktopHotKeyRecorder.
- minHeight audit of fixed frames, including the offline bar at minHeight 28.
- DesktopAccountScreens drops Automations.

(3) iOS settings: Appearance gains Motion, Chat font, Increase contrast and Haptics (alevr.haptics), plus Show usage. Page titles in Newsreader 28.

(4) Onboarding gating:
- The Prisma migration adds onboardingCompletedAt DateTime? to Settings, ordered after every existing migration.
- The backfill sets it to the migration time on every existing Settings row.
- onboarding-gate.ts treats accounts with no Settings row created before ONBOARDING_GATE_CUTOFF (the migration timestamp) as onboarded.
- The settings API reads and PATCHes the field.
- onboarding-lazy: when the server value is null and localStorage juno:onboarded:v1 exists, it PATCHes the server and skips. Any conversation history still counts. The localStorage key becomes a migration hint only.

(5) Onboarding page 1, on web, Mac and iOS:
- Title “Make Alevr yours” in display.
- Name, theme and accent: theme calls save({theme}) as well as setTheme; accent aria-labels use human labels; a failed name save keeps the card open with an inline Field error.
- Rows at a 60ms stagger (max 4) with a 6px rise over 220, first time only.
- Sentence-case buttons. After close, focus moves to the composer via an event.

(6) Onboarding page 2:
- Web: import from ChatGPT or Claude, plus the ⌘K tip.
- Mac, “Alevr on your Mac”: Quick Entry with Try it and the bound shortcut, or Choose a shortcut on conflict; Menu bar; “Tell me when work finishes” (requests authorization); Import. The sheet uses minWidth 480 inside a ScrollView, and the stale comment is removed.
- iOS: Notifications, Widgets and Control Center, and an optional Pair a Mac, replacing the three-page carousel.

(7) Web sign-in, identifier-first:
- Step 1: Google and Apple (44, radius 10), a divider, Email (44, radius 10) and Continue.
- Step 2 is identical for every email:
  - the email as text with Change, plus a visually hidden but present autocomplete=username input with the email
  - the Password field and Continue
  - Email me a link instead, and Forgot your password? (ui 13, 44 coarse)
  - “Signed up with Google or Apple? Use those buttons above.”
- MFA appears only after a correct password, keeping the credential inputs mounted. The server keeps one generic error, with no branch by account type.
- The step change is a 16px direction-aware slide plus a 220 cross-fade (a fade under reduced motion).
- Title “Welcome back”, with “New to Alevr? Create an account”.
- OAuthAccountNotLinked → “This email already has a password. Sign in with it below.”
- (auth)/layout legal links drop lang=fr, add hrefLang=fr and append (in French).

(8) eslint-rules/enforce/p11.json, and gates in e2e/wave2/p11-settings/gates.ts.

**Owns.** `src/components/settings/`, `src/app/(app)/settings/`, `src/components/auth/`, `src/app/(auth)/`, `src/app/app-auth/`, `src/components/app/onboarding.tsx`, `src/components/app/onboarding-lazy.tsx`, `src/app/api/settings/route.ts`, `src/lib/onboarding-gate.ts`, `prisma/schema.prisma`, `prisma/migrations/<new onboarding migration>/`, `e2e/auth.spec.ts`, `e2e/onboarding.spec.ts`, `e2e/wave2/p11-settings/`, `native/macOS/JunoDesktop/App/DesktopSettings*.swift`, `native/macOS/JunoDesktop/App/DesktopOnboardingSheet.swift`, `native/macOS/JunoDesktop/App/DesktopAccountScreens.swift`, `native/macOS/JunoDesktop/App/DesktopTextSize.swift`, `native/iOS/JunoMobile/App/JunoMobileSettingsView.swift`, `native/iOS/JunoMobile/App/JunoMobileSettingsPages.swift`, `native/iOS/JunoMobile/App/JunoMobileOnboarding.swift`, `native Mac and iOS tests whose subject is one of the native files above`, `eslint-rules/enforce/p11.json`, `tests/wave2-p11-*.test.ts`

**Acceptance.** e2e (production build via P0, alevr_p11_test):
- The identifier-first flow works for password, magic link and MFA.
- Step 2 DOM is identical for an existing password account, an OAuth-only account and an unknown email (snapshot diff of the form).
- A password manager fixture pairs the hidden username field with the password.
- OAuthAccountNotLinked copy is correct.

Migration:
- On a seeded copy of the schema, every pre-existing account is onboarded, and a new account is not.
- Onboarding completed in one browser context is not shown in a fresh context for the same account.
- A browser with the old localStorage key PATCHes the server and skips.
- The theme chosen in onboarding persists via the API. A failed name save shows the inline error. Focus lands in the composer after close.

Settings:
- Settings search finds a row inside a section, and an old deep link resolves.
- Motion Reduced removes transforms but keeps fades. Increase contrast applies the high-contrast tokens.
- Show usage changes the receipt on /chat.
- axe: 0 serious on sign-in, onboarding and settings.

Screenshots: web at 1440×900 and 390×844, light, dark and high contrast, with reduced motion on and off.

Native snapshots:
- Mac Settings and onboarding in light, dark and .xxl, with nothing clipped at xxl.
- iOS Settings Appearance and onboarding in light, dark and AX3.

No servers, databases or simulators are left running after the scripts.

## Appendix: how this spec was made

Three independent directions (Editorial Calm, Finished: one graphite instrument, one live colour, one grammar on three platforms; Glass Over Paper: Alevr as first-party Apple software, with the same precision on the web; Calm Instrument: one shell, one live line, one "needs you") were written from five surface audits (web shell, web conversation, web work surfaces, macOS, iOS) and two research sweeps (native craft, web motion). Three judges scored them on brand and craft, usability and accessibility, and feasibility and performance. The best-scoring direction was synthesized with grafts from the others, critiqued, and revised.

