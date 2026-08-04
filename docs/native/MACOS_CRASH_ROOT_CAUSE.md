# macOS: the update-constraints crash

Referenced from `JunoDesktopWorkspaceView.swift` and from
`MACOS_ARCHITECTURE.md`. This is the single place describing *why* the Mac app
is shaped the way it is — the constraint of record, not a historical note.

## The failure

A hard crash inside AppKit's constraint pass — `NSGenericException`, raised
while updating constraints — with no useful Swift frame at the top of the
report. It reproduced on the Chat → Code mode change and, earlier, on ordinary
sidebar toggles.

## The shape that causes it

**Two AppKit split-view controllers negotiating the same window at the same
time.**

SwiftUI's `NavigationSplitView` is backed by an `NSSplitViewController`. Anything
that puts two of them against one window concurrently — even for the length of an
animation — makes both size themselves against the same geometry, and the
constraint pass re-enters. The three ways Juno reached that state:

1. **Cross-fading between two `NavigationSplitView`s.** A SwiftUI transition
   keeps the outgoing view alive while the incoming one appears, so both split
   views exist for the duration. This is why the Chat ↔ Code swap is
   *instantaneous* with only one workspace ever instantiated, and why it is a
   **veil** — a canvas wash dissolving off the new content — that animates
   instead. A cross-fade there looks better and reintroduces the crash.
2. **A self-sizing popover.** A popover with no explicit `.frame` renegotiates
   the window's geometry as its content lays out.
3. **Conditional `ToolbarItem`s.** Toolbar items that appear and disappear with
   state rebuild the AppKit toolbar underneath a live window.

## The rules that replace it

These are load-bearing and must not be relaxed. `MACOS_ARCHITECTURE.md` states
the last two as well:

1. Only one `NavigationSplitView` is instantiated at a time. Mode changes swap
   instantly; only a veil animates.
2. Every anchored popover declares an explicit `.frame`.
3. Toolbar items are always present and `.disabled()` rather than conditional.

## Why this is why V2 exists

The first workaround was to avoid the problem entirely: a hand-rolled `HStack`
with a fixed-width column and a 1pt `Rectangle` divider, with `NavigationSplitView`
and `.inspector` deliberately absent. That worked and cost the entire native
layer — no sidebar collapse, no column resizing, no vibrancy, no unified titlebar,
and selection drawn by hand instead of by `List(selection:)`.

V2 is the version that gets those back by fixing the *cause* rather than avoiding
the container. Verified on macOS 27.0 (build 26A5388g) through repeated sidebar
toggles with the full-width model selector held open over a live split view: no
crash, no crash report, and the accessibility tree confirming a real AppKit
`splitter group`.

## Not this crash

If you are chasing a crash on the Mac, check which one you have before applying
any of the above. A separate, later report implicates SwiftUI's sheet
presentation during a parent-window resize, which is a different mechanism with
a different fix. Read the `.ips` — the two are easy to conflate because both
surface as AppKit layout frames with no Juno code near the top.
