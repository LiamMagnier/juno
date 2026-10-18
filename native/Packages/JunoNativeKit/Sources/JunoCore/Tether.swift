import Foundation

// Tether: the one reconnect policy every Alevr client follows when a live
// stream drops while a turn is still in flight.
//
// The Swift twin of `src/lib/net/tether.ts`. Both are held to
// `tests/fixtures/tether-vectors.json` (JunoCoreTests/TetherTests.swift and
// tests/tether.test.ts), so a constant or a transition that changes here and
// not there fails a test on both sides. Design:
// docs/rea/designs/reliability-and-native.md §3.1.
//
//  1. Backoff with full jitter: retry n waits uniformly between `floorMs` and
//     min(`capMs`, `baseMs` * 2^n), so a fleet that lost the server together
//     does not come back together.
//  2. Triggers skip the wait: the network returning (NWPathMonitor), the app
//     becoming active and the Mac waking start an attempt at once and reset
//     the backoff.
//  3. No give-up while a turn is in flight: past the active window the turn
//     parks ("Waiting for connection"), keeps its seq cursor, probes slowly,
//     and retries the moment a trigger fires.
//  4. Truthful states: reconnecting, waiting (no network), parked, connected.
//
// Times are whole milliseconds on the caller's clock, as in the TypeScript.

/// The shared constants (the fixture's `constants`).
public enum TetherPolicy {
    public static let baseMs = 1_000
    public static let capMs = 30_000
    public static let floorMs = 250
    public static let activeWindowMs = 3 * 60_000
    public static let probeMs = 60_000
    public static let heartbeatMs = 15_000
    public static let staleAfterMs = 2 * 15_000

    /// The wait before retry number `attempt` (0-based), for a uniform `unit`
    /// in [0, 1). Floored to whole milliseconds so both platforms agree.
    public static func delayMs(attempt: Int, unit: Double) -> Int {
        let doublings = min(max(0, attempt), 30)
        let ceiling = min(Double(capMs), Double(baseMs) * pow(2, Double(doublings)))
        let clamped = min(max(unit, 0), 1)
        return Int((Double(floorMs) + clamped * (ceiling - Double(floorMs))).rounded(.down))
    }
}

public enum TetherPhase: String, Sendable, Equatable, Codable {
    case connected
    case reconnecting
    case waiting
    case parked
}

/// What made an attempt start early. `manual` is a person pressing something.
public enum TetherTrigger: String, Sendable, Equatable, Codable {
    case network
    case foreground
    case wake
    case manual
}

public enum TetherEvent: Sendable, Equatable {
    /// The live stream ended or failed without the turn's terminal frame.
    case drop
    /// The timer (or a trigger) said go: an attempt is now under way.
    case attempt
    /// An attempt failed before any frame arrived.
    case failed
    /// Frames are flowing again.
    case connected
    /// The device reports no network.
    case offline
    case trigger(TetherTrigger)
}

public struct TetherState: Sendable, Equatable {
    public var phase: TetherPhase
    /// Retries since the outage (or the last trigger) began.
    public var attempt: Int
    /// Whether the device reports a network. Only `offline` clears it.
    public var online: Bool
    /// When the current active window started.
    public var since: Int?
    /// When the next attempt is due; nil while connected and while an attempt
    /// is under way (a trigger then does not start a second one).
    public var retryAt: Int?

    public init(phase: TetherPhase, attempt: Int, online: Bool, since: Int?, retryAt: Int?) {
        self.phase = phase
        self.attempt = attempt
        self.online = online
        self.since = since
        self.retryAt = retryAt
    }

    public static let connected = TetherState(phase: .connected, attempt: 0, online: true, since: nil, retryAt: nil)

    /// The policy. `unit` is a uniform random number in [0, 1); only the
    /// events that schedule a backoff read it.
    public func step(_ event: TetherEvent, now: Int, unit: Double = 0) -> TetherState {
        switch event {
        case .connected:
            return .connected
        case .drop:
            if phase == .connected { return backingOff(now: now, unit: unit, attempt: 0, since: now) }
            return step(.failed, now: now, unit: unit)
        case .failed:
            if phase == .connected { return self }
            return backingOff(now: now, unit: unit, attempt: attempt + 1, since: since ?? now)
        case .attempt:
            if phase == .connected { return self }
            var next = self
            next.retryAt = nil
            return next
        case .offline:
            var next = self
            next.online = false
            // Connected: the stream will fail on its own. Under way: let the
            // attempt fail. Scheduled: pointless until the network is back.
            if phase == .connected || retryAt == nil { return next }
            next.phase = .waiting
            next.retryAt = now + TetherPolicy.probeMs
            return next
        case .trigger(let reason):
            let isOnline = reason == .network ? true : online
            if phase == .connected {
                var next = self
                next.online = isOnline
                return next
            }
            return TetherState(
                phase: .reconnecting,
                attempt: 0,
                online: isOnline,
                since: now,
                retryAt: retryAt == nil ? nil : now
            )
        }
    }

