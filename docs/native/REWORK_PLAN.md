# Juno native rework — direction and plan

Date: 2026-08-15. Companion to [`REWORK_VISUAL_AUDIT.md`](REWORK_VISUAL_AUDIT.md)
(what was seen running) — this document is what to do about it.

Sources: eleven parallel audits of this tree, plus verified competitive research into
OpenAI (Codex → ChatGPT desktop merge, Jul 2026), Anthropic (Claude Code Desktop, Claude
Code on iOS, Cowork), Cursor, Google (Antigravity / Jules), Kimi, Zed, Warp and Devin, and
Apple's Liquid Glass guidance for the 26 baseline and the 27 delta.

## Owner decisions taken (2026-08-15)

1. **IA: three products, everything nested.** Chat, Code and Work are the only top-level
   destinations on both platforms. Search is system-wide. Projects, Library, Artifacts,
   Tasks, Connections, Usage, Memory and Settings move into an account layer or into the
   product that owns them.
2. **Website Code & Work is finished** — the parity audit and the sync/feature-linking
   work are in scope (Phase 8).
3. **Per-message cost stays visible by default**, but is restyled so it stops reading as
   debug output. Monospace remains banned as a UI label font (code, paths and terminal
   output only).

## The verdict

The apps do not look unfinished because the design system is bad. It is better than most
shipping Apple-platform software: a CSS→Swift token generator that passes clean, a
three-tier Reduce Motion model, WCAG contrast enforced by unit test, and Liquid Glass used
correctly at every one of its sites — all chrome, never content.

They look unfinished because **nothing exists between those tokens and the screens.**
34 Swift files exceed 1,000 lines and the largest is 5,346, so every screen re-derives its
own row, header, empty state and command bar. Nine surfaces agree on colour and disagree
on everything else.

Compounding it: **every migration here was diagnosed precisely, documented in an
essay-length comment, and then abandoned half-applied.** `junoFont` is 36% adopted.
`JunoSpacing`/`JunoCornerRadius` are deprecated with 8 live call sites each.
`JunoGeneratedDuration` and the 34KB generated `JunoWorkContract.swift` have zero
consumers. `WorkbenchView` is 1,801 lines of unreachable UI. `Package.swift` excludes 20
ghost `<Name> 2.swift` files behind a helper written to tolerate paths that don't exist.

The two apps are a full design-system generation apart — macOS uses `JunoSpace` 891 times,
iOS 42 — so the iPhone is not a peer but a stale port. On it, a completed Work task never
shows its answer and a Code run never shows its diff.

What actually reads as "experimental AI" is narrow and identifiable: ~1,084 lines of
ambient decoration whose largest artifact is a 512pt breathing bloom encoding *which AI lab
you are talking to* as hue and *reasoning effort* as brightness; a bare spinner as the
answer to every wait across 112 sites; and an IA where one destination has three doors,
Settings has two implementations, ⇧⌘N means three different things, and the main window
has no title.

## Design principles

Each is falsifiable — a reviewer can fail a PR against it.

1. **The chrome is glass; everything you read or act on is opaque.** Exactly one Liquid
   Glass layer per screen (sidebar, toolbar, tab bar, composer) over an opaque content
   layer. Grep any transcript row, list row, diff hunk, code block, bubble or empty state
   for `.glassEffect` / `.ultraThinMaterial` — a hit is a defect. True at 9 of 9 sites
   today; the rule exists so the rework doesn't break it.
2. **Nothing ships that a still frame cannot explain.** Pause any agent surface: step,
   elapsed time and last action must be readable as static text. If only motion implies
   progress, it informs identically whether the run is healthy or wedged.
3. **Every animation names a token or it is a bug.** A raw `.easeOut(duration:)`,
   `.spring(response:)` or `withAnimation(.default)` at a call site fails review. Already
   280:25 adopted — close the last 25 rather than invent a new ladder.
4. **iOS and macOS are peers with the same vocabulary and different values.** Same
   component, destination, motion-token and status names. Any derivation written twice in
   two files is a defect — that is exactly how iOS silently lost `finalAnswer`.
