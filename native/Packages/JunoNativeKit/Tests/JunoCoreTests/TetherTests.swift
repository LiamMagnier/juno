import Foundation
import XCTest
@testable import JunoCore

/// Tether's Swift half, held to the same vectors as the web
/// (`tests/fixtures/tether-vectors.json`, also read by tests/tether.test.ts).
final class TetherTests: XCTestCase {
    private struct Fixture: Decodable {
        let constants: [String: Int]
        let delays: [Delay]
        let scenarios: [Scenario]

        struct Delay: Decodable {
            let attempt: Int
            let unit: Double
            let delayMs: Int
        }

        struct Scenario: Decodable {
            let name: String
            let online: Bool
            let steps: [Step]
        }

        struct Step: Decodable {
            let at: Int
            let event: Event
            let unit: Double
            let expect: Expect
        }

        struct Event: Decodable {
            let type: String
            let reason: String?

            var value: TetherEvent {
                switch type {
                case "drop": .drop
                case "attempt": .attempt
                case "failed": .failed
                case "connected": .connected
                case "offline": .offline
                default: .trigger(TetherTrigger(rawValue: reason ?? "") ?? .manual)
                }
            }
        }

        struct Expect: Decodable {
            let phase: String
            let attempt: Int
            let online: Bool
            let since: Int?
            let retryAt: Int?
            let retryInSeconds: Int?
        }
    }

    /// The repository root, from this file: native/Packages/JunoNativeKit/Tests/JunoCoreTests/<file>.
    private static func repositoryFile(_ path: String, file: StaticString = #filePath) -> URL {
        var url = URL(fileURLWithPath: "\(file)")
        for _ in 0..<6 { url.deleteLastPathComponent() }
        return url.appendingPathComponent(path)
    }

    private func fixture() throws -> Fixture {
        let data = try Data(contentsOf: Self.repositoryFile("tests/fixtures/tether-vectors.json"))
        return try JSONDecoder().decode(Fixture.self, from: data)
    }

    func testTheConstantsAreTheWebsConstants() throws {
        let constants = try fixture().constants
        XCTAssertEqual(constants["baseMs"], TetherPolicy.baseMs)
        XCTAssertEqual(constants["capMs"], TetherPolicy.capMs)
        XCTAssertEqual(constants["floorMs"], TetherPolicy.floorMs)
        XCTAssertEqual(constants["activeWindowMs"], TetherPolicy.activeWindowMs)
        XCTAssertEqual(constants["probeMs"], TetherPolicy.probeMs)
        XCTAssertEqual(constants["heartbeatMs"], TetherPolicy.heartbeatMs)
        XCTAssertEqual(constants["staleAfterMs"], TetherPolicy.staleAfterMs)
        XCTAssertEqual(constants.count, 7, "a constant added on one side must be added on the other")
    }

    func testDelaysMatchTheVectors() throws {
        for delay in try fixture().delays {
            XCTAssertEqual(
                TetherPolicy.delayMs(attempt: delay.attempt, unit: delay.unit),
                delay.delayMs,
                "attempt \(delay.attempt), unit \(delay.unit)"
            )
        }
        for attempt in 0..<40 {
            for unit in [0, 0.1, 0.5, 0.9, 0.9999999] {
                let delay = TetherPolicy.delayMs(attempt: attempt, unit: unit)
                XCTAssertTrue((TetherPolicy.floorMs...TetherPolicy.capMs).contains(delay))
            }
        }
    }

    func testEveryScenarioStepsLikeTheWeb() throws {
        for scenario in try fixture().scenarios {
            var state = TetherState.connected
            state.online = scenario.online
            for (index, step) in scenario.steps.enumerated() {
                state = state.step(step.event.value, now: step.at, unit: step.unit)
                let label = "\(scenario.name) — step \(index)"
                XCTAssertEqual(state.phase.rawValue, step.expect.phase, label)
                XCTAssertEqual(state.attempt, step.expect.attempt, label)
                XCTAssertEqual(state.online, step.expect.online, label)
                XCTAssertEqual(state.since, step.expect.since, label)
                XCTAssertEqual(state.retryAt, step.expect.retryAt, label)
                XCTAssertEqual(state.retryInSeconds(now: step.at), step.expect.retryInSeconds, label)
            }
        }
    }

