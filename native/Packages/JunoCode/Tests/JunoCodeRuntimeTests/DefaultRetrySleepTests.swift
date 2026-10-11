import XCTest
@testable import JunoCodeRuntime

/// A second client file exercises the real default as well as ModelRetryTests.
/// A public default-argument async closure could acquire a mismatched frame
/// layout when Swift 6.3 links those independently compiled clients.
final class DefaultRetrySleepTests: XCTestCase {
    func testDefaultSleepHonoursItsDeadline() async throws {
        let configuration = AgentOrchestrator.Configuration(systemPrompt: "fixture")
        let started = ContinuousClock.now
        try await configuration.retrySleep(.milliseconds(20))
        XCTAssertGreaterThanOrEqual(ContinuousClock.now - started, .milliseconds(20))
    }

    func testDefaultSleepPropagatesCancellationPromptly() async throws {
        let configuration = AgentOrchestrator.Configuration(systemPrompt: "fixture")
        let task = Task { try await configuration.retrySleep(.seconds(30)) }
        try await ContinuousClock().sleep(for: .milliseconds(20))
        let started = ContinuousClock.now
        task.cancel()
        do {
            try await task.value
            XCTFail("A cancelled backoff must throw")
        } catch is CancellationError {
            XCTAssertLessThan(ContinuousClock.now - started, .seconds(1))
        }
    }
}
