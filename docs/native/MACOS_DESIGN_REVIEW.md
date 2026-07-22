# JunoMac — visual design review

Written 2026-07-22 after the owner rejected the shipped Chat and Code screens.
This is the diagnosis, the principles that follow from it, and the record of
what changed.

## 1. Why the rejected screens failed

The architecture was right and the pixels were not. Both screens compiled,
navigated and passed their tests; none of that is a design argument.

### Chat

| Defect | Root cause |
|---|---|
| Sidebar reads as a flat grey slab | The sidebar painted its own opaque `.bar`/list background instead of letting the system's translucent sidebar material through. A native sidebar is *vibrant*; ours was a rectangle of fill. |
| Every navigation icon is coral | `Label(_:systemImage:)` inside `.listStyle(.sidebar)` lets AppKit tint icons with the app accent. With nothing overriding it, all seven rows rendered coral, which spends the brand colour on inert navigation and leaves nothing to signal an action. |
| Icons invisible in dark mode | The same implicit tint. When the icon colour is never stated, the appearance-resolved tint is the only thing drawing it, and in dark it resolved to something indistinguishable from the background. Confirmed reproducible with the window active and with `NSAppearance` set to `darkAqua`. |
| Switcher looks pasted on | It sat in a `safeAreaInset` with its own `.bar` background and a divider — a band bolted above the list rather than a header region the list belongs to. |
| Weak navigation/content/action separation | One flat fill behind all three, no elevation change, no grouping. |
| Excessive empty space | The transcript clamped to 760pt and centred inside a full-width canvas with no compensating structure, so a wide window was mostly nothing. |
| Simplistic messages | Assistant turns were unstyled body text; user turns were a wide pastel blob. No type scale, no measured line height. |
| Generic composer | A rounded rectangle with a text view and two pickers, all at default metrics. |
| Footer looks pinned, not designed | Literally a `safeAreaInset` with `.bar` and three controls spaced by `Spacer()`. |

### Code

| Defect | Root cause |
|---|---|
| Enormous dead centre | The empty state was a centred `ContentUnavailableView` with a 60pt glyph in an unconstrained frame. |
| Inspector dominates while empty | `inspectorVisible` defaulted to `true` with a 360pt ideal width, so a session with no changes still gave a third of the window to "No changes yet". |
| Crowded unlabelled icon strip | Eight inspector tabs rendered as a bare `Picker`/icon row with no labels and no grouping. |
| Weak header hierarchy | Session title, workspace and permission mode were one small stacked label with no separation from the canvas. |
| Oversized disconnected New Session button | A full-width coral capsule pinned to the sidebar bottom, heavier than anything else in the window. |
| Does not feel like Chat | Different row metrics, different sidebar treatment, different empty-state voice, different composer. |

### Global

Default SwiftUI metrics throughout: unmodified control sizes, ad-hoc padding
numbers, three different corner radii chosen per call site, and Liquid Glass
applied to two controls as decoration rather than as a material hierarchy.

## 2. Principles adopted

1. **The canvas is quiet; the chrome carries the material.** Content surfaces
   are opaque and flat. Translucency belongs to the sidebar, the toolbar, the
   composer and the inspector — the things that float over or beside content.
2. **Coral is a verb.** It marks actions and active state. Navigation is
   `.secondary`; text is `.primary`. If everything is accented, nothing is.
3. **State is never carried by colour alone**, and every icon colour is stated
   explicitly rather than inherited from an implicit tint — that implicitness is
   what made dark mode fail.
4. **One spacing scale, one radius scale, one type scale**, used by name. No
   literal numbers in view code.
5. **Density is a feature.** A source list is an index to scan, not a stack of
   cards.
6. **Chat and Code share everything structural** — sidebar metrics, header
   region, row design, composer language, empty-state voice — so switching modes
   changes the content, not the application.

## 3. Component decisions

- **Design tokens** live in `JunoDesignSystem`: semantic colours on `Color`
  (`junoCanvasWarm`, `junoRaised`, `junoRowHover`, `junoRowSelected`,
  `junoSeparator`, `junoBorder`, `junoTerminal`), plus `JunoSpace`, `JunoRadius`
  and the `juno*` type modifiers. Shared by both apps.
- **Sidebar** stops painting a background so the system's sidebar material shows
  through, and gains a real header region containing the Juno mark and the
  mode switcher on the same grid as the rows beneath it.
- **Navigation rows** build their `Label` with an explicit icon view, so the
  colour is stated in both appearances instead of inherited.
