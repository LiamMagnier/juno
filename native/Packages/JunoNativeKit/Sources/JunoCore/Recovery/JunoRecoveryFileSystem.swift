import Foundation

/// The handful of file operations crash recovery needs, behind a protocol so
/// the rules can be tested against an in-memory disk with a fake clock.
///
/// Every write is atomic (a temporary file, then a rename): a process killed
/// half-way through a write leaves the previous file, never a torn one.
public protocol JunoRecoveryFileSystem: Sendable {
    /// The file's bytes, or nil when it does not exist or cannot be read.
    func contents(of url: URL) -> Data?
    /// Replaces the file atomically, creating its directory when needed.
    func write(_ data: Data, to url: URL) throws
    /// Removes the file. Removing a file that is not there is not an error.
    func remove(_ url: URL)
}

/// The real disk.
public struct JunoLiveRecoveryFileSystem: JunoRecoveryFileSystem {
    public init() {}

    public func contents(of url: URL) -> Data? {
        try? Data(contentsOf: url)
    }

    public func write(_ data: Data, to url: URL) throws {
        try FileManager.default.createDirectory(
            at: url.deletingLastPathComponent(),
            withIntermediateDirectories: true
        )
        #if os(iOS)
        // Readable after the first unlock, so a launch from a notification or
        // a background refresh can still read the sentinel and the snapshot.
        try data.write(to: url, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
        #else
        try data.write(to: url, options: .atomic)
        #endif
    }

    public func remove(_ url: URL) {
        try? FileManager.default.removeItem(at: url)
    }
}

/// Where recovery keeps its three files.
public struct JunoRecoveryLocation: Sendable, Equatable {
    public let directory: URL

    public init(directory: URL) {
        self.directory = directory
    }

    /// `run.lock`: present while the app runs; gone after a clean exit.
    public var sentinel: URL { directory.appendingPathComponent("run.lock", isDirectory: false) }
    /// `session-snapshot.json`: what was on screen, written as it changes.
    public var snapshot: URL { directory.appendingPathComponent("session-snapshot.json", isDirectory: false) }
    /// `recovery-ledger.json`: recent unclean exits, for the crash-loop guard.
    public var ledger: URL { directory.appendingPathComponent("recovery-ledger.json", isDirectory: false) }

    /// `Application Support/<bundle identifier>/Recovery`. Keyed by bundle so
    /// a Stable and a Next build running side by side never read each
    /// other's sentinel as a crash.
    public static func applicationSupport(bundleIdentifier: String?) -> JunoRecoveryLocation? {
        guard let support = FileManager.default.urls(
            for: .applicationSupportDirectory,
            in: .userDomainMask
        ).first else { return nil }
        let folder = bundleIdentifier ?? "Alevr"
        return JunoRecoveryLocation(
            directory: support
                .appendingPathComponent(folder, isDirectory: true)
                .appendingPathComponent("Recovery", isDirectory: true)
        )
    }
}
