import Foundation

/// The sentinel written at launch and removed on a clean exit. Still on disk
/// at the next launch, it means the previous run ended without saying so: a
/// crash, a hang the person force-quit, `kill -9`, a power cut.
public struct JunoRunSentinel: Codable, Sendable, Equatable {
    public var pid: Int32
    public var version: String
    public var startedAt: Date
    /// iOS: the app reached the background with its state saved. The system
    /// ends suspended apps as a matter of course, so a sentinel marked here is
    /// not an unclean exit.
    public var backgrounded: Bool

    public init(pid: Int32, version: String, startedAt: Date, backgrounded: Bool = false) {
        self.pid = pid
        self.version = version
        self.startedAt = startedAt
        self.backgrounded = backgrounded
    }
}

/// The recent unclean exits, for the crash-loop guard.
public struct JunoRecoveryLedger: Codable, Sendable, Equatable {
    public var uncleanExits: [Date]

    public init(uncleanExits: [Date] = []) {
        self.uncleanExits = uncleanExits
    }
}

/// The numbers the guard works by.
public struct JunoRecoveryPolicy: Sendable, Equatable {
    /// This many unclean exits inside ``crashLoopWindow`` start safe mode.
    public var crashLoopCount: Int
    public var crashLoopWindow: TimeInterval
    /// A run that lasts this long is stable: the unclean-exit count resets.
    public var stableAfter: TimeInterval

    public init(crashLoopCount: Int = 2, crashLoopWindow: TimeInterval = 600, stableAfter: TimeInterval = 300) {
        self.crashLoopCount = crashLoopCount
        self.crashLoopWindow = crashLoopWindow
        self.stableAfter = stableAfter
    }

    public static let standard = JunoRecoveryPolicy()
}

/// What the launch found.
public struct JunoLaunchAssessment: Sendable, Equatable {
    public enum Kind: Sendable, Equatable {
        /// The previous run ended cleanly, or there was none.
        case clean
        /// The previous run ended uncleanly: restore it and say so, once.
        case recovered
        /// Unclean exits in a row: start with the optional subsystems off.
        case safeMode
    }

    public var kind: Kind
    /// What was on screen, when the previous run ended uncleanly and left a
    /// snapshot worth restoring.
    public var snapshot: JunoSessionSnapshot?
    /// The run that ended uncleanly.
    public var previousRun: JunoRunSentinel?
    /// Unclean exits inside the crash-loop window, this one included.
    public var recentUncleanExits: Int

    public init(
        kind: Kind,
        snapshot: JunoSessionSnapshot? = nil,
        previousRun: JunoRunSentinel? = nil,
        recentUncleanExits: Int = 0
    ) {
        self.kind = kind
        self.snapshot = snapshot
        self.previousRun = previousRun
        self.recentUncleanExits = recentUncleanExits
    }

    public static let clean = JunoLaunchAssessment(kind: .clean)

    public var isUnclean: Bool { kind != .clean }
    public var isSafeMode: Bool { kind == .safeMode }
}

/// The black box: the sentinel, the ledger and the snapshot, and the rules
/// that read them at launch (docs/rea/designs/reliability-and-native.md §3.3).
///
/// One per process, owned by the app on the main actor. Every rule takes its
/// time from `now`, so the tests drive it with a fake clock over an in-memory
/// disk.
public final class JunoCrashRecovery {
    public let location: JunoRecoveryLocation
    public let policy: JunoRecoveryPolicy
    private let fileSystem: any JunoRecoveryFileSystem
    private let now: @Sendable () -> Date
    private var sentinel: JunoRunSentinel?
    private var launchedAt: Date?

    public init(
        location: JunoRecoveryLocation,
        fileSystem: any JunoRecoveryFileSystem = JunoLiveRecoveryFileSystem(),
        policy: JunoRecoveryPolicy = .standard,
        now: @escaping @Sendable () -> Date = { Date() }
    ) {
        self.location = location
        self.fileSystem = fileSystem
        self.policy = policy
        self.now = now
    }

