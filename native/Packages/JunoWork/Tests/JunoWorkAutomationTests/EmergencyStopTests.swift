import Foundation
import XCTest

@testable import JunoWorkAutomation

final class EmergencyStopTests: XCTestCase {
    private let activity = AutomationActivity(
        tier: .visual,
        intent: .activateControl,
        subject: .app(bundleIdentifier: "com.example.notes")
    )

    private func refusalCode(_ error: any Error) -> AutomationRefusal.Code? {
        (error as? AutomationRefusal)?.code
    }

    // MARK: - Ordinary running

    func testAnActionRunsAndClearsTheIndicatorAfterwards() async throws {
        let stop = EmergencyStop()
        let token = try await stop.begin(runID: "run-1", activity: activity)
        try await stop.checkpoint(token)

        let active = await stop.activeUse
        XCTAssertEqual(active?.runID, "run-1")
        XCTAssertEqual(active?.activity, activity)

        await stop.end(token)
        let cleared = await stop.activeUse
        XCTAssertNil(cleared)
    }

    /// An agent driving somebody's screen with no indicator is
    /// indistinguishable from malware, so the state a UI renders is set by the
    /// same call that authorises the action rather than by the UI remembering.
    func testTheIndicatorNamesTheTierAndTheTargetAndNothingElse() async throws {
        let stop = EmergencyStop()
        let token = try await stop.begin(runID: "run-1", activity: activity)
        try await stop.note(token)

        let current = await stop.activeUse
        let active = try XCTUnwrap(current)
        XCTAssertEqual(active.actionCount, 1)
        XCTAssertTrue(active.phrase.contains("screen control"), active.phrase)
        XCTAssertTrue(active.phrase.contains("app:com.example.notes"), active.phrase)
    }

    func testObserversSeeTheCurrentStateImmediatelyAndOnEveryChange() async throws {
        let stop = EmergencyStop()
        let seen = Recorder()
        await stop.addObserver { use in seen.append(use?.runID) }

        let token = try await stop.begin(runID: "run-1", activity: activity)
        await stop.end(token)
        await stop.stop()

        // The observer is called synchronously inside the actor but forwards to
        // its own; give those forwards a chance to land before asserting.
        try await Task.sleep(for: .milliseconds(50))
        let states = seen.values
        XCTAssertEqual(states.first, .some(nil), "An observer should learn the state it joined at.")
        XCTAssertTrue(states.contains(.some("run-1")))
    }

    // MARK: - Stopping

    /// Stopping is total. Nothing queued behind it starts.
    func testNothingStartsAfterAStop() async {
        let stop = EmergencyStop()
        await stop.stop(reason: "You stopped Juno.")
        do {
            _ = try await stop.begin(runID: "run-2", activity: activity)
            XCTFail("A stopped switch must not admit new work.")
        } catch {
            XCTAssertEqual(refusalCode(error), .emergencyStopped)
        }
        let active = await stop.activeUse
        XCTAssertNil(active)
    }

    /// The mid-await case, which is the one that matters. A control suspended in
    /// a driver call when the stop fired is holding a screenshot and a click,
    /// and the checkpoint on the far side of the suspension is what stops the
    /// click being delivered.
    func testAControlThatWasMidAwaitWhenTheStopFiredDoesNotComplete() async throws {
        let stop = EmergencyStop()
        let token = try await stop.begin(runID: "run-1", activity: activity)
        let driver = SlowDriver()

        let work = Task { () -> Bool in
            _ = await driver.captureTakingAWhile()
            do {
                try await stop.checkpoint(token)
                return true
            } catch {
                return false
            }
        }

        await driver.waitUntilStarted()
        await stop.stop()
        await driver.finish()

        let completed = await work.value
        XCTAssertFalse(completed, "The action must not resume past a stop.")
    }

