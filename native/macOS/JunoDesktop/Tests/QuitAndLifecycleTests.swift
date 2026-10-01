import AppKit
import Foundation
import JunoCodeUI
import Testing
@testable import JunoDesktop

/// Quitting with Juno Code runs in flight, and runs outliving the window
/// (CODE_AGENT_SPEC §1.11, §1.12). Pure decisions: nothing quits, no alert is
/// shown, no window opens.
@MainActor
struct QuitAndLifecycleTests {
    @Test
    func nothingWorkingQuitsAtOnceWithoutAsking() {
        var asked = false
        let reply = DesktopLifecycle.terminateReply(activeRuns: 0) { _, _ in
            asked = true
            return true
        }
        #expect(reply == .terminateNow)
        #expect(!asked)
    }

    @Test
    func oneRunAsksAndKeepWorkingCancelsTheQuit() {
        var question: String?
        let reply = DesktopLifecycle.terminateReply(activeRuns: 1) { message, _ in
            question = message
            return false
        }
        #expect(reply == .terminateCancel)
        #expect(question == "1 run is working. Quit and stop it?")
    }

    @Test
    func twoRunsAskAndQuitStopsThem() {
        var question: String?
        let reply = DesktopLifecycle.terminateReply(activeRuns: 2) { message, _ in
            question = message
            return true
        }
        #expect(reply == .terminateNow)
        #expect(question == "2 runs are working. Quit and stop them?")
    }

    @Test
    func aRestartWithRunsWorkingQuitsWithoutAsking() {
        var asked = false
        let reply = DesktopLifecycle.terminateReply(activeRuns: 2, systemIsPoweringOff: true) { _, _ in
            asked = true
            return false
        }
        #expect(reply == .terminateNow)
        #expect(!asked)
    }

    @Test
    func theStagedUpdateWaitsWhileRunsWork() {
        #expect(DesktopLifecycle.installsStagedUpdate(activeRuns: 0))
        #expect(!DesktopLifecycle.installsStagedUpdate(activeRuns: 1))
        #expect(!DesktopLifecycle.installsStagedUpdate(activeRuns: 2))
    }

    /// Runs, notifications and the menu bar item outlive the last window;
    /// this used to be only a code comment.
    @Test
    func closingTheLastWindowKeepsTheAppAndItsRunsAlive() {
        #expect(DesktopLifecycle.terminatesAfterLastWindowClosed == false)
    }
}