    func testNoGiveUpHoweverLongTheOutage() {
        var state = TetherState.connected.step(.drop, now: 0, unit: 0.5)
        var now = 0
        for index in 0..<500 {
            guard let due = state.retryAt else { return XCTFail("nothing scheduled at \(index)") }
            now = due
            state = state.step(.attempt, now: now)
            state = state.step(.failed, now: now + 50, unit: Double(index % 7) / 7)
        }
        XCTAssertEqual(state.phase, .parked)
        XCTAssertGreaterThan(now, 6 * 60 * 60_000)
        let back = state.step(.trigger(.wake), now: now + 1)
        XCTAssertEqual(back.phase, .reconnecting)
        XCTAssertEqual(back.retryAt, now + 1)
    }

    /// A2: 500 clients that lost the server together never put more than 5%
    /// of their attempts in one 100 ms bucket.
    func testAHerdSpreadsOut() {
        var generator = SplitMix64(seed: 0x7E7E7)
        let outage = 5 * 60_000
        var buckets: [Int: Int] = [:]
        var attempts = 0
        for _ in 0..<500 {
            var state = TetherState.connected.step(.drop, now: 0, unit: generator.unit())
            while let due = state.retryAt, due < outage {
                buckets[due / 100, default: 0] += 1
                attempts += 1
                state = state.step(.attempt, now: due)
                state = state.step(.failed, now: due, unit: generator.unit())
            }
        }
        let worst = buckets.values.max() ?? 0
        XCTAssertLessThanOrEqual(Double(worst) / Double(attempts), 0.05, "worst bucket \(worst)/\(attempts)")
    }

    func testTheViewSaysNothingWhileConnectedAndNeverCountsDownOutsideReconnecting() {
        XCTAssertNil(TetherState.connected.view)
        let parked = TetherState(phase: .parked, attempt: 9, online: true, since: 0, retryAt: 999_999)
        XCTAssertEqual(parked.view, TetherView(phase: .parked, retryAt: nil))
        XCTAssertEqual(parked.view?.label(now: .now), "Waiting for connection")
        let reconnecting = TetherState(phase: .reconnecting, attempt: 1, online: true, since: 0, retryAt: 4_500)
        let view = try? XCTUnwrap(reconnecting.view)
        XCTAssertEqual(view?.label(now: Date(timeIntervalSince1970: 0)), "Reconnecting in 5s")
        XCTAssertEqual(view?.accessibilityLabel, "Reconnecting…", "assistive tech never hears the countdown")
        XCTAssertEqual(TetherView(phase: .waiting, retryAt: nil).label(now: .now), "Waiting for network")
    }
}

/// TetherLink under a fake clock: park, resume, triggers.
@MainActor
final class TetherLinkTests: XCTestCase {
    func testWaitsOutTheBackoffThenGoes() async {
        let clock = FakeTetherClock(unit: 0.5)
        let link = TetherLink(clock: clock)
        link.drop()
        XCTAssertEqual(link.state.retryAt, 625)
        let attempt = Task { await link.nextAttempt() }
        await settle()
        clock.advance(by: 624)
        await settle()
        XCTAssertEqual(link.state.retryAt, 625, "not before it is due")
        clock.advance(by: 1)
        let went = await attempt.value
        XCTAssertTrue(went)
        XCTAssertNil(link.state.retryAt, "an attempt is now under way")
        link.close()
    }

    func testParksPastTheWindowThenAWakeResumesAtOnce() async {
        let clock = FakeTetherClock(unit: 0.5)
        let signals = FakeTetherSignals()
        let link = TetherLink(clock: clock, signals: signals)
        var phases: [TetherPhase] = []
        link.onChange = { phases.append($0.phase) }
        link.drop()
        while clock.nowMs() < 4 * 60_000 {
            let attempt = Task { await link.nextAttempt() }
            await settle()
            clock.advance(by: TetherPolicy.probeMs)
            let went = await attempt.value
            XCTAssertTrue(went)
            link.failed()
        }
        XCTAssertEqual(link.state.phase, .parked, "parked, not given up")
        XCTAssertTrue(phases.contains(.reconnecting))

        let attempt = Task { await link.nextAttempt() }
        await settle()
        clock.advance(by: 1_000)
        await settle()
        XCTAssertNotNil(link.state.retryAt, "parked does not spin")
        signals.fire(.trigger(.wake))
        let went = await attempt.value
        XCTAssertTrue(went, "the wake started the attempt immediately")
        XCTAssertEqual(link.state.phase, .reconnecting)
        XCTAssertEqual(link.state.attempt, 0, "and reset the backoff")
        link.connected()
        XCTAssertEqual(link.state.phase, .connected)
        link.close()
    }