    func testAStopWhileNothingIsRunningIsSafeAndSticky() async {
        let stop = EmergencyStop()
        await stop.stop()
        await stop.stop()
        let stopped = await stop.isStopped
        XCTAssertTrue(stopped)
    }

    /// A model that can clear its own stop has not been stopped.
    func testOnlyAPersonCanStartAutomationAgain() async throws {
        let stop = EmergencyStop()
        await stop.stop()
        do {
            try await stop.resume(afterHumanGesture: false)
            XCTFail("Resuming without a gesture must fail.")
        } catch {
            XCTAssertEqual(refusalCode(error), .emergencyStopped)
        }
        let stillStopped = await stop.isStopped
        XCTAssertTrue(stillStopped)

        try await stop.resume(afterHumanGesture: true)
        let running = await stop.isStopped
        XCTAssertFalse(running)
        _ = try await stop.begin(runID: "run-3", activity: activity)
    }

    /// A Mac that has never switched automation on starts stopped, so the
    /// switch's default is the same as every other default in this module.
    func testItCanStartStopped() async {
        let stop = EmergencyStop(stopped: true)
        let stopped = await stop.isStopped
        XCTAssertTrue(stopped)
        let reason = await stop.reason
        XCTAssertNotNil(reason)
    }

    // MARK: - Tokens

    /// Not a queue. A queued action is an action that runs after a stop, which
    /// is the exact thing this type exists to make impossible.
    func testASecondActionCannotStartWhileOneIsRunning() async throws {
        let stop = EmergencyStop()
        _ = try await stop.begin(runID: "run-1", activity: activity)
        do {
            _ = try await stop.begin(runID: "run-2", activity: activity)
            XCTFail("Two actions must not run at once.")
        } catch {
            XCTAssertEqual(refusalCode(error), .tooFast)
        }
    }

    /// A token that has been ended cannot be used for a second action without
    /// going through the whole gate again.
    func testAFinishedTokenIsSpent() async throws {
        let stop = EmergencyStop()
        let token = try await stop.begin(runID: "run-1", activity: activity)
        await stop.end(token)
        do {
            try await stop.checkpoint(token)
            XCTFail("A spent token must not pass a checkpoint.")
        } catch {
            XCTAssertEqual(refusalCode(error), .emergencyStopped)
        }
    }

    /// A stop followed by a resume does not revive the token that was in flight
    /// when it fired: the generation moved twice, and the action that was
    /// interrupted has to be asked for again.
    func testResumingDoesNotRevivePreviouslyInterruptedWork() async throws {
        let stop = EmergencyStop()
        let token = try await stop.begin(runID: "run-1", activity: activity)
        await stop.stop()
        try await stop.resume(afterHumanGesture: true)
        do {
            try await stop.checkpoint(token)
            XCTFail("An interrupted action must not resume itself.")
        } catch {
            XCTAssertEqual(refusalCode(error), .emergencyStopped)
        }
    }
}

// MARK: - Helpers

/// Collects observer callbacks off the actor that produced them.
private final class Recorder: @unchecked Sendable {
    private let lock = NSLock()
    private var storedValues: [String?] = []

    var values: [String?] {
        lock.withLock { storedValues }
    }

    func append(_ value: String?) {
        lock.withLock { storedValues.append(value) }
    }
}

/// A driver that suspends until a test lets it finish, so the window in which a
/// stop can land mid-action is a real one rather than a guess about timing.
private actor SlowDriver {
    private var started: CheckedContinuation<Void, Never>?
    private var release: CheckedContinuation<Void, Never>?
    private var hasStarted = false
    private var released = false

    func captureTakingAWhile() async -> Data {
        hasStarted = true
        started?.resume()
        started = nil
        if !released {
            await withCheckedContinuation { continuation in release = continuation }
        }
        return Data()
    }

    func waitUntilStarted() async {
        if hasStarted { return }
        await withCheckedContinuation { continuation in started = continuation }
    }

    func finish() {
        released = true
        release?.resume()
        release = nil
    }
}
