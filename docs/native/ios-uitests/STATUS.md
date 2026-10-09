# iOS UI tests vs the round-2 iPhone design: status (2026-10-10)

Branch `polish/ios-uitests` (worktree `.claude/worktrees/ios-uitests`, from
`polish/native-practice` 83da9dc4d). Only `native/iOS/JunoMobile/UITests/**` and
this file changed; no app code. Not pushed.

Runs: iPhone 17 Pro, iOS 27.0 simulator ("Alevr UITests iPhone", created for this
lane, headless), `CODE_SIGNING_ALLOWED=NO`, `-only-testing:JunoMobileUITests`.

| Run | Pass | Fail | Skip |
| --- | --- | --- | --- |
| Before (83da9dc4d, tests as they were) | 13 | 42 | 1 |
| After (this branch, app unchanged) | 16 | 39 | 1 |
| After + local app fixes A and B below (not committed) | 50 | 5 | 1 |
| ...and C fixed, inferred from flag-opened probes | 54-55 | 0-1 | 1 |

The suite still fails on the real app because three app bugs block taps. They are
real defects of the shipping app, not of the tests, and are left for the session
that owns app code.

## Real app bugs found

**A. The closed drawer swallows every tap on the conversation card (critical).**
`App/JunoMobilePhoneShell.swift`, `JunoMobilePushDrawer`, the dim / tap-to-close
overlay on `content()`:

```swift
Color.black
  .opacity(... * progress)
  .allowsHitTesting(isOpen)      // disables only the colour…
  .contentShape(.rect)           // …this and the tap gesture are still live
  .onTapGesture { setOpen(false) }
```

With the drawer closed, the invisible full-screen catcher still takes every tap
on the card: the top bar (sidebar, title menu, New chat), the transcript, the
composer's "+", dial, mic and text field, Search's field, the Projects/Artifacts
lists — anything the drawer hosts. Sheets work (they are presented above it), which
is why only the Accent suite passed. It became total with a9d5e2a6e (the card's
`.compositingGroup()`); before it, UIKit-hosted controls (bars, search fields) still
got through. Fix, verified locally: move `.allowsHitTesting(isOpen)` after
`.onTapGesture` (or only build the catcher while open). That one line alone takes the
unchanged suite from 13 to 30 passing tests.

**B. Rows of the glass "+" panel cannot be tapped.** The panel is drawn in an
overlay of the composer card, which `junoComposerBar` hosts with
`safeAreaBar(edge: .bottom)` (`JunoMobileConversationsView.swift`). The panel
stands above the bar's bounds, and hits there go to the transcript instead:
Camera, Photos, Files, From your library, Deep research, Web search, Apps, Orbit,
Model and More all do nothing (the "+" itself opens and closes the panel).
Verified by swapping `safeAreaBar` for `safeAreaInset` locally: every panel test
then passes. That swap loses the scroll edge effect under the composer, so the
real fix is probably to present the panel from the conversation screen (an
overlay above the bar) rather than inside it.

**C. Projects and Artifacts cannot open an item on iPhone.** The shell's stack is
`NavigationStack(path: $chatPath)` with `chatPath: [JunoMobileSection]`
(`JunoMobileRootView.swift`). Projects and Artifacts are pushed sections whose rows
are `NavigationLink(value: String)` with `.navigationDestination(for: String.self)`
declared on the pushed screen. SwiftUI logs "Only root-level navigation destinations
are effective for a navigation stack with a homogeneous path" and "A NavigationLink
is presenting a value of type String but there is no matching navigationDestination
… The link cannot be activated": a tap only highlights the row. (The preview flags
`--juno-preview-project` / `--juno-preview-artifact` use item-based presentation, so
screenshots never showed it.) The pages themselves are fine: flag-opened probes
pass every downstream assertion of the four Workspace tests.

**D. Smaller findings**
- A signed-out launch after preview-harness launches in the same install ends on
  "Juno cannot unlock the existing local account database." with no sign-in
  button and no way out (`authModel.phase == .unavailable`). The preview DB itself
  is a temp file, so something in a `--juno-ui-preview` launch touches the real
  store; with unsigned simulator builds the key does not survive. On a fresh
  install the launch test passes. Worth a look: the dead end has no recovery path,
  and `NativeLocalAccountStoreFactoryError` messages still say "Juno".
- Incognito copy differs from the web: iOS "won't appear in your history or be used
  for memory", web "won't appear in your history, won't be added to memory, and
  isn't used to train models".
- The card's sidebar button is a system toolbar item: its accessibility frame is
  the 36pt item box (button 24×36), not the 44pt glass circle the system draws, so
  "same diameter as the drawer's search button" is only checkable visually.

## The 6 new failures on this branch (the brief)