    func testOfflineWaitsWithoutACountdownAndTheNetworkReturningRetries() async {
        let clock = FakeTetherClock(unit: 0.9)
        let signals = FakeTetherSignals()
        let link = TetherLink(clock: clock, signals: signals)
        link.drop()
        signals.fire(.offline)
        XCTAssertEqual(link.state.phase, .waiting)
        XCTAssertNil(link.state.retryInSeconds(now: clock.nowMs()))
        let attempt = Task { await link.nextAttempt() }
        await settle()
        clock.advance(by: 10_000)
        await settle()
        XCTAssertEqual(link.state.phase, .waiting)
        signals.fire(.trigger(.network))
        let went = await attempt.value
        XCTAssertTrue(went)
        XCTAssertTrue(link.state.online)
        link.close()
    }

    func testCancellationEndsTheWaitWithFalse() async {
        let clock = FakeTetherClock(unit: 0.5)
        let link = TetherLink(clock: clock)
        link.drop()
        let attempt = Task { await link.nextAttempt() }
        await settle()
        attempt.cancel()
        let went = await attempt.value
        XCTAssertFalse(went)
        link.close()
    }

    private func settle() async {
        for _ in 0..<20 { await Task.yield() }
    }
}

// MARK: - Fakes

/// A clock that only moves when the test advances it.
private final class FakeTetherClock: TetherClock, @unchecked Sendable {
    private let lock = NSLock()
    private var now = 0
    private let fixedUnit: Double
    private var sleepers: [UUID: (at: Int, continuation: CheckedContinuation<Void, any Error>)] = [:]

    init(unit: Double) {
        fixedUnit = unit
    }

    func nowMs() -> Int {
        lock.withLock { now }
    }

    func random() -> Double { fixedUnit }

    func sleep(ms: Int) async throws {
        let id = UUID()
        try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, any Error>) in
                let resumeNow: Bool = lock.withLock {
                    if ms <= 0 { return true }
                    sleepers[id] = (now + ms, continuation)
                    return false
                }
                if resumeNow { continuation.resume() }
            }
        } onCancel: {
            let sleeper = lock.withLock { sleepers.removeValue(forKey: id) }
            sleeper?.continuation.resume(throwing: CancellationError())
        }
    }

    func advance(by ms: Int) {
        let due: [CheckedContinuation<Void, any Error>] = lock.withLock {
            now += ms
            let ready = sleepers.filter { $0.value.at <= now }
            for key in ready.keys { sleepers.removeValue(forKey: key) }
            return ready.values.map(\.continuation)
        }
        for continuation in due { continuation.resume() }
    }
}

@MainActor
private final class FakeTetherSignals: TetherSignalSource {
    var isOnline = true
    private var listener: (@MainActor (TetherSignal) -> Void)?

    func subscribe(_ listener: @escaping @MainActor (TetherSignal) -> Void) -> TetherSubscription {
        self.listener = listener
        return TetherSubscription { [weak self] in
            MainActor.assumeIsolated { self?.listener = nil }
        }
    }

    func fire(_ signal: TetherSignal) {
        listener?(signal)
    }
}

/// Deterministic randomness, so the herd test is a vector, not a dice roll.
private struct SplitMix64 {
    private var state: UInt64

    init(seed: UInt64) {
        state = seed
    }

    mutating func unit() -> Double {
        state &+= 0x9E37_79B9_7F4A_7C15
        var z = state
        z = (z ^ (z >> 30)) &* 0xBF58_476D_1CE4_E5B9
        z = (z ^ (z >> 27)) &* 0x94D0_49BB_1331_11EB
        z ^= z >> 31
        return Double(z >> 11) / Double(1 << 53)
    }
}