- **Mode switcher** keeps the system-backed `NSSegmentedControl` (see the commit
  that introduced it for why neither SwiftUI picker style can produce
  equal-width segments) and moves into the header region.

## 4. Screenshots

Before (rejected):
- `docs/native/design/before-chat-light.png`
- `docs/native/design/before-code-light.png`

After:
- `docs/native/design/after-chat-light.png`
- `docs/native/design/after-chat-dark.png`
- `docs/native/design/after-code-light.png`

Captured window-only (`screencapture -l <windowid>`), never the full desktop.

## 5. Accessibility findings

- The dark-mode icon defect above was an accessibility failure as much as a
  visual one and is fixed by stating icon colours.
- Icon-only controls use `Label` + `.labelStyle(.iconOnly)`; a bare `Image`
  reaches VoiceOver unnamed and leaks the SF Symbol id as the identifier.
- **Not done:** the Code inspector's tab strip still relies on unlabelled
  glyphs. It is listed under remaining limitations, not claimed as fixed.

## 6. What landed in this pass

Verified by screenshot, not by reading code.

**Design system** — `JunoSurfaces.swift` adds semantic surfaces (canvas, raised,
row hover/selected, separator, border, terminal), a named 4-point spacing scale
(`JunoSpace`), a three-value radius scale (`JunoRadius`) and a type scale
(`junoTitle`/`junoSidebarSection`/`junoRowLabel`/`junoBody`/`junoCaption`/
`junoMono`/`junoEmptyTitle`). `JunoCodeUI` now depends on `JunoDesignSystem`, so
Chat and Code cannot drift apart on tokens.

**Chat sidebar** — a real header region (Juno mark, then the switcher on the row
grid) that paints no background, so the system's sidebar material shows through
instead of the grey slab. The switcher lost its `.bar` band and divider.
Navigation icons are `.secondary`; coral is left to New Chat and active state.
Row height tightened to 26pt, section headers reduced to a quiet caption, and
the footer rebuilt as a designed region rather than three controls pushed apart
by a `Spacer()`.

**The dark-mode icon defect is fixed and the fix is confirmed in
`after-chat-dark.png`.** Cause: `Label(_:systemImage:)` inside
`.listStyle(.sidebar)` inherits AppKit's implicit accent tint, which resolved to
nothing in dark. `JunoMacNavigationRow` now builds the label with an explicit
icon view and states the colour, which fixes the invisibility *and* removes the
all-coral navigation in one change.

**Chat canvas** — short threads anchor to the top instead of floating against
the composer under a screen of dead space (`defaultScrollAnchor` is now
conditional on length). Measure widened to 820pt. The user turn is narrower
(460pt), much less saturated, and outlined rather than a pale slab. Reasoning is
secondary rather than a coral decoration.

**Chat composer** — opens one line tall instead of three, tighter control row
with a `+` actions menu, smaller Send/Stop, a real focus ring, and a shadow so
it reads as floating over the canvas.

**Code** — the inspector now starts **closed** (it opened by default at 360pt
ideal, so a fresh session gave a third of the window to "No changes yet"), and
its no-session state is compact rather than a full-height placeholder. The
New Session button is a compact accented footer row instead of a full-width
filled coral capsule that was the heaviest element in the window. The empty
canvas is a compact "Start a session" card with real suggestions instead of a
42pt glyph and a large-title wordmark. Both sidebars share `JunoMacSidebarHeader`.

## 7. Remaining real limitations

Stated rather than hidden:

- **Code's switcher sits below the system search field.** `.searchable(placement:
  .sidebar)` owns the top slot of a sidebar column and no `safeAreaInset` can get
  above it. Chat has no search field, so there the header is flush to the top.
  Making these identical means giving up the system search field in Code.
- **The Code transcript, terminal, diff, tests, Git and approvals surfaces were
  not redesigned** in this pass, nor was the Code composer. Phase G is partially
  done: sidebar, empty state, inspector proportions and the New Session action
  only.
- **The Chat canvas still has large vertical emptiness for short threads.** That
  is honest — a two-message conversation in a 760pt-tall window *is* mostly
  empty — but a designed short-thread state would do better.
- **Only three window sizes / two appearances were captured** (1180×760 light
  and dark, Code light). The 900×650, 1440×900 and full-screen passes in the
  brief were not run.
- **The preview scenario matrix in Phase I was not extended.** The existing
  `normal`/`empty`/`error`/… scenarios were reused.
