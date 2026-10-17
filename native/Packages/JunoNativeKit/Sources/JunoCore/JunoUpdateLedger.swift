import Foundation

/// What the Mac updater did, written down so the next launch can check it.
///
/// The updater stages a verified bundle and hands the swap to a script that
/// runs after the app has quit. Until now nothing looked back: if the swap
/// failed (a full disk, a permission it did not expect, a bundle that failed
/// the final signature check) the old app relaunched, staged the same version
/// again, and failed again, forever, without anyone being told.
///
/// The ledger is the pure half of the fix. It records each staged build and
/// the moment its install was handed off; at the next launch
/// ``reconcileLaunch(runningVersion:runningBuild:at:)`` compares that record
/// with the build that is actually running, and counts a failed apply when
/// they differ. A version that has failed ``failureLimit`` times is no longer
/// offered. The file I/O is ``JunoUpdateLedgerStore``; the decisions are here
/// so they can be tested without a disk, a network or a Mac.
public struct JunoUpdateLedger: Codable, Equatable, Sendable {

    /// Failed applies of one version before the updater stops offering it and
    /// asks for a manual install instead.
    public static let failureLimit = 3

    /// How many history lines are kept. Enough to read what happened across
    /// a few releases, small enough that the file never matters.
    public static let historyLimit = 24

    /// A verified bundle waiting to replace the running app.
    public struct Staged: Codable, Equatable, Sendable {
        public var version: String
        public var build: String
        /// Lowercase hex SHA-256 of the disk image the bundle came from.
        public var sha256: String
        public var stagedAt: Date
        /// The build that staged it, so a failure can say what stayed.
        public var fromVersion: String
        /// Set when the swap script was started. Nil means the update was
        /// staged but never handed to the installer.
        public var attemptedAt: Date?

        public init(
            version: String,
            build: String,
            sha256: String,
            stagedAt: Date,
            fromVersion: String,
            attemptedAt: Date? = nil
        ) {
            self.version = version
            self.build = build
            self.sha256 = sha256
            self.stagedAt = stagedAt
            self.fromVersion = fromVersion
            self.attemptedAt = attemptedAt
        }
    }

    /// One line of history.
    public struct Entry: Codable, Equatable, Sendable {
        public enum Kind: String, Codable, Sendable {
            case staged
            case attempted
            case applied
            case failed
            case withdrawn
            case superseded
            case discarded
        }

        public var kind: Kind
        public var version: String
        public var at: Date

        public init(kind: Kind, version: String, at: Date) {
            self.kind = kind
            self.version = version
            self.at = at
        }
    }

    /// What the next launch found.
    public enum LaunchOutcome: Equatable, Sendable {
        /// No update was waiting.
        case nothingPending
        /// An update was staged in an earlier run but never handed to the
        /// installer. Its bundle is not reused, so the record is dropped.
        case discardedUnattempted(version: String)
        /// The running build is the one that was staged.
        case applied(version: String)
        /// The install was attempted and the old build is still running.
        /// `blocked` is true once the version has reached ``failureLimit``.
        case failed(version: String, attempts: Int, blocked: Bool)
    }

    /// What the feed's current answer means for a staged update.
    public enum FeedVerdict: Equatable, Sendable {
        /// The feed still offers the staged version.
        case keep
        /// The feed now offers something newer than the staged version.
        case superseded(by: String)
        /// The feed no longer offers the staged version, or has rolled back
        /// to an older one. The staged bundle must never be installed.
        case withdrawn
    }

    public private(set) var staged: Staged?
    /// Failed applies per version.
    public private(set) var failedApplies: [String: Int]
    public private(set) var history: [Entry]

    public init(staged: Staged? = nil, failedApplies: [String: Int] = [:], history: [Entry] = []) {
        self.staged = staged
        self.failedApplies = failedApplies
        self.history = history
    }

    // MARK: Queries

    public func failureCount(for version: String) -> Int {
        failedApplies[version] ?? 0
    }

