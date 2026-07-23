# JunoMobile design review

Tracking the owner's visual rejection of 2026-07-22 through to a fix. One row
per rejected problem, what was actually done, and what is still open. Nothing
here is claimed from reading code — every "fixed" row was seen on a simulator or
asserted by a test that drives the real control.

Last updated: 2026-07-23, branch `agent/juno-mobile-redesign`.

## Phase 1 — brand assets (done)

| Rejected | Correction | Evidence |
|---|---|---|
| Seven-orange-dot logo | It was the SF Symbol `circle.hexagongrid.fill`, not a logo. Replaced with the site's real `public/juno-mark.png` as a **template** imageset — the native equivalent of the web's `dark:invert`, so one asset is right in both appearances. Applied to the iOS gate + sidebar and the macOS gate + sidebar. | `p1-sidebar.png`, iPhone 17 Pro sim |
| Generic SF Symbols for product navigation | The site's icons are **Lucide**, mapped in `src/lib/app-icons.ts` — there is no bespoke Juno set. `scripts/generate-native-icons.mjs` reads the geometry from the installed `lucide-react` and emits 11 imagesets per platform, so they cannot drift. Projects/Library/Artifacts/Search now use the site's own glyphs. | Same capture; `JunoBrandTests` asserts the set matches `app-icons.ts` |
| Coral on every icon | Mark and nav icons render in the foreground colour. Coral is left for emphasis. | Same capture |
| No Newsreader | Four real 24pt faces bundled, addressed by **PostScript** name. Two traps avoided: the variable file's family is `Newsreader 16pt` (a family lookup silently finds nothing), and asking for a weight on one face makes SwiftUI synthesise a faux-bold. Serif is display-only; controls and body stay on the system font. `JunoSerif.isBundled` makes the fallback observable. SIL OFL shipped. | `UIAppFonts` in `Info.plist`; faces verified present in the built `.app` |
| No real profile photo | `JunoAvatar` loads the account's `user.image` (same field the web user menu uses) and falls back to initials only when there truly is none — never as a loading placeholder, which would flash the wrong identity. | `JunoBrandTests`, 6 tests |

## The composer's "+" (one fixed, one open)

The owner reported the "+" as dead on a real iPhone. It was **two** independent
defects.

**Fixed — the touch target had collapsed to 13.3pt.** Nothing declared a hit
shape, so SwiftUI hit-tested the drawn glyph rather than the 32pt control. Send
had the identical construction and the identical defect. Both now declare one,
and `JunoMobileComposerUITests` asserts the frame so it cannot regress quietly.

**Open — the button's action never runs.** The cause is positional: the "+"
centre lands at x≈36, inside the strip where iOS arms its leading edge-pan
recogniser, which takes the touch. The control does not even animate.

Established mechanically, not guessed:

- Moving it 40pt clear → opens on the first tap, every time.
- The model chip 40pt to its right → never had the problem.
- Ruled out: the popover's anchor and arrow edge, where its `@State` lives,
  `.animation` on the Button, the panel's intrinsic size, and the shell's own
  drag gesture (`simultaneousGesture` changed nothing).

**Why it is not fixed here.** 20pt does not clear the strip. 40pt squeezes the
model and Thinking chips until SwiftUI stops resolving the layout at all — the
app renders no accessible content and the thinking-slider tests fail with it.
That is the same wall that stops these controls reaching Apple's 44pt touch
minimum. **The control row has to be rebuilt to carry fewer or narrower
controls.** That is the next piece of work, and it is not a one-line change.

`testTheComposerPlusButtonOpensTheActionsPanelOnTap` reproduces it and is marked
`XCTExpectFailure`, so the suite stays green *and* reports the day it passes.

## Phase 4 — composer, model selector, thinking (already built)

Landed in `521de78`, preserved from an abandoned session rather than rewritten.
The composer is one Liquid Glass container with the model and Thinking controls
*inside* it; there is deliberately no microphone, because dictation is not wired
and a control that does nothing is worse than one that is absent.
`/api/v1/models` and the bootstrap payload became plan-aware, reusing the web's
own `sortModelsForDisplay` and `getUserPlan`.

## Phase 3 — Home (done)

The generic "No messages yet" is gone. Home is the website's: the time-of-day
greeting in Newsreader with the first name in coral italic, the composer as the
centre of gravity, and the Write/Learn/Build/Decide/Compare modes — each a real
opening instruction, so tapping one starts a conversation that has already begun.
Captured at 02:54 showing "Moonlight chat" and at 02:58 showing "The world's
asleep", both from the web's 0–5 bucket, which also confirms the phrase varies.

**Newsreader is confirmed rendering on device**, in both appearances.

## Phase 5 — messages and reasoning (done)

The assistant's answer is borderless and takes the full column — it *is* the
reading surface, and the large rounded card the owner rejected is gone. Only the
user's words keep a surface: a compact warm bubble that stops short of full
width. Replies render real Markdown rather than one flat string. Reasoning is a
quiet secondary disclosure with no coral and no brain glyph.

## Phase 6 — top navigation (done)

The overflow drew its own ring: it was the `ellipsis.circle` SF Symbol, whose
circle is part of the glyph. Now `ellipsis`, in all four places. The remaining
ring on toolbar buttons is iOS 26's own toolbar treatment, not drawn by this code.

## Phase 8 — Projects (done)

Cards, not folder rows: name in the editorial serif, a one-line instruction
preview, chat and file counts, changed-at, favourite state. Deliberately *not*
Liquid Glass — glass belongs to chrome that floats over content, and a scrolling
wall of it would put a blur behind every title for nothing.

## Phase 9 — Project instructions (done)

The screen printed the whole prompt — 6,000 characters on the owner's own
project — before anything else. Now a three-line excerpt with a character and
line count and an explicit Edit, matching the web. The excerpt collapses blank
lines first so a spaced prompt does not spend its budget on whitespace. The full
editor and its sync path are untouched.

## Phase 15 — Code (done)

Hosts → sessions → live transcript, on the real relay. `hosts` had never been
populated: the model had the field but the client had no device call, so every
other method needed a `deviceID` nobody could type. `/api/code/devices` already
served the web and authenticates through `getCurrentUser`, which treats a bearer
as authoritative — so the phone reaches it with **no backend change**. Hosts sort
online-first. Two lifecycle bugs were found by looking at the screen rather than
the code: the model was never started on sign-in, and in the preview harness it
started after the view's task had run. Either leaves the screen stuck loading
forever, because a model with no account returns early and never retries.

## Known gap: the dark canvas is pure black

Dark mode is legible and the brand colours are right, but the background is the
system's near-black rather than Juno's warm `--background: 28 9% 9%`. The token
is correct (`JunoColorToken.warmBlack`, and `Color.junoCanvasWarm`); the screens
simply do not apply it — they inherit the system grouped background. Applying it
touches every destination, so it is called out here rather than half-done.

## Not yet started

Phases 3 (Home greeting — `JunoGreeting` is built and tested, not yet wired to a
screen), 5–18. The palette work in `JunoColors.swift` corrects two real drifts
from `src/app/globals.css`: the native dark canvas was **cool** where Juno's
`--background: 28 9% 9%` is warm, and native brightened coral in dark mode where
the web's `--primary: 15 54% 51%` is identical in both.

## Known limitation in this environment

The live simulator panel cannot run: `SimulatorKit.framework` is missing from
this Xcode-beta install, so `attach`/`tap` fail. Verification here is headless —
`simctl` screenshots plus XCUITests that drive the real controls. Physical-device
acceptance (Phase 18) has not been done.