5. **Animation may only spend time the user was going to lose anyway.** Instant operations
   get instant results and an animated *affordance* only. Slow ones get a skeleton with
   real final geometry, never a spinner. 112 `ProgressView()` today, one skeleton.
6. **One destination, one name, one door.** Nothing reachable from three places (Usage is),
   nothing with two implementations (Settings has), nothing that renames itself by context.
7. **Text scales, targets are 44pt, and the answer is always visible.** Everything goes
   through `junoFont(size:relativeTo:)`; `Font.system(size:)` is frozen at every
   accessibility size and is banned.
8. **Delete the previous attempt in the same commit that lands the new one.**

## Liquid Glass rules

Keeping Liquid Glass means *adopting the native structures that carry it*, not painting
material onto hand-rolled views. Most of the current non-native feel comes from
hand-rolling `Form`, `List`, `Picker`, navigation and toolbars — which opts the app out of
the material entirely.

- One `GlassEffectContainer` per cluster, `glassEffectID` on every participant. Loose
  `.glassEffect` calls get inconsistent sampling, no morphing, and documented performance
  loss. The iOS composer has **seven nested glass elements and no container** — fix first.
- **Morph, don't fade.** Buttons expand into menus from the tap point. Never cross-fade
  glass; modulate lensing via `glassEffectID` inside a container.
- **Exactly one tinted action per bar**, trailing edge, colour on the background not the
  glyph. Brand colour lives in the scrolling content so it scrolls away.
- **Register every custom bar for the scroll edge effect** (`safeAreaBar` /
  `scrollEdgeEffectStyle`). This is the direct fix for the hard seam under the iOS nav bar
  in dark mode.
- **Delete custom backgrounds** from `NavigationStack`/`NavigationSplitView`/toolbars/
  sheets/popovers. Simultaneously the accessibility fix, the 27-forward-compatibility fix,
  and the largest available code deletion.
- `ToolbarSpacer(.fixed)` grouping, max ~3 groups, symbols not text — the fix for the eight
  ungrouped icons in the macOS Code toolbar.
- **Concentric shapes** (`ConcentricRectangle`, `.rect(corner: .containerConcentric)`)
  instead of hard-coded radii, so nested containers stay aligned as Apple retunes metrics.
- `tabBarMinimizeBehavior(.onScrollDown)` + `tabViewBottomAccessory` as the iPhone home for
  a persistent "run in progress" pill.

## Motion system

Seven named tokens, projected from `globals.css`, nothing else permitted. `JunoMotion` is
kept (280:25 adopted already) but made drift-proof: it reads `JunoGeneratedDuration`
instead of re-declaring the same numbers as literals, and the test asserts the projection
rather than the literals — today a web-side retune of `--dur-base` leaves Swift stale and
the test green.

| Token | Value | Used for |
|---|---|---|
| `press` | `.easeOut(0.07)` | The press dip. Owned only by `JunoPressButtonStyle`. |
| `fast` | `.easeOut(0.12)` | A property changing under the pointer: hover fill, tint, icon morph, status glyph cross-fade. Never movement. |
| `exit` | `.easeIn(0.16)` | The removal half of an asymmetric transition. |
| `standard` | `.spring(duration: 0.22, bounce: 0.05)` | Default. Selection, disclosure, row insert/remove, popover, height change. |
| `emphasized` | `.spring(duration: 0.36, bounce: 0.10)` | A whole region: sidebar reveal, sheet, product switch, navigation push. |
| `interactive` | `.interactiveSpring(response: 0.32, dampingFraction: 0.85)` | Anything tracking a held finger. |
| `reward` | `.spring(duration: 0.36, bounce: 0.18)` | **Exactly two sites product-wide**: a run reaching Completed, and an approval accepted. A third fails review. |

**Bounce policy.** House default 0.05–0.10; nothing above 0.18 exists. Bounce is the
single strongest toy-versus-tool dial.

**Platform rule.** Same names, different values: macOS multiplies `standard`/`emphasized`/
`interactive` by **0.75**, bounce identical. Implemented as one `#if os(macOS)` factor
inside `JunoMotion`, never at call sites. Identical timings on both platforms is itself a
tell that motion was specified once and shipped twice.