    /// Whether a version has failed to apply too often to offer again.
    public func isBlocked(_ version: String) -> Bool {
        failureCount(for: version) >= Self.failureLimit
    }

    /// Compares the staged version with what the feed offers now. `offered`
    /// is nil when the feed answered and offers no macOS build at all; a feed
    /// that could not be reached is not an answer and must not reach here.
    public static func verdict(staged: String, offered: String?) -> FeedVerdict {
        guard let offered else { return .withdrawn }
        if offered == staged { return .keep }
        if JunoUpdateFeed.isNewer(offered, than: staged) { return .superseded(by: offered) }
        return .withdrawn
    }

    // MARK: Transitions

    /// Records a newly verified, staged bundle. Staging replaces any earlier
    /// staged record; a version's failure count survives being staged again,
    /// which is the point of counting it.
    public mutating func recordStaged(
        version: String,
        build: String,
        sha256: String,
        from fromVersion: String,
        at date: Date
    ) {
        staged = Staged(version: version, build: build, sha256: sha256, stagedAt: date, fromVersion: fromVersion)
        append(.staged, version, date)
    }

    /// Records that the swap script was started for the staged bundle.
    /// Returns false when nothing is staged.
    @discardableResult
    public mutating func recordInstallAttempt(at date: Date) -> Bool {
        guard var current = staged else { return false }
        current.attemptedAt = date
        staged = current
        append(.attempted, current.version, date)
        return true
    }

    /// Unstages after the feed withdrew or superseded the staged version.
    public mutating func recordUnstaged(_ verdict: FeedVerdict, at date: Date) {
        guard let current = staged else { return }
        switch verdict {
        case .keep:
            return
        case .withdrawn:
            append(.withdrawn, current.version, date)
        case .superseded:
            append(.superseded, current.version, date)
        }
        staged = nil
    }

    /// Run once per launch, before the first check: settles whatever the
    /// previous run left staged against the build that is running now.
    public mutating func reconcileLaunch(
        runningVersion: String,
        runningBuild: String,
        at date: Date
    ) -> LaunchOutcome {
        guard let current = staged else { return .nothingPending }
        staged = nil

        // The running app is the staged one, whoever installed it.
        if current.version == runningVersion, current.build.isEmpty || current.build == runningBuild {
            failedApplies[current.version] = nil
            append(.applied, current.version, date)
            return .applied(version: current.version)
        }

        guard current.attemptedAt != nil else {
            append(.discarded, current.version, date)
            return .discardedUnattempted(version: current.version)
        }

        let attempts = failureCount(for: current.version) + 1
        failedApplies[current.version] = attempts
        append(.failed, current.version, date)
        return .failed(version: current.version, attempts: attempts, blocked: attempts >= Self.failureLimit)
    }

    private mutating func append(_ kind: Entry.Kind, _ version: String, _ date: Date) {
        history.append(Entry(kind: kind, version: version, at: date))
        if history.count > Self.historyLimit {
            history.removeFirst(history.count - Self.historyLimit)
        }
    }
}

/// Reads and writes the ledger as one small JSON file.
///
/// A missing or unreadable file is an empty ledger: losing the record costs at
/// most a few repeated attempts, whereas refusing to update because a file was
/// corrupt would strand the install on an old build.
public struct JunoUpdateLedgerStore: Sendable {
    public let fileURL: URL

    public init(fileURL: URL) {
        self.fileURL = fileURL
    }

    public func load() -> JunoUpdateLedger {
        guard let data = try? Data(contentsOf: fileURL) else { return JunoUpdateLedger() }
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        return (try? decoder.decode(JunoUpdateLedger.self, from: data)) ?? JunoUpdateLedger()
    }

    public func save(_ ledger: JunoUpdateLedger) throws {
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        let data = try encoder.encode(ledger)
        try FileManager.default.createDirectory(
            at: fileURL.deletingLastPathComponent(), withIntermediateDirectories: true
        )
        try data.write(to: fileURL, options: .atomic)
    }
}
