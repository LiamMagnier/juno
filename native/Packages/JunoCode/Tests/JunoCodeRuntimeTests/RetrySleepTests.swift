import XCTest
import JunoCodeRuntime

/// Keep a second client file using the public initializer's default sleeper.
/// Xcode 26 used to link inconsistent async frames emitted by these clients,
/// aborting the process when cancellation unwound the default closure.
final class RetrySleepTests: XCTestCase {
    func testDefaultSleeperCanBeCancelledWhileWaiting() async throws {
        let sleep = AgentOrchestrator.Configuration(systemPrompt: "sys").retrySleep
        for _ in 0..<10 {
            let task = Task { try await sleep(.seconds(30)) }
            try await Task.sleep(nanoseconds: 10_000_000)
            let started = ContinuousClock.now
            task.cancel()
            do {
                try await task.value
                XCTFail("A cancelled retry must throw")
            } catch is CancellationError {
                XCTAssertLessThan(ContinuousClock.now - started, .seconds(2))
            }
        }
    }

    func testDefaultSleeperFinishesAFractionalDelay() async throws {
        let sleep = AgentOrchestrator.Configuration(systemPrompt: "sys").retrySleep
        let started = ContinuousClock.now
        try await sleep(.milliseconds(20))
        XCTAssertGreaterThanOrEqual(ContinuousClock.now - started, .milliseconds(20))
    }
}