**Reduce Motion.** The existing three-tier model is kept verbatim — it is the best thing in
the motion layer. `withAnimation` may no longer take a raw `Animation`; it takes the result
of `JunoMotion.reduced(...)`.

**Agentic motion rules.** One loop per screen (1.2–2.0s), only where data is changing.
Streaming text: word-granularity 150ms fade, no vertical translation, decoupled from the
socket at ~20ms/word, animation wrapper stripped on completion so scrollback is inert.
Tool-call rows appear at final geometry and never resize. Auto-scroll only while pinned to
the bottom, else "Jump to latest". Stagger caps at a 200ms envelope, first 6–8 items, one
-time reveals only — port the web's `use-work-arrivals.ts` rather than reinventing it.

## Information architecture

### macOS — one window, three products, nine destinations

Product switcher stays at the sidebar top but loses the brand logo and the uppercase
`WORKSPACE` eyebrow, cutting sidebar chrome from ~122pt to ~52pt so the source list starts
under the traffic lights like Mail and Xcode. ⌘1 Chat, ⌘2 Code, ⌘3 Work.

- **Chat** — Conversations, Projects, Library. *Artifacts folds into Library as a filter*
  (both answer "files I have"; Artifacts currently has its own 2,117-line screen).
  Search stops being a row and becomes ⌘F over the whole account.
- **Code** — Sessions, Pull requests. Remove Usage/Settings/Design, which currently sit
  beside a coding run.
- **Work** — Tasks, Schedules, Skills, Hosts. Matches the web's own `work-nav.tsx`
  exactly, and fixes Skills and Hosts having no entry point anywhere today.

Account surfaces leave the sidebar entirely into **one** Settings window at ⌘,. The
`.settings` destination is deleted; `DesktopSettingsScreen` gets one construction site.

Window titles: `.navigationTitle("")` deleted from both workspaces — today the title is
empty on eight surfaces. Restore last product *and* destination on launch.

### iOS — a tab bar with the same three products

`TabView(.sidebarAdaptable)` carrying **Chat, Code, Work** plus `Tab(role: .search)`. The
hand-built reveal drawer is deleted — on its own merits too: it sizes from
`UIScreen.main.bounds` (deprecated since iOS 16) and clamps to 340pt, so in a 320pt iPad
Slide Over it renders a drawer wider than the window containing it. `.sidebarAdaptable`
also gives iPad a real sidebar, which is why `JunoMobileSection.Group` has zero call sites
today.

Real `NavigationStack` per tab (the app currently has zero `NavigationStack` and zero
`NavigationLink`). `tabViewBottomAccessory` carries the persistent "run in progress" pill.

## Phases

Ordered so each ships something visibly better on its own, and so the foundation lands
before the screen rewrites.

| # | Phase | Depends on |
|---|---|---|
| 0 | **Delete the previous attempts, then gate.** Remove ~2,000 lines of unreachable UI; turn six design rules into build failures. Changes no pixels. | — |
| 1 | **Close the token loop.** Make tokens drift-proof; finish the three abandoned migrations. First user-visible win: iOS text responds to Dynamic Type; iOS controls become tappable. | 0 |
| 2 | **Build the component layer.** The missing layer between 16,755 lines of design system and 69,109 lines of screens. Longest phase; makes every later phase cheap. | 1 |
| 3 | **One IA, two shells.** Land the three-product decision on both platforms at once. | 2 |
| 4 | **Honest states everywhere.** 112 spinners → skeletons; real empty states; an offline story, which neither platform has. | 2, 3 |
| 5 | **Agentic motion, and retiring the slop.** The phase that most directly answers the verdict. | 1, 2 |
| 6 | **Juno Code rework.** One transcript renderer and one composer instead of four and two; iOS gains a diff and a follow-up composer. | 2, 3, 4 |
| 7 | **Juno Work rework.** iOS from viewer to peer — starting with showing the answer. | 2, 3, 4 |
| 8 | **Link the apps to the web.** Work onto the sync layer, close the contract gap, add push. | 6, 7 (backend half can start during 6) |
| 9 | **Platform expression and polish.** Cut first if the schedule compresses. | 3, 5, 6, 7 |

