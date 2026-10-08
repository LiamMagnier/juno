# Brand motifs on iOS and macOS

The website's dot-matrix identity (the orbit construction, the product switch's
orbit, the empty-state mark, Deep Field's orbits, the signature dot field) is
ported to SwiftUI in
`native/Packages/JunoNativeKit/Sources/JunoDesignSystem/Brand/`. Every
component is decorative (hidden from VoiceOver and hit testing unless noted),
reads only design-system tokens (`junoForeground` ink, `junoSecondaryInk` for
the ℵ labels, `junoPresence` for the one live object, `junoAccent` only where
the web uses `--primary`), and draws light and dark from the colour scheme.

## Components

| Component | Web source | What it is |
| --- | --- | --- |
| `JunoProductOrbit(active:locked:onSelect:)` | `components/app/product-switch.tsx` | Chat and Code in the serif at the two ends of a dot orbit; the presence trail runs to the selected product (round the front to Code, round the back to Chat) and rests there. Buttons, accessible; locked products are shown greyed with a lock and still call `onSelect`. |
| `JunoProductOrbitTrack(active:)` | same | The 84 × 48 orbit alone, for a caller that draws its own labels. |
| `JunoEmptyMark(size: .page / .panel)` | `components/ui/empty-mark.tsx` | The construction in miniature (208 × 76 or 128 × 48): three orbits on the number line, one presence arc. Draws on once, then stops. |
| `JunoDotConstruction(ticks:trajectory:axis:animate:origin:span:zoom:pitch:style:)` | `components/home/dot-construction.tsx` | The full construction: seven orbits at an isometric diagonal, the ℵ number line, the travelling comet. Fills its frame. |
| `JunoDotRings(rings:lines:arcs:…)` | `DotRings` | Flat dot ellipses with lines and presence arcs, for any drawing whose rings carry things. |
| `JunoDeepFieldDots(targets:animate:)` | `components/research/deep-field.tsx` | Deep Field's three orbits and the runs to cited sources (ink) and to the page being read (presence). |
| `JunoDotGrid(spacing:interactive:)` | `components/signature/dot-field.tsx` | The faint paper grid behind editorial surfaces; on the Mac it can follow the pointer toward the accent. |

`EnvironmentValues.junoDotsTime` pins every drawing to one moment for
snapshots (`.infinity` is the settled frame).

### Fidelity

The scenes are line-for-line ports of `src/components/home/dot-engine.ts` and
`dot-scenes.ts`: the same expo ease table, the same raster (one dot per cell,
24 brightness levels, presence cells in a second set), the same constants
(1.5 ring ratio, 58° tilt, −24° yaw, −20° roll, 110 ms stagger, 2.2 s draw,
±7° sway over 80 s, one revolution every ~31 s) and the same per-surface
pitch and strength (`.product-orbit` 2.4, `.empty-mark-dots` 2.7 / .8, `.rf-dots`
3.6 / .7). `JunoBrandMotifsTests` asserts the native raster lights exactly the
cells the web's does (lit count, presence count and summed brightness) for the
product orbit at rest and mid-trail, the empty mark, Deep Field and the
construction settled and mid-arrival.

### Lifecycle (why the web's "blank until reload" cannot happen here)

The web bug was a retained raster that kept stale brightness across a refresh
(fixed in `dot-engine.ts`; see `src/lib/canvas/canvas-lifecycle.ts`). Natively
nothing is retained: each frame is rasterised from the drawing's description
at the size the `Canvas` is handed and the screen's current scale, so a size
change, a display change, a theme flip or a return from the background just
draws again. The clock (`TimelineView`) runs only while the view has appeared,
is inside a scroll view's visible region (`onScrollVisibilityChange`), its
scene is not in the background, Reduce Motion is off and something is still
moving; a settled drawing that does not travel (rings, the empty mark, the
orbit) stops asking for frames, and the construction drops to 30 fps once
settled. Reduce Motion draws the final frame once.

## Where each one goes

Wired in this change (non-shell files):

- **Empty states, macOS** — `JunoEmptyState` draws `JunoEmptyMark` instead of
  the glyph tile for the empty tone, as the web's `EmptyState` does; errors
  keep the destructive glyph tile. Every Mac screen using `JunoEmptyState`
  (Library, Projects, Memory, Automations, Artifacts, Settings panes, …) picks
  it up.
- **Research, iOS and macOS** — `NativeResearchField` (Deep Field) draws its
  orbits and source runs with `JunoDeepFieldDots`; the dashed `FieldOrbit`
  strokes and the accent presence line are gone. Reached through
  `NativeResearchLiveView`, which the Mac `ResearchViews` and the phone's
  `JunoMobileResearch` / conversation view both host.

To drop in from the shell lanes (`polish/ios-rework`, `polish/mac-rework`),
which own these files:

| Place | Platform | File (today) | What to add |
| --- | --- | --- | --- |
| Product switch in the toolbar | macOS | `ChatToolbar.swift` (`ToolbarItem(.principal)` → `DesktopProductSwitch`) | Replace the segmented capsule's content with `JunoProductOrbit(active: JunoProduct(rawValue: product.rawValue) ?? .chat, locked: plan below Pro ? [.code] : []) { product = DesktopProductMode(rawValue: $0.rawValue)! }`. Keep ⌘1/⌘2 on the existing commands. |
| Product switch in the drawer header | iOS | `JunoMobileDrawer.swift` | `JunoProductOrbit` under the wordmark, where the web sidebar has it; route a locked Code to the upgrade sheet. |
| Empty states | iOS | `JunoMobileEmptyLine` (`JunoMobileWorkspaceChrome.swift`) and list placeholders | `JunoEmptyMark(size: .panel)` above the line; `.page` for a whole-screen empty list. |
| Loading states | both | first-page loads of Library, Projects, Memory, history | `JunoEmptyMark` while the first page arrives (it draws on once, then holds still); not for inline spinners. |
| Research, finished report header | both | `ResearchReportWindow.swift`, `JunoMobileResearch.swift` | `JunoDeepFieldDots(targets:animate: false)` behind the recap when no live field is shown. |
| Onboarding | macOS | `DesktopOnboardingSheet.swift` | `JunoDotGrid(spacing: 26)` at 40% opacity behind the welcome panel (the web's `onboarding.tsx`). |
| Onboarding | iOS | `JunoMobileOnboarding.swift` | `JunoDotConstruction(trajectory: true)` faint behind the first page, masked to an ellipse; or `JunoDotGrid` behind the panel. |
| Sign-in / download stage | both | auth screens | `JunoDotConstruction(ticks: true)` on the dark ground, as the web's access panel. |

Rules carried from the web: the presence blue is spent only on the one live
object (the trail, the arc, the page being read); no status pills or dots; the
motifs never replace a control's label; they stay decorative.
