# The galaxy: Alevr's one working mark

The galaxy is the only thing in the product that moves to say "work is
happening right now". It replaced the 3 x 3 run glyph, the thinking matrix,
the third-party thinking orb, the AIcss and Code v2 text shines, and every
spinner that was standing in for a status. One mark means one behaviour and
one place where the rules hold.

Source of truth:

- `src/components/brand/galaxy-field.ts`: the particle field and the motion
  functions. Pure and deterministic, shared with the Swift port
  (`JunoGalaxyMark.swift`, `JunoGalaxyRenderer`). The PRNG draw order in its
  header is load-bearing for parity.
- `src/components/brand/galaxy-mark.tsx`: the web renderer (`GalaxyMark`).
- `src/components/chat/run/run-galaxy.tsx`: the run UI's wrapper
  (`RunGalaxy`), which places the galaxy under the one-loop arbiter.
- `src/components/code/v2/primitives.tsx`: `LiveMark`, the Code workspace's
  wrapper.

## What it is

A small two-armed spiral of dots seen from above and tilted (the disc is
squashed to 0.62 and turned -18 degrees), with a soft, slightly warm core.
120 arm and dust stars plus 6 core stars; a mark under 18 px draws the first
72 of the 120, so it is the same galaxy with fewer stars, never a different
one. Every mark on a page shares one field.

Ink is the row's own colour (`currentColor`), so the mark never outweighs its
words. About 8% of arm stars take the presence accent (`--presence`, from the
token projection, `SCRIPT_COLOR.presence`). The core is mixed 12% toward
`--galaxy-core`. In Code, rows set the ink to coral (`--signal`); in Chat and
Work it stays the row's second ink.

## Where it appears

Wherever work is real, and only there:

| Surface | Component |
| --- | --- |
| The live line: the reply waiting for its first word, a running tool receipt, a research run, an image being made | `LiveLine`, `RunMark`, `ToolReceiptRow` |
| The run line in the transcript, the Activity panel's live reasoning, the research plan row | `RunGalaxy` |
| The task card and the Work timeline's running step and plan rail | `WorkRunPanel`, `WorkCurrentAction`, `FeedMarker`, `StepMark` |
| Agent and Work status words ("Running", "Thinking") | `AgentStatusBadge`, `StatusMark` |
| Code: the Working line, a live work-log row, a running agent, the sidebar's running session | `LiveMark`, `CodeWorkList` |
| Waits with no phase words of their own: indexing, importing, checking a file, loading a document, a loading toast | `GalaxyMark` directly |

Not here:

- **A state is not work.** A Mac host that is online shows a still presence
  dot. Waiting on the person is a still mark and the attention words.
- **The button you just pressed.** A spinner stays inside that button
  (`Button loading`, an `IconSwap` busy face): it answers the press. A
  spinner anywhere else is a status, and a status is the galaxy.
- **A field's own busy glyph** (the Library search field) keeps its icon swap.

## Sizes

CSS px, square. 14 to 20 beside text: 20 beside reading-size text (the live
line), 16 to 18 in a dense row, 14 in a caption row, 12 only in a rail slot or
a micro row. 64 to 96 for a hero. The dot grows more slowly than the mark
above 24 px, so a hero galaxy stays a field of fine points rather than beads.

## Motion

- **Turning.** Differential rotation, inner stars faster:
  `ω(r) = ω0 (0.35 + 0.65 (1 - r))`, `ω0 = 2π / 5.5 s`. The differential part
  winds and unwinds on an 11 s period instead of integrating forever, so the
  arms never wind into rings during a long run. Arm stars leave a short wake
  along the orbit (three fading copies).
- **Arriving.** The stars spiral in from 0.6 of their radius over 420 ms
  (`GALAXY_ENTER_MS`, ease-out cubic).
- **Stopping.** When the phase leaves `thinking` / `working`, the clock's
  speed eases to zero exponentially (τ = 0.35 s): a slowing, never a cut.
- **Stepping back.** `finished` and `idle` dim to 60% over
  `GALAXY_EXIT_MS` (240 ms). `waiting` and `error` stop at full ink.
- **Breathing.** The core's alpha moves 0.75 to 1.0 over 2.8 s while turning.

## Phases

`GalaxyMark` takes the truthful phase of the row it sits in:

| Phase | Clock | Ink |
| --- | --- | --- |
| `thinking`, `working` | turns | full |
| `waiting` | eases to a stop | full |
| `error` | eases to a stop | full (the words say what happened) |
| `finished`, `idle` | eases to a stop | steps back to 60% |

`RunGalaxy` maps run phases: queued and thinking turn as `thinking`;
searching, reading, tool and writing turn as `working`; answering, done and
stopped are `finished`; failed is `error`; waiting and paused are `waiting`.

**One loop per page.** In the run UI only the id that owns the page's loop
(`lib/run/store.ts`, SPEC §7.9.1) turns; every other working mark draws the
still frame at full ink, so a page with three live rows has one thing
turning. Outside the run UI each mark turns while its own work is real.

## Cost

- One 2D canvas per mark, drawn on `requestAnimationFrame` only while the
  mark is on screen (IntersectionObserver), the tab is visible and the phase
  is pending. A stopped, settled mark asks for no frames at all.
- The ink is re-read at most twice a second; a theme flip, a new device pixel
  ratio, a restored context or a bfcache restore repaints a settled mark once.
- No perpetual repaint without real state: nothing loops because a component
  is mounted.

## Reduced motion

The OS preference, Settings › Appearance › Motion › Reduced, and a gallery's
simulated `data-motion` all count (`lib/motion-preference.ts`). Under any of
them the galaxy draws one still frame (the field at t = 1.2 s), with the 60%
step-back for finished marks. Settings › Motion › Full keeps it turning even
when the OS asks for less.

## Accessibility

Decorative by default: the words beside it state the phase, so the mark is
`aria-hidden`. Pass `label` only where no words sit beside it; it then becomes
`role="img"` with that name. The live region is always the words, never the
mark.

## Native parity

`JunoGalaxyMark.swift` draws the same field with the same functions. Still to
port (it needs a native build to verify): the eased stop (it pauses its
`TimelineView` and snaps to a frame), the 60% step-back for finished marks,
and an accessibility label for the label-only case. The 17 native
`JunoShimmerText` call sites still shimmer and should become the galaxy plus
still text.