### Honest scale

~90k lines of Swift under active rework. **Phases 0–5 ≈ 9–11 weeks** for one focused
engineer; **6–8 ≈ 9–11 more**; 9 ≈ 2. Call it **20–24 weeks solo, 11–14 with two engineers**
splitting by platform after Phase 2. Phase 2 alone is 2–3 weeks and cannot be
parallelised. There is no version of this that is a two-week polish pass — attempting one
produces a fourth generation of half-finished migration on top of the three already here.

## Gates

Four of the design rules above are now build failures rather than prose. Run them with
`npm run native:design:check`; `npm run native:design:list` prints every violation each
can see, and `npm run native:design:baseline` re-records the ceiling after a migration.
CI runs them as the **Design rules** job in `.github/workflows/native.yml`.

**They ratchet.** Each records the tree's current violation count in
`scripts/check-native-design-baseline.json` and fails only when the count goes **up**. A
hard gate against a tree holding 550 unshaped hit targets is a gate that gets switched off
in week one, and a switched-off gate leaves a green check where a measurement used to be.
The number is only ever allowed to travel downwards. A lane that migrates a surface
re-records the baseline in the same commit that lands the migration — which is principle 8
applied to the gates themselves.

| Gate | Enforces | Bans | Exempt |
|---|---|---|---|
| `check-native-type` | Principle 7 | `Font.system(size:)` / `.font(.system(size:` anywhere | `JunoTypography.swift`, which implements `junoFont` |
| `check-native-motion` | Principle 3 | raw `.easeOut/.easeIn/.easeInOut/.linear(duration:)`, `.spring(response:)`, `.snappy`, `.bouncy`, `.smooth`, `withAnimation(.default`, and any `withAnimation(…)` whose argument is not a `JunoMotion.` token | `JunoDesignTokens.swift`, which defines the ladder |
| `check-native-glass` | Principle 1 | `.glassEffect` / `.junoGlass` / any `Material` inside a file or type named `Transcript*`, `*Row*`, `*Card*`, `*Bubble*`, `Diff*`, `Review*`, `*EmptyState*`, `Message*`; plus any glass call with no `GlassEffectContainer` in the file | `JunoMaterials`, `JunoDesktopChrome`, `JunoMobileChrome` — the primitives that own glass |
| `check-native-targets` | 44pt targets | a `Button`/`Menu` whose only explicit `.frame` dimension is under 44, and any `Button`/`Menu` label with no `.contentShape` | controls the system draws: `Menu` bodies, context menus, alerts, dialogs, swipe actions, toolbars, pickers |

`glass` matches on names, so a chrome affordance living inside a content-named file reads
as a violation — the "Jump to latest" pill in `TranscriptView.swift` is the one such hit
today, and it is chrome floating over content rather than content. The message always names
which marker matched, so a reviewer can tell the two apart in one line.

Comments and string literals are blanked before scanning, so the essays in
`JunoDesignTokens.swift` that name every banned constructor do not count against it. Test
targets are not scanned — a raw `.easeOut(duration:)` is *correct* in `JunoDesignTokensTests`,
which has to build the curve it is asserting the ladder produces.

### The ceiling as measured on 2026-08-15

The debt these gates hold the line on, by module. `targets` over-reports on purpose — it
cannot see padding or a `.contentShape` supplied by a shared `ButtonStyle` — so read it as
a ratchet, not as a defect count. The other three are close to literal.

| Module | type | motion | glass | targets |
|---|---:|---:|---:|---:|
| JunoNativeKit (shared) | 59 | 2 | 0 | 43 |
| JunoCode (shared) | 6 | 1 | 1 | 117 |
| JunoWork (shared) | 0 | 0 | 0 | 0 |
| JunoDesktop (macOS) | 9 | 9 | 1 | 252 |
| JunoMobile (iOS) | 17 | 17 | 3 | 138 |
| **Total** | **91** | **29** | **5** | **550** |