    private func backingOff(now: Int, unit: Double, attempt: Int, since: Int) -> TetherState {
        if !online {
            return TetherState(phase: .waiting, attempt: attempt, online: false, since: since, retryAt: now + TetherPolicy.probeMs)
        }
        if now - since >= TetherPolicy.activeWindowMs {
            return TetherState(phase: .parked, attempt: attempt, online: true, since: since, retryAt: now + TetherPolicy.probeMs)
        }
        return TetherState(
            phase: .reconnecting,
            attempt: attempt,
            online: true,
            since: since,
            retryAt: now + TetherPolicy.delayMs(attempt: attempt, unit: unit)
        )
    }

    /// Whole seconds until the next attempt, for "Reconnecting in 5s"; nil
    /// when nothing is counting down.
    public func retryInSeconds(now: Int) -> Int? {
        guard phase == .reconnecting, let retryAt else { return nil }
        let ms = retryAt - now
        return ms > 0 ? Int((Double(ms) / 1_000).rounded(.up)) : nil
    }

    /// What a transcript shows; nil while connected.
    public var view: TetherView? {
        switch phase {
        case .connected: nil
        case .reconnecting: TetherView(phase: .reconnecting, retryAt: retryAt.map(TetherView.date(fromMs:)))
        case .waiting: TetherView(phase: .waiting, retryAt: nil)
        case .parked: TetherView(phase: .parked, retryAt: nil)
        }
    }
}

/// A turn's connection as the transcript draws it. Absent means connected.
public struct TetherView: Sendable, Equatable {
    public let phase: TetherPhase
    /// When the next attempt is due, only while reconnecting.
    public let retryAt: Date?

    public init(phase: TetherPhase, retryAt: Date?) {
        self.phase = phase
        self.retryAt = retryAt
    }

    static func date(fromMs ms: Int) -> Date {
        Date(timeIntervalSince1970: Double(ms) / 1_000)
    }

    /// Whole seconds until the next attempt, nil when none is counting down.
    public func retryInSeconds(now: Date) -> Int? {
        guard phase == .reconnecting, let retryAt else { return nil }
        let seconds = retryAt.timeIntervalSince(now)
        return seconds > 0 ? Int(seconds.rounded(.up)) : nil
    }

    /// The words, as the shared string table has them (`turn.reconnecting`,
    /// `turn.reconnectingIn`, `turn.waitingForNetwork`, `turn.parked`).
    public func label(now: Date) -> String {
        switch phase {
        case .connected:
            return ""
        case .reconnecting:
            if let seconds = retryInSeconds(now: now) {
                return String(localized: "Reconnecting in \(seconds)s")
            }
            return String(localized: "Reconnecting…")
        case .waiting:
            return String(localized: "Waiting for network")
        case .parked:
            return String(localized: "Waiting for connection")
        }
    }

    /// The words without a countdown, for a place that does not redraw each
    /// second.
    public var phaseLabel: String {
        switch phase {
        case .connected: ""
        case .reconnecting: String(localized: "Reconnecting…")
        case .waiting: String(localized: "Waiting for network")
        case .parked: String(localized: "Waiting for connection")
        }
    }

    /// What assistive tech hears: the phase, never a ticking number.
    public var accessibilityLabel: String {
        switch phase {
        case .connected: ""
        case .reconnecting: String(localized: "Reconnecting…")
        case .waiting: String(localized: "Waiting for network")
        case .parked:
            String(localized: "Waiting for connection. The answer will continue where it left off when the connection is back.")
        }
    }
}

// MARK: - Driver

/// Time and randomness, injectable for fake-clock tests.
public protocol TetherClock: Sendable {
    func nowMs() -> Int
    func random() -> Double
    func sleep(ms: Int) async throws
}

