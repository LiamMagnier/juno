// Wave-2 native performance support (spec §9, P0 (7)), shared by the macOS
// and iOS test targets. This file is byte-identical in
// native/macOS/JunoDesktop/Tests/Performance and
// native/iOS/JunoMobile/Tests/Performance; tests/wave2-p0-native-support.test.ts
// fails if they drift.

import Foundation

/// An injectable clock whose time moves only when a test says so.
///
/// It is a real `Clock`, so code written against `any Clock<Duration>` or a
/// generic `C: Clock` takes it unchanged. The gates that need it: the Mac poll
/// (15s, then 60s after 2 minutes idle; nothing while occluded) and dock-pane
/// eviction after 10 minutes. A test advances ten minutes in a microsecond:
///
///     let clock = Wave2TestClock()
///     let poller = Poller(clock: clock)
///     clock.advance(by: .seconds(120))
///     #expect(poller.interval == .seconds(60))
final class Wave2TestClock: Clock, @unchecked Sendable {
    struct Instant: InstantProtocol {
        var offset: Duration

        func advanced(by duration: Duration) -> Instant { Instant(offset: offset + duration) }
        func duration(to other: Instant) -> Duration { other.offset - offset }
        static func < (lhs: Instant, rhs: Instant) -> Bool { lhs.offset < rhs.offset }
    }

    private struct Sleeper {
        let id: UInt64
        let deadline: Instant
        let continuation: CheckedContinuation<Void, any Error>
    }

    private let lock = NSLock()
    private var current: Instant
    private var sleepers: [Sleeper] = []
    private var cancelled: Set<UInt64> = []
    private var nextID: UInt64 = 0
    /// The wall-clock date that offset zero stands for, for code that reads `Date`.
    let epoch: Date

    init(epoch: Date = Date(timeIntervalSince1970: 1_800_000_000)) {
        self.epoch = epoch
        self.current = Instant(offset: .zero)
    }

    var now: Instant { lock.withLock { current } }
    var minimumResolution: Duration { .zero }

    /// `now` as a `Date`, for code that takes a `() -> Date`.
    var date: Date {
        let offset = now.offset.components
        return epoch.addingTimeInterval(Double(offset.seconds) + Double(offset.attoseconds) / 1e18)
    }

    /// Sleepers still waiting for time to reach their deadline.
    var pendingSleepers: Int { lock.withLock { sleepers.count } }

    func sleep(until deadline: Instant, tolerance: Duration? = nil) async throws {
        try Task.checkCancellation()
        let id: UInt64 = lock.withLock {
            nextID += 1
            return nextID
        }
        try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, any Error>) in
                enum Outcome { case wait, fire, cancel }
                let outcome: Outcome = lock.withLock {
                    if cancelled.remove(id) != nil { return .cancel }
                    if deadline <= current { return .fire }
                    sleepers.append(Sleeper(id: id, deadline: deadline, continuation: continuation))
                    return .wait
                }
                switch outcome {
                case .wait: break
                case .fire: continuation.resume()
                case .cancel: continuation.resume(throwing: CancellationError())
                }
            }
        } onCancel: {
            let sleeper: Sleeper? = lock.withLock {
                if let index = sleepers.firstIndex(where: { $0.id == id }) {
                    return sleepers.remove(at: index)
                }
                // Cancelled before the continuation was registered.
                cancelled.insert(id)
                return nil
            }
            sleeper?.continuation.resume(throwing: CancellationError())
        }
    }

    /// Moves time forward and wakes every sleeper whose deadline has passed,
    /// earliest first.
    func advance(by duration: Duration) {
        precondition(duration >= .zero, "Wave2TestClock never moves backwards")
        let due: [Sleeper] = lock.withLock {
            current = current.advanced(by: duration)
            let now = current
            let ready = sleepers.filter { $0.deadline <= now }.sorted { $0.deadline < $1.deadline }
            sleepers.removeAll { $0.deadline <= now }
            return ready
        }
        for sleeper in due { sleeper.continuation.resume() }
    }

    /// Advances in steps so work scheduled by a woken sleeper (a poll that
    /// re-arms itself) gets to run before time moves on.
    func run(for duration: Duration, step: Duration) async {
        precondition(step > .zero, "step must be positive")
        var elapsed = Duration.zero
        while elapsed < duration {
            let next = min(step, duration - elapsed)
            advance(by: next)
            elapsed += next
            await Task.yield()
            await Task.yield()
        }
    }
}