Two readings worth carrying into the phases. The `glass` column being near-empty confirms
the audit: content is opaque at essentially every site today, and the gate exists to keep
it that way through nine phases rather than to clean anything up — the five hits are all
*loose* glass, glass laid down with no `GlassEffectContainer` to group it. And `targets` is
where the work is, concentrated in `JunoDesktop` and `JunoCode`, which is the same place
Phase 2's missing component layer would fix it wholesale: one shaped row primitive retires
several hundred of these at once.

Principles 2 (still-frame) and 5 (skeletons, not spinners) are **not** gated. Both need to
know whether a surface's row geometry is knowable, which is a judgement about the screen
rather than a property of the token stream, and a gate that guessed at it would report
noise. They stay review items.

## Blockers found for the web-linking phase

The website Code & Work is feature-complete, but the apps cannot be linked to it as-is:

- **The native contract describes zero Work endpoints.** `contracts/openapi/juno-native-v1.yaml`
  has 28 paths and no `/work` entry, while `src/app/api/work` exposes 38 handlers the Swift
  clients already call.
- **Work is structurally outside the sync contract.** 23 of 87 Prisma models have entity
  loaders and change-capture triggers; **all 16 `Work*` models have neither**, so a Work
  task can never arrive via `/api/v1/changes`.
- **There is no push pipeline anywhere in the native tree.** No entitlements, no device-token
  registration, no server service, no link between a `WorkApproval` and a device. Work's
  whole proposition is unattended execution that stops to ask you something; without push
  that depends on a foregrounded 30-second poll. This is a backend project with its own
  schedule, not a UI task.
- **Work Skills does not exist in native at all** — the web ships list, create, detail,
  security review, instructions editor, version history and per-version consent.
- Offline writes cover 6 entity families out of 87.

## Open questions for the owner

1. **Ambient decoration — kill, demote, or keep?** `JunoComposerAura` (434 lines),
   `JunoVoiceAura` (293), `JunoProviderGlow` (184), `JunoAIcssShine` (173) total ~1,084
   lines — more than JunoColors + JunoTypography + JunoSurfaces + JunoMaterials +
   JunoOverlays combined. The engineering is good and Reduce Motion is properly answered,
   but it encodes the AI lab as hue and reasoning effort as brightness, breathes on an
   11-second loop, and swells 2.3× on send. **The plan assumes demotion to one static
   accent.** This is an identity call.
2. **Is iOS a peer or a control plane?** Anthropic says mobile is "a client, never a
   runtime"; OpenAI picked four mobile capabilities; Cursor chose full peer including merge
   and reviewer assignment from a phone. Phases 6–7 assume *peer for review-and-steer,
   control plane for authoring*. Full peer adds ~1 week; strict control plane shortens it.
3. **Scheduled chat prompts vs Work Schedules.** The IA merges the `tasks` destination into
   Work Schedules as a `chat_answer` action — one scheduler for the product. That moves a
   Chat feature behind the Work gate and needs a `ScheduledTask` → `WorkSchedule` migration.
4. **OS target: 26 or 27?** Two reported iOS 27 changes matter and **neither could be
   confirmed** in Apple's docs or the installed Xcode 27 SDK: the scroll edge effect default
   flipping `.soft`→`.hard`, and `UIDesignRequiresCompatibility` being ignored. The plan
   targets 26 and treats 27 chrome as Phase 9.
5. **Three products or two?** OpenAI merged Chat and Work into one view with a composer
   toggle, keeping only Codex separate. If Juno's Work is closer to "a mode of Chat", the IA
   collapses to two and Phase 3 shrinks.
6. **Does `design` survive?** A macOS footer row, no iOS surface, an 897-line screen with a
   hand-rolled command bar and no Reduce Motion.
7. **What is the acceptance test for "done"?** The verdict is aesthetic; the plan is
   mechanical. Agree now on a small set of screens — Chat home, a live Code session, a live
   Work task, Settings, both platforms — to re-judge at the end of Phase 5. If it still
   reads as experimental then, Phases 6–9 will not fix it and the direction needs revisiting.