    /// Reads what the previous run left, decides, and writes this run's
    /// sentinel. Call once, as early in launch as possible.
    public func beginLaunch(
        version: String,
        pid: Int32 = ProcessInfo.processInfo.processIdentifier
    ) -> JunoLaunchAssessment {
        let launch = now()
        launchedAt = launch
        // A sentinel that is there but unreadable still says a run never
        // ended cleanly.
        let previous = fileSystem.contents(of: location.sentinel).map {
            (try? JunoRecoveryCoding.decoder.decode(JunoRunSentinel.self, from: $0))
                ?? JunoRunSentinel(pid: 0, version: "", startedAt: launch)
        }
        var ledger = read(JunoRecoveryLedger.self, at: location.ledger) ?? JunoRecoveryLedger()
        ledger.uncleanExits = ledger.uncleanExits.filter {
            $0 <= launch && launch.timeIntervalSince($0) < policy.crashLoopWindow
        }

        let assessment: JunoLaunchAssessment
        if let previous, !previous.backgrounded {
            ledger.uncleanExits.append(launch)
            let count = ledger.uncleanExits.count
            assessment = JunoLaunchAssessment(
                kind: count >= policy.crashLoopCount ? .safeMode : .recovered,
                snapshot: readSnapshot(),
                previousRun: previous,
                recentUncleanExits: count
            )
        } else {
            assessment = JunoLaunchAssessment(kind: .clean, recentUncleanExits: ledger.uncleanExits.count)
        }

        store(ledger, at: location.ledger)
        let current = JunoRunSentinel(pid: pid, version: version, startedAt: launch)
        sentinel = current
        store(current, at: location.sentinel)
        return assessment
    }

    /// iOS: the scene reached the background with its state saved. If the
    /// system ends the app from here, the next launch is clean.
    public func didEnterBackground() {
        setBackgrounded(true)
    }

    /// iOS: back in front. From here an ending is unclean again.
    public func willEnterForeground() {
        setBackgrounded(false)
    }

    /// The app is quitting cleanly: remove the sentinel.
    public func endCleanly() {
        sentinel = nil
        fileSystem.remove(location.sentinel)
    }

    /// When this run counts as stable, for the app to schedule
    /// ``markStable()`` against.
    public var stableDeadline: Date? {
        launchedAt.map { $0.addingTimeInterval(policy.stableAfter) }
    }

    /// The run has lasted ``JunoRecoveryPolicy/stableAfter``: forget the
    /// unclean exits before it. Returns whether it did (it does nothing when
    /// called early).
    @discardableResult
    public func markStable() -> Bool {
        guard let stableDeadline, now() >= stableDeadline else { return false }
        resetCrashLoop()
        return true
    }

    /// "Restart normally": forget the unclean exits, so the next launch,
    /// whatever its sentinel says, does not start in safe mode on their count.
    public func resetCrashLoop() {
        store(JunoRecoveryLedger(), at: location.ledger)
    }

    /// Writes a sentinel as if a run were still going: what a UI test's
    /// launch argument uses to stand in for `kill -9`.
    public func plantSentinel(version: String, pid: Int32 = 0) {
        guard fileSystem.contents(of: location.sentinel) == nil else { return }
        store(JunoRunSentinel(pid: pid, version: version, startedAt: now()), at: location.sentinel)
    }

    private func setBackgrounded(_ value: Bool) {
        guard var current = sentinel, current.backgrounded != value else { return }
        current.backgrounded = value
        sentinel = current
        store(current, at: location.sentinel)
    }

    private func readSnapshot() -> JunoSessionSnapshot? {
        guard let snapshot = read(JunoSessionSnapshot.self, at: location.snapshot),
            snapshot.version == JunoSessionSnapshot.currentVersion,
            !snapshot.isEmpty
        else { return nil }
        return snapshot
    }

    private func read<Value: Decodable>(_ type: Value.Type, at url: URL) -> Value? {
        guard let data = fileSystem.contents(of: url) else { return nil }
        return try? JunoRecoveryCoding.decoder.decode(type, from: data)
    }

    private func store(_ value: some Encodable, at url: URL) {
        guard let data = try? JunoRecoveryCoding.encoder.encode(value) else { return }
        try? fileSystem.write(data, to: url)
    }
}
