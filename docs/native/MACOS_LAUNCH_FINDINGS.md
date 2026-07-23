# JunoMac: the "zero windows" blocker, resolved and narrowed

Recorded 2026-07-23. Everything here was reproduced in this session, not
inherited from earlier notes — and the earlier notes were wrong in a way that
mattered.

## What earlier sessions concluded

`STATUS.md` recorded that "every Xcode-built Juno target launches, runs a normal
event loop and creates ZERO windows", reproduced on a pre-redesign commit, and
treated it as an environment fault that blocked all macOS visual QA.

## What is actually true

**1. The target did not compile.** `JunoMacRootView` used `JunoMark` without
importing `JunoDesignSystem`, so the app on disk was stale. Fixed in `34b789b`.
This is also the whole explanation for "selecting Code does nothing": the mode
switcher is correct, the binary was old.

**2. The build location matters.** Built to a `/private/tmp` derived-data path
the app produces no window at all. Built to
`~/Library/Developer/Xcode/DerivedData/...` it does. Every earlier "zero
windows" observation used a scratch path.

**3. It is a crash, not a missing window.** With a real build location the app
opens a window and then dies:

```
Exception Type:  EXC_BREAKPOINT (SIGTRAP)
Triggered by Thread: 0 (com.apple.main-thread)
  2  CoreFoundation  +[NSException exceptionWithName:reason:userInfo:]
  3  AppKit          -[NSWindow(NSDisplayCycle) _postWindowNeedsUpdateConstraints] + 1716
  4..16 AppKit       -[NSView _informContainerThatSubviewsNeedUpdateConstraints]  (recursing 11+ deep)
 17  AppKit          -[NSView setNeedsUpdateConstraints:]
 19  AppKit          -[NSView updateConstraints]
 20  SwiftUI         NSHostingView.updateConstraints()
```

No Juno frames appear: it is thrown inside AppKit's two-pass constraint update,
under `NSHostingView`, with `_informContainerThatSubviewsNeedUpdateConstraints`
recursing deeply — the signature of a constraint update that re-triggers itself.

## Which shell is at fault

| Launch | Result |
|---|---|
| `--juno-code-ui-preview` → `WorkbenchView` | **Window opens, process stays alive** |
| `--juno-ui-preview` → `JunoMacRootView` (Chat shell) | Crashes as above |
| no flags → `JunoMacRootView` | Crashes as above |

So the fault is in the **Chat shell**, not in Juno Code, and not in the
environment. macOS visual QA is available *today* for Code, and for Chat as soon
as this is fixed.

## Where to look first

`JunoMacRootView`'s Chat path nests a `NavigationSplitView` containing an
`.inspector(...)`, with `.safeAreaInset` on the sidebar. A nested split view
plus an inspector is the most likely source of a self-retriggering constraint
pass. Bisect by rendering the Chat shell with the inspector removed, then with
the sidebar's `safeAreaInset` removed.

## How to run it

```bash
DEVELOPER_DIR=/Applications/Xcode-beta.app/Contents/Developer \
  xcodebuild -project native/macOS/JunoMac/JunoMac.xcodeproj -scheme JunoMac \
  -configuration Debug -derivedDataPath ~/Library/Developer/Xcode/DerivedData/JunoMacVerify build
open ~/Library/Developer/Xcode/DerivedData/JunoMacVerify/Build/Products/Debug/JunoMac.app --args --juno-code-ui-preview
```

`screencapture -x <file>` works; the accessibility route
(`System Events → count of windows`) is reliable and was sanity-checked against
TextEdit, which reports 1.

---

# The Juno Code crash, bisected

2026-07-23, second pass. Every line below is a measured run, not a reading.

## What is established

| Configuration | Result |
|---|---|
| `--juno-code-ui-preview` — `WorkbenchView` alone in the `WindowGroup` | alive |
| Chat shell | alive |
| Code shell with `sidebarHeader: { JunoMacSidebarHeader(...) }` | **crashes** |
| Code shell with `sidebarHeader: { EmptyView() }` | **alive** |

The trigger is the **sidebar header**, and the only thing in it that is not
plain SwiftUI is `JunoMacSegmentedModeControl` — an `NSViewRepresentable`
hosting an `NSSegmentedControl`, placed by `.safeAreaInset(edge: .top)` on a
`NavigationSplitView` sidebar. Code's sidebar hits it and Chat's does not,
because only Code's split view also owns an `.inspector`.

That matches the backtrace exactly: the inset asks the hosted control for a
height, the control invalidates, the inset asks again —
`_informContainerThatSubviewsNeedUpdateConstraints` recursing eleven deep until
`_postWindowNeedsUpdateConstraints` throws.

## Ruled out

- **Window minimum.** Raising it from 760 to 900 (Code needs sidebar 220 +
  detail + inspector 260) did not stop the crash. The change is kept because the
  arithmetic is right regardless, but it was not the cause.
- **Nested `NavigationSplitView`.** Fixed separately in Projects; unrelated here.
- **Mode-switch identity.** `.id(productMode)` is kept for the same reason — it
  is correct — but it did not stop this crash either.

## Where it stands

`.fixedSize(horizontal: false, vertical: true)` on the hosted control made Code
launch successfully once and then fail on a later run. **It is intermittent,**
which is what a constraint-timing bug looks like, and it must not be described
as fixed.

## The next step

Replace the AppKit-hosted segmented control in the sidebar header with a plain
SwiftUI control. `JunoMacModeSwitcher`'s own doc explains why
`NSSegmentedControl` was chosen — it is the only API that gives two equal-width
segments — but a control that crashes the app is worse than one that centres its
segments. Either drop back to `Picker(.segmented)` inside a `.frame`, or move the
switcher out of the sidebar's `safeAreaInset` and into the toolbar, where no
inset asks it to resolve a height mid-pass.

The known-good fallback, if Code must work today, is
`sidebarHeader: { EmptyView() }` in `codeShell` — verified alive, at the cost of
no mode switcher inside Code.
