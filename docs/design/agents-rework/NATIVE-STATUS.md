# Agents rework: native status

2026-09-27. Branch `agents/rework-native` (worktree `juno-agents-native`). Paused by the
owner at a safe point. The spec is `DIRECTION.md` in this folder.

## Done (commit 36347c9e)

Shared views live in `native/Packages/JunoNativeKit/Sources/JunoWorkKit/Agents/Views/`.

- **Agents home** (`NativeAgentsScreen.swift`) replaces the roster, the template grid and
  the hire sheet on both apps.
  - Headline "Who should take care of it?" in the display italic, then a composer ("Describe
    a job. An agent will set itself up.") and three suggestion lines from the template first
    goals. A suggestion fills the composer and never sends.
  - Send calls `NativeAgentsModel.startAgent()`: `POST /api/agents` with the name
    "New agent" and no avatar, so the server seeds the face. It then resolves the thread and
    hands `(conversationID, sentence)` to the app. The Mac (`DesktopAccountScreens.startAgentThread`)
    and the iPhone (`JunoMobileRootView.startAgentThread`) open the thread and send through
    `NativeConversationModel.sendMessage`.
  - "Your agents" shows a card grid on the Mac and a list on the iPhone. Each has the face at 72
    on a static tonal halo (`NativeAgentHalo`), the name and the live sentence. "Needs you" is
    accent text with the hand. Pinned agents come first (`homeOrder`). Tapping opens the thread.
- **Presence header** (`NativeAgentThreadHeader.swift`), used by the Mac `DesktopAgentThreadHeader`
  and the iPhone thread:
  - face 40 + halo, the name and the live sentence;
  - Computer (only when the agent has one), Profile, and a menu with Pause/Resume, Pin and Retire;
  - the quiet "Using its computer" line.
- **Empty-thread greeting** (`NativeAgentGreeting`): face 96 + halo, "Hi, I'm Wren." in the
  display italic, the promise line and three suggestions that seed the composer. It is used on
  both apps.
- **Profile sheet** (`NativeAgentProfileSheet.swift`) replaces the five-tab page. Its sections
  are prose and each hides when empty: Needs you (the existing Work gate cards), Working on,
  Goals (check = achieve), Routines (pause switch via `NativeWorkAutomationClient`), What it
  knows (forget), What it can use (remove app, computer Open / Turn off) and How much it asks.
  The footer has Pause and Retire. There are no text fields.
- **Computer**: `NativeAgentComputerScreen` is a large sheet on the Mac and a full-screen cover
  on the iPhone. It keeps the one-time handoff `WKWebView`, Take control / Hand back and the
  heartbeat.
- **Mac routing**
  - The `.agent` and `.newAgent` page routes and the hire sheet are gone.
  - A sidebar agent row opens the thread. The row is face + name, with the accent hand while
    the agent waits. There is no count.
  - ⌘K "New agent" and the sidebar plus open Agents home and focus its composer
    (`requestCompose`).
  - Notifications and `/agents/<id>` open the thread and present the profile.
- **iPhone routing**: notifications open the thread and present the profile. The header's
  Profile presents the sheet from the root.
- **Model and wire changes**
  - `NativeAgent.pinnedAt` is decoded and optional. `NativeAgentPatch.pinned` goes through the
    existing `PATCH /api/agents/{id}`. No new routes were added.
  - `NativeAgentDraft.avatar` is now optional; the hire body omits it when nil.
  - `NativeAgentTemplate.all` is untouched.
- **Removed**: `NativeAgentHire.swift`, `NativeAgentPage.swift` and `NativeAgentProfile.swift`.
- **Tests**
  - Snapshot fixtures updated: `PageSnapshotTestsC` now has `agents-home`, `agents-home-empty`,
    `agent-profile`, `agent-thread` and `window-agents`; `FinalSnapshotTests` has
    `window-agents`; `SignalsSnapshotTests` has the thread headers.
  - Navigation tests updated for the removed agent route.
  - Two new unit tests: pinned-first ordering, and a blank hire that sends the name only.

## Gate results so far

- `npm run native:design:check`: all 6 gates hold.
- `npx tsx --test tests/agents-contract.test.ts`: 5/5 pass.
- `npm run native:sync:check`: all 13 gates hold.
- `npm run native:test JunoNativeKit`: all JunoWorkKit tests pass, including the new agent tests.
  Three failures remain, all in untouched code and pre-existing:
  - `PreviewWorldTests`: preview email;
  - `JunoTokenConsumptionTests`: `JunoGeneratedRadius.stage` unread;
  - `JunoTokenConsumptionTests`: hand-typed colours in `JunoMobileIncognito` and `JunoMobilePremium`.
- **Mac Debug and Stable**: both build with `CODE_SIGNING_ALLOWED=NO`. With
  `SWIFT_TREAT_WARNINGS_AS_ERRORS=YES` both fail, but only on existing lines this change does
  not touch:
  - Xcode 27 GA deprecation of `Text +` in `ApprovalCard`, `ChatSkillCaptureSheet`,
    `ChatWorkApprovals` and `ChatWorkRunCard`;
  - duplicate `case .skills` / `.assistants` in `DesktopAccountScreens`;
  - an unused `withAnimation` result in `DesktopChatWorkspace`;
  - a warning in `JunoDesktopRootView`.

  Only Xcode.app 27 GA is installed; Xcode-beta is not present.
- `-only-testing:JunoDesktopTests`: 432 tests in 67 suites pass.
- **iOS**: the simulator build succeeds and JunoMobileTests pass (82).

## Snapshots reviewed

These are in the session scratchpad, not committed:

- Mac: `pages/agents-home`, `pages/agents-home-empty`, `pages/agent-profile`, `pages/agent-thread`
  and `pages/window-agents`, each in `-light` and `-dark`.
- iPhone: `ios/home`, `ios/profile` and `ios/thread`, each in `-light` and `-dark`. These were
  rendered by a temporary test that has since been removed; the renders themselves have not
  been reviewed yet.

## Next steps

1. Review the iPhone renders (home, profile, thread) and polish spacing on the phone.
2. Decide whether the "Take control" handoff should open straight from the header on the phone.
3. Consider a picture-in-picture computer tile above the composer (DIRECTION.md). It is not
   built.
4. Fix or baseline the pre-existing warnings-as-errors failures (a separate lane), so the
   strict Mac builds go green.
5. Signed-in manual check of the send flow: hire, thread, first message, agent self-setup.
