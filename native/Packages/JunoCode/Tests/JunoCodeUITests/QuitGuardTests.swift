import XCTest
import JunoCodeCore
import JunoCodeRuntime
@testable import JunoCodeUI

/// Answers after a pause, long enough for the window to go away.
private final class SlowModel: AgentModelClient, @unchecked Sendable {
    func streamTurn(_ request: ModelTurnRequest) -> AsyncThrowingStream<ModelStreamEvent, Error> {
        AsyncThrowingStream { continuation in
            Task {
                try? await Task.sleep(for: .milliseconds(300))
                continuation.yield(.textDelta("Finished while you were away."))
                continuation.yield(.turnCompleted(.endTurn))
                continuation.finish()
            }
        }
    }
}

/// Quitting with runs in flight, and runs outliving the window
/// (CODE_AGENT_SPEC §1.11, §1.12).
@MainActor
final class QuitGuardTests: XCTestCase {
    func testTheQuitDecisionForNoneOneAndTwoActiveRuns() {
        XCTAssertEqual(QuitGuard.decision(activeRuns: 0), .quit)
        XCTAssertEqual(
            QuitGuard.decision(activeRuns: 1),
            .ask(
                message: "1 run is working. Quit and stop it?",
                detail: "Alevr can resume a stopped run when you open it again: it carries on from where it stopped."
            )
        )
        guard case let .ask(message, _) = QuitGuard.decision(activeRuns: 2) else {
            return XCTFail("two runs ask")
        }
        XCTAssertEqual(message, "2 runs are working. Quit and stop them?")
    }

    func testARestartOrShutdownIsNotAskedAbout() {
        XCTAssertEqual(
            QuitGuard.decision(activeRuns: 2, systemIsPoweringOff: true),
            .quit,
            "a question would cancel the restart; the runs come back interrupted, with Resume"
        )
        XCTAssertFalse(QuitGuard.installsStagedUpdate(activeRuns: 2), "the update still waits")
    }

    func testAStagedUpdateWaitsForRunsToFinish() {
        XCTAssertTrue(QuitGuard.installsStagedUpdate(activeRuns: 0))
        XCTAssertFalse(QuitGuard.installsStagedUpdate(activeRuns: 1))
        XCTAssertFalse(QuitGuard.installsStagedUpdate(activeRuns: 3))
    }

    func testJunoOutlivesItsLastWindow() {
        XCTAssertFalse(QuitGuard.terminatesAfterLastWindowClosed)
    }

    /// The window detaching a session (what closing it does) does not stop
    /// the run: it finishes, the store records it, and the Runs list hears.
    func testARunKeepsGoingWithTheWindowClosed() async throws {
        let fixture = try await ShipFixture.make(model: SlowModel())
        defer { fixture.remove() }
        let (session, controller) = try await fixture.session()
        let heard = Heard()
        fixture.workbench.runIndexObserver = { heard.lists.append($0) }

        controller.composerText = "Take your time"
        await controller.send()
        XCTAssertEqual(fixture.workbench.activeRunCount, 1, "the quit guard counts it")
        await controller.detach()

        for _ in 0..<400 {
            let current = try await fixture.workbench.sessionStore.session(id: session.id)
            if !current.status.isActive { break }
            try await Task.sleep(for: .milliseconds(10))
        }
        let finished = try await fixture.workbench.sessionStore.session(id: session.id)
        XCTAssertEqual(finished.status, .completed, "the run finished with no window attached")
        for _ in 0..<200 where fixture.workbench.activeRunCount > 0 {
            try await Task.sleep(for: .milliseconds(10))
        }
        XCTAssertEqual(fixture.workbench.activeRunCount, 0)
        XCTAssertFalse(heard.lists.isEmpty, "the run monitor kept hearing the Runs list")
        XCTAssertTrue(
            heard.lists.last?.contains { $0.sessionID == session.id && !$0.group.isLive } ?? false
                || heard.lists.last?.allSatisfy { $0.sessionID != session.id } ?? false,
            "and heard the run end"
        )
    }
}

@MainActor
private final class Heard {
    var lists: [[RunIndexEntry]] = []
}

private extension RunGroup {
    var isLive: Bool { self == .working || self == .needsYou }
}