public struct SystemTetherClock: TetherClock {
    public init() {}

    public func nowMs() -> Int {
        Int((Date().timeIntervalSince1970 * 1_000).rounded(.down))
    }

    public func random() -> Double {
        Double.random(in: 0..<1)
    }

    public func sleep(ms: Int) async throws {
        try await Task.sleep(for: .milliseconds(ms))
    }
}

/// One dropped turn's reconnect state.
///
///     let link = TetherLink(signals: TetherSignals.shared)
///     link.drop()
///     while await link.nextAttempt() {
///         … try; on the first frame link.connected(); on a drop link.drop() …
///     }
///
/// `nextAttempt()` returns true when it is time to try (the backoff ran out
/// or a trigger fired) and false only when the task is cancelled. It never
/// gives up on its own.
@MainActor
public final class TetherLink {
    public private(set) var state: TetherState
    /// Called on every state change.
    public var onChange: ((TetherState) -> Void)?

    private let clock: any TetherClock
    private var subscription: TetherSubscription?
    /// The suspended ``nextAttempt()``, if one is waiting.
    private var waiter: CheckedContinuation<Void, Never>?

    public init(clock: any TetherClock = SystemTetherClock(), signals: (any TetherSignalSource)? = nil) {
        self.clock = clock
        self.state = TetherState.connected
        if let signals {
            state.online = signals.isOnline
            subscription = signals.subscribe { [weak self] signal in
                switch signal {
                case .offline: self?.dispatch(.offline)
                case .trigger(let reason): self?.dispatch(.trigger(reason))
                }
            }
        }
    }

    public func drop() { dispatch(.drop) }
    public func failed() { dispatch(.failed) }
    public func trigger(_ reason: TetherTrigger) { dispatch(.trigger(reason)) }

    public func connected() {
        guard state.phase != .connected else { return }
        dispatch(.connected)
    }

    public func dispatch(_ event: TetherEvent) {
        let next = state.step(event, now: clock.nowMs(), unit: clock.random())
        guard next != state else { return }
        state = next
        onChange?(next)
        wake()
    }

    /// Waits until the next attempt is due, or a trigger moves it forward.
    public func nextAttempt() async -> Bool {
        while !Task.isCancelled {
            guard state.phase != .connected, let due = state.retryAt else {
                // Nothing scheduled: only reachable before the first drop, or
                // with an attempt somehow under way. Go rather than hang.
                dispatch(.attempt)
                return true
            }
            let wait = due - clock.nowMs()
            if wait <= 0 {
                dispatch(.attempt)
                return true
            }
            await sleepOrWake(ms: wait)
        }
        return false
    }

    /// Stops listening for triggers. The link is finished after this.
    public func close() {
        subscription?.cancel()
        subscription = nil
        wake()
    }

    /// Suspends until `ms` have passed on the clock, the state changes, or the
    /// task is cancelled — whichever is first. Everything here runs on the
    /// main actor, so the waiter is always installed before anything can
    /// resume it.
    private func sleepOrWake(ms: Int) async {
        let clock = self.clock
        let timer = Task { [weak self] in
            try? await clock.sleep(ms: ms)
            // A cancelled timer belongs to a wait that already ended.
            guard !Task.isCancelled else { return }
            self?.wake()
        }
        await withTaskCancellationHandler {
            await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
                if Task.isCancelled {
                    continuation.resume()
                } else {
                    waiter = continuation
                }
            }
        } onCancel: {
            Task { @MainActor [weak self] in self?.wake() }
        }
        timer.cancel()
    }

    private func wake() {
        let pending = waiter
        waiter = nil
        pending?.resume()
    }
}

// MARK: - Triggers

public enum TetherSignal: Sendable, Equatable {
    case offline
    case trigger(TetherTrigger)
}

/// Where triggers come from: ``TetherSignals/shared`` in the apps, a fake in tests.
@MainActor
public protocol TetherSignalSource: AnyObject {
    var isOnline: Bool { get }
    func subscribe(_ listener: @escaping @MainActor (TetherSignal) -> Void) -> TetherSubscription
}

/// Cancels a ``TetherSignalSource`` subscription.
@MainActor
public final class TetherSubscription {
    private var cancelAction: (() -> Void)?

    public init(_ cancel: @escaping () -> Void) {
        cancelAction = cancel
    }

    public func cancel() {
        cancelAction?()
        cancelAction = nil
    }
}