| Test | Cause | Change |
| --- | --- | --- |
| Search `testTypingReturnsResults`, `testAMidWordFragmentReturnsResults` | A (the tap never focused the field) | none needed; pass once A is fixed |
| Workspace `testArtifactDetailShowsTheViewSwitchAndItsActions` | A + C | none needed; downstream asserts verified by probe |
| ChatChrome `testDrawerSearchAndSidebarButtonShareSizeAndCentreLine` | stale: drawer container identifier overrides `juno.mobile.sidebar-search`; toolbar item frame is not the glass | select by label; assert shared centre line + our 44pt circle. **Passes.** |
| ChatChrome `testTheHeaderPairsNewChatWithTheMenuInOneCapsule` | stale: title is the menu, New chat alone on the trailing edge | renamed `testTheHeaderPutsTheTitleMenuBetweenTheSidebarAndNewChat`. **Passes.** |
| Composer `testTheModelRowInPlusOpensTheModelList` | B | none needed |

## The other failures, classified

Stale tests (updated):
- Composer thinking dial (6): `testThinkingSliderDragsThroughEveryLevel`,
  `testTappingATrackPositionJumpsToThatDetent`, `testTheChipAndTheSliderAgreeAfterAdjusting`,
  `testAnOnOffModelExposesExactlyTwoStops`, `testTappingTheThinkingChipOverItsChevronOpensThePicker`,
  `testAutoOffersNoThinkingSliderAtAll` (passed vacuously before: its tap never
  landed). The popover slider (`juno.thinking-slider`, VoiceOver values "Thinking
  max") became the composer row's dial (`juno.mobile.thinking-dial`, values are the
  level names) that folds back into the gauge 0.9s after the touch, so levels are
  read on the gauge. Auto and models without levels now open the model list.
- `testANonReasoningModelHidesTheThinkingControl` → `testANonReasoningModelsDialOffersTheModelInsteadOfASlider`:
  the gauge stays (it is the composer's model control since the model chip went).
- `testTheComposerOpensOnTheAccountDefaultModelNotAuto`: the model chip is gone;
  reads the "+" panel's Model row ("Model, Opus 4.8"). Blocked only by A (it taps
  the "+", not a panel row).
- `testThePlusMenuOffersTheWebsitesTools`, `testArmingDeepResearchMarksThePlusButton`:
  no Tools submenu any more; Deep research / Web search are panel rows, canvas and
  memory are under More. Still blocked by B.
- `testSwipingFromTheLeadingEdgeStillOpensTheDrawer`: the card is pushed, not
  covered, so "+" stays on screen; asserts the card moved. **Passes.**
- `testTheThoughtProcessRowOpensTheRunPanel`: the fixture got longer; up to six
  swipes to reach the row.
- `testCodeRemotePickerDistinguishesRunnableAndUnavailableHosts`: Code opens on the
  Mac's remote sessions; the target chip is under "Run on" → Cloud → Remote; copy
  now says "Alevr Code".
- `testTheGhostOpensAnIncognitoSession` (copy) and `testShiftCommandNStartsAnIncognitoChat`
  (`incognito-note` → `incognito-intro`). The latter **passes**.
- `testLaunchShowsRealSignInGate`: first launch shows the welcome; Skip it. Passes on
  a fresh install, see D.
- Workspace `testProjectDetailShowsInstructionsConversationsAndFiles` and
  `testLongProjectInstructionsStartClampedAndCanBeExpanded`: project rows report as
  text; instructions moved to the foot of a lazy List (scroll to them), the toggle
  inherits the section identifier (found by "Show all"), and the toggle itself is
  the expansion marker. Still blocked by C.

Real-bug-only (test unchanged, pass once fixed):
- A: `testADraftOffersNoNewChatButton`, `testNewChatFromTheHeaderOpensADraft`,
  `testTappingAnArtifactCardOpensIt`, `testTheInlineArtifactViewerCloses`,
  `testOpeningTheMenuLeavesTheKeyboardUp`, `testTheCameraPanelClosesAndGivesTheComposerBack`,
  `testTheComposerPlusButtonOpensTheAttachmentMenuOnTap`, Dictation, Incognito ×3
  (draft not reached), LongDraft, LongPrompt, ScrollToLatest, Search ×3.
- B: `testChoosingCameraOpensTheCameraPanel`, `testChoosingPhotosOpensThePhotoPanelOverTheComposer`,
  `testChoosingLibraryOpensThePicker`, `testTheModelRowInPlusOpensTheModelList`.
- C: `testProjectHeaderPairsPinWithTheMenuInOneCapsule`, `testArtifactDetailShowsTheViewSwitchAndItsActions`.

## Reproduce

```sh
xcrun simctl create "Alevr UITests iPhone" com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro com.apple.CoreSimulator.SimRuntime.iOS-27-0
xcodebuild -project native/iOS/JunoMobile/JunoMobile.xcodeproj -scheme JunoMobile \
  -destination 'platform=iOS Simulator,id=<udid>' -derivedDataPath <scratch> \
  CODE_SIGNING_ALLOWED=NO -only-testing:JunoMobileUITests test
```

Uninstall the app first (`xcrun simctl uninstall <udid> com.liammagnier.JunoMobile.debug`)
for the launch test. iOS unit tests (`-only-testing:JunoMobileTests`) are unaffected.
